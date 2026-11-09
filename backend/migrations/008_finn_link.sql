-- The car's ad on finn.no (FINN code, e.g. 412345678), pasted by staff.
-- Shown as "Available on finn.no" with a link to the ad.
ALTER TABLE vehicles ADD COLUMN finn_code text CHECK (finn_code ~ '^[0-9]{6,12}$');
