# CLAUDE.md audit — 2026-04-17

Read-only analysis. No edits yet.

## 1. Current stats

| Metric | Value |
|--------|-------|
| Total lines | 244 |
| Words | 2,041 |
| Bytes | 14,196 |
| Tokenizer estimate (words × ~1.3) | ~2,650 tokens |

Target per Cherny guideline: ~100–150 lines / ~1,000–1,500 tokens.
**Current file is ~1.7× the upper bound**, dominated by three large
reference sections (Database Tables + npm Scripts + API Endpoints
together = 107 lines / 44% of the file).

## 2. Section-by-section classification

| § | Section | Lines | Classification | Rationale |
|---|---------|-------|----------------|-----------|
| 1 | Title + blurb (1–4) | 4 | **KEEP** | One-paragraph framing every session needs |
| 2 | Architecture (5–14) | 11 | **TRIM → 7** | Drop lines that the file path itself conveys ("Live ADS-B worker: `src/ingestion/adsblol-live-worker.ts`"). Keep the list, lose a line each |
| 3 | Data Architecture (16–22) | 8 | **TRIM → 5** | Fold into Architecture — it's 3 rows of a table that overlaps with §2 |
| 4 | Deployment (24–30) | 8 | **KEEP/EXPAND → 12** | **CRITICAL** section for per-session scoping. Needs Mac-vs-Lightsail distinction (see §3 Gaps). Drop the "Railway: Vapi webhooks only" one-liner (shrinking surface; Vapi may migrate) |
| 5 | Nightly Cron Schedule (32–38) | 8 | **MOVE → `docs/operations.md`** | Runs on Lightsail cron; not a per-session Claude concern |
| 6 | Security (40–44) | 6 | **KEEP/TRIM → 5** | Tight already. Add one line: `/ready` probe for PG liveness (added today, commit 5763d47) |
| 7 | Database Tables (46–79) | 35 | **MOVE → `docs/schema.md`** | 30 rows of reference. Claude reads schema-pg.sql or queries when needed; doesn't need every table name memorized up front |
| 8 | npm Scripts (81–111) | 32 | **DELETE** | `package.json` is the source of truth. Duplicated info rots — already shows `628 tests` while current count is 681 |
| 9 | API Endpoints (113–151) | 40 | **MOVE → `docs/api.md`** | Biggest section. Route code is discoverable via Grep and the files are already split by function |
| 10 | MCP Tools (153–170) | 19 | **MOVE → `docs/mcp-tools.md`** or **TRIM → 5** | One-liner pointer to `src/mcp/tools.ts` + the fact that there are 12 tools + server name, is enough |
| 11 | Deal Pipeline (172–179) | 9 | **KEEP** | Core business concept, dense, no duplication |
| 12 | Code Patterns (181–191) | 12 | **KEEP/EXPAND → 15** | These ARE the per-session rules. Add: logger contract (childLogger, Sentry auto-bridge on error/fatal), schema-pg.sql is SSOT for PG, Postgres is the primary backend (SQLite is local-dev only) |
| 13 | Known Issues (193–199) | 8 | **TRIM/UPDATE → 6** | Line 195 is stale ("KnowledgeGraphStore, health-queries, and ingestion scripts still use SQLite locally") — contradicts Phase 6 Tier 3. Add one line pointing to `docs/known-issues.md` for current flags (esp. Phase 7 adsb_completed_legs contamination) |
| 14 | Environment Variables (201–213) | 14 | **DELETE** | `.env.example` is the source of truth; this duplicates it. Keep a 1-line pointer in §6 Security |
| 15 | Commands Quick Reference (215–231) | 18 | **DELETE** | Duplicates npm Scripts table. Zero unique info |
| 16 | Karpathy Principles (233–244) | 12 | **KEEP** | These fire every session; high-signal, non-duplicated |

