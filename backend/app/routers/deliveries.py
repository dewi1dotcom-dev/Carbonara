"""Customer car delivery: customers dropping off their car for the workshop
register it on a kiosk tablet at the dealership (registration number, name,
phone, where the key is, a pin on a picture of the lot, tick boxes, message).

- kiosk_router (/api/kiosk/…): the form. Open to a kiosk tablet (its own cookie,
  see auth.require_kiosk_or_staff) or a logged-in staff member (preview).
- router: staff list, "received", and the admin setup (maps, key places, tick
  boxes, kiosk tablets).

Personal data (name, phone, message) never goes into vehicle_events. A delivery
is deleted for good TRASH_DAYS after it was received (sync_worker)."""

import datetime as dt
import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import auth, photostore, vegvesen
from ..auth import require_admin, require_kiosk_or_staff, require_superadmin
from ..common import (bad_request, cap_name, clean_phone, conflict, log_event, name_match, not_found,
                      tidy_name, update_row)
from ..common import org_no
from ..config import settings
from ..db import get_conn, pool

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
           -- The owner's name from Statens vegvesen is shown first; the typed one is kept.
           coalesce(d.svv_name, d.customer_name) AS display_name, d.svv_name, d.svv_owner_kind, d.name_match,
           d.svv_status, d.svv_checked_at, d.svv_error, d.svv_vin, d.svv_make, d.svv_model, d.svv_eu_due,
           d.received_at + make_interval(days => %(trash_days)s) AS purge_at,
           m.name AS map_name, m.name_no AS map_name_no, k.name AS kiosk_name,
           v.make, v.model, v.model_year,
           d.customer_car_id, cc.make AS car_make, cc.model AS car_model,
           d.work_order_id, (SELECT w.number FROM work_orders w WHERE w.id = d.work_order_id) AS work_order_number,
           d.owner_address, d.owner_postal_code, d.owner_city, d.not_owner, d.contact_name,
           -- The car's open work orders (0.60.4: shown on the staff card, or "New work order" when there are none).
           (SELECT coalesce(json_agg(json_build_object('id', w.id, 'number', w.number, 'title', w.title)
                                     ORDER BY w.number), '[]'::json)
              FROM work_orders w WHERE w.customer_car_id = d.customer_car_id
               AND w.status IN ('open', 'in_progress')) AS open_work_orders
      FROM car_deliveries d
      LEFT JOIN delivery_maps m ON m.id = d.map_id
      LEFT JOIN staff sr ON sr.id = d.received_by
      LEFT JOIN kiosk_devices k ON k.id = d.kiosk_id
      LEFT JOIN vehicles v ON v.id = d.vehicle_id AND v.deleted_at IS NULL
      LEFT JOIN customer_cars cc ON cc.id = d.customer_car_id"""


def _clean_reg(raw: Optional[str]) -> str:
    """'eb 82 655' -> 'EB82655' (stored without spaces, like vehicles)."""
    return "".join(ch for ch in (raw or "").upper() if ch.isalnum())


def _set_kiosk_cookie(request: Request, response: Response, token: str) -> None:
    # "secure" over HTTPS (caddy), as the staff session; plain HTTP on APP_PORT still works meanwhile.
    response.set_cookie(auth.KIOSK_COOKIE, token, max_age=auth.KIOSK_DAYS * 86400,
                        httponly=True, samesite="lax", secure=auth.cookie_secure(request), path="/")


# --------------------------------------------------------------------------- #
# Statens vegvesen lookup by registration number
# --------------------------------------------------------------------------- #

def _registry_lookup(reg: str, typed_name: str) -> dict:
    """Ask Statens vegvesen about the car (no DB work, so no connection is held
    while waiting). Returns the car_deliveries columns to update.

    A temporary problem (error / not set up) only updates the status, so data from
    an earlier good lookup stays; 'not found' clears it (the reg. no is probably wrong)."""
    out = {"svv_checked_at": dt.datetime.now(dt.timezone.utc), "svv_error": None}
    if not vegvesen.is_configured():
        return out | {"svv_status": "not_configured"}
    try:
        item = vegvesen.fetch_by_regnr(reg)
    except vegvesen.NotFound as exc:
        return out | {"svv_status": "not_found", "svv_error": str(exc)[:300], "svv_vin": None, "svv_make": None,
                      "svv_model": None, "svv_eu_due": None, "svv_name": None, "svv_owner_kind": None,
                      "name_match": None}
    except vegvesen.RegistryError as exc:
        return out | {"svv_status": "error", "svv_error": str(exc)[:300]}
    except Exception:  # never let a lookup problem break the delivery itself
        log.exception("Vegvesen lookup failed for a delivery")
        return out | {"svv_status": "error", "svv_error": "Lookup failed"}
    values = vegvesen.vehicle_values(item)
    own = vegvesen.owner(item)
    svv_name = tidy_name(own["name"]) if own else None
    return out | {
        "svv_status": "ok",
        "svv_vin": (vegvesen.dig(item, "kjoretoyId", "understellsnummer") or "").upper() or None,
        "svv_make": values.get("make"),
        "svv_model": values.get("model"),
        "svv_eu_due": vegvesen.extract(item)["eu_control_due"],
        "svv_name": svv_name,
        "svv_owner_kind": own["kind"] if own else None,
        "name_match": name_match(typed_name, svv_name, own["kind"] if own else None),
    }


def _register_event(conn, car_id: int, delivery_id: int) -> None:
    conn.execute("INSERT INTO register_events (car_id, kind, data) VALUES (%s, 'customer_delivery', %s)",
                 (car_id, Jsonb({"delivery_id": delivery_id})))


def _save_lookup(conn, delivery_id: int, fields: dict) -> None:
    row = update_row(conn, "car_deliveries", delivery_id, fields)
    # Not linked by reg. no, but the car is in the workshop's register by VIN (0.53.0: the register, never the
    # sales stock).
    if row and not row["customer_car_id"] and not row["vehicle_id"] and row["svv_vin"]:
        car = conn.execute("SELECT id FROM customer_cars WHERE vin = %s ORDER BY id DESC LIMIT 1",
                           (row["svv_vin"],)).fetchone()
        if car:
            conn.execute("UPDATE car_deliveries SET customer_car_id = %s WHERE id = %s", (car["id"], delivery_id))
            _register_event(conn, car["id"], delivery_id)


def lookup_in_background(delivery_id: int, reg: str, typed_name: str) -> None:
    """Runs after the kiosk has its answer, so the customer never waits for Statens vegvesen."""
    fields = _registry_lookup(reg, typed_name)
    try:
        with pool.connection() as conn:  # commits on leaving the block
            _save_lookup(conn, delivery_id, fields)
    except Exception:
        log.exception("Could not save the Vegvesen lookup for delivery %s", delivery_id)


def _privacy() -> dict:
    """Contact on the kiosk's privacy notice. A company set under System → Customer
    deliveries (kiosk) replaces the whole Company block; its details are never mixed
    with the dealership's, so a customer never gets another company's phone number."""
    if settings.delivery_company:
        return {"company": settings.delivery_company, "phone": settings.delivery_phone or None,
                "email": settings.delivery_email or None, "address": settings.delivery_address or None,
                "source": "delivery", "org_no": org_no(settings.delivery_org_no),
                # The company running Carbonara stores the data for the other company.
                "operator": settings.privacy_company if settings.privacy_company != settings.delivery_company else None}
    return {"company": settings.privacy_company, "phone": settings.privacy_contact or None,
            "email": settings.privacy_email or None, "address": settings.privacy_address or None,
            "source": "company", "org_no": org_no(settings.privacy_org_no)}


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
    work_order_id: Optional[int] = None   # the car was picked from today's booked cars (0.52.0)
    # A car not in the customer register (0.60.3): the legal owner's address; the person delivering may be someone else.
    owner_last_name: Optional[str] = Field(None, max_length=80)   # joined with customer_name (then the first name)
    owner_address: Optional[str] = Field(None, max_length=160)
    owner_postal_code: Optional[str] = Field(None, max_length=10)
    owner_city: Optional[str] = Field(None, max_length=80)
    not_owner: bool = False
    contact_name: Optional[str] = Field(None, max_length=60)


# Work orders for a car in the customer register, not arrived yet, shown on the kiosk as the registration number only
# (0.54.2, the user's rule) so the customer can pick their car; a tap then fills in the owner's name and phone
# (`booked_contact`, one car at a time, so the list itself never carries them). Shown from 07:00 the working
# day before the appointment (0.53.1, the user's rule: customers often deliver the evening before; a Monday appointment
# shows from Friday 07:00) until the end of the appointment day (Oslo time).
BOOKED_SQL = """
    SELECT w.id, cc.registration_number, w.customer_car_id,
           c.name AS customer_name, c.phone AS customer_phone
      FROM work_orders w JOIN customer_cars cc ON cc.id = w.customer_car_id
      LEFT JOIN customers c ON c.id = w.customer_id
      CROSS JOIN LATERAL (SELECT (w.planned_at AT TIME ZONE 'Europe/Oslo')::date AS d,
                                 now() AT TIME ZONE 'Europe/Oslo' AS n) t
     WHERE w.status IN ('open', 'in_progress') AND w.arrived_at IS NULL AND cc.registration_number IS NOT NULL
       AND t.d >= t.n::date
       AND t.n >= (t.d - CASE extract(isodow FROM t.d) WHEN 1 THEN 3 WHEN 7 THEN 2 ELSE 1 END) + time '07:00'"""


@kiosk_router.get("/booked")
def booked_today(_who=Depends(require_kiosk_or_staff), conn=Depends(get_conn)):
    """Booked cars for the kiosk (from 07:00 the working day before): registration number only."""
    rows = conn.execute(BOOKED_SQL + " ORDER BY w.planned_at, cc.registration_number").fetchall()
    return [{"id": r["id"], "registration_number": r["registration_number"]} for r in rows]


@kiosk_router.get("/booked/{work_order_id}/contact")
def booked_contact(work_order_id: int, _who=Depends(require_kiosk_or_staff), conn=Depends(get_conn)):
    """The owner's name and phone for one booked car, to fill in the form when the customer taps it."""
    r = conn.execute(BOOKED_SQL + " AND w.id = %s", (work_order_id,)).fetchone()
    if not r:
        raise not_found("Booking")
    return {"name": r["customer_name"], "phone": r["customer_phone"]}


