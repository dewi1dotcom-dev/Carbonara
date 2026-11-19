"""Phone / PC notifications (Web Push).

How it works:
- A browser that turns notifications on (over HTTPS) gives us a push address (`endpoint`, run by
  Google for Chrome / Opera, Apple, or Mozilla) and two keys. Stored in `push_subscriptions`, tied to
  the login session, so logging out stops them.
- `notify()` is called inside a request's transaction and only writes rows to `push_outbox`; a request
  that fails sends nothing. The app's push thread (`start()`) sends them within seconds, encrypted for
  that browser (the push service can't read them) and signed with our VAPID key (made once, kept in
  app_settings, never shown).
- The push thread also makes the scheduled notifications once a minute (`scheduled()`): PDI cars not
  prepared, storage checks / 12V charging due, test drives / rentals not back, and, for system admins,
  the background worker and disk warnings. It runs in the app, not the worker, so it can still warn when
  the worker has stopped. `push_sent` makes each of them go out once.
- The texts are short and never contain customer data (no names, phones, message texts): they show on a
  locked phone. The server writes them in the recipient's language, so both languages live here.
- Each person can turn each kind off (`staff.push_prefs`); kinds tied to a page only go to people whose
  team sees that page.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import logging
import threading
import time
from typing import Callable, Iterable, Optional

from psycopg.types.json import Jsonb

from .auth import menu_for
from .config import settings
from .db import pool

log = logging.getLogger(__name__)

# The kinds a person can turn on / off, in the order shown. The menu items a kind needs (any of them);
# None = everyone. "system" is only in a system admin's menu.
KIND_MENU: dict[str, Optional[tuple[str, ...]]] = {
    "dm": None,                                  # new private message
    "board": None,                               # new message on the Today board (own team / everyone)
    "pdi_prep": ("vehicles", "pdi_orders"),      # PDI soon, car not prepared yet
    "pdi_status": ("vehicles", "pdi_orders"),    # PDI date confirmed / PDI done (to whoever made the order)
    "late_return": ("testdrive", "rental"),      # test drive / rental car not back (to whoever handed it out)
    "daily_due": ("vehicles", "storage"),        # storage checks + 12V charging due (one in the morning)
    "system": ("system",),                       # background worker stopped, disk almost full
}
KINDS = tuple(KIND_MENU)

TTL_SECONDS = 12 * 3600          # a phone that is off gets it later, up to 12 hours
OUTBOX_MAX_AGE = dt.timedelta(hours=1)
TICK_SECONDS = 3                 # how often the push thread looks for something to send
SCHEDULE_SECONDS = 60            # how often it checks the scheduled notifications
SYSTEM_GRACE_SECONDS = 600       # no worker / disk alerts in the first 10 min after a start (redeploy)
MORNING = dt.time(7, 30)         # morning notifications, Monday–Friday
DAY_END = dt.time(21, 0)         # late-return notifications only 07:00–21:00
TEST_DRIVE_LATE = dt.timedelta(hours=3)

VAPID_KEY = "push_vapid"  # app_settings: "<private> <public>" (secret; not in the SETTINGS registry)


# --------------------------------------------------------------------------- #
# keys and who gets what
# --------------------------------------------------------------------------- #

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def vapid_keys(conn) -> tuple[str, str]:
    """(private key as base64url DER, public key for the browser). Made once (start() makes it at startup).
    Both halves are one row, so they can never come from two different keys. Changing it would stop every
    device's notifications until they are turned on again."""
    def read():
        row = conn.execute("SELECT value FROM app_settings WHERE key = %s", (VAPID_KEY,)).fetchone()
        if not row:
            return None
        private, _, public = row["value"].partition(" ")
        return (private, public) if private and public else None

    keys = read()
    if keys:
        return keys
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    key = ec.generate_private_key(ec.SECP256R1())
    private = _b64url(key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8,
                                        serialization.NoEncryption()))
    public = _b64url(key.public_key().public_bytes(serialization.Encoding.X962,
                                                   serialization.PublicFormat.UncompressedPoint))
    conn.execute("INSERT INTO app_settings (key, value) VALUES (%s, %s) ON CONFLICT (key) DO NOTHING",
                 (VAPID_KEY, f"{private} {public}"))
    log.info("Made the key for phone notifications")
    return read()  # whichever was saved first


def _subject() -> str:
    """Contact the push services may use (required in the signature): the company e-mail if set."""
    email = (settings.privacy_email or "").strip()
    return f"mailto:{email}" if "@" in email and " " not in email else "https://carbonara.invalid"


