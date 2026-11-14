"""PDI orders (Pre Delivery Inspection) for new cars, sent by e-mail to the
workshop. The workshop's reply with a date/time is entered by staff."""

import datetime as dt
import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, field_validator

from .. import mailer, pdisheet
from ..auth import require_admin
from ..common import (RIGHT_PHOTO_SQL, bad_request, conflict, log_event, not_found, place_in_location, tyre_season,
                      tyre_warning)
from ..config import settings
from ..db import get_conn
from . import pdi_sheets

log = logging.getLogger("carbonara.pdi")
router = APIRouter(tags=["pdi"])

TYRE_MODES = {
    "none": "Ingen vinterdekk",
    "in_stock": "Vinterdekk på lager",
    "sales_ordered": "Vinterdekk bestilt av selger",
    "workshop_orders": "Vinterdekk bestilles av verkstedet",
}


# --------------------------------------------------------------------------- #
# models
# --------------------------------------------------------------------------- #

class OrderItem(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    choice: Optional[str] = Field(None, max_length=40)


class Tyres(BaseModel):
    mode: Literal["none", "in_stock", "sales_ordered", "workshop_orders"] = "none"
    company: Optional[str] = Field(None, max_length=80)
    expected_date: Optional[dt.date] = None
    note: Optional[str] = Field(None, max_length=300)


class OrderIn(BaseModel):
    items: list[OrderItem] = Field(default_factory=list, max_length=40)
    other: Optional[str] = Field(None, max_length=1000)
    tyres: Tyres = Field(default_factory=Tyres)
    note: Optional[str] = Field(None, max_length=1000)


class SendIn(BaseModel):
    recipient_id: Optional[int] = None  # not used for 'print'
    via: Literal["smtp", "mail_app", "print"]


class BookingIn(BaseModel):
    date: Optional[dt.date] = None   # None clears the booking
    time: Optional[str] = Field(None, pattern=r"^\d{2}:\d{2}$")
    expected_done: Optional[dt.date] = None  # None = the day after the PDI date


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
           cf.name AS pdi_confirmed_by_name,
           (o.sent_at IS NOT NULL AND o.updated_at > o.sent_at + interval '2 seconds') AS changed_since_sent,
           v.vin, v.make, v.model, v.model_year, v.color, v.registration_number, v.condition, v.status AS vehicle_status,
           v.fuel_type, v.wheels, v.registered_marked_at,
           loc.id AS location_id, loc.code AS location_code,
           pp.name AS prep_plate_name, pb.name AS prepared_by_name
      FROM pdi_orders o
      JOIN vehicles v ON v.id = o.vehicle_id
      LEFT JOIN LATERAL (SELECT l.id, l.code FROM storage_assignments a JOIN storage_spots l ON l.id = a.location_id
                          WHERE a.vehicle_id = v.id AND a.removed_at IS NULL LIMIT 1) loc ON true
      LEFT JOIN trade_plates pp ON pp.id = o.prep_plate_id
      LEFT JOIN staff cb ON cb.id = o.created_by
      LEFT JOIN staff sb ON sb.id = o.sent_by
      LEFT JOIN staff bb ON bb.id = o.booked_by
      LEFT JOIN staff db ON db.id = o.done_by
      LEFT JOIN staff pb ON pb.id = o.prepared_by
      LEFT JOIN staff cf ON cf.id = o.pdi_confirmed_by"""


# PDIs booked or done in the current week (Monday–Sunday, Oslo time).
THIS_WEEK_SQL = """o.status IN ('booked', 'done')
    AND date_trunc('week', o.pdi_at AT TIME ZONE 'Europe/Oslo') = date_trunc('week', now() AT TIME ZONE 'Europe/Oslo')"""


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
        f"{settings.privacy_company or 'Vi'} bestiller nybilklargjøring med følgende for bilen under.",  # no company set yet: "Vi …"
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
        order.get("sender_name") or settings.privacy_company or "",
        settings.privacy_company or "",
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
        "company": settings.privacy_company,  # printed on the order sheet
    }


@router.get("/pdi")
def list_orders(conn=Depends(get_conn)):
    """Open orders, this week's PDIs (booked or done; the same as the Today
    tile counts) and the last few done, with their cars."""
    open_ = conn.execute(ORDER_SELECT + """ WHERE o.status NOT IN ('done', 'cancelled') AND v.deleted_at IS NULL
                                            ORDER BY o.pdi_at NULLS LAST, o.created_at""").fetchall()
    week = conn.execute(ORDER_SELECT + f""" WHERE {THIS_WEEK_SQL} AND v.deleted_at IS NULL
                                            ORDER BY o.pdi_at""").fetchall()
    done = conn.execute(ORDER_SELECT + """ WHERE o.status = 'done' AND v.deleted_at IS NULL
                                           ORDER BY o.done_at DESC LIMIT 10""").fetchall()
    return {"open": open_, "week": week, "done": done}


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
    if t.mode == "workshop_orders" and not t.company:
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
    """Send by SMTP, or record that staff sent it from their own e-mail app, or
    printed it / saved it as a PDF for the workshop (via 'print', no address)."""
    row = _open_order(conn, order_id)
    if body.via == "print":
        to = None
    elif body.recipient_id is None:
        raise bad_request("Choose who to send it to")
    else:
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
        conn.execute("UPDATE pdi_orders SET pdi_at = NULL, booked_by = NULL, expected_done_date = NULL, "
                     "pdi_confirmed_at = NULL, pdi_confirmed_by = NULL, "
                     "status = CASE WHEN sent_at IS NULL THEN 'draft' ELSE 'sent' END WHERE id = %s", (order_id,))
        log_event(conn, row["vehicle_id"], "pdi_booking_cleared", staff_id=_me(request))
        return _order(conn, order_id)
    expected = body.expected_done or body.date + dt.timedelta(days=1)
    if expected < body.date:
        raise bad_request("The expected completion date can't be before the PDI date")
    local = f"{body.date.isoformat()} {body.time or '08:00'}"
    # A new date or time needs a new confirmation; the same one keeps it.
    conn.execute(
        """UPDATE pdi_orders o SET pdi_at = x.at, booked_by = %s, status = 'booked', expected_done_date = %s,
                  pdi_confirmed_at = CASE WHEN o.pdi_at = x.at THEN o.pdi_confirmed_at END,
                  pdi_confirmed_by = CASE WHEN o.pdi_at = x.at THEN o.pdi_confirmed_by END
             FROM (SELECT (%s::timestamp AT TIME ZONE 'Europe/Oslo') AS at) x
            WHERE o.id = %s""",
        (_me(request), expected, local, order_id),
    )
    log_event(conn, row["vehicle_id"], "pdi_booked", staff_id=_me(request),
              data={"pdi_at": local, "expected_done": expected})
    return _order(conn, order_id)


class WorkOrderIn(BaseModel):
    work_order: str = Field(max_length=40)


def _work_order(text: str) -> str:
    value = " ".join(text.split())
    if not value:
        raise bad_request("Enter the work order number")
    return value


@router.post("/pdi/{order_id}/confirm")
def confirm_date(order_id: int, body: WorkOrderIn, request: Request, conn=Depends(get_conn)):
    """Confirm the PDI date (e.g. the workshop agrees to it), with the workshop's
    work order number. A new date clears the confirmation (the number stays)."""
    row = _open_order(conn, order_id)
    if row["status"] != "booked" or row["pdi_at"] is None:
        raise conflict("Enter the PDI date first")
    work_order = _work_order(body.work_order)
    conn.execute("UPDATE pdi_orders SET pdi_confirmed_at = now(), pdi_confirmed_by = %s, work_order = %s "
                 "WHERE id = %s",
                 (_me(request), work_order, order_id))
    log_event(conn, row["vehicle_id"], "pdi_date_confirmed", staff_id=_me(request),
              data={"pdi_at": row["pdi_at"].isoformat(), "work_order": work_order})
    if row["work_order"] and row["work_order"] != work_order:  # confirmed again with another number
        log_event(conn, row["vehicle_id"], "pdi_work_order_changed", staff_id=_me(request),
                  data={"from": row["work_order"], "to": work_order})
    return _order(conn, order_id)


@router.put("/pdi/{order_id}/work-order")
def set_work_order(order_id: int, body: WorkOrderIn, request: Request, conn=Depends(get_conn)):
    """Change the work order number (open or done orders). Doesn't touch
    updated_at, so it doesn't count as "changed since sent"."""
    row = conn.execute("SELECT vehicle_id, status, work_order FROM pdi_orders WHERE id = %s FOR UPDATE",
                       (order_id,)).fetchone()
    if not row:
        raise not_found("PDI order")
    if row["status"] == "cancelled":
        raise conflict("This PDI order is closed")
    work_order = _work_order(body.work_order)
    if work_order != row["work_order"]:
        conn.execute("UPDATE pdi_orders SET work_order = %s WHERE id = %s", (work_order, order_id))
        log_event(conn, row["vehicle_id"], "pdi_work_order_changed", staff_id=_me(request),
                  data={"from": row["work_order"], "to": work_order})
    return _order(conn, order_id)


