-- Work orders (0.55.1): "Parts arrived and ready", ticked by hand on the work order or in the planner.
-- Until it is ticked, a work order with parts shows "Waiting for parts".
ALTER TABLE work_orders
    ADD COLUMN parts_ready_at timestamptz,
    ADD COLUMN parts_ready_by bigint REFERENCES staff (id) ON DELETE SET NULL;
