-- Deleting storage spots. A spot that has never held a car is removed for
-- good; one with history (past assignments) is marked deleted instead, so the
-- history still points somewhere. Deleted spots are hidden everywhere and
-- their code can be used again.
ALTER TABLE storage_locations ADD COLUMN deleted_at timestamptz;

DROP INDEX storage_locations_code_per_parent;
CREATE UNIQUE INDEX storage_locations_code_per_parent
    ON storage_locations (coalesce(parent_id, 0), code) WHERE deleted_at IS NULL;

-- The view gets a "deleted" flag (a sub-zone is deleted with its spot).
CREATE OR REPLACE VIEW storage_spots AS
SELECT l.id,
       l.parent_id,
       l.code                                         AS own_code,
       coalesce(p.code || ' › ', '') || l.code         AS code,
       coalesce(l.zone, p.zone)                       AS zone,
       l.description,
       l.capacity,
       l.active AND coalesce(p.active, true)          AS active,
       (l.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL) AS deleted
  FROM storage_locations l
  LEFT JOIN storage_locations p ON p.id = l.parent_id;
