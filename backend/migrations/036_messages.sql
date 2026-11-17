-- Message board on the Today page: short notes shown with the writer's initials, for 24 hours.
-- team_id = the team that sees it; NULL = everyone (only admins post to everyone).
-- Expired rows are deleted (on the next read, and by the worker).
CREATE TABLE messages (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 300),
    team_id    bigint REFERENCES teams (id) ON DELETE CASCADE,
    created_by bigint REFERENCES staff (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_created_at ON messages (created_at);

-- Private messages between two users, with an optional file or image (stored under PHOTO_DIR).
-- expires_at = 72 working hours after sending (Monday–Friday only, weekends don't count); the worker
-- deletes the row and its file then. Only the sender and the recipient can read a message.
CREATE TABLE private_messages (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sender_id     bigint NOT NULL REFERENCES staff (id),
    recipient_id  bigint NOT NULL REFERENCES staff (id),
    body          text CHECK (body IS NULL OR length(body) BETWEEN 1 AND 2000),
    file_key      text,
    original_ext  text,
    original_name text,
    mime_type     text,
    size_bytes    integer,
    is_image      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    read_at       timestamptz,
    CHECK (body IS NOT NULL OR file_key IS NOT NULL),
    CHECK (sender_id <> recipient_id)
);
CREATE INDEX private_messages_pair ON private_messages (sender_id, recipient_id, created_at);
CREATE INDEX private_messages_unread ON private_messages (recipient_id) WHERE read_at IS NULL;
CREATE INDEX private_messages_expires ON private_messages (expires_at);
