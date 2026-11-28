"""Invoices (0.50.0): a work order's labour, parts and other charges end in an invoice (faktura) issued here.

Norwegian rules (bokføringsforskriften kap. 5, merverdiavgiftsloven, foretaksregisterloven § 10-2) followed:
- one unbroken number series (invoices and credit notes share it; max + 1 under a lock, so no gaps);
- the invoice date, the delivery date and the due date; seller's name, address and organisation number (+ "MVA" when
  registered for VAT, + "Foretaksregisteret" when registered there); buyer's name and address (org. no. for companies);
  what was delivered (quantity, unit price); VAT per rate and the total to pay; payment details (account, KID);
- never changed or deleted (database trigger, migration 048); a mistake = a credit note (kreditnota) for the whole
  invoice, after which the work order can be invoiced again. Kept at least 5 years (bokføringsloven § 13): Carbonara
  never deletes invoices, and seller / buyer / car / lines are copies, so deleting a customer never changes one.
- Parts leave the stock when the invoice is issued (the work order's parts orders are handed out); a credit note puts
  them back (the user's choice).
Invoices are in Norwegian (documents are, like the PDI order and privacy notices).
"""
import csv
import io
import math
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from ..common import bad_request, conflict, not_found, org_no
from ..config import settings
from ..db import get_conn
from ..worktime import OSLO, today
from . import customers
from .parts import require_parts_editor
from .parts_orders import change_status, sync as sync_parts_order
from .work_orders import _event, _labour, _order as _work_order, require_work_orders

router = APIRouter(tags=["invoices"])

CENT = Decimal("0.01")
UNIT_NO = {"pcs": "stk", "set": "sett", "l": "l", "m": "m", "kg": "kg"}
LIST_LIMIT = 300


def _money(x) -> Decimal:
    return Decimal(x).quantize(CENT, rounding=ROUND_HALF_UP)


def vat_on() -> bool:
    return settings.invoice_vat_registered != "off"


def fmt_account(text: str) -> Optional[str]:
    digits = "".join(ch for ch in (text or "") if ch.isdigit())
    return f"{digits[:4]}.{digits[4:6]}.{digits[6:]}" if len(digits) == 11 else None


def kid(number: int) -> str:
    """The invoice number + a MOD10 (Luhn) check digit."""
    digits = [int(d) for d in str(number)]
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 0:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return f"{number}{(10 - total % 10) % 10}"


def seller() -> dict:
    """The seller: the customer register's company (else System → Company), as printed on the invoice."""
    c = customers.company()
    return {"name": c["company"] or None, "org_no": c["org_no"], "address": c["address"], "phone": c["phone"],
            "email": c["email"], "vat_registered": vat_on(),
            "foretaksregisteret": settings.invoice_foretaksregisteret != "off",
            "bank_account": fmt_account(settings.invoice_bank_account), "footer": settings.invoice_note or None}


def _buyer(conn, customer_id: Optional[int]) -> Optional[dict]:
    if not customer_id:
        return None
    c = conn.execute("SELECT * FROM customers WHERE id = %s", (customer_id,)).fetchone()
    if not c:
        return None
    return {"name": c["name"], "customer_no": c["customer_no"], "kind": c["kind"],
            "org_no": org_no(c["org_no"]) if c["kind"] == "company" and c["org_no"] else None,
            "address": c["address"], "postal_code": c["postal_code"], "city": c["city"]}


def _line(kind: str, text: str, quantity, unit: str, unit_price, vat_rate, part_number=None, discount=None) -> dict:
    """An invoice line; `discount` = percent off the line (0.63.0), shown in its own column on the invoice."""
    q, p = Decimal(str(quantity)), _money(Decimal(str(unit_price or 0)))
    rate = Decimal(str(vat_rate if vat_on() else 0))
    d = Decimal(str(discount)) if discount else Decimal(0)
    line = {"kind": kind, "part_number": part_number, "text": text, "quantity": q, "unit": unit, "unit_price": p,
            "vat_rate": rate, "total_ex": _money(q * p * (100 - d) / 100)}
    if d:
        line["discount"] = d
    return line


