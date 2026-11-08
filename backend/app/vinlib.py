"""VIN validation and image recognition (all local, no external lookups).

Vehicle data for registered cars comes from Statens vegvesen, see vegvesen.py.

Recognition strategy (best first):
  1. 1D/2D barcodes (Code 39/128, QR via zbar; DataMatrix via libdmtx). Door
     jamb / B-pillar labels usually carry one of these, and barcodes are exact.
  2. OCR with Tesseract. Photos are first straightened (the text angle is
     found from a projection profile), the text band is cut out and scaled,
     and a few contrast variants are tried — phone photos are rarely level.
The same OCR text is also searched for Norwegian registration plates
(two letters + 4–5 digits), which the UI then looks up in Statens vegvesen.
Every candidate is returned with a confidence; the user always confirms.
"""

from __future__ import annotations

import io
import logging
import re
import threading

from PIL import Image, ImageFilter, ImageOps

log = logging.getLogger("carbonara.vin")

VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")

_TRANSLIT = {
    **{str(d): d for d in range(10)},
    "A": 1, "B": 2, "C": 3, "D": 4, "E": 5, "F": 6, "G": 7, "H": 8,
    "J": 1, "K": 2, "L": 3, "M": 4, "N": 5, "P": 7, "R": 9,
    "S": 2, "T": 3, "U": 4, "V": 5, "W": 6, "X": 7, "Y": 8, "Z": 9,
}
_WEIGHTS = (8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2)

# Characters that never appear in a VIN, mapped to what OCR most likely misread.
_OCR_FIXES = str.maketrans({"O": "0", "Q": "0", "I": "1"})


def normalize(value: str | None) -> str:
    return re.sub(r"[\s\-.]", "", value or "").upper()


def is_valid_format(vin: str) -> bool:
    return bool(VIN_RE.match(vin))


def check_digit(vin: str) -> str:
    total = sum(_TRANSLIT[c] * w for c, w in zip(vin, _WEIGHTS))
    r = total % 11
    return "X" if r == 10 else str(r)


def check_digit_ok(vin: str) -> bool:
    """Position 9 check digit. Mandatory in North America; many European
    manufacturers don't use it, so a mismatch is a warning, not an error."""
    return is_valid_format(vin) and vin[8] == check_digit(vin)


def describe(vin: str) -> dict:
    valid = is_valid_format(vin)
    return {
        "vin": vin,
        "valid_format": valid,
        "check_digit_ok": check_digit_ok(vin) if valid else None,
    }


# --------------------------------------------------------------------------- #
# Recognition
# --------------------------------------------------------------------------- #

def _candidates_in_text(text: str, fix_ocr: bool) -> list[tuple[str, bool]]:
    """Return (vin, exact_line) pairs found in free text."""
    out: list[tuple[str, bool]] = []
    for line in text.splitlines():
        letters = [c for c in line if c.isalpha()]
        # VINs are printed in capitals; mostly-lowercase text is words, not a VIN.
        if fix_ocr and letters and sum(c.islower() for c in letters) > 0.3 * len(letters):
            continue
        raw = re.sub(r"[^A-Z0-9]", "", line.upper())
        if len(raw) == 18 and raw[0] == "I":  # Code 39 "import" prefix
            raw = raw[1:]
        compact = raw.translate(_OCR_FIXES) if fix_ocr else raw
        if len(compact) < 17:
            continue
        exact = len(compact) == 17
        for i in range(len(compact) - 16):
            window = compact[i : i + 17]
            # A real VIN never contains I, O or Q. If OCR needed more than two
            # such fixes it was probably reading words ("SUBARU CORPORATION"),
            # unless the check digit confirms it (label fonts make 0 look like O).
            if fix_ocr and sum(c in "IOQ" for c in raw[i : i + 17]) > 2 and not check_digit_ok(window):
                continue
            if VIN_RE.match(window):
                out.append((window, exact))
    return out


