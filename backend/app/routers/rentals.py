"""Rental cars: the dealer's own rental / loan fleet, and who has which car.

The fleet lives in its own table (rental_cars), apart from the car database:
rental cars never show up in Vehicles, Storage, search or arrivals. Each car is
looked up at Statens vegvesen by registration number, mainly for EU-kontroll.

Rentals work like test drives: customer name, phone, driving licence photo,
items taken out / put in, return check. The customer's details move to the
trash on return and are wiped for good after TRASH_DAYS (see sync_worker).
"""

import datetime as dt
import logging
import time
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from psycopg.errors import UniqueViolation
from pydantic import BaseModel, Field

from .. import photostore, vegvesen
from ..common import bad_request, check_staff, clean_phone, conflict, insert_row, not_found
from ..config import settings
from ..db import get_conn
from ..schemas import TestDriveReturnIn
from .testdrives import _items, _read_image

log = logging.getLogger("carbonara.rentals")
router = APIRouter(tags=["rental cars"])

CAR_FIELDS = ("registration_number", "vin", "make", "model", "model_year", "color", "fuel", "note",
              "eu_control_due", "eu_control_last_approved", "registration_status", "registration_status_code",
              "first_registered", "registry_checked_at", "registry_error")

CAR_SELECT = f"""
    SELECT c.id, {', '.join('c.' + f for f in CAR_FIELDS)}, c.created_at, c.updated_at,
           r.id AS rental_id, r.customer_name AS rented_to, r.started_at AS rented_since,
           r.expected_return_at
      FROM rental_cars c
      LEFT JOIN rentals r ON r.rental_car_id = c.id AND r.status = 'out'"""

RENTAL_SELECT = """
    SELECT r.id, r.rental_car_id, r.status, r.started_at, r.expected_return_at, r.odometer_out,
           r.removed_items, r.added_items, r.items_note, r.returned_at, r.odometer_in, r.items_checked,
           r.return_note, r.customer_name, r.customer_phone, (r.license_file_key IS NOT NULL) AS has_license,
           r.customer_trashed_at, r.customer_purged_at, r.customer_informed,
           r.customer_trashed_at + make_interval(days => %(trash_days)s) AS purge_at,
           so.name AS started_by_name, sr.name AS returned_by_name,
           c.registration_number, c.make, c.model, c.model_year, c.color, c.eu_control_due
      FROM rentals r
      JOIN rental_cars c ON c.id = r.rental_car_id
      LEFT JOIN staff so ON so.id = r.started_by
      LEFT JOIN staff sr ON sr.id = r.returned_by"""

# Rentals whose customer details have been in the trash for TRASH_DAYS (sync_worker).
RENTAL_PURGE_DUE_SQL = """
    SELECT id FROM rentals
     WHERE customer_purged_at IS NULL
       AND customer_trashed_at < now() - make_interval(days => %s)"""


class RentalCarIn(BaseModel):
    registration_number: str = Field(min_length=2, max_length=12)
    vin: Optional[str] = Field(None, max_length=17)
    make: Optional[str] = Field(None, max_length=60)
    model: Optional[str] = Field(None, max_length=80)
    model_year: Optional[int] = Field(None, ge=1950, le=2100)
    color: Optional[str] = Field(None, max_length=40)
    fuel: Optional[str] = Field(None, max_length=40)
    note: Optional[str] = Field(None, max_length=500)
    eu_control_due: Optional[dt.date] = None


class RentalCarPatch(BaseModel):
    registration_number: Optional[str] = Field(None, min_length=2, max_length=12)
    vin: Optional[str] = Field(None, max_length=17)
    make: Optional[str] = Field(None, max_length=60)
    model: Optional[str] = Field(None, max_length=80)
    model_year: Optional[int] = Field(None, ge=1950, le=2100)
    color: Optional[str] = Field(None, max_length=40)
    fuel: Optional[str] = Field(None, max_length=40)
    note: Optional[str] = Field(None, max_length=500)
    eu_control_due: Optional[dt.date] = None


def _privacy() -> dict:
    return {"company": settings.privacy_company, "phone": settings.privacy_contact or None,
            "email": settings.privacy_email or None, "address": settings.privacy_address or None}


