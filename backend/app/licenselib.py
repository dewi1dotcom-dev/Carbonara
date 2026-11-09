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


def _otsu(arr) -> int:
    """Grey level that best separates dark text from the light card."""
    import numpy as np

    hist = np.bincount(arr.ravel(), minlength=256).astype(float)
    total, sum_all = arr.size, float(np.dot(np.arange(256), hist))
    wb = sb = best = 0.0
    thr = 128
    for t in range(256):
        wb += hist[t]
        if wb == 0:
            continue
        wf = total - wb
        if wf == 0:
            break
        sb += t * hist[t]
        var = wb * wf * (sb / wb - (sum_all - sb) / wf) ** 2
        if var > best:
            best, thr = var, t
    return thr


def _word_gaps(image: Image.Image, it: dict, n_chars: int) -> list[int]:
    """Positions (in the text without spaces) where the photo shows a word gap.

    The OCR model often drops spaces ("ANDERS STRANG" -> "ANDERSSTRANG").
    Straighten the text box, find the columns with ink (one run per letter)
    and treat gaps much wider than the normal letter spacing as spaces."""
    import math

    import numpy as np

    w, h = it["width"], it["height"]
    # Cut a square around the box first (cheap), then level it along the text.
    r = max(w, h) / 2 + 4
    left, top = int(it["cx"] - r), int(it["cy"] - r)
    square = image.crop((left, top, int(it["cx"] + r), int(it["cy"] + r)))
    cx, cy = it["cx"] - left, it["cy"] - top
    angle = math.degrees(math.atan2(it["uy"], it["ux"]))
    level = square.rotate(angle, resample=Image.BICUBIC, center=(cx, cy), fillcolor=(255, 255, 255))
    arr = np.asarray(level.crop((int(cx - w / 2), int(cy - h / 2), int(cx + w / 2), int(cy + h / 2))).convert("L"))
    if arr.shape[0] < 8 or arr.shape[1] < 16:
        return []
    arr = arr[int(arr.shape[0] * 0.1):int(arr.shape[0] * 0.9)]  # skip bits of the lines above/below
    ink = arr <= _otsu(arr)
    cols = ink.sum(axis=0) >= max(1, int(0.03 * arr.shape[0]))

    runs, start = [], None
    for x, on in enumerate(cols):
        if on and start is None:
            start = x
        elif not on and start is not None:
            runs.append((start, x))
            start = None
    if start is not None:
        runs.append((start, len(cols)))
    if len(runs) < 4:
        return []

    widths = sorted(e - s for s, e in runs)
    gaps = [runs[i + 1][0] - runs[i][1] for i in range(len(runs) - 1)]
    letter_w, letter_gap = widths[len(widths) // 2], sorted(gaps)[len(gaps) // 2]
    limit = max(0.45 * letter_w, 2.2 * letter_gap, 3)
    out = []
    for i, gap in enumerate(gaps):
        if gap >= limit:
            # Letters to the left of the gap; scaled if letters merged/split in the photo.
            pos = i + 1 if len(runs) == n_chars else round((i + 1) * n_chars / len(runs))
            if 0 < pos < n_chars:
                out.append(pos)
    return out


def _respace(image: Image.Image, it: dict) -> str:
    """The box's text with the spaces the OCR dropped put back."""
    text = it["text"].strip()
    compact = text.replace(" ", "")
    try:
        found = _word_gaps(image, it, len(compact))
    except Exception as exc:
        log.warning("word gap detection failed: %s", exc)
        return text
    # Keep the spaces the OCR did read, and add the ones seen in the photo.
    ocr_spaces, n = set(), 0
    for ch in text:
        if ch == " ":
            ocr_spaces.add(n)
        else:
            n += 1
    spaces = set(ocr_spaces)
    for pos in sorted(found):
        # Never cut off a single letter ("A NDERS"): that's a misplaced gap.
        before = max([p for p in spaces if p < pos] + [0])
        after = min([p for p in spaces if p > pos] + [len(compact)])
        if pos - before >= 2 and after - pos >= 2:
            spaces.add(pos)
    return "".join((" " if i in spaces else "") + ch for i, ch in enumerate(compact)).strip()


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


def _with_spaces(value: str, respaced: str) -> str:
    """Use the respaced reading only if it is the same letters, just split into words."""
    respaced = _clean_name(respaced)
    return respaced if respaced.replace(" ", "") == value.replace(" ", "") and _plausible(respaced) else value


def _fields(image: Image.Image, items: list[dict]) -> dict[str, tuple[str, float]]:
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
        if _plausible(value):
            # "2.ANDERSSTRANG": put back the spaces the OCR dropped, then drop the label again.
            m2 = _FIELD.match(_respace(image, it))
            if m2 and m2.group(1) == key:
                value = _with_spaces(value, m2.group(2))
        else:
            # Label alone in its box ("1."): the name is the next box on the line.
            nxt = _same_line_after(it, items)
            if not nxt or re.search(r"\d", nxt["text"]):
                continue
            value, score = _clean_name(nxt["text"]), min(score, nxt["score"])
            if not _plausible(value):
                continue
            value = _with_spaces(value, _respace(image, nxt))
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
        turned = image if angle == 0 else image.rotate(angle, expand=True)
        items = scene_text(turned, log_text=False)
        seen += [f"[{angle}°] {i['text']} ({i['score']:.2f})" for i in items]
        fields = _fields(turned, items)
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
