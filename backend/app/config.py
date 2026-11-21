import logging
import os
import re
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
# Settings that a system admin can change on the System page. Each one is read
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
    pattern: str = ""        # str settings: the whole value must match (re.fullmatch)
    pattern_error: str = ""

    @property
    def env(self) -> str:
        return self.name.upper()


# An IPv4 address or a host name (letters, digits, hyphens, dots); no scheme, port or path.
HOST_PATTERN = r"(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*"

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
    Setting("smtp_from", "Sender", "E-mail", help='e.g. Company name <post@example.com>'),
    # Company (privacy notice, PDI e-mails, storage reports)
    Setting("privacy_company", "Company name", "Company",
            help="Shown on the privacy notice, PDI e-mails and storage reports."),
    Setting("dealer_number", "Dealer number (Forh. nr.)", "Company",
            help="Printed on the storage maintenance report."),
    # Contact details shown to test drive customers on the privacy notice (each on its own line).
    Setting("privacy_contact", "Phone for customers", "Company",
            help="Shown to test drive customers on the privacy notice."),
    Setting("privacy_email", "E-mail for customers", "Company",
            help="Shown to test drive customers on the privacy notice."),
    Setting("privacy_address", "Postal address", "Company",
            help="Shown on the privacy notice: street, postcode and town."),
    # The delivery kiosk's privacy notice can name another company (e.g. the workshop).
    # Used only when delivery_company is set; otherwise the Company group above applies.
    Setting("delivery_company", "Company name", "Customer deliveries (kiosk)",
            help="Responsible for the data on the kiosk's privacy notice. Empty = the Company details above are used."),
    Setting("delivery_phone", "Phone for customers", "Customer deliveries (kiosk)",
            help="Shown on the kiosk's privacy notice."),
    Setting("delivery_email", "E-mail for customers", "Customer deliveries (kiosk)",
            help="Shown on the kiosk's privacy notice."),
    Setting("delivery_address", "Postal address", "Customer deliveries (kiosk)",
            help="Shown on the kiosk's privacy notice."),
    # Same for the rental cars' privacy notice (the rental business can be another company).
    Setting("rental_company", "Company name", "Rental cars",
            help="Responsible for the data on the rental privacy notice. Empty = the Company details above are used."),
    Setting("rental_phone", "Phone for customers", "Rental cars",
            help="Shown on the rental privacy notice."),
    Setting("rental_email", "E-mail for customers", "Rental cars",
            help="Shown on the rental privacy notice."),
    Setting("rental_address", "Postal address", "Rental cars",
            help="Shown on the rental privacy notice."),
    # Summer / winter wheels warnings (common.tyre_warning)
    Setting("tyre_region", "Studded tyre region", "Wheels", default="south", choices=("south", "north"),
            help="The studded tyre season for the summer / winter wheels warnings. South and Central Norway: "
                 "1 November to the first Sunday after Easter Monday. Nordland, Troms and Finnmark: "
                 "16 October to 30 April."),
    # Recalls (routers/recalls.py): how often a car in storage is due for a new recall check.
    Setting("recall_check_days", "Check cars in storage for recalls every (days)", "Recalls", int, 30, min=1, max=365,
            help="Also checked after the arrival inspection and when a PDI is booked. Only cars whose make has a "
                 "recall source (Settings → Recall sources) are checked."),
    # HTTPS: the address staff type at this location; the caddy container makes its certificate for it
    # (caddyhost.py → caddy/start.sh). Saved here, it survives redeploys; the env var is the stack fallback.
    Setting("carbonara_host", "Server address", "HTTPS", pattern=HOST_PATTERN,
            pattern_error="type an IP address (e.g. 192.168.1.20) or a host name, without http:// or a port",
            help="The address staff type to open Carbonara here, e.g. the server's IP address. The HTTPS "
                 "certificate is made for it. A change takes effect within half a minute; installed "
                 "certificates keep working."),
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
        if s.pattern and value and not re.fullmatch(s.pattern, value):
            raise ValueError(f"{s.label}: {s.pattern_error or 'not valid'}")
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
    # HTTPS (the caddy service): its port, and its local root certificate (caddy_data, mounted read-only).
    https_port = int(os.environ.get("HTTPS_PORT", "8443") or 8443)
    ca_root = Path(os.environ.get("CA_ROOT", "/caddy-data/caddy/pki/authorities/local/root.crt"))

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