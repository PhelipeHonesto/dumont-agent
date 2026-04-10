/** SDR qualification pipeline — four-column kanban with metrics. */

import { useMemo } from "react";
import { fmtRelative } from "../utils";

interface SDRItem {
  id: string; clientName: string; route: string; classification: string;
  reason: string; draftStatus: string; receivedAt: string; dealId: string | null;
}

const COLS: { key: string; label: string; color: string }[] = [
  { key: "qualified_with_budget", label: "Qualified", color: "var(--green)" },
  { key: "qualified_no_budget", label: "No Budget", color: "var(--amber)" },
  { key: "not_qualified", label: "Not Qualified", color: "var(--text-muted)" },
  { key: "budget_mismatch", label: "Budget Mismatch", color: "var(--osa-red)" },
];

interface Props {
  items: SDRItem[];
  onSelectDeal?: (dealId: string) => void;
}

export function SDRQueue({ items, onSelectDeal }: Props) {
  const grouped = useMemo(() => {
    const map: Record<string, SDRItem[]> = {};
    for (const col of COLS) map[col.key] = [];
    for (const item of items) {
      if (map[item.classification]) map[item.classification]!.push(item);
    }
    return map;
  }, [items]);

  const total = items.length;
  const qualified = items.filter((i) => i.classification.startsWith("qualified")).length;
  const autoResponded = items.filter((i) => i.draftStatus === "auto").length;

  return (
    <div aria-label="SDR qualification queue" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Metrics bar */}
      <div style={{ display: "flex", gap: 16, padding: "12px 16px", borderBottom: "1px solid var(--border)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
        <span style={{ color: "var(--text-muted)" }}>Inbound: <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{total}</span></span>
        <span style={{ color: "var(--text-muted)" }}>Qualified: <span style={{ color: "var(--green)", fontWeight: 600 }}>{total > 0 ? Math.round((qualified / total) * 100) : 0}%</span></span>
        <span style={{ color: "var(--text-muted)" }}>Auto-responded: <span style={{ color: "var(--osa-orange)", fontWeight: 600 }}>{total > 0 ? Math.round((autoResponded / total) * 100) : 0}%</span></span>
      </div>

      {/* Columns */}
      <div style={{ display: "flex", flex: 1, overflow: "auto", gap: 2 }}>
        {COLS.map((col) => (
          <div key={col.key} style={{ flex: 1, minWidth: 180, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border)" }}>
            <div style={{ padding: "8px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: col.color }}>{col.label}</span>
              <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{grouped[col.key]?.length ?? 0}</span>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "0 6px 6px" }}>
              {(grouped[col.key] ?? []).map((item) => (
                <div
                  key={item.id}
                  onClick={() => item.dealId && onSelectDeal?.(item.dealId)}
                  style={{
                    padding: "8px 10px", borderRadius: 4, background: "var(--surface-hover)",
                    marginBottom: 4, cursor: item.dealId ? "pointer" : "default",
                    borderLeft: `3px solid ${col.color}`, animation: "fadeIn 0.2s ease-out",
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>{item.clientName}</div>
                  <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", marginTop: 2 }}>{item.route}</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>{item.reason}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                    <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", padding: "1px 4px", borderRadius: 2, background: item.draftStatus === "auto" ? "var(--surface-active)" : "var(--surface)", color: item.draftStatus === "auto" ? "var(--osa-orange)" : "var(--text-muted)" }}>
                      {item.draftStatus}
                    </span>
                    <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{fmtRelative(item.receivedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
