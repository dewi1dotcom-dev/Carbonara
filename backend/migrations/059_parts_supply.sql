-- Parts on orders, per line (0.60.0, the user's request: "when parts arrived is clicked it should update the work
-- order"; "parts orders also need to generate an invoice").
--
-- supply = where the line's part comes from:
--   stock   – taken from our own stock (enough on the shelf when it was added)
--   order   – has to be ordered from the supplier (not ordered yet)
--   ordered – ordered from the supplier (expected_date optional)
--   arrived – arrived from the supplier (a part from the store is then added to the stock, kind 'order_received')
-- A line is ready when it is 'stock' or 'arrived'; the order's status and the work order's "Parts arrived and ready"
-- follow the lines (routers/parts_orders.py).
ALTER TABLE parts_order_lines
    ADD COLUMN supply        text        NOT NULL DEFAULT 'stock' CHECK (supply IN ('stock', 'order', 'ordered', 'arrived')),
    ADD COLUMN supply_at     timestamptz,
    ADD COLUMN supply_by     bigint      REFERENCES staff (id),
    ADD COLUMN expected_date date;

-- Existing lines get a state from their order's status.
UPDATE parts_order_lines l SET supply = CASE
        WHEN o.status = 'ordered' THEN 'ordered'
        WHEN o.status IN ('arrived', 'done') AND l.part_id IS NULL THEN 'arrived'
        WHEN o.status = 'open' AND l.part_id IS NULL THEN 'order'
        ELSE 'stock' END
  FROM parts_orders o WHERE o.id = l.order_id;

-- A counter sale (a parts order without a work order) is invoiced on its own; the invoice it ended in.
ALTER TABLE parts_orders ADD COLUMN invoice_id bigint REFERENCES invoices (id);

-- A part that arrives for an order goes into the stock first (and out again if the arrival is undone).
ALTER TABLE part_movements DROP CONSTRAINT part_movements_kind_check;
ALTER TABLE part_movements ADD CONSTRAINT part_movements_kind_check
    CHECK (kind IN ('created', 'received', 'out', 'count', 'import', 'price', 'order', 'order_return', 'order_received'));
