# CLAUDE.md — Carbonara

Vehicle lifecycle system for the car dealership **Moss AutoCenter** (Norway). Part 1 is in
production: arrival inspection → storage, Statens vegvesen (SVV) registry data, VIN and plate
OCR, service tracking and data retention. The UI is in English; dates, times and number
formats are Norwegian.

> **Keep this file current.** Update it at every big milestone, meaning a minor version
> bump (0.x.0), a new migration, a new subsystem or a changed workflow. Add the milestone
> to the table at the bottom and fix any section that no longer matches the code.

---

## Working with the user

- The user's own Carbonara account is **Supern** (system admin). "Andy" is a different person
  (a regular admin).

- **Commit and push only when the user says so** ("commit and push"). Never commit on your own.
- Every change bumps `VERSION` (patch for fixes and small features, minor for larger ones).
  The footer shows version + build time, and the user checks it after redeploying.
- The user deploys by pulling in **Portainer** and redeploying the stack, then says
  "up and running". After that, verify against the live server (see *Testing*), then report
  in a short table: what passed, what still needs a browser check.
- The user reports UI bugs with screenshots. Staff use Chrome and **Opera Touch** on phones.
  - **Cache-busting (0.10.2):** `main.py` serves `index.html` itself (no-cache) and
    rewrites `/js/app.js` and `/css/app.css` to `/v/<BUILD_TAG>/…` (immutable). Every
    deploy therefore gets new URLs, and relative ES-module imports inherit the build path.
  - Opera Touch kept a stale `app.js` even with `no-cache` (the result was "Not found" for
    a new route).
  - **Keep all frontend imports relative,** and reference JS/CSS from `index.html` only.
  - If a screenshot shows old UI, compare the footer version with `/api/version`.
- Explain in plain language. The user is the dealership's own IT person, not a full-time developer.

## SECURITY — the Vegvesen API key

The real SVV key must **never** be committed. It belongs only in the server's `.env` or in
the Portainer stack environment as `VEGVESEN_API_KEY`. `.env.example` keeps it empty.
**Before every commit, run** (the regex matches the real key but not this line itself):

```powershell
git grep --cached -nE "ca4ae1c6-?dcbb"   # must print nothing (exit code 1 = clean)
```

---

## Deployment

| Thing | Value |
|---|---|
| Server | `192.168.10.45`, Ubuntu + Docker, managed via Portainer |
| App URL | `http://192.168.10.45:8080` (port **8080**; 8000 on the host is taken by Portainer) |
| Repo | GitHub, branch `main` (git user `dewi1dotcom-dev`) |
| Containers | `db` (postgres:16), `app` (uvicorn on container port 8000 → host `APP_PORT`, default 8080), `worker` (`python -m app.sync_worker`) |
| Photos | `./data/photos` mounted at `/data/photos` in **both** `app` and `worker` (the worker deletes photo files during retention) |
| Timezone | `TZ=Europe/Oslo` on all containers |

