-- Kiosk deliveries belong to the workshop (0.53.0): a delivered car is linked to the workshop's customer register
-- (customer_cars), no longer to the sales company's stock (vehicles). vehicle_id stays for deliveries made before.

ALTER TABLE car_deliveries ADD COLUMN customer_car_id bigint REFERENCES customer_cars (id) ON DELETE SET NULL;
CREATE INDEX car_deliveries_customer_car_idx ON car_deliveries (customer_car_id);
