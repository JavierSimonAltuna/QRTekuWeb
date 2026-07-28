"""
PULSO · Lector de Excel desde SharePoint / OneDrive via Microsoft Graph API.

Todos los accesos a SharePoint usan Microsoft Graph API (más moderna y fiable
que la SharePoint REST API legacy). Requiere permiso:
  Sites.Read.All  (Microsoft Graph · Application) + admin consent

Modos de conexión
-----------------
sharepoint  SharePoint via Graph API  → Sites.Read.All
graph       OneDrive via Graph API    → Files.Read.All o Sites.Read.All

Fuente (source)
---------------
file    Archivo fijo en una ruta conocida
folder  Carpeta: PULSO lista los .xlsx y el usuario elige cuál cargar

Config guardada en: Documents/QRTeku/QR_WORDS/graph_config.json

Campos comunes
--------------
  enabled       bool   — activar
  mode          str    — "sharepoint" | "graph"
  source        str    — "file" | "folder"
  tenant_id     str    — ID del directorio Azure
  client_id     str    — ID de la aplicación
  client_secret str    — Secreto de cliente

Modo sharepoint + source=file
-----------------------------
  sharepoint_url  str  — ej. "https://garvasalogistica.sharepoint.com"
  site_path       str  — ej. "/sites/DatosGarvasa"
  file_path       str  — ruta relativa a la raíz del drive, ej. "/Documentos compartidos/Cargas.xlsx"

Modo sharepoint + source=folder
--------------------------------
  sharepoint_url  str  — ej. "https://garvasalogistica.sharepoint.com"
  site_path       str  — ej. "/sites/DatosGarvasa"
  folder_path     str  — carpeta con los Excels, ej. "/Documentos compartidos/Expediciones/PLAN DE CARGA"

Modo graph (OneDrive)
---------------------
  user_email  str  — ej. "jose@garvasa.com"
  file_path   str  — ej. "/Documentos/Cargas.xlsx"
  drive_id    str  — (opcional) ID del drive
  item_id     str  — (opcional) ID del item; preferencia sobre file_path
"""

import json

import qr_teku_core as core
from app_logger import log, log_exc

CONFIG_FILE = core.SAVE_DIR / "graph_config.json"
GRAPH = "https://graph.microsoft.com/v1.0"
GRAPH_SCOPE = "https://graph.microsoft.com/.default"
_REQUIRED = ("tenant_id", "client_id", "client_secret")

