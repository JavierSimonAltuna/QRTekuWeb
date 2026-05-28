"""
QR Teku · Gestor de cola Bleecker
==================================
Mantiene en memoria:
  - Lista de viajes encolados (con QR pre-generado, precintos, muelle, etc.)
  - Lista de cargadores activos (id + PIN + dónde está cada uno)
  - Asignaciones activas (qué cargador lleva qué viaje)

Persiste a JSON en SAVE_DIR/bleecker_queue.json para sobrevivir reinicios.

Algoritmo de asignación (orden de prioridad):
  1. Urgente (manual del supervisor)            ← desc
  2. Hora de salida más próxima                  ← asc
  3. Distancia al muelle del cargador            ← asc (|muelle_actual − muelle|)
"""

from __future__ import annotations

import base64
import json
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import qr_teku_core as core


# ─── Ubicación de la persistencia (mismo directorio que los Word) ──
QUEUE_FILE = core.SAVE_DIR / "bleecker_queue.json"
LOADERS_FILE = core.SAVE_DIR / "bleecker_loaders.json"


# ─── Cargadores demo por defecto (editables desde Tweaks) ──────────
DEFAULT_LOADERS = [
    {"id": "L01", "pin": "1111", "name": "Cargador 1", "muelle_actual": "01", "active": True, "queue_type": "ambiente"},
    {"id": "L02", "pin": "2222", "name": "Cargador 2", "muelle_actual": "08", "active": True, "queue_type": "ambiente"},
]


