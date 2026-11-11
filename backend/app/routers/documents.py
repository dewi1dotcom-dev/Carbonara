"""Documents per car: contracts, notes and other files.

Files are stored as they were uploaded under PHOTO_DIR/docs/<yyyy>/<mm>/<uuid>.<ext>,
so photostore.remove() can delete them too (it ignores the missing renditions).
Contracts hold personal data: titles and texts never go into vehicle_events, and
files are served with Cache-Control: no-store.
"""

import datetime as dt
import uuid
from pathlib import PurePath
from typing import Literal, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import photostore
from ..common import bad_request, log_event, not_found, patch_fields
from ..config import settings
from ..db import get_conn

router = APIRouter(tags=["documents"])

KINDS = ("contract", "note", "other")
# Allowed file types, by extension. The stored content type comes from this
# table, never from the browser. Only PDFs and images open in the browser;
# everything else is downloaded.
FILE_TYPES = {
    "pdf": "application/pdf",
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp",
    "heic": "image/heic", "heif": "image/heif",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "odt": "application/vnd.oasis.opendocument.text",
    "ods": "application/vnd.oasis.opendocument.spreadsheet",
    "txt": "text/plain; charset=utf-8",
}
INLINE = {"pdf", "jpg", "jpeg", "png", "webp"}

COLUMNS = """d.id, d.vehicle_id, d.kind, d.title, d.body, d.original_name, d.original_ext, d.mime_type, d.size_bytes,
             d.file_key IS NOT NULL AS has_file, d.created_at, d.created_by, s.name AS created_by_name,
             d.updated_at, u.name AS updated_by_name"""
FROM = """FROM vehicle_documents d LEFT JOIN staff s ON s.id = d.created_by LEFT JOIN staff u ON u.id = d.updated_by"""


def _clean(text: Optional[str]) -> Optional[str]:
    return (text or "").strip() or None


def _get(conn, doc_id: int) -> dict:
    row = conn.execute(f"SELECT {COLUMNS} {FROM} WHERE d.id = %s", (doc_id,)).fetchone()
    if not row:
        raise not_found("Document")
    return row


def _may_change(staff: dict, doc: dict) -> None:
    if not staff["is_admin"] and doc["created_by"] != staff["id"]:
        raise HTTPException(403, "Only the person who added it or an administrator can change this document")


@router.get("/vehicles/{vehicle_id}/documents")
def list_documents(vehicle_id: int, conn=Depends(get_conn)):
    return conn.execute(f"SELECT {COLUMNS} {FROM} WHERE d.vehicle_id = %s ORDER BY d.created_at DESC",
                        (vehicle_id,)).fetchall()


@router.post("/vehicles/{vehicle_id}/documents", status_code=201)
def add_document(
    vehicle_id: int,
    request: Request,
    kind: str = Form(...),
    title: Optional[str] = Form(None),
    body: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    conn=Depends(get_conn),
):
    if kind not in KINDS:
        raise bad_request(f"kind must be one of {', '.join(KINDS)}")
    if not conn.execute("SELECT 1 FROM vehicles WHERE id = %s AND deleted_at IS NULL", (vehicle_id,)).fetchone():
        raise not_found("Vehicle")
    title, body = _clean(title), _clean(body)
    if title and len(title) > 200:
        raise bad_request("The title is too long (max 200 characters)")
    if body and len(body) > 10000:
        raise bad_request("The text is too long (max 10 000 characters)")

    meta = {}
    path = None
    if file is not None and file.filename:
        name = PurePath(file.filename.replace("\\", "/")).name[:200]
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext not in FILE_TYPES:
            raise bad_request("This file type is not allowed (use PDF, a photo, Word, Excel or text)")
        data = file.file.read(settings.max_upload_bytes + 1)
        if len(data) > settings.max_upload_bytes:
            raise HTTPException(413, "File too large")
        if not data:
            raise bad_request("The file is empty")
        key = f"docs/{dt.datetime.now(dt.timezone.utc):%Y/%m}/{uuid.uuid4().hex}"
        meta = {"file_key": key, "original_ext": ext, "original_name": name,
                "mime_type": FILE_TYPES[ext], "size_bytes": len(data)}
        path = photostore.path_for(meta, "original")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    if not meta and not body:
        raise bad_request("Add a file or write a text")

    staff_id = request.state.staff["id"]
    try:
        row = conn.execute(
            """INSERT INTO vehicle_documents (vehicle_id, kind, title, body, file_key, original_ext, original_name,
                                              mime_type, size_bytes, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (vehicle_id, kind, title, body, meta.get("file_key"), meta.get("original_ext"), meta.get("original_name"),
             meta.get("mime_type"), meta.get("size_bytes"), staff_id),
        ).fetchone()
        # No title or text in the history: a contract title can name the customer.
        log_event(conn, vehicle_id, "document_added", staff_id=staff_id,
                  data={"document_id": row["id"], "kind": kind, "file": bool(meta)})
    except Exception:
        if meta:
            photostore.remove(meta)
        raise
    return _get(conn, row["id"])


class DocumentPatch(BaseModel):
    kind: Optional[Literal["contract", "note", "other"]] = None
    title: Optional[str] = Field(None, max_length=200)
    body: Optional[str] = Field(None, max_length=10000)


@router.patch("/documents/{doc_id}")
def update_document(doc_id: int, body: DocumentPatch, request: Request, conn=Depends(get_conn)):
    doc = _get(conn, doc_id)
    staff = request.state.staff
    _may_change(staff, doc)
    fields = patch_fields(body, non_nullable=("kind",))
    for k in ("title", "body"):
        if k in fields:
            fields[k] = _clean(fields[k])
    if "body" in fields and not fields["body"] and not doc["has_file"]:
        raise bad_request("A document without a file needs a text")
    if fields:
        sets = ", ".join(f"{k} = %({k})s" for k in fields)  # keys come from the model, not the user
        conn.execute(f"UPDATE vehicle_documents SET {sets}, updated_at = now(), updated_by = %(by)s WHERE id = %(id)s",
                     {**fields, "by": staff["id"], "id": doc_id})
        log_event(conn, doc["vehicle_id"], "document_updated", staff_id=staff["id"],
                  data={"document_id": doc_id, "kind": fields.get("kind", doc["kind"])})
    return _get(conn, doc_id)


@router.delete("/documents/{doc_id}", status_code=204)
def delete_document(doc_id: int, request: Request, conn=Depends(get_conn)):
    doc = _get(conn, doc_id)
    staff = request.state.staff
    _may_change(staff, doc)
    row = conn.execute("DELETE FROM vehicle_documents WHERE id = %s RETURNING file_key, original_ext",
                       (doc_id,)).fetchone()
    log_event(conn, doc["vehicle_id"], "document_deleted", staff_id=staff["id"],
              data={"document_id": doc_id, "kind": doc["kind"]})
    conn.commit()  # remove the file only once the delete is final
    if row["file_key"]:
        photostore.remove(row)


@router.get("/documents/{doc_id}/file")
def get_document_file(doc_id: int, conn=Depends(get_conn)):
    row = conn.execute("SELECT * FROM vehicle_documents WHERE id = %s", (doc_id,)).fetchone()
    if not row or not row["file_key"]:
        raise not_found("Document file")
    path = photostore.path_for(row, "original")
    if not path.is_file():
        raise not_found("Document file")
    return FileResponse(path, media_type=row["mime_type"], filename=row["original_name"],
                        content_disposition_type="inline" if row["original_ext"] in INLINE else "attachment",
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
