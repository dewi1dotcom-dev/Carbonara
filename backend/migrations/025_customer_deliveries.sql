-- Customer car delivery: customers dropping off their car for the workshop
-- register it themselves on a kiosk tablet at the dealership: registration
-- number, name, phone, where the key is, where the car is parked (a pin on a
-- picture of the lot), a few tick boxes and a message.

-- Pictures of the lots, one per location (a drone photo, screenshot or drawing).
-- The file is stored like a photo (photostore). A map that deliveries point to
-- is only deactivated, never deleted, so old pins keep their picture.
CREATE TABLE delivery_maps (
    id            bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          text         NOT NULL CHECK (length(trim(name)) > 0),
    name_no       text,
    file_key      text         NOT NULL UNIQUE,
    original_ext  text         NOT NULL,
    width         integer,
    height        integer,
    sort          integer      NOT NULL DEFAULT 0,
    active        boolean      NOT NULL DEFAULT true,
    created_at    timestamptz  NOT NULL DEFAULT now(),
    created_by    bigint       REFERENCES staff (id)
);

-- Editable lists (admins): where the key can be left, and the tick boxes.
-- Each has an English and a Norwegian label (the kiosk shows the customer's language).
CREATE TABLE delivery_options (
    id        bigint   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind      text     NOT NULL CHECK (kind IN ('key_place', 'checkbox')),
    label     text     NOT NULL CHECK (length(trim(label)) > 0),   -- English
    label_no  text     NOT NULL CHECK (length(trim(label_no)) > 0),
    sort      integer  NOT NULL DEFAULT 0,
    active    boolean  NOT NULL DEFAULT true
);
CREATE INDEX delivery_options_kind_idx ON delivery_options (kind, active, sort);

-- Starting lists; rename or remove them in Customer deliveries → Kiosk setup.
INSERT INTO delivery_options (kind, label, label_no, sort) VALUES
    ('key_place', 'Key drop box',            'Nøkkelboksen',            10),
    ('key_place', 'Reception',               'Resepsjonen',             20),
    ('checkbox',  'Service',                 'Service',                 10),
    ('checkbox',  'EU-kontroll',             'EU-kontroll',             20),
    ('checkbox',  'Tyre change',             'Hjulskift',               30),
    ('checkbox',  'Call me when the car is ready', 'Ring meg når bilen er klar', 40);

-- Tablets allowed to show the delivery form without a staff login. Like
-- sessions, only the SHA-256 of the device's token is stored.
CREATE TABLE kiosk_devices (
    id            bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          text         NOT NULL CHECK (length(trim(name)) > 0),
    token_hash    text         NOT NULL UNIQUE,
    created_at    timestamptz  NOT NULL DEFAULT now(),
    created_by    bigint       REFERENCES staff (id),
    last_seen_at  timestamptz,
    revoked_at    timestamptz,
    revoked_by    bigint       REFERENCES staff (id)
);

CREATE TABLE car_deliveries (
    id                   bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    registration_number  text         NOT NULL,            -- uppercase, no spaces
    vehicle_id           bigint       REFERENCES vehicles (id),  -- when the car is in Carbonara
    customer_name        text         NOT NULL,
    customer_phone       text         NOT NULL,
    map_id               bigint       REFERENCES delivery_maps (id),
    pin_x                real         CHECK (pin_x BETWEEN 0 AND 1),   -- share of the picture's width
    pin_y                real         CHECK (pin_y BETWEEN 0 AND 1),
    key_place            jsonb,                            -- {en, no} as shown when delivered
    checks               jsonb        NOT NULL DEFAULT '[]',  -- [{en, no}] ticked boxes
    message              text,
    kiosk_id             bigint       REFERENCES kiosk_devices (id),
    created_at           timestamptz  NOT NULL DEFAULT now(),
    received_at          timestamptz,
    received_by          bigint       REFERENCES staff (id),
    CHECK ((pin_x IS NULL) = (pin_y IS NULL))
);
-- The whole delivery is deleted TRASH_DAYS after it was received (sync_worker).
CREATE INDEX car_deliveries_open_idx ON car_deliveries (created_at) WHERE received_at IS NULL;
CREATE INDEX car_deliveries_received_idx ON car_deliveries (received_at) WHERE received_at IS NOT NULL;
