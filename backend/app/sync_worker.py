"""Background worker.

Run with:  python -m app.sync_worker

1. Keeps Statens vegvesen data fresh for registered vehicles: picks vehicles
   whose vehicle_registry.next_sync_at is due, one at a time (row-locked with
   SKIP LOCKED, so several workers/the API can't collide).
2. Once a day, data retention:
   - cars off site with no activity for RETENTION_YEARS -> Recently deleted;
   - cars in Recently deleted for more than TRASH_DAYS -> removed for good,
     including their photo files;
   - test drive customer details (name, phone, licence photo) in the trash
     for more than TRASH_DAYS -> wiped for good;
   - rental customer details in the trash for more than TRASH_DAYS -> wiped;
   - rental cars re-checked at Statens vegvesen (EU-kontroll) every
     vegvesen_sync_days;
   - customer car deliveries received more than TRASH_DAYS ago -> deleted.
"""

import logging
import time

import psycopg
from psycopg.rows import dict_row

from . import photostore, vegvesen
from .common import (RETENTION_DUE_SQL, TEST_DRIVE_PURGE_DUE_SQL, purge_test_drive_customer, purge_vehicle,
                     soft_delete_vehicle)
from .config import settings
from .migrate import run_migrations
from .routers.rentals import RENTAL_PURGE_DUE_SQL, purge_rental_customer, refresh_due_rental_cars

log = logging.getLogger("carbonara.sync_worker")
IDLE_SECONDS = 60
HOUSEKEEPING_EVERY_S = 24 * 3600


def housekeeping() -> None:
    """Apply the retention policy. Each car is handled in its own transaction."""
    with psycopg.connect(settings.database_url, row_factory=dict_row) as conn:
        expired = []
        if settings.retention_years > 0:
            expired = conn.execute(RETENTION_DUE_SQL, (settings.retention_years,)).fetchall()
        trash = conn.execute(
            "SELECT id, vin FROM vehicles WHERE deleted_at < now() - make_interval(days => %s)",
            (settings.trash_days,),
        ).fetchall()

    for car in expired:
        with psycopg.connect(settings.database_url, row_factory=dict_row) as conn:
            soft_delete_vehicle(conn, car["id"], reason="retention")
        log.info("Retention: vehicle %s (VIN %s) inactive since %s -> Recently deleted",
                 car["id"], car["vin"], car["last_activity"])

    for car in trash:
        with psycopg.connect(settings.database_url, row_factory=dict_row) as conn:
            photos = purge_vehicle(conn, car["id"])
            conn.commit()
        for row in photos:
            photostore.remove(row)
        log.info("Removed vehicle %s (VIN %s) for good, %d photo(s)", car["id"], car["vin"], len(photos))

    # Test drive customer details (name, phone, licence photo) in the trash too long.
    with psycopg.connect(settings.database_url, row_factory=dict_row) as conn:
        drives = conn.execute(TEST_DRIVE_PURGE_DUE_SQL, (settings.trash_days,)).fetchall()
    for drive in drives:
        with psycopg.connect(settings.database_url, row_factory=dict_row) as conn:
            photo = purge_test_drive_customer(conn, drive["id"])
            conn.commit()
        if photo:
            photostore.remove(photo)
        log.info("Test drive %s (vehicle %s): customer details deleted for good", drive["id"], drive["vehicle_id"])

    # Rental customer details (name, phone, licence photo) in the trash too long.
    with psycopg.connect(settings.database_url, row_factory=dict_row) as conn:
        rentals = conn.execute(RENTAL_PURGE_DUE_SQL, (settings.trash_days,)).fetchall()
    for rental in rentals:
        with psycopg.connect(settings.database_url, row_factory=dict_row) as conn:
            photo = purge_rental_customer(conn, rental["id"])
            conn.commit()
        if photo:
            photostore.remove(photo)
        log.info("Rental %s: customer details deleted for good", rental["id"])

    # Rental cars: EU-kontroll etc. from Statens vegvesen every vegvesen_sync_days.
    try:
        refresh_due_rental_cars(lambda: psycopg.connect(settings.database_url, row_factory=dict_row))
    except Exception:
        log.exception("rental car registry refresh failed")

    # Customer car deliveries (name, phone, message) received more than TRASH_DAYS ago.
    with psycopg.connect(settings.database_url, row_factory=dict_row) as conn:
        gone = conn.execute("DELETE FROM car_deliveries WHERE received_at < now() - make_interval(days => %s) "
                            "RETURNING id", (settings.trash_days,)).fetchall()
    if gone:
        log.info("Deleted %d received customer deliveries for good", len(gone))


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
    log.info("Retention: %s; deleted cars kept %d days",
             f"{settings.retention_years} years" if settings.retention_years > 0 else "off", settings.trash_days)
    last_housekeeping = 0.0
    while True:
        if time.monotonic() - last_housekeeping >= HOUSEKEEPING_EVERY_S or not last_housekeeping:
            try:
                housekeeping()
            except Exception:
                log.exception("housekeeping failed")
            last_housekeeping = time.monotonic()
        if vegvesen.is_configured():
            try:
                run_once()
            except Exception:
                log.exception("sync run failed")
        time.sleep(IDLE_SECONDS)


if __name__ == "__main__":
    main()
