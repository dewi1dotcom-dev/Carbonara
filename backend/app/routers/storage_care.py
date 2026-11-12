"""Storage maintenance checks for new cars (MG SI-GI2022102501), and the
printable record of them. Also the monthly 12V charging of used cars in storage."""

from typing import Literal, Optional

from fastapi import APIRouter, Depends, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import storagecare as sc
from ..auth import require_admin
from ..common import bad_request, conflict, log_event, not_found
from ..config import settings
from ..db import get_conn

router = APIRouter(tags=["storage care"])

TODAY_SQL = "SELECT (now() AT TIME ZONE 'Europe/Oslo')::date AS d"


class ItemResult(BaseModel):
    key: str = Field(max_length=40)
    result: Literal["ok", "not_ok", "na"]


class CheckIn(BaseModel):
    kind: Literal["arrival", "periodic"]
    items: list[ItemResult] = Field(max_length=60)
    tyre_pressure: Optional[float] = Field(None, ge=0, le=6)
    tyres_ok: Optional[bool] = None
    v12_before: Optional[float] = Field(None, ge=0, le=20)
    v12_after: Optional[float] = Field(None, ge=0, le=20)
    battery_status: Optional[Literal["good", "good_recharge", "charge_retest", "replace"]] = None
    battery_action: Optional[Literal["none", "charged", "replaced"]] = None
    battery_part_no: Optional[str] = Field(None, max_length=60)
    soc_percent: Optional[int] = Field(None, ge=0, le=100)
    soc_charged_to: Optional[int] = Field(None, ge=0, le=100)
    remarks: Optional[str] = Field(None, max_length=2000)


def _fuel(vehicle: dict, registry_fuel: Optional[str]) -> Optional[str]:
    if vehicle.get("fuel_type"):
        return vehicle["fuel_type"]
    if registry_fuel and "elektr" in registry_fuel.lower():
        return "Electric"
    return registry_fuel


def programme(conn, vehicle_id: int) -> dict:
    """Where a car stands in the storage programme."""
    v = conn.execute(
        """SELECT v.*, r.fuel AS registry_fuel,
                  coalesce(r.first_registered, r.first_registered_norway) AS first_registered,
                  (SELECT min(placed_at) FROM storage_assignments a WHERE a.vehicle_id = v.id) AS first_placed,
                  EXISTS (SELECT 1 FROM pdi_orders o WHERE o.vehicle_id = v.id AND o.status = 'done') AS pdi_done
             FROM vehicles v LEFT JOIN vehicle_registry r ON r.vehicle_id = v.id
            WHERE v.id = %s AND v.deleted_at IS NULL""",
        (vehicle_id,),
    ).fetchone()
    if not v:
        raise not_found("Vehicle")
    checks = conn.execute(
        """SELECT c.*, (c.performed_at AT TIME ZONE 'Europe/Oslo')::date AS performed_date, s.name AS performed_by_name,
                  vb.name AS voided_by_name
             FROM storage_checks c LEFT JOIN staff s ON s.id = c.performed_by LEFT JOIN staff vb ON vb.id = c.voided_by
            WHERE c.vehicle_id = %s ORDER BY c.performed_at""",
        (vehicle_id,),
    ).fetchall()
    today = conn.execute(TODAY_SQL).fetchone()["d"]
    valid = [c for c in checks if not c["voided_at"]]  # cancelled checks don't count in the schedule
    arrival = next((c for c in valid if c["kind"] == "arrival"), None)
    start = arrival["performed_date"] if arrival else (v["first_placed"].date() if v["first_placed"] else None)
    fuel = _fuel(v, v["registry_fuel"])

    applies = v["condition"] == "new"
    if not applies:
        active, note = False, "The storage programme is for factory-new cars."
    elif v["pdi_done"]:
        active, note = False, "PDI done – storage programme finished."
    elif v["status"] == "off_site":
        active, note = False, "The car is off site."
    elif v["status"] == "intake" and arrival is None:
        active, note = True, None  # the first storage check is a step of the arrival inspection
    elif v["status"] == "intake":
        active, note = False, "First storage check done – the monthly checks start when the car is placed in storage."
    elif v["status"] != "in_storage":
        active, note = False, "Starts when the car is placed in storage."
    else:
        active, note = True, None
    nxt = sc.next_check(start, arrival is not None, sum(c["kind"] == "periodic" for c in valid), today) if active else None
    return {"vehicle": v, "checks": checks, "arrival": arrival, "start": start, "fuel": fuel,
            "fuel_kind": sc.fuel_kind(fuel), "applies": applies, "active": active, "note": note,
            "next": nxt, "today": today}


