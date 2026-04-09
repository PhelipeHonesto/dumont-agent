/**
 * Deal Store — SQLite-backed storage for deal records.
 * Layer: memory
 *
 * All money stored as integer cents. Converted to dollars at the public API boundary.
 * Indexed on route, operator, client, and timestamp.
 */

import type Database from "better-sqlite3";
import type { DealRecord } from "../schemas/deal-record.js";
import { getDb } from "./database.js";

// ── Dollar ↔ Cents helpers ──────────────────────────────────────────────

function toCents(dollars: number | null): number | null {
  return dollars !== null ? Math.round(dollars * 100) : null;
}

function toDollars(cents: number | null): number | null {
  return cents !== null ? cents / 100 : null;
}

// ── Typed Row Interface ──────────────────────────────────────────────────

interface DealRow {
  id: string;
  timestamp: string;
  mode: string;
  route_departure: string;
  route_arrival: string;
  route_distance: number;
  estimate_low_cents: number | null;
  estimate_high_cents: number | null;
  operator_quote_cents: number | null;
  osa_price_cents: number | null;
  estimate_delta: number | null;
  operator_name: string | null;
  operator_base: string | null;
  operator_response_time: number | null;
  operator_conversion: number;
  aircraft_type: string | null;
  aircraft_class: string | null;
  client_name: string | null;
  client_contact: string | null;
  client_type: string;
  client_budget_min_cents: number | null;
  client_budget_max_cents: number | null;
  client_conversion: number;
  decision_time: number | null;
  result: string;
  revenue_cents: number | null;
  margin: number | null;
  total_deal_time: number | null;
  day_of_week: number;
  season: string;
  guardian_flags: string;
}

// ── Row ↔ DealRecord conversion ─────────────────────────────────────────

function rowToRecord(row: DealRow): DealRecord {
  return {
    id: row.id,
    timestamp: row.timestamp,
    mode: row.mode as DealRecord["mode"],
    route: {
      departure: row.route_departure,
      arrival: row.route_arrival,
      distance: row.route_distance,
    },
    aviapagesEstimate: row.estimate_low_cents !== null
      ? { low: toDollars(row.estimate_low_cents)!, high: toDollars(row.estimate_high_cents)! }
      : null,
    operatorQuote: toDollars(row.operator_quote_cents),
    osaPrice: toDollars(row.osa_price_cents),
    estimateDelta: row.estimate_delta,
    operatorName: row.operator_name,
    operatorBase: row.operator_base,
    operatorResponseTime: row.operator_response_time,
    operatorConversion: Boolean(row.operator_conversion),
    aircraftType: row.aircraft_type,
    aircraftClass: row.aircraft_class,
    clientName: row.client_name,
    clientContact: row.client_contact,
    clientType: row.client_type as DealRecord["clientType"],
    clientBudget: row.client_budget_min_cents !== null
      ? { min: toDollars(row.client_budget_min_cents)!, max: toDollars(row.client_budget_max_cents)! }
      : null,
    clientConversion: Boolean(row.client_conversion),
    decisionTime: row.decision_time,
    result: row.result as DealRecord["result"],
    revenue: toDollars(row.revenue_cents),
    margin: row.margin,
    totalDealTime: row.total_deal_time,
    dayOfWeek: row.day_of_week,
    season: row.season as DealRecord["season"],
    guardianFlags: JSON.parse(row.guardian_flags || "[]"),
  };
}

// ── DealStore ───────────────────────────────────────────────────────────

export class DealStore {
  private readonly db: Database.Database;

  constructor(pathOrDb?: string | Database.Database) {
    if (typeof pathOrDb === "object" && pathOrDb !== null) {
      this.db = pathOrDb;
    } else {
      this.db = getDb(pathOrDb);
    }
  }

  /** Expose the database instance for transactions across stores. */
  getDatabase(): Database.Database { return this.db; }

