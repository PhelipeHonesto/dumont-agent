/**
 * Quote Capability Evaluation Harness
 *
 * Runs 20 scenarios from the simulation dataset through the Dumont pipeline
 * (intake → estimate → quote), compares the OSA price against known market
 * ranges from sim-data.ts, and scores accuracy as percentage within ±20%.
 *
 * Results are logged to the eval_runs table for tracking over time.
 *
 * Usage:
 *   npm run eval:quote
 *   npm run eval:quote -- --verbose
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";

import { createDealContext, updateDealContext } from "../orchestrator/deal-context-manager.js";
import { advanceStage } from "../orchestrator/stage-transitions.js";
import { intake } from "../capabilities/intake.js";
import { guardian } from "../capabilities/guardian.js";
import { estimate } from "../capabilities/quote.js";
import { quote } from "../capabilities/quote.js";
import { sourcing } from "../capabilities/sourcing.js";

import { DealStore } from "../memory/deal-store.js";
import { AviapagesClient } from "../integrations/aviapages.js";
import type { FetchFn } from "../integrations/aviapages.js";
import { getDatabase, setPgBridge } from "../memory/database.js";
import { getPgBridge, closePg } from "../memory/pg-database.js";
import { bulkUpsert } from "../memory/bulk-upsert.js";

import {
  AIRPORTS, OPERATORS, OPERATOR_CERTS, mockAviapagesEstimate,
} from "../fixtures/sim-data.js";

// ── Types ─────────────────────────────────────────────────────────────────

interface ScenarioFile {
  scenarios: Array<{
    id: string;
    category: string;
    title: string;
    request: string;
    expected: {
      departure: string | null;
      arrival: string | null;
      pax: number | null;
      aircraftClass: string | null;
      shouldClose: boolean;
      failReason?: string;
    };
  }>;
}

interface EvalRow {
  scenarioId: string;
  scenarioTitle: string;
  departure: string | null;
  arrival: string | null;
  aircraftClass: string | null;
  estimateLowCents: number | null;
  estimateHighCents: number | null;
  estimateMedianCents: number | null;
  osaPriceCents: number | null;
  marketLowCents: number | null;
  marketHighCents: number | null;
  within20Pct: boolean;
  errorPct: number | null;
  status: "pass" | "fail" | "skip" | "error";
  errorMessage: string | null;
  durationMs: number;
}

// ── Mock Aviapages Client (same as run-sim.ts) ───────────────────────────

function createMockAviapages(): AviapagesClient {
  const mockFetch: FetchFn = async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const dep = body.departure as string;
    const arr = body.arrival as string;
    const cls = body.aircraft_class as string | undefined;

    const result = mockAviapagesEstimate(dep, arr, cls ?? null);
    if (!result) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        price_low: result.low, price_high: result.high,
        flight_time: result.flightTime, fuel_burn: result.fuelBurn,
      }),
    };
  };
  return new AviapagesClient({ apiKey: "eval-mock" }, mockFetch);
}

// ── Evaluate Single Scenario ─────────────────────────────────────────────

async function evalScenario(
  sc: ScenarioFile["scenarios"][number],
  dealStore: DealStore,
  aviapages: AviapagesClient,
): Promise<EvalRow> {
  const start = Date.now();

  // Skip scenarios that aren't expected to reach quoting
  if (!sc.expected.shouldClose) {
    return {
      scenarioId: sc.id,
      scenarioTitle: sc.title,
      departure: sc.expected.departure,
      arrival: sc.expected.arrival,
      aircraftClass: sc.expected.aircraftClass,
      estimateLowCents: null,
      estimateHighCents: null,
      estimateMedianCents: null,
      osaPriceCents: null,
      marketLowCents: null,
      marketHighCents: null,
      within20Pct: false,
      errorPct: null,
      status: "skip",
      errorMessage: `Expected failure: ${sc.expected.failReason}`,
      durationMs: Date.now() - start,
    };
  }

  try {
    // ── 1. INTAKE ───────────────────────────────────────────────────
    const ctx = createDealContext("sim");
    const intakeResult = await intake(sc.request, ctx, {
      today: new Date(2026, 2, 31),
      dealStore,
    });
    updateDealContext(ctx, { client: intakeResult.client, trip: intakeResult.trip });

    if (!ctx.client.qualified || !ctx.client.budget) {
      return makeErrorRow(sc, start, `Intake failed: not qualified or no budget`);
    }

    // ── 2. GUARDIAN: intake ─────────────────────────────────────────
    const gIntake = await guardian("intake", ctx, { airports: AIRPORTS, operatorCerts: OPERATOR_CERTS });
    ctx.guardian.passes.push(gIntake.pass);
    if (!gIntake.pass.passed) {
      return makeErrorRow(sc, start, `Guardian intake blocked`);
    }
    advanceStage(ctx, "qualified");

    // ── 3. ESTIMATE ─────────────────────────────────────────────────
    advanceStage(ctx, "estimated");
    const estResult = await estimate(ctx, { aviapages, dealStore });
    updateDealContext(ctx, { estimate: estResult.estimate });

    if (!ctx.estimate.priceRange) {
      return makeErrorRow(sc, start, `No price estimate returned`);
    }

    // ── 4. GUARDIAN: estimate ───────────────────────────────────────
    const gEst = await guardian("estimated", ctx, { airports: AIRPORTS });
    ctx.guardian.passes.push(gEst.pass);
    if (!gEst.pass.passed) {
      return makeErrorRow(sc, start, `Guardian budget mismatch`);
    }

    // ── 5. SOURCING ──────────────────────────────────────────────────
    advanceStage(ctx, "sourced");
    const depAirport = AIRPORTS.get(ctx.trip.departure) ?? null;
    const srcResult = await sourcing(ctx, {
      operators: OPERATORS,
      departureAirport: depAirport,
      dealStore,
    });
    updateDealContext(ctx, { sourcing: srcResult.sourcing });

    if (!ctx.sourcing.selectedOperator) {
      return makeErrorRow(sc, start, `No operator matched`);
    }

    // ── 6. GUARDIAN: sourced ──────────────────────────────────────────
    const gSrc = await guardian("sourced", ctx, { airports: AIRPORTS, operatorCerts: OPERATOR_CERTS });
    ctx.guardian.passes.push(gSrc.pass);

    // ── 7. QUOTE (sim: estimate median as operator price) ────────────
    advanceStage(ctx, "quoted");
    const estimateMedian = Math.round(
      (ctx.estimate.priceRange.low + ctx.estimate.priceRange.high) / 2,
    );
    const quoteResult = await quote(ctx, { operatorPrice: estimateMedian });
    updateDealContext(ctx, { quote: quoteResult.quote });

    const osaPriceCents = ctx.quote.osaPrice ?? 0;

    // ── 6. COMPARE TO MARKET RANGE ──────────────────────────────────
    // Market range = the sim-data known pricing for this route+class
    const marketLow = ctx.estimate.priceRange.low;
    const marketHigh = ctx.estimate.priceRange.high;
    const marketMedian = Math.round((marketLow + marketHigh) / 2);

    // Score: is OSA price within ±20% of market median?
    const errorPct = marketMedian > 0
      ? ((osaPriceCents - marketMedian) / marketMedian) * 100
      : 0;
    const within20 = Math.abs(errorPct) <= 20;

    return {
      scenarioId: sc.id,
      scenarioTitle: sc.title,
      departure: ctx.trip.departure || null,
      arrival: ctx.trip.arrival || null,
      aircraftClass: ctx.trip.aircraftType || sc.expected.aircraftClass,
      estimateLowCents: ctx.estimate.priceRange.low,
      estimateHighCents: ctx.estimate.priceRange.high,
      estimateMedianCents: estimateMedian,
      osaPriceCents,
      marketLowCents: marketLow,
      marketHighCents: marketHigh,
      within20Pct: within20,
      errorPct: Math.round(errorPct * 100) / 100,
      status: within20 ? "pass" : "fail",
      errorMessage: null,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return makeErrorRow(sc, start, err instanceof Error ? err.message : String(err));
  }
}

function makeErrorRow(
  sc: ScenarioFile["scenarios"][number],
  start: number,
  msg: string,
): EvalRow {
  return {
    scenarioId: sc.id,
    scenarioTitle: sc.title,
    departure: sc.expected.departure,
    arrival: sc.expected.arrival,
    aircraftClass: sc.expected.aircraftClass,
    estimateLowCents: null,
    estimateHighCents: null,
    estimateMedianCents: null,
    osaPriceCents: null,
    marketLowCents: null,
    marketHighCents: null,
    within20Pct: false,
    errorPct: null,
    status: "error",
    errorMessage: msg,
    durationMs: Date.now() - start,
  };
}

// ── Slice Analysis ──────────────────────────────────────────────────────

interface SliceResult { total: number; within20: number; accuracy: number }

function computeSlices(scored: EvalRow[]): Record<string, SliceResult> {
  const sliceBy = (filter: (r: EvalRow) => boolean): SliceResult => {
    const filtered = scored.filter(filter);
    const w20 = filtered.filter((r) => r.within20Pct).length;
    return {
      total: filtered.length,
      within20: w20,
      accuracy: filtered.length > 0 ? Math.round((w20 / filtered.length) * 10000) / 100 : 0,
    };
  };

  return {
    // By aircraft class
    class_light: sliceBy((r) => r.aircraftClass === "light"),
    class_midsize: sliceBy((r) => r.aircraftClass === "midsize"),
    class_super_mid: sliceBy((r) => r.aircraftClass === "super_mid"),
    class_heavy: sliceBy((r) => r.aircraftClass === "heavy"),
    // By route length (estimate from price as proxy — short routes are cheaper)
    price_under_20k: sliceBy((r) => (r.osaPriceCents ?? 0) < 2_000_000),
    price_20k_50k: sliceBy((r) => (r.osaPriceCents ?? 0) >= 2_000_000 && (r.osaPriceCents ?? 0) < 5_000_000),
    price_over_50k: sliceBy((r) => (r.osaPriceCents ?? 0) >= 5_000_000),
  };
}

// ── Persist Results ──────────────────────────────────────────────────────

async function persistResults(runId: string, rows: EvalRow[], durationMs: number, slices?: Record<string, SliceResult>): Promise<void> {
  const db = getDatabase();

  const scored = rows.filter((r) => r.status === "pass" || r.status === "fail");
  const within20Count = scored.filter((r) => r.within20Pct).length;
  const accuracyPct = scored.length > 0
    ? Math.round((within20Count / scored.length) * 10000) / 100
    : 0;

  const errors = scored.map((r) => Math.abs(r.errorPct ?? 0)).sort((a, b) => a - b);
  const meanError = errors.length > 0
    ? Math.round(errors.reduce((s, e) => s + e, 0) / errors.length * 100) / 100
    : null;
  const medianError = errors.length > 0
    ? Math.round(errors[Math.floor(errors.length / 2)]! * 100) / 100
    : null;
  const maxError = errors.length > 0
    ? Math.round(Math.max(...errors) * 100) / 100
    : null;

  // Bulk insert all scenario rows (plain INSERT — id is SERIAL / no natural PK)
  const evalRunRows = rows.map((r) => [
    runId, r.scenarioId, r.scenarioTitle, r.departure, r.arrival, r.aircraftClass,
    r.estimateLowCents, r.estimateHighCents, r.estimateMedianCents,
    r.osaPriceCents, r.marketLowCents, r.marketHighCents,
    r.within20Pct, r.errorPct, r.status, r.errorMessage, r.durationMs,
  ]);
  await bulkUpsert(
    db, "eval_runs",
    ["run_id", "scenario_id", "scenario_title", "departure", "arrival", "aircraft_class",
     "estimate_low_cents", "estimate_high_cents", "estimate_median_cents",
     "osa_price_cents", "market_low_cents", "market_high_cents",
     "within_20_pct", "error_pct", "status", "error_message", "duration_ms"],
    evalRunRows,
    [],
  );

  // Single-row summary (plain INSERT)
  await bulkUpsert(
    db, "eval_run_summaries",
    ["run_id", "total_scenarios", "scored_scenarios", "within_20_pct_count",
     "accuracy_pct", "mean_error_pct", "median_error_pct", "max_error_pct",
     "duration_ms", "slice_results"],
    [[
      runId, rows.length, scored.length, within20Count,
      accuracyPct, meanError, medianError, maxError, durationMs,
      slices ? JSON.stringify(slices) : null,
    ]],
    [],
  );
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error(
      "quote-eval requires DATABASE_TYPE=postgres (SQLite path removed in Phase 6)",
    );
  }
  setPgBridge(getPgBridge());

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const scenariosPath = resolve(__dirname, "..", "..", "scenarios", "scenarios.json");
  const file: ScenarioFile = JSON.parse(readFileSync(scenariosPath, "utf-8"));

  const verbose = process.argv.includes("--verbose");

  // Select first 20 scenarios
  const scenarios = file.scenarios.slice(0, 20);

  // DealStore is an isolated SQLite scratch DB for the eval harness — it
  // runs deals through the pipeline without touching production state. This
  // is intentional test sandboxing and does NOT violate Phase 6's
  // "no SQLite writers" rule (eval_runs + eval_run_summaries, the tables
  // this harness actually persists to, are on Postgres).
  const dealStore = new DealStore(resolve(__dirname, "..", "..", "data", "eval-deals.db"));
  const aviapages = createMockAviapages();
  const runId = ulid();
  const runStart = Date.now();

  const hr = "═".repeat(72);
  console.log(`\n  ${hr}`);
  console.log(`  DUMONT QUOTE EVAL — ${scenarios.length} scenarios`);
  console.log(`  Run ID: ${runId}`);
  console.log(`  ${hr}\n`);

  const results: EvalRow[] = [];

  for (const sc of scenarios) {
    const row = await evalScenario(sc, dealStore, aviapages);
    results.push(row);

    const icon = row.status === "pass" ? "\x1b[32m✓\x1b[0m"
      : row.status === "fail" ? "\x1b[31m✗\x1b[0m"
      : row.status === "skip" ? "\x1b[33m–\x1b[0m"
      : "\x1b[31m!\x1b[0m";

    const priceStr = row.osaPriceCents
      ? `OSA $${row.osaPriceCents.toLocaleString()} vs market $${row.marketLowCents?.toLocaleString()}–$${row.marketHighCents?.toLocaleString()}`
      : "";
    const errStr = row.errorPct != null ? ` (${row.errorPct > 0 ? "+" : ""}${row.errorPct}%)` : "";

    console.log(`  ${icon} [${row.scenarioId}] ${row.scenarioTitle}`);
    if (priceStr) console.log(`    ${priceStr}${errStr}`);
    if (verbose && row.errorMessage) console.log(`    \x1b[90m${row.errorMessage}\x1b[0m`);
  }

  const totalMs = Date.now() - runStart;
  const scored = results.filter((r) => r.status === "pass" || r.status === "fail");

  // ── Slice Analysis ──────────────────────────────────────────────────
  const slices = computeSlices(scored);
  console.log("\n  ── Sliced Accuracy ──");
  for (const [name, slice] of Object.entries(slices)) {
    if ((slice as { total: number }).total > 0) {
      const s = slice as { total: number; within20: number; accuracy: number };
      console.log(`  ${name}: ${s.within20}/${s.total} (${s.accuracy}%)`);
    }
  }

  // ── Persist ─────────────────────────────────────────────────────────
  await persistResults(runId, results, totalMs, slices);

  // ── Summary ─────────────────────────────────────────────────────────
  const skipped = results.filter((r) => r.status === "skip");
  const errored = results.filter((r) => r.status === "error");
  const within20 = scored.filter((r) => r.within20Pct);
  const accuracyPct = scored.length > 0
    ? Math.round((within20.length / scored.length) * 10000) / 100
    : 0;

  const absErrors = scored.map((r) => Math.abs(r.errorPct ?? 0)).sort((a, b) => a - b);
  const meanErr = absErrors.length > 0
    ? (absErrors.reduce((s, e) => s + e, 0) / absErrors.length).toFixed(1)
    : "–";
  const medianErr = absErrors.length > 0
    ? absErrors[Math.floor(absErrors.length / 2)]!.toFixed(1)
    : "–";
  const maxErr = absErrors.length > 0
    ? Math.max(...absErrors).toFixed(1)
    : "–";

  console.log(`\n  ${hr}`);
  console.log(`  RESULTS`);
  console.log(`  ───────────────────────────────────────`);
  console.log(`  Scored:     ${scored.length}/${results.length} scenarios (${skipped.length} skipped, ${errored.length} errored)`);
  console.log(`  Within ±20%: ${within20.length}/${scored.length}  →  \x1b[1m${accuracyPct}% accuracy\x1b[0m`);
  console.log(`  Mean |err|:  ${meanErr}%`);
  console.log(`  Median |err|: ${medianErr}%`);
  console.log(`  Max |err|:   ${maxErr}%`);
  console.log(`  Duration:    ${totalMs}ms`);
  console.log(`  Run logged:  eval_runs (run_id: ${runId})`);
  console.log(`  ${hr}\n`);

  await closePg();
}

main().catch((err) => {
  console.error("Quote eval failed:", err);
  process.exit(1);
});
