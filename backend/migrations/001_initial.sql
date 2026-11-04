-- Carbonara — part 1: arrival inspection & storage
--
-- Design notes
--  * A vehicle row lives forever and is identified by its VIN. If the same car
--    returns years later (trade-in, buy-back) it gets a new arrival inspection
--    on the same vehicle row, so its whole history stays connected.
--  * Status/kind columns use text + CHECK instead of enums so later parts can
--    extend them with a simple ALTER ... DROP/ADD CONSTRAINT.
--  * vehicle_events is an append-only timeline for the vehicle's lifecycle.
--  * Completed inspections are treated as immutable by the API.

CREATE TABLE staff (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL CHECK (length(trim(name)) > 0),
    active      boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vin                 text        NOT NULL UNIQUE CHECK (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
    make                text,
    model               text,
    variant             text,
    model_year          smallint    CHECK (model_year BETWEEN 1900 AND 2100),
    color               text,
    fuel_type           text,
    registration_number text,
    -- intake     = arrival inspection in progress
    -- in_storage = inspected and parked at the dealership
    -- off_site   = known vehicle that is not currently at the dealership
    status              text        NOT NULL DEFAULT 'intake'
                        CHECK (status IN ('intake', 'in_storage', 'off_site')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicles_status_idx       ON vehicles (status);
CREATE INDEX vehicles_registration_idx ON vehicles (upper(registration_number));

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vehicles_updated_at BEFORE UPDATE ON vehicles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE inspections (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id          bigint      NOT NULL REFERENCES vehicles (id),
    kind                text        NOT NULL DEFAULT 'arrival' CHECK (kind IN ('arrival')),
    status              text        NOT NULL DEFAULT 'in_progress'
                        CHECK (status IN ('in_progress', 'completed', 'cancelled')),
    inspector_id        bigint      REFERENCES staff (id),
    vin_source          text        CHECK (vin_source IN ('manual', 'barcode', 'ocr')),
    odometer_km         integer     CHECK (odometer_km >= 0),
    fuel_level_pct      smallint    CHECK (fuel_level_pct BETWEEN 0 AND 100),
    keys_count          smallint    CHECK (keys_count >= 0),
    no_damage_confirmed boolean     NOT NULL DEFAULT false,
    notes               text,
    started_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz,
    cancelled_at        timestamptz,
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
-- Only one open inspection of a given kind per vehicle.
CREATE UNIQUE INDEX inspections_one_open_per_vehicle
    ON inspections (vehicle_id, kind) WHERE status = 'in_progress';
CREATE INDEX inspections_vehicle_idx ON inspections (vehicle_id);
CREATE INDEX inspections_status_idx  ON inspections (status, started_at DESC);

CREATE TABLE inspection_photos (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_id bigint      NOT NULL REFERENCES inspections (id),
    kind          text        NOT NULL
                  CHECK (kind IN ('front', 'rear', 'left', 'right', 'vin', 'damage', 'other')),
    file_key      text        NOT NULL UNIQUE,  -- path stem under PHOTO_DIR, e.g. 2026/11/<uuid>
    original_ext  text        NOT NULL,
    mime_type     text        NOT NULL,
    width         integer,
    height        integer,
    size_bytes    bigint,
    taken_at      timestamptz,                  -- from EXIF when available
    uploaded_by   bigint      REFERENCES staff (id),
    uploaded_at   timestamptz NOT NULL DEFAULT now()
);
-- Exactly one photo per required angle (a retake replaces the old one).
CREATE UNIQUE INDEX inspection_photos_one_per_angle
    ON inspection_photos (inspection_id, kind)
    WHERE kind IN ('front', 'rear', 'left', 'right', 'vin');
CREATE INDEX inspection_photos_inspection_idx ON inspection_photos (inspection_id);

CREATE TABLE damages (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_id bigint      NOT NULL REFERENCES inspections (id),
    vehicle_id    bigint      NOT NULL REFERENCES vehicles (id),  -- denormalised for lifecycle queries
    panel         text        NOT NULL,
    pos_x         real        CHECK (pos_x BETWEEN 0 AND 1),    -- marker position on the diagram
    pos_y         real        CHECK (pos_y BETWEEN 0 AND 1),
    damage_type   text        NOT NULL
                  CHECK (damage_type IN ('scratch', 'dent', 'chip', 'crack', 'scuff',
                                         'rust', 'broken', 'missing', 'other')),
    severity      text        NOT NULL CHECK (severity IN ('minor', 'moderate', 'severe')),
    size_mm       integer     CHECK (size_mm > 0),
    description   text,
    photo_id      bigint      REFERENCES inspection_photos (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- filled in by later parts (workshop / prep) when the damage is fixed
    repaired_at   timestamptz,
    repair_note   text
);
CREATE INDEX damages_inspection_idx ON damages (inspection_id);
CREATE INDEX damages_open_by_vehicle_idx ON damages (vehicle_id) WHERE repaired_at IS NULL;

CREATE TABLE storage_locations (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        text        NOT NULL UNIQUE,   -- e.g. "A-12"
    zone        text,                          -- e.g. "Yard A", "Showroom"
    description text,
    active      boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE storage_assignments (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id  bigint      NOT NULL REFERENCES vehicles (id),
    location_id bigint      NOT NULL REFERENCES storage_locations (id),
    placed_at   timestamptz NOT NULL DEFAULT now(),
    placed_by   bigint      REFERENCES staff (id),
    removed_at  timestamptz,
    removed_by  bigint      REFERENCES staff (id),
    CHECK (removed_at IS NULL OR removed_at >= placed_at)
);
-- A vehicle is in at most one place, and a spot holds at most one vehicle.
CREATE UNIQUE INDEX storage_one_location_per_vehicle
    ON storage_assignments (vehicle_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX storage_one_vehicle_per_location
    ON storage_assignments (location_id) WHERE removed_at IS NULL;

CREATE TABLE vehicle_events (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id    bigint      NOT NULL REFERENCES vehicles (id),
    event_type    text        NOT NULL,
    occurred_at   timestamptz NOT NULL DEFAULT now(),
    staff_id      bigint      REFERENCES staff (id),
    inspection_id bigint      REFERENCES inspections (id),
    data          jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX vehicle_events_vehicle_idx ON vehicle_events (vehicle_id, occurred_at DESC);
