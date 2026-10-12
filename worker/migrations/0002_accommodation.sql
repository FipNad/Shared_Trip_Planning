ALTER TABLE trip_config ADD COLUMN destination_nights INTEGER NOT NULL DEFAULT 3;

CREATE TABLE IF NOT EXISTS accommodations (
  id TEXT PRIMARY KEY,
  leg TEXT NOT NULL CHECK (leg IN ('out','back','destination')),
  stop_id TEXT,
  destination_code TEXT CHECK (destination_code IS NULL OR destination_code IN ('oulu','levi')),
  night_number INTEGER NOT NULL CHECK (night_number BETWEEN 1 AND 30),
  name TEXT NOT NULL,
  price_amount REAL NOT NULL CHECK (price_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR',
  rating REAL,
  rating_scale INTEGER NOT NULL DEFAULT 10 CHECK (rating_scale IN (5,10)),
  review_count INTEGER,
  review_source TEXT NOT NULL DEFAULT '',
  review_note TEXT NOT NULL DEFAULT '',
  booking_url TEXT NOT NULL DEFAULT '',
  image_urls TEXT NOT NULL DEFAULT '[]',
  proposed_by TEXT NOT NULL DEFAULT 'Friend',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (stop_id) REFERENCES stops(id) ON DELETE CASCADE,
  CHECK ((leg='destination' AND stop_id IS NULL AND destination_code IS NOT NULL) OR (leg IN ('out','back') AND stop_id IS NOT NULL AND destination_code IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_accommodations_night ON accommodations(leg,stop_id,night_number);
