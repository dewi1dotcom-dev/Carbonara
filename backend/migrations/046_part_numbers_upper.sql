-- Part numbers in capital letters (0.48.2, the user's rule): new ones are saved that way; this fixes those saved before.
-- (Names get a capital first letter on save; existing names are left as typed, since SQL initcap() would lower the rest.)
UPDATE parts SET part_number = upper(part_number) WHERE part_number <> upper(part_number);
UPDATE parts_order_lines SET part_number = upper(part_number) WHERE part_number <> upper(part_number);
