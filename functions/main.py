"""
PULSO · Firebase Functions — dispatcher HTTP
=============================================
Reemplaza http_api.py + api.py.
Un único endpoint HTTP que despacha a todos los métodos por nombre.

Despliegue:
    firebase deploy --only functions

URL frontend (via Hosting rewrite):
    POST /api/<método>   { args: [...], kwargs: {...} }
"""

from __future__ import annotations

import base64
import io
import json
import os
import tempfile
import traceback
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import firestore as fs_admin
from firebase_functions import https_fn, options

import queue_fs as Q
import core_ops as C

# ── Inicializar Firebase Admin ─────────────────────────────────────────────
firebase_admin.initialize_app()


# ── Helpers ────────────────────────────────────────────────────────────────
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db():
    return fs_admin.client()


def _cargas_doc():
    return _db().collection("cargas").document("active")


def _cargas_sessions_col():
    return _db().collection("cargas_sessions")


# ── Métodos permitidos ─────────────────────────────────────────────────────
ALLOWED_METHODS = {
    # Cargador
    "loader_login", "loader_current", "loader_request_next",
    "loader_refresh_precintos", "loader_finish", "loader_set_muelle",
    # Cargas (supervisor)
    "load_excel_base64", "reload_excel", "clear_excel", "lookup_chf", "count_gesupej",
    "get_cargas_state", "update_row", "bulk_update_rows", "count_gesupej_bulk",
    # Cola
    "queue_snapshot", "queue_enqueue_manual", "queue_remove", "queue_reassign",
    "queue_set_urgent", "queue_set_comment", "queue_set_traffic_comment",
    "queue_set_supervisor_files", "queue_force_queued", "queue_send_to_pending_merch",
    "queue_reset_done", "queue_reset_queued", "queue_update_ruta",
    "queue_block", "queue_unblock", "queue_assign_helper", "queue_remove_helper",
    "queue_set_load_start", "queue_set_load_end", "queue_change_queue_type",
    "export_cargas_csv",
    # Cargadores (gestión)
    "loader_upsert", "loader_remove",
    # Info / diagnóstico
    "app_info", "get_odbc_diagnostics", "get_debug_log", "get_audit_log",
    "queue_debug",
    # Config API
    "get_api_config", "save_api_config", "test_api_connection",
    # Excel sessions
    "get_excel_sessions", "switch_excel_session",
    # Graph / SharePoint
    "graph_get_config", "graph_save_config", "graph_test",
    "graph_list_files", "graph_load_file", "graph_download_b64",
}


# ══════════════════════════════════════════════════════════════════════════
# IMPLEMENTACIONES
# ══════════════════════════════════════════════════════════════════════════

# ── Cola ──────────────────────────────────────────────────────────────────
def _queue_snapshot():
    result = Q.snapshot()
    total = sum(len(result.get(k, [])) for k in ("queued","queued_refr","queued_con","assigned","assigned_refr","assigned_con","pending_merch","pending_merch_refr","pending_merch_con","done"))
    print(f"[pulso] queue_snapshot: {total} items total, counts={result.get('counts',{})}")
    return result

def _queue_debug():
    """Diagnóstico: cuenta docs en queue_items sin filtro + meta/counter."""
    try:
        all_docs = Q._items_col().limit(200).get()
        items_raw = [d.to_dict() for d in all_docs]
        counter_doc = Q._meta_doc("counter").get()
        counter_val = counter_doc.get("value") if counter_doc.exists else None
        return {
            "ok": True,
            "total_items": len(items_raw),
            "counter": counter_val,
            "statuses": {s: sum(1 for i in items_raw if i.get("status") == s) for s in set(i.get("status","?") for i in items_raw)},
            "sample": items_raw[:3],
        }
    except Exception as e:
        return {"ok": False, "error": str(e), "traceback": traceback.format_exc()}

def _queue_enqueue_manual(row: dict, urgente: bool = False):
    return Q.enqueue_manual(row, urgente)

def _queue_remove(item_id: str):
    return Q.remove_item(item_id)

def _queue_reassign(item_id: str, loader_id: str):
    return Q.reassign(item_id, loader_id)

def _queue_set_urgent(item_id: str, urgente: bool):
    return Q.set_urgent(item_id, urgente)

def _queue_set_comment(item_id: str, comment: str):
    return Q.set_comment(item_id, comment)

def _queue_set_traffic_comment(item_id: str, traffic_comment: str):
    return Q.set_traffic_comment(item_id, traffic_comment)

def _queue_set_supervisor_files(item_id: str, files: list):
    return Q.set_supervisor_files(item_id, files)

def _queue_force_queued(item_id: str):
    return Q.force_queued(item_id)

def _queue_send_to_pending_merch(item_id: str):
    return Q.send_to_pending_merch(item_id)

def _queue_reset_done():
    return Q.reset_done()

def _queue_reset_queued(queue_type: str = None):
    return Q.reset_queued(queue_type)

def _queue_update_ruta(item_id: str, ruta_carga: str):
    return Q.update_ruta(item_id, ruta_carga)

def _queue_block(item_id: str):
    return Q.block_item(item_id)

def _queue_unblock(item_id: str):
    return Q.unblock_item(item_id)

def _queue_assign_helper(item_id: str, helper_loader_id: str):
    return Q.assign_helper(item_id, helper_loader_id)

def _queue_remove_helper(item_id: str):
    return Q.remove_helper(item_id)