# Events left out of the PDI orders page: documents (contracts hold personal data;
# the page shows no documents).
HIDDEN_EVENTS = ("document_added", "document_updated", "document_deleted")


@router.get("/pdi/orders")
def pdi_orders_page(conn=Depends(get_conn)):
    """The PDI orders page: every car with a PDI order (open or done; cancelled
    ones don't count) until the car is both marked as registered and taken off
    site. Car details, the right-side photo, the order and the car's history.
    No documents."""
    rows = conn.execute(
        ORDER_SELECT.replace("SELECT o.*,", f"SELECT o.*, {RIGHT_PHOTO_SQL},", 1) + """
         WHERE v.deleted_at IS NULL
           AND o.id = (SELECT o2.id FROM pdi_orders o2 WHERE o2.vehicle_id = v.id AND o2.status <> 'cancelled'
                        ORDER BY (o2.status <> 'done') DESC, o2.created_at DESC LIMIT 1)
           AND NOT (v.registered_marked_at IS NOT NULL AND v.status = 'off_site')
         ORDER BY (o.status = 'done'), o.pdi_at NULLS LAST, o.created_at""").fetchall()
    events: dict[int, list] = {r["vehicle_id"]: [] for r in rows}
    if rows:
        for e in conn.execute(
                """SELECT e.*, s.name AS staff_name
                     FROM vehicle_events e LEFT JOIN staff s ON s.id = e.staff_id
                    WHERE e.vehicle_id = ANY(%s) AND e.event_type <> ALL(%s)
                    ORDER BY e.occurred_at DESC, e.id DESC""",
                (list(events), list(HIDDEN_EVENTS))).fetchall():
            events[e["vehicle_id"]].append(e)
    season = tyre_season()
    for r in rows:
        r["events"] = events[r["vehicle_id"]]
        r["tyre_warning"] = tyre_warning(r["wheels"], season) if r["vehicle_status"] != "off_site" else None
    return rows


