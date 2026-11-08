"""Reference data: staff and storage locations."""

from fastapi import APIRouter, Depends
from psycopg import errors

from ..common import conflict, insert_row, not_found, patch_fields, update_row
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
    SELECT l.*, coalesce(c.n, 0) AS vehicle_count
      FROM storage_locations l
      LEFT JOIN (SELECT location_id, count(*) AS n FROM storage_assignments
                  WHERE removed_at IS NULL GROUP BY location_id) c ON c.location_id = l.id"""


@router.get("/storage-locations")
def list_locations(include_inactive: bool = False, available_only: bool = False, conn=Depends(get_conn)):
    """Spots with how many cars are in each. available_only = spots with room left."""
    return conn.execute(
        LOCATION_SELECT + """
            WHERE (%(inactive)s OR l.active)
              AND (NOT %(available)s OR l.capacity IS NULL OR coalesce(c.n, 0) < l.capacity)
            ORDER BY l.zone NULLS LAST, l.code""",
        {"inactive": include_inactive, "available": available_only},
    ).fetchall()


@router.get("/storage-locations/{location_id}")
def get_location(location_id: int, conn=Depends(get_conn)):
    """One spot and the cars in it, newest arrival first."""
    location = conn.execute(LOCATION_SELECT + " WHERE l.id = %s", (location_id,)).fetchone()
    if not location:
        raise not_found("Storage location")
    vehicles = conn.execute(
        """SELECT v.*, a.placed_at, r.eu_control_due, r.registration_status,
                  r.data -> 'registrering' -> 'registreringsstatus' ->> 'kodeVerdi' AS registration_status_code
             FROM storage_assignments a
             JOIN vehicles v ON v.id = a.vehicle_id
             LEFT JOIN vehicle_registry r ON r.vehicle_id = v.id
            WHERE a.location_id = %s AND a.removed_at IS NULL
            ORDER BY a.placed_at DESC""",
        (location_id,),
    ).fetchall()
    return {**location, "vehicles": vehicles}


@router.post("/storage-locations", status_code=201)
def create_location(body: LocationIn, conn=Depends(get_conn)):
    try:
        return insert_row(conn, "storage_locations", body.model_dump())
    except errors.UniqueViolation:
        raise conflict(f"Location {body.code} already exists")


@router.patch("/storage-locations/{location_id}")
def patch_location(location_id: int, body: LocationPatch, conn=Depends(get_conn)):
    fields = patch_fields(body, ("code", "active"))
    if "code" in fields:
        fields["code"] = fields["code"].upper()
    if fields.get("active") is False:
        occupied = conn.execute(
            "SELECT 1 FROM storage_assignments WHERE location_id = %s AND removed_at IS NULL",
            (location_id,),
        ).fetchone()
        if occupied:
            raise conflict("There are cars in this spot; move them before deactivating it")
    if fields.get("capacity") is not None:
        n = conn.execute(
            "SELECT count(*) AS n FROM storage_assignments WHERE location_id = %s AND removed_at IS NULL",
            (location_id,),
        ).fetchone()["n"]
        if n > fields["capacity"]:
            raise conflict(f"There are already {n} cars in this spot; capacity can't be lower than that")
    try:
        row = update_row(conn, "storage_locations", location_id, fields)
    except errors.UniqueViolation:
        raise conflict(f"Location {fields.get('code')} already exists")
    if not row:
        raise not_found("Storage location")
    return row