@kiosk_router.get("/known")
def known_car(reg: str = "", _who=Depends(require_kiosk_or_staff), conn=Depends(get_conn)):
    """Is this registration number in the workshop's customer register? Yes / no only (0.60.3): an unknown car asks
    for its legal owner's name and address on the kiosk."""
    r = _clean_reg(reg)
    if not 2 <= len(r) <= 8:
        return {"known": None}
    return {"known": bool(conn.execute("SELECT 1 FROM customer_cars WHERE registration_number = %s LIMIT 1",
                                       (r,)).fetchone())}


@kiosk_router.get("/config")
def kiosk_config(request: Request, response: Response, who=Depends(require_kiosk_or_staff), conn=Depends(get_conn)):
    """Everything the form needs: maps, key places, tick boxes, privacy contact."""
    if who["kiosk"]:  # a tablet left on for months keeps its kiosk cookie
        _set_kiosk_cookie(request, response, request.cookies[auth.KIOSK_COOKIE])
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
def create_delivery(body: DeliveryIn, tasks: BackgroundTasks, who=Depends(require_kiosk_or_staff),
                    conn=Depends(get_conn)):
    reg = _clean_reg(body.registration_number)
    if not 2 <= len(reg) <= 8:
        raise bad_request("Registration number: 2–8 letters and digits")
    # The workshop's own register (0.53.0): never the sales company's stock (vehicles).
    car = conn.execute("SELECT id FROM customer_cars WHERE registration_number = %s ORDER BY id DESC LIMIT 1",
                       (reg,)).fetchone()
    name = cap_name(body.customer_name)
    owner = {"owner_address": None, "owner_postal_code": None, "owner_city": None, "not_owner": False,
             "contact_name": None}
    if not car:
        # 0.60.3 (the user's request): a car we don't know yet: the legal owner's full name and address are needed;
        # the phone can be anyone's, and someone delivering for the owner gives their first name.
        last = cap_name(body.owner_last_name or "")
        if not name or not last:
            raise bad_request("Fill in the owner's first and last name")
        name = f"{name} {last}"
        address = " ".join((body.owner_address or "").split())
        postal = "".join(ch for ch in (body.owner_postal_code or "") if ch.isdigit())
        city = cap_name(body.owner_city or "")
        if not address or not city:
            raise bad_request("Fill in the owner's address")
        if len(postal) != 4:
            raise bad_request("Postal code: 4 digits")
        contact = cap_name(body.contact_name or "") if body.not_owner else ""
        if body.not_owner and not contact:
            raise bad_request("Fill in your first name")
        owner = {"owner_address": address[:160], "owner_postal_code": postal, "owner_city": city[:80],
                 "not_owner": body.not_owner, "contact_name": contact[:60] or None}
    elif body.owner_last_name:   # the form asked for the owner after all (the car was added meanwhile): keep the full name
        name = f"{name} {cap_name(body.owner_last_name)}"
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

    # A car picked from today's booked cars: tied to its work order only while the reg. no. still matches
    # (the customer may have picked the wrong one and typed their own).
    booked = None
    if body.work_order_id:
        booked = conn.execute(BOOKED_SQL + " AND w.id = %s FOR UPDATE OF w", (body.work_order_id,)).fetchone()
        if booked and booked["registration_number"] != reg:
            booked = None
    if not booked:  # not tapped in the list, but the typed reg. no. is a booked car (0.53.1)
        booked = conn.execute(BOOKED_SQL + " AND cc.registration_number = %s ORDER BY w.planned_at LIMIT 1 FOR UPDATE OF w",
                              (reg,)).fetchone()
    row = conn.execute(
        """INSERT INTO car_deliveries (registration_number, customer_car_id, customer_name, customer_phone, map_id,
                                       pin_x, pin_y, key_place, checks, message, kiosk_id, work_order_id,
                                       owner_address, owner_postal_code, owner_city, not_owner, contact_name)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id, created_at""",
        (reg, car["id"] if car else None, name, phone, map_id, pin_x, pin_y,
         Jsonb(key_place) if key_place else None, Jsonb(checks), message,
         who["kiosk"]["id"] if who["kiosk"] else None, booked["id"] if booked else None,
         owner["owner_address"], owner["owner_postal_code"], owner["owner_city"], owner["not_owner"],
         owner["contact_name"]),
    ).fetchone()
    if car:  # the car's history in the register gets the delivery, never the customer's details
        _register_event(conn, car["id"], row["id"])
    if booked:  # the planner shows the car as arrived
        conn.execute("UPDATE work_orders SET arrived_at = now() WHERE id = %s", (booked["id"],))
        conn.execute("INSERT INTO work_order_events (work_order_id, kind, data) VALUES (%s, 'arrived', %s)",
                     (booked["id"], Jsonb({"delivery_id": row["id"], "kiosk": True})))
    # VIN, EU-kontroll (and later the owner's name) from Statens vegvesen. The task runs
    # after this request has committed, so the row exists.
    tasks.add_task(lookup_in_background, row["id"], reg, name)
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


