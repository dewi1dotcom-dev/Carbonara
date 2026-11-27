"""Parts orders (0.48.0): parts collected for a customer's car, with history.

Status: open → ordered (from the supplier) → arrived → done (handed out), or cancelled. Parts on an order that is not
done or cancelled count as **reserved** in the parts store; the stock goes down only when the order is marked done
(one `part_movements` row per line, kind 'order'). Undoing a hand-out puts them back ('order_return').
Lines are parts from the store (number, name, unit, price and VAT copied when added; the price can be changed) or
free text (a part that is not in the store). Only the parts team (`parts._editor`) changes orders.

0.60.0 (the user's request: one place for a job's parts, "parts arrived" updating the work order, invoices for parts
orders): every line has a **supply** state (migration 059): stock (from our shelf) / order (to be ordered) / ordered /
arrived. A part from the store that arrives is added to the stock (movement 'order_received'; taken off again when the
arrival is undone), so handing it out never asks to "register as received" first. The order's status (open / ordered /
arrived) and, on a work order, "Parts arrived and ready" follow the lines (`sync`). A parts order without a work order
is a **counter sale** and is invoiced on its own (routers/invoices.py, `parts_orders.invoice_id`).
"""
from decimal import Decimal
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from ..common import bad_request, cap_name, conflict, not_found
from ..db import get_conn
from .customers import ORDERS_SELECT, EVENTS_SELECT, _names, event, require_register, touch
from ..auth import require_staff
from .parts import CENT, MAX_PRICE, MAX_QTY, _clean, _editor as _parts_editor, _fmt_qty, _move, require_parts_editor

router = APIRouter(tags=["parts orders"])

ACTIVE = ("open", "ordered", "arrived")
LIST_LIMIT = 200
SUPPLY = ("stock", "order", "ordered", "arrived")
READY = ("stock", "arrived")


def sync(conn, order_id: int, sid: Optional[int]) -> None:
    """The order's status from its lines (while not handed out / cancelled), and for a work order's parts order the
    work order's "Parts arrived and ready": set when every line of its parts orders is ready, cleared when one isn't."""
    order = _order(conn, order_id)
    states = [r["supply"] for r in conn.execute("SELECT supply FROM parts_order_lines WHERE order_id = %s",
                                                (order_id,)).fetchall()]
    if order["status"] in ACTIVE:
        new = ("open" if not states or "order" in states else "ordered" if "ordered" in states else "arrived")
        if new != order["status"]:
            conn.execute("UPDATE parts_orders SET status = %s, updated_at = now() WHERE id = %s", (new, order_id))
            event(conn, "order_status", sid, order_id=order_id, data={"from": order["status"], "to": new, "auto": True})
    if order["work_order_id"]:
        wo_sync(conn, order["work_order_id"], sid)


def wo_sync(conn, wo_id: int, sid: Optional[int]) -> None:
    """A work order's "Parts arrived and ready" from the lines of its parts orders (none = left as it is: then it is
    ticked by hand, e.g. for parts handled outside Carbonara)."""
    rows = conn.execute(
        """SELECT l.supply FROM parts_order_lines l JOIN parts_orders o ON o.id = l.order_id
            WHERE o.work_order_id = %s AND o.status <> 'cancelled'""", (wo_id,)).fetchall()
    if not rows:
        return
    ready = all(r["supply"] in READY for r in rows)
    wo = conn.execute("SELECT parts_ready_at, status FROM work_orders WHERE id = %s", (wo_id,)).fetchone()
    if not wo or wo["status"] in ("invoiced", "cancelled") or bool(wo["parts_ready_at"]) == ready:
        return
    conn.execute("UPDATE work_orders SET parts_ready_at = CASE WHEN %s THEN now() END, "
                 "parts_ready_by = CASE WHEN %s THEN %s::bigint END WHERE id = %s", (ready, ready, sid, wo_id))
    conn.execute("INSERT INTO work_order_events (work_order_id, kind, data, created_by) VALUES (%s, %s, %s, %s)",
                 (wo_id, "parts_ready" if ready else "parts_not_ready", Jsonb({"auto": True}), sid))