def _barcodes(img: Image.Image) -> list[str]:
    texts: list[str] = []
    try:
        from pyzbar.pyzbar import decode as zbar_decode

        texts += [r.data.decode("ascii", "ignore") for r in zbar_decode(img)]
    except Exception as exc:  # library missing or decode failure
        log.debug("zbar unavailable/failed: %s", exc)
    if not texts:
        try:
            from pylibdmtx.pylibdmtx import decode as dmtx_decode

            small = img.copy()
            small.thumbnail((1200, 1200))
            texts += [r.data.decode("ascii", "ignore") for r in dmtx_decode(small, timeout=2000, max_count=3)]
        except Exception as exc:
            log.debug("libdmtx unavailable/failed: %s", exc)
    return texts


# ---- straightening ---------------------------------------------------------

def _profile_score(edges: Image.Image, angle: float) -> float:
    """How 'line-like' the edge image is after rotating by `angle`: text lines
    and label borders give sharp peaks in the row sums when they are level."""
    import numpy as np

    rotated = edges.rotate(angle, resample=Image.BILINEAR, expand=True)
    rows = np.asarray(rotated, dtype=np.float32).sum(axis=1)
    return float(np.square(np.diff(rows)).sum())


def text_angle(gray: Image.Image) -> float:
    """Angle (degrees, PIL convention) that makes the text horizontal.
    Polarity-independent (works on edges), coarse search then refine."""
    small = gray.copy()
    small.thumbnail((700, 700))
    edges = ImageOps.autocontrast(small, cutoff=1).filter(ImageFilter.FIND_EDGES)
    edges = edges.point(lambda p: 255 if p > 60 else 0)  # drop sensor noise / dust
    best = max(range(-80, 81, 4), key=lambda a: _profile_score(edges, a))
    fine = [best + d / 2 for d in range(-8, 9)]
    return max(fine, key=lambda a: _profile_score(edges, a))


def _text_bands(img: Image.Image, max_bands: int = 2) -> list[Image.Image]:
    """Cut out the horizontal bands holding the most text (after straightening)."""
    import numpy as np

    small = img.copy()
    scale = 700 / max(img.size)
    if scale < 1:
        small = small.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))))
    else:
        scale = 1.0
    edges = np.asarray(ImageOps.autocontrast(small, cutoff=1).filter(ImageFilter.FIND_EDGES), dtype=np.float32)
    rows = np.convolve((edges > 60).sum(axis=1).astype(np.float32), np.ones(5) / 5, mode="same")
    if rows.max() <= 0:
        return []
    bands, taken = [], np.zeros_like(rows, dtype=bool)
    for _ in range(max_bands):
        masked = np.where(taken, 0, rows)
        peak = int(masked.argmax())
        if masked[peak] < rows.max() * 0.25:
            break
        lo = hi = peak
        thresh = masked[peak] * 0.3
        while lo > 0 and rows[lo - 1] > thresh and not taken[lo - 1]:
            lo -= 1
        while hi < len(rows) - 1 and rows[hi + 1] > thresh and not taken[hi + 1]:
            hi += 1
        taken[lo:hi + 1] = True
        pad = max(4, int((hi - lo) * 0.35))
        top, bottom = max(0, int((lo - pad) / scale)), min(img.height, int((hi + pad) / scale) + 1)
        if bottom - top < 8:
            continue
        band = img.crop((0, top, img.width, bottom))
        # Tesseract reads best at ~30–60 px text height.
        factor = max(0.4, min(3.0, 110 / band.height))
        bands.append(band.resize((max(1, int(band.width * factor)), max(1, int(band.height * factor))), Image.LANCZOS))
    return bands


def _ocr_variants(img: Image.Image):
    contrast = ImageOps.autocontrast(img, cutoff=2)
    yield contrast
    yield ImageOps.invert(contrast)  # light text on dark (stamped/engraved/printed labels)
    yield contrast.point(lambda p: 255 if p > 128 else 0)


