"""Customer register (0.48.0): customers with a customer number, their cars and who owned each car when.

Kept apart from the car database (`vehicles`, the dealer's stock): a car there can be copied into the register when
the customer agrees (`transfer`, consent logged with who and when). The register can belong to another company than
the car stock (System → Customer register). Customers are personal data:
- only admins and people whose team has Customers or Parts can read or change them (`_access`, checked here);
- history (`register_events`) holds ids only, never names, phones or addresses;
- customers with no activity for retention_years are deleted by the worker (`purge_inactive`).
"""
import json
import logging
import re
import time
from decimal import Decimal
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import vegvesen, vinlib
from ..auth import require_admin, require_staff
from ..common import bad_request, cap_name, clean_phone, conflict, log_event, not_found, org_no
from ..config import settings
from ..db import get_conn
from .rentals import registry_values

log = logging.getLogger(__name__)
router = APIRouter(tags=["customers"])

LIST_LIMIT = 100


def _access(staff: dict) -> bool:
    return bool(staff.get("is_admin") or {"customers", "parts"} & set(staff.get("menu") or []))


def require_register(staff: dict = Depends(require_staff)) -> dict:
    if not _access(staff):
        raise HTTPException(403, "Only staff with access to the customer register can do this")
    return staff


def event(conn, kind: str, staff_id, *, customer_id=None, car_id=None, order_id=None, data=None) -> None:
    """A history entry (ids only in data, never personal details)."""
    conn.execute(
        """INSERT INTO register_events (customer_id, car_id, order_id, kind, data, created_by)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        (customer_id, car_id, order_id, kind,
         Jsonb(data, dumps=lambda o: json.dumps(o, default=str)) if data else None, staff_id))


def touch(conn, customer_id) -> None:
    """Something happened for this customer (retention counts from the last activity)."""
    if customer_id:
        conn.execute("UPDATE customers SET last_activity_at = now() WHERE id = %s", (customer_id,))


def company() -> dict:
    """Who the register belongs to (privacy notice, consent text). Never mixes the two contact blocks."""
    if settings.customers_company:
        return {"company": settings.customers_company, "phone": settings.customers_phone or None,
                "email": settings.customers_email or None, "address": settings.customers_address or None,
                "source": "customers", "org_no": org_no(settings.customers_org_no),
                "operator": settings.privacy_company if settings.privacy_company != settings.customers_company else None}
    return {"company": settings.privacy_company, "phone": settings.privacy_contact or None,
            "email": settings.privacy_email or None, "address": settings.privacy_address or None, "source": "company",
            "org_no": org_no(settings.privacy_org_no)}


def _text(value: Optional[str], n: int) -> Optional[str]:
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    return value[:n] or None


def _reg(value: Optional[str]) -> Optional[str]:
    reg = vegvesen.normalize_regnr(value or "") if value else ""
    if reg and not 2 <= len(reg) <= 8:
        raise bad_request("Registration number is not valid")
    return reg or None


def _vin(value: Optional[str]) -> Optional[str]:
    vin = re.sub(r"[\s\-.]", "", value or "").upper()
    if vin and not re.fullmatch(r"[A-HJ-NPR-Z0-9]{17}", vin):
        raise bad_request("The VIN must be 17 letters and digits (never I, O or Q)")
    return vin or None


# --------------------------------------------------------------------------- #
# customers
# --------------------------------------------------------------------------- #

class CustomerIn(BaseModel):
    kind: Literal["private", "company"] = "private"
    first_name: Optional[str] = Field(None, max_length=60)
    last_name: Optional[str] = Field(None, max_length=60)
    company_name: Optional[str] = Field(None, max_length=120)
    org_no: Optional[str] = Field(None, max_length=20)
    phone: Optional[str] = Field(None, max_length=30)
    email: Optional[str] = Field(None, max_length=120)
    address: Optional[str] = Field(None, max_length=120)
    postal_code: Optional[str] = Field(None, max_length=10)
    city: Optional[str] = Field(None, max_length=60)
    note: Optional[str] = Field(None, max_length=1000)
    # 0.63.0: the customer's standing discount in percent (None = none). Left out = unchanged on edit.
    discount_parts: Optional[Decimal] = Field(None, ge=0, le=100)
    discount_labour: Optional[Decimal] = Field(None, ge=0, le=100)


def _customer_fields(body: CustomerIn) -> dict:
    f = {
        "kind": body.kind,
        "first_name": cap_name(_text(body.first_name, 60) or "") or None,
        "last_name": cap_name(_text(body.last_name, 60) or "") or None,
        "company_name": cap_name(_text(body.company_name, 120) or "") or None,
        "org_no": re.sub(r"\D", "", body.org_no or "") or None,
        "phone": clean_phone(body.phone) if (body.phone or "").strip() else None,
        "email": _text(body.email, 120),
        "address": _text(body.address, 120),
        "postal_code": _text(body.postal_code, 10),
        "city": _text(body.city, 60),
        "note": (body.note or "").strip()[:1000] or None,
    }
    for k in ("discount_parts", "discount_labour"):   # only when sent (other forms that make customers leave them out)
        if k in body.model_fields_set:
            v = getattr(body, k)
            f[k] = v.quantize(Decimal("0.01")) if v else None
    if f["email"] and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", f["email"]):
        raise bad_request("The e-mail address is not valid")
    if f["org_no"] and len(f["org_no"]) != 9:
        raise bad_request("The organisation number must be 9 digits")
    if body.kind == "company":
        if not f["company_name"]:
            raise bad_request("A company customer needs the company name")
        f["name"] = f["company_name"]
    else:
        if not (f["first_name"] and f["last_name"]):
            raise bad_request("A private customer needs first and last name")
        f["name"] = f"{f['first_name']} {f['last_name']}"
        f["company_name"] = f["org_no"] = None
    return f


def _next_number(conn) -> int:
    conn.execute("SELECT pg_advisory_xact_lock(hashtext('customer_no'))")  # two new customers never get one number
    row = conn.execute("SELECT max(customer_no) AS n FROM customers").fetchone()
    return max((row["n"] or 0) + 1, settings.customer_number_start)


def create_customer(conn, f: dict, staff_id) -> dict:
    no = _next_number(conn)
    cols = list(f)
    row = conn.execute(
        f"""INSERT INTO customers (customer_no, {', '.join(cols)}, created_by, updated_by)
            VALUES (%s, {', '.join(['%s'] * len(cols))}, %s, %s) RETURNING id, customer_no, name""",
        (no, *f.values(), staff_id, staff_id)).fetchone()
    event(conn, "customer_created", staff_id, customer_id=row["id"])
    return row


CURRENT_CARS = """(SELECT coalesce(json_agg(json_build_object('id', cc.id, 'registration_number', cc.registration_number,
                          'make', cc.make, 'model', cc.model) ORDER BY o.started_at), '[]'::json)
                     FROM car_ownerships o JOIN customer_cars cc ON cc.id = o.car_id
                    WHERE o.customer_id = c.id AND o.ended_at IS NULL)"""


@router.get("/customers")
def list_customers(q: str = "", conn=Depends(get_conn), _staff=Depends(require_register)):
    where, params = [], []
    for tok in q.split()[:5]:
        like = "%" + re.sub(r"([%_\\])", r"\\\1", tok) + "%"
        digits = re.sub(r"\D", "", tok)
        key = re.sub(r"[^A-Za-z0-9]", "", tok).upper()
        conds = ["c.name ILIKE %s", "c.email ILIKE %s", "c.city ILIKE %s", "c.address ILIKE %s"]
        params += [like] * 4
        if digits:
            conds += ["c.customer_no::text = %s", "regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') LIKE %s",
                      "c.org_no LIKE %s"]
            params += [digits, f"%{digits}%", f"%{digits}%"]
        if key:
            conds.append("""EXISTS (SELECT 1 FROM car_ownerships o JOIN customer_cars cc ON cc.id = o.car_id
                                     WHERE o.customer_id = c.id AND o.ended_at IS NULL
                                       AND (cc.registration_number LIKE %s OR cc.vin LIKE %s))""")
            params += [f"%{key}%", f"%{key}%"]
        where.append("(" + " OR ".join(conds) + ")")
    rows = conn.execute(
        f"""SELECT c.id, c.customer_no, c.kind, c.name, c.phone, c.email, c.city, {CURRENT_CARS} AS cars,
                   count(*) OVER () AS total
              FROM customers c {('WHERE ' + ' AND '.join(where)) if where else ''}
             ORDER BY c.updated_at DESC LIMIT {LIST_LIMIT}""", params).fetchall()
    return {"customers": rows, "total": rows[0]["total"] if rows else 0, "limit": LIST_LIMIT, "company": company(),
            "retention_years": settings.retention_years}


@router.post("/customers", status_code=201)
def add_customer(body: CustomerIn, conn=Depends(get_conn), staff=Depends(require_register)):
    return create_customer(conn, _customer_fields(body), staff["id"])


def _customer(conn, customer_id: int, lock: bool = False) -> dict:
    row = conn.execute("SELECT * FROM customers WHERE id = %s" + (" FOR UPDATE" if lock else ""),
                       (customer_id,)).fetchone()
    if not row:
        raise not_found("Customer")
    return row


EVENTS_SELECT = """SELECT e.id, e.kind, e.data, e.created_at, e.customer_id, e.car_id, e.order_id, s.name AS staff_name,
                          po.order_no
                     FROM register_events e LEFT JOIN staff s ON s.id = e.created_by
                     LEFT JOIN parts_orders po ON po.id = e.order_id"""

ORDERS_SELECT = """SELECT o.id, o.order_no, o.status, o.created_at, o.done_at, o.reference, o.customer_id, o.car_id,
                          c.name AS customer_name, c.customer_no, cc.registration_number, cc.make, cc.model,
                          o.work_order_id, (SELECT w.number FROM work_orders w WHERE w.id = o.work_order_id)
                              AS work_order_number, o.invoice_id,
                          (SELECT i.number FROM invoices i WHERE i.id = o.invoice_id) AS invoice_number,
                          (SELECT count(*) FROM parts_order_lines l WHERE l.order_id = o.id) AS lines,
                          (SELECT count(*) FROM parts_order_lines l WHERE l.order_id = o.id AND l.supply = 'order')
                              AS to_order,
                          -- 0.63.0: with the line / customer discount and the order's total discount (an amount is
                          -- spread like the invoice spreads it over the VAT rates)
                          (SELECT CASE o.total_discount_kind
                                    WHEN 'percent' THEN t.inc * greatest(0, 1 - o.total_discount / 100)
                                    WHEN 'amount' THEN t.inc * greatest(0, 1 - o.total_discount / nullif(t.ex, 0))
                                    ELSE t.inc END
                             FROM (SELECT coalesce(sum(x.ex * (1 + x.vat_rate / 100)), 0) AS inc, coalesce(sum(x.ex), 0) AS ex
                                     FROM (SELECT l.quantity * coalesce(l.unit_price, 0)
                                                  * (100 - coalesce(l.discount, c.discount_parts, 0)) / 100 AS ex, l.vat_rate
                                             FROM parts_order_lines l WHERE l.order_id = o.id) x) t) AS total_inc
                     FROM parts_orders o LEFT JOIN customers c ON c.id = o.customer_id
                     LEFT JOIN customer_cars cc ON cc.id = o.car_id"""


def _names(conn, events: list[dict]) -> list[dict]:
    """Owner-change events carry customer ids; add today's names (a deleted customer has none)."""
    ids = {v for e in events for k, v in (e["data"] or {}).items() if k.endswith("customer_id") and v}
    if ids:
        names = {r["id"]: f"{r['name']} ({r['customer_no']})" for r in conn.execute(
            "SELECT id, name, customer_no FROM customers WHERE id = ANY(%s)", (list(ids),)).fetchall()}
        for e in events:
            d = e["data"] or {}
            e["names"] = {k: names.get(v) for k, v in d.items() if k.endswith("customer_id") and v}
    return events


