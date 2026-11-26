-- Work orders (0.57.0): a recall check when the car's make is covered by a recall source (Settings → Recall sources).
-- Stored on the work order, so it works for cars in the customer register as well as cars in stock; recalls found
-- become tasks on the work order (and, for a car in stock, recalls on the car as before).
ALTER TABLE work_orders
    ADD COLUMN recall_checked_at timestamptz,
    ADD COLUMN recall_checked_by bigint REFERENCES staff (id) ON DELETE SET NULL,
    ADD COLUMN recall_result     text CHECK (recall_result IN ('none', 'found'));