**Subtotals of the cuts:**
- Delete outright: 32 + 18 + 14 = **64 lines**
- Move to `docs/`: 8 (cron) + 35 (schema) + 40 (api) + 19 (mcp) = **102 lines**
- Trim in-place: ~15 lines net reduction
- Keep + small expansions: +7 lines

**Target new total:** 244 − 64 − 102 − 15 + 7 = **70 lines of *new* content on top of kept sections**, landing around **130 lines** all-in.

## 3. Gaps — things to ADD based on recent sessions

Top candidates, in priority order:

### 3.1 Mac vs Lightsail split (HIGH)

Every long-running operation in this codebase has two possible hosts.
The Phase 7 rebuild is on Lightsail; `data/` on the Mac is stale cruft.
Claude has repeatedly had to be told "the rebuild is on Lightsail, don't
touch files on Mac". Encode it:

> **Two hosts: Mac (local dev / editing / tests) and Lightsail
> (44.197.126.96 — production API, feed, MCP, pipeline cron,
> rebuild jobs).** Operations that mention "the rebuild", "production",
> PM2, or cron live on Lightsail unless stated otherwise. `data/` on
> the Mac is local-only; the Mac SQLite is post-Phase-6 cruft.

### 3.2 Logging + Sentry contract (HIGH)

Phase 15 locked in a contract that isn't in CLAUDE.md yet:

> - `childLogger("<component>")` from `src/utils/logger.ts`, not
>   `console.*` for production paths. CLI summary tables + progress
>   counters stay `console.log`.
> - `log.error` / `log.fatal` auto-bridge to Sentry. Don't use them
>   for expected events — that's `info`/`warn`.
> - Logger writes to **stderr only** (MCP stdio protocol owns stdout).
> - `installProcessHandlers("<component>")` at the top of every
>   long-running entry point.

### 3.3 Phase 7 contamination flag pointer (HIGH)

`adsb_completed_legs` is tainted until the in-flight rebuild finishes
(see `docs/known-issues.md` and `docs/phase7-rebuild-runbook.md`).
Claude should not write features that depend on clean leg data without
calling this out.

### 3.4 Commit style (MEDIUM)

Today's session shipped 8 fixes as 6 commits, not one PR. Recent
Phase 15 work was the same pattern. Worth one line:

> **Commit style**: tier-by-tier or finding-by-finding, each typecheck-
> and test-green before push. Message = `<area>: <change> (<finding id>)`
> where applicable.

### 3.5 Supabase connection-string encoding (MEDIUM)

Password special characters in `SUPABASE_DATABASE_URL` need URL
encoding. Not today's-session-fresh but a known gotcha worth capturing
as one line in Code Patterns.

### 3.6 `/ready` vs `/health` split (LOW)

Today's commit 5763d47 added the split. Worth one line in §6 Security
so we don't regress.

## 4. Proposed new CLAUDE.md skeleton (~130 lines)

```
# Dumont Agent                                              [4 lines]
One-paragraph blurb.

## Architecture                                             [10 lines]
7-row bullet list: Postgres/Supabase, Express API,
MCP server, Dashboard, Live feed, Pipeline cron, Analytics.
Merges current §§2+3.

## Deployment                                               [12 lines]
Two-host split (Mac vs Lightsail). Domain. Caddy.
PM2 processes. S3 bucket. Pointer to docs/operations.md
for cron specifics.

## Known Issues (current flags)                             [8 lines]
1-sentence-each pointers to docs/known-issues.md,
incl. Phase 7 adsb_completed_legs contamination.

## Code Patterns                                            [18 lines]
Money in cents. ISO dates. Zod. getDatabase()/DbBridge.
deal_events append-only. Express 5 + asyncHandler.
safeLlmCall. Supabase URL encoding. Schema SSOT is
src/memory/schema-pg.sql.

## Logging & Observability (Phase 15 contract)              [14 lines]
childLogger, Sentry bridge, stderr only,
installProcessHandlers, /ready vs /health.

## Security                                                 [7 lines]
sanitize middleware pointer + rate limits +
CORS allowlist + /ready. .env.example for env vars.

## Commit Style                                             [5 lines]
Focused commits, typecheck + tests green, finding
ID in message.

## Karpathy Principles                                      [15 lines]
The 4 rules, verbatim. Do not trim.

## Key Docs                                                 [12 lines]
| docs/operations.md | nightly cron + PM2 ops |
| docs/schema.md     | 30 tables with column purposes |
| docs/api.md        | REST endpoints + auth matrix |
| docs/mcp-tools.md  | 12 MCP tools |
| docs/known-issues.md | current data flags |
| docs/phase7-rebuild-runbook.md | pre-flight/rebuild/verify |
| CHANGELOG → git log --oneline |
```

