"""Recalls / campaigns (0.41.0, phase 1; the user's request: "every dealer might have different brands …
keep it universal; automatic searches once when added, every now and then in storage, and when booking a PDI").

Carbonara works out WHEN a car needs a recall check:
- after the arrival inspection (request "arrival"),
- when a PDI is booked (request "pdi"),
- every `recall_check_days` while the car is in storage.
Staff then check in the brand's own system (a "recall source", entered by admins: name, the makes it covers
and its lookup address) and record the result: "no open recalls", or the recalls found. Only cars whose make
is covered by an active source are ever due, so a dealer without sources sees nothing.

Later phases add automatic sources (file import, public data, manufacturer APIs) that write the same tables.
No brand names in this file: the sources are data.
"""

from typing import Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from ..auth import require_admin
from ..common import bad_request, conflict, log_event, not_found
from ..config import settings
from ..db import get_conn

router = APIRouter(tags=["recalls"])


def _norm(sql: str) -> str:
    """SQL: a make without case, spaces or punctuation ("MG Motor" -> "mgmotor")."""
    return f"lower(regexp_replace(coalesce({sql}, ''), '[^A-Za-z0-9]', '', 'g'))"


# An active source covers the car (alias v): no makes listed = every car; else the car's make starts with one.
COVERED_SQL = f"""EXISTS (SELECT 1 FROM recall_sources s
     WHERE s.active AND (cardinality(s.makes) = 0 OR EXISTS (
           SELECT 1 FROM unnest(s.makes) m WHERE {_norm('m')} <> '' AND {_norm('v.make')} LIKE {_norm('m')} || '%%')))"""
# ('%%': always run with parameters, where a literal % is written twice)

# The latest check that gave an answer (not an error), per car.
LAST_CHECK_SQL = """(SELECT max(c.checked_at) FROM recall_checks c WHERE c.vehicle_id = v.id AND c.result <> 'error')"""

# Cars here (not off site / still at the arrival inspection) that need a recall check now.
DUE_WHERE = f"""v.deleted_at IS NULL AND v.status NOT IN ('intake', 'off_site') AND {COVERED_SQL}
    AND (v.recall_check_requested_at IS NOT NULL OR {LAST_CHECK_SQL} IS NULL
         OR {LAST_CHECK_SQL} < now() - make_interval(days => %(days)s))"""

OPEN_COUNT_SQL = "(SELECT count(*) FROM vehicle_recalls rc WHERE rc.vehicle_id = v.id AND rc.status = 'open')"

# For PDI orders (ORDER_SELECT): the car's open recalls, so the workshop fixes them during the PDI.
OPEN_RECALLS_JSON = """(SELECT coalesce(json_agg(json_build_object('code', rc.code, 'title', rc.title,
        'certainty', rc.certainty) ORDER BY rc.created_at), '[]'::json)
      FROM vehicle_recalls rc WHERE rc.vehicle_id = v.id AND rc.status = 'open') AS open_recalls"""


def due_list(conn) -> list[dict]:
    """Every car that needs a recall check now (Today, the morning notification)."""
    return conn.execute(
        f"""SELECT v.id, v.make, v.model, v.model_year, v.registration_number, v.vin,
                   coalesce(v.recall_check_reason, 'storage') AS reason, {LAST_CHECK_SQL} AS last_checked
              FROM vehicles v WHERE {DUE_WHERE}
             ORDER BY v.recall_check_requested_at NULLS LAST, {LAST_CHECK_SQL} NULLS FIRST""",
        {"days": settings.recall_check_days}).fetchall()


def open_list(conn) -> list[dict]:
    """Open recalls on cars that are still here (Today → Needs attention)."""
    return conn.execute(
        """SELECT v.id, v.make, v.model, v.model_year, v.registration_number, rc.code, rc.title, rc.certainty
             FROM vehicle_recalls rc JOIN vehicles v ON v.id = rc.vehicle_id
            WHERE rc.status = 'open' AND v.deleted_at IS NULL AND v.status <> 'off_site'
            ORDER BY rc.certainty, rc.created_at""").fetchall()


