-- A PDI order can also be handed to the workshop on paper or as a PDF
-- (printed from the browser) instead of by e-mail: sent_via 'print', with no
-- e-mail address in sent_to.

-- Drop the old CHECK on sent_via whatever it was named (normally
-- pdi_orders_sent_via_check), then add the wider one.
DO $$
DECLARE c text;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'pdi_orders'::regclass AND contype = 'c'
                AND position('sent_via' IN pg_get_constraintdef(oid)) > 0
    LOOP
        EXECUTE format('ALTER TABLE pdi_orders DROP CONSTRAINT %I', c);
    END LOOP;
END $$;

ALTER TABLE pdi_orders ADD CONSTRAINT pdi_orders_sent_via_check
    CHECK (sent_via IN ('smtp', 'mail_app', 'print'));
