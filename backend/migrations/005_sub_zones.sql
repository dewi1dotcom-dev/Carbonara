-- Sub-zones: a storage spot (e.g. BRUKTBILREKKE) can be split into named
-- sub-zones (RAD 1, RAD 2…), one level deep. Cars are placed in a sub-zone
-- once a spot has them. Codes only need to be unique within their parent.
ALTER TABLE storage_locations
    ADD COLUMN parent_id bigint REFERENCES storage_locations (id),
    ADD CONSTRAINT storage_locations_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id);
ALTER TABLE storage_locations DROP CONSTRAINT IF EXISTS storage_locations_code_key;
CREATE UNIQUE INDEX storage_locations_code_per_parent ON storage_locations (coalesce(parent_id, 0), code);
CREATE INDEX storage_locations_parent_idx ON storage_locations (parent_id);

-- Display names for every spot: "BRUKTBILREKKE › RAD 1"; zone and active
-- status are inherited from the parent.
CREATE VIEW storage_spots AS
SELECT l.id,
       l.parent_id,
       l.code                                         AS own_code,
       coalesce(p.code || ' › ', '') || l.code         AS code,
       coalesce(l.zone, p.zone)                       AS zone,
       l.description,
       l.capacity,
       l.active AND coalesce(p.active, true)          AS active
  FROM storage_locations l
  LEFT JOIN storage_locations p ON p.id = l.parent_id;
