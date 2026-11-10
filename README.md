# Market Paper Terminal

An all-category Polymarket paper-trading dashboard. It never creates real orders, connects wallets, or handles private keys. The UI is served by the authenticated Node server with relative URLs.

## Run and deploy

Use Node 20 or newer:

```sh
npm install
copy .env.example .env
npm run build
npm start
```

Development uses `npm run dev`. The server listens on `PORT` (default `3001`) and serves the built client from the same port. Every page, API route, SSE stream, and CSV download uses dashboard Basic Auth. `/api/bot/*` uses `Authorization: Bearer BOT_API_KEY` instead.

When running on a server that can reach Polymarket, run `npm run probe`. It fetches one Gamma page and prints the HTTP status, real field names, and one sample. The laptop does not need upstream access.

## Environment

`PORT`, `DATA_DIR`, `DASH_USER`, and `DASH_PASSWORD` configure the server. `DASH_PASSWORD`, `GEMINI_API_KEY`, and `BOT_API_KEY` may alternatively use `DASH_PASSWORD_FILE`, `GEMINI_API_KEY_FILE`, and `BOT_API_KEY_FILE`; file contents are trimmed. Production refuses to start without `DASH_PASSWORD`.

AI settings include `AI_ENABLED`, `GEMINI_MODEL` (required for a run; copy the current model id from Google AI Studio), `AI_RUN_UTC_HOUR`, `AI_MAX_CALLS_PER_DAY`, `MAX_BETS_PER_RUN`, `MAX_PER_CATEGORY`, `MAX_PER_EVENT`, `BET_USD`, `MIN_EDGE`, `DAILY_PROFIT_LOCK`, and `DAILY_LOSS_LIMIT`. `AI_USE_SEARCH` is intentionally off by default in this paper implementation. Trading settings are `FEE_RATE`, `FEE_RATE_OVERRIDES` as JSON by category, and `SLIPPAGE_BPS`. Verify fee assumptions against `docs.polymarket.com/trading/fees` before using paper results for decisions.

## What works

- Gamma paging/parser, category mapping, filtering, sorting, stale-data reporting, CLOB detail lookup, and the server-side refresh boundary.
- Three persistent paper accounts (`manual`, `ai`, `bot`), atomic queued state saves, fee/slippage-aware book walking, buy/sell routes, reconciliation, CSV export, and account-update SSE events.
- Exact-result settlement rules: closed binary 1/0, equal-price SPLIT, and PENDING_RESOLUTION for ambiguous results. Startup runtime loops schedule settlement every five minutes and mark-to-market every ten minutes with a ten-book-call cap.
- AI scan, one Gemini request per run, persisted UTC-day call cap, 429 stop, deterministic selection caps/locks, pause/resume/run-now routes, daily scheduler catch-up, and Brier calculation for stored shadow candidates.
- Responsive Markets, AI Picks, and Accounts screens with category chips, search/sort, market drawer/order-book display, paper buy form, controls, positions, reset, CSV, SSE reconnect polling, loading and empty states.
- Offline test suite covering tolerant parsing, filters, category/cap logic, fees/slippage, book depth, settlement states, reconciliation, Brier, fenced/invalid AI JSON, persisted AI caps and 429, auth/rate limiting, bot auth, CSV route, and 20 concurrent saves.

## What is partial

- The browser dashboard does not yet render a dedicated sell form inside the position rows; the sell API is complete and can be called by the bot/client.
- Gemini 5xx retry/backoff, Google Search grounding, full resolution-source display, and automated shadow-candidate resolution polling are not fully implemented. AI candidates are persisted and scored, but their resolution lifecycle needs a dedicated resolver integration.
- Fill delay is represented by paper-only synchronous fills rather than a delayed injected-clock queue. Circuit-breaker statistics and daily realized-PnL accounting need further hardening for production use.
- Gamma refresh is exposed and the scheduled loops are present, but refresh itself is not yet automatically scheduled every three minutes.

## Server checklist

1. Configure a dashboard password and, if needed, secret files; never commit `.env` or the data directory.
2. Run `npm run probe` and inspect the output for upstream field changes.
3. Run `npm run build && npm test`, start the server, authenticate in the browser, refresh markets, open a binary market, place a small paper buy, sell it through the API, and download CSV.
4. Test the bot with the Bearer key, verify Basic Auth returns 401 without credentials, verify repeated failures return 429, and confirm no secret appears in logs, API JSON, or browser state.
5. Use a disposable `DATA_DIR` to test restart persistence, pending resolution, exact settlement/SPLIT, AI pause/resume, daily call caps, and the five-/ten-minute runtime jobs.

Paper fills are estimates based on observed books. They are not forecasts of execution, liquidity, resolution, fees, or profit in real markets.
