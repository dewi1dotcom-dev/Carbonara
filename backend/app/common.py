import datetime as dt
import json
import re
import unicodedata
from typing import Optional

from fastapi import HTTPException
from psycopg import sql
from psycopg.types.json import Jsonb

from .config import settings


def not_found(what: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"{what} not found")


def conflict(message: str) -> HTTPException:
    return HTTPException(status_code=409, detail=message)


def bad_request(message: str) -> HTTPException:
    return HTTPException(status_code=422, detail=message)


def patch_fields(model, non_nullable=()) -> dict:
    """Fields explicitly sent in a PATCH body; null is ignored for NOT NULL columns."""
    fields = model.model_dump(exclude_unset=True)
    return {k: v for k, v in fields.items() if not (k in non_nullable and v is None)}


def update_row(conn, table: str, row_id: int, fields: dict, key: str = "id"):
    """UPDATE <table> SET <fields> WHERE <key> = row_id RETURNING *.

    Column names come from code / Pydantic models (never from raw user input)
    and are quoted as identifiers."""
    if not fields:
        return conn.execute(
            sql.SQL("SELECT * FROM {} WHERE {} = %s").format(sql.Identifier(table), sql.Identifier(key)),
            (row_id,),
        ).fetchone()
    query = sql.SQL("UPDATE {} SET {} WHERE {} = %s RETURNING *").format(
        sql.Identifier(table),
        sql.SQL(", ").join(sql.SQL("{} = %s").format(sql.Identifier(k)) for k in fields),
        sql.Identifier(key),
    )
    return conn.execute(query, [*fields.values(), row_id]).fetchone()


def cap_name(raw: Optional[str]) -> str:
    """'anne-lise  berg' -> 'Anne-Lise Berg': first letter, and the letter after a
    space or '-', in uppercase; the rest is kept as typed (so 'McDonald' stays)."""
    s = " ".join((raw or "").split())
    return re.sub(r"(^|[\s-])(\w)", lambda m: m.group(1) + m.group(2).upper(), s)


def tidy_name(raw: Optional[str]) -> str:
    """Registry names often come in capitals ('NORDMANN OLA'): those become
    'Nordmann Ola'; mixed-case names are only capitalized like cap_name."""
    s = " ".join((raw or "").split())
    return cap_name(s.lower() if s.isupper() else s)


def _name_tokens(name: str) -> list[str]:
    """'Ødegård-Hansen, Kåre' -> ['odegaard', 'hansen', 'kaare']: case, accents,
    punctuation and the æ/ø/å spellings (ae/o/aa) don't count."""
    s = (name or "").casefold().replace("æ", "ae").replace("ø", "o").replace("å", "aa")
    s = "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch))
    return [t for t in re.split(r"[^a-z0-9]+", s) if t]


def _one_edit(a: str, b: str) -> bool:
    """True when a and b differ by at most one letter (typo: missing, extra or wrong letter)."""
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i + (len(a) == len(b)):] == b[i + 1:]


def name_match(typed: Optional[str], registry: Optional[str], registry_kind: Optional[str] = None) -> Optional[str]:
    """Compare the name a customer typed with the owner's name from Statens vegvesen.

    - 'same':      the same words, in any order (SVV often puts the surname first).
    - 'similar':   every word of the shorter name is in the longer one (a middle name
                   left out), allowing one typo per word of 4+ letters, or an initial.
    - 'different': anything else (e.g. a spouse or friend delivering the car).
    - 'company':   the car is owned by a company; an employee delivering it is normal.
    None when there is nothing to compare. Both names are always kept."""
    if not registry or not typed:
        return None
    if registry_kind == "company":
        return "company"
    a, b = _name_tokens(typed), _name_tokens(registry)
    if not a or not b:
        return None
    if sorted(a) == sorted(b):
        return "same"
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    pool = list(long_)

    def take(word: str) -> bool:  # each word of the longer name can be used once
        for i, other in enumerate(pool):
            if (word == other or (min(len(word), len(other)) >= 4 and _one_edit(word, other))
                    or (len(word) == 1 and other.startswith(word)) or (len(other) == 1 and word.startswith(other))):
                del pool[i]
                return True
        return False

    return "similar" if all(take(w) for w in short) else "different"


