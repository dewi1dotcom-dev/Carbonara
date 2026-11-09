-- Each staff member chooses English or Norwegian. Existing accounts keep the
-- English they have used so far; they can switch under their name.
ALTER TABLE staff ADD COLUMN language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'no'));

-- Wording of the PDI order items (sent to the workshop in Norwegian):
-- "Sprutlapper" is "Skvettlapper", and PDI is "Nybilklargjøring".
UPDATE pdi_lists SET label = 'Skvettlapper' WHERE kind = 'item' AND label = 'Sprutlapper';
UPDATE pdi_lists SET label = 'Nybilklargjøring' WHERE kind = 'item' AND label = 'PDI';

-- Open orders that already list them use the new names too.
UPDATE pdi_orders o
   SET items = (SELECT coalesce(jsonb_agg(
                    CASE i ->> 'label'
                        WHEN 'Sprutlapper' THEN jsonb_set(i, '{label}', '"Skvettlapper"')
                        WHEN 'PDI'         THEN jsonb_set(i, '{label}', '"Nybilklargjøring"')
                        ELSE i END), '[]'::jsonb)
                  FROM jsonb_array_elements(o.items) AS i)
 WHERE o.status NOT IN ('done', 'cancelled')
   AND o.items @> ANY (ARRAY['[{"label": "Sprutlapper"}]', '[{"label": "PDI"}]']::jsonb[]);
