-- Preserve existing stays while allowing future destination codes without another table rebuild.
CREATE TABLE accommodations_new (
  id TEXT PRIMARY KEY,
  leg TEXT NOT NULL CHECK (leg IN ('out','back','destination')),
  stop_id TEXT,
  destination_code TEXT,
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

INSERT INTO accommodations_new(id,leg,stop_id,destination_code,night_number,name,price_amount,currency,rating,rating_scale,review_count,review_source,review_note,booking_url,image_urls,proposed_by,created_at,updated_at)
SELECT id,leg,stop_id,destination_code,night_number,name,price_amount,currency,rating,rating_scale,review_count,review_source,review_note,booking_url,image_urls,proposed_by,created_at,updated_at FROM accommodations;

DROP TABLE accommodations;
ALTER TABLE accommodations_new RENAME TO accommodations;
CREATE INDEX idx_accommodations_night ON accommodations(leg,stop_id,night_number);
