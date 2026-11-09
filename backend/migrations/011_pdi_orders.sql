-- PDI orders: what the customer ordered for a new car, sent to the workshop
-- that does the Pre Delivery Inspection (RBV – Rygge Bilverksted).

-- Editable lists (Settings): order items, tyre companies, e-mail recipients.
CREATE TABLE pdi_lists (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind        text        NOT NULL CHECK (kind IN ('item', 'tyre_company', 'recipient')),
    label       text        NOT NULL CHECK (length(trim(label)) > 0),
    email       text,                                  -- recipients only
    choices     text[]      NOT NULL DEFAULT '{}',     -- items: e.g. {Gummi, Tekstil} for floor mats
    is_default  boolean     NOT NULL DEFAULT false,    -- recipients: preselected in the send dialog
    sort        integer     NOT NULL DEFAULT 0,
    active      boolean     NOT NULL DEFAULT true,
    CHECK (kind <> 'recipient' OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
CREATE INDEX pdi_lists_kind_idx ON pdi_lists (kind, active, sort);

-- Starting lists (labels go to RBV in Norwegian; rename freely in Settings).
INSERT INTO pdi_lists (kind, label, choices, sort) VALUES
    ('item', 'PDI',                    '{}',                10),
    ('item', 'Gulvmatter',             '{Gummi,Tekstil}',   20),
    ('item', 'Bagasjeromsmatte',       '{}',                30),
    ('item', 'Hengerfeste',            '{}',                40),
    ('item', 'LED-bar',                '{}',                50),
    ('item', 'Skiluke / lastluke',     '{}',                60),
    ('item', 'Sprutlapper',            '{}',                70);
INSERT INTO pdi_lists (kind, label, sort) VALUES
    ('tyre_company', 'NorgesDekk', 10),
    ('tyre_company', 'Drivalia',   20);
-- No e-mail recipients are built in: they are added under Settings.

CREATE TABLE pdi_orders (
    id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id       bigint      NOT NULL REFERENCES vehicles (id),
    status           text        NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'sent', 'booked', 'done', 'cancelled')),
    items            jsonb       NOT NULL DEFAULT '[]',   -- [{label, choice}]
    other            text,                                -- "and more": free text
    tyres            jsonb       NOT NULL DEFAULT '{}',   -- {mode, company, expected_date, note}
    note             text,

    created_at       timestamptz NOT NULL DEFAULT now(),
    created_by       bigint      REFERENCES staff (id),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    sent_at          timestamptz,
    sent_by          bigint      REFERENCES staff (id),
    sent_to          text,                                -- e-mail address it went to
    sent_via         text        CHECK (sent_via IN ('smtp', 'mail_app')),
    pdi_at           timestamptz,                         -- booked date/time from RBV's reply
    booked_by        bigint      REFERENCES staff (id),
    done_at          timestamptz,
    done_by          bigint      REFERENCES staff (id),
    cancelled_at     timestamptz
);
-- One open order per car.
CREATE UNIQUE INDEX pdi_orders_one_open ON pdi_orders (vehicle_id) WHERE status NOT IN ('done', 'cancelled');
CREATE INDEX pdi_orders_pdi_at_idx ON pdi_orders (pdi_at) WHERE status = 'booked';
