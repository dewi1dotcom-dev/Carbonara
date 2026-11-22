-- Market data (test, 0.46.0): listings imported from a file (CSV), used to compare the asking prices of our own cars
-- with the market by make, model, year and mileage. Kept apart from vehicles; switched on / off on the System page.
-- Only what the price comparison needs is stored: no seller names or places (seller_kind = private / dealer).
CREATE TABLE market_imports (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_name    text        NOT NULL,
    rows_read    integer     NOT NULL DEFAULT 0,
    rows_skipped integer     NOT NULL DEFAULT 0,
    models       text[]      NOT NULL DEFAULT '{}',   -- "Make Model" groups in the file (each replaced earlier listings)
    imported_at  timestamptz NOT NULL DEFAULT now(),
    imported_by  bigint      REFERENCES staff (id)
);

CREATE TABLE market_listings (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    import_id    bigint      NOT NULL REFERENCES market_imports (id) ON DELETE CASCADE,
    make         text        NOT NULL,
    model        text        NOT NULL,
    make_key     text        NOT NULL,   -- lower case, letters and digits only (matching)
    model_key    text        NOT NULL,
    variant      text,
    year         integer     CHECK (year BETWEEN 1950 AND 2100),
    km           integer     CHECK (km BETWEEN 0 AND 2000000),
    price        integer     NOT NULL CHECK (price BETWEEN 1000 AND 99999999),
    first_price  integer     CHECK (first_price BETWEEN 1000 AND 99999999),
    fuel         text,
    seller_kind  text        CHECK (seller_kind IN ('private', 'dealer')),
    status       text,
    active       boolean     NOT NULL DEFAULT true,   -- false for sold / removed listings
    first_seen   date,
    last_seen    date,
    finn_code    text,
    url          text
);
CREATE INDEX market_listings_model_idx ON market_listings (make_key, model_key);