def _ocr(img: Image.Image) -> list[str]:
    """OCR on straightened text bands first, then the whole straightened image.
    Stops as soon as a check-digit-valid VIN turns up."""
    try:
        import pytesseract
    except ImportError:
        log.warning("pytesseract not installed; OCR disabled")
        return []
    whitelist = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    try:
        angle = text_angle(img)
    except Exception as exc:  # numpy missing etc. — fall back to the image as-is
        log.warning("deskew failed: %s", exc)
        angle = 0.0
    level = img.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=int(_median(img)))
    log.info("OCR: text angle %.1f°", angle)

    jobs = []
    try:
        for band in _text_bands(level):
            jobs += [(v, 7) for v in _ocr_variants(band)]  # psm 7: one text line
            jobs += [(v, 6) for v in list(_ocr_variants(band))[:2]]
    except Exception as exc:
        log.warning("band detection failed: %s", exc)
    whole = level.copy()
    whole.thumbnail((1800, 1800))
    jobs += [(v, 11) for v in list(_ocr_variants(whole))[:2]]  # psm 11: sparse text anywhere

    texts = []
    for variant, psm in jobs:
        try:
            text = pytesseract.image_to_string(
                variant, config=f"--psm {psm} -c tessedit_char_whitelist={whitelist}", timeout=8
            )
        except Exception as exc:
            log.warning("tesseract failed: %s", exc)
            break
        texts.append(text)
        # Stop early on a check-digit-valid VIN or a line that is exactly a plate.
        if any(check_digit_ok(v) for v, _ in _candidates_in_text(text, True)) \
                or any(exact for _, exact in _plates_in_text(text, set())):
            break
    return texts


def _median(img: Image.Image) -> float:
    hist = img.histogram()
    half, acc = sum(hist) / 2, 0
    for value, count in enumerate(hist):
        acc += count
        if acc >= half:
            return value
    return 128


# ---- Norwegian registration plates ------------------------------------------

# Standard plates: two letters + 4 or 5 digits ("EJ 18664", "AB 1234").
PLATE_RE = re.compile(r"[A-Z]{2}[0-9OQDILZSBGAT]{4,6}")
_PLATE_DIGIT_FIXES = str.maketrans({"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1",
                                    "Z": "2", "S": "5", "B": "8", "G": "6", "A": "4", "T": "7"})


def _plates_in_text(text: str, vins: set[str]) -> list[tuple[str, bool]]:
    """(plate, exact_line) pairs, formatted 'EJ 18664'. Text that is part of a
    VIN on the same line is ignored (VINs contain plate-like runs)."""
    out = []
    for line in text.splitlines():
        if any(c.islower() for c in line):  # plates are all capitals ("Tf90177632" is a phone no.)
            continue
        compact = re.sub(r"[^A-Z0-9]", "", line.upper())
        if not 6 <= len(compact) <= 16 or any(v in compact or compact in v for v in vins):
            continue
        for m in PLATE_RE.finditer(compact):
            letters, digits = m.group()[:2], m.group()[2:].translate(_PLATE_DIGIT_FIXES)
            if not digits.isdigit():
                continue
            if len(digits) == 6:
                # Plates have at most 5 digits; a leading "1" is usually a sticker or
                # separator between letters and digits read as a 1 ("KT 1 77829").
                if digits[0] != "1":
                    continue
                digits = digits[1:]
            out.append((f"{letters} {digits}", len(compact) == len(m.group())))
    return out


# ---- scene-text OCR (RapidOCR / PaddleOCR models) ----------------------------
#
# Tesseract is built for flat documents; phone photos of labels behind dusty
# glass and plates at an angle are "scene text". RapidOCR first detects text
# boxes at any angle, straightens each one and reads it with a neural network.

_engines: dict[bool, object] = {}
_engine_lock = threading.RLock()  # re-entrant: the hi-res fallback may build the default engine


def _rapid(hires: bool = False):
    """Default engine (detection on a ~736 px version of the photo, fast) or a
    high-resolution one for small, crowded text such as door-frame labels."""
    if hires not in _engines:
        with _engine_lock:
            if hires not in _engines:
                from rapidocr_onnxruntime import RapidOCR

                if hires:
                    try:
                        _engines[True] = RapidOCR(det_limit_side_len=1920, det_limit_type="max")
                    except Exception as exc:  # older/newer option names: use the default
                        log.warning("hi-res OCR options not accepted (%s); using defaults", exc)
                        _engines[True] = _rapid(False)
                else:
                    _engines[False] = RapidOCR()
    return _engines[hires]


