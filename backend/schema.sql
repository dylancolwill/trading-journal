CREATE TABLE IF NOT EXISTS tags (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6366f1',
  group_name TEXT DEFAULT '',
  group_color TEXT DEFAULT '',
  UNIQUE (name, group_name)
);

CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  account TEXT NOT NULL,
  instrument TEXT NOT NULL,
  contract TEXT DEFAULT '',          -- full contract e.g. "6E SEP26" for exact Databento lookup
  trade_date DATE NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  quantity INTEGER NOT NULL,
  entry_price NUMERIC(18,6) NOT NULL,
  exit_price NUMERIC(18,6),
  gross_pnl NUMERIC(18,2),
  commission NUMERIC(18,2) DEFAULT 0,
  net_pnl NUMERIC(18,2),
  description TEXT DEFAULT '',
  open BOOLEAN DEFAULT FALSE,
  entry_time TIMESTAMP,
  exit_time TIMESTAMP,
  source TEXT NOT NULL DEFAULT 'nt_import',  -- 'nt_import' (local time) | 'tradenote' (UTC)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fills (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER REFERENCES trades(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price NUMERIC(18,6) NOT NULL,
  fill_time TIMESTAMP NOT NULL,
  order_id TEXT,
  commission NUMERIC(18,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trade_tags (
  trade_id INTEGER REFERENCES trades(id) ON DELETE CASCADE,
  tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (trade_id, tag_id)
);

CREATE TABLE IF NOT EXISTS footprint_cache (
  trade_id INTEGER PRIMARY KEY REFERENCES trades(id) ON DELETE CASCADE,
  symbol TEXT,
  start_utc TIMESTAMP,
  end_utc TIMESTAMP,
  ticks JSONB NOT NULL,
  tick_count INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  cost NUMERIC(14,8) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Shared per-symbol downloaded ranges (so overlapping trade windows reuse data)
CREATE TABLE IF NOT EXISTS tick_ranges (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  start_ms BIGINT NOT NULL,
  end_ms BIGINT NOT NULL,
  records JSONB NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tick_ranges_symbol ON tick_ranges(symbol, start_ms);

CREATE TABLE IF NOT EXISTS candle_ranges (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  start_ms BIGINT NOT NULL,
  end_ms BIGINT NOT NULL,
  records JSONB NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_candle_ranges_symbol ON candle_ranges(symbol, start_ms);

CREATE TABLE IF NOT EXISTS candle_cache (
  trade_id INTEGER PRIMARY KEY REFERENCES trades(id) ON DELETE CASCADE,
  symbol TEXT,
  start_utc TIMESTAMP,
  end_utc TIMESTAMP,
  candles JSONB NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  cost NUMERIC(14,8) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chart levels imported per trading day + instrument (S/R lines, zones, trendlines).
CREATE TABLE IF NOT EXISTS day_levels (
  id SERIAL PRIMARY KEY,
  trade_date DATE NOT NULL,
  instrument TEXT NOT NULL,           -- base symbol, e.g. 'NQ'
  raw_text TEXT NOT NULL,
  levels JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (trade_date, instrument)
);

CREATE TABLE IF NOT EXISTS trade_images (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER REFERENCES trades(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
