"""Read the holder's name from a photo of a driving licence.

Norwegian (and all EU-format) licences number their fields:
    1. SURNAME            2. GIVEN NAMES        3. date and place of birth
    4a/4b/4c. dates, authority                  5. licence number
The OCR finds the "1." / "2." labels and takes the text after them (in the
same box, or the next box on the same line). The photo is only read in
memory here; nothing is stored.
"""

from __future__ import annotations

import io
import logging
import re

from PIL import Image, ImageOps

from .vinlib import scene_text

log = logging.getLogger("carbonara.license")

# "1. NORDMANN", "1.NORDMANN", "1, NORDMANN", "1 NORDMANN" — or just the label "1." alone.
_FIELD = re.compile(r"^\s*([12])\s*[.,:]?\s*(.*)$")
_NAME_CHARS = re.compile(r"[^A-ZÆØÅÄÖÜÉÈÁÀÓÍÚÑ' \-]")
# Header words on the card that are never a name.
_NOT_NAMES = {"NORGE", "NORWAY", "FØRERKORT", "FORERKORT", "DRIVING", "LICENCE", "LICENSE", "KONGERIKET",
              "PERMIS", "DE", "CONDUIRE", "FÜHRERSCHEIN", "PATENTE", "KØREKORT", "KÖRKORT", "EU", "N"}


def _clean_name(text: str) -> str:
    text = _NAME_CHARS.sub("", text.upper().replace("0", "O")).strip(" -'")
    return re.sub(r"\s{2,}", " ", text)


def _plausible(name: str) -> bool:
    letters = sum(ch.isalpha() for ch in name)
    return letters >= 2 and not set(name.split()) <= _NOT_NAMES


def _same_line_after(label: dict, items: list[dict]) -> dict | None:
    """The nearest box to the right of `label` on the same (possibly slanted) line."""
    best = None
    for b in items:
        if b is label:
            continue
        dx, dy = b["cx"] - label["cx"], b["cy"] - label["cy"]
        along = dx * label["ux"] + dy * label["uy"]
        across = abs(-dx * label["uy"] + dy * label["ux"])
        h = max(label["height"], b["height"])
        gap = along - (label["width"] + b["width"]) / 2
        if along > 0 and across < 0.6 * h and gap < 3 * h and (best is None or along < best[0]):
            best = (along, b)
    return best[1] if best else None


def _fields(items: list[dict]) -> dict[str, tuple[str, float]]:
    """{'1': (surname, score), '2': (given names, score)} from labelled boxes."""
    found: dict[str, tuple[str, float]] = {}
    for it in items:
        m = _FIELD.match(it["text"])
        if not m:
            continue
        key, rest = m.group(1), m.group(2)
        # Digits after the label: a date or number ("12.03.2020"), not a name field.
        if re.search(r"\d", rest):
            continue
        score = it["score"]
        value = _clean_name(rest)
        if not _plausible(value):
            # Label alone in its box ("1."): the name is the next box on the line.
            nxt = _same_line_after(it, items)
            if not nxt or re.search(r"\d", nxt["text"]):
                continue
            value, score = _clean_name(nxt["text"]), min(score, nxt["score"])
            if not _plausible(value):
                continue
        prev = found.get(key)
        if prev is None or score > prev[1]:
            found[key] = (value, score)
    return found


def _nice(name: str) -> str:
    """'OLA-KRISTIAN NORDMANN' -> 'Ola-Kristian Nordmann'."""
    return re.sub(r"[A-ZÆØÅÄÖÜÉÈÁÀÓÍÚÑ']+", lambda m: m.group(0).capitalize(), name)


def read_license_name(data: bytes) -> dict:
    """{'name', 'surname', 'given_names', 'confidence': 'high'|'low'|None, 'text'}"""
    image = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    if max(image.size) > 2400:
        image.thumbnail((2400, 2400))

    seen: list[str] = []
    best: dict[str, tuple[str, float]] = {}
    # Phones often take the card sideways: try upright first, then turned.
    for angle in (0, 90, 270, 180):
        items = scene_text(image if angle == 0 else image.rotate(angle, expand=True), log_text=False)
        seen += [f"[{angle}°] {i['text']} ({i['score']:.2f})" for i in items]
        fields = _fields(items)
        if len(fields) > len(best):
            best = fields
        if "1" in best and "2" in best:
            break

    surname = best.get("1", ("", 0.0))
    given = best.get("2", ("", 0.0))
    if not surname[0] and not given[0]:
        return {"name": None, "surname": None, "given_names": None, "confidence": None, "text": seen}
    name = " ".join(p for p in (_nice(given[0]), _nice(surname[0])) if p)
    both = surname[0] and given[0]
    confidence = "high" if both and min(surname[1], given[1]) >= 0.85 else "low"
    log.info("licence name read (%s confidence)", confidence)  # never the name itself
    return {"name": name, "surname": _nice(surname[0]) or None, "given_names": _nice(given[0]) or None,
            "confidence": confidence, "text": seen}
