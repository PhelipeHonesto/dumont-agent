/**
 * React hooks for consuming DealContext snapshots.
 * Fetches from the API with 30-second polling.
 * Falls back to demo fixture data if the API is unreachable.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import type { DealContext, DealRecord, DealMode, OperatorStats, ValidationLedgerEntry, LedgerSummary } from "../types";
import { DEMO_DEALS, DEMO_RECORDS, DEMO_OPERATOR_STATS } from "../fixtures/demo-deals";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const POLL_INTERVAL = 30_000;

const EMPTY_LEDGER_SUMMARY: LedgerSummary = {
  totalDeals: 0,
  bookedDeals: 0,
  winRate: 0,
  totalRevenue: 0,
  avgMargin: 0,
  avgResponseTime: 0,
};

export function useDealStore() {
  const [deals, setDeals] = useState<DealContext[]>(DEMO_DEALS);
  const [records, setRecords] = useState<DealRecord[]>(DEMO_RECORDS);
  const [mode, setMode] = useState<DealMode>("live");
  const [selectedDealId, setSelectedDealId] = useState<string | null>(DEMO_DEALS[0]?.id ?? null);
  const [ledgerEntries, setLedgerEntries] = useState<ValidationLedgerEntry[]>([]);
  const [ledgerSummary, setLedgerSummary] = useState<LedgerSummary>(EMPTY_LEDGER_SUMMARY);
  const [apiConnected, setApiConnected] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshCounterRef = useRef(0);
  const [refreshCounter, setRefreshCounter] = useState(0);

  // Fetch all data from API
  const fetchData = useCallback(async () => {
    try {
      const [dealsRes, metricsRes, ledgerRes] = await Promise.allSettled([
        fetch(`${API_BASE}/api/deals`),
        fetch(`${API_BASE}/api/metrics`),
        fetch(`${API_BASE}/api/ledger`),
      ]);

      let connected = false;

      if (dealsRes.status === "fulfilled" && dealsRes.value.ok) {
        const data = await dealsRes.value.json();
        if (Array.isArray(data) && data.length > 0) {
          setDeals(data);
          connected = true;
        }
      }

      if (metricsRes.status === "fulfilled" && metricsRes.value.ok) {
        // metrics endpoint may return records or summary — store if available
        const data = await metricsRes.value.json();
        if (data.records && Array.isArray(data.records)) {
          setRecords(data.records);
        }
      }

      if (ledgerRes.status === "fulfilled" && ledgerRes.value.ok) {
        const data = await ledgerRes.value.json();
        if (data.entries && Array.isArray(data.entries)) {
          setLedgerEntries(data.entries);
        }
        if (data.summary) {
          setLedgerSummary(data.summary);
        }
        connected = true;
      }

      if (!connected) {
        // Fall back to demo data if API returned nothing useful
        setDeals((prev) => prev.length > 0 ? prev : DEMO_DEALS);
        setRecords((prev) => prev.length > 0 ? prev : DEMO_RECORDS);
      }

      setApiConnected(connected);
    } catch {
      // API not reachable — keep existing data (demo or previously fetched)
      setApiConnected(false);
    }
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    fetchData();
    pollRef.current = setInterval(fetchData, POLL_INTERVAL);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchData]);

  // Manual refresh trigger (e.g., after review action)
  useEffect(() => {
    if (refreshCounter > 0) {
      fetchData();
    }
  }, [refreshCounter, fetchData]);

  const triggerRefresh = useCallback(() => {
    refreshCounterRef.current += 1;
    setRefreshCounter(refreshCounterRef.current);
  }, []);

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
    ledgerEntries,
    ledgerSummary,
    apiConnected,
    triggerRefresh,
  };
}