class DoneIn(BaseModel):
    """Optional: fill in the model's PDI sheet at the same time (see pdi_sheets)."""
    template_id: Optional[int] = None
    km: Optional[int] = Field(None, ge=0, le=2_000_000)
    date: Optional[dt.date] = None
    stamp_id: Optional[int] = None
    work_order: Optional[str] = Field(None, max_length=40)  # filled in or corrected here too


@router.post("/pdi/{order_id}/done")
def mark_done(order_id: int, request: Request, body: Optional[DoneIn] = None, conn=Depends(get_conn)):
    row = _open_order(conn, order_id)
    body = body or DoneIn()
    conn.execute("UPDATE pdi_orders SET status = 'done', done_at = now(), done_by = %s, done_km = %s WHERE id = %s",
                 (_me(request), body.km, order_id))
    pdi_sheets.save_work_order(conn, order_id, _me(request), body.work_order)
    old = None
    if body.template_id is not None:
        if body.km is None:
            raise bad_request("Enter the mileage for the PDI sheet")
        old = pdi_sheets.make_sheet(conn, order_id, request.state.staff, pdi_sheets.SheetIn(
            template_id=body.template_id, km=body.km, date=body.date or dt.date.today(), stamp_id=body.stamp_id))
    log_event(conn, row["vehicle_id"], "pdi_done", staff_id=_me(request),
              data={"km": body.km, "sheet": body.template_id is not None})
    result = _order(conn, order_id)
    if old:
        conn.commit()  # remove the old file only once the change is final
        pdisheet.remove(old, "pdf")
    return result


