"""PDI sheets: fill in a car model's own PDI form (a PDF) when the PDI is done.

An admin uploads the model's PDF once and taps where each field goes
(Settings → PDI sheets); OCR on the rendered page suggests positions next to
labels like "VIN" or "Dato". Filling draws the values, the company stamp and
the user's signature on top of the original PDF (reportlab overlay merged with
pypdf), so the form itself is never changed.

Files (all under PHOTO_DIR, with photostore's {file_key, original_ext} pattern):
    pdi/templates/<uuid>.pdf         the uploaded form
    pdi/templates/<uuid>_p<n>.png    rendered page n (cache, for placing fields)
    pdi/stamps/<uuid>.png            company stamps
    pdi/signatures/<uuid>.png        users' signatures
    pdi/sheets/<yyyy>/<mm>/<uuid>.pdf  filled-in sheets
"""

from __future__ import annotations

import datetime as dt
import io
import logging
import re
import threading
import uuid
from pathlib import Path

from PIL import Image, ImageOps

from . import photostore
from .config import settings

log = logging.getLogger("carbonara.pdisheet")

TEXT_FIELDS = ("reg", "vin", "km", "date", "signer", "work_order")
IMAGE_FIELDS = ("stamp", "signature")
FIELDS = TEXT_FIELDS + IMAGE_FIELDS
MAX_PAGES = 20
RENDER_WIDTH = 1400  # px; pictures of the pages for placing fields and for OCR

_pdfium_lock = threading.Lock()  # pdfium is not thread-safe


class SheetError(ValueError):
    pass


def new_key(folder: str) -> str:
    return f"pdi/{folder}/{uuid.uuid4().hex}"


def path(key: str, ext: str) -> Path:
    return photostore.path_for({"file_key": key, "original_ext": ext}, "original")


def remove(key: str | None, ext: str) -> None:
    """Delete a stored file (and a template's page pictures). Call after commit."""
    if not key:
        return
    p = path(key, ext)
    try:
        p.unlink(missing_ok=True)
        if ext == "pdf":
            for png in p.parent.glob(f"{p.stem}_p*.png"):
                png.unlink(missing_ok=True)
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# pictures: stamps and signatures
# --------------------------------------------------------------------------- #

def clean_image(data: bytes, max_side: int = 1200) -> bytes:
    """A stamp or signature as a PNG: white / near-white made transparent (so the
    form's lines show through), empty margins cropped, at most max_side px."""
    import numpy as np

    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:
        raise SheetError("The file is not a readable picture") from exc
    img = ImageOps.exif_transpose(img).convert("RGBA")
    img.thumbnail((max_side, max_side))
    px = np.array(img)
    light = (px[:, :, 0] > 225) & (px[:, :, 1] > 225) & (px[:, :, 2] > 225)
    px[light, 3] = 0
    img = Image.fromarray(px, "RGBA")
    box = img.getbbox()  # ignores fully transparent pixels
    if not box:
        raise SheetError("The picture is empty")
    out = io.BytesIO()
    img.crop(box).save(out, "PNG", optimize=True)
    return out.getvalue()


def store_image(data: bytes, folder: str) -> str:
    key = new_key(folder)
    p = path(key, "png")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(clean_image(data))
    return key


# --------------------------------------------------------------------------- #
# templates (the models' PDF forms)
# --------------------------------------------------------------------------- #

def store_template(data: bytes) -> tuple[str, list[dict]]:
    """Check and store an uploaded PDF form. Returns (file_key, page sizes)."""
    from pypdf import PdfReader

    if not data.startswith(b"%PDF"):
        raise SheetError("The file is not a PDF")
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise SheetError("The PDF is password protected; use a copy without a password")
        pages = []
        for page in reader.pages:
            w, h = float(page.cropbox.width), float(page.cropbox.height)
            if page.rotation % 180:  # shown turned a quarter: width and height swap
                w, h = h, w
            pages.append({"w": round(w, 2), "h": round(h, 2)})
    except SheetError:
        raise
    except Exception as exc:
        raise SheetError("The PDF could not be read") from exc
    if not pages:
        raise SheetError("The PDF has no pages")
    if len(pages) > MAX_PAGES:
        raise SheetError(f"The PDF has more than {MAX_PAGES} pages")
    key = new_key("templates")
    p = path(key, "pdf")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return key, pages


def page_image(key: str, page_no: int) -> Path:
    """A picture of the form's page (1-based), rendered once and cached."""
    out = path(key, "pdf").with_name(f"{Path(key).name}_p{page_no}.png")
    if not out.is_file():
        import pypdfium2 as pdfium

        with _pdfium_lock:
            pdf = pdfium.PdfDocument(str(path(key, "pdf")))
            try:
                if not 1 <= page_no <= len(pdf):
                    raise SheetError("No such page")
                page = pdf[page_no - 1]
                img = page.render(scale=RENDER_WIDTH / page.get_width()).to_pil()
            finally:
                pdf.close()
        img.convert("RGB").save(out, "PNG", optimize=True)
    return out


