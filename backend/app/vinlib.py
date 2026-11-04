"""VIN validation and image recognition (all local, no external lookups).

Vehicle data for registered cars comes from Statens vegvesen, see vegvesen.py.

Recognition strategy (best first):
  1. 1D/2D barcodes (Code 39/128, QR via zbar; DataMatrix via libdmtx). Door
     jamb / B-pillar labels usually carry one of these, and barcodes are exact.
  2. OCR with Tesseract on a few pre-processed variants of the image
     (windscreen plate, stamped chassis number, registration document).
Every candidate is returned with a confidence; the user always confirms.
"""

from __future__ import annotations

import io
import logging
import re

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


def _ocr_variants(img: Image.Image):
    yield img
    contrast = ImageOps.autocontrast(img, cutoff=2)
    yield contrast.filter(ImageFilter.SHARPEN)
    yield contrast.point(lambda p: 255 if p > 128 else 0)
    yield ImageOps.invert(contrast)  # light text on dark (stamped/engraved)


def _ocr(img: Image.Image) -> list[str]:
    try:
        import pytesseract
    except ImportError:
        log.warning("pytesseract not installed; OCR disabled")
        return []
    whitelist = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789OQI"
    texts = []
    for variant in _ocr_variants(img):
        for psm in (6, 11):
            try:
                text = pytesseract.image_to_string(
                    variant, config=f"--psm {psm} -c tessedit_char_whitelist={whitelist}", timeout=8
                )
            except Exception as exc:
                log.warning("tesseract failed: %s", exc)
                return texts
            texts.append(text)
            # Stop early once we have a check-digit-valid VIN.
            if any(check_digit_ok(v) for v, _ in _candidates_in_text(text, True)):
                return texts
    return texts


def recognize(data: bytes, limit: int = 5) -> list[dict]:
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("L")
    if max(img.size) > 2400:
        img.thumbnail((2400, 2400))

    found: dict[str, dict] = {}

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
        for text in _ocr(img):
            for vin, exact in _candidates_in_text(text, fix_ocr=True):
                add(vin, "ocr", exact)

    ranked = sorted(found.values(), key=lambda c: -c["_score"])[:limit]
    for c in ranked:
        c.pop("_score")
    return ranked
