/**
 * Composite Object Stores — SQLite-backed persistence for pre-aggregated
 * intelligence objects.
 *
 * TTL rules:
 * - RouteIntel: 24 hours (stale data re-computed from DealStore on next access)
 * - OperatorProfile: 24 hours
 * - ClientProfile: no TTL (updated on every deal close)
 * - ValidationLedger: append-only, permanent, no TTL
 *
 * All money stored as INTEGER cents. Converted at boundary.
 */

import type Database from "better-sqlite3";
import type {
  RouteIntel,
  OperatorProfile,
  ClientProfile,
  ValidationLedgerEntry,
} from "../schemas/composite-objects.js";
import { getDb } from "./database.js";

// ── TTL Config ──────────────────────────────────────────────────────────

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function isStale(lastUpdated: string): boolean {
  return Date.now() - new Date(lastUpdated).getTime() > TTL_MS;
}

// ── Dollar ↔ Cents helpers ──────────────────────────────────────────────

function toCents(dollars: number | null): number | null {
  return dollars !== null ? Math.round(dollars * 100) : null;
}

function toDollars(cents: number | null): number | null {
  return cents !== null ? cents / 100 : null;
}

// ── RouteIntelStore ─────────────────────────────────────────────────────

export class RouteIntelStore {
  private readonly db: Database.Database;

  constructor(pathOrDb?: string | Database.Database) {
    this.db = typeof pathOrDb === "object" && pathOrDb !== null ? pathOrDb : getDb(pathOrDb);
  }

  private rowToRouteIntel(row: any): RouteIntel {
    return {
      route: row.route,
      aircraftClass: row.aircraft_class,
      avgPrice30d: toDollars(row.avg_price_30d_cents),
      dealCount: row.deal_count,
      demandTrend: row.demand_trend,
      topOperators: JSON.parse(row.top_operators || "[]"),
      seasonalFactor: row.seasonal_factor,
      avgMarginDelta: row.avg_margin_delta,
      lastUpdated: row.last_updated,
    };
  }

  get(route: string, aircraftClass: string): RouteIntel | null {
    const row = this.db.prepare(
      "SELECT * FROM route_intel WHERE route = ? AND aircraft_class = ?",
    ).get(route, aircraftClass) as any;
    if (!row) return null;
    const intel = this.rowToRouteIntel(row);
    if (isStale(intel.lastUpdated)) return null;
    return intel;
  }

  getIncludingStale(route: string, aircraftClass: string): RouteIntel | null {
    const row = this.db.prepare(
      "SELECT * FROM route_intel WHERE route = ? AND aircraft_class = ?",
    ).get(route, aircraftClass) as any;
    return row ? this.rowToRouteIntel(row) : null;
  }

  upsert(intel: RouteIntel): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO route_intel (
        route, aircraft_class, avg_price_30d_cents, deal_count,
        demand_trend, top_operators, seasonal_factor, avg_margin_delta, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      intel.route, intel.aircraftClass, toCents(intel.avgPrice30d), intel.dealCount,
      intel.demandTrend, JSON.stringify(intel.topOperators), intel.seasonalFactor,
      intel.avgMarginDelta, intel.lastUpdated,
    );
  }

  invalidate(route: string, aircraftClass: string): void {
    this.db.prepare(
      "UPDATE route_intel SET last_updated = ? WHERE route = ? AND aircraft_class = ?",
    ).run(new Date(0).toISOString(), route, aircraftClass);
  }

  getAll(): RouteIntel[] {
    return this.db.prepare("SELECT * FROM route_intel").all().map((r: any) => this.rowToRouteIntel(r));
  }

  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM route_intel").get() as any;
    return row?.cnt ?? 0;
  }
}

// ── OperatorProfileStore ────────────────────────────────────────────────

export class OperatorProfileStore {
  private readonly db: Database.Database;

  constructor(pathOrDb?: string | Database.Database) {
    this.db = typeof pathOrDb === "object" && pathOrDb !== null ? pathOrDb : getDb(pathOrDb);
  }

