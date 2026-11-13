import datetime as dt
import re
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

ANGLES = ("front", "rear", "left", "right")
PHOTO_KINDS = (*ANGLES, "vin", "damage", "other")
DamageType = Literal["scratch", "dent", "chip", "crack", "scuff", "rust", "broken", "missing", "other"]
Severity = Literal["minor", "moderate", "severe"]


def _clean(v):
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


class _Clean(BaseModel):
    @field_validator("*", mode="before")
    @classmethod
    def strip_strings(cls, v):
        return _clean(v)


class StaffIn(_Clean):
    first_name: str = Field(min_length=1, max_length=60)
    last_name: str = Field(min_length=1, max_length=60)
    phone: str = Field(min_length=1, max_length=20)


class StaffPatch(_Clean):
    first_name: Optional[str] = Field(None, min_length=1, max_length=60)
    last_name: Optional[str] = Field(None, min_length=1, max_length=60)
    phone: Optional[str] = Field(None, min_length=1, max_length=20)
    active: Optional[bool] = None
    is_admin: Optional[bool] = None
    is_superadmin: Optional[bool] = None


class PinSetIn(BaseModel):
    pin: str = Field(max_length=20)


class LocationIn(_Clean):
    code: str = Field(min_length=1, max_length=30)
    zone: Optional[str] = Field(None, max_length=60)
    description: Optional[str] = Field(None, max_length=200)
    capacity: Optional[int] = Field(None, ge=1, le=10_000)  # max cars; None = unlimited
    parent_id: Optional[int] = None  # set to create a sub-zone inside that spot

    @field_validator("code")
    @classmethod
    def upper(cls, v):
        return v.upper()


class LocationPatch(_Clean):
    code: Optional[str] = Field(None, min_length=1, max_length=30)
    zone: Optional[str] = Field(None, max_length=60)
    description: Optional[str] = Field(None, max_length=200)
    capacity: Optional[int] = Field(None, ge=1, le=10_000)  # send null for unlimited
    active: Optional[bool] = None


class VehicleDetails(_Clean):
    make: Optional[str] = Field(None, max_length=60)
    model: Optional[str] = Field(None, max_length=60)
    variant: Optional[str] = Field(None, max_length=100)
    model_year: Optional[int] = Field(None, ge=1900, le=2100)
    color: Optional[str] = Field(None, max_length=40)
    fuel_type: Optional[str] = Field(None, max_length=40)
    registration_number: Optional[str] = Field(None, max_length=20)
    # New from the factory, or used. Used cars record their last service;
    # new cars' first service is due one year after first registration.
    condition: Optional[Literal["new", "used"]] = None
    last_service_date: Optional[dt.date] = None
    last_service_km: Optional[int] = Field(None, ge=0, le=5_000_000)
    # Wheels on the car now (studded tyre season warnings, common.tyre_warning).
    wheels: Optional[Literal["summer", "winter"]] = None
    # The ad on finn.no: a pasted link or just the FINN code; stored as the code.
    finn_code: Optional[str] = Field(None, max_length=500)

    @field_validator("finn_code")
    @classmethod
    def finn_code_from_link(cls, v):
        """Accepts '412345678', 'https://www.finn.no/mobility/item/412345678',
        '…/car/used/ad.html?finnkode=412345678' and similar."""
        if not v:
            return None
        m = (re.search(r"finnkode=(\d{6,12})", v) or re.search(r"/item/(\d{6,12})", v)
             or re.search(r"/ad/(\d{6,12})", v) or re.fullmatch(r"\s*(\d{6,12})\s*", v))
        if not m:
            raise ValueError("Paste a finn.no ad link or the FINN code (6–12 digits)")
        return m.group(1)

    @field_validator("registration_number")
    @classmethod
    def upper_reg(cls, v):
        # Stored without spaces/dashes: "eb 82655" -> "EB82655".
        return re.sub(r"[^A-Za-z0-9ÆØÅæøå]", "", v).upper() or None if v else v

    @field_validator("last_service_date")
    @classmethod
    def not_in_future(cls, v):
        if v and v > dt.date.today():
            raise ValueError("Last service date cannot be in the future")
        return v


class IntakeIn(BaseModel):
    vin: str
    inspector_id: int
    vin_source: Literal["manual", "barcode", "ocr", "registry"] = "manual"
    vehicle: Optional[VehicleDetails] = None
    # Fetch Statens vegvesen data when the inspection starts. accept_fields are
    # differences the inspector confirmed on the arrival screen (registry wins).
    use_registry: bool = False
    accept_fields: list[str] = []


class ResolveMismatchIn(BaseModel):
    use: list[str] = []    # take the Statens vegvesen value
    keep: list[str] = []   # keep ours (remembered for this registry value)
    staff_id: Optional[int] = None


class InspectionPatch(_Clean):
    inspector_id: Optional[int] = None
    odometer_km: Optional[int] = Field(None, ge=0, le=5_000_000)
    fuel_level_pct: Optional[int] = Field(None, ge=0, le=100)
    keys_count: Optional[int] = Field(None, ge=0, le=20)
    no_damage_confirmed: Optional[bool] = None
    notes: Optional[str] = Field(None, max_length=4000)


class DamageIn(_Clean):
    panel: str = Field(min_length=1, max_length=40)
    pos_x: Optional[float] = Field(None, ge=0, le=1)
    pos_y: Optional[float] = Field(None, ge=0, le=1)
    damage_type: DamageType
    severity: Severity
    size_mm: Optional[int] = Field(None, gt=0, le=10_000)
    description: Optional[str] = Field(None, max_length=1000)
    photo_id: Optional[int] = None


class DamagePatch(_Clean):
    panel: Optional[str] = Field(None, min_length=1, max_length=40)
    pos_x: Optional[float] = Field(None, ge=0, le=1)
    pos_y: Optional[float] = Field(None, ge=0, le=1)
    damage_type: Optional[DamageType] = None
    severity: Optional[Severity] = None
    size_mm: Optional[int] = Field(None, gt=0, le=10_000)
    description: Optional[str] = Field(None, max_length=1000)
    photo_id: Optional[int] = None


class MarkRegisteredIn(BaseModel):
    staff_id: Optional[int] = None


class MoveIn(_Clean):
    """Move a stored car to another spot (location_id), or take it off site
    (location_id = None) with an optional note such as "At workshop"."""
    location_id: Optional[int] = None
    note: Optional[str] = Field(None, max_length=200)
    staff_id: Optional[int] = None


class RepairIn(_Clean):
    note: Optional[str] = Field(None, max_length=1000)
    staff_id: Optional[int] = None


class CompleteIn(BaseModel):
    location_id: int
    staff_id: Optional[int] = None


class TestDriveReturnIn(_Clean):
    """The car is back from a test drive. `items_checked`: staff confirmed that
    everything taken out / put in for the drive is back as it was."""
    staff_id: Optional[int] = None
    odometer_in: Optional[int] = Field(None, ge=0, le=2_000_000)
    items_checked: bool = False
    return_note: Optional[str] = Field(None, max_length=500)