@router.post("/deliveries/{delivery_id}/to-register", status_code=201)
def delivery_to_register(delivery_id: int, request: Request, conn=Depends(get_conn)):
    """A delivered car not in the customer register yet (0.60.4): add it, with the owner typed on the kiosk (an existing
    customer with the same name and phone or address is used instead of a second one). Then a work order can be made."""
    from . import customers   # customers imports nothing from here
    staff = request.state.staff
    if not customers._access(staff):
        raise HTTPException(403, "Only staff with access to the customer register can do this")
    d = conn.execute("SELECT * FROM car_deliveries WHERE id = %s FOR UPDATE", (delivery_id,)).fetchone()
    if not d:
        raise not_found("Delivery")
    if d["customer_car_id"]:
        raise conflict("The car is already in the customer register")
    sid = staff["id"]
    car = conn.execute("SELECT id FROM customer_cars WHERE registration_number = %s ORDER BY id DESC LIMIT 1",
                       (d["registration_number"],)).fetchone()
    customer_id = None
    if not car:
        words = (d["customer_name"] or "").split()
        if len(words) < 2:
            raise bad_request("The delivery needs the owner's first and last name")
        first, last = " ".join(words[:-1]), words[-1]
        # The phone belongs to the owner only when the owner delivered the car.
        phone = None if d["not_owner"] else d["customer_phone"]
        same = conn.execute(
            """SELECT id FROM customers WHERE kind = 'private' AND lower(name) = lower(%s)
                 AND ((%s::text IS NOT NULL AND phone = %s) OR (%s::text IS NOT NULL AND lower(address) = lower(%s)))
                ORDER BY id LIMIT 1""",
            (d["customer_name"], phone, phone, d["owner_address"], d["owner_address"])).fetchone()
        if same:
            customer_id = same["id"]
        else:
            f = customers._customer_fields(customers.CustomerIn(
                kind="private", first_name=first[:60], last_name=last[:60], phone=phone,
                address=(d["owner_address"] or "")[:120] or None, postal_code=d["owner_postal_code"],
                city=(d["owner_city"] or "")[:60] or None))
            customer_id = customers.create_customer(conn, f, sid)["id"]
        vin = d["svv_vin"] if d["svv_vin"] and not conn.execute(
            "SELECT 1 FROM customer_cars WHERE vin = %s", (d["svv_vin"],)).fetchone() else None
        car = conn.execute(
            """INSERT INTO customer_cars (registration_number, vin, make, model, created_by)
               VALUES (%s, %s, %s, %s, %s) RETURNING id""",
            (d["registration_number"], vin, d["svv_make"], d["svv_model"], sid)).fetchone()
        customers.event(conn, "car_created", sid, car_id=car["id"], data={"delivery_id": delivery_id})
        customers.set_owner(conn, car["id"], customer_id, sid)
        customers.refresh_registry(conn, car["id"])   # never blocks: a failure is kept as registry_error
    conn.execute("UPDATE car_deliveries SET customer_car_id = %s WHERE id = %s", (car["id"], delivery_id))
    _register_event(conn, car["id"], delivery_id)
    return {"customer_car_id": car["id"], "customer_id": customer_id}


