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
| App URL | `http://192.168.10.45:8080` (port **8080**; 8000 on the host is taken by Portainer). **No HTTPS yet.** |
| Repo | GitHub, branch `main` (git user `dewi1dotcom-dev`) |
| Containers | `db` (postgres:16), `app` (uvicorn on container port 8000 → host `APP_PORT`), `worker` (`python -m app.sync_worker`) |
| Photos | `./data/photos` mounted at `/data/photos` in **both** `app` and `worker` (the worker deletes files during retention) |
| Timezone | `TZ=Europe/Oslo` on all containers |

**Environment variables** (`.env.example`, `docker-compose.yml`):
- **Server:** `POSTGRES_PASSWORD`, `APP_PORT=8080`, `MAX_UPLOAD_MB=30`.
- **Fallbacks for System page settings** (a value saved on the System page wins):
  - `VEGVESEN_API_KEY/_URL/_AUTH_HEADER/_AUTH_SCHEME/_SYNC_DAYS`
  - `TRASH_DAYS=30`, `RETENTION_YEARS=5`
  - `PRIVACY_COMPANY`, `PRIVACY_CONTACT` (phone), `PRIVACY_EMAIL`, `PRIVACY_ADDRESS`
  - The dealer number is set on the System page only.
  - `SMTP_HOST/PORT/USER/PASSWORD/FROM/SECURITY` (empty host = staff send from their own
    e-mail app)

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
2. **Live checks after the user redeploys.**
   - Every `/api` route except `/api/health`, `/api/version` and `/api/auth/*` needs a login
     cookie.
   - The user made a staff account **"Claude"** (staff id 5, admin, not system admin) for
     this. The PIN was given in chat. Never write it into the repo; if it doesn't work, ask
     the user.

```powershell
$b='http://192.168.10.45:8080'; $jar='<scratchpad>\cookies.txt'
'{"staff_id":5,"pin":"<PIN>"}' | Out-File -Encoding ascii "$env:TEMP\login.json"
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
  app/photostore.py     original + 1600px + 400px JPEG
  app/sync_worker.py    registry re-sync loop + daily housekeeping() (retention, trash purge,
                        test drive customer purge)
  app/routers/          vehicles, inspections, vin, admin (staff, storage spots), testdrives, documents,
                        session (login/language), pdi, dashboard (Today), system, storage_care
  migrations/           001…024
frontend/               no build step; plain ES modules
  index.html, css/app.css
  img/                  logo + app icon SVGs (favicon = carbonara-icon.svg)
  fonts/                Space Grotesk (logo font, bundled; SIL OFL)
  js/app.js             hash router (ignores "?…" in the hash), login boot, user menu, translator start
  js/ui.js              h(), append(), api, fmtDate, dateInput/timeInput, badges, shared helpers
  js/i18n.js            English/Norwegian translator + dictionary
  js/diagram.js         car damage diagram
  js/views/             today (start page), dashboard (= arrivals list), intake, inspection,
                        vehicles, documents, pdi (card + banner + PDI page), storagecare (card + check form
                        + report), storage, testdrive, login, settings, system
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

**New schema changes = a new numbered file. Never change what an applied migration does**
(the runner tracks by file name; comment-only edits are harmless).

**Frontend routes:**
- **Main pages:** `#/` Today · `#/arrivals` · `#/intake` · `#/inspections/:id` · `#/pdi` (PDI
  page, opened from the "PDIs this week" tile and the vehicle banner; not in the top menu).
- **Vehicles:**
  - `#/vehicles` — filters are kept in the hash, e.g. `#/vehicles?q=…&status=…&condition=new`
  - `#/vehicles/:id`
  - `#/vehicles/:id/storage-report` (printable)
  - `#/vehicles/deleted`
- **Storage:** `#/storage` · `#/storage/:id|off-site`.
- **Test drives:** `#/test-drive` · `#/test-drive/new/:vehicleId` (start form with the car
  preselected).
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
- **Card layout (0.21.1, user's request):** text on the left (make and model; reg. no, an empty
  line when missing; VIN; status + notification badges; colour · spot · EU-kontroll), and
  the **right-side photo** from the latest arrival inspection on the right
  (`common.RIGHT_PHOTO_SQL` → `right_photo_id`; "No photo" box otherwise). Same `vehicleCard`
  on the storage spot pages.
