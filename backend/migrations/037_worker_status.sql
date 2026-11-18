-- The background worker reports in here (app/workerstatus.py), so the System page and Today can warn
-- system admins when it has stopped or a step keeps failing. One row per kind:
--   'loop'          every round (about once a minute): private message expiry + registry sync
--   'housekeeping'  the daily cleanup (retention, GDPR deletions, rental car refresh)
-- `detail` holds only step names and error types, never personal data.
CREATE TABLE worker_status (
    name    text         PRIMARY KEY,
    at      timestamptz  NOT NULL DEFAULT now(),
    ok      boolean      NOT NULL DEFAULT true,
    detail  text
);
