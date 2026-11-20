-- My notes (0.40.0): each person's own notes in the 📝 panel. Private: only the person who wrote a
-- note can see it (admins too). A note is a text and/or a pinned car or page, with an optional reminder
-- (a phone notification when it is due, app/push.py). Done notes are deleted after trash_days by the
-- worker; a deleted staff member's notes go with them; a car removed for good takes its notes along.
CREATE TABLE notes (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    staff_id     bigint      NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
    body         text        CHECK (char_length(body) <= 1000),
    vehicle_id   bigint      REFERENCES vehicles (id) ON DELETE CASCADE,  -- a pinned car
    link         text        CHECK (char_length(link) <= 300),            -- a pinned page ("#/…")
    link_title   text        CHECK (char_length(link_title) <= 120),
    remind_at    timestamptz,
    reminded_at  timestamptz,                                             -- the notification went out
    done_at      timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (body IS NOT NULL OR vehicle_id IS NOT NULL OR link IS NOT NULL)
);
CREATE INDEX notes_staff_idx ON notes (staff_id);
CREATE INDEX notes_reminder_idx ON notes (remind_at) WHERE reminded_at IS NULL AND done_at IS NULL;
