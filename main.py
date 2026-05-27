"""
PULSO · Punto de entrada
==========================
Crea la ventana PyWebView, expone la API Python al JavaScript, y carga el frontend.
Usa un servidor HTTP local interno para servir web/ (evita problemas de file:// con blobs).

Desarrollo:  python main.py
Empaquetar:  build.bat
"""

import sys
import os
import socket
import threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import functools

import webview

from api import Api
from http_api import make_handler

HTTP_PORT = int(os.environ.get("PULSO_PORT", 8765))


def get_web_dir() -> Path:
    """Carpeta web/ — soporta ejecución normal y PyInstaller (--onefile)."""
    if getattr(sys, "frozen", False):
        base = Path(sys._MEIPASS)
    else:
        base = Path(__file__).resolve().parent
    return base / "web"


def start_local_server(web_dir: Path, api) -> tuple[int, str]:
    """Lanza un servidor HTTP en 0.0.0.0 con:
      - Ficheros estáticos de web/
      - POST /api/<método> que invoca la API (los mismos métodos que pywebview.api)
    Devuelve (puerto, ip_lan)."""
    handler_cls = make_handler(api, str(web_dir))
    port = HTTP_PORT
    try:
        server = ThreadingHTTPServer(("0.0.0.0", port), handler_cls)
    except OSError:
        # Puerto fijo ocupado: dejar al OS asignar uno libre
        server = ThreadingHTTPServer(("0.0.0.0", 0), handler_cls)
        port = server.server_address[1]
        print(f"[PULSO] Puerto {HTTP_PORT} ocupado, usando {port}")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    # Detectar IP en LAN (mejor esfuerzo)
    ip_lan = "127.0.0.1"
    try:
        s2 = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s2.connect(("8.8.8.8", 80))
        ip_lan = s2.getsockname()[0]
        s2.close()
    except Exception:
        pass
    return port, ip_lan


def main():
    web_dir = get_web_dir()
    if not (web_dir / "index.html").exists():
        # Fallback: mensaje claro
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk(); root.withdraw()
        messagebox.showerror("PULSO · Error",
                             f"No se encontró web/index.html\nEsperado en: {web_dir}")
        return

    api = Api()
    port, ip_lan = start_local_server(web_dir, api)
    url = f"http://127.0.0.1:{port}/index.html"
    loader_url_lan = f"http://{ip_lan}:{port}/index.html?mode=loader"
    print(f"\n[PULSO] Supervisor: {url}")
    print(f"[PULSO] Cargador (móvil LAN): {loader_url_lan}\n")

    window = webview.create_window(
        title="PULSO · Garvasa",
        url=url,
        js_api=api,
        width=1440,
        height=900,
        min_size=(1100, 720),
        resizable=True,
        text_select=True,
        background_color="#fafaf9",
        easy_drag=False,
    )

    api.set_window(window)

    # debug=True habilita DevTools (F12). Ponlo a False para distribución final.
    DEBUG = False
    webview.start(
        gui="edgechromium" if sys.platform == "win32" else None,
        debug=DEBUG,
    )


if __name__ == "__main__":
    main()
