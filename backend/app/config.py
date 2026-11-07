import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _read_text(path: Path, default: str) -> str:
    try:
        return path.read_text(encoding="utf-8").strip() or default
    except OSError:
        return default


class Settings:
    # Bump VERSION (repo root) for each release; BUILD_TIME is stamped by the
    # Dockerfile so two builds of the same version can be told apart.
    version = _read_text(ROOT / "VERSION", "dev")
    build_time = _read_text(ROOT / "BUILD_TIME", "")

    database_url = os.environ.get(
        "DATABASE_URL", "postgresql://carbonara:carbonara@localhost:5432/carbonara"
    )
    photo_dir = Path(os.environ.get("PHOTO_DIR", ROOT / "data" / "photos"))
    frontend_dir = Path(os.environ.get("FRONTEND_DIR", ROOT / "frontend"))
    migrations_dir = Path(__file__).resolve().parents[1] / "migrations"
    max_upload_bytes = int(os.environ.get("MAX_UPLOAD_MB", "30")) * 1024 * 1024

    # Statens vegvesen – "Enkeltoppslag kjøretøydata". Used only for vehicles
    # that sales has marked as registered. URL/header are configurable in case
    # Vegvesen changes them.
    vegvesen_api_key = os.environ.get("VEGVESEN_API_KEY", "").strip()
    vegvesen_api_url = os.environ.get(
        "VEGVESEN_API_URL",
        "https://akfell-datautlevering.atlas.vegvesen.no/enkeltoppslag/kjoretoydata",
    )
    vegvesen_auth_header = os.environ.get("VEGVESEN_AUTH_HEADER", "SVV-Authorization")
    vegvesen_auth_scheme = os.environ.get("VEGVESEN_AUTH_SCHEME", "Apikey")
    # How often registered vehicles are re-synced (EU-kontroll dates, plates, status).
    vegvesen_sync_days = int(os.environ.get("VEGVESEN_SYNC_DAYS", "7"))
    # Pause between API calls in the background worker (be nice to the quota).
    vegvesen_call_interval_s = float(os.environ.get("VEGVESEN_CALL_INTERVAL_S", "1.5"))


settings = Settings()
