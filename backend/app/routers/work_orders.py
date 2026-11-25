"""Work orders (0.49.0): a car + the work to perform + the mechanic's reply + labour time + parts.

- The car is from Vehicles (`vehicle_id`, e.g. a PDI) or from the customer register (`customer_car_id`, with its
  current owner as the customer). Number = next free, at least System → Work hours → first work order number.
- The work: free text (`description`) and / or a list to tick off (`tasks`); the mechanic answers in `mechanic_note`.
- Labour = time clocked on the order (`work_time`, one running clock per person; breaks taken off, worktime.py).
  Everyone with access sees the total; who worked when is shown to admins only (work hours are admin-only).
- Parts = parts orders tied to the order (`parts_orders.work_order_id`); they don't need a customer then.
- PDI orders get a work order from here when the PDI date is confirmed (`create_work_order`, routers/pdi.py).
- Access: admins and teams with Work orders, Customers or Parts (customer data; a server lock like the register).
- History (`work_order_events`): ids and short values only, never texts or customer details.
"""
import json
import secrets
from datetime import datetime
from decimal import Decimal
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import worktime
from ..auth import require_staff
from ..common import bad_request, conflict, not_found
from ..config import settings
from ..db import get_conn
from ..worktime import OSLO, local
from .customers import ORDERS_SELECT, touch
from .hours import enabled as hours_enabled, start_day, stop_running
from .parts import CENT

router = APIRouter(tags=["work orders"])

ACTIVE = ("open", "in_progress")
STATUSES = ("open", "in_progress", "done", "cancelled")
LIST_LIMIT = 200
MAX_TASKS = 100


def _access(staff: dict) -> bool:
    return bool(staff.get("is_admin") or {"work_orders", "customers", "parts"} & set(staff.get("menu") or []))


def require_work_orders(staff: dict = Depends(require_staff)) -> dict:
    if not _access(staff):
        raise HTTPException(403, "Only staff with access to work orders can do this")
    return staff


def _event(conn, wo_id: int, kind: str, staff_id, data=None) -> None:
    conn.execute("INSERT INTO work_order_events (work_order_id, kind, data, created_by) VALUES (%s, %s, %s, %s)",
                 (wo_id, kind, Jsonb(data, dumps=lambda o: json.dumps(o, default=str)) if data else None, staff_id))


def _text(value: Optional[str], n: int) -> Optional[str]:
    value = (value or "").strip()
    return value[:n] or None


def _planned(value: Optional[str]) -> Optional[datetime]:
    """ "2026-11-25T11:00" (local Oslo time) → aware datetime; empty = none."""
    if not (value or "").strip():
        return None
    day, _, hhmm = value.strip().partition("T")
    try:
        return worktime.parse_local(day, hhmm or "08:00")
    except ValueError:
        raise bad_request("Check the planned date and time")


def _tasks(texts: list[str]) -> list[dict]:
    out = []
    for t in texts[:MAX_TASKS]:
        t = " ".join(str(t or "").split())[:300]
        if t:
            out.append({"id": secrets.token_hex(4), "text": t, "done": False})
    return out


def _check_staff(conn, staff_id: Optional[int]) -> None:
    if staff_id and not conn.execute("SELECT 1 FROM staff WHERE id = %s AND deleted_at IS NULL",
                                     (staff_id,)).fetchone():
        raise not_found("Person")