  private rowToProfile(row: any): OperatorProfile {
    return {
      name: row.name,
      homeBase: row.home_base,
      certs: JSON.parse(row.certs || "[]"),
      fleet: JSON.parse(row.fleet || "[]"),
      avgResponseTime: row.avg_response_time,
      reliabilityScore: row.reliability_score,
      pricingDelta: row.pricing_delta,
      paymentSpeed: row.payment_speed,
      quoteToBookRate: row.quote_to_book_rate,
      cancelRate: row.cancel_rate,
      dealCount: row.deal_count,
      lastUpdated: row.last_updated,
    };
  }

  get(name: string): OperatorProfile | null {
    const row = this.db.prepare("SELECT * FROM operator_profiles WHERE name = ?").get(name) as any;
    if (!row) return null;
    const profile = this.rowToProfile(row);
    if (isStale(profile.lastUpdated)) return null;
    return profile;
  }

  getIncludingStale(name: string): OperatorProfile | null {
    const row = this.db.prepare("SELECT * FROM operator_profiles WHERE name = ?").get(name) as any;
    return row ? this.rowToProfile(row) : null;
  }

  getMany(names: string[]): OperatorProfile[] {
    return names
      .map((n) => this.get(n))
      .filter((p): p is OperatorProfile => p !== null);
  }

  upsert(profile: OperatorProfile): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO operator_profiles (
        name, home_base, certs, fleet,
        avg_response_time, reliability_score, pricing_delta, payment_speed,
        quote_to_book_rate, cancel_rate, deal_count, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      profile.name, profile.homeBase, JSON.stringify(profile.certs), JSON.stringify(profile.fleet),
      profile.avgResponseTime, profile.reliabilityScore, profile.pricingDelta, profile.paymentSpeed,
      profile.quoteToBookRate, profile.cancelRate, profile.dealCount, profile.lastUpdated,
    );
  }

  getAll(): OperatorProfile[] {
    return this.db.prepare("SELECT * FROM operator_profiles").all().map((r: any) => this.rowToProfile(r));
  }

  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM operator_profiles").get() as any;
    return row?.cnt ?? 0;
  }
}

// ── ClientProfileStore ──────────────────────────────────────────────────

export class ClientProfileStore {
  private readonly db: Database.Database;

  constructor(pathOrDb?: string | Database.Database) {
    this.db = typeof pathOrDb === "object" && pathOrDb !== null ? pathOrDb : getDb(pathOrDb);
  }

  private rowToProfile(row: any): ClientProfile {
    return {
      name: row.name,
      email: row.email,
      dealHistory: JSON.parse(row.deal_history || "[]"),
      avgPaymentTime: row.avg_payment_time,
      totalSpend: toDollars(row.total_spend_cents) ?? 0,
      tripFrequency: row.trip_frequency,
      preferredAircraftClass: row.preferred_aircraft_class,
      preferredRoutes: JSON.parse(row.preferred_routes || "[]"),
      lastUpdated: row.last_updated,
    };
  }

  get(nameOrEmail: string): ClientProfile | null {
    if (!nameOrEmail) return null;
    const needle = nameOrEmail.toLowerCase().trim();
    const row = this.db.prepare(
      "SELECT * FROM client_profiles WHERE LOWER(name) = ? OR LOWER(email) = ?",
    ).get(needle, needle) as any;
    return row ? this.rowToProfile(row) : null;
  }

