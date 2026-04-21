# Audit 05 — Code Principles (ln-623) — 2026-04-17

Scope: DRY, KISS, YAGNI, error handling, DI, best-practices guide
across `src/`. Karpathy principles in `CLAUDE.md` are treated as the
project's `principles.md`.

## Score: **7.5 / 10**

Codebase is deliberately simple per CLAUDE.md guidance — no abstract
classes, no DI container, no factory hierarchies. The real DRY hits
are concentrated in a few boilerplate shapes (Postgres client
construction, process-handler registration) where a small helper
would pay off quickly.

## Summary counts

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Moderate | 3 |
| Low | 4 |
| Informational | 2 |

## Findings

### F-05-1 — DRY 1.1: Raw `new pg.Client({ ssl: { rejectUnauthorized: false } })` duplicated 6×

**Severity:** MODERATE · **Pattern:** `dry_1.1` · **Effort:** S

Sites:
- `src/analytics/embeddings.ts:214`
- `src/ingestion/package-positions.ts:167`
- `src/memory/migrate-data.ts:356`
- `src/memory/pg-database.ts:32` (the legitimate one — shared pool)
- `src/ingestion/cross-validate.ts:139`
- `src/ingestion/pipeline.ts:110`

The shared helper `getPool()` / `getPgBridge()` already exists in
`pg-database.ts`. The 5 non-shared sites bypass it and wire their own
one-off clients with the same constructor options.

**Recommendation:** add a small helper `createStandaloneClient()` in
`pg-database.ts` that returns a new `pg.Client` with the standard SSL
options, so these scripts stop carrying the SSL config in their own
code. Saves ~6 duplicated lines and guarantees consistent TLS config
if we ever tighten it.

### F-05-2 — DRY 1.1: Process-handler registration duplicated 5×

**Severity:** MODERATE · **Pattern:** `dry_1.1` · **Effort:** S

Each long-running entry point registers the same pair:

```ts
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaught exception");
  void flushSentry().finally(() => setTimeout(() => process.exit(1), 200));
});
process.on("unhandledRejection", (reason) => {
  log.fatal({ err: reason }, "unhandled rejection");
  void flushSentry().finally(() => setTimeout(() => process.exit(1), 200));
});
```

