"""Parts orders (0.48.0): parts collected for a customer's car, with history.

Status: open → ordered (from the supplier) → arrived → done (handed out), or cancelled. Parts on an order that is not
done or cancelled count as **reserved** in the parts store; the stock goes down only when the order is marked done
(one `part_movements` row per line, kind 'order'). Undoing a hand-out puts them back ('order_return').
Lines are parts from the store (number, name, unit, price and VAT copied when added; the price can be changed) or
free text (a part that is not in the store). Only the parts team (`parts._editor`) changes orders.
"""
from decimal import Decimal
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..common import bad_request, cap_name, conflict, not_found
from ..db import get_conn
from .customers import ORDERS_SELECT, EVENTS_SELECT, _names, event, require_register, touch
from ..auth import require_staff
from .parts import CENT, MAX_PRICE, MAX_QTY, _clean, _editor as _parts_editor, _fmt_qty, _move, require_parts_editor

router = APIRouter(tags=["parts orders"])

ACTIVE = ("open", "ordered", "arrived")
LIST_LIMIT = 200


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
                conn=Depends(get_conn), _staff=Depends(require_register)):
    where, params = [], []
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
    counts = conn.execute("SELECT status, count(*) AS n FROM parts_orders GROUP BY status").fetchall()
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
    return {**order, **extra, "lines": lines, "total_ex": total_ex.quantize(CENT),
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
        # The same part again: add to that line instead of a second one.
        same = conn.execute("SELECT id, quantity FROM parts_order_lines WHERE order_id = %s AND part_id = %s",
                            (order_id, part["id"])).fetchone()
        if same:
            conn.execute("UPDATE parts_order_lines SET quantity = quantity + %s WHERE id = %s", (qty, same["id"]))
            line_id = same["id"]
        else:
            price = body.unit_price.quantize(CENT) if body.unit_price is not None else part["sale_price"]
            line_id = conn.execute(
                """INSERT INTO parts_order_lines (order_id, part_id, part_number, name, unit, quantity, unit_price,
                                                  vat_rate, created_by)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                (order_id, part["id"], part["part_number"], part["name"], part["unit"], qty, price,
                 body.vat_rate if body.vat_rate is not None else part["vat_rate"], staff["id"])).fetchone()["id"]
        number = part["part_number"]
    else:
        name = cap_name(_clean(body.name, 200) or "") or None
        if not name:
            raise bad_request("A line needs a part from the store or a name")
        number = (_clean(body.part_number, 60) or "").upper() or None
        line_id = conn.execute(
            """INSERT INTO parts_order_lines (order_id, part_number, name, quantity, unit_price, vat_rate, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (order_id, number, name, qty, body.unit_price.quantize(CENT) if body.unit_price is not None else None,
             body.vat_rate if body.vat_rate is not None else Decimal(25), staff["id"])).fetchone()["id"]
    event(conn, "order_line_added", staff["id"], order_id=order_id,
          data={"part_number": number, "quantity": qty, "free_text": not body.part_id})
    conn.execute("UPDATE parts_orders SET updated_at = now() WHERE id = %s", (order_id,))
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
    conn.execute("UPDATE parts_order_lines SET quantity = %s, unit_price = %s WHERE id = %s", (qty, price, line_id))
    event(conn, "order_line_changed", staff["id"], order_id=order_id,
          data={"part_number": line["part_number"], "quantity_from": line["quantity"], "quantity_to": qty,
                "price_from": line["unit_price"], "price_to": price})
    conn.execute("UPDATE parts_orders SET updated_at = now() WHERE id = %s", (order_id,))
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


class StatusIn(BaseModel):
    status: Literal["open", "ordered", "arrived", "done", "cancelled"]


@router.post("/parts-orders/{order_id}/status")
def set_status(order_id: int, body: StatusIn, conn=Depends(get_conn), staff=Depends(require_parts_editor)):
    order = _order(conn, order_id)
    if order["work_order_id"] and conn.execute(
            "SELECT 1 FROM work_orders WHERE id = %s AND status = 'invoiced'", (order["work_order_id"],)).fetchone():
        raise conflict("The work order is invoiced: make a credit note first")
    change_status(conn, order_id, body.status, staff["id"])
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
                              + ". Register the parts as received (or count the stock) first.")
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