def clean_phone(raw: Optional[str]) -> str:
    """Keep + and digits; Norwegian numbers have 8 digits, foreign ones more."""
    phone = re.sub(r"[\s\-().]", "", raw or "")
    if not re.fullmatch(r"\+?\d{8,15}", phone):
        raise bad_request("Phone number: 8–15 digits, optionally starting with +")
    return phone


def check_staff(conn, staff_id) -> None:
    if staff_id is not None and not conn.execute(
        "SELECT 1 FROM staff WHERE id = %s AND active", (staff_id,)
    ).fetchone():
        raise bad_request("Unknown or inactive staff member")


def insert_row(conn, table: str, fields: dict):
    query = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING *").format(
        sql.Identifier(table),
        sql.SQL(", ").join(sql.Identifier(k) for k in fields),
        sql.SQL(", ").join(sql.Placeholder() for _ in fields),
    )
    return conn.execute(query, list(fields.values())).fetchone()


def place_in_location(conn, vehicle_id: int, location_id: int, staff_id=None) -> dict:
    """Put a car in a storage spot: lock the spot (so two people can't fill the
    last place at once), check capacity, end the car's current assignment and
    create the new one. Returns the location row."""
    location = conn.execute(
        "SELECT * FROM storage_locations WHERE id = %s AND active FOR UPDATE", (location_id,)
    ).fetchone()
    if not location:
        raise bad_request("Unknown or inactive storage location")
    spot = conn.execute("SELECT code, active FROM storage_spots WHERE id = %s", (location_id,)).fetchone()
    name = spot["code"]  # full name, e.g. "BRUKTBILREKKE › RAD 1"
    if not spot["active"]:
        raise bad_request(f"{name} is inactive")
    if conn.execute("SELECT 1 FROM storage_locations WHERE parent_id = %s AND active LIMIT 1",
                    (location_id,)).fetchone():
        raise bad_request(f"{name} is split into sub-zones; choose one of them")
    if location["capacity"] is not None:
        used = conn.execute(
            """SELECT count(*) AS n FROM storage_assignments
                WHERE location_id = %s AND removed_at IS NULL AND vehicle_id <> %s""",
            (location_id, vehicle_id),
        ).fetchone()["n"]
        if used >= location["capacity"]:
            raise conflict(f"{name} is full ({used} of {location['capacity']} cars)")
    conn.execute(
        "UPDATE storage_assignments SET removed_at = now(), removed_by = %s "
        "WHERE vehicle_id = %s AND removed_at IS NULL",
        (staff_id, vehicle_id),
    )
    insert_row(conn, "storage_assignments",
               {"vehicle_id": vehicle_id, "location_id": location_id, "placed_by": staff_id})
    return {**location, "code": name}


def log_event(conn, vehicle_id: int, event_type: str, *, staff_id=None, inspection_id=None, data=None):
    conn.execute(
        """INSERT INTO vehicle_events (vehicle_id, event_type, staff_id, inspection_id, data)
           VALUES (%s, %s, %s, %s, %s)""",
        # default=str: dates/decimals in event data (e.g. a changed service date)
        (vehicle_id, event_type, staff_id, inspection_id, Jsonb(data or {}, dumps=lambda o: json.dumps(o, default=str))),
    )


# --------------------------------------------------------------------------- #
# Possible duplicates (warnings only — never blocks)
# --------------------------------------------------------------------------- #

