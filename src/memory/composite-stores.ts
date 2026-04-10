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

// ── SQLite Row Interfaces ───────────────────────────────────────────────

interface RouteIntelRow {
  route: string;
  aircraft_class: string;
  avg_price_30d_cents: number | null;
  deal_count: number;
  demand_trend: string;
  top_operators: string;
  seasonal_factor: number;
  avg_margin_delta: number;
  last_updated: string;
}

interface OperatorProfileRow {
  name: string;
  home_base: string;
  certs: string;
  fleet: string;
  avg_response_time: number;
  reliability_score: number;
  pricing_delta: number;
  payment_speed: number;
  quote_to_book_rate: number;
  cancel_rate: number;
  deal_count: number;
  last_updated: string;
}

interface ClientProfileRow {
  rowid: number;
  name: string;
  email: string;
  deal_history: string;
  avg_payment_time: number;
  total_spend_cents: number;
  trip_frequency: number;
  preferred_aircraft_class: string | null;
  preferred_routes: string;
  last_updated: string;
}

interface ValidationLedgerRow {
  id: number;
  route: string;
  date: string;
  mode: string;
  lead_time_hours: number;
  rli_at_quote: string;
  rli_score: number | null;
  dumont_physics_estimate_cents: number | null;
  ghost_positioning_value: number | null;
  operator_quoted_price_cents: number | null;
  osa_client_price_cents: number | null;
  realized_margin_pct: number | null;
  estimate_delta_percent: number | null;
  rfqs_sent: number;
  quotes_received: number;
  operator_response_minutes: number | null;
  client_decision_minutes: number | null;
  outcome: string;
  fleet_resilience_used: number;
  trip_completed: number | null;
  notes: string;
  // Benchmark 1: Ghost Positioning Spread
  ghost_value_cents: number;
  ghost_description: string | null;
  // Benchmark 4: Fleet Resilience
  trip_outcome: string;
  recovery_time_min: number | null;
  // Benchmark 5: Demand Prediction
  route_page_views_7d: number | null;
  // Benchmark 6: Client Decision Velocity
  options_presented_at: string | null;
  client_confirmed_at: string | null;
  // Benchmark 7: Network Density
  operators_in_network: number | null;
  operators_in_metro: number | null;
  // Operator Intelligence
  operator_name: string | null;
  operator_base: string | null;
  operator_reliability_score: number | null;
  // Outcome
  revenue_cents: number | null;
  // Payment State
  payment_status: string;
  client_paid_at: string | null;
  operator_paid_at: string | null;
  float_window_hours: number | null;
  // Timestamps
  created_at: string | null;
  updated_at: string | null;
}

export interface BenchmarkMetrics {
  ghostSpread: { totalCents: number; dealCount: number; avgPerDeal: number };
  signalRatio: { rfqsSent: number; quotesReceived: number; ratio: number };
  marginByLiquidity: { high: number | null; medium: number | null; low: number | null };
  pricingAccuracy: { avgAbsDeltaPct: number; sampleSize: number };
  avgClientDecisionMin: number | null;
  networkDensity: { avgOperatorsInNetwork: number | null; avgOperatorsInMetro: number | null };
  fleetResilience: { recoveredCount: number; failedCount: number; avgRecoveryMin: number | null };
}

interface CountRow {
  cnt: number;
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

  private rowToRouteIntel(row: RouteIntelRow): RouteIntel {
    return {
      route: row.route,
      aircraftClass: row.aircraft_class as RouteIntel["aircraftClass"],
      avgPrice30d: toDollars(row.avg_price_30d_cents),
      dealCount: row.deal_count,
      demandTrend: row.demand_trend as RouteIntel["demandTrend"],
      topOperators: JSON.parse(row.top_operators || "[]"),
      seasonalFactor: row.seasonal_factor,
      avgMarginDelta: row.avg_margin_delta,
      lastUpdated: row.last_updated,
    };
  }

  get(route: string, aircraftClass: string): RouteIntel | null {
    const row = this.db.prepare(
      "SELECT * FROM route_intel WHERE route = ? AND aircraft_class = ?",
    ).get(route, aircraftClass) as RouteIntelRow | undefined;
    if (!row) return null;
    const intel = this.rowToRouteIntel(row);
    if (isStale(intel.lastUpdated)) return null;
    return intel;
  }

  getIncludingStale(route: string, aircraftClass: string): RouteIntel | null {
    const row = this.db.prepare(
      "SELECT * FROM route_intel WHERE route = ? AND aircraft_class = ?",
    ).get(route, aircraftClass) as RouteIntelRow | undefined;
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
    return this.db.prepare("SELECT * FROM route_intel").all().map((r) => this.rowToRouteIntel(r as RouteIntelRow));
  }

  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM route_intel").get() as CountRow | undefined;
    return row?.cnt ?? 0;
  }
}

