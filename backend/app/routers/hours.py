"""Work hours (0.49.0): start and end of each person's working day, and the clock on work orders.

- Everyone starts / ends their own day and stops their own clock (⏱ in the top bar, `/hours/me`). They see only
  today's state; **only admins see the hours** (`/hours` list, corrections, export).
- Breaks: the System page's fixed breaks are copied onto the day when it starts; an admin can change one day's breaks.
  They are taken off the worked time and off the time on work orders (worktime.py).
- One running clock per person (unique index); ending the day stops it. Work days are deleted after retention_years
  by the worker (`purge_old_days`); time on work orders stays with the order.
"""
import csv
import io
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import worktime
from ..auth import require_admin, require_staff
from ..common import bad_request, conflict, not_found
from ..config import settings
from ..db import get_conn
from ..worktime import OSLO, local

router = APIRouter(tags=["hours"])

MAX_RANGE_DAYS = 62


def enabled() -> bool:
    return settings.work_hours != "off"


def _require_enabled() -> None:
    if not enabled():
        raise HTTPException(404, "Work hours are switched off (System page)")


def stop_running(conn, staff_id: int, at: Optional[datetime] = None) -> Optional[dict]:
    """Stop this person's running clock (if any). A clock stopped within a minute of starting is dropped."""
    row = conn.execute("SELECT * FROM work_time WHERE staff_id = %s AND ended_at IS NULL FOR UPDATE",
                       (staff_id,)).fetchone()
    if not row:
        return None
    at = at or datetime.now(OSLO)
    if at - row["started_at"] < timedelta(minutes=1):
        conn.execute("DELETE FROM work_time WHERE id = %s", (row["id"],))
    else:
        conn.execute("UPDATE work_time SET ended_at = %s WHERE id = %s", (at, row["id"]))
    return row


def start_day(conn, staff_id: int, at: Optional[datetime] = None) -> dict:
    """Today's work day for this person, started now if it isn't yet (an ended day is opened again)."""
    at = at or datetime.now(OSLO)
    day = at.astimezone(OSLO).date()
    row = conn.execute("SELECT * FROM work_days WHERE staff_id = %s AND day = %s FOR UPDATE", (staff_id, day)).fetchone()
    if row:
        if row["ended_at"]:
            row = conn.execute("UPDATE work_days SET ended_at = NULL WHERE id = %s RETURNING *", (row["id"],)).fetchone()
        return row
    return conn.execute(
        "INSERT INTO work_days (staff_id, day, started_at, breaks) VALUES (%s, %s, %s, %s) RETURNING *",
        (staff_id, day, at, Jsonb(worktime.default_breaks()))).fetchone()


def _day_out(conn, row: dict) -> dict:
    breaks_for = worktime.static_breaks(list(row["breaks"]))
    return {
        "id": row["id"], "day": row["day"], "start": local(row["started_at"]), "end": local(row["ended_at"]),
        "breaks": list(row["breaks"]), "note": row.get("note"),
        "worked_seconds": worktime.worked_seconds(row["started_at"], row["ended_at"], breaks_for),
        "break_seconds": worktime.break_seconds(row["started_at"], row["ended_at"] or datetime.now(OSLO), breaks_for),
        "edited_at": row.get("edited_at"),
    }


RUNNING_SELECT = """SELECT t.id, t.started_at, t.work_order_id, w.number, w.title, w.estimated_minutes,
                           coalesce(cc.registration_number, v.registration_number) AS registration_number,
                           coalesce(cc.make, v.make) AS make, coalesce(cc.model, v.model) AS model
                      FROM work_time t JOIN work_orders w ON w.id = t.work_order_id
                      LEFT JOIN vehicles v ON v.id = w.vehicle_id LEFT JOIN customer_cars cc ON cc.id = w.customer_car_id
                     WHERE t.staff_id = %s AND t.ended_at IS NULL"""


