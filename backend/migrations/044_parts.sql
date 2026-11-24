-- Parts store (delelager, 0.47.0): spare parts with part number, name, prices (cost and sales, ex VAT; the price with
-- VAT is worked out from vat_rate), shelf location and stock count. Every change of the stock is a movement, so the
-- count can always be explained. Kept apart from the cars (not linked to vehicles in this version).
CREATE TABLE parts (
    id            bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    part_number   text          NOT NULL,                 -- as written by the maker / supplier
    part_key      text          NOT NULL,                 -- upper case, letters + digits only (search, import matching)
    name          text          NOT NULL,
    make          text,                                   -- the car make the part is for (free text, data)
    supplier      text,
    location      text,                                   -- shelf / bin
    unit          text          NOT NULL DEFAULT 'pcs' CHECK (unit IN ('pcs', 'set', 'l', 'm', 'kg')),
    quantity      numeric(12,2) NOT NULL DEFAULT 0,
    min_quantity  numeric(12,2) CHECK (min_quantity >= 0),  -- "low stock" at or below this
    cost_price    numeric(12,2) CHECK (cost_price >= 0),    -- purchase price per unit, ex VAT
    sale_price    numeric(12,2) CHECK (sale_price >= 0),    -- sales price per unit, ex VAT
    vat_rate      numeric(5,2)  NOT NULL DEFAULT 25 CHECK (vat_rate BETWEEN 0 AND 100),
    note          text,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    created_by    bigint        REFERENCES staff (id),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    updated_by    bigint        REFERENCES staff (id),
    deleted_at    timestamptz,
    deleted_by    bigint        REFERENCES staff (id)
);
-- One active part per part number; a deleted part's number can be used again.
CREATE UNIQUE INDEX parts_key_active ON parts (part_key) WHERE deleted_at IS NULL;

-- Stock movements and price changes of a part (its history).
CREATE TABLE part_movements (
    id             bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    part_id        bigint        NOT NULL REFERENCES parts (id) ON DELETE CASCADE,
    kind           text          NOT NULL CHECK (kind IN ('created', 'received', 'out', 'count', 'import', 'price')),
    change         numeric(12,2) NOT NULL DEFAULT 0,      -- + in, − out (0 for a price change)
    quantity_after numeric(12,2) NOT NULL,
    unit_cost      numeric(12,2),                         -- received: purchase price per unit, ex VAT
    reference      text,                                  -- delivery note / invoice / work order / receipt no.
    note           text,
    data           jsonb,                                 -- price: {sale_from, sale_to, cost_from, cost_to}
    created_at     timestamptz   NOT NULL DEFAULT now(),
    created_by     bigint        REFERENCES staff (id)
);
CREATE INDEX part_movements_part_idx ON part_movements (part_id, created_at DESC);

-- Imported price lists / stock files.
CREATE TABLE part_imports (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_name    text        NOT NULL,
    rows_read    integer     NOT NULL DEFAULT 0,
    added        integer     NOT NULL DEFAULT 0,
    updated      integer     NOT NULL DEFAULT 0,
    skipped      integer     NOT NULL DEFAULT 0,
    imported_at  timestamptz NOT NULL DEFAULT now(),
    imported_by  bigint      REFERENCES staff (id)
);