@router.get("/customers/{customer_id}")
def get_customer(customer_id: int, conn=Depends(get_conn), _staff=Depends(require_register)):
    c = _customer(conn, customer_id)
    cars = conn.execute(
        """SELECT cc.*, o.started_at AS owned_from, o.ended_at AS owned_until
             FROM car_ownerships o JOIN customer_cars cc ON cc.id = o.car_id
            WHERE o.customer_id = %s ORDER BY (o.ended_at IS NULL) DESC, o.started_at DESC""", (customer_id,)).fetchall()
    orders = conn.execute(ORDERS_SELECT + " WHERE o.customer_id = %s ORDER BY o.created_at DESC LIMIT 50",
                          (customer_id,)).fetchall()
    events = conn.execute(EVENTS_SELECT + """ WHERE e.customer_id = %s
                          OR e.order_id IN (SELECT id FROM parts_orders WHERE customer_id = %s)
                          ORDER BY e.created_at DESC LIMIT 100""", (customer_id, customer_id)).fetchall()
    return {**c, "cars": cars, "orders": orders, "events": _names(conn, events), "company": company(),
            "retention_years": settings.retention_years}


@router.put("/customers/{customer_id}")
def edit_customer(customer_id: int, body: CustomerIn, conn=Depends(get_conn), staff=Depends(require_register)):
    _customer(conn, customer_id, lock=True)
    f = _customer_fields(body)
    sets = ", ".join(f"{k} = %s" for k in f)
    conn.execute(f"UPDATE customers SET {sets}, updated_at = now(), updated_by = %s, last_activity_at = now() "
                 "WHERE id = %s", (*f.values(), staff["id"], customer_id))
    event(conn, "customer_updated", staff["id"], customer_id=customer_id)
    return _customer(conn, customer_id)


