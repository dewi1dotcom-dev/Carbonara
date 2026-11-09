"""Test drives: log which car is out, with which customer, and what was taken
out of / put into the car. Customer details go to the trash when the car is
returned and are wiped for good after TRASH_DAYS (see sync_worker)."""

import json
import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from psycopg.errors import UniqueViolation

from .. import licenselib, photostore
from ..common import (bad_request, check_staff, conflict, insert_row, log_event, not_found,
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
           v.vin, v.make, v.model, v.model_year, v.color, v.registration_number, v.status AS vehicle_status
      FROM test_drives t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN staff so ON so.id = t.started_by
      LEFT JOIN staff sr ON sr.id = t.returned_by"""


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


def _phone(raw: str) -> str:
    """Keep + and digits; Norwegian numbers have 8 digits, foreign ones more."""
    phone = re.sub(r"[\s\-().]", "", raw or "")
    if not re.fullmatch(r"\+?\d{8,15}", phone):
        raise bad_request("Phone number: 8–15 digits, optionally starting with +")
    return phone


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
    conn=Depends(get_conn),
):
    # GDPR art. 13: the customer must be told what we store, why and for how long.
    if not customer_informed:
        raise bad_request("Confirm that the customer has been given the privacy information")
    name = (customer_name or "").strip()
    if not 2 <= len(name) <= 120:
        raise bad_request("Customer name is required")
    phone = _phone(customer_phone)
    if odometer_out is not None and not 0 <= odometer_out <= 2_000_000:
        raise bad_request("Odometer reading is not valid")
    removed, added = _items(removed_items, "Removed items"), _items(added_items, "Added items")
    note = (items_note or "").strip()[:500] or None
    check_staff(conn, staff_id)
    vehicle = conn.execute("SELECT id FROM vehicles WHERE id = %s AND deleted_at IS NULL FOR UPDATE",
                           (vehicle_id,)).fetchone()
    if not vehicle:
        raise not_found("Vehicle")

    meta = _read_image(license)
    try:
        row = insert_row(conn, "test_drives", {
            "vehicle_id": vehicle_id, "started_by": staff_id, "odometer_out": odometer_out,
            "removed_items": removed, "added_items": added, "items_note": note,
            "customer_name": name, "customer_phone": phone,
            "license_file_key": meta["file_key"], "license_ext": meta["original_ext"],
            "license_mime": meta["mime_type"], "customer_informed": True,
        })
    except UniqueViolation:
        photostore.remove(meta)
        raise conflict("This car is already out on a test drive")
    except Exception:
        photostore.remove(meta)
        raise
    # The car's history keeps the drive, but never the customer's details.
    log_event(conn, vehicle_id, "test_drive_out", staff_id=staff_id,
              data={"test_drive_id": row["id"], "odometer_out": odometer_out,
                    "removed": removed, "added": added, "note": note})
    return _drive(conn, row["id"])


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
def return_test_drive(drive_id: int, body: TestDriveReturnIn, conn=Depends(get_conn)):
    """The car is back: close the drive and move the customer details to the trash."""
    check_staff(conn, body.staff_id)
    drive = conn.execute("SELECT * FROM test_drives WHERE id = %s FOR UPDATE", (drive_id,)).fetchone()
    if not drive:
        raise not_found("Test drive")
    if drive["status"] != "out":
        raise conflict("This test drive is already returned")
    if body.odometer_in is not None and drive["odometer_out"] is not None and body.odometer_in < drive["odometer_out"]:
        raise bad_request(f"Odometer in ({body.odometer_in}) is lower than when the car left ({drive['odometer_out']})")
    if (drive["removed_items"] or drive["added_items"]) and not body.items_checked and not body.return_note:
        raise bad_request("Confirm that the items are back in place, or write a note about what is missing")
    conn.execute(
        """UPDATE test_drives
              SET status = 'returned', returned_at = now(), returned_by = %s, odometer_in = %s,
                  items_checked = %s, return_note = %s, customer_trashed_at = now()
            WHERE id = %s""",
        (body.staff_id, body.odometer_in, body.items_checked, body.return_note, drive_id),
    )
    log_event(conn, drive["vehicle_id"], "test_drive_returned", staff_id=body.staff_id,
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
