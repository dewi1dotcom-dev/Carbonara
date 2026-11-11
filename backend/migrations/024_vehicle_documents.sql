-- Documents per car: contracts, notes and other files (PDF, photos, Office
-- files). A document has a file, a text, or both. Files live under
-- PHOTO_DIR/docs/… and are removed with the car when it is purged.
CREATE TABLE vehicle_documents (
    id             bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id     bigint       NOT NULL REFERENCES vehicles (id),
    kind           text         NOT NULL CHECK (kind IN ('contract', 'note', 'other')),
    title          text,
    body           text,
    file_key       text         UNIQUE,         -- path stem under PHOTO_DIR, e.g. docs/2026/11/<uuid>
    original_ext   text,
    original_name  text,
    mime_type      text,
    size_bytes     bigint,
    created_at     timestamptz  NOT NULL DEFAULT now(),
    created_by     bigint       REFERENCES staff (id),
    updated_at     timestamptz,
    updated_by     bigint       REFERENCES staff (id),
    CHECK (file_key IS NOT NULL OR length(trim(coalesce(body, ''))) > 0)
);
CREATE INDEX vehicle_documents_vehicle_idx ON vehicle_documents (vehicle_id, created_at);
