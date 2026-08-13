"""
QR Teku · Gestor de cola Bleecker
==================================
Mantiene en memoria los items ACTIVOS (queued/assigned/pending_merch).
Los items completados (done) se guardan en SQLite y se consultan desde ahí.

Persistencia: SQLite (bleecker_queue.db).
  - Histórico completo, nunca se pierde al reiniciar.
  - Migración automática desde bleecker_queue.json si existe.

Algoritmo de asignación (orden de prioridad):
  1. Urgente (manual del supervisor)            ← desc
  2. Hora de salida más próxima                  ← asc
  3. Distancia al muelle del cargador            ← asc
"""

from __future__ import annotations

import base64
import json
import sqlite3
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional

import qr_teku_core as core


# ─── Ubicación de la persistencia ──────────────────────────────
# La DB vive junto al ejecutable/script (directorio activo de la app).
_APP_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
DB_FILE      = _APP_DIR / "bleecker_queue.db"
QUEUE_FILE   = core.SAVE_DIR / "bleecker_queue.json"    # legacy (migración)
LOADERS_FILE = core.SAVE_DIR / "bleecker_loaders.json"  # legacy (migración)


# ─── Cargadores demo por defecto ────────────────────────────────
DEFAULT_LOADERS = [
    {"id": "L01", "pin": "1111", "name": "Cargador 1", "muelle_actual": "01", "active": True, "queue_type": "ambiente"},
    {"id": "L02", "pin": "2222", "name": "Cargador 2", "muelle_actual": "08", "active": True, "queue_type": "ambiente"},
]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL,
    queue_type  TEXT,
    queued_at   TEXT,
    finished_at TEXT,
    data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);

