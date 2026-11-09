import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .db import pool
from .migrate import run_migrations
from .auth import require_staff
from .routers import (admin, dashboard, inspections, pdi, session, storage_care, system, testdrives, vehicles,
                      vin)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    run_migrations()
    settings.photo_dir.mkdir(parents=True, exist_ok=True)
    pool.open(wait=True, timeout=30)
    yield
    pool.close()


app = FastAPI(title="Carbonara", version=settings.version, lifespan=lifespan)

# Everything under /api needs a logged-in staff member, except login itself
# and health/version (used for monitoring and the footer).
app.include_router(session.router, prefix="/api")
for module in (admin, vin, inspections, vehicles, testdrives, pdi, dashboard, system, storage_care):
    app.include_router(module.router, prefix="/api", dependencies=[Depends(require_staff)])


@app.get("/api/health", tags=["meta"])
def health():
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok", "version": settings.version}


@app.get("/api/version", tags=["meta"])
def version():
    return {"version": settings.version, "build_time": settings.build_time or None}


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
