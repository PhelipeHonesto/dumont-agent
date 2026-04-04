/**
 * Scenario Runner — reads scenario JSON files, feeds each through the full
 * Dumont Agent pipeline, and reports pass/fail with stage-by-stage results.
 *
 * Usage: npm run sim
 *    or: npx tsx src/run-sim.ts
 *    or: npx tsx src/run-sim.ts --scenario S01
 *
 * Target: beat the old simulator's 72% pass rate.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createDealContext, updateDealContext } from "./orchestrator/deal-context-manager.js";
import { advanceStage } from "./orchestrator/stage-transitions.js";
import { closeDeal } from "./orchestrator/index.js";
import type { DealContext } from "./schemas/deal-context.js";

import { intake } from "./capabilities/intake.js";
import { guardian } from "./capabilities/guardian.js";
import { estimate } from "./capabilities/quote.js";
import { quote } from "./capabilities/quote.js";
import { sourcing } from "./capabilities/sourcing.js";
import { scenario } from "./capabilities/scenario.js";

import { DealStore } from "./memory/deal-store.js";
import { AviapagesClient } from "./integrations/aviapages.js";
import type { FetchFn } from "./integrations/aviapages.js";

import {
  AIRPORTS, OPERATORS, OPERATOR_CERTS, mockAviapagesEstimate,
} from "./fixtures/sim-data.js";

// ── Types ────────────────────────────────────────────────────────────────

interface ScenarioFile {
  meta: { version: string; target_pass_rate: number; total_scenarios: number };
  scenarios: Scenario[];
}

interface Scenario {
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
}

type StageResult = { stage: string; status: "pass" | "fail" | "skip"; detail: string; durationMs: number };

interface ScenarioResult {
  id: string;
  title: string;
  category: string;
  passed: boolean;
  stages: StageResult[];
  finalStage: string;
  osaPrice: number | null;
  failReason: string | null;
  wallClockMs: number;
}

// ── Mock Aviapages Client ────────────────────────────────────────────────

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
  return new AviapagesClient({ apiKey: "sim-mock" }, mockFetch);
}

// ── Run Single Scenario ──────────────────────────────────────────────────

async function runScenario(
  sc: Scenario,
  dealStore: DealStore,
  aviapages: AviapagesClient,
): Promise<ScenarioResult> {
  const startTime = Date.now();
  const stages: StageResult[] = [];
  let failReason: string | null = null;

  const ctx = createDealContext("sim");

  function stageOk(stage: string, detail: string, start: number) {
    stages.push({ stage, status: "pass", detail, durationMs: Date.now() - start });
  }
  function stageFail(stage: string, detail: string, start: number) {
    stages.push({ stage, status: "fail", detail, durationMs: Date.now() - start });
    failReason = detail;
  }

  try {
    // ── 1. INTAKE ──────────────────────────────────────────────────
    let t = Date.now();
    // Use local-time March 31 (not UTC) to avoid timezone shift issues
    const intakeResult = await intake(sc.request, ctx, {
      today: new Date(2026, 2, 31), // month is 0-indexed: 2 = March
      dealStore,
    });
    updateDealContext(ctx, { client: intakeResult.client, trip: intakeResult.trip });

    if (!ctx.client.qualified) {
      stageFail("INTAKE", `Not qualified: ${ctx.client.qualificationReason}`, t);
      if (sc.expected.failReason === "qualification") {
        return buildResult(sc, true, stages, ctx, startTime, "Expected qualification failure");
      }
      return buildResult(sc, false, stages, ctx, startTime, failReason);
    }
    stageOk("INTAKE", `${ctx.trip.departure}→${ctx.trip.arrival} ${ctx.trip.pax}pax`, t);

    // ── 2. GUARDIAN: intake ────────────────────────────────────────
    t = Date.now();
    const gIntake = await guardian("intake", ctx, { airports: AIRPORTS, operatorCerts: OPERATOR_CERTS });
    ctx.guardian.passes.push(gIntake.pass);
    if (!gIntake.pass.passed) {
      stageFail("GUARDIAN:INT", gIntake.pass.checks.filter((c) => !c.passed).map((c) => c.message).join("; "), t);
      if (sc.expected.failReason === "pax") {
        return buildResult(sc, true, stages, ctx, startTime, "Expected pax/range failure");
      }
      return buildResult(sc, false, stages, ctx, startTime, failReason);
    }
    stageOk("GUARDIAN:INT", `${gIntake.pass.checks.length} checks clear`, t);

    advanceStage(ctx, "qualified");

    // Budget gate
    if (!ctx.client.budget) {
      stages.push({ stage: "BUDGET", status: "fail", detail: "No budget — pipeline paused", durationMs: 0 });
      if (sc.expected.failReason === "no_budget") {
        return buildResult(sc, true, stages, ctx, startTime, "Expected no-budget pause");
      }
      return buildResult(sc, false, stages, ctx, startTime, "No budget provided");
    }

    // ── 3. ESTIMATE ───────────────────────────────────────────────
    t = Date.now();
    advanceStage(ctx, "estimated");
    const estResult = await estimate(ctx, { aviapages, dealStore });
    updateDealContext(ctx, { estimate: estResult.estimate });

    if (!ctx.estimate.priceRange) {
      stageFail("ESTIMATE", "No price estimate returned", t);
      return buildResult(sc, false, stages, ctx, startTime, failReason);
    }
    stageOk("ESTIMATE", `$${ctx.estimate.priceRange.low.toLocaleString()}–$${ctx.estimate.priceRange.high.toLocaleString()}`, t);

    // ── 4. GUARDIAN: estimate ─────────────────────────────────────
    t = Date.now();
    const gEst = await guardian("estimated", ctx, { airports: AIRPORTS });
    ctx.guardian.passes.push(gEst.pass);
    if (!gEst.pass.passed) {
      stageFail("GUARDIAN:EST", gEst.pass.checks.filter((c) => !c.passed).map((c) => c.message).join("; "), t);
      if (sc.expected.failReason === "budget") {
        return buildResult(sc, true, stages, ctx, startTime, "Expected budget mismatch");
      }
      return buildResult(sc, false, stages, ctx, startTime, failReason);
    }
    stageOk("GUARDIAN:EST", "Budget overlaps estimate", t);

    // ── 5. SOURCING ───────────────────────────────────────────────
    t = Date.now();
    advanceStage(ctx, "sourced");
    const depAirport = AIRPORTS.get(ctx.trip.departure) ?? null;
    const srcResult = await sourcing(ctx, {
      operators: OPERATORS,
      departureAirport: depAirport,
      dealStore,
    });
    updateDealContext(ctx, { sourcing: srcResult.sourcing });

    if (!ctx.sourcing.selectedOperator) {
      stageFail("SOURCING", "No operator matched", t);
      if (sc.expected.failReason === "pax") {
        return buildResult(sc, true, stages, ctx, startTime, "Expected no-match (pax too high)");
      }
      return buildResult(sc, false, stages, ctx, startTime, failReason);
    }
    stageOk("SOURCING", `${ctx.sourcing.selectedOperator.operatorName} (${ctx.sourcing.selectedOperator.aircraftType})`, t);

    // ── 6. GUARDIAN: sourced ──────────────────────────────────────
    t = Date.now();
    const gSrc = await guardian("sourced", ctx, { airports: AIRPORTS, operatorCerts: OPERATOR_CERTS });
    ctx.guardian.passes.push(gSrc.pass);
    stageOk("GUARDIAN:SRC", `${gSrc.pass.passed ? "Clear" : "Warning"}`, t);

    // ── 7. QUOTE (sim: use estimate median as operator price) ────
    t = Date.now();
    advanceStage(ctx, "quoted");
    const estimateMedian = ctx.estimate.priceRange
      ? Math.round((ctx.estimate.priceRange.low + ctx.estimate.priceRange.high) / 2)
      : 30000;
    const quoteResult = await quote(ctx, {
      operatorPrice: estimateMedian,
      aircraft: ctx.quote.aircraft ?? (ctx.sourcing.selectedOperator ? {
        type: ctx.sourcing.selectedOperator.aircraftType,
        tail: ctx.sourcing.selectedOperator.aircraftTail ?? "N/A",
        year: 2022,
      } : undefined) ?? undefined,
    });
    updateDealContext(ctx, { quote: quoteResult.quote });
    stageOk("QUOTE", `Op: $${estimateMedian.toLocaleString()} → OSA: $${ctx.quote.osaPrice?.toLocaleString()}`, t);

    // ── 8. GUARDIAN: quoted ───────────────────────────────────────
    t = Date.now();
    const gQuote = await guardian("quoted", ctx);
    ctx.guardian.passes.push(gQuote.pass);
    stageOk("GUARDIAN:QOT", `${gQuote.pass.passed ? "Clear" : "Warning"}`, t);

    // ── 9. SCENARIO (presentation) ───────────────────────────────
    t = Date.now();
    advanceStage(ctx, "presented");
    try {
      await scenario(ctx);
      ctx.presentation.sentAt = new Date().toISOString();
      ctx.presentation.timerStarted = new Date().toISOString();
      ctx.presentation.clientDecision = "pending";
      stageOk("SCENARIO", "Presentation built", t);
    } catch (err) {
      stageFail("SCENARIO", err instanceof Error ? err.message : String(err), t);
      return buildResult(sc, false, stages, ctx, startTime, failReason);
    }

    // ── 10. CLOSE DEAL ───────────────────────────────────────────
    t = Date.now();
    ctx.presentation.clientDecision = "confirmed";
    ctx.presentation.decisionAt = new Date().toISOString();
    closeDeal(ctx, {
      result: "closed",
      dealStore,
      airports: AIRPORTS,
      operatorResponseTime: 1800,
    });
    stageOk("CLOSE", `Revenue: $${ctx.outcome.revenue?.toLocaleString() ?? 0}`, t);

    return buildResult(sc, true, stages, ctx, startTime, null);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stages.push({ stage: "ERROR", status: "fail", detail: msg, durationMs: Date.now() - startTime });
    return buildResult(sc, false, stages, ctx, startTime, msg);
  }
}

function buildResult(
  sc: Scenario,
  passed: boolean,
  stages: StageResult[],
  ctx: DealContext,
  startTime: number,
  failReason: string | null,
): ScenarioResult {
  // Auto-score: check expected vs actual
  let autoPass = passed;
  const exp = sc.expected;

  if (exp.shouldClose && ctx.stage !== "closed") autoPass = false;
  if (!exp.shouldClose && ctx.stage === "closed") autoPass = false;

  // Check route parsing (only if expected non-null)
  if (exp.departure && ctx.trip.departure !== exp.departure) autoPass = false;
  if (exp.arrival && ctx.trip.arrival !== exp.arrival) autoPass = false;
  if (exp.pax !== null && ctx.trip.pax !== exp.pax) autoPass = false;

  return {
    id: sc.id,
    title: sc.title,
    category: sc.category,
    passed: autoPass,
    stages,
    finalStage: ctx.stage,
    osaPrice: ctx.quote.osaPrice,
    failReason: autoPass ? null : failReason,
    wallClockMs: Date.now() - startTime,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const scenariosPath = resolve(__dirname, "..", "scenarios", "scenarios.json");
  const file: ScenarioFile = JSON.parse(readFileSync(scenariosPath, "utf-8"));

  // Parse --scenario flag
  const args = process.argv.slice(2);
  const singleId = args.indexOf("--scenario") >= 0 ? args[args.indexOf("--scenario") + 1] : null;

  const scenarios = singleId
    ? file.scenarios.filter((s) => s.id === singleId)
    : file.scenarios;

  if (scenarios.length === 0) {
    console.error(`No scenarios found${singleId ? ` matching ${singleId}` : ""}`);
    process.exit(1);
  }

  const dealStore = new DealStore(resolve(__dirname, "..", "data", "sim-deals.json"));
  const aviapages = createMockAviapages();

  const hr = "=".repeat(72);
  console.log(`\n  ${hr}`);
  console.log(`  DUMONT AGENT — Scenario Runner`);
  console.log(`  ${scenarios.length} scenarios · target ${file.meta.target_pass_rate}% pass rate`);
  console.log(`  ${hr}\n`);

  const results: ScenarioResult[] = [];

  for (const sc of scenarios) {
    const result = await runScenario(sc, dealStore, aviapages);
    results.push(result);

    const icon = result.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    const price = result.osaPrice ? `$${result.osaPrice.toLocaleString()}` : "—";
    const stageStr = result.stages
      .map((s) => s.status === "pass" ? `\x1b[32m${s.stage}\x1b[0m` : s.status === "fail" ? `\x1b[31m${s.stage}\x1b[0m` : `\x1b[90m${s.stage}\x1b[0m`)
      .join(" → ");

    console.log(`  [${result.id}] ${icon}  ${result.title}`);
    console.log(`         ${stageStr}`);
    if (result.osaPrice) {
      console.log(`         Price: ${price}  Time: ${result.wallClockMs}ms`);
    }
    if (result.failReason && !result.passed) {
      console.log(`         \x1b[31mReason: ${result.failReason}\x1b[0m`);
    }
    console.log();
  }

  // ── Summary ──────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const passRate = Math.round((passed / results.length) * 100);
  const target = file.meta.target_pass_rate;
  const beatTarget = passRate >= target;

  console.log(`  ${hr}`);
  console.log(`  RESULTS: ${passed} pass / ${failed} fail  (${passRate}% pass rate)`);
  console.log(`  TARGET:  ${target}%  ${beatTarget ? "\x1b[32m— TARGET MET\x1b[0m" : "\x1b[31m— BELOW TARGET\x1b[0m"}`);
  console.log();

  // Category breakdown
  const cats: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    if (!cats[r.category]) cats[r.category] = { pass: 0, total: 0 };
    cats[r.category]!.total++;
    if (r.passed) cats[r.category]!.pass++;
  }
  console.log("  Category Breakdown:");
  console.log("  " + "-".repeat(50));
  for (const [cat, stats] of Object.entries(cats).sort((a, b) => a[0].localeCompare(b[0]))) {
    const rate = Math.round((stats.pass / stats.total) * 100);
    const bar = "\x1b[32m" + "█".repeat(Math.round(rate / 5)) + "\x1b[90m" + "░".repeat(20 - Math.round(rate / 5)) + "\x1b[0m";
    console.log(`  ${cat.padEnd(25)} ${bar} ${rate}% (${stats.pass}/${stats.total})`);
  }

  // Deal store stats
  console.log(`\n  Learning Loop: ${dealStore.count} deals recorded`);
  console.log(`  ${hr}\n`);

  process.exit(beatTarget ? 0 : 1);
}

main().catch((err) => {
  console.error("Scenario runner failed:", err);
  process.exit(1);
});