@router.delete("/customers/{customer_id}", status_code=204)
def delete_customer(customer_id: int, conn=Depends(get_conn), _admin=Depends(require_admin)):
    """Deleted for good (e.g. the customer asks). Their cars stay without this owner; orders stay without a customer."""
    _customer(conn, customer_id, lock=True)
    if conn.execute("SELECT 1 FROM parts_orders WHERE customer_id = %s AND status IN ('open', 'ordered', 'arrived')",
                    (customer_id,)).fetchone():
        raise conflict("The customer has open parts orders. Finish or cancel them first.")
    conn.execute("DELETE FROM customers WHERE id = %s", (customer_id,))


# --------------------------------------------------------------------------- #
# cars
# --------------------------------------------------------------------------- #

class CarIn(BaseModel):
    registration_number: Optional[str] = Field(None, max_length=12)
    vin: Optional[str] = Field(None, max_length=40)
    make: Optional[str] = Field(None, max_length=60)
    model: Optional[str] = Field(None, max_length=80)
    color: Optional[str] = Field(None, max_length=40)
    fuel_type: Optional[str] = Field(None, max_length=40)
    model_year: Optional[int] = Field(None, ge=1900, le=2100)
    first_registered: Optional[str] = Field(None, max_length=10)  # ignored since 0.59.1 (Statens vegvesen sets it)
    note: Optional[str] = Field(None, max_length=1000)
    chassis_checked: bool = False   # an older chassis number (not the 17-character VIN) was checked on the car


