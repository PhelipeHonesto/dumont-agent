/**
 * Chat context builder — token-optimized context injection for Dumont AI.
 * Layer: server
 *
 * Compass, not encyclopedia. Dense human-readable text, not raw JSON.
 * Target: under 700 tokens total context.
 */

import { DealStore } from "../memory/deal-store.js";
import { ValidationLedgerStore, OperatorProfileStore } from "../memory/composite-stores.js";
import { KnowledgeGraphStore } from "../memory/knowledge-graph.js";
import { getDb } from "../memory/database.js";

// ── Lazy stores ─────────────────────────────────────────────────────────

let _dealStore: DealStore | null = null;
let _ledger: ValidationLedgerStore | null = null;
let _operators: OperatorProfileStore | null = null;
let _kg: KnowledgeGraphStore | null = null;

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
function kg(): KnowledgeGraphStore {
  if (!_kg) _kg = new KnowledgeGraphStore(getDb());
  return _kg;
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

  // BENCHMARKS — 7 intelligence metrics
  const bm = vl().getSummaryMetrics();
  lines.push("");
  lines.push("BENCHMARKS:");
  lines.push(`  Ghost Spread: ${fmtCents(bm.ghostSpread.totalCents)} captured (${bm.ghostSpread.dealCount} deals, avg ${fmtCents(bm.ghostSpread.avgPerDeal)}/deal)`);
  lines.push(`  Signal Ratio: ${pct(bm.signalRatio.ratio)} (${bm.signalRatio.quotesReceived}/${bm.signalRatio.rfqsSent} RFQs)`);
  lines.push(`  Margin: ${bm.marginByLiquidity.high != null ? bm.marginByLiquidity.high.toFixed(1) + "%" : "—"} liquid / ${bm.marginByLiquidity.low != null ? bm.marginByLiquidity.low.toFixed(1) + "%" : "—"} constrained`);
  lines.push(`  Pricing Accuracy: ±${bm.pricingAccuracy.avgAbsDeltaPct.toFixed(1)}% (${bm.pricingAccuracy.sampleSize} samples)`);

  // OPERATOR DELTAS — top operators sorted by pricing delta
  const allOps = op().getAll();
  const opsWithDeals = allOps.filter((o) => o.dealCount > 0).sort((a, b) => b.pricingDelta - a.pricingDelta);
  if (opsWithDeals.length > 0) {
    lines.push("");
    lines.push("OPERATOR DELTAS (30d):");
    for (const o of opsWithDeals.slice(0, 5)) {
      const sign = o.pricingDelta >= 0 ? "+" : "";
      const label = o.pricingDelta < -0.02 ? " (hungry)" : o.pricingDelta > 0.05 ? " (premium)" : "";
      lines.push(`  ${o.name} (${o.homeBase}): ${sign}${(o.pricingDelta * 100).toFixed(1)}% vs physics${label}`);
    }
  }

  // KNOWLEDGE GRAPH — airport + operator counts
  try {
    const kgSummary = kg().getSummary();
    if (kgSummary.airportCount > 0 || kgSummary.operatorCount > 0) {
      lines.push("");
      lines.push("KNOWLEDGE GRAPH:");
      lines.push(`  Airports: ${kgSummary.airportCount} seeded`);
      lines.push(`  Operators: ${kgSummary.operatorCount} Part 135 certified`);
    }

    // ROUTE info when deal has departure/arrival
    if (dealId) {
      const deal = deals.find((d) => d.id === dealId);
      if (deal?.route?.departure && deal?.route?.arrival) {
        const depApt = kg().getAirport(deal.route.departure);
        const arrApt = kg().getAirport(deal.route.arrival);
        if (depApt || arrApt) {
          lines.push("");
          lines.push(`ROUTE (${deal.route.departure} → ${deal.route.arrival}):`);
          if (depApt) {
            const depIls = depApt.hasInstrumentApproach ? "ILS" : "VFR";
            lines.push(`  Dep: ${depApt.city ?? depApt.name}, ${depApt.state ?? depApt.country} — ${depApt.longestRunwayFt ?? "?"}ft runway, ${depIls}`);
          }
          if (arrApt) {
            const arrIls = arrApt.hasInstrumentApproach ? "ILS" : "VFR";
            lines.push(`  Arr: ${arrApt.city ?? arrApt.name}, ${arrApt.state ?? arrApt.country} — ${arrApt.longestRunwayFt ?? "?"}ft runway, ${arrIls}`);
          }
        }
      }
    }
  } catch {
    // KG tables may not exist yet — skip silently
  }

  // LIVE FLEET (ADS-B) — only if data exists, kept under 50 tokens
  try {
    const kgStore = kg();
    if (kgStore.hasAdsbData()) {
      const fleet = kgStore.getFleetStats();
      lines.push("");
      lines.push(`LIVE FLEET (ADS-B): ${fleet.total} tracked: ${fleet.airborne} airborne, ${fleet.idleTransient} idle transient (ghost inventory)`);

      // If we have a deal with a specific origin, show ghost candidates
      if (dealId) {
        const deal = deals.find((d) => d.id === dealId);
        if (deal?.route?.departure) {
          const ghosts = kgStore.getGhostCandidates(
            deal.route.departure,
            deal.aircraftClass ?? "midsize",
          );
          if (ghosts.length > 0) {
            lines.push(`  Ghost near ${deal.route.departure}: ${ghosts.length} idle ${deal.aircraftClass ?? "midsize"} aircraft`);
          }
        }
      }
    }
  } catch {
    // ADS-B tables may not exist yet — skip silently
  }

  return lines.join("\n");
}

function fmtCents(cents: number): string {
  if (cents >= 100000) return `$${Math.round(cents / 100000)}K`;
  if (cents >= 100) return `$${Math.round(cents / 100)}`;
  return `$${(cents / 100).toFixed(2)}`;
}
