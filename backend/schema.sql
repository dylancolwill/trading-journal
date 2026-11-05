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

-- Per-trade AI review output. These columns were added to the live DB by hand before they
-- were tracked here; the route code has always depended on them.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ai_analysis TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ai_score NUMERIC(4,1);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ai_entry_grade TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ai_entry_note TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ai_exit_grade TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ai_exit_note TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ai_direction_correct TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ai_direction_note TEXT;

-- Period performance reviews (the AI Analysis page). One row per generated report, kept as
-- history so periods can be compared rather than overwritten.
CREATE TABLE IF NOT EXISTS ai_reports (
  id SERIAL PRIMARY KEY,
  period_label TEXT NOT NULL,        -- 'Last 30 days', 'All time', ...
  period_days INTEGER,               -- NULL = all time
  from_date DATE,
  to_date DATE,
  trade_count INTEGER NOT NULL DEFAULT 0,
  instrument TEXT DEFAULT '',        -- '' = every instrument
  report TEXT NOT NULL,
  top_mistake TEXT,
  biggest_leak TEXT,
  first_fix TEXT,
  trend TEXT,
  stats JSONB NOT NULL DEFAULT '{}',
  model TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_reports_created ON ai_reports(created_at DESC);

-- Tick-exact execution metrics per trade (lib/execution.js). Persisted because the tick
-- cache evicts old ranges: once a trade's ticks are gone these can't be recomputed.
CREATE TABLE IF NOT EXISTS trade_execution (
  trade_id INTEGER PRIMARY KEY REFERENCES trades(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  covered BOOLEAN NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}',
  computed_at TIMESTAMPTZ DEFAULT NOW()
);

-- NY trading session each trade belongs to. A Sydney calendar date can hold two NY sessions
-- (a 01:00 and a 23:00 trade are different sessions), and one NY session can straddle two
-- Sydney dates, so session_date — not trade_date — is what levels and session stats key on.
-- Populated by lib/sessions.js (named-timezone conversion isn't IMMUTABLE, so no generated column).
ALTER TABLE trades ADD COLUMN IF NOT EXISTS session_date DATE;
CREATE INDEX IF NOT EXISTS idx_trades_session_date ON trades(session_date);

-- Imported levels belong to a NY session. trade_date is kept only to record the calendar day
-- the set was imported under.
ALTER TABLE day_levels ADD COLUMN IF NOT EXISTS session_date DATE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_day_levels_session ON day_levels(session_date, instrument);
-- Superseded by idx_day_levels_session: two sessions can be imported on one calendar date.
ALTER TABLE day_levels DROP CONSTRAINT IF EXISTS day_levels_trade_date_instrument_key;
