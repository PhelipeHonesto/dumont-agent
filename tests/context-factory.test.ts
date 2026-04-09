/**
 * Tests for ContextFactory — stage-specific context slices from DealContext.
 * Covers every builder function, trimming logic, store injection, and mutation safety.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createDealContext,
  updateDealContext,
  _resetDealCounter,
} from "../src/orchestrator/deal-context-manager.js";
import {
  buildIntakeContext,
  buildGuardianContext,
  buildEstimateContext,
  buildPriceWallContext,
  buildSourcingContext,
  buildQuoteContext,
  buildPresentContext,
  buildRespondContext,
  type ContextFactoryStores,
} from "../src/orchestrator/context-factory.js";
import type { DealContext, GuardianPass } from "../src/schemas/deal-context.js";
import type { RouteIntel, OperatorProfile, ClientProfile } from "../src/schemas/composite-objects.js";

// ── Test Helpers ──────────────────────────────────────────────────────────

function makeGuardianPass(stage: string, index: number): GuardianPass {
  return {
    stage,
    passed: true,
    checks: [{ name: `check-${index}`, passed: true, severity: "info", message: "ok" }],
    timestamp: new Date().toISOString(),
  };
}

function makePopulatedCtx(): DealContext {
  const ctx = createDealContext("sim");
  updateDealContext(ctx, {
    client: {
      name: "John Doe",
      contact: "john@example.com",
      type: "repeat",
      budget: { min: 20000, max: 40000 },
      qualified: true,
      qualificationReason: "budget confirmed",
    },
    trip: {
      departure: "KTEB",
      arrival: "KMIA",
      date: "2026-05-01",
      pax: 4,
      aircraftClass: "midsize",
      aircraftType: "Citation XLS",
      isRoundTrip: false,
      specialRequirements: ["pets"],
    },
    estimate: {
      source: "aviapages",
      flightTime: 160,
      priceRange: { low: 22000, high: 28000 },
      fuelBurn: 1800,
      positioning: 50,
      calculatedAt: new Date().toISOString(),
    },
    sourcing: {
      selectedOperator: {
        operatorId: "OP-001",
        operatorName: "Priester Aviation",
        phone: "+13125551234",
        baseAirport: "KPWK",
        aircraftType: "Citation XLS",
        aircraftTail: "N123PA",
        score: 0.92,
        scoreBreakdown: {
          proximity: 0.95,
          laneHistory: 0.88,
          responseTime: 0.90,
          pricingAccuracy: 0.93,
          relationship: 0.94,
        },
        distanceToDeparture: 42,
      },
      backupOperator: null,
      rankingReason: "highest composite score",
      laneHistory: [],
    },
    quote: {
      operatorPrice: 24000,
      osaPrice: 26400,
      margin: 0.09,
      validUntil: "2026-05-02T00:00:00.000Z",
      aircraft: { type: "Citation XLS", tail: "N123PA", year: 2019 },
      quotedAt: new Date().toISOString(),
    },
  });
  ctx.stage = "quoted";
  return ctx;
}

function makeRouteIntel(): RouteIntel {
  return {
    route: "KTEB-KMIA",
    aircraftClass: "midsize",
    avgPrice30d: 25000,
    dealCount: 12,
    demandTrend: "stable",
    topOperators: ["Priester Aviation", "NetJets", "Flexjet"],
    seasonalFactor: 1.0,
    avgMarginDelta: 0.08,
    lastUpdated: new Date().toISOString(),
  };
}

function makeOperatorProfile(name: string): OperatorProfile {
  return {
    name,
    homeBase: "KPWK",
    certs: ["Part 135"],
    fleet: ["Citation XLS", "Phenom 300"],
    avgResponseTime: 25,
    reliabilityScore: 0.92,
    pricingDelta: 0.05,
    paymentSpeed: 3,
    quoteToBookRate: 0.6,
    cancelRate: 0.02,
    dealCount: 8,
    lastUpdated: new Date().toISOString(),
  };
}

function makeClientProfile(): ClientProfile {
  return {
    name: "John Doe",
    email: "john@example.com",
    dealHistory: [
      { route: "KTEB-KMIA", price: 25000, date: "2026-03-15", outcome: "closed" },
    ],
    avgPaymentTime: 4,
    totalSpend: 75000,
    tripFrequency: 6,
    preferredAircraftClass: "midsize",
    preferredRoutes: ["KTEB-KMIA"],
    lastUpdated: new Date().toISOString(),
  };
}

/** Minimal fake stores for injection. */
function makeFakeStores(options?: {
  routeIntel?: RouteIntel;
  operators?: OperatorProfile[];
  client?: ClientProfile;
}): ContextFactoryStores {
  return {
    routeIntel: {
      get: (route: string, aircraftClass: string) => {
        if (options?.routeIntel &&
            options.routeIntel.route === route &&
            options.routeIntel.aircraftClass === aircraftClass) {
          return options.routeIntel;
        }
        return null;
      },
    } as any,
    operatorProfiles: {
      getMany: (names: string[]) => {
        if (!options?.operators) return [];
        return options.operators.filter((o) => names.includes(o.name));
      },
    } as any,
    clientProfiles: {
      get: (nameOrEmail: string) => {
        if (options?.client &&
            (options.client.name.toLowerCase() === nameOrEmail.toLowerCase() ||
             options.client.email.toLowerCase() === nameOrEmail.toLowerCase())) {
          return options.client;
        }
        return null;
      },
    } as any,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("ContextFactory", () => {
  beforeEach(() => _resetDealCounter());

  // ── buildIntakeContext ─────────────────────────────────────────────────

  describe("buildIntakeContext", () => {
    it("returns rawMessage and null clientHistory without stores", () => {
      const result = buildIntakeContext("I need a flight from Teterboro to Miami");
      expect(result.rawMessage).toBe("I need a flight from Teterboro to Miami");
      expect(result.clientHistory).toBeNull();
    });

    it("returns null clientHistory when stores exist but no matching client", () => {
      const stores = makeFakeStores();
      const result = buildIntakeContext("Flight request", stores, "unknown@test.com");
      expect(result.clientHistory).toBeNull();
    });

    it("returns clientHistory when stores contain matching client", () => {
      const client = makeClientProfile();
      const stores = makeFakeStores({ client });
      const result = buildIntakeContext("Flight request", stores, "john@example.com");
      expect(result.clientHistory).not.toBeNull();
      expect(result.clientHistory!.name).toBe("John Doe");
      expect(result.clientHistory!.totalSpend).toBe(75000);
    });

    it("returns null clientHistory when clientNameOrEmail is undefined", () => {
      const client = makeClientProfile();
      const stores = makeFakeStores({ client });
      const result = buildIntakeContext("Flight request", stores);
      expect(result.clientHistory).toBeNull();
    });

    it("returns null clientHistory when stores are undefined but clientNameOrEmail is provided", () => {
      const result = buildIntakeContext("Flight request", undefined, "john@example.com");
      expect(result.clientHistory).toBeNull();
    });
  });

  // ── buildGuardianContext ──────────────────────────────────────────────

  describe("buildGuardianContext", () => {
    it("returns correct stage and trip fields", () => {
      const ctx = makePopulatedCtx();
      const result = buildGuardianContext("estimated", ctx);
      expect(result.stage).toBe("estimated");
      expect(result.trip.departure).toBe("KTEB");
      expect(result.trip.arrival).toBe("KMIA");
      expect(result.trip.pax).toBe(4);
      expect(result.trip.isRoundTrip).toBe(false);
      expect(result.trip.specialRequirements).toEqual(["pets"]);
    });

    it("returns empty recentGuardianPasses when ctx has 0 passes", () => {
      const ctx = createDealContext("sim");
      const result = buildGuardianContext("intake", ctx);
      expect(result.recentGuardianPasses).toEqual([]);
    });

    it("returns 1 pass when ctx has exactly 1 pass", () => {
      const ctx = createDealContext("sim");
      ctx.guardian.passes = [makeGuardianPass("intake", 1)];
      const result = buildGuardianContext("intake", ctx);
      expect(result.recentGuardianPasses).toHaveLength(1);
    });

    it("returns all 3 passes when ctx has exactly 3 passes (no trim)", () => {
      const ctx = createDealContext("sim");
      ctx.guardian.passes = [
        makeGuardianPass("intake", 1),
        makeGuardianPass("qualified", 2),
        makeGuardianPass("estimated", 3),
      ];
      const result = buildGuardianContext("sourced", ctx);
      expect(result.recentGuardianPasses).toHaveLength(3);
      expect(result.recentGuardianPasses[0]!.stage).toBe("intake");
      expect(result.recentGuardianPasses[2]!.stage).toBe("estimated");
    });

    it("trims to last 3 passes when ctx has 5 passes", () => {
      const ctx = createDealContext("sim");
      ctx.guardian.passes = [
        makeGuardianPass("intake", 1),
        makeGuardianPass("qualified", 2),
        makeGuardianPass("estimated", 3),
        makeGuardianPass("sourced", 4),
        makeGuardianPass("quoted", 5),
      ];
      const result = buildGuardianContext("presented", ctx);
      expect(result.recentGuardianPasses).toHaveLength(3);
      expect(result.recentGuardianPasses[0]!.stage).toBe("estimated");
      expect(result.recentGuardianPasses[1]!.stage).toBe("sourced");
      expect(result.recentGuardianPasses[2]!.stage).toBe("quoted");
    });

    it("returns null estimate when ctx has no priceRange", () => {
      const ctx = createDealContext("sim");
      const result = buildGuardianContext("intake", ctx);
      expect(result.estimate).toBeNull();
    });

    it("returns populated estimate when ctx has priceRange", () => {
      const ctx = makePopulatedCtx();
      const result = buildGuardianContext("estimated", ctx);
      expect(result.estimate).not.toBeNull();
      expect(result.estimate!.priceRange!.low).toBe(22000);
      expect(result.estimate!.flightTime).toBe(160);
    });

    it("returns null selectedOperator when none sourced", () => {
      const ctx = createDealContext("sim");
      const result = buildGuardianContext("intake", ctx);
      expect(result.selectedOperator).toBeNull();
    });

    it("returns selectedOperator subset when sourced", () => {
      const ctx = makePopulatedCtx();
      const result = buildGuardianContext("sourced", ctx);
      expect(result.selectedOperator).not.toBeNull();
      expect(result.selectedOperator!.operatorName).toBe("Priester Aviation");
      expect(result.selectedOperator!.baseAirport).toBe("KPWK");
      expect(result.selectedOperator!.aircraftType).toBe("Citation XLS");
      // Should NOT include full OperatorMatch fields like score
      expect((result.selectedOperator as any).score).toBeUndefined();
    });

    it("returns null quote when operatorPrice is null", () => {
      const ctx = createDealContext("sim");
      const result = buildGuardianContext("intake", ctx);
      expect(result.quote).toBeNull();
    });

    it("returns populated quote when operatorPrice is set", () => {
      const ctx = makePopulatedCtx();
      const result = buildGuardianContext("quoted", ctx);
      expect(result.quote).not.toBeNull();
      expect(result.quote!.operatorPrice).toBe(24000);
      expect(result.quote!.osaPrice).toBe(26400);
      expect(result.quote!.margin).toBe(0.09);
    });

    it("returns clientBudget when set on ctx", () => {
      const ctx = makePopulatedCtx();
      const result = buildGuardianContext("estimated", ctx);
      expect(result.clientBudget).not.toBeNull();
      expect(result.clientBudget!.min).toBe(20000);
      expect(result.clientBudget!.max).toBe(40000);
    });

    it("returns null clientBudget when not set", () => {
      const ctx = createDealContext("sim");
      const result = buildGuardianContext("intake", ctx);
      expect(result.clientBudget).toBeNull();
    });
  });

  // ── buildEstimateContext ──────────────────────────────────────────────

  describe("buildEstimateContext", () => {
    it("returns trip fields and null routeIntel without stores", () => {
      const ctx = makePopulatedCtx();
      const result = buildEstimateContext(ctx);
      expect(result.trip.departure).toBe("KTEB");
      expect(result.trip.arrival).toBe("KMIA");
      expect(result.trip.aircraftClass).toBe("midsize");
      expect(result.routeIntel).toBeNull();
    });

    it("returns routeIntel when store has matching route and aircraftClass", () => {
      const ctx = makePopulatedCtx();
      const intel = makeRouteIntel();
      const stores = makeFakeStores({ routeIntel: intel });
      const result = buildEstimateContext(ctx, stores);
      expect(result.routeIntel).not.toBeNull();
      expect(result.routeIntel!.route).toBe("KTEB-KMIA");
      expect(result.routeIntel!.avgPrice30d).toBe(25000);
    });

    it("returns null routeIntel when aircraftClass is null (even if store has data)", () => {
      const ctx = makePopulatedCtx();
      ctx.trip.aircraftClass = null;
      const intel = makeRouteIntel();
      const stores = makeFakeStores({ routeIntel: intel });
      const result = buildEstimateContext(ctx, stores);
      expect(result.routeIntel).toBeNull();
    });

    it("returns null routeIntel when store has no matching route", () => {
      const ctx = makePopulatedCtx();
      ctx.trip.departure = "KJFK";
      const intel = makeRouteIntel(); // KTEB-KMIA
      const stores = makeFakeStores({ routeIntel: intel });
      const result = buildEstimateContext(ctx, stores);
      expect(result.routeIntel).toBeNull();
    });
  });

  // ── buildPriceWallContext ─────────────────────────────────────────────

  describe("buildPriceWallContext", () => {
    it("returns trip, physicsEstimate, and clientBudget when populated", () => {
      const ctx = makePopulatedCtx();
      const result = buildPriceWallContext(ctx);
      expect(result.trip.departure).toBe("KTEB");
      expect(result.trip.pax).toBe(4);
      expect(result.physicsEstimate).toEqual({ low: 22000, high: 28000 });
      expect(result.clientBudget).toEqual({ min: 20000, max: 40000 });
    });

    it("returns null physicsEstimate and clientBudget when empty ctx", () => {
      const ctx = createDealContext("sim");
      const result = buildPriceWallContext(ctx);
      expect(result.physicsEstimate).toBeNull();
      expect(result.clientBudget).toBeNull();
    });

    it("does not include aircraftClass in trip (only 4 fields)", () => {
      const ctx = makePopulatedCtx();
      const result = buildPriceWallContext(ctx);
      expect((result.trip as any).aircraftClass).toBeUndefined();
    });
  });

  // ── buildSourcingContext ──────────────────────────────────────────────

  describe("buildSourcingContext", () => {
    it("injects operatorProfiles from RouteIntel.topOperators via store", () => {
      const ctx = makePopulatedCtx();
      const intel = makeRouteIntel();
      const operators = [
        makeOperatorProfile("Priester Aviation"),
        makeOperatorProfile("NetJets"),
        makeOperatorProfile("Flexjet"),
      ];
      const stores = makeFakeStores({ routeIntel: intel, operators });
      const result = buildSourcingContext(ctx, stores);
      expect(result.operatorProfiles).toHaveLength(3);
      expect(result.operatorProfiles[0]!.name).toBe("Priester Aviation");
    });

    it("returns empty operatorProfiles when no routeIntel", () => {
      const ctx = makePopulatedCtx();
      ctx.trip.aircraftClass = null;
      const stores = makeFakeStores();
      const result = buildSourcingContext(ctx, stores);
      expect(result.operatorProfiles).toEqual([]);
    });

    it("returns empty operatorProfiles when routeIntel exists but no operatorProfiles store", () => {
      const ctx = makePopulatedCtx();
      const intel = makeRouteIntel();
      // Store with routeIntel but operatorProfiles store returns empty
      const stores = makeFakeStores({ routeIntel: intel });
      const result = buildSourcingContext(ctx, stores);
      expect(result.operatorProfiles).toEqual([]);
    });

    it("sets budgetCeiling from client.budget.max", () => {
      const ctx = makePopulatedCtx();
      const result = buildSourcingContext(ctx);
      expect(result.budgetCeiling).toBe(40000);
    });

    it("sets budgetCeiling to null when no budget", () => {
      const ctx = createDealContext("sim");
      const result = buildSourcingContext(ctx);
      expect(result.budgetCeiling).toBeNull();
    });
  });

  // ── buildQuoteContext ─────────────────────────────────────────────────

  describe("buildQuoteContext", () => {
    it("sets ghostPositioningValue from selectedOperator.distanceToDeparture", () => {
      const ctx = makePopulatedCtx();
      const result = buildQuoteContext(ctx);
      expect(result.ghostPositioningValue).toBe(42);
    });

    it("returns null ghostPositioningValue when no selectedOperator", () => {
      const ctx = createDealContext("sim");
      const result = buildQuoteContext(ctx);
      expect(result.ghostPositioningValue).toBeNull();
    });

    it("projects selectedOperator with score but without full scoreBreakdown", () => {
      const ctx = makePopulatedCtx();
      const result = buildQuoteContext(ctx);
      expect(result.selectedOperator).not.toBeNull();
      expect(result.selectedOperator!.operatorName).toBe("Priester Aviation");
      expect(result.selectedOperator!.score).toBe(0.92);
      expect((result.selectedOperator as any).scoreBreakdown).toBeUndefined();
    });

    it("returns null selectedOperator when not sourced", () => {
      const ctx = createDealContext("sim");
      const result = buildQuoteContext(ctx);
      expect(result.selectedOperator).toBeNull();
    });
  });

  // ── buildPresentContext ───────────────────────────────────────────────

  describe("buildPresentContext", () => {
    it("builds route string as departure-arrival", () => {
      const ctx = makePopulatedCtx();
      const result = buildPresentContext(ctx);
      expect(result.route).toBe("KTEB-KMIA");
    });

    it("includes clientName and osaPrice", () => {
      const ctx = makePopulatedCtx();
      const result = buildPresentContext(ctx);
      expect(result.clientName).toBe("John Doe");
      expect(result.osaPrice).toBe(26400);
    });

    it("returns null aircraft when quote.aircraft is null", () => {
      const ctx = createDealContext("sim");
      const result = buildPresentContext(ctx);
      expect(result.aircraft).toBeNull();
    });

    it("returns aircraft object when quote.aircraft is set", () => {
      const ctx = makePopulatedCtx();
      const result = buildPresentContext(ctx);
      expect(result.aircraft).not.toBeNull();
      expect(result.aircraft!.type).toBe("Citation XLS");
      expect(result.aircraft!.tail).toBe("N123PA");
      expect(result.aircraft!.year).toBe(2019);
    });

    it("returns null osaPrice when no quote", () => {
      const ctx = createDealContext("sim");
      const result = buildPresentContext(ctx);
      expect(result.osaPrice).toBeNull();
    });
  });

  // ── buildRespondContext ───────────────────────────────────────────────

  describe("buildRespondContext", () => {
    it("returns exactly 5 fields", () => {
      const ctx = makePopulatedCtx();
      const result = buildRespondContext(ctx, "quote_request");
      const keys = Object.keys(result);
      expect(keys).toHaveLength(5);
      expect(keys.sort()).toEqual(["clientName", "dealStage", "intent", "osaPrice", "route"].sort());
    });

    it("passes intent through", () => {
      const ctx = makePopulatedCtx();
      const result = buildRespondContext(ctx, "follow_up");
      expect(result.intent).toBe("follow_up");
    });

    it("uses ctx.stage as dealStage", () => {
      const ctx = makePopulatedCtx();
      const result = buildRespondContext(ctx, "greeting");
      expect(result.dealStage).toBe("quoted");
    });

    it("builds route string from trip", () => {
      const ctx = makePopulatedCtx();
      const result = buildRespondContext(ctx, "info");
      expect(result.route).toBe("KTEB-KMIA");
    });
  });

  // ── Mutation Safety ───────────────────────────────────────────────────

  describe("mutation safety", () => {
    it("buildGuardianContext trip is a new object (not a reference)", () => {
      const ctx = makePopulatedCtx();
      const result = buildGuardianContext("estimated", ctx);
      result.trip.pax = 99;
      expect(ctx.trip.pax).toBe(4);
    });

    it("buildPriceWallContext physicsEstimate is a new object", () => {
      const ctx = makePopulatedCtx();
      const result = buildPriceWallContext(ctx);
      result.physicsEstimate!.low = 999;
      expect(ctx.estimate.priceRange!.low).toBe(22000);
    });

    it("buildPriceWallContext clientBudget is a new object", () => {
      const ctx = makePopulatedCtx();
      const result = buildPriceWallContext(ctx);
      result.clientBudget!.min = 999;
      expect(ctx.client.budget!.min).toBe(20000);
    });

    it("buildPresentContext aircraft is a new object", () => {
      const ctx = makePopulatedCtx();
      const result = buildPresentContext(ctx);
      result.aircraft!.year = 1900;
      expect(ctx.quote.aircraft!.year).toBe(2019);
    });

    it("buildQuoteContext clientBudget is a new object", () => {
      const ctx = makePopulatedCtx();
      const result = buildQuoteContext(ctx);
      result.clientBudget!.max = 1;
      expect(ctx.client.budget!.max).toBe(40000);
    });
  });
});