def _order(conn, order_id: int, lock: bool = False) -> dict:
    row = conn.execute("SELECT * FROM parts_orders WHERE id = %s" + (" FOR UPDATE" if lock else ""),
                       (order_id,)).fetchone()
    if not row:
        raise not_found("Parts order")
    return row


def _line_editor(staff: dict, order: dict) -> None:
    """Lines are changed by the parts team, or (on a work order's parts order) by anyone working on work orders."""
    if _parts_editor(staff):
        return
    if order["work_order_id"] and (staff.get("is_admin") or {"work_orders", "customers", "parts"} & set(staff.get("menu") or [])):
        return
    raise HTTPException(403, "Only the parts team or an administrator can do this")


def _editable(order: dict) -> None:
    if order["status"] not in ACTIVE:
        raise conflict("The order is done or cancelled and can't be changed")


@router.get("/parts-orders")
def list_orders(show: Literal["active", "done", "cancelled", "all"] = "active", q: str = "",
                scope: Literal["counter", "workshop", "all"] = "counter",
                conn=Depends(get_conn), _staff=Depends(require_register)):
    """0.60.0: by default only counter sales (orders without a work order); a work order's parts are handled on the
    work order itself."""
    where, params = [], []
    if scope == "counter":
        where.append("o.work_order_id IS NULL")
    elif scope == "workshop":
        where.append("o.work_order_id IS NOT NULL")
    if show == "active":
        where.append("o.status IN ('open', 'ordered', 'arrived')")
    elif show != "all":
        where.append("o.status = %s")
        params.append(show)
    q = q.strip()
    if q:
        digits = "".join(ch for ch in q if ch.isdigit())
        key = "".join(ch for ch in q.upper() if ch.isalnum())
        like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        conds = ["c.name ILIKE %s", "o.reference ILIKE %s", "cc.registration_number LIKE %s"]
        params += [like, like, f"%{key}%"]
        if digits:
            conds += ["o.order_no::text = %s", "c.customer_no::text = %s"]
            params += [digits, digits]
        where.append("(" + " OR ".join(conds) + ")")
    rows = conn.execute(ORDERS_SELECT + (" WHERE " + " AND ".join(where) if where else "")
                        + f" ORDER BY o.created_at DESC LIMIT {LIST_LIMIT}", params).fetchall()
    scope_sql = {"counter": " WHERE work_order_id IS NULL", "workshop": " WHERE work_order_id IS NOT NULL"}.get(scope, "")
    counts = conn.execute("SELECT status, count(*) AS n FROM parts_orders" + scope_sql + " GROUP BY status").fetchall()
    return {"orders": rows, "counts": {r["status"]: r["n"] for r in counts}}


class OrderIn(BaseModel):
    customer_id: int
    car_id: Optional[int] = None
    reference: Optional[str] = Field(None, max_length=60)
    note: Optional[str] = Field(None, max_length=1000)


def _check_car(conn, customer_id: Optional[int], car_id: Optional[int]) -> None:
    """A customer is needed unless the order belongs to a work order (e.g. a PDI on a car in stock)."""
    if customer_id and not conn.execute("SELECT 1 FROM customers WHERE id = %s", (customer_id,)).fetchone():
        raise not_found("Customer")
    if car_id and not conn.execute("SELECT 1 FROM customer_cars WHERE id = %s", (car_id,)).fetchone():
        raise not_found("Car")


def new_order(conn, staff_id: int, *, customer_id: Optional[int], car_id: Optional[int], reference: Optional[str],
              note: Optional[str], work_order_id: Optional[int] = None) -> dict:
    """A new parts order with the next number (also made from a work order, routers/work_orders.py)."""
    if not customer_id and not work_order_id:
        raise bad_request("Choose a customer")
    _check_car(conn, customer_id, car_id)
    conn.execute("SELECT pg_advisory_xact_lock(hashtext('parts_order_no'))")
    no = (conn.execute("SELECT max(order_no) AS n FROM parts_orders").fetchone()["n"] or 0) + 1
    row = conn.execute(
        """INSERT INTO parts_orders (order_no, customer_id, car_id, reference, note, work_order_id, created_by)
           VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id""",
        (no, customer_id, car_id, _clean(reference, 60), (note or "").strip()[:1000] or None, work_order_id,
         staff_id)).fetchone()
    event(conn, "order_created", staff_id, order_id=row["id"],
          data={"customer_id": customer_id, "car_id": car_id, "work_order_id": work_order_id})
    touch(conn, customer_id)
    return {"id": row["id"], "order_no": no}


