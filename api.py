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


class Api:
    """Métodos expuestos al frontend."""

    def __init__(self):
        self._window: webview.Window = None
        self._last_excel_path: str = ""
        self._last_payload: dict = {}
        self._last_destino: str = ""
        self._last_precintos: list = []
        self._picker_open: bool = False

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
            rows, fecha_b2 = core.load_excel(path)
            self._last_excel_path = path
            # Enriquecer las filas aculadas con CIF/Agencia (mejor esfuerzo)
            # y empujarlas a la cola Bleecker automáticamente.
            added = 0
            try:
                for r in rows:
                    # Ya cargado: ocultar de vista y excluir de cola
                    if r.get("ya_cargado"):
                        r["estado"] = "done"
                    # Enriquecer aculados activos
                    if r.get("aculado") and not r.get("ya_cargado"):
                        if not r.get("cif"):
                            matricula = (r.get("matriculas") or "").split("/")[0].strip()
                            if matricula:
                                try:
                                    cif, agencia = core.odbc_lookup_chf(matricula)
                                    r["cif"] = cif or ""
                                    r["agencia"] = agencia or r.get("agencia", "")
                                except Exception:
                                    pass
                        # GESUPE6: buscar TOULIV1 en GECLI2 por CODCLI → contar pales
                        try:
                            cod_centro = r.get("cod_centro", "")
                            if cod_centro:
                                # Lookup correcto: CODCLI → TOULIV1 en GECLI2
                                touliv1 = core.odbc_lookup_touliv1(cod_centro)
                                if touliv1 is None:
                                    # Fallback: intentar cod_centro como valor numérico directo
                                    try:
                                        touliv1 = int(float(cod_centro))
                                    except (ValueError, TypeError):
                                        touliv1 = None
                                if touliv1 is not None:
                                    # Col W = "A" → ruta_carga = TOULIV1 + 1
                                    # En cualquier otro caso → TOULIV1 - 5
                                    col_w = str(r.get("col_w", "")).strip().upper()
                                    ruta_carga = int(touliv1) + 1 if col_w == "A" else int(touliv1) - 5
                                    numsup = core.odbc_count_gesupe6(ruta_carga)
                                    r["numsup_count"] = numsup
                                    r["touliv1"] = touliv1
                                    r["ruta_carga"] = ruta_carga
                        except Exception:
                            r["numsup_count"] = 0
                    # Fecha para QR
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
                    ok = combined > 25
                    is_combined = len(group) > 1
                    trip_destinos = [g.get("destino", "") for g in group]
                    for g in group:
                        g["combined_count"] = combined
                        g["mercancia_ok"] = ok
                        g["is_combined"] = is_combined
                        g["trip_destinos"] = trip_destinos

                added = queue_manager.get_manager().auto_enqueue_from_rows(rows)
            except Exception:
                pass
            return {
                "ok": True,
                "rows": rows,
                "fecha_b2": fecha_b2,
                "filename": os.path.basename(path),
                "count": len(rows),
                "auto_enqueued": added,
            }
        except Exception as e:
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

    def reload_excel(self) -> dict:
        if not self._last_excel_path:
            return {"ok": False, "error": "No hay archivo previo cargado."}
        if self._picker_open:
            return {"ok": False, "error": "picker_open"}
        core.clear_chf_caches()   # CIF/agencia siempre frescos; TOULIV1 permanece cacheado
        return self.load_excel(self._last_excel_path)

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
            "version": "3.0",
            "name": "PULSO",
            "company": "Garvasa",
            "platform": os.name,
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
            item = queue_manager.get_manager().manual_enqueue(row or {}, urgente=bool(urgente))
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

    def queue_reset_queued(self) -> dict:
        """Borra todos los items pendientes (queued y pending_merch) para poder recargar el Excel."""
        try:
            return queue_manager.get_manager().reset_queued()
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

    def queue_send_to_pending_merch(self, item_id: str) -> dict:
        """Mueve un item de la cola a Sin mercancía."""
        try:
            return queue_manager.get_manager().send_to_pending_merch(item_id)
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
            item = queue_manager.get_manager().get_current_for(loader_id)
            counts = queue_manager.get_manager().snapshot()["counts"]
            return {"ok": True, "item": item, "queued_count": counts["queued"]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def loader_request_next(self, loader_id: str) -> dict:
        """Pide la siguiente carga. Si ya tiene asignada, devuelve esa."""
        try:
            mgr = queue_manager.get_manager()
            current = mgr.get_current_for(loader_id)
            if current:
                counts = mgr.snapshot()["counts"]
                return {"ok": True, "item": current, "queued_count": counts["queued"], "already_assigned": True}
            item = mgr.pick_next_for(loader_id)
            counts = mgr.snapshot()["counts"]
            return {"ok": True, "item": item, "queued_count": counts["queued"]}
        except Exception as e:
            return {"ok": False, "error": str(e), "trace": traceback.format_exc()}

    def loader_finish(self, loader_id: str, item_id: str) -> dict:
        """Marca como completada y asigna automáticamente la siguiente."""
        try:
            mgr = queue_manager.get_manager()
            res = mgr.finish(item_id, loader_id)
            if not res.get("ok"):
                return res
            next_item = mgr.pick_next_for(loader_id)
            counts = mgr.snapshot()["counts"]
            return {
                "ok": True,
                "completed": res["completed"],
                "next": next_item,
                "queued_count": counts["queued"],
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

    def get_odbc_diagnostics(self) -> dict:
        """Devuelve el log de operaciones ODBC recientes para diagnóstico."""
        try:
            return {"ok": True, "log": core.get_odbc_log()}
        except Exception as e:
            return {"ok": False, "error": str(e), "log": []}
