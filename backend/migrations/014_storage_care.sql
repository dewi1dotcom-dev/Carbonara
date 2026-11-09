-- Storage maintenance for new cars (MG "Technical requirements for storage
-- vehicles management", SI-GI2022102501): an arrival check, then periodic
-- checks every month (more every 3 and 6 months). Kept as evidence for
-- warranty cases (e.g. a failed 12V battery) and printed as a report.
CREATE TABLE storage_checks (
    id               bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id       bigint       NOT NULL REFERENCES vehicles (id),
    kind             text         NOT NULL CHECK (kind IN ('arrival', 'periodic')),
    level            text         CHECK (level IN ('monthly', 'quarterly', 'half_year')),  -- periodic only
    seq              integer,                         -- periodic: 1 = first month after arrival
    due_date         date,                            -- when this check was due
    performed_at     timestamptz  NOT NULL DEFAULT now(),
    performed_by     bigint       REFERENCES staff (id),
    items            jsonb        NOT NULL DEFAULT '[]',   -- [{key, label, result: ok|not_ok|na}]
    tyre_pressure    numeric(3,2) CHECK (tyre_pressure BETWEEN 0 AND 6),
    tyres_ok         boolean,
    v12_before       numeric(4,2) CHECK (v12_before BETWEEN 0 AND 20),
    v12_after        numeric(4,2) CHECK (v12_after BETWEEN 0 AND 20),
    battery_status   text         CHECK (battery_status IN ('good', 'good_recharge', 'charge_retest', 'replace')),
    battery_action   text         CHECK (battery_action IN ('none', 'charged', 'replaced')),
    battery_part_no  text,
    soc_percent      integer      CHECK (soc_percent BETWEEN 0 AND 100),
    soc_charged_to   integer      CHECK (soc_charged_to BETWEEN 0 AND 100),
    remarks          text,
    CHECK ((kind = 'periodic') = (level IS NOT NULL))
);
CREATE INDEX storage_checks_vehicle_idx ON storage_checks (vehicle_id, performed_at);