def scene_text(rgb: Image.Image, hires: bool = False) -> list[dict]:
    """Every text box in the photo: [{text, score, height, width, cx, cy, ux, uy}]."""
    import numpy as np

    arr = np.ascontiguousarray(np.asarray(rgb.convert("RGB"))[:, :, ::-1])  # RGB -> BGR
    result, _ = _rapid(hires)(arr)
    items = []
    for box, text, score in result or []:
        pts = np.asarray(box, dtype=float)  # TL, TR, BR, BL
        height = (np.linalg.norm(pts[0] - pts[3]) + np.linalg.norm(pts[1] - pts[2])) / 2
        width = (np.linalg.norm(pts[1] - pts[0]) + np.linalg.norm(pts[2] - pts[3])) / 2
        direction = (pts[1] - pts[0]) + (pts[2] - pts[3])  # reading direction (may be slanted)
        norm = np.linalg.norm(direction) or 1.0
        cx, cy = pts.mean(axis=0)
        items.append({"text": str(text), "score": float(score), "height": float(height),
                      "width": float(width), "cx": float(cx), "cy": float(cy),
                      "ux": float(direction[0] / norm), "uy": float(direction[1] / norm)})
    log.info("scene text: %s", [(i["text"], round(i["score"], 2)) for i in items])
    return items


def _continues(a: dict, b: dict) -> bool:
    """True if box b continues box a on the same (possibly slanted) text line."""
    dx, dy = b["cx"] - a["cx"], b["cy"] - a["cy"]
    along = dx * a["ux"] + dy * a["uy"]           # distance along a's reading direction
    across = abs(-dx * a["uy"] + dy * a["ux"])    # distance off that line
    h = max(a["height"], b["height"])
    gap = along - (a["width"] + b["width"]) / 2
    return (along > 0 and across < 0.5 * h and gap < 2.5 * h
            and 0.6 < b["height"] / max(a["height"], 1) < 1.6)


def joined_lines(items: list[dict]) -> list[dict]:
    """Pseudo-boxes for text split over 2–3 boxes on one line ("DR" + "18564",
    "JF1AABAA1PA" + "000958"), with the weakest score of the parts."""
    out = []
    for a in items:
        for b in items:
            if b is a or not _continues(a, b):
                continue
            ab = {**a, "text": f"{a['text']} {b['text']}", "score": min(a["score"], b["score"])}
            out.append(ab)
            for c in items:
                if c is not a and c is not b and _continues(b, c):
                    out.append({**ab, "text": f"{ab['text']} {c['text']}", "score": min(ab["score"], c["score"])})
    return out


# Words that are big, uppercase and short but never a plate (labels, dealer frames).
_NOT_PLATES = {"MODEL", "SUBARU", "TOYOTA", "AUDI", "SKODA", "VOLVO", "TESLA", "NISSAN", "MAZDA",
               "KIA", "BMW", "FORD", "OPEL", "MG", "VW", "TDI", "AS", "N", "NOR", "NORGE", "KG"}


def _plates_from_items(items: list[dict], vins: set[str]) -> dict[str, dict]:
    plates: dict[str, dict] = {}

    def add(plate, confidence, height, custom=False):
        # _h (text height in px) ranks plates: the car being photographed is the
        # biggest plate, not one on a car in the background.
        rank = {"medium": 2, "low": 1}
        prev = plates.get(plate)
        if prev is None or rank[confidence] > rank[prev["confidence"]]:
            plates[plate] = {"plate": plate, "confidence": confidence, "custom": custom, "_h": height}

    # 1. Standard plates within one text box ("DR 18564"), or 2. split over
    #    boxes on the same (possibly slanted) line ("EJ" + "18664").
    for it in items + joined_lines(items):
        for plate, exact in _plates_in_text(it["text"], vins):
            add(plate, "medium" if exact and it["score"] > 0.8 else "low", it["height"])

    # 3. Personalised plates ("ALPAKKA"): the biggest short all-caps word, offered
    #    for the user to confirm — Statens vegvesen decides if it exists.
    if not any(p["confidence"] == "medium" for p in plates.values()) and not vins and items:
        tallest = max(i["height"] for i in items)
        for it in sorted(items, key=lambda i: -i["height"]):
            raw = it["text"].strip()
            word = re.sub(r"[\s\-]", "", raw)
            if (it["height"] >= 0.6 * tallest and it["score"] > 0.85 and 2 <= len(word) <= 7
                    and re.fullmatch(r"[A-Z0-9ÆØÅ]+", word) and re.search(r"[A-ZÆØÅ]", word)
                    and word not in _NOT_PLATES and not any(word in v for v in vins)):
                add(word, "low", it["height"], custom=True)
    return plates


