"""Statens vegvesen – technical vehicle data ("Enkeltoppslag kjøretøydata").

Only used for vehicles that sales has marked as registered. Lookup is by VIN
(understellsnummer). The complete response is stored, so if Vegvesen renames
or moves a field, only `extract()` needs adjusting – no data is lost.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
from decimal import Decimal

import httpx
from psycopg import sql
from psycopg.types.json import Jsonb

from .common import log_event, update_row
from .config import settings

log = logging.getLogger("carbonara.vegvesen")


class RegistryError(Exception):
    """Temporary or configuration problem; retried with backoff."""


class NotConfigured(RegistryError):
    pass


class NotFound(Exception):
    """Vegvesen has no vehicle with this VIN (yet)."""


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

def is_configured() -> bool:
    return bool(settings.vegvesen_api_key)


def fetch_by_vin(vin: str) -> dict:
    if not is_configured():
        raise NotConfigured("VEGVESEN_API_KEY is not set")
    headers = {
        settings.vegvesen_auth_header:
            f"{settings.vegvesen_auth_scheme} {settings.vegvesen_api_key}".strip(),
        "Accept": "application/json",
    }
    try:
        r = httpx.get(settings.vegvesen_api_url, params={"understellsnummer": vin},
                      headers=headers, timeout=15)
    except httpx.HTTPError as exc:
        raise RegistryError(f"Network error: {exc}") from exc

    if r.status_code in (204, 404):
        raise NotFound("Not found in the vehicle registry")
    if r.status_code in (401, 403):
        raise RegistryError(f"API key rejected by Statens vegvesen (HTTP {r.status_code})")
    if r.status_code == 429:
        raise RegistryError("Rate limit / daily quota reached")
    if r.status_code >= 400:
        raise RegistryError(f"HTTP {r.status_code}: {r.text[:300]}")
    try:
        body = r.json()
    except ValueError as exc:
        raise RegistryError("Response was not JSON") from exc

    items = body.get("kjoretoydataListe") or []
    if not items:
        raise NotFound(body.get("feilmelding") or "Not found in the vehicle registry")
    for item in items:
        if (dig(item, "kjoretoyId", "understellsnummer") or "").upper() == vin:
            return item
    if len(items) == 1 and not dig(items[0], "kjoretoyId", "understellsnummer"):
        return items[0]
    raise RegistryError("Response did not contain this VIN")


# --------------------------------------------------------------------------- #
# Field extraction (tolerant: missing paths give None)
# --------------------------------------------------------------------------- #

def dig(obj, *path):
    for p in path:
        if isinstance(p, int):
            if not isinstance(obj, list) or len(obj) <= p:
                return None
        elif not isinstance(obj, dict):
            return None
        obj = obj[p] if isinstance(p, int) else obj.get(p)
        if obj is None:
            return None
    return obj


def _text(v, key=None):
    """Code objects look like {kodeVerdi, kodeNavn, kodeBeskrivelse}; some
    lists hold plain strings, others dicts with a named key.

    kodeNavn is the display name ("Rød", "Kombikupé (AB)"); kodeBeskrivelse is
    often a side note ("herunder: Burgunder"), so it is only a fallback."""
    if isinstance(v, dict):
        if key and v.get(key):
            return str(v[key])
        return v.get("kodeNavn") or v.get("kodeBeskrivelse") or v.get("kodeVerdi")
    return str(v) if v not in (None, "") else None


def _date(v):
    if isinstance(v, str) and len(v) >= 10:
        try:
            return dt.date.fromisoformat(v[:10])
        except ValueError:
            return None
    return None


def _int(v):
    try:
        return int(round(float(v))) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _dec(v):
    try:
        return Decimal(str(round(float(v), 1))) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def extract(item: dict) -> dict:
    td = dig(item, "godkjenning", "tekniskGodkjenning", "tekniskeData") or {}
    motor = dig(td, "motorOgDrivverk", "motor", 0) or {}
    fuel0 = dig(motor, "drivstoff", 0) or {}
    return {
        "registration_number": _text(dig(item, "kjoretoyId", "kjennemerke"))
                               or _text(dig(item, "kjennemerke", 0), "kjennemerke"),
        "registration_status": _text(dig(item, "registrering", "registreringsstatus")),
        "first_registered_norway": _date(dig(item, "forstegangsregistrering", "registrertForstegangNorgeDato")),
        "first_registered": _date(dig(item, "godkjenning", "forstegangsGodkjenning", "forstegangRegistrertDato")),
        "eu_control_due": _date(dig(item, "periodiskKjoretoyKontroll", "kontrollfrist")),
        "eu_control_last_approved": _date(dig(item, "periodiskKjoretoyKontroll", "sistGodkjent")),
        "make": _text(dig(td, "generelt", "merke", 0), "merke"),
        "model": _text(dig(td, "generelt", "handelsbetegnelse", 0)),
        "type_designation": _text(dig(td, "generelt", "typebetegnelse")),
        "vehicle_class": _text(dig(item, "godkjenning", "tekniskGodkjenning", "kjoretoyklassifisering"), "beskrivelse"),
        "body_type": _text(dig(td, "karosseriOgLasteplan", "karosseritype")),
        "color": _text(dig(td, "karosseriOgLasteplan", "rFarge", 0)),
        "fuel": _text(dig(fuel0, "drivstoffKode")),
        "power_kw": _dec(fuel0.get("maksNettoEffekt")),
        "engine_cc": _int(motor.get("slagvolum")),
        "seats": _int(dig(td, "persontall", "sitteplasserTotalt")),
        "curb_weight_kg": _int(dig(td, "vekter", "egenvekt")),
        "total_weight_kg": _int(dig(td, "vekter", "tillattTotalvekt")),
    }


def overview(item: dict | None) -> dict:
    """Extra key facts for the top of the vehicle page, read from raw data."""
    item = item or {}
    body = dig(item, "godkjenning", "tekniskGodkjenning", "tekniskeData", "karosseriOgLasteplan") or {}
    return {
        # Machine-readable status, e.g. REGISTRERT / AVREGISTRERT / VRAKET.
        "status_code": dig(item, "registrering", "registreringsstatus", "kodeVerdi"),
        "vin_location": _text(dig(body, "plasseringUnderstellsnummer", 0)),
    }


def _num(v, unit=""):
    if v in (None, ""):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    s = f"{f:,.1f}".rstrip("0").rstrip(".").replace(",", " ")
    return f"{s} {unit}".strip()


def _tyres(td: dict) -> list:
    """One row per approved tyre/rim combination, e.g. '205/60R16 on 6.5J'."""
    rows = []
    for i, combo in enumerate(dig(td, "dekkOgFelg", "akselDekkOgFelgKombinasjon") or [], 1):
        per_axle = []
        for a in combo.get("akselDekkOgFelg") or []:
            text = " on ".join(filter(None, [(a.get("dekkdimensjon") or "").strip(),
                                             (a.get("felgdimensjon") or "").strip()]))
            if text and text not in per_axle:
                per_axle.append(text)
        if per_axle:
            rows.append([f"Option {i}", " / ".join(per_axle) if len(per_axle) > 1 else per_axle[0]])
    return rows


def details(item: dict | None) -> list:
    """All other useful registry data, grouped for the 'All vehicle data'
    section. Rows are [label, value] or [label, iso_date, "date"]; empty and
    not-applicable values are left out."""
    if not item:
        return []
    appr = dig(item, "godkjenning", "tekniskGodkjenning") or {}
    td = appr.get("tekniskeData") or {}
    gen = td.get("generelt") or {}
    body = td.get("karosseriOgLasteplan") or {}
    weights = td.get("vekter") or {}
    drive = td.get("motorOgDrivverk") or {}
    motor = dig(drive, "motor", 0) or {}
    fuel0 = dig(motor, "drivstoff", 0) or {}
    env = dig(td, "miljodata", "miljoOgdrivstoffGruppe", 0) or {}
    use = dig(env, "forbrukOgUtslipp", 0) or {}
    dims = td.get("dimensjoner") or {}
    reg = item.get("registrering") or {}

    hybrid = dig(drive, "hybridKategori")
    euro = dig(td, "miljodata", "euroKlasse", "kodeVerdi")
    braked, unbraked = weights.get("tillattTilhengervektMedBrems"), weights.get("tillattTilhengervektUtenBrems")
    towing = ([["Towing", "Not allowed"]] if not braked and not unbraked else
              [["Trailer with brakes", _num(braked, "kg")], ["Trailer without brakes", _num(unbraked, "kg")]])
    if dims.get("lengde"):
        size = " × ".join(str(dims[k]) for k in ("lengde", "bredde", "hoyde") if dims.get(k)) + " mm"
    else:
        size = None
    notes = "; ".join(n.get("merknad") for n in appr.get("kjoretoymerknad") or [] if n.get("merknad")) or None

    sections = [
        ("Registration", [
            ["Status", _text(reg.get("registreringsstatus"))],
            ["First registered in Norway",
             dig(item, "forstegangsregistrering", "registrertForstegangNorgeDato"), "date"],
            ["First registered", dig(item, "godkjenning", "forstegangsGodkjenning", "forstegangRegistrertDato"), "date"],
            ["Current owner since", reg.get("registrertForstegangPaEierskap"), "date"],
            ["Use", _text(reg.get("kjoringensArt"))],
            ["Plate type", _text(dig(item, "kjennemerke", 0, "kjennemerketype"))],
        ]),
        ("Vehicle", [
            ["Make", _text(dig(gen, "merke", 0), "merke")],
            ["Model", _text(dig(gen, "handelsbetegnelse", 0))],
            ["Type designation", _text(gen.get("typebetegnelse"))],
            ["Class", _text(appr.get("kjoretoyklassifisering"), "beskrivelse")],
            ["Body", _text(body.get("karosseritype"))],
            ["Doors", _text(body.get("plasseringAvDorer"))],
            ["Seats", _num(dig(td, "persontall", "sitteplasserTotalt"))],
            ["Length × width × height", size],
            ["Manufacturer", _text(dig(gen, "fabrikant", 0), "fabrikantNavn")],
            ["Type plate location", _text(dig(body, "plasseringFabrikasjonsplate", 0))],
        ]),
        ("Drivetrain and environment", [
            ["Fuel", _text(fuel0.get("drivstoffKode"))],
            ["Power", _num(fuel0.get("maksNettoEffekt"), "kW")],
            ["Engine", _num(motor.get("slagvolum"), "cc")],
            ["Gearbox", _text(drive.get("girkassetype"))],
            ["Hybrid", _text(hybrid) if hybrid and hybrid.get("kodeVerdi") != "INGEN" else None],
            ["Top speed", _num(dig(drive, "maksimumHastighet", 0), "km/h")],
            ["Range (WLTP)", _num(use.get("rekkeviddeKm"), "km")],
            ["Energy use", _num(use.get("elEnergiforbruk"), "Wh/km")],
            ["Fuel consumption", _num(use.get("forbrukBlandetKjoring"), "l/100 km")],
            ["CO₂", _num(use.get("co2BlandetKjoring"), "g/km")],
            ["Euro class", f"Euro {euro}" if euro else None],
            ["Engine code", _text(motor.get("motorKode"))],
        ]),
        ("Weights and towing", [
            ["Curb weight", _num(weights.get("egenvekt"), "kg")],
            ["Payload", _num(weights.get("nyttelast"), "kg")],
            ["Max total weight", _num(weights.get("tillattTotalvekt"), "kg")],
            *towing,
            ["Max train weight", _num(weights.get("tillattVogntogvekt") or None, "kg")],
        ]),
        ("Tyres and rims", _tyres(td)),
        ("Approval", [
            ["EU type approval", _text(dig(appr, "kjoretoyklassifisering", "efTypegodkjenning", "typegodkjenningNrTekst"))],
            ["Notes", notes],
        ]),
    ]
    out = []
    for title, rows in sections:
        rows = [r for r in rows if r[1] not in (None, "")]
        if rows:
            out.append({"title": title, "rows": rows})
    return out


# Fields whose change is worth a line in the vehicle's history.
TRACKED = ("registration_number", "registration_status", "eu_control_due",
           "eu_control_last_approved", "color")

# vehicles column <- registry field. Registration number is authoritative and
# always overwritten; the rest only fill in blanks typed at arrival.
OVERWRITE = {"registration_number": "registration_number"}
FILL_BLANK = {"make": "make", "model": "model", "color": "color", "fuel_type": "fuel"}


def _plain(v):
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    return v


# --------------------------------------------------------------------------- #
# Sync
# --------------------------------------------------------------------------- #

def _set_registry(conn, vehicle_id: int, fields: dict) -> None:
    update_row(conn, "vehicle_registry", vehicle_id, fields, key="vehicle_id")


def sync_vehicle(conn, vehicle_id: int) -> dict:
    """Fetch and store registry data for one vehicle. Never raises for API
    problems – the outcome is recorded on the vehicle_registry row."""
    vehicle = conn.execute("SELECT * FROM vehicles WHERE id = %s", (vehicle_id,)).fetchone()
    conn.execute(
        "INSERT INTO vehicle_registry (vehicle_id) VALUES (%s) ON CONFLICT (vehicle_id) DO NOTHING",
        (vehicle_id,),
    )
    prev = conn.execute(
        "SELECT * FROM vehicle_registry WHERE vehicle_id = %s FOR UPDATE", (vehicle_id,)
    ).fetchone()
    now = dt.datetime.now(dt.timezone.utc)

    try:
        item = fetch_by_vin(vehicle["vin"])
    except NotFound as exc:
        _set_registry(conn, vehicle_id, {
            "sync_status": "not_found", "last_attempt_at": now, "last_error": str(exc),
            "failures": prev["failures"] + 1, "next_sync_at": now + dt.timedelta(days=1),
        })
        return {"status": "not_found", "message": str(exc)}
    except RegistryError as exc:
        failures = prev["failures"] + 1
        backoff = min(dt.timedelta(hours=24), dt.timedelta(minutes=15) * 2 ** min(failures, 10))
        _set_registry(conn, vehicle_id, {
            "sync_status": "error", "last_attempt_at": now, "last_error": str(exc),
            "failures": failures, "next_sync_at": now + backoff,
        })
        log.warning("Vegvesen sync failed for vehicle %s: %s", vehicle_id, exc)
        return {"status": "error", "message": str(exc)}

    fields = extract(item)
    digest = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()
    last = conn.execute(
        "SELECT data_hash FROM vehicle_registry_snapshots WHERE vehicle_id = %s "
        "ORDER BY fetched_at DESC, id DESC LIMIT 1",
        (vehicle_id,),
    ).fetchone()
    if not last or last["data_hash"] != digest:
        conn.execute(
            "INSERT INTO vehicle_registry_snapshots (vehicle_id, data_hash, data) VALUES (%s, %s, %s)",
            (vehicle_id, digest, Jsonb(item)),
        )

    _set_registry(conn, vehicle_id, {
        **fields, "data": Jsonb(item), "sync_status": "ok", "last_attempt_at": now,
        "last_success_at": now, "failures": 0, "last_error": None,
        "next_sync_at": now + dt.timedelta(days=settings.vegvesen_sync_days),
    })

    # Copy into the vehicle record.
    updates = {col: fields[src] for col, src in OVERWRITE.items()
               if fields[src] and fields[src] != vehicle[col]}
    # Fill blanks, and also refresh values that were copied from the registry
    # earlier (vehicle value == previous registry value), so corrections flow
    # through without overwriting anything staff typed in themselves.
    updates |= {col: fields[src] for col, src in FILL_BLANK.items()
                if fields[src] and fields[src] != vehicle[col]
                and (not vehicle[col] or vehicle[col] == prev[src])}
    if updates:
        update_row(conn, "vehicles", vehicle_id, updates)

    vehicle_changes = {k: [_plain(vehicle[k]), _plain(v)] for k, v in updates.items()}
    if prev["last_success_at"] is None:
        log_event(conn, vehicle_id, "registry_first_sync", data={
            "registration_number": fields["registration_number"],
            "eu_control_due": _plain(fields["eu_control_due"]),
            "vehicle_changes": vehicle_changes,
        })
    else:
        changes = {k: [_plain(prev[k]), _plain(fields[k])] for k in TRACKED if prev[k] != fields[k]}
        if changes or vehicle_changes:
            log_event(conn, vehicle_id, "registry_changed",
                      data={"changes": changes, "vehicle_changes": vehicle_changes})
    return {"status": "ok"}


def due_vehicle_ids_sql():
    return sql.SQL(
        """SELECT r.vehicle_id
             FROM vehicle_registry r JOIN vehicles v ON v.id = r.vehicle_id
            WHERE v.registered_marked_at IS NOT NULL AND r.next_sync_at <= now()
            ORDER BY r.next_sync_at
            LIMIT 1
            FOR UPDATE OF r SKIP LOCKED"""
    )
