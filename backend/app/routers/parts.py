"""Parts store (delelager, 0.47.0): spare parts with part number, name, prices, shelf location and stock count.

Prices are stored per unit **ex VAT** (cost = purchase price, sale = sales price); the sales price with VAT is worked
out from the part's vat_rate (25 % by default). Every change of the stock is a row in part_movements (received, taken
out, counted, imported), so the count can always be explained; price changes are logged there too.

Who: the page is the top-menu item "parts". The cost price, the margin, the stock value and every change are only for
admins and people whose team has that menu item (`_editor`); this is checked here, not only in the app.

Import: a CSV (comma / semicolon / tab) or Excel (.xlsx) file, e.g. a supplier's price list or a list from an old
system. Parts are matched by part number (ignoring spaces, dashes and dots). Only the cells that have a value change a
part; new part numbers are added when the person asks for it; quantities in the file set the stock only when asked.
"""
import csv
import io
import json
import re
from decimal import Decimal, InvalidOperation
from typing import Literal, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from ..auth import require_staff
from ..common import bad_request, cap_name, conflict, not_found, patch_fields, update_row
from ..db import get_conn

router = APIRouter(tags=["parts"])

UNITS = ("pcs", "set", "l", "m", "kg")
MAX_BYTES = 20 * 1024 * 1024
MAX_ROWS = 100_000
LIST_LIMIT = 200
CENT = Decimal("0.01")
MAX_QTY = Decimal(1_000_000)
MAX_PRICE = Decimal(10_000_000)


def part_key(text: Optional[str]) -> str:
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper())


def _editor(staff: dict) -> bool:
    """Admins and the parts team (team with the "parts" menu item) see cost prices and may change parts."""
    return bool(staff.get("is_admin") or "parts" in (staff.get("menu") or []))


def require_parts_editor(staff: dict = Depends(require_staff)) -> dict:
    if not _editor(staff):
        raise HTTPException(403, "Only the parts team or an administrator can do this")
    return staff


def _clean(text: Optional[str], n: int) -> Optional[str]:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text[:n] or None


def _out(row: dict, editor: bool) -> dict:
    """A part for the app: sales price with VAT and the margin worked out; cost only for the parts team."""
    r = dict(row)
    sale, cost = r.get("sale_price"), r.get("cost_price")
    vat = r.get("vat_rate") if r.get("vat_rate") is not None else Decimal(25)
    r["sale_price_inc"] = (sale * (1 + vat / 100)).quantize(CENT) if sale is not None else None
    r["margin_pct"] = (round(float((sale - cost) / sale * 100), 1)
                       if editor and sale and cost is not None else None)
    r["low"] = bool(r.get("min_quantity") and r["quantity"] <= r["min_quantity"])
    for k in ("part_key", "created_by", "updated_by", "deleted_at", "deleted_by"):
        r.pop(k, None)
    if not editor:
        r.pop("cost_price", None)
    return r


PART_COLS = """p.id, p.part_number, p.part_key, p.name, p.make, p.supplier, p.location, p.unit, p.quantity,
               p.min_quantity, p.cost_price, p.sale_price, p.vat_rate, p.note, p.created_at, p.updated_at"""

# Parts on parts orders that are not handed out or cancelled yet (routers/parts_orders.py).
# Reserved = on the shelf for an open order: lines taken from stock or arrived (0.60.0: lines still to order / ordered
# aren't on the shelf yet, so they don't hold back the stock).
RESERVED_SQL = """(SELECT coalesce(sum(l.quantity), 0) FROM parts_order_lines l JOIN parts_orders o ON o.id = l.order_id
                    WHERE l.part_id = p.id AND o.status IN ('open', 'ordered', 'arrived')
                      AND l.supply IN ('stock', 'arrived'))"""