- **Vehicle page (0.21.2):** "Photos from the arrival inspection" card under the overview: every
  photo (angles, VIN, damage, other) of the latest completed arrival inspection with photos
  (cancelled ones skipped; one in progress only if none is completed)
  (`arrival_photos` from `GET /vehicles/{id}`); tap to enlarge, link to the inspection.
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
- **HTTPS is NOT set up** (the user chose to skip it for now), so the cookie has
  `secure=False`.
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
- Phone numbers go through `common.clean_phone` (shared with test drives): 8–15 digits,
  optional +.
- **Delete** (admins, only after deactivating, never yourself; a system admin only by a system
  admin): `DELETE /staff/{id}` tries a real delete in a savepoint. If any row refers to the
  person (`ForeignKeyViolation`), it sets `deleted_at` instead and wipes phone, PIN and rights,
  so the name stays on the history they signed (storage checks are warranty evidence).
  Deleted staff are never listed.

**Roles:**
- **Staff:** everything day-to-day.
- **Admin:** staff/PINs, PDI lists, deleting spots, cancelling storage checks.
- **System admin** (`is_superadmin`; always also admin): the System page, and granting or
  removing system admin. Only a system admin can change another system admin.
- **The word "super-admin" must not appear in UI text;** it is "System admin" /
  "Systemadministrator".

**System page (0.12.0)** (`config.py` `SETTINGS`, `routers/system.py`, `views/system.js`):
- **Groups:**
  - **Statens vegvesen:** key 🔒, sync days, URL, auth header/scheme, call pause
  - **E-mail (SMTP):** password 🔒
  - **Company:** company name, dealer number, customer phone, e-mail, postal address
  - **Data retention**
- **Where a value comes from:** `settings.<name>` = DB `app_settings`, else env `NAME`, else
  default. Cached 20 s per process (the worker too). **Always read settings at call time;
  never copy them into module constants.**
- **To add a setting:** one `Setting(...)` line, then use `settings.<name>`. Also add the
  Norwegian label/help to `i18n.js`.
- **Secrets** are write-only (the API returns the last 4 characters). The log records who
  changed which key, never the value.

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
- **E-mail to RBV** (Norwegian, `compose()`):
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
    and on the `carbonara:pdi-changed` event. The browser Notification API isn't usable
    (no HTTPS).
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
  service ≤ 31 days, SVV differences.
- **Then:** upcoming PDIs and number tiles. Attention lists only cover cars that aren't off
  site.

**finn.no:**
- Crawling is prohibited (robots.txt and terms). Staff paste the ad link or FINN code; the
  validator extracts 6–12 digits.
- Link: `https://www.finn.no/mobility/item/{code}`. Dealer FINN org id: `1324692627`.
- A future "Fetch from FINN" needs the official FINN API or an ad-system feed.

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

- **Customer contact:** fill in **E-mail for customers** and **Postal address** on System →
  Company (the phone 69269840 is set).
- **SMTP:** not set up; PDI e-mails go via the e-mail app until it is.
- **PDI recipients:** when going live, add RBV and make it the default instead of the test
  address.
- **Test storage check:** a test monthly storage check exists on the MG S5 EV
  (LSJWS4090SZ716243, 09.11.2026 23:13). It should be cancelled ("Test"), which moves the next
  check to 09.12.2026.
- **Andy's admin status:** unconfirmed (see *Working with the user*).

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

**Next / ideas (not started):**
- **HTTPS** (e.g. a Caddy container with a self-signed cert on 8443), then `secure=True` on the
  cookie.
- **Encrypted, expiring backups** of the DB and `data/photos`.
- **PDI replies:** read RBV's replies automatically (IMAP), or a booking link if the networks
  are connected.
- **FINN import** with image checkboxes (needs the FINN API or an ad-system feed).
- **Automated tests:** pytest for `vinlib`, `licenselib`, `storagecare`, `service_due`.
- **Part 2 of the lifecycle** (preparation and sale) has not been defined yet.
