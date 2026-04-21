# Audit 01 — Dependencies (ln-625) — 2026-04-17

Scope: `package.json` + `dashboard/package.json` workspace, `npm audit --json`,
`npm outdated --json`, import-usage grep across `src/`.

## Score: **5.5 / 10**

Reasoning: zero criticals and all direct prod deps are used, but 18 open
CVEs (12 HIGH, 4 MOD, 2 LOW) with several lacking upstream fixes, plus
six deps a full major version behind (including the LLM SDK and zod).

## Summary counts

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 12 |
| Moderate | 4 |
| Low | 2 |
| **Total CVEs** | **18** |

Dep totals: **819 total** (prod 505, dev 311, optional 108).

## Findings

### F-01-1 — `tar` has 6 HIGH CVEs; used directly in ingestion

**Severity:** HIGH · **CVSS up to 8.8** · **Fix:** no upstream fix
in 7.x chain (per npm audit)

Direct use in `src/ingestion/package-positions.ts` and
`src/ingestion/cross-validate.ts` to extract tars fetched from S3
(`raw/adsb/...` and `raw/adsb-osa/...`).

Notable CVEs:
- Race condition via Unicode ligature collisions on macOS APFS (8.8)
- Hardlink Path Traversal via Drive-Relative Linkpath
- Arbitrary File Read/Write via Hardlink Target Escape

Actual attacker model is narrow — our tar inputs are produced by our
own S3 bucket or `adsb.lol` (trusted enough for other reasons), never
by end users. But these are path-traversal / arbitrary-write
primitives; if an S3 key ever becomes untrusted, exploitation is
straight-forward.

**Recommendation:** monitor `tar` 7.x for a patched release; in the
meantime keep the attacker model narrow (no untrusted tar inputs).
Consider extracting under a rootless temp dir with `--strip-components`
and explicit allowlist if a 0-day lands.
**Effort:** S to add safety wrapper · L to replace with a safer extractor.

### F-01-2 — `@vercel/node` (direct, dashboard) is HIGH-vulnerable; no non-breaking fix

**Severity:** HIGH · **Direct dep:** yes (in `dashboard/package.json`)
· **Fix:** major version downgrade to 4.0.0 (breaking)

Pulls in `undici` (7 CVEs, up to 7.5), `path-to-regexp` (7.5),
`minimatch` (7.5), `ajv` (ReDoS), `smol-toml` (5.3). All route through
this single direct dep.

The dashboard deploys to Vercel (per `dashboard/package.json` deploy
script), so this is **prod-exposed surface** when the dashboard is
serving.

**Recommendation:** pin `@vercel/node` to the version Vercel's
platform actually requires (check the deploy build logs); if
Vercel's runtime supplies its own, we can drop the dep entirely from
the workspace. Confirm before downgrading.
**Effort:** M.

### F-01-3 — `duckdb` direct HIGH via `node-gyp` build chain; no fix

**Severity:** HIGH · **Direct dep:** yes · **Fix:** none upstream

Use: `src/ingestion/package-positions.ts`, `src/query/positions-router.ts`
(parquet reading). The vuln is in the build-time toolchain
(`node-gyp → make-fetch-happen → tar/cacache`), not the runtime binary.
Runtime risk is low; supply-chain risk is real if we ever rebuild from
npm on a compromised CDN.

**Recommendation:** accept for now; watch for `duckdb` upgrade to a
newer `node-gyp` (currently it pins an old one).
**Effort:** S (monitor only).

### F-01-4 — `@anthropic-ai/sdk` 0.39 → 0.90 (51 minor/major versions behind)

**Severity:** HIGH (not a CVE — product risk)

Used extensively (LLM calls, streaming, message params). The SDK's API
has changed significantly between 0.39 and 0.90 (new message content
types, extended thinking, etc.). We're missing capabilities and bug
fixes.

**Recommendation:** read the SDK changelog, make a migration plan.
Start with a branch, run the test suite, ship in a dedicated PR.
**Effort:** M–L.

### F-01-5 — `zod` 3.25 → 4.3 available (MAJOR)

**Severity:** MEDIUM (breaking changes expected)

Widely imported across schemas. zod 4 has a different error-format
object and some parser changes. Test suite will flag regressions.

**Recommendation:** defer — zod 3.25 is stable; migrate when there's a
feature we need from 4.x.
**Effort:** M.

### F-01-6 — Other major-behind packages

| Package | Current | Latest | Risk | Note |
|---------|---------|--------|------|------|
| `typescript` | 5.9.3 | 6.0.3 | LOW | Wait for TS 6 to stabilize; no pressing need. |
| `@types/node` | 22.19.15 | 25.6.0 | LOW | We run Node 22 on Lightsail; match types to runtime. Stay on 22.x types. |
| `vite` | 6.4.2 | 8.0.8 | MEDIUM | Dashboard build. 7→8 both recent. |
| `vitest` | 3.2.4 | 4.1.4 | MEDIUM | 681 tests; migration risk. |
| `@vitejs/plugin-react` | 4.7 | 6.0.1 | LOW | Pair with vite upgrade. |

**Recommendation:** defer Typescript and @types/node. Dashboard tooling
(vite + plugin-react + vitest) can batch together.
**Effort:** S–M per batch.

### F-01-7 — Minor-version catch-ups (safe)

These are one `npm update <pkg>` away:

- `@aws-sdk/client-s3` 3.1029 → 3.1032
- `@aws-sdk/lib-storage` 3.1029 → 3.1032
- `better-sqlite3` 12.8 → 12.9
- `@vercel/node` 5.7.4 → 5.7.10 (does NOT fix CVEs; still on 5.x chain)
- `@types/node` 22.19.15 → 22.19.17 (within 22.x)

**Recommendation:** run `npm update` in a PR, verify tests green.
**Effort:** S.

### F-01-8 — All direct prod deps are used

Verified via `grep ^import ... from 'X'` across `src/**/*.ts`:

| Package | Import sites |
|---------|--------------|
| `better-sqlite3` | 6 files |
| `duckdb` | 2 files |
| `@dsnp/parquetjs` | 2 files |
| `tar` | 2 files |
| `ulid` | 2 files |
| `pg-cursor` | 1 file |
| `@modelcontextprotocol/sdk` | 3 files |
| `express-rate-limit` | 1 file |
| `cors`, `express`, `pg`, `@sentry/node`, `pino`, `zod`, `@anthropic-ai/sdk`, `@aws-sdk/*` | widespread |

**No unused direct prod deps detected.** Nothing to remove.

### F-01-9 — No evidence of wheel-reinvention

Searched for `axios`, `lodash`, `moment`, `node-fetch`, `request` — none
imported. Node 22's native `fetch` is used instead. Date handling via
stdlib `Date` + ISO strings. No custom crypto spotted (uses
`node:crypto`).

## Fix priority

1. **F-01-2 (@vercel/node direct HIGH)** — decide if dep can be
   dropped (dashboard deploy target investigation).
2. **F-01-4 (Anthropic SDK 0.39 → 0.90)** — product risk, not CVE;
   schedule migration PR.
3. **F-01-1 (tar CVEs)** — accept but add path-safety wrapper on the
   extraction call sites.
4. **F-01-7 (safe minors)** — single `npm update` PR.

## Out of scope

- Node-runtime upgrades (Node 22 → 24) — handled in Lifecycle audit.
- Sentry version — current is 10.49.0, latest at audit time.
- Pino version — 10.3.1 current, no vulns.
