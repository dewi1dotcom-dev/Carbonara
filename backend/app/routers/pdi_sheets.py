"""PDI sheets: the models' PDF forms (templates), company stamps, each user's
own signature, and the filled-in sheet of a PDI order (see pdisheet.py)."""

import datetime as dt
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import pdisheet
from ..auth import require_admin
from ..common import bad_request, conflict, log_event, not_found
from ..config import settings
from ..db import get_conn

router = APIRouter(tags=["pdi-sheets"])

NO_STORE = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}


def _read(file: UploadFile) -> bytes:
    data = file.file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(413, "File too large")
    if not data:
        raise bad_request("The file is empty")
    return data


def _sheet_error(exc: pdisheet.SheetError):
    return bad_request(str(exc))


# --------------------------------------------------------------------------- #
# templates (admins change them; everyone can read them)
# --------------------------------------------------------------------------- #

TEMPLATE_COLUMNS = "id, name, models, pages, fields, created_at, updated_at"


def _template(conn, template_id: int) -> dict:
    row = conn.execute("SELECT * FROM pdi_templates WHERE id = %s AND deleted_at IS NULL", (template_id,)).fetchone()
    if not row:
        raise not_found("PDI sheet")
    return row


@router.get("/pdi-templates")
def list_templates(conn=Depends(get_conn)):
    return conn.execute(f"SELECT {TEMPLATE_COLUMNS} FROM pdi_templates WHERE deleted_at IS NULL ORDER BY name").fetchall()


@router.post("/pdi-templates", status_code=201)
def add_template(request: Request, name: str = Form(...), models: str = Form(""), file: UploadFile = File(...),
                 conn=Depends(get_conn), _admin=Depends(require_admin)):
    name, models = name.strip()[:80], models.strip()[:300]
    if not name:
        raise bad_request("Give the PDI sheet a name")
    try:
        key, pages = pdisheet.store_template(_read(file))
    except pdisheet.SheetError as exc:
        raise _sheet_error(exc)
    try:
        return conn.execute(
            f"""INSERT INTO pdi_templates (name, models, file_key, pages, created_by)
                VALUES (%s, %s, %s, %s, %s) RETURNING {TEMPLATE_COLUMNS}""",
            (name, models, key, Jsonb(pages), request.state.staff["id"])).fetchone()
    except Exception:
        pdisheet.remove(key, "pdf")
        raise


class TemplatePatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    models: Optional[str] = Field(None, max_length=300)
    fields: Optional[dict] = None


@router.patch("/pdi-templates/{template_id}")
def patch_template(template_id: int, body: TemplatePatch, conn=Depends(get_conn), _admin=Depends(require_admin)):
    t = _template(conn, template_id)
    if body.name is not None:
        conn.execute("UPDATE pdi_templates SET name = %s WHERE id = %s", (body.name.strip(), template_id))
    if body.models is not None:
        conn.execute("UPDATE pdi_templates SET models = %s WHERE id = %s", (body.models.strip(), template_id))
    if body.fields is not None:
        try:
            fields = pdisheet.clean_fields(body.fields, t["pages"])
        except pdisheet.SheetError as exc:
            raise _sheet_error(exc)
        conn.execute("UPDATE pdi_templates SET fields = %s WHERE id = %s", (Jsonb(fields), template_id))
    conn.execute("UPDATE pdi_templates SET updated_at = now() WHERE id = %s", (template_id,))
    return conn.execute(f"SELECT {TEMPLATE_COLUMNS} FROM pdi_templates WHERE id = %s", (template_id,)).fetchone()


@router.delete("/pdi-templates/{template_id}", status_code=204)
def delete_template(template_id: int, conn=Depends(get_conn), _admin=Depends(require_admin)):
    """Removed for good unless sheets were made from it; then only hidden. The
    sheets already made are files of their own and stay."""
    t = _template(conn, template_id)
    if conn.execute("SELECT 1 FROM pdi_orders WHERE sheet_template_id = %s LIMIT 1", (template_id,)).fetchone():
        conn.execute("UPDATE pdi_templates SET deleted_at = now() WHERE id = %s", (template_id,))
    else:
        conn.execute("DELETE FROM pdi_templates WHERE id = %s", (template_id,))
    conn.commit()  # remove the file only once the change is final
    pdisheet.remove(t["file_key"], "pdf")


@router.get("/pdi-templates/{template_id}/pages/{page_no}")
def template_page(template_id: int, page_no: int, conn=Depends(get_conn)):
    t = _template(conn, template_id)
    try:
        p = pdisheet.page_image(t["file_key"], page_no)
    except pdisheet.SheetError as exc:
        raise not_found("Page")
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@router.post("/pdi-templates/{template_id}/suggest")
def suggest_fields(template_id: int, conn=Depends(get_conn), _admin=Depends(require_admin)):
    """Positions suggested by OCR (not saved; the placing screen shows them first)."""
    t = _template(conn, template_id)
    return pdisheet.suggest(t["file_key"], t["pages"])


