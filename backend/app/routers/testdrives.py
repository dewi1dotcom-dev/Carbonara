"""Test drives: log which car is out, with which customer, and what was taken
out of / put into the car. Customer details go to the trash when the car is
returned and are wiped for good after TRASH_DAYS (see sync_worker)."""

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from psycopg.errors import UniqueViolation
from pydantic import BaseModel, Field

from .. import licenselib, photostore
from ..auth import require_admin
from ..common import (bad_request, check_staff, clean_phone, conflict, insert_row, log_event, not_found,
                      purge_test_drive_customer)
from ..config import settings
from ..db import get_conn
from ..schemas import TestDriveReturnIn

log = logging.getLogger("carbonara.testdrives")
router = APIRouter(tags=["test drives"])

MAX_ITEMS = 20
MAX_ITEM_LEN = 80

DRIVE_SELECT = """
    SELECT t.id, t.vehicle_id, t.status, t.started_at, t.odometer_out, t.removed_items, t.added_items,
           t.items_note, t.returned_at, t.odometer_in, t.items_checked, t.return_note,
           t.customer_name, t.customer_phone, (t.license_file_key IS NOT NULL) AS has_license,
           t.customer_trashed_at, t.customer_purged_at, t.customer_informed,
           t.customer_trashed_at + make_interval(days => %(trash_days)s) AS purge_at,
           so.name AS started_by_name, sr.name AS returned_by_name,
           v.vin, v.make, v.model, v.model_year, v.color, v.registration_number, v.status AS vehicle_status,
           t.trade_plate_id, tp.name AS trade_plate_name, t.plate_moved_at,
           mv.id AS plate_moved_to_vehicle_id, mv.registration_number AS plate_moved_to_reg,
           concat_ws(' ', mv.make, mv.model) AS plate_moved_to_car
      FROM test_drives t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN staff so ON so.id = t.started_by
      LEFT JOIN staff sr ON sr.id = t.returned_by
      LEFT JOIN trade_plates tp ON tp.id = t.trade_plate_id
      LEFT JOIN test_drives mt ON mt.id = t.plate_moved_to
      LEFT JOIN vehicles mv ON mv.id = mt.vehicle_id"""


class PlateIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class PlatePatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    active: Optional[bool] = None


def _items(raw: Optional[str], what: str) -> list[str]:
    """A JSON list of short strings from a form field."""
    if not raw:
        return []
    try:
        items = json.loads(raw)
    except ValueError:
        raise bad_request(f"{what}: not a valid list")
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        raise bad_request(f"{what}: give at most {MAX_ITEMS} items")
    out = []
    for item in items:
        item = str(item).strip()
        if len(item) > MAX_ITEM_LEN:
            raise bad_request(f"{what}: '{item[:20]}…' is too long")
        if item and item not in out:
            out.append(item)
    return out


def _drive(conn, drive_id: int) -> dict:
    row = conn.execute(DRIVE_SELECT + " WHERE t.id = %(id)s",
                       {"id": drive_id, "trash_days": settings.trash_days}).fetchone()
    if not row:
        raise not_found("Test drive")
    return row


def _read_image(file: UploadFile) -> dict:
    data = file.file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(413, "Image too large")
    try:
        return photostore.store(data)
    except photostore.PhotoError as exc:
        raise bad_request(str(exc))


@router.get("/test-drives")
def list_test_drives(conn=Depends(get_conn)):
    """Cars out now, and returned drives whose customer details are still in the trash."""
    params = {"trash_days": settings.trash_days}
    active = conn.execute(DRIVE_SELECT + " WHERE t.status = 'out' AND v.deleted_at IS NULL ORDER BY t.started_at",
                          params).fetchall()
    trash = conn.execute(DRIVE_SELECT + """ WHERE t.status = 'returned' AND t.customer_purged_at IS NULL
                                            ORDER BY t.returned_at DESC""", params).fetchall()
    return {"active": active, "trash": trash, "trash_days": settings.trash_days,
            "privacy": {"company": settings.privacy_company, "phone": settings.privacy_contact or None,
                        "email": settings.privacy_email or None, "address": settings.privacy_address or None}}