@router.post("/parts-orders", status_code=201)
def create_order(body: OrderIn, conn=Depends(get_conn), staff=Depends(require_parts_editor)):
    return new_order(conn, staff["id"], customer_id=body.customer_id, car_id=body.car_id, reference=body.reference,
                     note=body.note)


LINES_SELECT = """SELECT l.*, p.quantity AS stock, p.location, p.deleted_at IS NOT NULL AS part_deleted
                    FROM parts_order_lines l LEFT JOIN parts p ON p.id = l.part_id
                   WHERE l.order_id = %s ORDER BY l.id"""


@router.get("/parts-orders/{order_id}")
def get_order(order_id: int, conn=Depends(get_conn), _staff=Depends(require_register)):
    _order(conn, order_id)
    order = conn.execute(ORDERS_SELECT + " WHERE o.id = %s", (order_id,)).fetchone()
    extra = conn.execute(
        """SELECT o.note, o.updated_at, cs.name AS created_by_name, ds.name AS done_by_name, c.phone AS customer_phone,
                  cc.vin, cc.model_year, o.work_order_id, w.number AS work_order_number
             FROM parts_orders o LEFT JOIN staff cs ON cs.id = o.created_by LEFT JOIN staff ds ON ds.id = o.done_by
             LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN customer_cars cc ON cc.id = o.car_id
             LEFT JOIN work_orders w ON w.id = o.work_order_id
            WHERE o.id = %s""", (order_id,)).fetchone()
    lines = conn.execute(LINES_SELECT, (order_id,)).fetchall()
    total_ex = sum((l["quantity"] * (l["unit_price"] or 0) for l in lines), Decimal(0))
    total_inc = sum((l["quantity"] * (l["unit_price"] or 0) * (1 + l["vat_rate"] / 100) for l in lines), Decimal(0))
    for line in lines:
        line["total_ex"] = (line["quantity"] * line["unit_price"]).quantize(CENT) if line["unit_price"] is not None else None
    events = conn.execute(EVENTS_SELECT + " WHERE e.order_id = %s ORDER BY e.created_at DESC LIMIT 200",
                          (order_id,)).fetchall()
    billing = None
    if not order["work_order_id"]:   # a counter sale is invoiced on its own (0.60.0)
        from .invoices import parts_billing  # invoices imports this module
        billing = parts_billing(conn, _order(conn, order_id))
    return {**order, **extra, "lines": lines, "billing": billing, "total_ex": total_ex.quantize(CENT),
            "vat": (total_inc - total_ex).quantize(CENT), "total_inc": total_inc.quantize(CENT),
            "events": _names(conn, events)}


class OrderPatch(BaseModel):
    customer_id: Optional[int] = None
    car_id: Optional[int] = None
    reference: Optional[str] = Field(None, max_length=60)
    note: Optional[str] = Field(None, max_length=1000)


