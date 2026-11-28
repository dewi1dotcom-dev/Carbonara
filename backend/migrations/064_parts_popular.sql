-- Popular parts first on the parts page (0.64.0, the user's request: "make the recent search and sold parts go on top
-- so the most popular is easy to follow up"). looked_up_at = when the part was last opened or added to an order;
-- sold = its movements out of the stock (taken out, handed out on an order, minus hand-outs undone) in the last 90 days.
ALTER TABLE parts ADD COLUMN looked_up_at timestamptz;

CREATE INDEX part_movements_sold ON part_movements (created_at, part_id)
    WHERE kind IN ('out', 'order', 'order_return');
