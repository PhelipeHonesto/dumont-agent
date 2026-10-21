# OSA Dumont Agent

AI-powered charter brokerage orchestrator for Orange Sunshine Aviation (OSA).
Named after Santos-Dumont, the Brazilian aviation pioneer. Dumont takes a
charter request and coordinates a pipeline of specialized agents — Intake,
Sourcing, Quote, Scenario, Guardian — with a learning loop that sharpens on
every closed deal. Powers OSA Connect. Voice via Vapi. Exposed to Claude
clients over MCP (stdio locally, SSE at `api.orangesunshineaviation.com/sse`).

## The agent architecture

Single orchestrator with five callable capabilities. Not five independent
agents passing batons — one Pilot-in-Command (`src/orchestrator/`) that
decides what runs next. Guardian runs **after every stage** as a hard gate,
not a suggestion, inspired by EGPWS.

| Capability | File | Role |
|------------|------|------|
| **Intake** | `src/capabilities/intake.ts` | Parse raw requests (text/email/SMS), resolve airports, qualify client, detect repeats |
| **Sourcing** | `src/capabilities/sourcing.ts` | 5-factor operator selection: fit, reliability, price, availability, **Ghost Positioning** (aircraft already near departure) |
| **Quote** | `src/capabilities/quote.ts` | Physics-first validation (runway, range, time-of-day, weight) + Aviapages price calc + learning-loop correction |
| **Scenario** | `src/capabilities/scenario.ts` | Present one primary + one backup option with substitution preferences |
| **Guardian** | `src/capabilities/guardian.ts` | 5-pass validation between every stage. Blocks on criticals, warns on soft flags |

Deal flow:
`INTAKE → GUARDIAN → ESTIMATE → GUARDIAN → SOURCE → GUARDIAN → QUOTE → GUARDIAN → [AWAITING_REVIEW] → PRESENT → GUARDIAN → CLOSE → LEARN`

Business rules:
- **One quote, one operator, one deal** — never blast RFQs.
- **8–10% margins**; operators paid before departure (fast-pay as moat).
- **Learning loop** — every closed deal updates `route_intel`, `operator_profiles`, `client_profiles`.

SPARC specs: `specs/orchestrator.md`, `specs/capabilities/*.md`, `specs/learning-loop.md`.

## Data foundation

Supports agent decisions — not the product. PostgreSQL on Supabase is the
primary backend; SQLite at `data/dumont.db` is local-dev-only legacy.

- **FAA registry** — aircraft, operators, airports, deregistered, pilot records, document index (liens).
- **ADS-B intelligence** — live positions (hot tier, 48 h TTL), completed legs (cold), raw tars in S3 Glacier (2023–present).
- **Knowledge graph** — joined FAA + ADS-B view with safety scores, ghost candidates.
- **NTSB accidents** — 80k+ records, 1962–present.
- **Market signals** — for-sale listings + FAA ownership-change diffs.

Schema SSOT: `src/memory/schema/` (layered per Schema Evolution Rule 1 — `_extensions.sql`, `silver/`, `gold/`, `transactional/`, `analytics/`, `migrations/`). Details in `docs/schema.md`. Target architecture: `docs/data-architecture.md`.

## Deployment

Two hosts. Every long-running op targets one or the other.

- **Mac** — local dev, editor, tests. Mac `data/` is post-Phase-6 cruft; not a source of truth.
- **AWS Lightsail** (`44.197.126.96`) — production. Caddy + Let's Encrypt front `api.orangesunshineaviation.com`. PM2 runs `api`, `feed`, `mcp`. Nightly cron: archive, DB backup, pipeline.
- **Vapi** — voice interface; webhook hits `/chat/completions` on Lightsail.
- **Railway** — `railway.toml` present; may still host a Vapi webhook relay (verify current role before changes).
- **S3** (`osa-dumont-backup`) — daily DB backups + raw ADS-B / FAA archives (Glacier).
- **MCP** — stdio for Claude Desktop; SSE at `api.orangesunshineaviation.com/sse` for Claude Code.

Ops detail: `docs/operations.md`.

## Key contracts

