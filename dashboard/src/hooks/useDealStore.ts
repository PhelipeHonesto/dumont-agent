/**
 * React hooks for consuming DealContext snapshots.
 * In production these will subscribe to orchestrator events.
 * For now they serve demo fixture data.
 */

import { useState, useCallback, useMemo } from "react";
import type { DealContext, DealRecord, DealMode, OperatorStats } from "../types";
import { DEMO_DEALS, DEMO_RECORDS, DEMO_OPERATOR_STATS } from "../fixtures/demo-deals";

export function useDealStore() {
  const [deals, setDeals] = useState<DealContext[]>(DEMO_DEALS);
  const [records] = useState<DealRecord[]>(DEMO_RECORDS);
  const [mode, setMode] = useState<DealMode>("live");
  const [selectedDealId, setSelectedDealId] = useState<string | null>(DEMO_DEALS[0]?.id ?? null);

  const filteredDeals = useMemo(
    () => (mode === "live" ? deals : deals).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [deals, mode],
  );

  const selectedDeal = useMemo(
    () => deals.find((d) => d.id === selectedDealId) ?? null,
    [deals, selectedDealId],
  );

  const toggleMode = useCallback(() => {
    setMode((m) => (m === "live" ? "sim" : "live"));
  }, []);

  // Learning loop metrics
  const metrics = useMemo(() => {
    const closed = records.filter((r) => r.result === "closed");
    const totalRevenue = closed.reduce((s, r) => s + (r.revenue ?? 0), 0);
    const avgDelta = records.filter((r) => r.estimateDelta !== null).reduce((s, r) => s + Math.abs(r.estimateDelta!), 0) / (records.filter((r) => r.estimateDelta !== null).length || 1);
    const convRate = records.length > 0 ? closed.length / records.length : 0;
    return {
      totalDeals: records.length,
      closedDeals: closed.length,
      totalRevenue,
      avgEstimateDelta: avgDelta,
      conversionRate: convRate,
    };
  }, [records]);

  const operatorStats: OperatorStats[] = DEMO_OPERATOR_STATS;

  return {
    deals: filteredDeals,
    records,
    selectedDeal,
    selectedDealId,
    setSelectedDealId,
    mode,
    toggleMode,
    metrics,
    operatorStats,
  };
}
