-- Storage maintenance for used cars: the 12V battery is charged every month
-- while the car is in storage. One row per charge; a charge registered by
-- mistake is cancelled (not deleted) by an admin, like storage checks.
CREATE TABLE battery_charges (
    id           bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id   bigint       NOT NULL REFERENCES vehicles (id),
    charged_at   timestamptz  NOT NULL DEFAULT now(),
    charged_by   bigint       REFERENCES staff (id),
    v12_before   numeric(4,2) CHECK (v12_before BETWEEN 0 AND 20),
    v12_after    numeric(4,2) CHECK (v12_after BETWEEN 0 AND 20),
    note         text,
    voided_at    timestamptz,
    voided_by    bigint       REFERENCES staff (id),
    void_reason  text,
    CONSTRAINT battery_charges_void_reason CHECK (voided_at IS NULL OR length(trim(void_reason)) > 0)
);
CREATE INDEX battery_charges_vehicle_idx ON battery_charges (vehicle_id, charged_at);