def _clean_car(values: dict) -> dict:
    """Trim texts, empty -> None; registration number and VIN without spaces, uppercase."""
    out = {}
    for k, v in values.items():
        if isinstance(v, str):
            v = " ".join(v.split()) or None
        out[k] = v
    if out.get("registration_number") is not None:
        reg = vegvesen.normalize_regnr(out["registration_number"])
        if not 2 <= len(reg) <= 8:
            raise bad_request("Registration number is not valid")
        out["registration_number"] = reg
    if out.get("vin"):
        out["vin"] = out["vin"].replace(" ", "").upper()
    return out


def _car(conn, car_id: int) -> dict:
    row = conn.execute(CAR_SELECT + " WHERE c.id = %s AND c.deleted_at IS NULL", (car_id,)).fetchone()
    if not row:
        raise not_found("Rental car")
    return row


def _rental(conn, rental_id: int) -> dict:
    row = conn.execute(RENTAL_SELECT + " WHERE r.id = %(id)s",
                       {"id": rental_id, "trash_days": settings.trash_days}).fetchone()
    if not row:
        raise not_found("Rental")
    return row


def _me(request: Request) -> Optional[int]:
    staff = getattr(request.state, "staff", None)
    return staff["id"] if staff else None


# --------------------------------------------------------------------------- #
# Statens vegvesen
# --------------------------------------------------------------------------- #

def registry_values(reg: str) -> dict:
    """Look a registration number up at Statens vegvesen. Raises vegvesen.NotFound /
    vegvesen.RegistryError (incl. NotConfigured)."""
    item = vegvesen.fetch_by_regnr(reg)
    s = vegvesen.summary(item)
    f = vegvesen.extract(item)
    v = s["values"]
    return {
        "registration_number": v.get("registration_number") or vegvesen.normalize_regnr(reg),
        "vin": s["vin"], "make": v.get("make"), "model": v.get("model"), "color": v.get("color"),
        "fuel": v.get("fuel_type"),
        "eu_control_due": s["eu_control_due"], "eu_control_last_approved": s["eu_control_last_approved"],
        "registration_status": s["registration_status"], "registration_status_code": s.get("status_code"),
        "first_registered": f["first_registered"] or f["first_registered_norway"],
    }


# Always taken from the registry; the descriptive fields only fill gaps (staff edits win).
REGISTRY_FIELDS = ("eu_control_due", "eu_control_last_approved", "registration_status",
                   "registration_status_code", "first_registered")
DESCRIPTIVE_FIELDS = ("vin", "make", "model", "color", "fuel")


def refresh_registry(conn, car_id: int) -> Optional[str]:
    """Update one rental car from Statens vegvesen. Returns None when it worked,
    otherwise the reason (also saved on the car as registry_error)."""
    car = conn.execute("SELECT * FROM rental_cars WHERE id = %s AND deleted_at IS NULL FOR UPDATE",
                       (car_id,)).fetchone()
    if not car:
        raise not_found("Rental car")
    try:
        values = registry_values(car["registration_number"])
    except vegvesen.NotFound:
        error = "Not found at Statens vegvesen"
    except vegvesen.RegistryError as exc:
        error = str(exc)
    else:
        sets = {k: values[k] for k in REGISTRY_FIELDS}
        sets.update({k: values[k] for k in DESCRIPTIVE_FIELDS if values.get(k) and not car[k]})
        cols = ", ".join(f"{k} = %({k})s" for k in sets)
        conn.execute(f"UPDATE rental_cars SET {cols}, registry_checked_at = now(), registry_error = NULL, "
                     "updated_at = now() WHERE id = %(id)s", {**sets, "id": car_id})
        return None
    conn.execute("UPDATE rental_cars SET registry_error = %s WHERE id = %s", (error, car_id))
    return error


