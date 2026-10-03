CREATE TABLE IF NOT EXISTS trip_config (id INTEGER PRIMARY KEY CHECK (id=1), destination TEXT NOT NULL DEFAULT 'oulu');
INSERT OR IGNORE INTO trip_config(id,destination) VALUES(1,'oulu');

CREATE TABLE IF NOT EXISTS stops (
  id TEXT PRIMARY KEY,
  leg TEXT NOT NULL CHECK (leg IN ('out','back')),
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  nights INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'Friend',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_stops_leg_position ON stops(leg,position);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  leg TEXT NOT NULL CHECK (leg IN ('out','back')),
  stop_id TEXT,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  locality TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  proposed_by TEXT NOT NULL DEFAULT 'Friend',
  status TEXT NOT NULL DEFAULT 'suggested',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (stop_id) REFERENCES stops(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_leg ON activities(leg);

CREATE TABLE IF NOT EXISTS route_cache (cache_key TEXT PRIMARY KEY,data TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY,calls INTEGER NOT NULL DEFAULT 0);

INSERT OR IGNORE INTO stops(id,leg,name,lat,lon,nights,position,created_by) VALUES
('out-budapest','out','Budapest',47.4979,19.0402,1,0,'Starter route'),
('out-krakow','out','Kraków',50.0647,19.9450,2,1,'Starter route'),
('out-warsaw','out','Warsaw',52.2297,21.0122,1,2,'Starter route'),
('out-riga','out','Riga',56.9496,24.1052,1,3,'Starter route'),
('out-tallinn','out','Tallinn',59.4370,24.7536,1,4,'Starter route'),
('out-helsinki','out','Helsinki',60.1699,24.9384,1,5,'Starter route'),
('back-rovaniemi','back','Rovaniemi',66.5039,25.7294,1,0,'Starter route'),
('back-helsinki','back','Helsinki',60.1699,24.9384,1,1,'Starter route'),
('back-vilnius','back','Vilnius',54.6872,25.2797,1,2,'Starter route'),
('back-krakow','back','Kraków',50.0647,19.9450,1,3,'Starter route'),
('back-budapest','back','Budapest',47.4979,19.0402,1,4,'Starter route');

INSERT OR IGNORE INTO activities(id,leg,title,category,locality,description,source_url,proposed_by,status) VALUES
('idea-auschwitz','out','Auschwitz-Birkenau Memorial and Museum','museum','Kraków','A major historical memorial near Kraków. Reserve a visit and allow substantial time.','https://www.auschwitz.org/','Starter idea','suggested'),
('idea-wieliczka','out','Wieliczka Salt Mine','museum','Kraków','A historic underground mine close to Kraków.','https://www.kopalnia.pl/','Starter idea','suggested'),
('idea-riga','out','Riga Old Town','sightseeing','Riga','A walk through the historic centre before heading north.','','Starter idea','suggested'),
('idea-tallinn','out','Tallinn Old Town','sightseeing','Tallinn','Explore the medieval centre before the ferry to Finland.','','Starter idea','suggested'),
('idea-arktikum','back','Arktikum','museum','Rovaniemi','A museum and science centre focused on the Arctic.','https://www.arktikum.fi/','Starter idea','suggested'),
('idea-vilnius','back','Vilnius Old Town','sightseeing','Vilnius','A possible walking stop on the return.','','Starter idea','suggested');
