-- The workshop's work order number for the PDI: entered when the PDI date is
-- confirmed (editable later) and printed on the PDI sheet.
ALTER TABLE pdi_orders ADD COLUMN work_order text;