class DeliveryWorkOrderIn(BaseModel):
    work_order_id: int


@router.post("/deliveries/{delivery_id}/work-order")
def delivery_work_order(delivery_id: int, body: DeliveryWorkOrderIn, request: Request, conn=Depends(get_conn)):
    """A work order made from a delivery (0.60.4): tied to it, and the car counts as arrived (it is here)."""
    from .work_orders import _access as wo_access
    staff = request.state.staff
    if not wo_access(staff):
        raise HTTPException(403, "Only staff with access to work orders can do this")
    d = conn.execute("SELECT id, customer_car_id, work_order_id FROM car_deliveries WHERE id = %s FOR UPDATE",
                     (delivery_id,)).fetchone()
    if not d:
        raise not_found("Delivery")
    w = conn.execute("SELECT id, customer_car_id, arrived_at FROM work_orders WHERE id = %s FOR UPDATE",
                     (body.work_order_id,)).fetchone()
    if not w or not d["customer_car_id"] or w["customer_car_id"] != d["customer_car_id"]:
        raise bad_request("The work order isn't for this car")
    if not d["work_order_id"]:
        conn.execute("UPDATE car_deliveries SET work_order_id = %s WHERE id = %s", (w["id"], delivery_id))
    if not w["arrived_at"]:
        conn.execute("UPDATE work_orders SET arrived_at = now() WHERE id = %s", (w["id"],))
        conn.execute("INSERT INTO work_order_events (work_order_id, kind, data, created_by) VALUES (%s, 'arrived', %s, %s)",
                     (w["id"], Jsonb({"delivery_id": delivery_id}), staff["id"]))
    return {"ok": True}