def _vin_or_chassis(body: CarIn, reg: Optional[str], keep: Optional[str] = None) -> tuple[Optional[str], bool]:
    """(VIN, older): a 17-character VIN, or an older car's chassis number that Statens vegvesen has for this reg. no.
    and a person checked on the car (0.54.0)."""
    raw = re.sub(r"[\s\-.]", "", body.vin or "").upper()
    if not raw or re.fullmatch(r"[A-HJ-NPR-Z0-9]{17}", raw):
        return raw or None, False
    if keep and raw == keep:  # an older chassis number already checked when it was saved
        return raw, True
    if not (vinlib.is_chassis_format(raw) and body.chassis_checked):
        return _vin(raw), False  # raises the usual VIN message
    try:
        vegvesen.verify_chassis(raw, reg or "")
    except ValueError as exc:
        raise bad_request(str(exc))
    return raw, True


def _car_fields(body: CarIn, keep: Optional[str] = None) -> dict:
    reg = _reg(body.registration_number)
    vin, older = _vin_or_chassis(body, reg, keep)
    f = {
        "registration_number": reg, "vin": vin, "vin_nonstandard": older,
        "make": _text(body.make, 60), "model": _text(body.model, 80), "color": _text(body.color, 40),
        "fuel_type": _text(body.fuel_type, 40), "model_year": body.model_year,
        # no first_registered: Statens vegvesen sets it (0.59.1, the user's rule: not changeable)
        "note": (body.note or "").strip()[:1000] or None,
    }
    if not (f["registration_number"] or f["vin"]):
        raise bad_request("The car needs a registration number or a VIN")
    return f


def _check_vin(conn, vin: Optional[str], exclude: Optional[int] = None) -> None:
    if vin and conn.execute("SELECT 1 FROM customer_cars WHERE vin = %s AND id <> %s", (vin, exclude or 0)).fetchone():
        raise conflict("A car with this VIN is already in the customer register")


def set_owner(conn, car_id: int, customer_id: Optional[int], staff_id) -> None:
    """End the current ownership and start a new one (None = no owner now). Logged on the car and both customers."""
    cur = conn.execute("SELECT id, customer_id FROM car_ownerships WHERE car_id = %s AND ended_at IS NULL FOR UPDATE",
                       (car_id,)).fetchone()
    old = cur["customer_id"] if cur else None
    if old == customer_id:
        return
    if cur:
        conn.execute("UPDATE car_ownerships SET ended_at = now(), ended_by = %s WHERE id = %s", (staff_id, cur["id"]))
    if customer_id:
        conn.execute("INSERT INTO car_ownerships (car_id, customer_id, started_by) VALUES (%s, %s, %s)",
                     (car_id, customer_id, staff_id))
    data = {"from_customer_id": old, "to_customer_id": customer_id}
    event(conn, "owner_changed", staff_id, car_id=car_id, data=data)
    for cid in {old, customer_id} - {None}:
        event(conn, "owner_changed", staff_id, customer_id=cid, data={**data, "car_id": car_id})
        touch(conn, cid)


@router.get("/customer-cars/lookup")
def lookup(reg: str, _staff=Depends(require_register)):
    """Statens vegvesen data for the car form (nothing is saved). `reg` is a registration number or a 17-character
    VIN (0.58.4, the user's request: the same field for both)."""
    if not vegvesen.is_configured():
        raise conflict("Statens vegvesen is not set up (API key on the System page)")
    vin = vinlib.normalize(reg)
    vin = vin if vinlib.is_valid_format(vin) else None
    try:
        v = registry_values(reg, vin=vin)
    except vegvesen.NotFound:
        raise not_found("VIN at Statens vegvesen" if vin else "Registration number at Statens vegvesen")
    except vegvesen.RegistryError as exc:
        raise HTTPException(502, f"Statens vegvesen: {exc}")
    return {"registration_number": v["registration_number"], "vin": v["vin"], "make": v["make"], "model": v["model"],
            "color": v["color"], "fuel_type": v["fuel"], "first_registered": v["first_registered"],
            **{k: v[k] for k in REGISTRY_ONLY}}


