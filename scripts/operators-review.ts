/**
 * Manual review CLI for operator_match_review pending rows.
 *
 * Phase 1 commit 9. Walks the pending queue, shows each row with candidates
 * + calibration-seeded reviewer_notes, and prompts for one of five actions:
 *
 *   [a] approve     — top candidate is right; INSERT operator_identities
 *                     with match_confidence='manual' → status='matched'
 *   [r] reject      — none of the candidates are right; this is a new
 *                     operator → INSERT operators + operator_identities
 *                     with match_confidence='exact' → status='new_operator'
 *   [d] defer       — can't decide now; row stays status='pending'
 *   [l] add-alias   — approve AND record scraped_name as a new alias on
 *                     the chosen candidate → INSERT operator_aliases
 *   [e] escalate    — mark for founder review; status='skipped' with
 *                     reviewer_notes prefixed "[ESCALATED]"
 *   [n] pick-other  — use one of the other_candidates instead of top
 *   [q] quit        — exit the loop; remaining rows stay pending
 *
 * Hard pre-flight gate: refuses to run if match-thresholds.ts has
 * calibrated_at = null. Calibration (commit 8b) must land first or the
 * review queue might be built on bad thresholds.
 *
 * Usage:
 *   DATABASE_TYPE=postgres npm run operators:review             # interactive
 *   DATABASE_TYPE=postgres npm run operators:review -- --limit 10
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getPool, closePg } from "../src/memory/pg-database.js";
import { isCalibrated, THRESHOLDS } from "../src/memory/canonical/match-thresholds.js";
import { normalize } from "../src/ingestion/safety-ratings-fuzzy.js";
import { childLogger } from "../src/utils/logger.js";

const log = childLogger("operators-review");

// ── Types ────────────────────────────────────────────────────────────────

export type ReviewAction =
  | "approve"
  | "reject"
  | "defer"
  | "add-alias"
  | "escalate"
  | "pick-other"
  | "quit";

export interface CandidateRef {
  operator_id: string;
  canonical_name: string;
  score: number;
  signals?: Record<string, unknown>;
}

export interface PendingRow {
  id: number;
  scraped_name: string;
  scraped_source: string;
  scraped_source_id: string | null;
  scraped_payload: Record<string, unknown>;
  candidate_matches: CandidateRef[];
  reviewer_notes: string | null;
  created_at: string;
}

// ── Pure helpers (testable) ──────────────────────────────────────────────

export function parseArgs(argv: string[]): { limit: number | null; help: boolean } {
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit" && argv[i + 1]) {
      limit = Number.parseInt(argv[i + 1]!, 10);
      if (Number.isNaN(limit)) limit = null;
    }
  }
  return { limit, help: argv.includes("--help") || argv.includes("-h") };
}

export function parseActionKey(key: string): ReviewAction | null {
  switch (key.trim().toLowerCase()) {
    case "a":
    case "approve":
      return "approve";
    case "r":
    case "reject":
      return "reject";
    case "d":
    case "defer":
      return "defer";
    case "l":
    case "add-alias":
    case "alias":
      return "add-alias";
    case "e":
    case "escalate":
      return "escalate";
    case "n":
    case "pick-other":
    case "other":
      return "pick-other";
    case "q":
    case "quit":
    case "exit":
      return "quit";
    default:
      return null;
  }
}

/** Format the row header shown before prompting. Pure — no I/O. */
export function formatRowDisplay(
  row: PendingRow,
  index: number,
  total: number,
): string {
  const lines: string[] = [];
  lines.push(`\n── Review ${index}/${total} — row id ${row.id} ──────────────────────`);
  lines.push(`Scraped:   '${row.scraped_name}' (source=${row.scraped_source}, source_id=${row.scraped_source_id ?? "none"})`);
  const reason = (row.scraped_payload as { _resolver_reason?: string })._resolver_reason;
  if (reason) lines.push(`Reason:    ${reason}`);
  if (row.reviewer_notes) {
    lines.push(`📝 Labeler note:`);
    for (const line of row.reviewer_notes.split("\n")) {
      lines.push(`   ${line}`);
    }
  }
  lines.push(``);
  lines.push(`Candidates (top ${row.candidate_matches.length}):`);
  row.candidate_matches.forEach((c, i) => {
    lines.push(`  [${i + 1}] ${c.score.toFixed(3)}  ${c.canonical_name}`);
  });
  lines.push(``);
  lines.push(`Actions: [a]pprove top  [n]pick-other  [r]eject→new  [l] add-alias`);
  lines.push(`         [d]efer  [e]scalate  [q]uit`);
  return lines.join("\n");
}