# --------------------------------------------------------------------------- #
# preparing the car the day before the PDI
# --------------------------------------------------------------------------- #

class PrepareIn(BaseModel):
    trade_plate_id: Optional[int] = None
    location_id: Optional[int] = None   # storage spot; a different one moves the car
    note: Optional[str] = Field(None, max_length=300)
    wheels_location: Optional[str] = Field(None, max_length=200)


WHEELS_AT_DEALER = ("in_stock", "sales_ordered")  # the dealer has the winter wheels


def _next_workday(d: dt.date) -> dt.date:
    d += dt.timedelta(days=1)
    while d.weekday() >= 5:  # Saturday, Sunday
        d += dt.timedelta(days=1)
    return d


@router.get("/pdi/prepare-due")
def prepare_due(conn=Depends(get_conn)):
    """Booked PDIs up to the next working day whose car isn't prepared yet
    (on a Friday that includes Monday). Shown as a notification on every page."""
    today = conn.execute("SELECT (now() AT TIME ZONE 'Europe/Oslo')::date AS d").fetchone()["d"]
    return conn.execute(
        ORDER_SELECT + """ WHERE o.status = 'booked' AND o.prepared_at IS NULL AND v.deleted_at IS NULL
                             AND (o.pdi_at AT TIME ZONE 'Europe/Oslo')::date BETWEEN %s AND %s
                           ORDER BY o.pdi_at""",
        (today, _next_workday(today)),
    ).fetchall()


@router.post("/pdi/{order_id}/prepare")
def prepare(order_id: int, body: PrepareIn, request: Request, conn=Depends(get_conn)):
    """Record the preparation: trade plates, spot (+ short message), and where
    the winter wheels are. Choosing another spot moves the car there."""
    row = _open_order(conn, order_id)
    staff_id = _me(request)
    vehicle_id = row["vehicle_id"]
    plate = None
    if body.trade_plate_id is not None:
        plate = conn.execute("SELECT * FROM trade_plates WHERE id = %s AND active", (body.trade_plate_id,)).fetchone()
        if not plate:
            raise not_found("Trade plates")
    moved_to = None
    if body.location_id is not None:
        vehicle = conn.execute("SELECT status FROM vehicles WHERE id = %s FOR UPDATE", (vehicle_id,)).fetchone()
        current = conn.execute(
            """SELECT l.id, l.code FROM storage_assignments a JOIN storage_spots l ON l.id = a.location_id
                WHERE a.vehicle_id = %s AND a.removed_at IS NULL""", (vehicle_id,)).fetchone()
        if not current or current["id"] != body.location_id:
            if vehicle["status"] == "intake":
                raise conflict("Finish the arrival inspection first; it places the car in storage")
            location = place_in_location(conn, vehicle_id, body.location_id, staff_id)
            conn.execute("UPDATE vehicles SET status = 'in_storage' WHERE id = %s", (vehicle_id,))
            log_event(conn, vehicle_id, "moved", staff_id=staff_id, data={
                "from": current["code"] if current else None, "to": location["code"],
                "location_id": location["id"], "note": "PDI preparation"})
            moved_to = location["code"]
    note = (body.note or "").strip() or None
    wheels = (body.wheels_location or "").strip() or None
    if (row["tyres"] or {}).get("mode") not in WHEELS_AT_DEALER:
        wheels = None
    # updated_at is left alone: it drives "changed since sent", and the order
    # list itself is unchanged.
    conn.execute(
        """UPDATE pdi_orders SET prep_plate_id = %s, prep_note = %s, prep_wheels_location = %s,
                  prepared_at = now(), prepared_by = %s
            WHERE id = %s""",
        (plate["id"] if plate else None, note, wheels, staff_id, order_id),
    )
    log_event(conn, vehicle_id, "pdi_prepared", staff_id=staff_id, data={
        "trade_plates": plate["name"] if plate else None, "moved_to": moved_to,
        "note": note, "wheels_location": wheels})
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
