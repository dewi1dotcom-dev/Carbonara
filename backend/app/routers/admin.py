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


@router.get("/storage-locations")
def list_locations(include_inactive: bool = False, available_only: bool = False, conn=Depends(get_conn)):
    return conn.execute(
        """SELECT l.*,
                  a.vehicle_id AS occupied_by_vehicle_id,
                  v.vin        AS occupied_by_vin,
                  a.placed_at  AS occupied_since
             FROM storage_locations l
             LEFT JOIN storage_assignments a ON a.location_id = l.id AND a.removed_at IS NULL
             LEFT JOIN vehicles v ON v.id = a.vehicle_id
            WHERE (%(inactive)s OR l.active)
              AND (NOT %(available)s OR a.id IS NULL)
            ORDER BY l.zone NULLS LAST, l.code""",
        {"inactive": include_inactive, "available": available_only},
    ).fetchall()


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
            raise conflict("Location is occupied; move the vehicle before deactivating it")
    try:
        row = update_row(conn, "storage_locations", location_id, fields)
    except errors.UniqueViolation:
        raise conflict(f"Location {fields.get('code')} already exists")
    if not row:
        raise not_found("Storage location")
    return row