# Dates only Statens vegvesen sets (0.59.0, the user's request: "not changeable"): never in the car form, taken from
# the registry when a car is added or its reg. no. / VIN changes, with "Look up again" and by the worker.
REGISTRY_ONLY = ("first_registered_norway", "owner_since", "eu_control_due", "eu_control_last_approved")


def refresh_registry(conn, car_id: int) -> Optional[str]:
    """Update a register car from Statens vegvesen. Returns None when it worked, else the reason (also saved on the
    car as registry_error; earlier values are kept).
    - Looked up by VIN when the car has a 17-character VIN (a VIN never changes; 0.59.2, the user's rule), else by
      reg. no. (older chassis numbers); a VIN not found falls back to the reg. no.
    - The registration number follows Statens vegvesen (plates can be replaced, and a car added before it was
      registered gets its plate); a change is in the car's history.
    - Make, model, colour and fuel only fill gaps (staff edits win); the dates are always taken (not changeable)."""
    car = conn.execute("SELECT * FROM customer_cars WHERE id = %s FOR UPDATE", (car_id,)).fetchone()
    if not car or not vegvesen.is_configured():
        return "Statens vegvesen is not set up (API key on the System page)" if car else None
    vin = car["vin"] if car["vin"] and not car["vin_nonstandard"] and vinlib.is_valid_format(car["vin"]) else None
    if not (car["registration_number"] or vin):
        return None
    v, error = None, None
    for by_vin in ([True, False] if vin else [False]):
        if not by_vin and not car["registration_number"]:
            break
        try:
            v = registry_values(car["registration_number"] or "", vin=vin if by_vin else None)
            break
        except vegvesen.NotFound:
            error = "Not found at Statens vegvesen"
        except vegvesen.RegistryError as exc:
            error = str(exc)[:300]
            break
    if v is None:
        conn.execute("UPDATE customer_cars SET registry_checked_at = now(), registry_error = %s WHERE id = %s",
                     (error, car_id))
        return error
    reg = v["registration_number"] if (vin and v["vin"] == vin) else None  # only from a lookup of this very car
    new_vin = v["vin"] if not car["vin"] and v["vin"] and vinlib.is_valid_format(v["vin"]) else None
    if new_vin and conn.execute("SELECT 1 FROM customer_cars WHERE vin = %s AND id <> %s", (new_vin, car_id)).fetchone():
        new_vin = None  # that VIN is on another car in the register (one car, one VIN): left for staff to sort out
    conn.execute(
        """UPDATE customer_cars SET first_registered_norway = %s, owner_since = %s, eu_control_due = %s,
                  eu_control_last_approved = %s, first_registered = coalesce(%s, first_registered),
                  registration_number = coalesce(%s, registration_number),
                  vin = coalesce(vin, %s), make = coalesce(make, %s), model = coalesce(model, %s),
                  color = coalesce(color, %s), fuel_type = coalesce(fuel_type, %s),
                  registry_checked_at = now(), registry_error = NULL WHERE id = %s""",
        (*[v[k] for k in REGISTRY_ONLY], v["first_registered"], reg, new_vin,
         v["make"], v["model"], v["color"], v["fuel"], car_id))
    if reg and reg != car["registration_number"]:
        event(conn, "registration_number_changed", None, car_id=car_id,
              data={"from": car["registration_number"], "to": reg, "source": "statens_vegvesen"})
    return None
    conn.execute("UPDATE customer_cars SET registry_checked_at = now(), registry_error = %s WHERE id = %s",
                 (error, car_id))
    return error


def refresh_due_customer_cars(conn_factory) -> int:
    """Worker: re-check register cars every vegvesen_sync_days (EU-kontroll moves on after a car has passed, and the
    owner date changes with a new owner). At most 100 a day; conn_factory() gives a new connection per car."""
    if not vegvesen.is_configured():
        return 0
    with conn_factory() as conn:
        ids = [r["id"] for r in conn.execute(
            """SELECT id FROM customer_cars
                WHERE registry_checked_at IS NULL OR registry_checked_at < now() - make_interval(days => %s)
                ORDER BY registry_checked_at NULLS FIRST LIMIT 100""", (settings.vegvesen_sync_days,)).fetchall()]
    for car_id in ids:
        try:
            with conn_factory() as conn:
                refresh_registry(conn, car_id)
        except Exception:  # e.g. deleted meanwhile: carry on with the next car
            log.exception("customer car %s: registry refresh failed", car_id)
            continue
        time.sleep(settings.vegvesen_call_interval_s)
    return len(ids)