CREATE TABLE IF NOT EXISTS loaders (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    ts    TEXT,
    data  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


class QueueManager:
    """Singleton de gestión de cola. Thread-safe."""

    def __init__(self):
        self._lock = threading.RLock()
        self._items: list[dict] = []    # solo activos: queued / assigned / pending_merch
        self._loaders: list[dict] = []
        self._counter: int = 0
        self._load_from_disk()

    # ────────────────────────────────────────────────────────────
    # SQLite helpers
    # ────────────────────────────────────────────────────────────
    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(DB_FILE), timeout=10, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_schema(self, conn: sqlite3.Connection):
        conn.executescript(_SCHEMA)
        conn.commit()

    def _upsert_item_db(self, conn: sqlite3.Connection, it: dict):
        conn.execute(
            "INSERT OR REPLACE INTO items (id, status, queue_type, queued_at, finished_at, data) VALUES (?,?,?,?,?,?)",
            (it["id"], it["status"], it.get("queue_type", "ambiente"),
             it.get("queued_at"), it.get("finished_at"),
             json.dumps(it, ensure_ascii=False))
        )

    def _persist_item(self, it: dict):
        with self._conn() as conn:
            self._upsert_item_db(conn, it)
            conn.commit()

    def _remove_item_db(self, item_id: str):
        with self._conn() as conn:
            conn.execute("DELETE FROM items WHERE id=?", (item_id,))
            conn.commit()

    def _save_loader(self, loader: dict):
        with self._conn() as conn:
            conn.execute("INSERT OR REPLACE INTO loaders VALUES (?,?)",
                         (loader["id"], json.dumps(loader, ensure_ascii=False)))
            conn.commit()

    def _persist_counter(self, conn: Optional[sqlite3.Connection] = None):
        def _do(c):
            c.execute("INSERT OR REPLACE INTO meta VALUES ('counter', ?)", (str(self._counter),))
        if conn:
            _do(conn)
        else:
            with self._conn() as c:
                _do(c)
                c.commit()

    # ────────────────────────────────────────────────────────────
    # Persistencia / carga inicial
    # ────────────────────────────────────────────────────────────
    def _load_from_disk(self):
        try:
            core.SAVE_DIR.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

        with self._conn() as conn:
            self._init_schema(conn)

            row = conn.execute("SELECT value FROM meta WHERE key='counter'").fetchone()
            self._counter = int(row[0]) if row else 0

            # Items activos en memoria
            rows = conn.execute(
                "SELECT data FROM items WHERE status IN ('queued','assigned','pending_merch')"
            ).fetchall()
            self._items = []
            for r in rows:
                try:
                    it = json.loads(r[0])
                    if "queue_type" not in it:
                        is_refr = it.get("tipo_carga", "AMBIENTE") == "REFRIGERADO"
                        is_ade  = bool(it.get("adelantado_tipo"))
                        it["queue_type"] = "refrigerado" if (is_refr and not is_ade) else "ambiente"
                    self._items.append(it)
                except Exception:
                    pass

            # Loaders
            rows = conn.execute("SELECT data FROM loaders").fetchall()
            self._loaders = []
            for r in rows:
                try:
                    self._loaders.append(json.loads(r[0]))
                except Exception:
                    pass
            if not self._loaders:
                self._loaders = list(DEFAULT_LOADERS)
                for l in self._loaders:
                    conn.execute("INSERT OR REPLACE INTO loaders VALUES (?,?)",
                                 (l["id"], json.dumps(l, ensure_ascii=False)))
                conn.commit()

        # Migrar desde JSON legacy si la DB estaba vacía
        if not self._items and self._counter == 0 and QUEUE_FILE.exists():
            self._migrate_from_json()

    def _migrate_from_json(self):
        """Importa bleecker_queue.json → SQLite (una sola vez al arrancar)."""
        try:
            data = json.loads(QUEUE_FILE.read_text(encoding="utf-8"))
            items = data.get("items", [])
            counter = data.get("counter", 0)
            with self._conn() as conn:
                for it in items:
                    if "queue_type" not in it:
                        is_refr = it.get("tipo_carga", "AMBIENTE") == "REFRIGERADO"
                        is_ade  = bool(it.get("adelantado_tipo"))
                        it["queue_type"] = "refrigerado" if (is_refr and not is_ade) else "ambiente"
                    self._upsert_item_db(conn, it)
                    if it["status"] not in ("done",):
                        self._items.append(it)
                self._counter = counter
                self._persist_counter(conn)
                conn.commit()
            # Loaders legacy
            if LOADERS_FILE.exists() and not self._loaders:
                loaders = json.loads(LOADERS_FILE.read_text(encoding="utf-8"))
                self._loaders = loaders
                with self._conn() as conn:
                    for l in self._loaders:
                        conn.execute("INSERT OR REPLACE INTO loaders VALUES (?,?)",
                                     (l["id"], json.dumps(l, ensure_ascii=False)))
                    conn.commit()
        except Exception:
            pass

    # ────────────────────────────────────────────────────────────
    # Auditoría
    # ────────────────────────────────────────────────────────────
    def _add_audit(self, action: str, **kw):
        entry = {"ts": datetime.now().isoformat(timespec="seconds"), "action": action, **kw}
        try:
            with self._conn() as conn:
                conn.execute("INSERT INTO audit (ts, data) VALUES (?,?)",
                             (entry["ts"], json.dumps(entry, ensure_ascii=False)))
                conn.commit()
        except Exception:
            pass

    def get_audit_log(self, limit: int = 100) -> list[dict]:
        try:
            with self._conn() as conn:
                rows = conn.execute(
                    "SELECT data FROM audit ORDER BY rowid DESC LIMIT ?", (limit,)
                ).fetchall()
            return [json.loads(r[0]) for r in rows]
        except Exception:
            return []

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
        try:
            parts = str(s).strip().split(":")
            return (int(parts[0]), int(parts[1]))
        except (ValueError, IndexError, TypeError):
            return (99, 99)

    def _new_ticket(self) -> str:
        self._counter += 1
        self._persist_counter()
        return f"A-{self._counter:04d}"

    # ────────────────────────────────────────────────────────────
    # Auto-enqueue desde load_excel
    # ────────────────────────────────────────────────────────────
    def auto_enqueue_from_rows(self, rows: list[dict]) -> int:
        with self._lock:
            added = 0
            active_statuses = ("queued", "assigned", "pending_merch")
            present_single = {
                (it["viaje_n"], it["destino"]): it
                for it in self._items
                if it["status"] in active_statuses and not it.get("is_combined")
            }
            present_combined = {
                it["viaje_n"]: it
                for it in self._items
                if it["status"] in active_statuses and it.get("is_combined")
            }
            # Done en DB (para no volver a encolar)
            try:
                with self._conn() as conn:
                    db_rows = conn.execute("SELECT data FROM items WHERE status='done'").fetchall()
                done_items = [json.loads(r[0]) for r in db_rows]
            except Exception:
                done_items = []
            done_single    = {(it["viaje_n"], it["destino"]) for it in done_items if not it.get("is_combined")}
            done_combined  = {it["viaje_n"] for it in done_items if it.get("is_combined")}
            combined_seen: set = set()

            for r in rows:
                if not r.get("aculado") or r.get("ya_cargado"):
                    continue
                n = r.get("n", "")
                if not n:
                    continue
                is_combined = bool(r.get("is_combined", False))

                if is_combined:
                    if n in done_combined:
                        continue
                    if n in present_combined:
                        existing = present_combined[n]
                        if existing["status"] == "pending_merch":
                            new_ok = bool(r.get("mercancia_ok", False))
                            existing["combined_count"]  = r.get("combined_count")
                            existing["numsup_count"]    = r.get("numsup_count")
                            existing["mercancia_ok"]    = new_ok
                            existing["trip_centers"]    = r.get("trip_centers", existing.get("trip_centers", []))
                            existing["merch_threshold"] = r.get("merch_threshold", existing.get("merch_threshold"))
                            if new_ok:
                                existing["status"] = "queued"
                                added += 1
                                self._persist_item(existing)
                        continue
                    if n in combined_seen:
                        continue
                    combined_seen.add(n)
                else:
                    key = (n, r.get("destino", ""))
                    if key in done_single:
                        continue
                    if key in present_single:
                        existing = present_single[key]
                        if existing["status"] == "pending_merch":
                            new_ok = bool(r.get("mercancia_ok", False))
                            existing["combined_count"]  = r.get("combined_count")
                            existing["numsup_count"]    = r.get("numsup_count")
                            existing["merch_threshold"] = r.get("merch_threshold", existing.get("merch_threshold"))
                            existing["mercancia_ok"]    = new_ok
                            if new_ok:
                                existing["status"] = "queued"
                                added += 1
                                self._persist_item(existing)
                        continue

                item = self._build_item(r, urgente=False, source="auto")
                self._items.append(item)
                self._persist_item(item)
                added += 1

            return added

    def manual_enqueue(self, row: dict, urgente: bool = False) -> dict:
        with self._lock:
            is_combined = bool(row.get("is_combined", False))
            for it in self._items:
                already = (
                    it["viaje_n"] == row.get("n")
                    and it["status"] in ("queued", "assigned", "pending_merch")
                    and (is_combined or it["destino"] == row.get("destino"))
                )
                if already:
                    changed = False
                    if urgente and not it["urgente"]:
                        it["urgente"] = True
                        changed = True
                    if it["status"] == "pending_merch":
                        it["status"] = "queued"
                        it["mercancia_ok"] = True
                        changed = True
                    if changed:
                        self._persist_item(it)
                    return it
            row = dict(row)
            row["mercancia_ok"] = True
            item = self._build_item(row, urgente=urgente, source="manual")
            self._items.append(item)
            self._persist_item(item)
            self._add_audit("encolada", item_id=item["id"], destino=item.get("destino"),
                            viaje_n=item.get("viaje_n"), urgente=urgente)
            return item

    def _build_item(self, row: dict, urgente: bool, source: str) -> dict:
        ticket_id = self._new_ticket()
        viaje_n = (row.get("n") or "").strip() or ticket_id
        matriculas = (row.get("matriculas") or "").split("/")
        tractora = matriculas[0].strip().upper() if matriculas else ""
        remolque = (matriculas[1].strip().upper() if len(matriculas) > 1 else tractora)
        payload = {
            "T": tractora, "R": remolque,
            "N": viaje_n.zfill(3),
            "D": row.get("fecha") or datetime.now().strftime("%Y%m%d"),
            "C": row.get("cif") or "", "E": row.get("agencia") or "", "P": [],
        }
        compact = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        try:
            png_bytes = core.make_qr_png(compact)
            qr_b64 = "data:image/png;base64," + base64.b64encode(png_bytes).decode()
        except Exception:
            qr_b64 = ""

        tipo_raw = (row.get("tipo") or "").upper()
        exp_raw  = (row.get("expedicion") or "").upper()
        is_refr  = (
            "REFR" in tipo_raw or "FRIO" in tipo_raw or "REFR" in exp_raw
            or row.get("queue_type") == "refrigerado"
        )
        hora_salida   = self._derive_salida(row)
        mercancia_ok  = bool(row.get("mercancia_ok", True))
        initial_status = "queued" if mercancia_ok else "pending_merch"

        return {
            "id": ticket_id, "viaje_n": viaje_n,
            "destino": row.get("destino", ""), "tractora": tractora, "remolque": remolque,
            "matriculas": row.get("matriculas", ""), "cam": row.get("orden", "") or "",
            "playa": row.get("playa", ""), "muelle": row.get("muelle", ""),
            "hora_salida": hora_salida, "hora_acule": row.get("hora_acule", ""),
            "expedicion": row.get("expedicion", ""), "cod_centro": row.get("cod_centro", ""),
            "tipo_carga": "REFRIGERADO" if is_refr else "AMBIENTE",
            "agencia": row.get("agencia", ""), "cif": row.get("cif", ""),
            "precintos": row.get("precintos_data", []),
            "qr_png_b64": qr_b64, "qr_payload_compact": compact,
            "urgente": bool(urgente) or row.get("adelantado_tipo") == "manana" or bool(row.get("gallego_urgente", False)),
            "status": initial_status, "assigned_to": None, "assigned_at": None,
            "queued_at": datetime.now().isoformat(timespec="seconds"), "finished_at": None,
            "source": source, "completed_muelle": None, "completed_at": None,
            "mercancia_ok": mercancia_ok,
            "combined_count": row.get("combined_count"), "numsup_count": row.get("numsup_count"),
            "is_combined": bool(row.get("is_combined", False)),
            "trip_destinos": row.get("trip_destinos", []), "trip_centers": row.get("trip_centers", []),
            "merch_threshold": row.get("merch_threshold"),
            "queue_type": row.get("queue_type", "ambiente"),
            "gallego_urgente": bool(row.get("gallego_urgente", False)),
            "touliv1": row.get("touliv1"), "ruta_carga": row.get("ruta_carga"),
            "comment": "", "blocked": False, "helper_id": None,
            "load_start_at": None, "load_end_at": None, "checklist": None, "photos": [],
            "reserved_for": None,
        }

    @staticmethod
    def _derive_salida(row: dict) -> str:
        v = str(row.get("hora_salida", "")).strip()
        if ":" in v:
            return v[:5]
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
        for it in self._items:
            if it["status"] == "pending_merch":
                mins = self._minutes_to_departure(it.get("hora_salida", ""))
                if mins <= 45:
                    it["status"] = "queued"
                    it["urgente"] = True
                    self._persist_item(it)

    # ────────────────────────────────────────────────────────────
    # Algoritmo: siguiente carga
    # ────────────────────────────────────────────────────────────
    def pick_next_for(self, loader_id: str) -> Optional[dict]:
        with self._lock:
            loader = self._get_loader(loader_id)
            if not loader:
                return None
            muelle_loader = loader.get("muelle_actual", "00")
            loader_qt     = loader.get("queue_type", "ambiente")

            # Primero: items reservados específicamente para este cargador
            reserved = [it for it in self._items
                        if it["status"] == "queued" and it.get("reserved_for") == loader_id]
            if reserved:
                chosen = reserved[0]
            else:
                # Pool normal: excluir items reservados para otros cargadores
                pool = [it for it in self._items
                        if it["status"] == "queued" and not it.get("blocked")
                        and it.get("queue_type", "ambiente") == loader_qt
                        and not it.get("reserved_for")]
                if not pool:
                    return None
                pool.sort(key=lambda it: (
                    0 if it["urgente"] else 1,
                    self._parse_time(it["hora_salida"]),
                    self._muelle_distance(muelle_loader, it["muelle"]),
                ))
                chosen = pool[0]

            chosen["status"]       = "assigned"
            chosen["assigned_to"]  = loader_id
            chosen["assigned_at"]  = datetime.now().isoformat(timespec="seconds")
            chosen["reserved_for"] = None
            self._persist_item(chosen)
            self._add_audit("asignada", item_id=chosen["id"], destino=chosen.get("destino"),
                            loader_id=loader_id, muelle=chosen.get("muelle"),
                            viaje_n=chosen.get("viaje_n"))
            return chosen

    def get_current_for(self, loader_id: str) -> Optional[dict]:
        with self._lock:
            for it in self._items:
                if it["status"] == "assigned" and (
                    it["assigned_to"] == loader_id or it.get("helper_id") == loader_id
                ):
                    return it
            return None

    def finish(self, item_id: str, loader_id: str, checklist: Optional[dict] = None, photos: Optional[list] = None) -> dict:
        """Marca como completada. Guarda checklist e fotos si se proporcionan."""
        with self._lock:
            for i, it in enumerate(self._items):
                if it["id"] == item_id and (
                    it["assigned_to"] == loader_id or it.get("helper_id") == loader_id
                ):
                    it["status"]           = "done"
                    it["finished_at"]      = datetime.now().isoformat(timespec="seconds")
                    it["completed_muelle"] = it["muelle"]
                    it["completed_at"]     = datetime.now().strftime("%H:%M:%S")
                    if checklist:
                        it["checklist"] = checklist
                    if photos:
                        it["photos"] = photos
                    loader = self._get_loader(loader_id)
                    if loader:
                        loader["muelle_actual"] = it["muelle"]
                        self._save_loader(loader)
                    self._persist_item(it)
                    del self._items[i]   # ya vive en DB, no ocupa memoria
                    self._add_audit("finalizada", item_id=item_id, destino=it.get("destino"),
                                    loader_id=loader_id, muelle=it.get("muelle"),
                                    viaje_n=it.get("viaje_n"))
                    return {"ok": True, "completed": it}
            return {"ok": False, "error": "Asignación no encontrada"}

    # ────────────────────────────────────────────────────────────
    # Mutaciones sobre items activos
    # ────────────────────────────────────────────────────────────
    def remove(self, item_id: str) -> dict:
        with self._lock:
            for i, it in enumerate(self._items):
                if it["id"] == item_id and it["status"] in ("queued", "assigned"):
                    del self._items[i]
                    self._remove_item_db(item_id)
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado"}

    def reassign(self, item_id: str, new_loader_id: str) -> dict:
        with self._lock:
            # Comprobar si el cargador destino ya tiene una carga en curso
            target_busy = any(
                it["status"] == "assigned" and it["assigned_to"] == new_loader_id
                for it in self._items
            )
            for it in self._items:
                if it["id"] == item_id and it["status"] in ("queued", "assigned"):
                    prev_loader = it.get("assigned_to")
                    if target_busy:
                        # Cargador ocupado: reservar para él sin asignar todavía
                        it["status"]       = "queued"
                        it["assigned_to"]  = None
                        it["reserved_for"] = new_loader_id
                        it["urgente"]      = True   # sube al principio de su cola
                    else:
                        it["status"]       = "assigned"
                        it["assigned_to"]  = new_loader_id
                        it["assigned_at"]  = datetime.now().isoformat(timespec="seconds")
                        it["reserved_for"] = None
                    self._persist_item(it)
                    self._add_audit("reasignada", item_id=item_id, destino=it.get("destino"),
                                    loader_id=new_loader_id, prev_loader_id=prev_loader,
                                    viaje_n=it.get("viaje_n"), reserved=target_busy)
                    return {"ok": True, "item": it, "reserved": target_busy}
            return {"ok": False, "error": "No encontrado"}

    def set_comment(self, item_id: str, comment: str) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id:
                    it["comment"] = str(comment or "").strip()
                    self._persist_item(it)
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado"}

    def set_urgent(self, item_id: str, urgente: bool) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id:
                    it["urgente"] = bool(urgente)
                    self._persist_item(it)
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado"}

    def block_item(self, item_id: str) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["status"] == "queued":
                    it["blocked"] = True
                    self._persist_item(it)
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado o no está en cola"}

    def unblock_item(self, item_id: str) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["status"] == "queued":
                    it["blocked"] = False
                    self._persist_item(it)
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado o no está en cola"}

    def assign_helper(self, item_id: str, helper_loader_id: str) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["status"] == "assigned":
                    it["helper_id"] = helper_loader_id
                    self._persist_item(it)
                    return {"ok": True, "item": it}
            return {"ok": False, "error": "No encontrado o no está asignada"}

    def remove_helper(self, item_id: str) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id:
                    it["helper_id"] = None
                    self._persist_item(it)
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado"}

    def force_queued(self, item_id: str) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["status"] == "pending_merch":
                    it["status"]  = "queued"
                    it["urgente"] = True
                    self._persist_item(it)
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado o no en pending_merch"}

    def send_to_pending_merch(self, item_id: str) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["status"] in ("queued",):
                    it["status"]       = "pending_merch"
                    it["mercancia_ok"] = False
                    self._persist_item(it)
                    return {"ok": True}
            return {"ok": False, "error": "No encontrado o no está en cola"}

    def update_ruta_carga(self, item_id: str, ruta_carga: int, numsup_count: int, mercancia_ok: bool) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id:
                    it["ruta_carga"]    = ruta_carga
                    it["numsup_count"]  = numsup_count
                    it["mercancia_ok"]  = mercancia_ok
                    if it["status"] == "pending_merch" and mercancia_ok:
                        it["status"] = "queued"
                    self._persist_item(it)
                    return {"ok": True, "item": it, "numsup_count": numsup_count}
            return {"ok": False, "error": "No encontrado"}

    def set_load_start(self, item_id: str, loader_id: str) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["status"] == "assigned" and (
                    it["assigned_to"] == loader_id or it.get("helper_id") == loader_id
                ):
                    it["load_start_at"] = datetime.now().isoformat(timespec="seconds")
                    self._persist_item(it)
                    return {"ok": True, "load_start_at": it["load_start_at"]}
            return {"ok": False, "error": "No encontrado o no asignada a este cargador"}

    def set_load_end(self, item_id: str, loader_id: str) -> dict:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id and it["status"] == "assigned" and (
                    it["assigned_to"] == loader_id or it.get("helper_id") == loader_id
                ):
                    it["load_end_at"] = datetime.now().isoformat(timespec="seconds")
                    self._persist_item(it)
                    return {"ok": True, "load_end_at": it["load_end_at"]}
            return {"ok": False, "error": "No encontrado o no asignada a este cargador"}

    def update_item_fields(self, item_id: str, fields: dict) -> None:
        with self._lock:
            for it in self._items:
                if it["id"] == item_id:
                    it.update(fields)
                    self._persist_item(it)
                    return

    # ────────────────────────────────────────────────────────────
    # Lecturas
    # ────────────────────────────────────────────────────────────
    def snapshot(self) -> dict:
        with self._lock:
            self._promote_urgent_pending()
            sort_q = lambda it: (0 if it["urgente"] else 1, self._parse_time(it["hora_salida"]))
            sort_p = lambda it: self._parse_time(it.get("hora_salida", ""))

            def _qt(it):
                return it.get("queue_type", "ambiente")

            queued_amb   = sorted([it for it in self._items if it["status"] == "queued"       and _qt(it) == "ambiente"],     key=sort_q)
            queued_ref   = sorted([it for it in self._items if it["status"] == "queued"       and _qt(it) == "refrigerado"],  key=sort_q)
            assigned_amb =        [it for it in self._items if it["status"] == "assigned"     and _qt(it) == "ambiente"]
            assigned_ref =        [it for it in self._items if it["status"] == "assigned"     and _qt(it) == "refrigerado"]
            pending_amb  = sorted([it for it in self._items if it["status"] == "pending_merch" and _qt(it) == "ambiente"],   key=sort_p)
            pending_ref  = sorted([it for it in self._items if it["status"] == "pending_merch" and _qt(it) == "refrigerado"], key=sort_p)

            # Done: últimos 50 de la DB (histórico completo)
            try:
                with self._conn() as conn:
                    db_rows = conn.execute(
                        "SELECT data FROM items WHERE status='done' ORDER BY finished_at DESC LIMIT 50"
                    ).fetchall()
                done = [json.loads(r[0]) for r in db_rows]
            except Exception:
                done = []

            blocked_count = sum(1 for it in self._items if it["status"] == "queued" and it.get("blocked"))
            return {
                "queued": queued_amb, "queued_refr": queued_ref,
                "assigned": assigned_amb, "assigned_refr": assigned_ref,
                "done": done,
                "pending_merch": pending_amb, "pending_merch_refr": pending_ref,
                "loaders": self._loaders,
                "counts": {
                    "queued":           len(queued_amb),
                    "queued_refr":      len(queued_ref),
                    "assigned":         len(assigned_amb),
                    "assigned_refr":    len(assigned_ref),
                    "done":             len(done),
                    "pending_merch":    len(pending_amb),
                    "pending_merch_refr": len(pending_ref),
                    "blocked":          blocked_count,
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
                    return dict(l)
            return None

    def upsert_loader(self, loader: dict) -> dict:
        with self._lock:
            existing = self._get_loader(loader.get("id", ""))
            if existing:
                existing.update(loader)
                self._save_loader(existing)
            else:
                new_loader = {**loader, "active": True}
                self._loaders.append(new_loader)
                self._save_loader(new_loader)
            return {"ok": True, "loaders": self._loaders}

    def remove_loader(self, loader_id: str) -> dict:
        with self._lock:
            before = len(self._loaders)
            self._loaders = [l for l in self._loaders if l["id"] != loader_id]
            if len(self._loaders) == before:
                return {"ok": False, "error": f"Cargador {loader_id} no encontrado"}
            with self._conn() as conn:
                conn.execute("DELETE FROM loaders WHERE id=?", (loader_id,))
                conn.commit()
            return {"ok": True, "loaders": self._loaders}

    def reset_done(self) -> dict:
        """Borra el historial de completadas."""
        with self._lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM items WHERE status='done'")
                conn.commit()
            return {"ok": True}

    def reset_queued(self, queue_type: Optional[str] = None) -> dict:
        """Borra los items pendientes (queued y pending_merch) para recargar el Excel."""
        with self._lock:
            def _match(it):
                if it["status"] not in ("queued", "pending_merch"):
                    return False
                if queue_type and it.get("queue_type", "ambiente") != queue_type:
                    return False
                return True
            to_remove = [it for it in self._items if _match(it)]
            before = len(to_remove)
            ids = [it["id"] for it in to_remove]
            self._items = [it for it in self._items if not _match(it)]
            if ids:
                with self._conn() as conn:
                    conn.executemany("DELETE FROM items WHERE id=?", [(i,) for i in ids])
                    conn.commit()
            return {"ok": True, "removed": before}


# ─── Singleton ─────────────────────────────────────────────────
_manager: Optional[QueueManager] = None

def get_manager() -> QueueManager:
    global _manager
    if _manager is None:
        _manager = QueueManager()
    return _manager