def recognize(data: bytes, limit: int = 5) -> list[dict]:
    """VIN candidates only (kept for callers that just want VINs)."""
    return recognize_all(data, limit)["candidates"]


def recognize_all(data: bytes, limit: int = 5) -> dict:
    """{'candidates': [VIN candidates], 'plates': [registration plate candidates]}"""
    original = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    if max(original.size) > 2400:
        original.thumbnail((2400, 2400))
    img = original.convert("L")

    found: dict[str, dict] = {}
    plates: dict[str, dict] = {}
    seen_text: list[str] = []  # what the OCR read, returned for troubleshooting

    def add(vin: str, source: str, exact: bool) -> None:
        ok = check_digit_ok(vin)
        if source == "barcode" or ok:
            confidence = "high"
        elif exact:
            confidence = "medium"
        else:
            confidence = "low"
        score = {"high": 3, "medium": 2, "low": 1}[confidence]
        prev = found.get(vin)
        if prev is None or score > prev["_score"]:
            found[vin] = {
                "vin": vin, "source": source, "confidence": confidence,
                "check_digit_ok": ok, "_score": score,
            }

    for text in _barcodes(img):
        for vin, exact in _candidates_in_text(text, fix_ocr=False):
            add(vin, "barcode", exact)

    def confident() -> bool:
        return (any(c["confidence"] in ("high", "medium") for c in found.values())
                or any(p["confidence"] == "medium" for p in plates.values()))

    if not found:
        # Pass 1: normal resolution (fast, ~1 s). If that finds no VIN or clear
        # plate: pass 2 at full resolution (small text on crowded door-frame
        # labels), then passes 3–4 with the photo turned ±35° (very steep plates).
        passes = [("normal", False, 0), ("hi-res", True, 0), ("turned +35°", True, 35), ("turned -35°", True, -35)]
        ocr_ok = True
        for name, hires, angle in passes:
            image = original if not angle else original.rotate(angle, resample=Image.BICUBIC, expand=True)
            try:
                items = scene_text(image, hires=hires)
            except Exception as exc:  # engine missing/broken: fall back to Tesseract
                log.warning("RapidOCR unavailable, falling back to Tesseract: %s", exc)
                ocr_ok = False
                break
            seen_text += [f"[{name}] {it['text']} ({it['score']:.2f})" for it in items]
            for it in items + joined_lines(items):  # joined: VINs split over two boxes
                for vin, exact in _candidates_in_text(it["text"], fix_ocr=True):
                    add(vin, "ocr", exact)
            for plate, p in _plates_from_items(items, set(found)).items():
                prev = plates.get(plate)
                if prev is None or (p["confidence"] == "medium" and prev["confidence"] != "medium"):
                    plates[plate] = p
            if confident():
                break

        if not ocr_ok:
            texts = _ocr(img)
            for text in texts:
                for vin, exact in _candidates_in_text(text, fix_ocr=True):
                    add(vin, "ocr", exact)
            for text in texts:
                for plate, exact in _plates_in_text(text, set(found)):
                    prev = plates.get(plate)
                    if prev is None or (exact and prev["confidence"] != "medium"):
                        plates[plate] = {"plate": plate, "confidence": "medium" if exact else "low",
                                         "custom": False, "_h": 0}

    ranked = sorted(found.values(), key=lambda c: -c["_score"])[:limit]
    for c in ranked:
        c.pop("_score")
    # Clear plates first; among those, the biggest (closest car) first.
    plate_list = sorted(plates.values(), key=lambda p: (p["confidence"] != "medium", -p.get("_h", 0)))[:limit]
    for p in plate_list:
        p.pop("_h", None)
    return {"candidates": ranked, "plates": plate_list, "text": seen_text[:80]}
