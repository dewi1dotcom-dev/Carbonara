"""Planner (0.51.0): one calendar per team. Each person has a line; their work orders are laid out over the working day
(System page → Work hours: day start / end, breaks), one after another, with absences.

- Lines = the team's members + people added to its planner − people taken off it (`planner_rows`).
- A work order is on a line when it is assigned to that person and has a planned start; its length is the estimate
  (1 hour when none), laid out by `worktime.work_segments` (breaks, evenings and weekends skipped).
- Moving / stretching a job saves the work order (planned start, mechanic, estimate) through `PATCH /work-orders/{id}`.
- Who: admins plan every team; others plan their own team, and need access to work orders (`work_orders._access`).
  Everyone in the team can change it (the user's rule).
- Places (0.55.0): workshop places (lifts / bays) are lines too (`workshop_places`); a job is drawn on its mechanic's
  line and on its place's line. Job types (`job_types`, admin-managed colours) fill the jobs.
- `/planner/load`: planned / available hours per day for the month calendar and the 7-day chart.
- Absences: holiday / away / course / other; no health information ("away", not "sick"). Deleted by the worker a year
  after they end (`purge_old_absences`).
"""
from datetime import date, datetime, timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import worktime
from ..common import bad_request, not_found
from ..db import get_conn
from ..worktime import OSLO, local
from .work_orders import _access as work_order_access, require_work_orders

router = APIRouter(tags=["planner"])

DEFAULT_MINUTES = 60   # a job without an estimate is drawn as one hour
MAX_DAYS = 14
MAX_LOAD_DAYS = 62   # the month calendar (6 weeks) + the 7-day chart
ABSENCE_KEEP_DAYS = 365


def _check_team(conn, staff: dict, team_id: int) -> dict:
    team = conn.execute("SELECT id, name FROM teams WHERE id = %s", (team_id,)).fetchone()
    if not team:
        raise not_found("Team")
    if not (staff.get("is_admin") or staff.get("team_id") == team_id):
        raise HTTPException(403, "You can only plan your own team")
    return team


@router.get("/planner/teams")
def teams(conn=Depends(get_conn), staff=Depends(require_work_orders)):
    """The teams this person can plan: every team for admins, else their own."""
    if staff.get("is_admin"):
        return conn.execute("SELECT id, name FROM teams ORDER BY lower(name)").fetchall()
    return conn.execute("SELECT id, name FROM teams WHERE id = %s", (staff.get("team_id"),)).fetchall()


def rows(conn, team_id: int) -> list[dict]:
    """The people lines of a team's planner."""
    return conn.execute(
        """SELECT s.id AS staff_id, s.name
             FROM staff s LEFT JOIN planner_rows r ON r.team_id = %s AND r.staff_id = s.id
            WHERE s.deleted_at IS NULL AND s.active
              AND ((s.team_id = %s AND NOT coalesce(r.hidden, false)) OR (r.staff_id IS NOT NULL AND NOT r.hidden))
            ORDER BY coalesce(r.sort, 1000), lower(s.name)""", (team_id, team_id)).fetchall()


def places(conn, team_id: int) -> list[dict]:
    """The workshop places (lifts / bays) of a team's planner (0.55.0), drawn under the people."""
    return conn.execute("SELECT id AS place_id, name FROM workshop_places WHERE team_id = %s AND deleted_at IS NULL "
                        "ORDER BY sort, lower(name)", (team_id,)).fetchall()