@router.post("/customer-cars/{car_id}/registry")
def registry_again(car_id: int, conn=Depends(get_conn), staff=Depends(require_register)):
    """"↻ Look up again" on the car page."""
    _car(conn, car_id)
    error = refresh_registry(conn, car_id)
    return {**_car(conn, car_id), "registry_result": error}


def _find(conn, reg: str, vin: str) -> Optional[dict]:
    """A car already in the register with this reg. no or VIN, with its current owner."""
    reg = _reg(reg) if reg.strip() else None
    vin = re.sub(r"[\s\-.]", "", vin).upper() or None  # any chassis number (older cars too) is looked for as typed
    if not (reg or vin):
        return None
    return conn.execute(
        """SELECT cc.id, cc.registration_number, cc.vin, cc.make, cc.model, c.id AS owner_id, c.name AS owner_name,
                  c.customer_no AS owner_no
             FROM customer_cars cc
             LEFT JOIN car_ownerships o ON o.car_id = cc.id AND o.ended_at IS NULL
             LEFT JOIN customers c ON c.id = o.customer_id
            WHERE (%s::text IS NOT NULL AND cc.vin = %s) OR (%s::text IS NOT NULL AND cc.registration_number = %s)
            ORDER BY (cc.vin = %s) DESC NULLS LAST LIMIT 1""", (vin, vin, reg, reg, vin)).fetchone()


@router.get("/customer-cars")
def list_cars(q: str = "", conn=Depends(get_conn), _staff=Depends(require_register)):
    """The register's cars (0.53.0, "Cars" on the Customers page): reg. no., VIN, make / model, owner's name or no."""
    where, params = [], []
    for tok in q.split()[:5]:
        like = "%" + re.sub(r"([%_\\])", r"\\\1", tok) + "%"
        key = re.sub(r"[^A-Za-z0-9]", "", tok).upper()
        digits = re.sub(r"\D", "", tok)
        conds = ["cc.make ILIKE %s", "cc.model ILIKE %s", "c.name ILIKE %s"]
        params += [like] * 3
        if key:
            conds += ["cc.registration_number LIKE %s", "cc.vin LIKE %s"]
            params += [f"%{key}%", f"%{key}%"]
        if digits:
            conds.append("c.customer_no::text = %s")
            params.append(digits)
        where.append("(" + " OR ".join(conds) + ")")
    rows = conn.execute(
        f"""SELECT cc.id, cc.registration_number, cc.vin, cc.make, cc.model, cc.model_year, cc.vehicle_id, cc.eu_control_due,
                   c.id AS owner_id, c.name AS owner_name, c.customer_no AS owner_no,
                   (SELECT count(*) FROM work_orders w WHERE w.customer_car_id = cc.id
                       AND w.status IN ('open', 'in_progress')) AS open_work_orders,
                   count(*) OVER () AS total
              FROM customer_cars cc
              LEFT JOIN car_ownerships o ON o.car_id = cc.id AND o.ended_at IS NULL
              LEFT JOIN customers c ON c.id = o.customer_id
              {('WHERE ' + ' AND '.join(where)) if where else ''}
             ORDER BY cc.updated_at DESC LIMIT {LIST_LIMIT}""", params).fetchall()
    return {"cars": rows, "total": rows[0]["total"] if rows else 0, "limit": LIST_LIMIT}


@router.get("/customer-cars/find")
def find_car(reg: str = "", vin: str = "", conn=Depends(get_conn), _staff=Depends(require_register)):
    """Before adding a car: is it in the register already, and who owns it."""
    return _find(conn, reg, vin)


@router.post("/customers/{customer_id}/cars", status_code=201)
def add_car(customer_id: int, body: CarIn, conn=Depends(get_conn), staff=Depends(require_register)):
    _customer(conn, customer_id, lock=True)
    f = _car_fields(body)
    _check_vin(conn, f["vin"])
    row = conn.execute(
        f"""INSERT INTO customer_cars ({', '.join(f)}, created_by) VALUES ({', '.join(['%s'] * len(f))}, %s)
            RETURNING id""", (*f.values(), staff["id"])).fetchone()
    event(conn, "car_created", staff["id"], car_id=row["id"])
    set_owner(conn, row["id"], customer_id, staff["id"])
    refresh_registry(conn, row["id"])  # never blocks adding: a failure is kept as registry_error
    return {"id": row["id"]}


def _car(conn, car_id: int) -> dict:
    row = conn.execute("SELECT * FROM customer_cars WHERE id = %s", (car_id,)).fetchone()
    if not row:
        raise not_found("Car")
    return row


