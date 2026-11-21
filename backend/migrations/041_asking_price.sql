-- Asking price per car (0.44.0): read from the car's finn.no ad by the helper (the ad the person is looking at),
-- or typed in. Used to compare the cars in stock with each other (same make / model; year and mileage shown).
ALTER TABLE vehicles
    ADD COLUMN asking_price integer CHECK (asking_price BETWEEN 0 AND 99999999),
    ADD COLUMN asking_price_at timestamptz,
    ADD COLUMN asking_price_source text CHECK (asking_price_source IN ('manual', 'finn'));
