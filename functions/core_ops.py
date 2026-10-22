"""
PULSO · Llamadas al AS400 via FastAPI bridge
=============================================
Equivalente a las funciones odbc_* de qr_teku_core.py,
pero solo usando la API HTTP (PULSO_API_URL / PULSO_API_TOKEN).
"""

from __future__ import annotations

import json
import os
import urllib.request
import urllib.parse

PULSO_API_URL = os.environ.get("PULSO_API_URL", "").rstrip("/")
PULSO_API_TOKEN = os.environ.get("PULSO_API_TOKEN", "")


def _get(path: str, params: dict | None = None) -> dict | None:
    if not PULSO_API_URL or not PULSO_API_TOKEN:
        return None
    try:
        url = PULSO_API_URL + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {PULSO_API_TOKEN}"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"[core_ops] API error {path}: {e}")
        return None


def lookup_chf(matricula: str) -> dict:
    """Busca datos del camión por matrícula en GEZCAM."""
    if not matricula:
        return {}
    data = _get("/api/pulso/gezcam/lookup", {"matricula": matricula})
    if data and data.get("ok"):
        return data.get("data", {})
    return {}


def lookup_client(codcli: str) -> dict:
    """Busca datos del cliente en GECLI2."""
    if not codcli:
        return {}
    data = _get("/api/pulso/gecli2/cif", {"codcli": codcli})
    if data and data.get("ok"):
        return data.get("data", {})
    return {}


def load_gezcat() -> dict:
    """Carga la tabla GEZCAT (planes)."""
    data = _get("/api/pulso/gezcat")
    if data and data.get("ok"):
        return data.get("data", {})
    return {}


def lookup_touliv1(codcli: str, codact: str) -> str:
    """Consulta TOULIV1 para un cliente/actividad."""
    if not codcli:
        return ""
    data = _get("/api/pulso/gecli2/touliv1", {"codcli": codcli, "codact": codact})
    if data and data.get("ok"):
        return str(data.get("touliv1", ""))
    return ""


def count_gesupe6(ruta: str) -> int:
    """Cuenta soportes en GESUPE6."""
    if not ruta:
        return 0
    data = _get("/api/pulso/gesupe6/count", {"ruta": ruta})
    if data and data.get("ok"):
        return int(data.get("count", 0))
    return 0


def count_gesupej(codcli: str, ambiente: str) -> int:
    """Cuenta precintos en GESUPEJ."""
    if not codcli:
        return 0
    data = _get("/api/pulso/gesupej/count", {"codcli": codcli, "ambiente": ambiente})
    if data and data.get("ok"):
        return int(data.get("count", 0))
    return 0


def is_configured() -> bool:
    return bool(PULSO_API_URL and PULSO_API_TOKEN)


def diagnostics() -> dict:
    return {
        "api_url": PULSO_API_URL or "(no configurada)",
        "api_token_set": bool(PULSO_API_TOKEN),
        "connected": is_configured(),
    }
