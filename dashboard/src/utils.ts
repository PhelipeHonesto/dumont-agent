/** Shared formatting utilities for Mission Control. */

import type { DealStage, DealContext } from "./types";

/** Format a price as "$XX,XXX" or "—" if null. */
export function fmtPrice(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toLocaleString()}`;
}

/** Format seconds as human-readable duration. */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

/** Format an ISO timestamp as relative time ("4m ago", "2h ago", "3d ago"). */
export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/** Format a percentage as "XX.X%". */
export function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(decimals)}%`;
}

/** Pipeline stage ordering. */
const STAGE_ORDER: Record<string, number> = {
  intake: 0, qualified: 1, estimated: 2, sourced: 3,
  quoted: 4, awaiting_review: 5, presented: 6, confirmed: 7, closed: 8,
};

export function stageIndex(stage: DealStage): number {
  return STAGE_ORDER[stage] ?? -1;
}

/** Next step label for a deal. */
export function nextStep(deal: DealContext): string | null {
  const NEXT: Record<string, string> = {
    intake: "Qualification",
    qualified: "Estimate",
    estimated: "Sourcing",
    sourced: "Operator quote",
    quoted: "Broker review",
    awaiting_review: "Presentation",
    presented: "Client decision",
    confirmed: "Close",
  };
  return NEXT[deal.stage] ?? null;
}

/** Timer countdown: minutes remaining on a presented deal. */
export function timerRemaining(deal: DealContext): number | null {
  if (deal.stage !== "presented" || !deal.quote.validUntil) return null;
  const ms = new Date(deal.quote.validUntil).getTime() - Date.now();
  return Math.max(0, Math.round(ms / 60_000));
}

/** Timer urgency level. */
export function timerLevel(deal: DealContext): "none" | "amber" | "red" | "expired" {
  if (!deal.presentation.timerStarted || !deal.quote.validUntil) return "none";
  const startMs = new Date(deal.presentation.timerStarted).getTime();
  const endMs = new Date(deal.quote.validUntil).getTime();
  const elapsed = (Date.now() - startMs) / (endMs - startMs);
  if (elapsed >= 1) return "expired";
  if (elapsed >= 0.9) return "red";
  if (elapsed >= 0.7) return "amber";
  return "none";
}

/** Budget utilization bar: how much of the budget the OSA price consumes. */
export function budgetUtilization(deal: DealContext): number | null {
  if (!deal.client.budget || !deal.quote.osaPrice) return null;
  return deal.quote.osaPrice / deal.client.budget.max;
}