@router.get("/customer-cars/{car_id}")
def get_car(car_id: int, conn=Depends(get_conn), _staff=Depends(require_register)):
    car = _car(conn, car_id)
    owners = conn.execute(
        """SELECT o.id, o.customer_id, o.started_at, o.ended_at, c.name, c.customer_no, c.phone
             FROM car_ownerships o JOIN customers c ON c.id = o.customer_id
            WHERE o.car_id = %s ORDER BY (o.ended_at IS NULL) DESC, o.started_at DESC""", (car_id,)).fetchall()
    orders = conn.execute(ORDERS_SELECT + " WHERE o.car_id = %s ORDER BY o.created_at DESC LIMIT 50",
                          (car_id,)).fetchall()
    events = conn.execute(EVENTS_SELECT + """ WHERE e.car_id = %s
                          OR e.order_id IN (SELECT id FROM parts_orders WHERE car_id = %s)
                          ORDER BY e.created_at DESC LIMIT 100""", (car_id, car_id)).fetchall()
    return {**car, "owners": owners, "orders": orders, "events": _names(conn, events)}


@router.put("/customer-cars/{car_id}")
def edit_car(car_id: int, body: CarIn, conn=Depends(get_conn), staff=Depends(require_register)):
    old = _car(conn, car_id)
    f = _car_fields(body, keep=old["vin"] if old["vin_nonstandard"] else None)
    _check_vin(conn, f["vin"], exclude=car_id)
    conn.execute(f"UPDATE customer_cars SET {', '.join(f'{k} = %s' for k in f)}, updated_at = now() WHERE id = %s",
                 (*f.values(), car_id))
    event(conn, "car_updated", staff["id"], car_id=car_id)
    if (f["registration_number"], f["vin"]) != (old["registration_number"], old["vin"]) or not old["registry_checked_at"]:
        refresh_registry(conn, car_id)
    return _car(conn, car_id)


class OwnerIn(BaseModel):
    customer_id: Optional[int] = None   # None = the car has no owner in the register now (sold elsewhere, scrapped)


@router.post("/customer-cars/{car_id}/owner")
def change_owner(car_id: int, body: OwnerIn, conn=Depends(get_conn), staff=Depends(require_register)):
    _car(conn, car_id)
    if body.customer_id:
        _customer(conn, body.customer_id)
    set_owner(conn, car_id, body.customer_id, staff["id"])
    conn.execute("UPDATE customer_cars SET updated_at = now() WHERE id = %s", (car_id,))
    return {"ok": True}


@router.delete("/customer-cars/{car_id}", status_code=204)
def delete_car(car_id: int, conn=Depends(get_conn), _admin=Depends(require_admin)):
    _car(conn, car_id)
    if conn.execute("SELECT 1 FROM parts_orders WHERE car_id = %s AND status IN ('open', 'ordered', 'arrived')",
                    (car_id,)).fetchone():
        raise conflict("The car has open parts orders. Finish or cancel them first.")
    conn.execute("DELETE FROM customer_cars WHERE id = %s", (car_id,))


# --------------------------------------------------------------------------- #
# the car database: customer on a car, and the transfer into the register
# --------------------------------------------------------------------------- #

class VehicleCustomerIn(BaseModel):
    first_name: Optional[str] = Field(None, max_length=60)
    last_name: Optional[str] = Field(None, max_length=60)
    address: Optional[str] = Field(None, max_length=160)
    phone: Optional[str] = Field(None, max_length=30)


@router.put("/vehicles/{vehicle_id}/customer")
def vehicle_customer(vehicle_id: int, body: VehicleCustomerIn, conn=Depends(get_conn), staff=Depends(require_staff)):
    """The customer on a car in the car database (any staff; all empty = removed). Not logged with the values."""
    if not conn.execute("SELECT 1 FROM vehicles WHERE id = %s AND deleted_at IS NULL", (vehicle_id,)).fetchone():
        raise not_found("Vehicle")
    f = {
        "customer_first_name": cap_name(_text(body.first_name, 60) or "") or None,
        "customer_last_name": cap_name(_text(body.last_name, 60) or "") or None,
        "customer_address": _text(body.address, 160),
        "customer_phone": clean_phone(body.phone) if (body.phone or "").strip() else None,
    }
    conn.execute("""UPDATE vehicles SET customer_first_name = %(customer_first_name)s,
                           customer_last_name = %(customer_last_name)s, customer_address = %(customer_address)s,
                           customer_phone = %(customer_phone)s WHERE id = %(id)s""", {**f, "id": vehicle_id})
    log_event(conn, vehicle_id, "customer_details_updated", staff_id=staff["id"],
              data={"removed": True} if not any(f.values()) else None)
    return f


def _vehicle(conn, vehicle_id: int) -> dict:
    v = conn.execute("SELECT * FROM vehicles WHERE id = %s AND deleted_at IS NULL", (vehicle_id,)).fetchone()
    if not v:
        raise not_found("Vehicle")
    return v


