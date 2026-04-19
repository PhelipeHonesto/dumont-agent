# Claude Code Lessons — OSA Dumont Agent

A growing record of mistakes made and corrections issued during
Claude Code sessions. Every correction becomes a rule so it
doesn't repeat. Most recent first.

> **Read this before starting new work.** CLAUDE.md is the stable
> operating manual; this file is the memory of specific pitfalls
> from past sessions.

## How to use this file

- When Claude Code is corrected during a session, add a lesson here
- Format: brief rule, then context of what went wrong
- Kept in reverse chronological order (newest at top)
- Consolidated into CLAUDE.md if the lesson becomes foundational
- When a lesson is no longer applicable, delete it (don't archive)

## Lessons

### 2026-04-19 — Canonical operator dedup

**LESSON**: Dedup moves children, never merges fields. The survivor's canonical_name / headquarters_icao / type_tags / operator_type are authoritative; the duplicate contributes only its FK children (aliases, identities, review rows). When metadata disagrees, the invoker must pick the right survivor up front — don't try to reconcile after the fact.

Context: ARGUS-side `37d9a9cd...` and Wyvern-side `be8cb75c...` both named "A-Ok Jets" were created in the same safety-backfill second (same microsecond on first_seen_at, identity_pk=575 vs 576). `scripts/dedup-operator-rows.ts` re-points FK children and deletes the loser; it explicitly does NOT touch the survivor's own columns. An asymmetric integration test (KORD vs KTEB, charter vs fractional, part_135 vs part_91k) locks this invariant in.

**LESSON**: FK owners of `operators(id)` (audit via information_schema, 2026-04-19): `operator_aliases.operator_id` (CASCADE), `operator_identities.operator_id` (CASCADE), `operator_match_review.resolution_operator_id` (NO ACTION). CASCADE children MUST be re-pointed before the DELETE or they get wiped. NO ACTION children MUST be re-pointed before the DELETE or the DELETE hard-fails. `operator_identities` also carries a table-global `UNIQUE (source, source_id)` — no two canonical rows can share the same pair, so the UPDATE during dedup can never hit a uniqueness conflict.

Context: Wrote `scripts/dedup-operator-rows.ts` for Stage 1 hygiene. The FK audit surfaces every ownership edge; the UNIQUE insight removes the need for conflict-handling logic. Real column is `resolution_operator_id`, NOT `matched_operator_id` (a recurring spec typo — grep the schema, don't trust the write-up).

**LESSON**: Survivor-picking heuristic for canonical dedup — (1) older `first_seen_at` wins; (2) higher `identity_count` wins on tie; (3) on double-tie, human pick. Soft tiebreakers (source_reliability, earlier identity_pk) are advisory to the human, not rules the script applies. The script always takes explicit `--keep` / `--merge` UUIDs.

Context: A-Ok Jets hit case 3. The script reports the heuristic but never auto-picks — deleting a canonical row is irreversible (roll to backup if wrong), so the script refuses to guess. After `--commit`, the subprocess `npm run operators:trust-scores -- --commit` refreshes both scores; the survivor's new source_count and cross_source_agreement shift the numbers (A-Ok Jets: data_confidence 0.79, operator_trust 0.85 after gaining the Wyvern identity).

### 2026-04-18 — Entity resolution + data architecture

**LESSON**: OSA's data needs real MDM (Master Data Management) architecture before adding more scraping sources. Every new source has different IDs and naming conventions. Without a canonical + identities layer, integration chaos compounds exponentially.

Context: Attempted to sync ARGUS/Wyvern scraped ratings to faa_operators via certificate_number. Only 1 of 313 matched because each rating system uses its own internal ID (Wyvern "PRIA248H" ≠ FAA "1OCA082A"). This exposed a core data modeling gap — we were conflating source-specific IDs with a canonical operator identity.

**LESSON**: Data model for AI context, not human queries. Agents can't reliably write 4-table JOINs. Pre-compute question-shaped aggregate views (Platinum layer) for every AI read. Let Bronze (raw) and Silver (per-source) tables exist but keep them off the agent's plate.

Context: Per Zach Wilson's "AI-native modeling" — dimensional modeling at the base, question-first aggregations on top. OBT (One Big Table) is the right shape for agent queries because "AI thrives at mapping question → appropriate dataset." Dimensional correctness + OBT interface. Reference: https://blog.dataexpert.io/p/how-to-data-model-for-your-ai-context

**LESSON**: The hard part of entity resolution is the matching algorithm, not the schema. Deterministic matches (shared IDs) are easy. Probabilistic matches (name + base + fleet overlap + address) need weighted scoring with confidence thresholds and a manual review queue for ambiguous cases. Never merge records automatically below the high-confidence threshold.

Context: Surfaced while thinking about how to match 313 scraped rating records to 3,898 FAA operators. Same entity (e.g., Priester Aviation) shows up in multiple sources with different names (LLC variants, DBA variants) and different IDs. Deterministic matches are rare; fuzzy matching needs explicit confidence tracking and human review for edge cases.

### 2026-04-17 — Phase 7 rebuild + audit sprint

**Host / infrastructure awareness**

**LESSON**: Always verify which host a long-running command runs on before executing.
Context: Session started with Claude assuming rebuild was on Lightsail, when the user was actually running it on Mac via `caffeinate`. 2+ hours were lost before catching the mismatch. Every rebuild/archive/pipeline command must explicitly state "this runs on Mac" or "this runs on Lightsail" in the plan.

**LESSON**: Lightsail repo path is `~/dumont-agent`, NOT `~/osa/dumont-agent`.
Context: Mac uses `~/osa/dumont-agent`. Lightsail uses `~/dumont-agent`. Using the Mac path on Lightsail (or vice versa) causes "no such directory" errors. Always match path to host.

**LESSON**: `caffeinate` is macOS-only. Silently no-ops on Linux.
Context: Don't wrap Lightsail commands in `caffeinate -dims` (it doesn't exist there). For Lightsail, rely on tmux for session persistence; the server doesn't sleep.

**LESSON**: Long jobs (>30 min) must run in tmux, not a bare terminal.
Context: Today's rebuild survived machine migration, SSH drops, and terminal switches because it was in tmux. Bare terminal sessions die when SSH drops or terminal closes.

**Credentials / shell escaping**

**LESSON**: Supabase password must be alphanumeric-only. No `!`, `@`, `/`, `#`, `$`, `%`, or any special character.
Context: Original password contained `!` and `@`, which broke zsh history expansion AND URL parsing in psql. Rotated to alphanumeric, all pain stopped. Future credential rotations must pre-filter for special characters.

**LESSON**: Never paste the full Supabase URL into a shell or chat.
Context: Error messages leaking the hostname appeared multiple times during this session. Use `echo "URL length: ${#SUPABASE_DATABASE_URL}"` to verify without displaying. If a URL must be shared, redact the password portion.

**LESSON**: `$SUPABASE_DATABASE_URL` as a shell variable works where pasting the raw URL fails.
Context: zsh interprets `!` as history expansion in raw strings but not in loaded env vars. Always use `set -a && source .env && set +a` then reference `$VAR`, not the literal URL.

**Development environment**

**LESSON**: Repo root is `/Users/phelipehonesto/osa/dumont-agent` on Mac.
Context: There's a stray empty `~/dumont-agent` on Mac (not the real repo). Always `cd ~/osa/dumont-agent` on Mac before running commands.

**LESSON**: `DATABASE_TYPE=postgres` is an env var, NOT a CLI flag.
Context: `history-backfill.ts` and other scripts throw without it. `parseArgs()` only accepts `--from`, `--to`, `--s3-only`. Set it via `export DATABASE_TYPE=postgres` or inline `DATABASE_TYPE=postgres npx tsx ...`.

**Claude Code workflow**

**LESSON**: Don't over-plan before running. Run one audit/command, see output, adapt.
Context: We wasted time strategizing which skills to install before running any. One run of a real auditor produces more learning than hours of strategic discussion.

**LESSON**: Plan Mode for non-trivial tasks, Normal Mode for single-step commands.
Context: Bulk audit/refactor tasks need a plan. Simple "run this command, report output" tasks don't.

**LESSON**: `installProcessHandlers` uses stderr directly, not pino.
Context: During `uncaughtException`, pino's transport may be in an undefined state, and static import of logger.ts from sentry.ts forms a real cycle. Use `process.stderr.write` of JSON instead. See `src/utils/sentry.ts:installProcessHandlers`.

**Audit workflow**

**LESSON**: Ignore "install everything" skill bundles. Install selective plugins + custom skills.
Context: levnikolaevich has 116 skills across 5 plugins. Installing all of them creates context bloat and conflicting workflows. Install only `codebase-audit-suite` plus 2-3 custom skills specific to Dumont.

**LESSON**: When an audit returns 50+ findings, triage into Critical/High/Medium/Low first. Never "fix everything" in one sprint.
Context: Today's 7 audits produced 58 findings total. We triaged to 8 actionable items. Fixing all 58 would have blocked Phase 8 for days.
