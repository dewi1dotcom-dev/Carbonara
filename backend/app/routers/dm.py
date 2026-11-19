"""Private messages between users, with an optional file or image.

Only the sender and the recipient can read a message or open its file (admins too: no
exceptions). Every message is deleted, with its file, 72 working hours after it was sent:
only Monday–Friday hours count, so nothing disappears over a weekend (the user's rule).
The worker deletes expired messages every minute; reads never show them in the meantime.
Message texts and file names never go into the logs.
"""

import datetime as dt
import uuid
from pathlib import PurePath
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from .. import photostore, push
from ..common import bad_request, not_found
from ..config import settings
from ..db import get_conn
from .documents import FILE_TYPES, INLINE
from .messages import initials

router = APIRouter(tags=["private messages"])

OSLO = ZoneInfo("Europe/Oslo")
WORK_HOURS = 72
MAX_TEXT = 2000
# Photos are stored like inspection photos (original + 1600 px + 400 px JPEG), so iPhone HEIC
# pictures can be shown too. Other allowed types are stored as uploaded.
IMAGE_EXT = {"jpg", "jpeg", "png", "webp", "heic", "heif"}

COLUMNS = """id, sender_id, recipient_id, body, original_name, original_ext, size_bytes, is_image,
             file_key IS NOT NULL AS has_file, created_at, expires_at, read_at"""


def expires_after_work_hours(start: dt.datetime, hours: int = WORK_HOURS) -> dt.datetime:
    """start + `hours`, counting only Monday–Friday (Oslo wall-clock time).

    Friday 10:00 -> Wednesday 10:00; Saturday or Sunday -> Thursday 00:00; Thursday 10:00 -> Tuesday 10:00.
    """
    t = start.astimezone(OSLO).replace(tzinfo=None)
    left = dt.timedelta(hours=hours)
    while left > dt.timedelta(0):
        if t.weekday() >= 5:  # Saturday / Sunday: jump to Monday 00:00
            t = dt.datetime.combine(t.date() + dt.timedelta(days=7 - t.weekday()), dt.time())
            continue
        day_end = dt.datetime.combine(t.date() + dt.timedelta(days=1), dt.time())
        step = min(left, day_end - t)
        t += step
        left -= step
    return t.replace(tzinfo=OSLO)


def purge_expired(conn) -> list[dict]:
    """Delete expired messages. Returns their files; remove them only after the commit."""
    rows = conn.execute("DELETE FROM private_messages WHERE expires_at <= now() "
                        "RETURNING file_key, original_ext").fetchall()
    return [r for r in rows if r["file_key"]]


def _me(request: Request) -> int:
    return request.state.staff["id"]


def _person(conn, staff_id: int, me: int, *, for_sending: bool = False) -> dict:
    row = conn.execute("SELECT id, name, first_name, last_name, active FROM staff WHERE id = %s AND deleted_at IS NULL",
                       (staff_id,)).fetchone()
    if not row:
        raise not_found("Person")
    if row["id"] == me:
        raise bad_request("You can't send a message to yourself")
    if for_sending and not row["active"]:
        raise bad_request("This person is deactivated and can't receive messages")
    return row


def _message(conn, message_id: int, me: int) -> dict:
    """A message the user may see (sender or recipient, not expired)."""
    row = conn.execute("SELECT * FROM private_messages WHERE id = %s AND expires_at > now() "
                       "AND (sender_id = %s OR recipient_id = %s)", (message_id, me, me)).fetchone()
    if not row:
        raise not_found("Message")
    return row


@router.get("/dm/unread")
def unread(request: Request, conn=Depends(get_conn)):
    row = conn.execute("SELECT count(*) AS n FROM private_messages WHERE recipient_id = %s AND read_at IS NULL "
                       "AND expires_at > now()", (_me(request),)).fetchone()
    return {"count": row["n"]}


@router.get("/dm/contacts")
def contacts(request: Request, conn=Depends(get_conn)):
    """Everyone the user can write to: the latest conversations first, then by name."""
    rows = conn.execute(
        """SELECT s.id, s.name, s.first_name, s.last_name,
                  (SELECT count(*) FROM private_messages p
                    WHERE p.sender_id = s.id AND p.recipient_id = %(me)s AND p.read_at IS NULL
                      AND p.expires_at > now()) AS unread,
                  (SELECT max(p.created_at) FROM private_messages p
                    WHERE ((p.sender_id = s.id AND p.recipient_id = %(me)s) OR (p.sender_id = %(me)s AND p.recipient_id = s.id))
                      AND p.expires_at > now()) AS last_at
             FROM staff s
            WHERE s.active AND s.deleted_at IS NULL AND s.id <> %(me)s
            ORDER BY last_at DESC NULLS LAST, lower(s.name)""",
        {"me": _me(request)},
    ).fetchall()
    return [{"id": r["id"], "name": r["name"], "initials": initials(r["first_name"], r["last_name"], r["name"]),
             "unread": r["unread"], "last_at": r["last_at"]} for r in rows]


