-- Part 1b: registration in Norway + Statens vegvesen registry data.
--
-- Flow: sales marks a vehicle as registered -> a vehicle_registry row is
-- created with sync_status 'pending' -> the sync worker (or "Sync now")
-- fetches the vehicle by VIN from Vegvesen and keeps it fresh every
-- VEGVESEN_SYNC_DAYS. Every distinct response is kept in
-- vehicle_registry_snapshots, so registry history builds up over the years.

ALTER TABLE vehicles
    ADD COLUMN registered_marked_at timestamptz,
    ADD COLUMN registered_marked_by bigint REFERENCES staff (id);

CREATE TABLE vehicle_registry (
    vehicle_id               bigint PRIMARY KEY REFERENCES vehicles (id),

    -- sync bookkeeping
    sync_status              text        NOT NULL DEFAULT 'pending'
                             CHECK (sync_status IN ('pending', 'ok', 'not_found', 'error')),
    next_sync_at             timestamptz NOT NULL DEFAULT now(),
    last_attempt_at          timestamptz,
    last_success_at          timestamptz,
    failures                 integer     NOT NULL DEFAULT 0,
    last_error               text,

    -- extracted from the latest successful response
    registration_number      text,
    registration_status      text,
    first_registered_norway  date,
    first_registered         date,
    eu_control_due           date,   -- periodisk kjøretøykontroll: kontrollfrist
    eu_control_last_approved date,   -- sist godkjent
    make                     text,
    model                    text,
    type_designation         text,
    vehicle_class            text,
    body_type                text,
    color                    text,
    fuel                     text,
    power_kw                 numeric(7, 1),
    engine_cc                integer,
    seats                    smallint,
    curb_weight_kg           integer,
    total_weight_kg          integer,

    data                     jsonb       -- latest raw response (vehicle element)
);
CREATE INDEX vehicle_registry_next_sync_idx ON vehicle_registry (next_sync_at);
CREATE INDEX vehicle_registry_eu_due_idx    ON vehicle_registry (eu_control_due);
CREATE INDEX vehicle_registry_regnr_idx     ON vehicle_registry (upper(registration_number));

CREATE TABLE vehicle_registry_snapshots (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id  bigint      NOT NULL REFERENCES vehicles (id),
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    data_hash   text        NOT NULL,
    data        jsonb       NOT NULL
);
CREATE INDEX vehicle_registry_snapshots_vehicle_idx
    ON vehicle_registry_snapshots (vehicle_id, fetched_at DESC);