ORDER_SELECT = """SELECT w.id, w.number, w.status, w.title, w.assigned_to, w.planned_at, w.estimated_minutes,
                         coalesce(cc.registration_number, v.registration_number) AS registration_number,
                         coalesce(cc.make, v.make) AS make, coalesce(cc.model, v.model) AS model,
                         c.name AS customer_name, w.pdi_order_id, w.arrived_at, w.place_id, w.job_type_id,
                         jsonb_array_length(w.tasks) AS task_count,
                         (SELECT count(*) FROM jsonb_array_elements(w.tasks) x WHERE (x->>'done')::boolean) AS tasks_done,
                         (SELECT count(*) FROM work_time t WHERE t.work_order_id = w.id AND t.ended_at IS NULL)
                             AS clocks_running,
                         -- parts: waiting for the supplier ('ordered') or here ('arrived'), for the job's status marks
                         (SELECT CASE WHEN bool_or(po.status = 'ordered') THEN 'ordered'
                                      WHEN bool_or(po.status = 'arrived') THEN 'arrived' END
                            FROM parts_orders po WHERE po.work_order_id = w.id AND po.status <> 'cancelled')
                             AS parts_status,
                         -- the kiosk delivery tied to this job: where the customer parked and left the key
                         (SELECT jsonb_build_object('id', d.id, 'created_at', d.created_at, 'map_id', d.map_id,
                                     'map_name', m.name, 'map_name_no', m.name_no, 'pin_x', d.pin_x, 'pin_y', d.pin_y,
                                     'key_place', d.key_place)
                            FROM car_deliveries d LEFT JOIN delivery_maps m ON m.id = d.map_id
                           WHERE d.work_order_id = w.id ORDER BY d.created_at DESC LIMIT 1) AS delivery
                    FROM work_orders w LEFT JOIN vehicles v ON v.id = w.vehicle_id
                    LEFT JOIN customer_cars cc ON cc.id = w.customer_car_id
                    LEFT JOIN customers c ON c.id = w.customer_id"""


def _layout(conn, team_id: int, d1: date, days: int, with_details: bool = True) -> dict:
    """The lines, the jobs laid out over the days d1 … d1 + days − 1, the absences and the capacity per line and day
    (available = working day − breaks − absences; planned = the jobs' working time that day)."""
    d2 = d1 + timedelta(days=days - 1)
    lo = datetime.combine(d1, datetime.min.time(), OSLO)
    hi = datetime.combine(d2 + timedelta(days=1), datetime.min.time(), OSLO)
    people, spots = rows(conn, team_id), places(conn, team_id)
    ids = [r["staff_id"] for r in people]
    pids = [p["place_id"] for p in spots]
    window = worktime.day_window()

    # Work orders on these lines that may reach into the range (a job can run over several days).
    orders = conn.execute(
        (ORDER_SELECT if with_details else
         "SELECT w.id, w.assigned_to, w.place_id, w.planned_at, w.estimated_minutes FROM work_orders w")
        + """ WHERE (w.assigned_to = ANY(%s) OR w.place_id = ANY(%s)) AND w.planned_at IS NOT NULL
               AND w.status <> 'cancelled' AND w.planned_at < %s AND w.planned_at > %s - interval '60 days'
             ORDER BY w.planned_at""", (ids, pids, hi, lo)).fetchall()
    cache: dict = {}

    def breaks_of(sid):
        return cache.setdefault(sid, worktime.person_breaks(conn, sid))

    shown = []
    for o in orders:
        segs = worktime.work_segments(o["planned_at"], o["estimated_minutes"] or DEFAULT_MINUTES,
                                      breaks_of(o["assigned_to"]), window)
        if not segs or segs[-1][1] <= lo:
            continue
        o["segments"] = [[local(s), local(e)] for s, e in segs if e > lo and s < hi]
        o["planned_local"] = local(o.pop("planned_at"))
        o["end_local"] = local(segs[-1][1])
        shown.append(o)
    absences = conn.execute(
        """SELECT id, staff_id, kind, starts_at, ends_at, note FROM absences
            WHERE staff_id = ANY(%s) AND starts_at < %s AND ends_at > %s ORDER BY starts_at""", (ids, hi, lo)).fetchall()
    for a in absences:
        a["start"], a["end"] = local(a.pop("starts_at")), local(a.pop("ends_at"))

    day_list = [d1 + timedelta(days=i) for i in range(days)]

    def planned_on(match, d: date) -> float:
        total = 0.0
        for o in shown:
            if match(o):
                for s, e in o["segments"]:
                    if s[:10] == d.isoformat():
                        total += (datetime.fromisoformat(e) - datetime.fromisoformat(s)).total_seconds()
        return total

    capacity = {}
    for line in people:
        sid = line["staff_id"]
        for d in day_list:
            free = worktime.free_intervals(d, breaks_of(sid)(d), window)
            avail = sum((e - s).total_seconds() for s, e in free)
            for a in absences:
                if a["staff_id"] != sid:
                    continue
                a_s = datetime.fromisoformat(a["start"]).replace(tzinfo=OSLO)
                a_e = datetime.fromisoformat(a["end"]).replace(tzinfo=OSLO)
                for s, e in free:
                    avail -= max(0.0, (min(e, a_e) - max(s, a_s)).total_seconds())
            capacity[f"s{sid}:{d.isoformat()}"] = {
                "available": int(max(0, avail)), "planned": int(planned_on(lambda o: o["assigned_to"] == sid, d))}
    default = worktime.default_breaks()
    for spot in spots:
        pid = spot["place_id"]
        for d in day_list:
            avail = sum((e - s).total_seconds() for s, e in worktime.free_intervals(d, default, window))
            capacity[f"p{pid}:{d.isoformat()}"] = {
                "available": int(avail), "planned": int(planned_on(lambda o: o["place_id"] == pid, d))}
    return {"people": people, "places": spots, "ids": ids, "pids": pids, "days": day_list, "window": window,
            "orders": shown, "absences": absences, "capacity": capacity}