def create_work_order(conn, staff_id: int, *, vehicle_id=None, customer_car_id=None, customer_id=None, title=None,
                      description=None, tasks: Optional[list[str]] = None, estimated_minutes=None, planned_at=None,
                      assigned_to=None, pdi_order_id=None) -> dict:
    """A new work order with the next number (shared with the PDI date confirmation)."""
    if bool(vehicle_id) == bool(customer_car_id):
        raise bad_request("Choose the car for the work order")
    if vehicle_id and not conn.execute("SELECT 1 FROM vehicles WHERE id = %s AND deleted_at IS NULL",
                                       (vehicle_id,)).fetchone():
        raise not_found("Vehicle")
    if customer_car_id:
        if not conn.execute("SELECT 1 FROM customer_cars WHERE id = %s", (customer_car_id,)).fetchone():
            raise not_found("Car")
        if not customer_id:  # the car's current owner
            owner = conn.execute("SELECT customer_id FROM car_ownerships WHERE car_id = %s AND ended_at IS NULL",
                                 (customer_car_id,)).fetchone()
            customer_id = owner["customer_id"] if owner else None
    if customer_id and not conn.execute("SELECT 1 FROM customers WHERE id = %s", (customer_id,)).fetchone():
        raise not_found("Customer")
    _check_staff(conn, assigned_to)
    conn.execute("SELECT pg_advisory_xact_lock(hashtext('work_order_no'))")  # two new orders never share a number
    n = conn.execute("SELECT max(number) AS n FROM work_orders").fetchone()["n"] or 0
    number = max(n + 1, settings.work_order_number_start)
    row = conn.execute(
        """INSERT INTO work_orders (number, vehicle_id, customer_car_id, customer_id, title, description, tasks,
                                    estimated_minutes, planned_at, assigned_to, pdi_order_id, created_by, updated_by)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id, number""",
        (number, vehicle_id, customer_car_id, customer_id, _text(title, 120), _text(description, 5000),
         Jsonb(_tasks(tasks or [])), estimated_minutes, planned_at, assigned_to, pdi_order_id, staff_id,
         staff_id)).fetchone()
    _event(conn, row["id"], "created", staff_id, {"vehicle_id": vehicle_id, "customer_car_id": customer_car_id,
                                                   "customer_id": customer_id, "pdi_order_id": pdi_order_id})
    touch(conn, customer_id)
    return row


WO_SELECT = """SELECT w.id, w.number, w.status, w.title, w.planned_at, w.estimated_minutes, w.created_at, w.done_at,
                      w.vehicle_id, w.customer_car_id, w.customer_id, w.assigned_to, w.pdi_order_id, w.updated_at,
                      w.arrived_at,
                      coalesce(cc.registration_number, v.registration_number) AS registration_number,
                      coalesce(cc.vin, v.vin) AS vin, coalesce(cc.make, v.make) AS make,
                      coalesce(cc.model, v.model) AS model, v.deleted_at IS NOT NULL AS vehicle_deleted,
                      c.name AS customer_name, c.customer_no, a.name AS assigned_name,
                      jsonb_array_length(w.tasks) AS task_count,
                      (SELECT count(*) FROM jsonb_array_elements(w.tasks) x WHERE (x->>'done')::boolean) AS tasks_done,
                      (SELECT count(*) FROM work_time t WHERE t.work_order_id = w.id AND t.ended_at IS NULL)
                          AS clocks_running
                 FROM work_orders w LEFT JOIN vehicles v ON v.id = w.vehicle_id
                 LEFT JOIN customer_cars cc ON cc.id = w.customer_car_id
                 LEFT JOIN customers c ON c.id = w.customer_id LEFT JOIN staff a ON a.id = w.assigned_to"""


def _labour(conn, order_ids: list[int]) -> dict[int, int]:
    """Seconds clocked per work order, breaks taken off (each person's own breaks)."""
    if not order_ids:
        return {}
    rows = conn.execute("SELECT work_order_id, staff_id, started_at, ended_at FROM work_time "
                        "WHERE work_order_id = ANY(%s)", (order_ids,)).fetchall()
    cache: dict[int, worktime.BreaksFor] = {}
    out: dict[int, int] = {}
    for r in rows:
        bf = cache.setdefault(r["staff_id"], worktime.person_breaks(conn, r["staff_id"]))
        out[r["work_order_id"]] = out.get(r["work_order_id"], 0) + worktime.worked_seconds(r["started_at"],
                                                                                            r["ended_at"], bf)
    return out