def customer_discounts(conn, customer_id: Optional[int]) -> dict:
    """The customer's standing discount in percent (0.63.0): {"parts": …, "labour": …} (None = none)."""
    row = conn.execute("SELECT discount_parts, discount_labour FROM customers WHERE id = %s",
                       (customer_id,)).fetchone() if customer_id else None
    return {"parts": row["discount_parts"] if row else None, "labour": row["discount_labour"] if row else None}


def _pct_text(x) -> str:
    return f"{Decimal(x).normalize():f}".replace(".", ",")


def _total_discount(lines: list[dict], kind: Optional[str], value) -> tuple[list[dict], Decimal]:
    """A discount on the whole order ex VAT (0.63.0): a percent, or an amount in kr (never more than the lines).
    Split over the VAT rates in proportion to each rate's amount, as one "Rabatt" line per rate, so the VAT is right.
    Returns (the discount lines, the discount ex VAT)."""
    if not kind or not value:
        return [], Decimal(0)
    by_rate: dict[Decimal, Decimal] = {}
    for line in lines:
        by_rate[line["vat_rate"]] = by_rate.get(line["vat_rate"], Decimal(0)) + line["total_ex"]
    by_rate = {r: b for r, b in by_rate.items() if b > 0}
    subtotal = sum(by_rate.values(), Decimal(0))
    if subtotal <= 0:
        return [], Decimal(0)
    value = Decimal(str(value))
    amount = _money(subtotal * min(value, Decimal(100)) / 100) if kind == "percent" else min(_money(value), subtotal)
    text = f"Rabatt {_pct_text(value)} %" if kind == "percent" else "Rabatt"
    out, left = [], amount
    rates = sorted(by_rate)
    for i, r in enumerate(rates):
        share = left if i == len(rates) - 1 else _money(amount * by_rate[r] / subtotal)
        left -= share
        if share:
            label = f"{text} (mva {_pct_text(r)} %)" if len(rates) > 1 else text
            out.append({"kind": "discount", "part_number": None, "text": label, "quantity": Decimal(1), "unit": "",
                        "unit_price": -share, "vat_rate": r, "total_ex": -share})
    return out, amount


def _totals(lines: list[dict]) -> dict:
    by_rate: dict[Decimal, Decimal] = {}
    for line in lines:
        by_rate[line["vat_rate"]] = by_rate.get(line["vat_rate"], Decimal(0)) + line["total_ex"]
    vat_lines = [{"rate": r, "base": _money(b), "vat": _money(b * r / 100)} for r, b in sorted(by_rate.items()) if b or r]
    total_ex = _money(sum((line["total_ex"] for line in lines), Decimal(0)))
    vat = _money(sum((v["vat"] for v in vat_lines), Decimal(0)))
    return {"vat_lines": vat_lines, "total_ex": total_ex, "vat": vat, "total_inc": total_ex + vat}


def _seller_missing(s: dict) -> list[str]:
    missing = []
    if not s["name"]:
        missing.append("the company name (System page)")
    if not s["org_no"]:
        missing.append("the organisation number (System page)")
    if not s["address"]:
        missing.append("the company's postal address (System page)")
    return missing