// ── DB I/O ───────────────────────────────────────────────────────────────

async function loadPending(client: pg.PoolClient, limit: number | null): Promise<PendingRow[]> {
  const sql = `
    SELECT id, scraped_name, scraped_source, scraped_source_id,
           scraped_payload, candidate_matches, reviewer_notes, created_at::text
      FROM operator_match_review
     WHERE status = 'pending'
     ORDER BY created_at ASC, id ASC
     ${limit ? `LIMIT ${limit}` : ""}
  `;
  const res = await client.query<PendingRow>(sql);
  return res.rows;
}

export async function approveMatch(
  client: pg.PoolClient,
  row: PendingRow,
  candidate: CandidateRef,
): Promise<void> {
  const evidence = {
    method: "manual_review",
    match_score: candidate.score,
    review_row_id: row.id,
  };
  await client.query(
    `INSERT INTO operator_identities
       (operator_id, source, source_id, name_as_provided,
        match_confidence, match_method, match_evidence)
     VALUES ($1, $2, $3, $4, 'manual', 'manual_review', $5::jsonb)
     ON CONFLICT (source, source_id) DO NOTHING`,
    [
      candidate.operator_id,
      row.scraped_source,
      row.scraped_source_id,
      row.scraped_name,
      JSON.stringify(evidence),
    ],
  );
  await client.query(
    `UPDATE operator_match_review
        SET status = 'matched',
            resolution_operator_id = $1,
            reviewed_at = NOW()
      WHERE id = $2`,
    [candidate.operator_id, row.id],
  );
}

export async function rejectAndCreateNew(
  client: pg.PoolClient,
  row: PendingRow,
): Promise<string> {
  const newId = randomUUID();
  await client.query(
    `INSERT INTO operators (id, canonical_name) VALUES ($1, $2)`,
    [newId, row.scraped_name],
  );
  const evidence = { method: "manual_review_new", review_row_id: row.id };
  await client.query(
    `INSERT INTO operator_identities
       (operator_id, source, source_id, name_as_provided,
        match_confidence, match_method, match_evidence)
     VALUES ($1, $2, $3, $4, 'exact', 'manual_review_new', $5::jsonb)
     ON CONFLICT (source, source_id) DO NOTHING`,
    [newId, row.scraped_source, row.scraped_source_id, row.scraped_name, JSON.stringify(evidence)],
  );
  await client.query(
    `UPDATE operator_match_review
        SET status = 'new_operator',
            resolution_operator_id = $1,
            reviewed_at = NOW()
      WHERE id = $2`,
    [newId, row.id],
  );
  return newId;
}

export async function addAlias(
  client: pg.PoolClient,
  row: PendingRow,
  candidate: CandidateRef,
): Promise<void> {
  await approveMatch(client, row, candidate);
  await client.query(
    `INSERT INTO operator_aliases
       (operator_id, alias, alias_normalized, alias_type, source)
     VALUES ($1, $2, $3, 'dba', $4)
     ON CONFLICT (operator_id, alias_normalized) DO NOTHING`,
    [candidate.operator_id, row.scraped_name, normalize(row.scraped_name), row.scraped_source],
  );
}

export async function escalate(client: pg.PoolClient, row: PendingRow): Promise<void> {
  const prefix = "[ESCALATED] ";
  const newNotes = row.reviewer_notes
    ? `${prefix}${row.reviewer_notes}`
    : prefix.trim();
  await client.query(
    `UPDATE operator_match_review
        SET status = 'skipped',
            reviewer_notes = $1,
            reviewed_at = NOW()
      WHERE id = $2`,
    [newNotes, row.id],
  );
}

// ── Readline wrapper ─────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (ans) => {
      rl.close();
      res(ans);
    });
  });
}

// ── Env load ─────────────────────────────────────────────────────────────

