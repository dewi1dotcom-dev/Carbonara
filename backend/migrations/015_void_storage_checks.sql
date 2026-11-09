-- A storage check registered by mistake (or as a test) can be cancelled by an
-- admin with a reason. It no longer counts in the schedule but stays in the
-- report, struck through, so the record stays honest.
ALTER TABLE storage_checks
    ADD COLUMN voided_at    timestamptz,
    ADD COLUMN voided_by    bigint REFERENCES staff (id),
    ADD COLUMN void_reason  text,
    ADD CONSTRAINT storage_checks_void_reason CHECK (voided_at IS NULL OR length(trim(void_reason)) > 0);
