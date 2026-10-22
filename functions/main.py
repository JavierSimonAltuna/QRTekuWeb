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
    "load_excel_base64", "reload_excel", "lookup_chf",
    "get_cargas_state", "update_row",
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
    # Info
    "app_info", "get_odbc_diagnostics", "get_debug_log", "get_audit_log",
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
    return Q.snapshot()

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

def _parse_excel_bytes(data: bytes, filename: str) -> dict:
    """Parsea un Excel y devuelve las filas. Mismo formato que api.py load_excel."""
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    ws = wb.active
    headers = [str(c.value or "").strip() for c in next(ws.iter_rows(min_row=1, max_row=1))]
    rows = []
    for i, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=1):
        r = {"n": str(i)}
        for h, v in zip(headers, row):
            r[h] = str(v or "").strip() if v is not None else ""
        # Normalizar campos clave
        r.setdefault("ruta", r.get("RUTA", r.get("Ruta", "")))
        r.setdefault("muelle", r.get("MUELLE", r.get("Muelle", "")))
        r.setdefault("playa", r.get("PLAYA", r.get("Playa", "")))
        r.setdefault("hora_salida", r.get("SALIDA", r.get("hora_salida", "")))
        r.setdefault("cam", r.get("CAMION", r.get("Camion", r.get("cam", ""))))
        r.setdefault("codcli", r.get("CODCLI", r.get("CodCli", "")))
        r.setdefault("agencia", r.get("AGENCIA", r.get("Agencia", "")))
        r.setdefault("estado", "pendiente")
        rows.append(r)
    return rows


def _load_excel_base64(filename: str, b64_content: str):
    try:
        data = base64.b64decode(b64_content)
        rows = _parse_excel_bytes(data, filename)
        session_id = f"session-{_now_iso()[:19].replace(':','-').replace('T','_')}"
        session = {
            "session_id": session_id,
            "filename": filename,
            "loaded_at": _now_iso(),
            "rows": rows,
            "count": len(rows),
        }
        # Guardar como sesión activa y añadir al historial
        _cargas_doc().set(session)
        _cargas_sessions_col().document(session_id).set({
            "session_id": session_id,
            "filename": filename,
            "loaded_at": _now_iso(),
            "count": len(rows),
            "rows": rows,
        })
        # Auto-encolar en la cola
        auto_count = 0
        snap = Q.snapshot()
        existing_ids = {
            it["id"] for lst in [
                snap.get("queued", []), snap.get("queued_refr", []),
                snap.get("queued_con", []), snap.get("assigned", []),
                snap.get("assigned_refr", []), snap.get("assigned_con", []),
                snap.get("pending_merch", []), snap.get("pending_merch_refr", []),
                snap.get("pending_merch_con", []),
            ] for it in lst
        }
        for row in rows:
            ruta = str(row.get("ruta") or "").strip()
            if not ruta or ruta in existing_ids:
                continue
            Q.enqueue_manual(row, urgente=False)
            auto_count += 1
        return {
            "ok": True, "rows": rows, "filename": filename,
            "count": len(rows), "auto_enqueued": auto_count,
            "session_id": session_id,
        }
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
    allowed = {"cif", "agencia", "estado", "precintos_data", "muelle", "playa", "matriculas"}
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
    # Buscar la sesión completa en cargas_sessions (con rows)
    full = _cargas_sessions_col().document(session_id).get()
    if not full.exists:
        return {"ok": False, "error": "Sesión no encontrada"}
    _cargas_doc().set(full.to_dict())
    return {"ok": True, "session_id": session_id}


# ── AS400 ─────────────────────────────────────────────────────────────────
def _lookup_chf(matricula: str):
    data = C.lookup_chf(matricula)
    if data:
        return {"ok": True, **data}
    return {"ok": False, "error": "No encontrado"}


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


def _graph_list_files():
    cfg = _graph_reader_cfg()
    if not (cfg.get("enabled") and cfg.get("tenant_id") and cfg.get("client_id") and cfg.get("client_secret")):
        return {"ok": True, "files": []}
    try:
        token = _graph_token(cfg)
        site = _graph_site_id(cfg, token)
        folder = (cfg.get("folder_path") or "").strip("/")
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
    "get_cargas_state":         lambda *a, **k: _get_cargas_state(),
    "update_row":               lambda *a, **k: _update_row(*a, **k),
    "get_excel_sessions":       lambda *a, **k: _get_excel_sessions(),
    "switch_excel_session":     lambda *a, **k: _switch_excel_session(*a, **k),
    "lookup_chf":               lambda *a, **k: _lookup_chf(*a, **k),
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
    timeout_sec=60,
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