def request_check(conn, vehicle_id: int, reason: str) -> None:
    """An event asks for a fresh check (arrival inspection completed, PDI booked). Harmless for cars no
    source covers: they are never listed as due."""
    conn.execute("UPDATE vehicles SET recall_check_requested_at = now(), recall_check_reason = %s WHERE id = %s",
                 (reason, vehicle_id))


# --------------------------------------------------------------------------- #
# sources (admins, Settings → Recall sources)
# --------------------------------------------------------------------------- #

class SourceIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    makes: str = Field("", max_length=300)  # comma-separated; empty = every car
    url: Optional[str] = Field(None, max_length=500)
    note: Optional[str] = Field(None, max_length=300)


class SourcePatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    makes: Optional[str] = Field(None, max_length=300)
    url: Optional[str] = Field(None, max_length=500)
    note: Optional[str] = Field(None, max_length=300)
    active: Optional[bool] = None


def _makes(text: str) -> list[str]:
    seen, out = set(), []
    for part in (text or "").split(","):
        name = " ".join(part.split())
        if name and name.lower() not in seen:
            seen.add(name.lower())
            out.append(name[:40])
    return out


def _url(text: Optional[str]) -> Optional[str]:
    url = (text or "").strip()
    if not url:
        return None
    if not url.lower().startswith(("https://", "http://")):
        raise bad_request("The address must start with https://")
    return url


def _text(text: Optional[str]) -> Optional[str]:
    return " ".join((text or "").split()) or None


@router.get("/recall-sources")
def list_sources(include_inactive: bool = False, conn=Depends(get_conn)):
    return conn.execute("SELECT id, name, makes, url, note, active FROM recall_sources "
                        "WHERE active OR %s ORDER BY active DESC, lower(name)", (include_inactive,)).fetchall()


@router.post("/recall-sources", status_code=201)
def add_source(body: SourceIn, conn=Depends(get_conn), admin=Depends(require_admin)):
    return conn.execute(
        """INSERT INTO recall_sources (name, makes, url, note, created_by) VALUES (%s, %s, %s, %s, %s)
           RETURNING id, name, makes, url, note, active""",
        (_text(body.name), _makes(body.makes), _url(body.url), _text(body.note), admin["id"])).fetchone()


@router.patch("/recall-sources/{source_id}")
def edit_source(source_id: int, body: SourcePatch, conn=Depends(get_conn), _admin=Depends(require_admin)):
    if not conn.execute("SELECT 1 FROM recall_sources WHERE id = %s", (source_id,)).fetchone():
        raise not_found("Recall source")
    sent = body.model_fields_set
    values = {
        "name": _text(body.name) if "name" in sent else None,
        "makes": _makes(body.makes or "") if "makes" in sent else None,
        "url": _url(body.url) if "url" in sent else None,
        "note": _text(body.note) if "note" in sent else None,
        "active": body.active if "active" in sent else None,
    }
    if "name" in sent and not values["name"]:
        raise bad_request("Give the source a name")
    for col, value in values.items():
        if col in sent:
            conn.execute(f"UPDATE recall_sources SET {col} = %s WHERE id = %s", (value, source_id))  # col: fixed list
    return conn.execute("SELECT id, name, makes, url, note, active FROM recall_sources WHERE id = %s",
                        (source_id,)).fetchone()


# --------------------------------------------------------------------------- #
# one car
# --------------------------------------------------------------------------- #

def _vehicle(conn, vehicle_id: int) -> dict:
    v = conn.execute("SELECT * FROM vehicles v WHERE v.id = %s AND v.deleted_at IS NULL", (vehicle_id,)).fetchone()
    if not v:
        raise not_found("Vehicle")
    return v


