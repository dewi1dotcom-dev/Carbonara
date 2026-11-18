"""Is the background worker (sync_worker) alive? It reports in after every round and after the daily
cleanup; status() turns that into warnings for system admins (System page and Today).

The worker does the GDPR deletions the privacy notices promise (test drive / rental customers,
deliveries, private messages), so a stopped worker must not go unnoticed."""

import datetime as dt
import logging

log = logging.getLogger("carbonara.workerstatus")

LOOP_LATE_MIN = 15           # a round takes about a minute (longer while syncing many cars)
HOUSEKEEPING_LATE_H = 26     # runs at start, then every 24 hours


def report(conn, name: str, ok: bool = True, detail: str | None = None) -> None:
    conn.execute(
        """INSERT INTO worker_status (name, at, ok, detail) VALUES (%s, now(), %s, %s)
           ON CONFLICT (name) DO UPDATE SET at = excluded.at, ok = excluded.ok, detail = excluded.detail""",
        (name, ok, (detail or None) and detail[:300]))


def status(conn) -> dict:
    rows = {r["name"]: r for r in conn.execute("SELECT name, at, ok, detail FROM worker_status").fetchall()}
    now = conn.execute("SELECT now() AS now").fetchone()["now"]
    loop, house = rows.get("loop"), rows.get("housekeeping")
    problems = []
    if not loop:
        problems.append({"kind": "never"})
    elif now - loop["at"] > dt.timedelta(minutes=LOOP_LATE_MIN):
        problems.append({"kind": "stopped", "since": loop["at"]})
    elif not loop["ok"]:
        problems.append({"kind": "step_failed", "steps": _steps(loop["detail"]), "at": loop["at"]})
    if loop and now - loop["at"] <= dt.timedelta(minutes=LOOP_LATE_MIN):
        if not house or now - house["at"] > dt.timedelta(hours=HOUSEKEEPING_LATE_H):
            problems.append({"kind": "cleanup_late", "since": house["at"] if house else None})
        elif not house["ok"]:
            problems.append({"kind": "cleanup_failed", "at": house["at"], "error": house["detail"]})
    return {
        "ok": not problems,
        "problems": problems,
        "loop_at": loop["at"] if loop else None,
        "housekeeping_at": house["at"] if house else None,
        "housekeeping_ok": house["ok"] if house else None,
    }


def _steps(detail: str | None) -> list[dict]:
    """'private_messages:OperationalError,registry_sync:Timeout' -> [{step, error}] (the page names the steps)."""
    out = []
    for part in (detail or "").split(","):
        step, _, err = part.partition(":")
        if step:
            out.append({"step": step, "error": err or None})
    return out
