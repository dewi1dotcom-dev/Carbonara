"""Staff login with a personal PIN.

- PINs are 4–8 digits, stored as scrypt hashes (stdlib, no extra package).
- Wrong PIN 5 times -> that account is locked for 15 minutes.
- A login creates a session: a random token in an HttpOnly cookie; the
  database only keeps its SHA-256, so a leaked database can't be used to
  log in. Sessions last SESSION_DAYS.
- Every /api route except health/version/auth needs a session
  (require_staff); admin-only routes use require_admin.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

from fastapi import Depends, HTTPException, Request

from .db import get_conn

COOKIE = "carbonara_session"
SESSION_DAYS = 30
MAX_FAILURES = 5
LOCK_MINUTES = 15
PIN_MIN, PIN_MAX = 4, 8

# Columns that are safe to send to the browser (never pin_hash).
STAFF_PUBLIC = ("id, name, first_name, last_name, phone, active, is_admin, is_superadmin, language, created_at, "
                "last_login_at, (pin_hash IS NOT NULL) AS has_pin")


# Top menu items a team can be given (keys = data-nav in index.html). Today is
# always there; System is for system admins only, so neither is listed.
MENU_ITEMS = ("arrivals", "vehicles", "storage", "testdrive", "deliveries", "settings")


def menu_for(staff: dict) -> list[str]:
    """The menu items this person sees. System admins: all (they can't lock
    themselves out). Others: Today + their team's items; no team = Today only.
    The frontend hides the rest and blocks their pages (not a server lock)."""
    if staff.get("is_superadmin"):
        return ["today", *MENU_ITEMS, "system"]
    return ["today", *[m for m in MENU_ITEMS if m in (staff.get("team_menu") or [])]]


def valid_pin(pin: str) -> bool:
    return isinstance(pin, str) and pin.isdigit() and PIN_MIN <= len(pin) <= PIN_MAX


def hash_pin(pin: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(pin.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def check_pin(pin: str, stored: str | None) -> bool:
    try:
        scheme, salt, digest = (stored or "").split("$")
        if scheme != "scrypt":
            return False
        test = hashlib.scrypt(pin.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1, dklen=32)
        return hmac.compare_digest(test.hex(), digest)
    except (ValueError, TypeError):
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_session(conn, staff_id: int, user_agent: str | None) -> str:
    token = secrets.token_urlsafe(32)
    conn.execute(
        """INSERT INTO sessions (token_hash, staff_id, expires_at, user_agent)
           VALUES (%s, %s, now() + make_interval(days => %s), %s)""",
        (token_hash(token), staff_id, SESSION_DAYS, (user_agent or "")[:200]),
    )
    conn.execute("DELETE FROM sessions WHERE expires_at < now()")  # tidy up old ones
    return token


def end_session(conn, token: str | None) -> None:
    if token:
        conn.execute("DELETE FROM sessions WHERE token_hash = %s", (token_hash(token),))


def session_staff(conn, token: str | None) -> dict | None:
    if not token:
        return None
    row = conn.execute(
        """SELECT s.id, s.name, s.active, s.is_admin, s.is_superadmin, s.language, s.theme, s.created_at, s.last_login_at,
                  (s.pin_hash IS NOT NULL) AS has_pin, s.team_id, t.name AS team_name, t.menu AS team_menu
              FROM sessions x JOIN staff s ON s.id = x.staff_id
              LEFT JOIN teams t ON t.id = s.team_id
             WHERE x.token_hash = %s AND x.expires_at > now() AND s.active""",
        (token_hash(token),),
    ).fetchone()
    if row:
        row["menu"] = menu_for(row)
        del row["team_menu"]
        conn.execute("UPDATE sessions SET last_seen_at = now() WHERE token_hash = %s AND last_seen_at < now() - interval '5 minutes'",
                     (token_hash(token),))
    return row


def require_staff(request: Request, conn=Depends(get_conn)) -> dict:
    staff = session_staff(conn, request.cookies.get(COOKIE))
    if not staff:
        raise HTTPException(401, "Not logged in")
    request.state.staff = staff
    return staff


# --------------------------------------------------------------------------- #
# Delivery kiosk: a tablet at the dealership where customers register the car
# they drop off. An admin turns a device into a kiosk; it then has its own
# cookie (token hash in kiosk_devices) that only opens the /kiosk routes.
# --------------------------------------------------------------------------- #

KIOSK_COOKIE = "carbonara_kiosk"
KIOSK_DAYS = 365  # renewed whenever the kiosk loads its form


def new_kiosk(conn, name: str, staff_id: int) -> str:
    token = secrets.token_urlsafe(32)
    conn.execute("INSERT INTO kiosk_devices (name, token_hash, created_by) VALUES (%s, %s, %s)",
                 (name, token_hash(token), staff_id))
    return token


def kiosk_device(conn, token: str | None) -> dict | None:
    if not token:
        return None
    row = conn.execute("SELECT id, name FROM kiosk_devices WHERE token_hash = %s AND revoked_at IS NULL",
                       (token_hash(token),)).fetchone()
    if row:
        conn.execute("UPDATE kiosk_devices SET last_seen_at = now() WHERE id = %s "
                     "AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')", (row["id"],))
    return row


def require_kiosk_or_staff(request: Request, conn=Depends(get_conn)) -> dict:
    """The kiosk routes: a kiosk tablet, or a logged-in staff member (preview)."""
    staff = session_staff(conn, request.cookies.get(COOKIE))
    if staff:
        request.state.staff = staff
        return {"staff": staff, "kiosk": None}
    kiosk = kiosk_device(conn, request.cookies.get(KIOSK_COOKIE))
    if kiosk:
        return {"staff": None, "kiosk": kiosk}
    raise HTTPException(401, "This device is not set up as a delivery kiosk")


def require_admin(staff: dict = Depends(require_staff)) -> dict:
    if not staff["is_admin"]:
        raise HTTPException(403, "Only an administrator can do this")
    return staff


def require_superadmin(staff: dict = Depends(require_staff)) -> dict:
    if not staff["is_superadmin"]:
        raise HTTPException(403, "Only a system admin can do this")
    return staff
