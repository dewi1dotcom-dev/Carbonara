-- Older chassis numbers (0.54.0): veteran cars from before the 17-character VIN (1981) have chassis numbers of other
-- lengths that may use I, O and Q. They are accepted only as Statens vegvesen has them, after a person checked them
-- on the car; vin_nonstandard marks them (no VIN rules, check digit or make decoding apply).

ALTER TABLE vehicles ADD COLUMN vin_nonstandard boolean NOT NULL DEFAULT false;
ALTER TABLE vehicles DROP CONSTRAINT vehicles_vin_check;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_vin_check
    CHECK (vin ~ '^[A-HJ-NPR-Z0-9]{17}$' OR (vin_nonstandard AND vin ~ '^[A-Z0-9]{4,30}$'));

ALTER TABLE customer_cars ADD COLUMN vin_nonstandard boolean NOT NULL DEFAULT false;
