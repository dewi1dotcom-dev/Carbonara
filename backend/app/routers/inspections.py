"""Arrival intake: start inspection, details, photos, damages, complete -> storage."""

from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from psycopg import errors

from .. import photostore, vegvesen, vinlib
from ..common import (
    bad_request, check_staff, conflict, insert_row, log_event, not_found, patch_fields, place_in_location,
    purge_vehicle, similar_vehicles, update_row,
)
from ..config import settings
from ..db import get_conn
from ..schemas import (
    ANGLES, PHOTO_KINDS, CompleteIn, DamageIn, DamagePatch, InspectionPatch, IntakeIn,
)

router = APIRouter(tags=["inspections"])

PHOTO_COLUMNS = "id, inspection_id, kind, width, height, size_bytes, taken_at, uploaded_at"


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def _open_inspection(conn, inspection_id: int) -> dict:
    """Lock an inspection row and make sure it can still be edited."""
    insp = conn.execute(
        "SELECT * FROM inspections WHERE id = %s FOR UPDATE", (inspection_id,)
    ).fetchone()
    if not insp:
        raise not_found("Inspection")
    if insp["status"] != "in_progress":
        raise conflict(f"Inspection is {insp['status'].replace('_', ' ')} and can no longer be changed")
    return insp


_check_staff = check_staff


def _check_photo(conn, inspection_id: int, photo_id: Optional[int]) -> None:
    if photo_id is not None and not conn.execute(
        "SELECT 1 FROM inspection_photos WHERE id = %s AND inspection_id = %s",
        (photo_id, inspection_id),
    ).fetchone():
        raise bad_request("Photo does not belong to this inspection")


def _checklist(insp: dict, vehicle: dict, photos: list, damages: list) -> list[dict]:
    have = {p["kind"] for p in photos}
    missing = [a for a in ANGLES if a not in have]
    return [
        {"key": "vehicle", "label": "Make and model recorded",
         "done": bool(vehicle["make"] and vehicle["model"])},
        {"key": "condition", "label": "New or used car selected",
         "done": vehicle["condition"] is not None},
        {"key": "odometer", "label": "Odometer reading recorded",
         "done": insp["odometer_km"] is not None},
        {"key": "photos", "label": "Photos from all four sides",
         "done": not missing, "missing": missing},
        {"key": "damage", "label": "Damage inspection done",
         "done": bool(damages) or insp["no_damage_confirmed"]},
    ]


def load_inspection(conn, inspection_id: int) -> dict:
    insp = conn.execute(
        """SELECT i.*, s.name AS inspector_name
             FROM inspections i LEFT JOIN staff s ON s.id = i.inspector_id
            WHERE i.id = %s""",
        (inspection_id,),
    ).fetchone()
    if not insp:
        raise not_found("Inspection")
    vehicle = conn.execute("SELECT * FROM vehicles WHERE id = %s", (insp["vehicle_id"],)).fetchone()
    photos = conn.execute(
        f"SELECT {PHOTO_COLUMNS} FROM inspection_photos WHERE inspection_id = %s ORDER BY uploaded_at",
        (inspection_id,),
    ).fetchall()
    damages = conn.execute(
        "SELECT * FROM damages WHERE inspection_id = %s ORDER BY id", (inspection_id,)
    ).fetchall()
    location = conn.execute(
        """SELECT l.id, l.code, l.zone, a.placed_at
             FROM storage_assignments a JOIN storage_spots l ON l.id = a.location_id
            WHERE a.vehicle_id = %s AND a.removed_at IS NULL""",
        (insp["vehicle_id"],),
    ).fetchone()
    checklist = _checklist(insp, vehicle, photos, damages)
    return {
        **insp,
        "vehicle": vehicle,
        "vin_info": vinlib.describe(vehicle["vin"]),
        "photos": photos,
        "damages": damages,
        "current_location": location,
        "checklist": checklist,
        "ready_to_complete": all(c["done"] for c in checklist),
        # Same reg. no or a VIN one character away on another car: warn, never block.
        "possible_duplicates": similar_vehicles(conn, vehicle["vin"], vehicle["registration_number"], vehicle["id"]),
    }