def _queue_set_load_start(item_id: str, loader_id: str):
    return Q.set_load_start(item_id, loader_id)

def _queue_set_load_end(item_id: str, loader_id: str):
    return Q.set_load_end(item_id, loader_id)

def _queue_change_queue_type(item_id: str, new_type: str):
    return Q.change_queue_type(item_id, new_type)


# ── Cargadores ────────────────────────────────────────────────────────────
def _loader_login(pin: str):
    loader = Q.get_loader_by_pin(str(pin))
    if not loader:
        return {"ok": False, "error": "PIN incorrecto"}
    return {"ok": True, "loader": loader}


def _loader_current(loader_id: str):
    loader = Q.get_loader(loader_id)
    if not loader:
        return {"ok": False, "error": "Cargador no encontrado"}
    # Buscar item asignado actualmente
    docs = (
        Q._items_col()
        .where(filter=fs_admin.FieldFilter("status", "==", "assigned"))
        .where(filter=fs_admin.FieldFilter("loader_id", "==", loader_id))
        .limit(1)
        .get()
    )
    item = docs[0].to_dict() if docs else None
    # Enriquecer con precintos si tiene item asignado
    if item and item.get("codcli"):
        try:
            count = C.count_gesupe6(item.get("ruta", ""))
            item["numsup_count"] = count
        except Exception:
            pass
    return {"ok": True, "loader": loader, "item": item}


def _loader_request_next(loader_id: str):
    return Q.assign_next(loader_id)


def _loader_refresh_precintos(loader_id: str):
    docs = (
        Q._items_col()
        .where(filter=fs_admin.FieldFilter("status", "==", "assigned"))
        .where(filter=fs_admin.FieldFilter("loader_id", "==", loader_id))
        .limit(1)
        .get()
    )
    if not docs:
        return {"ok": False, "error": "Sin asignación"}
    item = docs[0].to_dict()
    count = C.count_gesupe6(item.get("ruta", ""))
    docs[0].reference.update({"numsup_count": count})
    return {"ok": True, "numsup_count": count}


def _loader_finish(loader_id: str, item_id: str, checklist: dict = None, photos: list = None):
    return Q.finish_item(loader_id, item_id, checklist, photos)


def _loader_set_muelle(loader_id: str, muelle: str):
    return Q.set_loader_muelle(loader_id, muelle)


def _loader_upsert(loader_id: str, name: str, pin: str, queue_type: str = "ambiente"):
    return Q.upsert_loader(loader_id, name, pin, queue_type)


def _loader_remove(loader_id: str):
    return Q.remove_loader(loader_id)


# ── Cargas (Excel) en Firestore ────────────────────────────────────────────

_EXCEL_ERRORS = {"#n/a", "#value!", "#ref!", "#div/0!", "#name?", "#null!", "#num!", "#na"}

def _safe_str(v) -> str:
    """Convierte cualquier valor de celda a string limpio."""
    if v is None:
        return ""
    import datetime as _dt
    if isinstance(v, (_dt.datetime, _dt.date)):
        return str(v)
    if isinstance(v, _dt.timedelta):
        total = int(v.total_seconds())
        h, rem = divmod(abs(total), 3600)
        return f"{h:02d}:{rem // 60:02d}"
    if isinstance(v, bool):
        return ""
    if isinstance(v, float):
        if v != v:  # NaN
            return ""
        if v == int(v):
            return str(int(v))
        return str(v)
    if isinstance(v, int):
        return str(v)
    s = str(v).strip()
    if s.lower() in ("nan", "none") or s.lower() in _EXCEL_ERRORS:
        return ""
    return s


def _norm_hora(v) -> str:
    """Convierte valor de hora Excel a HH:MM."""
    import datetime as _dt
    if v is None:
        return ""
    if isinstance(v, _dt.timedelta):
        total = int(v.total_seconds())
        h, rem = divmod(abs(total), 3600)
        return f"{h:02d}:{rem // 60:02d}"
    if isinstance(v, (_dt.datetime, _dt.time)):
        return v.strftime("%H:%M")
    s = _safe_str(v).strip()
    if s in ("0", "0.0", "0.00", ""):
        return ""
    if ":" in s:
        parts = s.split(":")
        try:
            return f"{int(parts[0]):02d}:{int(parts[1]):02d}"
        except Exception:
            return ""
    try:
        f = float(s)
        if f == 0:
            return ""
        total = round(f * 86400)
        h, rem = divmod(total, 3600)
        return f"{h % 24:02d}:{rem // 60:02d}"
    except Exception:
        return s


def _nc(s: str) -> str:
    """Normaliza nombre de columna para comparar."""
    return str(s).upper().replace("\n","").replace("\r","").replace(" ","").replace("\t","")