def _public(p: dict) -> dict:
    v = p["vehicle"]
    nxt = p["next"]
    form = None
    if nxt:
        items = sc.items_for(nxt["kind"], nxt["level"], p["fuel"])
        form = {"items": [{"key": i.key, "label": i.label} for i in items],
                "soc": p["fuel_kind"]["nev"], "part_no": nxt["kind"] == "arrival"}
    return {
        "applies": p["applies"], "active": p["active"], "note": p["note"], "start": p["start"],
        "fuel": p["fuel"], "fuel_kind": p["fuel_kind"], "next": nxt, "form": form,
        "checks": p["checks"], "vehicle_id": v["id"],
        "limits": {"tyre_min": sc.TYRE_MIN, "tyre_max": sc.TYRE_MAX, "v12_min": sc.V12_MIN,
                   "soc_min": sc.SOC_MIN, "soc_long": sc.SOC_LONG},
        "battery_status": sc.BATTERY_STATUS, "battery_action": sc.BATTERY_ACTION,
    }


@router.get("/vehicles/{vehicle_id}/storage-care")
def get_programme(vehicle_id: int, conn=Depends(get_conn)):
    return _public(programme(conn, vehicle_id))


@router.post("/vehicles/{vehicle_id}/storage-care/checks", status_code=201)
def add_check(vehicle_id: int, body: CheckIn, request: Request, conn=Depends(get_conn)):
    conn.execute("SELECT 1 FROM vehicles WHERE id = %s FOR UPDATE", (vehicle_id,))  # one check at a time
    p = programme(conn, vehicle_id)
    nxt = p["next"]
    if not nxt:
        raise conflict(p["note"] or "No storage check is due for this car")
    if body.kind != nxt["kind"]:
        raise conflict("The page is out of date – reload and try again")

    expected = sc.items_for(nxt["kind"], nxt["level"], p["fuel"])
    given = {i.key: i.result for i in body.items}
    missing = [i.label for i in expected if i.key not in given]
    if missing:
        raise bad_request(f"Answer every point (missing: {missing[0]})")
    remarks = (body.remarks or "").strip() or None
    problems = [i.label for i in expected if given[i.key] == "not_ok"]

    # Tyres: 2.7 ± 0.1 bar.
    if body.tyre_pressure is None:
        raise bad_request("Enter the tyre pressure")
    if not body.tyres_ok:
        problems.append("Dekktrykk ikke innenfor 2,6–2,8 bar")
    # 12V battery: tester result, voltage ≥ 12.5 V, otherwise charged or replaced.
    if body.v12_before is None or not body.battery_status:
        raise bad_request("Enter the 12V voltage and the battery tester result")
    low = body.v12_before < sc.V12_MIN or body.battery_status != "good"
    action = body.battery_action or "none"
    if low and action == "none":
        raise bad_request(f"12V below {sc.V12_MIN} V or not 'Good': record whether the battery was charged or replaced")
    if action == "charged" and body.v12_after is None:
        raise bad_request("Enter the voltage after charging")
    if body.battery_status == "replace" and action != "replaced":
        problems.append("12V-batteri må byttes")
    # HV battery (BEV/PHEV/FCEV): SOC ≥ 30 %, else charge to ≥ 50 %.
    soc_needed = p["fuel_kind"]["nev"] and p["fuel_kind"]["known"]
    if soc_needed and body.soc_percent is None:
        raise bad_request("Enter the HV battery charge (SOC %)")
    if body.soc_percent is not None and body.soc_percent < sc.SOC_MIN:
        if body.soc_charged_to is None or body.soc_charged_to < sc.SOC_LONG:
            raise bad_request(f"SOC below {sc.SOC_MIN} %: charge to at least {sc.SOC_LONG} % and enter the new value")
    if problems and not remarks:
        raise bad_request("Something is not OK – describe it and what was done under Remarks")

    labels = {i.key: i.label for i in expected}
    row = conn.execute(
        """INSERT INTO storage_checks (vehicle_id, kind, level, seq, due_date, performed_by, items, tyre_pressure,
                                       tyres_ok, v12_before, v12_after, battery_status, battery_action,
                                       battery_part_no, soc_percent, soc_charged_to, remarks)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
        (vehicle_id, nxt["kind"], nxt["level"], nxt["seq"] or None, nxt["due"] if nxt["kind"] == "periodic" else None,
         request.state.staff["id"],
         Jsonb([{"key": k, "label": labels[k], "result": given[k]} for k in labels]),
         body.tyre_pressure, bool(body.tyres_ok), body.v12_before, body.v12_after, body.battery_status, action,
         (body.battery_part_no or "").strip() or None, body.soc_percent, body.soc_charged_to, remarks),
    ).fetchone()
    log_event(conn, vehicle_id, "storage_check", staff_id=request.state.staff["id"],
              data={"check_id": row["id"], "kind": nxt["kind"], "level": nxt["level"],
                    "v12": body.v12_before, "battery_action": action, "problems": len(problems)})
    return _public(programme(conn, vehicle_id))


class VoidIn(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


@router.post("/storage-checks/{check_id}/void")
def void_check(check_id: int, body: VoidIn, request: Request, conn=Depends(get_conn), _admin=Depends(require_admin)):
    """Cancel a check registered by mistake. It stops counting in the schedule
    but stays in the report (struck through, with who/when/why)."""
    row = conn.execute("SELECT * FROM storage_checks WHERE id = %s FOR UPDATE", (check_id,)).fetchone()
    if not row:
        raise not_found("Storage check")
    if row["voided_at"]:
        raise conflict("This check is already cancelled")
    reason = body.reason.strip()
    if len(reason) < 3:
        raise bad_request("Give a reason")
    staff_id = request.state.staff["id"]
    conn.execute("UPDATE storage_checks SET voided_at = now(), voided_by = %s, void_reason = %s WHERE id = %s",
                 (staff_id, reason, check_id))
    log_event(conn, row["vehicle_id"], "storage_check_voided", staff_id=staff_id,
              data={"check_id": check_id, "kind": row["kind"], "level": row["level"],
                    "performed_at": row["performed_at"], "reason": reason})
    return _public(programme(conn, row["vehicle_id"]))


@router.get("/vehicles/{vehicle_id}/storage-care/report")
def report(vehicle_id: int, conn=Depends(get_conn)):
    """Everything for the printable storage maintenance record."""
    p = programme(conn, vehicle_id)
    v = p["vehicle"]
    spot = conn.execute(
        """SELECT l.code FROM storage_assignments a JOIN storage_spots l ON l.id = a.location_id
            WHERE a.vehicle_id = %s AND a.removed_at IS NULL""", (vehicle_id,)).fetchone()
    return {
        **_public(p),
        "company": settings.privacy_company, "dealer_number": settings.dealer_number or None,
        "vehicle": {k: v[k] for k in ("id", "vin", "make", "model", "variant", "model_year", "color",
                                      "registration_number", "first_registered", "condition", "status")},
        "spot": spot["code"] if spot else None,
        "items": [{"key": i.key, "label": i.label, "when": i.when} for i in sc.ITEMS],
        "level_text": sc.LEVEL_TEXT,
    }


# ---------------------------------------------------------------- used cars: 12V charging every month

# Every car with where its current stay in storage started and its last charge.
# A move between spots ends one assignment and starts the next in the same
# transaction (same now()), so the stay starts at the latest placement that
# doesn't continue an earlier one (i.e. the car came back from off site).
CHARGE_SQL = """
SELECT v.id, v.vin, v.make, v.model, v.model_year, v.registration_number, v.condition, v.status,
       (SELECT (max(a.placed_at) AT TIME ZONE 'Europe/Oslo')::date FROM storage_assignments a
         WHERE a.vehicle_id = v.id
           AND NOT EXISTS (SELECT 1 FROM storage_assignments b
                            WHERE b.vehicle_id = a.vehicle_id AND b.id <> a.id AND b.removed_at = a.placed_at)) AS stay_start,
       (SELECT (max(c.charged_at) AT TIME ZONE 'Europe/Oslo')::date FROM battery_charges c
         WHERE c.vehicle_id = v.id AND c.voided_at IS NULL) AS last_charged
  FROM vehicles v
 WHERE v.deleted_at IS NULL"""


def charge_due(row: dict, today) -> Optional[dict]:
    """Used cars in storage: due one month after the last charge, or after the
    car came into storage if it hasn't been charged since."""
    if row["condition"] != "used" or row["status"] != "in_storage":
        return None
    dates = [d for d in (row["stay_start"], row["last_charged"]) if d]
    base = max(dates) if dates else today
    due = sc.add_months(base, 1)
    return {"due": due, "days": (due - today).days}


def charging_due_list(conn, today, within_days: int = 3) -> list[dict]:
    """For the Today board: used cars whose 12V charge is due within a few days or overdue."""
    out = []
    for r in conn.execute(CHARGE_SQL + " AND v.condition = 'used' AND v.status = 'in_storage'").fetchall():
        d = charge_due(r, today)
        if d and d["days"] <= within_days:
            out.append({k: r[k] for k in ("id", "vin", "make", "model", "model_year", "registration_number",
                                           "stay_start", "last_charged")} | {"due": d["due"], "in_days": d["days"]})
    out.sort(key=lambda r: r["in_days"])
    return out


def charging(conn, vehicle_id: int) -> dict:
    v = conn.execute(CHARGE_SQL + " AND v.id = %s", (vehicle_id,)).fetchone()
    if not v:
        raise not_found("Vehicle")
    charges = conn.execute(
        """SELECT c.*, s.name AS charged_by_name, vb.name AS voided_by_name
             FROM battery_charges c LEFT JOIN staff s ON s.id = c.charged_by LEFT JOIN staff vb ON vb.id = c.voided_by
            WHERE c.vehicle_id = %s ORDER BY c.charged_at""",
        (vehicle_id,),
    ).fetchall()
    today = conn.execute(TODAY_SQL).fetchone()["d"]
    applies = v["condition"] == "used"
    note = None
    if applies and v["status"] == "off_site":
        note = "The car is off site."
    elif applies and v["status"] != "in_storage":
        note = "Starts when the car is placed in storage."
    return {"vehicle_id": v["id"], "applies": applies, "note": note, "stay_start": v["stay_start"],
            "next": charge_due(v, today), "charges": charges, "v12_min": sc.V12_MIN}


class ChargeIn(BaseModel):
    v12_before: Optional[float] = Field(None, ge=0, le=20)
    v12_after: Optional[float] = Field(None, ge=0, le=20)
    note: Optional[str] = Field(None, max_length=500)


@router.get("/vehicles/{vehicle_id}/battery-charging")
def get_charging(vehicle_id: int, conn=Depends(get_conn)):
    return charging(conn, vehicle_id)


@router.post("/vehicles/{vehicle_id}/battery-charging", status_code=201)
def add_charge(vehicle_id: int, body: ChargeIn, request: Request, conn=Depends(get_conn)):
    conn.execute("SELECT 1 FROM vehicles WHERE id = %s FOR UPDATE", (vehicle_id,))
    p = charging(conn, vehicle_id)
    if not p["applies"]:
        raise conflict("Monthly 12V charging is recorded for used cars")
    note = (body.note or "").strip() or None
    if body.v12_after is not None and body.v12_after < sc.V12_MIN and not note:
        raise bad_request(f"Below {sc.V12_MIN} V after charging – write what was done under Note")
    staff_id = request.state.staff["id"]
    row = conn.execute(
        """INSERT INTO battery_charges (vehicle_id, charged_by, v12_before, v12_after, note)
           VALUES (%s, %s, %s, %s, %s) RETURNING id""",
        (vehicle_id, staff_id, body.v12_before, body.v12_after, note),
    ).fetchone()
    log_event(conn, vehicle_id, "battery_charged", staff_id=staff_id,
              data={"charge_id": row["id"], "v12_before": body.v12_before, "v12_after": body.v12_after})
    return charging(conn, vehicle_id)


@router.post("/battery-charges/{charge_id}/void")
def void_charge(charge_id: int, body: VoidIn, request: Request, conn=Depends(get_conn), _admin=Depends(require_admin)):
    """Cancel a charge registered by mistake. It stops counting but stays in the list, struck through."""
    row = conn.execute("SELECT * FROM battery_charges WHERE id = %s FOR UPDATE", (charge_id,)).fetchone()
    if not row:
        raise not_found("Battery charge")
    if row["voided_at"]:
        raise conflict("This charge is already cancelled")
    reason = body.reason.strip()
    if len(reason) < 3:
        raise bad_request("Give a reason")
    staff_id = request.state.staff["id"]
    conn.execute("UPDATE battery_charges SET voided_at = now(), voided_by = %s, void_reason = %s WHERE id = %s",
                 (staff_id, reason, charge_id))
    log_event(conn, row["vehicle_id"], "battery_charge_voided", staff_id=staff_id,
              data={"charge_id": charge_id, "charged_at": row["charged_at"], "reason": reason})
    return charging(conn, row["vehicle_id"])
