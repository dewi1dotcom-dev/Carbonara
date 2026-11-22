"""Market data (test, 0.46.0): car listings imported from a file, compared with our own asking prices.

The person imports a CSV (one row per listing: make, model, year, km, price …) on the Market prices page. Each
make + model in a file **replaces** the earlier listings of that make + model, so a new file of the same search
refreshes the prices and other models stay. Carbonara never fetches listings itself.

Matching: make and model ignoring case, spaces and punctuation; an exact model first, else one that starts with the
other ("ZS" ↔ "ZS EV"). The estimate for a car is a least-squares fit of price on year and mileage over the active
listings of its model (needs 8+ with year and km); the similar listings are year ± 1 and mileage ± 25 % (at least
20 000 km). Switched on / off on the System page (setting market_data); off = 404 here.
"""
import csv
import io
import re
import statistics
from typing import Optional

from fastapi import APIRouter, Depends, File, Request, UploadFile

from ..auth import require_admin
from ..common import bad_request, not_found
from ..config import settings
from ..db import get_conn
from .vehicles import PRICE_BASE

router = APIRouter(tags=["market"])

MAX_BYTES = 10 * 1024 * 1024
MAX_ROWS = 50_000
MIN_FIT = 8          # listings with year + km needed for the year / mileage estimate
SIMILAR_SHOWN = 8

# Column names accepted (lower case, without spaces / _ / -): the first one found wins.
COLUMNS = {
    "make": ("make", "merke", "brand"),
    "model": ("model", "modell"),
    "variant": ("variant", "title", "tittel", "modellvariant"),
    "year": ("year", "modelyear", "modellår", "årsmodell", "modellar", "arsmodell"),
    "km": ("km", "mileage", "kilometerstand", "kilometer", "odometer"),
    "price": ("pricenok", "price", "pris", "totalpris", "askingprice"),
    "first_price": ("firstpricenok", "firstprice", "originalprice"),
    "fuel": ("fuel", "drivstoff"),
    "seller": ("seller", "selger", "sellertype"),
    "status": ("status",),
    "first_seen": ("firstseen",),
    "last_seen": ("lastseen",),
    "finn_code": ("finncode", "finnkode", "code"),
    "url": ("url", "link", "lenke"),
}
INACTIVE = re.compile(r"sold|solgt|removed|fjernet|inactive|inaktiv|expired|utløpt", re.I)
PRIVATE = re.compile(r"^\s*priv|privatperson", re.I)
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def key(text: Optional[str]) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def _enabled() -> None:
    if settings.market_data != "on":
        raise not_found("Market data (turned off on the System page)")


def _int(value, lo: int, hi: int) -> Optional[int]:
    """A whole number from "124 532", "124532 kr" or "124532.00"; None when missing or outside lo..hi."""
    text = re.sub(r"[.,]\d{1,2}\s*$", "", str(value or "").strip())  # drop decimals (øre)
    digits = re.sub(r"[^\d]", "", text)
    if not digits:
        return None
    n = int(digits)
    return n if lo <= n <= hi else None


def _text(value, n: int = 200) -> Optional[str]:
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    return value[:n] or None


# --------------------------------------------------------------------------- #
# import
# --------------------------------------------------------------------------- #

