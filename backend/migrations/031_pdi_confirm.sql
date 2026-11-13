-- PDI orders: an expected completion date (defaults to the day after the PDI
-- date) and a confirmation of the PDI date (who confirmed it, when). Changing
-- the date clears the confirmation.
ALTER TABLE pdi_orders
    ADD COLUMN expected_done_date date,
    ADD COLUMN pdi_confirmed_at   timestamptz,
    ADD COLUMN pdi_confirmed_by   bigint REFERENCES staff (id);

-- Orders that already have a PDI date get the default.
UPDATE pdi_orders SET expected_done_date = (pdi_at AT TIME ZONE 'Europe/Oslo')::date + 1
 WHERE pdi_at IS NOT NULL;

-- New top menu item "PDI orders": teams that see Vehicles also see it.
UPDATE teams SET menu = array_append(menu, 'pdi_orders')
 WHERE 'vehicles' = ANY (menu) AND NOT 'pdi_orders' = ANY (menu);