- **Logging** (Phase 15). Use `childLogger("<component>")` from `src/utils/logger.ts`, not `console.*`, in production paths. CLI summary tables + progress counters stay `console.log`. Writes to **stderr** (MCP stdio owns stdout). `log.error` / `log.fatal` auto-bridge to Sentry — don't use them for expected events.
- **Process handlers**. Every long-running entry point calls `installProcessHandlers("<component>")` from `src/utils/sentry.ts`. Registers `uncaughtException` + `unhandledRejection` → flush Sentry → exit.
- **Health**. `/health` = cheap liveness. `/ready` = PG `SELECT 1` with 2 s timeout (503 on failure). PM2 / LBs point at `/ready`.
- **Money in integer cents.** Never floats.
- **Dates as ISO strings.** `NOW()` in PG, `datetime('now')` in SQLite.
- **Zod** at runtime boundaries; `src/schemas/` is SSOT.
- **`deal_events` append-only** — no UPDATE, no DELETE.
- **`getDatabase()`** returns a `DbBridge` (PG or SQLite per `DATABASE_TYPE`). All calls `await`.
- **Commit style**: one commit per finding or phase, finding ID in the message (e.g. `F-02-1`), typecheck + tests green before push.

## Known issues

See `docs/known-issues.md` for standing data flags.
`adsb_completed_legs` was rebuilt 2026-04-23 (see `docs/phase7-completion.md`); 17 permanent S3 gaps and 7 deferred reingests remain (see `docs/known-issues.md`).

Other standing caveats: pilot-aircraft links are proximity heuristics (not FAA-authoritative); aircraft classification is pattern-matched on `common_name`; NTSB `airport_code` uses FAA codes (strip K prefix when joining ICAO).

## Common pitfalls (from past sessions)

Before starting new work, skim `.claude/lessons.md` for past pitfalls specific to this codebase. The entries below are the stable rules; `lessons.md` is the appendable record of *why* each rule exists.

- **Mac vs Lightsail**: confirm host before any "rebuild / archive / pipeline" command. Rebuilds run on Lightsail; the Mac is dev-only.
- **Supabase password must be alphanumeric.** Special chars (`!`, `@`, `/`) break shell escaping and URL parsing in `SUPABASE_DATABASE_URL`.
- **`tmux`** is mandatory for jobs > 30 min. Bare terminal = lose the job if SSH drops.
- **`caffeinate -dims`** is Mac-only (no-op on Linux). Use it when running long jobs locally; skip on Lightsail.
- **`DATABASE_TYPE=postgres`** is env-only (no CLI flag). Scripts throw without it.

## File layout

```
src/capabilities/   — the 5 agents (intake, sourcing, quote, scenario, guardian) + supporting
src/orchestrator/   — PIC that coordinates capabilities + DealContext + stage transitions
src/memory/         — persistence (pg-database, composite-stores, schema/ SSOT)
src/mcp/            — MCP server (stdio + SSE transports; 12 tools)
src/server/         — HTTP API (Vapi webhook, dashboard, intelligence + analytics routes)
src/ingestion/      — data pipelines (ADS-B feed, FAA daily diff, history backfill, NTSB, cross-validate)
src/analytics/      — WINGX engine, embeddings, data-quality
src/utils/          — logger, sentry, safe-llm-call, haversine
tests/              — 679 tests / 24 files (vitest)
scripts/            — one-off tooling (phase7-preflight, phase7-verify, s3-bulk-restore, inventory)
.claude/            — Claude Code config, skills, commands
docs/               — phase docs, runbooks, audits (this file's reference siblings)
specs/              — SPARC specs for orchestrator + capabilities
```

## Where to find more

- `docs/api.md` — HTTP API reference
- `docs/schema.md` — full table list + field purposes (`src/memory/schema/` is SSOT)
- `docs/er-architecture-plan.md` — ontology, entity resolution principles, 9-stage build sequence
- `docs/data-platform-plan.md` — tool choices (dbt, Dagster), layer boundaries, operational ontology, migration sequence
- `docs/operations.md` — npm scripts (incl. `operators:dedup` / `operators:fix-name` / `operators:review` for canonical hygiene), cron, PM2, env vars
- `docs/mcp-tools.md` — 12 MCP tools + stdio/SSE notes
- `docs/known-issues.md` — standing data flags
- `docs/phase7-rebuild-runbook.md` — active rebuild operations
- History: `git log --oneline` (no separate CHANGELOG)

## Claude Code Guidelines (Karpathy Principles)

1. **Think Before Coding** — State assumptions explicitly. Present tradeoffs. Push back when a simpler approach exists. Stop and ask when confused rather than guessing.

2. **Simplicity First** — Minimum code that solves the problem. No speculative features, no abstractions for single-use code, no "flexibility" that wasn't requested. If 200 lines could be 50, rewrite it.

3. **Surgical Changes** — Touch only what you must. Don't "improve" adjacent code, comments, or formatting. Don't refactor things that aren't broken. Every changed line should trace directly to the request.

4. **Goal-Driven Execution** — Define success criteria before coding. Transform tasks into verifiable goals:
   - "Add validation" → "Write tests for invalid inputs, then make them pass"
   - "Fix the bug" → "Write a test that reproduces it, then make it pass"
   - For multi-step tasks, state a plan with verification at each step.