// ── OperatorProfileStore ────────────────────────────────────────────────

export class OperatorProfileStore {
  private readonly db: Database.Database;

  constructor(pathOrDb?: string | Database.Database) {
    this.db = typeof pathOrDb === "object" && pathOrDb !== null ? pathOrDb : getDb(pathOrDb);
  }

  private rowToProfile(row: OperatorProfileRow): OperatorProfile {
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
    const row = this.db.prepare("SELECT * FROM operator_profiles WHERE name = ?").get(name) as OperatorProfileRow | undefined;
    if (!row) return null;
    const profile = this.rowToProfile(row);
    if (isStale(profile.lastUpdated)) return null;
    return profile;
  }

  getIncludingStale(name: string): OperatorProfile | null {
    const row = this.db.prepare("SELECT * FROM operator_profiles WHERE name = ?").get(name) as OperatorProfileRow | undefined;
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
    return this.db.prepare("SELECT * FROM operator_profiles").all().map((r) => this.rowToProfile(r as OperatorProfileRow));
  }

  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM operator_profiles").get() as CountRow | undefined;
    return row?.cnt ?? 0;
  }
}

// ── ClientProfileStore ──────────────────────────────────────────────────

export class ClientProfileStore {
  private readonly db: Database.Database;

  constructor(pathOrDb?: string | Database.Database) {
    this.db = typeof pathOrDb === "object" && pathOrDb !== null ? pathOrDb : getDb(pathOrDb);
  }

  private rowToProfile(row: ClientProfileRow): ClientProfile {
    return {
      name: row.name,
      email: row.email,
      dealHistory: JSON.parse(row.deal_history || "[]"),
      avgPaymentTime: row.avg_payment_time,
      totalSpend: toDollars(row.total_spend_cents) ?? 0,
      tripFrequency: row.trip_frequency,
      preferredAircraftClass: row.preferred_aircraft_class as ClientProfile["preferredAircraftClass"],
      preferredRoutes: JSON.parse(row.preferred_routes || "[]"),
      lastUpdated: row.last_updated,
    };
  }

  get(nameOrEmail: string): ClientProfile | null {
    if (!nameOrEmail) return null;
    const needle = nameOrEmail.toLowerCase().trim();
    const row = this.db.prepare(
      "SELECT * FROM client_profiles WHERE LOWER(name) = ? OR LOWER(email) = ?",
    ).get(needle, needle) as ClientProfileRow | undefined;
    return row ? this.rowToProfile(row) : null;
  }

  upsert(profile: ClientProfile): void {
    // Try to find existing by email (primary) or name (secondary)
    let existing: { rowid: number } | undefined = undefined;
    if (profile.email) {
      existing = this.db.prepare(
        "SELECT rowid FROM client_profiles WHERE LOWER(email) = ?",
      ).get(profile.email.toLowerCase()) as { rowid: number } | undefined;
    }
    if (!existing && profile.name) {
      existing = this.db.prepare(
        "SELECT rowid FROM client_profiles WHERE LOWER(name) = ?",
      ).get(profile.name.toLowerCase()) as { rowid: number } | undefined;
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
    return this.db.prepare("SELECT * FROM client_profiles").all().map((r) => this.rowToProfile(r as ClientProfileRow));
  }

  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM client_profiles").get() as CountRow | undefined;
    return row?.cnt ?? 0;
  }
}

// ── ValidationLedgerStore ───────────────────────────────────────────────

export class ValidationLedgerStore {
  private readonly db: Database.Database;

  constructor(pathOrDb?: string | Database.Database) {
    this.db = typeof pathOrDb === "object" && pathOrDb !== null ? pathOrDb : getDb(pathOrDb);
  }