# --------------------------------------------------------------------------- #
# intake / inspection lifecycle
# --------------------------------------------------------------------------- #

@router.post("/intake", status_code=201)
def start_intake(body: IntakeIn, conn=Depends(get_conn)):
    vin = vinlib.normalize(body.vin)
    if not vinlib.is_valid_format(vin):
        raise bad_request("VIN must be 17 characters: A–Z and 0–9, without I, O or Q")
    _check_staff(conn, body.inspector_id)

    vehicle = conn.execute("SELECT * FROM vehicles WHERE vin = %s FOR UPDATE", (vin,)).fetchone()
    if vehicle is not None and vehicle["deleted_at"] is not None:
        # The VIN is in Recently deleted. It was deleted on purpose, so the car
        # starts fresh: remove the old record for good first.
        photos = purge_vehicle(conn, vehicle["id"])
        conn.commit()
        for row in photos:
            photostore.remove(row)
        vehicle = None
    if vehicle is None:
        details = body.vehicle.model_dump(exclude_none=True) if body.vehicle else {}
        try:
            vehicle = insert_row(conn, "vehicles", {"vin": vin, "status": "intake", **details})
        except errors.UniqueViolation:
            raise conflict("This VIN was registered at the same moment by someone else; try again")
        log_event(conn, vehicle["id"], "vehicle_created", staff_id=body.inspector_id,
                  data={"vin_source": body.vin_source})
    else:
        open_insp = conn.execute(
            "SELECT id FROM inspections WHERE vehicle_id = %s AND kind = 'arrival' AND status = 'in_progress'",
            (vehicle["id"],),
        ).fetchone()
        if open_insp:
            _registry_step(conn, vehicle, body)
            return {"inspection_id": open_insp["id"], "resumed": True}
        if vehicle["status"] == "in_storage":
            raise conflict("This vehicle is already in stock")
        conn.execute("UPDATE vehicles SET status = 'intake' WHERE id = %s", (vehicle["id"],))

    insp = insert_row(conn, "inspections", {
        "vehicle_id": vehicle["id"],
        "kind": "arrival",
        "inspector_id": body.inspector_id,
        "vin_source": body.vin_source,
    })
    log_event(conn, vehicle["id"], "arrival_inspection_started", staff_id=body.inspector_id,
              inspection_id=insp["id"], data={"vin_source": body.vin_source})
    _registry_step(conn, vehicle, body)
    return {"inspection_id": insp["id"], "resumed": False}


def _registry_step(conn, vehicle: dict, body: IntakeIn) -> None:
    """Pull Statens vegvesen data as the inspection starts. Blanks are filled,
    differences confirmed on the arrival screen are applied, and a car the
    registry lists as registered is marked as registered so syncing continues."""
    if not (body.use_registry and vegvesen.is_configured()):
        return
    res = vegvesen.sync_vehicle(conn, vehicle["id"], accept=body.accept_fields)
    if res.get("status_code") == "REGISTRERT" and not vehicle["registered_marked_at"]:
        conn.execute(
            "UPDATE vehicles SET registered_marked_at = now(), registered_marked_by = %s WHERE id = %s",
            (body.inspector_id, vehicle["id"]),
        )
        log_event(conn, vehicle["id"], "marked_registered", staff_id=body.inspector_id,
                  data={"source": "statens_vegvesen"})


