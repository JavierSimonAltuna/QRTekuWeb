"""
QR Teku · API bridge JS ↔ Python
================================
Cada método público de la clase Api está disponible desde JavaScript como:

    window.pywebview.api.<nombre_método>(...args)  // → Promise

Devuelven siempre tipos serializables (dict, list, str, int, bool, None).
Si lanzan excepción, el JS la recibe en el .catch() de la promesa.
"""

import base64
import io
import os
import json
import traceback
from pathlib import Path
from datetime import datetime

import webview

import qr_teku_core as core
import queue_manager
from app_logger import log, log_exc, get_log_lines, LOG_FILE


class _GraphReader:
    """Cliente Microsoft Graph API para SharePoint — sin dependencias externas."""

    def __init__(self):
        self._cfg = self._load_config()

    @staticmethod
    def _load_config() -> dict:
        try:
            f = core.SAVE_DIR / "graph_config.json"
            if f.exists():
                return json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            pass
        return {}

    def get_config_safe(self) -> dict:
        c = dict(self._cfg)
        if c.get("client_secret"):
            c["client_secret"] = "•" * 36
        return c

    def is_configured(self) -> bool:
        return bool(
            self._cfg.get("enabled") and
            self._cfg.get("tenant_id") and
            self._cfg.get("client_id") and
            self._cfg.get("client_secret")
        )

    def save_config(self, cfg: dict):
        current = self._load_config()
        merged = {**current, **cfg}
        if (cfg.get("client_secret") or "").startswith("•") and current.get("client_secret"):
            merged["client_secret"] = current["client_secret"]
        core.SAVE_DIR.mkdir(parents=True, exist_ok=True)
        (core.SAVE_DIR / "graph_config.json").write_text(
            json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        self._cfg = merged

    def _token(self) -> str:
        import msal
        app = msal.ConfidentialClientApplication(
            self._cfg["client_id"],
            authority=f"https://login.microsoftonline.com/{self._cfg['tenant_id']}",
            client_credential=self._cfg["client_secret"],
        )
        res = app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
        if "access_token" not in res:
            raise RuntimeError(res.get("error_description") or res.get("error") or "Auth error")
        return res["access_token"]

    def _get(self, path: str) -> dict:
        import requests as _req
        r = _req.get(
            f"https://graph.microsoft.com/v1.0{path}",
            headers={"Authorization": f"Bearer {self._token()}"},
            timeout=30,
        )
        r.raise_for_status()
        return r.json()

    def _site_id(self) -> str:
        sp = (self._cfg.get("sharepoint_url") or "").rstrip("/")
        host = sp.split("//", 1)[-1].split("/")[0]
        sp_path = (self._cfg.get("site_path") or "").strip("/")
        endpoint = f"/sites/{host}:/{sp_path}" if sp_path else f"/sites/{host}"
        return self._get(endpoint)["id"]

    def list_folder_files(self) -> list:
        site = self._site_id()
        folder = (self._cfg.get("folder_path") or "").strip("/")
        if folder:
            data = self._get(f"/sites/{site}/drive/root:/{folder}:/children")
        else:
            data = self._get(f"/sites/{site}/drive/root/children")
        out = []
        for item in data.get("value", []):
            if not item.get("name", "").lower().endswith(".xlsx"):
                continue
            # server_url = item ID de Graph (único, estable, descargable directamente)
            out.append({
                "name":       item["name"],
                "server_url": item["id"],
                "modified":   item.get("lastModifiedDateTime", ""),
                "size_kb":    round((item.get("size") or 0) / 1024),
            })
        return out

    def download_bytes(self, item_id: str):
        """Descarga un archivo de SharePoint por su Graph item ID."""
        import requests as _req
        site = self._site_id()
        tok = self._token()
        # Obtener nombre del archivo
        meta = _req.get(
            f"https://graph.microsoft.com/v1.0/sites/{site}/drive/items/{item_id}",
            headers={"Authorization": f"Bearer {tok}"},
            timeout=15,
        )
        meta.raise_for_status()
        filename = meta.json().get("name", "plan_carga.xlsx")
        # Descargar contenido
        r = _req.get(
            f"https://graph.microsoft.com/v1.0/sites/{site}/drive/items/{item_id}/content",
            headers={"Authorization": f"Bearer {tok}"},
            timeout=60,
            allow_redirects=True,
        )
        r.raise_for_status()
        return r.content, filename


class Api:
    """Métodos expuestos al frontend."""

    def __init__(self):
        self._window: webview.Window = None
        self._last_excel_path: str = ""
        self._last_fecha_b2: str = ""
        self._last_payload: dict = {}
        self._last_destino: str = ""
        self._last_precintos: list = []
        self._picker_open: bool = False
        self._rows: list = []   # filas enriquecidas del último Excel cargado
        self._excel_sessions: list = []  # historial de Excels cargados (máx 3)
        self._ip_lan: str = "127.0.0.1"
        self._port: int = 8765
        self._graph_server_url: str = ""   # Graph item ID del archivo SP activo
        self._graph_active_name: str = ""  # nombre del archivo SP activo (para mostrar)

    def set_server_info(self, ip_lan: str, port: int):
        self._ip_lan = ip_lan
        self._port = port

    def set_window(self, window):
        self._window = window

    # ──────────────────────────────────────────────────────────────
    # Excel: diálogos y carga
    # ──────────────────────────────────────────────────────────────
    def pick_excel(self) -> str:
        """Abre un diálogo nativo para escoger un Excel. Devuelve la ruta o ''.
        Usa tkinter en lugar de webview.OPEN_DIALOG para evitar el error
        'Este archivo está en uso' cuando el Excel está abierto en Excel."""
        self._picker_open = True
        try:
            import tkinter as _tk
            from tkinter import filedialog as _fd
            root = _tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            path = _fd.askopenfilename(
                parent=root,
                title="Seleccionar Plan de Carga",
                filetypes=[
                    ("Excel / CSV", "*.xlsx *.xls *.csv"),
                    ("Excel 2007+", "*.xlsx"),
                    ("Excel 97-2003", "*.xls"),
                    ("CSV", "*.csv"),
                    ("Todos los archivos", "*.*"),
                ],
            )
            root.destroy()
            if path:
                core.clear_touliv1_cache()
            return path or ""
        finally:
            self._picker_open = False

    def load_excel(self, path: str) -> dict:
        """
        Carga el Excel y devuelve:
        {
          "ok": True,
          "rows":  [ { destino, n, agencia, matriculas, tipo, expedicion, precinto, estado, ... }, ... ],
          "fecha_b2": "20260519",
          "filename": "Cargas_19052026.xlsx",
          "count": 12,
          "auto_enqueued": 3,
        }
        Devuelve { ok: False, error: "..." } si algo falla.
        """
        try:
            log("INFO", "load_excel", path=path)
            rows, fecha_b2 = core.load_excel(path)
            self._last_excel_path = path
            self._last_fecha_b2 = fecha_b2
            # Enriquecer las filas aculadas con CIF/Agencia (mejor esfuerzo)
            # y empujarlas a la cola Bleecker automáticamente.
            added = 0
            try:
                # Precarga tabla de categorías GEZCAT (llamada única sin filtros)
                try:
                    gezcat_map = core.odbc_load_gezcat()
                except Exception:
                    gezcat_map = {}

                for r in rows:
                    if r.get("ya_cargado"):
                        r["estado"] = "done"

                    # Trigger: solo procesar camiones aculados activos
                    if not (r.get("aculado") and not r.get("ya_cargado")):
                        r["fecha"] = fecha_b2
                        continue

                    # SLAM: sin procesar por ahora
                    destino_up = str(r.get("destino", "")).upper()
                    agencia_up = str(r.get("agencia", "")).upper()
                    if "SLAM" in destino_up or "SLAM" in agencia_up:
                        r["fecha"] = fecha_b2
                        continue

                    # CIF/agencia por matrícula
                    if not r.get("cif"):
                        matricula = (r.get("matriculas") or "").split("/")[0].strip()
                        if matricula:
                            try:
                                cif, agencia = core.odbc_lookup_chf(matricula)
                                r["cif"] = cif or ""
                                r["agencia"] = agencia or r.get("agencia", "")
                            except Exception:
                                pass

                    # GECLI2 + GEZCAT + GESUPEJ
                    try:
                        cod_centro = r.get("cod_centro", "")
                        tipo_viaje = r.get("tipo_viaje", "ambiente")
                        es_ambiente = tipo_viaje == "ambiente"
                        codact_gecli2 = "101" if es_ambiente else "003"

                        # queue_type solo depende de col_w y tipo_viaje (no de ODBC)
                        # Adelantados (marca A) siempre van a cola ambiente aunque sean refrigerado
                        _col_w = str(r.get("col_w", "")).strip().upper()
                        r["queue_type"] = "refrigerado" if (not es_ambiente and _col_w != "A") else "ambiente"

                        if cod_centro:
                            touliv1, catcli = core.odbc_lookup_touliv1(cod_centro, codact=codact_gecli2)
                            r["catcli"] = catcli
                            r["libcat"] = gezcat_map.get(catcli, "")
                            categoria_tipo = core.get_categoria_tipo(catcli)
                            r["categoria_tipo"] = categoria_tipo
                            min_pales = core.get_min_pales(catcli, r.get("tipo", ""))
                            r["min_pales"] = min_pales
                            r["ideal_pales"] = core.get_ideal_pales(catcli)

                            if touliv1 is None:
                                try:
                                    touliv1 = int(float(cod_centro))
                                except (ValueError, TypeError):
                                    touliv1 = None
                            if touliv1 is not None:
                                col_w = str(r.get("col_w", "")).strip().upper()
                                ruta_carga = int(touliv1) + 1 if col_w == "A" else int(touliv1) - 5
                                r["touliv1"] = touliv1
                                r["ruta_carga"] = ruta_carga

                            numsup = core.odbc_count_gesupej(cod_centro, ambiente=es_ambiente)
                            r["numsup_count"] = numsup

                            norm_key = core._to_codcli_key(cod_centro)
                            col_w = str(r.get("col_w", "")).strip().upper()
                            col_i = str(r.get("col_i", "")).strip().upper()
                            is_adelantado = col_w == "A"
                            if is_adelantado:
                                if norm_key in core.ADELANTADOS_MANANA or "DEP" in col_i:
                                    r["adelantado_tipo"] = "manana"
                                elif norm_key in core.ADELANTADOS_TARDE:
                                    r["adelantado_tipo"] = "tarde"
                                else:
                                    r["adelantado_tipo"] = "A"

                            es_gallego = norm_key in core.GALLEGOS
                            r["es_gallego"] = es_gallego
                            if es_gallego:
                                try:
                                    h_str = str(r.get("hora_acule", "")).strip().split(":")[0]
                                    r["gallego_urgente"] = int(h_str) < 12
                                except Exception:
                                    r["gallego_urgente"] = False
                            else:
                                r["gallego_urgente"] = False
                    except Exception:
                        r["numsup_count"] = 0

                    r["fecha"] = fecha_b2

                # Viajes combinados: sumar numsup_count por viaje_n
                from collections import defaultdict
                viaje_counts: dict = defaultdict(int)
                viaje_rows: dict = defaultdict(list)
                for r in rows:
                    if r.get("aculado") and not r.get("ya_cargado"):
                        n = r.get("n", "")
                        if n:
                            viaje_counts[n] += r.get("numsup_count", 0)
                            viaje_rows[n].append(r)
                for n, group in viaje_rows.items():
                    combined = viaje_counts[n]
                    min_vals = [g.get("min_pales") for g in group if g.get("min_pales") is not None]
                    threshold = max(min_vals) if min_vals else 25
                    ok = combined >= threshold
                    is_combined = len(group) > 1
                    trip_destinos = [g.get("destino", "") for g in group]
                    trip_centers = [
                        {
                            "destino": g.get("destino", ""),
                            "numsup_count": g.get("numsup_count", 0),
                            "ruta_carga": g.get("ruta_carga"),
                            "cod_centro": g.get("cod_centro", ""),
                        }
                        for g in group
                    ]
                    for g in group:
                        g["combined_count"] = combined
                        g["mercancia_ok"] = ok
                        g["is_combined"] = is_combined
                        g["trip_destinos"] = trip_destinos
                        g["trip_centers"] = trip_centers
                        g["merch_threshold"] = threshold

            except Exception as _enrich_err:
                log("WARNING", "load_excel enrich_failed", error=str(_enrich_err))
            try:
                added = queue_manager.get_manager().auto_enqueue_from_rows(rows)
                if added:
                    log("INFO", "auto_enqueue", added=added, path=path)
            except Exception as _eq_err:
                log("WARNING", "auto_enqueue_failed", error=str(_eq_err))
            self._rows = rows  # guardar para releer precintos al asignar
            # Historial de sesiones Excel (máx 3, deduplicar por ruta)
            _fname = os.path.basename(path)
            _session = {"path": path, "filename": _fname, "fecha": fecha_b2,
                        "count": len(rows), "rows": rows}
            self._excel_sessions = [s for s in self._excel_sessions if s["path"] != path]
            self._excel_sessions.insert(0, _session)
            self._excel_sessions = self._excel_sessions[:3]
            return {
                "ok": True,
                "rows": rows,
                "fecha_b2": fecha_b2,
                "filename": os.path.basename(path),
                "count": len(rows),
                "auto_enqueued": added,
            }
        except Exception as e:
            log_exc("load_excel", e)
            return {"ok": False, "error": str(e), "trace": traceback.format_exc()}

    def load_excel_base64(self, filename: str, b64_content: str) -> dict:
        """Carga un Excel desde contenido base64 (fallback para navegador sin pywebview)."""
        import base64 as _b64, tempfile, os as _os
        try:
            data = _b64.b64decode(b64_content)
            suffix = _os.path.splitext(filename)[1] or ".xlsx"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
                f.write(data)
                tmp_path = f.name
            try:
                return self.load_excel(tmp_path)
            finally:
                try: _os.unlink(tmp_path)
                except: pass
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_cargas_state(self) -> dict:
        """Devuelve las filas actuales en memoria sin releer el fichero ni hacer ODBC.
        Usado por tablet/navegador para sincronizar el estado del supervisor en tiempo real."""
        if not self._rows:
            return {"ok": False, "error": "no_file"}
        return {
            "ok": True,
            "rows": self._rows,
            "filename": os.path.basename(self._last_excel_path) if self._last_excel_path else "",
            "fecha_b2": self._last_fecha_b2 if hasattr(self, "_last_fecha_b2") else "",
            "count": len(self._rows),
        }

    def update_row(self, n: str, patch: dict) -> dict:
        """Actualiza campos de una fila en memoria. Usado para sincronizar estado
        (CIF, agencia, estado=done, precintos_data) entre dispositivos en tiempo real."""
        allowed = {"cif", "agencia", "estado", "precintos_data", "muelle", "playa", "matriculas"}
        patch = {k: v for k, v in (patch or {}).items() if k in allowed}
        if not patch:
            return {"ok": True}
        n = str(n)
        for row in self._rows:
            if str(row.get("n", "")) == n:
                row.update(patch)
                return {"ok": True}
        return {"ok": False, "error": "row_not_found"}

    def reload_excel(self) -> dict:
        # ── SharePoint / Graph API ─────────────────────────────────
        # Solo si hay un archivo SP activo (seleccionado por el usuario via graph_load_file)
        if self._graph_server_url:
            try:
                gr = _GraphReader()
                if gr.is_configured():
                    import tempfile as _tmp, os as _os2
                    content, filename = gr.download_bytes(self._graph_server_url)
                    with _tmp.NamedTemporaryFile(suffix=".xlsx", delete=False) as f:
                        f.write(content)
                        tmp_path = f.name
                    try:
                        saved_path = self._last_excel_path
                        result = self.load_excel(tmp_path)
                        self._last_excel_path = saved_path
                        if result.get("ok"):
                            result["filename"] = filename
                            result["source"] = "sharepoint"
                        return result
                    finally:
                        try:
                            _os2.unlink(tmp_path)
                        except Exception:
                            pass
            except Exception as _ge_err:
                log("WARNING", "graph_reload_failed", error=str(_ge_err))

        # ── Disco local ───────────────────────────────────────────
        if not self._last_excel_path:
            return {"ok": False, "error": "no_file"}
        if not os.path.exists(self._last_excel_path):
            # Archivo fue subido por base64 (tablet) y el temporal ya no existe;
            # devolvemos las filas en memoria para que el UI no pierda estado.
            if self._rows:
                return {"ok": True, "rows": self._rows,
                        "filename": os.path.basename(self._last_excel_path),
                        "fecha_b2": "", "count": len(self._rows), "auto_enqueued": 0}
            return {"ok": False, "error": "no_file"}
        if self._picker_open:
            return {"ok": False, "error": "picker_open"}
        # Comprobar si el archivo está bloqueado (típico de OneDrive sincronizando)
        try:
            with open(self._last_excel_path, "rb"):
                pass
        except PermissionError:
            log("WARNING", "reload_excel_locked", path=self._last_excel_path)
            if self._rows:
                return {"ok": True, "rows": self._rows,
                        "filename": os.path.basename(self._last_excel_path),
                        "fecha_b2": self._last_fecha_b2, "count": len(self._rows), "auto_enqueued": 0}
            return {"ok": False, "error": "file_locked"}
        core.clear_chf_caches()   # CIF/agencia siempre frescos; TOULIV1 permanece cacheado
        return self.load_excel(self._last_excel_path)

    # ──────────────────────────────────────────────────────────────
    # Microsoft Graph API — configuración
    # ──────────────────────────────────────────────────────────────
    def graph_get_config(self) -> dict:
        try:
            r = _GraphReader()
            return {
                "ok": True,
                "config": r.get_config_safe(),
                "configured": r.is_configured(),
                "active_file": self._graph_active_name if self._graph_server_url else "",
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def graph_save_config(self, cfg: dict) -> dict:
        try:
            r = _GraphReader()
            r.save_config(cfg)
            self._graph_server_url = ""   # resetear al cambiar config
            self._graph_active_name = ""
            log("INFO", "graph_config_saved", enabled=cfg.get("enabled"))
            return {"ok": True, "configured": r.is_configured()}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def graph_test(self) -> dict:
        """Prueba autenticación + lista los archivos de la carpeta."""
        try:
            r = _GraphReader()
            if not r.is_configured():
                return {"ok": False, "error": "No configurado o desactivado"}
            files = r.list_folder_files()
            return {"ok": True, "files": files, "count": len(files)}
        except Exception as e:
            log_exc("graph_test", e)
            return {"ok": False, "error": str(e)}

    def graph_list_files(self) -> dict:
        """Lista los .xlsx de la carpeta SharePoint configurada."""
        try:
            r = _GraphReader()
            if not r.is_configured():
                return {"ok": False, "error": "No configurado"}
            files = r.list_folder_files()
            return {"ok": True, "files": files, "active": self._graph_server_url}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def graph_load_file(self, server_url: str) -> dict:
        """Descarga y carga un Excel de SharePoint por su ServerRelativeUrl."""
        try:
            import tempfile as _tmp, os as _os2
            r = _GraphReader()
            if not r.is_configured():
                return {"ok": False, "error": "No configurado"}
            content, filename = r.download_bytes(server_url)
            with _tmp.NamedTemporaryFile(suffix=".xlsx", delete=False) as f:
                f.write(content)
                tmp_path = f.name
            try:
                saved_path = self._last_excel_path
                result = self.load_excel(tmp_path)
                self._last_excel_path = saved_path
                if result.get("ok"):
                    self._graph_server_url = server_url
                    self._graph_active_name = filename
                    result["filename"] = filename
                    result["source"] = "sharepoint"
                    log("INFO", "graph_load_file", file=filename)
                return result
            finally:
                try:
                    _os2.unlink(tmp_path)
                except Exception:
                    pass
        except Exception as e:
            log_exc("graph_load_file", e)
            return {"ok": False, "error": str(e)}

    def graph_download_b64(self, server_url: str) -> dict:
        """Devuelve el contenido de un archivo SP como base64 (para apps web externas)."""
        try:
            r = _GraphReader()
            if not r.is_configured():
                return {"ok": False, "error": "No configurado"}
            content, filename = r.download_bytes(server_url)
            return {
                "ok": True,
                "filename": filename,
                "content": base64.b64encode(content).decode("ascii"),
            }
        except Exception as e:
            log_exc("graph_download_b64", e)
            return {"ok": False, "error": str(e)}

    # ──────────────────────────────────────────────────────────────
    # ODBC: lookup CIF/Agencia
    # ──────────────────────────────────────────────────────────────
    def lookup_chf(self, matricula: str) -> dict:
        """Busca CIF + Agencia en FGE50STO.GEZCAM por matrícula (CODCAM)."""
        try:
            cif, agencia = core.odbc_lookup_chf(matricula)
            return {"ok": True, "cif": cif, "agencia": agencia, "found": bool(cif and agencia)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ──────────────────────────────────────────────────────────────
    # QR: generar imagen
    # ──────────────────────────────────────────────────────────────
    def generate_qr(self, payload: dict) -> dict:
        """
        Genera el PNG del QR a partir del payload {T,R,N,D,C,E,P}.
        Devuelve { ok, png_b64 (data URL), compact, pretty }.
        """
        try:
            compact = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
            pretty = json.dumps(payload, indent=2, ensure_ascii=False)
            png_bytes = core.make_qr_png(compact)
            self._last_payload = payload
            return {
                "ok": True,
                "png_b64": "data:image/png;base64," + base64.b64encode(png_bytes).decode(),
                "compact": compact,
                "pretty": pretty,
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def save_qr_png(self, payload: dict, default_name: str = "qr.png") -> dict:
        """Abre 'guardar como', escribe el PNG. Devuelve { ok, path }."""
        if not self._window:
            return {"ok": False, "error": "Sin ventana"}
        chosen = self._window.create_file_dialog(
            webview.SAVE_DIALOG,
            save_filename=default_name,
            file_types=("PNG (*.png)",),
        )
        if not chosen:
            return {"ok": False, "error": "cancelled"}
        try:
            compact = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
            png_bytes = core.make_qr_png(compact)
            with open(chosen, "wb") as f:
                f.write(png_bytes)
            return {"ok": True, "path": chosen}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def save_json(self, pretty: str, default_name: str = "qr.json") -> dict:
        if not self._window:
            return {"ok": False, "error": "Sin ventana"}
        chosen = self._window.create_file_dialog(
            webview.SAVE_DIALOG,
            save_filename=default_name,
            file_types=("JSON (*.json)",),
        )
        if not chosen:
            return {"ok": False, "error": "cancelled"}
        try:
            with open(chosen, "w", encoding="utf-8") as f:
                f.write(pretty)
            return {"ok": True, "path": chosen}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ──────────────────────────────────────────────────────────────
    # Word: generar e imprimir
    # ──────────────────────────────────────────────────────────────
    def generate_word_and_print(self, payload: dict, destino: str, precintos: list, do_print: bool = True, meta: dict | None = None) -> dict:
        """
        Genera el Word con cabecera + QR + tabla datos + grid precintos.
        `meta` puede contener {playa, muelle} — se imprime en Word pero NO va en el QR.
        """
        try:
            self._last_destino = destino or ""
            self._last_precintos = precintos or []
            path = core.export_word(payload, destino, precintos, meta=meta or {})
            if do_print:
                core.print_file(path)
            return {"ok": True, "path": str(path)}
        except Exception as e:
            return {"ok": False, "error": str(e), "trace": traceback.format_exc()}

    # ──────────────────────────────────────────────────────────────
    # Sistema
    # ──────────────────────────────────────────────────────────────
    def open_external(self, url: str) -> dict:
        import webbrowser
        webbrowser.open(url)
        return {"ok": True}

    def copy_to_clipboard(self, text: str) -> dict:
        """Copiar texto. Lo manejaremos del lado JS con navigator.clipboard;
        este método queda como fallback."""
        try:
            import pyperclip
            pyperclip.copy(text)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def app_info(self) -> dict:
        return {
            "version": "6.0",
            "name": "PULSO",
            "company": "Garvasa",
            "platform": os.name,
            "ip_lan": self._ip_lan,
            "port": self._port,
            "supervisor_url": f"http://{self._ip_lan}:{self._port}/index.html",
            "loader_url": f"http://{self._ip_lan}:{self._port}/index.html?mode=loader",
        }

    # ──────────────────────────────────────────────────────────────
    # COLA BLEECKER — Supervisor
    # ──────────────────────────────────────────────────────────────
    def queue_snapshot(self) -> dict:
        """Devuelve cola actual (queued / assigned / done últimos 20) + cargadores."""
        try:
            return {"ok": True, **queue_manager.get_manager().snapshot()}
        except Exception as e:
            return {"ok": False, "error": str(e), "trace": traceback.format_exc()}

    def queue_auto_enqueue(self, rows: list) -> dict:
        """Empuja a la cola las filas con aculado=True que aún no estén."""
        try:
            n = queue_manager.get_manager().auto_enqueue_from_rows(rows or [])
            return {"ok": True, "added": n}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_enqueue_manual(self, row: dict, urgente: bool = False) -> dict:
        """Añadir manualmente a la cola desde el botón del supervisor."""
        try:
            row = dict(row or {})
            # CIF/agencia por matrícula si el supervisor no los rellenó
            if not row.get("cif"):
                tractora = (row.get("tractora") or row.get("matriculas", "").split("/")[0]).strip()
                if tractora:
                    try:
                        cif, agencia = core.odbc_lookup_chf(tractora)
                        row["cif"] = cif or ""
                        if not row.get("agencia"):
                            row["agencia"] = agencia or ""
                    except Exception:
                        pass
            # Pales disponibles
            if row.get("numsup_count") is None and row.get("cod_centro"):
                try:
                    tipo_viaje = row.get("tipo_viaje", "ambiente")
                    es_ambiente = tipo_viaje == "ambiente"
                    numsup = core.odbc_count_gesupej(row["cod_centro"], ambiente=es_ambiente)
                    row["numsup_count"] = numsup
                    if row.get("combined_count") is None:
                        row["combined_count"] = numsup
                except Exception:
                    pass
            item = queue_manager.get_manager().manual_enqueue(row, urgente=bool(urgente))
            return {"ok": True, "item": item}
        except Exception as e:
            return {"ok": False, "error": str(e), "trace": traceback.format_exc()}

    def queue_remove(self, item_id: str) -> dict:
        try:
            return queue_manager.get_manager().remove(item_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_reassign(self, item_id: str, loader_id: str) -> dict:
        try:
            return queue_manager.get_manager().reassign(item_id, loader_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_set_urgent(self, item_id: str, urgente: bool) -> dict:
        try:
            return queue_manager.get_manager().set_urgent(item_id, bool(urgente))
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_reset_done(self) -> dict:
        try:
            return queue_manager.get_manager().reset_done()
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_reset_queued(self, queue_type: str = None) -> dict:
        """Borra los items pendientes (queued y pending_merch) para poder recargar el Excel.
        Si se indica queue_type ('ambiente'/'refrigerado'), solo afecta a esa cola."""
        try:
            return queue_manager.get_manager().reset_queued(queue_type)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_change_queue_type(self, item_id: str, new_type: str) -> dict:
        try:
            return queue_manager.get_manager().change_queue_type(item_id, new_type)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_force_queued(self, item_id: str) -> dict:
        """Fuerza un item pending_merch a la cola como urgente."""
        try:
            return queue_manager.get_manager().force_queued(item_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_set_comment(self, item_id: str, comment: str) -> dict:
        """Guarda el comentario del supervisor para un item de la cola."""
        try:
            return queue_manager.get_manager().set_comment(item_id, str(comment or ""))
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_set_supervisor_files(self, item_id: str, files: list) -> dict:
        """Guarda los archivos adjuntos del supervisor (max 5, base64) en el item."""
        try:
            files = (files or [])[:5]
            queue_manager.get_manager().update_item_fields(item_id, {"supervisor_files": files})
            return {"ok": True, "count": len(files)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_block(self, item_id: str) -> dict:
        """Bloquea un item de la cola para que no sea asignado automáticamente."""
        try:
            return queue_manager.get_manager().block_item(item_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_unblock(self, item_id: str) -> dict:
        """Desbloquea un item bloqueado."""
        try:
            return queue_manager.get_manager().unblock_item(item_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_assign_helper(self, item_id: str, helper_loader_id: str) -> dict:
        """Asigna un segundo cargador como ayudante de una carga en curso."""
        try:
            return queue_manager.get_manager().assign_helper(item_id, helper_loader_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_remove_helper(self, item_id: str) -> dict:
        """Elimina el ayudante de una carga en curso."""
        try:
            return queue_manager.get_manager().remove_helper(item_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_send_to_pending_merch(self, item_id: str) -> dict:
        """Mueve un item de la cola a Sin mercancía."""
        try:
            return queue_manager.get_manager().send_to_pending_merch(item_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_set_load_start(self, item_id: str, loader_id: str) -> dict:
        """Registra el inicio de la carga (timestamp pulsado por el cargador)."""
        try:
            return queue_manager.get_manager().set_load_start(item_id, str(loader_id or ""))
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_set_load_end(self, item_id: str, loader_id: str) -> dict:
        """Registra el fin de la carga (timestamp pulsado por el cargador)."""
        try:
            return queue_manager.get_manager().set_load_end(item_id, str(loader_id or ""))
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_update_ruta(self, item_id: str, ruta_carga: str) -> dict:
        """Recalcula numsup con una ruta manual y actualiza el item de la cola."""
        try:
            ruta = int(str(ruta_carga).strip())
            numsup = core.odbc_count_gesupe6(ruta)
            mercancia_ok = numsup > 25
            return queue_manager.get_manager().update_ruta_carga(item_id, ruta, numsup, mercancia_ok)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def lookup_client(self, cod_cli: str) -> dict:
        """Busca CIF + Nombre en GECLI2 por CODCLI."""
        try:
            cif, nombre = core.odbc_lookup_client(cod_cli or "")
            return {"ok": True, "cif": cif, "nombre": nombre, "found": bool(cif)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def lookup_gesupe6(self, touliv1_str: str) -> dict:
        """Cuenta pales supervisados (GESUPE6) para una ruta."""
        try:
            touliv1 = int(float(str(touliv1_str).strip()))
            ruta_carga = touliv1 - 5
            count = core.odbc_count_gesupe6(ruta_carga)
            return {"ok": True, "count": count, "ruta_carga": ruta_carga}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ──────────────────────────────────────────────────────────────
    # COLA BLEECKER — helpers internos
    # ──────────────────────────────────────────────────────────────
    def _enrich_qr_if_empty(self, item: dict) -> None:
        """Si el item no tiene CIF o agencia, intenta rellenarlos por ODBC y
        regenera el QR PNG. Se llama al asignar la carga al cargador."""
        if not item:
            return
        cif = (item.get("cif") or "").strip()
        agencia = (item.get("agencia") or "").strip()
        if cif and agencia:
            return  # ya completo
        tractora = (item.get("tractora") or item.get("matriculas", "").split("/")[0]).strip()
        if not tractora:
            return
        try:
            new_cif, new_agencia = core.odbc_lookup_chf(tractora)
        except Exception:
            return
        updated: dict = {}
        if new_cif and not cif:
            item["cif"] = new_cif
            updated["cif"] = new_cif
        if new_agencia and not agencia:
            item["agencia"] = new_agencia
            updated["agencia"] = new_agencia
        if not updated:
            return
        # Regenerar QR con los datos nuevos
        try:
            import json as _json, base64 as _b64
            compact = item.get("qr_payload_compact", "")
            if compact:
                payload = _json.loads(compact)
                payload["C"] = item["cif"]
                payload["E"] = item["agencia"]
                compact = _json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
                png_bytes = core.make_qr_png(compact)
                item["qr_png_b64"] = "data:image/png;base64," + _b64.b64encode(png_bytes).decode()
                item["qr_payload_compact"] = compact
                updated["qr_png_b64"] = item["qr_png_b64"]
                updated["qr_payload_compact"] = compact
        except Exception:
            pass
        try:
            queue_manager.get_manager().update_item_fields(item["id"], updated)
        except Exception:
            pass

    def _refresh_precintos(self, item: dict) -> bool:
        """Actualiza precintos del item desde las filas del Excel en memoria.
        El QR no incluye precintos (el campo "P" es para otra cosa), así que
        solo se actualiza la lista para mostrar en la app del cargador.
        Devuelve True si hubo cambios."""
        self._enrich_qr_if_empty(item)
        if not item or not self._rows:
            return False
        viaje_n = str(item.get("viaje_n", "")).strip()
        matching = [r for r in self._rows if str(r.get("n", "")).strip() == viaje_n]
        if not matching:
            return False
        fresh = []
        seen_prec = set()
        for r in matching:
            for p in (r.get("precintos_data") or []):
                key = (p.get("centro", ""), p.get("precinto", ""))
                if key not in seen_prec:
                    seen_prec.add(key)
                    fresh.append(p)
        current = item.get("precintos") or []
        if fresh == current:
            return False
        item["precintos"] = fresh
        try:
            queue_manager.get_manager().update_item_fields(item["id"], {"precintos": fresh})
        except Exception:
            pass
        return True

    # ──────────────────────────────────────────────────────────────
    # COLA BLEECKER — Cargador
    # ──────────────────────────────────────────────────────────────
    def loader_login(self, pin: str) -> dict:
        """Login por PIN. Devuelve datos del cargador o ok=False."""
        try:
            l = queue_manager.get_manager().login_by_pin(pin or "")
            if l:
                return {"ok": True, "loader": l}
            return {"ok": False, "error": "PIN no válido"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def loader_current(self, loader_id: str) -> dict:
        """Carga asignada al cargador (si la hay) sin asignar otra."""
        try:
            mgr = queue_manager.get_manager()
            item = mgr.get_current_for(loader_id)
            snap = mgr.snapshot()
            counts = snap["counts"]
            loader = next((l for l in snap["loaders"] if l["id"] == loader_id), None)
            is_refri = (loader or {}).get("queue_type") == "refrigerado"
            queued_count = counts["queued_refr"] if is_refri else counts["queued"]
            return {"ok": True, "item": item, "queued_count": queued_count}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def loader_refresh_precintos(self, loader_id: str) -> dict:
        """Vuelve a consultar el Excel para la carga en curso del cargador,
        por si se han añadido precintos mientras la carga estaba en marcha."""
        try:
            mgr = queue_manager.get_manager()
            item = mgr.get_current_for(loader_id)
            if not item:
                return {"ok": False, "error": "No hay carga asignada"}
            changed = self._refresh_precintos(item)
            return {"ok": True, "item": item, "changed": changed}
        except Exception as e:
            return {"ok": False, "error": str(e), "trace": traceback.format_exc()}

    def loader_request_next(self, loader_id: str) -> dict:
        """Pide la siguiente carga. Si ya tiene asignada, devuelve esa.
        En ambos casos refresca los precintos desde el Excel en memoria."""
        try:
            mgr = queue_manager.get_manager()
            current = mgr.get_current_for(loader_id)
            snap = mgr.snapshot()
            counts = snap["counts"]
            loader = next((l for l in snap["loaders"] if l["id"] == loader_id), None)
            is_refri = (loader or {}).get("queue_type") == "refrigerado"
            queued_count = counts["queued_refr"] if is_refri else counts["queued"]
            if current:
                self._refresh_precintos(current)
                return {"ok": True, "item": current, "queued_count": queued_count, "already_assigned": True}
            item = mgr.pick_next_for(loader_id)
            if item:
                self._refresh_precintos(item)
            snap2 = mgr.snapshot()
            counts2 = snap2["counts"]
            queued_count2 = counts2["queued_refr"] if is_refri else counts2["queued"]
            return {"ok": True, "item": item, "queued_count": queued_count2}
        except Exception as e:
            return {"ok": False, "error": str(e), "trace": traceback.format_exc()}

    def loader_finish(self, loader_id: str, item_id: str, checklist: dict = None, photos: list = None) -> dict:
        """Marca como completada y asigna automáticamente la siguiente."""
        try:
            mgr = queue_manager.get_manager()
            res = mgr.finish(item_id, loader_id, checklist=checklist, photos=photos)
            if not res.get("ok"):
                return res
            next_item = mgr.pick_next_for(loader_id)
            if next_item:
                self._refresh_precintos(next_item)
            snap = mgr.snapshot()
            counts = snap["counts"]
            loader = next((l for l in snap["loaders"] if l["id"] == loader_id), None)
            is_refri = (loader or {}).get("queue_type") == "refrigerado"
            queued_count = counts["queued_refr"] if is_refri else counts["queued"]
            return {
                "ok": True,
                "completed": res["completed"],
                "next": next_item,
                "queued_count": queued_count,
            }
        except Exception as e:
            return {"ok": False, "error": str(e), "trace": traceback.format_exc()}

    def loader_set_muelle(self, loader_id: str, muelle: str) -> dict:
        """Actualizar manualmente el muelle donde está el cargador."""
        try:
            mgr = queue_manager.get_manager()
            return mgr.upsert_loader({"id": loader_id, "muelle_actual": str(muelle)})
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_excel_sessions(self) -> dict:
        """Devuelve el historial de Excels cargados en esta sesión (sin las filas)."""
        return {"ok": True, "sessions": [
            {"path": s["path"], "filename": s["filename"], "fecha": s["fecha"],
             "count": s["count"], "active": s["path"] == self._last_excel_path}
            for s in self._excel_sessions
        ]}

    def switch_excel_session(self, idx: int) -> dict:
        """Cambia a otro Excel cargado en memoria y devuelve sus filas."""
        try:
            idx = int(idx)
            if not (0 <= idx < len(self._excel_sessions)):
                return {"ok": False, "error": "Sesión no encontrada"}
            s = self._excel_sessions[idx]
            self._rows = s["rows"]
            self._last_excel_path = s["path"]
            return {"ok": True, "rows": s["rows"], "filename": s["filename"],
                    "fecha": s["fecha"], "count": s["count"]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_audit_log(self, limit: int = 100) -> dict:
        """Devuelve el historial de actividad de asignaciones."""
        try:
            log = queue_manager.get_manager().get_audit_log(limit)
            return {"ok": True, "log": log}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def loader_upsert(self, loader_id: str, name: str, pin: str, queue_type: str = "ambiente") -> dict:
        """Crear o actualizar un cargador (supervisor)."""
        try:
            loader_id = str(loader_id).strip().upper()
            name = str(name).strip()
            pin = str(pin).strip()
            if not loader_id or not name or not pin:
                return {"ok": False, "error": "ID, nombre y PIN son obligatorios"}
            if queue_type not in ("ambiente", "refrigerado"):
                queue_type = "ambiente"
            mgr = queue_manager.get_manager()
            return mgr.upsert_loader({
                "id": loader_id, "name": name, "pin": pin,
                "queue_type": queue_type, "active": True,
            })
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def loader_remove(self, loader_id: str) -> dict:
        """Eliminar un cargador (supervisor)."""
        try:
            mgr = queue_manager.get_manager()
            return mgr.remove_loader(str(loader_id).strip().upper())
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def loader_import_json(self) -> dict:
        """Importar cargadores desde bleecker_loaders.json (migración manual)."""
        try:
            return queue_manager.get_manager().import_loaders_from_json()
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_odbc_diagnostics(self) -> dict:
        """Devuelve el log de operaciones ODBC recientes para diagnóstico."""
        try:
            return {"ok": True, "log": core.get_odbc_log()}
        except Exception as e:
            return {"ok": False, "error": str(e), "log": []}

    def get_debug_log(self, lines: int = 200) -> dict:
        """Devuelve las últimas N líneas del fichero de log de ejecución."""
        try:
            return {"ok": True, "lines": get_log_lines(int(lines)), "path": str(LOG_FILE)}
        except Exception as e:
            return {"ok": False, "error": str(e), "lines": []}