def _parse_excel_bytes(data: bytes, filename: str) -> tuple:
    """
    Parsea el Plan de Carga Excel siguiendo la misma lógica que qr_teku_core.py.
    Devuelve (rows, fecha_b2).
    """
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    ws = wb.active
    all_rows = list(ws.iter_rows(values_only=True))

    # ── Fecha B2 ──────────────────────────────────────────────────────────
    fecha_b2 = ""
    try:
        v = all_rows[1][1] if len(all_rows) > 1 and len(all_rows[1]) > 1 else None
        if v is not None:
            import datetime as _dt
            if isinstance(v, (_dt.datetime, _dt.date)):
                fecha_b2 = v.strftime("%Y%m%d")
            else:
                s = _safe_str(v)
                if s and s.replace("-","").isdigit():
                    fecha_b2 = s.replace("-","")
                elif s:
                    fecha_b2 = s
    except Exception:
        pass

    # ── Fila de cabecera (primera que contiene "DESTINO") ─────────────────
    hdr_idx = 0
    for i, row in enumerate(all_rows[:50]):
        vals = [_nc(str(v or "")) for v in row]
        if "DESTINO" in vals:
            hdr_idx = i
            break

    raw_hdr = [str(v or "").strip() for v in all_rows[hdr_idx]]

    # Hacer únicos los nombres de columna
    seen_h: dict = {}
    headers = []
    for h in raw_hdr:
        if h in seen_h:
            seen_h[h] += 1
            headers.append(f"{h}_{seen_h[h]}")
        else:
            seen_h[h] = 0
            headers.append(h)

    n_cols = len(headers)

    def col_idx(name: str):
        nc = _nc(name)
        for i, h in enumerate(headers):
            if _nc(h) == nc:
                return i
        return None

    def rget(row, name: str, fallback_idx: int = None):
        idx = col_idx(name)
        if idx is not None and idx < len(row):
            return row[idx]
        if fallback_idx is not None and fallback_idx < len(row):
            return row[fallback_idx]
        return None

    # ── Detectar columnas por pre-cabecera ────────────────────────────────
    _salida_prev_idx = None
    _cod_centro_idx = None
    if hdr_idx > 0:
        for ci in range(n_cols):
            pre = " ".join(
                _nc(str(all_rows[ri][ci] or ""))
                for ri in range(hdr_idx)
                if ci < len(all_rows[ri]) and _safe_str(all_rows[ri][ci])
            )
            if _salida_prev_idx is None and "SALIDA" in pre and "PREV" in pre:
                _salida_prev_idx = ci
            if _cod_centro_idx is None and "COD" in pre and "CENTRO" in pre:
                _cod_centro_idx = ci
    if _salida_prev_idx is None and n_cols > 27:
        _salida_prev_idx = 27
    if _cod_centro_idx is None and n_cols > 20:
        _cod_centro_idx = 20

    # ── Columna precinto ──────────────────────────────────────────────────
    precinto_col_idx = None
    for i, h in enumerate(headers):
        if "PRECINTO" in _nc(h):
            precinto_col_idx = i
            break
    if precinto_col_idx is None and n_cols > 30:
        precinto_col_idx = 30

    TIPOS_AMBIENTE = {"1", "2", "3"}

    # ── Parsear filas de datos (máx 600, igual que desktop) ─────────────
    rows = []
    for raw_row in all_rows[hdr_idx + 1: hdr_idx + 601]:
        if all(v is None for v in raw_row):
            continue

        destino   = _safe_str(rget(raw_row, "DESTINO"))
        n         = _safe_str(rget(raw_row, "Nº") or rget(raw_row, "N°"))
        agencia   = _safe_str(rget(raw_row, "AGENCIA CONTRATADA"))
        matriculas = _safe_str(rget(raw_row, "MATRICULAS"))
        tipo      = _safe_str(rget(raw_row, "TIPO CAMION"))
        expedicion = _safe_str(rget(raw_row, "EXPEDICION"))
        cad       = _safe_str(rget(raw_row, "C.A.D"))
        orden     = _safe_str(rget(raw_row, "ORDEN CARGA OPERADOR"))

        # PLAYA col K (idx 10) y MUELLE col L (idx 11)
        playa = ""
        muelle = ""
        for i, h in enumerate(headers):
            nc = _nc(h)
            if not playa and nc == "PLAYA":
                playa = _safe_str(raw_row[i] if i < len(raw_row) else None)
            if not muelle and nc == "MUELLE":
                muelle = _safe_str(raw_row[i] if i < len(raw_row) else None)
        if not playa and n_cols > 10:
            playa = _safe_str(raw_row[10] if 10 < len(raw_row) else None)
        if not muelle and n_cols > 11:
            muelle = _safe_str(raw_row[11] if 11 < len(raw_row) else None)

        # HORA ACULE (col AA = idx 26)
        hora_acule = ""
        for i, h in enumerate(headers):
            if "ACULE" in _nc(h):
                v = raw_row[i] if i < len(raw_row) else None
                if _safe_str(v) not in ("0.0","0","0.00","","nan","none",""):
                    hora_acule = _norm_hora(v)
                break
        if not hora_acule and n_cols > 26:
            v = raw_row[26] if 26 < len(raw_row) else None
            if _safe_str(v) not in ("0.0","0","0.00","","nan","none",""):
                hora_acule = _norm_hora(v)
        aculado = bool(hora_acule.strip())

        # HORA SALIDA PREVISTA
        hora_salida = ""
        if _salida_prev_idx is not None and _salida_prev_idx < len(raw_row):
            v = raw_row[_salida_prev_idx]
            if _safe_str(v) not in ("0.0","0","0.00","","nan","none",""):
                hora_salida = _norm_hora(v)
        if not hora_salida:
            for i, h in enumerate(headers):
                nc = _nc(h)
                if "SALIDAPREV" in nc or "SALIDA_PREV" in nc or "HORASALIDA" in nc:
                    v = raw_row[i] if i < len(raw_row) else None
                    hora_salida = _norm_hora(v)
                    if hora_salida:
                        break

        # COD. CENTRO
        cod_centro = ""
        if _cod_centro_idx is not None and _cod_centro_idx < len(raw_row):
            cod_centro = _safe_str(raw_row[_cod_centro_idx])
        if not cod_centro:
            for i, h in enumerate(headers):
                nc = _nc(h).replace(".","")
                if "CODCENTRO" in nc or "CODCENT" in nc:
                    cod_centro = _safe_str(raw_row[i] if i < len(raw_row) else None)
                    if cod_centro:
                        break

        # TIPO VIAJE
        tipo_viaje = "ambiente" if tipo.strip() in TIPOS_AMBIENTE else "refrigerado"
        if "CONGELADO" in tipo.upper() or "CONG" in tipo.upper():
            tipo_viaje = "congelado"

        # PRECINTO (texto plano — no como lista para evitar nested arrays en Firestore)
        precinto = ""
        if precinto_col_idx is not None and precinto_col_idx < len(raw_row):
            precinto = _safe_str(raw_row[precinto_col_idx])

        # COL I (idx 8) y COL W (idx 22)
        col_i = _safe_str(raw_row[8] if n_cols > 8 and 8 < len(raw_row) else None)
        col_w = _safe_str(raw_row[22] if n_cols > 22 and 22 < len(raw_row) else None).upper()

        if not destino and not n:
            continue

        rows.append({
            "destino": destino, "n": n, "agencia": agencia,
            "matriculas": matriculas, "tipo": tipo,
            "expedicion": expedicion, "cad": cad, "orden": orden,
            "playa": playa, "muelle": muelle,
            "hora_acule": hora_acule, "aculado": aculado,
            "hora_salida": hora_salida,
            "cod_centro": cod_centro, "col_w": col_w, "col_i": col_i,
            "tipo_viaje": tipo_viaje, "precinto": precinto,
            "ya_cargado": False,
            "estado": "ready" if destino else "missing-cif",
        })

    # Deduplicar por (destino, n)
    seen_n: set = set()
    deduped = []
    for row in rows:
        key = (row["destino"], row["n"])
        if row["n"] and key in seen_n:
            continue
        seen_n.add(key)
        deduped.append(row)

    return deduped, fecha_b2