@router.get("/inspections")
def list_inspections(status: Optional[str] = None, limit: int = 50, conn=Depends(get_conn)):
    return conn.execute(
        """SELECT i.id, i.kind, i.status, i.started_at, i.completed_at, i.vehicle_id,
                  v.vin, v.make, v.model, v.model_year, v.color,
                  s.name AS inspector_name,
                  (SELECT count(*) FROM inspection_photos p
                    WHERE p.inspection_id = i.id AND p.kind IN ('front','rear','left','right')) AS angle_photos,
                  (SELECT count(*) FROM damages d WHERE d.inspection_id = i.id) AS damage_count,
                  (SELECT l.code FROM storage_assignments a JOIN storage_spots l ON l.id = a.location_id
                    WHERE a.vehicle_id = i.vehicle_id AND a.removed_at IS NULL) AS location_code
             FROM inspections i
             JOIN vehicles v ON v.id = i.vehicle_id AND v.deleted_at IS NULL
             LEFT JOIN staff s ON s.id = i.inspector_id
            WHERE (%(status)s::text IS NULL OR i.status = %(status)s)
            ORDER BY coalesce(i.completed_at, i.cancelled_at, i.started_at) DESC
            LIMIT %(limit)s""",
        {"status": status, "limit": max(1, min(limit, 500))},
    ).fetchall()


@router.get("/inspections/{inspection_id}")
def get_inspection(inspection_id: int, conn=Depends(get_conn)):
    return load_inspection(conn, inspection_id)


@router.patch("/inspections/{inspection_id}")
def patch_inspection(inspection_id: int, body: InspectionPatch, conn=Depends(get_conn)):
    _open_inspection(conn, inspection_id)
    fields = patch_fields(body, ("no_damage_confirmed",))
    if "inspector_id" in fields:
        if fields["inspector_id"] is None:
            del fields["inspector_id"]
        else:
            _check_staff(conn, fields["inspector_id"])
    if fields.get("no_damage_confirmed"):
        if conn.execute("SELECT 1 FROM damages WHERE inspection_id = %s", (inspection_id,)).fetchone():
            raise conflict("Damages are recorded; remove them before confirming 'no damage'")
    update_row(conn, "inspections", inspection_id, fields)
    return load_inspection(conn, inspection_id)


@router.post("/inspections/{inspection_id}/complete")
def complete_inspection(inspection_id: int, body: CompleteIn, conn=Depends(get_conn)):
    insp = _open_inspection(conn, inspection_id)
    detail = load_inspection(conn, inspection_id)
    if not detail["ready_to_complete"]:
        todo = ", ".join(c["label"].lower() for c in detail["checklist"] if not c["done"])
        raise conflict(f"Inspection is not complete yet: {todo}")

    staff_id = body.staff_id or insp["inspector_id"]
    vehicle_id = insp["vehicle_id"]
    location = place_in_location(conn, vehicle_id, body.location_id, staff_id)

    conn.execute(
        "UPDATE inspections SET status = 'completed', completed_at = now() WHERE id = %s",
        (inspection_id,),
    )
    conn.execute("UPDATE vehicles SET status = 'in_storage' WHERE id = %s", (vehicle_id,))
    log_event(conn, vehicle_id, "arrival_inspection_completed", staff_id=staff_id,
              inspection_id=inspection_id,
              data={"odometer_km": insp["odometer_km"], "damage_count": len(detail["damages"])})
    log_event(conn, vehicle_id, "placed_in_storage", staff_id=staff_id, inspection_id=inspection_id,
              data={"location_id": location["id"], "location_code": location["code"]})
    return load_inspection(conn, inspection_id)


@router.post("/inspections/{inspection_id}/cancel")
def cancel_inspection(inspection_id: int, conn=Depends(get_conn)):
    insp = _open_inspection(conn, inspection_id)
    conn.execute(
        "UPDATE inspections SET status = 'cancelled', cancelled_at = now() WHERE id = %s",
        (inspection_id,),
    )
    stored = conn.execute(
        "SELECT 1 FROM storage_assignments WHERE vehicle_id = %s AND removed_at IS NULL",
        (insp["vehicle_id"],),
    ).fetchone()
    conn.execute(
        "UPDATE vehicles SET status = %s WHERE id = %s",
        ("in_storage" if stored else "off_site", insp["vehicle_id"]),
    )
    log_event(conn, insp["vehicle_id"], "arrival_inspection_cancelled",
              staff_id=insp["inspector_id"], inspection_id=inspection_id)
    return load_inspection(conn, inspection_id)


# --------------------------------------------------------------------------- #
# photos
# --------------------------------------------------------------------------- #

