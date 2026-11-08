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
    name: str = Field(min_length=1, max_length=100)


class StaffPatch(_Clean):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    active: Optional[bool] = None


class LocationIn(_Clean):
    code: str = Field(min_length=1, max_length=30)
    zone: Optional[str] = Field(None, max_length=60)
    description: Optional[str] = Field(None, max_length=200)

    @field_validator("code")
    @classmethod
    def upper(cls, v):
        return v.upper()


class LocationPatch(_Clean):
    code: Optional[str] = Field(None, min_length=1, max_length=30)
    zone: Optional[str] = Field(None, max_length=60)
    description: Optional[str] = Field(None, max_length=200)
    active: Optional[bool] = None


class VehicleDetails(_Clean):
    make: Optional[str] = Field(None, max_length=60)
    model: Optional[str] = Field(None, max_length=60)
    variant: Optional[str] = Field(None, max_length=100)
    model_year: Optional[int] = Field(None, ge=1900, le=2100)
    color: Optional[str] = Field(None, max_length=40)
    fuel_type: Optional[str] = Field(None, max_length=40)
    registration_number: Optional[str] = Field(None, max_length=20)

    @field_validator("registration_number")
    @classmethod
    def upper_reg(cls, v):
        return v.upper() if v else v


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