def _compute_queue_type(row: dict) -> str:
    """Compute queue_type matching desktop logic.

    Adelantados (col_w == 'A') always go to the ambiente queue even when
    the shipment is refrigerado — same rule as in desktop api.py.
    """
    tipo_viaje = row.get("tipo_viaje", "ambiente")
    col_w = str(row.get("col_w") or "").strip().upper()
    if tipo_viaje == "congelado" and col_w != "A":
        return "congelado"
    if tipo_viaje == "refrigerado" and col_w != "A":
        return "refrigerado"
    return "ambiente"


def _load_excel_base64(filename: str, b64_content: str):
    try:
        data = base64.b64decode(b64_content)
        rows, fecha_b2 = _parse_excel_bytes(data, filename)

        # ── Añadir fecha y queue_type a cada fila (misma lógica que desktop) ──
        for r in rows:
            r["fecha"] = fecha_b2
            r["queue_type"] = _compute_queue_type(r)

        session_id = f"session-{_now_iso()[:19].replace(':','-').replace('T','_')}"
        now = _now_iso()
        fs_error = None

        # Guardar en Firestore (sesión activa)
        try:
            _cargas_doc().set({
                "session_id": session_id,
                "filename": filename,
                "loaded_at": now,
                "rows": rows,
                "count": len(rows),
            })
            # Historial: solo metadata (rows no caben en 1 doc si hay > 600 filas)
            _cargas_sessions_col().document(session_id).set({
                "session_id": session_id,
                "filename": filename,
                "loaded_at": now,
                "count": len(rows),
            })
        except Exception as e:
            fs_error = str(e)
            print(f"[pulso] Firestore write error in load_excel: {e}")

        # Auto-encolar SOLO filas aculadas (misma lógica que desktop)
        auto_count = 0
        auto_enqueue_error = None
        try:
            snap = Q.snapshot()
            existing_ids = {
                it.get("id", "") for lst in [
                    snap.get("queued", []), snap.get("queued_refr", []),
                    snap.get("queued_con", []), snap.get("assigned", []),
                    snap.get("assigned_refr", []), snap.get("assigned_con", []),
                    snap.get("pending_merch", []), snap.get("pending_merch_refr", []),
                    snap.get("pending_merch_con", []),
                ] for it in lst
            }
            aculadas = [r for r in rows if r.get("aculado") and not r.get("ya_cargado")]
            print(f"[pulso] Auto-enqueue: {len(aculadas)} aculadas candidatas de {len(rows)} filas")
            for row in aculadas:
                n_viaje = str(row.get("n") or "").strip()
                destino = str(row.get("destino") or "").strip()
                if not n_viaje and not destino:
                    continue
                key = n_viaje or destino
                if key in existing_ids:
                    continue
                try:
                    Q.enqueue_manual(row, urgente=False)
                    auto_count += 1
                except Exception as e2:
                    auto_enqueue_error = str(e2)
                    print(f"[pulso] enqueue_manual error row {key}: {e2}\n{traceback.format_exc()}")
        except Exception as e:
            auto_enqueue_error = str(e)
            print(f"[pulso] Auto-enqueue setup error: {e}\n{traceback.format_exc()}")

        result = {
            "ok": True, "rows": rows, "filename": filename,
            "count": len(rows), "auto_enqueued": auto_count,
            "session_id": session_id, "fecha_b2": fecha_b2,
        }
        if fs_error:
            result["warning"] = f"Datos cargados pero no persistidos: {fs_error}"
        if auto_enqueue_error:
            result["auto_enqueue_error"] = auto_enqueue_error
        return result
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _reload_excel():
    doc = _cargas_doc().get()
    if not doc.exists:
        return {"ok": False, "error": "no_file"}
    session = doc.to_dict()
    return {
        "ok": True,
        "rows": session.get("rows", []),
        "filename": session.get("filename", ""),
        "count": session.get("count", 0),
        "auto_enqueued": 0,
    }


