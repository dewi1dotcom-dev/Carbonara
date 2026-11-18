"""How full is the server's disk? Photos, licence photos, PDI sheets, documents and message files
grow every day (all under PHOTO_DIR, a folder on the server's own disk mounted into the containers).
A full disk stops new photos and can stop the database, so system admins are warned in time
(System page and Today)."""

import logging
import shutil

from .config import settings

log = logging.getLogger("carbonara.diskstatus")

GB = 1024 ** 3
# Amber below either of the first pair, red below either of the second (whichever comes first).
WARN_PERCENT, WARN_GB = 15, 10
BAD_PERCENT, BAD_GB = 5, 3


def status(conn) -> dict:
    out = {"level": "ok", "free_gb": None, "total_gb": None, "free_percent": None, "db_gb": None, "error": None}
    try:
        u = shutil.disk_usage(settings.photo_dir)
        free_pct = 100 * u.free / u.total if u.total else 0
        out.update(free_gb=round(u.free / GB, 1), total_gb=round(u.total / GB, 1), free_percent=round(free_pct, 1))
        if free_pct < BAD_PERCENT or u.free < BAD_GB * GB:
            out["level"] = "bad"
        elif free_pct < WARN_PERCENT or u.free < WARN_GB * GB:
            out["level"] = "warn"
    except OSError as exc:
        log.warning("disk usage not read: %s", exc)
        out.update(level="unknown", error=type(exc).__name__)
    try:  # the database may live on another disk (a Docker volume); its size is shown for reference
        size = conn.execute("SELECT pg_database_size(current_database()) AS b").fetchone()["b"]
        out["db_gb"] = round(size / GB, 2)
    except Exception as exc:
        log.warning("database size not read: %s", exc)
    return out