def similar_vehicles(conn, vin: str, regnr: str | None = None, exclude_id: int | None = None) -> list:
    """Other cars that may be the same car: same registration number, or a
    VIN that differs in exactly one position (a typo or misread character).
    Each row gets `reason` ('same_reg' / 'similar_vin') and, for a similar
    VIN, `diff_pos` (1-based position of the differing character)."""
    regnr = "".join(ch for ch in (regnr or "").upper() if ch.isalnum()) or None
    rows = conn.execute(
        """SELECT v.id, v.vin, v.registration_number, v.make, v.model, v.model_year, v.status
             FROM vehicles v
            WHERE v.deleted_at IS NULL AND v.vin <> %(vin)s
              AND (%(ex)s::bigint IS NULL OR v.id <> %(ex)s)
              AND ((%(reg)s::text IS NOT NULL AND v.registration_number = %(reg)s)
                   OR (SELECT count(*) FROM generate_series(1, 17) g
                        WHERE substr(v.vin, g, 1) <> substr(%(vin)s, g, 1)) = 1)
            LIMIT 5""",
        {"vin": vin, "reg": regnr, "ex": exclude_id},
    ).fetchall()
    for r in rows:
        diffs = [i + 1 for i, (a, b) in enumerate(zip(r["vin"], vin)) if a != b]
        r["reason"] = "same_reg" if regnr and r["registration_number"] == regnr else "similar_vin"
        r["diff_pos"] = diffs[0] if len(diffs) == 1 else None
    return rows


# --------------------------------------------------------------------------- #
# Deleting cars: "Recently deleted" first, removed for good later
# --------------------------------------------------------------------------- #

def soft_delete_vehicle(conn, vehicle_id: int, *, reason: str, staff_id=None) -> None:
    """Move a car to Recently deleted: hidden everywhere, storage spot freed,
    restorable until it is purged."""
    spot = conn.execute(
        "SELECT location_id FROM storage_assignments WHERE vehicle_id = %s AND removed_at IS NULL", (vehicle_id,)
    ).fetchone()
    conn.execute(
        "UPDATE storage_assignments SET removed_at = now(), removed_by = %s WHERE vehicle_id = %s AND removed_at IS NULL",
        (staff_id, vehicle_id),
    )
    conn.execute(
        "UPDATE vehicles SET deleted_at = now(), deleted_by = %s, deleted_reason = %s WHERE id = %s",
        (staff_id, reason, vehicle_id),
    )
    log_event(conn, vehicle_id, "deleted", staff_id=staff_id,
              data={"reason": reason, "location_id": spot["location_id"] if spot else None})


def purge_vehicle(conn, vehicle_id: int) -> list:
    """Remove a car and everything about it for good. Returns the photo rows;
    call photostore.remove() on them once the transaction has committed."""
    photos = conn.execute(
        """SELECT p.file_key, p.original_ext FROM inspection_photos p
             JOIN inspections i ON i.id = p.inspection_id WHERE i.vehicle_id = %s
           UNION ALL
           SELECT license_file_key, license_ext FROM test_drives
            WHERE vehicle_id = %s AND license_file_key IS NOT NULL
           UNION ALL
           SELECT file_key, original_ext FROM vehicle_documents
            WHERE vehicle_id = %s AND file_key IS NOT NULL
           UNION ALL
           SELECT sheet_file_key, 'pdf' FROM pdi_orders  -- filled-in PDI sheets
            WHERE vehicle_id = %s AND sheet_file_key IS NOT NULL""",
        (vehicle_id, vehicle_id, vehicle_id, vehicle_id),
    ).fetchall()
    for stmt in (
        # Customer deliveries are kept (by reg. no) with their own retention; only unlinked.
        "UPDATE car_deliveries SET vehicle_id = NULL WHERE vehicle_id = %s",
        "DELETE FROM vehicle_documents WHERE vehicle_id = %s",
        "DELETE FROM test_drives WHERE vehicle_id = %s",
        "DELETE FROM pdi_orders WHERE vehicle_id = %s",
        "DELETE FROM storage_checks WHERE vehicle_id = %s",
        "DELETE FROM battery_charges WHERE vehicle_id = %s",
        "DELETE FROM damages WHERE vehicle_id = %s",
        "DELETE FROM vehicle_events WHERE vehicle_id = %s",
        "DELETE FROM inspection_photos WHERE inspection_id IN (SELECT id FROM inspections WHERE vehicle_id = %s)",
        "DELETE FROM inspections WHERE vehicle_id = %s",
        "DELETE FROM storage_assignments WHERE vehicle_id = %s",
        "DELETE FROM vehicle_registry_snapshots WHERE vehicle_id = %s",
        "DELETE FROM vehicle_registry WHERE vehicle_id = %s",
        "DELETE FROM vehicles WHERE id = %s",
    ):
        conn.execute(stmt, (vehicle_id,))
    return photos


