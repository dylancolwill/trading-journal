# Trading Journal

A personal futures trading journal built around orderflow and Auction Market Theory. Imports
NinjaTrader fills, pulls tick and candle data from Databento, and renders the charts needed to
review a trade — candlesticks, a bid/ask footprint with imbalances, and a TPO market profile —
plus an AI post-trade analysis.

## Features

- **CSV import** — parses NinjaTrader executions and groups fills into round-trip trades.
- **Candlestick chart** — 1m/2m/5m/15m, with entry/exit markers.
- **Footprint chart** — bid × ask per price level, stacked diagonal imbalances, CVD panel, and a
  tick-by-tick replay mode.
- **TPO / market profile** — Globex-session profile built up to the trade entry, with POC, value
  area, the RTH initial balance (09:30–10:30 ET), TPO counts, and a compressed/expanded view
  toggle. The previous session's profile can be overlaid on the same price grid, with a
  value-area shift readout.
- **Imported levels** — paste your marked S/R lines, zones (one or two anchors), and trendlines
  for a session; they render on the candlestick and footprint charts, and export back out as
  text or CSV. Levels drawn on a full-size contract apply to its micro (ES → MES).
- **Measured execution** — for every trade, tick-exact facts about what price actually did:
  normal 1-minute noise, stop size against that noise, 5/15-minute excursions, heat taken before
  the peak, and whether the directional read was right (decided at 2× noise). Captured while the
  ticks are cached and stored, since the cache evicts old ranges.
- **AI analysis** — a per-trade review grounded in the orderflow, market profile, your levels and
  the measured outcome, plus a period review page: reads-right rate, winner capture, stops vs
  noise, a stop × target what-if heatmap, and breakdowns by time from the open, side, tag,
  half-hour ET, weekday and instrument.
- **Tags, notes, screenshots, and a P&L dashboard** with daily and weekly totals.

## Stack

| Layer    | Tech                                            |
| -------- | ----------------------------------------------- |
| Frontend | React 18 + Vite (no UI framework, inline styles) |
| Backend  | Node + Express                                   |
| Database | PostgreSQL                                       |
| Market data | Databento (GLBX.MDP3)                         |
| AI       | Claude (via the `claude` CLI)                    |

## Layout

```
backend/     Express API — routes for trades, import, candles, footprint, tpo, levels, insights,
             tags, images
  lib/       CSV parsing and trade grouping, level parse/format, symbol families, the shared
             market-data range cache, execution metrics, insight aggregation, NY-session helpers
  schema.sql tables (created automatically on boot)
frontend/    React app — one page per view under src/pages
migration/   one-off data migration script
images/      uploaded trade screenshots (not tracked)
```

## Setup

Requires Node 20+ and PostgreSQL.

```bash
# 1. database
createdb journal    # schema.sql is applied automatically on first boot

# 2. backend
cd backend
npm install
cp .env.example .env   # then fill in the values below
npm start              # serves the API on :8090 (and frontend/dist if built)

# 3. frontend
cd frontend
npm install
npm run dev            # dev server, proxies /api to :8090
npm run build          # production build into frontend/dist
```

### Environment (`backend/.env`)

| Variable             | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `DATABENTO_API_KEY`  | Databento historical API key (ticks + candles)     |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASS` / `DB_NAME` | Postgres connection      |
| `PORT`               | API port (default `8090`)                          |
| `TRADE_TZ`           | Timezone the imported fill times are in (default `Australia/Sydney`) |
| `CLAUDE_PATH`        | Path to the `claude` CLI used for AI analysis      |

## Notes

- Trades and levels are keyed to the **NY session**, not the local calendar date. Globex rolls at
  18:00 ET, so one local date routinely holds two sessions — an evening trade belongs to the next
  one. Anything grouped "by day" groups by session, and a day spanning two sessions gets a levels
  set per session.
- Market data is fetched on demand and cached per symbol, so overlapping trade windows reuse
  what has already been downloaded rather than re-pulling it. The caches are size-capped and
  evict the oldest ranges, so an old trade's ticks eventually go away — anything derived from
  them is computed and stored while they are still there.
- Databento has roughly a one-day lag, so very recent trades may not have data yet.
- `images/` and `.env` are intentionally untracked.
