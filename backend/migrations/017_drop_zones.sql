-- Zones are no longer used (spots, sub-zones and descriptions are enough).
-- So nothing is lost, a spot's zone becomes its description if it has none.
UPDATE storage_locations
   SET description = zone
 WHERE zone IS NOT NULL AND trim(zone) <> '' AND (description IS NULL OR trim(description) = '');
UPDATE storage_locations SET zone = NULL WHERE zone IS NOT NULL;