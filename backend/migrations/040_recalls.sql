-- Recalls / campaigns (0.41.0, phase 1). Carbonara knows WHEN a car needs a recall check (after the arrival
-- inspection, every recall_check_days while in storage, and when a PDI is booked); staff check in the
-- brand's own system and record the result. Later phases add automatic sources (file import, public data,
-- manufacturer APIs) that write the same tables.

-- Where a car is checked: one row per brand system, entered by admins (Settings → Recall sources), never in
-- code, since every dealer has its own brands. `makes` = the car makes it covers (matched against the car's
-- make, ignoring case, spaces and punctuation; a car make starting with it counts too). `url` = the lookup
-- page; {vin} and {reg} in it are replaced with the car's VIN / reg. no.
CREATE TABLE recall_sources (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    makes       text[]      NOT NULL DEFAULT '{}',
    url         text        CHECK (char_length(url) <= 500),
    note        text        CHECK (char_length(note) <= 300),
    active      boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  bigint      REFERENCES staff (id)
);

-- A recall / campaign found on a car. certainty: 'confirmed' (found for this VIN) or 'possible' (only
-- make / model / year match; for the later automatic sources). status: open → done / not_applicable.
CREATE TABLE vehicle_recalls (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id  bigint      NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
    source_id   bigint      REFERENCES recall_sources (id) ON DELETE SET NULL,
    code        text        CHECK (char_length(code) <= 60),
    title       text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    details     text        CHECK (char_length(details) <= 2000),
    certainty   text        NOT NULL DEFAULT 'confirmed' CHECK (certainty IN ('confirmed', 'possible')),
    status      text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'not_applicable')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  bigint      REFERENCES staff (id),
    closed_at   timestamptz,
    closed_by   bigint      REFERENCES staff (id),
    close_note  text        CHECK (char_length(close_note) <= 300)
);
CREATE INDEX vehicle_recalls_vehicle_idx ON vehicle_recalls (vehicle_id);
CREATE INDEX vehicle_recalls_open_idx ON vehicle_recalls (vehicle_id) WHERE status = 'open';

-- Every check of a car: when, against which source, by whom, the result and why it was due.
CREATE TABLE recall_checks (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id  bigint      NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
    source_id   bigint      REFERENCES recall_sources (id) ON DELETE SET NULL,
    checked_at  timestamptz NOT NULL DEFAULT now(),
    checked_by  bigint      REFERENCES staff (id),
    result      text        NOT NULL CHECK (result IN ('none', 'found', 'error')),
    reason      text        CHECK (reason IN ('arrival', 'storage', 'pdi', 'manual')),
    note        text        CHECK (char_length(note) <= 300)
);
CREATE INDEX recall_checks_vehicle_idx ON recall_checks (vehicle_id, checked_at DESC);

-- A check asked for by an event (arrival inspection completed, PDI booked); cleared by the next check.
ALTER TABLE vehicles
    ADD COLUMN recall_check_requested_at timestamptz,
    ADD COLUMN recall_check_reason text CHECK (recall_check_reason IN ('arrival', 'pdi'));
