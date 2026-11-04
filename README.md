# Carbonara

Dealership vehicle lifecycle system. **Part 1: arrival inspection → storage.**

Each car that arrives goes through these steps:

1. **Identify by VIN.** Type it in, or take a photo and let the server read it.
   Door-frame barcodes are read first (zbar / libdmtx), then OCR (Tesseract) is tried on the
   windscreen plate or the registration document. The check digit is validated, and a
   mismatch is only a warning because many European makes don't use it.
2. **Vehicle details.** Make, model, year, colour, fuel, registration number, odometer,
   fuel/charge level, number of keys, notes.
3. **Four required photos:** front, rear, left and right. A VIN plate photo and extra photos are optional.
4. **Damage inspection.** Tap a car diagram to place numbered markers, each with location,
   type, severity, size, description and a photo. If the car has no damage, you have to tick
   "No damage found".
5. **Place in storage.** The inspection can only be completed when all the steps above are
   done. Completing it assigns a free storage spot and locks the inspection.

Every step is written to a per-vehicle history (`vehicle_events`). A VIN is registered once.
If the same car comes back years later, it gets a new arrival inspection on the same vehicle record.

## Registration in Norway and Statens vegvesen

No external database is used at arrival. The car is identified only by its VIN, and the
inspector types in the details. When sales has registered the car, they open it under
**Vehicles** and click **Mark as registered**. After that:

* The server fetches the car from Statens vegvesen by VIN, right away if an API key is configured.
* Technical data is stored in `vehicle_registry`: registration number, registration status,
  first registration dates, EU-kontroll due and last approved dates, make/model/type, colour,
  fuel, power, engine, seats and weights.
* The registration number is always taken from Vegvesen. Make, model, colour and fuel only
  fill in fields that were left empty at arrival.
* The `worker` container re-syncs every registered car every `VEGVESEN_SYNC_DAYS` days.
  Each distinct response is kept in `vehicle_registry_snapshots`, and changes to plates,
  status or EU-kontroll appear in the vehicle history.
* If a car is not found (the registry may lag behind), it is retried daily. Errors such as a
  bad key or an exceeded quota are retried with backoff, up to once a day.

**API key:** apply at vegvesen.no (open data, *API for tekniske kjøretøyopplysninger*) and
put it in `.env` as `VEGVESEN_API_KEY`. The endpoint URL, auth header name and scheme can
also be set in `.env` (`VEGVESEN_API_URL`, `VEGVESEN_AUTH_HEADER`, `VEGVESEN_AUTH_SCHEME`).
Defaults: `https://akfell-datautlevering.atlas.vegvesen.no/enkeltoppslag/kjoretoydata`,
`SVV-Authorization: Apikey <key>`.

> These defaults and the JSON field mapping (`extract()` in `backend/app/vegvesen.py`)
> come from earlier knowledge of the API and have **not** been checked against current
> Vegvesen docs or a live call. After the first real sync, compare the stored data (vehicle
> page → *Raw data*) with what the page shows. Any field that shows up empty only needs a
> path fixed in `extract()`. The raw data is kept, so nothing is lost while you do that.

## Stack

| Layer    | Tech                                                                  |
|----------|-----------------------------------------------------------------------|
| Database | PostgreSQL 16. Schema in `backend/migrations/*.sql`, applied automatically on start |
| API      | Python 3.12 / FastAPI / psycopg 3 (plain SQL)                          |
| VIN      | Tesseract OCR, zbar, libdmtx. All local, no external VIN databases |
| Registry | Statens vegvesen "Enkeltoppslag kjøretøydata", only for cars marked as registered |
| Frontend | Plain HTML/CSS/JS modules in `frontend/`, no build step               |
| Photos   | Files on disk (`./data/photos`). The original is kept, plus 1600px and 400px JPEGs |

## Run on the Ubuntu server

