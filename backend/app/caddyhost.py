"""The HTTPS server address (System page → HTTPS → "Server address", setting carbonara_host) handed to
the caddy container through the shared caddy_host volume (0.39.0).

Before, it was only the stack's CARBONARA_HOST, which fell back to "localhost" whenever a redeploy
didn't carry it. Now it's saved in the database, so it survives every redeploy and each location sets
its own. Caddy's start script (caddy/start.sh) reads the file every 10 s and reloads with the new
address; an empty file means the stack's CARBONARA_HOST (or localhost)."""

import logging
import os
from pathlib import Path

from .config import settings

log = logging.getLogger("carbonara.caddyhost")
HOST_FILE = Path(os.environ.get("CADDY_HOST_FILE", "/caddy-host/host"))


def write() -> None:
    """Write the current address for caddy; called at startup and when the setting changes. Never raises."""
    if not HOST_FILE.parent.is_dir():  # no shared volume (e.g. run without caddy)
        return
    value = str(settings.carbonara_host or "").strip().lower()
    try:
        if HOST_FILE.is_file() and HOST_FILE.read_text(encoding="utf-8").strip() == value:
            return
        tmp = HOST_FILE.with_name(HOST_FILE.name + ".tmp")
        tmp.write_text(value + "\n", encoding="utf-8")
        os.replace(tmp, HOST_FILE)  # caddy never reads a half-written file
        log.info("HTTPS server address handed to caddy: %s", value or "(the stack's CARBONARA_HOST)")
    except OSError as exc:
        log.warning("could not write the HTTPS server address for caddy: %s", exc)
