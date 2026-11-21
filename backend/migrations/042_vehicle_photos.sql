-- Cars added from their finn.no ad by Carbonara Sidekick (0.45.0).
--
-- vehicle_photos: the car's own photos, outside any inspection: copied from its finn.no ad (the ones the person
-- ticked) or uploaded on the car page ("Photos" card). Stored by photostore (original + 1600 / 400 px JPEG).
-- The first one is the car's picture in lists until the arrival inspection has a right-side photo.
CREATE TABLE vehicle_photos (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id    bigint      NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
    file_key      text        NOT NULL,
    original_ext  text        NOT NULL,
    mime_type     text        NOT NULL,
    width         integer,
    height        integer,
    size_bytes    integer,
    source        text        NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'finn')),
    sort          integer     NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    bigint      REFERENCES staff (id)
);
CREATE INDEX vehicle_photos_vehicle_idx ON vehicle_photos (vehicle_id, sort, id);

-- The mileage stated on the car's ad, with when it was read (one of the mileage sources on the car page).
ALTER TABLE vehicles
    ADD COLUMN listed_km integer CHECK (listed_km BETWEEN 0 AND 5000000),
    ADD COLUMN listed_km_at timestamptz;
