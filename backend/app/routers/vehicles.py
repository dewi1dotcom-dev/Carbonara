from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from .. import vegvesen, vinlib
from ..common import check_staff, conflict, log_event, not_found, patch_fields, update_row
from ..db import get_conn
from ..schemas import MarkRegisteredIn, VehicleDetails

router = APIRouter(tags=["vehicles"])

REGISTRY_COLUMNS = """r.sync_status, r.next_sync_at, r.last_attempt_at, r.last_success_at,
    r.failures, r.last_error, r.registration_number, r.registration_status,
    r.first_registered_norway, r.first_registered, r.eu_control_due, r.eu_control_last_approved,
    r.make, r.model, r.type_designation, r.vehicle_class, r.body_type, r.color, r.fuel,
    r.power_kw, r.engine_cc, r.seats, r.curb_weight_kg, r.total_weight_kg"""


@router.get("/registry/status", tags=["registry"])
def registry_status(conn=Depends(get_conn)):
    counts = conn.execute(
        """SELECT count(*) FILTER (WHERE r.sync_status = 'ok')        AS ok,
                  count(*) FILTER (WHERE r.sync_status = 'pending')   AS pending,
                  count(*) FILTER (WHERE r.sync_status = 'not_found') AS not_found,
                  count(*) FILTER (WHERE r.sync_status = 'error')     AS error,
                  count(*) FILTER (WHERE r.next_sync_at <= now())     AS due
             FROM vehicle_registry r JOIN vehicles v ON v.id = r.vehicle_id
            WHERE v.registered_marked_at IS NOT NULL"""
    ).fetchone()
    last_error = conn.execute(
        """SELECT last_error, last_attempt_at FROM vehicle_registry
            WHERE sync_status = 'error' ORDER BY last_attempt_at DESC NULLS LAST LIMIT 1"""
    ).fetchone()
    key = vegvesen.settings.vegvesen_api_key
    return {"configured": vegvesen.is_configured(), "sync_days": vegvesen.settings.vegvesen_sync_days,
            # Only the last 4 characters, so staff can confirm which key is active after replacing it.
            "key_hint": key[-4:] if len(key) >= 8 else None,
            **counts, "last_error": last_error}


@router.get("/vehicles")
def list_vehicles(q: Optional[str] = None, status: Optional[str] = None, limit: int = 100,
                  conn=Depends(get_conn)):
    term = f"%{q.strip()}%" if q and q.strip() else None
    return conn.execute(
        """SELECT v.*, l.code AS location_code, l.zone AS location_zone,
                  r.sync_status AS registry_status, r.eu_control_due,
                  r.registration_status,
                  r.data -> 'registrering' -> 'registreringsstatus' ->> 'kodeVerdi' AS registration_status_code
             FROM vehicles v
             LEFT JOIN storage_assignments a ON a.vehicle_id = v.id AND a.removed_at IS NULL
             LEFT JOIN storage_locations l ON l.id = a.location_id
             LEFT JOIN vehicle_registry r ON r.vehicle_id = v.id
            WHERE (%(status)s::text IS NULL OR v.status = %(status)s)
              AND (%(term)s::text IS NULL
                   OR v.vin ILIKE %(term)s OR v.make ILIKE %(term)s OR v.model ILIKE %(term)s
                   OR v.registration_number ILIKE %(term)s OR l.code ILIKE %(term)s)
            ORDER BY v.updated_at DESC
            LIMIT %(limit)s""",
        {"status": status, "term": term, "limit": max(1, min(limit, 500))},
    ).fetchall()


@router.get("/vehicles/{vehicle_id}")
def get_vehicle(vehicle_id: int, conn=Depends(get_conn)):
    vehicle = conn.execute("SELECT * FROM vehicles WHERE id = %s", (vehicle_id,)).fetchone()
    if not vehicle:
        raise not_found("Vehicle")
    location = conn.execute(
        """SELECT l.id, l.code, l.zone, a.placed_at
             FROM storage_assignments a JOIN storage_locations l ON l.id = a.location_id
            WHERE a.vehicle_id = %s AND a.removed_at IS NULL""",
        (vehicle_id,),
    ).fetchone()
    inspections = conn.execute(
        """SELECT i.id, i.kind, i.status, i.started_at, i.completed_at, i.odometer_km,
                  s.name AS inspector_name,
                  (SELECT count(*) FROM damages d WHERE d.inspection_id = i.id) AS damage_count,
                  (SELECT p.id FROM inspection_photos p
                    WHERE p.inspection_id = i.id AND p.kind = 'front') AS front_photo_id
             FROM inspections i LEFT JOIN staff s ON s.id = i.inspector_id
            WHERE i.vehicle_id = %s
            ORDER BY i.started_at DESC""",
        (vehicle_id,),
    ).fetchall()
    open_damages = conn.execute(
        """SELECT d.*, i.started_at AS inspected_at
             FROM damages d JOIN inspections i ON i.id = d.inspection_id
            WHERE d.vehicle_id = %s AND d.repaired_at IS NULL AND i.status = 'completed'
            ORDER BY d.id""",
        (vehicle_id,),
    ).fetchall()
    events = conn.execute(
        """SELECT e.*, s.name AS staff_name
             FROM vehicle_events e LEFT JOIN staff s ON s.id = e.staff_id
            WHERE e.vehicle_id = %s
            ORDER BY e.occurred_at DESC, e.id DESC""",
        (vehicle_id,),
    ).fetchall()
    registry = conn.execute(
        f"SELECT {REGISTRY_COLUMNS}, r.data FROM vehicle_registry r WHERE r.vehicle_id = %s", (vehicle_id,)
    ).fetchone()
    details = []
    if registry:
        raw = registry.pop("data")
        registry |= vegvesen.overview(raw)
        details = vegvesen.details(raw)
    marked_by = vehicle["registered_marked_by"] and conn.execute(
        "SELECT name FROM staff WHERE id = %s", (vehicle["registered_marked_by"],)
    ).fetchone()
    return {
        **vehicle,
        "registered_marked_by_name": marked_by["name"] if marked_by else None,
        "vin_info": vinlib.describe(vehicle["vin"]),
        "current_location": location,
        "inspections": inspections,
        "open_damages": open_damages,
        "events": events,
        "registry": registry,
        "registry_details": details,
        "registry_configured": vegvesen.is_configured(),
    }