def _clear_excel():
    """Elimina la sesión activa de Firestore (limpia el plan de carga)."""
    try:
        _cargas_doc().delete()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _get_cargas_state():
    doc = _cargas_doc().get()
    if not doc.exists:
        return {"ok": False, "error": "no_file"}
    session = doc.to_dict()
    return {
        "ok": True,
        "rows": session.get("rows", []),
        "filename": session.get("filename", ""),
        "count": session.get("count", 0),
    }


def _update_row(n: str, patch: dict):
    allowed = {"cif", "agencia", "estado", "precintos_data", "muelle", "playa", "matriculas", "numsup_count", "ruta_carga", "combined_count"}
    patch = {k: v for k, v in (patch or {}).items() if k in allowed}
    if not patch:
        return {"ok": True}
    doc = _cargas_doc().get()
    if not doc.exists:
        return {"ok": False, "error": "no_file"}
    session = doc.to_dict()
    rows = session.get("rows", [])
    n = str(n)
    for row in rows:
        if str(row.get("n", "")) == n:
            row.update(patch)
            _cargas_doc().update({"rows": rows})
            return {"ok": True}
    return {"ok": False, "error": "row_not_found"}


def _bulk_update_rows(updates: dict):
    """Actualiza múltiples filas en una sola lectura/escritura de Firestore.
    updates: {"n": {"numsup_count": x, "ruta_carga": y, ...}}
    """
    if not updates:
        return {"ok": True, "updated": 0}
    allowed = {"cif", "agencia", "estado", "precintos_data", "muelle", "playa", "matriculas", "numsup_count", "ruta_carga", "combined_count"}
    doc_ref = _cargas_doc()
    doc = doc_ref.get()
    if not doc.exists:
        return {"ok": False, "error": "no_file"}
    data = doc.to_dict() or {}
    rows = data.get("rows", [])
    n_to_idx = {str(r.get("n", "")): i for i, r in enumerate(rows)}
    updated = 0
    for n_key, patch in (updates or {}).items():
        clean = {k: v for k, v in (patch or {}).items() if k in allowed}
        if not clean:
            continue
        idx = n_to_idx.get(str(n_key))
        if idx is None:
            continue
        rows[idx] = {**rows[idx], **clean}
        updated += 1
    if updated:
        doc_ref.update({"rows": rows})
    return {"ok": True, "updated": updated}


def _get_excel_sessions():
    docs = (
        _cargas_sessions_col()
        .order_by("loaded_at", direction=fs_admin.Query.DESCENDING)
        .limit(20)
        .get()
    )
    sessions = [d.to_dict() for d in docs]
    active = _cargas_doc().get()
    active_id = active.to_dict().get("session_id", "") if active.exists else ""
    return {"ok": True, "sessions": sessions, "active_session_id": active_id}


def _switch_excel_session(idx: int):
    docs = (
        _cargas_sessions_col()
        .order_by("loaded_at", direction=fs_admin.Query.DESCENDING)
        .limit(20)
        .get()
    )
    sessions = list(docs)
    if idx < 0 or idx >= len(sessions):
        return {"ok": False, "error": "Sesión no encontrada"}
    session_id = sessions[idx].to_dict()["session_id"]

    # Si ya es la sesión activa, devolver ok directamente
    active = _cargas_doc().get()
    if active.exists and active.to_dict().get("session_id") == session_id:
        return {"ok": True, "session_id": session_id}

    # Los datos de filas no se persisten en el historial (documentos de solo metadata).
    # No es posible restaurar una sesión anterior sin volver a cargar el archivo.
    return {
        "ok": False,
        "error": "Sesión no restaurable — recarga el archivo desde SharePoint o disco local",
    }


# ── AS400 ─────────────────────────────────────────────────────────────────
def _lookup_chf(matricula: str):
    tractora_norm = (matricula or "").upper().replace(" ", "").replace("-", "").strip()
    api_url = C._api_url()
    print(f"[lookup_chf] matricula={matricula!r} norm={tractora_norm!r} api_url={api_url!r}")
    data = C.lookup_chf(matricula)
    print(f"[lookup_chf] result data={data!r}")
    if data:
        return {"ok": True, "found": True, **data}
    return {"ok": True, "found": False, "error": "No encontrado", "debug_norm": tractora_norm, "debug_api_url": api_url}


