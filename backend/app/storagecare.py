"""Storage maintenance programme for new cars, after MG's bulletin
SI-GI2022102501 ("Technical requirements for storage vehicles management").
Used for every factory-new car in storage until its PDI is done.

Schedule: an arrival check (month 0), then periodic check n is due n months
after the start. Check n is a 6-month check if n % 6 == 0, a 3-month check if
n % 3 == 0, otherwise a monthly check; larger checks include the smaller ones.
"""

from __future__ import annotations

import calendar
import datetime as dt
from dataclasses import dataclass

LEVELS = ("monthly", "quarterly", "half_year")
LEVEL_TEXT = {"monthly": "Månedlig", "quarterly": "3 måneder", "half_year": "6 måneder"}
LEVEL_EN = {"monthly": "Monthly check", "quarterly": "3-month check", "half_year": "6-month check"}

# BEV/PHEV/FCEV ("new energy vehicles") get the HV-battery steps; pure
# electric cars skip starting the engine.
NEV_FUELS = {"electric", "plug-in hybrid", "hydrogen"}
BEV_FUELS = {"electric", "hydrogen"}


@dataclass(frozen=True)
class Item:
    key: str
    label: str           # Norwegian, as on MG's sheets (also printed)
    when: str            # arrival | monthly | quarterly | half_year
    applies: str = "all"  # all | nev (BEV/PHEV/FCEV) | engine (not pure electric)


ITEMS: tuple[Item, ...] = (
    # Arrival / parking (MG long-term storage sheet, bulletin points 1–16)
    Item("park_150", "Minimum 150 mm til neste objekt foran og bak", "arrival"),
    Item("park_600", "Minimum 600 mm åpen plass på siden", "arrival"),
    Item("park_trees", "Ikke parkert under trær eller annet som kan skade bilen", "arrival"),
    Item("park_heat", "Lagret vekk fra varmekilder og svært fuktige områder", "arrival"),
    Item("gear", "Girspak i P (automat) / 1. gir (manuell), parkeringsbrems ikke på", "arrival"),
    Item("dash", "Ingenting på dashbordet, solskjerm i hvileposisjon", "arrival"),
    Item("ac_vents", "Alle A/C-ventiler åpne", "arrival"),
    Item("closed", "Takluke og gardin, vinduer, dører, panser og bakluke lukket", "arrival"),
    Item("carpet", "Teppebeskyttelse lagt inn på førersiden", "arrival"),
    Item("wipers_up", "Viskerarmer løftet", "arrival"),
    Item("arr_electrical", "Alt elektrisk utstyr avslått", "arrival"),
    Item("arr_disconnect", "12V-batteri frakoblet (minuspol)", "arrival"),
    # Every month (bulletin: dynamic inspection > 1 month)
    Item("surface", "Sjekk lakk for aggressive stoffer (mose, støv, fugleskitt), vask ved behov", "monthly"),
    Item("doors_horn", "Åpne og lukk dører, panser og bakluke; test horn 3 ganger", "monthly"),
    Item("engine_5min", "Start bilen på tomgang i minst 5 minutter, lytt etter lyder", "monthly", "engine"),
    Item("ac_on", "Skru på A/C og bruk ventilasjonen én gang (over 5 °C)", "monthly"),
    Item("move_40", "Flytt bilen minimum 40 cm", "monthly"),
    Item("mon_electrical", "Alt elektrisk utstyr avslått", "monthly"),
    Item("mon_disconnect", "Koble fra 12V-batteri", "monthly"),
    # Every 3 months (on top of the monthly check)
    Item("ready_10", "READY-modus i 10 min, deretter 12V tilkoblet i 2 timer (balansering av HV-batteri)",
         "quarterly", "nev"),
    Item("wipers", "Rengjør viskere og ruter, test spylere", "quarterly"),
    Item("fluids", "Sjekk og etterfyll væsker: kjølevæske, motorolje, spylervæske, bremsevæske", "quarterly"),
    Item("seals", "Sjekk alle dørpakninger og taklukepakning", "quarterly"),
    Item("paint", "Sjekk lakk, interiør og overflater", "quarterly"),
    # Every 6 months
    Item("ac_charge", "Lad HV-batteriet i minimum 2 timer med AC-lading", "half_year", "nev"),
)
BY_KEY = {i.key: i for i in ITEMS}

BATTERY_STATUS = {
    "good": "God",
    "good_recharge": "God – lad opp",
    "charge_retest": "Lad og test på nytt",
    "replace": "Bytt batteri",
}
BATTERY_ACTION = {"none": "Ingen", "charged": "Ladet", "replaced": "Byttet"}

TYRE_MIN, TYRE_MAX = 2.6, 2.8
V12_MIN = 12.5
SOC_MIN, SOC_LONG = 30, 50


def fuel_kind(fuel: str | None) -> dict:
    f = (fuel or "").strip().lower()
    known = bool(f)
    return {"known": known, "nev": f in NEV_FUELS or not known, "bev": f in BEV_FUELS}


def items_for(kind: str, level: str | None, fuel: str | None) -> list[Item]:
    """The checklist for an arrival check or a periodic check of `level`.
    Unknown fuel: every item is shown (staff can mark N/A)."""
    fk = fuel_kind(fuel)
    whens = {"arrival"} if kind == "arrival" else set(LEVELS[: LEVELS.index(level) + 1])
    out = []
    for i in ITEMS:
        if i.when not in whens:
            continue
        if i.applies == "nev" and not fk["nev"]:
            continue
        if i.applies == "engine" and fk["bev"]:
            continue
        out.append(i)
    return out


def add_months(d: dt.date, months: int) -> dt.date:
    y, m = divmod(d.month - 1 + months, 12)
    year, month = d.year + y, m + 1
    return dt.date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def level_for(seq: int) -> str:
    return "half_year" if seq % 6 == 0 else "quarterly" if seq % 3 == 0 else "monthly"


def next_check(start: dt.date | None, has_arrival: bool, periodic_done: int, today: dt.date) -> dict:
    """What is due next: the arrival check, or periodic check n."""
    if not has_arrival or start is None:
        return {"kind": "arrival", "level": None, "seq": 0, "due": today, "days": 0,
                "title": "Ankomstkontroll", "title_en": "Arrival check"}
    seq = periodic_done + 1
    due = add_months(start, seq)
    level = level_for(seq)
    return {"kind": "periodic", "level": level, "seq": seq, "due": due, "days": (due - today).days,
            "title": f"{LEVEL_TEXT[level]} sjekk", "title_en": LEVEL_EN[level]}
