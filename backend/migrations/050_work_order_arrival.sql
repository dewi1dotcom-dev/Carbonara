-- Arrival on the kiosk (0.52.0): a customer with a work order planned today picks their car on the delivery kiosk
-- (registration number + first name); the delivery is tied to the work order and the planner shows the car as arrived.

ALTER TABLE work_orders ADD COLUMN arrived_at timestamptz;
ALTER TABLE car_deliveries ADD COLUMN work_order_id bigint REFERENCES work_orders (id) ON DELETE SET NULL;
CREATE INDEX car_deliveries_work_order_idx ON car_deliveries (work_order_id);
