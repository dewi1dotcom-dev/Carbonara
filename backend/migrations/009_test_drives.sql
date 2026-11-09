-- Test drives: which car is out, with which customer, and what was taken out
-- of / put into the car for the drive (typically the spare set of winter or
-- summer wheels stored in the car).
--
-- Customer details (name, phone, driving licence photo) are personal data:
-- when the car comes back they move to the trash (customer_trashed_at) and
-- are wiped for good after TRASH_DAYS (customer_purged_at). The drive itself
-- (car, times, staff, items) stays as history without personal data.
CREATE TABLE test_drives (
    id                   bigserial   PRIMARY KEY,
    vehicle_id           bigint      NOT NULL REFERENCES vehicles (id),
    status               text        NOT NULL DEFAULT 'out' CHECK (status IN ('out', 'returned')),

    started_at           timestamptz NOT NULL DEFAULT now(),
    started_by           bigint      REFERENCES staff (id),
    odometer_out         integer     CHECK (odometer_out >= 0),
    removed_items        text[]      NOT NULL DEFAULT '{}',  -- taken out of the car for the drive
    added_items          text[]      NOT NULL DEFAULT '{}',  -- put into the car for the drive
    items_note           text,

    returned_at          timestamptz,
    returned_by          bigint      REFERENCES staff (id),
    odometer_in          integer     CHECK (odometer_in >= 0),
    items_checked        boolean,                            -- staff confirmed everything is back
    return_note          text,

    -- personal data (wiped by purge)
    customer_name        text,
    customer_phone       text,
    license_file_key     text        UNIQUE,                 -- path stem under PHOTO_DIR
    license_ext          text,
    license_mime         text,
    customer_trashed_at  timestamptz,
    customer_purged_at   timestamptz,

    CHECK ((status = 'returned') = (returned_at IS NOT NULL)),
    CHECK (status = 'returned' OR customer_trashed_at IS NULL)
);

-- A car can only be out on one test drive at a time.
CREATE UNIQUE INDEX test_drives_one_active ON test_drives (vehicle_id) WHERE status = 'out';
CREATE INDEX test_drives_vehicle_idx ON test_drives (vehicle_id, started_at DESC);
CREATE INDEX test_drives_trash_idx ON test_drives (customer_trashed_at)
    WHERE customer_trashed_at IS NOT NULL AND customer_purged_at IS NULL;