@router.get("/work-orders")
def list_orders(show: Literal["active", "done", "invoiced", "cancelled", "all"] = "active", q: str = "",
                vehicle_id: Optional[int] = None, customer_car_id: Optional[int] = None,
                customer_id: Optional[int] = None, conn=Depends(get_conn), _staff=Depends(require_work_orders)):
    where, params = [], []
    if show == "active":
        where.append("w.status IN ('open', 'in_progress')")
    elif show != "all":
        where.append("w.status = %s")
        params.append(show)
    for col, value in (("w.vehicle_id", vehicle_id), ("w.customer_car_id", customer_car_id),
                       ("w.customer_id", customer_id)):
        if value:
            where.append(f"{col} = %s")
            params.append(value)
    q = q.strip()
    if q:
        digits = "".join(ch for ch in q if ch.isdigit())
        key = "".join(ch for ch in q.upper() if ch.isalnum())
        like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        conds = ["c.name ILIKE %s", "w.title ILIKE %s", "coalesce(cc.registration_number, v.registration_number) LIKE %s",
                 "coalesce(cc.vin, v.vin) LIKE %s", "coalesce(cc.make, v.make) || ' ' || coalesce(cc.model, v.model) ILIKE %s"]
        params += [like, like, f"%{key}%", f"%{key}%", like]
        if digits:
            conds += ["w.number::text = %s", "c.customer_no::text = %s"]
            params += [digits, digits]
        where.append("(" + " OR ".join(conds) + ")")
    rows = conn.execute(WO_SELECT + (" WHERE " + " AND ".join(where) if where else "")
                        + " ORDER BY (w.status IN ('open', 'in_progress')) DESC, w.planned_at NULLS LAST, "
                          f"w.created_at DESC LIMIT {LIST_LIMIT}", params).fetchall()
    labour = _labour(conn, [r["id"] for r in rows])
    for r in rows:
        r["labour_seconds"] = labour.get(r["id"], 0)
        r["planned_local"] = local(r["planned_at"])
    counts = conn.execute("SELECT status, count(*) AS n FROM work_orders GROUP BY status").fetchall()
    return {"orders": rows, "counts": {r["status"]: r["n"] for r in counts}}


@router.get("/work-orders/cars")
def find_cars(q: str = "", conn=Depends(get_conn), _staff=Depends(require_work_orders)):
    """Cars for a new work order: from Vehicles and from the customer register (by reg. no., VIN or owner's name)."""
    q = q.strip()
    key = "".join(ch for ch in q.upper() if ch.isalnum())
    if len(key) < 2:
        return {"vehicles": [], "customer_cars": []}
    like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    vehicles = conn.execute(
        """SELECT id, registration_number, vin, make, model, status FROM vehicles
            WHERE deleted_at IS NULL AND (registration_number LIKE %s OR vin LIKE %s)
            ORDER BY registration_number NULLS LAST LIMIT 10""", (f"%{key}%", f"%{key}%")).fetchall()
    cars = conn.execute(
        """SELECT cc.id, cc.registration_number, cc.vin, cc.make, cc.model, c.id AS customer_id, c.name AS customer_name,
                  c.customer_no
             FROM customer_cars cc
             LEFT JOIN car_ownerships o ON o.car_id = cc.id AND o.ended_at IS NULL
             LEFT JOIN customers c ON c.id = o.customer_id
            WHERE cc.registration_number LIKE %s OR cc.vin LIKE %s OR c.name ILIKE %s
            ORDER BY cc.registration_number NULLS LAST LIMIT 15""", (f"%{key}%", f"%{key}%", like)).fetchall()
    return {"vehicles": vehicles, "customer_cars": cars}


@router.get("/work-orders/staff")
def staff_list(conn=Depends(get_conn), _staff=Depends(require_work_orders)):
    """People who can be set as the mechanic on a work order."""
    return conn.execute("SELECT id, name FROM staff WHERE deleted_at IS NULL AND active ORDER BY lower(name)").fetchall()


