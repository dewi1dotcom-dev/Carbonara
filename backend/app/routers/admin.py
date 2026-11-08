"""Reference data: staff and storage locations (spots and their sub-zones)."""

from fastapi import APIRouter, Depends
from psycopg import errors

from ..common import bad_request, conflict, insert_row, not_found, patch_fields, update_row
from ..db import get_conn
from ..schemas import LocationIn, LocationPatch, StaffIn, StaffPatch

router = APIRouter(tags=["admin"])


@router.get("/staff")
def list_staff(include_inactive: bool = False, conn=Depends(get_conn)):
    return conn.execute(
        "SELECT * FROM staff WHERE %s OR active ORDER BY active DESC, name", (include_inactive,)
    ).fetchall()


@router.post("/staff", status_code=201)
def create_staff(body: StaffIn, conn=Depends(get_conn)):
    return insert_row(conn, "staff", {"name": body.name})


@router.patch("/staff/{staff_id}")
def patch_staff(staff_id: int, body: StaffPatch, conn=Depends(get_conn)):
    row = update_row(conn, "staff", staff_id, patch_fields(body, ("name", "active")))
    if not row:
        raise not_found("Staff member")
    return row


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
            WHERE (%(inactive)s OR active)
              AND (NOT %(available)s
                   OR (child_count = 0 AND (capacity IS NULL OR vehicle_count < capacity)))
            ORDER BY zone NULLS LAST, code""",
        {"inactive": include_inactive, "available": available_only},
    ).fetchall()


@router.get("/storage-locations/{location_id}")
def get_location(location_id: int, conn=Depends(get_conn)):
    """One spot, its sub-zones, and every car in it or its sub-zones (newest first)."""
    location = conn.execute(
        "SELECT * FROM (" + LOCATION_SELECT + ") x WHERE id = %s", (location_id,)
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
