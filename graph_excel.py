"""
PULSO · Lector de Excel desde Microsoft 365 / OneDrive via Graph API.
Requiere: msal, requests   (incluidos en requirements.txt)

Config persistida en: Documents/QRTeku/QR_WORDS/graph_config.json
Campos:
    enabled       bool   — activar lectura desde Graph
    tenant_id     str    — ID del directorio Azure (Entra ID)
    client_id     str    — ID de la aplicación registrada
    client_secret str    — Secreto de cliente
    user_email    str    — Email M365 del usuario dueño del OneDrive
    file_path     str    — Ruta en OneDrive, ej. /Documentos/Cargas.xlsx
    drive_id      str    — (opcional) ID del drive si no es el personal
    item_id       str    — (opcional) ID del item; tiene preferencia sobre file_path
"""

import json
import os
import tempfile

import qr_teku_core as core
from app_logger import log, log_exc

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
CONFIG_FILE = core.SAVE_DIR / "graph_config.json"

_REQUIRED = ("tenant_id", "client_id", "client_secret")


class GraphExcelReader:
    def __init__(self):
        self._cfg: dict | None = None
        self._app = None  # msal.ConfidentialClientApplication (lazy)

    # ─────────────────── Config ───────────────────

    def load_config(self) -> bool:
        if not CONFIG_FILE.exists():
            return False
        try:
            with open(CONFIG_FILE, encoding="utf-8") as f:
                self._cfg = json.load(f)
            self._app = None
            return True
        except Exception as e:
            log("WARNING", "graph_config_load", error=str(e))
            return False

    def save_config(self, cfg: dict):
        # Si el secreto llega enmascarado, mantener el guardado
        if cfg.get("client_secret", "").startswith("•"):
            cfg["client_secret"] = (self._cfg or {}).get("client_secret", "")
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        self._cfg = cfg
        self._app = None

    def get_config_safe(self) -> dict:
        if not self._cfg:
            return {}
        safe = dict(self._cfg)
        if safe.get("client_secret"):
            safe["client_secret"] = "•" * 8  # máscarar
        return safe

    def is_configured(self) -> bool:
        if not self._cfg or not self._cfg.get("enabled"):
            return False
        if not all(self._cfg.get(k) for k in _REQUIRED):
            return False
        return bool(self._cfg.get("item_id") or self._cfg.get("file_path"))

    # ─────────────────── Auth ───────────────────

    def _get_app(self):
        if self._app is None:
            import msal
            self._app = msal.ConfidentialClientApplication(
                self._cfg["client_id"],
                authority=f"https://login.microsoftonline.com/{self._cfg['tenant_id']}",
                client_credential=self._cfg["client_secret"],
            )
        return self._app

    def _get_token(self) -> str:
        result = self._get_app().acquire_token_for_client(
            scopes=["https://graph.microsoft.com/.default"]
        )
        if "access_token" not in result:
            err = result.get("error_description") or result.get("error") or str(result)
            raise RuntimeError(f"Token error: {err}")
        return result["access_token"]

    # ─────────────────── Descarga ───────────────────

    def _build_url(self) -> str:
        cfg = self._cfg
        drive_id = cfg.get("drive_id", "")
        item_id  = cfg.get("item_id", "")
        email    = cfg.get("user_email", "")
        fpath    = cfg.get("file_path", "").lstrip("/")

        if item_id and drive_id:
            return f"{GRAPH_BASE}/drives/{drive_id}/items/{item_id}/content"
        if item_id:
            user_seg = f"users/{email}" if email else "me"
            return f"{GRAPH_BASE}/{user_seg}/drive/items/{item_id}/content"
        if drive_id:
            return f"{GRAPH_BASE}/drives/{drive_id}/root:/{fpath}:/content"
        user_seg = f"users/{email}" if email else "me"
        return f"{GRAPH_BASE}/{user_seg}/drive/root:/{fpath}:/content"

    def download_bytes(self) -> tuple[bytes, str]:
        """Descarga el Excel y devuelve (bytes, filename)."""
        import requests as _req
        token = self._get_token()
        url   = self._build_url()
        r = _req.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
        r.raise_for_status()
        filename = self._cfg.get("file_path", "graph_excel.xlsx").rsplit("/", 1)[-1]
        return r.content, filename


# ─────────────────── Singleton ───────────────────

_reader = GraphExcelReader()


def get_reader() -> GraphExcelReader:
    if _reader._cfg is None:
        _reader.load_config()
    return _reader
