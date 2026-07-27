"""
PULSO · Logger de ejecución
============================
Logging rotativo a disco para diagnóstico de errores en producción.

Uso:
    from app_logger import log, log_exc, get_log_lines

    log("INFO", "mensaje")
    log_exc("contexto donde ocurrió", exc)
    lineas = get_log_lines(200)   # últimas 200 líneas
"""

import logging
import sys
import traceback
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path

import qr_teku_core as core

LOG_FILE = core.SAVE_DIR / "pulso_debug.log"
MAX_BYTES = 2 * 1024 * 1024   # 2 MB por fichero
BACKUP_COUNT = 3               # pulso_debug.log + .1 + .2 + .3

_logger: logging.Logger | None = None


def _get_logger() -> logging.Logger:
    global _logger
    if _logger is not None:
        return _logger

    try:
        core.SAVE_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    logger = logging.getLogger("pulso")
    logger.setLevel(logging.DEBUG)

    if not logger.handlers:
        fmt = logging.Formatter(
            "%(asctime)s [%(levelname)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        try:
            fh = RotatingFileHandler(
                LOG_FILE, maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT,
                encoding="utf-8",
            )
            fh.setFormatter(fmt)
            logger.addHandler(fh)
        except Exception:
            pass

        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(fmt)
        logger.addHandler(sh)

    _logger = logger
    return _logger


def log(level: str, msg: str, **ctx):
    """Registra un mensaje. level = 'DEBUG'|'INFO'|'WARNING'|'ERROR'."""
    extra = "  |  ".join(f"{k}={v}" for k, v in ctx.items())
    full = f"{msg}  [{extra}]" if extra else msg
    lvl = getattr(logging, level.upper(), logging.INFO)
    _get_logger().log(lvl, full)


def log_exc(context: str, exc: Exception):
    """Registra una excepción con traceback completo."""
    tb = traceback.format_exc()
    _get_logger().error(f"{context}: {exc}\n{tb}")


def get_log_lines(n: int = 200) -> list[str]:
    """Devuelve las últimas n líneas del log de texto plano."""
    try:
        if not LOG_FILE.exists():
            return []
        text = LOG_FILE.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        return lines[-n:]
    except Exception as e:
        return [f"[error leyendo log: {e}]"]
