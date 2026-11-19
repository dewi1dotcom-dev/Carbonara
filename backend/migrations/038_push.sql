-- Phone / PC notifications (Web Push, app/push.py).
--
-- push_subscriptions: one row per browser that turned notifications on. It belongs to the login session
-- it was made in, so logging out, a PIN reset (all devices logged out) or an expired session removes it
-- (ON DELETE CASCADE): a device nobody is logged in on never gets notifications. The endpoint is the
-- browser's push address (Google / Apple / Mozilla); p256dh + auth encrypt the content for that browser.
CREATE TABLE push_subscriptions (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    staff_id      bigint      NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
    session_hash  text        NOT NULL REFERENCES sessions (token_hash) ON DELETE CASCADE,
    endpoint      text        NOT NULL UNIQUE,
    p256dh        text        NOT NULL,
    auth          text        NOT NULL,
    user_agent    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_sent_at  timestamptz
);
CREATE INDEX push_subscriptions_staff_idx ON push_subscriptions (staff_id);

-- Which kinds of notifications each person wants ({"dm": false, ...}); a missing key = on.
ALTER TABLE staff ADD COLUMN push_prefs jsonb NOT NULL DEFAULT '{}';

-- Notifications waiting to be sent. Written in the same transaction as the change they are about (so a
-- failed request sends nothing) and sent within seconds by the app's push thread. Only the short text
-- shown on the phone, never customer data.
CREATE TABLE push_outbox (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    staff_id    bigint      NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
    payload     jsonb       NOT NULL,
    urgency     text        NOT NULL DEFAULT 'normal',
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Scheduled notifications already sent (e.g. 'daily_due:2026-11-20', 'rental_late:12'), so each goes out
-- once. Rows older than 30 days are deleted.
CREATE TABLE push_sent (
    key      text        PRIMARY KEY,
    sent_at  timestamptz NOT NULL DEFAULT now()
);
