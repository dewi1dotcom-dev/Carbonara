-- Deleting a car moves it to "Recently deleted" first; it is removed for good
-- (with photos) after TRASH_DAYS. Cars no longer here and without activity for
-- RETENTION_YEARS are deleted the same way automatically (reason 'retention').
ALTER TABLE vehicles
    ADD COLUMN deleted_at     timestamptz,
    ADD COLUMN deleted_by     bigint REFERENCES staff (id),
    ADD COLUMN deleted_reason text CHECK (deleted_reason IN ('manual', 'retention'));

CREATE INDEX vehicles_deleted_idx ON vehicles (deleted_at) WHERE deleted_at IS NOT NULL;