@router.get("/pdi-templates/{template_id}/test")
def test_template(template_id: int, request: Request, conn=Depends(get_conn)):
    """The form filled with made-up values, the default stamp and your own signature."""
    t = _template(conn, template_id)
    me = conn.execute("SELECT name, signature_key FROM staff WHERE id = %s", (request.state.staff["id"],)).fetchone()
    stamp = conn.execute("""SELECT * FROM pdi_stamps WHERE deleted_at IS NULL
                             ORDER BY is_default DESC, id LIMIT 1""").fetchone()
    try:
        data = pdisheet.test_fill(t, me, stamp)
    except Exception as exc:
        raise bad_request(f"The test sheet could not be made: {exc}")
    return Response(data, media_type="application/pdf",
                    headers={**NO_STORE, "Content-Disposition": 'inline; filename="pdi-sheet-test.pdf"'})


# --------------------------------------------------------------------------- #
# stamps (admins)
# --------------------------------------------------------------------------- #

@router.get("/pdi-stamps")
def list_stamps(conn=Depends(get_conn)):
    return conn.execute("""SELECT id, name, is_default, created_at FROM pdi_stamps WHERE deleted_at IS NULL
                            ORDER BY is_default DESC, name""").fetchall()


@router.post("/pdi-stamps", status_code=201)
def add_stamp(request: Request, name: str = Form(...), file: UploadFile = File(...), conn=Depends(get_conn),
              _admin=Depends(require_admin)):
    name = name.strip()[:80]
    if not name:
        raise bad_request("Give the stamp a name")
    try:
        key = pdisheet.store_image(_read(file), "stamps")
    except pdisheet.SheetError as exc:
        raise _sheet_error(exc)
    first = not conn.execute("SELECT 1 FROM pdi_stamps WHERE deleted_at IS NULL LIMIT 1").fetchone()
    try:
        return conn.execute(
            """INSERT INTO pdi_stamps (name, file_key, is_default, created_by) VALUES (%s, %s, %s, %s)
               RETURNING id, name, is_default, created_at""",
            (name, key, first, request.state.staff["id"])).fetchone()
    except Exception:
        pdisheet.remove(key, "png")
        raise


class StampPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    is_default: Optional[bool] = None


@router.patch("/pdi-stamps/{stamp_id}")
def patch_stamp(stamp_id: int, body: StampPatch, conn=Depends(get_conn), _admin=Depends(require_admin)):
    if not conn.execute("SELECT 1 FROM pdi_stamps WHERE id = %s AND deleted_at IS NULL", (stamp_id,)).fetchone():
        raise not_found("Stamp")
    if body.name is not None:
        conn.execute("UPDATE pdi_stamps SET name = %s WHERE id = %s", (body.name.strip(), stamp_id))
    if body.is_default:
        conn.execute("UPDATE pdi_stamps SET is_default = (id = %s) WHERE deleted_at IS NULL", (stamp_id,))
    return conn.execute("SELECT id, name, is_default, created_at FROM pdi_stamps WHERE id = %s", (stamp_id,)).fetchone()


@router.delete("/pdi-stamps/{stamp_id}", status_code=204)
def delete_stamp(stamp_id: int, conn=Depends(get_conn), _admin=Depends(require_admin)):
    row = conn.execute("SELECT * FROM pdi_stamps WHERE id = %s AND deleted_at IS NULL", (stamp_id,)).fetchone()
    if not row:
        raise not_found("Stamp")
    if conn.execute("SELECT 1 FROM pdi_orders WHERE sheet_stamp_id = %s LIMIT 1", (stamp_id,)).fetchone():
        conn.execute("UPDATE pdi_stamps SET deleted_at = now(), is_default = false WHERE id = %s", (stamp_id,))
    else:
        conn.execute("DELETE FROM pdi_stamps WHERE id = %s", (stamp_id,))
    if row["is_default"]:  # another stamp becomes the default
        conn.execute("""UPDATE pdi_stamps SET is_default = true WHERE id = (
                          SELECT id FROM pdi_stamps WHERE deleted_at IS NULL ORDER BY id LIMIT 1)""")
    conn.commit()
    pdisheet.remove(row["file_key"], "png")


@router.get("/pdi-stamps/{stamp_id}/image")
def stamp_image(stamp_id: int, conn=Depends(get_conn)):
    row = conn.execute("SELECT file_key FROM pdi_stamps WHERE id = %s AND deleted_at IS NULL", (stamp_id,)).fetchone()
    p = row and pdisheet.path(row["file_key"], "png")
    if not p or not p.is_file():
        raise not_found("Stamp")
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


# --------------------------------------------------------------------------- #
# my signature (each user their own; nobody else can see or change it)
# --------------------------------------------------------------------------- #

@router.get("/my-signature")
def my_signature(request: Request, conn=Depends(get_conn)):
    row = conn.execute("SELECT signature_key FROM staff WHERE id = %s", (request.state.staff["id"],)).fetchone()
    p = row["signature_key"] and pdisheet.path(row["signature_key"], "png")
    if not p or not p.is_file():
        raise not_found("Signature")
    return FileResponse(p, media_type="image/png", headers=NO_STORE)


