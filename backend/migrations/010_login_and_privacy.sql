-- Personal PIN login for staff, sessions, an access log for test drive
-- customer data, and "customer was informed" on test drives (GDPR art. 13).

ALTER TABLE staff
    ADD COLUMN pin_hash          text,               -- scrypt; NULL = can't log in yet
    ADD COLUMN is_admin          boolean     NOT NULL DEFAULT false,
    ADD COLUMN pin_failures      integer     NOT NULL DEFAULT 0,
    ADD COLUMN pin_locked_until  timestamptz,
    ADD COLUMN last_login_at     timestamptz;

-- One row per logged-in device. Only a hash of the cookie token is stored.
CREATE TABLE sessions (
    token_hash    text        PRIMARY KEY,
    staff_id      bigint      NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    user_agent    text
);
CREATE INDEX sessions_staff_idx ON sessions (staff_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Who opened a licence photo or deleted customer details (no customer data here).
CREATE TABLE test_drive_access_log (
    id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    test_drive_id  bigint      NOT NULL REFERENCES test_drives (id) ON DELETE CASCADE,
    staff_id       bigint      REFERENCES staff (id),
    action         text        NOT NULL CHECK (action IN ('license_viewed', 'customer_deleted')),
    at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX test_drive_access_log_drive_idx ON test_drive_access_log (test_drive_id, at DESC);

-- Staff confirm the customer got the privacy notice. Earlier drives: unknown (false).
ALTER TABLE test_drives ADD COLUMN customer_informed boolean NOT NULL DEFAULT false;
