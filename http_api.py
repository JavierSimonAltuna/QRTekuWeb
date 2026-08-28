"""
QR Teku · API HTTP
==================
Wrapper que expone los métodos públicos de `Api` (api.py) también por HTTP,
para que los móviles de cargadores (en LAN) puedan llamarlos.

Misma firma que el bridge pywebview:
    POST /api/<método>   body JSON {args, kwargs}   →   200 JSON respuesta

El handler también sirve los ficheros estáticos de web/ como antes.
"""

import json
import traceback
from http.server import SimpleHTTPRequestHandler

from app_logger import log, log_exc


# Lista blanca de métodos invocables por HTTP (los necesarios para la vista cargador
# y la consulta de cola; los diálogos nativos como pick_excel se excluyen).
ALLOWED_METHODS = {
    # Loader
    "loader_login",
    "loader_current",
    "loader_request_next",
    "loader_refresh_precintos",
    "loader_finish",
    "loader_set_muelle",
    # Cargas (supervisor desde navegador o tablet)
    "load_excel_base64",
    "reload_excel",
    "lookup_chf",
    "generate_word_and_print",
    # Cola (supervisor, lectura/escritura)
    "queue_snapshot",
    "queue_enqueue_manual",
    "queue_remove",
    "queue_reassign",
    "queue_set_urgent",
    "queue_set_comment",
    "queue_set_supervisor_files",
    "queue_force_queued",
    "queue_send_to_pending_merch",
    "queue_reset_done",
    "queue_reset_queued",
    "queue_update_ruta",
    "queue_block",
    "queue_unblock",
    "queue_assign_helper",
    "queue_remove_helper",
    "queue_set_load_start",
    "queue_set_load_end",
    "queue_change_queue_type",
    "export_cargas_csv",
    # Diagnóstico
    "get_odbc_diagnostics",
    "get_debug_log",
    # Gestión de cargadores (supervisor)
    "loader_upsert",
    "loader_remove",
    # Útiles desde móvil (lectura)
    "app_info",
    "get_cargas_state",
    "update_row",
    # Historial Excel y actividad
    "get_excel_sessions",
    "switch_excel_session",
    "get_audit_log",
    # Microsoft 365 / SharePoint
    "graph_get_config",
    "graph_save_config",
    "graph_test",
    "graph_list_files",
    "graph_load_file",
    "graph_download_b64",
}


def make_handler(api, web_dir: str):
    """Crea una clase handler ligada a una instancia de Api."""

    class _Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=web_dir, **kwargs)

        # CORS abierto (sólo se sirve en LAN local del cliente)
        def end_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            super().end_headers()

        def log_message(self, format, *args):
            # Silencio (evita ruido en consola)
            return

        def do_OPTIONS(self):
            self.send_response(204)
            self.end_headers()

        def do_GET(self):
            # Descarga directa de CSV — GET /api/download/cargas.csv o /api/download/actividad.csv
            if self.path.startswith("/api/download/"):
                name = self.path[len("/api/download/"):].split("?")[0]
                try:
                    if name == "cargas.csv":
                        content = api.get_manager_csv("cargas")
                        fname = "pulso_cargas.csv"
                    elif name == "actividad.csv":
                        content = api.get_manager_csv("actividad")
                        fname = "pulso_actividad.csv"
                    else:
                        self._json(404, {"ok": False, "error": "Fichero no disponible"})
                        return
                    payload = content.encode("utf-8-sig")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv; charset=utf-8")
                    self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except Exception as e:
                    self._json(500, {"ok": False, "error": str(e)})
                return
            # Resto de GETs → ficheros estáticos
            super().do_GET()

        def do_POST(self):
            if not self.path.startswith("/api/"):
                self._json(404, {"ok": False, "error": "Not found"})
                return
            method_name = self.path[len("/api/"):].split("?")[0].strip("/")
            if method_name not in ALLOWED_METHODS:
                self._json(403, {"ok": False, "error": f"Método no permitido: {method_name}"})
                return
            method = getattr(api, method_name, None)
            if not callable(method):
                self._json(404, {"ok": False, "error": f"Método no existe: {method_name}"})
                return

            # Leer body JSON
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b""
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception as e:
                self._json(400, {"ok": False, "error": f"JSON inválido: {e}"})
                return

            args = body.get("args", []) or []
            kwargs = body.get("kwargs", {}) or {}
            try:
                result = method(*args, **kwargs)
                self._json(200, result)
            except Exception as e:
                log_exc(f"HTTP API {method_name}", e)
                self._json(500, {
                    "ok": False,
                    "error": str(e),
                    "trace": traceback.format_exc(),
                })

        def _json(self, code: int, data):
            payload = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return _Handler