def refresh_due_rental_cars(conn_factory) -> int:
    """Worker: re-check rental cars every vegvesen_sync_days (EU-kontroll changes
    when a car has passed). conn_factory() gives a new connection per car."""
    if not vegvesen.is_configured():
        return 0
    with conn_factory() as conn:
        ids = [r["id"] for r in conn.execute(
            """SELECT id FROM rental_cars WHERE deleted_at IS NULL
                 AND (registry_checked_at IS NULL
                      OR registry_checked_at < now() - make_interval(days => %s))
               ORDER BY registry_checked_at NULLS FIRST LIMIT 50""", (settings.vegvesen_sync_days,)).fetchall()]
    for car_id in ids:
        try:
            with conn_factory() as conn:
                error = refresh_registry(conn, car_id)
        except Exception:  # e.g. removed meanwhile: carry on with the next car
            log.exception("rental car %s: registry refresh failed", car_id)
            continue
        log.info("rental car %s: %s", car_id, error or "updated from Statens vegvesen")
        time.sleep(settings.vegvesen_call_interval_s)
    return len(ids)


@router.get("/rental-cars/lookup")
def lookup(reg: str):
    """Statens vegvesen data for the add form (nothing is saved)."""
    if not vegvesen.is_configured():
        raise conflict("Statens vegvesen is not set up (API key on the System page)")
    try:
        return registry_values(reg)
    except vegvesen.NotFound:
        raise not_found("Registration number at Statens vegvesen")
    except vegvesen.RegistryError as exc:
        raise HTTPException(502, f"Statens vegvesen: {exc}")


# --------------------------------------------------------------------------- #
# the fleet
# --------------------------------------------------------------------------- #

@router.get("/rental-cars")
def list_rental_cars(conn=Depends(get_conn)):
    """The fleet (EU-kontroll first), cars out now, and returned rentals whose
    customer details are still in the trash."""
    params = {"trash_days": settings.trash_days}
    cars = conn.execute(CAR_SELECT + " WHERE c.deleted_at IS NULL "
                        "ORDER BY c.eu_control_due NULLS LAST, c.registration_number").fetchall()
    active = conn.execute(RENTAL_SELECT + " WHERE r.status = 'out' ORDER BY r.expected_return_at NULLS LAST, r.started_at",
                          params).fetchall()
    trash = conn.execute(RENTAL_SELECT + """ WHERE r.status = 'returned' AND r.customer_purged_at IS NULL
                                             ORDER BY r.returned_at DESC""", params).fetchall()
    return {"cars": cars, "active": active, "trash": trash, "trash_days": settings.trash_days,
            "privacy": _privacy(), "registry": vegvesen.is_configured()}


@router.post("/rental-cars", status_code=201)
def add_rental_car(body: RentalCarIn, request: Request, conn=Depends(get_conn)):
    """Add a car to the fleet, then fetch its Statens vegvesen data (a failed
    lookup doesn't stop the car being added; it shows on the car)."""
    values = _clean_car(body.model_dump())
    try:
        with conn.transaction():  # savepoint, so the duplicate check can be reported nicely
            row = insert_row(conn, "rental_cars", {**values, "created_by": _me(request)})
    except UniqueViolation:
        raise conflict(f"{values['registration_number']} is already a rental car")
    if vegvesen.is_configured():
        refresh_registry(conn, row["id"])
    log.info("staff %s added rental car %s", _me(request), values["registration_number"])
    return _car(conn, row["id"])


@router.patch("/rental-cars/{car_id}")
def edit_rental_car(car_id: int, body: RentalCarPatch, conn=Depends(get_conn)):
    sent = _clean_car(body.model_dump(exclude_unset=True))
    if "registration_number" in sent and not sent["registration_number"]:
        raise bad_request("Registration number is required")
    car = conn.execute("SELECT * FROM rental_cars WHERE id = %s AND deleted_at IS NULL FOR UPDATE",
                       (car_id,)).fetchone()
    if not car:
        raise not_found("Rental car")
    if not sent:
        return _car(conn, car_id)
    cols = ", ".join(f"{k} = %({k})s" for k in sent)
    try:
        with conn.transaction():
            conn.execute(f"UPDATE rental_cars SET {cols}, updated_at = now() WHERE id = %(id)s", {**sent, "id": car_id})
    except UniqueViolation:
        raise conflict(f"{sent['registration_number']} is already a rental car")
    # A new registration number is a different car at Statens vegvesen: look it up again.
    if sent.get("registration_number") and sent["registration_number"] != car["registration_number"] \
            and vegvesen.is_configured():
        refresh_registry(conn, car_id)
    return _car(conn, car_id)


