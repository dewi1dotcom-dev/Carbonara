-- PDI sheets: when a PDI is done, the car model's own PDI form (a PDF) is
-- filled in with reg. no, VIN, mileage, date, a company stamp and the
-- signature of the person marking it done, and stored on the PDI order.

-- One PDF form per car model (or group of models). The positions of the
-- fields are tapped in once by an admin (Settings → PDI sheets).
CREATE TABLE pdi_templates (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL,
    models      text        NOT NULL DEFAULT '',   -- comma-separated, matched against the car's make + model
    file_key    text        NOT NULL,              -- PHOTO_DIR/<file_key>.pdf
    pages       jsonb       NOT NULL DEFAULT '[]', -- [{w, h}] page sizes in PDF points, as displayed
    -- {key: {page, x, y, size | w}}: x, y = share of the page width / height from the top left.
    -- Text (reg, vin, km, date, signer): x, y = start of the text, middle of the line; size in points.
    -- Pictures (stamp, signature): x, y = the centre; w = share of the page width.
    fields      jsonb       NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  bigint      REFERENCES staff (id),
    updated_at  timestamptz,
    deleted_at  timestamptz                        -- hidden; kept while sheets refer to it
);

-- Company stamps (pictures). Several are possible; one is the default.
CREATE TABLE pdi_stamps (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL,
    file_key    text        NOT NULL,              -- PHOTO_DIR/<file_key>.png (white made transparent)
    is_default  boolean     NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  bigint      REFERENCES staff (id),
    deleted_at  timestamptz
);

-- Each user's own signature (drawn or uploaded), PHOTO_DIR/<signature_key>.png.
ALTER TABLE staff
    ADD COLUMN signature_key        text,
    ADD COLUMN signature_updated_at timestamptz;

-- The filled-in sheet on the PDI order, and what it was made with.
ALTER TABLE pdi_orders
    ADD COLUMN done_km           integer,
    ADD COLUMN sheet_file_key    text,           -- PHOTO_DIR/<sheet_file_key>.pdf
    ADD COLUMN sheet_template_id bigint REFERENCES pdi_templates (id),
    ADD COLUMN sheet_stamp_id    bigint REFERENCES pdi_stamps (id),
    ADD COLUMN sheet_date        date,
    ADD COLUMN sheet_made_at     timestamptz,
    ADD COLUMN sheet_made_by     bigint REFERENCES staff (id);
