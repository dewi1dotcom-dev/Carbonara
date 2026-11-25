-- Work orders and work hours (0.49.0).
--
-- A work order = a car (from Vehicles or from the customer register) + the work to perform (free text and / or a
-- list to tick off) + the mechanic's reply + labour time (clocked on the order) + parts (parts orders tied to it).
-- PDI orders can get their work order number from here when the PDI date is confirmed.
-- Work hours: each person starts and ends the day; fixed breaks (System page) are taken off the worked time and off
-- the time clocked on work orders. Only admins see the hours.

CREATE TABLE work_orders (
    id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    number            integer     NOT NULL UNIQUE CHECK (number > 0),
    status            text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
    vehicle_id        bigint      REFERENCES vehicles (id) ON DELETE SET NULL,       -- a car in Vehicles (e.g. a PDI)
    customer_car_id   bigint      REFERENCES customer_cars (id) ON DELETE SET NULL,  -- or a car in the customer register
    customer_id       bigint      REFERENCES customers (id) ON DELETE SET NULL,
    title             text,
    description       text,                                -- the work to perform (free text)
    tasks             jsonb       NOT NULL DEFAULT '[]',   -- the work as a list: [{id, text, done, done_by, done_at}]
    mechanic_note     text,                                -- the mechanic's reply
    estimated_minutes integer     CHECK (estimated_minutes > 0),
    planned_at        timestamptz,
    assigned_to       bigint      REFERENCES staff (id),
    pdi_order_id      bigint      REFERENCES pdi_orders (id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        bigint      REFERENCES staff (id),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        bigint      REFERENCES staff (id),
    done_at           timestamptz,
    done_by           bigint      REFERENCES staff (id)
);
CREATE INDEX work_orders_status_idx ON work_orders (status);
CREATE INDEX work_orders_vehicle_idx ON work_orders (vehicle_id);
CREATE INDEX work_orders_car_idx ON work_orders (customer_car_id);
CREATE INDEX work_orders_customer_idx ON work_orders (customer_id);

-- History of a work order (ids and short values only; never customer details or texts).
CREATE TABLE work_order_events (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_order_id bigint      NOT NULL REFERENCES work_orders (id) ON DELETE CASCADE,
    kind          text        NOT NULL,
    data          jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    bigint      REFERENCES staff (id)
);
CREATE INDEX work_order_events_idx ON work_order_events (work_order_id, created_at DESC);

-- One row per person and working day: start, end and that day's breaks ("11:30-12:00"; copied from the System page
-- when the day starts, an admin can change them for the day).
CREATE TABLE work_days (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    staff_id   bigint      NOT NULL REFERENCES staff (id),
    day        date        NOT NULL,
    started_at timestamptz NOT NULL,
    ended_at   timestamptz,
    breaks     jsonb       NOT NULL DEFAULT '[]',
    note       text,
    edited_at  timestamptz,
    edited_by  bigint      REFERENCES staff (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (staff_id, day),
    CHECK (ended_at IS NULL OR ended_at > started_at)
);
CREATE INDEX work_days_day_idx ON work_days (day);

-- Time clocked on work orders. One running clock per person.
CREATE TABLE work_time (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_order_id bigint      NOT NULL REFERENCES work_orders (id) ON DELETE CASCADE,
    staff_id      bigint      NOT NULL REFERENCES staff (id),
    started_at    timestamptz NOT NULL,
    ended_at      timestamptz,
    note          text,
    edited_at     timestamptz,
    edited_by     bigint      REFERENCES staff (id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (ended_at IS NULL OR ended_at > started_at)
);
CREATE UNIQUE INDEX work_time_running_idx ON work_time (staff_id) WHERE ended_at IS NULL;
CREATE INDEX work_time_order_idx ON work_time (work_order_id);
CREATE INDEX work_time_staff_idx ON work_time (staff_id, started_at);

-- Parts orders can belong to a work order; they then don't need a customer (e.g. a PDI on a car in stock).
ALTER TABLE parts_orders ADD COLUMN work_order_id bigint REFERENCES work_orders (id) ON DELETE SET NULL;
CREATE INDEX parts_orders_work_order_idx ON parts_orders (work_order_id);

-- A PDI order whose work order number came from Carbonara.
ALTER TABLE pdi_orders ADD COLUMN work_order_id bigint REFERENCES work_orders (id) ON DELETE SET NULL;

-- The new top menu item: teams that see Parts or Customers get Work orders.
UPDATE teams SET menu = array_append(menu, 'work_orders')
 WHERE ('parts' = ANY (menu) OR 'customers' = ANY (menu)) AND NOT 'work_orders' = ANY (menu);
