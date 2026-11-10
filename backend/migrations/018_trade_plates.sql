-- Trade plates (prøvekjennemerker) used on test drives. Staff give each set a
-- name of their own (it can be renamed, e.g. when a plate is replaced).
-- A set can only be on one car at a time: it belongs to the test drive it was
-- handed out with, until that car is returned or the plates are moved to
-- another car (plate_moved_at / plate_moved_to on the old drive).
CREATE TABLE trade_plates (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
    active      boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX trade_plates_name_active ON trade_plates (lower(btrim(name))) WHERE active;

ALTER TABLE test_drives
    ADD COLUMN trade_plate_id bigint      REFERENCES trade_plates (id),
    ADD COLUMN plate_moved_at timestamptz,
    ADD COLUMN plate_moved_to bigint      REFERENCES test_drives (id) ON DELETE SET NULL;

-- The same plates can't be on two cars at the same time.
CREATE UNIQUE INDEX test_drives_one_plate ON test_drives (trade_plate_id)
    WHERE status = 'out' AND trade_plate_id IS NOT NULL AND plate_moved_at IS NULL;
