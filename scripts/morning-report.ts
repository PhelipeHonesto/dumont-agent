/**
 * Morning report — generates a markdown summary of the last 24 h of
 * ingestion + data-quality activity. Designed for a 0700 UTC cron on
 * Lightsail: runs, writes to ~/daily-report.md, emits to stdout too.
 *
 * No email/Slack plumbing in this commit; Sentry already catches
 * individual failures via the logger bridge. This report is for the
 * "what shipped last night" scan, not incident alerting.
 *
 * Usage:
 *   DATABASE_TYPE=postgres npm run report:morning
 *   DATABASE_TYPE=postgres npm run report:morning -- --window-hours 72
 *   DATABASE_TYPE=postgres npm run report:morning -- --out /tmp/report.md
 *
 * Lightsail cron (not installed automatically; see docs/operations.md):
 *   0 7 * * * cd /home/ubuntu/dumont-agent && \
 *     set -a && source .env && set +a && \
 *     export DATABASE_TYPE=postgres && \
 *     npm run report:morning -- --out /home/ubuntu/daily-report.md \
 *     >> /home/ubuntu/morning-report.log 2>&1
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { getPool, closePg } from "../src/memory/pg-database.js";
import { childLogger } from "../src/utils/logger.js";

const log = childLogger("morning-report");

// ── Types ────────────────────────────────────────────────────────────────

export interface PipelineRow {
  id: number;
  job_name: string;
  started_at: string;
  ended_at: string | null;
  status: "running" | "completed" | "failed";
  row_count_delta: number;
  error_message: string | null;
  metadata: Record<string, unknown>;
}

export interface DqRow {
  run_at: string;
  run_id: string | null;
  check_name: string | null;
  status: "pass" | "fail" | null;
  actual_value: string | null;
  threshold: string | null;
}

export interface ReportData {
  windowHours: number;
  generatedAt: string;
  pipelineRuns: PipelineRow[];
  dqRuns: DqRow[];
}

// ── Pure helpers (testable) ──────────────────────────────────────────────

export function parseArgs(argv: string[]): { windowHours: number; out: string | null } {
  let windowHours = 24;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--window-hours" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(n) && n > 0) windowHours = n;
    }
    if (argv[i] === "--out" && argv[i + 1]) {
      out = argv[i + 1]!;
    }
  }
  return { windowHours, out };
}

export function formatReport(data: ReportData): string {
  const lines: string[] = [];
  lines.push(`# Dumont morning report`);
  lines.push(``);
  lines.push(`Generated: \`${data.generatedAt}\`  ·  Window: last ${data.windowHours} h`);
  lines.push(``);

  // Pipeline summary
  const byJob = new Map<string, { completed: number; failed: number; running: number; rowDelta: number }>();
  for (const r of data.pipelineRuns) {
    const k = r.job_name;
    if (!byJob.has(k)) byJob.set(k, { completed: 0, failed: 0, running: 0, rowDelta: 0 });
    const b = byJob.get(k)!;
    if (r.status === "completed") b.completed++;
    else if (r.status === "failed") b.failed++;
    else b.running++;
    b.rowDelta += r.row_count_delta;
  }

  lines.push(`## Pipeline runs`);
  lines.push(``);
  if (byJob.size === 0) {
    lines.push(`_No pipeline runs recorded in the window._`);
  } else {
    lines.push(`| Job | Completed | Failed | Running | Row delta |`);
    lines.push(`|---|---:|---:|---:|---:|`);
    for (const [job, b] of [...byJob.entries()].sort()) {
      lines.push(`| \`${job}\` | ${b.completed} | ${b.failed} | ${b.running} | ${b.rowDelta.toLocaleString()} |`);
    }
  }
  lines.push(``);

  // Failures detail
  const failures = data.pipelineRuns.filter((r) => r.status === "failed");
  if (failures.length > 0) {
    lines.push(`### Pipeline failures`);
    lines.push(``);
    for (const f of failures) {
      lines.push(`- **${f.job_name}** at \`${f.started_at}\` — ${f.error_message ?? "(no message)"}`);
    }
    lines.push(``);
  }

  // DQ summary
  lines.push(`## Data quality`);
  lines.push(``);
  if (data.dqRuns.length === 0) {
    lines.push(`_No DQ runs recorded in the window._`);
  } else {
    const perCheck = data.dqRuns.filter((r) => r.run_id !== null);
    const totalPerCheck = perCheck.length;
    const failed = perCheck.filter((r) => r.status === "fail").length;
    lines.push(`Per-check rows: **${totalPerCheck - failed}/${totalPerCheck} passed**, ${failed} failed.`);
    lines.push(``);
    if (failed > 0) {
      lines.push(`### DQ failures`);
      lines.push(``);
      for (const r of perCheck.filter((p) => p.status === "fail")) {
        lines.push(`- **${r.check_name}** at \`${r.run_at}\` — actual=\`${r.actual_value}\` threshold=\`${r.threshold}\``);
      }
      lines.push(``);
    }
  }

  return lines.join("\n") + "\n";
}

// ── DB queries ───────────────────────────────────────────────────────────

async function loadPipelineRuns(client: pg.PoolClient, windowHours: number): Promise<PipelineRow[]> {
  const cutoff = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const res = await client.query<PipelineRow>(
    `SELECT id, job_name, started_at, ended_at, status,
            COALESCE(row_count_delta, 0) AS row_count_delta,
            error_message,
            COALESCE(metadata, '{}'::jsonb) AS metadata
       FROM pipeline_runs
      WHERE started_at >= $1
      ORDER BY started_at DESC`,
    [cutoff],
  );
  return res.rows;
}

async function loadDqRuns(client: pg.PoolClient, windowHours: number): Promise<DqRow[]> {
  const cutoff = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const res = await client.query<DqRow>(
    `SELECT run_at::text, run_id::text, check_name, status, actual_value, threshold
       FROM data_quality_runs
      WHERE run_at >= $1::timestamptz
      ORDER BY run_at DESC`,
    [cutoff],
  );
  return res.rows;
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
    /* .env not found */
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error("morning-report requires DATABASE_TYPE=postgres");
  }
  const { windowHours, out } = parseArgs(process.argv.slice(2));

  const pool = getPool();
  const client = await pool.connect();
  try {
    const [pipelineRuns, dqRuns] = await Promise.all([
      loadPipelineRuns(client, windowHours),
      loadDqRuns(client, windowHours),
    ]);
    const data: ReportData = {
      windowHours,
      generatedAt: new Date().toISOString(),
      pipelineRuns,
      dqRuns,
    };
    const md = formatReport(data);
    process.stdout.write(md);
    if (out) {
      writeFileSync(out, md, "utf-8");
      console.log(`\n[morning-report] written to ${out}`);
    }
  } finally {
    client.release();
    await closePg();
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, "morning-report fatal error");
    process.exit(1);
  });
}
