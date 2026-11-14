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

TEXT_FIELDS = ("reg", "vin", "km", "date", "signer", "work_order", "battery")
IMAGE_FIELDS = ("stamp", "signature")
# "checks": the form's tick boxes, many positions in one field: {"size": pt, "marks": [{page, x, y}, …]}.
# Each mark is the centre of a box; all are ticked when the user chooses "Tick all boxes".
CHECKS = "checks"
FIELDS = TEXT_FIELDS + IMAGE_FIELDS + (CHECKS,)
MAX_PAGES = 20
MAX_MARKS = 400
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
    "battery": ("12v", "12 v", "12v-batteri", "12v batteri", "batterispenning", "batteri", "battery voltage",
                "battery", "spenning", "voltage", "volt"),
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
    marks: list[dict] = []
    box_pts: list[float] = []
    import numpy as np

    for page_no in range(1, min(len(pages), 6) + 1):
        img = Image.open(page_image(key, page_no))
        W, H = img.size
        gray = np.array(img.convert("L"))
        for cx, cy, bw in find_boxes(img):
            marks.append({"page": page_no, "x": round(cx / W, 4), "y": round(cy / H, 4)})
            box_pts.append(bw / W * pages[page_no - 1]["w"])
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
                    start = field_start(gray, right * W, item["cy"], item["height"]) / W
                    pos = {"page": page_no, "x": min(start, 0.95), "y": item["cy"] / H, "bold": True,
                           "size": max(8, min(16, round(item["height"] / W * pages[page_no - 1]["w"] * 0.8) + 2))}
                if field not in found or len(text) < found[field][0]:
                    found[field] = (len(text), {k: round(v, 4) if isinstance(v, float) else v for k, v in pos.items()})
    out = {f: pos for f, (_, pos) in found.items()}
    if marks:
        box_pts.sort()
        out[CHECKS] = {"size": round(min(max(box_pts[len(box_pts) // 2], 6), 24), 1), "marks": marks[:MAX_MARKS]}
    return out


def field_start(gray, right: float, cy: float, text_h: float) -> float:
    """Where a value should start, in px, for a label whose right edge is at `right`.
    Looks along the label's line for the empty box the value belongs in:
      - label in a dark (black) cell: past the dark area, into the light box beside it
      - label on white with a box after it: past the box's left border line
      - otherwise (e.g. "Reg.nr: ______"): just after the label, as before."""
    H, W = gray.shape
    pad = max(4, round(W * 0.006))
    band = gray[max(0, round(cy - text_h * 0.15)):min(H, round(cy + text_h * 0.15) + 1)]
    tall = gray[max(0, round(cy - text_h)):min(H, round(cy + text_h) + 1)]  # a box border spans more than a letter
    if band.size == 0:
        return right + pad
    light = band.mean(axis=0) > 160
    line = (tall < 110).mean(axis=0) > 0.9
    x, end = int(right) + 2, min(W, int(right + W * 0.35))
    if x >= end:
        return right + pad
    if not light[x]:  # dark cell: walk past it, then into the light box
        while x < end and not light[x]:
            x += 1
        return x + pad if x < end else right + pad
    for gap_x in range(x, min(end, int(right + W * 0.15))):  # a border line soon after the label
        if line[gap_x]:
            k = gap_x
            while k < end and line[k]:
                k += 1
            if k + round(W * 0.03) < end and light[k:k + round(W * 0.03)].all():
                return k + pad
            break
        if not light[gap_x]:  # more text before any box: not a box field
            break
    return right + pad


def find_boxes(img: Image.Image) -> list[tuple[float, float, float]]:
    """Empty square tick boxes on a rendered page, as (centre x, centre y, width) in px.
    A box: a square outline 0.7–3 % of the page width, hollow inside. Letters like
    O or D are rounder (less area than their bounding box) and are skipped."""
    import cv2
    import numpy as np

    gray = np.array(img.convert("L"))
    W = gray.shape[1]
    bw = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 15, 10)
    contours, _ = cv2.findContours(bw, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    lo, hi = W * 0.007, W * 0.03
    boxes = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if not (lo <= w <= hi and lo <= h <= hi and 0.8 <= w / h <= 1.25):
            continue
        if cv2.contourArea(c) < 0.85 * w * h:
            continue
        approx = cv2.approxPolyDP(c, 0.08 * cv2.arcLength(c, True), True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        m = max(2, round(w * 0.2))
        inner = bw[y + m:y + h - m, x + m:x + w - m]
        if inner.size == 0 or inner.mean() > 255 * 0.15:  # filled squares, bullets, ticked boxes
            continue
        boxes.append((x + w / 2, y + h / 2, float(w)))
    out: list[tuple[float, float, float]] = []
    for b in sorted(boxes, key=lambda b: -b[2]):  # a box's outer and inner edge: keep one
        if not any(abs(b[0] - o[0]) < o[2] / 2 and abs(b[1] - o[1]) < o[2] / 2 for o in out):
            out.append(b)
    return sorted(out, key=lambda b: (round(b[1] / (W * 0.01)), b[0]))  # reading order


def clean_fields(fields: dict, pages: list[dict]) -> dict:
    """Validate positions sent from the field placing screen."""
    out = {}
    for key, f in (fields or {}).items():
        if key not in FIELDS or not isinstance(f, dict):
            raise SheetError(f"Unknown field: {key}")
        if key == CHECKS:
            marks = f.get("marks") or []
            if not isinstance(marks, list) or len(marks) > MAX_MARKS:
                raise SheetError(f"At most {MAX_MARKS} tick boxes")
            clean = []
            for m in marks:
                try:
                    page, x, y = int(m["page"]), float(m["x"]), float(m["y"])
                except (KeyError, TypeError, ValueError) as exc:
                    raise SheetError("Tick boxes: page, x and y are needed") from exc
                if not 1 <= page <= len(pages) or not (0 <= x <= 1 and 0 <= y <= 1):
                    raise SheetError("A tick box is outside the page")
                clean.append({"page": page, "x": round(x, 4), "y": round(y, 4)})
            if clean:  # no boxes = the field isn't placed
                out[key] = {"size": round(min(max(float(f.get("size") or 10), 6), 24), 1), "marks": clean}
            continue
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
            item["size"] = round(min(max(float(f.get("size") or 12), 6), 24), 1)
            item["bold"] = f.get("bold", True) is not False  # bold unless turned off (the user's default)
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


def fmt_volt(v) -> str:
    """12.6 -> '12,6 V' (Norwegian decimal comma)."""
    if v is None:
        return ""
    return f"{float(v):.2f}".rstrip("0").rstrip(".").replace(".", ",") + " V"


def fill(template: dict, values: dict[str, str], images: dict[str, Path | None], checks: bool = False) -> bytes:
    """The form with the values and pictures drawn on. Fields without a value or
    picture are left blank (e.g. no reg. no yet). checks = tick every tick box."""
    from pypdf import PdfReader, PdfWriter
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    fields = dict(template["fields"] or {})
    tick = fields.pop(CHECKS, None) if checks else None
    fields.pop(CHECKS, None)
    reader = PdfReader(str(path(template["file_key"], "pdf")))
    writer = PdfWriter()
    for page_no, src in enumerate(reader.pages, start=1):
        if src.rotation % 360:
            src.transfer_rotation_to_content()  # draw in the page's upright coordinates
        page = writer.add_page(src)
        try:
            _flatten_widgets(writer, page, page_no)  # fillable forms: fields would cover what we draw
        except Exception:  # an odd form: fill it as before rather than fail
            log.warning("Form fields on page %s could not be flattened", page_no, exc_info=True)
        box = page.cropbox
        left, bottom, W, H = float(box.left), float(box.bottom), float(box.width), float(box.height)
        here = {k: f for k, f in fields.items() if f.get("page") == page_no}
        ticks = [m for m in (tick or {}).get("marks", []) if m["page"] == page_no]
        if here or ticks:
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
                        c.setFont("Helvetica" if f.get("bold") is False else "Helvetica-Bold", f["size"])
                        c.drawString(x, y - f["size"] * 0.35, text)  # y is the middle of the line
            if ticks:
                size = tick["size"]
                c.setFont("ZapfDingbats", size)  # built-in PDF font; "4" is a heavy check mark ✔
                for m in ticks:
                    c.drawCentredString(left + m["x"] * W, bottom + (1 - m["y"]) * H - size * 0.35, "4")
            c.save()
            buf.seek(0)
            page.merge_page(PdfReader(buf).pages[0])
    if "/AcroForm" in writer._root_object:
        del writer._root_object["/AcroForm"]
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def _flatten_widgets(writer, page, page_no: int) -> None:
    """A fillable ("klikkbar") PDF form: viewers draw form fields on top of the page, so
    the fields' white boxes would hide the ticks and text we draw. Draw each field's
    current look into the page itself and remove the fields; the sheet looks the same
    but is no longer editable (fine for a signed, archived sheet)."""
    from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject

    annots = page.get("/Annots")
    if not annots:
        return
    keep, ops = ArrayObject(), []
    xobjects = {}
    for i, ref in enumerate(annots.get_object()):
        a = ref.get_object()
        if a.get("/Subtype") != "/Widget":
            keep.append(ref)
            continue
        ap = a.get("/AP")
        if ap is None or int(a.get("/F", 0)) & 2:  # no look, or hidden
            continue
        ap = ap.get_object()
        if "/N" not in ap:
            continue
        normal, n_ref = ap["/N"].get_object(), ap.raw_get("/N")
        if not hasattr(normal, "get_data"):  # check boxes: one look per state, /AS is the current one
            state = a.get("/AS")
            if not state or state not in normal:
                continue
            n_ref, normal = normal.raw_get(state), normal[state].get_object()
        try:
            r = [float(v) for v in a["/Rect"]]
            bb = [float(v) for v in normal.get("/BBox", [0, 0, abs(r[2] - r[0]), abs(r[3] - r[1])])]
            m = [float(v) for v in normal.get("/Matrix", [1, 0, 0, 1, 0, 0])]
        except (KeyError, TypeError, ValueError):
            continue
        x0, y0, x1, y1 = min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3])
        # PDF 12.5.5: the bounding box, transformed by the look's matrix, is fitted to the field's rectangle.
        pts = [(bb[0], bb[1]), (bb[2], bb[1]), (bb[0], bb[3]), (bb[2], bb[3])]
        tx = [m[0] * x + m[2] * y + m[4] for x, y in pts]
        ty = [m[1] * x + m[3] * y + m[5] for x, y in pts]
        w, h = max(tx) - min(tx), max(ty) - min(ty)
        if w <= 0 or h <= 0:
            continue
        sx, sy = (x1 - x0) / w, (y1 - y0) / h
        name = f"/CbnField{page_no}x{i}"
        xobjects[name] = n_ref if hasattr(n_ref, "idnum") else writer._add_object(normal)
        ops.append(f"q {sx:.5f} 0 0 {sy:.5f} {x0 - min(tx) * sx:.4f} {y0 - min(ty) * sy:.4f} cm {name} Do Q")
    if keep:
        page[NameObject("/Annots")] = keep
    else:
        del page["/Annots"]
    if not ops:
        return
    if "/Resources" not in page:
        page[NameObject("/Resources")] = DictionaryObject()
    res = page["/Resources"].get_object()
    if "/XObject" not in res:
        res[NameObject("/XObject")] = DictionaryObject()
    xo = res["/XObject"].get_object()
    for name, ref in xobjects.items():
        xo[NameObject(name)] = ref
    old = page.get_contents()
    stream = DecodedStreamObject()
    stream.set_data(b"q\n" + (old.get_data() if old else b"") + b"\nQ\n" + "\n".join(ops).encode() + b"\n")
    page[NameObject("/Contents")] = writer._add_object(stream)


def store_sheet(data: bytes) -> str:
    key = f"pdi/sheets/{dt.datetime.now(dt.timezone.utc):%Y/%m}/{uuid.uuid4().hex}"
    p = path(key, "pdf")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return key


def make_sheet(conn, order_id: int, staff: dict, template_id: int, km: int, date: dt.date,
               stamp_id: int | None, battery: float | None = None, checks: bool = False) -> str | None:
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
    if "battery" in fields and battery is None:
        raise SheetError("Enter the 12V battery reading")
    values = {
        "battery": fmt_volt(battery),
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
        key = store_sheet(fill(template, values, images, checks=checks))
    except SheetError:
        raise
    except Exception as exc:
        log.exception("PDI sheet for order %s could not be made", order_id)
        raise SheetError("The PDI sheet could not be made from this PDF") from exc
    conn.execute(
        """UPDATE pdi_orders SET done_km = %s, sheet_file_key = %s, sheet_template_id = %s, sheet_stamp_id = %s,
                  sheet_date = %s, sheet_made_at = now(), sheet_made_by = %s,
                  done_battery_v = coalesce(%s, done_battery_v), sheet_checks = %s
            WHERE id = %s""",
        (km, key, template_id, stamp["id"] if stamp else None, date, staff["id"], battery,
         bool(checks and CHECKS in fields), order_id),
    )
    return order["sheet_file_key"]


def test_fill(template: dict, signer: dict, stamp: dict | None) -> bytes:
    """The form filled with made-up values, to check the positions."""
    return fill(template, {
        "reg": "AB 12345", "vin": "TESTVIN0123456789", "km": "12 345",
        "date": dt.date.today().strftime("%d.%m.%Y"), "signer": signer["name"], "work_order": "123456",
        "battery": fmt_volt(12.6),
    }, {
        "stamp": path(stamp["file_key"], "png") if stamp else None,
        "signature": path(signer["signature_key"], "png") if signer.get("signature_key") else None,
    }, checks=True)
