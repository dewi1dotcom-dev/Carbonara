-- Server settings a system admin can change on the System page (they override
-- the environment). Secrets (API key, mail password) are stored here too:
-- whoever can read the database can already read everything else.
CREATE TABLE app_settings (
    key         text        PRIMARY KEY,
    value       text        NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  bigint      REFERENCES staff (id)
);

-- System admin: can change system settings and give/remove system admin.
ALTER TABLE staff ADD COLUMN is_superadmin boolean NOT NULL DEFAULT false;

-- Existing installs: the first administrator (lowest id, with a PIN) becomes
-- system admin, so someone can always open the System page. New installs: the
-- person doing first-time setup becomes system admin.
-- (Edited after this ran on the first install, where the owner's account was
-- picked by name; it never matched anything on a new install.)
UPDATE staff SET is_superadmin = true
 WHERE NOT EXISTS (SELECT 1 FROM staff WHERE is_superadmin)
   AND id = (SELECT min(id) FROM staff WHERE is_admin AND active AND pin_hash IS NOT NULL);