@router.post("/test-drives/read-license")
def read_license(file: UploadFile = File(...)):
    """Read the holder's name from a licence photo, to fill in the form.
    The photo is only processed in memory; it is stored when the drive starts."""
    data = file.file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(413, "Image too large")
    try:
        result = licenselib.read_license_name(data)
    except Exception as exc:  # unreadable image or OCR failure: just no suggestion
        log.warning("licence reading failed: %s", exc)
        return {"name": None, "confidence": None, "error": "Could not read the photo"}
    result.pop("text", None)  # what the OCR saw is logged, not sent back (personal data)
    return result


@router.get("/test-drives/{drive_id}")
def get_test_drive(drive_id: int, conn=Depends(get_conn)):
    return _drive(conn, drive_id)


# --------------------------------------------------------------------------- #
# trade plates (prøvekjennemerker)
# --------------------------------------------------------------------------- #

PLATE_SELECT = """
    SELECT p.id, p.name, p.active,
           t.id AS drive_id, t.vehicle_id, t.started_at,
           v.registration_number, v.make, v.model, v.model_year
      FROM trade_plates p
      LEFT JOIN test_drives t ON t.trade_plate_id = p.id AND t.status = 'out' AND t.plate_moved_at IS NULL
      LEFT JOIN vehicles v ON v.id = t.vehicle_id"""


def _plate_name(raw: str) -> str:
    name = " ".join((raw or "").split())
    if not name:
        raise bad_request("Give the trade plates a name")
    return name


@router.get("/trade-plates")
def list_plates(include_inactive: bool = False, conn=Depends(get_conn)):
    """Trade plates, and which car each set is on now (drive_id is null when free)."""
    return conn.execute(PLATE_SELECT + " WHERE (p.active OR %s) ORDER BY p.active DESC, lower(p.name)",
                        (include_inactive,)).fetchall()


@router.post("/trade-plates", status_code=201)
def add_plate(body: PlateIn, conn=Depends(get_conn), _admin=Depends(require_admin)):
    name = _plate_name(body.name)
    try:
        row = conn.execute("INSERT INTO trade_plates (name) VALUES (%s) RETURNING id", (name,)).fetchone()
    except UniqueViolation:
        raise conflict(f"{name} already exists")
    return conn.execute(PLATE_SELECT + " WHERE p.id = %s", (row["id"],)).fetchone()


@router.patch("/trade-plates/{plate_id}")
def patch_plate(plate_id: int, body: PlatePatch, conn=Depends(get_conn), _admin=Depends(require_admin)):
    """Rename (e.g. when a plate is replaced), remove or restore a set of plates."""
    plate = conn.execute("SELECT * FROM trade_plates WHERE id = %s FOR UPDATE", (plate_id,)).fetchone()
    if not plate:
        raise not_found("Trade plates")
    name = _plate_name(body.name) if body.name is not None else plate["name"]
    active = plate["active"] if body.active is None else body.active
    if not active and conn.execute(
            "SELECT 1 FROM test_drives WHERE trade_plate_id = %s AND status = 'out' AND plate_moved_at IS NULL",
            (plate_id,)).fetchone():
        raise conflict("These trade plates are on a car out on a test drive; register the return first")
    try:
        conn.execute("UPDATE trade_plates SET name = %s, active = %s, updated_at = now() WHERE id = %s",
                     (name, active, plate_id))
    except UniqueViolation:
        raise conflict(f"{name} already exists")
    return conn.execute(PLATE_SELECT + " WHERE p.id = %s", (plate_id,)).fetchone()