@router.get("/hours/me")
def my_state(conn=Depends(get_conn), staff=Depends(require_staff)):
    """Today's state for the ⏱ button: day started / ended, the running work order clock. No history."""
    row = conn.execute("SELECT * FROM work_days WHERE staff_id = %s AND day = %s",
                       (staff["id"], worktime.today())).fetchone()
    running = conn.execute(RUNNING_SELECT, (staff["id"],)).fetchone()
    if running:
        running["start"] = local(running.pop("started_at"))
    return {"enabled": enabled(), "day": _day_out(conn, row) if row else None, "running": running,
            "default_breaks": worktime.default_breaks()}


@router.post("/hours/day/start")
def day_start(conn=Depends(get_conn), staff=Depends(require_staff)):
    _require_enabled()
    start_day(conn, staff["id"])
    return my_state(conn, staff)


@router.post("/hours/day/end")
def day_end(conn=Depends(get_conn), staff=Depends(require_staff)):
    _require_enabled()
    row = conn.execute("SELECT * FROM work_days WHERE staff_id = %s AND day = %s FOR UPDATE",
                       (staff["id"], worktime.today())).fetchone()
    if not row or row["ended_at"]:
        raise conflict("Your working day hasn't been started today")
    now = datetime.now(OSLO)
    stop_running(conn, staff["id"], now)
    if now - row["started_at"] < timedelta(minutes=1):
        conn.execute("DELETE FROM work_days WHERE id = %s", (row["id"],))  # started by mistake
    else:
        conn.execute("UPDATE work_days SET ended_at = %s WHERE id = %s", (now, row["id"]))
    return my_state(conn, staff)


@router.post("/hours/clock/stop")
def clock_stop(conn=Depends(get_conn), staff=Depends(require_staff)):
    stop_running(conn, staff["id"])
    return my_state(conn, staff)


# --------------------------------------------------------------------------- #
# admins: the hours of everyone, corrections, export
# --------------------------------------------------------------------------- #

def _range(start: Optional[str], end: Optional[str]) -> tuple[date, date]:
    try:
        d1 = date.fromisoformat(start) if start else worktime.today() - timedelta(days=worktime.today().weekday())
        d2 = date.fromisoformat(end) if end else d1 + timedelta(days=6)
    except ValueError:
        raise bad_request("Check the dates")
    if d2 < d1:
        d1, d2 = d2, d1
    if (d2 - d1).days >= MAX_RANGE_DAYS:
        raise bad_request(f"Choose at most {MAX_RANGE_DAYS} days")
    return d1, d2


def _report(conn, d1: date, d2: date, staff_id: Optional[int]) -> list[dict]:
    lo = datetime.combine(d1, datetime.min.time(), OSLO)
    hi = datetime.combine(d2 + timedelta(days=1), datetime.min.time(), OSLO)
    who = " AND staff_id = %s" if staff_id else ""
    days = conn.execute(f"SELECT * FROM work_days WHERE day BETWEEN %s AND %s{who} ORDER BY day",
                        (d1, d2, *([staff_id] if staff_id else []))).fetchall()
    entries = conn.execute(
        f"""SELECT t.*, w.number, w.title FROM work_time t JOIN work_orders w ON w.id = t.work_order_id
             WHERE t.started_at >= %s AND t.started_at < %s{who.replace('staff_id', 't.staff_id')}
             ORDER BY t.started_at""", (lo, hi, *([staff_id] if staff_id else []))).fetchall()
    ids = {r["staff_id"] for r in days} | {r["staff_id"] for r in entries}
    names = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM staff WHERE id = ANY(%s)",
                                                      (list(ids),)).fetchall()}
    people: dict[int, dict] = {}
    for sid in ids:
        people[sid] = {"staff_id": sid, "name": names.get(sid, "?"), "days": {}, "worked_seconds": 0,
                       "order_seconds": 0}
    for r in days:
        p = people[r["staff_id"]]
        p["days"][r["day"]] = {**_day_out(conn, r), "entries": [], "order_seconds": 0}
    breaks_cache: dict[int, worktime.BreaksFor] = {}
    for t in entries:
        p = people[t["staff_id"]]
        bf = breaks_cache.setdefault(t["staff_id"], worktime.person_breaks(conn, t["staff_id"]))
        d = t["started_at"].astimezone(OSLO).date()
        day = p["days"].setdefault(d, {"id": None, "day": d, "start": None, "end": None, "breaks": [], "note": None,
                                       "worked_seconds": 0, "break_seconds": 0, "entries": [], "order_seconds": 0})
        secs = worktime.worked_seconds(t["started_at"], t["ended_at"], bf)
        day["entries"].append({"id": t["id"], "work_order_id": t["work_order_id"], "number": t["number"],
                               "title": t["title"], "start": local(t["started_at"]), "end": local(t["ended_at"]),
                               "seconds": secs, "note": t["note"], "running": t["ended_at"] is None})
        day["order_seconds"] += secs
    out = []
    for p in people.values():
        p["days"] = [p["days"][k] for k in sorted(p["days"])]
        p["worked_seconds"] = sum(d["worked_seconds"] for d in p["days"])
        p["order_seconds"] = sum(d["order_seconds"] for d in p["days"])
        out.append(p)
    return sorted(out, key=lambda p: p["name"].lower())


