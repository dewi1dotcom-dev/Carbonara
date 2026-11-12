-- Teams: every user is in (at most) one team; the team decides which top menu
-- items they see (system admins see everything). Managed on the System page.
-- `menu` holds the menu keys (auth.MENU_ITEMS); Today is always available.
-- A user without a team sees only Today.
CREATE TABLE teams (
    id          bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text         NOT NULL,
    menu        text[]       NOT NULL DEFAULT '{}',
    created_at  timestamptz  NOT NULL DEFAULT now(),
    created_by  bigint       REFERENCES staff (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX teams_name_idx ON teams (lower(name));

ALTER TABLE staff ADD COLUMN team_id bigint REFERENCES teams (id) ON DELETE SET NULL;

-- Existing staff keep the full menu they had, until a system admin changes it.
WITH t AS (
    INSERT INTO teams (name, menu)
    VALUES ('All staff', ARRAY['arrivals', 'vehicles', 'storage', 'testdrive', 'deliveries', 'settings'])
    RETURNING id
)
UPDATE staff SET team_id = (SELECT id FROM t) WHERE deleted_at IS NULL;