@router.post("/rental-cars/{car_id}/refresh")
def refresh_rental_car(car_id: int, conn=Depends(get_conn)):
    """"Look up again" at Statens vegvesen."""
    if not vegvesen.is_configured():
        raise conflict("Statens vegvesen is not set up (API key on the System page)")
    error = refresh_registry(conn, car_id)
    conn.commit()  # keep registry_error even though the request reports a failure
    if error:
        raise HTTPException(502, f"Statens vegvesen: {error}")
    return _car(conn, car_id)


@router.delete("/rental-cars/{car_id}", status_code=204)
def remove_rental_car(car_id: int, request: Request, conn=Depends(get_conn)):
    """Remove a car from the fleet. With rental history it is only hidden, so the
    history (without customer details once purged) keeps its car."""
    car = conn.execute("SELECT id FROM rental_cars WHERE id = %s AND deleted_at IS NULL FOR UPDATE",
                       (car_id,)).fetchone()
    if not car:
        raise not_found("Rental car")
    if conn.execute("SELECT 1 FROM rentals WHERE rental_car_id = %s AND status = 'out'", (car_id,)).fetchone():
        raise conflict("This car is out on rental; register the return first")
    if conn.execute("SELECT 1 FROM rentals WHERE rental_car_id = %s", (car_id,)).fetchone():
        conn.execute("UPDATE rental_cars SET deleted_at = now(), deleted_by = %s WHERE id = %s", (_me(request), car_id))
    else:
        conn.execute("DELETE FROM rental_cars WHERE id = %s", (car_id,))


# --------------------------------------------------------------------------- #
# rentals
# --------------------------------------------------------------------------- #