@router.post("/test-drives", status_code=201)
def start_test_drive(
    vehicle_id: int = Form(...),
    customer_name: str = Form(...),
    customer_phone: str = Form(...),
    license: UploadFile = File(...),
    staff_id: Optional[int] = Form(None),
    odometer_out: Optional[int] = Form(None),
    removed_items: Optional[str] = Form(None),
    added_items: Optional[str] = Form(None),
    items_note: Optional[str] = Form(None),
    customer_informed: bool = Form(False),
    trade_plate_id: Optional[int] = Form(None),
    move_plate: bool = Form(False),
    conn=Depends(get_conn),
):
    # GDPR art. 13: the customer must be told what we store, why and for how long.
    if not customer_informed:
        raise bad_request("Confirm that the customer has been given the privacy information")
    name = (customer_name or "").strip()
    if not 2 <= len(name) <= 120:
        raise bad_request("Customer name is required")
    phone = clean_phone(customer_phone)
    if odometer_out is not None and not 0 <= odometer_out <= 2_000_000:
        raise bad_request("Odometer reading is not valid")
    removed, added = _items(removed_items, "Removed items"), _items(added_items, "Added items")
    note = (items_note or "").strip()[:500] or None
    check_staff(conn, staff_id)
    vehicle = conn.execute("SELECT id FROM vehicles WHERE id = %s AND deleted_at IS NULL FOR UPDATE",
                           (vehicle_id,)).fetchone()
    if not vehicle:
        raise not_found("Vehicle")
    if conn.execute("SELECT 1 FROM test_drives WHERE vehicle_id = %s AND status = 'out'", (vehicle_id,)).fetchone():
        raise conflict("This car is already out on a test drive")

    # Trade plates: one car at a time. If the set is on another car, it is only
    # moved when staff confirmed it (move_plate); that car then needs its return.
    plate, prev = None, None
    if trade_plate_id is not None:
        plate = conn.execute("SELECT * FROM trade_plates WHERE id = %s FOR UPDATE", (trade_plate_id,)).fetchone()
        if not plate or not plate["active"]:
            raise not_found("Trade plates")
        prev = conn.execute(
            """SELECT t.id, t.vehicle_id, v.registration_number, concat_ws(' ', v.make, v.model) AS car
                 FROM test_drives t JOIN vehicles v ON v.id = t.vehicle_id
                WHERE t.trade_plate_id = %s AND t.status = 'out' AND t.plate_moved_at IS NULL FOR UPDATE OF t""",
            (trade_plate_id,)).fetchone()
        if prev and not move_plate:
            raise conflict(f"{plate['name']} are on {prev['registration_number'] or prev['car']}; move them to this car?")
        if prev:  # frees the plates before the new drive takes them (one-plate index)
            conn.execute("UPDATE test_drives SET plate_moved_at = now() WHERE id = %s", (prev["id"],))

    meta = _read_image(license)
    try:
        row = insert_row(conn, "test_drives", {
            "vehicle_id": vehicle_id, "started_by": staff_id, "odometer_out": odometer_out,
            "removed_items": removed, "added_items": added, "items_note": note,
            "customer_name": name, "customer_phone": phone,
            "license_file_key": meta["file_key"], "license_ext": meta["original_ext"],
            "license_mime": meta["mime_type"], "customer_informed": True,
            "trade_plate_id": trade_plate_id,
        })
    except UniqueViolation:
        photostore.remove(meta)
        raise conflict("This car or these trade plates were just taken by someone else; reload and try again")
    except Exception:
        photostore.remove(meta)
        raise
    plate_name = plate["name"] if plate else None
    if prev:
        conn.execute("UPDATE test_drives SET plate_moved_to = %s WHERE id = %s", (row["id"], prev["id"]))
        log_event(conn, prev["vehicle_id"], "trade_plates_moved", staff_id=staff_id,
                  data={"test_drive_id": prev["id"], "trade_plates": plate_name, "to_vehicle_id": vehicle_id})
    # The car's history keeps the drive, but never the customer's details.
    log_event(conn, vehicle_id, "test_drive_out", staff_id=staff_id,
              data={"test_drive_id": row["id"], "odometer_out": odometer_out,
                    "removed": removed, "added": added, "note": note, "trade_plates": plate_name})
    # moved_from_drive_id: the car the plates came from, whose return is due now.
    return {**_drive(conn, row["id"]), "moved_from_drive_id": prev["id"] if prev else None}


def _log_access(conn, request: Request, drive_id: int, action: str) -> None:
    staff = getattr(request.state, "staff", None)
    conn.execute("INSERT INTO test_drive_access_log (test_drive_id, staff_id, action) VALUES (%s, %s, %s)",
                 (drive_id, staff["id"] if staff else None, action))


