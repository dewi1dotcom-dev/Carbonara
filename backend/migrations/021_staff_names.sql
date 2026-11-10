-- Staff get a first name, last name and phone number. `name` stays as the
-- display name ("First Last") that all history and pickers use.
-- Deleting a deactivated person: removed for good when nothing refers to them,
-- otherwise deleted_at is set (hidden from the staff list, phone and PIN
-- wiped) so their name stays on the history they signed (storage checks…).
ALTER TABLE staff
    ADD COLUMN first_name text,
    ADD COLUMN last_name  text,
    ADD COLUMN phone      text,
    ADD COLUMN deleted_at timestamptz,
    ADD COLUMN deleted_by bigint REFERENCES staff (id);

-- Existing names: first word = first name, the rest = last name.
UPDATE staff
   SET first_name = split_part(btrim(name), ' ', 1),
       last_name  = nullif(btrim(substr(btrim(name), length(split_part(btrim(name), ' ', 1)) + 1)), '');