class QueueManager:
    """Singleton de gestión de cola. Thread-safe."""

    def __init__(self):
        self._lock = threading.RLock()
        self._items: list[dict] = []       # cola completa (queued + assigned + done)
        self._loaders: list[dict] = []
        self._counter: int = 0
        self._load_from_disk()

    # ────────────────────────────────────────────────────────────
    # Persistencia
    # ────────────────────────────────────────────────────────────
    def _load_from_disk(self):
        try:
            core.SAVE_DIR.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        if QUEUE_FILE.exists():
            try:
                data = json.loads(QUEUE_FILE.read_text(encoding="utf-8"))
                self._items = data.get("items", [])
                self._counter = data.get("counter", 0)
                # Migrar items sin queue_type (creados antes del split ambiente/refrigerado)
                for it in self._items:
                    if "queue_type" not in it:
                        is_refr = it.get("tipo_carga", "AMBIENTE") == "REFRIGERADO"
                        is_adelantado = bool(it.get("adelantado_tipo"))
                        it["queue_type"] = "refrigerado" if (is_refr and not is_adelantado) else "ambiente"
            except Exception:
                self._items = []
                self._counter = 0
        if LOADERS_FILE.exists():
            try:
                self._loaders = json.loads(LOADERS_FILE.read_text(encoding="utf-8"))
            except Exception:
                self._loaders = list(DEFAULT_LOADERS)
        else:
            self._loaders = list(DEFAULT_LOADERS)
            self._save_loaders()

    def _save(self):
        try:
            QUEUE_FILE.write_text(
                json.dumps({"items": self._items, "counter": self._counter}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass

    def _save_loaders(self):
        try:
            LOADERS_FILE.write_text(json.dumps(self._loaders, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    # ────────────────────────────────────────────────────────────
    # Helpers internos
    # ────────────────────────────────────────────────────────────
    @staticmethod
    def _muelle_distance(a: str, b: str) -> int:
        try:
            return abs(int(str(a).strip()) - int(str(b).strip()))
        except (ValueError, TypeError):
            return 999

    @staticmethod
    def _parse_time(s: str) -> tuple:
        """'08:30' → (8, 30). Fallback (99,99) para que vaya al final."""
        try:
            parts = str(s).strip().split(":")
            return (int(parts[0]), int(parts[1]))
        except (ValueError, IndexError, TypeError):
            return (99, 99)

    def _new_ticket(self) -> str:
        self._counter += 1
        return f"A-{self._counter:04d}"

    # ────────────────────────────────────────────────────────────
    # Auto-enqueue desde load_excel
    # ────────────────────────────────────────────────────────────
    def auto_enqueue_from_rows(self, rows: list[dict]) -> int:
        """
        Para cada fila aculada activa (no ya_cargado) que no esté en cola,
        genera el QR y la añade. Si ya está en pending_merch, actualiza counts
        y promueve a queued si mercancia_ok. Devuelve nº de nuevas/promovidas.
        Los viajes combinados (is_combined=True, mismo viaje_n) se fusionan en
        UN SOLO item de cola; precintos_data ya contiene todos los centros.
        """
        with self._lock:
            added = 0
            changed = False
            active_statuses = ("queued", "assigned", "pending_merch")
            # Presencia de viajes simples: clave (viaje_n, destino)
            present_single: dict = {
                (it["viaje_n"], it["destino"]): it
                for it in self._items
                if it["status"] in active_statuses and not it.get("is_combined")
            }
            # Presencia de viajes combinados: clave viaje_n (uno por viaje)
            present_combined: dict = {
                it["viaje_n"]: it
                for it in self._items
                if it["status"] in active_statuses and it.get("is_combined")
            }
            # Combinados añadidos en esta llamada (para deduplicar dentro del mismo lote)
            combined_seen: set = set()

            for r in rows:
                if not r.get("aculado") or r.get("ya_cargado"):
                    continue
                n = r.get("n", "")
                if not n:
                    continue
                is_combined = bool(r.get("is_combined", False))

                if is_combined:
                    # Viaje combinado: un solo item por viaje_n
                    if n in present_combined:
                        existing = present_combined[n]
                        if existing["status"] == "pending_merch":
                            new_ok = bool(r.get("mercancia_ok", False))
                            existing["combined_count"] = r.get("combined_count")
                            existing["numsup_count"] = r.get("numsup_count")
                            existing["mercancia_ok"] = new_ok
                            existing["trip_centers"] = r.get("trip_centers", existing.get("trip_centers", []))
                            existing["merch_threshold"] = r.get("merch_threshold", existing.get("merch_threshold"))
                            if new_ok:
                                existing["status"] = "queued"
                                changed = True
                                added += 1
                        continue
                    if n in combined_seen:
                        continue  # ya añadido en este lote
                    combined_seen.add(n)
                else:
                    # Viaje simple: clave (viaje_n, destino)
                    key = (n, r.get("destino", ""))
                    if key in present_single:
                        existing = present_single[key]
                        if existing["status"] == "pending_merch":
                            new_ok = bool(r.get("mercancia_ok", False))
                            existing["combined_count"] = r.get("combined_count")
                            existing["numsup_count"] = r.get("numsup_count")
                            existing["mercancia_ok"] = new_ok
                            if new_ok:
                                existing["status"] = "queued"
                                changed = True
                                added += 1
                        continue

                self._items.append(self._build_item(r, urgente=False, source="auto"))
                added += 1
            if added or changed:
                self._save()
            return added

    def manual_enqueue(self, row: dict, urgente: bool = False) -> dict:
        """Encolar manualmente desde la app supervisor (botón explícito)."""
        with self._lock:
            # Si ya está en cola, marcar urgente si procede y devolver
            is_combined = bool(row.get("is_combined", False))
            for it in self._items:
                already = (
                    it["viaje_n"] == row.get("n") and it["status"] in ("queued", "assigned")
                    and (is_combined or it["destino"] == row.get("destino"))
                )
                if already:
                    if urgente and not it["urgente"]:
                        it["urgente"] = True
                        self._save()
                    return it
            item = self._build_item(row, urgente=urgente, source="manual")
            self._items.append(item)
            self._save()
            return item

    def _build_item(self, row: dict, urgente: bool, source: str) -> dict:
        """Construye un item de cola con QR PNG ya renderizado."""
        # Payload del QR — solo T,R,N,D,C,E,P
        matriculas = (row.get("matriculas") or "").split("/")
        tractora = matriculas[0].strip().upper() if matriculas else ""
        remolque = (matriculas[1].strip().upper() if len(matriculas) > 1 else tractora)
        payload = {
            "T": tractora,
            "R": remolque,
            "N": (row.get("n") or "").strip().zfill(3),
            "D": row.get("fecha") or datetime.now().strftime("%Y%m%d"),
            "C": row.get("cif") or "",
            "E": row.get("agencia") or "",
            "P": [],
        }
        compact = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        try:
            png_bytes = core.make_qr_png(compact)
            qr_b64 = "data:image/png;base64," + base64.b64encode(png_bytes).decode()
        except Exception:
            qr_b64 = ""

        # Tipo de carga: refrigerado si "REFR" en tipo o expedición
        tipo_raw = (row.get("tipo") or "").upper()
        exp_raw = (row.get("expedicion") or "").upper()
        is_refr = "REFR" in tipo_raw or "FRIO" in tipo_raw or "REFR" in exp_raw

        # Hora de salida: usamos expedicion si parece una hora, si no, derivamos de hora_acule+30min
        hora_salida = self._derive_salida(row)

        mercancia_ok = bool(row.get("mercancia_ok", True))
        initial_status = "queued" if mercancia_ok else "pending_merch"

        return {
            "id": self._new_ticket(),
            "viaje_n": row.get("n", ""),
            "destino": row.get("destino", ""),
            "tractora": tractora,
            "remolque": remolque,
            "matriculas": row.get("matriculas", ""),
            "cam": row.get("orden", "") or "",
            "playa": row.get("playa", ""),
            "muelle": row.get("muelle", ""),
            "hora_salida": hora_salida,
            "hora_acule": row.get("hora_acule", ""),
            "expedicion": row.get("expedicion", ""),
            "cod_centro": row.get("cod_centro", ""),
            "tipo_carga": "REFRIGERADO" if is_refr else "AMBIENTE",
            "agencia": row.get("agencia", ""),
            "cif": row.get("cif", ""),
            "precintos": row.get("precintos_data", []),
            "qr_png_b64": qr_b64,
            "qr_payload_compact": compact,
            "urgente": bool(urgente) or row.get("adelantado_tipo") == "manana" or bool(row.get("gallego_urgente", False)),
            "status": initial_status,
            "assigned_to": None,
            "assigned_at": None,
            "queued_at": datetime.now().isoformat(timespec="seconds"),
            "finished_at": None,
            "source": source,
            "completed_muelle": None,
            "completed_at": None,
            "mercancia_ok": mercancia_ok,
            "combined_count": row.get("combined_count"),
            "numsup_count": row.get("numsup_count"),
            "is_combined": bool(row.get("is_combined", False)),
            "trip_destinos": row.get("trip_destinos", []),
            "trip_centers": row.get("trip_centers", []),
            "merch_threshold": row.get("merch_threshold"),
            "queue_type": row.get("queue_type", "ambiente"),
            "gallego_urgente": bool(row.get("gallego_urgente", False)),
            "touliv1": row.get("touliv1"),
            "ruta_carga": row.get("ruta_carga"),
            "comment": "",
            "blocked": False,
            "helper_id": None,
        }

    @staticmethod
    def _derive_salida(row: dict) -> str:
        """Hora de salida prevista. Preferimos la columna AB (SALIDA PREV) ya
        normalizada por core como `hora_salida`. Si no hay, derivamos de
        hora_acule + 30 min como aproximación."""
        v = str(row.get("hora_salida", "")).strip()
        if ":" in v:
            return v[:5]
        # fallback: hora_acule + 30 min
        ha = str(row.get("hora_acule", "")).strip()
        if ":" in ha:
            try:
                h, m = ha.split(":")[:2]
                t_min = int(h) * 60 + int(m) + 30
                return f"{(t_min // 60) % 24:02d}:{t_min % 60:02d}"
            except Exception:
                pass
        return ""

    @staticmethod
    def _minutes_to_departure(hora_salida: str) -> float:
        """Minutos hasta la hora de salida desde ahora. Inf si no hay hora válida.
        Si la hora ya pasó (más de 5 min), se asume que es del día siguiente."""
        try:
            parts = str(hora_salida).strip().split(":")
            h, m = int(parts[0]), int(parts[1])
            now = datetime.now()
            dep = now.replace(hour=h, minute=m, second=0, microsecond=0)
            diff = (dep - now).total_seconds() / 60
            if diff < -5:
                dep = dep.replace(day=dep.day + 1)
                diff = (dep - now).total_seconds() / 60
            return diff
        except Exception:
            return float("inf")

    def _promote_urgent_pending(self):
        """Promueve a urgente los items pending_merch con salida en ≤45 min."""
        for it in self._items:
            if it["status"] == "pending_merch":
                mins = self._minutes_to_departure(it.get("hora_salida", ""))
                if mins <= 45:
                    it["status"] = "queued"
                    it["urgente"] = True

    # ────────────────────────────────────────────────────────────
    # Algoritmo: siguiente carga para un cargador
    # ────────────────────────────────────────────────────────────
    def pick_next_for(self, loader_id: str) -> Optional[dict]:
        """Asigna la siguiente carga al cargador según el algoritmo. None si cola vacía."""
        with self._lock:
            loader = self._get_loader(loader_id)
            if not loader:
                return None
            muelle_loader = loader.get("muelle_actual", "00")
            loader_qt = loader.get("queue_type", "ambiente")
            pool = [it for it in self._items if it["status"] == "queued" and not it.get("blocked")
                    and it.get("queue_type", "ambiente") == loader_qt]
            if not pool:
                return None
            # Ordenamos: (no-urgente=1, urgente=0)  → urgentes primero
            #            luego hora_salida asc, luego distancia muelle asc
            pool.sort(key=lambda it: (
                0 if it["urgente"] else 1,
                self._parse_time(it["hora_salida"]),
                self._muelle_distance(muelle_loader, it["muelle"]),
            ))
            chosen = pool[0]
            chosen["status"] = "assigned"
            chosen["assigned_to"] = loader_id
            chosen["assigned_at"] = datetime.now().isoformat(timespec="seconds")
            self._save()
            return chosen

    def get_current_for(self, loader_id: str) -> Optional[dict]:
        """Devuelve la asignación activa del cargador (primario o ayudante), sin asignar una nueva."""
        with self._lock:
            for it in self._items:
                if it["status"] == "assigned" and (
                    it["assigned_to"] == loader_id or it.get("helper_id") == loader_id
                ):
                    return it
            return None

    def finish(self, item_id: str, loader_id: str) -> dict:
        """Marca como completada. Puede marcarla tanto el cargador primario como el ayudante."""
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and (
                    it["assigned_to"] == loader_id or it.get("helper_id") == loader_id
                ):
                    it["status"] = "done"
                    it["finished_at"] = datetime.now().isoformat(timespec="seconds")
                    it["completed_muelle"] = it["muelle"]
                    it["completed_at"] = datetime.now().strftime("%H:%M:%S")
                    # Actualizar posición del cargador
                    loader = self._get_loader(loader_id)
                    if loader:
                        loader["muelle_actual"] = it["muelle"]
                        self._save_loaders()
                    self._save()
                    return {"ok": True, "completed": it}
            return {"ok": False, "error": "Asignación no encontrada"}

    def remove(self, item_id: str) -> dict:
        with self._lock:
            for i, it in enumerate(self._items):
                if it["id"] == item_id and it["status"] in ("queued", "assigned"):
                    del self._items[i]
                    self._save()
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado"}

    def reassign(self, item_id: str, new_loader_id: str) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["status"] in ("queued", "assigned"):
                    it["assigned_to"] = new_loader_id
                    it["status"] = "assigned"
                    it["assigned_at"] = datetime.now().isoformat(timespec="seconds")
                    self._save()
                    return {"ok": True, "item": it}
            return {"ok": False, "error": "No encontrado"}

    def set_comment(self, item_id: str, comment: str) -> dict:
        """Guarda el comentario del supervisor en un item (visible al cargador)."""
        with self._lock:
            for it in self._items:
                if it["id"] == item_id:
                    it["comment"] = str(comment or "").strip()
                    self._save()
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado"}

    def set_urgent(self, item_id: str, urgente: bool) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id:
                    it["urgente"] = bool(urgente)
                    self._save()
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado"}

    def block_item(self, item_id: str) -> dict:
        """Bloquea un item de la cola para que no sea asignado automáticamente."""
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["status"] == "queued":
                    it["blocked"] = True
                    self._save()
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado o no está en cola"}

    def unblock_item(self, item_id: str) -> dict:
        """Desbloquea un item para que vuelva a ser elegible para asignación."""
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["status"] == "queued":
                    it["blocked"] = False
                    self._save()
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado o no está en cola"}

    def assign_helper(self, item_id: str, helper_loader_id: str) -> dict:
        """Asigna un segundo cargador como ayudante de una carga ya asignada."""
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["status"] == "assigned":
                    it["helper_id"] = helper_loader_id
                    self._save()
                    return {"ok": True, "item": it}
            return {"ok": False, "error": "No encontrado o no está asignada"}

    def remove_helper(self, item_id: str) -> dict:
        """Elimina el ayudante de una carga."""
        with self._lock:
            for it in self._items:
                if it["id"] == item_id:
                    it["helper_id"] = None
                    self._save()
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado"}

    def force_queued(self, item_id: str) -> dict:
        """Fuerza un item pending_merch a la cola como urgente."""
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["status"] == "pending_merch":
                    it["status"] = "queued"
                    it["urgente"] = True
                    self._save()
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado o no en pending_merch"}

    def send_to_pending_merch(self, item_id: str) -> dict:
        """Mueve un item de la cola (queued) a Sin mercancía (pending_merch)."""
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["status"] in ("queued",):
                    it["status"] = "pending_merch"
                    it["mercancia_ok"] = False
                    self._save()
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado o no está en cola"}

    def update_ruta_carga(self, item_id: str, ruta_carga: int, numsup_count: int, mercancia_ok: bool) -> dict:
        """Actualiza ruta_carga y numsup_count de un item (corrección manual de ruta)."""
        with self._lock:
            for it in self._items:
                if it["id"] == item_id:
                    it["ruta_carga"] = ruta_carga
                    it["numsup_count"] = numsup_count
                    it["mercancia_ok"] = mercancia_ok
                    if it["status"] == "pending_merch" and mercancia_ok:
                        it["status"] = "queued"
                    self._save()
                    return {"ok": True, "item": it, "numsup_count": numsup_count}
            return {"ok": False, "error": "No encontrado"}

    # ────────────────────────────────────────────────────────────
    # Lecturas
    # ────────────────────────────────────────────────────────────
    def snapshot(self) -> dict:
        with self._lock:
            self._promote_urgent_pending()
            sort_q = lambda it: (0 if it["urgente"] else 1, self._parse_time(it["hora_salida"]))
            sort_p = lambda it: self._parse_time(it.get("hora_salida", ""))
            done = [it for it in self._items if it["status"] == "done"]

            def _qt(it):
                return it.get("queue_type", "ambiente")

            queued_amb = sorted([it for it in self._items if it["status"] == "queued" and _qt(it) == "ambiente"], key=sort_q)
            queued_ref = sorted([it for it in self._items if it["status"] == "queued" and _qt(it) == "refrigerado"], key=sort_q)
            assigned_amb = [it for it in self._items if it["status"] == "assigned" and _qt(it) == "ambiente"]
            assigned_ref = [it for it in self._items if it["status"] == "assigned" and _qt(it) == "refrigerado"]
            pending_amb = sorted([it for it in self._items if it["status"] == "pending_merch" and _qt(it) == "ambiente"], key=sort_p)
            pending_ref = sorted([it for it in self._items if it["status"] == "pending_merch" and _qt(it) == "refrigerado"], key=sort_p)

            blocked_count = sum(1 for it in self._items if it["status"] == "queued" and it.get("blocked"))
            return {
                "queued": queued_amb,
                "queued_refr": queued_ref,
                "assigned": assigned_amb,
                "assigned_refr": assigned_ref,
                "done": done[-20:],
                "pending_merch": pending_amb,
                "pending_merch_refr": pending_ref,
                "loaders": self._loaders,
                "counts": {
                    "queued": len(queued_amb),
                    "queued_refr": len(queued_ref),
                    "assigned": len(assigned_amb),
                    "assigned_refr": len(assigned_ref),
                    "done": len(done),
                    "pending_merch": len(pending_amb),
                    "pending_merch_refr": len(pending_ref),
                    "blocked": blocked_count,
                },
            }

    # ────────────────────────────────────────────────────────────
    # Cargadores
    # ────────────────────────────────────────────────────────────
    def _get_loader(self, loader_id: str) -> Optional[dict]:
        for l in self._loaders:
            if l["id"] == loader_id:
                return l
        return None

    def login_by_pin(self, pin: str) -> Optional[dict]:
        with self._lock:
            for l in self._loaders:
                if l.get("active") and str(l.get("pin", "")) == str(pin).strip():
                    return dict(l)  # copia
            return None

    def upsert_loader(self, loader: dict) -> dict:
        with self._lock:
            existing = self._get_loader(loader.get("id", ""))
            if existing:
                existing.update(loader)
            else:
                self._loaders.append({**loader, "active": True})
            self._save_loaders()
            return {"ok": True, "loaders": self._loaders}

    def remove_loader(self, loader_id: str) -> dict:
        with self._lock:
            before = len(self._loaders)
            self._loaders = [l for l in self._loaders if l["id"] != loader_id]
            if len(self._loaders) == before:
                return {"ok": False, "error": f"Cargador {loader_id} no encontrado"}
            self._save_loaders()
            return {"ok": True, "loaders": self._loaders}

    def reset_done(self) -> dict:
        """Borra los completados (por si el supervisor quiere limpiar el historial)."""
        with self._lock:
            self._items = [it for it in self._items if it["status"] != "done"]
            self._save()
            return {"ok": True}

    def reset_queued(self) -> dict:
        """Borra los items pendientes (queued y pending_merch) para recargar el Excel."""
        with self._lock:
            before = len([it for it in self._items if it["status"] in ("queued", "pending_merch")])
            self._items = [it for it in self._items if it["status"] not in ("queued", "pending_merch")]
            self._save()
            return {"ok": True, "removed": before}


# Singleton
_manager: Optional[QueueManager] = None

def get_manager() -> QueueManager:
    global _manager
    if _manager is None:
        _manager = QueueManager()
    return _manager
