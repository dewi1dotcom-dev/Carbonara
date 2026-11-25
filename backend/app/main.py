import io
import logging
import re
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from .config import settings
from .db import pool
from .migrate import run_migrations
from . import caddyhost, push
from .auth import require_staff
from .routers import (admin, customers, dashboard, deliveries, dm, documents, from_ad, hours, inspections, market,
                      messages, notes, notifications, parts, parts_orders, pdi, pdi_sheets, recalls, rentals, session,
                      storage_care, system, testdrives, vehicle_photos, vehicles, vin, work_orders)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    run_migrations()
    settings.photo_dir.mkdir(parents=True, exist_ok=True)
    pool.open(wait=True, timeout=30)
    caddyhost.write()  # the HTTPS server address from the System page, for the caddy container
    push.start()  # sends queued phone notifications and makes the scheduled ones (app/push.py)
    yield
    push.stop()
    pool.close()


app = FastAPI(title="Carbonara", version=settings.version, lifespan=lifespan)

# Everything under /api needs a logged-in staff member, except login itself,
# health/version (used for monitoring and the footer) and the delivery kiosk
# form (/api/kiosk/…: a kiosk tablet or staff, checked per route).
app.include_router(session.router, prefix="/api")
app.include_router(deliveries.kiosk_router, prefix="/api")
for module in (admin, vin, inspections, vehicles, testdrives, rentals, pdi, pdi_sheets, dashboard, system, storage_care,
               documents, deliveries, messages, dm, notifications, notes, recalls, vehicle_photos, from_ad,
               market, parts, customers, parts_orders, hours, work_orders):
    app.include_router(module.router, prefix="/api", dependencies=[Depends(require_staff)])


@app.get("/api/health", tags=["meta"])
def health():
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok", "version": settings.version}


@app.get("/api/version", tags=["meta"])
def version():
    # https_port: set once HTTPS is ready, so a device opened over plain HTTP can try https:// (app.js).
    return {"version": settings.version, "build_time": settings.build_time or None,
            "https_port": settings.https_port if settings.ca_root.is_file() else None}


# The root certificate of Caddy's local certificate authority (the caddy service, HTTPS). Public by
# nature: each device installs it once so https:// opens without warnings. Open without login, also
# over plain HTTP, since a device without it can't use https:// yet. (Never the private key.)
@app.get("/carbonara-ca.crt", include_in_schema=False)
def ca_root():
    if not settings.ca_root.is_file():
        raise HTTPException(404, "HTTPS is not set up on this server yet")
    return FileResponse(settings.ca_root, media_type="application/x-x509-ca-cert", filename="carbonara-ca.crt",
                        headers={"Cache-Control": "no-cache"})


# Carbonara Sidekick (a Chrome extension, addons/sidekick; the "recall helper" until 0.44) as a zip to unpack and
# load in Chrome. Open without login like the certificate: it holds no data or secrets, only the extension's code.
# The old address still gives the same zip.
_ADDONS = Path(__file__).resolve().parents[2] / "addons"


@app.get("/addons/sidekick.zip", include_in_schema=False)
@app.get("/addons/recall-helper.zip", include_in_schema=False)
def sidekick_zip():
    folder = _ADDONS / "sidekick"
    if not folder.is_dir():
        raise HTTPException(404, "Not found")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(folder.rglob("*")):
            if f.is_file():
                z.write(f, f"carbonara-sidekick/{f.relative_to(folder).as_posix()}")
    return Response(buf.getvalue(), media_type="application/zip", headers={
        "Content-Disposition": 'attachment; filename="carbonara-sidekick.zip"', "Cache-Control": "no-store"})


# --------------------------------------------------------------------------- #
# Frontend. JS/CSS are served under a per-build path (/v/<build>/js/app.js) so a
# browser can never run old code after a deploy: some (Opera Touch) kept a
# cached app.js despite revalidation headers. ES-module imports are relative,
# so every module loaded by app.js gets the same build path.
# --------------------------------------------------------------------------- #
BUILD_TAG = re.sub(r"[^0-9A-Za-z.-]", "", f"{settings.version}-{settings.build_time or 'dev'}") or "dev"
_FRONTEND = Path(settings.frontend_dir).resolve()


def _index_html() -> str:
    html = (_FRONTEND / "index.html").read_text(encoding="utf-8")
    return (html.replace('src="/js/app.js"', f'src="/v/{BUILD_TAG}/js/app.js"')
                .replace('href="/css/app.css"', f'href="/v/{BUILD_TAG}/css/app.css"'))


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def index():
    return HTMLResponse(_index_html(), headers={"Cache-Control": "no-cache"})


@app.get("/v/{tag}/{path:path}", include_in_schema=False)
def versioned_asset(tag: str, path: str):
    """Any build tag serves the current files; the URL only has to change per build."""
    file = (_FRONTEND / path).resolve()
    if not file.is_relative_to(_FRONTEND) or not file.is_file():
        raise HTTPException(404, "Not found")
    cache = "public, max-age=31536000, immutable" if tag == BUILD_TAG else "no-cache"
    return FileResponse(file, headers={"Cache-Control": cache})


class FrontendFiles(StaticFiles):
    """Static frontend that browsers must revalidate on every load.

    Without a Cache-Control header browsers cache JS/CSS heuristically, so
    after a redeploy they kept running old code until a hard refresh.
    "no-cache" still allows caching, but the browser checks the ETag first
    (a cheap 304 when nothing changed).
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


# Frontend (must be mounted last so /api routes win).
app.mount("/", FrontendFiles(directory=settings.frontend_dir, html=True), name="frontend")
