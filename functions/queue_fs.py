"""
PULSO · Operaciones de cola sobre Firestore
===========================================
Sustituye queue_manager.py (SQLite + threading) por Firestore.

Colecciones:
  queue_items   — items activos y completados
  loaders       — cargadores
  audit         — log de auditoría
  meta          — contadores y metadatos
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Optional

from firebase_admin import firestore

# ── Firestore client (lazy, reutilizado) ───────────────────────────────────
_db = None


def db():
    global _db
    if _db is None:
        _db = firestore.client()
    return _db


# ── Colecciones ────────────────────────────────────────────────────────────
def _items_col():
    return db().collection("queue_items")


def _loaders_col():
    return db().collection("loaders")


def _audit_col():
    return db().collection("audit")


def _meta_doc(key: str):
    return db().collection("meta").document(key)


# ── Utilidades ─────────────────────────────────────────────────────────────
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_time(t: str):
    if not t:
        return "99:99"
    try:
        parts = t.strip().split(":")
        return f"{int(parts[0]):02d}:{int(parts[1]):02d}"
    except Exception:
        return t or "99:99"


def _audit(action: str, item_id: str = "", data: dict | None = None):
    try:
        _audit_col().add({
            "ts": _now_iso(),
            "action": action,
            "item_id": item_id,
            "data": data or {},
        })
    except Exception:
        pass


def _next_counter() -> int:
    """Incrementa y devuelve un contador atómico en Firestore."""
    ref = _meta_doc("counter")
    doc = ref.get()
    current = int(doc.get("value") or 0) if doc.exists else 0
    nxt = current + 1
    ref.set({"value": nxt})
    return nxt


# ── Cargadores por defecto ─────────────────────────────────────────────────
DEFAULT_LOADERS = [
    {"id": "L01", "pin": "1111", "name": "Cargador 1",
     "muelle_actual": "01", "active": True, "queue_type": "ambiente"},
    {"id": "L02", "pin": "2222", "name": "Cargador 2",
     "muelle_actual": "08", "active": True, "queue_type": "ambiente"},
]


def _ensure_default_loaders():
    docs = _loaders_col().limit(1).get()
    if not docs:
        for l in DEFAULT_LOADERS:
            _loaders_col().document(l["id"]).set(l)


# ── Snapshot ───────────────────────────────────────────────────────────────
def snapshot() -> dict:
    """Devuelve el estado completo de la cola (misma estructura que QueueManager.snapshot)."""
    # Items activos
    active_docs = _items_col().where(
        filter=firestore.FieldFilter("status", "in", ["queued", "assigned", "pending_merch"])
    ).get()
    all_items = [d.to_dict() for d in active_docs]

    # Últimos 50 completados — sin order_by para no requerir índice compuesto
    done_docs = (
        _items_col()
        .where(filter=firestore.FieldFilter("status", "==", "done"))
        .limit(200)
        .get()
    )
    done_all = [d.to_dict() for d in done_docs]
    done = sorted(done_all, key=lambda x: x.get("finished_at") or "", reverse=True)[:50]

    # Loaders
    loader_docs = _loaders_col().get()
    loaders = [d.to_dict() for d in loader_docs]
    if not loaders:
        _ensure_default_loaders()
        loaders = list(DEFAULT_LOADERS)

    def _qt(it):
        return it.get("queue_type", "ambiente")

    def sort_q(it):
        return (0 if it.get("urgente") else 1, _parse_time(it.get("hora_salida", "")))

    def sort_p(it):
        return _parse_time(it.get("hora_salida", ""))

    queued_amb = sorted([i for i in all_items if i["status"] == "queued" and _qt(i) == "ambiente"], key=sort_q)
    queued_ref = sorted([i for i in all_items if i["status"] == "queued" and _qt(i) == "refrigerado"], key=sort_q)
    queued_con = sorted([i for i in all_items if i["status"] == "queued" and _qt(i) == "congelado"], key=sort_q)
    assigned_amb = [i for i in all_items if i["status"] == "assigned" and _qt(i) == "ambiente"]
    assigned_ref = [i for i in all_items if i["status"] == "assigned" and _qt(i) == "refrigerado"]
    assigned_con = [i for i in all_items if i["status"] == "assigned" and _qt(i) == "congelado"]
    pending_amb = sorted([i for i in all_items if i["status"] == "pending_merch" and _qt(i) == "ambiente"], key=sort_p)
    pending_ref = sorted([i for i in all_items if i["status"] == "pending_merch" and _qt(i) == "refrigerado"], key=sort_p)
    pending_con = sorted([i for i in all_items if i["status"] == "pending_merch" and _qt(i) == "congelado"], key=sort_p)

    blocked_count = sum(1 for i in all_items if i["status"] == "queued" and i.get("blocked"))

    return {
        "queued": queued_amb, "queued_refr": queued_ref, "queued_con": queued_con,
        "assigned": assigned_amb, "assigned_refr": assigned_ref, "assigned_con": assigned_con,
        "done": done,
        "pending_merch": pending_amb, "pending_merch_refr": pending_ref, "pending_merch_con": pending_con,
        "loaders": loaders,
        "counts": {
            "queued": len(queued_amb), "queued_refr": len(queued_ref), "queued_con": len(queued_con),
            "assigned": len(assigned_amb), "assigned_refr": len(assigned_ref), "assigned_con": len(assigned_con),
            "done": len(done),
            "pending_merch": len(pending_amb), "pending_merch_refr": len(pending_ref), "pending_merch_con": len(pending_con),
            "blocked": blocked_count,
        },
    }


# ── Añadir item manual ─────────────────────────────────────────────────────
def enqueue_manual(row: dict, urgente: bool = False) -> dict:
    counter = _next_counter()
    now = _now_iso()
    qt = row.get("queue_type") or row.get("tipo_viaje") or "ambiente"
    if qt not in ("ambiente", "refrigerado", "congelado"):
        qt = "ambiente"

    # Extraer tractora/remolque de matriculas si no vienen ya separados
    _matriculas = str(row.get("matriculas") or "")
    _partes = [p.strip() for p in _matriculas.split("/")]
    tractora = str(row.get("tractora") or (_partes[0] if _partes else ""))
    remolque  = str(row.get("remolque") or (_partes[1] if len(_partes) > 1 else ""))

    # mercancia_ok: si numsup_count se conoce en el momento del encolado, calcular
    numsup_count = row.get("numsup_count")
    merch_threshold = int(row.get("merch_threshold") or 25)
    if numsup_count is not None:
        mercancia_ok = int(numsup_count) >= merch_threshold
        initial_status = "queued" if mercancia_ok else "pending_merch"
    else:
        initial_status = "queued"

    item_id = f"M-{counter:04d}-{now[:10]}"
    item = {
        "id": item_id,
        "source": "manual",
        "status": initial_status,
        "queue_type": qt,
        "urgente": bool(urgente),
        "queued_at": now,
        "finished_at": None,
        "completed_at": None,
        "completed_muelle": None,
        "blocked": False,
        "comment": "",
        "traffic_comment": "",
        "supervisor_files": [],
        "helper_loader_id": None,
        "reserved_for": None,
        "load_start_at": None,
        "load_end_at": None,
        "assigned_at": None,
        "ruta": str(row.get("ruta") or ""),
        "pallets": str(row.get("pallets") or ""),
        "muelle": str(row.get("muelle") or ""),
        "playa": str(row.get("playa") or ""),
        "hora_salida": str(row.get("hora_salida") or ""),
        "hora_acule": str(row.get("hora_acule") or ""),
        "cam": str(row.get("cam") or row.get("orden") or ""),
        "tractora": tractora,
        "remolque": remolque,
        "destino": str(row.get("destino") or ""),
        "codcli": str(row.get("codcli") or ""),
        "agencia": str(row.get("agencia") or ""),
        "expedicion": str(row.get("expedicion") or ""),
        "cod_centro": str(row.get("cod_centro") or ""),
        "viaje_n": str(row.get("n") or row.get("viaje_n") or ""),
        "fecha": str(row.get("fecha") or ""),
        "tipo_carga": ("CONGELADO" if qt == "congelado" else
                       "REFRIGERADO" if qt == "refrigerado" else "AMBIENTE"),
        "loader_id": None,
        "loader_name": None,
        "numsup_count": numsup_count,
        "merch_threshold": merch_threshold,
        "precintos_data": row.get("precintos_data") or [],
    }
    _items_col().document(item_id).set(item)
    _audit("enqueue_manual", item_id, {"urgente": urgente, "status": initial_status})
    return {"ok": True, "item": item}


# ── Eliminar item ──────────────────────────────────────────────────────────
def remove_item(item_id: str) -> dict:
    _items_col().document(item_id).delete()
    _audit("remove", item_id)
    return {"ok": True}


# ── Reasignar cargador ─────────────────────────────────────────────────────
def reassign(item_id: str, loader_id: str) -> dict:
    loader_doc = _loaders_col().document(loader_id).get()
    if not loader_doc.exists:
        return {"ok": False, "error": "Cargador no encontrado"}
    loader = loader_doc.to_dict()

    # Si el cargador está ocupado, reservar el item para él
    busy = (
        _items_col()
        .where(filter=firestore.FieldFilter("status", "==", "assigned"))
        .where(filter=firestore.FieldFilter("loader_id", "==", loader_id))
        .limit(1)
        .get()
    )
    if busy:
        _items_col().document(item_id).update({
            "loader_id": loader_id,
            "loader_name": loader.get("name", loader_id),
            "reserved_for": loader_id,
        })
        _audit("reassign_reserved", item_id, {"loader_id": loader_id})
        return {"ok": True, "reserved": True}

    _items_col().document(item_id).update({
        "loader_id": loader_id,
        "loader_name": loader.get("name", loader_id),
        "reserved_for": None,
    })
    _audit("reassign", item_id, {"loader_id": loader_id})
    return {"ok": True, "reserved": False}


# ── Urgencia ───────────────────────────────────────────────────────────────
def set_urgent(item_id: str, urgente: bool) -> dict:
    _items_col().document(item_id).update({"urgente": bool(urgente)})
    _audit("set_urgent", item_id, {"urgente": urgente})
    return {"ok": True}


# ── Comentarios ────────────────────────────────────────────────────────────
def set_comment(item_id: str, comment: str) -> dict:
    _items_col().document(item_id).update({"comment": str(comment or "").strip()})
    return {"ok": True}


def set_traffic_comment(item_id: str, traffic_comment: str) -> dict:
    _items_col().document(item_id).update({"traffic_comment": str(traffic_comment or "").strip()})
    return {"ok": True}


def set_supervisor_files(item_id: str, files: list) -> dict:
    _items_col().document(item_id).update({"supervisor_files": files or []})
    return {"ok": True}


# ── Bloqueo ────────────────────────────────────────────────────────────────
def block_item(item_id: str) -> dict:
    _items_col().document(item_id).update({"blocked": True})
    _audit("block", item_id)
    return {"ok": True}


def unblock_item(item_id: str) -> dict:
    _items_col().document(item_id).update({"blocked": False})
    _audit("unblock", item_id)
    return {"ok": True}


# ── Ayudante ───────────────────────────────────────────────────────────────
def assign_helper(item_id: str, helper_loader_id: str) -> dict:
    loader_doc = _loaders_col().document(helper_loader_id).get()
    if not loader_doc.exists:
        return {"ok": False, "error": "Cargador no encontrado"}
    _items_col().document(item_id).update({"helper_loader_id": helper_loader_id})
    _audit("assign_helper", item_id, {"helper": helper_loader_id})
    return {"ok": True}


def remove_helper(item_id: str) -> dict:
    _items_col().document(item_id).update({"helper_loader_id": None})
    return {"ok": True}


# ── Pending merch ──────────────────────────────────────────────────────────
def send_to_pending_merch(item_id: str) -> dict:
    _items_col().document(item_id).update({"status": "pending_merch"})
    _audit("pending_merch", item_id)
    return {"ok": True}


# ── Tiempos de carga ───────────────────────────────────────────────────────
def set_load_start(item_id: str, loader_id: str) -> dict:
    _items_col().document(item_id).update({"load_start_at": _now_iso()})
    _audit("load_start", item_id, {"loader_id": loader_id})
    return {"ok": True}


def set_load_end(item_id: str, loader_id: str) -> dict:
    _items_col().document(item_id).update({"load_end_at": _now_iso()})
    _audit("load_end", item_id, {"loader_id": loader_id})
    return {"ok": True}


# ── Ruta ───────────────────────────────────────────────────────────────────
def update_ruta(item_id: str, ruta_carga: str) -> dict:
    doc = _items_col().document(item_id).get()
    if not doc.exists:
        return {"ok": False, "error": "Item no encontrado"}
    item = doc.to_dict()
    updates = {"ruta": str(ruta_carga or "")}
    # Si el item está en pending_merch y ya se conoce numsup_count, recalcular mercancia_ok
    promoted = False
    if item.get("status") == "pending_merch":
        numsup = item.get("numsup_count")
        threshold = int(item.get("merch_threshold") or 25)
        if numsup is not None and int(numsup) >= threshold:
            updates["status"] = "queued"
            promoted = True
    _items_col().document(item_id).update(updates)
    return {"ok": True, "promoted": promoted}


# ── Tipo de cola ───────────────────────────────────────────────────────────
def change_queue_type(item_id: str, new_type: str) -> dict:
    if new_type not in ("ambiente", "refrigerado", "congelado"):
        return {"ok": False, "error": "Tipo inválido"}
    tipo_map = {"ambiente": "AMBIENTE", "refrigerado": "REFRIGERADO", "congelado": "CONGELADO"}
    _items_col().document(item_id).update({
        "queue_type": new_type,
        "tipo_carga": tipo_map[new_type],
    })
    _audit("change_type", item_id, {"new_type": new_type})
    return {"ok": True}


# ── Force queued ───────────────────────────────────────────────────────────
def force_queued(item_id: str) -> dict:
    _items_col().document(item_id).update({"status": "queued", "loader_id": None, "loader_name": None})
    _audit("force_queued", item_id)
    return {"ok": True}


# ── Reset done ─────────────────────────────────────────────────────────────
def reset_done() -> dict:
    done_docs = _items_col().where(
        filter=firestore.FieldFilter("status", "==", "done")
    ).get()
    batch = db().batch()
    for doc in done_docs:
        batch.delete(doc.reference)
    batch.commit()
    return {"ok": True, "deleted": len(done_docs)}


# ── Reset queued ───────────────────────────────────────────────────────────
def reset_queued(queue_type: str = None) -> dict:
    q = _items_col().where(filter=firestore.FieldFilter("status", "==", "queued"))
    if queue_type:
        q = q.where(filter=firestore.FieldFilter("queue_type", "==", queue_type))
    docs = q.get()
    batch = db().batch()
    for doc in docs:
        batch.delete(doc.reference)
    batch.commit()
    return {"ok": True, "deleted": len(docs)}


# ── Audit log ─────────────────────────────────────────────────────────────
def fix_legacy_tipo_carga() -> dict:
    """Migración puntual: corrige tipo_carga en items que lo tienen ausente o incorrecto."""
    tipo_map = {"ambiente": "AMBIENTE", "refrigerado": "REFRIGERADO", "congelado": "CONGELADO"}
    docs = _items_col().get()
    fixed = 0
    batch = db().batch()
    for doc in docs:
        item = doc.to_dict()
        qt = item.get("queue_type", "ambiente")
        expected_tc = tipo_map.get(qt, "AMBIENTE")
        if item.get("tipo_carga") != expected_tc:
            batch.update(doc.reference, {"tipo_carga": expected_tc})
            fixed += 1
    if fixed:
        batch.commit()
    return {"ok": True, "fixed": fixed}


def export_queue_csv() -> dict:
    """Exporta todos los items de la cola (activos + completados) como CSV."""
    try:
        all_docs = _items_col().get()
        items = [d.to_dict() for d in all_docs]
        if not items:
            return {"ok": False, "error": "Sin datos en la cola"}
        FIELDS = [
            "id", "viaje_n", "destino", "agencia", "tractora", "remolque",
            "tipo_carga", "queue_type", "muelle", "playa", "hora_salida", "hora_acule",
            "cam", "ruta", "pallets", "status", "urgente", "blocked",
            "loader_id", "loader_name", "helper_loader_id",
            "queued_at", "assigned_at", "load_start_at", "load_end_at",
            "finished_at", "completed_at", "completed_muelle",
            "numsup_count", "merch_threshold", "comment", "traffic_comment",
            "source", "fecha", "cod_centro", "expedicion",
        ]
        lines = [";".join(FIELDS)]
        for item in sorted(items, key=lambda x: x.get("queued_at") or ""):
            lines.append(";".join(str(item.get(f, "")) for f in FIELDS))
        return {
            "ok": True,
            "csv": "\n".join(lines),
            "filename": f"pulso_cola_{_now_iso()[:10]}.csv",
            "count": len(items),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def get_audit_log(limit: int = 100) -> dict:
    docs = (
        _audit_col()
        .order_by("ts", direction=firestore.Query.DESCENDING)
        .limit(int(limit))
        .get()
    )
    return {"ok": True, "rows": [d.to_dict() for d in docs]}


# ── Loaders ───────────────────────────────────────────────────────────────

def get_loader_by_pin(pin: str) -> Optional[dict]:
    docs = _loaders_col().where(
        filter=firestore.FieldFilter("pin", "==", str(pin))
    ).get()
    for doc in docs:
        l = doc.to_dict()
        if l.get("active", True):
            return l
    return None


def get_loader(loader_id: str) -> Optional[dict]:
    doc = _loaders_col().document(loader_id).get()
    return doc.to_dict() if doc.exists else None


def get_all_loaders() -> list:
    docs = _loaders_col().get()
    return [d.to_dict() for d in docs]


def upsert_loader(loader_id: str, name: str, pin: str, queue_type: str = "ambiente") -> dict:
    if queue_type not in ("ambiente", "refrigerado", "congelado"):
        queue_type = "ambiente"
    existing = get_loader(loader_id)
    muelle = existing.get("muelle_actual", "01") if existing else "01"
    loader = {
        "id": loader_id,
        "name": name,
        "pin": pin,
        "queue_type": queue_type,
        "muelle_actual": muelle,
        "active": True,
    }
    _loaders_col().document(loader_id).set(loader)
    return {"ok": True, "loader": loader}


def remove_loader(loader_id: str) -> dict:
    _loaders_col().document(loader_id).delete()
    return {"ok": True}


def set_loader_muelle(loader_id: str, muelle: str) -> dict:
    _loaders_col().document(loader_id).update({"muelle_actual": str(muelle).strip()})
    return {"ok": True}


# ── Asignación de siguiente ────────────────────────────────────────────────
def assign_next(loader_id: str) -> dict:
    """Asigna el siguiente item queued al cargador.
    Prioriza items con reserved_for == loader_id antes de la cola normal."""
    loader = get_loader(loader_id)
    if not loader:
        return {"ok": False, "error": "Cargador no encontrado"}
    if not loader.get("active", True):
        return {"ok": False, "error": "Cargador inactivo"}

    qt = loader.get("queue_type", "ambiente")

    # Prioridad 1: item reservado para este cargador
    reserved = (
        _items_col()
        .where(filter=firestore.FieldFilter("reserved_for", "==", loader_id))
        .limit(1)
        .get()
    )
    if reserved:
        best_doc = reserved[0]
    else:
        # Prioridad 2: cola normal del tipo correcto, no bloqueados
        candidates = (
            _items_col()
            .where(filter=firestore.FieldFilter("status", "==", "queued"))
            .where(filter=firestore.FieldFilter("queue_type", "==", qt))
            .get()
        )
        eligible = [d for d in candidates if not d.to_dict().get("blocked")]
        if not eligible:
            return {"ok": False, "error": "No hay items en cola"}

        def sort_key(d):
            it = d.to_dict()
            return (0 if it.get("urgente") else 1, _parse_time(it.get("hora_salida", "")))

        eligible.sort(key=sort_key)
        best_doc = eligible[0]

    item = best_doc.to_dict()
    now_assign = _now_iso()
    item["status"] = "assigned"
    item["loader_id"] = loader_id
    item["loader_name"] = loader.get("name", loader_id)
    item["assigned_at"] = now_assign

    best_doc.reference.update({
        "status": "assigned",
        "loader_id": loader_id,
        "loader_name": loader.get("name", loader_id),
        "assigned_at": now_assign,
        "reserved_for": None,
    })
    _audit("assign_next", item["id"], {"loader_id": loader_id})
    return {"ok": True, "item": item}


# ── Finalizar carga ────────────────────────────────────────────────────────
def finish_item(loader_id: str, item_id: str, checklist: dict = None, photos: list = None) -> dict:
    doc = _items_col().document(item_id).get()
    if not doc.exists:
        return {"ok": False, "error": "Item no encontrado"}
    item = doc.to_dict()
    if item.get("loader_id") != loader_id:
        return {"ok": False, "error": "Item no pertenece al cargador"}

    now = _now_iso()
    loader = get_loader(loader_id)
    completed_muelle = loader.get("muelle_actual", "") if loader else ""

    updates = {
        "status": "done",
        "finished_at": now,
        "completed_at": now,
        "completed_muelle": completed_muelle,
        "checklist": checklist or {},
        "photos": photos or [],
    }
    _items_col().document(item_id).update(updates)
    _audit("finish", item_id, {"loader_id": loader_id, "muelle": completed_muelle})
    return {"ok": True}