class WorkOrderIn(BaseModel):
    vehicle_id: Optional[int] = None
    customer_car_id: Optional[int] = None
    title: Optional[str] = Field(None, max_length=120)
    description: Optional[str] = Field(None, max_length=5000)
    tasks: list[str] = Field(default_factory=list, max_length=MAX_TASKS)
    estimated_minutes: Optional[int] = Field(None, gt=0, le=100_000)
    planned_at: Optional[str] = None   # local "2026-11-25T11:00"
    assigned_to: Optional[int] = None


@router.post("/work-orders", status_code=201)
def new_order(body: WorkOrderIn, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    return create_work_order(conn, staff["id"], vehicle_id=body.vehicle_id, customer_car_id=body.customer_car_id,
                             title=body.title, description=body.description, tasks=body.tasks,
                             estimated_minutes=body.estimated_minutes, planned_at=_planned(body.planned_at),
                             assigned_to=body.assigned_to)


def _order(conn, wo_id: int, lock: bool = False) -> dict:
    row = conn.execute("SELECT * FROM work_orders WHERE id = %s" + (" FOR UPDATE" if lock else ""), (wo_id,)).fetchone()
    if not row:
        raise not_found("Work order")
    return row


def _expected_done(conn, o: dict, labour: int) -> Optional[str]:
    """When the job should be done: from the running clock (estimate minus time so far), else from the planned
    start (when nothing is clocked yet). Breaks are skipped."""
    if not o["estimated_minutes"] or o["status"] not in ACTIVE:
        return None
    left = o["estimated_minutes"] - labour / 60
    running = conn.execute("SELECT staff_id FROM work_time WHERE work_order_id = %s AND ended_at IS NULL "
                           "ORDER BY started_at LIMIT 1", (o["id"],)).fetchone()
    if running:
        if left <= 0:
            return None
        return local(worktime.add_work(datetime.now(OSLO), left, worktime.person_breaks(conn, running["staff_id"])))
    if o["planned_at"] and not labour:  # as the Planner draws it: breaks, evenings and weekends skipped
        segs = worktime.work_segments(o["planned_at"], o["estimated_minutes"],
                                      worktime.person_breaks(conn, o["assigned_to"]))
        return local(segs[-1][1]) if segs else None
    return None


@router.get("/work-orders/{wo_id}")
def get_order(wo_id: int, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    from . import invoices  # invoices imports this module
    o = _order(conn, wo_id)
    out = conn.execute(WO_SELECT + " WHERE w.id = %s", (wo_id,)).fetchone()
    extra = conn.execute(
        """SELECT cs.name AS created_by_name, us.name AS updated_by_name, ds.name AS done_by_name,
                  c.phone AS customer_phone, p.status AS pdi_status
             FROM work_orders w LEFT JOIN staff cs ON cs.id = w.created_by LEFT JOIN staff us ON us.id = w.updated_by
             LEFT JOIN staff ds ON ds.id = w.done_by LEFT JOIN customers c ON c.id = w.customer_id
             LEFT JOIN pdi_orders p ON p.id = w.pdi_order_id
            WHERE w.id = %s""", (wo_id,)).fetchone()
    labour = _labour(conn, [wo_id]).get(wo_id, 0)
    is_admin = bool(staff.get("is_admin"))
    entries = []
    if is_admin:  # who worked when: work hours are for admins only
        cache: dict[int, worktime.BreaksFor] = {}
        for t in conn.execute(
                """SELECT t.*, s.name AS staff_name FROM work_time t LEFT JOIN staff s ON s.id = t.staff_id
                    WHERE t.work_order_id = %s ORDER BY t.started_at DESC""", (wo_id,)).fetchall():
            bf = cache.setdefault(t["staff_id"], worktime.person_breaks(conn, t["staff_id"]))
            entries.append({"id": t["id"], "staff_id": t["staff_id"], "staff_name": t["staff_name"],
                            "start": local(t["started_at"]), "end": local(t["ended_at"]), "note": t["note"],
                            "seconds": worktime.worked_seconds(t["started_at"], t["ended_at"], bf),
                            "running": t["ended_at"] is None})
    mine = conn.execute("SELECT started_at FROM work_time WHERE work_order_id = %s AND staff_id = %s "
                        "AND ended_at IS NULL", (wo_id, staff["id"])).fetchone()
    parts = conn.execute(ORDERS_SELECT + " WHERE o.work_order_id = %s ORDER BY o.created_at", (wo_id,)).fetchall()
    lines = conn.execute(
        """SELECT l.*, o.order_no, o.status AS order_status, p.quantity AS stock, p.location,
                  p.deleted_at IS NOT NULL AS part_deleted
             FROM parts_order_lines l JOIN parts_orders o ON o.id = l.order_id LEFT JOIN parts p ON p.id = l.part_id
            WHERE o.work_order_id = %s AND o.status <> 'cancelled' ORDER BY o.order_no, l.id""", (wo_id,)).fetchall()
    parts_total = sum((l["quantity"] * (l["unit_price"] or 0) for l in lines), Decimal(0)).quantize(CENT)
    events = conn.execute(
        """SELECT e.id, e.kind, e.data, e.created_at, s.name AS staff_name FROM work_order_events e
             LEFT JOIN staff s ON s.id = e.created_by WHERE e.work_order_id = %s
            ORDER BY e.created_at DESC LIMIT 200""", (wo_id,)).fetchall()
    return {**out, **extra, "description": o["description"], "tasks": o["tasks"], "mechanic_note": o["mechanic_note"],
            "planned_local": local(o["planned_at"]), "labour_seconds": labour, "entries": entries,
            "my_clock": local(mine["started_at"]) if mine else None,
            "expected_done": _expected_done(conn, o, labour), "parts_orders": parts, "parts_lines": lines,
            "parts_total_ex": parts_total, "events": events, "hours_enabled": hours_enabled(),
            "km": o["km"], "extra_lines": o["extra_lines"], "billing": invoices.billing(conn, o),
            "invoices": invoices.work_order_invoices(conn, wo_id)}


class WorkOrderPatch(BaseModel):
    title: Optional[str] = Field(None, max_length=120)
    description: Optional[str] = Field(None, max_length=5000)
    mechanic_note: Optional[str] = Field(None, max_length=5000)
    estimated_minutes: Optional[int] = Field(None, gt=0, le=100_000)
    planned_at: Optional[str] = None
    assigned_to: Optional[int] = None
    labour_rate: Optional[Decimal] = Field(None, ge=0, le=100_000)   # null = the System page rate
    billed_minutes: Optional[int] = Field(None, ge=0, le=100_000)    # null = the clocked time, rounded up
    km: Optional[int] = Field(None, ge=0, le=5_000_000)
    customer_id: Optional[int] = None


def _not_locked(o: dict) -> None:
    """Cancelled and invoiced work orders can't be changed (an invoiced one: credit the invoice first)."""
    if o["status"] == "cancelled":
        raise conflict("The work order is cancelled")
    if o["status"] == "invoiced":
        raise conflict("The work order is invoiced: make a credit note first")


@router.patch("/work-orders/{wo_id}")
def edit_order(wo_id: int, body: WorkOrderPatch, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    o = _order(conn, wo_id, lock=True)
    _not_locked(o)
    sent = body.model_dump(exclude_unset=True)
    new = {}
    for f in ("labour_rate", "billed_minutes", "km"):
        if f in sent:
            new[f] = sent[f]
    if "customer_id" in sent:
        if sent["customer_id"] and not conn.execute("SELECT 1 FROM customers WHERE id = %s",
                                                    (sent["customer_id"],)).fetchone():
            raise not_found("Customer")
        new["customer_id"] = sent["customer_id"]
    for f, n in (("title", 120), ("description", 5000), ("mechanic_note", 5000)):
        if f in sent:
            new[f] = _text(sent[f], n)
    if "estimated_minutes" in sent:
        new["estimated_minutes"] = sent["estimated_minutes"]
    if "planned_at" in sent:
        new["planned_at"] = _planned(sent["planned_at"])
    if "assigned_to" in sent:
        _check_staff(conn, sent["assigned_to"])
        new["assigned_to"] = sent["assigned_to"]
    changed = [f for f, v in new.items() if v != o[f]]
    if not changed:
        return {"id": wo_id}
    sets = ", ".join(f"{f} = %s" for f in changed)
    conn.execute(f"UPDATE work_orders SET {sets}, updated_at = now(), updated_by = %s WHERE id = %s",
                 (*[new[f] for f in changed], staff["id"], wo_id))
    data = {"fields": changed}
    for f in ("estimated_minutes", "planned_at", "assigned_to", "labour_rate", "billed_minutes", "km",
              "customer_id"):  # short values and ids; texts are never logged
        if f in changed:
            data[f] = {"from": o[f], "to": new[f]}
    _event(conn, wo_id, "updated", staff["id"], data)
    touch(conn, o["customer_id"])
    return {"id": wo_id}


class TaskIn(BaseModel):
    id: Optional[str] = Field(None, max_length=20)
    text: str = Field(max_length=300)
    done: bool = False


class TasksIn(BaseModel):
    tasks: list[TaskIn] = Field(max_length=MAX_TASKS)


@router.put("/work-orders/{wo_id}/tasks")
def save_tasks(wo_id: int, body: TasksIn, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    """The whole list (add, tick, untick, remove, reorder). Who ticked a task and when is kept."""
    o = _order(conn, wo_id, lock=True)
    _not_locked(o)
    old = {t.get("id"): t for t in o["tasks"] or []}
    out, ticked = [], 0
    for t in body.tasks:
        text = " ".join(t.text.split())[:300]
        if not text:
            continue
        before = old.get(t.id) if t.id else None
        item = {"id": t.id if before else secrets.token_hex(4), "text": text, "done": t.done}
        if t.done:
            if before and before.get("done"):
                item["done_by"], item["done_at"] = before.get("done_by"), before.get("done_at")
            else:
                item["done_by"], item["done_at"] = staff["name"], datetime.now(OSLO).isoformat()
                ticked += 1
        out.append(item)
    conn.execute("UPDATE work_orders SET tasks = %s, updated_at = now(), updated_by = %s WHERE id = %s",
                 (Jsonb(out), staff["id"], wo_id))
    if len(out) != len(old) or ticked:
        _event(conn, wo_id, "tasks", staff["id"], {"count": len(out), "done": sum(1 for t in out if t["done"])})
    return {"tasks": out}


class StatusIn(BaseModel):
    status: Literal["open", "in_progress", "done", "cancelled"]


@router.post("/work-orders/{wo_id}/status")
def set_status(wo_id: int, body: StatusIn, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    o = _order(conn, wo_id, lock=True)
    if o["status"] == "invoiced":
        raise conflict("The work order is invoiced: make a credit note first")
    if o["status"] == body.status:
        return {"id": wo_id}
    if body.status in ("done", "cancelled"):  # nobody keeps clocking on a finished order
        for r in conn.execute("SELECT staff_id FROM work_time WHERE work_order_id = %s AND ended_at IS NULL",
                              (wo_id,)).fetchall():
            stop_running(conn, r["staff_id"])
    conn.execute(
        """UPDATE work_orders SET status = %s, updated_at = now(), updated_by = %s,
                  done_at = CASE WHEN %s = 'done' THEN now() END, done_by = CASE WHEN %s = 'done' THEN %s END
            WHERE id = %s""", (body.status, staff["id"], body.status, body.status, staff["id"], wo_id))
    _event(conn, wo_id, "status", staff["id"], {"from": o["status"], "to": body.status})
    touch(conn, o["customer_id"])
    return {"id": wo_id}


@router.post("/work-orders/{wo_id}/clock")
def clock_start(wo_id: int, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    """Start my clock on this order: any other clock of mine stops, and my working day starts if it hasn't."""
    o = _order(conn, wo_id, lock=True)
    if o["status"] not in ACTIVE:
        raise conflict("The work order is done or cancelled: open it again first")
    now = datetime.now(OSLO)
    running = conn.execute("SELECT work_order_id FROM work_time WHERE staff_id = %s AND ended_at IS NULL",
                           (staff["id"],)).fetchone()
    if running and running["work_order_id"] == wo_id:
        return {"id": wo_id}
    stop_running(conn, staff["id"], now)
    if hours_enabled():
        start_day(conn, staff["id"], now)
    conn.execute("INSERT INTO work_time (work_order_id, staff_id, started_at) VALUES (%s, %s, %s)",
                 (wo_id, staff["id"], now))
    if o["status"] == "open":
        conn.execute("UPDATE work_orders SET status = 'in_progress', updated_at = now(), updated_by = %s WHERE id = %s",
                     (staff["id"], wo_id))
        _event(conn, wo_id, "status", staff["id"], {"from": "open", "to": "in_progress"})
    return {"id": wo_id}


@router.post("/work-orders/{wo_id}/parts-order", status_code=201)
def parts_order(wo_id: int, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    """The work order's parts order (one not handed out yet), made now if there is none."""
    from .parts_orders import new_order as new_parts_order  # parts_orders imports nothing from here
    o = _order(conn, wo_id)
    _not_locked(o)
    row = conn.execute("SELECT id FROM parts_orders WHERE work_order_id = %s AND status IN ('open', 'ordered', "
                       "'arrived') ORDER BY created_at LIMIT 1", (wo_id,)).fetchone()
    if row:
        return {"id": row["id"]}
    made = new_parts_order(conn, staff["id"], customer_id=o["customer_id"], car_id=o["customer_car_id"],
                           reference=f"#{o['number']}", note=None, work_order_id=wo_id)
    _event(conn, wo_id, "parts_order", staff["id"], {"order_id": made["id"], "order_no": made["order_no"]})
    return made


class ExtraLine(BaseModel):
    text: str = Field(max_length=200)
    quantity: Decimal = Field(default=Decimal(1), gt=0, le=100_000)
    unit_price: Decimal = Field(ge=0, le=10_000_000)   # ex VAT
    vat_rate: Decimal = Field(default=Decimal(25), ge=0, le=100)


class ExtraLinesIn(BaseModel):
    lines: list[ExtraLine] = Field(max_length=50)


@router.put("/work-orders/{wo_id}/extra-lines")
def save_extra_lines(wo_id: int, body: ExtraLinesIn, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    """Other charges on the invoice (e.g. an environmental fee, consumables): text, quantity, price ex VAT, VAT."""
    o = _order(conn, wo_id, lock=True)
    _not_locked(o)
    lines = [{"text": " ".join(x.text.split()), "quantity": x.quantity, "unit_price": x.unit_price,
              "vat_rate": x.vat_rate} for x in body.lines if x.text.strip()]
    conn.execute("UPDATE work_orders SET extra_lines = %s, updated_at = now(), updated_by = %s WHERE id = %s",
                 (Jsonb(lines, dumps=lambda v: json.dumps(v, default=str)), staff["id"], wo_id))
    _event(conn, wo_id, "extra_lines", staff["id"], {"count": len(lines)})
    return {"lines": lines}


class ArrivedIn(BaseModel):
    arrived: bool


@router.post("/work-orders/{wo_id}/arrived")
def set_arrived(wo_id: int, body: ArrivedIn, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    """The car is here (also set by the kiosk when the customer picks it from today's booked cars), or not after all."""
    o = _order(conn, wo_id, lock=True)
    _not_locked(o)
    if bool(o["arrived_at"]) == body.arrived:
        return {"id": wo_id}
    conn.execute("UPDATE work_orders SET arrived_at = CASE WHEN %s THEN now() END WHERE id = %s", (body.arrived, wo_id))
    _event(conn, wo_id, "arrived" if body.arrived else "not_arrived", staff["id"])
    return {"id": wo_id}
