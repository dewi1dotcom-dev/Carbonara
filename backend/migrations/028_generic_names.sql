-- Carbonara can be used by any dealer, so no workshop is named in the code.
-- The winter tyre option "the workshop orders the tyres" was stored as
-- 'rbv_orders'; it is now 'workshop_orders'.
UPDATE pdi_orders
   SET tyres = jsonb_set(tyres, '{mode}', '"workshop_orders"')
 WHERE tyres->>'mode' = 'rbv_orders';
