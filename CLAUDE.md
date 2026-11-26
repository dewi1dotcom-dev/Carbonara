# CLAUDE.md — Carbonara

Vehicle lifecycle system for the car dealership **Moss AutoCenter** (Moss, Norway), in daily
use. It covers:
- **New cars:** arrival inspection → storage, Statens vegvesen (SVV) registry data, VIN and
  plate OCR, MG storage maintenance, and PDI orders to the workshop.
- **All cars:** service tracking, test drives, and data retention / GDPR.

The interface is in **English and Norwegian** (per user). Dates, times and numbers always use
Norwegian formats.

> **Keep this file current.** Update it at every big milestone, meaning a minor version
> bump (0.x.0), a new migration, a new subsystem or a changed workflow. Add the milestone
> to the table at the bottom and fix any section that no longer matches the code.

---

## Working with the user

- **Who the user is:** the dealership's own IT person, not a full-time developer. Explain in
  plain language, and report results in a short table (what passed, what still needs a
  browser check).
- **Accounts:**
  - The user's own Carbonara account is **Supern** (system admin).
  - "Andy" is a different person. The user called Andy a regular admin, but Andy had
    admin = false at the last check. This was flagged and not answered.
  - Enrique and Jonna are staff (no PINs at the last check).
- **Commit and push only when the user says so** ("commit and push"). Never commit on your own.
- **Every change bumps `VERSION`:** patch for fixes and small features, minor for larger ones.
  The footer shows the version and build time, and the user checks it after redeploying.
- **Deploying:** the user pulls in **Portainer** and redeploys the stack, then says "up and
  running" / "server is up". After that, verify against the live server (see *Testing*).
- **Bug reports:** the user sends UI bugs as screenshots. Staff use Chrome and **Opera Touch**
  on phones.