@router.get("/hours")
def hours_report(start: Optional[str] = None, end: Optional[str] = None, staff_id: Optional[int] = None,
                 conn=Depends(get_conn), _admin=Depends(require_admin)):
    d1, d2 = _range(start, end)
    staff = conn.execute("SELECT id, name FROM staff WHERE deleted_at IS NULL AND active ORDER BY lower(name)").fetchall()
    return {"start": d1, "end": d2, "people": _report(conn, d1, d2, staff_id), "staff": staff,
            "default_breaks": worktime.default_breaks(), "enabled": enabled()}


def _hours(seconds: int) -> str:
    return f"{seconds / 3600:.2f}".replace(".", ",")


@router.get("/hours/export")
def hours_export(start: Optional[str] = None, end: Optional[str] = None, staff_id: Optional[int] = None,
                 conn=Depends(get_conn), _admin=Depends(require_admin)):
    """CSV for payroll (semicolons, decimal commas, BOM: opens in Excel)."""
    d1, d2 = _range(start, end)
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Name", "Date", "Start", "End", "Breaks", "Hours worked", "Hours on work orders", "Note"])
    for p in _report(conn, d1, d2, staff_id):
        for d in p["days"]:
            w.writerow([p["name"], d["day"].strftime("%d.%m.%Y"), (d["start"] or "")[11:], (d["end"] or "")[11:],
                        ", ".join(d["breaks"]), _hours(d["worked_seconds"]), _hours(d["order_seconds"]),
                        (d["note"] or "").replace("\n", " ")])
        w.writerow([p["name"], "Total", "", "", "", _hours(p["worked_seconds"]), _hours(p["order_seconds"]), ""])
    name = f"work-hours-{d1.isoformat()}-{d2.isoformat()}.csv"
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


def _times(day: str, start: str, end: Optional[str]) -> tuple[datetime, Optional[datetime]]:
    """Local date + "hh:mm" start / end → aware datetimes; an end before the start is the next day."""
    try:
        s = worktime.parse_local(day, start)
        e = worktime.parse_local(day, end) if (end or "").strip() else None
    except ValueError as exc:
        raise bad_request(str(exc))
    if e is not None and e <= s:
        e += timedelta(days=1)
    return s, e


def _breaks(value) -> list[str]:
    try:
        return worktime.parse_breaks(value)
    except ValueError as exc:
        raise bad_request(str(exc))


class DayIn(BaseModel):
    staff_id: Optional[int] = None   # new days only
    day: str
    start: str
    end: Optional[str] = None
    breaks: list[str] = Field(default_factory=list, max_length=20)
    note: Optional[str] = Field(None, max_length=500)


@router.post("/hours/days", status_code=201)
def add_day(body: DayIn, conn=Depends(get_conn), admin=Depends(require_admin)):
    if not body.staff_id or not conn.execute("SELECT 1 FROM staff WHERE id = %s", (body.staff_id,)).fetchone():
        raise not_found("Person")
    s, e = _times(body.day, body.start, body.end)
    if conn.execute("SELECT 1 FROM work_days WHERE staff_id = %s AND day = %s", (body.staff_id, s.date())).fetchone():
        raise conflict("That person already has that day: change it instead")
    row = conn.execute(
        """INSERT INTO work_days (staff_id, day, started_at, ended_at, breaks, note, edited_at, edited_by)
           VALUES (%s, %s, %s, %s, %s, %s, now(), %s) RETURNING *""",
        (body.staff_id, s.date(), s, e, Jsonb(_breaks(body.breaks)), (body.note or "").strip() or None,
         admin["id"])).fetchone()
    return _day_out(conn, row)