  private rowToEntry(row: ValidationLedgerRow): ValidationLedgerEntry {
    return {
      route: row.route,
      date: row.date,
      mode: row.mode as ValidationLedgerEntry["mode"],
      leadTimeHours: row.lead_time_hours,
      rliAtQuote: row.rli_at_quote as ValidationLedgerEntry["rliAtQuote"],
      rliScore: row.rli_score ?? undefined,
      dumontPhysicsEstimate: toDollars(row.dumont_physics_estimate_cents),
      ghostPositioningValue: row.ghost_positioning_value,
      operatorQuotedPrice: toDollars(row.operator_quoted_price_cents),
      osaClientPrice: toDollars(row.osa_client_price_cents),
      realizedMarginPct: row.realized_margin_pct,
      estimateDeltaPercent: row.estimate_delta_percent ?? undefined,
      rfqsSent: row.rfqs_sent,
      quotesReceived: row.quotes_received,
      operatorResponseMinutes: row.operator_response_minutes,
      clientDecisionMinutes: row.client_decision_minutes,
      outcome: row.outcome as ValidationLedgerEntry["outcome"],
      fleetResilienceUsed: Boolean(row.fleet_resilience_used),
      tripCompleted: row.trip_completed === null ? null : Boolean(row.trip_completed),
      notes: row.notes,
      // Benchmark 1: Ghost Positioning Spread
      ghostValueCents: row.ghost_value_cents ?? 0,
      ghostDescription: row.ghost_description ?? undefined,
      // Benchmark 4: Fleet Resilience
      tripOutcome: (row.trip_outcome as ValidationLedgerEntry["tripOutcome"]) ?? "completed",
      recoveryTimeMin: row.recovery_time_min ?? undefined,
      // Benchmark 5: Demand Prediction
      routePageViews7d: row.route_page_views_7d ?? undefined,
      // Benchmark 6: Client Decision Velocity
      optionsPresentedAt: row.options_presented_at ?? undefined,
      clientConfirmedAt: row.client_confirmed_at ?? undefined,
      // Benchmark 7: Network Density
      operatorsInNetwork: row.operators_in_network ?? undefined,
      operatorsInMetro: row.operators_in_metro ?? undefined,
      // Operator Intelligence
      operatorName: row.operator_name ?? undefined,
      operatorBase: row.operator_base ?? undefined,
      operatorReliabilityScore: row.operator_reliability_score ?? undefined,
      // Outcome
      revenueCents: row.revenue_cents ?? undefined,
      // Payment State
      paymentStatus: (row.payment_status as ValidationLedgerEntry["paymentStatus"]) ?? "pending",
      clientPaidAt: row.client_paid_at ?? undefined,
      operatorPaidAt: row.operator_paid_at ?? undefined,
      floatWindowHours: row.float_window_hours ?? undefined,
      // Timestamps
      createdAt: row.created_at ?? undefined,
      updatedAt: row.updated_at ?? undefined,
    };
  }

