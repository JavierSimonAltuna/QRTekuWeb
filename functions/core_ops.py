"""
PULSO · Llamadas al AS400 via FastAPI bridge
=============================================
La URL y el token se leen desde Firestore (config/api)
para poder modificarlos desde la app sin redesplegar.
"""

from __future__ import annotations

import json
import urllib.request
import urllib.parse

_cfg_cache: dict | None = None


def _load_cfg() -> dict:
    """Lee config/api de Firestore (con caché en memoria por instancia)."""
    global _cfg_cache
    if _cfg_cache is not None:
        return _cfg_cache
    try:
        from firebase_admin import firestore
        doc = firestore.client().collection("config").document("api").get()
        _cfg_cache = doc.to_dict() if doc.exists else {}
    except Exception:
        _cfg_cache = {}
    return _cfg_cache


def _invalidate_cache():
    global _cfg_cache
    _cfg_cache = None


def _api_url() -> str:
    return (_load_cfg().get("api_url") or "").rstrip("/")


def _api_token() -> str:
    return _load_cfg().get("api_token") or ""


def _get(path: str, params: dict | None = None) -> dict | None:
    url_base = _api_url()
    token = _api_token()
    if not url_base or not token:
        return None
    try:
        url = url_base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {token}"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"[core_ops] API error {path}: {e}")
        return None


def _norm_tractor(s: str) -> str:
    """Normaliza matrícula igual que el desktop: mayúsculas, sin espacios ni guiones."""
    return (s or "").upper().replace(" ", "").replace("-", "").strip()


def _parse_chf_response(data: dict) -> dict:
    """Extrae cif/agencia de respuesta del bridge (anidada o plana)."""
    if not (data and data.get("ok")):
        return {}
    nested = data.get("data")
    if isinstance(nested, dict) and nested:
        return nested
    flat = {k: v for k, v in data.items() if k not in ("ok", "error", "data", "found")}
    return flat if flat else {}


def lookup_chf(matricula: str) -> dict:
    if not matricula:
        return {}
    tractora_norm = _norm_tractor(matricula)
    # Intento 1: matrícula normalizada (sin guiones ni espacios)
    data = _get("/api/pulso/gezcam/lookup", {"matricula": tractora_norm})
    result = _parse_chf_response(data)
    if result:
        return result
    # Intento 2: matrícula original (por si el bridge hace match sin normalizar)
    if tractora_norm != matricula.upper().strip():
        data2 = _get("/api/pulso/gezcam/lookup", {"matricula": matricula.upper().strip()})
        result2 = _parse_chf_response(data2)
        if result2:
            return result2
    return {}


def lookup_client(codcli: str) -> dict:
    if not codcli:
        return {}
    data = _get("/api/pulso/gecli2/cif", {"codcli": codcli})
    if data and data.get("ok"):
        return data.get("data", {})
    return {}


def load_gezcat() -> dict:
    data = _get("/api/pulso/gezcat")
    if data and data.get("ok"):
        return data.get("data", {})
    return {}


def lookup_touliv1(codcli: str, codact: str) -> str:
    if not codcli:
        return ""
    data = _get("/api/pulso/gecli2/touliv1", {"codcli": codcli, "codact": codact})
    if data and data.get("ok"):
        return str(data.get("touliv1", ""))
    return ""


def count_gesupe6(ruta: str) -> int:
    if not ruta:
        return 0
    data = _get("/api/pulso/gesupe6/count", {"ruta": ruta})
    if data and data.get("ok"):
        return int(data.get("count", 0))
    return 0


def count_gesupej(codcli: str, ambiente: str) -> int:
    if not codcli:
        return 0
    data = _get("/api/pulso/gesupej/count", {"codcli": codcli, "ambiente": ambiente})
    if data and data.get("ok"):
        return int(data.get("count", 0))
    return 0


def is_configured() -> bool:
    return bool(_api_url() and _api_token())


def test_connection() -> dict:
    url = _api_url()
    token = _api_token()
    if not url:
        return {"ok": False, "error": "URL no configurada"}
    if not token:
        return {"ok": False, "error": "Token no configurado"}
    import urllib.error
    try:
        req = urllib.request.Request(
            url.rstrip("/") + "/api/pulso/gezcat",
            headers={"Authorization": f"Bearer {token}"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            json.loads(resp.read().decode())
            return {"ok": True, "message": "API conectada correctamente"}
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return {"ok": False, "error": f"Token inválido (HTTP {e.code})"}
        return {"ok": False, "error": f"Error HTTP {e.code}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def diagnostics() -> dict:
    return {
        "api_url": _api_url() or "(no configurada)",
        "api_token_set": bool(_api_token()),
        "connected": is_configured(),
    }


# ── Leer / guardar config desde la app ────────────────────────────────────

def get_api_config() -> dict:
    """Devuelve la config de la API (token enmascarado)."""
    cfg = _load_cfg()
    token = cfg.get("api_token", "")
    return {
        "ok": True,
        "api_url": cfg.get("api_url", ""),
        "api_token": ("•" * 12 + token[-4:]) if len(token) > 4 else ("•" * len(token)),
        "configured": is_configured(),
    }


def save_api_config(api_url: str, api_token: str = "") -> dict:
    """Guarda URL y token en Firestore. Si el token son puntos, mantiene el actual."""
    try:
        from firebase_admin import firestore
        doc_ref = firestore.client().collection("config").document("api")
        existing = doc_ref.get()
        current = existing.to_dict() if existing.exists else {}

        new_url = (api_url or "").rstrip("/").strip()
        # Si el token recibido es solo puntos (enmascarado), mantener el actual
        if api_token and not all(c == "•" for c in api_token):
            new_token = api_token.strip()
        else:
            new_token = current.get("api_token", "")

        doc_ref.set({"api_url": new_url, "api_token": new_token})
        _invalidate_cache()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}
