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
    {"id": "L01", "pin": "1111", "name": "Cargador 1", "muelle_actual": "01", "active": True},
    {"id": "L02", "pin": "2222", "name": "Cargador 2", "muelle_actual": "08", "active": True},
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
        Para cada fila con aculado=True que no esté ya en cola (queued|assigned),
        genera el QR y la añade a la cola. Devuelve nº de nuevas entradas.
        """
        with self._lock:
            added = 0
            # claves ya presentes (viaje_n + destino) para no duplicar
            present_keys = {
                (it["viaje_n"], it["destino"])
                for it in self._items
                if it["status"] in ("queued", "assigned")
            }
            for r in rows:
                if not r.get("aculado"):
                    continue
                key = (r.get("n", ""), r.get("destino", ""))
                if not key[0] or key in present_keys:
                    continue
                self._items.append(self._build_item(r, urgente=False, source="auto"))
                added += 1
            if added:
                self._save()
            return added

    def manual_enqueue(self, row: dict, urgente: bool = False) -> dict:
        """Encolar manualmente desde la app supervisor (botón explícito)."""
        with self._lock:
            # Si ya está en cola, marcar urgente si procede y devolver
            for it in self._items:
                if it["viaje_n"] == row.get("n") and it["destino"] == row.get("destino") and it["status"] in ("queued", "assigned"):
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
            "urgente": bool(urgente),
            "status": "queued",
            "assigned_to": None,
            "assigned_at": None,
            "queued_at": datetime.now().isoformat(timespec="seconds"),
            "finished_at": None,
            "source": source,
            "completed_muelle": None,
            "completed_at": None,
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
            pool = [it for it in self._items if it["status"] == "queued"]
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
        """Devuelve la asignación activa del cargador, sin asignar una nueva."""
        with self._lock:
            for it in self._items:
                if it["status"] == "assigned" and it["assigned_to"] == loader_id:
                    return it
            return None

    def finish(self, item_id: str, loader_id: str) -> dict:
        """Marca como completada y actualiza muelle_actual del cargador."""
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["assigned_to"] == loader_id:
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

    def set_urgent(self, item_id: str, urgente: bool) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id:
                    it["urgente"] = bool(urgente)
                    self._save()
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado"}

    # ────────────────────────────────────────────────────────────
    # Lecturas
    # ────────────────────────────────────────────────────────────
    def snapshot(self) -> dict:
        with self._lock:
            queued = [it for it in self._items if it["status"] == "queued"]
            assigned = [it for it in self._items if it["status"] == "assigned"]
            done = [it for it in self._items if it["status"] == "done"]
            # Orden de presentación: igual que algoritmo (sin asignar a cargador concreto)
            queued.sort(key=lambda it: (
                0 if it["urgente"] else 1,
                self._parse_time(it["hora_salida"]),
            ))
            return {
                "queued": queued,
                "assigned": assigned,
                "done": done[-20:],  # solo últimos 20 hechos
                "loaders": self._loaders,
                "counts": {
                    "queued": len(queued),
                    "assigned": len(assigned),
                    "done": len(done),
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

    def reset_done(self) -> dict:
        """Borra los completados (por si el supervisor quiere limpiar el historial)."""
        with self._lock:
            self._items = [it for it in self._items if it["status"] != "done"]
            self._save()
            return {"ok": True}


# Singleton
_manager: Optional[QueueManager] = None

def get_manager() -> QueueManager:
    global _manager
    if _manager is None:
        _manager = QueueManager()
    return _manager