  upsert(profile: ClientProfile): void {
    // Try to find existing by email (primary) or name (secondary)
    let existing: any = null;
    if (profile.email) {
      existing = this.db.prepare(
        "SELECT rowid FROM client_profiles WHERE LOWER(email) = ?",
      ).get(profile.email.toLowerCase()) as any;
    }
    if (!existing && profile.name) {
      existing = this.db.prepare(
        "SELECT rowid FROM client_profiles WHERE LOWER(name) = ?",
      ).get(profile.name.toLowerCase()) as any;
    }

    if (existing) {
      this.db.prepare(`
        UPDATE client_profiles SET
          name = ?, email = ?, deal_history = ?, avg_payment_time = ?,
          total_spend_cents = ?, trip_frequency = ?, preferred_aircraft_class = ?,
          preferred_routes = ?, last_updated = ?
        WHERE rowid = ?
      `).run(
        profile.name, profile.email, JSON.stringify(profile.dealHistory),
        profile.avgPaymentTime, toCents(profile.totalSpend),
        profile.tripFrequency, profile.preferredAircraftClass,
        JSON.stringify(profile.preferredRoutes), profile.lastUpdated,
        existing.rowid,
      );
    } else {
      this.db.prepare(`
        INSERT INTO client_profiles (
          name, email, deal_history, avg_payment_time,
          total_spend_cents, trip_frequency, preferred_aircraft_class,
          preferred_routes, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        profile.name, profile.email, JSON.stringify(profile.dealHistory),
        profile.avgPaymentTime, toCents(profile.totalSpend),
        profile.tripFrequency, profile.preferredAircraftClass,
        JSON.stringify(profile.preferredRoutes), profile.lastUpdated,
      );
    }
  }

  getAll(): ClientProfile[] {
    return this.db.prepare("SELECT * FROM client_profiles").all().map((r: any) => this.rowToProfile(r));
  }

  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM client_profiles").get() as any;
    return row?.cnt ?? 0;
  }
}

// ── ValidationLedgerStore ───────────────────────────────────────────────

export class ValidationLedgerStore {
  private readonly db: Database.Database;

  constructor(pathOrDb?: string | Database.Database) {
    this.db = typeof pathOrDb === "object" && pathOrDb !== null ? pathOrDb : getDb(pathOrDb);
  }

  private rowToEntry(row: any): ValidationLedgerEntry {
    return {
      route: row.route,
      date: row.date,
      mode: row.mode,
      leadTimeHours: row.lead_time_hours,
      rliAtQuote: row.rli_at_quote,
      dumontPhysicsEstimate: toDollars(row.dumont_physics_estimate_cents),
      ghostPositioningValue: row.ghost_positioning_value,
      operatorQuotedPrice: toDollars(row.operator_quoted_price_cents),
      osaClientPrice: toDollars(row.osa_client_price_cents),
      realizedMarginPct: row.realized_margin_pct,
      rfqsSent: row.rfqs_sent,
      quotesReceived: row.quotes_received,
      operatorResponseMinutes: row.operator_response_minutes,
      clientDecisionMinutes: row.client_decision_minutes,
      outcome: row.outcome,
      fleetResilienceUsed: Boolean(row.fleet_resilience_used),
      tripCompleted: row.trip_completed === null ? null : Boolean(row.trip_completed),
      notes: row.notes,
    };
  }

  append(entry: ValidationLedgerEntry): void {
    this.db.prepare(`
      INSERT INTO validation_ledger (
        route, date, mode, lead_time_hours, rli_at_quote,
        dumont_physics_estimate_cents, ghost_positioning_value,
        operator_quoted_price_cents, osa_client_price_cents,
        realized_margin_pct, rfqs_sent, quotes_received,
        operator_response_minutes, client_decision_minutes,
        outcome, fleet_resilience_used, trip_completed, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.route, entry.date, entry.mode, entry.leadTimeHours, entry.rliAtQuote,
      toCents(entry.dumontPhysicsEstimate), entry.ghostPositioningValue,
      toCents(entry.operatorQuotedPrice), toCents(entry.osaClientPrice),
      entry.realizedMarginPct, entry.rfqsSent, entry.quotesReceived,
      entry.operatorResponseMinutes, entry.clientDecisionMinutes,
      entry.outcome, entry.fleetResilienceUsed ? 1 : 0,
      entry.tripCompleted === null ? null : (entry.tripCompleted ? 1 : 0),
      entry.notes,
    );
  }

  getByRoute(route: string): ValidationLedgerEntry[] {
    return this.db.prepare(
      "SELECT * FROM validation_ledger WHERE route = ? ORDER BY date",
    ).all(route).map((r: any) => this.rowToEntry(r));
  }

  getBooked(): ValidationLedgerEntry[] {
    return this.db.prepare(
      "SELECT * FROM validation_ledger WHERE outcome = 'booked' ORDER BY date",
    ).all().map((r: any) => this.rowToEntry(r));
  }

  getByDateRange(from: string, to: string): ValidationLedgerEntry[] {
    return this.db.prepare(
      "SELECT * FROM validation_ledger WHERE date >= ? AND date <= ? ORDER BY date",
    ).all(from, to).map((r: any) => this.rowToEntry(r));
  }

  getAll(): ValidationLedgerEntry[] {
    return this.db.prepare("SELECT * FROM validation_ledger ORDER BY id").all()
      .map((r: any) => this.rowToEntry(r));
  }

  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM validation_ledger").get() as any;
    return row?.cnt ?? 0;
  }
}
