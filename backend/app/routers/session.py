"""Log in / log out with a personal PIN, and first-time setup."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .. import auth
from ..db import get_conn

log = logging.getLogger("carbonara.session")
router = APIRouter(prefix="/auth", tags=["login"])


class LoginIn(BaseModel):
    staff_id: int
    pin: str = Field(max_length=20)


class SetupIn(BaseModel):
    staff_id: Optional[int] = None          # an existing staff member, or
    name: Optional[str] = Field(None, max_length=100)  # a new one when there is no staff yet
    pin: str = Field(max_length=20)


class PinChangeIn(BaseModel):
    current_pin: str = Field(max_length=20)
    new_pin: str = Field(max_length=20)


def _setup_needed(conn) -> bool:
    return not conn.execute("SELECT 1 FROM staff WHERE pin_hash IS NOT NULL AND active LIMIT 1").fetchone()


def _set_cookie(response: Response, token: str) -> None:
    # secure=False: the server runs plain HTTP on the local network for now.
    response.set_cookie(auth.COOKIE, token, max_age=auth.SESSION_DAYS * 86400,
                        httponly=True, samesite="lax", secure=False, path="/")


def _pin_rule() -> str:
    return f"The PIN must be {auth.PIN_MIN}–{auth.PIN_MAX} digits"


@router.get("/state")
def state(request: Request, conn=Depends(get_conn)):
    """For the login screen: who can log in, and whether first-time setup is needed."""
    setup = _setup_needed(conn)
    staff = conn.execute(
        "SELECT id, name FROM staff WHERE active AND (%s OR pin_hash IS NOT NULL) ORDER BY name", (setup,)
    ).fetchall()
    return {"setup_needed": setup, "staff": staff, "me": auth.session_staff(conn, request.cookies.get(auth.COOKIE))}


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, conn=Depends(get_conn)):
    row = conn.execute(
        """SELECT id, pin_hash, pin_failures,
                  greatest(0, ceil(extract(epoch FROM pin_locked_until - now()) / 60))::int AS locked_min
             FROM staff WHERE id = %s AND active FOR UPDATE""",
        (body.staff_id,),
    ).fetchone()
    if not row or not row["pin_hash"]:
        raise HTTPException(401, "Wrong name or PIN")
    if row["locked_min"] > 0:
        raise HTTPException(429, f"Too many wrong PINs. Try again in {row['locked_min']} min, or ask an administrator.")
    if not auth.check_pin(body.pin, row["pin_hash"]):
        failures = row["pin_failures"] + 1
        if failures >= auth.MAX_FAILURES:
            conn.execute("UPDATE staff SET pin_failures = 0, pin_locked_until = now() + make_interval(mins => %s) "
                         "WHERE id = %s", (auth.LOCK_MINUTES, row["id"]))
            log.warning("staff %s locked after %d wrong PINs", row["id"], failures)
        else:
            conn.execute("UPDATE staff SET pin_failures = %s WHERE id = %s", (failures, row["id"]))
        conn.commit()  # keep the count although the request fails
        left = auth.MAX_FAILURES - failures
        raise HTTPException(401, "Wrong PIN" + (f" ({left} tries left)" if 0 < left <= 2 else
                                                f". Locked for {auth.LOCK_MINUTES} min." if left <= 0 else ""))
    conn.execute("UPDATE staff SET pin_failures = 0, pin_locked_until = NULL, last_login_at = now() WHERE id = %s",
                 (row["id"],))
    _set_cookie(response, auth.new_session(conn, row["id"], request.headers.get("user-agent")))
    return {"ok": True}


@router.post("/setup")
def setup(body: SetupIn, request: Request, response: Response, conn=Depends(get_conn)):
    """First start: the first person to set a PIN becomes administrator."""
    conn.execute("LOCK TABLE staff IN SHARE ROW EXCLUSIVE MODE")  # two people can't both become first admin
    if not _setup_needed(conn):
        raise HTTPException(409, "Setup is already done. Log in instead.")
    if not auth.valid_pin(body.pin):
        raise HTTPException(422, _pin_rule())
    if body.staff_id:
        staff = conn.execute("SELECT id FROM staff WHERE id = %s AND active", (body.staff_id,)).fetchone()
        if not staff:
            raise HTTPException(404, "Staff member not found")
        staff_id = staff["id"]
    elif body.name and body.name.strip():
        staff_id = conn.execute("INSERT INTO staff (name) VALUES (%s) RETURNING id", (body.name.strip(),)).fetchone()["id"]
    else:
        raise HTTPException(422, "Choose your name, or type it in")
    conn.execute("UPDATE staff SET pin_hash = %s, is_admin = true, last_login_at = now() WHERE id = %s",
                 (auth.hash_pin(body.pin), staff_id))
    _set_cookie(response, auth.new_session(conn, staff_id, request.headers.get("user-agent")))
    log.info("first-time setup: staff %s is administrator", staff_id)
    return {"ok": True}


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, conn=Depends(get_conn)):
    auth.end_session(conn, request.cookies.get(auth.COOKIE))
    response.delete_cookie(auth.COOKIE, path="/")


@router.post("/pin", status_code=204)
def change_own_pin(body: PinChangeIn, request: Request, staff=Depends(auth.require_staff), conn=Depends(get_conn)):
    row = conn.execute("SELECT pin_hash FROM staff WHERE id = %s", (staff["id"],)).fetchone()
    if not auth.check_pin(body.current_pin, row["pin_hash"]):
        raise HTTPException(401, "Current PIN is wrong")
    if not auth.valid_pin(body.new_pin):
        raise HTTPException(422, _pin_rule())
    conn.execute("UPDATE staff SET pin_hash = %s WHERE id = %s", (auth.hash_pin(body.new_pin), staff["id"]))
    # Log out other devices, keep this one.
    conn.execute("DELETE FROM sessions WHERE staff_id = %s AND token_hash <> %s",
                 (staff["id"], auth.token_hash(request.cookies.get(auth.COOKIE, ""))))
