"""Work time arithmetic (0.49.0): breaks are taken off worked time, and skipped when working out when a job is done.

Breaks are local Oslo times written "11:30-12:00" (System page → Work hours, `settings.work_breaks`; each work day keeps
its own copy, which an admin can change for that day). Example: a 2 hour job started at 11:00 with lunch 11:30-12:00
is done at 13:30, and a clock running 11:00-13:30 counts 2 hours.
"""
import re
from datetime import date, datetime, time, timedelta
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from .config import settings

OSLO = ZoneInfo("Europe/Oslo")
MAX_BREAKS = 10
BREAK_RE = re.compile(r"([0-2]?\d)[:.]([0-5]\d)\s*-\s*([0-2]?\d)[:.]([0-5]\d)")

BreaksFor = Callable[[date], list[str]]


def parse_breaks(text) -> list[str]:
    """ "11:30-12:00, 14:00-14:15" (or a list of such) → sorted ["11:30-12:00", "14:00-14:15"]. Raises ValueError."""
    parts = text if isinstance(text, list) else re.split(r"[,;\n]+", str(text or ""))
    out = []
    for part in parts:
        part = str(part or "").strip()
        if not part:
            continue
        m = BREAK_RE.fullmatch(part)
        if not m:
            raise ValueError(f"Break \"{part}\": write it as 11:30-12:00")
        a, b = int(m[1]) * 60 + int(m[2]), int(m[3]) * 60 + int(m[4])
        if a >= 24 * 60 or b > 24 * 60 or b <= a:
            raise ValueError(f"Break \"{part}\": the end must be after the start")
        out.append(f"{a // 60:02d}:{a % 60:02d}-{b // 60:02d}:{b % 60:02d}")
    if len(out) > MAX_BREAKS:
        raise ValueError(f"At most {MAX_BREAKS} breaks")
    return sorted(set(out))


def default_breaks() -> list[str]:
    try:
        return parse_breaks(settings.work_breaks)
    except ValueError:
        return []


def _intervals(day: date, breaks: list[str]) -> list[tuple[datetime, datetime]]:
    out = []
    for b in breaks or []:
        m = BREAK_RE.fullmatch(b)
        if not m:
            continue
        start = datetime.combine(day, time(int(m[1]), int(m[2])), OSLO)
        end_min = int(m[3]) * 60 + int(m[4])
        end = datetime.combine(day, time(0), OSLO) + timedelta(minutes=end_min)
        out.append((start, end))
    return sorted(out)


def _days(start: datetime, end: datetime):
    d = start.astimezone(OSLO).date()
    last = end.astimezone(OSLO).date()
    while d <= last:
        yield d
        d += timedelta(days=1)


def break_seconds(start: datetime, end: datetime, breaks_for: BreaksFor) -> int:
    """Seconds of breaks inside start…end."""
    total = 0
    for d in _days(start, end):
        for bs, be in _intervals(d, breaks_for(d)):
            overlap = (min(end, be) - max(start, bs)).total_seconds()
            if overlap > 0:
                total += overlap
    return int(total)


def worked_seconds(start: datetime, end: Optional[datetime], breaks_for: BreaksFor,
                   now: Optional[datetime] = None) -> int:
    """Seconds from start to end (or now, while running), breaks taken off."""
    end = end or now or datetime.now(OSLO)
    if end <= start:
        return 0
    return max(0, int((end - start).total_seconds()) - break_seconds(start, end, breaks_for))


def add_work(start: datetime, minutes: float, breaks_for: BreaksFor) -> datetime:
    """When `minutes` of work started at `start` is done, skipping the breaks."""
    t = start.astimezone(OSLO)
    left = timedelta(minutes=max(0.0, minutes))
    for _ in range(366):  # one day at a time; a year is plenty
        d = t.date()
        midnight = datetime.combine(d + timedelta(days=1), time(0), OSLO)
        for bs, be in _intervals(d, breaks_for(d)):
            if be <= t:
                continue
            if bs > t:
                chunk = min(left, bs - t)
                t += chunk
                left -= chunk
                if not left:
                    return t
            t = max(t, be)  # inside a break: work starts again when it ends
        chunk = min(left, midnight - t)
        t += chunk
        left -= chunk
        if not left:
            return t
    return t


def static_breaks(breaks: list[str]) -> BreaksFor:
    return lambda _d: breaks


def person_breaks(conn, staff_id: Optional[int]) -> BreaksFor:
    """The breaks of a person's work days (their day's own list, else the System page's), cached per day."""
    cache: dict[date, list[str]] = {}
    default = default_breaks()

    def get(d: date) -> list[str]:
        if d not in cache:
            row = conn.execute("SELECT breaks FROM work_days WHERE staff_id = %s AND day = %s",
                               (staff_id, d)).fetchone() if staff_id else None
            cache[d] = list(row["breaks"]) if row else default
        return cache[d]
    return get


def local(dt: Optional[datetime]) -> Optional[str]:
    """ISO local Oslo time without offset ("2026-11-25T11:30"), for the frontend's date / time inputs."""
    return dt.astimezone(OSLO).strftime("%Y-%m-%dT%H:%M") if dt else None


def parse_local(day: str, hhmm: str) -> datetime:
    """A local Oslo date "2026-11-25" + time "11:30" → aware datetime. Raises ValueError."""
    d = date.fromisoformat(str(day))
    m = re.fullmatch(r"([0-2]?\d)[:.]([0-5]\d)", str(hhmm or "").strip())
    if not m or int(m[1]) > 23:
        raise ValueError("Write the time as hh:mm")
    return datetime.combine(d, time(int(m[1]), int(m[2])), OSLO)


def today() -> date:
    return datetime.now(OSLO).date()
