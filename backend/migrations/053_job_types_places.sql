-- Planner (0.55.0): job types with colours and workshop places (lifts / bays) as planner lines.
--
-- job_types: what kind of job a work order is (service, EU-kontroll, tyres …); its colour fills the job on the planner.
--   Names in English and Norwegian (admin-entered data can't go through the translator). Removed = active false.
-- workshop_places: a place in the workshop (a lift, a bay, the wheel alignment rig …), a line on its team's planner.
--   A work order can be booked on a place as well as on a mechanic. Removed = deleted_at (history keeps the name).

CREATE TABLE job_types (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       text        NOT NULL,
    name_no    text,
    color      text        NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
    sort       integer     NOT NULL DEFAULT 0,
    active     boolean     NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO job_types (name, name_no, color, sort) VALUES
    ('Service',                  'Service',                   '#4CAF50', 10),
    ('Repair',                   'Reparasjon',                '#64B5F6', 20),
    ('EU-kontroll / alignment',  'EU-kontroll / hjulstilling', '#F2E6A0', 30),
    ('Tyres',                    'Dekk',                      '#BCAAA4', 40),
    ('Warranty',                 'Garanti',                   '#9FC5E8', 50),
    ('PDI',                      'Nybilklargjøring',          '#E57EC8', 60),
    ('Internal',                 'Internt',                   '#B0BEC5', 70);

CREATE TABLE workshop_places (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id    bigint      NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    name       text        NOT NULL,
    sort       integer     NOT NULL DEFAULT 0,
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workshop_places_team_idx ON workshop_places (team_id) WHERE deleted_at IS NULL;

ALTER TABLE work_orders
    ADD COLUMN job_type_id bigint REFERENCES job_types (id),
    ADD COLUMN place_id    bigint REFERENCES workshop_places (id);
CREATE INDEX work_orders_place_idx ON work_orders (place_id, planned_at) WHERE place_id IS NOT NULL;

-- PDI work orders made so far get the PDI type.
UPDATE work_orders SET job_type_id = (SELECT id FROM job_types WHERE name = 'PDI')
 WHERE pdi_order_id IS NOT NULL AND job_type_id IS NULL;
