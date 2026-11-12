"""Customer car delivery: customers dropping off their car for the workshop
register it on a kiosk tablet at the dealership (registration number, name,
phone, where the key is, a pin on a picture of the lot, tick boxes, message).

- kiosk_router (/api/kiosk/…): the form. Open to a kiosk tablet (its own cookie,
  see auth.require_kiosk_or_staff) or a logged-in staff member (preview).
- router: staff list, "received", and the admin setup (maps, key places, tick
  boxes, kiosk tablets).

Personal data (name, phone, message) never goes into vehicle_events. A delivery
is deleted for good TRASH_DAYS after it was received (sync_worker)."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import auth, photostore
from ..auth import require_admin, require_kiosk_or_staff
from ..common import bad_request, cap_name, clean_phone, conflict, log_event, not_found
from ..config import settings
from ..db import get_conn

log = logging.getLogger("carbonara.deliveries")
kiosk_router = APIRouter(prefix="/kiosk", tags=["delivery kiosk"])
router = APIRouter(tags=["customer deliveries"])

MAP_SELECT = """
    SELECT m.id, m.name, m.name_no, m.width, m.height, m.sort, m.active, m.created_at,
           (SELECT count(*) FROM car_deliveries d WHERE d.map_id = m.id) AS used
      FROM delivery_maps m"""

DELIVERY_SELECT = """
    SELECT d.id, d.registration_number, d.vehicle_id, d.customer_name, d.customer_phone,
           d.map_id, d.pin_x, d.pin_y, d.key_place, d.checks, d.message, d.created_at,
           d.received_at, sr.name AS received_by_name,
           d.received_at + make_interval(days => %(trash_days)s) AS purge_at,
           m.name AS map_name, m.name_no AS map_name_no, k.name AS kiosk_name,
           v.make, v.model, v.model_year
      FROM car_deliveries d
      LEFT JOIN delivery_maps m ON m.id = d.map_id
      LEFT JOIN staff sr ON sr.id = d.received_by
      LEFT JOIN kiosk_devices k ON k.id = d.kiosk_id
      LEFT JOIN vehicles v ON v.id = d.vehicle_id AND v.deleted_at IS NULL"""


def _clean_reg(raw: Optional[str]) -> str:
    """'eb 82 655' -> 'EB82655' (stored without spaces, like vehicles)."""
    return "".join(ch for ch in (raw or "").upper() if ch.isalnum())


def _set_kiosk_cookie(response: Response, token: str) -> None:
    # secure=False: plain HTTP on the local network for now (as the staff session).
    response.set_cookie(auth.KIOSK_COOKIE, token, max_age=auth.KIOSK_DAYS * 86400,
                        httponly=True, samesite="lax", secure=False, path="/")


def _privacy() -> dict:
    return {"company": settings.privacy_company, "phone": settings.privacy_contact or None,
            "email": settings.privacy_email or None, "address": settings.privacy_address or None}


# --------------------------------------------------------------------------- #
# the kiosk form
# --------------------------------------------------------------------------- #

class DeliveryIn(BaseModel):
    registration_number: str = Field(max_length=20)
    customer_name: str = Field(max_length=120)
    customer_phone: str = Field(max_length=30)
    map_id: Optional[int] = None
    pin_x: Optional[float] = Field(None, ge=0, le=1)
    pin_y: Optional[float] = Field(None, ge=0, le=1)
    key_place_id: Optional[int] = None
    check_ids: list[int] = Field(default_factory=list, max_length=50)
    message: Optional[str] = Field(None, max_length=1000)


@kiosk_router.get("/config")
def kiosk_config(request: Request, response: Response, who=Depends(require_kiosk_or_staff), conn=Depends(get_conn)):
    """Everything the form needs: maps, key places, tick boxes, privacy contact."""
    if who["kiosk"]:  # a tablet left on for months keeps its kiosk cookie
        _set_kiosk_cookie(response, request.cookies[auth.KIOSK_COOKIE])
    options = conn.execute("SELECT id, kind, label, label_no FROM delivery_options WHERE active "
                           "ORDER BY sort, id").fetchall()
    return {
        "kiosk": who["kiosk"],
        "maps": conn.execute(MAP_SELECT + " WHERE m.active ORDER BY m.sort, m.id").fetchall(),
        "key_places": [o for o in options if o["kind"] == "key_place"],
        "checkboxes": [o for o in options if o["kind"] == "checkbox"],
        "privacy": _privacy(),
        "trash_days": settings.trash_days,
    }


@kiosk_router.get("/maps/{map_id}/image")
def map_image(map_id: int, _who=Depends(require_kiosk_or_staff), conn=Depends(get_conn)):
    row = conn.execute("SELECT file_key, original_ext FROM delivery_maps WHERE id = %s", (map_id,)).fetchone()
    if not row:
        raise not_found("Map")
    path = photostore.path_for(row, "display")
    if not path.is_file():
        raise not_found("Map file")
    # A map's picture never changes (a new picture is a new map), so it can be cached.
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@kiosk_router.post("/deliveries", status_code=201)
def create_delivery(body: DeliveryIn, who=Depends(require_kiosk_or_staff), conn=Depends(get_conn)):
    reg = _clean_reg(body.registration_number)
    if not 2 <= len(reg) <= 8:
        raise bad_request("Registration number: 2–8 letters and digits")
    name = cap_name(body.customer_name)
    if not 2 <= len(name) <= 120:
        raise bad_request("Customer name is required")
    phone = clean_phone(body.customer_phone)

    # Where the car is: required as soon as at least one map is set up.
    map_ids = {r["id"] for r in conn.execute("SELECT id FROM delivery_maps WHERE active").fetchall()}
    map_id, pin_x, pin_y = None, None, None
    if map_ids:
        if body.map_id not in map_ids:
            raise bad_request("Choose where the car is parked")
        if body.pin_x is None or body.pin_y is None:
            raise bad_request("Tap the map where the car is parked")
        map_id, pin_x, pin_y = body.map_id, body.pin_x, body.pin_y

    # Labels are stored as shown (both languages), so renaming an option later
    # doesn't change what the customer chose.
    options = {r["id"]: r for r in conn.execute("SELECT * FROM delivery_options WHERE active").fetchall()}
    key_place = None
    if any(o["kind"] == "key_place" for o in options.values()):
        o = options.get(body.key_place_id)
        if not o or o["kind"] != "key_place":
            raise bad_request("Choose where you left the key")
        key_place = {"en": o["label"], "no": o["label_no"]}
    checks = [{"en": options[i]["label"], "no": options[i]["label_no"]}
              for i in dict.fromkeys(body.check_ids) if i in options and options[i]["kind"] == "checkbox"]
    message = (body.message or "").strip() or None

    vehicle = conn.execute("SELECT id FROM vehicles WHERE registration_number = %s AND deleted_at IS NULL "
                           "ORDER BY id DESC LIMIT 1", (reg,)).fetchone()
    row = conn.execute(
        """INSERT INTO car_deliveries (registration_number, vehicle_id, customer_name, customer_phone, map_id,
                                       pin_x, pin_y, key_place, checks, message, kiosk_id)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id, created_at""",
        (reg, vehicle["id"] if vehicle else None, name, phone, map_id, pin_x, pin_y,
         Jsonb(key_place) if key_place else None, Jsonb(checks), message,
         who["kiosk"]["id"] if who["kiosk"] else None),
    ).fetchone()
    if vehicle:  # the car's history gets the delivery, never the customer's details
        log_event(conn, vehicle["id"], "customer_delivery", data={"delivery_id": row["id"]})
    return {"id": row["id"], "created_at": row["created_at"]}


# --------------------------------------------------------------------------- #
# staff: deliveries
# --------------------------------------------------------------------------- #

@router.get("/deliveries")
def list_deliveries(conn=Depends(get_conn)):
    """Waiting to be received, and received ones (kept TRASH_DAYS, then deleted)."""
    params = {"trash_days": settings.trash_days}
    return {
        "open": conn.execute(DELIVERY_SELECT + " WHERE d.received_at IS NULL ORDER BY d.created_at",
                             params).fetchall(),
        "received": conn.execute(DELIVERY_SELECT + " WHERE d.received_at IS NOT NULL ORDER BY d.received_at DESC",
                                 params).fetchall(),
        "trash_days": settings.trash_days,
        "privacy": _privacy(),
    }


@router.post("/deliveries/{delivery_id}/receive")
def receive_delivery(delivery_id: int, request: Request, conn=Depends(get_conn)):
    """Staff have the car and the key. Received by = the logged-in staff member."""
    staff_id = request.state.staff["id"]
    d = conn.execute("SELECT id, vehicle_id, received_at FROM car_deliveries WHERE id = %s FOR UPDATE",
                     (delivery_id,)).fetchone()
    if not d:
        raise not_found("Delivery")
    if d["received_at"]:
        raise conflict("This delivery is already received")
    conn.execute("UPDATE car_deliveries SET received_at = now(), received_by = %s WHERE id = %s",
                 (staff_id, delivery_id))
    if d["vehicle_id"]:
        log_event(conn, d["vehicle_id"], "customer_delivery_received", staff_id=staff_id,
                  data={"delivery_id": delivery_id})
    return {"ok": True}


@router.delete("/deliveries/{delivery_id}", status_code=204)
def delete_delivery(delivery_id: int, request: Request, conn=Depends(get_conn)):
    """Delete a received delivery (with the customer's details) now instead of after the trash period."""
    d = conn.execute("SELECT received_at FROM car_deliveries WHERE id = %s", (delivery_id,)).fetchone()
    if not d:
        raise not_found("Delivery")
    if not d["received_at"]:
        raise conflict("Mark the car as received before deleting the delivery")
    conn.execute("DELETE FROM car_deliveries WHERE id = %s", (delivery_id,))
    log.info("delivery %s deleted by staff %s", delivery_id, request.state.staff["id"])


# --------------------------------------------------------------------------- #
# admin setup: key places and tick boxes
# --------------------------------------------------------------------------- #

class OptionIn(BaseModel):
    kind: str = Field(pattern="^(key_place|checkbox)$")
    label: str = Field(min_length=1, max_length=80)
    label_no: str = Field(min_length=1, max_length=80)


class OptionPatch(BaseModel):
    label: Optional[str] = Field(None, min_length=1, max_length=80)
    label_no: Optional[str] = Field(None, min_length=1, max_length=80)
    active: Optional[bool] = None


def _label(raw: str) -> str:
    text = " ".join((raw or "").split())
    if not text:
        raise bad_request("Give both the English and the Norwegian text")
    return text


@router.get("/delivery-options")
def list_options(conn=Depends(get_conn)):
    return conn.execute("SELECT * FROM delivery_options ORDER BY kind, active DESC, sort, id").fetchall()


@router.post("/delivery-options", status_code=201)
def add_option(body: OptionIn, conn=Depends(get_conn), _admin=Depends(require_admin)):
    sort = conn.execute("SELECT coalesce(max(sort), 0) + 10 AS s FROM delivery_options WHERE kind = %s",
                        (body.kind,)).fetchone()["s"]
    return conn.execute(
        "INSERT INTO delivery_options (kind, label, label_no, sort) VALUES (%s, %s, %s, %s) RETURNING *",
        (body.kind, _label(body.label), _label(body.label_no), sort)).fetchone()


@router.patch("/delivery-options/{option_id}")
def patch_option(option_id: int, body: OptionPatch, conn=Depends(get_conn), _admin=Depends(require_admin)):
    row = conn.execute("SELECT * FROM delivery_options WHERE id = %s FOR UPDATE", (option_id,)).fetchone()
    if not row:
        raise not_found("List entry")
    conn.execute("UPDATE delivery_options SET label = %s, label_no = %s, active = %s WHERE id = %s",
                 (_label(body.label) if body.label is not None else row["label"],
                  _label(body.label_no) if body.label_no is not None else row["label_no"],
                  row["active"] if body.active is None else body.active, option_id))
    return conn.execute("SELECT * FROM delivery_options WHERE id = %s", (option_id,)).fetchone()


# --------------------------------------------------------------------------- #
# admin setup: maps (one picture per location)
# --------------------------------------------------------------------------- #

class MapPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    name_no: Optional[str] = Field(None, max_length=80)
    active: Optional[bool] = None


@router.get("/delivery-maps")
def list_maps(conn=Depends(get_conn)):
    return conn.execute(MAP_SELECT + " ORDER BY m.active DESC, m.sort, m.id").fetchall()


@router.post("/delivery-maps", status_code=201)
def add_map(request: Request, name: str = Form(...), name_no: Optional[str] = Form(None),
            file: UploadFile = File(...), conn=Depends(get_conn), _admin=Depends(require_admin)):
    name = " ".join((name or "").split())
    if not name or len(name) > 80:
        raise bad_request("Give the location a name")
    name_no = " ".join((name_no or "").split())[:80] or None
    data = file.file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(413, "Image too large")
    try:
        meta = photostore.store(data)
    except photostore.PhotoError as exc:
        raise bad_request(str(exc))
    try:
        sort = conn.execute("SELECT coalesce(max(sort), 0) + 10 AS s FROM delivery_maps").fetchone()["s"]
        row = conn.execute(
            """INSERT INTO delivery_maps (name, name_no, file_key, original_ext, width, height, sort, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (name, name_no, meta["file_key"], meta["original_ext"], meta["width"], meta["height"], sort,
             request.state.staff["id"])).fetchone()
    except Exception:
        photostore.remove(meta)
        raise
    return conn.execute(MAP_SELECT + " WHERE m.id = %s", (row["id"],)).fetchone()


@router.patch("/delivery-maps/{map_id}")
def patch_map(map_id: int, body: MapPatch, conn=Depends(get_conn), _admin=Depends(require_admin)):
    row = conn.execute("SELECT * FROM delivery_maps WHERE id = %s FOR UPDATE", (map_id,)).fetchone()
    if not row:
        raise not_found("Map")
    name = " ".join(body.name.split()) if body.name is not None else row["name"]
    if not name:
        raise bad_request("Give the location a name")
    name_no = (" ".join(body.name_no.split()) or None) if body.name_no is not None else row["name_no"]
    active = row["active"] if body.active is None else body.active
    conn.execute("UPDATE delivery_maps SET name = %s, name_no = %s, active = %s WHERE id = %s",
                 (name, name_no, active, map_id))
    return conn.execute(MAP_SELECT + " WHERE m.id = %s", (map_id,)).fetchone()


@router.delete("/delivery-maps/{map_id}", status_code=204)
def delete_map(map_id: int, conn=Depends(get_conn), _admin=Depends(require_admin)):
    """Only a map no delivery points to; otherwise it is removed (deactivated) instead."""
    row = conn.execute("SELECT * FROM delivery_maps WHERE id = %s FOR UPDATE", (map_id,)).fetchone()
    if not row:
        raise not_found("Map")
    if conn.execute("SELECT 1 FROM car_deliveries WHERE map_id = %s LIMIT 1", (map_id,)).fetchone():
        raise conflict("Deliveries point to this map, so it can only be removed, not deleted")
    conn.execute("DELETE FROM delivery_maps WHERE id = %s", (map_id,))
    conn.commit()  # the row is gone before the file
    photostore.remove(row)


# --------------------------------------------------------------------------- #
# admin setup: kiosk tablets
# --------------------------------------------------------------------------- #

class KioskIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)


@router.get("/kiosk-devices")
def list_kiosks(conn=Depends(get_conn), _admin=Depends(require_admin)):
    return conn.execute(
        """SELECT k.id, k.name, k.created_at, k.last_seen_at, k.revoked_at, c.name AS created_by_name
             FROM kiosk_devices k LEFT JOIN staff c ON c.id = k.created_by
            ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC LIMIT 50""").fetchall()


@router.post("/kiosk-devices", status_code=201)
def make_kiosk(body: KioskIn, request: Request, response: Response, conn=Depends(get_conn),
               admin=Depends(require_admin)):
    """Turn THIS device into a delivery kiosk: it gets a kiosk cookie, and the
    admin is logged out here, so customers can't reach the rest of Carbonara."""
    name = " ".join(body.name.split())
    if not name:
        raise bad_request("Give the kiosk a name")
    _set_kiosk_cookie(response, auth.new_kiosk(conn, name, admin["id"]))
    auth.end_session(conn, request.cookies.get(auth.COOKIE))
    response.delete_cookie(auth.COOKIE, path="/")
    log.info("staff %s made device '%s' a delivery kiosk", admin["id"], name)
    return {"ok": True}


@router.delete("/kiosk-devices/{kiosk_id}", status_code=204)
def revoke_kiosk(kiosk_id: int, conn=Depends(get_conn), admin=Depends(require_admin)):
    """The tablet stops showing the form (e.g. lost, or replaced)."""
    row = conn.execute("UPDATE kiosk_devices SET revoked_at = now(), revoked_by = %s "
                       "WHERE id = %s AND revoked_at IS NULL RETURNING id", (admin["id"], kiosk_id)).fetchone()
    if not row:
        raise not_found("Kiosk")
