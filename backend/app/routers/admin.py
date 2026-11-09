"""Reference data: staff and storage locations (spots and their sub-zones)."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg import errors

from ..auth import PIN_MAX, PIN_MIN, STAFF_PUBLIC, hash_pin, require_admin, valid_pin
from ..common import (bad_request, conflict, insert_row, log_event, not_found, patch_fields, place_in_location,
                      update_row)
from ..db import get_conn
from ..schemas import LocationIn, LocationPatch, PinSetIn, StaffIn, StaffPatch

log = logging.getLogger("carbonara.admin")
router = APIRouter(tags=["admin"])


def _public_staff(conn, staff_id: int):
    return conn.execute(f"SELECT {STAFF_PUBLIC} FROM staff WHERE id = %s", (staff_id,)).fetchone()


@router.get("/staff")
def list_staff(include_inactive: bool = False, conn=Depends(get_conn)):
    # Never SELECT *: the PIN hash must not leave the server.
    return conn.execute(
        f"SELECT {STAFF_PUBLIC} FROM staff WHERE %s OR active ORDER BY active DESC, name", (include_inactive,)
    ).fetchall()


@router.post("/staff", status_code=201)
def create_staff(body: StaffIn, conn=Depends(get_conn), _admin=Depends(require_admin)):
    row = insert_row(conn, "staff", {"name": body.name})
    return _public_staff(conn, row["id"])


@router.patch("/staff/{staff_id}")
def patch_staff(staff_id: int, body: StaffPatch, conn=Depends(get_conn), admin=Depends(require_admin)):
    fields = patch_fields(body, ("name", "active", "is_admin", "is_superadmin"))
    if "is_superadmin" in fields and not admin["is_superadmin"]:
        raise HTTPException(403, "Only a system admin can give or remove system admin")
    target = conn.execute("SELECT is_superadmin FROM staff WHERE id = %s", (staff_id,)).fetchone()
    if target and target["is_superadmin"] and not admin["is_superadmin"] and (
            fields.get("is_admin") is False or fields.get("active") is False):
        raise HTTPException(403, "Only a system admin can change another system admin")
    if fields.get("is_superadmin"):
        fields["is_admin"] = True  # a system admin is always an admin too
    if staff_id == admin["id"] and (fields.get("active") is False or fields.get("is_admin") is False
                                    or fields.get("is_superadmin") is False):
        raise bad_request("You can't deactivate yourself or remove your own rights")
    if fields.get("is_admin") is False:
        fields["is_superadmin"] = False
    if not update_row(conn, "staff", staff_id, fields):
        raise not_found("Staff member")
    if fields.get("active") is False:
        conn.execute("DELETE FROM sessions WHERE staff_id = %s", (staff_id,))  # logged out everywhere
    return _public_staff(conn, staff_id)


@router.post("/staff/{staff_id}/pin")
def set_staff_pin(staff_id: int, body: PinSetIn, conn=Depends(get_conn), _admin=Depends(require_admin)):
    """Give a staff member a PIN, or reset a forgotten one (also unlocks the account)."""
    if not valid_pin(body.pin):
        raise bad_request(f"The PIN must be {PIN_MIN}–{PIN_MAX} digits")
    row = conn.execute(
        "UPDATE staff SET pin_hash = %s, pin_failures = 0, pin_locked_until = NULL WHERE id = %s RETURNING id",
        (hash_pin(body.pin), staff_id),
    ).fetchone()
    if not row:
        raise not_found("Staff member")
    conn.execute("DELETE FROM sessions WHERE staff_id = %s", (staff_id,))  # old devices must log in again
    return _public_staff(conn, staff_id)


LOCATION_SELECT = """
    SELECT s.*,
           coalesce(own.n, 0)                     AS vehicle_count,  -- cars directly in this spot
           coalesce(sub.children, 0)::int         AS child_count,    -- active sub-zones
           (coalesce(own.n, 0) + coalesce(sub.n, 0))::int AS total_count,
           CASE WHEN coalesce(sub.children, 0) = 0 THEN s.capacity   -- plain spot
                WHEN sub.uncapped = 0 THEN sub.cap::int              -- all sub-zones have a limit
           END                                    AS total_capacity
      FROM storage_spots s
      LEFT JOIN (SELECT location_id, count(*) AS n FROM storage_assignments
                  WHERE removed_at IS NULL GROUP BY location_id) own ON own.location_id = s.id
      LEFT JOIN (SELECT c.parent_id,
                        count(*)                                   AS children,
                        sum(c.capacity)                            AS cap,
                        count(*) FILTER (WHERE c.capacity IS NULL) AS uncapped,
                        sum(coalesce(cn.n, 0))                     AS n
                   FROM storage_locations c
                   LEFT JOIN (SELECT location_id, count(*) AS n FROM storage_assignments
                               WHERE removed_at IS NULL GROUP BY location_id) cn ON cn.location_id = c.id
                  WHERE c.active AND c.parent_id IS NOT NULL
                  GROUP BY c.parent_id) sub ON sub.parent_id = s.id"""


@router.get("/storage-locations")
def list_locations(include_inactive: bool = False, available_only: bool = False, conn=Depends(get_conn)):
    """All spots and sub-zones, with car counts. `code` is the full display name
    ("BRUKTBILREKKE › RAD 1"), `own_code` the spot's own code.
    available_only = places a car can go now: spots without sub-zones, and
    sub-zones, that have room left."""
    return conn.execute(
        "SELECT * FROM (" + LOCATION_SELECT + """) x
            WHERE NOT deleted AND (%(inactive)s OR active)
              AND (NOT %(available)s
                   OR (child_count = 0 AND (capacity IS NULL OR vehicle_count < capacity)))
            ORDER BY zone NULLS LAST, code""",
        {"inactive": include_inactive, "available": available_only},
    ).fetchall()


@router.get("/storage-locations/{location_id}")
def get_location(location_id: int, conn=Depends(get_conn)):
    """One spot, its sub-zones, and every car in it or its sub-zones (newest first)."""
    location = conn.execute(
        "SELECT * FROM (" + LOCATION_SELECT + ") x WHERE id = %s AND NOT deleted", (location_id,)
    ).fetchone()
    if not location:
        raise not_found("Storage location")
    children = conn.execute(
        "SELECT * FROM (" + LOCATION_SELECT + ") x WHERE parent_id = %s AND active ORDER BY own_code",
        (location_id,),
    ).fetchall()
    vehicles = conn.execute(
        """SELECT v.*, a.placed_at, a.location_id, s.own_code AS sub_code, r.eu_control_due, r.registration_status,
                  r.data -> 'registrering' -> 'registreringsstatus' ->> 'kodeVerdi' AS registration_status_code
             FROM storage_assignments a
             JOIN storage_spots s ON s.id = a.location_id
             JOIN vehicles v ON v.id = a.vehicle_id
             LEFT JOIN vehicle_registry r ON r.vehicle_id = v.id
            WHERE (a.location_id = %(id)s OR s.parent_id = %(id)s) AND a.removed_at IS NULL
            ORDER BY a.placed_at DESC""",
        {"id": location_id},
    ).fetchall()
    return {**location, "children": children, "vehicles": vehicles}


@router.post("/storage-locations", status_code=201)
def create_location(body: LocationIn, conn=Depends(get_conn)):
    fields = body.model_dump()
    if body.parent_id is not None:
        parent = conn.execute("SELECT * FROM storage_locations WHERE id = %s", (body.parent_id,)).fetchone()
        if not parent:
            raise not_found("Parent spot")
        if parent["parent_id"] is not None:
            raise bad_request("Sub-zones can only be added to a top-level spot, not to another sub-zone")
        if not parent["active"]:
            raise bad_request(f"{parent['code']} is inactive")
        fields["zone"] = None  # a sub-zone always belongs to its parent's zone
    try:
        with conn.transaction():
            return insert_row(conn, "storage_locations", fields)
    except errors.UniqueViolation:
        raise conflict(f"{body.code} already exists" + (" in this spot" if body.parent_id else ""))


@router.patch("/storage-locations/{location_id}")
def patch_location(location_id: int, body: LocationPatch, conn=Depends(get_conn)):
    fields = patch_fields(body, ("code", "active"))
    if "code" in fields:
        fields["code"] = fields["code"].upper()
    if fields.get("active") is False:
        occupied = conn.execute(
            """SELECT count(*) AS n FROM storage_assignments a JOIN storage_locations l ON l.id = a.location_id
                WHERE (l.id = %(id)s OR l.parent_id = %(id)s) AND a.removed_at IS NULL""",
            {"id": location_id},
        ).fetchone()["n"]
        if occupied:
            raise conflict(f"There {'is 1 car' if occupied == 1 else f'are {occupied} cars'} here; "
                           "move them before deactivating")
    if fields.get("capacity") is not None:
        n = conn.execute(
            "SELECT count(*) AS n FROM storage_assignments WHERE location_id = %s AND removed_at IS NULL",
            (location_id,),
        ).fetchone()["n"]
        if n > fields["capacity"]:
            raise conflict(f"There are already {n} cars here; capacity can't be lower than that")
    try:
        with conn.transaction():
            row = update_row(conn, "storage_locations", location_id, fields)
    except errors.UniqueViolation:
        raise conflict(f"{fields.get('code')} already exists")
    if not row:
        raise not_found("Storage location")
    if fields.get("active") is False:
        # Sub-zones go with their spot.
        conn.execute("UPDATE storage_locations SET active = false WHERE parent_id = %s", (location_id,))
    return row


@router.delete("/storage-locations/{location_id}")
def delete_location(location_id: int, request: Request, move_to: Optional[int] = None,
                    conn=Depends(get_conn), _admin=Depends(require_admin)):
    """Delete a spot (with its sub-zones). Cars still in it must go somewhere:
    `move_to` = the spot they are all moved to. Without it, a spot with cars
    is refused (409) and the page asks where to move them."""
    spot = conn.execute(
        "SELECT * FROM storage_locations WHERE id = %s AND deleted_at IS NULL FOR UPDATE", (location_id,)
    ).fetchone()
    if not spot:
        raise not_found("Storage location")
    ids = [location_id] + [r["id"] for r in conn.execute(
        "SELECT id FROM storage_locations WHERE parent_id = %s AND deleted_at IS NULL FOR UPDATE", (location_id,))]
    name = conn.execute("SELECT code FROM storage_spots WHERE id = %s", (location_id,)).fetchone()["code"]
    cars = conn.execute(
        """SELECT a.vehicle_id, s.code FROM storage_assignments a JOIN storage_spots s ON s.id = a.location_id
            WHERE a.location_id = ANY(%s) AND a.removed_at IS NULL ORDER BY a.placed_at""",
        (ids,),
    ).fetchall()
    staff_id = request.state.staff["id"]

    moved_to = None
    if cars:
        if move_to is None:
            raise conflict(f"{name} has {len(cars)} {'car' if len(cars) == 1 else 'cars'}; choose a spot to move them to")
        if move_to in ids:
            raise bad_request("Choose a spot outside the one you are deleting")
        for car in cars:  # checks capacity, sub-zones and active for each car
            target = place_in_location(conn, car["vehicle_id"], move_to, staff_id)
            log_event(conn, car["vehicle_id"], "moved", staff_id=staff_id,
                      data={"from": car["code"], "to": target["code"], "note": f"Spot {name} deleted"})
        moved_to = target["code"]

    used = conn.execute("SELECT 1 FROM storage_assignments WHERE location_id = ANY(%s) LIMIT 1", (ids,)).fetchone()
    if used:  # keep the rows for history, hidden everywhere
        conn.execute("UPDATE storage_locations SET deleted_at = now(), active = false WHERE id = ANY(%s)", (ids,))
    else:
        conn.execute("DELETE FROM storage_locations WHERE parent_id = %s", (location_id,))
        conn.execute("DELETE FROM storage_locations WHERE id = %s", (location_id,))
    log.info("storage spot %s deleted by staff %s (%d cars moved)", name, staff_id, len(cars))
    return {"deleted": name, "moved": len(cars), "moved_to": moved_to}