@router.put("/hours/days/{day_id}")
def edit_day(day_id: int, body: DayIn, conn=Depends(get_conn), admin=Depends(require_admin)):
    row = conn.execute("SELECT * FROM work_days WHERE id = %s FOR UPDATE", (day_id,)).fetchone()
    if not row:
        raise not_found("Work day")
    s, e = _times(row["day"].isoformat(), body.start, body.end)
    row = conn.execute(
        """UPDATE work_days SET started_at = %s, ended_at = %s, breaks = %s, note = %s, edited_at = now(),
                                edited_by = %s WHERE id = %s RETURNING *""",
        (s, e, Jsonb(_breaks(body.breaks)), (body.note or "").strip() or None, admin["id"], day_id)).fetchone()
    return _day_out(conn, row)


@router.delete("/hours/days/{day_id}", status_code=204)
def delete_day(day_id: int, conn=Depends(get_conn), _admin=Depends(require_admin)):
    if not conn.execute("DELETE FROM work_days WHERE id = %s RETURNING id", (day_id,)).fetchone():
        raise not_found("Work day")


class EntryIn(BaseModel):
    work_order_number: Optional[int] = None   # new entries only
    staff_id: Optional[int] = None            # new entries only
    day: str
    start: str
    end: str
    note: Optional[str] = Field(None, max_length=500)


@router.post("/hours/entries", status_code=201)
def add_entry(body: EntryIn, conn=Depends(get_conn), admin=Depends(require_admin)):
    wo = conn.execute("SELECT id FROM work_orders WHERE number = %s", (body.work_order_number,)).fetchone()
    if not wo:
        raise not_found("Work order")
    if not body.staff_id or not conn.execute("SELECT 1 FROM staff WHERE id = %s", (body.staff_id,)).fetchone():
        raise not_found("Person")
    s, e = _times(body.day, body.start, body.end)
    if e is None:
        raise bad_request("Enter the end time")
    row = conn.execute(
        """INSERT INTO work_time (work_order_id, staff_id, started_at, ended_at, note, edited_at, edited_by)
           VALUES (%s, %s, %s, %s, %s, now(), %s) RETURNING id""",
        (wo["id"], body.staff_id, s, e, (body.note or "").strip() or None, admin["id"])).fetchone()
    return {"id": row["id"]}


@router.put("/hours/entries/{entry_id}")
def edit_entry(entry_id: int, body: EntryIn, conn=Depends(get_conn), admin=Depends(require_admin)):
    row = conn.execute("SELECT * FROM work_time WHERE id = %s FOR UPDATE", (entry_id,)).fetchone()
    if not row:
        raise not_found("Time entry")
    s, e = _times(body.day, body.start, body.end)
    if e is None:
        raise bad_request("Enter the end time")
    conn.execute("UPDATE work_time SET started_at = %s, ended_at = %s, note = %s, edited_at = now(), edited_by = %s "
                 "WHERE id = %s", (s, e, (body.note or "").strip() or None, admin["id"], entry_id))
    return {"id": entry_id}


@router.delete("/hours/entries/{entry_id}", status_code=204)
def delete_entry(entry_id: int, conn=Depends(get_conn), _admin=Depends(require_admin)):
    if not conn.execute("DELETE FROM work_time WHERE id = %s RETURNING id", (entry_id,)).fetchone():
        raise not_found("Time entry")


def purge_old_days(conn, years: int) -> int:
    """Work days older than `years` (worker housekeeping; personal data)."""
    return conn.execute("DELETE FROM work_days WHERE day < (now() AT TIME ZONE 'Europe/Oslo')::date "
                        "- make_interval(years => %s)", (years,)).rowcount
