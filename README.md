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
  area, London initial balance, TPO counts, and a compressed/expanded view toggle.
- **Imported levels** — paste your marked S/R lines, zones, and trendlines for a session; they
  render on the candlestick and footprint charts.
- **AI analysis** — a post-trade review grounded in the orderflow, market profile, and your own
  levels, written in Dalton's Auction Market Theory framework.
- **Tags, notes, screenshots, and a P&L dashboard.**

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
backend/     Express API — routes for trades, import, candles, footprint, tpo, levels, tags, images
  lib/       CSV parsing, trade grouping, shared market-data range cache
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

- Market data is fetched on demand and cached per symbol, so overlapping trade windows reuse
  what has already been downloaded rather than re-pulling it.
- Databento has roughly a one-day lag, so very recent trades may not have data yet.
- `images/` and `.env` are intentionally untracked.