Total: ~105 lines + 25 lines whitespace/dividers = **~130 lines**.

## 5. Files to create when we execute

| New file | Contents | Source |
|----------|----------|--------|
| `docs/operations.md` | Nightly cron table, PM2 process list, deploy checklist | Current §5 (Nightly Cron) + some of §4 (Deployment) |
| `docs/schema.md` | 30-table breakdown with column purposes | Current §7 (Database Tables) |
| `docs/api.md` | Intelligence + Analytics + auth-required route tables | Current §9 (API Endpoints) |
| `docs/mcp-tools.md` | 12 MCP tools with stdio/SSE notes | Current §10 (MCP Tools) |

Four new files. No source code changes.

## 6. Stale facts in current CLAUDE.md (will be corrected during trim)

| Location | Stale claim | Current reality |
|----------|-------------|-----------------|
| Line 85 | "`test`: 628 tests, 19 files" | 681 tests, 25 files (audit + Phase 15 work) |
| Line 195 | "KnowledgeGraphStore, health-queries, ingestion scripts still use SQLite locally" | Phase 6 Tier 3 migrated these (commit 2c5287b). SQLite is *only* local-dev now |
| Line 110 | "`db:migrate-pg`: Create all 42 PostgreSQL tables" | Schema lists 30 tables; 42 is pre-Phase-7 (when a bunch of intermediate per-analytics tables existed); verify actual count during trim |
| Line 111 | "Migrate data from SQLite → Supabase (7.86M rows)" | Historical; migration ran once and is done. Delete or demote to `docs/phase6-migration-log.md` |
| Line 192–199 | §13 Known Issues doesn't mention Phase 7 contamination (biggest current flag) | Point to `docs/known-issues.md` |
| Line 218 | `npm test # 628 tests` — same stale count | 681 |

## 7. Risks / tradeoffs

- **Moving the API endpoints table** removes a quick-reference that can
  be handy when spotting "do we have an endpoint for X". Mitigation:
  keep a 3-line summary in CLAUDE.md naming the three routers with
  file paths, and the full table in `docs/api.md`.
- **Deleting Commands Quick Reference** means new-to-codebase-Claude
  has to `grep '"scripts"' package.json` to find commands. Acceptable
  — that's how every other Node project works.
- **Losing the Database Tables full list** means Claude will sometimes
  ask "does table X exist?". Mitigation: schema-pg.sql is 900+ lines
  and trivially grep-able; direct Claude there via the Key Docs
  pointer.

## 8. Execution plan (for a follow-on session)

1. Create the four `docs/*.md` files with content lifted from CLAUDE.md
   (no rewording; exact move).
2. Rewrite CLAUDE.md against the skeleton in §4.
3. Correct the six stale facts from §6.
4. Add the five new rules from §3 (Mac/Lightsail split, logger
   contract, Phase 7 flag pointer, commit style, Supabase URL
   encoding, /ready split).
5. Single commit: `docs: trim CLAUDE.md, split reference material to
   docs/*.md`.
6. Tests not affected — docs-only change.

No code breaks. No risk to the 8 audit fixes or the Phase 7 rebuild.
