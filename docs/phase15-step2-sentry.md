# Phase 15 Step 2 — Sentry integration

## What ships

- **Sentry bridge**: pino `error` and `fatal` events auto-capture to Sentry
  via a `logMethod` hook in `src/utils/logger.ts`. Existing call sites
  (`log.error({ err }, "msg")`) unchanged — the hook intercepts before
  output.
- **Per-component grouping**: the child logger's `component` binding is
  promoted to a Sentry tag, so errors group by subsystem (`faa-diff`,
  `archive`, `cross-validate`, etc).
- **Secret scrubbing**: `beforeSend` recursively redacts values whose
  keys match `/dsn|api[_-]?key|token|secret|password|auth/i`, and also
  matches against known env-var secret strings (`SUPABASE_DATABASE_URL`,
  `ANTHROPIC_API_KEY`, `MCP_AUTH_TOKEN`, `VAPI_SECRET`, `SENTRY_DSN`,
  `GITHUB_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`).
- **Uncaught exception + unhandled rejection handlers** in every
  long-running entry point (API, MCP stdio + SSE, opensky worker,
  adsb-feed worker). Flushes Sentry then exits.
- **Sentry MCP server** registered in `.mcp.json` so Claude Code can
  query production errors natively.

## Setup (one time)

1. **Get your DSN**: Sentry → Settings → Projects → your project →
   Client Keys (DSN). Copy the full URL.
2. **Add to `.env`**:
   ```
   SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>
   ```
   Without the DSN, every Sentry call is a no-op (local dev works).

## Verification

```
DATABASE_TYPE=postgres npx tsx src/ingestion/opensky-worker.ts --test-sentry
```

This emits one `log.error` event with component `sentry-test`, waits up
to 3 seconds for Sentry to flush, and exits cleanly. Then in the Sentry
dashboard you should see a new issue:

- Title: `Error: Phase 15 Step 2 test error`
- Tag `component: sentry-test`
- Extra `msg: test`
- Release: `0.1.0`

If nothing appears within a few minutes, verify the DSN is readable:
```
node -e 'console.log(process.env.SENTRY_DSN ? "set" : "UNSET")'
```

## MCP setup

First time you run `claude` in this repo after this commit, the Sentry
MCP OAuth flow will prompt you to authorize the Sentry MCP server. The
token is cached at `~/.sentry/mcp.json`. Subsequent runs use the cached
token automatically.

Test with prompts like:
- "What errors has production seen in the last 24 hours?"
- "Show me recent errors for component=opensky"
- "What's the stack trace of the latest fatal error?"

## What's captured vs not

| Level | Sent to Sentry? | Rationale |
|-------|-----------------|-----------|
| `fatal` (60) | yes | unrecoverable, always page |
| `error` (50) | yes | operation failed, intervention needed |
| `warn` (40) | **no** | noisy — retries, missing tars, rate limits |
| `info` (30) | no | row counts, completions — use PM2 logs |
| `debug` (20) | no | dev-only |
| `trace` (10) | no | dev-only |

Rationale: Sentry free tier allows 5,000 errors/month. Warnings from
worker retries (adsb.lol HTTP errors, OpenSky timeouts) would blow past
that in hours without adding signal.

If a warn *should* page, graduate it to `error`. If an error is too
noisy, demote it to `warn`.

## The auto-triage pattern (Phase 16 — after deploy)

Per Sentry's [Claude Code cookbook](https://docs.sentry.io/platforms/javascript/configuration/claude-code/),
the intended follow-on is a scheduled Claude Code task:

> Every morning, check Sentry for overnight errors. Run Seer on the top
> 3 most-impactful issues. Open a PR for each suggested fix. Cap at 2
> PRs per run.

We're **not** wiring this yet. Deferred until:
1. Dumont is deployed to Lightsail and generating real traffic.
2. We've seen at least a week of real production errors to calibrate
   what "most impactful" means for this service.
3. We have CI on the Lightsail branch so auto-PRs can actually be
   merged safely.

Cap of 2 PRs per run matches Sentry's recommendation to keep human
review sustainable.

## Free tier limits

- **5,000 errors/month** (hard cap; subsequent events dropped)
- **10,000 performance events/month** — we sample at `tracesSampleRate: 0.1`
- **30 days retention**

Upgrade signal: "at quota" email or Dumont dashboard shows an unusual
drop-off in captured issues mid-month. First upgrade tier (Team) is
$26/mo for 50K errors.

## Secret scrubbing rules

**Scrubbed by key pattern** (case-insensitive):
- Any key matching `/dsn|api[_-]?key|token|secret|password|auth/i`

**Scrubbed by value match**:
- `SUPABASE_DATABASE_URL`, `ANTHROPIC_API_KEY`, `MCP_AUTH_TOKEN`,
  `VAPI_SECRET`, `SENTRY_DSN`, `GITHUB_TOKEN`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`

**To extend**: edit the `SCRUB_VALUES` set or the `SCRUB_KEY_RE` regex
in `src/utils/sentry.ts`. Scrubbing runs on every event before send.

## Files touched

- `src/utils/sentry.ts` (new) — DSN gating, beforeSend scrubber,
  captureException / captureFatal / flushSentry wrappers
- `src/utils/logger.ts` — pino `logMethod` hook wired to Sentry bridge
- `src/server/index.ts`, `src/mcp/server.ts`, `src/mcp/server-sse.ts`,
  `src/ingestion/opensky-worker.ts`,
  `src/ingestion/adsblol-live-worker.ts`,
  `src/ingestion/pipeline.ts` — `initSentry()` + process handlers
  (pipeline is batch, no handlers)
- `src/ingestion/opensky-worker.ts` — `--test-sentry` CLI flag
- `tests/sentry.test.ts` (new) — 8 tests
- `tests/logger.test.ts` — 4 new bridge tests (8 total)
- `.mcp.json` (new) — Sentry MCP server registration
- `.env.example` — `SENTRY_DSN` + `LOG_LEVEL` placeholders

## Test plan (manual)

1. `npm run typecheck` — clean ✓
2. `npm test` — 671 pass (was 659, +12) ✓
3. Set `SENTRY_DSN` in `.env`
4. Run `npx tsx src/ingestion/opensky-worker.ts --test-sentry`
5. Check Sentry dashboard — issue should appear within ~30s
6. Start `claude` in this repo — OAuth prompt for Sentry MCP appears
7. Prompt Claude: "show me the recent errors from Dumont"