def _move(conn, part_id: int, kind: str, change, after, staff_id, *, unit_cost=None, reference=None, note=None,
          data=None, order_id=None) -> None:
    conn.execute(
        """INSERT INTO part_movements (part_id, kind, change, quantity_after, unit_cost, reference, note, data,
                                       created_by, order_id)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (part_id, kind, change, after, unit_cost, reference, note,
         Jsonb(data, dumps=lambda o: json.dumps(o, default=str)) if data else None, staff_id, order_id))


def _price_change(conn, part: dict, new: dict, staff_id) -> None:
    """Log a changed sales or cost price in the part's history."""
    data = {}
    for f, short in (("sale_price", "sale"), ("cost_price", "cost")):
        if f in new and new[f] != part.get(f):
            data[f"{short}_from"], data[f"{short}_to"] = part.get(f), new[f]
    if data:
        _move(conn, part["id"], "price", 0, part["quantity"], staff_id, data=data)


# --------------------------------------------------------------------------- #
# list, one part, export
# --------------------------------------------------------------------------- #

def _where(q: str, show: str, make: str) -> tuple[list[str], list]:
    where, params = ["p.deleted_at IS NULL"], []
    for tok in q.split()[:6]:
        like = "%" + re.sub(r"([%_\\])", r"\\\1", tok) + "%"
        k = part_key(tok)
        conds = ["p.name ILIKE %s", "p.make ILIKE %s", "p.supplier ILIKE %s", "p.location ILIKE %s", "p.note ILIKE %s"]
        params += [like] * len(conds)
        if k:
            conds.append("p.part_key LIKE %s")
            params.append(f"%{k}%")
        where.append("(" + " OR ".join(conds) + ")")
    if show == "stock":
        where.append("p.quantity > 0")
    elif show == "low":
        where.append("p.min_quantity > 0 AND p.quantity <= p.min_quantity")
    elif show == "out":
        where.append("p.quantity <= 0")
    if make:
        where.append("lower(p.make) = lower(%s)")
        params.append(make)
    return where, params


@router.get("/parts")
def list_parts(request: Request, q: str = "", show: Literal["all", "stock", "low", "out"] = "all", make: str = "",
               conn=Depends(get_conn)):
    editor = _editor(request.state.staff)
    where, params = _where(q, show, make)
    qk = part_key(q.strip()) if len(q.split()) == 1 else ""
    rows = conn.execute(
        f"""SELECT {PART_COLS}, {RESERVED_SQL} AS reserved, count(*) OVER () AS total
              FROM parts p WHERE {' AND '.join(where)}
             ORDER BY (p.part_key = %s) DESC, (%s <> '' AND p.part_key LIKE %s) DESC, p.part_key
             LIMIT {LIST_LIMIT}""",
        [*params, qk, qk, qk + "%"]).fetchall()
    stats = conn.execute(
        """SELECT count(*) AS parts,
                  count(*) FILTER (WHERE min_quantity > 0 AND quantity <= min_quantity) AS low,
                  count(*) FILTER (WHERE quantity <= 0) AS out_of_stock,
                  coalesce(sum(quantity * cost_price) FILTER (WHERE quantity > 0), 0) AS stock_value,
                  count(*) FILTER (WHERE quantity > 0 AND cost_price IS NULL) AS no_cost
             FROM parts WHERE deleted_at IS NULL""").fetchone()
    if not editor:
        stats.pop("stock_value")
        stats.pop("no_cost")
    makes = [r["make"] for r in conn.execute(
        """SELECT min(make) AS make FROM parts WHERE deleted_at IS NULL AND make IS NOT NULL
            GROUP BY lower(make) ORDER BY lower(min(make))""").fetchall()]
    return {
        "parts": [_out(r, editor) for r in rows],
        "total": rows[0]["total"] if rows else 0,
        "limit": LIST_LIMIT,
        "stats": stats,
        "makes": makes,
        "editor": editor,
    }


@router.get("/parts/imports")
def list_imports(conn=Depends(get_conn), _staff=Depends(require_parts_editor)):
    return conn.execute(
        """SELECT i.*, s.name AS imported_by_name FROM part_imports i LEFT JOIN staff s ON s.id = i.imported_by
            ORDER BY i.imported_at DESC LIMIT 20""").fetchall()


def _csv_num(value) -> str:
    return "" if value is None else str(value).replace(".", ",")


def _csv_text(value) -> str:
    """Text for Excel: a cell starting with = + - @ would run as a formula, so it gets a leading apostrophe."""
    text = value or ""
    return "'" + text if text[:1] in ("=", "+", "-", "@") else text


@router.get("/parts/export")
def export_parts(request: Request, q: str = "", show: Literal["all", "stock", "low", "out"] = "all", make: str = "",
                 conn=Depends(get_conn)):
    """The parts (with the page's search and filter) as a CSV for Excel: semicolons, decimal commas, UTF-8 with BOM."""
    editor = _editor(request.state.staff)
    where, params = _where(q, show, make)
    rows = conn.execute(f"SELECT {PART_COLS} FROM parts p WHERE {' AND '.join(where)} ORDER BY p.part_key",
                        params).fetchall()
    out = io.StringIO()
    w = csv.writer(out, delimiter=";")
    head = ["part_number", "name", "make", "supplier", "location", "unit", "quantity", "min_quantity"]
    if editor:
        head.append("cost_price_ex_vat")
    head += ["price_ex_vat", "price_inc_vat", "vat_rate", "note"]
    w.writerow(head)
    for row in rows:
        r = _out(row, editor)
        line = [_csv_text(r["part_number"]), _csv_text(r["name"]), _csv_text(r["make"]), _csv_text(r["supplier"]),
                _csv_text(r["location"]), r["unit"],
                _csv_num(r["quantity"]), _csv_num(r["min_quantity"])]
        if editor:
            line.append(_csv_num(r["cost_price"]))
        line += [_csv_num(r["sale_price"]), _csv_num(r["sale_price_inc"]), _csv_num(r["vat_rate"]), _csv_text(r["note"])]
        w.writerow(line)
    return Response(chr(0xFEFF) + out.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="parts.csv"', "Cache-Control": "no-store"})


def _get(conn, part_id: int, lock: bool = False) -> dict:
    row = conn.execute(f"SELECT {PART_COLS} FROM parts p WHERE p.id = %s AND p.deleted_at IS NULL"
                       + (" FOR UPDATE" if lock else ""), (part_id,)).fetchone()
    if not row:
        raise not_found("Part")
    return row


@router.get("/parts/{part_id}")
def get_part(part_id: int, request: Request, conn=Depends(get_conn)):
    editor = _editor(request.state.staff)
    part = _out(_get(conn, part_id), editor)
    part["reserved"] = conn.execute(f"SELECT {RESERVED_SQL} AS n FROM parts p WHERE p.id = %s",
                                    (part_id,)).fetchone()["n"]
    moves = conn.execute(
        """SELECT m.id, m.kind, m.change, m.quantity_after, m.unit_cost, m.reference, m.note, m.data, m.created_at,
                  s.name AS staff_name, m.order_id, po.order_no
             FROM part_movements m LEFT JOIN staff s ON s.id = m.created_by
             LEFT JOIN parts_orders po ON po.id = m.order_id
            WHERE m.part_id = %s ORDER BY m.created_at DESC, m.id DESC LIMIT 100""", (part_id,)).fetchall()
    if not editor:  # purchase prices are for the parts team only
        moves = [{**m, "unit_cost": None, "data": None} for m in moves if m["kind"] != "price"]
    return {**part, "movements": moves}


# --------------------------------------------------------------------------- #
# add, edit, delete
# --------------------------------------------------------------------------- #

Money = Optional[Decimal]


class PartIn(BaseModel):
    part_number: str = Field(min_length=1, max_length=60)
    name: str = Field(min_length=1, max_length=200)
    make: Optional[str] = Field(None, max_length=60)
    supplier: Optional[str] = Field(None, max_length=100)
    location: Optional[str] = Field(None, max_length=60)
    unit: Literal["pcs", "set", "l", "m", "kg"] = "pcs"
    quantity: Decimal = Field(Decimal(0), ge=0, le=MAX_QTY)
    min_quantity: Money = Field(None, ge=0, le=MAX_QTY)
    cost_price: Money = Field(None, ge=0, le=MAX_PRICE)
    sale_price: Money = Field(None, ge=0, le=MAX_PRICE)
    vat_rate: Decimal = Field(Decimal(25), ge=0, le=100)
    note: Optional[str] = Field(None, max_length=1000)


class PartPatch(BaseModel):
    part_number: Optional[str] = Field(None, min_length=1, max_length=60)
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    make: Optional[str] = Field(None, max_length=60)
    supplier: Optional[str] = Field(None, max_length=100)
    location: Optional[str] = Field(None, max_length=60)
    unit: Optional[Literal["pcs", "set", "l", "m", "kg"]] = None
    min_quantity: Money = Field(None, ge=0, le=MAX_QTY)
    cost_price: Money = Field(None, ge=0, le=MAX_PRICE)
    sale_price: Money = Field(None, ge=0, le=MAX_PRICE)
    vat_rate: Optional[Decimal] = Field(None, ge=0, le=100)
    note: Optional[str] = Field(None, max_length=1000)


TEXT_LIMITS = {"part_number": 60, "name": 200, "make": 60, "supplier": 100, "location": 60, "note": 1000}


def _tidy(fields: dict) -> dict:
    for f, n in TEXT_LIMITS.items():
        if f in fields:
            fields[f] = _clean(fields[f], n) if f != "note" else (str(fields[f] or "").strip()[:n] or None)
    # Part numbers in capital letters; names with a capital first letter, also after a space or "-".
    if fields.get("part_number"):
        fields["part_number"] = fields["part_number"].upper()
    if fields.get("name"):
        fields["name"] = cap_name(fields["name"])
    for f in ("min_quantity", "cost_price", "sale_price", "vat_rate"):
        if fields.get(f) is not None:
            fields[f] = Decimal(fields[f]).quantize(CENT)
    return fields


def _check_number(conn, key: str, exclude: Optional[int] = None) -> None:
    if not key:
        raise bad_request("The part number needs letters or digits")
    other = conn.execute("SELECT part_number FROM parts WHERE part_key = %s AND deleted_at IS NULL AND id <> %s",
                         (key, exclude or 0)).fetchone()
    if other:
        raise conflict(f"Part number {other['part_number']} is already in the parts store")


@router.post("/parts", status_code=201)
def create_part(body: PartIn, conn=Depends(get_conn), staff=Depends(require_parts_editor)):
    f = _tidy(body.model_dump())
    if not f["name"]:
        raise bad_request("The part needs a name")
    key = part_key(f["part_number"])
    _check_number(conn, key)
    qty = Decimal(f.pop("quantity")).quantize(CENT)
    row = conn.execute(
        """INSERT INTO parts (part_number, part_key, name, make, supplier, location, unit, quantity, min_quantity,
                              cost_price, sale_price, vat_rate, note, created_by, updated_by)
           VALUES (%(part_number)s, %(key)s, %(name)s, %(make)s, %(supplier)s, %(location)s, %(unit)s, %(qty)s,
                   %(min_quantity)s, %(cost_price)s, %(sale_price)s, %(vat_rate)s, %(note)s, %(by)s, %(by)s)
           RETURNING id""", {**f, "key": key, "qty": qty, "by": staff["id"]}).fetchone()
    _move(conn, row["id"], "created", qty, qty, staff["id"])
    return _out(_get(conn, row["id"]), True)


@router.patch("/parts/{part_id}")
def edit_part(part_id: int, body: PartPatch, conn=Depends(get_conn), staff=Depends(require_parts_editor)):
    part = _get(conn, part_id, lock=True)
    f = _tidy(patch_fields(body, non_nullable=("part_number", "name", "unit", "vat_rate")))
    if "name" in f and not f["name"]:
        raise bad_request("The part needs a name")
    if "part_number" in f:
        key = part_key(f["part_number"])
        _check_number(conn, key, exclude=part_id)
        f["part_key"] = key
    _price_change(conn, part, f, staff["id"])
    if f:
        f.update(updated_by=staff["id"])
        conn.execute("UPDATE parts SET updated_at = now() WHERE id = %s", (part_id,))
        update_row(conn, "parts", part_id, f)
    return _out(_get(conn, part_id), True)


@router.delete("/parts/{part_id}", status_code=204)
def delete_part(part_id: int, conn=Depends(get_conn), staff=Depends(require_parts_editor)):
    """Hidden, not removed: its history stays in the database, and the part number can be used again."""
    _get(conn, part_id, lock=True)
    conn.execute("UPDATE parts SET deleted_at = now(), deleted_by = %s WHERE id = %s", (staff["id"], part_id))


# --------------------------------------------------------------------------- #
# stock: received, taken out, counted
# --------------------------------------------------------------------------- #

class MovementIn(BaseModel):
    kind: Literal["received", "out", "count"]
    quantity: Decimal = Field(ge=0, le=MAX_QTY)   # received / out: how many; count: the number counted
    unit_cost: Money = Field(None, ge=0, le=MAX_PRICE)  # received: purchase price per unit (updates the cost price)
    reference: Optional[str] = Field(None, max_length=60)
    note: Optional[str] = Field(None, max_length=300)


def _fmt_qty(n: Decimal) -> str:
    return f"{n.normalize():f}".replace(".", ",")


@router.post("/parts/{part_id}/movements", status_code=201)
def add_movement(part_id: int, body: MovementIn, conn=Depends(get_conn), staff=Depends(require_parts_editor)):
    part = _get(conn, part_id, lock=True)
    n = body.quantity.quantize(CENT)
    have = part["quantity"]
    if body.kind != "count" and n <= 0:
        raise bad_request("Enter a quantity above 0")
    if body.kind == "received":
        change, after = n, have + n
    elif body.kind == "out":
        if n > have:
            raise bad_request(f"Only {_fmt_qty(have)} in stock. If that is wrong, count the stock first.")
        change, after = -n, have - n
    else:
        change, after = n - have, n
    unit_cost = body.unit_cost.quantize(CENT) if body.kind == "received" and body.unit_cost is not None else None
    if unit_cost is not None and unit_cost != part["cost_price"]:
        _price_change(conn, part, {"cost_price": unit_cost}, staff["id"])
        conn.execute("UPDATE parts SET cost_price = %s WHERE id = %s", (unit_cost, part_id))
    _move(conn, part_id, body.kind, change, after, staff["id"], unit_cost=unit_cost,
          reference=_clean(body.reference, 60), note=_clean(body.note, 300))
    conn.execute("UPDATE parts SET quantity = %s, updated_at = now(), updated_by = %s WHERE id = %s",
                 (after, staff["id"], part_id))
    return _out(_get(conn, part_id), True)


# --------------------------------------------------------------------------- #
# import (CSV or Excel)
# --------------------------------------------------------------------------- #

def _k(text) -> str:
    return re.sub(r"[^a-z0-9æøå]", "", str(text or "").lower())


# Column names accepted (compared in lower case without spaces / punctuation). The first match wins.
COLUMNS = {
    "part_number": ("partnumber", "partno", "partnr", "part", "delenummer", "delenr", "varenummer", "varenr",
                    "artikkelnummer", "artikkelnr", "artnr", "itemnumber", "itemno", "sku", "productnumber"),
    "name": ("name", "description", "beskrivelse", "navn", "betegnelse", "varenavn", "varetekst", "tekst",
             "delenavn", "artikkelnavn", "produktnavn"),
    "make": ("make", "merke", "brand", "fabrikat", "bilmerke"),
    "supplier": ("supplier", "leverandør", "leverandor", "vendor"),
    "location": ("location", "lokasjon", "plassering", "lagerplass", "lagerplassering", "hylle", "hylleplass", "bin",
                 "shelf"),
    "unit": ("unit", "enhet"),
    "quantity": ("quantity", "qty", "stock", "onhand", "instock", "antall", "beholdning", "lagerbeholdning",
                 "pålager", "palager"),
    "min_quantity": ("minquantity", "minimum", "min", "minstock", "minbeholdning", "minlager", "bestillingspunkt",
                     "reorderpoint"),
    "cost_price": ("costprice", "cost", "costexvat", "purchaseprice", "innpris", "innkjøpspris", "innkjopspris",
                   "nettopris", "kostpris", "netprice"),
    "sale_inc": ("priceincvat", "priceinclvat", "salepriceincvat", "incvat", "inclvat", "prisinklmva", "inklmva",
                 "utprisinklmva", "utsalgsprisinklmva", "veilprisinklmva", "veiledendeprisinklmva", "prisinkmva"),
    "sale_price": ("priceexvat", "salepriceexvat", "exvat", "prisekskmva", "prisexmva", "utprisekskmva", "eksmva",
                   "utsalgsprisekskmva", "veilprisekskmva", "price", "saleprice", "pris", "utpris", "utsalgspris",
                   "veilpris", "veiledendepris", "listprice", "listepris", "bruttopris"),
    "vat_rate": ("vatrate", "vat", "mva", "mvasats", "mvaprosent"),
    "note": ("note", "notes", "comment", "merknad", "kommentar", "notat"),
    "replaced_by": ("replacedby", "supersededby", "erstattetav", "erstatning", "nyttdelenummer", "nyttnr"),
}
REPLACED = "Replaced by "  # note on a replaced part ("Erstattet av" in Norwegian through the translator)
UNIT_WORDS = {"pcs": ("pcs", "pc", "stk", "st", "ea", "each"), "set": ("set", "sett"), "l": ("l", "ltr", "liter", "litre"),
              "m": ("m", "meter", "metre"), "kg": ("kg",)}


def _num(value, lo: Decimal = Decimal(0), hi: Decimal = MAX_PRICE) -> Optional[Decimal]:
    """A number from a cell: 1234.5 (Excel), "1 234,50", "1.234,50", "1,234.50", "249,- kr". None when missing."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        n = Decimal(str(value))
    else:
        t = re.sub(r"[^\d,.\-]", "", str(value).replace(",-", ""))
        if not re.search(r"\d", t):
            return None
        if "," in t and "." in t:  # the last one is the decimal mark
            t = t.replace(".", "").replace(",", ".") if t.rfind(",") > t.rfind(".") else t.replace(",", "")
        elif "," in t:
            t = t.replace(",", ".") if t.count(",") == 1 else t.replace(",", "")
        elif t.count(".") > 1 or re.search(r"\.\d{3}$", t):
            t = t.replace(".", "")  # 1.234 = one thousand two hundred thirty-four (Norwegian thousands mark)
        try:
            n = Decimal(t)
        except InvalidOperation:
            return None
    if not (lo <= n <= hi):
        return None
    return n.quantize(CENT)


def _unit(value) -> Optional[str]:
    v = _k(value)
    return next((u for u, words in UNIT_WORDS.items() if v in words), None) if v else None


# Importers' price lists as fixed-width text (.txt) without column names, one part per line:
#  A: part no. (15) | name (30) | space | price "0000344,82" | discount code (1) | replaced by (16) | its price
#  B: part no. | name | price "2.150,00" | discount code     (columns lined up with spaces)
FIXED_A = re.compile(r"^(.{15})(.{30}) (\d{7},\d{2}) (.)(.{16})(\d{7},\d{2}) *$")
FIXED_B = re.compile(r"^([^\s,]+) +(\S.*?) +(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})(?: +(\S{1,6}))? *$")
FIXED_HEADER = ["part_number", "name", "price", "replaced_by"]


def _fixed_rows(text: str) -> Optional[list[list]]:
    """Rows of a fixed-width price list (with FIXED_HEADER added), or None when the text isn't one."""
    lines = [ln.rstrip("\r") for ln in text.split("\n")]
    sample = [ln for ln in lines[:60] if ln.strip()]
    if not sample or any(c in ln for ln in sample for c in ";\t"):  # separators = a CSV file
        return None
    for pattern in (FIXED_A, FIXED_B):
        if sum(1 for ln in sample if pattern.match(ln)) < max(1, len(sample) * 0.8):
            continue
        rows = [FIXED_HEADER]
        for ln in lines:
            m = pattern.match(ln)
            if not m:
                rows.append(["", ln.strip()] if ln.strip() else [])  # no part number: counted as skipped
                continue
            price = m.group(3)
            replaced = m.group(5).strip() if pattern is FIXED_A else ""
            if not re.search(r"[1-9]", price):
                price = ""  # 0,00 = no price (often a part that has been replaced)
            rows.append([m.group(1).strip(), m.group(2).strip(), price, replaced])
        return rows
    return None


def _rows(data: bytes, name: str) -> list[list]:
    """The file's rows as lists of cell values (CSV or the first sheet of an Excel file)."""
    if data[:2] == b"PK" or name.lower().endswith((".xlsx", ".xlsm")):
        try:
            from openpyxl import load_workbook
            wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        except Exception:
            raise bad_request("The Excel file could not be read (save it as .xlsx or CSV)")
        out = []
        for row in wb.worksheets[0].iter_rows(values_only=True):
            out.append(list(row))
            if len(out) > MAX_ROWS + 20:
                break
        wb.close()
        return out
    if name.lower().endswith(".xls"):
        raise bad_request("Old Excel files (.xls) can't be read: save it as .xlsx or CSV")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252", errors="replace")
    fixed = _fixed_rows(text)
    if fixed:
        return fixed
    first = text.split("\n", 1)[0]
    delimiter = max((";", ",", "\t"), key=first.count)  # Excel in Norway saves CSV with semicolons
    return list(csv.reader(io.StringIO(text), delimiter=delimiter))


def _header(rows: list[list]) -> tuple[int, dict]:
    """The header row (one of the first 15: price lists often start with a title) and the column of each field."""
    for i, row in enumerate(rows[:15]):
        names = [_k(c) for c in row]
        index = {}
        for field, aliases in COLUMNS.items():
            for alias in aliases:
                if alias in names and names.index(alias) not in index.values():
                    index[field] = names.index(alias)
                    break
        if "part_number" in index:
            return i, index
    raise bad_request("No part number column found (e.g. \"part_number\" or \"delenummer\")")


@router.post("/parts/import", status_code=201)
async def import_parts(file: UploadFile = File(...), add_new: bool = Form(True), set_stock: bool = Form(False),
                       make: str = Form(""), price_is: Literal["sale", "cost"] = Form("sale"),
                       conn=Depends(get_conn), staff=Depends(require_parts_editor)):
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise bad_request("The file is too large")
    if not data:
        raise bad_request("The file is empty")
    rows = _rows(data, file.filename or "")
    start, index = _header(rows)
    fixed = rows[start] is FIXED_HEADER
    if fixed and price_is == "cost":  # a text price list has no column names: the person says what its price is
        index["cost_price"] = index.pop("sale_price")
    body = rows[start + 1:]
    if len(body) > MAX_ROWS:
        raise bad_request(f"The file has more than {MAX_ROWS} rows")
    file_make = _clean(make, 60)

    parsed, skipped, seen = [], 0, set()
    for raw in body:
        get = lambda f: raw[index[f]] if f in index and index[f] < len(raw) else None  # noqa: E731
        number = (_clean(get("part_number"), 60) or "").upper() or None
        key = part_key(number)
        if not key:
            if any(c not in (None, "") for c in raw):
                skipped += 1
            continue
        if key in seen:  # the same part twice in one file: the first row counts
            skipped += 1
            continue
        seen.add(key)
        vat = _num(get("vat_rate"), hi=Decimal(100))
        if vat is not None and 0 < vat < 1:
            vat = (vat * 100).quantize(CENT)  # 0.25 = 25 %
        sale = _num(get("sale_price"))
        inc = _num(get("sale_inc"))
        if sale is None and inc is not None:
            sale = (inc / (1 + (vat if vat is not None else Decimal(25)) / 100)).quantize(CENT)
        replaced = (_clean(get("replaced_by"), 60) or "").upper()
        parsed.append({
            "key": key, "part_number": number, "name": cap_name(_clean(get("name"), 200) or "") or None,
            "make": _clean(get("make"), 60) or file_make,
            "supplier": _clean(get("supplier"), 100), "location": _clean(get("location"), 60),
            "unit": _unit(get("unit")), "quantity": _num(get("quantity"), lo=Decimal(-MAX_QTY), hi=MAX_QTY),
            "min_quantity": _num(get("min_quantity"), hi=MAX_QTY), "cost_price": _num(get("cost_price")),
            "sale_price": sale, "vat_rate": vat, "note": _clean(get("note"), 1000),
            "replaced_by": replaced if part_key(replaced) and part_key(replaced) != key else None,
        })
    if not parsed:
        raise bad_request("No parts found in the file")

    existing = {r["part_key"]: r for r in conn.execute(
        f"SELECT {PART_COLS} FROM parts p WHERE p.deleted_at IS NULL AND p.part_key = ANY(%s) FOR UPDATE",
        ([p["key"] for p in parsed],)).fetchall()}
    fields = ("name", "make", "supplier", "location", "unit", "min_quantity", "cost_price", "sale_price", "vat_rate",
              "note")
    added = updated = unchanged = not_added = 0
    sid = staff["id"]
    src = _clean(file.filename, 100)
    # Big price lists (tens of thousands of parts) are written in batches, not one statement per part.
    new_rows, upd_rows, moves = [], [], []
    for p in parsed:
        old = existing.get(p["key"])
        if p["replaced_by"] and p["note"] is None and (not old or not old["note"] or old["note"].startswith(REPLACED)):
            p["note"] = REPLACED + p["replaced_by"]  # never over a note someone wrote
        if old:
            change = {f: p[f] for f in fields if p[f] is not None and p[f] != old[f]}
            qty = p["quantity"] if set_stock and p["quantity"] is not None and p["quantity"] != old["quantity"] else None
            if not change and qty is None:
                unchanged += 1
                continue
            price = {}
            for f, short in (("sale_price", "sale"), ("cost_price", "cost")):
                if f in change:
                    price[f"{short}_from"], price[f"{short}_to"] = old[f], change[f]
            if price:
                moves.append((old["id"], "price", 0, old["quantity"], None,
                              Jsonb(price, dumps=lambda o: json.dumps(o, default=str))))
            if qty is not None:
                moves.append((old["id"], "import", qty - old["quantity"], qty, src, None))
            merged = {**old, **change, "quantity": qty if qty is not None else old["quantity"]}
            upd_rows.append((*[merged[f] for f in fields], merged["quantity"], sid, old["id"]))
            updated += 1
        elif add_new:
            if not p["name"]:
                skipped += 1  # a new part needs a name
                continue
            qty = p["quantity"] if p["quantity"] is not None and p["quantity"] >= 0 else Decimal(0)
            new_rows.append((p["part_number"], p["key"], p["name"], p["make"], p["supplier"], p["location"],
                             p["unit"] or "pcs", qty, p["min_quantity"], p["cost_price"], p["sale_price"],
                             p["vat_rate"] if p["vat_rate"] is not None else Decimal(25), p["note"], sid, sid))
            added += 1
        else:
            not_added += 1  # not in Carbonara, and the person chose to update existing parts only
    with conn.cursor() as cur:
        if upd_rows:
            cur.executemany(
                f"""UPDATE parts SET {', '.join(f'{f} = %s' for f in fields)}, quantity = %s, updated_by = %s,
                                     updated_at = now() WHERE id = %s""", upd_rows)
        if new_rows:
            cur.executemany(
                """INSERT INTO parts (part_number, part_key, name, make, supplier, location, unit, quantity,
                                      min_quantity, cost_price, sale_price, vat_rate, note, created_by, updated_by)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""", new_rows)
            # One "import" line in each new part's history (the key is unique among parts not deleted).
            cur.execute(
                """INSERT INTO part_movements (part_id, kind, change, quantity_after, note, created_by)
                   SELECT p.id, 'import', p.quantity, p.quantity, %s, %s FROM parts p
                    WHERE p.deleted_at IS NULL AND p.part_key = ANY(%s)""",
                (src, sid, [r[1] for r in new_rows]))
        if moves:
            cur.executemany(
                """INSERT INTO part_movements (part_id, kind, change, quantity_after, note, data, created_by)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""", [(*m, sid) for m in moves])
    imp = conn.execute(
        """INSERT INTO part_imports (file_name, rows_read, added, updated, skipped, imported_by)
           VALUES (%s, %s, %s, %s, %s, %s) RETURNING *""",
        ((file.filename or "file")[:200], len(parsed), added, updated, skipped, sid)).fetchone()
    return {**imp, "unchanged": unchanged, "not_added": not_added, "fixed_width": fixed}