Sites: `src/server/index.ts`, `src/mcp/server.ts`, `src/mcp/server-sse.ts`,
`src/ingestion/opensky-worker.ts`, `src/ingestion/adsblol-live-worker.ts`
(not in `pipeline.ts` since it's batch-mode).

**Recommendation:** extract to `src/utils/sentry.ts` as
`installProcessHandlers(component: string)` that takes the component
name, builds a child logger, and registers both handlers. Each entry
point goes from 10 lines → 1.

Flagged by Phase 15 Step 2 design but wasn't hoisted at the time. Do
it now before the pattern spreads.

### F-05-3 — DRY 1.5: SQL query shapes duplicated across stores

**Severity:** MODERATE · **Pattern:** `dry_1.5` · **Effort:** M

`src/memory/composite-stores.ts` implements several near-identical
SELECT + UPSERT shapes (deal, ledger, outcome). Each store writes its
own `INSERT ... ON CONFLICT DO UPDATE SET ...`. The shared
`bulkUpsert()` helper in `src/memory/bulk-upsert.ts` could absorb more
of this, but current stores build SQL by hand.

**Recommendation:** nice-to-have cleanup; defer. The specialty of each
store (which fields, which conflict key) is the actual variation, and
a bad abstraction here would be worse than the duplication.

### F-05-4 — DRY 1.7: `new S3Client({})` in 10 sites

**Severity:** LOW · **Pattern:** `dry_1.7` · **Effort:** S

Every call site constructs `new S3Client({})` with no options —
region, credentials, etc. come from env vars. Acceptable boilerplate,
but if we ever want to tune timeouts, retries, or endpoint overrides
globally, a single `getS3Client()` factory would simplify that.

**Recommendation:** defer; add the factory when we need the option to
vary config (e.g., if we start hitting retry limits).

### F-05-5 — Centralized error handler exists

**Severity:** — · **Location:** `src/server/middleware/error-tracker.ts`

Express 5 error middleware (`errorTracker`) is mounted last in the
chain, writes JSON to `errors.log` with rotation, logs via `log.error`
(which bridges to Sentry via Phase 15 Step 2), and returns
`{ error: "Internal server error" }` to the client — no stack trace
leaked. ✓

### F-05-6 — `asyncHandler` wrapper used in 5 route files

**Severity:** — · **Location:** `src/server/middleware.ts`

Routes in `intelligence.ts`, `analytics.ts`, `radar.ts`, `deals.ts`
use `asyncHandler` to catch rejected promises and forward to
errorTracker. Other routes (`chat.ts`, `vapi-llm.ts`,
`conversation.ts`, `health.ts`, `dashboard.ts`) don't need it —
they handle their own error paths inline.

No missing error handling on async routes spot-checked. ✓

### F-05-7 — No abstract classes in `src/`

**Severity:** — · **Location:** n/a

Zero `abstract class` declarations. The codebase favors plain
functions + typed data classes. KISS-friendly.

### F-05-8 — No DI container; direct imports used throughout

**Severity:** INFORMATIONAL · **Location:** codebase-wide

No `inversify` / `awilix` / `tsyringe`. Dependencies are imported
directly or returned from factory functions (`getDatabase`,
`getPgBridge`, `getDb`, `childLogger`). Tests inject mocks via vi.mock
or by constructing stores with explicit client params.

Explicitly endorsed by CLAUDE.md: "`getDatabase()` returns `DbBridge`
— SQLite or PgSyncBridge based on `DATABASE_TYPE`". Not a DI container
but same isolation benefit.

**Recommendation:** keep as-is. A DI framework would violate the
Karpathy simplicity principle and the tests prove this pattern
tests cleanly.

### F-05-9 — No `ARCHITECTURE.md` / `CONTRIBUTING.md`

**Severity:** LOW · **Effort:** S

`CLAUDE.md` (14 KB) serves as the partial replacement — it covers
architecture, deployment, patterns, and code conventions. For a solo
codebase that's probably sufficient.

**Recommendation:** keep CLAUDE.md as SSOT. When onboarding someone
else, split into `ARCHITECTURE.md` (stable architecture) +
`CONTRIBUTING.md` (PR checklist, test rules) — not today.

### F-05-10 — YAGNI scan

**Severity:** — · n/a

- No dead feature flags detected (grep for `if (FEATURE_` / `const
  FEATURE_` — no matches).
- Config options: all `process.env.*` reads in `src/utils/logger.ts`,
  `sentry.ts`, `server/index.ts`, `memory/pg-database.ts`. All used.
- No `interface` with exactly one implementation that's suspicious —
  interfaces in this codebase are data contracts (TraceFile,
  ParsedTrace, DealContext), not polymorphism hooks.

Single candidate: `QueryClient` interface in
`scripts/phase7-verify.ts:25-29` — exactly 1 impl (real pg.Client) at
runtime, but **legitimately** used for test mocking
(`tests/phase7-verify.test.ts` injects a fake implementation). Skip.

## Fix priority

1. **F-05-2** (process-handler dedup) — 5 entry points, tight, clear win. ~15 min.
2. **F-05-1** (pg.Client factory) — 5 sites. Introduce `createStandaloneClient()`. ~20 min.
3. **F-05-9** (architecture.md) — optional, do only on onboarding day.

## Karpathy-principle alignment

This codebase follows the principles in `CLAUDE.md` well:

- **Simplicity first**: no OOP hierarchies, no DI framework, routes
  are just functions
- **Surgical changes**: evident in recent commits (Phase 15, Phase 7)
- **Goal-driven**: tests correspond to features, schemas serve as
  source of truth

The DRY findings above are all tight, one-shot cleanups — none require
architectural rework.

<!-- FINDINGS-EXTENDED
{
  "findings": [
    {
      "id": "F-05-1",
      "severity": "moderate",
      "pattern_id": "dry_1.1",
      "pattern_signature": "pg_client_standalone_ssl_false",
      "sites": 5,
      "effort": "S"
    },
    {
      "id": "F-05-2",
      "severity": "moderate",
      "pattern_id": "dry_1.1",
      "pattern_signature": "process_uncaught_unhandled_sentry_flush",
      "sites": 5,
      "effort": "S"
    },
    {
      "id": "F-05-3",
      "severity": "moderate",
      "pattern_id": "dry_1.5",
      "pattern_signature": "composite_store_upsert_shape",
      "sites": 3,
      "effort": "M"
    },
    {
      "id": "F-05-4",
      "severity": "low",
      "pattern_id": "dry_1.7",
      "pattern_signature": "s3_client_empty_construct",
      "sites": 10,
      "effort": "S"
    }
  ]
}
-->
