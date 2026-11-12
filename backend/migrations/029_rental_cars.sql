-- Rental cars: the dealer's own loan/rental fleet. Kept apart from the car
-- database (vehicles): they never show up in Vehicles, Storage, search or the
-- arrival flow, only on the Rental cars page.
CREATE TABLE rental_cars (
    id                       bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    registration_number      text         NOT NULL,             -- without spaces, uppercase
    vin                      text,
    make                     text,
    model                    text,
    model_year               integer,
    color                    text,
    fuel                     text,
    note                     text,                              -- e.g. "winter wheels in the boot"

    -- Statens vegvesen (looked up by registration number). EU-kontroll can also
    -- be typed in by hand; the next lookup overwrites it.
    eu_control_due           date,
    eu_control_last_approved date,
    registration_status      text,                              -- e.g. "Registrert"
    registration_status_code text,                              -- e.g. REGISTRERT / AVREGISTRERT
    first_registered         date,
    registry_checked_at      timestamptz,                       -- last successful lookup
    registry_error           text,                              -- last failed lookup (null when fine)

    created_at               timestamptz  NOT NULL DEFAULT now(),
    created_by               bigint       REFERENCES staff (id),
    updated_at               timestamptz  NOT NULL DEFAULT now(),
    deleted_at               timestamptz,                       -- removed, but kept for its rental history
    deleted_by               bigint       REFERENCES staff (id)
);
CREATE UNIQUE INDEX rental_cars_reg_active ON rental_cars (registration_number) WHERE deleted_at IS NULL;

-- One rental = one customer with one car. Same rules as test drives: the
-- customer's name, phone and driving licence photo move to the trash on return
-- and are wiped for good after TRASH_DAYS; the rental itself stays as history.
CREATE TABLE rentals (
    id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rental_car_id        bigint      NOT NULL REFERENCES rental_cars (id),
    status               text        NOT NULL DEFAULT 'out' CHECK (status IN ('out', 'returned')),

    started_at           timestamptz NOT NULL DEFAULT now(),
    started_by           bigint      REFERENCES staff (id),
    expected_return_at   timestamptz,                         -- optional: when the customer said they'd be back
    odometer_out         integer     CHECK (odometer_out >= 0),
    removed_items        text[]      NOT NULL DEFAULT '{}',
    added_items          text[]      NOT NULL DEFAULT '{}',
    items_note           text,

    returned_at          timestamptz,
    returned_by          bigint      REFERENCES staff (id),
    odometer_in          integer     CHECK (odometer_in >= 0),
    items_checked        boolean,
    return_note          text,

    -- personal data (wiped by purge)
    customer_name        text,
    customer_phone       text,
    license_file_key     text        UNIQUE,
    license_ext          text,
    license_mime         text,
    customer_informed    boolean     NOT NULL DEFAULT false,
    customer_trashed_at  timestamptz,
    customer_purged_at   timestamptz,

    CHECK ((status = 'returned') = (returned_at IS NOT NULL)),
    CHECK (status = 'returned' OR customer_trashed_at IS NULL)
);
CREATE UNIQUE INDEX rentals_one_active ON rentals (rental_car_id) WHERE status = 'out';
CREATE INDEX rentals_car_idx ON rentals (rental_car_id, started_at DESC);
CREATE INDEX rentals_trash_idx ON rentals (customer_trashed_at)
    WHERE customer_trashed_at IS NOT NULL AND customer_purged_at IS NULL;

-- Who opened a renter's licence photo or deleted their details (like test drives).
CREATE TABLE rental_access_log (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rental_id  bigint      NOT NULL REFERENCES rentals (id) ON DELETE CASCADE,
    staff_id   bigint      REFERENCES staff (id),
    action     text        NOT NULL,
    at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rental_access_log_idx ON rental_access_log (rental_id, at DESC);

-- New top menu item: teams that see Test drive also see Rental cars.
UPDATE teams SET menu = array_append(menu, 'rental')
 WHERE 'testdrive' = ANY (menu) AND NOT 'rental' = ANY (menu);
