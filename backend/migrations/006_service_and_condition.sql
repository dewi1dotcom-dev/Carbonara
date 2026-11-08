-- New or used car, and the last service (for "next service due").
-- New cars need no service record: their first service is due one year after
-- first registration (from Statens vegvesen).
ALTER TABLE vehicles
    ADD COLUMN condition         text    CHECK (condition IN ('new', 'used')),
    ADD COLUMN last_service_date date,
    ADD COLUMN last_service_km   integer CHECK (last_service_km >= 0);

-- Registration numbers are stored without spaces: "EB 82655" -> "EB82655".
UPDATE vehicles
   SET registration_number = upper(regexp_replace(registration_number, '[^A-Za-z0-9ÆØÅæøå]', '', 'g'))
 WHERE registration_number IS NOT NULL;
UPDATE vehicle_registry
   SET registration_number = upper(regexp_replace(registration_number, '[^A-Za-z0-9ÆØÅæøå]', '', 'g'))
 WHERE registration_number IS NOT NULL;
