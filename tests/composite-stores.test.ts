/**
 * Tests for Composite Object Stores — RouteIntelStore, OperatorProfileStore,
 * ClientProfileStore, ValidationLedgerStore, and JsonFileStore base behavior.
 *
 * Coverage:
 * 1. RouteIntelStore: get/upsert/invalidate/stale TTL, count, getAll
 * 2. OperatorProfileStore: get/getMany/upsert/stale handling
 * 3. ClientProfileStore: case-insensitive lookup by name/email, upsert matching
 * 4. ValidationLedgerStore: append-only, getByRoute, getBooked, getByDateRange
 * 5. JsonFileStore base: load from file, corrupt JSON, missing file, save persistence
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../src/memory/database.js";
import type Database from "better-sqlite3";
import {
  RouteIntelStore,
  OperatorProfileStore,
  ClientProfileStore,
  ValidationLedgerStore,
} from "../src/memory/composite-stores.js";
import type {
  RouteIntel,
  OperatorProfile,
  ClientProfile,
  ValidationLedgerEntry,
} from "../src/schemas/composite-objects.js";

const NOW = new Date().toISOString();
const STALE = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago

function makeRouteIntel(overrides: Partial<RouteIntel> = {}): RouteIntel {
  return {
    route: "KTEB-KMIA",
    aircraftClass: "light",
    avgPrice30d: 32000,
    dealCount: 5,
    demandTrend: "stable",
    topOperators: ["Elite Aviation", "NetJets"],
    seasonalFactor: 1.0,
    avgMarginDelta: -0.03,
    lastUpdated: NOW,
    ...overrides,
  };
}

function makeOperatorProfile(overrides: Partial<OperatorProfile> = {}): OperatorProfile {
  return {
    name: "Elite Aviation",
    homeBase: "KTEB",
    certs: ["Part 135", "IS-BAO"],
    fleet: ["Phenom 300E", "Citation CJ3+"],
    avgResponseTime: 45,
    reliabilityScore: 0.92,
    pricingDelta: 0.05,
    paymentSpeed: 3,
    quoteToBookRate: 0.7,
    cancelRate: 0.02,
    dealCount: 12,
    lastUpdated: NOW,
    ...overrides,
  };
}

function makeClientProfile(overrides: Partial<ClientProfile> = {}): ClientProfile {
  return {
    name: "John Smith",
    email: "john@smith.com",
    dealHistory: [
      { route: "KTEB-KMIA", price: 30000, date: "2026-03-15", outcome: "booked" },
    ],
    avgPaymentTime: 4.5,
    totalSpend: 30000,
    tripFrequency: 3,
    preferredAircraftClass: "light",
    preferredRoutes: ["KTEB-KMIA"],
    lastUpdated: NOW,
    ...overrides,
  };
}

function makeLedgerEntry(overrides: Partial<ValidationLedgerEntry> = {}): ValidationLedgerEntry {
  return {
    route: "KTEB-KMIA",
    date: "2026-04-01",
    mode: "live",
    leadTimeHours: 48,
    rliAtQuote: "high",
    dumontPhysicsEstimate: 28000,
    ghostPositioningValue: 1200,
    operatorQuotedPrice: 30000,
    osaClientPrice: 32700,
    realizedMarginPct: 0.083,
    rfqsSent: 1,
    quotesReceived: 1,
    operatorResponseMinutes: 35,
    clientDecisionMinutes: 90,
    outcome: "booked",
    fleetResilienceUsed: false,
    tripCompleted: true,
    notes: "Clean deal",
    ...overrides,
  };
}

// ── SQLite Store Base Behavior ───────────────────────────────────────────

describe("SQLite store base behavior", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("starts empty with fresh database", () => {
    const store = new RouteIntelStore(db);
    expect(store.count).toBe(0);
    expect(store.getAll()).toEqual([]);
  });

  it("persists data within the same database instance", () => {
    const store = new RouteIntelStore(db);
    store.upsert(makeRouteIntel());
    expect(store.count).toBe(1);

    // Another store instance on the same db sees the data
    const store2 = new RouteIntelStore(db);
    expect(store2.count).toBe(1);
  });

  it("upsert() persists and is immediately readable", () => {
    const store = new RouteIntelStore(db);
    store.upsert(makeRouteIntel());

    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.route).toBe("KTEB-KMIA");
  });
});

// ── RouteIntelStore ──────────────────────────────────────────────────────

describe("RouteIntelStore", () => {
  let db: Database.Database;
  let store: RouteIntelStore;

  beforeEach(() => {
    db = createTestDb();
    store = new RouteIntelStore(db);
  });
  afterEach(() => db.close());

  it("get() returns null for missing data", () => {
    expect(store.get("KTEB-KMIA", "light")).toBeNull();
  });

  it("get() returns null for stale data (>24h old)", () => {
    store.upsert(makeRouteIntel({ lastUpdated: STALE }));
    expect(store.get("KTEB-KMIA", "light")).toBeNull();
  });

  it("get() returns data when fresh", () => {
    const intel = makeRouteIntel();
    store.upsert(intel);

    const result = store.get("KTEB-KMIA", "light");
    expect(result).not.toBeNull();
    expect(result!.route).toBe("KTEB-KMIA");
    expect(result!.avgPrice30d).toBe(32000);
  });

  it("getIncludingStale() returns stale data", () => {
    store.upsert(makeRouteIntel({ lastUpdated: STALE }));

    const result = store.getIncludingStale("KTEB-KMIA", "light");
    expect(result).not.toBeNull();
    expect(result!.route).toBe("KTEB-KMIA");
  });

  it("getIncludingStale() returns null for missing data", () => {
    expect(store.getIncludingStale("NOPE-NADA", "heavy")).toBeNull();
  });

  it("upsert() inserts new records", () => {
    expect(store.count).toBe(0);
    store.upsert(makeRouteIntel());
    expect(store.count).toBe(1);
  });

  it("upsert() updates existing records (same route + aircraftClass)", () => {
    store.upsert(makeRouteIntel({ avgPrice30d: 30000 }));
    store.upsert(makeRouteIntel({ avgPrice30d: 35000 }));

    expect(store.count).toBe(1);
    expect(store.get("KTEB-KMIA", "light")!.avgPrice30d).toBe(35000);
  });

  it("upsert() inserts separately for different aircraftClass", () => {
    store.upsert(makeRouteIntel({ aircraftClass: "light" }));
    store.upsert(makeRouteIntel({ aircraftClass: "heavy" }));

    expect(store.count).toBe(2);
  });

  it("invalidate() marks record as stale", () => {
    store.upsert(makeRouteIntel());
    expect(store.get("KTEB-KMIA", "light")).not.toBeNull();

    store.invalidate("KTEB-KMIA", "light");
    expect(store.get("KTEB-KMIA", "light")).toBeNull();

    // But still accessible via getIncludingStale
    expect(store.getIncludingStale("KTEB-KMIA", "light")).not.toBeNull();
  });

  it("invalidate() is a no-op for missing records", () => {
    store.invalidate("NOPE-NADA", "light"); // should not throw
    expect(store.count).toBe(0);
  });

  it("count property reflects current record count", () => {
    expect(store.count).toBe(0);
    store.upsert(makeRouteIntel());
    expect(store.count).toBe(1);
    store.upsert(makeRouteIntel({ route: "KORD-KASE" }));
    expect(store.count).toBe(2);
  });

  it("getAll() returns copies (mutations do not affect store)", () => {
    store.upsert(makeRouteIntel());
    const all = store.getAll();
    all.pop();
    expect(store.count).toBe(1);
  });
});

// ── OperatorProfileStore ─────────────────────────────────────────────────

describe("OperatorProfileStore", () => {
  let db: Database.Database;
  let store: OperatorProfileStore;

  beforeEach(() => {
    db = createTestDb();
    store = new OperatorProfileStore(db);
  });
  afterEach(() => db.close());

  it("get() returns profile by name", () => {
    store.upsert(makeOperatorProfile());
    const result = store.get("Elite Aviation");
    expect(result).not.toBeNull();
    expect(result!.homeBase).toBe("KTEB");
  });

  it("get() returns null for missing operator", () => {
    expect(store.get("Ghost Operator")).toBeNull();
  });

  it("get() returns null for stale profile", () => {
    store.upsert(makeOperatorProfile({ lastUpdated: STALE }));
    expect(store.get("Elite Aviation")).toBeNull();
  });

  it("getIncludingStale() returns stale profile", () => {
    store.upsert(makeOperatorProfile({ lastUpdated: STALE }));
    const result = store.getIncludingStale("Elite Aviation");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Elite Aviation");
  });

  it("getMany() filters stale entries", () => {
    store.upsert(makeOperatorProfile({ name: "Fresh Op" }));
    store.upsert(makeOperatorProfile({ name: "Stale Op", lastUpdated: STALE }));

    const results = store.getMany(["Fresh Op", "Stale Op"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Fresh Op");
  });

  it("getMany() returns empty for unknown names", () => {
    const results = store.getMany(["Unknown1", "Unknown2"]);
    expect(results).toEqual([]);
  });

  it("getMany() returns multiple fresh profiles", () => {
    store.upsert(makeOperatorProfile({ name: "Op A" }));
    store.upsert(makeOperatorProfile({ name: "Op B" }));

    const results = store.getMany(["Op A", "Op B"]);
    expect(results).toHaveLength(2);
  });

  it("upsert() updates existing by name", () => {
    store.upsert(makeOperatorProfile({ reliabilityScore: 0.8 }));
    store.upsert(makeOperatorProfile({ reliabilityScore: 0.95 }));

    expect(store.count).toBe(1);
    expect(store.get("Elite Aviation")!.reliabilityScore).toBe(0.95);
  });
});

// ── ClientProfileStore ───────────────────────────────────────────────────

describe("ClientProfileStore", () => {
  let db: Database.Database;
  let store: ClientProfileStore;

  beforeEach(() => {
    db = createTestDb();
    store = new ClientProfileStore(db);
  });
  afterEach(() => db.close());

  it("get() case-insensitive name matching", () => {
    store.upsert(makeClientProfile());

    expect(store.get("john smith")).not.toBeNull();
    expect(store.get("JOHN SMITH")).not.toBeNull();
    expect(store.get("John Smith")).not.toBeNull();
  });

  it("get() case-insensitive email matching", () => {
    store.upsert(makeClientProfile());

    expect(store.get("JOHN@SMITH.COM")).not.toBeNull();
    expect(store.get("john@smith.com")).not.toBeNull();
  });

  it("get() returns null for empty string", () => {
    store.upsert(makeClientProfile());
    expect(store.get("")).toBeNull();
  });

  it("get() returns null for unknown client", () => {
    expect(store.get("nobody@nowhere.com")).toBeNull();
  });

  it("get() trims whitespace from search string", () => {
    store.upsert(makeClientProfile());
    expect(store.get("  john smith  ")).not.toBeNull();
  });

  it("upsert() matches on email first, then name", () => {
    store.upsert(makeClientProfile({ name: "John Smith", email: "john@smith.com", totalSpend: 30000 }));

    // Update with same email, different name — should match by email
    store.upsert(makeClientProfile({ name: "Jonathan Smith", email: "john@smith.com", totalSpend: 60000 }));

    expect(store.count).toBe(1);
    expect(store.get("john@smith.com")!.name).toBe("Jonathan Smith");
    expect(store.get("john@smith.com")!.totalSpend).toBe(60000);
  });

  it("upsert() falls back to name match when email differs", () => {
    store.upsert(makeClientProfile({ name: "John Smith", email: "john@old.com" }));

    // Same name, different email, no email match — falls back to name
    store.upsert(makeClientProfile({ name: "John Smith", email: "john@new.com" }));

    expect(store.count).toBe(1);
    expect(store.get("John Smith")!.email).toBe("john@new.com");
  });

  it("upsert() inserts new client when no match", () => {
    store.upsert(makeClientProfile({ name: "Alice", email: "alice@ex.com" }));
    store.upsert(makeClientProfile({ name: "Bob", email: "bob@ex.com" }));

    expect(store.count).toBe(2);
  });
});

// ── ValidationLedgerStore ────────────────────────────────────────────────

describe("ValidationLedgerStore", () => {
  let db: Database.Database;
  let store: ValidationLedgerStore;

  beforeEach(() => {
    db = createTestDb();
    store = new ValidationLedgerStore(db);
  });
  afterEach(() => db.close());

  it("append() adds entries", () => {
    store.append(makeLedgerEntry());
    expect(store.count).toBe(1);

    store.append(makeLedgerEntry({ route: "KORD-KASE" }));
    expect(store.count).toBe(2);
  });

  it("append() is truly append-only (no dedup)", () => {
    const entry = makeLedgerEntry();
    store.append(entry);
    store.append(entry);
    expect(store.count).toBe(2);
  });

  it("getByRoute() filters correctly", () => {
    store.append(makeLedgerEntry({ route: "KTEB-KMIA" }));
    store.append(makeLedgerEntry({ route: "KORD-KASE" }));
    store.append(makeLedgerEntry({ route: "KTEB-KMIA" }));

    const results = store.getByRoute("KTEB-KMIA");
    expect(results).toHaveLength(2);
  });

  it("getByRoute() returns empty for unknown route", () => {
    store.append(makeLedgerEntry());
    expect(store.getByRoute("NOPE-NADA")).toEqual([]);
  });

  it("getBooked() returns only booked outcomes", () => {
    store.append(makeLedgerEntry({ outcome: "booked" }));
    store.append(makeLedgerEntry({ outcome: "lost_price" }));
    store.append(makeLedgerEntry({ outcome: "booked" }));
    store.append(makeLedgerEntry({ outcome: "lost_ghosted" }));

    const booked = store.getBooked();
    expect(booked).toHaveLength(2);
    expect(booked.every((e) => e.outcome === "booked")).toBe(true);
  });

  it("getBooked() returns empty when no booked deals", () => {
    store.append(makeLedgerEntry({ outcome: "lost_price" }));
    store.append(makeLedgerEntry({ outcome: "lost_timing" }));

    expect(store.getBooked()).toEqual([]);
  });

  it("getByDateRange() inclusive filtering", () => {
    store.append(makeLedgerEntry({ date: "2026-03-15" }));
    store.append(makeLedgerEntry({ date: "2026-04-01" }));
    store.append(makeLedgerEntry({ date: "2026-04-15" }));
    store.append(makeLedgerEntry({ date: "2026-05-01" }));

    const results = store.getByDateRange("2026-04-01", "2026-04-15");
    expect(results).toHaveLength(2);
  });

  it("getByDateRange() returns empty for out-of-range dates", () => {
    store.append(makeLedgerEntry({ date: "2026-01-01" }));
    store.append(makeLedgerEntry({ date: "2026-06-01" }));

    expect(store.getByDateRange("2026-03-01", "2026-03-31")).toEqual([]);
  });

  it("getByDateRange() includes boundary dates exactly", () => {
    store.append(makeLedgerEntry({ date: "2026-04-01" }));
    store.append(makeLedgerEntry({ date: "2026-04-30" }));

    const results = store.getByDateRange("2026-04-01", "2026-04-30");
    expect(results).toHaveLength(2);
  });

  it("persists entries across store instances on same db", () => {
    const store1 = new ValidationLedgerStore(db);
    store1.append(makeLedgerEntry());
    store1.append(makeLedgerEntry({ route: "KORD-KASE" }));

    // New store instance on same database
    const store2 = new ValidationLedgerStore(db);
    expect(store2.count).toBe(2);
    expect(store2.getByRoute("KORD-KASE")).toHaveLength(1);
  });
});
