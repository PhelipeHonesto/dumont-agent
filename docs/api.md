# HTTP API

Express server on `:3001` (prod: `api.orangesunshineaviation.com`).
Source: `src/server/`.

## Cross-cutting

- **CORS**: production allows `orangesunshineaviation.com` + `www` + `api` subdomains; `http://localhost:*` in dev. `ALLOWED_ORIGINS` env overrides.
- **Rate limits**: 100 req/min global; 10 req/min on analytics/routes/market endpoints; health endpoints exempt.
- **Input sanitization**: `src/server/middleware/sanitize.ts` — tail numbers (`N` + 1-5 alphanum), ICAO codes (4 letters), month/date formats, SQL injection patterns blocked, string length limits.
- **Error tracking**: every 500 captured to `errors.log` (1MB rotation) and bridged to Sentry via `log.error`.

## Intelligence routes (no auth)

`src/server/routes/intelligence.ts`

| Path | Purpose |
|------|---------|
| `GET /api/aircraft/:tailNumber` | Full aircraft profile — registration, ADS-B, liens, pilots, ghost status |
| `GET /api/aircraft/:tailNumber/flights` | Flight history with origin, destination, times |
| `GET /api/airport/:icao/ghosts` | Ghost candidates near airport |
| `GET /api/fleet/stats` | Fleet summary — tracked, airborne, idle, ghost count |
| `GET /api/routes/:origin/:destination` | Route analytics — frequency, class mix, monthly trend |
| `GET /api/market/listings` | Active for-sale listings |
| `GET /api/market/transactions` | Recent FAA ownership changes |
| `GET /api/health/data` | Data freshness traffic light |
| `GET /api/health/feed` | ADS-B feed liveness |
| `GET /api/health/quality` | Latest data quality report (7 checks) |
| `GET /api/health/errors` | Last 20 errors from `errors.log` |

## Analytics routes (no auth, rate-limited)

`src/server/routes/analytics.ts`

| Path | Purpose |
|------|---------|
| `GET /api/analytics/market?month=` | Top operators, fleet size, activity, class mix |
| `GET /api/analytics/operator/:name?months=` | Operator deep dive — utilization, routes, trend |
| `GET /api/analytics/airport/:icao?date=` | Hourly activity, peak hours, top operators |
| `GET /api/analytics/route/:origin/:dest?months=` | Monthly route trend with YoY |
| `GET /api/analytics/fleet?class=` | Fleet health — utilization rates, registrations |
| `GET /api/analytics/top-routes?month=&limit=` | Busiest routes ranked |
| `GET /api/analytics/top-operators?month=&limit=` | Most active operators ranked |
| `GET /api/analytics/fuel/:origin/:dest/:class` | Estimated fuel cost for route |

## Auth-required routes

| Path | Purpose |
|------|---------|
| `POST /chat/completions` | Vapi voice AI webhook (shared secret via `VAPI_SECRET`) |
| `POST /api/dumont/respond` | REST conversation endpoint |
| `POST /api/chat` | Dumont AI co-pilot SSE streaming |
| `GET /api/deals` | Deal management |

## System / health

| Path | Purpose |
|------|---------|
| `GET /health` | Cheap liveness — always 200 if event loop alive |
| `GET /ready` | PG readiness — `SELECT 1` with 2s timeout, 503 on failure |
| `GET /dashboard` | Operational dashboard (HTML, calls the intelligence/health routes above) |
