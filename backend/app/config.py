import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _read_text(path: Path, default: str) -> str:
    try:
        return path.read_text(encoding="utf-8").strip() or default
    except OSError:
        return default


log = logging.getLogger("carbonara.config")


# --------------------------------------------------------------------------- #
# Settings that a super-admin can change on the System page. Each one is read
# from (1) the value saved in the database (app_settings), else (2) the server
# environment (.env / Portainer stack), else (3) the default here.
# To add a setting later: add one Setting(...) line and use settings.<name>.
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class Setting:
    name: str            # attribute: settings.<name>; env var is NAME upper-cased
    label: str
    group: str
    type: type = str     # str | int | float
    default: object = ""
    secret: bool = False  # never sent to the browser (only the last 4 characters)
    help: str = ""
    choices: tuple = ()
    min: float | None = None
    max: float | None = None

    @property
    def env(self) -> str:
        return self.name.upper()


SETTINGS: tuple[Setting, ...] = (
    # Statens vegvesen – "Enkeltoppslag kjøretøydata"
    Setting("vegvesen_api_key", "API key", "Statens vegvesen", secret=True,
            help="Key for 'API for tekniske kjøretøyopplysninger' (apply at vegvesen.no)."),
    Setting("vegvesen_sync_days", "Re-sync registered cars every (days)", "Statens vegvesen", int, 7, min=1, max=365),
    Setting("vegvesen_api_url", "API address", "Statens vegvesen",
            default="https://akfell-datautlevering.atlas.vegvesen.no/enkeltoppslag/kjoretoydata",
            help="Only change if Statens vegvesen changes their API."),
    Setting("vegvesen_auth_header", "Auth header name", "Statens vegvesen", default="SVV-Authorization"),
    Setting("vegvesen_auth_scheme", "Auth scheme", "Statens vegvesen", default="Apikey"),
    Setting("vegvesen_call_interval_s", "Pause between API calls (seconds)", "Statens vegvesen", float, 1.5, min=0, max=60),
    # Outgoing e-mail
    Setting("smtp_host", "Mail server (SMTP host)", "E-mail",
            help="Empty = not set up; staff send from their own e-mail app. Gmail: smtp.gmail.com"),
    Setting("smtp_port", "Port", "E-mail", int, 587, min=1, max=65535),
    Setting("smtp_security", "Security", "E-mail", default="starttls", choices=("starttls", "ssl", "none"),
            help="starttls for port 587, ssl for port 465."),
    Setting("smtp_user", "Username", "E-mail"),
    Setting("smtp_password", "Password", "E-mail", secret=True, help="Gmail: an app password, not the normal password."),
    Setting("smtp_from", "Sender", "E-mail", help='e.g. Moss AutoCenter <post@example.no>'),
    # Company (privacy notice, PDI e-mails, storage reports)
    Setting("privacy_company", "Company name", "Company", default="Moss AutoCenter",
            help="Shown on the privacy notice, PDI e-mails and storage reports."),
    Setting("dealer_number", "Dealer number (Forh. nr.)", "Company",
            help="Printed on the storage maintenance report."),
    Setting("privacy_contact", "Contact for customers", "Company",
            help="E-mail and/or phone shown to test drive customers on the privacy notice."),
    # Data retention
    Setting("trash_days", "Keep deleted data (days)", "Data retention", int, 30, min=1, max=3650,
            help="Recently deleted cars and returned test drive customers."),
    Setting("retention_years", "Delete inactive off-site cars after (years)", "Data retention", int, 5, min=0, max=100,
            help="0 = never."),
)
BY_NAME = {s.name: s for s in SETTINGS}
CACHE_SECONDS = 20


def convert(s: Setting, raw):
    """Text -> the setting's type; raises ValueError with a readable message."""
    if s.type is str:
        value = str(raw).strip()
        if s.choices and value not in s.choices:
            raise ValueError(f"{s.label}: choose one of {', '.join(s.choices)}")
        return value
    try:
        value = s.type(str(raw).strip().replace(",", "."))
    except ValueError:
        raise ValueError(f"{s.label}: not a number")
    if (s.min is not None and value < s.min) or (s.max is not None and value > s.max):
        raise ValueError(f"{s.label}: must be between {s.min:g} and {s.max:g}")
    return value


class Settings:
    # Bump VERSION (repo root) for each release; BUILD_TIME is stamped by the
    # Dockerfile so two builds of the same version can be told apart.
    version = _read_text(ROOT / "VERSION", "dev")
    build_time = _read_text(ROOT / "BUILD_TIME", "")

    # Fixed at start (environment only).
    database_url = os.environ.get(
        "DATABASE_URL", "postgresql://carbonara:carbonara@localhost:5432/carbonara"
    )
    photo_dir = Path(os.environ.get("PHOTO_DIR", ROOT / "data" / "photos"))
    frontend_dir = Path(os.environ.get("FRONTEND_DIR", ROOT / "frontend"))
    migrations_dir = Path(__file__).resolve().parents[1] / "migrations"
    max_upload_bytes = int(os.environ.get("MAX_UPLOAD_MB", "30")) * 1024 * 1024

    def __init__(self):
        self._db: dict[str, str] = {}
        self._loaded = 0.0
        self._lock = threading.Lock()

    def _saved(self) -> dict[str, str]:
        """Values saved on the System page, cached for CACHE_SECONDS (API and worker)."""
        if time.monotonic() - self._loaded > CACHE_SECONDS:
            with self._lock:
                if time.monotonic() - self._loaded > CACHE_SECONDS:
                    try:
                        import psycopg

                        with psycopg.connect(self.database_url, connect_timeout=3) as conn:
                            self._db = dict(conn.execute("SELECT key, value FROM app_settings").fetchall())
                    except Exception as exc:  # table not there yet / DB down: keep what we had
                        log.debug("app_settings not read: %s", exc)
                    self._loaded = time.monotonic()
        return self._db

    def reload(self) -> None:
        self._loaded = 0.0

    def source(self, name: str) -> str:
        s = BY_NAME[name]
        if name in self._saved():
            return "saved"
        return "environment" if os.environ.get(s.env, "").strip() != "" else "default"

    def __getattr__(self, name: str):
        s = BY_NAME.get(name)
        if s is None:
            raise AttributeError(name)
        saved = self._saved()
        for raw in (saved.get(name), os.environ.get(s.env)):
            if raw is not None and str(raw).strip() != "":
                try:
                    return convert(s, raw)
                except ValueError:
                    log.warning("ignoring invalid value for %s", s.env)
        return s.default


settings = Settings()