def _count_gesupej(cod_centro: str, tipo_viaje: str = "ambiente", col_w: str = ""):
    """
    Devuelve pales + ruta_carga para un cod_centro, igual que el desktop:
      - numsup_count: GESUPEJ por codcli
      - ruta_carga:   touliv1 ± 5 (o +1 para adelantados)
      - combined_count: numsup + gesupe6 por ruta
    """
    try:
        s = str(cod_centro or "").strip()
        codcli = str(int(float(s))).zfill(8) if s else ""
    except (ValueError, TypeError):
        codcli = str(cod_centro or "").strip()
    if not codcli:
        return {"ok": True, "numsup_count": 0, "ruta_carga": None, "combined_count": None}

    ambiente = str(tipo_viaje or "").lower() == "ambiente"
    codact = "101" if ambiente else "003"
    ambi_str = "true" if ambiente else "false"
    is_adelantado = str(col_w or "").strip().upper() == "A"

    numsup = C.count_gesupej(codcli, ambi_str)

    # Obtener ruta_carga a partir de touliv1 (igual que desktop)
    ruta_carga = None
    combined_count = numsup
    try:
        touliv1_raw = C.lookup_touliv1(codcli, codact)
        if touliv1_raw:
            touliv1 = int(float(touliv1_raw))
            ruta_carga = touliv1 + 1 if is_adelantado else touliv1 - 5
            gesupe6 = C.count_gesupe6(str(ruta_carga))
            combined_count = numsup + gesupe6
    except Exception:
        pass

    return {
        "ok": True,
        "numsup_count": numsup,
        "ruta_carga": ruta_carga,
        "combined_count": combined_count,
    }


# ── Pales bulk (todos los centros en paralelo) ────────────────────────────
def _count_gesupej_bulk(entries: list) -> dict:
    """
    entries: [{cod_centro, tipo_viaje, col_w}, ...]
    Devuelve {results: {cod_centro: {numsup_count, ruta_carga, combined_count}}}
    Deduplica por cod_centro y hace las llamadas en paralelo.
    """
    import concurrent.futures

    # Deduplicar: guardar primer entry de cada cod_centro
    seen: dict[str, dict] = {}
    for e in (entries or []):
        cc = str(e.get("cod_centro") or "").strip()
        if cc and cc not in seen:
            seen[cc] = e

    def _fetch(entry):
        cc = str(entry.get("cod_centro") or "").strip()
        res = _count_gesupej(cc, entry.get("tipo_viaje", "ambiente"), entry.get("col_w", ""))
        return cc, res

    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(_fetch, e): e for e in seen.values()}
        for fut in concurrent.futures.as_completed(futures):
            try:
                cc, res = fut.result(timeout=15)
                results[cc] = res
            except Exception as exc:
                entry = futures[fut]
                cc = str(entry.get("cod_centro") or "").strip()
                results[cc] = {"ok": False, "error": str(exc)}

    return {"ok": True, "results": results}


# ── CSV export ────────────────────────────────────────────────────────────
def _export_cargas_csv():
    doc = _cargas_doc().get()
    if not doc.exists:
        return {"ok": False, "error": "no_file"}
    rows = doc.to_dict().get("rows", [])
    if not rows:
        return {"ok": False, "error": "Sin datos"}
    headers = list(rows[0].keys())
    lines = [";".join(headers)]
    for r in rows:
        lines.append(";".join(str(r.get(h, "")) for h in headers))
    csv_content = "\n".join(lines)
    return {
        "ok": True,
        "csv": csv_content,
        "filename": "pulso_cargas.csv",
    }


# ── Graph / SharePoint (config en Firestore) ───────────────────────────────
def _graph_get_config():
    doc = _db().collection("config").document("graph").get()
    if not doc.exists:
        return {"ok": True, "config": {}, "configured": False}
    cfg = doc.to_dict()
    safe = dict(cfg)
    if safe.get("client_secret"):
        safe["client_secret"] = "•" * 36
    configured = bool(cfg.get("enabled") and cfg.get("tenant_id") and
                      cfg.get("client_id") and cfg.get("client_secret"))
    return {"ok": True, "config": safe, "configured": configured}


def _graph_save_config(cfg: dict):
    doc_ref = _db().collection("config").document("graph")
    existing = doc_ref.get()
    current = existing.to_dict() if existing.exists else {}
    merged = {**current, **cfg}
    if (cfg.get("client_secret") or "").startswith("•") and current.get("client_secret"):
        merged["client_secret"] = current["client_secret"]
    doc_ref.set(merged)
    return {"ok": True}