def kinds_for(staff: dict) -> list[str]:
    """The kinds this person can get (needs `is_superadmin` and `team_menu` or `menu`)."""
    menu = staff.get("menu") or menu_for(staff)
    return [k for k, need in KIND_MENU.items() if need is None or any(m in menu for m in need)]


def prefs_for(staff: dict) -> dict[str, bool]:
    saved = staff.get("push_prefs") or {}
    return {k: saved.get(k) is not False for k in kinds_for(staff)}


# Active people with at least one device that can get notifications (a live session).
_RECIPIENTS = """
    SELECT s.id, s.language, s.is_superadmin, s.push_prefs, t.menu AS team_menu
      FROM staff s LEFT JOIN teams t ON t.id = s.team_id
     WHERE s.active AND s.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM push_subscriptions p JOIN sessions x ON x.token_hash = p.session_hash
                    WHERE p.staff_id = s.id AND x.expires_at > now())"""


def notify(conn, staff_ids: Optional[Iterable[int]], kind: str, *, en: tuple[str, str], no: tuple[str, str],
           url: str | Callable[[dict], str] = "#/", tag: Optional[str] = None, urgency: str = "normal",
           exclude: Optional[int] = None) -> int:
    """Queue a notification for these people (None = everyone) who want this kind. `en` / `no` =
    (title, body); `url` = the page it opens (or a function of the person). Never raises: a problem
    here must not undo the change the request made (it runs in a savepoint)."""
    try:
        with conn.transaction():
            if staff_ids is None:
                rows = conn.execute(_RECIPIENTS).fetchall()
            else:
                ids = [i for i in staff_ids if i]
                if not ids:
                    return 0
                rows = conn.execute(_RECIPIENTS + " AND s.id = ANY(%s)", (ids,)).fetchall()
            count = 0
            for s in rows:
                if s["id"] == exclude or not prefs_for(s).get(kind):
                    continue
                title, body = no if s["language"] == "no" else en
                payload = {"title": title, "body": body, "url": url(s) if callable(url) else url,
                           "tag": tag or kind}
                conn.execute("INSERT INTO push_outbox (staff_id, payload, urgency) VALUES (%s, %s, %s)",
                             (s["id"], Jsonb(payload), urgency))
                count += 1
            return count
    except Exception:
        log.exception("Could not queue a %s notification", kind)
        return 0


def has_menu(staff: dict, item: str) -> bool:
    return item in menu_for(staff)


# --------------------------------------------------------------------------- #
# sending
# --------------------------------------------------------------------------- #

