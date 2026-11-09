"""The start page ("Today board"): what needs doing today and tomorrow,
what needs attention, and a few numbers. One request, small queries."""

from fastapi import APIRouter, Depends

from .. import vegvesen
from ..common import service_due
from ..db import get_conn
from .pdi import ORDER_SELECT

router = APIRouter(tags=["dashboard"])

TODAY = "(now() AT TIME ZONE 'Europe/Oslo')::date"
LOCAL_DAY = "(o.pdi_at AT TIME ZONE 'Europe/Oslo')::date"


@router.get("/dashboard")
def dashboard(conn=Depends(get_conn)):
    pdi_open = conn.execute(ORDER_SELECT + f""" WHERE o.status NOT IN ('done', 'cancelled') AND v.deleted_at IS NULL
                                                ORDER BY o.pdi_at NULLS LAST, o.created_at""").fetchall()
    days = {r["id"]: r for r in conn.execute(
        f"SELECT o.id, {LOCAL_DAY} - {TODAY} AS in_days FROM pdi_orders o WHERE o.status = 'booked'").fetchall()}
    for o in pdi_open:
        o["in_days"] = days.get(o["id"], {}).get("in_days")

    test_drives = conn.execute(
        """SELECT t.id, t.vehicle_id, t.started_at, t.customer_name, v.make, v.model, v.model_year, v.registration_number
             FROM test_drives t JOIN vehicles v ON v.id = t.vehicle_id
            WHERE t.status = 'out' AND v.deleted_at IS NULL ORDER BY t.started_at""").fetchall()
    arrivals = conn.execute(
        """SELECT i.id, i.started_at, v.vin, v.make, v.model, v.model_year, s.name AS inspector_name
             FROM inspections i JOIN vehicles v ON v.id = i.vehicle_id AND v.deleted_at IS NULL
             LEFT JOIN staff s ON s.id = i.inspector_id
            WHERE i.status = 'in_progress' ORDER BY i.started_at""").fetchall()

    # Cars here (not off site) with their registry data, for the attention lists.
    cars = conn.execute(
        """SELECT v.*, r.eu_control_due, r.data AS registry_data, r.kept_values,
                  coalesce(r.first_registered, r.first_registered_norway) AS first_registered
             FROM vehicles v LEFT JOIN vehicle_registry r ON r.vehicle_id = v.id
            WHERE v.deleted_at IS NULL AND v.status <> 'off_site'""").fetchall()
    eu, service, mismatches = [], [], []
    today = conn.execute(f"SELECT {TODAY} AS d").fetchone()["d"]
    for c in cars:
        car = {k: c[k] for k in ("id", "vin", "make", "model", "model_year", "registration_number")}
        if c["eu_control_due"] and (c["eu_control_due"] - today).days <= 60:
            eu.append({**car, "due": c["eu_control_due"], "in_days": (c["eu_control_due"] - today).days})
        due = service_due(c, c["first_registered"])["due"]
        if due and (due - today).days <= 31:
            service.append({**car, "due": due, "in_days": (due - today).days})
        if c["registry_data"] and vegvesen.mismatch_list(c, c["registry_data"], c["kept_values"]):
            mismatches.append(car)
    eu.sort(key=lambda r: r["in_days"])
    service.sort(key=lambda r: r["in_days"])

    numbers = conn.execute(
        f"""SELECT
              (SELECT count(*) FROM vehicles WHERE deleted_at IS NULL AND status = 'in_storage') AS in_storage,
              (SELECT coalesce(sum(greatest(s.capacity - (SELECT count(*) FROM storage_assignments a
                                                            WHERE a.location_id = s.id AND a.removed_at IS NULL), 0)), 0)
                 FROM storage_spots s
                WHERE s.active AND s.capacity IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM storage_locations c WHERE c.parent_id = s.id AND c.active)) AS free_places,
              (SELECT count(*) FROM inspections WHERE status = 'completed'
                AND completed_at >= date_trunc('week', now() AT TIME ZONE 'Europe/Oslo') AT TIME ZONE 'Europe/Oslo') AS arrived_this_week,
              (SELECT count(*) FROM pdi_orders o WHERE o.status IN ('booked', 'done')
                AND date_trunc('week', o.pdi_at AT TIME ZONE 'Europe/Oslo') = date_trunc('week', now() AT TIME ZONE 'Europe/Oslo')) AS pdi_this_week"""
    ).fetchone()

    return {
        "today": today,
        "pdi_today": [o for o in pdi_open if o["in_days"] == 0],
        "pdi_tomorrow": [o for o in pdi_open if o["in_days"] == 1],
        "pdi_upcoming": [o for o in pdi_open if o["in_days"] is not None and o["in_days"] > 1][:10],
        "pdi_overdue": [o for o in pdi_open if o["in_days"] is not None and o["in_days"] < 0],
        "pdi_waiting": [o for o in pdi_open if o["status"] == "sent"],
        "pdi_drafts": [o for o in pdi_open if o["status"] == "draft"],
        "test_drives": test_drives,
        "arrivals": arrivals,
        "eu_control": eu,
        "service": service,
        "registry_mismatches": mismatches,
        "numbers": numbers,
    }
