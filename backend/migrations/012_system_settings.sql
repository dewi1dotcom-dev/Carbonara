-- Server settings a super-admin can change on the System page (they override
-- the environment). Secrets (API key, mail password) are stored here too:
-- whoever can read the database can already read everything else.
CREATE TABLE app_settings (
    key         text        PRIMARY KEY,
    value       text        NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  bigint      REFERENCES staff (id)
);

-- Super-admin: can change system settings and give/remove super-admin.
ALTER TABLE staff ADD COLUMN is_superadmin boolean NOT NULL DEFAULT false;

-- Moss AutoCenter's install: the owner's account "Supern" becomes super-admin
-- (and admin). If there is no such account, the first administrator (lowest id,
-- with a PIN) does, so someone can always open the System page. New installs:
-- the person doing first-time setup becomes super-admin.
UPDATE staff SET is_superadmin = true, is_admin = true
 WHERE active AND pin_hash IS NOT NULL AND name = 'Supern';
UPDATE staff SET is_superadmin = true
 WHERE NOT EXISTS (SELECT 1 FROM staff WHERE is_superadmin)
   AND id = (SELECT min(id) FROM staff WHERE is_admin AND active AND pin_hash IS NOT NULL);