def parse(data: bytes) -> tuple[list[dict], int]:
    """The listings in a CSV file (comma, semicolon or tab) and the number of rows skipped."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252", errors="replace")
    # The separator is the one used most in the header line (Excel in Norway saves CSV with semicolons).
    first = text.split("\n", 1)[0]
    delimiter = max((",", ";", "\t"), key=first.count)
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    header = next(reader, None)
    if not header:
        raise bad_request("The file is empty")
    names = [key(h) for h in header]
    index = {}
    for field, aliases in COLUMNS.items():
        for alias in aliases:
            if key(alias) in names:
                index[field] = names.index(key(alias))
                break
    missing = [f for f in ("make", "model", "price") if f not in index]
    if missing:
        raise bad_request(f"The file has no column for: {', '.join(missing)}")

    rows, skipped, seen = [], 0, set()
    for i, raw in enumerate(reader):
        if i >= MAX_ROWS:
            raise bad_request(f"The file has more than {MAX_ROWS} rows")
        get = lambda f: raw[index[f]] if f in index and index[f] < len(raw) else None  # noqa: E731
        make, model = _text(get("make"), 60), _text(get("model"), 80)
        price = _int(get("price"), 1000, 99_999_999)
        if not (make and model and price and key(make) and key(model)):
            skipped += 1
            continue
        code = _int(get("finn_code"), 100000, 999_999_999_999)
        if code and code in seen:
            skipped += 1  # the same ad twice in one file
            continue
        if code:
            seen.add(code)
        status = _text(get("status"), 40)
        seller = get("seller")
        url = _text(get("url"), 300)
        rows.append({
            "make": make, "model": model, "make_key": key(make), "model_key": key(model),
            "variant": _text(get("variant")),
            "year": _int(get("year"), 1950, 2100),
            "km": _int(get("km"), 0, 2_000_000),
            "price": price,
            "first_price": _int(get("first_price"), 1000, 99_999_999),
            "fuel": _text(get("fuel"), 40),
            "seller_kind": None if not _text(seller) else "private" if PRIVATE.search(seller) else "dealer",
            "status": status,
            "active": not (status and INACTIVE.search(status)),
            "first_seen": (get("first_seen") or "")[:10] if DATE.match(get("first_seen") or "") else None,
            "last_seen": (get("last_seen") or "")[:10] if DATE.match(get("last_seen") or "") else None,
            "finn_code": str(code) if code else None,
            "url": url if url and url.startswith("https://") else None,
        })
    if not rows:
        raise bad_request("No usable rows in the file (each needs make, model and price)")
    return rows, skipped


@router.post("/market/import", status_code=201)
async def import_file(request: Request, file: UploadFile = File(...), conn=Depends(get_conn),
                      admin=Depends(require_admin)):
    _enabled()
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise bad_request("The file is too large")
    rows, skipped = parse(data)
    groups = {}
    for r in rows:
        groups.setdefault((r["make_key"], r["model_key"]), f"{r['make']} {r['model']}")
    imp = conn.execute(
        """INSERT INTO market_imports (file_name, rows_read, rows_skipped, models, imported_by)
           VALUES (%s, %s, %s, %s, %s) RETURNING *""",
        ((file.filename or "file.csv")[:200], len(rows), skipped, sorted(groups.values()), admin["id"])).fetchone()
    replaced = 0
    for make_key, model_key in groups:
        replaced += conn.execute("DELETE FROM market_listings WHERE make_key = %s AND model_key = %s",
                                 (make_key, model_key)).rowcount
    cols = ["make", "model", "make_key", "model_key", "variant", "year", "km", "price", "first_price", "fuel",
            "seller_kind", "status", "active", "first_seen", "last_seen", "finn_code", "url"]
    with conn.cursor() as cur:
        cur.executemany(
            f"INSERT INTO market_listings (import_id, {', '.join(cols)}) VALUES (%s, {', '.join(['%s'] * len(cols))})",
            [(imp["id"], *[r[c] for c in cols]) for r in rows])
    # Imports whose listings were all replaced are only history now; drop them.
    conn.execute("""DELETE FROM market_imports i WHERE i.id <> %s
                     AND NOT EXISTS (SELECT 1 FROM market_listings l WHERE l.import_id = i.id)""", (imp["id"],))
    return {**imp, "replaced": replaced}


@router.delete("/market/imports/{import_id}", status_code=204)
def delete_import(import_id: int, conn=Depends(get_conn), _admin=Depends(require_admin)):
    _enabled()
    if not conn.execute("DELETE FROM market_imports WHERE id = %s", (import_id,)).rowcount:
        raise not_found("Import")


# --------------------------------------------------------------------------- #
# comparison
# --------------------------------------------------------------------------- #

def _listings(conn) -> list[dict]:
    return conn.execute(
        """SELECT id, make, model, make_key, model_key, variant, year, km, price, first_price, fuel, seller_kind,
                  status, active, first_seen, last_seen, finn_code, url
             FROM market_listings ORDER BY price""").fetchall()


def matches(car: dict, listings: list[dict]) -> list[dict]:
    """The listings of the car's make and model: the exact model if any, else one starting with the other."""
    mk, md = key(car.get("make")), key(car.get("model"))
    if not (mk and md):
        return []
    same_make = [x for x in listings if x["make_key"] == mk]
    exact = [x for x in same_make if x["model_key"] == md]
    if exact:
        return exact
    return [x for x in same_make if x["model_key"].startswith(md) or md.startswith(x["model_key"])]


def _fit(points: list[tuple[float, float, float]]):
    """Least squares price = a + b·year + c·km (normal equations, 3×3). None when it can't be solved."""
    n = len(points)
    if n < MIN_FIT:
        return None
    ys = {p[0] for p in points}
    use_year = len(ys) > 1
    # Centre the values so the 3×3 system is well conditioned.
    my = statistics.fmean(p[0] for p in points)
    mk = statistics.fmean(p[1] for p in points)
    rows = [((p[0] - my) if use_year else 0.0, (p[1] - mk) / 10000, p[2]) for p in points]
    sxx = sum(r[0] * r[0] for r in rows); sxz = sum(r[0] * r[1] for r in rows); szz = sum(r[1] * r[1] for r in rows)
    sxp = sum(r[0] * r[2] for r in rows); szp = sum(r[1] * r[2] for r in rows)
    mean_p = statistics.fmean(r[2] for r in rows)
    sxp -= mean_p * sum(r[0] for r in rows); szp -= mean_p * sum(r[1] for r in rows)
    det = sxx * szz - sxz * sxz
    if use_year and abs(det) > 1e-9:
        b = (sxp * szz - szp * sxz) / det
        c = (szp * sxx - sxp * sxz) / det
    elif szz > 1e-9:
        b, c = 0.0, szp / szz
    else:
        return None
    return lambda year, km: mean_p + (b * (year - my) if use_year else 0) + c * ((km - mk) / 10000)