@router.put("/my-signature")
def save_signature(request: Request, file: UploadFile = File(...), conn=Depends(get_conn)):
    """A drawn signature (PNG from the signature pad) or an uploaded picture."""
    try:
        key = pdisheet.store_image(_read(file), "signatures")
    except pdisheet.SheetError as exc:
        raise _sheet_error(exc)
    staff_id = request.state.staff["id"]
    old = conn.execute("SELECT signature_key FROM staff WHERE id = %s FOR UPDATE", (staff_id,)).fetchone()
    conn.execute("UPDATE staff SET signature_key = %s, signature_updated_at = now() WHERE id = %s", (key, staff_id))
    conn.commit()
    pdisheet.remove(old["signature_key"], "png")
    return {"has_signature": True}


@router.delete("/my-signature", status_code=204)
def delete_signature(request: Request, conn=Depends(get_conn)):
    staff_id = request.state.staff["id"]
    old = conn.execute("SELECT signature_key FROM staff WHERE id = %s FOR UPDATE", (staff_id,)).fetchone()
    conn.execute("UPDATE staff SET signature_key = NULL, signature_updated_at = NULL WHERE id = %s", (staff_id,))
    conn.commit()
    pdisheet.remove(old["signature_key"], "png")


# --------------------------------------------------------------------------- #
# the PDI order's sheet
# --------------------------------------------------------------------------- #

@router.get("/pdi/{order_id}/sheet-options")
def sheet_options(order_id: int, request: Request, conn=Depends(get_conn)):
    """What the "PDI done" / "Make PDI sheet" dialog needs."""
    order = conn.execute(
        """SELECT o.id, o.status, o.done_km, o.sheet_template_id, o.sheet_stamp_id, o.sheet_date, o.done_at,
                  o.work_order, v.make, v.model, v.registration_number, v.vin,
                  (SELECT max(i.odometer_km) FROM inspections i
                    WHERE i.vehicle_id = v.id AND i.status = 'completed') AS last_km
             FROM pdi_orders o JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = %s""", (order_id,)).fetchone()
    if not order:
        raise not_found("PDI order")
    templates = list_templates(conn)
    match = pdisheet.match_template(templates, order["make"], order["model"])
    me = conn.execute("SELECT signature_key FROM staff WHERE id = %s", (request.state.staff["id"],)).fetchone()
    return {
        "order": order,
        "templates": [{"id": t["id"], "name": t["name"], "models": t["models"], "fields": sorted(t["fields"] or {})}
                      for t in templates],
        "suggested_template_id": order["sheet_template_id"] or (match["id"] if match else None),
        "stamps": list_stamps(conn),
        "has_signature": bool(me["signature_key"]),
    }


class SheetIn(BaseModel):
    template_id: int
    km: int = Field(ge=0, le=2_000_000)
    date: dt.date
    stamp_id: Optional[int] = None
    work_order: Optional[str] = Field(None, max_length=40)  # filled in or corrected in the dialog


def make_sheet(conn, order_id: int, staff: dict, body: SheetIn) -> Optional[str]:
    """Shared by "PDI done" (pdi.py) and "Make PDI sheet": returns the old sheet's key."""
    work_order = " ".join((body.work_order or "").split())
    if work_order:  # typed in the dialog: saved on the order, then printed on the sheet
        conn.execute("UPDATE pdi_orders SET work_order = %s WHERE id = %s", (work_order, order_id))
    try:
        old = pdisheet.make_sheet(conn, order_id, staff, body.template_id, body.km, body.date, body.stamp_id)
    except pdisheet.SheetError as exc:
        raise _sheet_error(exc)
    return old


@router.post("/pdi/{order_id}/sheet")
def remake_sheet(order_id: int, body: SheetIn, request: Request, conn=Depends(get_conn)):
    """Make (or make again) the sheet of a done PDI, e.g. once the car has its reg. no."""
    row = conn.execute("SELECT vehicle_id, status FROM pdi_orders WHERE id = %s FOR UPDATE", (order_id,)).fetchone()
    if not row:
        raise not_found("PDI order")
    if row["status"] != "done":
        raise conflict("Mark the PDI as done first")
    staff = request.state.staff
    old = make_sheet(conn, order_id, staff, body)
    log_event(conn, row["vehicle_id"], "pdi_sheet_made", staff_id=staff["id"], data={"km": body.km, "again": bool(old)})
    conn.commit()
    pdisheet.remove(old, "pdf")
    return {"ok": True}


@router.get("/pdi/{order_id}/sheet")
def get_sheet(order_id: int, conn=Depends(get_conn)):
    row = conn.execute(
        """SELECT o.sheet_file_key, v.registration_number, v.vin
             FROM pdi_orders o JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = %s""", (order_id,)).fetchone()
    p = row and row["sheet_file_key"] and pdisheet.path(row["sheet_file_key"], "pdf")
    if not p or not p.is_file():
        raise not_found("PDI sheet")
    return FileResponse(p, media_type="application/pdf", filename=f"PDI-{row['registration_number'] or row['vin']}.pdf",
                        content_disposition_type="inline", headers=NO_STORE)
