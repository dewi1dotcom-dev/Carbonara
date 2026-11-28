-- Notifications wait for the person's work period (0.62.0, the user's rule: "not have notifications before workers
-- are in their work period"). A notification queued outside it is kept until the period starts. The period itself
-- is stored in staff.push_prefs ("work_from" / "work_until"; missing = the working day on the System page).
ALTER TABLE push_outbox ADD COLUMN send_after timestamptz;

CREATE INDEX push_outbox_send_after ON push_outbox (send_after);