def compare(car: dict, listings: list[dict]) -> Optional[dict]:
    """The market for one car: all listings of its model, an estimate for its year + mileage, and the most
    similar listings. None when no listing matches."""
    found = [x for x in matches(car, listings) if x["active"]]
    if not found:
        return None
    prices = [x["price"] for x in found]
    year = car.get("model_year") or car.get("first_reg_year")
    km = car.get("km")
    estimate = None
    if year:
        pts = [(x["year"], x["km"], x["price"]) for x in found if x["year"] and x["km"] is not None]
        # Only years near the car's: a 2016 listing says little about a 2022 car.
        near = [p for p in pts if abs(p[0] - year) <= 2]
        f = _fit(near if len(near) >= MIN_FIT else pts)
        if f:
            km_for = km
            if km_for is None:  # mileage unknown: the typical mileage of that year (else of all listings)
                same_year = [p[1] for p in pts if p[0] == year]
                km_for = statistics.median(same_year or [p[1] for p in pts])
            value = f(year, km_for)
            lo, hi = min(prices), max(prices)
            if lo * 0.6 <= value <= hi * 1.4:  # a fit far outside the market is not shown
                estimate = {"price": int(round(value / 1000) * 1000), "basis": len(near if len(near) >= MIN_FIT else pts),
                            "km_assumed": km is None}
    similar = [x for x in found if year and x["year"] and abs(x["year"] - year) <= 1
               and (km is None or x["km"] is None or abs(x["km"] - km) <= max(20000, km * 0.25))]
    score = lambda x: abs((x["year"] or 0) - (year or 0)) * 20000 + abs((x["km"] or 0) - (km or 0))  # noqa: E731
    sim_prices = [x["price"] for x in similar]
    return {
        "model_name": f"{found[0]['make']} {found[0]['model']}",
        "all": {"n": len(found), "low": min(prices), "median": int(statistics.median(prices)), "high": max(prices)},
        "similar": {"n": len(similar), "low": min(sim_prices), "median": int(statistics.median(sim_prices)),
                    "high": max(sim_prices)} if similar else None,
        "estimate": estimate,
        "closest": sorted(similar or found, key=score)[:SIMILAR_SHOWN],
        "year": year, "km": km,
    }


# Cars to price: in stock, plus cars added from their ad that haven't arrived yet (off site, no arrival inspection).
# Delivered cars (off site after an arrival inspection) are left out.
CARS_SQL = PRICE_BASE + """ AND (v.status <> 'off_site' OR NOT EXISTS (
        SELECT 1 FROM inspections ai WHERE ai.vehicle_id = v.id AND ai.kind = 'arrival' AND ai.status = 'completed'))"""


@router.get("/market")
def market(conn=Depends(get_conn)):
    _enabled()
    listings = _listings(conn)
    models = {}
    for x in listings:
        g = models.setdefault((x["make_key"], x["model_key"]), {"make": x["make"], "model": x["model"], "prices": [],
                                                                 "years": [], "inactive": 0, "last_seen": None})
        if not x["active"]:
            g["inactive"] += 1
            continue
        g["prices"].append(x["price"])
        if x["year"]:
            g["years"].append(x["year"])
        if x["last_seen"] and (not g["last_seen"] or x["last_seen"] > g["last_seen"]):
            g["last_seen"] = x["last_seen"]
    model_rows = [{
        "make": g["make"], "model": g["model"], "n": len(g["prices"]), "inactive": g["inactive"],
        "low": min(g["prices"]) if g["prices"] else None, "high": max(g["prices"]) if g["prices"] else None,
        "median": int(statistics.median(g["prices"])) if g["prices"] else None,
        "year_min": min(g["years"]) if g["years"] else None, "year_max": max(g["years"]) if g["years"] else None,
        "last_seen": g["last_seen"],
    } for g in models.values()]
    model_rows.sort(key=lambda r: (r["make"].lower(), r["model"].lower()))
    cars = []
    for car in conn.execute(CARS_SQL + " ORDER BY lower(v.make), lower(v.model)").fetchall():
        c = compare(car, listings)
        if c:
            c.pop("closest")
            cars.append({**car, "market": c})
    imports = conn.execute(
        """SELECT i.id, i.file_name, i.rows_read, i.rows_skipped, i.models, i.imported_at, s.name AS imported_by,
                  (SELECT count(*) FROM market_listings l WHERE l.import_id = i.id) AS listings
             FROM market_imports i LEFT JOIN staff s ON s.id = i.imported_by
            ORDER BY i.imported_at DESC""").fetchall()
    return {"imports": imports, "models": model_rows, "cars": cars, "listings": len(listings)}


@router.get("/vehicles/{vehicle_id}/market")
def vehicle_market(vehicle_id: int, conn=Depends(get_conn)):
    _enabled()
    car = conn.execute(PRICE_BASE + " AND v.id = %s", (vehicle_id,)).fetchone()
    if not car:
        raise not_found("Vehicle")
    return {"market": compare(car, _listings(conn)), "asking_price": car["asking_price"]}
