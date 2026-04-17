/**
 * Tests for Scenario capability — quote presentation, backup activation,
 * timer management.
 *
 * Coverage:
 * 1. Happy path: buildPresentation with all data present
 * 2. Backup activation by substitution preference type
 * 3. Timer threshold alerts (70% amber, 90% red, 100% expired)
 * 4. Missing data rejection
 * 5. Guardian pre-presentation validation
 * 6. Main scenario() entry point
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildPresentation,
  checkTimer,
  determineBackupAction,
  scenario,
  ScenarioError,
} from "../src/capabilities/scenario.js";
import type { QuotePresentation, TimerStatus, BackupAction } from "../src/capabilities/scenario.js";
import { checksBeforePresentation } from "../src/capabilities/guardian.js";
import type { DealContext } from "../src/schemas/deal-context.js";
import { createDealContext, updateDealContext } from "../src/orchestrator/deal-context-manager.js";
import { QUOTE_VALIDITY } from "../src/config.js";

// ── Test Fixtures ─────────────────────────────────────────────────────────

function makeOperatorMatch(overrides?: Partial<DealContext["sourcing"]["selectedOperator"]>) {
  return {
    operatorId: "op_001",
    operatorName: "Elite Aviation",
    phone: "+1-555-0100",
    baseAirport: "KTEB",
    aircraftType: "Phenom 300E",
    aircraftTail: "N300EA",
    score: 0.85,
    scoreBreakdown: { proximity: 0.9, laneHistory: 0.7, responseTime: 0.8, pricingAccuracy: 0.85, relationship: 0.8 },
    distanceToDeparture: 0,
    ...overrides,
  };
}

function makeFullDealCtx(overrides?: {
  substitutionPref?: DealContext["client"]["substitutionPref"];
  osaPrice?: number;
  validUntilMs?: number;
}): DealContext {
  const ctx = createDealContext("sim");
  const validUntil = new Date(Date.now() + (overrides?.validUntilMs ?? 120 * 60_000)).toISOString();
  updateDealContext(ctx, {
    trip: {
      departure: "KTEB",
      arrival: "KPBI",
      date: "2026-04-15",
      pax: 4,
      aircraftClass: "light",
      aircraftType: "Phenom 300E",
      isRoundTrip: false,
      specialRequirements: ["pets"],
    },
    client: {
      name: "Test Client",
      contact: "test@example.com",
      type: "new",
      budget: { min: 25000, max: 40000 },
      substitutionPref: overrides?.substitutionPref ?? null,
      qualified: true,
      qualificationReason: "Fully qualified",
    },
    sourcing: {
      selectedOperator: makeOperatorMatch(),
      backupOperator: makeOperatorMatch({
        operatorId: "op_002",
        operatorName: "Backup Air",
        aircraftTail: "N300BA",
        score: 0.75,
      }),
      rankingReason: "Elite Aviation selected (score: 0.85)",
      laneHistory: [],
    },
    quote: {
      operatorPrice: 28000,
      osaPrice: overrides?.osaPrice ?? 30435,
      margin: 0.08,
      validUntil,
      aircraft: { type: "Phenom 300E", tail: "N300EA", year: 2022 },
      quotedAt: new Date().toISOString(),
    },
  });
  return ctx;
}

// ── buildPresentation ────────────────────────────────────────────────────

describe("buildPresentation", () => {
  it("builds complete presentation from valid deal context", () => {
    const ctx = makeFullDealCtx();
    const pres = buildPresentation(ctx);

    expect(pres).not.toBeNull();
    const p = pres!;

    // Route
    expect(p.route.departure).toBe("KTEB");
    expect(p.route.arrival).toBe("KPBI");
    expect(p.route.date).toBe("2026-04-15");
    expect(p.route.isRoundTrip).toBe(false);

    // Aircraft
    expect(p.aircraft).not.toBeNull();
    expect(p.aircraft!.type).toBe("Phenom 300E");
    expect(p.aircraft!.tail).toBe("N300EA");
    expect(p.aircraft!.year).toBe(2022);
    expect(p.aircraft!.operatorName).toBe("Elite Aviation");

    // Pricing
    expect(p.pricing.totalAllIn).toBe(30435);
    expect(p.pricing.includes).toContain("crew");
    expect(p.pricing.includes).toContain("fuel");
    expect(p.pricing.includes).toContain("taxes");
    expect(p.pricing.validityMinutes).toBeGreaterThan(0);

    // Safety
    expect(p.safety.operatorName).toBe("Elite Aviation");
    expect(p.safety.guardianVerified).toBe(true);
    expect(p.safety.guardianStatus).toBe("clear");

    // Passengers + special
    expect(p.passengers).toBe(4);
    expect(p.specialRequirements).toContain("pets");
  });

  it("uses operator aircraft info when quote.aircraft is null", () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, {
      quote: { aircraft: null },
    });

    const pres = buildPresentation(ctx);
    expect(pres).not.toBeNull();
    expect(pres!.aircraft!.type).toBe("Phenom 300E");  // from operator
    expect(pres!.aircraft!.tail).toBe("N300EA");        // from operator
    expect(pres!.aircraft!.year).toBeNull();             // not available
  });

  it("reflects guardian warning status", () => {
    const ctx = makeFullDealCtx();
    ctx.guardian.currentStatus = "warning";

    const pres = buildPresentation(ctx);
    expect(pres!.safety.guardianVerified).toBe(true);  // not blocked
    expect(pres!.safety.guardianStatus).toBe("warning");
  });

  // ── Missing Data Rejection ─────────────────────────────────────────

  it("returns null when no operator selected", () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, {
      sourcing: { selectedOperator: null },
    });

    expect(buildPresentation(ctx)).toBeNull();
  });

  it("returns null when no OSA price", () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, {
      quote: { osaPrice: null },
    });

    expect(buildPresentation(ctx)).toBeNull();
  });

  it("returns null when no validity window", () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, {
      quote: { validUntil: null },
    });

    expect(buildPresentation(ctx)).toBeNull();
  });

  it("returns null when no departure", () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, {
      trip: { departure: "" },
    });

    expect(buildPresentation(ctx)).toBeNull();
  });

  it("returns null when no arrival", () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, {
      trip: { arrival: "" },
    });

    expect(buildPresentation(ctx)).toBeNull();
  });
});

// ── Timer Alerts ─────────────────────────────────────────────────────────

describe("checkTimer", () => {
  function makeTimerParams(elapsedPercent: number) {
    const totalMs = 120 * 60_000; // 120 min validity
    const startMs = Date.now() - totalMs * elapsedPercent;
    const endMs = startMs + totalMs;
    return {
      timerStarted: new Date(startMs).toISOString(),
      validUntil: new Date(endMs).toISOString(),
    };
  }

  it("returns 'none' when under 70% elapsed", () => {
    const { timerStarted, validUntil } = makeTimerParams(0.50);
    const status = checkTimer(timerStarted, validUntil);

    expect(status.level).toBe("none");
    expect(status.elapsedPercent).toBeCloseTo(0.50, 1);
    expect(status.remainingMinutes).toBeGreaterThan(50);
  });

  it("returns 'amber' at 70-89% elapsed", () => {
    const { timerStarted, validUntil } = makeTimerParams(0.75);
    const status = checkTimer(timerStarted, validUntil);

    expect(status.level).toBe("amber");
    expect(status.elapsedPercent).toBeCloseTo(0.75, 1);
  });

  it("returns 'red' at 90-99% elapsed", () => {
    const { timerStarted, validUntil } = makeTimerParams(0.92);
    const status = checkTimer(timerStarted, validUntil);

    expect(status.level).toBe("red");
    expect(status.remainingMinutes).toBeLessThan(15);
  });

  it("returns 'expired' at 100%+", () => {
    const { timerStarted, validUntil } = makeTimerParams(1.05);
    const status = checkTimer(timerStarted, validUntil);

    expect(status.level).toBe("expired");
    expect(status.remainingMinutes).toBe(0);
    expect(status.elapsedPercent).toBe(1);
  });

  it("returns 'expired' when validUntil equals timerStarted", () => {
    const now = new Date().toISOString();
    const status = checkTimer(now, now);
    expect(status.level).toBe("expired");
  });

  it("uses custom 'now' parameter for deterministic testing", () => {
    const start = new Date("2026-04-15T10:00:00Z");
    const end = new Date("2026-04-15T12:00:00Z"); // 2 hours
    // At 70% = 84 minutes in → 10:00 + 84 = 11:24
    const at70 = new Date("2026-04-15T11:24:00Z");

    const status = checkTimer(start.toISOString(), end.toISOString(), at70);
    expect(status.level).toBe("amber");
    expect(status.remainingMinutes).toBe(36);
  });

  it("transitions precisely at 70% threshold", () => {
    const start = new Date("2026-04-15T10:00:00Z");
    const end = new Date("2026-04-15T12:00:00Z");
    const atExact70 = new Date(start.getTime() + (end.getTime() - start.getTime()) * 0.70);

    const status = checkTimer(start.toISOString(), end.toISOString(), atExact70);
    expect(status.level).toBe("amber");
  });

  it("transitions precisely at 90% threshold", () => {
    const start = new Date("2026-04-15T10:00:00Z");
    const end = new Date("2026-04-15T12:00:00Z");
    const atExact90 = new Date(start.getTime() + (end.getTime() - start.getTime()) * 0.90);

    const status = checkTimer(start.toISOString(), end.toISOString(), atExact90);
    expect(status.level).toBe("red");
  });
});

// ── Backup Activation Logic ──────────────────────────────────────────────

describe("determineBackupAction", () => {
  it("auto_within_10pct: auto-presents when backup within 10%", () => {
    const ctx = makeFullDealCtx({ substitutionPref: "auto_within_10pct", osaPrice: 30000 });
    // Backup at $32,000 = +6.7% → within 10%
    const action = determineBackupAction(ctx, 32000);

    expect(action.action).toBe("auto_present");
    expect(action.reason).toContain("within 10%");
  });

  it("auto_within_10pct: pauses when backup exceeds 10%", () => {
    const ctx = makeFullDealCtx({ substitutionPref: "auto_within_10pct", osaPrice: 30000 });
    // Backup at $35,000 = +16.7% → exceeds 10%
    const action = determineBackupAction(ctx, 35000);

    expect(action.action).toBe("pause_for_approval");
    expect(action.reason).toContain("exceeds 10%");
  });

  it("always_approve: always pauses for client call", () => {
    const ctx = makeFullDealCtx({ substitutionPref: "always_approve" });
    const action = determineBackupAction(ctx, 30000);

    expect(action.action).toBe("pause_for_approval");
    expect(action.reason).toContain("always approve");
  });

  it("cancel_if_unavailable: closes deal", () => {
    const ctx = makeFullDealCtx({ substitutionPref: "cancel_if_unavailable" });
    const action = determineBackupAction(ctx, 30000);

    expect(action.action).toBe("cancel_deal");
    expect(action.reason).toContain("cancel if primary unavailable");
  });

  it("null preference (new client): defaults to pause_for_approval", () => {
    const ctx = makeFullDealCtx({ substitutionPref: null as any });
    const action = determineBackupAction(ctx, 30000);

    expect(action.action).toBe("pause_for_approval");
    expect(action.reason).toContain("New client");
  });

  it("returns no_backup when no backup operator exists", () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, {
      sourcing: { backupOperator: null },
    });
    const action = determineBackupAction(ctx, null);

    expect(action.action).toBe("no_backup");
    expect(action.reason).toContain("No backup");
  });

  it("pauses when backup exists but has no price", () => {
    const ctx = makeFullDealCtx({ substitutionPref: "auto_within_10pct" });
    const action = determineBackupAction(ctx, null);

    expect(action.action).toBe("pause_for_approval");
    expect(action.reason).toContain("no price yet");
  });

  it("auto_within_10pct: exact 10% boundary passes", () => {
    const ctx = makeFullDealCtx({ substitutionPref: "auto_within_10pct", osaPrice: 30000 });
    // Exactly 10% = $33,000
    const action = determineBackupAction(ctx, 33000);

    expect(action.action).toBe("auto_present");
  });

  it("auto_within_10pct: just over 10% fails", () => {
    const ctx = makeFullDealCtx({ substitutionPref: "auto_within_10pct", osaPrice: 30000 });
    // $33,001 = just over 10%
    const action = determineBackupAction(ctx, 33001);

    expect(action.action).toBe("pause_for_approval");
  });
});

// ── scenario() Main Entry Point ──────────────────────────────────────────

describe("scenario (main entry)", () => {
  it("returns presentation fields on happy path", async () => {
    const ctx = makeFullDealCtx();
    const result = await scenario(ctx);

    expect(result.presentation).toBeDefined();
    expect(result.presentation.sentAt).toBeNull();       // orchestrator fills
    expect(result.presentation.timerStarted).toBeNull();  // orchestrator fills
    expect(result.presentation.clientDecision).toBeNull(); // orchestrator sets pending
  });

  it("throws ScenarioError when operator missing", async () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, { sourcing: { selectedOperator: null } });

    await expect(scenario(ctx)).rejects.toThrow(ScenarioError);
    await expect(scenario(ctx)).rejects.toThrow("no operator selected");
  });

  it("throws ScenarioError when OSA price missing", async () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, { quote: { osaPrice: null } });

    await expect(scenario(ctx)).rejects.toThrow(ScenarioError);
    await expect(scenario(ctx)).rejects.toThrow("no OSA price");
  });

  it("throws ScenarioError when validity window missing", async () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, { quote: { validUntil: null } });

    await expect(scenario(ctx)).rejects.toThrow("no validity window");
  });

  it("throws ScenarioError listing all missing fields", async () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, {
      sourcing: { selectedOperator: null },
      quote: { osaPrice: null, validUntil: null },
    });

    try {
      await scenario(ctx);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ScenarioError);
      const msg = (err as ScenarioError).message;
      expect(msg).toContain("no operator selected");
      expect(msg).toContain("no OSA price");
      expect(msg).toContain("no validity window");
    }
  });
});

// ── Guardian Pre-Presentation Check ──────────────────────────────────────

describe("Guardian checksBeforePresentation", () => {
  it("passes with all data present", () => {
    const ctx = makeFullDealCtx();
    const checks = checksBeforePresentation(ctx);

    const failed = checks.filter((c) => !c.passed);
    expect(failed).toHaveLength(0);
    expect(checks.find((c) => c.name === "pre_present_complete")).toBeDefined();
  });

  it("fails when no operator selected", () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, { sourcing: { selectedOperator: null } });

    const checks = checksBeforePresentation(ctx);
    const opCheck = checks.find((c) => c.name === "pre_present_operator");
    expect(opCheck!.passed).toBe(false);
    expect(opCheck!.severity).toBe("critical");
  });

  it("fails when no OSA price", () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, { quote: { osaPrice: null } });

    const checks = checksBeforePresentation(ctx);
    const priceCheck = checks.find((c) => c.name === "pre_present_price");
    expect(priceCheck!.passed).toBe(false);
  });

  it("fails when no operator quote", () => {
    const ctx = makeFullDealCtx();
    updateDealContext(ctx, { quote: { operatorPrice: null } });

    const checks = checksBeforePresentation(ctx);
    const quoteCheck = checks.find((c) => c.name === "pre_present_quote");
    expect(quoteCheck!.passed).toBe(false);
  });
});

// ── End-to-End: Presentation + Timer + Backup ────────────────────────────

describe("end-to-end scenario flow", () => {
  it("full flow: build presentation → timer check → backup activation", () => {
    const ctx = makeFullDealCtx({ substitutionPref: "auto_within_10pct", osaPrice: 30000 });

    // Step 1: Build presentation
    const pres = buildPresentation(ctx);
    expect(pres).not.toBeNull();
    expect(pres!.pricing.totalAllIn).toBe(30000);

    // Step 2: Simulate timer at 75% (amber)
    const start = new Date("2026-04-15T10:00:00Z");
    const end = new Date("2026-04-15T12:00:00Z");
    const at75 = new Date("2026-04-15T11:30:00Z");
    const timerStatus = checkTimer(start.toISOString(), end.toISOString(), at75);
    expect(timerStatus.level).toBe("amber");

    // Step 3: Primary falls through at 92% (red zone)
    const at92 = new Date("2026-04-15T11:50:00Z");
    const redStatus = checkTimer(start.toISOString(), end.toISOString(), at92);
    expect(redStatus.level).toBe("red");

    // Step 4: Determine backup action — price within 10%
    const backupPrice = 32500; // +8.3% of $30,000
    const action = determineBackupAction(ctx, backupPrice);
    expect(action.action).toBe("auto_present");

    // Step 5: Would auto-present backup — verify different operator
    expect(ctx.sourcing.backupOperator!.operatorId).not.toBe(ctx.sourcing.selectedOperator!.operatorId);
  });

  it("cancel flow: cancel_if_unavailable preference", () => {
    const ctx = makeFullDealCtx({ substitutionPref: "cancel_if_unavailable" });

    const pres = buildPresentation(ctx);
    expect(pres).not.toBeNull();

    // Primary falls through
    const action = determineBackupAction(ctx, 32000);
    expect(action.action).toBe("cancel_deal");
  });
});