def parts_billing(conn, order: dict) -> dict:
    """What an invoice for a counter sale (a parts order without a work order, 0.60.0) would hold now."""
    rows = conn.execute("SELECT * FROM parts_order_lines WHERE order_id = %s ORDER BY id", (order["id"],)).fetchall()
    cust = customer_discounts(conn, order["customer_id"])
    lines = [_line("part", p["name"], p["quantity"], UNIT_NO.get(p["unit"], p["unit"]) if p["unit"] else "stk",
                   p["unit_price"], p["vat_rate"], p["part_number"],
                   p["discount"] if p["discount"] is not None else cust["parts"]) for p in rows]
    extra, discount = _total_discount(lines, order["total_discount_kind"], order["total_discount"])
    lines += extra
    s = seller()
    missing = _seller_missing(s)
    if not order["customer_id"]:
        missing.append("the customer")
    if not rows:
        missing.append("parts on the order")
    if any(p["unit_price"] is None for p in rows):
        missing.append("a price on every line")
    if any(p["supply"] in ("order", "ordered") for p in rows):
        missing.append("parts that haven't arrived yet")
    return {"lines": lines, **_totals(lines), "missing": missing, "vat_registered": vat_on(), "seller": s,
            "customer_discount": cust, "total_discount": order["total_discount"],
            "total_discount_kind": order["total_discount_kind"], "total_discount_ex": discount}


def billing(conn, wo: dict) -> dict:
    """What an invoice for this work order would hold now: labour, parts, other charges, VAT and totals."""
    clocked = _labour(conn, [wo["id"]]).get(wo["id"], 0)
    suggested = math.ceil(clocked / 60 / 15) * 15 if clocked else 0   # rounded up to a quarter hour
    minutes = wo["billed_minutes"] if wo["billed_minutes"] is not None else suggested
    rate = wo["labour_rate"] if wo["labour_rate"] is not None else Decimal(str(settings.labour_rate or 0))
    cust = customer_discounts(conn, wo["customer_id"])
    labour_discount = wo["labour_discount"] if wo["labour_discount"] is not None else cust["labour"]
    lines = []
    if minutes:
        title = f" – {wo['title']}" if wo.get("title") else ""
        lines.append(_line("labour", f"Arbeid{title}", (Decimal(minutes) / 60).quantize(CENT), "t", rate, 25,
                           discount=labour_discount))
    parts = conn.execute(
        """SELECT l.*, o.status AS order_status FROM parts_order_lines l JOIN parts_orders o ON o.id = l.order_id
            WHERE o.work_order_id = %s AND o.status <> 'cancelled' ORDER BY o.order_no, l.id""", (wo["id"],)).fetchall()
    for p in parts:
        lines.append(_line("part", p["name"], p["quantity"], UNIT_NO.get(p["unit"], p["unit"]), p["unit_price"],
                           p["vat_rate"], p["part_number"],
                           p["discount"] if p["discount"] is not None else cust["parts"]))
    for x in wo["extra_lines"] or []:
        lines.append(_line("other", x.get("text") or "", x.get("quantity") or 1, x.get("unit") or "stk",
                           x.get("unit_price") or 0, x.get("vat_rate", 25), discount=x.get("discount")))
    extra, discount = _total_discount(lines, wo["total_discount_kind"], wo["total_discount"])
    lines += extra
    s = seller()
    missing = _seller_missing(s)
    if not wo["customer_id"]:
        missing.append("the customer")
    if minutes and not rate:
        missing.append("the hourly rate for labour")
    if any(p["supply"] in ("order", "ordered") and p["order_status"] != "done" for p in parts):
        missing.append("parts that haven't arrived yet")
    if not lines:
        missing.append("labour, parts or other charges")
    return {"clocked_seconds": clocked, "suggested_minutes": suggested, "minutes": minutes,
            "billed_minutes": wo["billed_minutes"], "rate": rate, "own_rate": wo["labour_rate"] is not None,
            "default_rate": Decimal(str(settings.labour_rate or 0)), "lines": lines, **_totals(lines),
            "missing": missing, "vat_registered": vat_on(), "seller": s,
            "customer_discount": cust, "labour_discount": labour_discount, "own_labour_discount": wo["labour_discount"] is not None,
            "total_discount": wo["total_discount"], "total_discount_kind": wo["total_discount_kind"],
            "total_discount_ex": discount}


