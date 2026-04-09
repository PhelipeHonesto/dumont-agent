/**
 * Chat context builder — token-optimized context injection for Dumont AI.
 * Layer: server
 *
 * Compass, not encyclopedia. Dense human-readable text, not raw JSON.
 * Target: under 500 tokens total context.
 */

import { DealStore } from "../memory/deal-store.js";
import { ValidationLedgerStore, OperatorProfileStore } from "../memory/composite-stores.js";
import { getDb } from "../memory/database.js";

// ── Lazy stores ─────────────────────────────────────────────────────────

let _dealStore: DealStore | null = null;
let _ledger: ValidationLedgerStore | null = null;
let _operators: OperatorProfileStore | null = null;

function ds(): DealStore {
  if (!_dealStore) _dealStore = new DealStore(getDb());
  return _dealStore;
}
function vl(): ValidationLedgerStore {
  if (!_ledger) _ledger = new ValidationLedgerStore(getDb());
  return _ledger;
}
function op(): OperatorProfileStore {
  if (!_operators) _operators = new OperatorProfileStore(getDb());
  return _operators;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function fmtK(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${n}`;
}

function pct(n: number | null): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

// ── Context builder ─────────────────────────────────────────────────────

export const BASE_PROMPT = `You are Dumont, the AI deal engine for Orange Sunshine Aviation. You are talking to Phelipe, the founder and ATP-rated pilot-in-command. You have access to the current deal pipeline, operator intelligence, and pricing data. Answer questions about deals, operators, routes, and pricing using the data provided. Be direct, use numbers, no filler. If a margin looks compressed, flag it. If an operator's response time is degrading, mention it.`;

/**
 * Build token-optimized context from SQLite stores.
 * Dense text format — under 500 tokens total.
 */
export function buildChatContext(dealId?: string): string {
  const lines: string[] = [];

  // ACTIVE PIPELINE — one line
  const deals = ds().getAll();
  const byResult: Record<string, number> = {};
  for (const d of deals) byResult[d.result] = (byResult[d.result] ?? 0) + 1;
  const stageParts = Object.entries(byResult).map(([k, v]) => `${k}:${v}`).join(" ");
  lines.push(`PIPELINE: ${deals.length} deals. ${stageParts}`);

  // CURRENT DEAL FOCUS — 5-8 lines max
  if (dealId) {
    const deal = deals.find((d) => d.id === dealId);
    if (deal) {
      lines.push("");
      lines.push("DEAL FOCUS:");
      lines.push(`  Route: ${deal.route.departure}→${deal.route.arrival} ${deal.aircraftClass ?? ""} ${deal.route.distance}nm`);
      if (deal.clientName) lines.push(`  Client: ${deal.clientName} (${deal.clientType})`);
      if (deal.aviapagesEstimate) lines.push(`  Estimate: ${fmtK(deal.aviapagesEstimate.low)}–${fmtK(deal.aviapagesEstimate.high)}`);
      if (deal.operatorName) lines.push(`  Operator: ${deal.operatorName} (${deal.operatorBase ?? "?"})`);
      if (deal.osaPrice) lines.push(`  OSA Price: ${fmtK(deal.osaPrice)} Margin: ${pct(deal.margin)}`);
      lines.push(`  Stage: ${deal.result} Delta: ${deal.estimateDelta != null ? pct(deal.estimateDelta) : "—"}`);
    }
  }

  // RECENT COMPLETED — last 5, one line each
  const recent = vl().getAll().slice(-5);
  if (recent.length > 0) {
    lines.push("");
    lines.push("RECENT DEALS:");
    for (const e of recent) {
      lines.push(`  [${e.date}] ${e.route}: Op ${fmtK(e.operatorQuotedPrice)}→OSA ${fmtK(e.osaClientPrice)} (${pct(e.realizedMarginPct != null ? e.realizedMarginPct / 100 : null)}). ${e.outcome}`);
    }
  }

  // TOP OPERATORS — top 5, one line each
  const ops = op().getAll()
    .sort((a, b) => b.reliabilityScore - a.reliabilityScore)
    .slice(0, 5);
  if (ops.length > 0) {
    lines.push("");
    lines.push("TOP OPERATORS:");
    for (const o of ops) {
      lines.push(`  ${o.name} (${o.homeBase}): Rel ${pct(o.reliabilityScore)} Speed ${Math.round(o.avgResponseTime)}m Delta ${pct(o.pricingDelta)} Deals:${o.dealCount}`);
    }
  }

  return lines.join("\n");
}