def _sources_for(conn, vehicle_id: int) -> list[dict]:
    return conn.execute(
        f"""SELECT s.id, s.name, s.url, s.note FROM recall_sources s, vehicles v
             WHERE v.id = %s AND s.active AND (cardinality(s.makes) = 0 OR EXISTS (
                   SELECT 1 FROM unnest(s.makes) m WHERE {_norm('m')} <> '' AND {_norm('v.make')} LIKE {_norm('m')} || '%%'))
             ORDER BY lower(s.name)""", (vehicle_id,)).fetchall()


def _reason(conn, v: dict) -> str:
    """Why a check now counts: the pending request, else the regular check in storage, else by hand."""
    if v["recall_check_requested_at"]:
        return v["recall_check_reason"] or "manual"
    due = conn.execute(f"SELECT 1 FROM vehicles v WHERE v.id = %(id)s AND {DUE_WHERE}",
                       {"id": v["id"], "days": settings.recall_check_days}).fetchone()
    return "storage" if due else "manual"


def _source_id(conn, source_id: Optional[int]) -> Optional[int]:
    if source_id is not None and not conn.execute("SELECT 1 FROM recall_sources WHERE id = %s", (source_id,)).fetchone():
        raise not_found("Recall source")
    return source_id


def _record_check(conn, v: dict, source_id: Optional[int], result: str, staff_id: int, note: Optional[str]) -> None:
    reason = _reason(conn, v)
    conn.execute("""INSERT INTO recall_checks (vehicle_id, source_id, checked_by, result, reason, note)
                    VALUES (%s, %s, %s, %s, %s, %s)""", (v["id"], source_id, staff_id, result, reason, note))
    conn.execute("UPDATE vehicles SET recall_check_requested_at = NULL, recall_check_reason = NULL WHERE id = %s",
                 (v["id"],))
    name = conn.execute("SELECT name FROM recall_sources WHERE id = %s", (source_id,)).fetchone() if source_id else None
    log_event(conn, v["id"], "recall_check", staff_id=staff_id,
              data={"result": result, "source": name["name"] if name else None, "reason": reason})


@router.get("/vehicles/{vehicle_id}/recalls")
def vehicle_recalls(vehicle_id: int, conn=Depends(get_conn)):
    v = _vehicle(conn, vehicle_id)
    params = {"id": vehicle_id, "days": settings.recall_check_days}
    due = conn.execute(f"SELECT 1 FROM vehicles v WHERE v.id = %(id)s AND {DUE_WHERE}", params).fetchone()
    recalls = conn.execute(
        """SELECT r.*, s.name AS source_name, cb.name AS created_by_name, xb.name AS closed_by_name
             FROM vehicle_recalls r
             LEFT JOIN recall_sources s ON s.id = r.source_id
             LEFT JOIN staff cb ON cb.id = r.created_by
             LEFT JOIN staff xb ON xb.id = r.closed_by
            WHERE r.vehicle_id = %s
            ORDER BY r.status <> 'open', r.created_at DESC""", (vehicle_id,)).fetchall()
    checks = conn.execute(
        """SELECT c.id, c.checked_at, c.result, c.reason, c.note, s.name AS source_name, b.name AS checked_by_name
             FROM recall_checks c
             LEFT JOIN recall_sources s ON s.id = c.source_id
             LEFT JOIN staff b ON b.id = c.checked_by
            WHERE c.vehicle_id = %s ORDER BY c.checked_at DESC LIMIT 20""", (vehicle_id,)).fetchall()
    sources = _sources_for(conn, vehicle_id)
    last = next((c for c in checks if c["result"] != "error"), None)
    return {
        "sources": sources,
        "covered": bool(sources),
        "due": bool(due),
        "reason": (v["recall_check_reason"] or "storage") if due else None,
        "last_check": last,
        "check_days": settings.recall_check_days,
        "recalls": recalls,
        "checks": checks,
    }


class CheckIn(BaseModel):
    source_id: Optional[int] = None
    result: str = Field(pattern="^(none|found)$")
    note: Optional[str] = Field(None, max_length=300)


