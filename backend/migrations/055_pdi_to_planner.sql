-- PDI orders (0.56.0): sending a PDI order puts it straight into the workshop planner as a work order
-- (sent_via 'planner'); e-mail sending is no longer offered (old rows keep 'smtp' / 'mail_app').
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
    CHECK (sent_via IN ('smtp', 'mail_app', 'print', 'planner'));