@router.post("/rentals", status_code=201)
def start_rental(
    rental_car_id: int = Form(...),
    customer_name: str = Form(...),
    customer_phone: str = Form(...),
    license: UploadFile = File(...),
    staff_id: Optional[int] = Form(None),
    expected_return: Optional[str] = Form(None),  # "2026-11-20T16:00", Norwegian local time
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
    phone = clean_phone(customer_phone)
    if odometer_out is not None and not 0 <= odometer_out <= 2_000_000:
        raise bad_request("Odometer reading is not valid")
    removed, added = _items(removed_items, "Removed items"), _items(added_items, "Added items")
    note = (items_note or "").strip()[:500] or None
    back = None
    if expected_return:
        try:
            back = dt.datetime.fromisoformat(expected_return.strip()).replace(tzinfo=None, second=0, microsecond=0)
        except ValueError:
            raise bad_request("Expected return: not a valid date and time")
    check_staff(conn, staff_id)
    if not conn.execute("SELECT id FROM rental_cars WHERE id = %s AND deleted_at IS NULL FOR UPDATE",
                        (rental_car_id,)).fetchone():
        raise not_found("Rental car")
    if conn.execute("SELECT 1 FROM rentals WHERE rental_car_id = %s AND status = 'out'", (rental_car_id,)).fetchone():
        raise conflict("This car is already out on rental")

    meta = _read_image(license)
    try:
        row = insert_row(conn, "rentals", {
            "rental_car_id": rental_car_id, "started_by": staff_id,
            "odometer_out": odometer_out, "removed_items": removed, "added_items": added, "items_note": note,
            "customer_name": name, "customer_phone": phone,
            "license_file_key": meta["file_key"], "license_ext": meta["original_ext"],
            "license_mime": meta["mime_type"], "customer_informed": True,
        })
    except UniqueViolation:
        photostore.remove(meta)
        raise conflict("This car was just rented out by someone else; reload and try again")
    except Exception:
        photostore.remove(meta)
        raise
    if back:  # typed as Norwegian local time
        conn.execute("UPDATE rentals SET expected_return_at = (%s::timestamp AT TIME ZONE 'Europe/Oslo') WHERE id = %s",
                     (back, row["id"]))
    return _rental(conn, row["id"])


def _log_access(conn, request: Request, rental_id: int, action: str) -> None:
    conn.execute("INSERT INTO rental_access_log (rental_id, staff_id, action) VALUES (%s, %s, %s)",
                 (rental_id, _me(request), action))


@router.get("/rentals/{rental_id}/access-log")
def access_log(rental_id: int, conn=Depends(get_conn)):
    """Who opened the licence photo / deleted the customer details."""
    return conn.execute(
        """SELECT l.action, l.at, s.name AS staff_name FROM rental_access_log l
             LEFT JOIN staff s ON s.id = l.staff_id
            WHERE l.rental_id = %s ORDER BY l.at DESC LIMIT 100""",
        (rental_id,),
    ).fetchall()


@router.get("/rentals/{rental_id}/license/{variant}")
def get_license(rental_id: int, variant: str, request: Request, conn=Depends(get_conn)):
    if variant not in photostore.VARIANTS:
        raise not_found("Photo variant")
    row = conn.execute("SELECT license_file_key AS file_key, license_ext AS original_ext, license_mime "
                       "FROM rentals WHERE id = %s", (rental_id,)).fetchone()
    if not row or not row["file_key"]:
        raise not_found("Licence photo")
    path = photostore.path_for(row, variant)
    if not path.is_file():
        raise not_found("Licence photo file")
    media = row["license_mime"] if variant == "original" else "image/jpeg"
    if variant != "thumb":  # opened in full (thumbnails load with every list view)
        _log_access(conn, request, rental_id, "license_viewed")
    # Personal data: never keep it in the browser cache.
    return FileResponse(path, media_type=media, headers={"Cache-Control": "no-store"})


@router.post("/rentals/{rental_id}/return")
def return_rental(rental_id: int, body: TestDriveReturnIn, request: Request, conn=Depends(get_conn)):
    """The car is back: close the rental and move the customer details to the trash.
    Received by = the logged-in staff member."""
    staff_id = _me(request)
    rental = conn.execute("SELECT * FROM rentals WHERE id = %s FOR UPDATE", (rental_id,)).fetchone()
    if not rental:
        raise not_found("Rental")
    if rental["status"] != "out":
        raise conflict("This rental is already returned")
    if body.odometer_in is not None and rental["odometer_out"] is not None and body.odometer_in < rental["odometer_out"]:
        raise bad_request(f"Odometer in ({body.odometer_in}) is lower than when the car left ({rental['odometer_out']})")
    if (rental["removed_items"] or rental["added_items"]) and not body.items_checked and not body.return_note:
        raise bad_request("Confirm that the items are back in place, or write a note about what is missing")
    conn.execute(
        """UPDATE rentals
              SET status = 'returned', returned_at = now(), returned_by = %s, odometer_in = %s,
                  items_checked = %s, return_note = %s, customer_trashed_at = now()
            WHERE id = %s""",
        (staff_id, body.odometer_in, body.items_checked, body.return_note, rental_id),
    )
    return _rental(conn, rental_id)


def purge_rental_customer(conn, rental_id: int) -> dict | None:
    """Wipe a rental's customer details for good (name, phone, licence photo).
    Returns the photo row for photostore.remove() after commit, or None."""
    row = conn.execute(
        """UPDATE rentals r
              SET customer_name = NULL, customer_phone = NULL,
                  license_file_key = NULL, license_ext = NULL, license_mime = NULL,
                  customer_purged_at = now()
             FROM (SELECT id, license_file_key, license_ext FROM rentals WHERE id = %s FOR UPDATE) prev
            WHERE r.id = prev.id
        RETURNING prev.license_file_key AS file_key, prev.license_ext AS original_ext""",
        (rental_id,),
    ).fetchone()
    return row if row and row["file_key"] else None


@router.delete("/rentals/{rental_id}/customer", status_code=204)
def delete_customer_now(rental_id: int, request: Request, conn=Depends(get_conn)):
    """Wipe the customer details now instead of waiting for the trash period."""
    rental = conn.execute("SELECT status FROM rentals WHERE id = %s", (rental_id,)).fetchone()
    if not rental:
        raise not_found("Rental")
    if rental["status"] != "returned":
        raise conflict("Return the car before deleting the customer details")
    photo = purge_rental_customer(conn, rental_id)
    _log_access(conn, request, rental_id, "customer_deleted")
    conn.commit()
    if photo:
        photostore.remove(photo)