@router.get("/vehicles/{vehicle_id}/transfer")
def transfer_preview(vehicle_id: int, conn=Depends(get_conn), _staff=Depends(require_staff)):
    """Before copying a car into the customer register: the car if it is there already, and customers that may be the
    same person (same phone, or same first + last name). Only name and customer number are shown."""
    v = _vehicle(conn, vehicle_id)
    car = _find(conn, v["registration_number"] or "", v["vin"] or "")
    phone = re.sub(r"\D", "", v["customer_phone"] or "")
    name = f"{v['customer_first_name'] or ''} {v['customer_last_name'] or ''}".strip()
    matches = conn.execute(
        """SELECT id, customer_no, name, city FROM customers
            WHERE (%s <> '' AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 8) = right(%s, 8))
               OR (%s <> '' AND lower(name) = lower(%s))
            ORDER BY updated_at DESC LIMIT 5""", (phone, phone, name, name)).fetchall()
    return {"car": car, "matches": matches, "company": company(), "retention_years": settings.retention_years}


class TransferIn(BaseModel):
    consent: bool
    customer_id: Optional[int] = None      # an existing customer, or
    customer: Optional[CustomerIn] = None  # a new one


@router.post("/vehicles/{vehicle_id}/transfer", status_code=201)
def transfer(vehicle_id: int, body: TransferIn, conn=Depends(get_conn), staff=Depends(require_staff)):
    """Copy a car from the car database into the customer register, owned by the customer (consent required)."""
    if not body.consent:
        raise bad_request("The customer must agree before the car and their details go into the customer register")
    v = _vehicle(conn, vehicle_id)
    sid = staff["id"]
    if body.customer_id:
        customer = _customer(conn, body.customer_id)
    elif body.customer:
        customer = create_customer(conn, _customer_fields(body.customer), sid)
    else:
        raise bad_request("Choose a customer or fill in a new one")
    car = _find(conn, v["registration_number"] or "", v["vin"] or "")
    if car:
        car_id = car["id"]
        conn.execute("""UPDATE customer_cars SET vehicle_id = %s, consent_at = now(), consent_by = %s,
                               updated_at = now() WHERE id = %s""", (vehicle_id, sid, car_id))
    else:
        car_id = conn.execute(
            """INSERT INTO customer_cars (registration_number, vin, vin_nonstandard, make, model, color, fuel_type,
                                          model_year, vehicle_id, consent_at, consent_by, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, now(), %s, %s) RETURNING id""",
            (v["registration_number"], v["vin"], v.get("vin_nonstandard", False), v["make"], v["model"], v["color"],
             v["fuel_type"], v["model_year"], vehicle_id, sid, sid)).fetchone()["id"]
        event(conn, "car_created", sid, car_id=car_id)
        refresh_registry(conn, car_id)  # the Statens vegvesen dates (0.59.0)
    set_owner(conn, car_id, customer["id"], sid)
    event(conn, "transferred_from_car_database", sid, car_id=car_id, data={"vehicle_id": vehicle_id, "consent": True})
    event(conn, "transferred_from_car_database", sid, customer_id=customer["id"],
          data={"vehicle_id": vehicle_id, "car_id": car_id, "consent": True})
    conn.execute("UPDATE vehicles SET customer_car_id = %s WHERE id = %s", (car_id, vehicle_id))
    log_event(conn, vehicle_id, "transferred_to_customer_register", staff_id=sid, data={"customer_car_id": car_id})
    touch(conn, customer["id"])
    return {"customer_id": customer["id"], "car_id": car_id}


# --------------------------------------------------------------------------- #
# retention (sync_worker.housekeeping)
# --------------------------------------------------------------------------- #

def purge_inactive(conn, years: int) -> int:
    """Delete customers with no activity for `years` (no open orders), then register cars nobody owns any more that
    have not changed in that time. Orders stay, without the customer."""
    gone = conn.execute(
        """DELETE FROM customers c WHERE c.last_activity_at < now() - make_interval(years => %s)
              AND NOT EXISTS (SELECT 1 FROM parts_orders o WHERE o.customer_id = c.id
                                 AND (o.status IN ('open', 'ordered', 'arrived')
                                      OR o.updated_at > now() - make_interval(years => %s)))
           RETURNING id""", (years, years)).fetchall()
    conn.execute(
        """DELETE FROM customer_cars cc WHERE cc.updated_at < now() - make_interval(years => %s)
              AND NOT EXISTS (SELECT 1 FROM car_ownerships o WHERE o.car_id = cc.id)
              AND NOT EXISTS (SELECT 1 FROM parts_orders o WHERE o.car_id = cc.id
                                 AND o.status IN ('open', 'ordered', 'arrived'))""", (years,))
    return len(gone)
