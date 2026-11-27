-- Kiosk deliveries of cars the workshop doesn't know yet (0.60.3, the user's request): the car's legal owner (name +
-- address) is asked for, and the person delivering may be someone else (a first name + the contact phone).
-- customer_name stays the owner's full name as typed; the rows are deleted with the delivery (trash_days after it is
-- received), like the rest of it.
ALTER TABLE car_deliveries
    ADD COLUMN owner_address     text,
    ADD COLUMN owner_postal_code text,
    ADD COLUMN owner_city        text,
    ADD COLUMN not_owner         boolean NOT NULL DEFAULT false,   -- the person delivering isn't the owner
    ADD COLUMN contact_name      text;                             -- their first name, when not the owner
