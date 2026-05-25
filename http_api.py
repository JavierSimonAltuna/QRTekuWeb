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


# Lista blanca de métodos invocables por HTTP (los necesarios para la vista cargador
# y la consulta de cola; los diálogos nativos como pick_excel se excluyen).
ALLOWED_METHODS = {
    # Loader
    "loader_login",
    "loader_current",
    "loader_request_next",
    "loader_finish",
    "loader_set_muelle",
    # Cola (supervisor, lectura/escritura)
    "queue_snapshot",
    "queue_enqueue_manual",
    "queue_remove",
    "queue_reassign",
    "queue_set_urgent",
    "queue_reset_done",
    # Útiles desde móvil (lectura)
    "app_info",
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
