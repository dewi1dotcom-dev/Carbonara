-- Customer deliveries: Statens vegvesen lookup by registration number.
-- Done in the background right after the kiosk form is sent; staff can repeat it.
-- svv_name is the registered owner's name, once the SVV API sends owner data
-- (not yet). The name the customer typed (customer_name) is always kept; the
-- SVV name is shown first. Both are deleted with the delivery.
ALTER TABLE car_deliveries
    ADD COLUMN svv_status      text CHECK (svv_status IN ('ok', 'not_found', 'error', 'not_configured')),
    ADD COLUMN svv_checked_at  timestamptz,
    ADD COLUMN svv_error       text,
    ADD COLUMN svv_vin         text,
    ADD COLUMN svv_make        text,
    ADD COLUMN svv_model       text,
    ADD COLUMN svv_eu_due      date,
    ADD COLUMN svv_name        text,
    ADD COLUMN svv_owner_kind  text CHECK (svv_owner_kind IN ('person', 'company')),
    ADD COLUMN name_match      text CHECK (name_match IN ('same', 'similar', 'different', 'company'));