function loadEnv(): void {
  try {
    const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* .env not found — fine */
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error("operators:review requires DATABASE_TYPE=postgres");
  }

  // Hard pre-flight gate.
  if (!isCalibrated()) {
    console.error(`\n[review] REFUSING TO RUN: match-thresholds.ts has calibrated_at = null.`);
    console.error(`[review] Run commit 8b calibration first: npm run operators:calibrate -- --score\n`);
    process.exit(2);
  }
  console.log(
    `[review] Calibration OK: calibrated_at=${THRESHOLDS.calibrated_at} (sample_size=${THRESHOLDS.calibrated_sample_size})`,
  );

  const { limit, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(`Usage: npm run operators:review [-- --limit N]`);
    return;
  }

  const pool = getPool();
  const client = await pool.connect();
  let processed = 0;
  let matched = 0;
  let newOps = 0;
  let deferred = 0;
  let aliased = 0;
  let escalated = 0;

  try {
    const rows = await loadPending(client, limit);
    console.log(`[review] Loaded ${rows.length} pending review rows.\n`);
    if (rows.length === 0) {
      console.log(`[review] Queue is empty. Nothing to review.`);
      return;
    }

    outer: for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      console.log(formatRowDisplay(row, i + 1, rows.length));
      inner: for (;;) {
        const ans = await prompt(`Action [a/n/r/l/d/e/q]: `);
        const action = parseActionKey(ans);
        if (!action) {
          console.log(`  ? unrecognised, try again`);
          continue inner;
        }
        try {
          switch (action) {
            case "approve": {
              const top = row.candidate_matches[0];
              if (!top) {
                console.log(`  ! no candidates available; use 'r' to create new`);
                continue inner;
              }
              await approveMatch(client, row, top);
              console.log(`  ✓ matched '${row.scraped_name}' → '${top.canonical_name}'`);
              matched++;
              break;
            }
            case "pick-other": {
              if (row.candidate_matches.length < 2) {
                console.log(`  ! only one candidate available; use 'a' to approve it or 'r' to reject`);
                continue inner;
              }
              const pickStr = await prompt(`  Pick candidate # (1-${row.candidate_matches.length}): `);
              const pickIdx = Number.parseInt(pickStr.trim(), 10) - 1;
              if (Number.isNaN(pickIdx) || pickIdx < 0 || pickIdx >= row.candidate_matches.length) {
                console.log(`  ? invalid candidate number`);
                continue inner;
              }
              const picked = row.candidate_matches[pickIdx]!;
              await approveMatch(client, row, picked);
              console.log(`  ✓ matched '${row.scraped_name}' → '${picked.canonical_name}' (picked #${pickIdx + 1})`);
              matched++;
              break;
            }
            case "reject": {
              const newId = await rejectAndCreateNew(client, row);
              console.log(`  ✓ created new operator ${newId} for '${row.scraped_name}'`);
              newOps++;
              break;
            }
            case "defer": {
              console.log(`  → deferred (stays pending)`);
              deferred++;
              break;
            }
            case "add-alias": {
              const top = row.candidate_matches[0];
              if (!top) {
                console.log(`  ! no candidates available; use 'r' to create new`);
                continue inner;
              }
              await addAlias(client, row, top);
              console.log(`  ✓ matched + added '${row.scraped_name}' as alias of '${top.canonical_name}'`);
              aliased++;
              break;
            }
            case "escalate": {
              await escalate(client, row);
              console.log(`  ⚠ escalated '${row.scraped_name}'`);
              escalated++;
              break;
            }
            case "quit": {
              console.log(`  → quitting`);
              break outer;
            }
          }
        } catch (err) {
          log.error({ err, row_id: row.id }, "action failed");
          console.log(`  ✗ action failed: ${err instanceof Error ? err.message : String(err)}`);
          console.log(`  → row stays pending; retry with next row`);
        }
        processed++;
        break inner;
      }
    }

    console.log(`\n[review] Session summary:`);
    console.log(`  Processed:  ${processed}`);
    console.log(`  Matched:    ${matched}`);
    console.log(`  Aliased:    ${aliased}`);
    console.log(`  New ops:    ${newOps}`);
    console.log(`  Deferred:   ${deferred}`);
    console.log(`  Escalated:  ${escalated}`);
  } finally {
    client.release();
    await closePg();
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, "operators-review fatal error");
    process.exit(1);
  });
}