def drain(conn, limit: int = 50) -> int:
    """Send up to `limit` queued notifications. Each is taken off the queue first (sent at most once)."""
    rows = conn.execute(
        """DELETE FROM push_outbox WHERE id IN (SELECT id FROM push_outbox ORDER BY id LIMIT %s
                                                  FOR UPDATE SKIP LOCKED)
           RETURNING id, staff_id, payload, urgency, created_at""", (limit,)).fetchall()
    if not rows:
        conn.commit()
        return 0
    subs = conn.execute(
        """SELECT p.id, p.staff_id, p.endpoint, p.p256dh, p.auth
             FROM push_subscriptions p JOIN sessions x ON x.token_hash = p.session_hash
            WHERE p.staff_id = ANY(%s) AND x.expires_at > now()""",
        (list({r["staff_id"] for r in rows}),)).fetchall()
    private, _ = vapid_keys(conn)
    now = conn.execute("SELECT now() AS t").fetchone()["t"]
    conn.commit()  # the queue rows are gone before anything is sent

    from pywebpush import WebPushException, webpush
    sent, gone = set(), set()
    for r in sorted(rows, key=lambda r: r["id"]):
        if now - r["created_at"] > OUTBOX_MAX_AGE:
            continue  # stuck for an hour (e.g. no internet): too old to be useful
        data = json.dumps(r["payload"])
        for s in subs:
            if s["staff_id"] != r["staff_id"] or s["id"] in gone:
                continue
            try:
                webpush(subscription_info={"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                        data=data, vapid_private_key=private, vapid_claims={"sub": _subject()},
                        ttl=TTL_SECONDS, headers={"Urgency": r["urgency"]}, timeout=10)
                sent.add(s["id"])
            except WebPushException as exc:
                status = getattr(exc.response, "status_code", None)
                if status in (404, 410):  # the browser dropped it (notifications turned off, app removed)
                    gone.add(s["id"])
                else:
                    log.warning("Notification not sent (push service answered %s)", status)
            except Exception as exc:
                log.warning("Notification not sent (%s)", type(exc).__name__)
    if gone:
        conn.execute("DELETE FROM push_subscriptions WHERE id = ANY(%s)", (list(gone),))
    if sent - gone:
        conn.execute("UPDATE push_subscriptions SET last_sent_at = now() WHERE id = ANY(%s)", (list(sent - gone),))
    conn.commit()
    return len(rows)


# --------------------------------------------------------------------------- #
# scheduled notifications
# --------------------------------------------------------------------------- #

def _once(conn, key: str) -> bool:
    """True the first time a key is seen (then remembered for 30 days)."""
    return conn.execute("INSERT INTO push_sent (key) VALUES (%s) ON CONFLICT DO NOTHING RETURNING key",
                        (key,)).fetchone() is not None


def car_text(r: dict) -> str:
    reg = r.get("registration_number")
    return " ".join(x for x in (r.get("make"), r.get("model"), reg) if x) or "–"


def _cars(rows: list[dict], more_en: str, more_no: str) -> tuple[str, str]:
    names = [car_text(r) for r in rows[:3]]
    rest = len(rows) - len(names)
    text = ", ".join(names)
    return (text + (f" {more_en.format(n=rest)}" if rest else ""),
            text + (f" {more_no.format(n=rest)}" if rest else ""))


def _pdi_url(s: dict) -> str:
    return "#/pdi-orders" if has_menu(s, "pdi_orders") else "#/"


def scheduled(conn, *, system_checks: bool = True) -> None:
    now = conn.execute("SELECT now() AT TIME ZONE 'Europe/Oslo' AS t").fetchone()["t"]
    today, clock = now.date(), now.time()
    workday = today.weekday() < 5
    morning = workday and MORNING <= clock < DAY_END
    daytime = dt.time(7, 0) <= clock < DAY_END

    if morning:
        _pdi_prep(conn, today)
        _daily_due(conn, today)
    if daytime:
        _late_returns(conn)
    if system_checks:
        _system(conn, today)
    if clock.hour == 3 and clock.minute < 2:  # tidy up once a night
        conn.execute("DELETE FROM push_sent WHERE sent_at < now() - interval '30 days'")
        conn.execute("DELETE FROM push_outbox WHERE created_at < now() - interval '1 hour'")


def _pdi_prep(conn, today: dt.date) -> None:
    """Booked PDIs up to the next working day whose car isn't prepared (the 🔔 bar), once per order a day."""
    from .routers.pdi import ORDER_SELECT, _next_workday
    rows = conn.execute(
        ORDER_SELECT + """ WHERE o.status = 'booked' AND o.prepared_at IS NULL AND v.deleted_at IS NULL
                             AND (o.pdi_at AT TIME ZONE 'Europe/Oslo')::date BETWEEN %s AND %s
                           ORDER BY o.pdi_at""", (today, _next_workday(today))).fetchall()
    new = [r for r in rows if _once(conn, f"pdi_prep:{r['id']}:{today}")]
    if not new:
        return
    cars_en, cars_no = _cars(new, "and {n} more", "og {n} til")
    when = new[0]["pdi_local"].strftime("%d.%m.%Y %H:%M") if new[0]["pdi_local"] else ""
    if len(new) == 1:
        en = ("Prepare the car for the PDI", f"{cars_en} · PDI {when}")
        no = ("Gjør bilen klar til nybilklargjøring", f"{cars_no} · nybilklargjøring {when}")
    else:
        en = (f"{len(new)} cars to prepare for the PDI", cars_en)
        no = (f"{len(new)} biler skal gjøres klar til nybilklargjøring", cars_no)
    notify(conn, None, "pdi_prep", en=en, no=no, url=_pdi_url, tag=f"pdi_prep-{today}")


def _daily_due(conn, today: dt.date) -> None:
    """One morning notification: storage checks and 12V charging due within 3 days or overdue."""
    from .routers.storage_care import charging_due_list, storage_check_due_list
    checks, charges = len(storage_check_due_list(conn)), len(charging_due_list(conn, today))
    if not (checks or charges) or not _once(conn, f"daily_due:{today}"):
        return
    en = [f"Storage checks: {checks}" if checks else None, f"12V charging: {charges}" if charges else None]
    no = [f"Lagerkontroller: {checks}" if checks else None, f"12V-lading: {charges}" if charges else None]
    notify(conn, None, "daily_due", en=("Due today or soon", " · ".join(x for x in en if x)),
           no=("Forfaller i dag eller snart", " · ".join(x for x in no if x)), url="#/", tag=f"daily_due-{today}")


def _late_returns(conn) -> None:
    """Test drives out for 3 hours and rentals past the expected return: to whoever handed the car out."""
    for r in conn.execute(
            """SELECT t.id, t.started_by, v.make, v.model, v.registration_number
                 FROM test_drives t JOIN vehicles v ON v.id = t.vehicle_id
                WHERE t.status = 'out' AND t.plate_moved_at IS NULL AND v.deleted_at IS NULL
                  AND t.started_at < now() - %s AND t.started_at > now() - interval '2 days'""",
            (TEST_DRIVE_LATE,)).fetchall():
        if r["started_by"] and _once(conn, f"testdrive_late:{r['id']}"):
            notify(conn, [r["started_by"]], "late_return",
                   en=("Test drive not back yet", f"{car_text(r)} · out for more than 3 hours"),
                   no=("Prøvekjøring ikke tilbake", f"{car_text(r)} · ute i mer enn 3 timer"),
                   url="#/test-drive", tag=f"testdrive-{r['id']}")
    for r in conn.execute(
            """SELECT r.id, r.started_by, r.expected_return_at, (r.expected_return_at AT TIME ZONE 'Europe/Oslo') AS due,
                      c.make, c.model, c.registration_number
                 FROM rentals r JOIN rental_cars c ON c.id = r.rental_car_id
                WHERE r.status = 'out' AND r.expected_return_at < now()
                  AND r.expected_return_at > now() - interval '2 days'""").fetchall():
        if r["started_by"] and _once(conn, f"rental_late:{r['id']}:{r['expected_return_at'].isoformat()}"):
            due = r["due"].strftime("%d.%m.%Y %H:%M")
            notify(conn, [r["started_by"]], "late_return",
                   en=("Rental car not returned on time", f"{car_text(r)} · expected back {due}"),
                   no=("Leiebil ikke levert i tide", f"{car_text(r)} · skulle vært tilbake {due}"),
                   url="#/rental", tag=f"rental-{r['id']}")


def _system(conn, today: dt.date) -> None:
    """System admins: the background worker's problems and low disk space, each at most once a day."""
    from . import diskstatus, workerstatus
    texts = {
        "stopped": (("Background worker has stopped", "Deletions and registry updates are not running. See the System page."),
                    ("Bakgrunnsjobben har stoppet", "Slettinger og registeroppdateringer kjører ikke. Se Systemsiden.")),
        "step_failed": (("Background worker: a step failed", "See the System page."),
                        ("Bakgrunnsjobben: et steg feilet", "Se Systemsiden.")),
        "cleanup_late": (("Daily cleanup has not run", "See the System page."),
                         ("Den daglige oppryddingen har ikke kjørt", "Se Systemsiden.")),
        "cleanup_failed": (("Daily cleanup failed", "See the System page."),
                           ("Den daglige oppryddingen feilet", "Se Systemsiden.")),
        "disk_warn": (("Disk space is getting low", "See the System page."),
                      ("Lite ledig diskplass", "Se Systemsiden.")),
        "disk_bad": (("Disk almost full", "Carbonara may stop saving photos and files. See the System page."),
                     ("Disken er nesten full", "Carbonara kan slutte å lagre bilder og filer. Se Systemsiden.")),
    }
    found = [p["kind"] for p in workerstatus.status(conn)["problems"] if p["kind"] in texts]
    level = diskstatus.status(conn)["level"]
    if level in ("warn", "bad"):
        found.append(f"disk_{level}")
    for kind in found:
        if _once(conn, f"system:{kind}:{today}"):
            en, no = texts[kind]
            notify(conn, None, "system", en=en, no=no, url="#/system", tag=f"system-{kind}", urgency="high")


# --------------------------------------------------------------------------- #
# the push thread (started by main.py)
# --------------------------------------------------------------------------- #

_stop = threading.Event()


def start() -> None:
    """Make the signing key now (one place, before any request can ask for it), then start the thread."""
    try:
        with pool.connection() as conn:
            vapid_keys(conn)
    except Exception:
        log.exception("Could not make the key for phone notifications")
    _stop.clear()
    threading.Thread(target=_run, name="push", daemon=True).start()


def stop() -> None:
    _stop.set()


def _run() -> None:
    started = time.monotonic()
    last_schedule = 0.0
    while not _stop.wait(TICK_SECONDS):
        if time.monotonic() - last_schedule >= SCHEDULE_SECONDS:
            last_schedule = time.monotonic()
            try:  # its own transaction: a failing check must not stop the sending below
                with pool.connection() as conn:
                    scheduled(conn, system_checks=time.monotonic() - started >= SYSTEM_GRACE_SECONDS)
            except Exception:
                log.exception("Scheduled notifications failed")
        try:
            with pool.connection() as conn:
                while drain(conn) == 50:
                    pass
        except Exception:
            log.exception("Sending notifications failed")