def _start_date(start: Optional[str]) -> date:
    try:
        return date.fromisoformat(start) if start else worktime.today()
    except ValueError:
        raise bad_request("Check the date")


def job_types(conn) -> list[dict]:
    return conn.execute("SELECT id, name, name_no, color, sort, active FROM job_types ORDER BY sort, id").fetchall()


@router.get("/planner")
def planner(team_id: int, start: Optional[str] = None, days: int = 1, conn=Depends(get_conn),
            staff=Depends(require_work_orders)):
    team = _check_team(conn, staff, team_id)
    lay = _layout(conn, team_id, _start_date(start), max(1, min(days, MAX_DAYS)))
    ids, pids = lay["ids"], lay["pids"]
    unplanned = conn.execute(
        ORDER_SELECT + """ WHERE w.status IN ('open', 'in_progress')
                             AND (w.planned_at IS NULL OR NOT (coalesce(w.assigned_to = ANY(%s), false)
                                                              OR coalesce(w.place_id = ANY(%s), false)))
                             AND (w.assigned_to IS NULL OR w.assigned_to = ANY(%s) OR w.place_id = ANY(%s))
                           ORDER BY w.created_at LIMIT 100""", (ids, pids, ids, pids)).fetchall()
    for o in unplanned:
        o["planned_local"] = local(o.pop("planned_at"))
    lines = [{"kind": "staff", "key": f"s{r['staff_id']}", **r} for r in lay["people"]] + \
            [{"kind": "place", "key": f"p{p['place_id']}", **p} for p in lay["places"]]
    return {"team": team, "rows": lines, "days": lay["days"], "window": lay["window"],
            "breaks": worktime.default_breaks(), "orders": lay["orders"], "absences": lay["absences"],
            "unplanned": unplanned, "capacity": lay["capacity"], "today": worktime.today(),
            "job_types": job_types(conn), "can_edit": work_order_access(staff),
            "is_admin": bool(staff.get("is_admin"))}