@router.post("/vehicles/{vehicle_id}/recall-checks", status_code=201)
def record_check(vehicle_id: int, body: CheckIn, request: Request, conn=Depends(get_conn)):
    """The result of a check in a recall source ("found" comes with the recalls, added below)."""
    v = _vehicle(conn, vehicle_id)
    _record_check(conn, v, _source_id(conn, body.source_id), body.result, request.state.staff["id"], _text(body.note))
    return vehicle_recalls(vehicle_id, conn)


class RecallIn(BaseModel):
    source_id: Optional[int] = None
    code: Optional[str] = Field(None, max_length=60)
    title: str = Field(min_length=1, max_length=200)
    details: Optional[str] = Field(None, max_length=2000)
    as_check: bool = True  # found during a check: also counts as the car's check


@router.post("/vehicles/{vehicle_id}/recalls", status_code=201)
def add_recall(vehicle_id: int, body: RecallIn, request: Request, conn=Depends(get_conn)):
    v = _vehicle(conn, vehicle_id)
    me = request.state.staff["id"]
    source_id = _source_id(conn, body.source_id)
    title = _text(body.title)
    if not title:
        raise bad_request("Describe the recall")
    code = _text(body.code)
    if code and conn.execute("""SELECT 1 FROM vehicle_recalls WHERE vehicle_id = %s AND status = 'open'
                                 AND lower(code) = lower(%s)""", (vehicle_id, code)).fetchone():
        raise conflict(f"Recall {code} is already open on this car")
    conn.execute("""INSERT INTO vehicle_recalls (vehicle_id, source_id, code, title, details, created_by)
                    VALUES (%s, %s, %s, %s, %s, %s)""",
                 (vehicle_id, source_id, code, title, (body.details or "").strip() or None, me))
    log_event(conn, vehicle_id, "recall_added", staff_id=me, data={"code": code, "title": title})
    if body.as_check:
        _record_check(conn, v, source_id, "found", me, None)
    return vehicle_recalls(vehicle_id, conn)


class RecallPatch(BaseModel):
    status: str = Field(pattern="^(open|done|not_applicable)$")
    note: Optional[str] = Field(None, max_length=300)


def _recall(conn, recall_id: int) -> dict:
    row = conn.execute("""SELECT r.* FROM vehicle_recalls r JOIN vehicles v ON v.id = r.vehicle_id
                          WHERE r.id = %s AND v.deleted_at IS NULL""", (recall_id,)).fetchone()
    if not row:
        raise not_found("Recall")
    return row


@router.patch("/recalls/{recall_id}")
def set_recall_status(recall_id: int, body: RecallPatch, request: Request, conn=Depends(get_conn)):
    r = _recall(conn, recall_id)
    me = request.state.staff["id"]
    if body.status == "open":
        conn.execute("UPDATE vehicle_recalls SET status = 'open', closed_at = NULL, closed_by = NULL, close_note = NULL "
                     "WHERE id = %s", (recall_id,))
    else:
        conn.execute("""UPDATE vehicle_recalls SET status = %s, closed_at = now(), closed_by = %s, close_note = %s
                        WHERE id = %s""", (body.status, me, _text(body.note), recall_id))
    log_event(conn, r["vehicle_id"], "recall_reopened" if body.status == "open" else "recall_closed", staff_id=me,
              data={"code": r["code"], "title": r["title"], "status": body.status, "note": _text(body.note)})
    return vehicle_recalls(r["vehicle_id"], conn)


# --------------------------------------------------------------------------- #
# The recall helper (0.42.0): a Chrome extension (addons/recall-helper) that runs in the person's own,
# logged-in dealer portal tab, looks each car up with the portal's own search and sends the result here.
# It uses the person's Carbonara login (cookie); Carbonara never stores a portal password.
# --------------------------------------------------------------------------- #

@router.get("/recall-helper/cars")
def helper_cars(all: bool = False, conn=Depends(get_conn)):
    """Cars to check: the due ones, or every car here that a source covers (all=1), with their sources."""
    where = DUE_WHERE if not all else f"v.deleted_at IS NULL AND v.status NOT IN ('intake', 'off_site') AND {COVERED_SQL}"
    rows = conn.execute(f"""SELECT v.id, v.vin, v.registration_number, v.make, v.model, v.model_year
                              FROM vehicles v WHERE {where} ORDER BY v.id""",
                        {"days": settings.recall_check_days}).fetchall()
    for r in rows:
        r["sources"] = _sources_for(conn, r["id"])
    return rows


