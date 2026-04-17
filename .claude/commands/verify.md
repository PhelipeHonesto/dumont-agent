---
name: verify
description: Run the full verification suite before marking any task complete. Typecheck, tests, and audit-fix regression check.
---

Run the verification sequence for the current change:

1. `npm run typecheck`
   Must exit 0. Paste any errors.

2. `npm test`
   Must show "681 passed" (or higher if new tests added).
   Paste the summary line.

3. Confirm no regression of today's audit fixes:
   - `grep -q "function esc" src/server/routes/dashboard.ts`
     (XSS helper must still exist)
   - `grep -q "/ready" src/server/routes/health.ts`
     (readiness probe must still exist)
   - `grep -q "installProcessHandlers" src/utils/sentry.ts`
     (helper must still exist)
   - `grep -q "createStandaloneClient" src/memory/pg-database.ts`
     (helper must still exist)

4. `git status` — verify only the expected files changed

5. Report: PASS / FAIL. If FAIL, do NOT commit or mark task done.

Only after PASS: propose a commit message following the style:
`<type>: <summary> (<finding-id>)`
where type is one of: feat, fix, refactor, cleanup, chore, docs, security, perf, test.