# Labels on PDI forms (Norwegian and English), per field. Matched as whole words.
LABELS = {
    "reg": ("reg.nr", "reg. nr", "regnr", "reg nr", "reg.no", "reg no", "kjennemerke", "registration", "license plate",
            "licence plate", "registreringsnummer"),
    "vin": ("vin", "understellsnr", "understellsnummer", "chassisnr", "chassis", "vin-nr", "vin nr"),
    "km": ("km", "km-stand", "kmstand", "kilometerstand", "kilometer", "mileage", "odometer"),
    "date": ("dato", "date"),
    "work_order": ("arbeidsordre", "arbeidsordrenr", "arbeidsordre nr", "ordrenr", "ordre nr", "ordrenummer", "a.o.",
                   "ao nr", "work order", "work order no", "wo", "wo no", "r.o.", "repair order"),
    "signer": ("navn", "name"),
    "signature": ("signatur", "signature", "underskrift", "sign"),
    "stamp": ("stempel", "stamp", "firmastempel"),
}
DEFAULT_SIZE = {"stamp": 0.2, "signature": 0.22}


def _has_label(text: str, label: str) -> bool:
    return re.search(rf"(^|[^a-z0-9æøå]){re.escape(label)}([^a-z0-9æøå]|$)", text) is not None


def suggest(key: str, pages: list[dict]) -> dict:
    """Positions suggested from labels found by OCR, as {key: {page, x, y, size | w}}.
    The shortest text with the label wins (a bare "VIN:" over a sentence that mentions it)."""
    from .vinlib import scene_text

    found: dict[str, tuple[int, dict]] = {}
    for page_no in range(1, min(len(pages), 6) + 1):
        img = Image.open(page_image(key, page_no))
        W, H = img.size
        for item in scene_text(img, log_text=False):
            text = item["text"].lower().strip()
            if len(text) > 60:
                continue
            for field, labels in LABELS.items():
                if not any(_has_label(text, lb) for lb in labels):
                    continue
                right = (item["cx"] + item["width"] / 2) / W  # the label's right edge
                if field in IMAGE_FIELDS:
                    w = DEFAULT_SIZE[field]
                    pos = {"page": page_no, "x": min(right + w / 2 + 0.01, 1 - w / 2), "y": item["cy"] / H, "w": w}
                else:
                    pos = {"page": page_no, "x": min(right + 0.01, 0.95), "y": item["cy"] / H,
                           "size": max(7, min(14, round(item["height"] / W * pages[page_no - 1]["w"] * 0.8)))}
                if field not in found or len(text) < found[field][0]:
                    found[field] = (len(text), {k: round(v, 4) if isinstance(v, float) else v for k, v in pos.items()})
    return {f: pos for f, (_, pos) in found.items()}


def clean_fields(fields: dict, pages: list[dict]) -> dict:
    """Validate positions sent from the field placing screen."""
    out = {}
    for key, f in (fields or {}).items():
        if key not in FIELDS or not isinstance(f, dict):
            raise SheetError(f"Unknown field: {key}")
        try:
            page = int(f["page"])
            x, y = float(f["x"]), float(f["y"])
        except (KeyError, TypeError, ValueError) as exc:
            raise SheetError(f"Field {key}: page, x and y are needed") from exc
        if not 1 <= page <= len(pages) or not (0 <= x <= 1 and 0 <= y <= 1):
            raise SheetError(f"Field {key} is outside the page")
        item = {"page": page, "x": round(x, 4), "y": round(y, 4)}
        if key in IMAGE_FIELDS:
            item["w"] = round(min(max(float(f.get("w") or DEFAULT_SIZE[key]), 0.03), 0.6), 4)
        else:
            item["size"] = round(min(max(float(f.get("size") or 10), 6), 24), 1)
        out[key] = item
    return out


def match_template(templates: list[dict], make: str | None, model: str | None) -> dict | None:
    """The template whose model name best matches the car (the longest name found
    in make + model, ignoring case, spaces and punctuation)."""
    norm = lambda s: re.sub(r"[^a-z0-9æøå]", "", (s or "").lower())  # noqa: E731
    car = norm(f"{make or ''} {model or ''}")
    best, best_len = None, 0
    for t in templates:
        for name in (t["models"] or "").split(","):
            n = norm(name)
            if n and n in car and len(n) > best_len:
                best, best_len = t, len(n)
    return best


# --------------------------------------------------------------------------- #
# filling in
# --------------------------------------------------------------------------- #

def fmt_reg(reg: str | None) -> str:
    """'EB82655' -> 'EB 82655' (standard plates); personalised plates as they are."""
    if not reg:
        return ""
    m = re.fullmatch(r"([A-Z]{2})(\d{4,5})", reg)
    return f"{m.group(1)} {m.group(2)}" if m else reg


def fmt_km(km: int | None) -> str:
    return "" if km is None else f"{km:,}".replace(",", " ")


