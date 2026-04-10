/**
 * Operator Network — sortable stats with conversion bars and trend arrows.
 * Click operator to filter pipeline deals.
 */

import { useState, useMemo, useCallback } from "react";
import type { OperatorStats } from "../types";
import { TrendUp, TrendDown } from "./Icons";
import { fmtDuration } from "../utils";

type SortKey = "conversion" | "responseTime" | "deals";

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={{ width: "100%", height: 6, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4, transition: "width 0.3s" }} />
    </div>
  );
}

interface Props {
  operators: OperatorStats[];
  onFilterByOperator?: (name: string | null) => void;
  activeFilter?: string | null;
}

export function OperatorNetwork({ operators, onFilterByOperator, activeFilter }: Props) {
  const [sortBy, setSortBy] = useState<SortKey>("conversion");

  const sorted = useMemo(() => {
    const copy = [...operators];
    switch (sortBy) {
      case "conversion": copy.sort((a, b) => b.conversionRate - a.conversionRate); break;
      case "responseTime": copy.sort((a, b) => a.avgResponseTime - b.avgResponseTime); break;
      case "deals": copy.sort((a, b) => b.totalDeals - a.totalDeals); break;
    }
    return copy;
  }, [operators, sortBy]);

  const maxDeals = Math.max(...operators.map((o) => o.totalDeals), 1);

  const onSortClick = useCallback((key: SortKey) => {
    setSortBy(key);
  }, []);

  const onOperatorClick = useCallback((name: string) => {
    if (!onFilterByOperator) return;
    onFilterByOperator(activeFilter === name ? null : name);
  }, [onFilterByOperator, activeFilter]);

  return (
    <section aria-label="Operator network" style={{ padding: "16px 20px", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: 0, letterSpacing: 0.5, textTransform: "uppercase" }}>
          Operator Network
        </h2>
        {/* Sort buttons */}
        <div style={{ display: "flex", gap: 4 }}>
          {([
            { key: "conversion" as SortKey, label: "Conv" },
            { key: "responseTime" as SortKey, label: "Speed" },
            { key: "deals" as SortKey, label: "Deals" },
          ]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => onSortClick(key)}
              aria-label={`Sort by ${label}`}
              aria-pressed={sortBy === key}
              style={{
                padding: "2px 6px", borderRadius: 4, border: "none",
                fontSize: 9, fontFamily: "var(--font-mono)", fontWeight: 500,
                background: sortBy === key ? "var(--osa-orange)" : "var(--surface-hover)",
                color: sortBy === key ? "#fff" : "var(--text-muted)",
                cursor: "pointer", transition: "background 0.15s",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }} role="list">
        {sorted.map((op) => {
          const isFiltered = activeFilter === op.name;
          const improving = op.avgDelta <= 0;
          return (
            <div
              key={op.name}
              role="listitem"
              onClick={() => onOperatorClick(op.name)}
              style={{
                display: "flex", flexDirection: "column", gap: 4,
                cursor: onFilterByOperator ? "pointer" : "default",
                padding: 4, borderRadius: 4, marginLeft: -4, marginRight: -4,
                background: isFiltered ? "var(--surface-active)" : "transparent",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => { if (!isFiltered) (e.currentTarget as HTMLElement).style.background = "var(--surface-hover)"; }}
              onMouseLeave={(e) => { if (!isFiltered) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{op.name}</span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{op.base}</span>
                  {/* Trend arrow */}
                  {improving
                    ? <TrendUp size={10} color="var(--green)" />
                    : <TrendDown size={10} color="var(--osa-red)" />
                  }
                </div>
                <span
                  aria-label={`${(op.conversionRate * 100).toFixed(0)}% conversion rate`}
                  style={{
                    fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 600,
                    color: op.conversionRate >= 0.8 ? "var(--green)" : op.conversionRate >= 0.6 ? "var(--amber)" : "var(--osa-red)",
                  }}
                >
                  {(op.conversionRate * 100).toFixed(0)}%
                </span>
              </div>
              <Bar value={op.closedDeals} max={maxDeals} color="var(--osa-orange)" />
              <div style={{ display: "flex", gap: 12, fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                <span>{op.closedDeals}/{op.totalDeals} deals</span>
                <span>avg {fmtDuration(op.avgResponseTime)}</span>
                <span>{op.avgDelta >= 0 ? "+" : ""}{(op.avgDelta * 100).toFixed(0)}% delta</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
