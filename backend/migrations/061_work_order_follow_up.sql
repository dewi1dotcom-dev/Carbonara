-- Work orders that aren't forgotten (0.61.0, the user's request: "2–5 weeks of waiting time, many open work orders
-- for various reasons … open orders that are forgotten usually pile up").
--
-- waiting_for = why an open work order is waiting (set by hand): customer (reply / approval of the price), car (not
-- delivered yet), approval (warranty, insurance, importer), parts, other. "Parts" and "planned" are also shown on
-- their own from the parts lines and the planner (routers/work_orders.py).
-- follow_up_on = "look at it again on": on that day it is on Today and its creator (+ the people chosen on the
-- Settings page) get a notification.
ALTER TABLE work_orders
    ADD COLUMN waiting_for  text CHECK (waiting_for IN ('customer', 'car', 'approval', 'parts', 'other')),
    ADD COLUMN waiting_note text,
    ADD COLUMN follow_up_on date;
CREATE INDEX work_orders_follow_up_idx ON work_orders (follow_up_on) WHERE follow_up_on IS NOT NULL;
