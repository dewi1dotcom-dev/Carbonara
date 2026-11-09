import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .config import settings
from .db import pool
from .migrate import run_migrations
from .routers import admin, inspections, vehicles, vin

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    run_migrations()
    settings.photo_dir.mkdir(parents=True, exist_ok=True)
    pool.open(wait=True, timeout=30)
    yield
    pool.close()


app = FastAPI(title="Carbonara", version=settings.version, lifespan=lifespan)

for module in (admin, vin, inspections, vehicles):
    app.include_router(module.router, prefix="/api")


@app.get("/api/health", tags=["meta"])
def health():
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok", "version": settings.version}


@app.get("/api/version", tags=["meta"])
def version():
    return {"version": settings.version, "build_time": settings.build_time or None}


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
