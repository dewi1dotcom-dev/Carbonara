-- PDI sheets: the 12V battery reading and "tick all boxes", stored on the order so
-- "Make sheet again" can fill them in the same way.
ALTER TABLE pdi_orders
    ADD COLUMN done_battery_v numeric(4,2),
    ADD COLUMN sheet_checks boolean NOT NULL DEFAULT false;