@router.get("/dm/with/{staff_id}")
def conversation(staff_id: int, request: Request, conn=Depends(get_conn)):
    me = _me(request)
    person = _person(conn, staff_id, me)
    rows = conn.execute(
        f"""SELECT {COLUMNS} FROM private_messages
             WHERE ((sender_id = %(me)s AND recipient_id = %(other)s) OR (sender_id = %(other)s AND recipient_id = %(me)s))
               AND expires_at > now()
             ORDER BY created_at, id""",
        {"me": me, "other": staff_id},
    ).fetchall()
    # Opening the conversation reads the messages sent to the user.
    conn.execute("UPDATE private_messages SET read_at = now() WHERE sender_id = %s AND recipient_id = %s "
                 "AND read_at IS NULL", (staff_id, me))
    return {
        "person": {"id": person["id"], "name": person["name"], "active": person["active"],
                   "initials": initials(person["first_name"], person["last_name"], person["name"])},
        "messages": [{**r, "mine": r["sender_id"] == me} for r in rows],
    }


@router.post("/dm/with/{staff_id}", status_code=201)
def send(
    staff_id: int,
    request: Request,
    body: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    conn=Depends(get_conn),
):
    me = _me(request)
    _person(conn, staff_id, me, for_sending=True)
    text = (body or "").strip() or None
    if text and len(text) > MAX_TEXT:
        raise bad_request("The message is too long (max 2 000 characters)")

    meta: dict = {}
    if file is not None and file.filename:
        name = PurePath(file.filename.replace("\\", "/")).name[:200]
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext not in FILE_TYPES:
            raise bad_request("This file type is not allowed (use PDF, a photo, Word, Excel or text)")
        data = file.file.read(settings.max_upload_bytes + 1)
        if len(data) > settings.max_upload_bytes:
            raise HTTPException(413, "File too large")
        if not data:
            raise bad_request("The file is empty")
        if ext in IMAGE_EXT:
            try:
                stored = photostore.store(data)
            except photostore.PhotoError:
                raise bad_request("This picture could not be read")
            meta = {"file_key": stored["file_key"], "original_ext": stored["original_ext"],
                    "mime_type": stored["mime_type"], "size_bytes": stored["size_bytes"], "is_image": True}
        else:
            meta = {"file_key": f"dm/{dt.datetime.now(dt.timezone.utc):%Y/%m}/{uuid.uuid4().hex}",
                    "original_ext": ext, "mime_type": FILE_TYPES[ext], "size_bytes": len(data), "is_image": False}
            path = photostore.path_for(meta, "original")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        meta["original_name"] = name
    if not text and not meta:
        raise bad_request("Write a message or add a file")

    now = dt.datetime.now(dt.timezone.utc)
    try:
        row = conn.execute(
            """INSERT INTO private_messages (sender_id, recipient_id, body, file_key, original_ext, original_name,
                                             mime_type, size_bytes, is_image, created_at, expires_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (me, staff_id, text, meta.get("file_key"), meta.get("original_ext"), meta.get("original_name"),
             meta.get("mime_type"), meta.get("size_bytes"), meta.get("is_image", False), now,
             expires_after_work_hours(now)),
        ).fetchone()
    except Exception:
        if meta:
            photostore.remove(meta)
        raise
    sender = request.state.staff["name"]
    push.notify(conn, [staff_id], "dm", en=("New private message", f"From {sender}"),
                no=("Ny privat melding", f"Fra {sender}"), url=f"#/messages/{me}", tag=f"dm-{me}", urgency="high")
    return {"id": row["id"]}


@router.get("/dm/{message_id}/file")
def get_file(message_id: int, request: Request, variant: str = "original", conn=Depends(get_conn)):
    """The message's file. Pictures also come as 'display' (1600 px) and 'thumb' (400 px) JPEGs."""
    row = _message(conn, message_id, _me(request))
    if not row["file_key"]:
        raise not_found("File")
    if variant not in ("original", "display", "thumb") or (variant != "original" and not row["is_image"]):
        raise bad_request("Unknown file variant")
    path = photostore.path_for(row, variant)
    if not path.is_file():
        raise not_found("File")
    headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
    if variant != "original":
        return FileResponse(path, media_type="image/jpeg", headers=headers)
    inline = row["is_image"] or row["original_ext"] in INLINE
    return FileResponse(path, media_type=row["mime_type"], filename=row["original_name"],
                        content_disposition_type="inline" if inline else "attachment", headers=headers)


@router.delete("/dm/{message_id}", status_code=204)
def delete_message(message_id: int, request: Request, conn=Depends(get_conn)):
    me = _me(request)
    row = _message(conn, message_id, me)
    if row["sender_id"] != me:
        raise HTTPException(403, "Only the sender can delete this message")
    conn.execute("DELETE FROM private_messages WHERE id = %s", (message_id,))
    conn.commit()  # remove the file only once the delete is final
    if row["file_key"]:
        photostore.remove(row)