def fill(template: dict, values: dict[str, str], images: dict[str, Path | None]) -> bytes:
    """The form with the values and pictures drawn on. Fields without a value or
    picture are left blank (e.g. no reg. no yet)."""
    from pypdf import PdfReader, PdfWriter
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    fields = template["fields"] or {}
    reader = PdfReader(str(path(template["file_key"], "pdf")))
    writer = PdfWriter()
    for page_no, page in enumerate(reader.pages, start=1):
        if page.rotation % 360:
            page.transfer_rotation_to_content()  # draw in the page's upright coordinates
        box = page.cropbox
        left, bottom, W, H = float(box.left), float(box.bottom), float(box.width), float(box.height)
        here = {k: f for k, f in fields.items() if f.get("page") == page_no}
        if here:
            buf = io.BytesIO()
            c = canvas.Canvas(buf, pagesize=(float(page.mediabox.right), float(page.mediabox.top)))
            for key, f in here.items():
                x, y = left + f["x"] * W, bottom + (1 - f["y"]) * H
                if key in IMAGE_FIELDS:
                    img_path = images.get(key)
                    if not img_path or not img_path.is_file():
                        continue
                    with Image.open(img_path) as im:
                        iw, ih = im.size
                    w = f["w"] * W
                    h = w * ih / iw
                    c.drawImage(ImageReader(str(img_path)), x - w / 2, y - h / 2, width=w, height=h, mask="auto")
                else:
                    text = values.get(key) or ""
                    if text:
                        c.setFont("Helvetica", f["size"])
                        c.drawString(x, y - f["size"] * 0.35, text)  # y is the middle of the line
            c.save()
            buf.seek(0)
            page.merge_page(PdfReader(buf).pages[0])
        writer.add_page(page)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def store_sheet(data: bytes) -> str:
    key = f"pdi/sheets/{dt.datetime.now(dt.timezone.utc):%Y/%m}/{uuid.uuid4().hex}"
    p = path(key, "pdf")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return key


def make_sheet(conn, order_id: int, staff: dict, template_id: int, km: int, date: dt.date,
               stamp_id: int | None) -> str | None:
    """Fill in the PDI sheet for a PDI order and store it on the order. Signs with
    the logged-in user's signature. Returns the replaced sheet's key: remove that
    file after commit."""
    template = conn.execute("SELECT * FROM pdi_templates WHERE id = %s AND deleted_at IS NULL",
                            (template_id,)).fetchone()
    if not template:
        raise SheetError("Choose a PDI sheet")
    fields = template["fields"] or {}
    if not fields:
        raise SheetError("The fields of this PDI sheet have not been placed yet (Settings → PDI sheets)")
    order = conn.execute(
        """SELECT o.id, o.sheet_file_key, o.work_order, v.registration_number, v.vin
             FROM pdi_orders o JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = %s""", (order_id,)).fetchone()
    me = conn.execute("SELECT name, signature_key FROM staff WHERE id = %s", (staff["id"],)).fetchone()
    stamp = None
    if "stamp" in fields:
        if stamp_id is None:
            raise SheetError("Choose a stamp")
        stamp = conn.execute("SELECT * FROM pdi_stamps WHERE id = %s AND deleted_at IS NULL", (stamp_id,)).fetchone()
        if not stamp:
            raise SheetError("Choose a stamp")
    if "signature" in fields and not me["signature_key"]:
        raise SheetError("Add your signature first (Settings → My signature, or the 👤 menu)")
    values = {
        "reg": fmt_reg(order["registration_number"]),
        "vin": order["vin"],
        "km": fmt_km(km),
        "date": date.strftime("%d.%m.%Y"),
        "signer": me["name"],
        "work_order": order["work_order"] or "",
    }
    images = {
        "stamp": path(stamp["file_key"], "png") if stamp else None,
        "signature": path(me["signature_key"], "png") if me["signature_key"] else None,
    }
    try:
        key = store_sheet(fill(template, values, images))
    except SheetError:
        raise
    except Exception as exc:
        log.exception("PDI sheet for order %s could not be made", order_id)
        raise SheetError("The PDI sheet could not be made from this PDF") from exc
    conn.execute(
        """UPDATE pdi_orders SET done_km = %s, sheet_file_key = %s, sheet_template_id = %s, sheet_stamp_id = %s,
                  sheet_date = %s, sheet_made_at = now(), sheet_made_by = %s
            WHERE id = %s""",
        (km, key, template_id, stamp["id"] if stamp else None, date, staff["id"], order_id),
    )
    return order["sheet_file_key"]


def test_fill(template: dict, signer: dict, stamp: dict | None) -> bytes:
    """The form filled with made-up values, to check the positions."""
    return fill(template, {
        "reg": "AB 12345", "vin": "TESTVIN0123456789", "km": "12 345",
        "date": dt.date.today().strftime("%d.%m.%Y"), "signer": signer["name"], "work_order": "123456",
    }, {
        "stamp": path(stamp["file_key"], "png") if stamp else None,
        "signature": path(signer["signature_key"], "png") if signer.get("signature_key") else None,
    })