@router.patch("/parts-orders/{order_id}")
def edit_order(order_id: int, body: OrderPatch, conn=Depends(get_conn), staff=Depends(require_parts_editor)):
    order = _order(conn, order_id, lock=True)
    _editable(order)
    sent = body.model_dump(exclude_unset=True)
    customer_id = sent.get("customer_id", order["customer_id"]) or order["customer_id"]
    car_id = sent["car_id"] if "car_id" in sent else order["car_id"]
    _check_car(conn, customer_id, car_id)
    reference = _clean(sent["reference"], 60) if "reference" in sent else order["reference"]
    note = ((sent["note"] or "").strip()[:1000] or None) if "note" in sent else order["note"]
    conn.execute("""UPDATE parts_orders SET customer_id = %s, car_id = %s, reference = %s, note = %s, updated_at = now()
                     WHERE id = %s""", (customer_id, car_id, reference, note, order_id))
    if customer_id != order["customer_id"]:
        event(conn, "order_customer_changed", staff["id"], order_id=order_id,
              data={"from_customer_id": order["customer_id"], "to_customer_id": customer_id})
    if car_id != order["car_id"]:
        event(conn, "order_car_changed", staff["id"], order_id=order_id, data={"from": order["car_id"], "to": car_id})
    if reference != order["reference"] or note != order["note"]:
        event(conn, "order_updated", staff["id"], order_id=order_id)
    touch(conn, customer_id)
    return {"ok": True}


class LineIn(BaseModel):
    part_id: Optional[int] = None                       # a part from the store, or
    part_number: Optional[str] = Field(None, max_length=60)  # a free text line
    name: Optional[str] = Field(None, max_length=200)
    quantity: Decimal = Field(gt=0, le=MAX_QTY)
    unit_price: Optional[Decimal] = Field(None, ge=0, le=MAX_PRICE)  # ex VAT; empty = the part's price
    vat_rate: Optional[Decimal] = Field(None, ge=0, le=100)
    supply: Optional[Literal["stock", "order", "ordered", "arrived"]] = None  # empty = worked out (0.60.0)


@router.post("/parts-orders/{order_id}/lines", status_code=201)
def add_line(order_id: int, body: LineIn, conn=Depends(get_conn), staff=Depends(require_staff)):
    order = _order(conn, order_id, lock=True)
    _line_editor(staff, order)
    _editable(order)
    qty = body.quantity.quantize(CENT)
    if body.part_id:
        part = conn.execute("SELECT * FROM parts WHERE id = %s AND deleted_at IS NULL", (body.part_id,)).fetchone()
        if not part:
            raise not_found("Part")
        # The same part again: add to that line instead of a second one (not to a line already ordered or arrived:
        # the extra quantity gets its own line, 0.60.0).
        same = conn.execute("SELECT id, quantity, supply FROM parts_order_lines WHERE order_id = %s AND part_id = %s "
                            "AND supply IN ('stock', 'order') ORDER BY id LIMIT 1", (order_id, part["id"])).fetchone()
        # 0.60.0: from our stock when there is enough on the shelf that isn't reserved by other open orders,
        # else it has to be ordered.
        reserved = conn.execute(
            """SELECT coalesce(sum(l.quantity), 0) AS n FROM parts_order_lines l JOIN parts_orders o ON o.id = l.order_id
                WHERE l.part_id = %s AND o.status IN ('open', 'ordered', 'arrived') AND l.supply IN ('stock', 'arrived')""",
            (part["id"],)).fetchone()["n"]
        enough = part["quantity"] - reserved >= qty
        if same:
            supply = same["supply"] if same["supply"] != "stock" or enough else "order"
            conn.execute("UPDATE parts_order_lines SET quantity = quantity + %s, supply = %s WHERE id = %s",
                         (qty, supply, same["id"]))
            line_id = same["id"]
        else:
            supply = body.supply if body.supply in ("stock", "order") else ("stock" if enough else "order")
            price = body.unit_price.quantize(CENT) if body.unit_price is not None else part["sale_price"]
            line_id = conn.execute(
                """INSERT INTO parts_order_lines (order_id, part_id, part_number, name, unit, quantity, unit_price,
                                                  vat_rate, created_by, supply, supply_at, supply_by)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), %s) RETURNING id""",
                (order_id, part["id"], part["part_number"], part["name"], part["unit"], qty, price,
                 body.vat_rate if body.vat_rate is not None else part["vat_rate"], staff["id"], supply,
                 staff["id"])).fetchone()["id"]
        number = part["part_number"]
    else:
        name = cap_name(_clean(body.name, 200) or "") or None
        if not name:
            raise bad_request("A line needs a part from the store or a name")
        number = (_clean(body.part_number, 60) or "").upper() or None
        line_id = conn.execute(
            """INSERT INTO parts_order_lines (order_id, part_number, name, quantity, unit_price, vat_rate, created_by,
                                              supply, supply_at, supply_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now(), %s) RETURNING id""",
            (order_id, number, name, qty, body.unit_price.quantize(CENT) if body.unit_price is not None else None,
             body.vat_rate if body.vat_rate is not None else Decimal(25), staff["id"],
             body.supply if body.supply in ("order", "ordered", "arrived") else "order",   # never on our shelf
             staff["id"])).fetchone()["id"]
    event(conn, "order_line_added", staff["id"], order_id=order_id,
          data={"part_number": number, "quantity": qty, "free_text": not body.part_id})
    conn.execute("UPDATE parts_orders SET updated_at = now() WHERE id = %s", (order_id,))
    sync(conn, order_id, staff["id"])
    return {"id": line_id}


