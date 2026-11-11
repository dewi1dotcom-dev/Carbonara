-- Each staff member chooses a light or dark theme, or follows the device
-- ('auto', which is how Carbonara has looked so far).
ALTER TABLE staff ADD COLUMN theme text NOT NULL DEFAULT 'auto' CHECK (theme IN ('auto', 'light', 'dark'));
