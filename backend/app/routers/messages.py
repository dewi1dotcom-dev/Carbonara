"""Message board on the Today page.

Messages belong to a team: a user sees their own team's messages plus messages to everyone
(team_id NULL). Staff post to their own team; admins can also post to everyone or to another
team. Each message is marked with the writer's initials and shown for 24 hours. Expired
messages are deleted on the next read (and daily by the worker). Texts never go into the logs.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import push
from ..auth import require_admin
from ..common import bad_request, not_found
from ..db import get_conn

router = APIRouter(tags=["messages"])

HOURS = 24
DELETE_EXPIRED_SQL = f"DELETE FROM messages WHERE created_at < now() - interval '{HOURS} hours'"


class MessageIn(BaseModel):
    body: str = Field(..., max_length=300)
    # Admins only: "all" = everyone, a team id, or None = the writer's own team.
    to: Optional[str] = Field(None, max_length=20)


def initials(first: str | None, last: str | None, name: str | None) -> str:
    """'Ola Nordmann' -> 'ON'. Falls back to the first letters of the full name's words."""
    parts = [p for p in ((first or "").strip(), (last or "").strip()) if p]
    if not parts:
        parts = (name or "").split()
    if len(parts) > 2:
        parts = [parts[0], parts[-1]]
    return "".join(p[0] for p in parts).upper() or "?"


@router.get("/messages")
def list_messages(request: Request, conn=Depends(get_conn)):
    conn.execute(DELETE_EXPIRED_SQL)
    me = request.state.staff
    rows = conn.execute(
        f"""SELECT m.id, m.body, m.created_at, m.created_by, m.team_id, t.name AS team_name,
                   m.created_at + interval '{HOURS} hours' AS expires_at,
                   s.first_name, s.last_name, s.name
              FROM messages m LEFT JOIN staff s ON s.id = m.created_by
              LEFT JOIN teams t ON t.id = m.team_id
             WHERE m.team_id IS NULL OR m.team_id = %s
             ORDER BY m.created_at DESC""",
        (me["team_id"],),
    ).fetchall()
    return {
        # No team and not an admin: nobody would see the message, so the board doesn't offer writing.
        "can_post": bool(me["is_admin"] or me["team_id"]),
        "messages": [{
            "id": r["id"], "body": r["body"], "created_at": r["created_at"], "expires_at": r["expires_at"],
            "initials": initials(r["first_name"], r["last_name"], r["name"]), "name": r["name"],
            "to_all": r["team_id"] is None, "team_name": r["team_name"],
            # The writer or an admin may take a message down before it expires.
            "can_delete": me["is_admin"] or r["created_by"] == me["id"],
        } for r in rows],
    }


@router.get("/messages/teams")
def message_teams(_admin: dict = Depends(require_admin), conn=Depends(get_conn)):
    """The teams an admin can post to (besides everyone)."""
    return conn.execute("SELECT id, name FROM teams ORDER BY lower(name)").fetchall()


@router.post("/messages", status_code=201)
def add_message(body: MessageIn, request: Request, conn=Depends(get_conn)):
    me = request.state.staff
    text = " ".join(body.body.split())  # one line: tidy spaces and line breaks
    if not text:
        raise bad_request("Write a message first")
    if not me["is_admin"] or body.to is None:
        team_id = me["team_id"]  # staff always post to their own team
        if team_id is None:
            if not me["is_admin"]:
                raise bad_request("You are not in a team, so nobody would see the message")
            raise bad_request("Choose who should see the message")
    elif body.to == "all":
        team_id = None
    else:
        if not body.to.isdigit() or not conn.execute("SELECT 1 FROM teams WHERE id = %s", (int(body.to),)).fetchone():
            raise not_found("Team")
        team_id = int(body.to)
    row = conn.execute("INSERT INTO messages (body, team_id, created_by) VALUES (%s, %s, %s) RETURNING id",
                       (text, team_id, me["id"])).fetchone()
    # The text itself isn't sent: it shows on locked phones and may name a customer.
    to = None if team_id is None else [r["id"] for r in conn.execute(
        "SELECT id FROM staff WHERE team_id = %s", (team_id,)).fetchall()]
    push.notify(conn, to, "board", en=("New message on the Today page", f"From {me['name']}"),
                no=("Ny melding på I dag-siden", f"Fra {me['name']}"), url="#/", tag="board", exclude=me["id"])
    return {"id": row["id"]}


@router.delete("/messages/{message_id}", status_code=204)
def delete_message(message_id: int, request: Request, conn=Depends(get_conn)):
    row = conn.execute("SELECT created_by FROM messages WHERE id = %s", (message_id,)).fetchone()
    if not row:
        raise not_found("Message")
    me = request.state.staff
    if not me["is_admin"] and row["created_by"] != me["id"]:
        raise HTTPException(403, "Only the writer or an administrator can delete this message")
    conn.execute("DELETE FROM messages WHERE id = %s", (message_id,))