class LinePatch(BaseModel):
    quantity: Optional[Decimal] = Field(None, gt=0, le=MAX_QTY)
    unit_price: Optional[Decimal] = Field(None, ge=0, le=MAX_PRICE)


def _line(conn, order_id: int, line_id: int) -> dict:
    line = conn.execute("SELECT * FROM parts_order_lines WHERE id = %s AND order_id = %s",
                        (line_id, order_id)).fetchone()
    if not line:
        raise not_found("Order line")
    return line


@router.patch("/parts-orders/{order_id}/lines/{line_id}")
def edit_line(order_id: int, line_id: int, body: LinePatch, conn=Depends(get_conn),
              staff=Depends(require_staff)):
    order = _order(conn, order_id, lock=True)
    _line_editor(staff, order)
    _editable(order)
    line = _line(conn, order_id, line_id)
    sent = body.model_dump(exclude_unset=True)
    qty = sent["quantity"].quantize(CENT) if sent.get("quantity") is not None else line["quantity"]
    price = (sent["unit_price"].quantize(CENT) if sent["unit_price"] is not None else None) \
        if "unit_price" in sent else line["unit_price"]
    if line["part_id"] and line["supply"] == "arrived" and qty != line["quantity"]:
        _stock(conn, line["part_id"], qty - line["quantity"], staff["id"], order)  # the arrival counted the old number
    conn.execute("UPDATE parts_order_lines SET quantity = %s, unit_price = %s WHERE id = %s", (qty, price, line_id))
    event(conn, "order_line_changed", staff["id"], order_id=order_id,
          data={"part_number": line["part_number"], "quantity_from": line["quantity"], "quantity_to": qty,
                "price_from": line["unit_price"], "price_to": price})
    conn.execute("UPDATE parts_orders SET updated_at = now() WHERE id = %s", (order_id,))
    sync(conn, order_id, staff["id"])
    return {"ok": True}


@router.delete("/parts-orders/{order_id}/lines/{line_id}", status_code=204)
def delete_line(order_id: int, line_id: int, conn=Depends(get_conn), staff=Depends(require_staff)):
    order = _order(conn, order_id, lock=True)
    _line_editor(staff, order)
    _editable(order)
    line = _line(conn, order_id, line_id)
    conn.execute("DELETE FROM parts_order_lines WHERE id = %s", (line_id,))
    event(conn, "order_line_removed", staff["id"], order_id=order_id,
          data={"part_number": line["part_number"], "quantity": line["quantity"]})
    conn.execute("UPDATE parts_orders SET updated_at = now() WHERE id = %s", (order_id,))
    sync(conn, order_id, staff["id"])


def _stock(conn, part_id: int, change, sid, order: dict) -> None:
    """A part arriving for an order goes into the stock (or out again when the arrival is undone)."""
    part = conn.execute("SELECT part_number, quantity FROM parts WHERE id = %s FOR UPDATE", (part_id,)).fetchone()
    if not part:
        return
    after = part["quantity"] + change
    if after < 0:
        raise bad_request(f"Not enough of {part['part_number']} in stock to take the arrival back "
                          f"({_fmt_qty(part['quantity'])} in stock)")
    _move(conn, part_id, "order_received", change, after, sid, reference=f"#{order['order_no']}", order_id=order["id"])
    conn.execute("UPDATE parts SET quantity = %s, updated_at = now(), updated_by = %s WHERE id = %s",
                 (after, sid, part_id))


