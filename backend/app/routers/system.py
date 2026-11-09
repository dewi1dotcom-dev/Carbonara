"""System settings (super-admins): values saved here override the server
environment. Secrets are write-only: only their last 4 characters are shown."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from ..auth import require_superadmin
from ..common import bad_request, not_found
from ..config import BY_NAME, SETTINGS, convert, settings
from ..db import get_conn

log = logging.getLogger("carbonara.system")
router = APIRouter(tags=["system"], dependencies=[Depends(require_superadmin)])


class SettingIn(BaseModel):
    value: str = Field(max_length=2000)


def _hint(value) -> Optional[str]:
    text = str(value or "")
    return f"…{text[-4:]}" if len(text) >= 8 else ("set" if text else None)


@router.get("/system/settings")
def list_settings(conn=Depends(get_conn)):
    settings.reload()
    saved = {r["key"]: r for r in conn.execute(
        "SELECT a.key, a.updated_at, s.name AS updated_by_name FROM app_settings a "
        "LEFT JOIN staff s ON s.id = a.updated_by").fetchall()}
    out = []
    for s in SETTINGS:
        value = getattr(settings, s.name)
        out.append({
            "name": s.name, "env": s.env, "label": s.label, "group": s.group, "help": s.help,
            "type": s.type.__name__, "choices": list(s.choices), "min": s.min, "max": s.max,
            "secret": s.secret, "default": None if s.secret else s.default,
            "value": None if s.secret else value,
            "hint": _hint(value) if s.secret else None,
            "is_set": value not in (None, ""),
            "source": settings.source(s.name),
            "updated_at": saved.get(s.name, {}).get("updated_at"),
            "updated_by_name": saved.get(s.name, {}).get("updated_by_name"),
        })
    return out


@router.put("/system/settings/{name}")
def save_setting(name: str, body: SettingIn, request: Request, conn=Depends(get_conn)):
    s = BY_NAME.get(name)
    if not s:
        raise not_found("Setting")
    if not body.value.strip():
        raise bad_request("Empty value: use Reset to go back to the server environment / default")
    try:
        value = convert(s, body.value)
    except ValueError as exc:
        raise bad_request(str(exc))
    conn.execute(
        """INSERT INTO app_settings (key, value, updated_by) VALUES (%s, %s, %s)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by""",
        (name, str(value), request.state.staff["id"]),
    )
    conn.commit()
    settings.reload()
    log.info("setting %s changed by staff %s", s.env, request.state.staff["id"])  # never the value
    return {"ok": True}


@router.delete("/system/settings/{name}", status_code=204)
def reset_setting(name: str, request: Request, conn=Depends(get_conn)):
    if name not in BY_NAME:
        raise not_found("Setting")
    conn.execute("DELETE FROM app_settings WHERE key = %s", (name,))
    conn.commit()
    settings.reload()
    log.info("setting %s reset by staff %s", BY_NAME[name].env, request.state.staff["id"])
