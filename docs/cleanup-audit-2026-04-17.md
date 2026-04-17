# Repo cleanup audit — 2026-04-17

Read-only investigation. No files were modified. All recommendations
require explicit user approval in a separate session.

Scope: `~/osa/dumont-agent/` only. Lightsail deployment, `/tmp`, and
the stray `~/dumont-agent` folder are out of scope.

## Category legend

- **ACTIVE** — in use, do not delete
- **HISTORICAL** — kept for reference but no longer active
- **REDUNDANT** — superseded by something newer
- **TRASH** — build artifacts, dumps, OS junk
- **UNCLEAR** — needs user decision

## Section 1 — Repo root inventory

| Path | Size | Last modified | Git status | Category | Reasoning | Recommended action |
|------|------|---------------|------------|----------|-----------|--------------------|
| `.claude/` | — | 2026-04-14 | ignored | ACTIVE | Local Claude Code settings + skills. Per-machine. | keep |
| `.claude-task` | 324 B | 2026-04-12 | tracked | TRASH | One-line prompt from April 12 for the FAA registry ingestor; that work is long since done. Dangling scratch file. | git rm |
| `.dockerignore` | 176 B | 2026-04-12 | tracked | REDUNDANT | Goes with Dockerfile; Dockerfile is obsolete (see below). | git rm with Dockerfile |
| `.DS_Store` | 10 K | 2026-04-16 | ignored | TRASH | macOS Finder metadata. Already gitignored; fine to delete locally. | rm (local only) |
| `.env` | 474 B | 2026-04-17 | ignored | ACTIVE | Real secrets. Do NOT commit. | keep |
| `.env.example` | 359 B | 2026-04-17 | tracked | ACTIVE | Updated in Phase 15 Step 2. | keep |
| `.git/` | 5.6 M | — | — | ACTIVE | Repository metadata. | keep |
| `.github/` | — | 2026-04-13 | tracked | ACTIVE | CI workflow (ae51236 + 0a3fcf6). | keep |
| `.gitignore` | 264 B | 2026-04-16 | tracked | ACTIVE | | keep |
| `.gstack/` | 20 K | 2026-04-12 | ignored | TRASH | `browse-console.log` + `browse-network.log` from an ad-hoc browser tool on Apr 12. No references anywhere. | rm -rf (local) |
| `.mcp.json` | 112 B | 2026-04-17 | tracked | ACTIVE | Sentry MCP registration (Phase 15 Step 2). | keep |
| `ANALYSIS.md` | 24 K | 2026-04-08 | tracked | HISTORICAL | "Forensic Analysis" generated 2026-04-08, pre-Phase 6 PostgreSQL migration. Describes the repo as it was before ~10 major commits. Not referenced by any code or doc. | move to `archive/` or git rm |
| `archive/` | 4 K | 2026-03-31 | tracked | HISTORICAL | Just `REFERENCE.md` — pointers to `~/osa/simulator/`, `~/osa/sparc-specs/`, `~/osa/mission-control/` (previous OSA work) + migration plan notes. Useful as a breadcrumb to prior work. | keep (it's tiny, clearly labelled) |
| `CLAUDE.md` | 14 K | 2026-04-14 | tracked | ACTIVE | Project instructions. | keep |
| `claude_desktop_config.json` | 183 B | 2026-04-12 | tracked | UNCLEAR | Claude Desktop MCP config with an absolute path (`/Users/phelipehonesto/osa/dumont-agent`). Works only on this Mac. Not referenced elsewhere. The `.mcp.json` at root replaces this for Claude Code. | git rm if you no longer use Claude Desktop, else keep |
| `dashboard/` | 16 M | 2026-04-12 | mostly ignored | ACTIVE | React + Vite dashboard (`@osa/mission-control`). Referenced by `package.json` scripts `dashboard`, `dashboard:build`. Per CLAUDE.md "React dashboard on :5174, PWA-enabled". | keep (see dashboard deep-dive below) |
| `data/` | 5.2 G | 2026-04-17 | ignored | mixed | See Section 3 deep-dive — 4+ GB of reclaimable local-only state. | partial cleanup |
| `deploy-checklist.md` | 3.3 K | 2026-04-12 | tracked | REDUNDANT | Railway deployment checklist from 2026-04-12. CLAUDE.md now names AWS Lightsail as deployment target. Superseded by `docs/feed-migration-deploy.md`. | move to `archive/` or git rm |
| `Dockerfile` | 650 B | 2026-04-12 | tracked | REDUNDANT | Railway Docker build. Lightsail uses PM2 directly. No CI references it. | git rm |
| `docs/` | 108 K | 2026-04-17 | tracked | ACTIVE | 11 docs, all phase/runbook material from recent commits. | keep (see deep-dive) |
| `full-codebase.txt` | 740 K | 2026-04-09 | tracked | TRASH | Repomix dump from 2026-04-09 (pre-Phase 6). Huge, stale, not referenced. | git rm |
| `node_modules/` | 413 M | 2026-04-17 | ignored | ACTIVE | | keep |
| `package.json` / `package-lock.json` | 3 K / 391 K | 2026-04-17 | tracked | ACTIVE | | keep |
| `Procfile` | 33 B | 2026-04-04 | tracked | REDUNDANT | Railway start command (`web: npx tsx src/server/index.ts`). Lightsail uses PM2. | git rm |
| `railway.toml` | 132 B | 2026-04-13 | tracked | REDUNDANT | Railway build/deploy config. Only Vapi webhooks on Railway now (per CLAUDE.md); the API itself is on Lightsail. | git rm or slim to Vapi-only |
| `README.md` | 4.9 K | 2026-04-17 | tracked | ACTIVE | CI badge added (0a3fcf6). | keep |
| `scenarios/` | 12 K | 2026-03-31 | tracked | ACTIVE | `scenarios.json` — loaded by `src/run-sim.ts:306` and `src/eval/quote-eval.ts:353`. | keep |
| `scripts/` | 724 K | 2026-04-17 | tracked | ACTIVE | `s3-bulk-restore.ts`, `phase7-preflight.ts`, `phase7-verify.ts`, `backfill-2023.ts`, `inventory-adsb-archive.ts`, `probe-2023-releases.ts`, `probe-adsb-partials.ts`, `smoke-test.sh`. | keep (see Section 2 note on probes) |
| `specs/` | 92 K | 2026-04-04 | tracked | HISTORICAL | SPARC specs (orchestrator, capabilities, learning loop, comms). Never imported or linked from code — only ANALYSIS.md refs them. Useful as design reference, same lineage as `archive/REFERENCE.md`. | move to `archive/specs/` or keep (small) |
| `src/` | 1.4 M | 2026-04-16 | tracked | ACTIVE | | keep |
| `tests/` | 452 K | 2026-04-17 | tracked | ACTIVE | 25 test files, 681 tests pass. | keep |
| `tsconfig.base.json` | 204 B | 2026-04-12 | tracked | ACTIVE | Extended by `tsconfig.json` and `dashboard/tsconfig.json`. | keep |
| `tsconfig.json` | 427 B | 2026-04-12 | tracked | ACTIVE | | keep |
| `vitest.config.ts` | 152 B | 2026-03-31 | tracked | ACTIVE | | keep |

## Section 2 — Deep-dive on called-out items

### `.claude-task`

Single-line prompt describing the FAA registry ingestor task from
April 12. That work is shipped (`src/ingestion/faa-full-ingest.ts`
+ `faa-daily-diff.ts`). No references. **Dangling scratch →
recommend `git rm`.**

### `.gstack/`

Two log files (`browse-console.log` 455 B, `browse-network.log` 14 K)
from Apr 12 19:22. Looks like output from an ad-hoc browser-scraping
tool run once. Already gitignored (`.gstack/` in `.gitignore`). No
references anywhere. **Recommend `rm -rf .gstack/` locally.**

### `archive/`

Only `archive/REFERENCE.md` (2.3 K, Mar 31). Serves a clear purpose —
it's a "here's what the previous OSA work was" breadcrumb for anyone
reading the repo for the first time. **Recommend keep.**

### `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "dumont-intelligence": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/Users/phelipehonesto/osa/dumont-agent"
    }
  }
}
```

Absolute path makes it useful only on this Mac. Claude Code now uses
the repo-root `.mcp.json` (added 2026-04-17). **Recommend `git rm`
unless you still plug Claude Desktop into this repo daily.**

### `dashboard/`

16 MB including `node_modules` (15 M) and `dist` (328 K) — both
gitignored. Tracked files are `package.json`, `vite.config.ts`,
`vercel.json`, `tsconfig.json`, `index.html`, `src/`, `api/`,
`public/`, `middleware.ts`, `scripts/`. Name in `package.json` is
`@osa/mission-control`. Referenced by root `package.json` scripts
`dashboard` and `dashboard:build`. Also a `deploy` script calling
`vercel --prod` — so the dashboard is a separately-deployable Vercel
app consuming the Dumont API. **ACTIVE.**

### `scenarios/` and `specs/`

- `scenarios/scenarios.json` (8.5 K, Mar 31): 25 validation scenarios,
  loaded by `src/run-sim.ts` and `src/eval/quote-eval.ts`.
  **ACTIVE — keep.**
- `specs/` (8 files, 92 K total including a `.DS_Store`): SPARC-format
  design docs (orchestrator, intake, quote, sourcing, scenario,
  guardian, comms, learning-loop). Last touched Apr 4. Not referenced
  by any code; only ANALYSIS.md lists them. Useful as design
  reference. **HISTORICAL — keep in place or move to `archive/specs/`
  (your call). Tiny either way.**

### `data/`

5.2 GB total, 100% gitignored. Breakdown:

| Path | Size | Contents | Still active? |
|------|------|----------|---------------|
| `dumont.db` | 3.0 GB | SQLite DB from pre-Phase-6 (`DATABASE_TYPE=postgres` is now canonical). | **No** — project runs on Supabase. Deletable. |
| `dumont.db.gz` | 762 MB | Compressed backup from Apr 12. | **No** — obsolete. Deletable. |
| `dumont.db-shm` / `-wal` | 32 KB / 0 B | SQLite WAL journal artifacts. | No. Deletable with the main .db. |
| `backfill-tmp/2024-02-07.tar` | 1.1 GB | Leftover from an interrupted local backfill run on this Mac (rebuild is now on Lightsail, separate host). | **No** — this Mac isn't running the rebuild. Deletable. |
| `ReleasableAircraft.zip` | 72 MB | FAA raw zip from Apr 12. Pipeline re-downloads fresh daily. | No. Deletable. |
| `faa_raw/` | 525 MB | Extracted FAA data (MASTER, DEREG, ACFTREF, etc.). Re-extracted each pipeline run. | No — regeneratable. Deletable. |
| `exports/target_companies_top500.csv` | 44 KB | One-off export from Apr 12. | Unclear — user decision. |
| `seeds/safety-ratings.json` | 4 KB | Seed data loaded by `src/ingestion/safety-ratings.ts`. | **Yes** — keep. |
| `eval-deals.db` | 496 KB | Eval harness DB. | Likely yes — `src/eval/quote-eval.ts` uses it. Keep. |
| `sim-deals.json` | 32 KB | Sim test data. | Likely yes. Keep. |

**Total reclaimable in `data/`: ~5.45 GB** (all local, gitignored).
Safe to delete with: `rm -rf data/dumont.db* data/backfill-tmp data/ReleasableAircraft.zip data/faa_raw`.

### `full-codebase.txt`

Repomix dump from 2026-04-09. 740 K of mostly pre-Phase-6 code (before
the PostgreSQL migration, before Phase 15 logging/Sentry, before phase
7 bugfix + rebuild infrastructure). Not referenced by any script or
doc. Git-tracked. **Recommend `git rm` — you can always regenerate
with `repomix` if needed.**

### `ANALYSIS.md`

Tracked doc, 24 K, 2026-04-08. First line: "Generated 2026-04-08.
Based on reading every file in the repository and running every
command." Describes the repo as it existed before the Phase 6 PostgreSQL
migration (commit 97ae73d and later), before the Phase 15 logging work,
before the Phase 7 rebuild infrastructure. **HISTORICAL.** Accurate
snapshot of its date but stale for current-state reference — a new
reader coming to this doc today would get a misleading picture.
**Recommend move to `archive/analysis-2026-04-08.md` or `git rm`.**

### `deploy-checklist.md`

Railway deployment checklist, 3.3 K, 2026-04-12. CLAUDE.md now names
AWS Lightsail, PM2, Caddy — not Railway. Superseded by
`docs/feed-migration-deploy.md` (16 K, current). **REDUNDANT.
Recommend `git rm`.**

### `railway.toml`

```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "npm run server"
healthcheckPath = "/health"
restartPolicyType = "ON_FAILURE"
```

Railway-specific config. Per CLAUDE.md, only Vapi webhooks still run on
Railway. If the Vapi webhook handler is a separate Railway service
that uses this `railway.toml`, keep it. If Railway is deprecated
entirely, `git rm`. **UNCLEAR — user decision.**

## Section 3 — Obvious cruft scan

| Pattern | Found | Location | Action |
|---------|-------|----------|--------|
| `.DS_Store` files | 4 | `./`, `./specs/`, `./tests/`, `./src/` | gitignored already; delete locally with `find . -name .DS_Store -not -path './node_modules/*' -not -path './.git/*' -delete` |
| `*.swp` / `*~` / `*.bak` | 0 | — | — |
| Editor dirs (`.vscode`, `.cursor`, `.idea`) | 0 | — | — |
| Loose `*.log` files (not gitignored) | 0 | — | — (`.gstack/*.log` and `*.log` are gitignored) |
| `node_modules/` in subdirectories | 1 legit | `dashboard/node_modules` | legitimate subproject, gitignored |
| Test output files | 0 | — | — |

## Section 4 — Summary

### Counts by category

| Category | Count |
|----------|-------|
| ACTIVE | 18 |
| HISTORICAL | 3 |
| REDUNDANT | 4 |
| TRASH | 4 |
| UNCLEAR | 2 |

### Reclaimable if TRASH + REDUNDANT deleted

**On-disk (local only, gitignored):**
- `data/dumont.db` + `.db-shm` + `.db-wal`: **~3.0 GB**
- `data/dumont.db.gz`: **762 MB**
- `data/backfill-tmp/2024-02-07.tar`: **1.1 GB**
- `data/ReleasableAircraft.zip`: **72 MB**
- `data/faa_raw/`: **525 MB**
- `.gstack/`: **20 KB**
- `.DS_Store` files (4): **~20 KB**
- **Subtotal**: **~5.45 GB** (doesn't change repo size on clone)

**Tracked (shrinks clone + history going forward):**
- `full-codebase.txt`: **740 KB** (single biggest win for clone size)
- `ANALYSIS.md`: **24 KB**
- `deploy-checklist.md`: **3.3 KB**
- `.claude-task`: **324 B**
- `Dockerfile` + `.dockerignore`: **~830 B**
- `Procfile`: **33 B**
- `claude_desktop_config.json`: **183 B** (if not used)
- `railway.toml`: **132 B** (if not used)
- `specs/` if moved to `archive/`: **92 KB** shift (not a delete)
- **Subtotal**: **~770 KB** deletion from tracked files

### High-priority deletion candidates (>1 MB each)

1. **`data/dumont.db`** — 3.0 GB. Pre-Phase-6 SQLite. Safe to delete.
2. **`data/backfill-tmp/2024-02-07.tar`** — 1.1 GB. Stale from an
   interrupted local run; the rebuild currently in progress is on
   Lightsail, not on this Mac.
3. **`data/dumont.db.gz`** — 762 MB. Old compressed backup.
4. **`data/faa_raw/`** — 525 MB. Regenerated on every pipeline run.

### Items needing user decision (UNCLEAR)

1. **`claude_desktop_config.json`** — keep only if you still use
   Claude Desktop in this repo; `.mcp.json` now handles Claude Code.
2. **`railway.toml`** — keep if the Vapi webhook still runs on
   Railway; remove if Railway is fully deprecated.
3. **`data/exports/target_companies_top500.csv`** — one-off export;
   was it a deliverable or throwaway?
4. **`specs/`** (as a whole) — historical SPARC specs. Keep in place,
   move to `archive/specs/`, or git rm? Small either way.
5. **`ANALYSIS.md`** — git rm vs. move to `archive/analysis-2026-04-08.md`.

### One-liner deletion scripts (NOT run — for your review)

**Reclaim the 5.45 GB of local-only cruft** (safe; all gitignored):
```bash
rm -rf data/dumont.db data/dumont.db-shm data/dumont.db-wal data/dumont.db.gz
rm -rf data/backfill-tmp data/ReleasableAircraft.zip data/faa_raw
rm -rf .gstack
find . -name .DS_Store -not -path './node_modules/*' -not -path './.git/*' \
  -not -path './dashboard/node_modules/*' -delete
```

**Remove obsolete Railway + repomix artifacts** (approve first):
```bash
git rm full-codebase.txt .claude-task Dockerfile .dockerignore Procfile
# optionally, if Railway fully deprecated:
git rm railway.toml deploy-checklist.md
```

**Archive pre-Phase-6 snapshot** (approve first):
```bash
git mv ANALYSIS.md archive/analysis-2026-04-08.md
```

**Archive SPARC specs** (optional, approve first):
```bash
git mv specs archive/specs
```

## Notes and caveats

- The in-progress Phase 7 rebuild on Lightsail is untouched by any
  recommendation here. The `data/backfill-tmp/2024-02-07.tar` called
  out for deletion is on this Mac, not the rebuild host.
- Git history is not rewritten by any recommendation. `git rm` of
  tracked files just stops tracking them going forward; they remain
  in history and can be recovered with `git show <hash>:path`.
- No recommendation touches `src/`, `tests/`, `scripts/`, `docs/`,
  `dashboard/`, `.github/`, or any config that CI/runtime depends on.