class SupplyIn(BaseModel):
    supply: Literal["stock", "order", "ordered", "arrived"]
    expected_date: Optional[str] = None   # ISO date, for "ordered"


@router.put("/parts-orders/{order_id}/lines/{line_id}/supply")
def set_supply(order_id: int, line_id: int, body: SupplyIn, conn=Depends(get_conn), staff=Depends(require_staff)):
    """In stock / To order / Ordered (+ expected date) / Arrived, per line (0.60.0)."""
    from datetime import date
    order = _order(conn, order_id, lock=True)
    _line_editor(staff, order)
    _editable(order)
    line = _line(conn, order_id, line_id)
    if body.supply == "stock" and not line["part_id"]:
        raise bad_request("A part that isn't in the parts store can't come from our stock")
    try:
        expected = date.fromisoformat(body.expected_date) if body.expected_date and body.supply == "ordered" else None
    except ValueError:
        raise bad_request("Check the date")
    if line["part_id"] and (line["supply"] == "arrived") != (body.supply == "arrived"):
        _stock(conn, line["part_id"], line["quantity"] if body.supply == "arrived" else -line["quantity"],
               staff["id"], order)
    if body.supply != line["supply"] or expected != line["expected_date"]:
        conn.execute("""UPDATE parts_order_lines SET supply = %s, expected_date = %s, supply_at = now(), supply_by = %s
                         WHERE id = %s""", (body.supply, expected, staff["id"], line_id))
        event(conn, "order_line_supply", staff["id"], order_id=order_id,
              data={"part_number": line["part_number"], "from": line["supply"], "to": body.supply,
                    "expected": expected})
        conn.execute("UPDATE parts_orders SET updated_at = now() WHERE id = %s", (order_id,))
    sync(conn, order_id, staff["id"])
    return {"ok": True}


@router.post("/parts-orders/{order_id}/arrived")
def all_arrived(order_id: int, conn=Depends(get_conn), staff=Depends(require_staff)):
    """Everything ordered (or still to order) has arrived: one tap for the whole delivery."""
    order = _order(conn, order_id, lock=True)
    _line_editor(staff, order)
    _editable(order)
    lines = conn.execute("SELECT * FROM parts_order_lines WHERE order_id = %s AND supply IN ('order', 'ordered') "
                         "ORDER BY id", (order_id,)).fetchall()
    for line in lines:
        if line["part_id"]:
            _stock(conn, line["part_id"], line["quantity"], staff["id"], order)
        conn.execute("UPDATE parts_order_lines SET supply = 'arrived', expected_date = NULL, supply_at = now(), "
                     "supply_by = %s WHERE id = %s", (staff["id"], line["id"]))
    if lines:
        event(conn, "order_arrived", staff["id"], order_id=order_id, data={"lines": len(lines)})
        conn.execute("UPDATE parts_orders SET updated_at = now() WHERE id = %s", (order_id,))
    sync(conn, order_id, staff["id"])
    return {"ok": True, "lines": len(lines)}


class StatusIn(BaseModel):
    status: Literal["open", "ordered", "arrived", "done", "cancelled"]


