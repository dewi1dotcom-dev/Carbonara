"""The car's own photos (0.45.0), outside any inspection: copied from its finn.no ad by Carbonara Sidekick (the
ones the person ticked), or uploaded on the car page ("Photos" card). Stored by photostore like inspection
photos (original + 1600 / 400 px JPEG). The first one is the car's picture in lists until the arrival inspection
has a right-side photo (AD_PHOTO_SQL)."""

from typing import Optional

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import FileResponse

from .. import photostore
from ..common import bad_request, conflict, log_event, not_found
from ..config import settings
from ..db import get_conn

router = APIRouter(tags=["vehicle photos"])

COLUMNS = "id, vehicle_id, width, height, source, sort, created_at, created_by"
MAX_PER_CAR = 60

# The car's first own photo, for car cards without an arrival inspection photo (alias v).
AD_PHOTO_SQL = """(SELECT p.id FROM vehicle_photos p WHERE p.vehicle_id = v.id
                    ORDER BY p.sort, p.id LIMIT 1) AS ad_photo_id"""


def _vehicle(conn, vehicle_id: int) -> None:
    if not conn.execute("SELECT 1 FROM vehicles WHERE id = %s AND deleted_at IS NULL", (vehicle_id,)).fetchone():
        raise not_found("Vehicle")


@router.get("/vehicles/{vehicle_id}/photos")
def list_photos(vehicle_id: int, conn=Depends(get_conn)):
    _vehicle(conn, vehicle_id)
    return conn.execute(f"SELECT {COLUMNS} FROM vehicle_photos WHERE vehicle_id = %s ORDER BY sort, id",
                        (vehicle_id,)).fetchall()


@router.post("/vehicles/{vehicle_id}/photos", status_code=201)
async def add_photo(vehicle_id: int, request: Request, file: UploadFile = File(...),
                    source: Optional[str] = Form(None), conn=Depends(get_conn)):
    _vehicle(conn, vehicle_id)
    count = conn.execute("SELECT count(*) AS n FROM vehicle_photos WHERE vehicle_id = %s", (vehicle_id,)).fetchone()["n"]
    if count >= MAX_PER_CAR:
        raise conflict(f"A car can have at most {MAX_PER_CAR} photos")
    data = await file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise bad_request("The file is too large")
    try:
        stored = photostore.store(data)
    except photostore.PhotoError as exc:
        raise bad_request(str(exc))
    me = request.state.staff["id"]
    row = conn.execute(
        f"""INSERT INTO vehicle_photos (vehicle_id, file_key, original_ext, mime_type, width, height, size_bytes,
                                       source, sort, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING {COLUMNS}""",
        (vehicle_id, stored["file_key"], stored["original_ext"], stored["mime_type"], stored["width"],
         stored["height"], stored["size_bytes"], "finn" if source == "finn" else "upload", count, me)).fetchone()
    log_event(conn, vehicle_id, "photo_added", staff_id=me, data={"photo_id": row["id"], "source": row["source"]})
    return row


@router.get("/vehicle-photos/{photo_id}/{variant}")
def get_photo(photo_id: int, variant: str, conn=Depends(get_conn)):
    if variant not in photostore.VARIANTS:
        raise not_found("Photo variant")
    row = conn.execute("SELECT * FROM vehicle_photos WHERE id = %s", (photo_id,)).fetchone()
    if not row:
        raise not_found("Photo")
    path = photostore.path_for(row, variant)
    if not path.is_file():
        raise not_found("Photo file")
    return FileResponse(path, media_type=row["mime_type"] if variant == "original" else "image/jpeg",
                        headers={"Cache-Control": "private, max-age=31536000, immutable"})


@router.post("/vehicle-photos/{photo_id}/first")
def make_first(photo_id: int, conn=Depends(get_conn)):
    """Show this photo first (and as the car's picture in lists)."""
    row = conn.execute("SELECT vehicle_id FROM vehicle_photos WHERE id = %s", (photo_id,)).fetchone()
    if not row:
        raise not_found("Photo")
    conn.execute("UPDATE vehicle_photos SET sort = CASE WHEN id = %s THEN 0 ELSE sort + 1 END WHERE vehicle_id = %s",
                 (photo_id, row["vehicle_id"]))
    return list_photos(row["vehicle_id"], conn)


@router.delete("/vehicle-photos/{photo_id}", status_code=204)
def delete_photo(photo_id: int, request: Request, conn=Depends(get_conn)):
    row = conn.execute("DELETE FROM vehicle_photos WHERE id = %s RETURNING *", (photo_id,)).fetchone()
    if not row:
        raise not_found("Photo")
    log_event(conn, row["vehicle_id"], "photo_deleted", staff_id=request.state.staff["id"], data={"photo_id": photo_id})
    conn.commit()  # remove the files only once the delete is final
    photostore.remove(row)
