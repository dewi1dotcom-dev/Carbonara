"""My notes (0.40.0): each person's own notes in the 📝 panel (the user's request: "every user needs to
take notes, pin cars and other things to remember, quick and easy").

A note is a text and/or a pinned car or page, with an optional reminder. **Private:** only the person who
wrote it can see or change it, admins included. When a reminder is due the note goes to the top of the
panel, the 📝 button shows a count, and a phone notification goes out (push._note_reminders; the text of
the note never goes into the notification, as it may name a customer). Done notes are deleted after
trash_days by the worker. Note texts are never logged and never go into vehicle history.
"""

import datetime as dt
from typing import Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from ..common import bad_request, not_found
from ..config import settings
from ..db import get_conn

router = APIRouter(tags=["notes"])

MAX_TEXT = 1000
DONE_SHOWN = 50

COLUMNS = """n.id, n.body, n.vehicle_id, n.link, n.link_title, n.remind_at,
             (n.remind_at AT TIME ZONE 'Europe/Oslo') AS remind_local,
             n.remind_at IS NOT NULL AND n.remind_at <= now() AS due,
             n.done_at, n.created_at, n.updated_at,
             v.registration_number, v.make, v.model, v.model_year,
             v.id IS NOT NULL AND v.deleted_at IS NOT NULL AS vehicle_deleted"""
FROM = " FROM notes n LEFT JOIN vehicles v ON v.id = n.vehicle_id"

# Done notes, deleted by the worker's daily housekeeping (sync_worker).
DONE_PURGE_SQL = "DELETE FROM notes WHERE done_at < now() - make_interval(days => %s)"


class NoteIn(BaseModel):
    body: Optional[str] = Field(None, max_length=MAX_TEXT)
    vehicle_id: Optional[int] = None
    link: Optional[str] = Field(None, max_length=300)
    link_title: Optional[str] = Field(None, max_length=200)
    remind: Optional[str] = Field(None, max_length=20)  # "2026-11-21T14:30", Norwegian local time


class NotePatch(BaseModel):
    body: Optional[str] = Field(None, max_length=MAX_TEXT)
    remind: Optional[str] = Field(None, max_length=20)  # "" = no reminder
    done: Optional[bool] = None


def _text(raw: Optional[str]) -> Optional[str]:
    text = (raw or "").strip()
    return text or None


def _remind(raw: Optional[str]) -> Optional[dt.datetime]:
    if not (raw or "").strip():
        return None
    try:
        return dt.datetime.fromisoformat(raw.strip()).replace(tzinfo=None, second=0, microsecond=0)
    except ValueError:
        raise bad_request("Reminder: not a valid date and time")


def _get(conn, note_id: int, me: int) -> dict:
    row = conn.execute("SELECT " + COLUMNS + FROM + " WHERE n.id = %s AND n.staff_id = %s", (note_id, me)).fetchone()
    if not row:
        raise not_found("Note")  # someone else's note looks the same as a missing one
    return row


@router.get("/notes")
def list_notes(request: Request, conn=Depends(get_conn)):
    me = request.state.staff["id"]
    # Reminders first (due ones are the earliest), then the rest, newest first.
    open_ = conn.execute("SELECT " + COLUMNS + FROM + """ WHERE n.staff_id = %s AND n.done_at IS NULL
                         ORDER BY n.remind_at IS NULL, n.remind_at, n.created_at DESC""", (me,)).fetchall()
    done = conn.execute("SELECT " + COLUMNS + FROM + """ WHERE n.staff_id = %s AND n.done_at IS NOT NULL
                        ORDER BY n.done_at DESC LIMIT %s""", (me, DONE_SHOWN)).fetchall()
    done_count = conn.execute("SELECT count(*) AS n FROM notes WHERE staff_id = %s AND done_at IS NOT NULL",
                              (me,)).fetchone()["n"]
    return {"open": open_, "done": done, "done_count": done_count, "keep_days": settings.trash_days}


@router.get("/notes/due")
def due_count(request: Request, conn=Depends(get_conn)):
    """For the 📝 button: reminders that are due now."""
    row = conn.execute("""SELECT count(*) AS n FROM notes WHERE staff_id = %s AND done_at IS NULL
                           AND remind_at <= now()""", (request.state.staff["id"],)).fetchone()
    return {"count": row["n"]}


@router.post("/notes", status_code=201)
def add_note(body: NoteIn, request: Request, conn=Depends(get_conn)):
    me = request.state.staff["id"]
    text, link, title = _text(body.body), _text(body.link), _text(body.link_title)
    if body.vehicle_id is not None:
        if not conn.execute("SELECT 1 FROM vehicles WHERE id = %s AND deleted_at IS NULL", (body.vehicle_id,)).fetchone():
            raise not_found("Vehicle")
        link = title = None  # a pinned car is shown from the car itself
    if link is not None and not (link.startswith("#/") and " " not in link):
        raise bad_request("Only pages in Carbonara can be pinned")
    if not (text or body.vehicle_id or link):
        raise bad_request("Write something first")
    remind = _remind(body.remind)
    row = conn.execute(
        """INSERT INTO notes (staff_id, body, vehicle_id, link, link_title, remind_at)
           VALUES (%s, %s, %s, %s, %s, %s::timestamp AT TIME ZONE 'Europe/Oslo') RETURNING id""",
        (me, text, body.vehicle_id, link, title[:120] if title else None, remind)).fetchone()
    return _get(conn, row["id"], me)


@router.patch("/notes/{note_id}")
def edit_note(note_id: int, body: NotePatch, request: Request, conn=Depends(get_conn)):
    me = request.state.staff["id"]
    note = _get(conn, note_id, me)
    sent = body.model_fields_set
    if "body" in sent:
        text = _text(body.body)
        if not (text or note["vehicle_id"] or note["link"]):
            raise bad_request("Write something first")
        conn.execute("UPDATE notes SET body = %s, updated_at = now() WHERE id = %s", (text, note_id))
    if "remind" in sent:
        # A new time can remind again; the same time keeps "already reminded".
        conn.execute("""UPDATE notes SET remind_at = %s::timestamp AT TIME ZONE 'Europe/Oslo',
                               reminded_at = CASE WHEN remind_at IS NOT DISTINCT FROM
                                   (%s::timestamp AT TIME ZONE 'Europe/Oslo') THEN reminded_at END,
                               updated_at = now() WHERE id = %s""",
                     (_remind(body.remind), _remind(body.remind), note_id))
    if body.done is not None:
        conn.execute("UPDATE notes SET done_at = CASE WHEN %s THEN coalesce(done_at, now()) END WHERE id = %s",
                     (body.done, note_id))
    return _get(conn, note_id, me)


@router.delete("/notes/{note_id}", status_code=204)
def delete_note(note_id: int, request: Request, conn=Depends(get_conn)):
    _get(conn, note_id, request.state.staff["id"])
    conn.execute("DELETE FROM notes WHERE id = %s", (note_id,))
