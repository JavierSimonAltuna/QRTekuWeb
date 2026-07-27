"""
PULSO · Lector de Excel desde SharePoint / OneDrive via API.

Modos
-----
sharepoint  Usa la API REST de SharePoint  → permiso Sites.FullControl.All (ya concedido)
graph       Usa Microsoft Graph             → permiso Files.Read.All (requiere añadirlo)

Config guardada en: Documents/QRTeku/QR_WORDS/graph_config.json

Campos comunes
--------------
  enabled       bool   — activar
  mode          str    — "sharepoint" | "graph"
  tenant_id     str    — ID del directorio Azure
  client_id     str    — ID de la aplicación
  client_secret str    — Secreto de cliente

Modo sharepoint
---------------
  sharepoint_url  str  — ej. "https://garvasa.sharepoint.com"
  site_path       str  — ej. "/sites/Logistica"  (vacío = sitio raíz)
  file_path       str  — ruta relativa al sitio, ej. "/Documentos compartidos/Cargas.xlsx"

Modo graph (OneDrive)
---------------------
  user_email  str  — ej. "jose@garvasa.com"
  file_path   str  — ej. "/Documentos/Cargas.xlsx"
  drive_id    str  — (opcional) ID del drive
  item_id     str  — (opcional) ID del item; preferencia sobre file_path
"""

import json
import os
import tempfile

import qr_teku_core as core
from app_logger import log, log_exc

CONFIG_FILE = core.SAVE_DIR / "graph_config.json"
_REQUIRED = ("tenant_id", "client_id", "client_secret")


class GraphExcelReader:
    def __init__(self):
        self._cfg: dict | None = None
        self._app = None

    # ──────────────────────── Config ────────────────────────

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
            safe["client_secret"] = "•" * 8
        return safe

    def is_configured(self) -> bool:
        if not self._cfg or not self._cfg.get("enabled"):
            return False
        if not all(self._cfg.get(k) for k in _REQUIRED):
            return False
        mode = self._cfg.get("mode", "sharepoint")
        if mode == "sharepoint":
            return bool(self._cfg.get("sharepoint_url") and self._cfg.get("file_path"))
        # graph / OneDrive
        return bool(self._cfg.get("item_id") or self._cfg.get("file_path"))

    # ──────────────────────── Auth ────────────────────────

    def _get_app(self):
        if self._app is None:
            import msal
            self._app = msal.ConfidentialClientApplication(
                self._cfg["client_id"],
                authority=f"https://login.microsoftonline.com/{self._cfg['tenant_id']}",
                client_credential=self._cfg["client_secret"],
            )
        return self._app

    def _get_token(self, scope: str) -> str:
        result = self._get_app().acquire_token_for_client(scopes=[scope])
        if "access_token" not in result:
            err = result.get("error_description") or result.get("error") or str(result)
            raise RuntimeError(f"Token error: {err}")
        return result["access_token"]

    # ──────────────────────── Descarga SharePoint ────────────────────────

    def _download_sharepoint(self) -> tuple[bytes, str]:
        sp_url   = self._cfg["sharepoint_url"].rstrip("/")
        site_path = self._cfg.get("site_path", "").rstrip("/")
        file_path = self._cfg.get("file_path", "")
        if not file_path.startswith("/"):
            file_path = "/" + file_path

        # Ruta relativa al servidor: /sites/X/Documentos/Archivo.xlsx
        server_rel = site_path + file_path

        # Token con scope de SharePoint (Sites.FullControl.All)
        scope = f"{sp_url}/.default"
        token = self._get_token(scope)

        import requests as _req
        encoded = _req.utils.quote(server_rel)
        url = (
            f"{sp_url}{site_path}/_api/web/"
            f"GetFileByServerRelativePath(decodedurl='{server_rel}')/$value"
        )
        r = _req.get(url, headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/octet-stream",
        }, timeout=30)
        r.raise_for_status()
        filename = server_rel.rsplit("/", 1)[-1]
        return r.content, filename

    # ──────────────────────── Descarga Graph / OneDrive ────────────────────────

    def _download_graph(self) -> tuple[bytes, str]:
        import requests as _req
        GRAPH = "https://graph.microsoft.com/v1.0"
        token = self._get_token("https://graph.microsoft.com/.default")
        headers = {"Authorization": f"Bearer {token}"}

        cfg       = self._cfg
        drive_id  = cfg.get("drive_id", "")
        item_id   = cfg.get("item_id", "")
        email     = cfg.get("user_email", "")
        fpath     = cfg.get("file_path", "").lstrip("/")

        if item_id and drive_id:
            url = f"{GRAPH}/drives/{drive_id}/items/{item_id}/content"
        elif item_id:
            user_seg = f"users/{email}" if email else "me"
            url = f"{GRAPH}/{user_seg}/drive/items/{item_id}/content"
        elif drive_id:
            url = f"{GRAPH}/drives/{drive_id}/root:/{fpath}:/content"
        else:
            user_seg = f"users/{email}" if email else "me"
            url = f"{GRAPH}/{user_seg}/drive/root:/{fpath}:/content"

        r = _req.get(url, headers=headers, timeout=30)
        r.raise_for_status()
        filename = fpath.rsplit("/", 1)[-1] if fpath else "excel.xlsx"
        return r.content, filename

    # ──────────────────────── API pública ────────────────────────

    def download_bytes(self) -> tuple[bytes, str]:
        """Descarga el Excel y devuelve (bytes, filename)."""
        mode = self._cfg.get("mode", "sharepoint")
        if mode == "sharepoint":
            return self._download_sharepoint()
        return self._download_graph()


# ──────────────────────── Singleton ────────────────────────

_reader = GraphExcelReader()


def get_reader() -> GraphExcelReader:
    if _reader._cfg is None:
        _reader.load_config()
    return _reader
