"""
PULSO · Llamadas al AS400 via FastAPI bridge
=============================================
La URL y el token se leen desde Firestore (config/api)
para poder modificarlos desde la app sin redesplegar.

Endpoints FastAPI (todos GET con Authorization: Bearer <token>):
  GET /api/pulso/gezcam/lookup?matricula=XXX
  GET /api/pulso/gecli2/cif?codcli=XXX
  GET /api/pulso/gecli2/touliv1?codcli=XXX&codact=101
  GET /api/pulso/gesupe6/count?touliv=XXX
  GET /api/pulso/gesupej/count?codcli=XXX&ambiente=true
  GET /api/pulso/gezcat
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
    """GET /path?params con Authorization: Bearer <token>."""
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
        print(f"[core_ops] _get {path}: {e}")
        return None


def _norm_tractor(s: str) -> str:
    """Normaliza matrícula: mayúsculas, sin espacios ni guiones."""
    return (s or "").upper().replace(" ", "").replace("-", "").strip()


def _parse_chf_response(data: dict) -> dict:
    """Extrae cif/agencia de respuesta del bridge. Verifica ok y found."""
    if not (data and data.get("ok") and data.get("found")):
        return {}
    cif = str(data.get("cif") or "").strip()
    agencia = str(data.get("agencia") or "").strip()
    if not (cif and agencia):
        return {}
    return {"cif": cif, "agencia": agencia}


def lookup_chf(matricula: str) -> dict:
    if not matricula:
        return {}
    tractora_norm = _norm_tractor(matricula)
    data = _get("/api/pulso/gezcam/lookup", {"matricula": tractora_norm})
    result = _parse_chf_response(data)
    if result:
        return result
    # Intento con matrícula original si es diferente de la normalizada
    orig = matricula.upper().strip()
    if orig != tractora_norm:
        data2 = _get("/api/pulso/gezcam/lookup", {"matricula": orig})
        result2 = _parse_chf_response(data2)
        if result2:
            return result2
    return {}


def lookup_client(codcli: str) -> dict:
    if not codcli:
        return {}
    data = _get("/api/pulso/gecli2/cif", {"codcli": codcli})
    if data and data.get("ok") and data.get("found"):
        return {"cif": str(data.get("cif") or ""), "nombre": str(data.get("agencia") or "")}
    return {}


def load_gezcat() -> dict:
    """Devuelve dict {catcli: libcat} con la tabla GEZCAT completa."""
    data = _get("/api/pulso/gezcat")
    if data and data.get("ok"):
        items = data.get("data") or []
        if isinstance(items, list):
            return {item.get("catcli"): item.get("libcat") for item in items if item.get("catcli")}
    return {}


def lookup_touliv1(codcli: str, codact: str = "101") -> str:
    """Devuelve TOULIV1 como string, o '' si no se encuentra."""
    if not codcli:
        return ""
    data = _get("/api/pulso/gecli2/touliv1", {"codcli": codcli, "codact": codact})
    if data and data.get("ok") and data.get("found"):
        v = data.get("touliv1")
        return str(int(v)) if v is not None else ""
    return ""


def count_gesupe6(ruta: str) -> int:
    """Cuenta pales en GESUPE6 WHERE TOULIV=ruta. El param del endpoint es 'touliv'."""
    if not ruta:
        return 0
    try:
        touliv = int(float(str(ruta)))
    except (ValueError, TypeError):
        return 0
    data = _get("/api/pulso/gesupe6/count", {"touliv": touliv})
    if data and data.get("ok"):
        return int(data.get("count", 0))
    return 0


def count_gesupej(codcli: str, ambiente: str = "true") -> int:
    """Cuenta pales en GESUPEJ. ambiente='true'|'false'."""
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
            url.rstrip("/") + "/api/test/pulso/infolog",
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
