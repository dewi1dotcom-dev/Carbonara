"""Adding a car to Carbonara from its finn.no ad (0.45.0; the user's request: cars already advertised when
Carbonara is taken into use, or advertised before they arrive).

Carbonara Sidekick reads the dealer's own ad the person has open (on their click), then:
1. `POST /vehicles/from-ad/preview` {registration_number, vin?}: is the car already here (reg. no or VIN), and what
   Statens vegvesen says (the VIN is required for every car and is rarely on an ad; make / model / colour / fuel).
2. `POST /vehicles/from-ad`: creates the car **off site** (the user's choice: it counts in storage only once it is
   placed or has its arrival inspection), with the ad's link, asking price and mileage, and syncs the registry
   (a registered car is marked as registered, as with "Sync now"). Sidekick then uploads the ticked photos
   (`POST /vehicles/{id}/photos`, source finn).
The server never contacts finn.no.
"""

import datetime as dt
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from .. import vegvesen, vinlib
from ..common import bad_request, conflict, insert_row, log_event
from ..db import get_conn
from ..schemas import VehicleDetails

router = APIRouter(tags=["from ad"])


class PreviewIn(BaseModel):
    registration_number: Optional[str] = Field(None, max_length=20)
    vin: Optional[str] = Field(None, max_length=30)


def _existing(conn, reg: Optional[str], vin: Optional[str]) -> Optional[dict]:
    return conn.execute(
        """SELECT id, vin, registration_number, make, model, model_year, finn_code, status, deleted_at
             FROM vehicles WHERE (%s::text IS NOT NULL AND registration_number = %s) OR (%s::text IS NOT NULL AND vin = %s)
            ORDER BY deleted_at NULLS FIRST LIMIT 1""", (reg, reg, vin, vin)).fetchone()


@router.post("/vehicles/from-ad/preview")
def preview(body: PreviewIn, conn=Depends(get_conn)):
    reg = vegvesen.normalize_regnr(body.registration_number or "") or None
    vin = vinlib.normalize(body.vin or "") or None
    if vin and not vinlib.is_valid_format(vin):
        vin = None
    registry, error = None, None
    if not (reg or vin):
        error = "The ad shows no registration number"
    elif not vegvesen.is_configured():
        error = "Statens vegvesen lookup is not set up (System page)"
    else:
        try:
            item = vegvesen.fetch_by_vin(vin) if vin else vegvesen.fetch_by_regnr(reg)
            registry = vegvesen.summary(item)
            vin = vin or registry.get("vin")
            reg = reg or registry["values"].get("registration_number")
        except vegvesen.NotFound:
            error = "Statens vegvesen does not know this registration number"
        except vegvesen.RegistryError as exc:
            error = f"Statens vegvesen could not be asked: {exc}"
    return {"registration_number": reg, "vin": vin, "registry": registry, "registry_error": error,
            "existing": _existing(conn, reg, vin)}


class FromAdIn(VehicleDetails):
    vin: str = Field(min_length=17, max_length=30)


@router.post("/vehicles/from-ad", status_code=201)
def create(body: FromAdIn, request: Request, conn=Depends(get_conn)):
    me = request.state.staff["id"]
    vin = vinlib.normalize(body.vin)
    if not vinlib.is_valid_format(vin):
        raise bad_request("VIN must be 17 characters: A–Z and 0–9, without I, O or Q")
    fields = body.model_dump(exclude_none=True, exclude={"vin", "asking_price_source"})
    found = _existing(conn, fields.get("registration_number"), vin)
    if found:
        raise conflict("This car is in Recently deleted; restore it there" if found["deleted_at"]
                       else "This car is already in Carbonara")
    now = dt.datetime.now(dt.timezone.utc)
    if fields.get("asking_price") is not None:
        fields |= {"asking_price_at": now, "asking_price_source": "finn"}
    if fields.get("listed_km") is not None:
        fields["listed_km_at"] = now
    vehicle = insert_row(conn, "vehicles", {"vin": vin, "status": "off_site", **fields})
    log_event(conn, vehicle["id"], "vehicle_created", staff_id=me,
              data={"vin_source": "registry", "source": "finn", "finn_code": fields.get("finn_code")})
    if vegvesen.is_configured():
        result = vegvesen.sync_vehicle(conn, vehicle["id"])  # never raises for registry problems
        if result.get("status_code") == "REGISTRERT":
            conn.execute("UPDATE vehicles SET registered_marked_at = now(), registered_marked_by = %s WHERE id = %s",
                         (me, vehicle["id"]))
            log_event(conn, vehicle["id"], "marked_registered", staff_id=me, data={"source": "statens_vegvesen"})
    return {"id": vehicle["id"], "vin": vin}