  append(entry: ValidationLedgerEntry): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO validation_ledger (
        route, date, mode, lead_time_hours, rli_at_quote, rli_score,
        dumont_physics_estimate_cents, ghost_positioning_value,
        operator_quoted_price_cents, osa_client_price_cents,
        realized_margin_pct, estimate_delta_percent,
        rfqs_sent, quotes_received,
        operator_response_minutes, client_decision_minutes,
        outcome, fleet_resilience_used, trip_completed, notes,
        ghost_value_cents, ghost_description,
        trip_outcome, recovery_time_min,
        route_page_views_7d,
        options_presented_at, client_confirmed_at,
        operators_in_network, operators_in_metro,
        operator_name, operator_base, operator_reliability_score,
        revenue_cents,
        payment_status, client_paid_at, operator_paid_at, float_window_hours,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.route, entry.date, entry.mode, entry.leadTimeHours, entry.rliAtQuote,
      entry.rliScore ?? null,
      toCents(entry.dumontPhysicsEstimate), entry.ghostPositioningValue,
      toCents(entry.operatorQuotedPrice), toCents(entry.osaClientPrice),
      entry.realizedMarginPct, entry.estimateDeltaPercent ?? null,
      entry.rfqsSent, entry.quotesReceived,
      entry.operatorResponseMinutes, entry.clientDecisionMinutes,
      entry.outcome, entry.fleetResilienceUsed ? 1 : 0,
      entry.tripCompleted === null ? null : (entry.tripCompleted ? 1 : 0),
      entry.notes,
      entry.ghostValueCents ?? 0, entry.ghostDescription ?? null,
      entry.tripOutcome ?? "completed", entry.recoveryTimeMin ?? null,
      entry.routePageViews7d ?? null,
      entry.optionsPresentedAt ?? null, entry.clientConfirmedAt ?? null,
      entry.operatorsInNetwork ?? null, entry.operatorsInMetro ?? null,
      entry.operatorName ?? null, entry.operatorBase ?? null, entry.operatorReliabilityScore ?? null,
      entry.revenueCents ?? null,
      entry.paymentStatus ?? "pending", entry.clientPaidAt ?? null, entry.operatorPaidAt ?? null, entry.floatWindowHours ?? null,
      entry.createdAt ?? now, entry.updatedAt ?? now,
    );
  }

  getByRoute(route: string): ValidationLedgerEntry[] {
    return this.db.prepare(
      "SELECT * FROM validation_ledger WHERE route = ? ORDER BY date",
    ).all(route).map((r) => this.rowToEntry(r as ValidationLedgerRow));
  }

  getBooked(): ValidationLedgerEntry[] {
    return this.db.prepare(
      "SELECT * FROM validation_ledger WHERE outcome = 'booked' ORDER BY date",
    ).all().map((r) => this.rowToEntry(r as ValidationLedgerRow));
  }

  getByDateRange(from: string, to: string): ValidationLedgerEntry[] {
    return this.db.prepare(
      "SELECT * FROM validation_ledger WHERE date >= ? AND date <= ? ORDER BY date",
    ).all(from, to).map((r) => this.rowToEntry(r as ValidationLedgerRow));
  }

  getAll(): ValidationLedgerEntry[] {
    return this.db.prepare("SELECT * FROM validation_ledger ORDER BY id").all()
      .map((r) => this.rowToEntry(r as ValidationLedgerRow));
  }

  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM validation_ledger").get() as CountRow | undefined;
    return row?.cnt ?? 0;
  }

  /**
   * Compute the 7 benchmark metrics via SQL aggregation.
   * Returns BenchmarkMetrics for the entire ledger.
   */
  getSummaryMetrics(): BenchmarkMetrics {
    // Benchmark 1: Ghost Positioning Spread
    const ghost = this.db.prepare(`
      SELECT COALESCE(SUM(ghost_value_cents), 0) AS total,
             COUNT(*) AS cnt
      FROM validation_ledger
      WHERE ghost_value_cents > 0
    `).get() as { total: number; cnt: number };

    // Benchmark 2: Operator Signal Ratio
    const signal = this.db.prepare(`
      SELECT COALESCE(SUM(rfqs_sent), 0) AS rfqs,
             COALESCE(SUM(quotes_received), 0) AS quotes
      FROM validation_ledger
    `).get() as { rfqs: number; quotes: number };

    // Benchmark 3: Margin by liquidity
    const marginByRli = (rli: string): number | null => {
      const row = this.db.prepare(`
        SELECT AVG(realized_margin_pct) AS avg_margin
        FROM validation_ledger
        WHERE rli_at_quote = ? AND realized_margin_pct IS NOT NULL
      `).get(rli) as { avg_margin: number | null } | undefined;
      return row?.avg_margin ?? null;
    };

    // Benchmark 4: Fleet Resilience
    const resilience = this.db.prepare(`
      SELECT
        SUM(CASE WHEN trip_outcome = 'disruption_recovered' THEN 1 ELSE 0 END) AS recovered,
        SUM(CASE WHEN trip_outcome = 'disruption_failed' THEN 1 ELSE 0 END) AS failed,
        AVG(CASE WHEN trip_outcome = 'disruption_recovered' THEN recovery_time_min END) AS avg_recovery
      FROM validation_ledger
    `).get() as { recovered: number; failed: number; avg_recovery: number | null };

    // Benchmark 5: Pricing accuracy (estimate_delta_percent)
    const pricing = this.db.prepare(`
      SELECT AVG(ABS(estimate_delta_percent)) AS avg_delta,
             COUNT(*) AS cnt
      FROM validation_ledger
      WHERE estimate_delta_percent IS NOT NULL
    `).get() as { avg_delta: number | null; cnt: number };

    // Benchmark 6: Client Decision Velocity
    const decision = this.db.prepare(`
      SELECT AVG(client_decision_minutes) AS avg_min
      FROM validation_ledger
      WHERE client_decision_minutes IS NOT NULL
    `).get() as { avg_min: number | null };

    // Benchmark 7: Network Density
    const network = this.db.prepare(`
      SELECT AVG(operators_in_network) AS avg_network,
             AVG(operators_in_metro) AS avg_metro
      FROM validation_ledger
      WHERE operators_in_network IS NOT NULL
    `).get() as { avg_network: number | null; avg_metro: number | null };

    return {
      ghostSpread: {
        totalCents: ghost.total,
        dealCount: ghost.cnt,
        avgPerDeal: ghost.cnt > 0 ? Math.round(ghost.total / ghost.cnt) : 0,
      },
      signalRatio: {
        rfqsSent: signal.rfqs,
        quotesReceived: signal.quotes,
        ratio: signal.rfqs > 0 ? signal.quotes / signal.rfqs : 0,
      },
      marginByLiquidity: {
        high: marginByRli("high"),
        medium: marginByRli("medium"),
        low: marginByRli("low"),
      },
      pricingAccuracy: {
        avgAbsDeltaPct: pricing.avg_delta ?? 0,
        sampleSize: pricing.cnt,
      },
      avgClientDecisionMin: decision.avg_min ?? null,
      networkDensity: {
        avgOperatorsInNetwork: network.avg_network ?? null,
        avgOperatorsInMetro: network.avg_metro ?? null,
      },
      fleetResilience: {
        recoveredCount: resilience.recovered ?? 0,
        failedCount: resilience.failed ?? 0,
        avgRecoveryMin: resilience.avg_recovery ?? null,
      },
    };
  }
}
