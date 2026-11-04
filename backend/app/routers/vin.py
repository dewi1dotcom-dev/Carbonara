from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from PIL import UnidentifiedImageError

from .. import vinlib
from ..config import settings
from ..db import get_conn

router = APIRouter(tags=["vin"])


@router.post("/vin/recognize")
def recognize_vin(file: UploadFile = File(...)):
    data = file.file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(413, "Image too large")
    try:
        candidates = vinlib.recognize(data)
    except UnidentifiedImageError:
        raise HTTPException(422, "File is not a readable image")
    return {"candidates": candidates}


@router.get("/vin/{vin}")
def lookup_vin(vin: str, conn=Depends(get_conn)):
    """Local check only: format, check digit, and whether we already know the car.
    Registry data from Statens vegvesen is fetched once sales marks the car as
    registered (see vehicles router)."""
    vin = vinlib.normalize(vin)
    result = vinlib.describe(vin)
    result.update(existing_vehicle=None, open_inspection_id=None)
    if not result["valid_format"]:
        return result

    vehicle = conn.execute(
        """SELECT id, vin, make, model, model_year, color, registration_number, status
             FROM vehicles WHERE vin = %s""",
        (vin,),
    ).fetchone()
    if vehicle:
        result["existing_vehicle"] = vehicle
        open_insp = conn.execute(
            "SELECT id FROM inspections WHERE vehicle_id = %s AND status = 'in_progress'",
            (vehicle["id"],),
        ).fetchone()
        result["open_inspection_id"] = open_insp["id"] if open_insp else None
    return result