```bash
# one-time: install Docker
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER   # log out/in afterwards

# copy this folder to the server, then:
cp .env.example .env            # set POSTGRES_PASSWORD
docker compose up -d --build
docker compose logs -f app      # wait for "Application startup complete"
```

Open `http://<server-ip>:8080` on a phone or tablet on the same network.

Then go to **Settings**, add the inspectors and the storage spots (there's an "Add range"
option, e.g. `A-01` … `A-40`), and start with **+ New arrival**.

API docs (Swagger) are at `http://<server-ip>:8080/docs`.

### Camera note
Photos use the browser's file input with `capture="environment"`, which opens the rear
camera directly on Android and iOS. This also works over plain HTTP on the LAN, so no
certificate is needed.

## Backups

Two things need backing up: the database and the photo folder.

```bash
docker compose exec -T db pg_dump -U carbonara -Fc carbonara > backup/carbonara-$(date +%F).dump
rsync -a data/photos/ backup/photos/
```

Restore: `docker compose exec -T db pg_restore -U carbonara -d carbonara --clean < file.dump`

## Development without Docker

```bash
sudo apt install -y tesseract-ocr libzbar0 libdmtx0b postgresql
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL=postgresql://carbonara:carbonara@localhost:5432/carbonara
uvicorn app.main:app --reload --host 0.0.0.0
```

## Data model (part 1)

```
staff ─┐
       ├─< inspections >── vehicles ──< vehicle_events
       │        │  │          │
       │        │  └─< damages (also keyed to vehicle; repaired_at for later parts)
       │        └─< inspection_photos (front/rear/left/right/vin/damage/other)
       └─< storage_assignments >── storage_locations

vehicles ──1:1── vehicle_registry            (current Vegvesen data + sync state)
         └─────< vehicle_registry_snapshots  (every distinct Vegvesen response)
```

* `vehicles.status`: `intake` → `in_storage` (or `off_site` when not at the dealership).
  Later parts add more statuses by extending the CHECK constraint in a new migration.
* `inspections.kind` is `arrival` for now. Delivery, service and return inspections can
  reuse the same tables later.
* Partial unique indexes enforce one open inspection per vehicle, one photo per angle,
  one car per storage spot, and one spot per car.

Add schema changes as new files (`002_….sql`). Never edit an applied migration.

## API overview

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/vin/{vin}` | Validate, model-year guess, existing vehicle / open inspection |
| POST | `/api/vin/recognize` | Multipart `file` → VIN candidates |
| POST | `/api/intake` | Start (or resume) an arrival inspection |
| GET/PATCH | `/api/inspections/{id}` | Detail incl. checklist / update odometer, keys, notes… |
| POST | `/api/inspections/{id}/photos` | Multipart `kind` + `file` |
| GET | `/api/photos/{id}/{thumb\|display\|original}` | Serve photo |
| POST | `/api/inspections/{id}/damages` | Add damage (PATCH/DELETE `/api/damages/{id}`) |
| POST | `/api/inspections/{id}/complete` | `{location_id}` → completes and stores |
| POST | `/api/inspections/{id}/cancel` | Cancel |
| GET/PATCH | `/api/vehicles`, `/api/vehicles/{id}` | Search / detail with history |
| GET/POST/PATCH | `/api/staff`, `/api/storage-locations` | Reference data |
| POST/DELETE | `/api/vehicles/{id}/registered` | Mark (and sync) / undo "registered in Norway" |
| POST | `/api/vehicles/{id}/registry/sync` | Sync with Statens vegvesen now |
| GET | `/api/vehicles/{id}/registry/raw` | Latest raw Vegvesen response + snapshot list |
| GET | `/api/registry/status` | Sync overview (used on Settings page) |

## Not in part 1 (yet)

* Login and permissions. Anyone on the LAN can use it, and the inspector is chosen from a list.
* Moving cars between spots, or removing them from storage.
* Sales, preparation, workshop and ownership history.
