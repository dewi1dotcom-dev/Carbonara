-- Work orders (0.58.0, the user's request): recalls found when a work order's car is checked can go on a new work order
-- of their own. The first work order keeps a link to it ("Recalls on work order #n"); the new one finds its origin
-- through this column. A job type for recalls is added (data; dealers can rename or remove it under Job types).
ALTER TABLE work_orders
    ADD COLUMN recall_work_order_id bigint REFERENCES work_orders (id) ON DELETE SET NULL;

INSERT INTO job_types (name, name_no, color, sort)
SELECT 'Recall / campaign', 'Tilbakekalling / kampanje', '#FFB74D', 55
 WHERE NOT EXISTS (SELECT 1 FROM job_types WHERE lower(name) = 'recall / campaign');
