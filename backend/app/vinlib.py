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
    for line in text.upper().splitlines():
        compact = re.sub(r"[^A-Z0-9]", "", line)
        if fix_ocr:
            compact = compact.translate(_OCR_FIXES)
        if len(compact) < 17:
            continue
        if len(compact) == 18 and compact[0] == "I":  # Code 39 "import" prefix
            compact = compact[1:]
        exact = len(compact) == 17
        for i in range(len(compact) - 16):
            window = compact[i : i + 17]
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
PLATE_RE = re.compile(r"[A-Z]{2}[0-9OQDILZSBG]{4,5}")
_PLATE_DIGIT_FIXES = str.maketrans({"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1",
                                    "Z": "2", "S": "5", "B": "8", "G": "6"})


def _plates_in_text(text: str, vins: set[str]) -> list[tuple[str, bool]]:
    """(plate, exact_line) pairs, formatted 'EJ 18664'. Text that is part of a
    VIN on the same line is ignored (VINs contain plate-like runs)."""
    out = []
    for line in text.upper().splitlines():
        compact = re.sub(r"[^A-Z0-9]", "", line)
        if not 6 <= len(compact) <= 16 or any(v in compact or compact in v for v in vins):
            continue
        for m in PLATE_RE.finditer(compact):
            letters, digits = m.group()[:2], m.group()[2:].translate(_PLATE_DIGIT_FIXES)
            if not digits.isdigit():
                continue
            out.append((f"{letters} {digits}", len(compact) == len(m.group())))
    return out


# ---- scene-text OCR (RapidOCR / PaddleOCR models) ----------------------------
#
# Tesseract is built for flat documents; phone photos of labels behind dusty
# glass and plates at an angle are "scene text". RapidOCR first detects text
# boxes at any angle, straightens each one and reads it with a neural network.

_engine = None
_engine_lock = threading.Lock()


def _rapid():
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                from rapidocr_onnxruntime import RapidOCR

                _engine = RapidOCR()
    return _engine


def scene_text(rgb: Image.Image) -> list[dict]:
    """Every text box in the photo: [{text, score, height, cx, cy}], height in px."""
    import numpy as np

    arr = np.ascontiguousarray(np.asarray(rgb.convert("RGB"))[:, :, ::-1])  # RGB -> BGR
    result, _ = _rapid()(arr)
    items = []
    for box, text, score in result or []:
        pts = np.asarray(box, dtype=float)  # TL, TR, BR, BL
        height = (np.linalg.norm(pts[0] - pts[3]) + np.linalg.norm(pts[1] - pts[2])) / 2
        cx, cy = pts.mean(axis=0)
        items.append({"text": str(text), "score": float(score), "height": float(height),
                      "cx": float(cx), "cy": float(cy)})
    log.info("scene text: %s", [(i["text"], round(i["score"], 2)) for i in items])
    return items


# Words that are big, uppercase and short but never a plate (labels, dealer frames).
_NOT_PLATES = {"MODEL", "SUBARU", "TOYOTA", "AUDI", "SKODA", "VOLVO", "TESLA", "NISSAN", "MAZDA",
               "KIA", "BMW", "FORD", "OPEL", "MG", "VW", "TDI", "AS", "N", "NOR", "NORGE", "KG"}


def _plates_from_items(items: list[dict], vins: set[str]) -> dict[str, dict]:
    plates: dict[str, dict] = {}

    def add(plate, confidence, custom=False):
        rank = {"medium": 2, "low": 1}
        if plate not in plates or rank[confidence] > rank[plates[plate]["confidence"]]:
            plates[plate] = {"plate": plate, "confidence": confidence, "custom": custom}

    # 1. Standard plates within one text box ("DR 18564").
    for it in items:
        for plate, exact in _plates_in_text(it["text"], vins):
            add(plate, "medium" if exact and it["score"] > 0.8 else "low")

    # 2. Plates split over two boxes ("DR" + "18564") on the same line.
    for a in items:
        la = re.sub(r"[^A-Z]", "", a["text"].upper())
        if len(la) != 2:
            continue
        for b in items:
            db = re.sub(r"[^A-Z0-9]", "", b["text"].upper()).translate(_PLATE_DIGIT_FIXES)
            if b is a or not (4 <= len(db) <= 5 and db.isdigit()):
                continue
            same_line = abs(a["cy"] - b["cy"]) < 0.6 * max(a["height"], b["height"])
            if same_line and b["cx"] > a["cx"] and abs(a["height"] - b["height"]) < 0.4 * a["height"]:
                add(f"{la} {db}", "medium" if min(a["score"], b["score"]) > 0.8 else "low")

    # 3. Personalised plates ("ALPAKKA"): the biggest short all-caps word, offered
    #    for the user to confirm — Statens vegvesen decides if it exists.
    if not plates and not vins and items:
        tallest = max(i["height"] for i in items)
        for it in sorted(items, key=lambda i: -i["height"]):
            raw = it["text"].strip()
            word = re.sub(r"[\s\-]", "", raw)
            if (it["height"] >= 0.6 * tallest and it["score"] > 0.85 and 2 <= len(word) <= 7
                    and re.fullmatch(r"[A-Z0-9ÆØÅ]+", word) and re.search(r"[A-ZÆØÅ]", word)
                    and word not in _NOT_PLATES and not any(word in v for v in vins)):
                add(word, "low", custom=True)
    return plates


def recognize(data: bytes, limit: int = 5) -> list[dict]:
    """VIN candidates only (kept for callers that just want VINs)."""
    return recognize_all(data, limit)["candidates"]


def recognize_all(data: bytes, limit: int = 5) -> dict:
    """{'candidates': [VIN candidates], 'plates': [registration plate candidates]}"""
    original = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
    if max(original.size) > 2400:
        original.thumbnail((2400, 2400))
    img = original.convert("L")

    found: dict[str, dict] = {}
    plates: dict[str, dict] = {}

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

    if not found:
        items = None
        try:
            items = scene_text(original)
        except Exception as exc:  # engine missing/broken: fall back to Tesseract
            log.warning("RapidOCR unavailable, falling back to Tesseract: %s", exc)

        if items is not None:
            for it in items:
                for vin, exact in _candidates_in_text(it["text"], fix_ocr=True):
                    add(vin, "ocr", exact)
            plates = _plates_from_items(items, set(found))
        else:
            texts = _ocr(img)
            for text in texts:
                for vin, exact in _candidates_in_text(text, fix_ocr=True):
                    add(vin, "ocr", exact)
            for text in texts:
                for plate, exact in _plates_in_text(text, set(found)):
                    prev = plates.get(plate)
                    if prev is None or (exact and prev["confidence"] != "medium"):
                        plates[plate] = {"plate": plate, "confidence": "medium" if exact else "low",
                                         "custom": False}

    ranked = sorted(found.values(), key=lambda c: -c["_score"])[:limit]
    for c in ranked:
        c.pop("_score")
    plate_list = sorted(plates.values(), key=lambda p: p["confidence"] != "medium")[:limit]
    return {"candidates": ranked, "plates": plate_list}