def _next_number(conn) -> int:
    conn.execute("SELECT pg_advisory_xact_lock(hashtext('invoice_no'))")  # one series, no gaps
    n = conn.execute("SELECT max(number) AS n FROM invoices").fetchone()["n"] or 0
    return max(n + 1, settings.invoice_number_start)


def _jsonb(value):
    import json
    return Jsonb(value, dumps=lambda o: json.dumps(o, default=str))


class IssueIn(BaseModel):
    note: Optional[str] = Field(None, max_length=1000)


@router.post("/work-orders/{wo_id}/invoice", status_code=201)
def issue(wo_id: int, body: IssueIn, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    wo = _work_order(conn, wo_id, lock=True)
    if wo["status"] != "done":
        raise conflict("Mark the work as done before invoicing")
    b = billing(conn, wo)
    if b["missing"]:
        raise bad_request("Missing before invoicing: " + ", ".join(b["missing"]))
    sid = staff["id"]
    # Parts leave the stock now (refused when a part has too little: nothing is saved then).
    handed = []
    for po in conn.execute("SELECT id, status FROM parts_orders WHERE work_order_id = %s AND status <> 'cancelled'",
                           (wo_id,)).fetchall():
        if not conn.execute("SELECT 1 FROM parts_order_lines WHERE order_id = %s", (po["id"],)).fetchone():
            continue
        if po["status"] != "done":
            change_status(conn, po["id"], "done", sid)
            handed.append(po["id"])
    number = _next_number(conn)
    issued = today()
    delivered = wo["done_at"].astimezone(OSLO).date() if wo["done_at"] else issued
    car = conn.execute(
        """SELECT coalesce(cc.registration_number, v.registration_number) AS registration_number,
                  coalesce(cc.make, v.make) AS make, coalesce(cc.model, v.model) AS model, coalesce(cc.vin, v.vin) AS vin
             FROM work_orders w LEFT JOIN vehicles v ON v.id = w.vehicle_id
             LEFT JOIN customer_cars cc ON cc.id = w.customer_car_id WHERE w.id = %s""", (wo_id,)).fetchone()
    row = conn.execute(
        """INSERT INTO invoices (number, kind, work_order_id, customer_id, issue_date, delivery_date, due_date, seller,
                                 buyer, car, lines, vat_lines, total_ex, vat, total_inc, kid, note, parts_order_ids,
                                 created_by)
           VALUES (%s, 'invoice', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
        (number, wo_id, wo["customer_id"], issued, delivered, issued + timedelta(days=settings.invoice_due_days),
         _jsonb(b["seller"]), _jsonb(_buyer(conn, wo["customer_id"])),
         _jsonb({**car, "km": wo["km"], "work_order": wo["number"]}), _jsonb(b["lines"]), _jsonb(b["vat_lines"]),
         b["total_ex"], b["vat"], b["total_inc"], kid(number) if settings.invoice_kid == "on" else None,
         (body.note or "").strip() or None, handed, sid)).fetchone()
    conn.execute("UPDATE work_orders SET status = 'invoiced', invoice_id = %s, updated_at = now(), updated_by = %s "
                 "WHERE id = %s", (row["id"], sid, wo_id))
    _event(conn, wo_id, "invoiced", sid, {"invoice_id": row["id"], "number": number, "total_inc": b["total_inc"]})
    customers.touch(conn, wo["customer_id"])
    return {"id": row["id"], "number": number}


@router.post("/parts-orders/{order_id}/invoice", status_code=201)
def issue_parts(order_id: int, body: IssueIn, conn=Depends(get_conn), staff=Depends(require_parts_editor)):
    """Invoice a counter sale (0.60.0): the parts are handed out (out of the stock) and the order is locked; a credit
    note puts them back, as for work orders."""
    order = conn.execute("SELECT * FROM parts_orders WHERE id = %s FOR UPDATE", (order_id,)).fetchone()
    if not order:
        raise not_found("Parts order")
    if order["work_order_id"]:
        raise conflict("This parts order belongs to a work order: invoice the work order")
    if order["invoice_id"]:
        raise conflict("The order is already invoiced")
    if order["status"] == "cancelled":
        raise conflict("A cancelled order can't be invoiced")
    b = parts_billing(conn, order)
    if b["missing"]:
        raise bad_request("Missing before invoicing: " + ", ".join(b["missing"]))
    sid = staff["id"]
    if order["status"] != "done":
        change_status(conn, order_id, "done", sid)   # refused (nothing saved) when a part has too little stock
    number = _next_number(conn)
    issued = today()
    car = {"parts_order": order["order_no"]}
    if order["car_id"]:
        cc = conn.execute("SELECT registration_number, make, model, vin FROM customer_cars WHERE id = %s",
                          (order["car_id"],)).fetchone()
        car.update(cc or {})
    row = conn.execute(
        """INSERT INTO invoices (number, kind, customer_id, issue_date, delivery_date, due_date, seller, buyer, car,
                                 lines, vat_lines, total_ex, vat, total_inc, kid, note, parts_order_ids, created_by)
           VALUES (%s, 'invoice', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
        (number, order["customer_id"], issued, issued, issued + timedelta(days=settings.invoice_due_days),
         _jsonb(b["seller"]), _jsonb(_buyer(conn, order["customer_id"])), _jsonb(car), _jsonb(b["lines"]),
         _jsonb(b["vat_lines"]), b["total_ex"], b["vat"], b["total_inc"],
         kid(number) if settings.invoice_kid == "on" else None, (body.note or "").strip() or None, [order_id],
         sid)).fetchone()
    conn.execute("UPDATE parts_orders SET invoice_id = %s, updated_at = now() WHERE id = %s", (row["id"], order_id))
    customers.event(conn, "order_invoiced", sid, order_id=order_id,
                    data={"invoice_id": row["id"], "number": number, "total_inc": b["total_inc"]})
    customers.touch(conn, order["customer_id"])
    return {"id": row["id"], "number": number}


def _invoice(conn, invoice_id: int) -> dict:
    row = conn.execute("SELECT * FROM invoices WHERE id = %s", (invoice_id,)).fetchone()
    if not row:
        raise not_found("Invoice")
    return row


class CreditIn(BaseModel):
    reason: Optional[str] = Field(None, max_length=500)


@router.post("/invoices/{invoice_id}/credit", status_code=201)
def credit(invoice_id: int, body: CreditIn, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    """A credit note for the whole invoice: the parts go back into the stock and the work order can be changed and
    invoiced again."""
    inv = conn.execute("SELECT * FROM invoices WHERE id = %s FOR UPDATE", (invoice_id,)).fetchone()
    if not inv:
        raise not_found("Invoice")
    if inv["kind"] != "invoice":
        raise conflict("A credit note can't be credited")
    if conn.execute("SELECT 1 FROM invoices WHERE credits_invoice_id = %s", (invoice_id,)).fetchone():
        raise conflict("This invoice has already been credited")
    sid = staff["id"]
    for po in inv["parts_order_ids"] or []:
        row = conn.execute("SELECT status, invoice_id FROM parts_orders WHERE id = %s", (po,)).fetchone()
        if not row:
            continue
        if row["status"] == "done":
            change_status(conn, po, "arrived", sid)
        if row["invoice_id"] == invoice_id:   # a counter sale: open again, can be changed and invoiced again
            conn.execute("UPDATE parts_orders SET invoice_id = NULL, updated_at = now() WHERE id = %s", (po,))
            customers.event(conn, "order_credited", sid, order_id=po,
                            data={"invoice_id": invoice_id, "number": inv["number"]})
        sync_parts_order(conn, po, sid)   # the open status follows the lines again (0.60.0)
    neg = lambda x: -Decimal(str(x))  # noqa: E731
    lines = [{**ln, "quantity": neg(ln["quantity"]), "total_ex": neg(ln["total_ex"])} for ln in inv["lines"]]
    vat_lines = [{**v, "base": neg(v["base"]), "vat": neg(v["vat"])} for v in inv["vat_lines"]]
    number = _next_number(conn)
    issued = today()
    row = conn.execute(
        """INSERT INTO invoices (number, kind, credits_invoice_id, work_order_id, customer_id, issue_date,
                                 delivery_date, due_date, seller, buyer, car, lines, vat_lines, total_ex, vat,
                                 total_inc, note, created_by)
           VALUES (%s, 'credit_note', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           RETURNING id""",
        (number, invoice_id, inv["work_order_id"], inv["customer_id"], issued, inv["delivery_date"], issued,
         _jsonb(inv["seller"]), _jsonb(inv["buyer"]), _jsonb(inv["car"]), _jsonb(lines), _jsonb(vat_lines),
         -inv["total_ex"], -inv["vat"], -inv["total_inc"], (body.reason or "").strip() or None, sid)).fetchone()
    if inv["work_order_id"]:
        conn.execute("UPDATE work_orders SET status = 'done', invoice_id = NULL, updated_at = now(), updated_by = %s "
                     "WHERE id = %s AND invoice_id = %s", (sid, inv["work_order_id"], invoice_id))
        _event(conn, inv["work_order_id"], "credited", sid,
               {"invoice_id": invoice_id, "number": inv["number"], "credit_note_id": row["id"],
                "credit_note_number": number})
    return {"id": row["id"], "number": number}


class PaidIn(BaseModel):
    paid_at: Optional[str] = None   # ISO date; empty = not paid


@router.put("/invoices/{invoice_id}/paid")
def set_paid(invoice_id: int, body: PaidIn, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    """Record (or remove) the payment. The only change an issued invoice allows."""
    inv = _invoice(conn, invoice_id)
    if inv["kind"] != "invoice":
        raise conflict("A credit note isn't paid")
    try:
        paid = date.fromisoformat(body.paid_at) if body.paid_at else None
    except ValueError:
        raise bad_request("Check the date")
    conn.execute("UPDATE invoices SET paid_at = %s, paid_by = %s, paid_marked_at = now() WHERE id = %s",
                 (paid, staff["id"] if paid else None, invoice_id))
    return {"id": invoice_id}


LIST_SELECT = """SELECT i.id, i.number, i.kind, i.issue_date, i.due_date, i.total_ex, i.vat, i.total_inc, i.paid_at,
                        i.work_order_id, i.credits_invoice_id, i.buyer->>'name' AS buyer_name,
                        i.buyer->>'customer_no' AS customer_no, i.car->>'registration_number' AS registration_number,
                        (i.car->>'work_order') AS work_order_number, (i.car->>'parts_order') AS parts_order_number,
                        (SELECT c.number FROM invoices c WHERE c.credits_invoice_id = i.id) AS credited_by_number,
                        (SELECT c.number FROM invoices c WHERE c.id = i.credits_invoice_id) AS credits_number
                   FROM invoices i"""


@router.get("/invoices")
def list_invoices(show: Literal["unpaid", "paid", "all"] = "all", q: str = "", conn=Depends(get_conn),
                  _staff=Depends(require_work_orders)):
    where, params = [], []
    open_sql = ("i.kind = 'invoice' AND i.paid_at IS NULL "
                "AND NOT EXISTS (SELECT 1 FROM invoices c WHERE c.credits_invoice_id = i.id)")
    if show == "unpaid":
        where.append(open_sql)
    elif show == "paid":
        where.append("i.paid_at IS NOT NULL")
    q = q.strip()
    if q:
        digits = "".join(ch for ch in q if ch.isdigit())
        like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        key = "".join(ch for ch in q.upper() if ch.isalnum())
        conds = ["i.buyer->>'name' ILIKE %s", "i.car->>'registration_number' LIKE %s"]
        params += [like, f"%{key}%"]
        if digits:
            conds += ["i.number::text = %s", "i.buyer->>'customer_no' = %s", "i.car->>'work_order' = %s",
                      "i.car->>'parts_order' = %s"]
            params += [digits, digits, digits, digits]
        where.append("(" + " OR ".join(conds) + ")")
    rows = conn.execute(LIST_SELECT + (" WHERE " + " AND ".join(where) if where else "")
                        + f" ORDER BY i.number DESC LIMIT {LIST_LIMIT}", params).fetchall()
    unpaid = conn.execute(f"SELECT count(*) AS n, coalesce(sum(i.total_inc), 0) AS sum FROM invoices i "
                          f"WHERE {open_sql}").fetchone()
    overdue = conn.execute(f"SELECT count(*) AS n FROM invoices i WHERE {open_sql} AND i.due_date < %s",
                           (today(),)).fetchone()
    return {"invoices": rows, "unpaid": unpaid, "overdue": overdue["n"], "today": today()}


def _nok(x) -> str:
    return f"{Decimal(x):.2f}".replace(".", ",")


@router.get("/invoices/export")
def export(start: Optional[str] = None, end: Optional[str] = None, conn=Depends(get_conn),
           _staff=Depends(require_work_orders)):
    """Invoices and credit notes for the accountant (CSV: semicolons, decimal commas, BOM)."""
    try:
        d1 = date.fromisoformat(start) if start else today().replace(day=1)
        d2 = date.fromisoformat(end) if end else today()
    except ValueError:
        raise bad_request("Check the dates")
    rows = conn.execute(LIST_SELECT + " WHERE i.issue_date BETWEEN %s AND %s ORDER BY i.number", (d1, d2)).fetchall()
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Nummer", "Type", "Fakturadato", "Forfall", "Kunde", "Kundenr", "Reg.nr", "Arbeidsordre", "Delebestilling",
                "Eks. mva", "Mva", "Inkl. mva", "Betalt", "Krediterer"])
    for r in rows:
        w.writerow([r["number"], "Faktura" if r["kind"] == "invoice" else "Kreditnota",
                    r["issue_date"].strftime("%d.%m.%Y"), r["due_date"].strftime("%d.%m.%Y"), r["buyer_name"] or "",
                    r["customer_no"] or "", r["registration_number"] or "", r["work_order_number"] or "", r["parts_order_number"] or "",
                    _nok(r["total_ex"]), _nok(r["vat"]), _nok(r["total_inc"]),
                    r["paid_at"].strftime("%d.%m.%Y") if r["paid_at"] else "", r["credits_number"] or ""])
    name = f"invoices-{d1.isoformat()}-{d2.isoformat()}.csv"
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


@router.get("/invoices/{invoice_id}")
def get_invoice(invoice_id: int, conn=Depends(get_conn), _staff=Depends(require_work_orders)):
    inv = _invoice(conn, invoice_id)
    extra = conn.execute(
        """SELECT cs.name AS created_by_name, ps.name AS paid_by_name,
                  (SELECT c.id FROM invoices c WHERE c.credits_invoice_id = i.id) AS credited_by_id,
                  (SELECT c.number FROM invoices c WHERE c.credits_invoice_id = i.id) AS credited_by_number,
                  o.number AS credits_number, o.issue_date AS credits_issue_date
             FROM invoices i LEFT JOIN staff cs ON cs.id = i.created_by LEFT JOIN staff ps ON ps.id = i.paid_by
             LEFT JOIN invoices o ON o.id = i.credits_invoice_id
            WHERE i.id = %s""", (invoice_id,)).fetchone()
    return {**inv, **extra, "today": today()}


def work_order_invoices(conn, wo_id: int) -> list[dict]:
    return conn.execute(LIST_SELECT + " WHERE i.work_order_id = %s ORDER BY i.number", (wo_id,)).fetchall()