- **Standing rules from the user (don't break them without asking):**
  - Dates are always **dd.mm.yyyy** and times **24-hour**, everywhere, for display and input.
  - **No Norwegian in the English version and vice versa.** All new UI text needs both
    languages (see *Language*).
  - **No e-mail addresses built into code or migrations.** They are entered in Settings.
  - **No company, place or person names in code or migrations (0.27.0).** Carbonara is meant to
    be usable by other dealers, alone or several under one roof. Names such as the dealership, the
    workshop, tyre companies, addresses, phone numbers and staff stay in this file and in
    the System page / Settings, never in code. Say "the workshop" / "the dealer" in code and
    comments. Check before a commit with:
    `git grep -n -iE "rbv|rygge|autocenter|kvaenveien|norgesdekk|drivalia|supern" -- backend frontend .env.example docker-compose.yml`
    (the only allowed hit is the comment in migration 028 that mentions the old code `rbv_orders`).
  - The full licence photo is kept (no masking); see *Login & GDPR*.

## SECURITY — the Vegvesen API key

The real SVV key must **never** be committed. It lives in the server environment
(`VEGVESEN_API_KEY` in `.env` / the Portainer stack) and/or in the DB via the System page.
`.env.example` keeps it empty. **Before every commit, run** this check. It finds any
UUID-shaped value (the SVV key's format) without containing any part of the real key:

```powershell
git grep -nE "[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}" -- .
# must print nothing (exit code 1 = clean)
```

**Never write personal data from test photos** (names, ID numbers, licence numbers, birth dates
from licences or ID cards) into a file, comment or commit message; use made-up names like
"Ola Nordmann". Test photos never go into the repo (`.gitignore` blocks image files).

**Never write any part of a real key, password or PIN into a file,** not even in a check
like the one above. Never write staff PINs (e.g. the Claude test account's) into any file.

---

## Deployment

| Thing | Value |
|---|---|
| Server | `192.168.10.45`, Ubuntu + Docker, managed via Portainer |
| App URL | `http://192.168.10.45:8080` (port **8080**; 8000 on the host is taken by Portainer). **HTTPS (0.37.0):** `https://192.168.10.45:8443` through the `caddy` container, once the server address `192.168.10.45` is saved on System → HTTPS (see *HTTPS*). |
| Repo | GitHub, branch `main` (git user `dewi1dotcom-dev`) |
| Containers | `db` (postgres:16), `app` (uvicorn on container port 8000 → host `APP_PORT`), `worker` (`python -m app.sync_worker`), `caddy` (built from `caddy/Dockerfile` = caddy:2.8.4-alpine + Caddyfile, HTTPS on host `HTTPS_PORT` → `app:8000`) |
| Photos | `./data/photos` mounted at `/data/photos` in **both** `app` and `worker` (the worker deletes files during retention) |
| Timezone | `TZ=Europe/Oslo` on all containers |

**Environment variables** (`.env.example`, `docker-compose.yml`):
- **Server:** `POSTGRES_PASSWORD`, `APP_PORT=8080`, `MAX_UPLOAD_MB=30`, `HTTPS_PORT=8443`.
- `CARBONARA_HOST` is now only the fallback for System → HTTPS → **Server address** (0.39.0, see *HTTPS*).
- **Fallbacks for System page settings** (a value saved on the System page wins):
  - `VEGVESEN_API_KEY/_URL/_AUTH_HEADER/_AUTH_SCHEME/_SYNC_DAYS`
  - `TRASH_DAYS=30`, `RETENTION_YEARS=5`
  - `PRIVACY_COMPANY`, `PRIVACY_CONTACT` (phone), `PRIVACY_EMAIL`, `PRIVACY_ADDRESS`
  - `DELIVERY_COMPANY`, `DELIVERY_PHONE`, `DELIVERY_EMAIL`, `DELIVERY_ADDRESS` (kiosk privacy notice)
  - `RENTAL_COMPANY`, `RENTAL_PHONE`, `RENTAL_EMAIL`, `RENTAL_ADDRESS` (rental privacy notice)
  - The dealer number is set on the System page only.
  - `SMTP_HOST/PORT/USER/PASSWORD/FROM/SECURITY` (empty host = staff send from their own
    e-mail app)

**HTTPS (0.37.0)** (`caddy/Caddyfile`, the `caddy` service; the user's request, "local fix first"):
- **The Caddyfile is built into the image (0.37.1)** (`caddy/Dockerfile`, `build: ./caddy`). Don't bind-mount it:
  under Portainer's Git stack the relative path `./caddy/Caddyfile` didn't exist on the server, Docker made an empty
  folder there and the container stayed "created" (never started, no log). (So `./data/photos` may also not be where
  the repo is on the host; find the real path before setting up backups.)
- Caddy is its own small certificate authority (`tls internal`, root CN "Carbonara Local Root"). The root + its key
  live in the `caddy_data` volume: **keep it and back it up**, or every device must install a new root.
  `default_sni` = `CARBONARA_HOST`, because browsers send no SNI for an IP address.
- **Server address on the System page (0.39.0, the user's request):** the stack's `CARBONARA_HOST` kept falling back to
  `localhost` on redeploys, and each location has its own IP. Setting `carbonara_host` (group "HTTPS", drawn inside the
  HTTPS card, with a "Use <address this page is open at>" button while unsaved; validated by `HOST_PATTERN` = IPv4 or
  host name) is kept in the DB. `caddyhost.write()` (at app start and on save / reset) writes it to `/caddy-host/host`
  in the shared `caddy_host` volume (rw in `app`, ro in `caddy` at `/carbonara`). Caddy's `CMD` is `caddy/start.sh`:
  it starts `caddy run` with `CARBONARA_HOST` = the file's value (only `A-Za-z0-9.-` kept), else the env, else
  `localhost`, checks the file every 10 s and runs `caddy reload` with the new value (a failed value isn't retried).
  The Dockerfile strips CRLF from the script.
- Each device installs the root once: `GET /carbonara-ca.crt` (open, plain HTTP too; `main.py` reads it from
  `caddy_data`, mounted read-only in `app` at `/caddy-data`). System page → **HTTPS** card: https address, download
  link and the steps for Android, iPhone, Windows and Firefox.
- **Plain HTTP on `APP_PORT` stays open** while devices move over (`auto_https disable_redirects`). `app.js`
  `moveToHttps()` (before `boot()`): on `http:`, if `/api/version` has `https_port`, a `no-cors` test request to the
  https address succeeds only when the device trusts the root, and then the page moves there by itself. Needed
  because after a login over HTTPS (secure cookie) the browser won't let http:// set the same cookie.
- The kiosk tablet keeps its cookie on the https address (cookies don't depend on the port).
- **Step 2 (later):** a real certificate for a host name replaces `tls internal`; then close plain HTTP.

**Cache-busting (0.10.2):** `main.py` serves `index.html` itself (no-cache) and rewrites
`/js/app.js` and `/css/app.css` to `/v/<BUILD_TAG>/…` (immutable), so every deploy gets new
URLs.
- Opera Touch kept a stale `app.js` even with `no-cache` (the result was "Not found" for a new
  route).
- **Keep all frontend imports relative,** and reference JS/CSS only from `index.html`.
- If a screenshot shows old UI, compare the footer version with `/api/version`.

## Build

The dev machine is Windows 10 with **PowerShell 5.1**. **Docker, Node and Python 3 are not
installed** (only OpenOffice's Python 2.7), so code can't be run locally. The build happens on
the server:

```bash
cp .env.example .env              # set POSTGRES_PASSWORD
docker compose up -d --build
docker compose logs -f app        # wait for "Application startup complete"
```

Dockerfile notes. These were learned the hard way, so don't undo them:
- `pip install -r backend/requirements.txt`, **then**
  `pip install --no-deps rapidocr-onnxruntime==1.3.24`, then an import check
  (`import rapidocr_onnxruntime, cv2, onnxruntime`) that fails the build early. RapidOCR's
  own dependency list pulls in the GUI `opencv-python` and numpy 2.
- **numpy must stay at 1.26.4 (< 2).** Use `opencv-python-headless`, never `opencv-python`.
- System packages: `tesseract-ocr libzbar0 libdmtx0b`.
- PDI sheets need `pypdf`, `reportlab`, `pypdfium2` (pip wheels, no system packages).
- Notifications need `pywebpush==2.0.3` (pulls cryptography, aiohttp, py-vapid, http-ece); the import check covers it
  and that numpy stayed below 2.
- The parts import reads Excel with `openpyxl` (pure Python, no system packages).
- `BUILD_TIME` is stamped in ISO UTC at build time; `VERSION` is copied in. Both are served at
  `/api/version`.

**PowerShell pitfalls:**
- `R` is an alias (Invoke-History), so don't name helper functions `R`.
- In double-quoted strings, escape `` ` `` and `$`; multi-line replacements are safer with the
  Edit tool.
- Use `curl.exe`, not the `curl` alias.
- Files must be written as UTF-8 without BOM (`New-Object Text.UTF8Encoding $false`).

## Testing

There is no automated test suite. Verification has two parts:
1. **Careful reading before handing over.** Nothing can be run locally. Re-read edited JS
   for the `append` pitfall, quote balance and imports.
   - **Syntax check in headless Edge (0.48.1):** Edge and Chrome are installed. Write a scratch HTML page with one
     `<script type="module">import('file:///c:/Users/Dewil/Carbonara/frontend/js/…')` per module (log OK / FAIL), run
     `msedge.exe --headless=new --allow-file-access-from-files --virtual-time-budget=5000 --enable-logging=stderr
     --dump-dom file:///…/check.html 2>log.txt` and look for `FAIL` in the log (`app.js` alone fails at run time on
     the empty page; that is fine). A module loaded with `<script type="module" src>` gives the line number
     (`CONSOLE:<line>`). 0.48.0 shipped with an extra `)` in two files and showed only the top menu.
2. **Live checks after the user redeploys.**
   - Every `/api` route except `/api/health`, `/api/version` and `/api/auth/*` needs a login
     cookie.
   - The user made a staff account **"Claude"** (staff id 7, shown as "Claude Claude"; admin, not system admin; recreated after id 5) for
     this. The PIN was given in chat. Never write it into the repo; if it doesn't work, ask
     the user.

```powershell
$b='http://192.168.10.45:8080'; $jar='<scratchpad>\cookies.txt'
'{"staff_id":7,"pin":"<PIN>"}' | Out-File -Encoding ascii "$env:TEMP\login.json"
curl.exe -s -c $jar -H "Content-Type: application/json" --data-binary "@$env:TEMP\login.json" "$b/api/auth/login"
Remove-Item "$env:TEMP\login.json"                      # don't leave the PIN on disk
(Invoke-RestMethod "$b/api/version").version
curl.exe -s -b $jar "$b/api/dashboard"
curl.exe -s -b $jar "$b/api/vehicles?q=LJ%2077892"
curl.exe -s -b $jar "$b/api/vin/JF1BS9LC2KG171677"      # decode + "similar" duplicates
curl.exe -s -b $jar -F "file=@C:\path\photo.png;type=image/png" "$b/api/vin/recognize"
curl.exe -s -b $jar -F "file=@C:\path\licence.png;type=image/png" "$b/api/test-drives/read-license"
```

- After testing a wrong PIN, log in correctly once to reset the failure counter.
- **Production data:** don't write test data without asking. If something must be created to
  test it (e.g. a storage spot), use an obvious name like `ZZ-CLAUDE-TEST` and delete it
  afterwards.
- **Reference results:**
  - The OCR regression set was 35 user photos; the result was **34 of 35** (the miss, a tiny
    Subaru door label, is accepted).
  - The user's licence must read with the full name (given names + surname) correctly spaced.
    Licence test photos: the user's own card (two given names) and a card with labels "1"/"2" without
    dots (0.19.1). Never write the names from them into a file or commit message.
  - The Norsk Biltransport transport sheet must give VIN `LSJWS4090SZ716243` via the QR code.
  - These photos lived in session temp folders and are gone. Ask for them again before
    changing `vinlib.py` or `licenselib.py`.

---

## Architecture

```
backend/
  app/main.py           FastAPI app; serves index.html + /v/<build>/ assets; includes routers
                        (all except session behind require_staff); /api/health, /api/version
  app/config.py         Settings: fixed env values + the SETTINGS registry of System-page
                        settings (DB app_settings > env > default, cached 20 s)
  app/db.py             psycopg3 ConnectionPool, dict_row; get_conn = one transaction per request
  app/migrate.py        applies backend/migrations/NNN_*.sql in filename order (tracked by name)
  app/auth.py           PIN hashing (scrypt), sessions, require_staff / require_admin /
                        require_superadmin, STAFF_PUBLIC
  app/common.py         errors, patch_fields/update_row/insert_row, log_event, place_in_location,
                        similar_vehicles, soft_delete_vehicle, purge_vehicle,
                        purge_test_drive_customer, RETENTION_DUE_SQL, service_due
  app/schemas.py        Pydantic models
  app/vegvesen.py       SVV fetch/extract/overview/details/compare/resolve, sync_vehicle
  app/vinlib.py         VIN rules (ISO 3779/3780), WMI table, check digit, RapidOCR + Tesseract,
                        barcodes (zbar/libdmtx), plate parsing, recognize_all, scene_text
  app/licenselib.py     name from a driving licence photo (fields 1./2., restores dropped spaces)
  app/storagecare.py    MG storage programme: checklist ITEMS, schedule (next_check)
  app/mailer.py         SMTP sending (PDI orders)
  app/pdisheet.py       PDI sheets: fill a model's PDF form (reportlab overlay + pypdf), page pictures (pypdfium2),
                        OCR field suggestions, stamp / signature pictures
  app/photostore.py     original + 1600px + 400px JPEG
  app/workerstatus.py   the worker reports in (`worker_status`); status() = warnings for system admins
  app/push.py           phone / PC notifications (Web Push): notify() queues, the app thread sends + scheduled ones
  app/diskstatus.py     free space on the disk holding PHOTO_DIR + database size (System page, Today)
  app/caddyhost.py      hands the server address (System → HTTPS) to the caddy container via the caddy_host volume
  app/worktime.py       break arithmetic: worked time minus breaks, add_work (when a job is done, skipping breaks)
  app/sync_worker.py    registry re-sync loop + daily housekeeping() (retention, trash purge,
                        test drive + rental customer purge, rental car SVV refresh, received customer deliveries,
                        stopped kiosk tablets,
                        Today messages); expired private messages + files every loop (~1 min)
  app/routers/          vehicles, inspections, vin, admin (staff, storage spots), testdrives, rentals, documents,
                        session (login/language), pdi, dashboard (Today), system, storage_care,
                        deliveries (kiosk form + staff list + kiosk setup), pdi_sheets (templates, stamps, my signature,
                        the order's sheet), messages (Today message board), dm (private messages), notifications (push on/off, kinds, test),
                        notes (my notes), recalls (recall sources, checks, recalls per car),
                        market (market data test: CSV import, comparison), parts (parts store),
                        customers (customer register, cars, owners, transfer from Vehicles), parts_orders,
                        work_orders (work orders), hours (work hours: start / end of day, clock, admin list),
                        invoices (invoices + credit notes from work orders), planner (team calendar)
  migrations/           001…056
addons/sidekick/        Carbonara Sidekick, a Chrome extension (manifest, popup.html/js = start + progress, worker.js = the check): recall checks
                        in a dealer portal (0.42.0);
                        copied into the image (Dockerfile) and served zipped at /addons/sidekick.zip
frontend/               no build step; plain ES modules
  index.html, css/app.css
  img/                  logo + app icon SVGs (favicon = carbonara-icon.svg); PNG app icons 192/512 +
                        apple-touch-icon (drawn from the SVG; `.gitignore` allows only frontend/img/*.png)
  sw.js                 service worker for notifications only (no caching); served at /sw.js
  manifest.json         installed app (Chrome "Install"): name + PNG icons; without them Chrome shows a "C"
  fonts/                Space Grotesk (logo font, bundled; SIL OFL)
  js/app.js             hash router (ignores "?…" in the hash), login boot, user menu, translator start
  js/ui.js              h(), append(), api, fmtDate, dateInput/timeInput, badges, shared helpers
  js/i18n.js            English/Norwegian translator + dictionary
  js/diagram.js         car damage diagram
  js/views/             today (start page), dashboard (= arrivals list), intake, inspection,
                        vehicles, documents, pdi (card + banner + PDI page), pdiorders (PDI orders page), pdisheet (PDI sheets,
                        stamps, signature, PDI done dialog), storagecare (card + check form
                        + report), messages (Today message board), dm (private messages), storage, testdrive, rental (rental cars), deliveries (kiosk form + Customer deliveries),
                        login, settings, system, notifications (👤 menu → Notifications), notes (📝 panel + #/notes),
                        recalls (car page card, check dialog, Settings → Recall sources),
                        market (#/market Market prices + car page card; market data test), parts (#/parts parts store),
                        customers (#/customers, customer cars, transfer dialog), partsorders (#/parts-orders),
                        workorders (#/work-orders), hours (⏱ panel + #/hours), invoices (#/invoices), planner (#/planner)
```

**Migrations:**

| # | Name | What it adds |
|---|---|---|
| 001 | `initial` | base schema |
| 002 | `vegvesen_registry` | registry data |
| 003 | `registry_confirm` | `kept_values`, vin_source 'registry' |
| 004 | `spot_capacity` | multi-car spots |
| 005 | `sub_zones` | `parent_id` + `storage_spots` view |
| 006 | `service_and_condition` | condition, last service; reg. nos normalised |
| 007 | `soft_delete` | soft delete |
| 008 | `finn_link` | finn.no code |
| 009 | `test_drives` | test drives |
| 010 | `login_and_privacy` | PINs, sessions, access log, `customer_informed` |
| 011 | `pdi_orders` | PDI orders + `pdi_lists` |
| 012 | `system_settings` | `app_settings`, `is_superadmin` |
| 013 | `delete_spots` | deleted spots, `storage_spots.deleted` |
| 014 | `storage_care` | `storage_checks` |
| 015 | `void_storage_checks` | cancelling checks |
| 016 | `language` | `staff.language`; Skvettlapper / Nybilklargjøring |
| 017 | `drop_zones` | zones moved into descriptions |
| 018 | `trade_plates` | `trade_plates`; `test_drives.trade_plate_id / plate_moved_at / plate_moved_to` |
| 019 | `pdi_print` | `pdi_orders.sent_via` also allows `'print'` |
| 020 | `pdi_prep` | `pdi_orders.prep_plate_id / prep_note / prep_wheels_location / prepared_at / prepared_by` |
| 021 | `staff_names` | `staff.first_name / last_name / phone / deleted_at / deleted_by`; existing names split |
| 022 | `theme` | `staff.theme` ('auto' / 'light' / 'dark') |
| 023 | `battery_charges` | monthly 12V charges of used cars in storage (cancellable) |
| 024 | `vehicle_documents` | contracts, notes and other files per car |
| 025 | `customer_deliveries` | `delivery_maps`, `delivery_options` (key places / tick boxes, EN + NO), `kiosk_devices`, `car_deliveries` |
| 026 | `delivery_registry` | `car_deliveries.svv_*` (SVV lookup by reg. no: VIN, make/model, EU-kontroll, owner name + kind), `name_match` |
| 027 | `teams` | `teams` (name, `menu` text[]), `staff.team_id`; existing staff put in the team "All staff" with every menu item |
| 028 | `generic_names` | stored tyre option `rbv_orders` → `workshop_orders` |
| 029 | `rental_cars` | `rental_cars` (own fleet + SVV fields), `rentals`, `rental_access_log`; teams with Test drive get menu item `rental` |
| 030 | `wheels` | `vehicles.wheels`, `rental_cars.wheels` ('summer' / 'winter', NULL = not recorded) |
| 031 | `pdi_confirm` | `pdi_orders.expected_done_date / pdi_confirmed_at / pdi_confirmed_by`; teams with Vehicles get menu item `pdi_orders` |
| 032 | `pdi_sheets` | `pdi_templates` (model PDFs + field positions), `pdi_stamps`, `staff.signature_key`, `pdi_orders.done_km / sheet_*` |
| 033 | `work_order` | `pdi_orders.work_order` (the workshop's work order number) |
| 034 | `pdi_battery_checks` | `pdi_orders.done_battery_v` (12V reading), `sheet_checks` ("tick all boxes") |
| 035 | `kiosk_language` | `kiosk_devices.language` ('en' / 'no', default 'no'), set on the Customer deliveries page |
| 036 | `messages` | Today page message board (`body` ≤ 300, `team_id` (NULL = everyone), `created_by`, `created_at`; shown 24 h, then deleted); `private_messages` (sender, recipient, text and/or file / picture, `expires_at` = 72 working hours, `read_at`) |
| 037 | `worker_status` | the background worker's check-ins (`name` 'loop' / 'housekeeping', `at`, `ok`, `detail` = step names + error types only) |
| 038 | `push` | `push_subscriptions` (per browser, tied to the login session), `staff.push_prefs`, `push_outbox` (queued notifications), `push_sent` (scheduled ones already sent) |
| 039 | `notes` | `notes` (my notes: `staff_id`, `body` ≤ 1000, pinned `vehicle_id` or `link` + `link_title`, `remind_at`, `reminded_at`, `done_at`) |
| 040 | `recalls` | `recall_sources` (name, `makes[]`, `url` with {vin}/{reg}, note), `vehicle_recalls` (code, title, details, certainty, status open/done/not_applicable), `recall_checks` (result, reason), `vehicles.recall_check_requested_at / _reason` |
| 041 | `asking_price` | `vehicles.asking_price` (kr), `asking_price_at`, `asking_price_source` ('manual' / 'finn') |
| 042 | `vehicle_photos` | `vehicle_photos` (the car's own photos: from its finn.no ad or uploaded; `sort`, `source`), `vehicles.listed_km / listed_km_at` (the ad's mileage) |
| 043 | `market_data` | `market_imports` (file name, rows read / skipped, models), `market_listings` (make / model + match keys, variant, year, km, price, first price, fuel, `seller_kind` private / dealer, status, `active`, first / last seen, finn code, url; no seller names or places) |
| 044 | `parts` | `parts` (part number + `part_key`, name, make, supplier, location, unit, quantity, minimum, cost / sales price ex VAT, VAT rate, note; soft delete), `part_movements` (created / received / out / count / import / price; change, quantity after, unit cost, reference, note, data), `part_imports` |
| 045 | `customers` | `customers` (customer no., private / company, contact, `last_activity_at`), `customer_cars`, `car_ownerships` (one current owner per car), `parts_orders`, `parts_order_lines`, `register_events`; `vehicles.customer_first_name / _last_name / _address / _phone / customer_car_id`; `part_movements.order_id`, kinds `order` / `order_return` |
| 046 | `part_numbers_upper` | existing part numbers (parts, order lines) in capital letters |
| 047 | `work_orders_hours` | `work_orders` (number, status open / in_progress / done / cancelled, `vehicle_id` or `customer_car_id` + `customer_id`, title, description, `tasks` jsonb, `mechanic_note`, `estimated_minutes`, `planned_at`, `assigned_to`, `pdi_order_id`), `work_order_events`, `work_days` (staff, day, start, end, `breaks` jsonb), `work_time` (clock on a work order; one running per person); `parts_orders.work_order_id`, `pdi_orders.work_order_id`; teams with Parts or Customers get `work_orders` |
| 048 | `invoices` | `invoices` (number, kind invoice / credit_note, `credits_invoice_id`, work order, customer, issue / delivery / due date, snapshots `seller` / `buyer` / `car` / `lines` / `vat_lines`, totals, `kid`, `note`, `parts_order_ids`, `paid_at / paid_by`; trigger `invoices_locked`: never changed or deleted except the payment and links set to NULL); `work_orders.labour_rate / billed_minutes / extra_lines / km / invoice_id`, status `invoiced` |
| 049 | `planner` | `planner_rows` (team, staff, sort, hidden: the lines of a team's planner), `absences` (staff, kind holiday / away / course / other, start, end, note); teams with Work orders get `planner` |
| 050 | `work_order_arrival` | `work_orders.arrived_at`, `car_deliveries.work_order_id` |
| 051 | `delivery_customer_car` | `car_deliveries.customer_car_id` (kiosk deliveries link to the workshop's register, not the car stock) |
| 052 | `older_chassis_numbers` | `vehicles.vin_nonstandard` (the VIN check now allows 4–30 letters / digits when it is set), `customer_cars.vin_nonstandard` |
| 053 | `job_types_places` | `job_types` (name EN + NO, `color`, sort, active; 7 generic types seeded), `workshop_places` (team, name, sort, `deleted_at`: lifts / bays as planner lines); `work_orders.job_type_id / place_id`; existing PDI work orders get the PDI type |
| 054 | `parts_ready` | `work_orders.parts_ready_at / parts_ready_by` ("Parts arrived and ready", ticked by hand) |
| 055 | `pdi_to_planner` | `pdi_orders.sent_via` also allows `'planner'` |
| 056 | `work_order_recall_check` | `work_orders.recall_checked_at / recall_checked_by / recall_result` (none / found) |

**New schema changes = a new numbered file. Never change what an applied migration does**
(the runner tracks by file name; comment-only edits are harmless).
- **The one exception (0.27.0):** to take names out of the code, 011 no longer seeds tyre
  companies, and 012 no longer picks the system admin by the account name. This only changes
  new installs. The live install ran the old versions and keeps its data.

**Frontend routes:**
- **Main pages:** `#/` Today · `#/arrivals` · `#/intake` · `#/inspections/:id` · `#/pdi` (PDI
  page, opened from the "PDIs this week" tile and the vehicle banner; not in the top menu) · `#/pdi-orders`
  (PDI orders page, top menu "PDI orders").
- **Vehicles:**
  - `#/vehicles` — filters are kept in the hash, e.g. `#/vehicles?q=…&status=…&condition=new`
  - `#/vehicles/:id`
  - `#/vehicles/:id/storage-report` (printable)
  - `#/vehicles/deleted`
- **Storage:** `#/storage` · `#/storage/:id|off-site`.
- **Test drives:** `#/test-drive` · `#/test-drive/new/:vehicleId` (start form with the car
  preselected).
- **Rental cars:** `#/rental` (fleet, rent out, cars out, trash; top menu "Rental cars").
- **Customer deliveries:** `#/deliveries` (list + kiosk setup; top menu "Deliveries" since 0.25.1, also from
  Today and Settings) · `#/kiosk` (staff preview of the kiosk form).
- **Parts store:** `#/parts` (top menu "Parts" / "Delelager"; filters in the hash, e.g. `#/parts?q=…&show=low`).
- **Customers:** `#/customers` · `#/customers/:id` · `#/customer-cars/:id` (nav `customers`). **Parts orders:** `#/parts-orders` · `#/parts-orders/:id` (nav `parts`).
- **Work orders:** `#/work-orders` · `#/work-orders/:id` (nav `work_orders`). **Invoices:** `#/invoices` · `#/invoices/:id` (nav `work_orders`). **Planner:** `#/planner?team=&start=&days=` (nav `planner`). **Work hours:** the ⏱ button (every user) · `#/hours` (admins only: `canSee('hours')`).
- **Private messages:** `#/messages` (people) · `#/messages/:staffId` (conversation); the 💬 button in the top bar, every
  user whatever the team (`canSee` always allows `messages`).
- **My notes:** the 📝 panel (any page) · `#/notes` (the same as a page; reminder notifications open it); `canSee` always
  allows `notes`.
- **Admin:** `#/settings` · `#/system` (system admins only).

---

## Domain rules (the nuance)

**Registration numbers** are stored and sent **without spaces**, in uppercase (`EB82655`).
Search accepts spaces. Standard Norwegian plates are 2 letters + 4–5 digits. Personalised
plates exist and are offered as "custom".

**VIN (ISO 3779/3780):**
- 17 characters, never I/O/Q.
- Position 1 is never `0`. Position 10 (model year) is never U/Z/0. Positions 14–17 are digits.
- The check digit (position 9) is **mandatory only** when position 1 is 1–5 (North America) or
  `L` (China). Elsewhere a mismatch is just a warning.
- Check-digit repair (a single look-alike swap) is only attempted where the check digit is
  mandatory.
- Make comes from the WMI table and model year from position 10 (`describe()`).
- **Older chassis numbers (0.54.0, the user's request: veteran cars):** cars from before the 17-character VIN have
  chassis numbers of other lengths (and may use I / O / Q). They are accepted **only as Statens vegvesen has them, after a
  check**: the arrival screen ("Find VIN" by reg. no.) and the customer register's car form (lookup by reg. no.) show
  "Older chassis number" with a required "I have checked the chassis number on the car"; the server
  (`vegvesen.verify_chassis`) looks the reg. no. up again and accepts the number only if it equals SVV's chassis number
  (spaces / dashes / dots ignored, `chassis_key`); then `vin_nonstandard` = true (4–30 A–Z / 0–9, `vinlib.CHASSIS_RE`),
  and no VIN rules, check digit or make decoding apply. Such a car is re-synced by its reg. no. (checked against the
  chassis number). Saving an unchanged older chassis number again needs no new check. Registration numbers already
  accept any 2–8 letters / digits (Æ Ø Å included), so older plates work.

**OCR pipeline** (`vinlib.recognize_all`):
- **Order:** barcodes first (zbar, then libdmtx). Then RapidOCR passes: normal → label-line
  strips (recognition only, using long lines as rulers) → zoom → rotated ±35°. Tesseract is
  the fallback.
- **Plates:** at most 2 letter→digit fixes; 6 digits with a leading 1 → drop the 1. Reject
  lines with lowercase letters.
- A single high-confidence VIN is auto-filled at arrival.
- Engines share a re-entrant lock (RLock).
- Raw barcode text is returned in `text` as `[barcode] …`.

**Transport sheets (factory-new cars):** Norsk Biltransport puts a delivery sheet in each new
car. It has a printed VIN, model ("MGS5"), dealer and a **QR code that contains only the
VIN**. The QR gives the VIN with high confidence in ~0.4 s.

**Statens vegvesen API:** `GET {url}?understellsnummer=<VIN>` or `?kjennemerke=<REGNR>`, with
header `SVV-Authorization: Apikey <key>`.
- Prefer `kodeNavn` over `kodeBeskrivelse` (colour etc.).
- Many SVV fields are **lists**, e.g. `plasseringUnderstellsnummer` (LJ77892 has two:
  Instrumentpanel and Kupé - gulv høyre side). Don't take only `[0]` when all of them matter.
- Lookup happens at arrival (by VIN or reg. no). Mismatches with typed values need a
  per-field confirmation (`accept_fields`, `kept_values`).
- The worker re-syncs registered cars every `vegvesen_sync_days`.
- **"↻ Sync now" (0.16.1)** sits in the header of the vehicle page's Statens vegvesen card for
  **every** car (`POST /vehicles/{id}/registry/sync`). For a car not marked as registered it
  is a one-off lookup (the worker still only re-syncs marked cars). If SVV says `REGISTRERT`,
  the car is marked as registered (event source `statens_vegvesen`, like at arrival).
- New cars aren't in the registry until registered; "not found" is normal for them.

**Status badges:** EU-kontroll and registration show amber within 60 days and **red from 1 day
before** the deadline. Service: green / amber (± 31 days) / red.

**Summer / winter wheels (0.29.0)** (`vehicles.wheels`, `rental_cars.wheels`; `common.tyre_season` /
`tyre_warning` / `add_tyre_warnings`; `WHEELS`, `tyreText`, `tyreBadge`, `wheelsSelect` in `ui.js`):
- **Recorded with a dropdown** ("Not recorded / Summer wheels / Winter wheels", saves at once): the
  "Wheels" row of the vehicle page overview (every car) and the rental car add/edit dialog (only there,
  0.29.1: the fleet list shows the wheels as text + the warning badge). **Used cars** get a required "Summer or winter wheels? *" field and
  checklist item in the arrival inspection (`inspections._checklist`, key `wheels`).
- **The studded tyre season** (piggdekksesongen; the user's rules), region on System → Wheels:
  - South and Central Norway (default `south`): 1 November up to and including the first Sunday after
    Easter Monday (= Easter Sunday + 7; `easter_sunday()`).
  - Nordland, Troms and Finnmark (`north`): 16 October up to and including 30 April.
- **Warnings (the user's rule):** summer wheels turn **amber a month before** the season (1 Oct / 16 Sep)
  and **red once it has started**; winter wheels after the season get only a **neutral notice** (plain
  badge, "info" block on Today), since that isn't strict. Shown as a badge on the vehicle header, vehicle
  cards (Vehicles list + storage spots), rental cars (fleet, chooser, rent-out form), and on Today.
  Cars taken off site get no warning; rental cars always do.
- The server sends `tyre_warning` = `{level: bad|warn|info, kind, date}`; the frontend only formats it.

**Service due** (`common.service_due`):
- Last service + 1 year.
- New car → first registration + 1 year.
- Used car without history → next registration anniversary.
- At arrival, choosing *Used* reveals the last service date + km fields immediately
  (`serviceSlot` redraw).

**Storage spots:**
- **Capacity:** spots have a `capacity` (several cars per spot) and optional **sub-zones**
  (`parent_id`). **The user likes the sub-zone layout; keep it.**
- `place_in_location` locks the spot and checks capacity and sub-zone rules. "Off site" means
  not on a spot.
- **Move car (0.32.2):** the person moving is the logged-in user (`POST /vehicles/{id}/move` uses the
  session, not `staff_id`); the dialog has no "Moved by" dropdown.
- **Zones are not used (0.14.2):** old zone values were moved into the description, and
  zones are never shown. In Settings, the description and capacity are edited in place.
  Lists and pickers are flat.
- **Rename:** any staff (`PATCH code`).
- **Delete:** admins only, `DELETE /storage-locations/{id}?move_to=`.
  - A spot with cars (its own or in its sub-zones) needs `move_to`.
  - Each car is moved with `place_in_location` and logged as `moved`, with the note "Spot X
    deleted".
  - Never-used spots are deleted for good. Spots with history get `deleted_at`;
    `storage_spots.deleted` hides them, and their code can be reused.

**Duplicates** (`common.similar_vehicles`): the same reg. no, or a VIN at Hamming distance 1.
These **warn, never block** ("Use this VIN" on the arrival screen).

**Deletion & retention:**
- Delete is a **soft delete** (`deleted_at/by/reason` 'manual'|'retention'), and the storage
  assignment ends. Deleted cars are excluded everywhere.
- **Recently deleted** keeps cars for `trash_days` (30). Restore goes back to the old spot if
  there's room, otherwise off site.
- After that, `purge_vehicle` removes all rows (including test drives, PDI orders and storage
  checks) and the photo files. Commit before deleting the files.
- **Retention:** off-site cars with no activity for `retention_years` (5) are soft-deleted
  automatically by the worker's daily `housekeeping()`.
- Starting an arrival for a VIN that sits in the trash purges the old record first.
- A car that is out on a test drive can't be deleted.
- **Cancelling an arrival inspection (0.22.3):** if the car is new to Carbonara (no other completed
  inspection, never placed in storage; `inspections._first_arrival`, sent as `cancel_deletes`), the
  button reads "Cancel inspection and delete" and the car is soft-deleted (reason `manual`). A car
  coming back keeps its record ("Cancel inspection") and gets its old status back. "⏸ Pause
  inspection" just goes to `#/arrivals` (fields save as they are entered).

**Vehicles list:**
- **Search** covers VIN, make, model, variant, colour, reg. no (spaces ignored) and spot.
- **Filters:** status, and **New/used** (factory new / used / not chosen).
- A result count shows above the list.
- **"+ New arrival" (0.35.1, the user's request, for the workflow):** the same button as on Today / Arrivals
  (`#/intake`), top right of the Vehicles page; only shown when the team can open Arrivals (`canOpen`).
- **Card layout (0.21.1, user's request):** text on the left (make and model; reg. no, an empty
  line when missing; VIN; status + notification badges; colour · spot · EU-kontroll), and
  the **right-side photo** from the latest arrival inspection on the right
  (`common.RIGHT_PHOTO_SQL` → `right_photo_id`; "No photo" box otherwise). Same `vehicleCard`
  on the storage spot pages.
- **Vehicle page (0.21.2):** "Photos from the arrival inspection" card under the overview: every
  photo (angles, VIN, damage, other) of the latest completed arrival inspection with photos
  (cancelled ones skipped; one in progress only if none is completed)
  (`arrival_photos` from `GET /vehicles/{id}`); tap to enlarge, link to the inspection.
- **Mileage (0.34.1, the user's request):** the overview card shows the latest recorded km and where it came from
  (`LATEST_KM_SQL` in `routers/vehicles.py` → `mileage` `{km, at, source}`): arrival inspection, service, test drive
  out / back, PDI done; newest date wins (a service counts as midnight on its date).
- **Quick actions (0.22.0)** under the vehicle header (`topActions`): "🔑 Start test drive" (not
  while out), "🔧 Create PDI order" (no open order; opens `pdi.editDialog`), "📄 Add document".

**Documents per car (0.22.0)** (`vehicle_documents`, `routers/documents.py`, `views/documents.js`):
- Type contract / note / other, optional title, a **file and/or a text**. Files: PDF, photos,
  Word/Excel/ODF, txt (whitelist by extension; content type from the table, not the browser).
  Max `MAX_UPLOAD_MB`. Stored as uploaded under `PHOTO_DIR/docs/yyyy/mm/<uuid>.<ext>`, so
  `photostore.remove()` and `purge_vehicle` delete them too.
- Served at `/api/documents/{id}/file` with `no-store` + `nosniff`; PDFs and images open
  inline, other types download.
- Edit (type, title, text; not the file) and delete: the person who added it, or an admin.
  Delete is permanent (file removed after commit).
- **Contracts hold personal data:** events `document_added/updated/deleted` log only id and
  type, never the title or text.

**Rental cars (0.28.0)** (`routers/rentals.py`, `views/rental.js`, migration 029):
- **The dealer's own rental / loan fleet, kept apart from the car database (the user's rule).** The
  fleet is in its own table, `rental_cars`, not `vehicles`. Rental cars never show up in Vehicles,
  Storage, search, arrivals or the vehicle Today lists. They are added, edited and removed on the
  Rental cars page only.
- **Adding a car:** type the reg. no → "Look up at Statens vegvesen" (`GET /rental-cars/lookup`)
  fills make / model / colour / fuel / VIN and the EU-kontroll date.
  - Saving (`POST /rental-cars`) looks the car up again.
  - A failed lookup never blocks adding the car; the reason is saved as `registry_error` and shown
    on the car.
  - Without an SVV key, EU-kontroll is typed in by hand.
- **SVV data, focused on EU-kontroll:** `refresh_registry()` always takes EU-kontroll due / last
  approved, registration status and first registration from SVV. The descriptive fields (VIN, make,
  model, colour, fuel) only fill gaps, so staff edits win.
  - The worker's `housekeeping()` re-checks every car every `vegvesen_sync_days`, so EU-kontroll moves
    on after the car has passed.
  - "Look up again" does the same on demand.
  - A new reg. no on edit triggers a new lookup.
- **EU-kontroll is shown everywhere a car appears:** a badge on each car (green / amber within 60
  days / red from the day before, as on the vehicle page). Also:
  - an "EU-kontroll soon" notice at the top of the page
  - the fleet is sorted by EU date
  - Today → Needs attention "Rental cars – EU-kontroll due" (≤ 60 days)
  - renting out: a warning when the deadline has passed (plus a confirm), or falls before the
    expected return
- **Renting out = the test drive flow:**
  - customer name + phone, driving licence photo (the name is read via
    `/test-drives/read-license`), "customer informed" checkbox
  - odometer, handed out by, note (no items taken out / put in since 0.28.2, the user's request; old
    rentals with items still show them and ask for them at return)
  - extra: an optional **expected return** date + time (Norwegian local time, stored with `AT TIME
    ZONE 'Europe/Oslo'`; time defaults to 16:00). It's overdue in red on the page and on Today ("Rental
    cars not returned on time").
  - one active rental per car
  - no trade plates
- **Return, trash and access log:** the same as test drives (`rentals.customer_trashed_at` → wiped
  after `trash_days` by the worker; "Delete now"; `rental_access_log`).
  - The privacy notice is its own Norwegian text (`rentalPrivacyDialog`): art. 6(1)(b) rental
    agreement + 6(1)(f), fødselsnummer § 12.
  - **Contact (0.28.1):** like the kiosk. System → **Rental cars** (`rental_company/_phone/_email/_address`)
    replaces System → Company when `rental_company` is set; never mixed. If it differs from Company, `_privacy()`
    sends `operator` and the notice uses the two-company wording (staff of both, data processor, "Contact {company}").
- **Removing a car:** not while it is out. A car with rental history is only hidden (`deleted_at`);
  one without is deleted. The reg. no can then be reused.
- **Menu:** the top-menu key `rental` ("Rental cars" / "Leiebiler"). Migration 029 gave it to teams
  that had Test drive.

**Test drives** (`routers/testdrives.py`, `views/testdrive.js`):
- **Start:** car, customer name + phone (8–15 digits, optional +), **driving licence photo**,
  and the **"customer has been given the privacy information"** checkbox (required).
  - Optional: items taken out (presets; the spare **winter/summer wheels** are the most
    common) and put in (e.g. trade plates), odometer, note.
  - It is one multipart POST. One active drive per car; spot and status don't change.
- **Return:** "Received by" is the logged-in user (0.22.4; the server uses the session, not
  `staff_id`). Every item ticked back, or a note about what's missing. Customer details then
  move to the **trash** (`customer_trashed_at`) and show under "Returned — customer details
  in the trash" (for toll and speeding fines). The worker wipes them after `trash_days`;
  "Delete now" wipes them at once.
- **Trade plates (0.16.0)** (`trade_plates`, Settings → Trade plates, `/trade-plates`):
  - Admins add sets with a free name, rename them (e.g. when a plate is replaced) and
    remove/restore them (not while on a car). Stored as `test_drives.trade_plate_id`, not
    as an "added item" (the old free-text preset is gone).
  - **One car at a time:** unique index on `trade_plate_id` for drives that are out and not
    moved. If the chosen set is on another car, the start form asks to move it
    (`move_plate=true`). The old drive gets `plate_moved_at` / `plate_moved_to`, a
    `trade_plates_moved` event, and the response's `moved_from_drive_id` sends staff to
    `#/test-drive?return=<id>`, which opens that car's return dialog.
  - A drive whose plates were moved shows "register the return" on the Test drive page, the
    vehicle banner ("Register return" button) and Today. Its return doesn't need the plates
    ticked; a drive with plates still on needs "Trade plates taken off" ticked (or a note).
- **Name from the licence** (`licenselib.py`, `POST /test-drives/read-license`):
  - The OCR reads EU-format field labels `1.` (surname) and `2.` (given names), with or without the
    dot, and tries 0°/90°/270°/180°. It fills in "Given Surname" and never overwrites a typed name.
  - Fallbacks (0.19.1): a lone label misread as I/l/| (1) or Z (2) is accepted; if only one field
    is found, the name line right above/below it is used, with "low" confidence.
  - The OCR model often **drops spaces** ("OLA KRISTIAN" → "OLAKRISTIAN"). `_respace` finds
    ink column runs in the straightened box. A gap ≥ max(0.45 × median letter width, 2.2 ×
    median letter gap) counts as a space. It is only used if the letters are unchanged, and
    it never cuts off a single letter.
  - The photo is read in memory only, and licence OCR text is **not logged**
    (`scene_text(log_text=False)`).
- **Personal data never goes into `vehicle_events`.** Licence photos are served with
  `Cache-Control: no-store`.
- **Access log:** `test_drive_access_log` records opening a licence photo in full and
  "Delete now". It's shown via "Access log" on returned drives.
- **Privacy notice (GDPR art. 13):** `privacyDialog`, Norwegian, printable.
  - It shows company, then phone / e-mail / postal address on separate lines (System →
    Company).
  - It ends with signature / date / name-in-capitals lines.
  - If no contact is set, it shows a red "missing" line and the Test drive page shows a
    reminder.

**Customer car delivery (0.24.0)** (`routers/deliveries.py`, `views/deliveries.js`): customers dropping
off their car for the workshop register it on a **kiosk tablet** at the dealership (the user's choice:
the server is LAN-only, so no customer phones / public internet).
- **Kiosk mode:** an admin logs in on the tablet → Customer deliveries → "Use this device as the
  delivery kiosk" (`POST /kiosk-devices`). The device gets its own cookie `carbonara_kiosk` (365 days,
  renewed on every form load; only the token's SHA-256 in `kiosk_devices`), and the admin's session on
  it is ended. `/auth/state` returns `kiosk`; `boot()` then shows the form instead of the login screen
  (no menu: `body.logged-out`). Admins can stop a tablet (`revoked_at`); it then shows the login screen.
- **No staff login and no language switch on the tablet (0.33.12, the user's rule):** the only way
  back to a normal device is "Stop" on the Customer deliveries page (from another device). The tablet's
  language is `kiosk_devices.language` (migration 035, default `no`), chosen when it is set up and changed
  with the dropdown on its row (`PUT /kiosk-devices/{id}/language`). `boot()` applies it; the form checks
  `/auth/state` every minute and reloads for a new language or a stop, but not while a customer is
  using the form or the thank-you is showing. The staff preview (`#/kiosk`) uses the staff member's language.
- **Tablet records (0.34.2):** a tablet is known only by its cookie token (no hardware ID). "Stop" is one-way (to reuse
  a tablet, set it up again: new token, new row). Stopped tablets are deleted by the worker's `housekeeping()`
  30 days after stopping (`deliveries.KIOSK_KEEP_STOPPED_DAYS`, `purge_stopped_kiosks`). **System admins** can delete
  any tablet at once (`DELETE /kiosk-devices/{id}/record`; an active one stops too). Deleting sets
  `car_deliveries.kiosk_id` to NULL (the delivery is kept, without the tablet name). The page lists 3 tablets, the
  rest folded under "More tablets (n)".
- **Full screen (0.33.11):** browsers only allow full screen after a tap, so on a kiosk tablet every tap on
  the form asks for it while not full screen (`kioskFullscreen` in `deliveries.js`). iPhones can't; for a
  locked-down tablet use Android screen pinning.
- **On-screen keyboard (0.33.15):** no scrolling from code (0.33.14 did, and it brought the address bar back).
  On the tablet the viewport gets `interactive-widget=resizes-content` (the keyboard shrinks the page), and while
  a text field has focus the button row is `position: sticky` at the bottom (`.typing`, lifted by `--kb` where
  the keyboard is laid over the page, from `visualViewport`).
- **`/api/kiosk/*`** is the only API open without a staff session: `auth.require_kiosk_or_staff` (kiosk
  cookie or staff). Staff can preview the form at `#/kiosk` (deliveries sent from it are real).
- **The form:** reg. no (stored uppercase without spaces, 2–8 letters/digits; linked to the car in the **customer register**
  when the reg. no is there, `customer_car_id`, 0.53.0; before that it linked to Vehicles), name (`nameInput`) + phone (`clean_phone`), **key place** (one, from the list),
  **where the car is**: a tap on the location's map picture (pin stored as `pin_x/pin_y`, 0–1 share of
  width/height), **tick boxes** (any), message. Key place and pin are required once the lists/maps exist.
  Choices are stored as `{en, no}` snapshots, so renaming an option doesn't change old deliveries.
  The form clears itself after 3 min idle and 30 s after "Thank you" (next customer must not see it).
- **Maps:** one uploaded picture per location (`delivery_maps`, via `photostore`, served at
  `/api/kiosk/maps/{id}/image`, `display` size). Several maps → the customer picks the location first.
  A picture never changes: to replace it, add a new map and remove the old one. A map that deliveries
  point to can only be removed (deactivated), never deleted.
- **Lists:** key places and tick boxes (`delivery_options`) each have an English **and** a Norwegian label
  (admin-entered data can't go through the translator); `optText()` picks the user's language. Map names
  have an optional Norwegian name.
- **Statens vegvesen lookup (0.25.0):** after the form is sent, a FastAPI background task
  (`lookup_in_background`, own pool connection, after the request commits) looks up the reg. no and
  stores `svv_vin`, make/model and `svv_eu_due` on the delivery; the customer never waits. Staff see
  VIN + EU-kontroll (badge) on the delivery and can "↻ Look up again" (`POST /deliveries/{id}/registry`).
  An error / "not set up" keeps earlier data; "not found" clears it (probably a mistyped reg. no). A
  delivery not linked by reg. no gets linked to a car in Carbonara with the same VIN.
- **Owner name from SVV (prepared, not sent yet):** the current SVV API has no owner. `vegvesen.owner()`
  tries likely field names (`OWNER_PATHS`, person / company); adjust only there when SVV's owner data
  arrives. Strategy: **both names are kept** (`customer_name` as typed, `svv_name` tidied from capitals);
  the **SVV name is shown first** everywhere (`display_name` = coalesce, Today block too), and the typed
  name stays visible under it when they differ. `common.name_match` → `same` (same words, any order) /
  `similar` (shorter name's words all in the longer one; one typo per 4+ letter word, initials; æ/ø/å =
  ae/o/aa) / `different` (warn badge, e.g. a spouse delivering) / `company` (company-owned car). It never
  blocks anything. The SVV name is personal data: only on the delivery, deleted with it.
- **Staff:** Today block "Customer cars delivered – not received yet"; `#/deliveries` lists them with
  map + pin; "✓ Received" (received by = session user). Received deliveries are **deleted whole** after
  `trash_days` by the worker ("Delete now" at once). `vehicle_events` get only `customer_delivery` /
  `customer_delivery_received` with the delivery id — never name, phone or message.
- **Privacy:** short text on the form + `deliveryPrivacyDialog` (Norwegian document, art. 6(1)(b)).
  - **Contact on the notice (0.26.3):** the kiosk notice can name **another company** than the
    dealership. `_privacy()` in `routers/deliveries.py` uses System → **Customer deliveries (kiosk)**
    (`delivery_company/_phone/_email/_address`) when `delivery_company` is set. Otherwise it uses
    System → Company.
  - The two blocks are **never mixed**, so a customer never sees one company's name with the other's
    phone number.
  - **Two companies under one roof (0.27.0).** The first install is like this: the dealer runs
    Carbonara and the workshop receives the cars. When the kiosk company differs from System →
    Company, `_privacy()` also sends `operator` (the Company name). The notice then says:
    - the kiosk company is the controller
    - staff of **both** companies with access can see the data
    - the operator stores it on its server for the kiosk company (data processor, art. 28)
    - "Contact {kiosk company}" instead of "Contact us"
  - For a single dealer, the notice keeps the original "our staff / our own server" wording.

**Login & GDPR (0.11.0)** (`auth.py`, `routers/session.py`, `views/login.js`):
- **Login:** a personal **PIN** (4–8 digits, scrypt).
  - 5 wrong attempts lock the account for 15 min.
  - A login creates a session: an HttpOnly cookie `carbonara_session` lasting 30 days. Only
    the token's SHA-256 is stored.
- **Route protection:** routers are included with `dependencies=[Depends(require_staff)]`.
  Admin-only routes add `require_admin`; System routes use `require_superadmin`.
- **First start:** while nobody has a PIN, the login screen runs **setup**, and that person
  becomes admin + system admin. Admins then set PINs in Settings. A reset also unlocks the
  account and logs out that person's devices.
- **PIN hashes never leave the server:** use `STAFF_PUBLIC`; never `SELECT * FROM staff` in a
  response.
- Staff pickers default to the logged-in user (`setInspectorId(me.id)`).
- **Cookies and HTTPS (0.37.0):** the session and kiosk cookies are `secure` when the request came through
  caddy (`auth.cookie_secure`: `X-Forwarded-Proto: https`), not over plain HTTP on `APP_PORT` (still open while
  devices move over).
- **Full licence photo is kept on purpose (user's decision, 2026-11-09).** It includes field
  4d, the national identity number (fødselsnummer), for secure identification to the police,
  SVV, toll companies and insurers (personopplysningsloven § 12). The notice says so. Do
  **not** mask it unless the user asks.

**Staff records (0.19.0)** (`routers/admin.py`, Settings → Staff):
- **First name, last name, phone** (all required when adding or editing). `staff.name` is still
  stored as "First Last" and is what every join, picker and the login list uses; don't build
  names from the parts elsewhere. Existing staff were split (first word / rest) and show
  "Missing: last name, phone" until edited.
- **Auto-capitalize:** `common.cap_name` (server) and `capName` / `nameInput()` (`ui.js`,
  while typing) uppercase the first letter and the letter after a space or "-"; the rest is
  kept as typed ("McDonald"). Use `nameInput()` for any new person-name field.
- **Part numbers and names (0.48.2, the user's rule):** part numbers are in capital letters (`upperInput()` in `ui.js`
  while typing; `.upper()` on the server, also on import and free-text order lines). Part names, free-text line names,
  company names and customer names use `nameInput()` / `cap_name` (capital after a space or "-").
- Phone numbers go through `common.clean_phone` (shared with test drives): 8–15 digits,
  optional +.
- **Delete** (admins, only after deactivating, never yourself; a system admin only by a system
  admin): `DELETE /staff/{id}` tries a real delete in a savepoint. If any row refers to the
  person (`ForeignKeyViolation`), it sets `deleted_at` instead and wipes phone, PIN and rights,
  so the name stays on the history they signed (storage checks are warranty evidence).
  Deleted staff are never listed.

**Roles:**
- **Staff:** everything day-to-day.
- **Admin:** staff/PINs, PDI lists, PDI sheets + stamps, deleting spots, cancelling storage checks, delivery kiosk setup
  (maps, key places, tick boxes, kiosk tablets).
- **System admin** (`is_superadmin`; always also admin): the System page, and granting or
  removing system admin. Only a system admin can change another system admin.
- **The word "super-admin" must not appear in UI text;** it is "System admin" /
  "Systemadministrator".

**Teams (0.26.0)** (`teams`, `staff.team_id`; System page → Teams; `/system/teams`, `/system/staff/{id}/team`):
- System admins create teams with a name, tick which **top menu items** each team sees
  (`auth.MENU_ITEMS`: arrivals, vehicles, pdi_orders, storage, testdrive, rental, customers, parts, deliveries, settings) and place users.
  **One team per user.** Today is always shown; System stays system-admin-only.
- `auth.menu_for()` puts `menu` on the session user (`/auth/state` → `me.menu`): system admins get
  everything; others Today + their team's items; **no team = Today only** (the user's choice). New staff
  have no team until a system admin places them. Migration 027 put existing staff in "All staff".
- **Not a server lock (the user's choice):** `canSee(nav)` in `ui.js` hides menu items (`renderUser`) and
  `render()` shows "Not available" for a route whose nav key isn't allowed. The API and Today board
  still return everything. A new menu item = add its key to `MENU_ITEMS`, `MENU_LABEL` (`system.js`)
  and the route's nav key.
- **Links follow the team (0.33.17):** `canOpen(href)` (`ui.js`, check set by `app.js` from its route table) turns
  Today rows and tiles that point to a page the team can't see into plain text. PDI rows (Today, the PDI page,
  the 🔔 bar; `pdiCarHref`) go to
  `#/pdi-orders?car=<vehicle id>` (scrolls to and marks that car) for everyone who sees PDI orders (0.33.19, the
  user's rule; before, only teams without Vehicles); others get the car page.
- A change applies when the user next opens or reloads the app.
- **"More" dropdown (0.35.0, the user's request):** System page → **Top menu** ticks items (`auth.MORE_ITEMS` = the
  team items + `system`) that move from the menu line into a "More" dropdown at its end, **the same for everyone**.
  Saved in `app_settings` under `menu_more` (comma list, not in the `SETTINGS` registry; `GET/PUT /system/menu-more`);
  `/auth/state` sends it as `me.menu_more`. `layoutNav()` in `app.js` moves the `<a data-nav>` links into the panel
  (a `position: fixed` element on `<body>`, since the nav scrolls sideways and would clip it). "More" is hidden when
  nothing is ticked or none of the ticked items is open to the user; it looks active while one of its pages is open.

**System page (0.12.0)** (`config.py` `SETTINGS`, `routers/system.py`, `views/system.js`):
- **Folding cards (0.48.5, the user's request):** on `#/settings` and `#/system` every `section.card` with an `h2` (directly
  or in `.card-head`) is closed until its heading is clicked (`initFoldCards` in `ui.js`, started once in `app.js` after
  the translator; a MutationObserver on `#app` also covers cards drawn later and pages that redraw). Open cards are kept
  in `localStorage` `carbonara.open.<page>` by the heading's letters (counts ignored). Cards without an h2 (notices)
  always show. Another page = add it to `FOLD_PAGES`.
- **Organisation numbers (0.48.4):** `privacy_org_no`, `delivery_org_no`, `rental_org_no`, `customers_org_no` (9 digits,
  `ORG_NO_PATTERN`), sent as `org_no` in each `_privacy()` / `company()` block (`common.org_no` formats "123 456 789") and
  shown after the company name: privacy notices "(org.nr. …)", storage report, PDI order sheet and e-mail signature.
- **Groups:**
  - **Statens vegvesen:** key 🔒, sync days, URL, auth header/scheme, call pause
  - **E-mail (SMTP):** password 🔒
  - **Company:** company name, organisation number (0.48.4), dealer number, customer phone, e-mail, postal address
  - **Customer deliveries (kiosk):** company name, phone, e-mail, postal address for the kiosk
    privacy notice (empty company name = Company is used)
  - **Rental cars (0.28.1):** the same four fields for the rental privacy notice
  - **HTTPS (0.39.0):** server address (`carbonara_host`), shown inside the HTTPS card, not as its own card
  - **Recalls (0.41.0):** `recall_check_days` (default 30): how often a car in storage is due for a recall check
  - **Market data (0.46.0):** `market_data` off / on (choice labels Off / On); `/auth/state` sends `me.market_data`
  - **Modules (0.48.0):** `module_cars` / `module_workshop` / `module_rental` (on / off; see *Customer register + parts orders*)
  - **Customer register (0.48.0):** company name, phone, e-mail, postal address (empty company = Company), first customer number
  - **Wheels (0.29.0):** studded tyre region (`tyre_region` south / north; readable names via `CHOICE_LABEL` in `system.js`)
  - **Data retention**
- **Where a value comes from:** `settings.<name>` = DB `app_settings`, else env `NAME`, else
  default. Cached 20 s per process (the worker too). **Always read settings at call time;
  never copy them into module constants.**
- **To add a setting:** one `Setting(...)` line, then use `settings.<name>`. Also add the
  Norwegian label/help to `i18n.js`.
- **Secrets** are write-only (the API returns the last 4 characters). The log records who
  changed which key, never the value.
- **Background worker card (0.36.0)** (`workerstatus.py`, migration 037; `GET /system/worker`): the worker writes
  `worker_status` 'loop' after every round (ok = false + `step:ErrorType` when deleting private messages or the SVV
  sync failed) and 'housekeeping' after the daily cleanup. Problems: no check-in yet, **no round for 15 min**
  (stopped), the last round had errors, **no daily cleanup for 26 h**, or the cleanup failed. Shown on the System page
  ("✓ Running normally" or the red notice) and as a red notice at the top of **Today for system admins**
  (`workerStatusNotice` from `system.js`). Why: the worker does the GDPR deletions the privacy notices promise.
- **Disk space card (0.36.1)** (`diskstatus.py`; `GET /system/health` = `{worker, disk}`, used by the System page and
  Today): free space on the disk that holds `PHOTO_DIR` (`shutil.disk_usage`; the bind mount = the server's own disk),
  a usage bar, disk size and the database size (`pg_database_size`; the DB volume may be on another disk). **Amber below
  15 % or 10 GB free, red below 5 % or 3 GB** (constants in `diskstatus.py`). Not ok → `diskNotice` on the System page
  and at the top of Today for system admins.

**PDI = nybilklargjøring (0.12.0)** (`routers/pdi.py`, `views/pdi.js`, `mailer.py`):
- **Who and what:** new cars get a PDI at **RBV – Rygge Bilverksted**, a separate firm in the
  same building. The salesperson fills in the car's **PDI order** card:
  - items from the list (some with a choice, e.g. Gulvmatter: Gummi/Tekstil)
  - "Other"
  - winter tyres: none / in stock / ordered by sales (+ expected date) / RBV orders (+ tyre
    company)
  - a note
- **Status:** draft → sent → booked (`pdi_at`) → done, or cancelled. One open order per car.
  Editing after sending shows "changed since sent".
- **Sent to the workshop planner (0.56.0, the user's rule: "the e-mail option is obsolete"):** "Send to workshop…" opens
  the order sheet with "Send to the workshop planner" (+ "🖨 Print / save as PDF"); `POST /pdi/{id}/send {via: 'planner'}`
  makes the PDI's work order (`_carbonara_work_order`: title "PDI", job type PDI, tasks = the items, unplanned, no
  mechanic, so it shows under "Not planned" in every team's planner) and puts its number on the order. Sent again after a
  change: new items are added to the work order's tasks (`work_orders.add_tasks`).
  - **The date follows the planner:** planning / moving the job (`PATCH /work-orders/{id}` with `planned_at`) →
    `pdi.follow_work_order`: PDI date = the job's start, confirmed (by whoever moved it; events `pdi_booked` +
    `pdi_date_confirmed` with `source: planner`, the orderer gets the "PDI date confirmed" notification), expected done =
    the day after. Taken off the plan → back to "Sent – waiting for date".
  - **And the other way:** "Enter / Change PDI date" on the PDI moves the work order (`work_orders.follow_pdi`, open /
    in progress only); clearing the date takes it off the plan. Cancelling the PDI cancels its work order while it is
    still open.
  - The e-mail code below (`compose`, SMTP, recipients) is still there but no longer offered; old orders show "sent … to …".
- **E-mail to RBV (before 0.56.0)** (Norwegian, `compose()`):
  - Subject: "Bestilling av nybilklargjøring – …"; it asks RBV to reply with a date and time.
  - Sent by SMTP if configured (it isn't yet). Otherwise via **"Open in e-mail app"**
    (mailto) plus a "did you send it?" confirmation, or "Copy text".
- **Print or PDF instead of e-mail (0.17.0):** the send dialog has two modes, "✉ E-mail" and
  "🖨 Print or PDF". Print mode shows a Norwegian A4 order sheet (`pdiSheet()` in `pdi.js`:
  car, ordered items with an "Utført ☐" column, other, winter tyres, note, date/time lines,
  "Bestilt av" / "Mottatt av verkstedet" signatures). The browser's print window also
  saves it as a PDF. Afterwards "did you give it to the workshop?" records `sent_via = 'print'`
  with no `sent_to`; shown as "Printed / PDF". Opened with `openDialog(..., { doc: true })`,
  so the app title bar isn't printed. Print mode works with no e-mail recipients set up.
- **Lists in Settings** (`pdi_lists`, admins): items, tyre companies (NorgesDekk, Drivalia)
  and recipients (one is the default). During testing the user's own address is the
  default; switch to RBV when going live.
- **The PDI date** is entered **manually** ("Enter PDI date"), on any open order, even
  unsent. A booked but unsent order shows a warning and stays under "not sent yet" on Today.
  RBV can't reach the server. Reading replies (IMAP) or a booking link are possible later.
- **Reminder:** on Today, the day before ("make the car ready"), with "✓ prepared" / "not
  prepared yet" on the today/tomorrow rows.
- **"Did you give/send it?" (0.18.0):** after printing or opening the e-mail app, an in-app
  Yes/No dialog (`givenDialog`, not the browser's `confirm`) asks, with optional PDI date + time.
  Yes records the send and, if a date was given, the booking.
- **Preparing the car (0.18.0)** (`prepDialog`, `POST /pdi/{id}/prepare`): the car must be
  ready the day before the PDI.
  - **Notification:** a 🔔 bar under the top bar on **every page** (`#notify`, `refreshNotify()`
    in `app.js`, `GET /pdi/prepare-due`) for booked PDIs up to the **next working day** (a
    Friday includes Monday) that aren't prepared. Refreshed on every navigation, every 15 min
    and on the `carbonara:pdi-changed` event. Also sent to phones from 0.38.0 (`pdi_prep`, see *Phone / PC
    notifications*).
  - **The form:** trade plates (from Settings → Trade plates; it warns if the set is out on a
    test drive, but doesn't block); where the car is (storage spot dropdown, and **choosing
    another spot moves the car**, logged as `moved`) plus a short message; and where the
    winter wheels are, **required** when tyres are `in_stock` / `sales_ordered` (the dealer has
    them).
  - Shown on the PDI card ("✓ Prepared for the PDI …", "Prepare for PDI" / "Edit
    preparation" on booked orders); history event `pdi_prepared`. Doesn't touch `updated_at`,
    so it doesn't count as "changed since sent".
- **Ready for registration and delivery (0.15.1):** after "✓ PDI done", the car shows a green
  "✓ Ready for registration and delivery" badge (vehicle header + Vehicles list) until it is
  taken off site (delivered). It is **derived** (`common.READY_SQL`: a done PDI order and status
  ≠ off_site), not a `vehicles.status` value, because status means *where* the car is and the
  storage counts depend on it. Vehicles filter `status=ready`; Today tile links there.
- **Finding PDI cars (0.15.0):**
  - Vehicle page: a banner at the top while an order is open ("PDI booked dd.mm.yyyy HH:mm", or
    ordered / not sent), with "See order" (scrolls to the card) and "All PDIs".
  - Vehicles list: a badge per car (`pdi_status`, `pdi_at` from `GET /vehicles`).
  - PDI page `#/pdi` (`GET /pdi` → `open`, `week`, `done`): this week (booked + done; the same
    rule as the Today tile, `pdi.THIS_WEEK_SQL`), date passed, later, waiting for a date, not
    sent, recently done.
- **Expected completion + confirmed date (0.30.0)** (migration 031):
  - `pdi_orders.expected_done_date`: set with the PDI date ("Enter / Change PDI date"). It defaults to
    **the day after the PDI date** (the user's rule): the dialog follows the date until it's changed by hand,
    and the server uses date + 1 when none is sent (e.g. from "given to the workshop?"). Not before the PDI date.
  - `pdi_confirmed_at / _by`: "✓ Confirm PDI date" (`POST /pdi/{id}/confirm`, booked orders only; event
    `pdi_date_confirmed`). **A new date or time clears it**; saving the same date keeps it. Removing the date
    clears both. Shown as a badge ("✓ Date confirmed …" / "Date not confirmed") on the PDI card and the PDI
    orders page; the PDI page says "date not confirmed".
- **Work order no. (0.32.0)** (`pdi_orders.work_order`, migration 033; the user's request):
  - **Also asked when the PDI date is entered the first time (0.33.18):** "Enter PDI date" and the "given to the
    workshop?" dialog show an optional "Work order no." while the order has no date (`BookingIn.work_order`, saved
    with `pdi_sheets.save_work_order`, history entry `pdi_work_order_changed`).
  - **Entered when confirming the PDI date:** "✓ Confirm PDI date" opens a dialog (`confirmDate` in `pdi.js`)
    with a required "Work order no." (`POST /pdi/{id}/confirm` `{work_order}`; max 40 characters, spaces
    tidied). A new PDI date clears the confirmation but **keeps the number**.
  - **Shown and changed** with `workOrderLine` ("Work order no. 123456 · Change" / "Add work order no.") on the PDI
    card and the PDI orders page (`PUT /pdi/{id}/work-order`, open or done orders; event `pdi_work_order_changed`;
    doesn't touch `updated_at`).
  - **On the PDI sheet:** placeable text field `work_order` (OCR labels: arbeidsordre, ordrenr, work order…). The
    "PDI done" / "Make PDI sheet" dialog shows the number prefilled and editable (required when the chosen sheet
    has the field); a number typed there is saved on the order first (`pdi_sheets.save_work_order`).
  - **Every change of the number is a history entry (0.32.1, the user's rule):** `pdi_work_order_changed`
    `{from, to}`, wherever it is changed (the Change link, the sheet dialogs, or confirming again with another
    number). The first number entered at confirmation is logged in `pdi_date_confirmed`.
- **PDI orders page (0.30.0)** (`#/pdi-orders`, `views/pdiorders.js`, `GET /pdi/orders`; top menu "PDI orders" /
  "Nybilklargjøring", team menu key `pdi_orders`; migration 031 gave it to teams that see Vehicles):
  - **Which cars:** every car with a PDI order (its open one, else its latest done one; cancelled ones don't
    count) **until the car is both marked as registered and taken off site** (the user's rule). Open orders
    first (by PDI date), then "PDI done – waiting for registration or delivery" (latest done on top, 0.33.20).
  - **Per car:** make / model, reg. no, VIN, status + registered + wheels badges, the **right-side photo**
    (`RIGHT_PHOTO_SQL`, tap to enlarge), colour / fuel / new-used / spot / wheels, the order (items, tyres,
    other, note, preparation), PDI date, expected completion, sent / done, and the car's **history**
    (folded; `EVENT_LABELS` / `eventDetail` exported from `vehicles.js`).
  - **No documents (the user's rule):** no document list, and `document_*` events are left out of the history
    on the server (`HIDDEN_EVENTS`).
  - **"✓ Delivered" (0.35.2–0.35.3, the user's request):** on every "PDI done" car ("✓ Registered" once it is off site).
    Opens `deliveredDialog` with two tick boxes, both ticked by default and only offered when still needed:
    - **Delivered:** the same as Move car → Off site (`POST /vehicles/{id}/move` `{location_id: null, note: "Delivered"}`,
      event `moved_off_site`). The note is shown through `tr()` (`trText` in `vehicles.js`), so it reads "Levert" in Norwegian.
    - **Registered:** the same as "Mark as registered" (`POST /vehicles/{id}/registered`, starts the SVV sync); done
      first. Not offered when the car is already marked as registered (by hand or by a sync that found it registered).
  - Actions: "✓ Confirm PDI date", "Enter / Change PDI date" (the same `bookingDialog`), "Open car page"
    (only for teams that see Vehicles). Made so a workshop team can be given only this page, but like all
    teams it's a menu filter, not a server lock.
- **PDI sheets (0.31.0)** (migration 032; `app/pdisheet.py`, `routers/pdi_sheets.py`, `views/pdisheet.js`):
  - **What:** when a PDI is marked done, the **car model's own PDI form (a PDF)** is filled in with reg. no
    (formatted "AB 12345"; empty if not registered yet), VIN, mileage, date, work order no. (0.32.0), the signer's name, a **company
    stamp** and the **signature of the person marking it done**, and stored on the order
    (`pdi_orders.sheet_file_key`, `done_km`, `sheet_template_id / _stamp_id / _date / _made_at / _made_by`).
  - **"✓ PDI done" dialog** (`doneDialog`, on the PDI card and the PDI orders page, booked orders): PDI sheet
    (the template matching the car preselected; "No PDI sheet" allowed), mileage (required with a sheet; the
    arrival inspection's km shown as a hint), date, stamp (default preselected), your signature (or "Add my
    signature"), and **"Summer or winter wheels? \*"** (required, prefilled from the car; 0.32.3, the user's rule;
    saved on `vehicles.wheels` with the same `vehicle_details_updated` entry as the vehicle page's dropdown; not
    asked in "Make PDI sheet"). One request: `POST /pdi/{id}/done` with `{template_id, km, date, stamp_id,
    work_order, wheels}`; nothing is saved if the sheet fails. Afterwards "📄 Open PDI sheet" (a tap, so no popup
    blocker).
  - **12V battery + tick boxes (0.33.0, migration 034; the user's request):** the MG forms have a 12V reading and
    many tick boxes.
    - Text field `battery` (OCR labels 12V / batteri / spenning…), filled as just the number "12,6" (`fmt_volt`; the forms print "Volt" themselves, 0.33.3). When the
      matched label is only the unit ("Volt"), the suggestion puts the number before it (0.33.4). The dialog
      asks "12V battery (V) \*" (required when the sheet has the field; comma or dot). Stored as
      `pdi_orders.done_battery_v` and logged in `pdi_done` / `pdi_sheet_made` (`battery`; not personal data).
    - Field `checks` = **many positions in one field**: `{size, marks: [{page, x, y}]}` (centre of each box). In
      "Place fields" → "Tick boxes", each tap adds a box and a tap on a tick removes it; "Remove all". "Suggest
      positions" also finds empty square boxes on the page pictures (`find_boxes`, OpenCV: square outline
      0.7–4 % of the page width, hollow, not round like O/D), only when no boxes are placed yet. **One box per
      spot (0.33.5):** MG's tick cells are grey | white | grey squares, so candidates close together on a line
      compete and only the lightest inside (the white box) is kept; mid-grey or darker insides never count.
      **Grey cells (0.33.7):** another MG S6 form has wide, solid light-grey tick cells (≈ 7.6 × 2.6 % of the page,
      black borders); those count too (2–10 % wide, aspect 1.2–4.5, evenly grey 150–240; white rectangles never,
      they are headers / text boxes), sized by their height. The suggested tick size is 85 % of the median box.
    - The dialog shows "Tick all boxes on the PDI sheet" (unticked by default, remembered as `sheet_checks` for
      "Make sheet again"). Ticks are drawn with ZapfDingbats (built-in PDF font); reportlab needs the
      Unicode "✔" (passing "4" came out as a black square, fixed 0.33.6). "Test" ticks every box.
  - **Done orders:** "📄 PDI sheet" (`GET /pdi/{id}/sheet`, inline, `no-store`) and "Make PDI sheet" / "Make
    sheet again" (`POST /pdi/{id}/sheet`, e.g. once the car has its reg. no; the old file is removed after
    commit; event `pdi_sheet_made`). The signer is whoever makes the sheet.
  - **Templates = the user's chosen approach "tap positions" (Settings → PDI sheets, admins):** upload the
    model's PDF with a name and **car models** (comma-separated; `match_template` picks the longest name found in
    make + model, ignoring case/spaces/punctuation). Then "Place fields" (`placeDialog`): pick a field, tap the
    page picture (`GET /pdi-templates/{id}/pages/{n}`, rendered by pypdfium2 at 1400 px **with the form fields**
    (`init_forms()`, 0.33.4: a fillable form's tick boxes are fields and were missing) and cached as
    `<key>_pf<n>.png`; older `_p<n>.png` files are just unused). Text: x, y = start of the text, middle of the line, size in pt. Stamp / signature: centred,
    `w` = share of the page width. Stored as shares of the page in `pdi_templates.fields`, so it doesn't depend on
    the picture size. **OCR suggests positions** (`suggest`: RapidOCR `scene_text` on the page pictures, labels like
    VIN / Reg.nr / Km / Dato / Signatur / Stempel in `LABELS`, the shortest matching text wins) automatically on the
    first open and with "Suggest positions"; they only fill empty fields. "Test" (`GET /pdi-templates/{id}/test`)
    fills it with made-up values, the default stamp and your own signature.
  - **Text style (0.33.2, the user's default):** text fields are **bold** (Helvetica-Bold; per field "Bold" checkbox,
    `bold: false` turns it off, a missing flag = bold) and **12 pt** by default (suggested sizes +2 pt, 8–16).
  - **Suggested text goes into the box (0.33.2):** `field_start` looks along the label's line: a label in a black cell
    → past the dark area into the light box; a label on white followed by a box border (a dark line taller than the
    text) → just inside the border; otherwise just after the label ("Reg.nr: ____").
  - **Header bars (0.33.3):** fields that share one label (MG S6: "FIRMASTEMPEL, DATO OG SIGNATUR" = stamp, date and
    signature) are placed together. When the label sits in a dark bar that runs on to the right, `_box_below` finds the
    widest empty column run in the box under the bar, and the fields go side by side there: stamp | signature | text.
  - **Filling** (`fill`): a reportlab overlay per page merged onto the original with pypdf (the form is never
    changed); rotated pages are straightened first (`transfer_rotation_to_content`); Helvetica (æøå OK).
    **Fillable ("klikkbar") forms (0.33.1):** viewers draw form fields *on top of* the page, so their white boxes hid
    the ticks and text. `_flatten_widgets` draws each field's current look (`/AP /N`, check boxes by `/AS`) into the
    page and removes the fields and `/AcroForm` before the overlay is merged, so the filled sheet isn't editable.
    If flattening fails, the page is filled as before (logged).
    - **Never rewrite the page content (0.33.6):** the looks are added as extra streams, `/Contents = [q, <original
      streams>, Q + looks]`. 0.33.1–0.33.5 read the content back with `get_contents().get_data()`, which came back
      empty for the MG S6 form, so the made sheet lost the whole form (only our values and boxes were left).
    - **The form's own check boxes (0.33.6):** MG's boxes have the states `/Ja` (its own ✔) and `/Off`. With "Tick all
      boxes", a check box with a tick mark inside its rectangle is drawn in its on state (first state ≠ `/Off`), and
      that tick is not drawn again (`_flatten_widgets` returns the ticks it handled).
  - **Stamps** (`pdi_stamps`, admins; several, one default) and **my signature** (`staff.signature_key`; every user
    their own, drawn on a signature pad or an uploaded picture; Settings → My signature and the 👤 menu;
    `GET/PUT/DELETE /my-signature`, never readable by others). Uploaded pictures go through `clean_image`:
    near-white → transparent, margins cropped, PNG.
  - **Files** (photostore's `{file_key, original_ext}` pattern): `pdi/templates/…pdf`, `pdi/stamps/…png`,
    `pdi/signatures/…png`, `pdi/sheets/yyyy/mm/…pdf`. `purge_vehicle` deletes the car's sheets; deleting a staff
    member deletes their signature (signed sheets keep it in their own PDF). A template or stamp used by a sheet is
    only hidden (`deleted_at`) when removed.
  - **Build:** `pypdf`, `reportlab`, `pypdfium2` (BSD / Apache) in `requirements.txt`; the Dockerfile's import check
    covers them.

**Storage maintenance for new cars (0.13.0)** (`storagecare.py`, `routers/storage_care.py`,
`views/storagecare.js`). Source: MG bulletin **SI-GI2022102501** plus MG's sheets (long-term
storage, periodic checklist, 12V battery form).
- **Applies to all factory-new cars** (`condition = 'new'`) in storage, until the PDI is done
  (the user's choice: MG's list for all makes).
- **Schedule:** the arrival check, then periodic check *n* due *start + n months*. Every 6th
  is a 6-month check and every 3rd a 3-month check; larger checks include the smaller items.
  `start` = arrival check date, else first placement.
- **The arrival check is called "First storage check" in the UI** ("Første lagerkontroll"), so
  it isn't mixed up with the arrival inspection (the user's request, 0.15.0). In code and DB it
  is still `kind = 'arrival'`, and the printed report keeps MG's term "Ankomstkontroll".
- **Part of the arrival inspection (0.15.0):** for a factory-new car without a valid first
  storage check (and no PDI done), `inspections._storage_check` adds a step "4. First storage
  check" plus a **required** checklist item, so the inspection can't be completed without it.
  The step opens the same form (`storagecare.checkDialog`). `programme()` allows the arrival
  check while the car's status is `intake`. A car coming back already has one, so it is
  skipped.
- **Items per fuel type** (`ITEMS`, Norwegian labels, also printed): HV-battery steps for
  BEV/PHEV/FCEV; no "start the engine" for pure electric. Unknown fuel shows all items, with
  N/A allowed.
- **Rules (server-side):**
  - Every item OK / Not OK / N/A.
  - Tyres: one value plus "all four within 2.6–2.8".
  - 12V below 12.5 V or tester not "Good" → charged/replaced is required, plus the voltage
    after charging.
  - SOC below 30 % → "charged to ≥ 50 %".
  - Anything not OK → remarks are required. Each check is signed with the staff member and
    the time.
- **Checks are never deleted** (warranty evidence). An admin can **cancel** one with a reason
  (`/storage-checks/{id}/void`). A cancelled check leaves the schedule but stays in the
  report struck through ("ANNULLERT"), plus the section "Annullerte kontroller".
- **Reminders:** "Storage checks due" on Today (due ≤ 3 days, or overdue).
- **Printable report** `#/vehicles/:id/storage-report` (Norwegian A4):
  - a header with company, **dealer number**, VIN, model, colour, arrival, reg. date, spot,
    battery part no. and arrival voltage
  - the arrival check, a periodic grid (max 6 per table), MG's 12V battery form, remarks, and
    a signature/stamp box
  - "Only 12V battery form" prints that part alone (warranty claims)

**12V charging for used cars (0.21.0)** (`battery_charges`, end of `routers/storage_care.py`,
`batteryCard` in `views/storagecare.js`):
- Used cars (`condition = 'used'`; "not chosen" doesn't count) in storage get their 12V battery
  charged **every month**. Card "12V battery charging" on the vehicle page: next charge,
  last charge, all charges, "🔌 Record charge" (voltage before/after optional, note).
  Below 12.5 V after charging needs a note.
- **Due** = one month after the latest of the last charge and the start of the current stay
  in storage. The stay starts at the latest placement that doesn't continue an earlier
  assignment (a move ends one and starts the next in the same transaction, so
  `removed_at = placed_at`); coming back from off site starts a new stay.
- Today: "12V battery charging due (used cars)", due within 3 days or overdue (same rule as
  storage checks). Events `battery_charged` / `battery_charge_voided`; an admin cancels a
  charge with a reason (struck through, never deleted).

**Printing:**
- `@page { size: A4; margin: 0 }`: the browser prints no header/footer (title, date, URL,
  page no.). Documents (`dialog`, `.report`) get 15 mm padding instead.
- Dialogs print black on white even in the dark theme.
- With a dialog open, only the dialog prints. Otherwise the page prints without the topbar,
  footer and `.no-print` elements.

**Today board (0.12.0)** (`routers/dashboard.py`, `views/today.js`): the start page `#/`, one
`/api/dashboard` call.
- **Today/tomorrow:** PDI tomorrow (warn), PDI today, PDI date passed, storage checks due,
  12V charging due (used cars), out on test drive, arrivals in progress.
- **Needs attention:** PDI orders waiting for reply, unsent orders, EU-kontroll ≤ 60 days,
  service ≤ 31 days, SVV differences, summer wheels (amber / red) and winter wheels after the season
  (notice), cars here + rental cars (rental rows only for users who see Rental cars).
- **Then:** upcoming PDIs and number tiles. Attention lists only cover cars that aren't off
  site.
- **Message board (0.34.0)** (`messages`, migration 036; `routers/messages.py`, `views/messages.js`): right under
  the page title (the user's request).
  - **Limited to the team (the user's rule):** a user sees their own team's messages plus messages to everyone
    (`team_id` NULL). Staff write to their own team; staff without a team can't write (no button). **Admins**
    choose "Who sees it": Everyone or any team (own team preselected; `GET /messages/teams`, `to` = `all` / team id).
    Deleting a team deletes its messages.
  - One line, max 300 characters ("+ Write a message"). Shown with the writer's **initials** (first + last name;
    the full name on hover), the time written and "To everyone" / the team name.
  - A message is shown for **24 hours**. Expired rows are deleted on every `GET /messages` and by the worker's
    `housekeeping()`; the board also drops them while the page stays open.
  - Several messages: one at a time, newest first, **changing every 8 s**, with "n / m" and dots to switch.
    The board reloads every minute so new messages show up.
  - The writer or an admin can delete a message (✕). Message texts are never logged.

**Phone / PC notifications (0.38.0)** (Web Push; migration 038; `app/push.py`, `routers/notifications.py`,
`views/notifications.js`, `frontend/sw.js`; the user's request):
- **Needs HTTPS** (browsers only allow it on a secure address, so the certificate must be installed). Each person turns it
  on per device: 👤 menu → **Notifications** ("Turn on notifications", "Send a test", "Turn off on this device") and
  ticks which kinds they want (`staff.push_prefs`, all their devices; a missing key = on). iPhone / iPad only from
  the Home Screen app; Opera Touch probably not (use Chrome). The kiosk tablet gets none.
- **How it's sent:** the browser's push address (Google / Apple / Mozilla / Microsoft; `PUSH_HOSTS` allowlist, never a
  local address) + keys in `push_subscriptions`, **tied to the login session** (`session_hash` FK ON DELETE CASCADE):
  log out, PIN reset or expired session = no more notifications on that device. The device remembers who turned it on
  (`localStorage carbonara.pushOwner`); `syncPush()` at boot re-binds it to the current session, or drops it if
  someone else is logged in now. Logout calls `pushLogout()` first.
- `push.notify(conn, staff_ids|None, kind, en=(title, body), no=(title, body), url=…)` only writes `push_outbox` rows
  in the request's transaction (savepoint, never raises; a failed request sends nothing). A **thread in the app
  process** (`push.start()` in `main.py`'s lifespan) sends them every 3 s with `pywebpush` (encrypted for the browser,
  signed with our VAPID key: one `app_settings` row `push_vapid` = "private public", made at startup, never shown;
  changing it stops every device until turned on again). 404/410 from the push service deletes the subscription.
  Signature contact = `mailto:` the company e-mail (System → Company), else a placeholder.
- **Texts are short, in the recipient's language (both languages in `push.py` / the hooks, since the server writes
  them), and never hold customer data** (no customer names, phones, message texts): they show on locked phones.
- **Kinds** (`KIND_MENU`: kinds tied to a page only go to people whose team sees it):
  - `dm` new private message ("From {name}", opens the conversation) — `routers/dm.py`
  - `notes` a reminder on my note is due (0.40.0; any time of day, once per reminder; only the pinned car / page title
    is sent, never the note's text) — `push._note_reminders`, opens `#/notes`
  - `board` new Today board message for your team / everyone (writer's name only) — `routers/messages.py`
  - `pdi_status` PDI date confirmed / PDI done, to whoever made the order (not when they did it themselves) — `pdi._notify_status`
  - scheduled, once a minute by the same thread (`scheduled()`, `push_sent` keys make each go out once; kept 30 days):
    - `pdi_prep` booked PDIs up to the next working day not prepared (the 🔔 bar), Mon–Fri 07:30–21:00, once per order a day
    - `daily_due` storage checks + 12V charging + recall checks due (same lists as Today: `storage_check_due_list`,
      `charging_due_list`, `recalls.due_list`), one per working day from 07:30
    - `late_return` test drive out > 3 h / rental past its expected return, to whoever handed it out, 07:00–21:00
    - `system` (system admins) worker problems and disk warn / bad, each at most once a day, not in the first
      10 min after a start. In the app, not the worker, so it can warn when the worker has stopped.
- `/sw.js` (site root, scope `/`) caches nothing; a tap opens the page (`carbonara-open` message to an open window,
  else a new one); a `dm` push updates the 💬 count (`carbonara-push` → `carbonara:dm-changed`).

**Recalls / campaigns (0.41.0, phase 1)** (migration 040; `routers/recalls.py`, `views/recalls.js`; the user's request:
"every dealer might have different brands … keep it universal; check once when added, every now and then in storage, and
when booking a PDI"). The plan (user's notes, Carbonara-recalls-notes.txt): phase 1 = the core + checks by hand; phase 2
= file import + public data hints (KBA / EU Safety Gate, "possible"); phase 3 = manufacturer APIs, one source at a time.
- **Recall sources** (Settings → Recall sources, admins; data, never brand names in code): name, the **makes** it covers
  (car make ignoring case / spaces / punctuation, equal or starting with it; none = every car), the lookup page `url`
  (`{vin}` / `{reg}` replaced) and a note. Removed = `active` false. A car whose make no active source covers is
  **never due** (a dealer without sources sees nothing).
- **When a check is due** (`DUE_WHERE`; cars not off site and past the arrival inspection): a request
  (`request_check`: `arrival` from `complete_inspection`, `pdi` from `set_booking` with a date), or no check yet, or the
  last check older than `recall_check_days`. Any recorded check clears the request.
- **Checking (by hand, the user's choice for now):** "🔍 Check for recalls" on the car's Recalls card opens the
  sources with "Open {source} ↗" (url filled) + Copy VIN / reg. no; then "✓ No open recalls" (`POST
  /vehicles/{id}/recall-checks`) or "⚠ Found recalls" → add each one (`POST /vehicles/{id}/recalls`, the first with
  `as_check`). Logging into a brand's dealer site from the server (scraping) was ruled out (terms, staff passwords).
  **No referrer (0.41.1):** a dealer portal's login returned to the referring page (Carbonara) when opened from here,
  so `index.html` has `<meta name="referrer" content="same-origin">` (other sites never see Carbonara's address or
  paths) and the source link is `rel="noopener noreferrer"`. Keep external links that way.
- **A recall:** code, title, details, `certainty` confirmed / possible (later sources), status open → ✓ Done / Doesn't
  apply (reason) → Reopen; deleted only by whoever added it or an admin. Events `recall_check / _added / _closed /
  _reopened / _deleted` (no personal data).
- **On work orders (0.57.0, the user's request: check for recalls when a work order is made, if the make is covered by
  the recall sources):** `work_orders.recall_info` (`recalls.sources_for_make` on the car's make, cars in stock and customer
  register alike) → `recall` in `GET /work-orders/{id}`; the work order page shows "Recalls and campaigns" at the top
  (`workOrderRecallCard` in `recalls.js`): "⚠ Check for recalls" with the sources' links + Copy VIN / reg. no, "✓ No open
  recalls" / "⚠ Found recalls" (code + title per recall) → `POST /work-orders/{id}/recall-check`: stored on the work order
  (`recall_checked_at / _by`, `recall_result`), each recall found becomes a task "Recall {code}: {title}", and for a car in
  stock also a `vehicle_recalls` row + the car's check (`_record_check`). Creating a work order answers `recall_due` (a toast);
  the planner marks unchecked jobs ⚠ (`recall_due` in `ORDER_SELECT`, `recalls.covered_sql`).
- **Where they show:** "⚠ Open recall" badge (car header, Vehicles list and storage cards: `open_recalls` count); Today:
  "Recall checks due" (Today/tomorrow) and "Open recalls" (Needs attention); the morning `daily_due` notification counts
  them; **PDI orders** carry `open_recalls` (`OPEN_RECALLS_JSON` in `ORDER_SELECT`): in the e-mail ("TILBAKEKALLINGER /
  KAMPANJER"), the printed sheet (with "Utført ☐") and the PDI orders page; the **"Delivered" dialog** warns about open
  confirmed recalls (never blocks).
- **Carbonara Sidekick (0.42.0 as the "recall helper"; renamed 0.44.1 by the user's choice, since it also does finn.no
  links and prices; a Chrome extension, `addons/sidekick/`, version in its `manifest.json`).** Recalls: automates the check in a
  dealer portal **in the person's own logged-in tab** (no portal password stored anywhere; the server never logs in).
  - Install: Settings → Recall sources → "Carbonara Sidekick for Chrome (PC)": `GET /addons/sidekick.zip` (the old `/addons/recall-helper.zip` still works) (zipped on the
    fly from `addons/`, open like the certificate), then chrome://extensions → Developer mode → Load unpacked. The
    popup asks for Carbonara's address once (optional host permission for that origin only) and uses the Carbonara
    login cookie of the same Chrome. Its texts follow the user's language (`/auth/state`), EN/NO dictionary in `popup.js`.
  - **The check runs in the extension's background (`worker.js`, 0.42.1)**, not in the popup: Chrome closes the popup
    at the first click elsewhere, and 1.0.0 stopped half way (4 of 8 cars). Progress is kept in
    `chrome.storage.local` `job` (status + lines as English keys with arguments; the popup translates and shows it,
    "cut off" after 15 min). The portal's answer is read inside the page (`checkVin`, self-contained: a service
    worker has no DOMParser). One check at a time.
  - Run: on the portal's campaign page, "Check cars" → `GET /api/recall-helper/cars` (due, or `?all=1` every covered
    car here, each with its sources); only cars whose source `url` is on the **open tab's origin** are checked (so no
    portal address in code). For each VIN, `chrome.scripting` (activeTab, world MAIN) runs the portal's own request:
    `POST url_AsyncMethods` with `AsyncMethod=CampaignByVIN`, `chassisNumber`; 1.5 s between cars.
  - The portal's answer (the "PTS" campaign list the user saved, 21.11.2026): an HTML table, one `tr.rowCampaign` per
    operation (`data-id` = campaign no.; cells: type, status, status date, start, end, op. no, description, chassis,
    repair date, odometer, op. no, icon). Rows of one campaign are variants; **the campaign is done when any row has
    the "Utført" mark / a repair date**. No rows: "Antall: 0" = none; a login form = stop; anything else = error (never
    recorded as "no recalls").
  - `POST /api/recall-helper/result` `{vehicle_id, source_id, open[], done[], error}`: adds open campaigns whose code
    isn't on the car in any status (`certainty` confirmed), closes open recalls whose code the portal shows as done,
    records the check (`found` / `none`; an error is logged as `result='error'` and keeps the car due). Events carry
    `helper: true`.

**My notes (0.40.0)** (`notes`, migration 039; `routers/notes.py`, `views/notes.js`; the user's request: "every user needs
to take notes, pin cars and other things to remember, quick and easy"):
- **📝 in the top bar** (before 💬) opens a panel from the right on every page (`toggleNotesPanel`; closes on ✕, Esc,
  the backdrop, a link or any navigation). The red count = reminders due now (`GET /notes/due`, polled every minute
  and on `carbonara:notes-changed`). `#/notes` shows the same as a page.
- **Private (the user's choice of "every user"):** only the writer can see or change a note, admins included; someone
  else's note answers 404. Texts are never logged or put in vehicle history.
- **A note** = text (≤ 1000) and/or a pin: "📌 Pin this car" on a car page (`vehicle_id`; shown as make / model / reg.
  no linking to the car, "Car deleted" when soft-deleted; removed with the car by `purge_vehicle` via ON DELETE CASCADE)
  or "📌 Pin this page" elsewhere (`link` = the hash, must start with `#/`; `link_title` = the page's h1). Links follow
  `canOpen`.
- **Reminder** ("⏰ Remind me": date + time in Oslo time, quick choices In 1 hour / Tomorrow 08:00 / Monday 08:00): due
  reminders sort first with a red edge; the push thread sends one notification (`notes` kind). A new time can remind
  again. Reminders more than a day late (app down) are only marked, not sent.
- **✓ Done** moves it under "Done (n)" (Undo possible); the worker's `housekeeping()` deletes done notes after `trash_days`.

**Private messages (0.34.0)** (`private_messages`, migration 036; `routers/dm.py`, `views/dm.js`; the user's request):
- **Between two users**, any team (no menu item; 💬 in the top bar with a red unread count, `GET /dm/unread`, polled every
  minute and on `carbonara:dm-changed`). `#/messages` lists every active user (latest conversation first, "n new");
  `#/messages/:id` is the conversation (polls every 10 s; opening it marks the messages to you as read; the sender sees
  "✓ Read" / "Not read yet").
- **Layout (0.38.2):** the conversation scrolls in its own box (`.dm-thread`, sized by `fit()` to fill the screen down to
  the writing field, which sits under it, not sticky). Opening scrolls the box to the newest message, again as the page
  settles and pictures load (3 s, stops when the person scrolls).
- **Text and/or one file per message** (`POST /dm/with/{id}`, multipart). Text max 2 000 characters. Files: the same
  whitelist as car documents (`documents.FILE_TYPES`), max `MAX_UPLOAD_MB`. Pictures go through `photostore.store`
  (original + 1600 / 400 px JPEG, so HEIC shows too) and show as a thumbnail; other files are stored as uploaded under
  `PHOTO_DIR/dm/yyyy/mm/`. Served at `/api/dm/{id}/file[?variant=thumb|display]`, `no-store` + `nosniff`.
- **Only the sender and the recipient** can read a message or open its file, **admins included** (no exception).
  The sender can delete their own message (file removed after commit).
- **Deleted after 72 working hours (the user's rule):** `expires_at = dm.expires_after_work_hours(sent)`, counting only
  Monday–Friday hours in Oslo time: Friday 10:00 → Wednesday 10:00; Saturday / Sunday → Thursday 00:00; Thursday 10:00 →
  Tuesday 10:00. No public holidays. Each message shows "deleted dd.mm.yyyy HH:mm". The worker's
  `expire_private_messages()` deletes rows + files every loop (~1 min); reads never show expired messages meanwhile.
- **Staff delete:** the FK has no ON DELETE, so a person with messages is soft-deleted (the usual savepoint fallback).
- Texts and file names are never logged.

**finn.no:**
- Crawling is prohibited (robots.txt and terms). Staff paste the ad link or FINN code; the
  validator extracts 6–12 digits.
- Link: `https://www.finn.no/mobility/item/{code}`. Dealer FINN org id: `1324692627` (enter it on System → Company →
  "FINN organisation id", setting `finn_org_id`; never in code).
- **The server never searches finn.no, not even one search per car or on a button (0.43.0, explained to the user):**
  robots.txt forbids crawling without written permission. Allowed instead:
  - **"🔎 Find on finn.no"** (car page, finn.no row and dialog): `GET /vehicles/{id}` sends `finn_search_url` =
    `https://www.finn.no/mobility/search/car?orgId=<finn_org_id>&q=<make model>` (None until the setting is set); it
    opens in the person's own browser.
  - **The helper (recall helper 1.2.0) on one of your ads:** reads only the tab's address (FINN code) and title (to
    guess the car: most make / model / year words in the title; cars without a link first), the person picks / confirms
    the car, and it saves `finn_code` with `PATCH /vehicles/{id}` (taking it off another car first: one ad, one car).
- **Automatic linking + price comparison need agreements (the user is asking FINN):** FINN's API for the dealer's own
  ads (agreement + key, api@finn.no / account manager) would let the server link cars by reg. no / VIN on its own.
  Market prices: FINN Dealer Hub "Prissjekk" (API unknown), or licensed data (OFV Kjøretøydata API, Bilpriser API);
  never scraped listings. Planned as a pluggable "Market price" card on used cars once a provider is chosen.
- **Adding a car from its finn.no ad (0.45.0, the user's request: cars advertised before they arrive, or already
  advertised when Carbonara is taken into use)** (`routers/from_ad.py`, `routers/vehicle_photos.py`,
  `views/carphotos.js`, migration 042; Sidekick 1.5.0):
  - Sidekick on the dealer's own ad reads it **once, on the person's click** (`readAd`: schema.org Car / Product in
    JSON-LD, then the details list "label → value" (Merke, Modell, Modellår, Kilometerstand, Farge, Drivstoff,
    Registreringsnummer, Chassisnr., Totalpris), then meta tags / text; photos from JSON-LD `image`, og:image and
    large `<img>`s). The car list offers "➕ New car from this ad", preselected when no car matches (a car whose reg.
    no is on the ad wins, then the finn link, then the title words).
  - `POST /vehicles/from-ad/preview` {registration_number, vin}: an existing car (reg. no or VIN; a deleted one says
    "Recently deleted") and Statens vegvesen's `summary` (the **VIN**, rarely on an ad, and official make / model /
    colour / fuel, which replace the ad's). `POST /vehicles/from-ad` (`FromAdIn` = `VehicleDetails` + vin): creates
    the car **off site** (the user's choice; arrival inspection or Move car places it later), with `finn_code`, asking
    price (source finn), `listed_km`, condition (Sidekick's New/used, default used), event `vehicle_created`
    `{source: 'finn'}`, then `sync_vehicle` (a registered car is marked as registered, like "Sync now").
  - The ticked photos (first 8 ticked by default): **the adding runs in Sidekick's background (`worker.js`
    `addFromAd`, progress in `chrome.storage.local` `adJob`; 1.5.1)**, because Chrome's permission question closes the
    popup (1.5.0 then sent nothing). finn.no's photo host `images.finncdn.no` is in `host_permissions` (no question);
    other photo hosts are still asked for in the click, and the worker waits up to a minute for the answer. It
    fetches them and uploads each to `POST /vehicles/{id}/photos` (source finn). The server never contacts
    finn.no.
  - **The car's own photos** (`vehicle_photos`, photostore; max 60 per car): "Photos (n)" card on the car page (tap to
    enlarge, ★ Show first, Delete, 📷 Add photos from the device); the first one is the car's picture in lists until
    the arrival inspection has a right-side photo (`AD_PHOTO_SQL` → `ad_photo_id`); `purge_vehicle` removes them.
  - **No arrival inspection yet (0.45.3, the user's request):** the car page shows a warning banner under the top actions
    ("No arrival inspection yet" + "🔍 Start arrival inspection", or "Arrival inspection in progress" + "Continue
    inspection"), the same button in the empty Inspections card, and lists show a "No arrival inspection" badge
    (`no_arrival` from `GET /vehicles`). The button posts `/intake` with the car's VIN; the server takes a car in stock
    in again only when it never had a completed arrival inspection. `_first_arrival` is false when the car has events
    older than the inspection, so cancelling it keeps the car (before, it would have gone to Recently deleted).
  - `listed_km` (the ad's mileage, `listed_km_at`) is a mileage source (`LATEST_KM_SQL` 'ad', "from the finn.no ad");
    linking an existing car also saves it.
- **Asking prices, compared within our own stock (0.44.0, the user's request)** (`views/prices.js`, migration 041):
  - **Where the price comes from:** typed in (car page → overview "Asking price" → `priceDialog`), or the helper
    (1.3.0) on the car's finn.no ad reads it from **that page only, on the person's click** (`readAdPrice`: schema.org
    `offers.price` in JSON-LD, then price meta tags, then the visible "Totalpris" / "Pris"; 1 000–99 999 999), shows it
    for checking and saves it with the link (`asking_price_source` 'finn'). Never more than the open ad: going through
    all ads would be crawling (only with FINN's API).
  - `PATCH /vehicles/{id}` with `asking_price`: always stamps `asking_price_at` (saving the same price again = "checked
    today"); a changed price goes into the history (`vehicle_details_updated`).
  - **Compared:** "Price compared with similar cars in stock" card on the car page (`price_peers` from `GET
    /vehicles/{id}`: same make + model ignoring case / spaces / punctuation, not off site; low / median / high and this
    car vs. the median; year = model year, else first registration; km = latest mileage, `LATEST_KM_SQL`). **Price
    overview** page `#/prices` (link on Vehicles; `GET /vehicles/prices`, declared before `/vehicles/{vehicle_id}`):
    every car in stock grouped by make + model, sorted by price, "vs. median" badge (above +5 % amber, below −5 % green),
    New/used filter.
- **Market data (test, 0.46.0, the user's request)** (`routers/market.py`, `views/market.js`, migration 043): the user
  wanted to see whether a listings database is good enough and how it works in Carbonara. **Carbonara never fetches
  listings** (building a finn.no scraper was declined: finn.no's terms / robots.txt and the database right in
  åndsverkloven § 24, with the risk on the dealer's FINN account); the user brings a **CSV file** made elsewhere, so
  where the file comes from is the user's responsibility. The same import fits licensed data later.
  - **On / off:** System → Market data (`market_data`, default off). Off: `/api/market*` answer 404, the page shows a
    notice, the Vehicles link and the car page card are hidden; imported data stays. The browser learns it from
    `/auth/state` (`me.market_data`), so a change shows after a reload.
  - **Import (admins, `POST /market/import`, multipart `file`, ≤ 10 MB / 50 000 rows):** comma / semicolon / tab
    (sniffed), UTF-8 (BOM ok) or cp1252. Column names are matched loosely (`COLUMNS`: make/merke, model/modell,
    price/price_nok/pris/totalpris required; year, km, variant, fuel, seller, status, first_price_nok, first_seen,
    last_seen, finn_code, url optional). Rows without make, model or a price 1 000–99 999 999 are skipped (counted);
    the same finn code twice in a file counts once. **Each make + model in a file replaces the earlier listings of
    that make + model** (the user's "future uploads recreate price data"); other models stay; imports left with no
    listings are deleted. Status containing sold / solgt / removed … = inactive (not in the prices). **Seller names
    and places are never stored**, only `seller_kind` (private when the seller text starts with "priv" / says
    "privatperson", else dealer). `DELETE /market/imports/{id}` removes an import and its listings.
  - **Matching** (`matches`): make and model keys (lower case, letters + digits); the exact model if any, else a model
    starting with the other ("ZS" ↔ "ZS EV").
  - **Estimate** (`compare`): least squares price = a + b·year + c·km over the active listings of the model within
    ± 2 years of the car (all years when fewer than 8), needs 8+ listings with year and km; the car's year = model year,
    else first registration; km = latest mileage (`LATEST_KM_SQL`, the ad's km counts), else the typical km of that
    year (shown as assumed). Rounded to 1 000 kr; not shown when outside 0.6 × lowest … 1.4 × highest. **Similar** =
    year ± 1 and km ± 25 % (at least 20 000 km); the 8 closest are listed on the car page with their ad links.
  - **Where it shows:** `#/market` "Market prices" (link "📈 Market prices (test)" on Vehicles, nav `vehicles`): import
    card (admins) with the imports, "Our cars with market data" (cars in stock + off-site cars without a completed
    arrival inspection = added from their ad, not delivered; `CARS_SQL`) with asking price, estimate, similar listings
    and "vs. estimate" badge (±5 % plain, above amber, below green), and "Imported models". Car page: "Market price
    (imported listings)" card under the price card (`GET /vehicles/{id}/market`; null = no card).

**Parts store / delelager (0.47.0)** (migration 044; `routers/parts.py`, `views/parts.js`; the user's request: "part
numbers, prices, ex vat, inc vat, locations and so on"; the user chose stock counting, manual entry + file import, cost +
sales price, and no link to cars for now):
- **Top menu "Parts" / "Delelager"** (`#/parts`, team menu key `parts`; no team got it automatically, a system admin
  ticks it on System → Teams).
- **A part:** part number (`part_key` = upper case letters + digits, one active part per key; search and import match on
  it), name, make (free text, data), supplier, location (shelf), unit (`pcs` / `set` / `l` / `m` / `kg`; "stk" / "sett"
  in Norwegian), quantity, minimum stock ("Low stock" at or below it), **cost price and sales price per unit ex VAT**,
  VAT rate (default 25 %; the price inc VAT is worked out, never stored), note. The edit form keeps ex / inc VAT in step
  and shows the margin. Delete = hidden (`deleted_at`), history kept, the number can be used again.
- **Stock only changes through movements** (`part_movements`: created / received / out / count / import, with change and
  quantity after; `price` rows log price changes `{sale_from, sale_to, cost_from, cost_to}`). "＋ Received" (purchase
  price per unit, updates the cost price; delivery note / invoice no.), "－ Taken out" (work order / receipt no.; never
  below 0: "count the stock first"), "Count stock" (sets the counted number). Shown as the part's History.
- **Parts team = admins + users whose team has `parts`** (`_editor`, checked on the server): only they see cost prices,
  margin, stock value and purchase prices in the history, and only they can add / edit / delete / move / import.
- **The page:** search (part number ignoring spaces / dashes, name, make, supplier, location, note; an exact or starting
  part number first), filters All / In stock / Low stock / Out of stock + make; at most 200 rows shown ("search to
  narrow it down"); the search is kept in the hash (`#/parts?q=…&show=…&make=…`, `history.replaceState`). Counts, and
  for the parts team the stock value at cost. "⬇ Export (CSV)" (`GET /parts/export`, the same filter; semicolons,
  decimal commas, BOM, for Excel). The ex VAT column is hidden on phones.
- **Import** (`POST /parts/import`, multipart `file`, `add_new`, `set_stock`; ≤ 20 MB / 100 000 rows): CSV (`;` `,` or
  tab, UTF-8 or cp1252) or **.xlsx** (first sheet, `openpyxl`); old .xls is refused. The header row may be any of the
  first 15 rows; columns are matched by name in English or Norwegian (`COLUMNS`: delenummer, varenummer, beskrivelse,
  hylle, beholdning, innpris, pris inkl. mva … ; a bare "price" / "pris" is ex VAT; only inc VAT → ex worked out).
  Numbers like "1 234,50", "1.234,50", "249,-". Only cells with a value change a part (price changes logged); a
  repeated part number in a file counts once. "Add parts that are not in Carbonara yet" (default on; off = update
  prices from a full supplier list only) and "Set the stock of existing parts" (default off; new parts always get the
  file's quantity). Logged in `part_imports` (last 5 shown).
- **Importers' text price lists (0.48.6)** (`_fixed_rows`): a `.txt` without `;` / tab whose lines (80 % of the first 60) fit
  one of two fixed-width layouts gets the column names `part_number, name, price, replaced_by` added: **A** = part no. (15) |
  name (30) | space | price `0000344,82` | discount code | replaced by (16) | its price; **B** = part no. | name | price
  `2.150,00` | discount code (lined up with spaces). The two sample files (one per make, 36 110 and 8 510 lines) are in the
  user's notes folder. A 0,00 price = no price. "Replaced by X" goes into the note (never over a note someone wrote; NO
  pattern "Erstattet av"). The form also asks **"Make for parts without one in the file"** (`make`) and whether a text list's
  price is the sales or the cost price ex VAT (`price_is`, default sales). Saving is batched (`executemany`) for big lists.

**Customer register + parts orders (0.48.0)** (migration 045; `routers/customers.py`, `routers/parts_orders.py`,
`views/customers.js`, `views/partsorders.js`; the user's request: "collect parts in an order connected to a car and
owner, with history; customers have a customer number; owners can change; owners can have several cars; the Vehicles
database stays separate but can be transferred when a customer allows it; a choice at first setup, for companies working
together"). The user's choices: stock goes down when an order is handed out, automatic customer numbers, inactive
customers deleted after `retention_years`, and modules + another company + consent.
- **Two companies, two databases (0.53.0, the user's question):** the sales company's cars are **Vehicles** (`vehicles`);
  the workshop's customers and their cars are the **customer register** (`customers`, `customer_cars`, `car_ownerships`;
  a customer can own several cars, owners change over time). They are separate tables and screens; the only bridges are
  on purpose: "Transfer to the customer register" (customer's consent), work orders on a car in stock (e.g. a PDI the
  sales company orders) and the vehicle page's typed customer row. Kiosk deliveries (workshop) link to the register
  (`car_deliveries.customer_car_id`, register events `customer_delivery` / `customer_delivery_received`), never to
  Vehicles any more. The Customers page has two tabs, **Customers** and **Cars** (`#/customers?tab=cars`,
  `GET /customer-cars?q=`: reg. no., VIN, make / model, owner; "+ New car" picks the owner first). Admins see both sides
  (they are admins of the whole install); teams decide what others see.
- **Customers** (`#/customers`, `#/customers/:id`; top menu "Customers" / "Kunder", team key `customers`): customer no.
  (automatic: max + 1, at least System → Customer register → "First customer number" `customer_number_start`, advisory
  lock), private (first + last name) or company (company name, 9-digit org. no.), phone (`clean_phone`), e-mail, address,
  postal code, city, note. `customers.name` = display name. Delete (admins) = for good, not with open orders.
- **Customer cars** (`customer_cars`, `#/customer-cars/:id`): **kept apart from `vehicles`**. Reg. no., VIN (unique),
  make / model / year / colour / fuel / first registered (Statens vegvesen lookup by reg. no. via `rentals.registry_values`).
  **Owners over time** (`car_ownerships`, one current per car): "Change owner" ends the current one and starts the new
  ("No owner now" = sold elsewhere / scrapped); adding a car that is already in the register (reg. no. or VIN) offers to
  change its owner instead. A customer can own several cars; earlier cars stay listed with their period.
- **History** (`register_events`, customer / car / order): ids only in `data` (`from_customer_id` …), names looked up
  when shown (`_names`; a deleted customer shows as "deleted customer"). Never names, phones or addresses in events.
- **Who:** admins and teams with Customers or Parts (`customers._access`, a server lock: personal data). Orders are changed
  only by the parts team (`parts._editor`).
- **Parts orders** (`#/parts-orders`, `#/parts-orders/:id`, nav `parts`; from the Parts page, a customer or a car):
  order no. (max + 1), customer (required), car (optional, one of the customer's), reference, note. Lines = a part from
  the store (number, name, unit, sales price and VAT copied; the same part again adds to its line) or free text.
  Status open → ordered (from the supplier) → arrived → **done = handed out**: every stock line is taken out of the
  stock (`part_movements` kind `order` with `order_id`; refused when a part has too little: "register as received or
  count first"); "Undo hand-out" puts them back (`order_return`). Cancelled = final. Parts on orders not done / cancelled
  are **reserved** (`parts.RESERVED_SQL`: shown on the Parts list, the part dialog and the line picker). Totals ex VAT,
  VAT, inc VAT. "🖨 Print" prints the page.
- **The car database (Vehicles):** a "Customer" row on the car page overview (`vehicleCustomerRow`): first + last name,
  address, phone typed by sales (`vehicles.customer_*`, `PUT /vehicles/{id}/customer`, any staff; event
  `customer_details_updated` without the values). **"Transfer to the customer register"** (only while the Workshop module
  is on; `GET /vehicles/{id}/transfer` = the car if already in the register + possible matches by phone / name, name and
  customer no. only): pick a match or a new customer (prefilled), **tick the customer's consent** (required, server
  checks), → the car is created or found by VIN / reg. no., gets the customer as owner, `customer_cars.vehicle_id /
  consent_at / consent_by`, `vehicles.customer_car_id`, events `transferred_from_car_database` /
  `transferred_to_customer_register`. The car stays in Vehicles unchanged.
- **Another company:** System → **Customer register** (`customers_company / _phone / _email / _address`) (+ `customers_org_no`, 0.48.4) like the kiosk and
  rental blocks (`customers.company()`, `operator` when it differs from Company). Shown on the Customers page ("Customer
  register of …") and in `registerPrivacyDialog` (Norwegian, art. 6(1)(b) + (f), consent for transfers, retention).
- **Retention:** `customers.last_activity_at` is touched by every change, owner change and order; the worker's
  `housekeeping()` → `purge_inactive` deletes customers older than `retention_years` (none with open orders or orders
  changed within that time; orders stay without the customer), then register cars with no owners left and no changes.
- **Modules (System page → Modules, and first-time setup):** `module_cars` (arrivals, vehicles, pdi_orders, storage,
  testdrive), `module_workshop` (customers, parts, deliveries), `module_rental` (rental); `auth.MODULE_ITEMS`,
  `modules_off()`: off = those menu items are gone for everyone (system admins too); data is kept; like teams, not a
  server lock. The setup screen asks "What will Carbonara be used for here?" (`SetupIn.modules` → `app_settings`).
  `/auth/state` sends `me.modules`.

**Work orders + work hours (0.49.0)** (migration 047; `app/worktime.py`, `routers/work_orders.py`, `routers/hours.py`,
`views/workorders.js`, `views/hours.js`; the user's request: "logging of work hours, start day, end day per person, also
logging of time for each work order"; "a work order is a car + parts + labour time + text field for what work to perform and
a reply from mechanics; the work could be a list to check off or free text; PDIs can receive a work order number from
Carbonara when the date is confirmed"; "only admins see hours"; "a fixed break, with the option to add more breaks and
adjust the time, auto-subtracted from the work: a 2 hour job set from 11 goes to 13:30 if lunch is 30 minutes from 11:30";
"one clock running at a time"):
- **Work orders** (top menu "Work orders" / "Arbeidsordrer", team key `work_orders`, in the Workshop module; migration 047
  gave it to teams with Parts or Customers). Access on the server: admins + teams with Work orders, Customers or Parts
  (`work_orders._access`; customer data). Number = max + 1, at least System → Work hours → `work_order_number_start`.
  - **The car:** from Vehicles (`vehicle_id`, e.g. a PDI) or the customer register (`customer_car_id`; the customer = its
    current owner). New: "+ New work order" (car search over both: reg. no., VIN, owner's name), "🛠 New work order" on the
    vehicle page, "+ New work order" on a customer car page. A "Work orders" card on customer / customer car pages, and on
    the vehicle page only when the car has some.
  - **The work:** free text (`description`) and / or tasks (`tasks` jsonb `{id, text, done, done_by (name), done_at}`; saved
    whole with `PUT …/tasks`, ticked at once). **Mechanic's reply** (`mechanic_note`). Estimate (hours, typed "2,5"),
    planned date + time, mechanic (`assigned_to`, `GET /work-orders/staff`). Status open → in progress (automatic when a
    clock starts) → done, or cancelled; done / cancelled stop the clocks on it; "Open again".
  - **Labour** = clocked time minus breaks (`_labour`). Everyone with access sees the total, "Expected done" (estimate − time
    so far from now, or from the planned start, skipping breaks: `worktime.add_work`) and "Over the estimate". **Who worked
    when only for admins** (Labour card, "+ Add time" / change / delete through `/hours/entries`).
  - **Parts** = parts orders with `work_order_id` ("+ Add parts" → `POST /work-orders/{id}/parts-order` opens the
    order's parts order, made if none is open; reference "#number"). Those don't need a customer (`parts_orders.new_order`);
    the parts order page shows "Work order #n".
  - **PDI:** "✓ Confirm PDI date" offers "Make a work order in Carbonara and use its number" (teams that see Work orders,
    while the PDI has no number): `ConfirmIn.create_work_order` → `pdi._carbonara_work_order` (vehicle, title "PDI", tasks =
    the order items "label: choice" + other, description = the order note, planned = PDI date; `pdi_orders.work_order_id`);
    the number then links to the work order on the PDI card / PDI orders page.
  - History `work_order_events` (created, updated with field names + estimate / planned / mechanic values, tasks n/m,
    status, parts_order); never texts. Clock starts / stops are not in the history (hours are admin-only).
- **Work hours** (System → Work hours: `work_hours` on / off (default on), `work_breaks` (default "11:30-12:00", several
  comma-separated, `BREAKS_PATTERN`), `work_order_number_start`):
  - **⏱ in the top bar** (before 📝; marked while the day is started, a dot while a clock runs; hidden when off and no clock):
    "Start my day" / "End my day" (`POST /hours/day/start|end`; one `work_days` row per person and day, an ended day can be
    started again, a day ended within a minute is dropped), the running clock with "Stop clock". Staff see only today's start
    and their clock, never totals.
  - **Clock:** "▶ Start my clock" on a work order (`POST /work-orders/{id}/clock`): stops any other clock of mine (one per
    person, unique index), starts my day if needed. Ending the day stops it. A clock stopped within a minute is dropped.
  - **Breaks:** copied onto the day when it starts (`work_days.breaks`), an admin can change one day's breaks; taken off the
    day and off clocked time (`worktime.worked_seconds`, each person's own day breaks via `person_breaks`).
  - **`#/hours` (admins only; link in the ⏱ panel):** a week at a time (◀ ▶, dates, This week, person filter), per person the
    days (start, end, breaks, worked, on work orders; "Not ended" days marked) with the work order entries under each day;
    "+ Add a day", change / delete a day (`/hours/days`), change entries; "⬇ Export (CSV)" for payroll (`GET /hours/export`;
    semicolons, decimal hours with comma, BOM). Max 62 days per view.
  - **Retention:** the worker deletes `work_days` older than `retention_years` (`hours.purge_old_days`); `work_time` stays
    with the work order.

**Invoices (0.50.0)** (migration 048; `routers/invoices.py`, `views/invoices.js`; the user's request: "labour (+ labour
price) and parts should be in the same work order and finish with a bill / faktura with the Norwegian requirements"; the
user's choices: Carbonara issues the invoice; labour = clocked time rounded up to a quarter hour, editable, one hourly rate
on the System page changeable per work order; parts leave the stock when the invoice is issued; the seller is the
Customer register company):
- **On the work order:** parts are added right there (search the store / "+ Part not in the store", change / remove;
  kept in the work order's parts order, made on the first part; anyone with work order access may change the lines of a
  work order's parts order: `parts_orders._line_editor`); "Invoice basis" card: labour (clocked, suggested, **hours to
  invoice** `billed_minutes`, **hourly rate** `labour_rate`, "Use the clocked time" / "Use the rate from the System page"
  reset to NULL), **other charges** (`extra_lines`, `PUT …/extra-lines`), the lines as they will be invoiced, VAT per
  rate, totals, and what is missing (`invoices.billing`). The customer can be chosen / changed on the work order (needed
  for a car from Vehicles). Mileage (`km`) in Edit.
- **"🧾 Make invoice"** (status done) → `POST /work-orders/{id}/invoice`: refused while something is missing (company
  name, org. no., postal address, customer, hourly rate when there is labour, any line); hands out the work order's parts
  orders (`parts_orders.change_status`, refused when a part has too little stock: nothing saved); next number (max + 1
  under a lock, at least `invoice_number_start`; invoices and credit notes share one series, no gaps); invoice date =
  today, delivery date = when the work was marked done, due = + `invoice_due_days`; snapshots of seller
  (`customers.company()` + VAT / Foretaksregisteret flags, bank account, footer text), buyer (name, customer no., org. no.
  for companies, address), car (reg. no., make / model, VIN, km, work order no.) and lines. Work order → `invoiced`
  (locked: `_not_locked`; its parts orders can't change status either).
- **The document** (`#/invoices/:id`, Norwegian, `translate="no"`, "🖨 Print or PDF"): FAKTURA / KREDITNOTA, seller with
  "Org.nr. … MVA" and "Foretaksregisteret", invoice no., invoice / delivery / due date, customer no., work order, KID;
  buyer; car; lines (Varenr., Beskrivelse, Antall, Enhet, Pris eks. mva, Mva, Beløp eks. mva); "Sum eks. mva", "Mva 25 % av
  …", "Å betale (NOK)"; payment (account, KID, due); not registered for VAT → no VAT + the sentence about
  Merverdiavgiftsregisteret; the note; the footer (`invoice_note`).
- **Afterwards:** only the payment changes (`PUT /invoices/{id}/paid`, date or null). **Credit note** (`POST
  /invoices/{id}/credit`, reason): a new number, negative copies of the lines, "Krediterer faktura nr. … datert …"; the
  parts orders the invoice handed out go back to "arrived" (stock back); the work order back to `done`, so it can be
  changed and invoiced again. One credit note per invoice.
- **#/invoices:** list (all / not paid / paid, search), unpaid sum and overdue count, "Export for the accountant" (CSV of
  invoices + credit notes between two dates). "🧾 Invoices" button on the Work orders page.
- **Never deleted by Carbonara** (bokføringsloven § 13: at least 5 years); customer retention deleting a customer only
  sets `customer_id` NULL (the buyer snapshot stays).
- System → **Invoicing**: `labour_rate`, `invoice_due_days` (14), `invoice_bank_account` (`BANK_ACCOUNT_PATTERN`),
  `invoice_vat_registered` (on), `invoice_foretaksregisteret` (on), `invoice_kid` (off; MOD10), `invoice_number_start`
  (10000), `invoice_note`.

**Planner (0.51.0)** (migration 049; `routers/planner.py`, `views/planner.js`, `worktime.work_segments`; the user's request with a
photo of their old booking system: "a calendar to plan the jobs, each user gets their own line (users can be added or
removed) of work orders lined up after each other per day; one calendar for each team, everyone can make changes in their
team"):
- **Top menu "Planner" / "Planlegger"** (team key `planner`, Workshop module; migration 049 gave it to teams with Work
  orders). Admins plan every team (team dropdown); others their own team only (`_check_team`), and need work order access.
  **0.56.2 (the user's rule: everyone in the team sees its places):** "the team" = everyone with a line on its planner.
  `auth.session_staff` loads `planner_teams` (teams whose planner has a visible line for the person, other than their
  own); `menu_for` then adds `planner` + `work_orders` (also for people without a team), and `planner._my_teams` (own
  team + those) decides which planners they can open (team dropdown) and whose absences they can set.
- **Lines** = the team's members + people added − people taken off (`planner_rows`; "Lines" dialog: order ↑↓, remove,
  add anyone active).
- **Jobs** = work orders assigned to a line's person with a planned start (not cancelled), length = the estimate (1 h when
  none), laid out by `worktime.work_segments`: only inside the **working day** (System → Work hours: `planner_day_start`
  07:00, `planner_day_end` 15:30; Monday–Friday), breaks skipped; a job past the end of the day continues the next working
  day (drawn with a dashed left edge). One bar per day from its first to its last piece (spans the break, like the old
  system). Overlapping jobs on a line are stacked. Colours: open blue, in progress green, done / invoiced grey, PDI pink.
  The work order's "Expected done" from the planned start uses the same layout.
- **Changing:** drag a job (time snapped to 15 min, and onto another line = another mechanic) → `PATCH /work-orders/{id}`
  `{planned_at, assigned_to}`; drag its right edge → `estimated_minutes`; tap → dialog (date, start, estimated hours,
  mechanic, "Take off the plan" = planned_at NULL, open). Tap an empty spot → "+ New work order here"
  (`newWorkOrderDialog(car, {planned, assigned_to, onDone})`), "+ Absence", or put a job from "Not planned" there.
  **Not planned** (card under the board): active work orders without a time / person on this planner; drag onto a line
  (pointer events, works with touch) or tap to plan.
- **Absences:** holiday / away / course / other (purple / teal / grey blocks); **no "sick"** on purpose (health data): the
  dialog says not to write why someone is away. Deleted by the worker a year after they end (`purge_old_absences`).
- **Capacity:** under each name, planned / available hours over the days shown (available = working day − breaks −
  absences; red when over). Red "now" line on today. Views: one day, three days, one week (from Monday).
- **Bigger planner (0.55.0, the user's request with a photo of their old booking system; the user's choices: places =
  lifts / bays, colours = job type fill + status mark):**
  - **Full width:** on `#/planner` the page has no 980 px limit (`body.planner-wide`); pixels per minute (`data.px`) =
    the width shared over the days shown (0.55–4 px; below that it scrolls sideways). Redrawn on a resize and every minute
    (others' changes), never while a dialog is open or a job is dragged (`hookOnce` in `planner.js`).
  - **Own window:** "⧉ Open in its own window" opens `#/planner?…&full=1` in a popup window (`body.planner-full`: no top
    bar, menu, 🔔 bar or footer; "⛶ Full screen"). The installed app has a "Planner" shortcut (`manifest.json` shortcuts).
  - **Top row:** a month calendar (pick a day; each day coloured by how booked the team's people are: green < 85 %, amber
    85–100 %, red over; tooltip with % and hours), "Booked, next 7 working days" bars from the day shown (dashed line =
    100 %; tap a bar to go there), and the legend (job types, status edges, icons, absences, break). `GET /planner/load`
    (people lines only; up to 62 days) gives planned / available seconds per day.
  - **Job types** (`job_types`, migration 053; "Job types" button for admins, `PUT /job-types` saves the list; one not in
    use is kept on old work orders): name EN + NO, colour = the job's fill (text dark / light by brightness). Chosen on
    the new / edit work order dialogs and in the planner's job dialog; shown on the work order page. PDI work orders get
    the type named "PDI" (`create_work_order`). No type = the old status colours.
  - **Status marks:** a 6 px left edge (open grey, in progress green, done black, invoiced gold) and icons 🔑 arrived,
    ⏱ clock running, 📦 waiting for parts (the work order has parts lines and "Parts arrived and ready" isn't ticked), ✅ parts arrived and ready (0.55.1: `parts_ready_at`, `POST /work-orders/{id}/parts-ready`, a bar at the top of the work order page and in the planner job dialog), tasks n/m. Two lines per job:
    "#no reg. no. · customer" and "type · title".
  - **Places** (`workshop_places` per team; added / renamed / ordered / removed in "Lines", `PUT /planner/{team}/places`):
    lines under the people (🔧, grey). A job with `place_id` shows on the place's line **and** its mechanic's line;
    dropping a job on a place line sets the place, on a person's line the mechanic. Place capacity = working day − the
    System page breaks. Removing a place takes it off unfinished jobs.
- **Arrived (0.52.0, the user's request):** the **delivery kiosk** shows "Booked in today? Tap your car" with today's
  work orders (open / in progress, not arrived, car from the customer register; **from 07:00 the working day before the appointment** until the end of the appointment day, 0.53.1: a Monday appointment shows from Friday 07:00) as
  **the registration number only** (0.54.2; before: + first name) (`deliveries.BOOKED_SQL`, `GET /api/kiosk/booked`, reloaded each time the form resets). Tapping fills the reg. no. and the owner's name + phone (`GET /api/kiosk/booked/{id}/contact`, one car at a time; cleared again when another reg. no. is typed) (typing another one drops the
  choice); on "Register delivery" the server ties the delivery to the work order only if the reg. no. still matches; **a typed reg. no. of a booked car links too, without tapping** (0.53.1)
  (`car_deliveries.work_order_id`), sets `work_orders.arrived_at` and logs `arrived` `{delivery_id, kiosk}`. The planner
  marks the job (🔑, green bottom edge); the job dialog, the work order page ("Car arrived") and `POST
  /work-orders/{id}/arrived {arrived}` set / undo it by hand; the staff delivery card shows "Booked: Work order #n". The planner job dialog shows the delivery (key place + the map with the customer's pin; `delivery` in `planner.ORDER_SELECT`, 0.54.1). The
  kiosk privacy notice says booked customers' reg. no. shows (and a tap fills in their name + phone) on the tablet that day.

**Language: English and Norwegian (0.14.0)** (`frontend/js/i18n.js`):
- **The rule:** no Norwegian in the English version, no English in the Norwegian one.
- **How it's chosen:** per user (`staff.language`, default `en` for existing accounts),
  switched under their name at the top (`POST /api/auth/language`), and also stored in
  localStorage. When the saved language differs, `boot()` reloads once. Before login it
  follows the device, with a switch on the login screen.
- **How it works:** the code is written **in English**. `startTranslator()` translates text
  nodes and the placeholder/title/aria-label attributes as they render (a MutationObserver),
  and wraps `confirm`/`prompt`/`alert`.
  - `NO` holds exact texts. `NO_PATTERNS` holds texts with values: `{}` = any text,
    `{n}` = a number, and `{1t}` in the target also translates that part.
  - Patterns are tried most specific first.
  - Leading icons and trailing arrows are stripped for the lookup and put back, so keys are
    written without them.
  - Server messages (English) are translated the same way.
  - `EN` translates the Norwegian texts Carbonara uses itself (storage checklist, battery
    results, winter-tyre options) when English is chosen. Use `tr()` when such a text is
    joined into a longer string.
- **Not translated (the user's choices):**
  - documents, which are always Norwegian and marked `translate="no"` (PDI e-mail preview,
    privacy notice, storage report)
  - Statens vegvesen data
  - PDI item names (one name each)
  - `.mono` / `.vin` elements and input values
- **Adding UI text:** write it in English, then add the Norwegian to `NO` (or a pattern if it
  contains a value). Missing entries show up as English in the Norwegian version; the user
  reports them with screenshots.
- **Norwegian terms:**

  | English | Norwegian |
  |---|---|
  | PDI | **nybilklargjøring** |
  | Arrival inspection | **Mottakskontroll** |
  | First storage check (storage programme) | **Første lagerkontroll** (report: Ankomstkontroll) |
  | Vehicles | Biler |
  | Storage | Lager |
  | Off site | Ikke på lager |
  | System admin | **Systemadministrator** |
  | Sub-zone | Undersone |
  | Mudflaps | **Skvettlapper** (not "Sprutlapper") |
  | Parts (store) | **Delelager** (a part = del, part number = delenummer, cost price = innpris) |
  | Parts order / Customers / Handed out | **Delebestilling** / **Kunder** / **Utlevert** |
  | Work order / Work hours / Labour | **Arbeidsordre** / **Arbeidstimer** / **Arbeidstid** |

**Theme: light / dark (0.20.0):**
- Per user, under their name at the top: "Same as device" (default `auto`), "Light", "Dark".
  Saved in `staff.theme` (`POST /api/auth/theme`) and in localStorage (`carbonara.theme`).
- A small inline script in `index.html` sets `<html data-theme="light|dark">` before the first
  paint; `applyTheme()` in `ui.js` does the same later and follows the device when it switches.
  `boot()` applies the account's theme (no reload).
- **Brand colours (0.23.0)** from the user's design files (logo + `carbonara-colors.txt`):
  - Light: background `#FBF7EC`, secondary surface `#EFE8D4` (top bar), text `#1C1B19`, muted
    `#4A4538`. Dark: background `#1C1B19`, secondary surface `#272522` (top bar, cards), text
    `#FFF9E8` (brighter since 0.23.1), muted `#C9BD9A`. Accent `#F5B800` in both (primary buttons, with dark text).
  - Yellow is too pale for text on the light background, so links / link buttons / focus use
    `--link` (dark gold `#7A5A00` in light, the accent in dark). Use `--link` for coloured text,
    `--primary` only for fills and borders, `--primary-text` on top of `--primary`.
  - **Logo top left** is an inline SVG in `index.html` (not an `<img>`), coloured by
    `--logo-bin/-car/-wheel` so it follows the theme; the text uses the bundled Space Grotesk
    (`frontend/fonts/`, no Google Fonts request). `theme-color` is set with the theme.
- CSS: the dark colours live under `:root[data-theme="dark"]`. **Don't use
  `@media (prefers-color-scheme)`** for colours; new colours go in both token blocks.

**Dates, times & numbers (standing rule):**
- **Display:** always through `fmtDate` in `ui.js` (`dd.mm.yyyy`, or `dd.mm.yyyy HH:mm`).
  Bare ISO dates are formatted as-is, with no timezone shift. Only the header clock and the
  Today weekday use a long form, in the user's language.
- **Input:** **never** `<input type="date|time">` (they show mm/dd/yyyy and AM/PM on English
  devices). Use `dateInput()` / `timeInput()` from `ui.js`.
  - Placeholders are `dd.mm.yyyy` / `hh:mm` (`dd.mm.åååå` / `tt:mm` in Norwegian), and loose
    typing is accepted.
  - A 📅 button opens the native calendar.
  - `.value` is ISO, and `.id`, `.disabled` and change/input events work like native inputs.
    Invalid input never fires `change` to listeners.
- **Today:** `osloTodayIso()`, never `new Date().toISOString()` (that is UTC).
- **Numbers:** Norwegian format (`fmtKm` → "119 782 km"; decimals with a comma in reports).

---

## Code style

**General:** keep it simple and dependency-light. No frontend framework, no build step, no
ORM. Match the surrounding code. Comments explain *why*.

**Python (backend):**
- Python 3.12, 4-space indent, double quotes, f-strings, type hints on helpers. Lines up to
  ~110.
- **Plain SQL with psycopg3:** `%s` parameters, and `psycopg.sql` for identifiers. Never format
  user input into SQL.
- One transaction per request (`get_conn`). Call `conn.commit()` explicitly only before side
  effects outside the DB (deleting files), or to keep a counter when the request then fails
  (wrong PIN).
- Shared logic goes in `common.py`. Raise errors with `not_found()`, `conflict()` (409) and
  `bad_request()` (422). Error messages are English; add their Norwegian to `i18n.js`.
- PATCH endpoints use `patch_fields(model)` + `update_row()`.
- Write every meaningful change to history with `log_event()` (JSONB, `default=str`), never
  with personal data.

**JavaScript (frontend):**
- ES modules, 2-space indent, single quotes, semicolons, `const`/arrow functions, async/await.
- Build DOM with `h(tag, attrs, ...children)` from `ui.js`; shared helpers go in `ui.js`.
- **Pitfall #1:** the native `append()` / `replaceChildren()` print arrays and `null` as text
  ("null[object HTMLElement]"). Use the `append()` helper, or
  `el.replaceChildren(...list.filter(Boolean))`. This has shipped **four** times. **Grep
  every new view for `.append(` / `.replaceChildren(` before handing over.**
- **Pitfall #2 (0.22.0 blank page):** an imported name that is also declared in the same
  module (e.g. importing `editDialog` from `pdi.js` into `vehicles.js`, which has its own) is a
  SyntaxError, and the **whole app** shows only the header. Import with `as` (`editDialog as
  pdiEditDialog`). Before handing over, check every module: imported names vs. top-level
  declarations, and that each imported name is exported by its source.
- `ul.rows li` is a flex row (label left, buttons right). Wrap sentences mixing text and links
  in one `<span>`, or they split into columns.
- A card built once must redraw dependent parts through a slot element + render function (see
  `serviceSlot` in `inspection.js`).
- **Pitfall #3 (0.26.1): whole-page redraws.** A view that redraws itself by rendering into a fresh
  `div` and moving the children into `el` must pass the real container on: `view(el, params, host = el)`
  and `await view(fresh, params, host); host.replaceChildren(...fresh.childNodes)`. Otherwise the
  buttons drawn by the first redraw redraw the detached `fresh` div, and from the second action on the
  page doesn't update (System → Teams, Customer deliveries, Test drive, vehicle page).
- **UI text is written in English**, and every new text gets a Norwegian entry in
  `i18n.js`. Date/time input uses `dateInput()`/`timeInput()`.

**CSS:** one file, `frontend/css/app.css`.
- Reuse classes (`card`, `notice warn`, `badge`, `grid`, `mono`, `reg-big`…).
- Mobile first; it's used on phones in the yard.
- Global form fields are `width: 100%`. Inside flex rows, override with a more specific
  selector (see `.toolbar input[type=search]`).

**Git (PowerShell 5.1):** write the commit message to a file in the scratchpad and use
`git commit -F <file>`.
- Title: `<Short summary> (vX.Y.Z)`, then a body grouped by feature.
- End with the `Co-Authored-By` trailer.
- Run the API key check first.

---

## Open items waiting on the user

- **Company name (0.27.0):** the built-in default "Moss AutoCenter" was removed from the code. The
  name must be saved on System → Company (and the workshop under Customer deliveries (kiosk)),
  or the privacy notices, PDI e-mails and storage reports show no company name.

- **Customer contact:** fill in **E-mail for customers** and **Postal address** on System →
  Company (the phone 69269840 is set).
- **SMTP:** not set up; PDI e-mails go via the e-mail app until it is.
- **PDI recipients:** when going live, add RBV and make it the default instead of the test
  address.
- **Test storage check:** a test monthly storage check exists on the MG S5 EV
  (LSJWS4090SZ716243, 09.11.2026 23:13). It should be cancelled ("Test"), which moves the next
  check to 09.12.2026.
- **Andy's admin status:** unconfirmed (see *Working with the user*).
- **PDI sheets (0.31.0):** upload each model's PDI PDF (Settings → PDI sheets) and place the fields, upload the
  company stamp(s), and have everyone who marks PDIs done add their signature (👤 menu → My signature).
- **Delivery kiosk (0.24.0):** upload a map picture of the lot, check the key places / tick boxes, and
  set up the tablet (Customer deliveries → Kiosk setup).

## Milestones

| Version | Milestone |
|---|---|
| initial | Arrival inspection → storage; default port moved to 8080 |
| 0.2.0 | Version footer; SVV API key hint in settings |
| 0.3.0 | SVV field mapping (`kodeNavn`); overview card with EU-kontroll/registration badges; "All vehicle data"; Norwegian 24 h time + live clock |
| 0.4.0 | SVV lookup at arrival with mismatch confirmation; edit/move/off-site; damage repair with undo |
| 0.5.0 | Storage menu; multi-car spots with capacity |
| 0.6.0 | Sub-zones inside spots; big reg. no in vehicle header |
| 0.7.0–0.7.8 | OCR: RapidOCR replaces Tesseract (0/13 → 34/35); numpy/headless OpenCV build fix; door labels; ISO VIN rules, check-digit repair, make/year from VIN; auto-fill a single confident VIN |
| 0.9.0 | New/used + service tracking; reg. nos without spaces; soft delete + Recently deleted; 5-year retention |
| 0.9.3 | Duplicate warnings; finn.no link; service fields appear at once at arrival |
| 0.9.4 | Dates as `dd.mm.yyyy` (+ `HH:mm`); frontend `Cache-Control: no-cache` |
| 0.10.0 | **Test drive** page (customer, licence photo, items, return check, trash after return); name from the licence photo |
| 0.10.1 | Licence names: dropped spaces restored from the photo |
| 0.10.2 | Per-build JS/CSS URLs (Opera Touch "Not found" fix); all SVV VIN locations shown |
| 0.10.3 | Settings: "Recently deleted" sentence no longer split into columns |
| 0.10.4 | Transport-sheet QR verified; raw barcode text returned |
| 0.11.0 | **Login** with personal PIN; all API behind login; privacy notice + "customer informed"; licence access log |
| 0.12.0 | **PDI orders** to RBV; **Today board** as start page; Arrivals moved; **System page** (system admin settings); no built-in e-mail addresses |
| 0.12.1 | Storage spots can be renamed and deleted (cars moved first) |
| 0.12.2 | Fix: System page / PDI card printed "[object HTMLElement]" / "null" |
| 0.13.0 | **Storage maintenance** for new cars (MG SI-GI2022102501) with printable report; dealer number setting |
| 0.13.1 | Storage checks can be cancelled by an admin (struck through in the report) |
| 0.13.2 | "Enter PDI date" available before the order is sent |
| 0.13.3 | Own dd.mm.yyyy / 24 h date & time inputs; km in Norwegian number format |
| 0.14.0 | **English / Norwegian** per user; "super-admin" → "System admin"; Sprutlapper → Skvettlapper, PDI item → Nybilklargjøring |
| 0.14.1 | Translator: icon headings and "by …" texts translated (most specific pattern first) |
| 0.14.2 | Zones removed (moved into description); description editable in place |
| 0.14.3 | Vehicles: New/used filter, result count, filters in the address; search box width fixed |
| 0.14.4 | Printing without browser header/footer; privacy notice signature / date / name lines |
| 0.14.5 | Customer phone, e-mail and postal address as separate settings / lines on the privacy notice |
| 0.14.6 | Today board: details always on their own line under the car |
| 0.15.0 | **PDI page** (`#/pdi`, from the "PDIs this week" tile); PDI banner on the vehicle page and badge in the Vehicles list; storage "Arrival check" renamed **First storage check** and made a required step of the arrival inspection for factory-new cars |
| 0.15.1 | "Ready for registration and delivery" after the PDI is done (badge, Vehicles filter, Today tile) |
| 0.16.0 | **Trade plates** in Settings (named sets, one car at a time); moving plates from a car on a test drive leads straight to its return |
| 0.16.1 | "Sync now" with Statens vegvesen on every car (header of the SVV card); auto-marks registered cars |
| 0.17.0 | PDI order: **print or save as PDF** instead of e-mail (Norwegian order sheet) |
| 0.18.0 | In-app Yes/No "given to the workshop?" with PDI date; **PDI preparation** (trade plates, spot + message, winter wheels) with a notification bar the working day before |
| 0.19.0 | Staff: first name, last name, phone; names auto-capitalized; deactivated staff can be deleted (history keeps the name) |
| 0.19.1 | Licence reader: misread field labels (I, l or a bar for 1; Z for 2) accepted; if only one name field is found, the line above/below is used (low confidence) |
| 0.20.0 | **Light / dark theme** per user (or same as device), under their name at the top |
| 0.21.0 | **12V charging every month for used cars** in storage: card on the vehicle page, reminder on Today |
| 0.21.1–0.21.2 | Car photo (right side) in the Vehicles list; arrival inspection photos on the vehicle page |
| 0.22.0 | **Documents per car** (contracts, notes, files); quick actions on the vehicle page (test drive, Create PDI order, Add document) |
| 0.22.1 | Fix: blank page in 0.22.0 (duplicate `editDialog` name in `vehicles.js`) |
| 0.22.2 | Fix: car photos skip cancelled arrival inspections (prefer the completed one) |
| 0.22.3 | Arrival inspection: "Cancel inspection and delete" (cars new to Carbonara go to Recently deleted) and "Pause inspection" (back to Arrivals) |
| 0.22.4 | Test drive return: "Received by" is the logged-in user (no dropdown; server takes it from the session) |
| 0.22.5 | Login page: clock on the right, as when logged in |
| 0.23.0 | **Brand look:** Carbonara logo top left, app icon as favicon, brand colours in light and dark theme |
| 0.23.1 | Dark theme: brighter text colour (`#FFF9E8`) |
| 0.23.2 | Top bar: account button is just the 👤 silhouette (name on hover); clock always rightmost |
| 0.23.3 | Top bar: clock's right edge lines up with the content boxes below on wide screens |
| 0.24.0 | **Customer car delivery:** kiosk tablet form (reg. no, name, phone, key place, pin on a map of the lot, tick boxes, message); Customer deliveries page + Today block; kiosk setup (maps, lists in EN + NO, tablets). Phone / e-mail fields get the normal input style |
| 0.25.0 | Customer deliveries: SVV lookup by reg. no in the background (VIN, EU-kontroll shown to staff, "Look up again"); owner name from SVV prepared (shown first, typed name kept, name comparison); kiosk scrolls to the top after sending |
| 0.25.1 | Top menu item "Deliveries" (Leveringer) to the Customer deliveries page |
| 0.26.0 | **Teams:** system admins make named teams on the System page, pick the top menu items each team sees and place users (one team each); no team = Today only |
| 0.26.1 | Fix: pages that redraw themselves (System → Teams, Customer deliveries, Test drive, vehicle page) only updated on the first action |
| 0.26.2 | Customer delivery card: reg. no, VIN, name + phone, then EU-kontroll badge + date |
| 0.26.3 | Kiosk privacy notice can name another company: System → Customer deliveries (kiosk) |
| 0.27.0 | No company / place / person names in code (usable by any dealer); kiosk notice worded for two companies under one roof; company name has no built-in default; tyre option `workshop_orders` (migration 028) |
| 0.27.1 | Storage checklist paint check: tree sap ("kvae") added; "Iht. MG Service Information …" line removed from the storage report; MG bulletin note removed from the storage maintenance card |
| 0.27.2 | Kiosk form: English / Norsk switch on the title line, top right (in the staff preview it saves the staff member's own language) |
| 0.28.0 | **Rental cars** page: own fleet (not in the car database), added / edited on the page, Statens vegvesen lookup with EU-kontroll first (badges, notice, Today, nightly refresh); renting out like test drives + expected return; trash after return (migration 029) |
| 0.28.1 | Rental privacy notice contact customizable on System → Rental cars (another company possible, two-company wording) |
| 0.28.2 | Rental cars: "Taken out of / Put into the car" item pickers removed from the rent-out form |
| 0.28.3 | Installed app (Chrome) shows the Carbonara icon instead of a "C": web app manifest + PNG icons |
| 0.29.0 | **Summer / winter wheels:** dropdown on the vehicle page and rental cars, required for used cars at the arrival inspection; warnings from the studded tyre season (region on the System page) on cars, lists and Today (migration 030) |
| 0.29.1 | Rental cars: wheels dropdown only in the Edit dialog (fleet list shows the wheels as text + warning badge) |
| 0.29.2 | Rental cars: each car in the fleet list in its own box, with space under the heading |
| 0.29.3 | Login always opens Today (the login screen resets the address to `#/`, so the next user doesn't land on the previous user's page, e.g. System) |
| 0.30.0 | **PDI orders page** (top menu): cars with a PDI order until registered and off site, with car details, right-side photo, order and history (no documents); PDI **expected completion date** (default the day after) and **confirm PDI date** (migration 031) |
| 0.31.0 | **PDI sheets:** "PDI done" dialog fills in the model's own PDF form (reg. no, VIN, mileage, date, stamp, signature) and stores it on the order; templates uploaded per model with tap-to-place fields and OCR suggestions; company stamps; each user's own signature (drawn or uploaded) (migration 032) |
| 0.32.0 | **Work order no.** on PDI orders: entered when confirming the PDI date (editable later), shown on the PDI orders page and the PDI card, placeable field on the PDI sheet (migration 033) |
| 0.32.1 | Work order no. changed in the "PDI done" / "Make PDI sheet" dialog now gets a history entry too |
| 0.32.2 | Move car: "Moved by" is the logged-in user (no dropdown; server takes it from the session) |
| 0.32.3 | "PDI done" dialog asks for summer or winter wheels (required, saved on the car) |
| 0.33.0 | **PDI sheets: 12V battery reading** (placeable field, asked in the dialog) and **"Tick all boxes"** (tick-box positions tapped or found automatically on the form) (migration 034) |
| 0.33.1 | Fix: fillable PDF forms hid the ticks and text (form fields are flattened into the page before filling) |
| 0.33.2 | PDI sheets: suggested text positions go into the box beside the label (not on the label's black cell); text bold and 12 pt by default |
| 0.33.3 | PDI sheets: 12V reading printed as the number only; stamp / signature / date under a shared header bar are suggested side by side in the box below it |
| 0.33.4 | PDI sheets: page pictures show a fillable form's fields (tick boxes visible and found); bare "REG" label; 12V number suggested before a "Volt" label. Verified live: flattening removes the form fields |
| 0.33.5 | PDI sheets: tick box finder keeps one box per spot (the white box, not the grey squares beside it) |
| 0.33.6 | Fix: made PDI sheets of fillable forms lost the whole form (page content kept untouched now); the form's own check boxes are ticked ("Ja" look); ✔ instead of black squares |
| 0.33.7 | PDI sheets: tick box finder also finds wide light-grey tick cells (MG S6 "S6 2" form) |
| 0.33.8 | Top bar clock: time, weekday and date on three lines (narrower, more room for the menu) |
| 0.33.9 | Rental cars: the rent-out form opens in place of the tapped car (not under the whole list) |
| 0.33.10 | Rental cars: the tapped car stays visible with its form right under it; tapping it again (or "Cancel") closes the form |
| 0.33.11 | Delivery kiosk: full screen on the first tap (and again after leaving it); left when staff log in |
| 0.33.12 | Delivery kiosk: no language switch or staff login on the tablet; language set per tablet on the Customer deliveries page (migration 035) |
| 0.33.13 | Name fields (kiosk and staff) capitalize on phone / tablet keyboards too (after each word, and on leaving the field) |
| 0.33.14 | Kiosk form: the "Register delivery" button stays visible above the on-screen keyboard while typing |
| 0.33.15 | Kiosk form: button row sticks above the keyboard while typing (no scrolling from code, which brought the address bar back) |
| 0.33.16 | Today: wheel blocks use ❄️ / ☀️ (the 🛞 wheel emoji is missing on Windows 10 and older phones) |
| 0.33.17 | Today: links only lead to pages the team can see (others shown as plain text); PDI rows open the PDI orders page at that car for teams without Vehicles |
| 0.33.18 | PDI date entered the first time ("Enter PDI date" or "given to the workshop?") also asks for the work order no. (optional there) |
| 0.33.19 | PDI rows on Today, the PDI page and the 🔔 bar open the order on the PDI orders page (car page only for teams without PDI orders) |
| 0.33.20 | PDI orders page: "PDI done" group shows the latest marked done on top |
| 0.34.0 | **Message board on Today:** notes for the writer's team (admins also to everyone or another team), marked with the writer's initials, shown 24 hours; several messages change by themselves every 8 s. **Private messages** between users with photos and files (💬 in the top bar), deleted after 72 working hours (migration 036) |
| 0.34.1 | Vehicle page: latest recorded mileage (from the arrival inspection, service, test drive or PDI) on the overview card |
| 0.34.2 | Kiosk tablets: stopped ones deleted after 30 days; list folds after 3; system admins can delete a tablet |
| 0.35.0 | **"More" in the top menu:** a dropdown for the menu items a system admin picks on the System page (Top menu); not shown when none are picked |
| 0.35.1 | Vehicles page: "+ New arrival" button (as on Today / Arrivals) |
| 0.35.2 | PDI orders page: "✓ Delivered" on PDI-done cars takes the car off site with the note "Delivered" |
| 0.35.3 | "Delivered" opens a dialog: confirm delivery and/or registration (marks the car as registered unless it already is) |
| 0.36.0 | **Background worker warning:** the worker reports in every round; the System page and Today (system admins) warn when it has stopped, a step failed or the daily cleanup is late (migration 037) |
| 0.36.1 | **Disk space warning:** System page card (free space, usage bar, database size); amber / red warning on Today for system admins |
| 0.37.0 | **HTTPS (local):** `caddy` container on 8443 with Carbonara's own certificate (installed once per device, System page → HTTPS); secure cookies over HTTPS; devices that trust it move from http:// by themselves |
| 0.37.1 | Fix: caddy container never started under Portainer (Caddyfile now built into a small image instead of mounted) |
| 0.37.2 | System → HTTPS: Android steps say not to tap the downloaded file (install through Settings) and that "Network may be monitored" is normal |
| 0.38.0 | **Phone / PC notifications** (Web Push over HTTPS): private messages, Today board, PDI date confirmed / done, PDI car not prepared, storage checks + 12V due, test drive / rental not back, worker / disk problems for system admins; turned on per device and chosen per person in the 👤 menu (migration 038) |
| 0.38.1 | Private message conversation opened from a notification scrolls to the newest message (scrolls again as the page settles and pictures load) |
| 0.38.2 | Private messages: the conversation scrolls in its own box with the writing field under it (the field no longer covers the newest messages), opened at the newest message |
| 0.39.0 | **Server address on the System page** (HTTPS card): kept in the database, so it survives redeploys and each location sets its own; caddy follows a change within ~10 s without a restart (`caddy_host` volume, `caddy/start.sh`) |
| 0.40.0 | **My notes:** 📝 panel on every page with private notes, pinned cars / pages, reminders (with phone notification) and done list (migration 039) |
| 0.41.0 | **Recalls, phase 1:** recall sources per brand (Settings), checks due after arrival / when a PDI is booked / every 30 days in storage, check dialog (open the brand's system, record the result), recalls per car (done / doesn't apply), on Today, PDI orders and the Delivered dialog (migration 040) |
| 0.41.1 | Fix: a dealer portal opened from the recall check sent you back to Carbonara after login (Carbonara no longer tells other sites where a link came from) |
| 0.42.0 | **Recall helper:** a Chrome extension (download in Settings → Recall sources) that checks the due cars in a dealer portal you are logged in to, adds open campaigns and closes the ones done |
| 0.42.1 | Recall helper 1.1.0: the check runs in the background and continues when its small window closes (it stopped after 4 of 8 cars) |
| 0.43.0 | finn.no: "Find on finn.no" on the car page (your ads for that make / model, FINN organisation id on the System page); the helper (1.2.0) links the finn.no ad you are looking at to a car |
| 0.44.0 | **Asking prices:** price per car (typed in, or read by the helper from the car's finn.no ad), compared with the same make / model in stock on the car page and on the new Price overview page (migration 041) |
| 0.44.1 | The Chrome helper is renamed **Carbonara Sidekick** (1.4.0; folder `addons/sidekick`, download `carbonara-sidekick.zip`) |
| 0.45.0 | **Add a car from its finn.no ad** with Sidekick 1.5.0 (details from the ad + VIN from Statens vegvesen, starts off site, ticked photos copied); **Photos** card on the car page (migration 042) |
| 0.45.1 | Fix: adding a car from its finn.no ad did nothing when Chrome asked about the photos (the question closed Sidekick); Sidekick 1.5.1 adds the car in its background and may read finn.no's photo server without asking |
| 0.45.2 | Sidekick 1.5.2: each photo of a finn.no ad offered once (the same photo came at several sizes) |
| 0.45.3 | Cars without an arrival inspection (e.g. added from their finn.no ad): warning banner with "Start arrival inspection" on the car page, the same button in the empty Inspections card, "No arrival inspection" badge in lists; cancelling that inspection keeps the car |
| 0.46.0 | **Market data (test):** import a CSV of car listings (System → Market data on / off); Market prices page (our cars vs. an estimate for their year + mileage, imported models) and a "Market price" card on the car page (migration 043) |
| 0.47.0 | **Parts store (delelager):** new top menu page with part numbers, names, locations, stock with a history (received, taken out, counted), cost and sales prices ex / inc VAT, low stock, CSV export and import of price / stock lists (CSV or Excel) (migration 044) |
| 0.48.0 | **Customer register + parts orders:** customers with customer numbers, their cars with owner history, parts orders (reserved stock, handed out = taken out of stock) with history; customer on cars in Vehicles and transfer to the register with consent; modules chosen at first setup / System page; the register can belong to another company (migration 045) |
| 0.48.1 | Fix: blank page in 0.48.0 (an extra bracket in the customer and parts order pages) |
| 0.48.2 | Part numbers in capital letters; part names, company and customer names with a capital first letter, also after a space or "-" (migration 046) |
| 0.48.3 | Fix: the new customer form showed both the private person and the company fields (a global `[hidden]` rule in `app.css`) |
| 0.48.4 | Organisation number for each company on the System page (Company, kiosk, Rental cars, Customer register), shown with the company name on the privacy notices, the storage report and PDI orders |
| 0.48.5 | Settings and System: every card folds (closed by default, the heading opens it; open cards remembered per browser) |
| 0.48.6 | Parts import reads importers' fixed-width text price lists (.txt), with a make for the file and sales / cost price choice; replaced parts get "Replaced by …" |
| 0.49.0 | **Work orders + work hours:** work orders (car from Vehicles or the customer register, work as text and / or a task list, mechanic's reply, labour clock, parts orders tied to it; PDIs get a number from here when the date is confirmed); ⏱ start / end of the working day and one running clock per person; fixed breaks taken off; #/hours for admins with corrections and CSV export (migration 047) |
| 0.50.0 | **Invoices:** parts and labour (hours × rate) and other charges on the work order; "Make invoice" issues a Norwegian invoice (unbroken number series, all required details, never changed or deleted; parts leave the stock), credit notes, mark as paid, invoice list + CSV export for the accountant; Invoicing settings on the System page (migration 048) |
| 0.51.0 | **Planner:** a calendar per team with a line per person, work orders laid out over the working day (breaks, evenings, weekends skipped), drag to move / change mechanic / stretch, "Not planned" list, absences (holiday / away / course / other), planned vs. available hours; working day start / end on the System page (migration 049) |
| 0.52.0 | Delivery kiosk: today's booked cars (reg. no. + first name) to tap; the delivery is tied to the work order and the planner shows the car as arrived (also set by hand) (migration 050) |
| 0.52.1 | Top bar: time and date on one line, with the buttons (⏱ 📝 💬 👤) under it (`.topbar-side`) |
| 0.52.2 | Top bar clock: weekday and date as dd.mm.yyyy, the time to the right of it |
| 0.53.0 | Workshop and sales kept apart: Customers page gets a **Cars** tab (the workshop's customer cars, searchable, owner, open work orders); kiosk deliveries link to the customer register instead of the car stock (migration 051) |
| 0.53.1 | Kiosk: booked cars show from 07:00 the working day before the appointment (Monday: from Friday); a typed reg. no. of a booked car also marks it as arrived, without tapping it in the list |
| 0.54.0 | Veteran cars: older chassis numbers (not the 17-character VIN) accepted as Statens vegvesen has them, after a "checked on the car" tick, at arrival and in the customer register (migration 052) |
| 0.54.1 | Planner: the job dialog shows where the customer parked (the pin on the kiosk map) and where the key is, once the car is delivered at the kiosk |
| 0.54.2 | Kiosk: booked cars listed by registration number only; tapping one fills in the owner's name and phone (fetched for that car only), cleared again if another reg. no. is typed |
| 0.55.0 | **Planner, bigger:** fills the screen width, "Open in its own window" (no top bar, refreshes itself), month calendar coloured by how booked each day is, chart of the next 7 working days, **job types with colours** (admins) + status marks (edge, 🔑 ⏱ 📦), legend, **workshop places** (lifts / bays) as lines; job type on work orders (migration 053) |
| 0.55.1 | Work orders: "✓ Parts arrived and ready" at the top (else "Waiting for parts" when it has parts), also in the planner; the planner job dialog has the planning boxes at the top and the kiosk delivery folded at the bottom (migration 054) |
| 0.56.0 | **PDI orders go to the planner:** "Send" makes the work order under "Not planned" (no e-mail any more; printing still possible); planning or moving it in the planner sets and confirms the PDI date, and changing the PDI date moves the job; cancelling the PDI cancels its open work order (migration 055) |
| 0.56.1 | PDI order dialog: "Save and send to the workshop" (straight to the planner), "Pause" (save without sending) and "Cancel" / "Cancel order" |
| 0.56.2 | Planner: everyone with a line on a team's planner can open it (its places included), also people added from another team or without a team; they get Planner + Work orders in the menu |
| 0.57.0 | Work orders: recall check when the car's make is covered by a recall source (any car, also from the customer register): box at the top of the work order, recalls found become tasks, ⚠ in the planner, a reminder when the work order is created (migration 056) |

**Next / ideas (not started):**
- **HTTPS, step 2:** a real certificate for a host name (the user has a No-IP plan with a "Vital Encrypt" certificate
  for one host name) instead of `tls internal`, with local DNS pointing the name to the server; then close plain
  HTTP on `APP_PORT` (or redirect it). The user will look for a domain later.
- **Encrypted, expiring backups** of the DB and `data/photos`.
- **PDI replies:** read RBV's replies automatically (IMAP), or a booking link if the networks
  are connected.
- **FINN import** with image checkboxes (needs the FINN API or an ad-system feed).
- **Automated tests:** pytest for `vinlib`, `licenselib`, `storagecare`, `service_due`.
- **Part 2 of the lifecycle** (preparation and sale) has not been defined yet.
