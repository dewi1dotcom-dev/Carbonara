-- The language of a delivery kiosk tablet is chosen per tablet on the Customer deliveries page
-- (admins), not on the tablet itself, so customers can't change it. Norwegian by default.
ALTER TABLE kiosk_devices ADD COLUMN language text NOT NULL DEFAULT 'no' CHECK (language IN ('en', 'no'));
