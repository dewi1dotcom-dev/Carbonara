"""Background worker: keeps Statens vegvesen data fresh for registered vehicles.

Run with:  python -m app.sync_worker
Picks vehicles whose vehicle_registry.next_sync_at is due, one at a time
(row-locked with SKIP LOCKED, so several workers/the API can't collide).
"""

import logging
import time

import psycopg
from psycopg.rows import dict_row

from . import vegvesen
from .config import settings
from .migrate import run_migrations

log = logging.getLogger("carbonara.sync_worker")
IDLE_SECONDS = 60


def run_once(max_vehicles: int = 50) -> int:
    done = 0
    while done < max_vehicles:
        with psycopg.connect(settings.database_url, row_factory=dict_row) as conn:
            row = conn.execute(vegvesen.due_vehicle_ids_sql()).fetchone()
            if not row:
                break
            result = vegvesen.sync_vehicle(conn, row["vehicle_id"])
            log.info("vehicle %s: %s", row["vehicle_id"], result["status"])
        done += 1
        time.sleep(settings.vegvesen_call_interval_s)
    return done


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    run_migrations()
    if not vegvesen.is_configured():
        log.warning("VEGVESEN_API_KEY is not set – registry sync is disabled until it is configured")
    while True:
        if vegvesen.is_configured():
            try:
                run_once()
            except Exception:
                log.exception("sync run failed")
        time.sleep(IDLE_SECONDS)


if __name__ == "__main__":
    main()
