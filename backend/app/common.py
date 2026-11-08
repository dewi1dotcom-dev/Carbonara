from fastapi import HTTPException
from psycopg import sql
from psycopg.types.json import Jsonb


def not_found(what: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"{what} not found")


def conflict(message: str) -> HTTPException:
    return HTTPException(status_code=409, detail=message)


def bad_request(message: str) -> HTTPException:
    return HTTPException(status_code=422, detail=message)


def patch_fields(model, non_nullable=()) -> dict:
    """Fields explicitly sent in a PATCH body; null is ignored for NOT NULL columns."""
    fields = model.model_dump(exclude_unset=True)
    return {k: v for k, v in fields.items() if not (k in non_nullable and v is None)}


def update_row(conn, table: str, row_id: int, fields: dict, key: str = "id"):
    """UPDATE <table> SET <fields> WHERE <key> = row_id RETURNING *.

    Column names come from code / Pydantic models (never from raw user input)
    and are quoted as identifiers."""
    if not fields:
        return conn.execute(
            sql.SQL("SELECT * FROM {} WHERE {} = %s").format(sql.Identifier(table), sql.Identifier(key)),
            (row_id,),
        ).fetchone()
    query = sql.SQL("UPDATE {} SET {} WHERE {} = %s RETURNING *").format(
        sql.Identifier(table),
        sql.SQL(", ").join(sql.SQL("{} = %s").format(sql.Identifier(k)) for k in fields),
        sql.Identifier(key),
    )
    return conn.execute(query, [*fields.values(), row_id]).fetchone()


def check_staff(conn, staff_id) -> None:
    if staff_id is not None and not conn.execute(
        "SELECT 1 FROM staff WHERE id = %s AND active", (staff_id,)
    ).fetchone():
        raise bad_request("Unknown or inactive staff member")


def insert_row(conn, table: str, fields: dict):
    query = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING *").format(
        sql.Identifier(table),
        sql.SQL(", ").join(sql.Identifier(k) for k in fields),
        sql.SQL(", ").join(sql.Placeholder() for _ in fields),
    )
    return conn.execute(query, list(fields.values())).fetchone()


def place_in_location(conn, vehicle_id: int, location_id: int, staff_id=None) -> dict:
    """Put a car in a storage spot: lock the spot (so two people can't fill the
    last place at once), check capacity, end the car's current assignment and
    create the new one. Returns the location row."""
    location = conn.execute(
        "SELECT * FROM storage_locations WHERE id = %s AND active FOR UPDATE", (location_id,)
    ).fetchone()
    if not location:
        raise bad_request("Unknown or inactive storage location")
    if location["capacity"] is not None:
        used = conn.execute(
            """SELECT count(*) AS n FROM storage_assignments
                WHERE location_id = %s AND removed_at IS NULL AND vehicle_id <> %s""",
            (location_id, vehicle_id),
        ).fetchone()["n"]
        if used >= location["capacity"]:
            raise conflict(f"{location['code']} is full ({used} of {location['capacity']} cars)")
    conn.execute(
        "UPDATE storage_assignments SET removed_at = now(), removed_by = %s "
        "WHERE vehicle_id = %s AND removed_at IS NULL",
        (staff_id, vehicle_id),
    )
    insert_row(conn, "storage_assignments",
               {"vehicle_id": vehicle_id, "location_id": location_id, "placed_by": staff_id})
    return location


def log_event(conn, vehicle_id: int, event_type: str, *, staff_id=None, inspection_id=None, data=None):
    conn.execute(
        """INSERT INTO vehicle_events (vehicle_id, event_type, staff_id, inspection_id, data)
           VALUES (%s, %s, %s, %s, %s)""",
        (vehicle_id, event_type, staff_id, inspection_id, Jsonb(data or {})),
    )