# --------------------------------------------------------------------------- #
# Registration in Norway / Statens vegvesen sync
# --------------------------------------------------------------------------- #

@router.post("/vehicles/{vehicle_id}/registered")
def mark_registered(vehicle_id: int, body: MarkRegisteredIn, conn=Depends(get_conn)):
    """Sales marks the car as registered in Norway. This enables registry sync
    and runs a first sync immediately when an API key is configured."""
    vehicle = conn.execute("SELECT * FROM vehicles WHERE id = %s FOR UPDATE", (vehicle_id,)).fetchone()
    if not vehicle:
        raise not_found("Vehicle")
    if vehicle["registered_marked_at"]:
        raise conflict("Vehicle is already marked as registered")
    check_staff(conn, body.staff_id)
    conn.execute(
        "UPDATE vehicles SET registered_marked_at = now(), registered_marked_by = %s WHERE id = %s",
        (body.staff_id, vehicle_id),
    )
    conn.execute(
        """INSERT INTO vehicle_registry (vehicle_id) VALUES (%s)
           ON CONFLICT (vehicle_id) DO UPDATE SET next_sync_at = now(), failures = 0""",
        (vehicle_id,),
    )
    log_event(conn, vehicle_id, "marked_registered", staff_id=body.staff_id)
    if vegvesen.is_configured():
        vegvesen.sync_vehicle(conn, vehicle_id)
    return get_vehicle(vehicle_id, conn)


@router.delete("/vehicles/{vehicle_id}/registered")
def unmark_registered(vehicle_id: int, staff_id: Optional[int] = None, conn=Depends(get_conn)):
    """Undo a mistaken 'registered' mark. Registry data already fetched is kept."""
    vehicle = conn.execute("SELECT * FROM vehicles WHERE id = %s FOR UPDATE", (vehicle_id,)).fetchone()
    if not vehicle:
        raise not_found("Vehicle")
    if not vehicle["registered_marked_at"]:
        raise conflict("Vehicle is not marked as registered")
    check_staff(conn, staff_id)
    conn.execute(
        "UPDATE vehicles SET registered_marked_at = NULL, registered_marked_by = NULL WHERE id = %s",
        (vehicle_id,),
    )
    log_event(conn, vehicle_id, "registered_mark_removed", staff_id=staff_id)
    return get_vehicle(vehicle_id, conn)


@router.post("/vehicles/{vehicle_id}/registry/sync")
def sync_now(vehicle_id: int, conn=Depends(get_conn)):
    vehicle = conn.execute("SELECT registered_marked_at FROM vehicles WHERE id = %s", (vehicle_id,)).fetchone()
    if not vehicle:
        raise not_found("Vehicle")
    if not vehicle["registered_marked_at"]:
        raise conflict("Mark the vehicle as registered before syncing with Statens vegvesen")
    if not vegvesen.is_configured():
        raise HTTPException(503, "Statens vegvesen API key is not configured on the server")
    result = vegvesen.sync_vehicle(conn, vehicle_id)
    return {"result": result, "vehicle": get_vehicle(vehicle_id, conn)}


@router.get("/vehicles/{vehicle_id}/registry/raw")
def registry_raw(vehicle_id: int, conn=Depends(get_conn)):
    current = conn.execute(
        "SELECT data, last_success_at FROM vehicle_registry WHERE vehicle_id = %s", (vehicle_id,)
    ).fetchone()
    snapshots = conn.execute(
        "SELECT id, fetched_at FROM vehicle_registry_snapshots WHERE vehicle_id = %s ORDER BY fetched_at DESC",
        (vehicle_id,),
    ).fetchall()
    return {"current": current, "snapshots": snapshots}


@router.patch("/vehicles/{vehicle_id}")
def patch_vehicle(vehicle_id: int, body: VehicleDetails, conn=Depends(get_conn)):
    before = conn.execute("SELECT * FROM vehicles WHERE id = %s FOR UPDATE", (vehicle_id,)).fetchone()
    if not before:
        raise not_found("Vehicle")
    fields = {k: v for k, v in patch_fields(body).items() if before[k] != v}
    if not fields:
        return before
    row = update_row(conn, "vehicles", vehicle_id, fields)
    log_event(conn, vehicle_id, "vehicle_details_updated",
              data={"changes": {k: [before[k], v] for k, v in fields.items()}})
    return row