@router.get("/planner/load")
def load(team_id: int, start: str, days: int = 42, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    """How full each day is (the people lines: planned / available seconds), for the month calendar and the
    7-day chart (0.55.0)."""
    _check_team(conn, staff, team_id)
    lay = _layout(conn, team_id, _start_date(start), max(1, min(days, MAX_LOAD_DAYS)), with_details=False)
    out = []
    for d in lay["days"]:
        cells = [lay["capacity"][f"s{sid}:{d.isoformat()}"] for sid in lay["ids"]]
        out.append({"date": d, "available": sum(c["available"] for c in cells),
                    "planned": sum(c["planned"] for c in cells)})
    return out


class RowsIn(BaseModel):
    staff_ids: list[int] = Field(max_length=200)


@router.put("/planner/{team_id}/rows")
def save_rows(team_id: int, body: RowsIn, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    """The lines of the team's planner, in order. Members left out are taken off; others in the list are added."""
    _check_team(conn, staff, team_id)
    wanted = list(dict.fromkeys(body.staff_ids))
    found = {r["id"] for r in conn.execute("SELECT id FROM staff WHERE id = ANY(%s) AND deleted_at IS NULL",
                                           (wanted,)).fetchall()}
    wanted = [s for s in wanted if s in found]
    members = {r["id"] for r in conn.execute("SELECT id FROM staff WHERE team_id = %s", (team_id,)).fetchall()}
    conn.execute("DELETE FROM planner_rows WHERE team_id = %s", (team_id,))
    for i, sid in enumerate(wanted):
        conn.execute("INSERT INTO planner_rows (team_id, staff_id, sort, hidden) VALUES (%s, %s, %s, false)",
                     (team_id, sid, i))
    for sid in members - set(wanted):
        conn.execute("INSERT INTO planner_rows (team_id, staff_id, sort, hidden) VALUES (%s, %s, 1000, true)",
                     (team_id, sid))
    return {"rows": rows(conn, team_id)}


class PlaceIn(BaseModel):
    id: Optional[int] = None
    name: str = Field(min_length=1, max_length=60)


class PlacesIn(BaseModel):
    places: list[PlaceIn] = Field(max_length=100)


@router.put("/planner/{team_id}/places")
def save_places(team_id: int, body: PlacesIn, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    """The team's workshop places, in order. Places left out are removed (hidden; their jobs keep the name)."""
    _check_team(conn, staff, team_id)
    old = {p["place_id"] for p in places(conn, team_id)}
    kept = set()
    for i, p in enumerate(body.places):
        name = " ".join(p.name.split())
        if not name:
            raise bad_request("Give the place a name")
        if p.id in old:
            conn.execute("UPDATE workshop_places SET name = %s, sort = %s WHERE id = %s", (name, i, p.id))
            kept.add(p.id)
        else:
            conn.execute("INSERT INTO workshop_places (team_id, name, sort) VALUES (%s, %s, %s)", (team_id, name, i))
    gone = list(old - kept)
    if gone:
        conn.execute("UPDATE workshop_places SET deleted_at = now() WHERE id = ANY(%s)", (gone,))
        # planned jobs that aren't finished leave the removed place (still on their mechanic's line)
        conn.execute("UPDATE work_orders SET place_id = NULL WHERE place_id = ANY(%s) "
                     "AND status IN ('open', 'in_progress')", (gone,))
    return {"places": places(conn, team_id)}


@router.get("/job-types")
def list_job_types(conn=Depends(get_conn), _staff=Depends(require_work_orders)):
    return job_types(conn)


class JobTypeIn(BaseModel):
    id: Optional[int] = None
    name: str = Field(min_length=1, max_length=60)
    name_no: Optional[str] = Field(None, max_length=60)
    color: str = Field(pattern=r"^#[0-9A-Fa-f]{6}$")
    active: bool = True


class JobTypesIn(BaseModel):
    types: list[JobTypeIn] = Field(max_length=60)


@router.put("/job-types")
def save_job_types(body: JobTypesIn, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    """Admins: the job types and their colours, in order. A type left out is only switched off (work orders keep it)."""
    if not staff.get("is_admin"):
        raise HTTPException(403, "Only admins can change the job types")
    old = {t["id"] for t in job_types(conn)}
    kept = set()
    for i, t in enumerate(body.types):
        name = " ".join(t.name.split())
        name_no = " ".join((t.name_no or "").split()) or None
        if not name:
            raise bad_request("Give the job type a name")
        if t.id in old:
            conn.execute("UPDATE job_types SET name = %s, name_no = %s, color = %s, sort = %s, active = %s WHERE id = %s",
                         (name, name_no, t.color.upper(), i, t.active, t.id))
            kept.add(t.id)
        else:
            conn.execute("INSERT INTO job_types (name, name_no, color, sort, active) VALUES (%s, %s, %s, %s, %s)",
                         (name, name_no, t.color.upper(), i, t.active))
    gone = list(old - kept)
    if gone:
        conn.execute("UPDATE job_types SET active = false WHERE id = ANY(%s)", (gone,))
    return job_types(conn)


@router.get("/planner/{team_id}/people")
def people(team_id: int, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    """Everyone who can be given a line (active staff)."""
    _check_team(conn, staff, team_id)
    return conn.execute("SELECT id, name, team_id FROM staff WHERE deleted_at IS NULL AND active "
                        "ORDER BY lower(name)").fetchall()


class AbsenceIn(BaseModel):
    staff_id: int
    kind: Literal["holiday", "away", "course", "other"]
    start: str   # local "2026-11-25T07:00"
    end: str
    note: Optional[str] = Field(None, max_length=200)


def _absence_times(body: AbsenceIn) -> tuple[datetime, datetime]:
    try:
        s = worktime.parse_local(*body.start.split("T"))
        e = worktime.parse_local(*body.end.split("T"))
    except (ValueError, TypeError):
        raise bad_request("Check the dates and times")
    if e <= s:
        raise bad_request("The end must be after the start")
    return s, e


def _check_person(conn, staff: dict, staff_id: int) -> None:
    """Absences are set for people with a line in a planner the user can change."""
    if staff.get("is_admin"):
        return
    team_id = staff.get("team_id")
    if not team_id or staff_id not in {r["staff_id"] for r in rows(conn, team_id)}:
        raise HTTPException(403, "You can only plan your own team")


@router.post("/planner/absences", status_code=201)
def add_absence(body: AbsenceIn, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    _check_person(conn, staff, body.staff_id)
    s, e = _absence_times(body)
    row = conn.execute(
        "INSERT INTO absences (staff_id, kind, starts_at, ends_at, note, created_by) VALUES (%s, %s, %s, %s, %s, %s) "
        "RETURNING id", (body.staff_id, body.kind, s, e, (body.note or "").strip() or None, staff["id"])).fetchone()
    return {"id": row["id"]}


@router.put("/planner/absences/{absence_id}")
def edit_absence(absence_id: int, body: AbsenceIn, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    old = conn.execute("SELECT staff_id FROM absences WHERE id = %s", (absence_id,)).fetchone()
    if not old:
        raise not_found("Absence")
    _check_person(conn, staff, old["staff_id"])
    _check_person(conn, staff, body.staff_id)
    s, e = _absence_times(body)
    conn.execute("UPDATE absences SET staff_id = %s, kind = %s, starts_at = %s, ends_at = %s, note = %s WHERE id = %s",
                 (body.staff_id, body.kind, s, e, (body.note or "").strip() or None, absence_id))
    return {"id": absence_id}


@router.delete("/planner/absences/{absence_id}", status_code=204)
def delete_absence(absence_id: int, conn=Depends(get_conn), staff=Depends(require_work_orders)):
    old = conn.execute("SELECT staff_id FROM absences WHERE id = %s", (absence_id,)).fetchone()
    if not old:
        raise not_found("Absence")
    _check_person(conn, staff, old["staff_id"])
    conn.execute("DELETE FROM absences WHERE id = %s", (absence_id,))


def purge_old_absences(conn) -> int:
    """Absences that ended more than a year ago (worker housekeeping)."""
    return conn.execute("DELETE FROM absences WHERE ends_at < now() - make_interval(days => %s)",
                        (ABSENCE_KEEP_DAYS,)).rowcount
