"""System settings (system admins): values saved here override the server
environment. Secrets are write-only: only their last 4 characters are shown."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from ..auth import MENU_ITEMS, require_superadmin
from ..common import bad_request, conflict, not_found
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


# --------------------------------------------------------------------------- #
# Teams: which top menu items each team sees (auth.menu_for)
# --------------------------------------------------------------------------- #

class TeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    menu: list[str] = Field(default_factory=list, max_length=20)


class TeamPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    menu: Optional[list[str]] = Field(None, max_length=20)


class TeamMemberIn(BaseModel):
    team_id: Optional[int] = None  # null = no team (Today only)


def _team_name(conn, raw: str, team_id: Optional[int] = None) -> str:
    name = " ".join((raw or "").split())
    if not name:
        raise bad_request("Give the team a name")
    if conn.execute("SELECT 1 FROM teams WHERE lower(name) = lower(%s) AND id IS DISTINCT FROM %s",
                    (name, team_id)).fetchone():
        raise conflict(f"There is already a team called {name}")
    return name


def _menu(items: list[str]) -> list[str]:
    unknown = [m for m in items if m not in MENU_ITEMS]
    if unknown:
        raise bad_request(f"Unknown menu item: {', '.join(unknown)}")
    return [m for m in MENU_ITEMS if m in items]  # menu order, no duplicates


@router.get("/system/teams")
def list_teams(conn=Depends(get_conn)):
    """Teams with their members, and every active user (with their team) for the pickers."""
    teams = conn.execute("SELECT id, name, menu, created_at FROM teams ORDER BY lower(name)").fetchall()
    staff = conn.execute(
        "SELECT id, name, team_id, is_admin, is_superadmin FROM staff "
        "WHERE deleted_at IS NULL AND active ORDER BY name").fetchall()
    for t in teams:
        t["members"] = [s for s in staff if s["team_id"] == t["id"]]
    return {"items": list(MENU_ITEMS), "teams": teams, "staff": staff}


@router.post("/system/teams", status_code=201)
def add_team(body: TeamIn, request: Request, conn=Depends(get_conn)):
    row = conn.execute("INSERT INTO teams (name, menu, created_by) VALUES (%s, %s, %s) RETURNING id",
                       (_team_name(conn, body.name), _menu(body.menu), request.state.staff["id"])).fetchone()
    log.info("team %s created by staff %s", row["id"], request.state.staff["id"])
    return row


@router.patch("/system/teams/{team_id}")
def patch_team(team_id: int, body: TeamPatch, request: Request, conn=Depends(get_conn)):
    team = conn.execute("SELECT * FROM teams WHERE id = %s FOR UPDATE", (team_id,)).fetchone()
    if not team:
        raise not_found("Team")
    name = _team_name(conn, body.name, team_id) if body.name is not None else team["name"]
    menu = _menu(body.menu) if body.menu is not None else team["menu"]
    conn.execute("UPDATE teams SET name = %s, menu = %s WHERE id = %s", (name, menu, team_id))
    log.info("team %s changed by staff %s: menu %s", team_id, request.state.staff["id"], menu)
    return {"ok": True}


@router.delete("/system/teams/{team_id}", status_code=204)
def delete_team(team_id: int, request: Request, conn=Depends(get_conn)):
    """Its members are left without a team (Today only) until placed in another."""
    if not conn.execute("DELETE FROM teams WHERE id = %s RETURNING id", (team_id,)).fetchone():
        raise not_found("Team")
    log.info("team %s deleted by staff %s", team_id, request.state.staff["id"])


@router.put("/system/staff/{staff_id}/team")
def set_staff_team(staff_id: int, body: TeamMemberIn, request: Request, conn=Depends(get_conn)):
    if body.team_id is not None and not conn.execute("SELECT 1 FROM teams WHERE id = %s",
                                                     (body.team_id,)).fetchone():
        raise not_found("Team")
    if not conn.execute("UPDATE staff SET team_id = %s WHERE id = %s AND deleted_at IS NULL RETURNING id",
                        (body.team_id, staff_id)).fetchone():
        raise not_found("Staff member")
    log.info("staff %s moved to team %s by staff %s", staff_id, body.team_id, request.state.staff["id"])
    return {"ok": True}