@router.post("/deliveries/{delivery_id}/receive")
def receive_delivery(delivery_id: int, request: Request, conn=Depends(get_conn)):
    """Staff have the car and the key. Received by = the logged-in staff member."""
    staff_id = request.state.staff["id"]
    d = conn.execute("SELECT id, vehicle_id, customer_car_id, received_at FROM car_deliveries WHERE id = %s FOR UPDATE",
                     (delivery_id,)).fetchone()
    if not d:
        raise not_found("Delivery")
    if d["received_at"]:
        raise conflict("This delivery is already received")
    conn.execute("UPDATE car_deliveries SET received_at = now(), received_by = %s WHERE id = %s",
                 (staff_id, delivery_id))
    if d["customer_car_id"]:
        conn.execute("INSERT INTO register_events (car_id, kind, data, created_by) "
                     "VALUES (%s, 'customer_delivery_received', %s, %s)",
                     (d["customer_car_id"], Jsonb({"delivery_id": delivery_id}), staff_id))
    elif d["vehicle_id"]:  # a delivery made before 0.53.0, linked to the car stock
        log_event(conn, d["vehicle_id"], "customer_delivery_received", staff_id=staff_id,
                  data={"delivery_id": delivery_id})
    return {"ok": True}


@router.post("/deliveries/{delivery_id}/registry")
def lookup_delivery(delivery_id: int, conn=Depends(get_conn)):
    """'↻ Look up again' at Statens vegvesen (e.g. after an error)."""
    d = conn.execute("SELECT registration_number, customer_name FROM car_deliveries WHERE id = %s",
                     (delivery_id,)).fetchone()
    if not d:
        raise not_found("Delivery")
    _save_lookup(conn, delivery_id, _registry_lookup(d["registration_number"], d["customer_name"]))
    return conn.execute(DELIVERY_SELECT + " WHERE d.id = %(id)s",
                        {"trash_days": settings.trash_days, "id": delivery_id}).fetchone()


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
    language: str = Field("no", pattern="^(en|no)$")


