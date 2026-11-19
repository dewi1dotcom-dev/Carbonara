"""Phone / PC notifications: this device's subscription, each person's choices and a test (app/push.py)."""

from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import auth, push
from ..common import bad_request
from ..db import get_conn

router = APIRouter(tags=["notifications"])

# The browsers' push services. The server sends to the address a browser gives, so only these are
# accepted (never an address inside the network).
PUSH_HOSTS = (".googleapis.com", ".mozilla.com", ".mozaws.net", ".push.apple.com", ".notify.windows.com")


class Keys(BaseModel):
    p256dh: str = Field(min_length=10, max_length=200)
    auth: str = Field(min_length=10, max_length=100)


class SubscriptionIn(BaseModel):
    endpoint: str = Field(max_length=1000)
    keys: Keys


class EndpointIn(BaseModel):
    endpoint: str = Field(max_length=1000)


class PrefsIn(BaseModel):
    prefs: dict[str, bool]


def _check_endpoint(endpoint: str) -> None:
    parts = urlsplit(endpoint)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not any(host.endswith(h) or host == h[1:] for h in PUSH_HOSTS):
        raise bad_request("This browser's notification service is not supported")


def _saved_prefs(conn, staff_id: int) -> dict:
    return conn.execute("SELECT push_prefs FROM staff WHERE id = %s", (staff_id,)).fetchone()["push_prefs"] or {}


@router.get("/push/config")
def push_config(request: Request, conn=Depends(get_conn)):
    me = request.state.staff
    _, public = push.vapid_keys(conn)
    devices = conn.execute("""SELECT count(*) AS n FROM push_subscriptions p JOIN sessions x ON x.token_hash = p.session_hash
                               WHERE p.staff_id = %s AND x.expires_at > now()""", (me["id"],)).fetchone()["n"]
    return {"public_key": public, "kinds": push.kinds_for(me),
            "prefs": push.prefs_for({**me, "push_prefs": _saved_prefs(conn, me["id"])}), "devices": devices}


@router.post("/push/subscriptions", status_code=204)
def subscribe(body: SubscriptionIn, request: Request, conn=Depends(get_conn)):
    """Turn notifications on for this browser (also called on every start, so the subscription follows
    whoever is logged in on the device now)."""
    _check_endpoint(body.endpoint)
    session = auth.token_hash(request.cookies.get(auth.COOKIE) or "")
    conn.execute(
        """INSERT INTO push_subscriptions (staff_id, session_hash, endpoint, p256dh, auth, user_agent)
           VALUES (%s, %s, %s, %s, %s, %s)
           ON CONFLICT (endpoint) DO UPDATE SET staff_id = EXCLUDED.staff_id, session_hash = EXCLUDED.session_hash,
                  p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent""",
        (request.state.staff["id"], session, body.endpoint, body.keys.p256dh, body.keys.auth,
         (request.headers.get("user-agent") or "")[:300]))


@router.post("/push/unsubscribe", status_code=204)
def unsubscribe(body: EndpointIn, request: Request, conn=Depends(get_conn)):
    conn.execute("DELETE FROM push_subscriptions WHERE endpoint = %s AND staff_id = %s",
                 (body.endpoint, request.state.staff["id"]))


@router.put("/push/prefs")
def set_prefs(body: PrefsIn, request: Request, conn=Depends(get_conn)):
    """Which kinds this person wants, on all their devices."""
    me = request.state.staff
    saved = _saved_prefs(conn, me["id"])
    saved.update({k: v for k, v in body.prefs.items() if k in push.KINDS})
    conn.execute("UPDATE staff SET push_prefs = %s WHERE id = %s", (Jsonb(saved), me["id"]))
    return push.prefs_for({**me, "push_prefs": saved})


@router.post("/push/test", status_code=204)
def test(request: Request, conn=Depends(get_conn)):
    """A test notification to all of this person's devices (whatever the choices)."""
    me = request.state.staff
    n = conn.execute("""SELECT count(*) AS n FROM push_subscriptions p JOIN sessions x ON x.token_hash = p.session_hash
                         WHERE p.staff_id = %s AND x.expires_at > now()""", (me["id"],)).fetchone()["n"]
    if not n:
        raise bad_request("Notifications are not turned on on any of your devices")
    title, text = (("Test fra Carbonara", "Varslene virker på denne enheten.") if me["language"] == "no"
                   else ("Test from Carbonara", "Notifications work on this device."))
    conn.execute("INSERT INTO push_outbox (staff_id, payload, urgency) VALUES (%s, %s, 'high')",
                 (me["id"], Jsonb({"title": title, "body": text, "url": "#/", "tag": "test"})))
