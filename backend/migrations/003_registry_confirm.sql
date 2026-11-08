-- Differences between typed vehicle data and Statens vegvesen are confirmed by
-- staff instead of being overwritten. When staff keep their own value, the
-- registry value they declined is remembered ({field: registry_value}) so the
-- same prompt does not come back until the registry value changes again.
ALTER TABLE vehicle_registry ADD COLUMN kept_values jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The VIN can now also come from a registration-number lookup in Statens vegvesen.
ALTER TABLE inspections DROP CONSTRAINT IF EXISTS inspections_vin_source_check;
ALTER TABLE inspections ADD CONSTRAINT inspections_vin_source_check
    CHECK (vin_source IN ('manual', 'barcode', 'ocr', 'registry'));
