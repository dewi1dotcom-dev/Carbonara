-- Customer register cars (0.59.0, the user's request): dates from Statens vegvesen that staff can't change. Filled
-- when a car is added or its reg. no. / VIN changes, with "Look up again", and by the worker every vegvesen_sync_days.
ALTER TABLE customer_cars
    ADD COLUMN first_registered_norway  date,         -- differs from first_registered for an imported car
    ADD COLUMN owner_since              date,         -- the current owner's registration date at Statens vegvesen
    ADD COLUMN eu_control_due           date,
    ADD COLUMN eu_control_last_approved date,
    ADD COLUMN registry_checked_at      timestamptz,
    ADD COLUMN registry_error           text;