  add(record: DealRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO deals (
        id, timestamp, mode,
        route_departure, route_arrival, route_distance,
        estimate_low_cents, estimate_high_cents,
        operator_quote_cents, osa_price_cents, estimate_delta,
        operator_name, operator_base, operator_response_time, operator_conversion,
        aircraft_type, aircraft_class,
        client_name, client_contact, client_type,
        client_budget_min_cents, client_budget_max_cents,
        client_conversion, decision_time,
        result, revenue_cents, margin,
        total_deal_time, day_of_week, season,
        guardian_flags
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?
      )
    `).run(
      record.id, record.timestamp, record.mode,
      record.route.departure, record.route.arrival, record.route.distance,
      record.aviapagesEstimate ? toCents(record.aviapagesEstimate.low) : null,
      record.aviapagesEstimate ? toCents(record.aviapagesEstimate.high) : null,
      toCents(record.operatorQuote), toCents(record.osaPrice), record.estimateDelta,
      record.operatorName, record.operatorBase, record.operatorResponseTime,
      record.operatorConversion ? 1 : 0,
      record.aircraftType, record.aircraftClass,
      record.clientName, record.clientContact, record.clientType,
      record.clientBudget ? toCents(record.clientBudget.min) : null,
      record.clientBudget ? toCents(record.clientBudget.max) : null,
      record.clientConversion ? 1 : 0, record.decisionTime,
      record.result, toCents(record.revenue), record.margin,
      record.totalDealTime, record.dayOfWeek, record.season,
      JSON.stringify(record.guardianFlags),
    );
  }

  getAll(): DealRecord[] {
    return this.db.prepare("SELECT * FROM deals ORDER BY timestamp").all().map((r) => rowToRecord(r as DealRow));
  }

  getByRoute(departure: string, arrival: string): DealRecord[] {
    return this.db.prepare(
      "SELECT * FROM deals WHERE route_departure = ? AND route_arrival = ? ORDER BY timestamp",
    ).all(departure, arrival).map((r) => rowToRecord(r as DealRow));
  }

  getByOperator(operatorName: string): DealRecord[] {
    return this.db.prepare(
      "SELECT * FROM deals WHERE operator_name = ? ORDER BY timestamp",
    ).all(operatorName).map((r) => rowToRecord(r as DealRow));
  }

  getByClient(clientType: "new" | "repeat"): DealRecord[] {
    return this.db.prepare(
      "SELECT * FROM deals WHERE client_type = ? ORDER BY timestamp",
    ).all(clientType).map((r) => rowToRecord(r as DealRow));
  }

  /**
   * Find past deals by client name or contact (case-insensitive match).
   * Email matches are exact; name matches use LIKE for substring.
   */
  findClientDeals(nameOrContact: string): DealRecord[] {
    if (!nameOrContact) return [];
    const needle = nameOrContact.trim();
    // If it looks like an email, do exact match on contact
    if (needle.includes("@")) {
      return this.db.prepare(
        "SELECT * FROM deals WHERE client_contact = ? COLLATE NOCASE ORDER BY timestamp",
      ).all(needle).map((r) => rowToRecord(r as DealRow));
    }
    // Otherwise search by name or contact substring (escape LIKE metacharacters)
    const escaped = needle.replace(/[%_\\]/g, (c) => `\\${c}`);
    const like = `%${escaped}%`;
    return this.db.prepare(
      "SELECT * FROM deals WHERE client_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR client_contact LIKE ? ESCAPE '\\' COLLATE NOCASE ORDER BY timestamp",
    ).all(like, like).map((r) => rowToRecord(r as DealRow));
  }

  getLatestClientDeal(nameOrContact: string): DealRecord | null {
    const deals = this.findClientDeals(nameOrContact);
    if (deals.length === 0) return null;
    return deals.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]!;
  }

  getPricingDelta(departure: string, arrival: string): number | null {
    const row = this.db.prepare(
      "SELECT AVG(estimate_delta) as avg_delta FROM deals WHERE route_departure = ? AND route_arrival = ? AND estimate_delta IS NOT NULL",
    ).get(departure, arrival) as { avg_delta: number | null } | undefined;
    return row?.avg_delta ?? null;
  }

  getOperatorStats(operatorName: string, departure: string, arrival: string) {
    const rows = this.db.prepare(
      "SELECT * FROM deals WHERE operator_name = ? AND route_departure = ? AND route_arrival = ?",
    ).all(operatorName, departure, arrival) as DealRow[];
    if (rows.length === 0) return null;

    const records = rows.map(rowToRecord);
    const conversions = records.filter((r) => r.operatorConversion).length;
    const withResponse = records.filter((r) => r.operatorResponseTime !== null);
    const avgResponseTime = withResponse.length > 0
      ? withResponse.reduce((acc, r) => acc + (r.operatorResponseTime ?? 0), 0) / withResponse.length
      : 0;

    return {
      totalDeals: records.length,
      conversionRate: conversions / records.length,
      avgResponseTime,
    };
  }

  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM deals").get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }
}
