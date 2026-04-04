/**
 * Deal Store — JSON file-backed storage for deal records.
 * Feeds the learning loop. Simple for <100 deals per spec.
 *
 * Per spec: learning-loop.md
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { DealRecord } from "../schemas/deal-record.js";
import { DealRecordSchema } from "../schemas/deal-record.js";

const DEFAULT_PATH = "./data/deals.json";

export class DealStore {
  private records: DealRecord[] = [];
  private readonly path: string;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
    this.load();
  }

  private load(): void {
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf-8"));
        this.records = Array.isArray(raw)
          ? raw.filter((r) => DealRecordSchema.safeParse(r).success)
          : [];
      } catch {
        this.records = [];
      }
    }
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.records, null, 2));
  }

  add(record: DealRecord): void {
    this.records.push(record);
    this.save();
  }

  getAll(): DealRecord[] {
    return [...this.records];
  }

  getByRoute(departure: string, arrival: string): DealRecord[] {
    return this.records.filter(
      (r) => r.route.departure === departure && r.route.arrival === arrival,
    );
  }

  getByOperator(operatorName: string): DealRecord[] {
    return this.records.filter((r) => r.operatorName === operatorName);
  }

  getByClient(clientType: "new" | "repeat"): DealRecord[] {
    return this.records.filter((r) => r.clientType === clientType);
  }

  /**
   * Find past deals by client name or contact (case-insensitive substring match).
   * Used by Intake to detect repeat clients.
   */
  findClientDeals(nameOrContact: string): DealRecord[] {
    if (!nameOrContact) return [];
    const needle = nameOrContact.toLowerCase().trim();
    return this.records.filter((r) => {
      const name = r.clientName?.toLowerCase() ?? "";
      const contact = r.clientContact?.toLowerCase() ?? "";
      return name.includes(needle) || contact.includes(needle) ||
             (needle.includes("@") && contact === needle) ||
             (name && needle.includes(name));
    });
  }

  /**
   * Get the most recent deal for a client — used to pre-populate preferences.
   */
  getLatestClientDeal(nameOrContact: string): DealRecord | null {
    const deals = this.findClientDeals(nameOrContact);
    if (deals.length === 0) return null;
    return deals.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]!;
  }

  /** Pricing delta for a route — how much Aviapages under/over-estimates */
  getPricingDelta(departure: string, arrival: string): number | null {
    const routeDeals = this.getByRoute(departure, arrival)
      .filter((r) => r.estimateDelta !== null);
    if (routeDeals.length === 0) return null;
    const sum = routeDeals.reduce((acc, r) => acc + (r.estimateDelta ?? 0), 0);
    return sum / routeDeals.length;
  }

  /** Operator ranking data for a route */
  getOperatorStats(operatorName: string, departure: string, arrival: string) {
    const deals = this.records.filter(
      (r) =>
        r.operatorName === operatorName &&
        r.route.departure === departure &&
        r.route.arrival === arrival,
    );
    if (deals.length === 0) return null;

    const conversions = deals.filter((r) => r.operatorConversion).length;
    const avgResponseTime =
      deals
        .filter((r) => r.operatorResponseTime !== null)
        .reduce((acc, r) => acc + (r.operatorResponseTime ?? 0), 0) /
      (deals.filter((r) => r.operatorResponseTime !== null).length || 1);

    return {
      totalDeals: deals.length,
      conversionRate: conversions / deals.length,
      avgResponseTime,
    };
  }

  get count(): number {
    return this.records.length;
  }
}