@router.get("/test-drives/{drive_id}/access-log")
def access_log(drive_id: int, conn=Depends(get_conn)):
    """Who opened the licence photo / deleted the customer details."""
    return conn.execute(
        """SELECT l.action, l.at, s.name AS staff_name FROM test_drive_access_log l
             LEFT JOIN staff s ON s.id = l.staff_id
            WHERE l.test_drive_id = %s ORDER BY l.at DESC LIMIT 100""",
        (drive_id,),
    ).fetchall()


@router.get("/test-drives/{drive_id}/license/{variant}")
def get_license(drive_id: int, variant: str, request: Request, conn=Depends(get_conn)):
    if variant not in photostore.VARIANTS:
        raise not_found("Photo variant")
    row = conn.execute("SELECT license_file_key AS file_key, license_ext AS original_ext, license_mime "
                       "FROM test_drives WHERE id = %s", (drive_id,)).fetchone()
    if not row or not row["file_key"]:
        raise not_found("Licence photo")
    path = photostore.path_for(row, variant)
    if not path.is_file():
        raise not_found("Licence photo file")
    media = row["license_mime"] if variant == "original" else "image/jpeg"
    if variant != "thumb":  # opened in full (thumbnails load with every list view)
        _log_access(conn, request, drive_id, "license_viewed")
    # Personal data: never keep it in the browser cache.
    return FileResponse(path, media_type=media, headers={"Cache-Control": "no-store"})


@router.post("/test-drives/{drive_id}/return")
def return_test_drive(drive_id: int, body: TestDriveReturnIn, request: Request, conn=Depends(get_conn)):
    """The car is back: close the drive and move the customer details to the trash.
    Received by = the logged-in staff member (body.staff_id is ignored)."""
    staff_id = request.state.staff["id"]
    drive = conn.execute("SELECT * FROM test_drives WHERE id = %s FOR UPDATE", (drive_id,)).fetchone()
    if not drive:
        raise not_found("Test drive")
    if drive["status"] != "out":
        raise conflict("This test drive is already returned")
    if body.odometer_in is not None and drive["odometer_out"] is not None and body.odometer_in < drive["odometer_out"]:
        raise bad_request(f"Odometer in ({body.odometer_in}) is lower than when the car left ({drive['odometer_out']})")
    plates_on_car = drive["trade_plate_id"] is not None and drive["plate_moved_at"] is None
    if (drive["removed_items"] or drive["added_items"] or plates_on_car) and not body.items_checked and not body.return_note:
        raise bad_request("Confirm that the items are back in place, or write a note about what is missing")
    conn.execute(
        """UPDATE test_drives
              SET status = 'returned', returned_at = now(), returned_by = %s, odometer_in = %s,
                  items_checked = %s, return_note = %s, customer_trashed_at = now()
            WHERE id = %s""",
        (staff_id, body.odometer_in, body.items_checked, body.return_note, drive_id),
    )
    log_event(conn, drive["vehicle_id"], "test_drive_returned", staff_id=staff_id,
              data={"test_drive_id": drive_id, "odometer_in": body.odometer_in,
                    "km_driven": (body.odometer_in - drive["odometer_out"])
                    if body.odometer_in is not None and drive["odometer_out"] is not None else None,
                    "items_checked": body.items_checked, "note": body.return_note})
    return _drive(conn, drive_id)


@router.delete("/test-drives/{drive_id}/customer", status_code=204)
def delete_customer_now(drive_id: int, request: Request, conn=Depends(get_conn)):
    """Wipe the customer details now instead of waiting for the trash period."""
    drive = conn.execute("SELECT status FROM test_drives WHERE id = %s", (drive_id,)).fetchone()
    if not drive:
        raise not_found("Test drive")
    if drive["status"] != "returned":
        raise conflict("Return the car before deleting the customer details")
    photo = purge_test_drive_customer(conn, drive_id)
    _log_access(conn, request, drive_id, "customer_deleted")
    conn.commit()
    if photo:
        photostore.remove(photo)
