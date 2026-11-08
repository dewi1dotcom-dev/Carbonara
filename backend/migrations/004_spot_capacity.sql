-- A storage spot can hold many cars (e.g. a row like BRUKTBILREKKE), optionally
-- up to a capacity. NULL capacity = unlimited. A car is still in at most one
-- spot at a time (storage_one_location_per_vehicle stays).
DROP INDEX IF EXISTS storage_one_vehicle_per_location;
ALTER TABLE storage_locations ADD COLUMN capacity integer CHECK (capacity IS NULL OR capacity > 0);
