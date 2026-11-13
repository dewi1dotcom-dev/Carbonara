-- Which wheels are on the car now: summer or winter (NULL = not recorded).
-- Used for the studded tyre season warnings (common.tyre_warning): summer wheels
-- turn amber a month before the season and red once it has started; winter
-- wheels after the season only get a quiet notice.
ALTER TABLE vehicles    ADD COLUMN wheels text CHECK (wheels IN ('summer', 'winter'));
ALTER TABLE rental_cars ADD COLUMN wheels text CHECK (wheels IN ('summer', 'winter'));
