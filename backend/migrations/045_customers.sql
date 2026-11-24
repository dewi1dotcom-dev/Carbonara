-- Customer register + parts orders (0.48.0).
-- Customers (customer number, private or company), their cars (kept apart from the car database `vehicles`), who owns
-- each car over time, and parts orders for a customer's car. A car from the car database can be copied into the
-- register when the customer agrees (consent logged). Customers with no activity are deleted after retention_years.

-- The customer on a car in the car database (typed by sales; personal data, never in vehicle_events).
ALTER TABLE vehicles
    ADD COLUMN customer_first_name text,
    ADD COLUMN customer_last_name  text,
    ADD COLUMN customer_address    text,
    ADD COLUMN customer_phone      text;

CREATE TABLE customers (
    id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_no      integer     NOT NULL UNIQUE CHECK (customer_no > 0),
    kind             text        NOT NULL DEFAULT 'private' CHECK (kind IN ('private', 'company')),
    first_name       text,
    last_name        text,
    company_name     text,
    org_no           text,
    name             text        NOT NULL,   -- "First Last" or the company name (lists, search)
    phone            text,
    email            text,
    address          text,
    postal_code      text,
    city             text,
    note             text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    created_by       bigint      REFERENCES staff (id),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    updated_by       bigint      REFERENCES staff (id),
    last_activity_at timestamptz NOT NULL DEFAULT now()   -- retention: deleted after retention_years without activity
);
CREATE INDEX customers_name_idx ON customers (lower(name));

CREATE TABLE customer_cars (
    id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    registration_number text,       -- upper case, no spaces
    vin                 text,
    make                text,
    model               text,
    color               text,
    fuel_type           text,
    model_year          smallint    CHECK (model_year BETWEEN 1900 AND 2100),
    first_registered    date,
    note                text,
    vehicle_id          bigint      REFERENCES vehicles (id) ON DELETE SET NULL,  -- copied from the car database
    consent_at          timestamptz,                                              -- the customer agreed to the copy
    consent_by          bigint      REFERENCES staff (id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          bigint      REFERENCES staff (id),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (registration_number IS NOT NULL OR vin IS NOT NULL)
);
CREATE UNIQUE INDEX customer_cars_vin_idx ON customer_cars (vin) WHERE vin IS NOT NULL;
CREATE INDEX customer_cars_reg_idx ON customer_cars (registration_number);

ALTER TABLE vehicles ADD COLUMN customer_car_id bigint REFERENCES customer_cars (id) ON DELETE SET NULL;

-- Who owned a car when. One current owner (ended_at NULL) per car; earlier owners are kept as history.
CREATE TABLE car_ownerships (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    car_id      bigint      NOT NULL REFERENCES customer_cars (id) ON DELETE CASCADE,
    customer_id bigint      NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    started_at  timestamptz NOT NULL DEFAULT now(),
    started_by  bigint      REFERENCES staff (id),
    ended_at    timestamptz,
    ended_by    bigint      REFERENCES staff (id)
);
CREATE UNIQUE INDEX car_ownerships_current_idx ON car_ownerships (car_id) WHERE ended_at IS NULL;
CREATE INDEX car_ownerships_customer_idx ON car_ownerships (customer_id);

-- Parts orders: open -> ordered (from the supplier) -> arrived -> done (handed out; stock goes down), or cancelled.
CREATE TABLE parts_orders (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_no     integer     NOT NULL UNIQUE,
    customer_id  bigint      REFERENCES customers (id) ON DELETE SET NULL,
    car_id       bigint      REFERENCES customer_cars (id) ON DELETE SET NULL,
    status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ordered', 'arrived', 'done', 'cancelled')),
    reference    text,       -- work order / customer's reference
    note         text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    created_by   bigint      REFERENCES staff (id),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    done_at      timestamptz,
    done_by      bigint      REFERENCES staff (id)
);
CREATE INDEX parts_orders_customer_idx ON parts_orders (customer_id);
CREATE INDEX parts_orders_car_idx ON parts_orders (car_id);
CREATE INDEX parts_orders_status_idx ON parts_orders (status);

CREATE TABLE parts_order_lines (
    id          bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id    bigint        NOT NULL REFERENCES parts_orders (id) ON DELETE CASCADE,
    part_id     bigint        REFERENCES parts (id),   -- NULL = a free text line (not in the parts store)
    part_number text,
    name        text          NOT NULL,
    unit        text          NOT NULL DEFAULT 'pcs',
    quantity    numeric(12,2) NOT NULL CHECK (quantity > 0),
    unit_price  numeric(12,2) CHECK (unit_price >= 0),   -- per unit, ex VAT
    vat_rate    numeric(5,2)  NOT NULL DEFAULT 25 CHECK (vat_rate BETWEEN 0 AND 100),
    created_at  timestamptz   NOT NULL DEFAULT now(),
    created_by  bigint        REFERENCES staff (id)
);
CREATE INDEX parts_order_lines_order_idx ON parts_order_lines (order_id);
CREATE INDEX parts_order_lines_part_idx ON parts_order_lines (part_id);

-- History of customers, their cars and orders. Ids only in data, never names / phones (those may be deleted).
CREATE TABLE register_events (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id bigint      REFERENCES customers (id) ON DELETE CASCADE,
    car_id      bigint      REFERENCES customer_cars (id) ON DELETE CASCADE,
    order_id    bigint      REFERENCES parts_orders (id) ON DELETE CASCADE,
    kind        text        NOT NULL,
    data        jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  bigint      REFERENCES staff (id)
);
CREATE INDEX register_events_customer_idx ON register_events (customer_id, created_at DESC);
CREATE INDEX register_events_car_idx ON register_events (car_id, created_at DESC);
CREATE INDEX register_events_order_idx ON register_events (order_id, created_at DESC);

-- Stock taken out by a parts order (and put back when a hand-out is undone).
ALTER TABLE part_movements ADD COLUMN order_id bigint REFERENCES parts_orders (id) ON DELETE SET NULL;
ALTER TABLE part_movements DROP CONSTRAINT part_movements_kind_check;
ALTER TABLE part_movements ADD CONSTRAINT part_movements_kind_check
    CHECK (kind IN ('created', 'received', 'out', 'count', 'import', 'price', 'order', 'order_return'));
