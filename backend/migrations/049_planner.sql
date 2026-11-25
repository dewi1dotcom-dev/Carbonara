-- Planner (0.51.0): one calendar per team, a line per person with their work orders laid out over the day, and absences.
--
-- Lines: the team's members, plus people added to the planner, minus people taken off it (planner_rows; hidden = taken
-- off). Absences (holiday / away / course / other) are drawn on the person's line. "Away" is used instead of "sick" on
-- purpose: Carbonara stores no health information.

CREATE TABLE planner_rows (
    team_id  bigint  NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    staff_id bigint  NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
    sort     integer NOT NULL DEFAULT 0,
    hidden   boolean NOT NULL DEFAULT false,
    PRIMARY KEY (team_id, staff_id)
);

CREATE TABLE absences (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    staff_id   bigint      NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
    kind       text        NOT NULL CHECK (kind IN ('holiday', 'away', 'course', 'other')),
    starts_at  timestamptz NOT NULL,
    ends_at    timestamptz NOT NULL,
    note       text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by bigint      REFERENCES staff (id) ON DELETE SET NULL,
    CHECK (ends_at > starts_at)
);
CREATE INDEX absences_staff_idx ON absences (staff_id, starts_at);

-- The new top menu item: teams that see Work orders get the Planner.
UPDATE teams SET menu = array_append(menu, 'planner')
 WHERE 'work_orders' = ANY (menu) AND NOT 'planner' = ANY (menu);