class KioskLanguageIn(BaseModel):
    language: str = Field(pattern="^(en|no)$")


@router.get("/kiosk-devices")
def list_kiosks(conn=Depends(get_conn), _admin=Depends(require_admin)):
    return conn.execute(
        """SELECT k.id, k.name, k.language, k.created_at, k.last_seen_at, k.revoked_at, c.name AS created_by_name
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
    _set_kiosk_cookie(request, response, auth.new_kiosk(conn, name, admin["id"], body.language))
    auth.end_session(conn, request.cookies.get(auth.COOKIE))
    response.delete_cookie(auth.COOKIE, path="/")
    log.info("staff %s made device '%s' a delivery kiosk", admin["id"], name)
    return {"ok": True}


@router.put("/kiosk-devices/{kiosk_id}/language", status_code=204)
def kiosk_language(kiosk_id: int, body: KioskLanguageIn, conn=Depends(get_conn), admin=Depends(require_admin)):
    """The tablet's language; the tablet itself has no switch (it picks this up within a minute)."""
    row = conn.execute("UPDATE kiosk_devices SET language = %s WHERE id = %s AND revoked_at IS NULL RETURNING id",
                       (body.language, kiosk_id)).fetchone()
    if not row:
        raise not_found("Kiosk")
    log.info("staff %s set kiosk %s language to %s", admin["id"], kiosk_id, body.language)


@router.delete("/kiosk-devices/{kiosk_id}", status_code=204)
def revoke_kiosk(kiosk_id: int, conn=Depends(get_conn), admin=Depends(require_admin)):
    """The tablet stops showing the form (e.g. lost, or replaced)."""
    row = conn.execute("UPDATE kiosk_devices SET revoked_at = now(), revoked_by = %s "
                       "WHERE id = %s AND revoked_at IS NULL RETURNING id", (admin["id"], kiosk_id)).fetchone()
    if not row:
        raise not_found("Kiosk")


# Stopped tablets are deleted for good this many days after they were stopped (sync_worker).
KIOSK_KEEP_STOPPED_DAYS = 30


def delete_kiosk(conn, kiosk_id: int) -> bool:
    """Delete a tablet's record. Deliveries sent from it are kept; they just lose the tablet's name.
    Its cookie stops working at once (the token hash is gone)."""
    conn.execute("UPDATE car_deliveries SET kiosk_id = NULL WHERE kiosk_id = %s", (kiosk_id,))
    return conn.execute("DELETE FROM kiosk_devices WHERE id = %s RETURNING id", (kiosk_id,)).fetchone() is not None


def purge_stopped_kiosks(conn) -> int:
    rows = conn.execute("SELECT id FROM kiosk_devices WHERE revoked_at < now() - make_interval(days => %s)",
                        (KIOSK_KEEP_STOPPED_DAYS,)).fetchall()
    for r in rows:
        delete_kiosk(conn, r["id"])
    return len(rows)


@router.delete("/kiosk-devices/{kiosk_id}/record", status_code=204)
def remove_kiosk_record(kiosk_id: int, conn=Depends(get_conn), admin=Depends(require_superadmin)):
    """System admins: delete a tablet from the list now (an active one stops showing the form too)."""
    if not delete_kiosk(conn, kiosk_id):
        raise not_found("Kiosk")
    log.info("staff %s deleted kiosk %s", admin["id"], kiosk_id)