# Prefijo interno para referencias de archivo vía Graph API
_GRAPH_REF_PREFIX = "__graph__"


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
        mode   = self._cfg.get("mode",   "sharepoint")
        source = self._cfg.get("source", "file")
        if mode == "sharepoint":
            if not self._cfg.get("sharepoint_url"):
                return False
            if source == "folder":
                return bool(self._cfg.get("folder_path"))
            return bool(self._cfg.get("file_path"))
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

    def _graph_headers(self) -> dict:
        return {"Authorization": f"Bearer {self._get_token(GRAPH_SCOPE)}"}

    # ──────────────────────── SharePoint via Graph API ────────────────────────

    def _get_site_id(self) -> str:
        """Obtiene el ID del site de SharePoint usando Graph API."""
        import requests as _req
        sp_url    = self._cfg["sharepoint_url"].rstrip("/")
        host      = sp_url.split("://")[-1]  # garvasalogistica.sharepoint.com
        site_path = self._cfg.get("site_path", "").strip("/")  # sites/DatosGarvasa

        url = f"{GRAPH}/sites/{host}:/{site_path}" if site_path else f"{GRAPH}/sites/{host}"
        r = _req.get(url, headers=self._graph_headers(), timeout=30)
        r.raise_for_status()
        return r.json()["id"]

    def _find_drive(self, site_id: str, library_name: str) -> str | None:
        """Busca el drive (biblioteca) cuyo nombre coincide con library_name."""
        import requests as _req
        r = _req.get(f"{GRAPH}/sites/{site_id}/drives",
                     headers=self._graph_headers(), timeout=30)
        r.raise_for_status()
        for d in r.json().get("value", []):
            if d.get("name", "").lower() == library_name.lower():
                return d["id"]
        return None

    def list_folder_files(self) -> list[dict]:
        """Lista los .xlsx de la carpeta configurada via Graph API.
        Devuelve [{name, server_url, modified, size_kb}]."""
        import requests as _req
        site_id = self._get_site_id()
        folder  = self._cfg.get("folder_path", "").strip("/")

        # La folder_path incluye la biblioteca como primer componente:
        # "Documentos compartidos/Expediciones/PLAN DE CARGA"
        # → biblioteca: "Documentos compartidos"
        # → subcarpeta: "Expediciones/PLAN DE CARGA"
        parts        = folder.split("/", 1)
        library_name = parts[0]
        sub_path     = parts[1] if len(parts) > 1 else ""

        drive_id = self._find_drive(site_id, library_name)

        if drive_id and sub_path:
            url = f"{GRAPH}/drives/{drive_id}/root:/{sub_path}:/children"
        elif drive_id:
            url = f"{GRAPH}/drives/{drive_id}/root/children"
        else:
            # Fallback: usar el drive por defecto del sitio con la ruta completa
            url = f"{GRAPH}/sites/{site_id}/drive/root:/{folder}:/children"

        r = _req.get(url, headers=self._graph_headers(),
                     params={"$orderby": "lastModifiedDateTime desc", "$top": "50"},
                     timeout=30)
        r.raise_for_status()
        items = r.json().get("value", [])

        result = []
        for item in items:
            name = item.get("name", "")
            if name.lower().endswith((".xlsx", ".xls")):
                ref = f"{_GRAPH_REF_PREFIX}{site_id}|{item['id']}|{name}"
                result.append({
                    "name":       name,
                    "server_url": ref,
                    "modified":   item.get("lastModifiedDateTime", ""),
                    "size_kb":    round(item.get("size", 0) / 1024, 1),
                })
        return result

    def download_by_server_url(self, server_url: str) -> tuple[bytes, str]:
        """Descarga un archivo por su referencia (Graph ref o ServerRelativeUrl legacy)."""
        if server_url.startswith(_GRAPH_REF_PREFIX):
            return self._download_graph_item(server_url[len(_GRAPH_REF_PREFIX):])
        # Fallback legacy: SharePoint REST API (por si hay referencias antiguas guardadas)
        return self._download_sp_rest(server_url)

    def _download_graph_item(self, ref: str) -> tuple[bytes, str]:
        """Descarga un archivo de SharePoint usando Graph API.
        ref: '{site_id}|{item_id}|{filename}'"""
        import requests as _req
        parts = ref.split("|", 2)
        site_id  = parts[0]
        item_id  = parts[1]
        filename = parts[2] if len(parts) > 2 else "excel.xlsx"

        url = f"{GRAPH}/sites/{site_id}/drive/items/{item_id}/content"
        r = _req.get(url, headers=self._graph_headers(), timeout=60, allow_redirects=True)
        r.raise_for_status()
        return r.content, filename

    def _download_sp_rest(self, server_url: str) -> tuple[bytes, str]:
        """Descarga legacy por SharePoint REST API (fallback)."""
        import requests as _req
        sp_url    = self._cfg["sharepoint_url"].rstrip("/")
        site_path = self._cfg.get("site_path", "").rstrip("/")
        url = (
            f"{sp_url}{site_path}/_api/web/"
            f"GetFileByServerRelativePath(decodedurl='{server_url}')/$value"
        )
        sp_token = self._get_token(f"{sp_url}/.default")
        r = _req.get(url, headers={
            "Authorization": f"Bearer {sp_token}",
            "Accept": "application/octet-stream",
        }, timeout=60)
        r.raise_for_status()
        filename = server_url.rsplit("/", 1)[-1]
        return r.content, filename

    # ──────────────────────── Descarga SharePoint (archivo fijo) via Graph ────────────────────────

    def _download_sharepoint_file(self) -> tuple[bytes, str]:
        """Descarga el archivo fijo de SharePoint usando Graph API."""
        import requests as _req
        site_id   = self._get_site_id()
        file_path = self._cfg.get("file_path", "").strip("/")

        url = f"{GRAPH}/sites/{site_id}/drive/root:/{file_path}:/content"
        r = _req.get(url, headers=self._graph_headers(), timeout=60, allow_redirects=True)
        r.raise_for_status()
        filename = file_path.rsplit("/", 1)[-1] if file_path else "excel.xlsx"
        return r.content, filename

    # ──────────────────────── Descarga Graph / OneDrive ────────────────────────

    def _download_graph(self) -> tuple[bytes, str]:
        import requests as _req
        cfg      = self._cfg
        drive_id = cfg.get("drive_id", "")
        item_id  = cfg.get("item_id", "")
        email    = cfg.get("user_email", "")
        fpath    = cfg.get("file_path", "").lstrip("/")

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

        r = _req.get(url, headers=self._graph_headers(), timeout=60, allow_redirects=True)
        r.raise_for_status()
        filename = fpath.rsplit("/", 1)[-1] if fpath else "excel.xlsx"
        return r.content, filename

    # ──────────────────────── API pública ────────────────────────

    def download_bytes(self, server_url: str = "") -> tuple[bytes, str]:
        """Descarga el Excel y devuelve (bytes, filename).
        server_url: referencia al archivo (de list_folder_files o guardada en _graph_server_url).
        """
        mode = self._cfg.get("mode", "sharepoint")
        if mode == "sharepoint":
            if server_url:
                return self.download_by_server_url(server_url)
            return self._download_sharepoint_file()
        return self._download_graph()


# ──────────────────────── Singleton ────────────────────────

_reader = GraphExcelReader()


def get_reader() -> GraphExcelReader:
    if _reader._cfg is None:
        _reader.load_config()
    return _reader