def purge_test_drive_customer(conn, drive_id: int) -> dict | None:
    """Wipe a test drive's customer details for good (name, phone, licence
    photo). Returns the licence photo row ({file_key, original_ext}) or None;
    call photostore.remove() on it once the transaction has committed."""
    row = conn.execute(
        """UPDATE test_drives t
              SET customer_name = NULL, customer_phone = NULL,
                  license_file_key = NULL, license_ext = NULL, license_mime = NULL,
                  customer_purged_at = now()
             FROM (SELECT id, license_file_key, license_ext FROM test_drives WHERE id = %s FOR UPDATE) prev
            WHERE t.id = prev.id
        RETURNING prev.license_file_key AS file_key, prev.license_ext AS original_ext""",
        (drive_id,),
    ).fetchone()
    return row if row and row["file_key"] else None


# Returned test drives whose customer details have been in the trash for TRASH_DAYS.
# "Ready for registration and delivery": the PDI is done and the car hasn't
# left yet. Derived, not a vehicles.status value, because status says where the
# car is (storage counts and lists depend on it). Needs the vehicles alias "v".
READY_SQL = """(v.status <> 'off_site'
    AND EXISTS (SELECT 1 FROM pdi_orders rp WHERE rp.vehicle_id = v.id AND rp.status = 'done'))"""


# The car's right-side photo from its latest arrival inspection, shown in car lists.
# Cancelled inspections are skipped; completed ones win over one in progress.
# Needs the vehicles alias "v".
RIGHT_PHOTO_SQL = """(SELECT p.id FROM inspection_photos p JOIN inspections i ON i.id = p.inspection_id
                       WHERE i.vehicle_id = v.id AND p.kind = 'right' AND i.status <> 'cancelled'
                       ORDER BY (i.status = 'completed') DESC, i.started_at DESC, p.uploaded_at DESC
                       LIMIT 1) AS right_photo_id"""


TEST_DRIVE_PURGE_DUE_SQL = """
    SELECT id, vehicle_id FROM test_drives
     WHERE customer_purged_at IS NULL
       AND customer_trashed_at < now() - make_interval(days => %s)"""


# Cars that have left (off site) with no activity for RETENTION_YEARS. Activity
# = the car record changing or anything in its history; registry syncs don't count.
RETENTION_DUE_SQL = """
    SELECT v.id, v.vin, v.registration_number,
           greatest(v.updated_at, coalesce(max(e.occurred_at), v.updated_at)) AS last_activity
      FROM vehicles v
      LEFT JOIN vehicle_events e ON e.vehicle_id = v.id
     WHERE v.deleted_at IS NULL AND v.status = 'off_site'
     GROUP BY v.id
    HAVING greatest(v.updated_at, coalesce(max(e.occurred_at), v.updated_at)) < now() - make_interval(years => %s)"""


def add_years(d: dt.date, years: int) -> dt.date:
    try:
        return d.replace(year=d.year + years)
    except ValueError:  # 29 February -> 28 February
        return d.replace(year=d.year + years, day=28)


SERVICE_WINDOW_DAYS = 31  # "once a year, plus/minus a month"


