-- Discounts (0.63.0, the user's request: "some customers have a set discount … a discount option for each item / work
-- in parts / work orders, but also an option to have a total discount at ex VAT").
-- Percentages are 0–100. A line's own discount wins; NULL = the customer's discount (parts or labour).

-- The customer's standing discount, on parts and on labour.
ALTER TABLE customers
    ADD COLUMN discount_parts  numeric(5,2) CHECK (discount_parts BETWEEN 0 AND 100),
    ADD COLUMN discount_labour numeric(5,2) CHECK (discount_labour BETWEEN 0 AND 100);

-- Per part line (NULL = the customer's parts discount).
ALTER TABLE parts_order_lines
    ADD COLUMN discount numeric(5,2) CHECK (discount BETWEEN 0 AND 100);

-- Labour on a work order (NULL = the customer's labour discount), and a discount on the whole work order / counter
-- sale ex VAT: a percentage or an amount in kr (split over the VAT rates on the invoice). Other charges keep their own
-- discount in work_orders.extra_lines ("discount" per line).
ALTER TABLE work_orders
    ADD COLUMN labour_discount     numeric(5,2) CHECK (labour_discount BETWEEN 0 AND 100),
    ADD COLUMN total_discount      numeric(12,2) CHECK (total_discount >= 0),
    ADD COLUMN total_discount_kind text CHECK (total_discount_kind IN ('percent', 'amount'));

ALTER TABLE parts_orders
    ADD COLUMN total_discount      numeric(12,2) CHECK (total_discount >= 0),
    ADD COLUMN total_discount_kind text CHECK (total_discount_kind IN ('percent', 'amount'));