@router.post("/inspections/{inspection_id}/photos", status_code=201)
def upload_photo(
    inspection_id: int,
    kind: str = Form(...),
    file: UploadFile = File(...),
    uploaded_by: Optional[int] = Form(None),
    conn=Depends(get_conn),
):
    if kind not in PHOTO_KINDS:
        raise bad_request(f"kind must be one of {', '.join(PHOTO_KINDS)}")
    insp = _open_inspection(conn, inspection_id)
    _check_staff(conn, uploaded_by)

    data = file.file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(413, "Image too large")
    try:
        meta = photostore.store(data)
    except photostore.PhotoError as exc:
        raise bad_request(str(exc))

    replaced = None
    try:
        if kind in (*ANGLES, "vin"):
            replaced = conn.execute(
                "DELETE FROM inspection_photos WHERE inspection_id = %s AND kind = %s RETURNING *",
                (inspection_id, kind),
            ).fetchone()
        row = insert_row(conn, "inspection_photos", {
            "inspection_id": inspection_id, "kind": kind,
            "uploaded_by": uploaded_by or insp["inspector_id"], **meta,
        })
    except Exception:
        photostore.remove(meta)
        raise
    if replaced:
        photostore.remove(replaced)
    return {k: row[k] for k in PHOTO_COLUMNS.split(", ")}


@router.get("/photos/{photo_id}/{variant}")
def get_photo(photo_id: int, variant: str, conn=Depends(get_conn)):
    if variant not in photostore.VARIANTS:
        raise not_found("Photo variant")
    row = conn.execute("SELECT * FROM inspection_photos WHERE id = %s", (photo_id,)).fetchone()
    if not row:
        raise not_found("Photo")
    path = photostore.path_for(row, variant)
    if not path.is_file():
        raise not_found("Photo file")
    media = row["mime_type"] if variant == "original" else "image/jpeg"
    return FileResponse(path, media_type=media,
                        headers={"Cache-Control": "private, max-age=31536000, immutable"})


@router.delete("/photos/{photo_id}", status_code=204)
def delete_photo(photo_id: int, conn=Depends(get_conn)):
    row = conn.execute("SELECT * FROM inspection_photos WHERE id = %s", (photo_id,)).fetchone()
    if not row:
        raise not_found("Photo")
    _open_inspection(conn, row["inspection_id"])
    conn.execute("DELETE FROM inspection_photos WHERE id = %s", (photo_id,))
    photostore.remove(row)


# --------------------------------------------------------------------------- #
# damages
# --------------------------------------------------------------------------- #

@router.post("/inspections/{inspection_id}/damages", status_code=201)
def add_damage(inspection_id: int, body: DamageIn, conn=Depends(get_conn)):
    insp = _open_inspection(conn, inspection_id)
    _check_photo(conn, inspection_id, body.photo_id)
    row = insert_row(conn, "damages", {
        "inspection_id": inspection_id, "vehicle_id": insp["vehicle_id"], **body.model_dump(),
    })
    if insp["no_damage_confirmed"]:
        conn.execute("UPDATE inspections SET no_damage_confirmed = false WHERE id = %s", (inspection_id,))
    return row


def _damage_for_edit(conn, damage_id: int) -> dict:
    row = conn.execute("SELECT * FROM damages WHERE id = %s", (damage_id,)).fetchone()
    if not row:
        raise not_found("Damage")
    _open_inspection(conn, row["inspection_id"])
    return row


@router.patch("/damages/{damage_id}")
def patch_damage(damage_id: int, body: DamagePatch, conn=Depends(get_conn)):
    row = _damage_for_edit(conn, damage_id)
    fields = patch_fields(body, ("panel", "damage_type", "severity"))
    if fields.get("photo_id") is not None:
        _check_photo(conn, row["inspection_id"], fields["photo_id"])
    return update_row(conn, "damages", damage_id, fields)


@router.delete("/damages/{damage_id}", status_code=204)
def delete_damage(damage_id: int, conn=Depends(get_conn)):
    _damage_for_edit(conn, damage_id)
    conn.execute("DELETE FROM damages WHERE id = %s", (damage_id,))
