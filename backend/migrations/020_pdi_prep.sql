-- Preparing a car the day before its PDI: which trade plates go with it,
-- a short message about where it is (the spot itself is the car's storage
-- assignment), and where the winter wheels are when the dealer has them.
ALTER TABLE pdi_orders
    ADD COLUMN prep_plate_id        bigint      REFERENCES trade_plates (id),
    ADD COLUMN prep_note            text,
    ADD COLUMN prep_wheels_location text,
    ADD COLUMN prepared_at          timestamptz,
    ADD COLUMN prepared_by          bigint      REFERENCES staff (id);
