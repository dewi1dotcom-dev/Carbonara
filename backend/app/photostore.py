"""Photo storage on local disk.

For each upload we keep the untouched original (evidence: original bytes and
EXIF) plus two JPEG renditions for the UI:
    PHOTO_DIR/2026/11/<uuid>.<ext>          original
    PHOTO_DIR/2026/11/<uuid>_display.jpg    max 1600 px
    PHOTO_DIR/2026/11/<uuid>_thumb.jpg      max 400 px
"""

from __future__ import annotations

import datetime as dt
import io
import uuid
from pathlib import Path

from PIL import Image, ImageOps

from .config import settings

try:  # iPhone HEIC uploads
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    pass

FORMATS = {
    "JPEG": ("jpg", "image/jpeg"),
    "PNG": ("png", "image/png"),
    "WEBP": ("webp", "image/webp"),
    "HEIF": ("heic", "image/heic"),
}
RENDITIONS = {"display": 1600, "thumb": 400}
VARIANTS = ("original", *RENDITIONS)


class PhotoError(ValueError):
    pass


def _exif_taken_at(img: Image.Image) -> dt.datetime | None:
    try:
        exif = img.getexif()
        raw = exif.get_ifd(0x8769).get(36867) or exif.get(306)  # DateTimeOriginal / DateTime
        return dt.datetime.strptime(str(raw).strip("\x00 "), "%Y:%m:%d %H:%M:%S") if raw else None
    except Exception:
        return None


def store(data: bytes) -> dict:
    try:
        img = Image.open(io.BytesIO(data))
        fmt = img.format
        img.load()
    except Exception as exc:
        raise PhotoError("File is not a readable image") from exc
    if fmt not in FORMATS:
        raise PhotoError(f"Unsupported image format: {fmt}")
    ext, mime = FORMATS[fmt]
    taken_at = _exif_taken_at(img)

    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    key = f"{dt.datetime.now(dt.timezone.utc):%Y/%m}/{uuid.uuid4().hex}"
    base = settings.photo_dir / key
    base.parent.mkdir(parents=True, exist_ok=True)
    try:
        base.with_name(f"{base.name}.{ext}").write_bytes(data)
        for name, size in RENDITIONS.items():
            r = img.copy()
            r.thumbnail((size, size))
            r.save(base.with_name(f"{base.name}_{name}.jpg"), "JPEG", quality=85, optimize=True)
    except Exception:
        remove({"file_key": key, "original_ext": ext})
        raise

    return {
        "file_key": key,
        "original_ext": ext,
        "mime_type": mime,
        "width": img.width,
        "height": img.height,
        "size_bytes": len(data),
        "taken_at": taken_at,
    }


def path_for(row: dict, variant: str) -> Path:
    base = settings.photo_dir / row["file_key"]
    if variant == "original":
        return base.with_name(f"{base.name}.{row['original_ext']}")
    return base.with_name(f"{base.name}_{variant}.jpg")


def remove(row: dict) -> None:
    for variant in VARIANTS:
        try:
            path_for(row, variant).unlink(missing_ok=True)
        except OSError:
            pass
