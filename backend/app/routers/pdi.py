"""PDI orders (Pre Delivery Inspection) for new cars, sent by e-mail to the
workshop (RBV). The workshop's reply with a date/time is entered by staff."""

import datetime as dt
import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, field_validator

from .. import mailer
from ..auth import require_admin
from ..common import bad_request, conflict, log_event, not_found
from ..config import settings
from ..db import get_conn

log = logging.getLogger("carbonara.pdi")
router = APIRouter(tags=["pdi"])

TYRE_MODES = {
    "none": "Ingen vinterdekk",
    "in_stock": "Vinterdekk på lager",
    "sales_ordered": "Vinterdekk bestilt av selger",
    "rbv_orders": "Vinterdekk bestilles av verkstedet",
}


# --------------------------------------------------------------------------- #
# models
# --------------------------------------------------------------------------- #

class OrderItem(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    choice: Optional[str] = Field(None, max_length=40)


class Tyres(BaseModel):
    mode: Literal["none", "in_stock", "sales_ordered", "rbv_orders"] = "none"
    company: Optional[str] = Field(None, max_length=80)
    expected_date: Optional[dt.date] = None
    note: Optional[str] = Field(None, max_length=300)


class OrderIn(BaseModel):
    items: list[OrderItem] = Field(default_factory=list, max_length=40)
    other: Optional[str] = Field(None, max_length=1000)
    tyres: Tyres = Field(default_factory=Tyres)
    note: Optional[str] = Field(None, max_length=1000)


class SendIn(BaseModel):
    recipient_id: int
    via: Literal["smtp", "mail_app"]


class BookingIn(BaseModel):
    date: Optional[dt.date] = None   # None clears the booking
    time: Optional[str] = Field(None, pattern=r"^\d{2}:\d{2}$")


class ListIn(BaseModel):
    kind: Literal["item", "tyre_company", "recipient"]
    label: str = Field(min_length=1, max_length=80)
    email: Optional[str] = Field(None, max_length=200)
    choices: list[str] = Field(default_factory=list, max_length=10)
    is_default: bool = False

    @field_validator("choices")
    @classmethod
    def clean_choices(cls, v):
        return [c.strip()[:40] for c in v if c and c.strip()]


class ListPatch(BaseModel):
    label: Optional[str] = Field(None, min_length=1, max_length=80)
    email: Optional[str] = Field(None, max_length=200)
    choices: Optional[list[str]] = Field(None, max_length=10)
    is_default: Optional[bool] = None
    active: Optional[bool] = None


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

ORDER_SELECT = """
    SELECT o.*, (o.pdi_at AT TIME ZONE 'Europe/Oslo') AS pdi_local,
           cb.name AS created_by_name, sb.name AS sent_by_name, bb.name AS booked_by_name, db.name AS done_by_name,
           (o.sent_at IS NOT NULL AND o.updated_at > o.sent_at + interval '2 seconds') AS changed_since_sent,
           v.vin, v.make, v.model, v.model_year, v.color, v.registration_number, v.condition, v.status AS vehicle_status,
           (SELECT l.code FROM storage_assignments a JOIN storage_spots l ON l.id = a.location_id
             WHERE a.vehicle_id = v.id AND a.removed_at IS NULL) AS location_code
      FROM pdi_orders o
      JOIN vehicles v ON v.id = o.vehicle_id
      LEFT JOIN staff cb ON cb.id = o.created_by
      LEFT JOIN staff sb ON sb.id = o.sent_by
      LEFT JOIN staff bb ON bb.id = o.booked_by
      LEFT JOIN staff db ON db.id = o.done_by"""


def _me(request: Request) -> Optional[int]:
    staff = getattr(request.state, "staff", None)
    return staff["id"] if staff else None


def _order(conn, order_id: int) -> dict:
    row = conn.execute(ORDER_SELECT + " WHERE o.id = %s", (order_id,)).fetchone()
    if not row:
        raise not_found("PDI order")
    return row


def _open_order(conn, order_id: int) -> dict:
    row = conn.execute("SELECT * FROM pdi_orders WHERE id = %s FOR UPDATE", (order_id,)).fetchone()
    if not row:
        raise not_found("PDI order")
    if row["status"] in ("done", "cancelled"):
        raise conflict("This PDI order is closed")
    return row


def _fmt_date(d) -> str:
    return d.strftime("%d.%m.%Y") if d else ""


def compose(order: dict) -> tuple[str, str]:
    """The e-mail to the workshop (Norwegian)."""
    car = " ".join(str(p) for p in (order["make"], order["model"], order["model_year"]) if p) or "Bil"
    reg = order["registration_number"]
    subject = f"Bestilling av nybilklargjøring – {car} – {order['vin']}" + (f" ({reg})" if reg else "")
    lines = [
        "Hei,",
        "",
        f"{settings.privacy_company} bestiller nybilklargjøring med følgende for bilen under.",
        "",
        "BIL",
        f"  {car}",
        f"  Understellsnr. (VIN): {order['vin']}",
        f"  Reg.nr.: {reg or 'ikke registrert ennå'}",
    ]
    if order["color"]:
        lines.append(f"  Farge: {order['color']}")
    if order["location_code"]:
        lines.append(f"  Står på: {order['location_code']}")
    lines += ["", "BESTILT"]
    items = order["items"] or []
    lines += [f"  - {i['label']}" + (f": {i['choice']}" if i.get("choice") else "") for i in items] or ["  (ingen tilbehør)"]
    if order["other"]:
        lines += ["", "ANNET", *[f"  {line}" for line in order["other"].splitlines()]]
    t = order["tyres"] or {}
    mode = t.get("mode", "none")
    if mode != "none":
        lines += ["", "VINTERDEKK", f"  {TYRE_MODES[mode]}"]
        if t.get("company"):
            lines.append(f"  Dekkleverandør: {t['company']}")
        if t.get("expected_date"):
            lines.append(f"  Forventet levert: {_fmt_date(dt.date.fromisoformat(str(t['expected_date'])[:10]))}")
        if t.get("note"):
            lines.append(f"  {t['note']}")
    if order["note"]:
        lines += ["", "MERKNAD", *[f"  {line}" for line in order["note"].splitlines()]]
    lines += [
        "",
        "Vennligst svar på denne e-posten med dato og klokkeslett for nybilklargjøringen.",
        "",
        "Med vennlig hilsen",
        order.get("sender_name") or settings.privacy_company,
        settings.privacy_company,
    ]
    return subject, "\n".join(lines)


def _recipient(conn, recipient_id: int) -> dict:
    row = conn.execute("SELECT * FROM pdi_lists WHERE id = %s AND kind = 'recipient' AND active",
                       (recipient_id,)).fetchone()
    if not row:
        raise bad_request("Unknown recipient")
    return row


# --------------------------------------------------------------------------- #
# orders
# --------------------------------------------------------------------------- #

@router.get("/pdi/options")
def options(conn=Depends(get_conn)):
    rows = conn.execute("SELECT * FROM pdi_lists WHERE active ORDER BY sort, id").fetchall()
    return {
        "items": [r for r in rows if r["kind"] == "item"],
        "tyre_companies": [r for r in rows if r["kind"] == "tyre_company"],
        "recipients": [r for r in rows if r["kind"] == "recipient"],
        "tyre_modes": TYRE_MODES,
        "smtp_configured": mailer.is_configured(),
    }


@router.get("/pdi")
def list_orders(conn=Depends(get_conn)):
    """Open orders (and the last few done) with their cars."""
    open_ = conn.execute(ORDER_SELECT + """ WHERE o.status NOT IN ('done', 'cancelled') AND v.deleted_at IS NULL
                                            ORDER BY o.pdi_at NULLS LAST, o.created_at""").fetchall()
    done = conn.execute(ORDER_SELECT + """ WHERE o.status = 'done' AND v.deleted_at IS NULL
                                           ORDER BY o.done_at DESC LIMIT 10""").fetchall()
    return {"open": open_, "done": done}


@router.get("/vehicles/{vehicle_id}/pdi")
def vehicle_orders(vehicle_id: int, conn=Depends(get_conn)):
    rows = conn.execute(ORDER_SELECT + " WHERE o.vehicle_id = %s ORDER BY o.created_at DESC", (vehicle_id,)).fetchall()
    current = next((r for r in rows if r["status"] not in ("done", "cancelled")), None)
    return {"current": current, "history": [r for r in rows if r is not current]}


@router.put("/vehicles/{vehicle_id}/pdi")
def save_order(vehicle_id: int, body: OrderIn, request: Request, conn=Depends(get_conn)):
    """Create the car's open PDI order, or update it."""
    if not conn.execute("SELECT 1 FROM vehicles WHERE id = %s AND deleted_at IS NULL FOR UPDATE",
                        (vehicle_id,)).fetchone():
        raise not_found("Vehicle")
    t = body.tyres
    if t.mode == "rbv_orders" and not t.company:
        raise bad_request("Choose the tyre company the workshop should order from")
    if t.mode == "sales_ordered" and not t.expected_date:
        raise bad_request("Give the expected delivery date for the tyres")
    if t.mode in ("none", "in_stock"):
        t.expected_date = None
    fields = {
        "items": Jsonb([i.model_dump() for i in body.items]),
        "other": (body.other or "").strip() or None,
        "tyres": Jsonb(t.model_dump(mode="json")),
        "note": (body.note or "").strip() or None,
    }
    current = conn.execute(
        "SELECT id FROM pdi_orders WHERE vehicle_id = %s AND status NOT IN ('done', 'cancelled') FOR UPDATE",
        (vehicle_id,)).fetchone()
    if current:
        conn.execute("UPDATE pdi_orders SET items = %(items)s, other = %(other)s, tyres = %(tyres)s, note = %(note)s, "
                     "updated_at = now() WHERE id = %(id)s", {**fields, "id": current["id"]})
        order_id = current["id"]
    else:
        order_id = conn.execute(
            """INSERT INTO pdi_orders (vehicle_id, items, other, tyres, note, created_by)
               VALUES (%(vid)s, %(items)s, %(other)s, %(tyres)s, %(note)s, %(me)s) RETURNING id""",
            {**fields, "vid": vehicle_id, "me": _me(request)},
        ).fetchone()["id"]
    return _order(conn, order_id)


@router.get("/pdi/{order_id}/email")
def preview_email(order_id: int, recipient_id: int, request: Request, conn=Depends(get_conn)):
    order = _order(conn, order_id)
    order["sender_name"] = (getattr(request.state, "staff", None) or {}).get("name")
    subject, body = compose(order)
    return {"to": _recipient(conn, recipient_id)["email"], "subject": subject, "body": body}


@router.post("/pdi/{order_id}/send")
def send_order(order_id: int, body: SendIn, request: Request, conn=Depends(get_conn)):
    """Send by SMTP, or record that staff sent it from their own e-mail app."""
    row = _open_order(conn, order_id)
    to = _recipient(conn, body.recipient_id)["email"]
    if body.via == "smtp":
        order = _order(conn, order_id)
        order["sender_name"] = (getattr(request.state, "staff", None) or {}).get("name")
        subject, text = compose(order)
        try:
            mailer.send(to, subject, text)
        except mailer.MailError as exc:
            raise HTTPException(502, str(exc))
    conn.execute(
        """UPDATE pdi_orders SET sent_at = now(), sent_by = %s, sent_to = %s, sent_via = %s,
                  status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END
            WHERE id = %s""",
        (_me(request), to, body.via, order_id),
    )
    log_event(conn, row["vehicle_id"], "pdi_order_sent", staff_id=_me(request),
              data={"to": to, "via": body.via, "resent": row["sent_at"] is not None})
    return _order(conn, order_id)


@router.post("/pdi/{order_id}/booking")
def set_booking(order_id: int, body: BookingIn, request: Request, conn=Depends(get_conn)):
    """The workshop's reply: date and time of the PDI (entered by staff)."""
    row = _open_order(conn, order_id)
    if body.date is None:
        conn.execute("UPDATE pdi_orders SET pdi_at = NULL, booked_by = NULL, "
                     "status = CASE WHEN sent_at IS NULL THEN 'draft' ELSE 'sent' END WHERE id = %s", (order_id,))
        log_event(conn, row["vehicle_id"], "pdi_booking_cleared", staff_id=_me(request))
        return _order(conn, order_id)
    local = f"{body.date.isoformat()} {body.time or '08:00'}"
    conn.execute(
        """UPDATE pdi_orders SET pdi_at = (%s::timestamp AT TIME ZONE 'Europe/Oslo'), booked_by = %s, status = 'booked'
            WHERE id = %s""",
        (local, _me(request), order_id),
    )
    log_event(conn, row["vehicle_id"], "pdi_booked", staff_id=_me(request), data={"pdi_at": local})
    return _order(conn, order_id)


@router.post("/pdi/{order_id}/done")
def mark_done(order_id: int, request: Request, conn=Depends(get_conn)):
    row = _open_order(conn, order_id)
    conn.execute("UPDATE pdi_orders SET status = 'done', done_at = now(), done_by = %s WHERE id = %s",
                 (_me(request), order_id))
    log_event(conn, row["vehicle_id"], "pdi_done", staff_id=_me(request))
    return _order(conn, order_id)


@router.post("/pdi/{order_id}/cancel")
def cancel(order_id: int, request: Request, conn=Depends(get_conn)):
    row = _open_order(conn, order_id)
    conn.execute("UPDATE pdi_orders SET status = 'cancelled', cancelled_at = now() WHERE id = %s", (order_id,))
    if row["sent_at"]:
        log_event(conn, row["vehicle_id"], "pdi_cancelled", staff_id=_me(request))
    return _order(conn, order_id)


# --------------------------------------------------------------------------- #
# lists (Settings) – admins
# --------------------------------------------------------------------------- #

def _check_email(kind: str, email: Optional[str]) -> Optional[str]:
    if kind != "recipient":
        return None
    email = (email or "").strip()
    if "@" not in email or "." not in email.split("@")[-1] or " " in email:
        raise bad_request("Give a valid e-mail address")
    return email


@router.get("/pdi/lists")
def all_lists(conn=Depends(get_conn)):
    return conn.execute("SELECT * FROM pdi_lists ORDER BY kind, active DESC, sort, id").fetchall()


@router.post("/pdi/lists", status_code=201)
def add_list_entry(body: ListIn, conn=Depends(get_conn), _admin=Depends(require_admin)):
    email = _check_email(body.kind, body.email)
    if body.is_default and body.kind == "recipient":
        conn.execute("UPDATE pdi_lists SET is_default = false WHERE kind = 'recipient'")
    sort = conn.execute("SELECT coalesce(max(sort), 0) + 10 AS s FROM pdi_lists WHERE kind = %s",
                        (body.kind,)).fetchone()["s"]
    return conn.execute(
        """INSERT INTO pdi_lists (kind, label, email, choices, is_default, sort)
           VALUES (%s, %s, %s, %s, %s, %s) RETURNING *""",
        (body.kind, body.label.strip(), email, body.choices if body.kind == "item" else [],
         body.is_default and body.kind == "recipient", sort),
    ).fetchone()


@router.patch("/pdi/lists/{entry_id}")
def patch_list_entry(entry_id: int, body: ListPatch, conn=Depends(get_conn), _admin=Depends(require_admin)):
    row = conn.execute("SELECT * FROM pdi_lists WHERE id = %s FOR UPDATE", (entry_id,)).fetchone()
    if not row:
        raise not_found("List entry")
    fields = body.model_dump(exclude_unset=True)
    if "email" in fields:
        fields["email"] = _check_email(row["kind"], fields["email"])
    if "choices" in fields:
        fields["choices"] = [c.strip()[:40] for c in fields["choices"] or [] if c and c.strip()]
    if "label" in fields:
        fields["label"] = fields["label"].strip()
    if fields.get("is_default") and row["kind"] == "recipient":
        conn.execute("UPDATE pdi_lists SET is_default = false WHERE kind = 'recipient'")
    for key, value in fields.items():  # keys come from the model, not user input
        conn.execute(f"UPDATE pdi_lists SET {key} = %s WHERE id = %s", (value, entry_id))
    return conn.execute("SELECT * FROM pdi_lists WHERE id = %s", (entry_id,)).fetchone()