class HelperCampaign(BaseModel):
    code: str = Field(min_length=1, max_length=60)
    title: str = Field(min_length=1, max_length=200)
    details: Optional[str] = Field(None, max_length=2000)


class HelperResult(BaseModel):
    vehicle_id: int
    source_id: Optional[int] = None
    error: Optional[str] = Field(None, max_length=300)  # the portal couldn't be asked / read: nothing changes
    open: list[HelperCampaign] = Field(default_factory=list, max_length=100)  # campaigns still to do on the car
    done: list[str] = Field(default_factory=list, max_length=200)  # campaign numbers the portal shows as done


@router.post("/recall-helper/result")
def helper_result(body: HelperResult, request: Request, conn=Depends(get_conn)):
    """One car's answer from the portal: add the open campaigns not on the car yet, close the open ones the
    portal shows as done, and record the check (an error is recorded but keeps the check due)."""
    v = _vehicle(conn, body.vehicle_id)
    me = request.state.staff["id"]
    source_id = _source_id(conn, body.source_id)
    if body.error:
        conn.execute("""INSERT INTO recall_checks (vehicle_id, source_id, checked_by, result, reason, note)
                        VALUES (%s, %s, %s, 'error', %s, %s)""", (v["id"], source_id, me, _reason(conn, v), _text(body.error)))
        return {"added": 0, "closed": 0, "open": None}
    added = closed = 0
    for c in body.open:
        code, title = _text(c.code), _text(c.title)
        # Any status: a campaign closed here (e.g. "doesn't apply") isn't added again.
        if conn.execute("SELECT 1 FROM vehicle_recalls WHERE vehicle_id = %s AND lower(code) = lower(%s)",
                        (v["id"], code)).fetchone():
            continue
        conn.execute("""INSERT INTO vehicle_recalls (vehicle_id, source_id, code, title, details, created_by)
                        VALUES (%s, %s, %s, %s, %s, %s)""",
                     (v["id"], source_id, code, title, (c.details or "").strip() or None, me))
        log_event(conn, v["id"], "recall_added", staff_id=me, data={"code": code, "title": title, "helper": True})
        added += 1
    done = [d.strip().lower() for d in body.done if d.strip()]
    if done:
        for r in conn.execute("""UPDATE vehicle_recalls SET status = 'done', closed_at = now(), closed_by = %s
                                  WHERE vehicle_id = %s AND status = 'open' AND lower(code) = ANY(%s)
                              RETURNING code, title""", (me, v["id"], done)).fetchall():
            log_event(conn, v["id"], "recall_closed", staff_id=me,
                      data={"code": r["code"], "title": r["title"], "status": "done", "helper": True})
            closed += 1
    still_open = conn.execute("SELECT count(*) AS n FROM vehicle_recalls WHERE vehicle_id = %s AND status = 'open'",
                              (v["id"],)).fetchone()["n"]
    _record_check(conn, v, source_id, "found" if still_open else "none", me, None)
    return {"added": added, "closed": closed, "open": still_open}


@router.delete("/recalls/{recall_id}")
def delete_recall(recall_id: int, request: Request, conn=Depends(get_conn)):
    """For a recall added by mistake: the person who added it, or an admin."""
    r = _recall(conn, recall_id)
    staff = request.state.staff
    if r["created_by"] != staff["id"] and not staff["is_admin"]:
        raise conflict("Only the person who added it or an administrator can delete it")
    conn.execute("DELETE FROM vehicle_recalls WHERE id = %s", (recall_id,))
    log_event(conn, r["vehicle_id"], "recall_deleted", staff_id=staff["id"], data={"code": r["code"], "title": r["title"]})
    return vehicle_recalls(r["vehicle_id"], conn)