@router.post("/parts-orders/{order_id}/status")
def set_status(order_id: int, body: StatusIn, conn=Depends(get_conn), staff=Depends(require_parts_editor)):
    """Hand out ("done"), undo a hand-out (any open status: the lines decide which), or cancel. Since 0.60.0 the open
    statuses follow the lines (`sync`), so asking for one of them on an open order changes nothing."""
    order = _order(conn, order_id)
    if order["work_order_id"] and conn.execute(
            "SELECT 1 FROM work_orders WHERE id = %s AND status = 'invoiced'", (order["work_order_id"],)).fetchone():
        raise conflict("The work order is invoiced: make a credit note first")
    if order["invoice_id"]:
        raise conflict("The order is invoiced: make a credit note first")
    if body.status in ACTIVE:
        if order["status"] == "done":
            change_status(conn, order_id, "arrived", staff["id"])
        sync(conn, order_id, staff["id"])
        return {"ok": True}
    if body.status == "done" and order["status"] in ACTIVE:
        waiting = conn.execute("SELECT count(*) AS n FROM parts_order_lines WHERE order_id = %s "
                               "AND supply IN ('order', 'ordered')", (order_id,)).fetchone()["n"]
        if waiting:
            raise bad_request(f"{waiting} part(s) haven't arrived yet: mark them as arrived first")
    change_status(conn, order_id, body.status, staff["id"])
    if body.status == "cancelled" and order["work_order_id"]:
        wo_sync(conn, order["work_order_id"], staff["id"])
    return {"ok": True}


def change_status(conn, order_id: int, new: str, sid: int) -> None:
    """Change a parts order's status; "done" = hand out (stock goes down), from "done" = undo (stock back).
    Also used by invoices (routers/invoices.py): issuing hands the parts out, a credit note puts them back."""
    order = _order(conn, order_id, lock=True)
    old = order["status"]
    if old == new:
        return
    if old == "cancelled":
        raise conflict("A cancelled order can't be changed")
    lines = conn.execute("SELECT * FROM parts_order_lines WHERE order_id = %s AND part_id IS NOT NULL ORDER BY id",
                         (order_id,)).fetchall()
    if new == "done":
        if not conn.execute("SELECT 1 FROM parts_order_lines WHERE order_id = %s", (order_id,)).fetchone():
            raise bad_request("The order has no lines")
        # Take the parts out of the stock; every part must have enough.
        need = {}
        for line in lines:
            need[line["part_id"]] = need.get(line["part_id"], Decimal(0)) + line["quantity"]
        parts = {p["id"]: p for p in conn.execute(
            "SELECT id, part_number, quantity FROM parts WHERE id = ANY(%s) FOR UPDATE", (list(need),)).fetchall()}
        short = [f"{parts[pid]['part_number']} ({_fmt_qty(parts[pid]['quantity'])} in stock, {_fmt_qty(n)} needed)"
                 for pid, n in need.items() if parts[pid]["quantity"] < n]
        if short:
            raise bad_request("Not enough in stock: " + ", ".join(short)
                              + ". Mark ordered parts as arrived (or count the stock) first.")
        for line in lines:
            after = parts[line["part_id"]]["quantity"] - line["quantity"]
            parts[line["part_id"]]["quantity"] = after
            _move(conn, line["part_id"], "order", -line["quantity"], after, sid,
                  reference=f"#{order['order_no']}", order_id=order_id)
            conn.execute("UPDATE parts SET quantity = %s, updated_at = now(), updated_by = %s WHERE id = %s",
                         (after, sid, line["part_id"]))
        conn.execute("UPDATE parts_orders SET status = 'done', done_at = now(), done_by = %s, updated_at = now() "
                     "WHERE id = %s", (sid, order_id))
    elif old == "done":
        if new == "cancelled":
            raise conflict("Undo the hand-out first")
        # Undo a hand-out: the parts go back into the stock.
        for line in lines:
            part = conn.execute("SELECT quantity FROM parts WHERE id = %s FOR UPDATE", (line["part_id"],)).fetchone()
            after = part["quantity"] + line["quantity"]
            _move(conn, line["part_id"], "order_return", line["quantity"], after, sid,
                  reference=f"#{order['order_no']}", order_id=order_id)
            conn.execute("UPDATE parts SET quantity = %s, updated_at = now(), updated_by = %s WHERE id = %s",
                         (after, sid, line["part_id"]))
        conn.execute("UPDATE parts_orders SET status = %s, done_at = NULL, done_by = NULL, updated_at = now() "
                     "WHERE id = %s", (new, order_id))
    else:
        conn.execute("UPDATE parts_orders SET status = %s, updated_at = now() WHERE id = %s", (new, order_id))
    event(conn, "order_status", sid, order_id=order_id, data={"from": old, "to": new})
    touch(conn, order["customer_id"])