Environment variables (see `.env.example` and `docker-compose.yml`): `POSTGRES_PASSWORD`,
`APP_PORT=8080`, `MAX_UPLOAD_MB=30`, `VEGVESEN_API_KEY`, `VEGVESEN_API_URL`,
`VEGVESEN_AUTH_HEADER=SVV-Authorization`, `VEGVESEN_AUTH_SCHEME=Apikey`,
`VEGVESEN_SYNC_DAYS=7`, `TRASH_DAYS=30`, `RETENTION_YEARS=5`, `PRIVACY_COMPANY=Moss AutoCenter`,
`PRIVACY_CONTACT=` (shown to test drive customers), `SMTP_HOST/PORT/USER/PASSWORD/FROM/SECURITY`
(outgoing e-mail; empty host = use the staff's own e-mail app).

## Build

The dev machine is Windows 10 with **PowerShell 5.1**. Docker and Node are **not**
installed locally, so the real build happens on the server.

```bash
# On the server (or anywhere with Docker)
cp .env.example .env              # set POSTGRES_PASSWORD (+ VEGVESEN_API_KEY)
docker compose up -d --build
docker compose logs -f app        # wait for "Application startup complete"
```

Dockerfile notes. These were learned the hard way, so don't undo them:
- `pip install -r backend/requirements.txt`, **then**
  `pip install --no-deps rapidocr-onnxruntime==1.3.24`, then an import check
  (`import rapidocr_onnxruntime, cv2, onnxruntime`) that fails the build early.
  RapidOCR's own dependency list pulls in the GUI `opencv-python` and numpy 2.
- **numpy must stay at 1.26.4 (< 2).** Use `opencv-python-headless`, never `opencv-python`.
- System packages: `tesseract-ocr libzbar0 libdmtx0b`.
- `BUILD_TIME` is stamped in ISO UTC at build time; `VERSION` is copied in. Both are served at `/api/version`.

## Testing

There is no automated test suite yet. Verification has two parts.

**1. Local static checks (before handing over a change):**

```powershell
cd backend; python -m py_compile app/main.py app/common.py app/schemas.py app/vinlib.py app/vegvesen.py app/sync_worker.py app/routers/*.py; if ($?) { "compiles" }
cd backend; python -c "from app.config import settings; print(settings.version)"
```
Python and Node may both be missing on the dev PC (Python was gone as of 0.9.4). If
`python` is not found, say so and rely on careful reading plus the live checks. JS cannot be
syntax-checked locally because Node isn't installed. Re-read edited JS carefully,
especially calls to `append` / `replaceChildren` (see pitfalls).

**2. Live checks after the user redeploys.** From 0.11.0 every `/api` route except
`/api/health`, `/api/version` and `/api/auth/*` needs a login cookie. For authenticated checks,
log in with a test account the user has given you (`POST /api/auth/login`, keep the cookie
via `curl.exe -c/-b`), or ask the user to test in the browser. Never ask for a real staff
member's PIN.
- The user created a staff account **"Claude"** (staff id 5, admin) for these checks. The PIN
  was given in chat; never write it into the repo. If it doesn't work, ask the user.
- Use a cookie jar in the scratchpad. After testing a wrong PIN, log in correctly once to
  reset the failure counter.

```powershell
Invoke-RestMethod http://192.168.10.45:8080/api/version      # {version, build_time}
Invoke-RestMethod http://192.168.10.45:8080/api/health
Invoke-RestMethod "http://192.168.10.45:8080/api/vehicles?q=LJ%2077892"
Invoke-RestMethod http://192.168.10.45:8080/api/vin/JF1BS9LC2KG171677   # decode + "similar" duplicates
Invoke-RestMethod http://192.168.10.45:8080/api/retention
# OCR on a photo (use curl.exe, not the PowerShell curl alias):
curl.exe -s -F "file=@C:\path\photo.png;type=image/png" http://192.168.10.45:8080/api/vin/recognize
```

The OCR regression set was 35 user photos (VIN plates, windscreen VINs, door labels, plates
and a personalised Tesla plate), and the result was **34 of 35**. The one miss, a tiny Subaru
door label, is accepted. Those photos lived in a session temp folder and are gone. Ask the
user for them again before changing `vinlib.py`, and re-run the whole set after any OCR change.

Don't write test data to the live database without asking, because it is production data.

---

## Architecture

```
backend/
  app/main.py           FastAPI app, static frontend, /api/health, /api/version
  app/config.py         settings from env (version, build_time, vegvesen_*, trash_days, retention_years)
  app/db.py             psycopg3 ConnectionPool, dict_row; get_conn = one transaction per request
  app/migrate.py        applies backend/migrations/NNN_*.sql in order on startup
  app/common.py         shared helpers: errors, patch_fields/update_row, log_event, place_in_location,
                        similar_vehicles, soft_delete_vehicle, purge_vehicle, RETENTION_DUE_SQL,
                        add_years, service_due (SERVICE_WINDOW_DAYS=31)
  app/schemas.py        Pydantic models (VehicleDetails, IntakeIn, MoveIn, RepairIn, LocationIn/Patch…)
  app/vegvesen.py       SVV fetch/extract/compare/resolve, sync_vehicle, due_vehicle_ids_sql
  app/vinlib.py         VIN rules (ISO 3779/3780), WMI table, check digit, RapidOCR + Tesseract,
                        plate parsing, recognize_all
  app/photostore.py     original + 1600px + 400px JPEG
  app/sync_worker.py    registry re-sync loop + housekeeping() once every 24 h
  app/mailer.py         SMTP sending (PDI orders)
  app/auth.py           PIN login, sessions, require_staff / require_admin
  app/routers/          vehicles.py, inspections.py, vin.py, admin.py, testdrives.py, session.py (login),
                        pdi.py, dashboard.py, system.py (system admin settings), storage_care.py
  app/storagecare.py    MG storage programme: checklist items, schedule
  migrations/           001…008 (see below)
frontend/               no build step; plain ES modules
  index.html, css/app.css, js/app.js (hash router), js/ui.js (helpers), js/diagram.js
  js/views/             today (start page), dashboard (= arrivals list), intake, inspection, vehicles,
                        pdi (card on vehicle page), storage, testdrive, login, settings
```

Migrations: `001_initial`, `002_vegvesen_registry`, `003_registry_confirm` (kept_values,
vin_source 'registry'), `004_spot_capacity` (multi-car spots), `005_sub_zones` (parent_id +
`storage_spots` view), `006_service_and_condition` (condition, last_service_date/km, reg.
numbers normalized), `007_soft_delete` (deleted_at/by/reason), `008_finn_link` (finn_code),
`009_test_drives` (test_drives table), `010_login_and_privacy`, `011_pdi_orders`,
`012_system_settings`, `013_delete_spots`, `014_storage_care`, `015_void_storage_checks`,
`016_language`.
**New schema changes = a new numbered file. Never edit an applied migration.**

Frontend routes: `#/` dashboard, `#/intake`, `#/inspections/:id`, `#/vehicles`,
`#/vehicles/:id`, `#/vehicles/deleted`, `#/storage`, `#/storage/:id|off-site`,
`#/test-drive`, `#/test-drive/new/:vehicleId` (start form with the car preselected), `#/settings`,
`#/system` (system admins), `#/arrivals`, `#/vehicles/:id/storage-report` (printable).

## Domain rules (the nuance)

**Registration numbers** are stored and sent **without spaces**, in uppercase (`EB82655`).
Search accepts spaces. Standard Norwegian plates are 2 letters + 4–5 digits. Personalised
plates exist and are offered as "custom".

**VIN (ISO 3779/3780):**
- 17 characters, never I/O/Q.
- Position 1 is never `0`. Position 10 (model year) is never U/Z/0. Positions 14–17 are digits.
- The check digit (position 9) is **mandatory only** when position 1 is 1–5 (North America) or
  `L` (China). Elsewhere a mismatch is just a warning.
- Check-digit repair (a single look-alike swap) is only attempted where the check digit is mandatory.
- Make comes from the WMI table and model year from position 10 (`describe()`).

**OCR pipeline** (`vinlib.recognize_all`): RapidOCR passes run in this order: normal →
label-line strips (recognition-only, using long lines found as rulers) → zoom → rotated
±35°. Tesseract is the fallback.
- Plates: at most 2 letter→digit fixes; 6 digits with a leading 1 → drop the 1. Reject lines
  that contain lowercase letters.
- A single high-confidence VIN is auto-filled at arrival.
- Engines share a re-entrant lock (RLock), because one engine is built from inside another.

**Transport sheets (factory-new cars):** Norsk Biltransport puts a delivery sheet in each new
car. It has a big printed VIN, model ("MGS5"), dealer and a **QR code**. zbar decodes the QR
first (VIN, source `barcode`, high confidence, ~0.4 s), and the arrival screen auto-fills it.
From 0.10.4 the raw barcode text is included in `text` (`[barcode] …`) to see what else the
QR holds.

**Statens vegvesen API:** `GET {VEGVESEN_API_URL}?understellsnummer=<VIN>` or
`?kjennemerke=<REGNR>` with header `SVV-Authorization: Apikey <key>`.
- Prefer `kodeNavn` over `kodeBeskrivelse` (colour etc.).
- Many SVV fields are **lists**, e.g. `plasseringUnderstellsnummer` (LJ77892 has two: Instrumentpanel and Kupé - gulv høyre side). Don't take only `[0]` when all of them matter.
- Lookup happens at arrival (by VIN or reg. no). Mismatches with typed values need a
  confirmation prompt; the user picks per field (`accept_fields`, `kept_values`).
- The worker re-syncs registered cars every `VEGVESEN_SYNC_DAYS`.

**Status badges:** EU-kontroll and registration show amber within 60 days and **red from 1 day
before** the deadline. Service: green / amber (± 31 days) / red.

**Service due** (`common.service_due`):
- Last service + 1 year.
- New car → first registration + 1 year.
- Used car without history → next registration anniversary.
- At arrival, choosing *Used* reveals the last service date + km fields immediately
  (`serviceSlot` redraw). *New* needs no service history.

**Storage spots: rename & delete (0.12.1, migration 013):**
- **Rename:** any staff (`PATCH code`).
- **Delete:** admins only, `DELETE /storage-locations/{id}?move_to=`. A spot with cars (its
  own or in its sub-zones) needs `move_to`. Each car is moved with `place_in_location`
  (capacity is checked) and logged as `moved` with the note "Spot X deleted".
- **Never-used spots** are deleted for good. Spots with assignment history get `deleted_at`
  (and become inactive), so history keeps its reference.
- `storage_spots.deleted` hides them everywhere, and the unique code index ignores deleted
  spots, so their codes can be reused.

**Storage:** spots have a `capacity` (several cars per spot) and optional **sub-zones** (`parent_id`).
`place_in_location` locks the spot and checks capacity and sub-zone rules. "Off-site" means not
on a spot.

**Duplicates** (`common.similar_vehicles`): the same reg. no, or a VIN at Hamming distance 1
(computed in SQL with `generate_series`). These **warn, never block**. On the arrival screen the
warning offers "Use this VIN".

**Deletion & retention:**
- Delete is a **soft delete**: `deleted_at`, `deleted_by`, `deleted_reason`
  `'manual'|'retention'`, and the storage assignment ends. Deleted cars are excluded from every
  list, the registry sync and the duplicate checks.
- **Recently deleted** keeps cars for `TRASH_DAYS` (30). Restore goes back to the old spot if
  there's room, otherwise off-site.
- After that, `purge_vehicle` removes all rows and the photo files. Commit before deleting the files.
- **Retention:** off-site cars with no activity for `RETENTION_YEARS` (5) are soft-deleted
  automatically by the worker's daily `housekeeping()`.
- Starting an arrival for a VIN that sits in the trash purges the old record first.

**Test drives** (`routers/testdrives.py`, `views/testdrive.js`):
- Starting a drive needs the car, the customer's name and phone (8–15 digits, optional +) and
  a **driving licence photo**. Optional: items taken out of the car (presets; the spare
  **winter/summer wheels** are the most common), items put in (e.g. trade plates), an
  odometer reading and a note. It is one multipart POST.
- One active drive per car (partial unique index). A car that is out can't be deleted. The
  car's storage spot and status don't change during a drive.
- On return, staff tick every item back in place, or write a note about what's missing.
  Customer details then move to the **trash** (`customer_trashed_at`), are shown under
  "Returned — customer details in the trash" (for toll and speeding fines), and are wiped
  after `TRASH_DAYS` by the worker (`purge_test_drive_customer`). They can also be deleted
  right away.
- **Name from the licence** (`licenselib.py`, `POST /test-drives/read-license`):
  - The OCR finds the EU-format field labels `1.` (surname) and `2.` (given names), taking
    the text in the same box or the next box on the line. It tries 0°/90°/270°/180°.
  - The name is filled in as "Given Surname"; confidence is high only when both fields are
    read at ≥ 0.85. A name the staff typed is never overwritten.
  - The OCR model often **drops spaces** ("ANDERS STRANG" → "ANDERSSTRANG"). `_respace`
    straightens the box and finds ink column runs (one per letter). A gap ≥ max(0.45 ×
    median letter width, 2.2 × median letter gap) counts as a space. It is only used if the
    letters are unchanged, and it never cuts off a single letter. Test photo: user's own
    licence (THORKILDSEN / ANDERS STRANG); ask for it again if needed.
  - The photo is only read in memory. OCR text from licences is **not logged**
    (`scene_text(log_text=False)`).
- **Personal data never goes into `vehicle_events`.** The history only logs items, km and
  notes. Licence photos are served with `Cache-Control: no-store`. `purge_vehicle` also
  removes a car's test drives and licence files.

**Login & GDPR (0.11.0)** (`auth.py`, `routers/session.py`, `views/login.js`, migration 010):
- **Login:** a personal **PIN** (4–8 digits) per staff member, hashed with scrypt.
  - 5 wrong attempts lock the account for 15 min.
  - A login creates a session: a random token in the HttpOnly cookie `carbonara_session`,
    lasting 30 days. The DB only keeps its SHA-256.
- **Route protection:** every router except `session` is included with
  `dependencies=[Depends(require_staff)]`. Admin-only routes (staff create/patch/PIN) add
  `require_admin`.
- **First start:** while no active staff member has a PIN, the login screen runs **setup**,
  and the first person becomes admin. Admins then set PINs in Settings. Resetting a PIN also
  unlocks the account and logs out that person's devices.
- **PIN hashes never leave the server:** staff queries use `STAFF_PUBLIC`; never
  `SELECT * FROM staff` in a response.
- Staff pickers default to the logged-in user (`setInspectorId(me.id)` in `boot()`).
- **HTTPS is NOT set up** (the user chose to skip it for now), so the cookie has
  `secure=False`. When HTTPS comes, set `secure=True`.
- **Privacy for test drive customers (art. 13):**
  - A Norwegian notice (`privacyDialog` in `testdrive.js`, printable) shows `PRIVACY_COMPANY`
    and `PRIVACY_CONTACT` from the env.
  - Starting a drive requires `customer_informed`.
- **Full licence photo is kept on purpose (user's decision, 2026-11-09).** It includes field
  4d, the national identity number (fødselsnummer). The reason: identifying the driver
  securely to the police, Statens vegvesen, toll companies and insurers for fines, damage or
  theft (personopplysningsloven § 12). The notice tells the customer this. Do **not** add
  masking unless the user asks.
- **Access log:** `test_drive_access_log` records opening a licence photo in full (not
  thumbnails) and "Delete now". It's shown via "Access log" on returned drives.

**PDI orders (0.12.0)** (`routers/pdi.py`, `views/pdi.js`, `mailer.py`, migration 011):
- New cars get a PDI (Pre Delivery Inspection) at **RBV – Rygge Bilverksted**, a separate firm
  in the same building. The salesperson registers what the customer ordered on the car's
  **PDI order** card:
  - items from the list, some with a choice (floor mats: Gummi/Tekstil)
  - "Other" free text
  - winter tyres: none / in stock / ordered by sales (+ expected date) / RBV orders (+ tyre
    company)
- **Status:** draft → sent → booked (`pdi_at`) → done, or cancelled. There is one open order
  per car. Editing after sending shows "changed since sent".
- **E-mail to RBV:** plain text in Norwegian (`compose()`), with car info and the order.
  - Sent by SMTP if `SMTP_*` is set (it isn't yet).
  - Otherwise via **"Open in e-mail app"** (mailto) plus a "did you send it?" confirmation;
    `sent_via = mail_app`.
- **Recipients, items and tyre companies** are editable lists in Settings (`pdi_lists`;
  admins edit). **No e-mail addresses are built into code or migrations** (the user's rule).
  RBV's address and the user's test address are added in Settings. During testing the
  test address is the default; switch to RBV when going live.
- **RBV's reply** (date/time) is entered **manually** by staff ("Enter PDI date"). It is
  available on any open order, including unsent ones (dates are often agreed in person or by
  phone). A booked order that isn't sent shows a warning, and Today lists it under "not sent
  yet". RBV can't
  reach the server (local network; the user is unsure whether the companies' networks are
  connected). Automatic reply reading (IMAP) or a booking link are possible later.
- **Reminders are on the dashboard only** (the user's choice): "PDI tomorrow – make the car
  ready".

**System page & system admin (0.12.0)** (`config.py` `SETTINGS`, `routers/system.py`,
`views/system.js`, migration 012):
- **What can be changed:** server settings, edited at `#/system` (system admins only; the nav
  link is hidden for others). This covers the SVV API key/URL/sync days, SMTP, the privacy
  notice company/contact, and retention days/years.
- **Where a value comes from:** `settings.<name>` = the value saved in `app_settings` (DB),
  else the env var `NAME`, else the default.
  - Cached for 20 s per process, so the worker picks changes up too.
  - Always read settings at call time; never copy them into module constants.
- **To add a setting:** add one `Setting(...)` line to `SETTINGS`, then use `settings.<name>`.
- **Secrets** (`secret=True`) are write-only: the API only returns the last 4 characters. The
  log records who changed which key, never the value.
- **System admin:**
  - `staff.is_superadmin`. The person doing first-time setup becomes system admin. Migration
    012 made **Supern** (the user's own account) system admin, with a fallback to the
    lowest-id admin. **Andy is a regular admin.**
  - Only system admins can grant or remove system admin, or change another system admin. A
    system admin is always an admin.
- **The SVV key can now live in the DB** (entered on the System page) instead of the env.
  It still must never be committed to git.

**Storage maintenance for new cars (0.13.0)** (`storagecare.py`, `routers/storage_care.py`,
`views/storagecare.js`, migration 014). Source: MG bulletin **SI-GI2022102501** plus MG's
sheets (long-term storage, periodic checklist, 12V battery form).
- **Applies to all factory-new cars** (`condition = 'new'`) in storage, until the PDI is done
  (the user's choice: MG's list for all makes).
- **Schedule:** the arrival check, then periodic check *n* due *start + n months*. Every 6th
  is a 6-month check and every 3rd a 3-month check; larger checks include the smaller items.
  `start` = arrival check date, else first storage placement.
- **Items are per fuel type** (`ITEMS`; Norwegian labels, also printed): HV-battery steps for
  BEV/PHEV/FCEV, no "start the engine" for pure electric. Unknown fuel shows all items, with
  N/A allowed.
- **Rules (server-side):**
  - Every item must be answered OK / Not OK / N/A.
  - Tyres: one value plus "all four within 2.6–2.8" (the user's choice).
  - 12V below 12.5 V or tester not "Good" → action charged/replaced is required, plus the
    voltage after charging.
  - SOC below 30 % → "charged to ≥ 50 %" is required.
  - Anything not OK → remarks are required. The check is signed with the logged-in staff
    member and the time.
- **Reminders:** "Storage checks due" on Today (due ≤ 3 days, or overdue).
- **Printable report:** `#/vehicles/:id/storage-report`, in Norwegian A4. It has a header
  (company, **dealer number** from System → Company, VIN, model, colour, arrival, reg. date,
  spot, battery part number, arrival voltage), the arrival check, a periodic grid (max 6
  checks per table), MG's 12V battery form, remarks, and a signature/stamp box. "Only 12V
  battery form" prints that part alone (warranty claims).
- **Checks are never deleted** (they are warranty evidence). An admin can **cancel** one with
  a reason (`POST /storage-checks/{id}/void`, migration 015). A cancelled check:
  - no longer counts in the schedule (the next due date is recalculated)
  - stays in the report struck through ("ANNULLERT"), with a section "Annullerte kontroller"
    (who, when, why)
  - is logged as `storage_check_voided`
- **Printing:** with a dialog open, only the dialog prints; otherwise the page prints without
  topbar, footer and `.no-print` elements.

**Today board (0.12.0)** (`routers/dashboard.py`, `views/today.js`): the start page `#/`.
- Today/tomorrow: PDI tomorrow (warn), PDI today, PDI date passed, out on test drive,
  arrivals in progress.
- Needs attention: PDI orders waiting for reply, unsent drafts, EU-kontroll ≤ 60 days,
  service ≤ 31 days, SVV differences.
- Then upcoming PDIs and number tiles.
- The old arrivals start page moved to `#/arrivals` (`arrivalsView` in `dashboard.js`).
- One `/api/dashboard` call. Attention lists only cover cars that aren't off site.

**finn.no:** crawling finn.no is prohibited (robots.txt and terms). Staff paste the ad link or
FINN code (option C). The validator extracts 6–12 digits, and the link is
`https://www.finn.no/mobility/item/{code}`. The dealer's FINN org id is `1324692627`. A future
"Fetch from FINN" import needs the official FINN API (option A) or a feed from their ad
system (option B).

**Language: English and Norwegian (0.14.0)** (`frontend/js/i18n.js`, migration 016).
- **The rule:** no Norwegian words in the English version, and no English in the Norwegian
  version.
- **How it's chosen:** per user (`staff.language`, default `en`), switched under their name
  at the top (`POST /api/auth/language`), and saved in localStorage too. Before login it
  follows the device, with a switch on the login screen.
- **How it works:** the code is written in English. `startTranslator()` translates every text
  node and the placeholder/title/aria-label attributes as they are rendered (a
  MutationObserver), and `confirm`/`prompt`/`alert` are wrapped.
  - `NO` holds exact texts. `NO_PATTERNS` holds texts with values: `{}` = any text,
    `{n}` = a number, and `{1t}` in the target also translates that part.
  - Server messages (English) are translated the same way when they reach the page.
  - `EN` translates the few Norwegian texts Carbonara uses itself (storage checklist labels,
    battery results, winter-tyre options) when English is chosen. Use `tr()` when such a
    text is joined into a longer string.
- **Not translated (the user's choices):**
  - **documents are always Norwegian:** the PDI e-mail, the customer privacy notice and the
    storage report. They are marked `translate="no"`.
  - **Statens vegvesen data** is shown as it comes.
  - **PDI items** are one name each, as written in Settings.
  - `.mono` / `.vin` (VINs, plates, codes) and input values are also skipped.
- **Adding UI text:** write it in English, then add the Norwegian to `NO`, or a pattern if it
  contains a value. Check the page in both languages.
- **Norwegian terms:** PDI = **nybilklargjøring**; Arrival inspection = **Mottakskontroll**;
  storage Arrival check = **Ankomstkontroll**; Vehicles = Biler; Off site = Ikke på lager;
  System admin = **Systemadministrator**.
- **The role formerly called "super-admin" is "System admin" in all text** (the user's
  wording). The code name `is_superadmin` is unchanged.

**Dates & times: ALWAYS dd.mm.yyyy and 24-hour HH:MM, everywhere, unless the user says
otherwise.** This is a standing rule from the user, and it covers both display and input.
- **Display:** everything goes through `fmtDate` in `ui.js` (`dd.mm.yyyy`, or
  `dd.mm.yyyy HH:mm` for timestamps). Bare ISO dates are formatted as-is, with no timezone
  shift. Only the live header clock uses the long form ("søndag 8. november 2026").
- **Input:** never use `<input type="date|time">`. They follow the device language
  (mm/dd/yyyy and AM/PM on English phones). Use `dateInput()` / `timeInput()` from `ui.js`
  instead (0.13.3).
  - They show `dd.mm.åååå` / `tt:mm`, accept loose typing ("9.11.26", "09112026", "800").
  - The date field has a 📅 button that opens the native calendar.
  - `.value` is ISO, like the native inputs, and `.id`, `.disabled` and change/input events
    work the same. Invalid input never fires `change` to listeners.
- **Today:** use `osloTodayIso()`, never `new Date().toISOString()` (that is UTC, so it's
  the wrong day just after midnight).
- **Numbers:** Norwegian format, e.g. `fmtKm` → "119 782 km". Decimals in reports use a
  comma ("12,59 V").

---

## Code style

**General:** keep it simple and dependency-light. No frontend framework, no build step, no
ORM. Match the style of the surrounding code. Comments explain *why*, not what.

**Python (backend):**
- Python 3.12, 4-space indent, double quotes, f-strings, type hints on helpers. Lines up to ~110.
- **Plain SQL with psycopg3**: `%s` parameters, and `psycopg.sql` for identifiers. Never format
  user input into SQL. Rows are dicts (`dict_row`).
- One transaction per request via the `get_conn` dependency. Call `conn.commit()` explicitly
  only before side effects outside the database (e.g. deleting files).
- Shared logic belongs in `common.py`. Raise errors with `not_found()`, `conflict()` (409) and
  `bad_request()` (422).
- PATCH endpoints use `patch_fields(model)` + `update_row()`, so only sent fields change.
- Write every meaningful change to history with `log_event(conn, vehicle_id, type, data)`.
  It stores JSONB with `default=str`, so dates are fine.
- Validation and normalization go in Pydantic validators in `schemas.py` (e.g. reg. no →
  uppercase alphanumerics, `finn_code` extraction).

**JavaScript (frontend):**
- ES modules, 2-space indent, single quotes, semicolons, `const`/arrow functions, async/await.
- Build DOM with `h(tag, attrs, ...children)` from `ui.js`. Put shared helpers in `ui.js`
  (badges, `fmtDate`, `duplicateNotice`, `finnLink`, `spotLabel`…).
- **Pitfall:** the native `append()` / `replaceChildren()` print arrays and `null` as text
  ("null[object HTMLElement]"). Use `el.replaceChildren(...list.filter(Boolean))` or the
  `append()` helper from `ui.js`. This bug has shipped **four** times (last: 0.12.1
  System page). **Before handing over a new view, grep it for `.append(` and
  `.replaceChildren(`, and check that no argument can be an array or null.**
- `ul.rows li` is a flex row (label left, buttons right). Sentences mixing text and links
  inside it must be wrapped in one `<span>`, or they split into columns (0.10.3 fix).
- A card that is built once must redraw its dependent parts when inputs change, using a slot
  element + a render function (see `serviceSlot` in `inspection.js`).
- User-facing text is English. Dates use the `nb-NO` locale.

**CSS:** one file, `frontend/css/app.css`. Reuse existing classes (`card`, `notice warn`,
`badge`, `grid`, `mono`, `reg-big`…) before adding new ones. Mobile/tablet first; it's used
on phones in the yard.

**Git (PowerShell 5.1):** quoted multi-line `-m` messages break. Write the message to a file in
the scratchpad and use `git commit -F <file>`. Commit title format:
`<Short summary of changes> (vX.Y.Z)`, then a body grouped by feature. End with the
`Co-Authored-By` trailer.

---

## Milestones

| Version | Milestone |
|---|---|
| initial | Arrival inspection → storage; default port moved to 8080 |
| 0.2.0 | Version footer; SVV API key hint in settings (key replaceable via env) |
| 0.3.0 | SVV field mapping fixed (`kodeNavn`); overview card with EU-kontroll/registration badges; "All vehicle data" section; Norwegian 24 h time + live clock |
| 0.4.0 | SVV lookup at arrival with mismatch confirmation; edit/move/off-site; damage repair with undo |
| 0.5.0 | Storage menu; multi-car spots with capacity |
| 0.6.0 | Sub-zones inside spots; big reg. no in vehicle header |
| 0.7.0–0.7.8 | OCR: tilted VINs + plates; RapidOCR replaces Tesseract (0/13 → 34/35); numpy/headless OpenCV build fix; door labels; ISO VIN rules, check-digit repair, make/year from VIN; auto-fill a single confident VIN |
| 0.9.0 | New/used + service tracking; reg. nos without spaces; soft delete + Recently deleted; 5-year retention |
| 0.9.3 | Duplicate warnings (reg. no / VIN distance 1); finn.no link (manual code); fix: service fields appear at once at arrival |
| 0.9.4 | Dates shown as Norwegian standard `dd.mm.yyyy` (+ `HH:mm`); frontend served with `Cache-Control: no-cache` |
| 0.10.0 | **Test drive** page: start (customer, licence photo, items out/in), cars out now, return with item check; customer name auto-filled from the licence photo (OCR); customer details trashed on return and wiped after 30 days; vehicle search also matches variant/colour |
| 0.10.1 | Licence names: spaces the OCR dropped are restored from the gaps in the photo (middle names, double surnames) |
| 0.10.2 | Per-build JS/CSS URLs (`/v/<build>/…`) so no browser can run stale code (Opera Touch "Not found" fix); VIN location shows **all** of SVV's `plasseringUnderstellsnummer` entries, not just the first |
| 0.10.3 | Settings → Data retention: "Recently deleted" sentence no longer split into columns |
| 0.10.4 | Transport-sheet QR verified (VIN via barcode); raw barcode text returned for troubleshooting |
| 0.14.0 | **English / Norwegian** per user (translator + dictionary; documents stay Norwegian); "super-admin" renamed "System admin"; Sprutlapper → Skvettlapper, PDI item → Nybilklargjøring |
| 0.13.3 | All date/time inputs are Carbonara's own dd.mm.yyyy / 24 h fields (no more browser mm/dd/yyyy, AM/PM); km in Norwegian number format |
| 0.13.2 | "Enter PDI date" available before the order is sent |
| 0.13.1 | Storage checks can be cancelled by an admin with a reason (kept struck through in the report) |
| 0.13.0 | **Storage maintenance** for new cars (MG SI-GI2022102501): arrival + monthly/3/6-month checks, 12V/SOC/tyre rules, Today reminders, printable report; dealer number setting |
| 0.12.2 | Fix: System page and PDI card printed "[object HTMLElement]" / "null" (native `append` again) |
| 0.12.1 | Storage spots can be renamed and deleted (cars moved to another spot first) |
| 0.12.0 | **PDI orders** to RBV (items, tyres, editable lists, e-mail via SMTP or e-mail app, manual booking date); **Today board** as start page; Arrivals moved to `#/arrivals`; **System page** (system admin) to change server settings incl. SVV key and SMTP; no built-in e-mail addresses |
| 0.11.0 | **Login** with personal PIN (first-time setup → admin; admins manage PINs); all API behind login; test drive privacy notice (NO) + "customer informed" checkbox; licence access log; `PRIVACY_COMPANY`/`PRIVACY_CONTACT` env |

**Next / ideas (not started):**
- HTTPS (e.g. a Caddy container with a self-signed cert on 8443), then `secure=True` on the cookie.
- Encrypted, expiring backups of the DB and `data/photos`.
- FINN import with image checkboxes. Blocked on official FINN API access or an ad-system feed.
- Automated tests: pytest for `vinlib` (VIN rules, plate parsing, an OCR photo set) and `common.service_due`.
- Part 2 of the lifecycle (after storage: preparation and sale) has not been defined yet.