def _graph_test():
    doc = _db().collection("config").document("graph").get()
    if not doc.exists:
        return {"ok": False, "error": "No configurado"}
    cfg = doc.to_dict()
    if not (cfg.get("tenant_id") and cfg.get("client_id") and cfg.get("client_secret")):
        return {"ok": False, "error": "Faltan credenciales"}
    try:
        import msal
        app = msal.ConfidentialClientApplication(
            cfg["client_id"],
            authority=f"https://login.microsoftonline.com/{cfg['tenant_id']}",
            client_credential=cfg["client_secret"],
        )
        res = app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
        if "access_token" not in res:
            return {"ok": False, "error": res.get("error_description", "Auth error")}
        return {"ok": True, "message": "Conexión correcta"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _graph_reader_cfg() -> dict:
    doc = _db().collection("config").document("graph").get()
    return doc.to_dict() if doc.exists else {}


def _graph_token(cfg: dict) -> str:
    import msal
    app = msal.ConfidentialClientApplication(
        cfg["client_id"],
        authority=f"https://login.microsoftonline.com/{cfg['tenant_id']}",
        client_credential=cfg["client_secret"],
    )
    res = app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
    if "access_token" not in res:
        raise RuntimeError(res.get("error_description") or "Auth error")
    return res["access_token"]


def _graph_get(token: str, path: str) -> dict:
    import requests as _req
    r = _req.get(
        f"https://graph.microsoft.com/v1.0{path}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _graph_site_id(cfg: dict, token: str) -> str:
    sp = (cfg.get("sharepoint_url") or "").rstrip("/")
    host = sp.split("//", 1)[-1].split("/")[0]
    sp_path = (cfg.get("site_path") or "").strip("/")
    endpoint = f"/sites/{host}:/{sp_path}" if sp_path else f"/sites/{host}"
    return _graph_get(token, endpoint)["id"]


_DOC_LIB_PREFIXES = (
    "documentos compartidos/",
    "shared documents/",
    "documents/",
    "documentos/",
)


def _graph_normalize_folder(folder_path: str) -> str:
    """Strip document-library root prefix.

    Graph /drive/root already points to the default library
    ('Documentos compartidos'), so that segment must not appear
    in the folder path we send to the API.
    """
    f = (folder_path or "").strip("/")
    fl = f.lower()
    for p in _DOC_LIB_PREFIXES:
        if fl.startswith(p):
            return f[len(p):].strip("/")
    return f


def _graph_list_files():
    cfg = _graph_reader_cfg()
    if not (cfg.get("enabled") and cfg.get("tenant_id") and cfg.get("client_id") and cfg.get("client_secret")):
        return {"ok": True, "files": []}
    try:
        token = _graph_token(cfg)
        site = _graph_site_id(cfg, token)
        folder = _graph_normalize_folder(cfg.get("folder_path") or "")
        if folder:
            data = _graph_get(token, f"/sites/{site}/drive/root:/{folder}:/children")
        else:
            data = _graph_get(token, f"/sites/{site}/drive/root/children")
        files = []
        for item in data.get("value", []):
            if not item.get("name", "").lower().endswith(".xlsx"):
                continue
            files.append({
                "name":       item["name"],
                "server_url": item["id"],
                "modified":   item.get("lastModifiedDateTime", ""),
                "size_kb":    round((item.get("size") or 0) / 1024),
            })
        return {"ok": True, "files": files}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _graph_load_file(server_url: str):
    """Descarga un Excel de SharePoint y lo carga como sesión activa."""
    cfg = _graph_reader_cfg()
    if not cfg.get("client_secret"):
        return {"ok": False, "error": "SharePoint no configurado"}
    try:
        import requests as _req
        token = _graph_token(cfg)
        site = _graph_site_id(cfg, token)
        # Metadatos
        meta = _req.get(
            f"https://graph.microsoft.com/v1.0/sites/{site}/drive/items/{server_url}",
            headers={"Authorization": f"Bearer {token}"}, timeout=15,
        )
        meta.raise_for_status()
        filename = meta.json().get("name", "plan_carga.xlsx")
        # Contenido
        r = _req.get(
            f"https://graph.microsoft.com/v1.0/sites/{site}/drive/items/{server_url}/content",
            headers={"Authorization": f"Bearer {token}"}, timeout=60, allow_redirects=True,
        )
        r.raise_for_status()
        b64 = base64.b64encode(r.content).decode()
        return _load_excel_base64(filename, b64)
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _graph_download_b64(server_url: str):
    cfg = _graph_reader_cfg()
    if not cfg.get("client_secret"):
        return {"ok": False, "error": "SharePoint no configurado"}
    try:
        import requests as _req
        token = _graph_token(cfg)
        site = _graph_site_id(cfg, token)
        meta = _req.get(
            f"https://graph.microsoft.com/v1.0/sites/{site}/drive/items/{server_url}",
            headers={"Authorization": f"Bearer {token}"}, timeout=15,
        )
        meta.raise_for_status()
        filename = meta.json().get("name", "plan_carga.xlsx")
        r = _req.get(
            f"https://graph.microsoft.com/v1.0/sites/{site}/drive/items/{server_url}/content",
            headers={"Authorization": f"Bearer {token}"}, timeout=60, allow_redirects=True,
        )
        r.raise_for_status()
        return {"ok": True, "filename": filename, "b64": base64.b64encode(r.content).decode()}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Info ──────────────────────────────────────────────────────────────────
def _app_info():
    diag = C.diagnostics()
    return {
        "ok": True,
        "version": "7.0-cloud",
        "mode": "firebase",
        "connected": C.is_configured(),
        "api_url": diag.get("api_url", "(no configurada)"),
    }


def _get_odbc_diagnostics():
    return {"ok": True, **C.diagnostics()}


def _get_debug_log(lines: int = 200):
    return {"ok": True, "lines": [], "info": "Debug log no disponible en modo cloud"}


def _get_audit_log(limit: int = 100):
    return Q.get_audit_log(limit)


# ══════════════════════════════════════════════════════════════════════════
# DISPATCHER
# ══════════════════════════════════════════════════════════════════════════

HANDLERS = {
    "queue_snapshot":           lambda *a, **k: _queue_snapshot(),
    "queue_debug":              lambda *a, **k: _queue_debug(),
    "queue_enqueue_manual":     lambda *a, **k: _queue_enqueue_manual(*a, **k),
    "queue_remove":             lambda *a, **k: _queue_remove(*a, **k),
    "queue_reassign":           lambda *a, **k: _queue_reassign(*a, **k),
    "queue_set_urgent":         lambda *a, **k: _queue_set_urgent(*a, **k),
    "queue_set_comment":        lambda *a, **k: _queue_set_comment(*a, **k),
    "queue_set_traffic_comment": lambda *a, **k: _queue_set_traffic_comment(*a, **k),
    "queue_set_supervisor_files": lambda *a, **k: _queue_set_supervisor_files(*a, **k),
    "queue_force_queued":       lambda *a, **k: _queue_force_queued(*a, **k),
    "queue_send_to_pending_merch": lambda *a, **k: _queue_send_to_pending_merch(*a, **k),
    "queue_reset_done":         lambda *a, **k: _queue_reset_done(),
    "queue_reset_queued":       lambda *a, **k: _queue_reset_queued(*a, **k),
    "queue_update_ruta":        lambda *a, **k: _queue_update_ruta(*a, **k),
    "queue_block":              lambda *a, **k: _queue_block(*a, **k),
    "queue_unblock":            lambda *a, **k: _queue_unblock(*a, **k),
    "queue_assign_helper":      lambda *a, **k: _queue_assign_helper(*a, **k),
    "queue_remove_helper":      lambda *a, **k: _queue_remove_helper(*a, **k),
    "queue_set_load_start":     lambda *a, **k: _queue_set_load_start(*a, **k),
    "queue_set_load_end":       lambda *a, **k: _queue_set_load_end(*a, **k),
    "queue_change_queue_type":  lambda *a, **k: _queue_change_queue_type(*a, **k),
    "loader_login":             lambda *a, **k: _loader_login(*a, **k),
    "loader_current":           lambda *a, **k: _loader_current(*a, **k),
    "loader_request_next":      lambda *a, **k: _loader_request_next(*a, **k),
    "loader_refresh_precintos": lambda *a, **k: _loader_refresh_precintos(*a, **k),
    "loader_finish":            lambda *a, **k: _loader_finish(*a, **k),
    "loader_set_muelle":        lambda *a, **k: _loader_set_muelle(*a, **k),
    "loader_upsert":            lambda *a, **k: _loader_upsert(*a, **k),
    "loader_remove":            lambda *a, **k: _loader_remove(*a, **k),
    "load_excel_base64":        lambda *a, **k: _load_excel_base64(*a, **k),
    "reload_excel":             lambda *a, **k: _reload_excel(),
    "clear_excel":              lambda *a, **k: _clear_excel(),
    "get_cargas_state":         lambda *a, **k: _get_cargas_state(),
    "update_row":               lambda *a, **k: _update_row(*a, **k),
    "bulk_update_rows":         lambda *a, **k: _bulk_update_rows(*a, **k),
    "get_excel_sessions":       lambda *a, **k: _get_excel_sessions(),
    "switch_excel_session":     lambda *a, **k: _switch_excel_session(*a, **k),
    "lookup_chf":               lambda *a, **k: _lookup_chf(*a, **k),
    "count_gesupej":            lambda *a, **k: _count_gesupej(*a, **k),
    "count_gesupej_bulk":       lambda *a, **k: _count_gesupej_bulk(*a, **k),
    "export_cargas_csv":        lambda *a, **k: _export_cargas_csv(),
    "app_info":                 lambda *a, **k: _app_info(),
    "get_odbc_diagnostics":     lambda *a, **k: _get_odbc_diagnostics(),
    "get_debug_log":            lambda *a, **k: _get_debug_log(*a, **k),
    "get_audit_log":            lambda *a, **k: _get_audit_log(*a, **k),
    "graph_get_config":         lambda *a, **k: _graph_get_config(),
    "graph_save_config":        lambda *a, **k: _graph_save_config(*a, **k),
    "graph_test":               lambda *a, **k: _graph_test(),
    "graph_list_files":         lambda *a, **k: _graph_list_files(),
    "graph_load_file":          lambda *a, **k: _graph_load_file(*a, **k),
    "graph_download_b64":       lambda *a, **k: _graph_download_b64(*a, **k),
    "get_api_config":           lambda *a, **k: C.get_api_config(),
    "save_api_config":          lambda *a, **k: C.save_api_config(*a, **k),
    "test_api_connection":      lambda *a, **k: C.test_connection(),
}


# ══════════════════════════════════════════════════════════════════════════
# FIREBASE HTTP FUNCTION
# ══════════════════════════════════════════════════════════════════════════

@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["GET", "POST", "OPTIONS"]),
    memory=options.MemoryOption.MB_512,
    timeout_sec=120,
)
def api(req: https_fn.Request) -> https_fn.Response:
    if req.method == "OPTIONS":
        return https_fn.Response("", status=204)

    # Extraer nombre del método desde la URL
    # Firebase Hosting rewrite pasa la ruta completa, p.ej. /api/queue_snapshot
    path = req.path or ""
    if path.startswith("/api/"):
        method_name = path[len("/api/"):].strip("/")
    else:
        method_name = path.strip("/")

    if not method_name:
        return _json_resp({"ok": False, "error": "Método no especificado"}, 400)

    if method_name not in ALLOWED_METHODS:
        return _json_resp({"ok": False, "error": f"Método no permitido: {method_name}"}, 403)

    handler = HANDLERS.get(method_name)
    if not handler:
        return _json_resp({"ok": False, "error": f"No implementado: {method_name}"}, 501)

    try:
        body = req.get_json(silent=True) or {}
        args = body.get("args", []) or []
        kwargs = body.get("kwargs", {}) or {}
        result = handler(*args, **kwargs)
        return _json_resp(result, 200)
    except Exception as e:
        print(f"[pulso] ERROR {method_name}: {e}\n{traceback.format_exc()}")
        return _json_resp({"ok": False, "error": str(e)}, 500)


def _json_resp(data: dict, status: int) -> https_fn.Response:
    return https_fn.Response(
        json.dumps(data, ensure_ascii=False, default=str),
        status=status,
        mimetype="application/json",
    )