def service_due(vehicle: dict, first_registered: dt.date | None) -> dict:
    """When the next yearly service is due, and what that is based on.

    - A recorded last service: one year after it.
    - New car without a service yet: one year after first registration.
    - Used car without a service record: the next anniversary of first
      registration (flagged, since the real history is unknown).
    Returns {due, basis, note}; due is None when there is nothing to go on."""
    last = vehicle.get("last_service_date")
    if last:
        return {"due": add_years(last, 1), "basis": "last_service", "note": None}
    if not first_registered:
        note = ("First service is due one year after registration." if vehicle.get("condition") == "new"
                else "No service history or registration date yet.")
        return {"due": None, "basis": None, "note": note}
    if vehicle.get("condition") == "new":
        return {"due": add_years(first_registered, 1), "basis": "registration",
                "note": "First service: one year after registration."}
    # Used / unknown: next registration anniversary that isn't already past the window.
    today = dt.date.today()
    years = 1
    while add_years(first_registered, years) < today - dt.timedelta(days=SERVICE_WINDOW_DAYS):
        years += 1
    return {"due": add_years(first_registered, years), "basis": "registration_anniversary",
            "note": "No service history recorded; based on the registration date."}


# --------------------------------------------------------------------------- #
# Summer / winter wheels and the studded tyre season (piggdekksesongen)
#   South and Central Norway: 1 November up to and including the first Sunday
#     after Easter Monday.
#   Nordland, Troms and Finnmark: 16 October up to and including 30 April.
# --------------------------------------------------------------------------- #

def easter_sunday(year: int) -> dt.date:
    """Gregorian Easter Sunday (anonymous Gregorian algorithm)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return dt.date(year, month, day + 1)


def _season_from(year: int, region: str) -> tuple[dt.date, dt.date]:
    """The studded tyre season that starts in the autumn of `year`: (first day, last day)."""
    if region == "north":
        return dt.date(year, 10, 16), dt.date(year + 1, 4, 30)
    # First Sunday after Easter Monday = Easter Sunday + 7 days.
    return dt.date(year, 11, 1), easter_sunday(year + 1) + dt.timedelta(days=7)


def tyre_season(today: dt.date | None = None, region: str | None = None) -> dict:
    """The current or next season (the first one that hasn't ended), the last one
    that has ended, and whether today is inside the season."""
    today = today or dt.date.today()
    region = region or settings.tyre_region
    start, end = _season_from(today.year - 1, region)
    if today > end:
        start, end = _season_from(today.year, region)
    prev_end = _season_from(start.year - 1, region)[1]
    # "A month before": the same day in the previous month (1 Oct / 16 Sep).
    warn_from = start.replace(month=start.month - 1)
    return {"start": start, "end": end, "previous_end": prev_end, "warn_from": warn_from,
            "in_season": start <= today <= end}


def tyre_warning(wheels: str | None, season: dict | None = None) -> dict | None:
    """Warning for the wheels on a car, or None when they suit the season.
      summer wheels in the season               -> bad  (since the season started)
      summer wheels the month before the season -> warn (the season starts soon)
      winter wheels after the season            -> info (just a notice; not strict)"""
    if wheels not in ("summer", "winter"):
        return None
    s = season or tyre_season()
    today = dt.date.today()
    if wheels == "summer":
        if s["in_season"]:
            return {"level": "bad", "kind": "summer_in_season", "date": s["start"]}
        if today >= s["warn_from"]:
            return {"level": "warn", "kind": "summer_soon", "date": s["start"]}
        return None
    if not s["in_season"] and today < s["warn_from"]:
        return {"level": "info", "kind": "winter_after_season", "date": s["previous_end"]}
    return None


def add_tyre_warnings(rows: list[dict], only_here: bool = True) -> list[dict]:
    """Sets row["tyre_warning"] on each row. only_here: cars taken off site
    (delivered) get no warning."""
    season = tyre_season()
    for row in rows:
        here = not only_here or row.get("status") != "off_site"
        row["tyre_warning"] = tyre_warning(row.get("wheels"), season) if here else None
    return rows
