/**
 * Intelligence View — Validation Ledger table + KPI cards.
 * Shows deal intelligence metrics and full ledger history.
 */

import type { ValidationLedgerEntry, LedgerSummary } from "../types";
import { fmtPrice, fmtPct } from "../utils";

interface Props {
  entries: ValidationLedgerEntry[];
  summary: LedgerSummary;
  onExportCSV: () => void;
}

// ── KPI Card ──────────────────────────────────────────────────────────────

function KPICard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{
      flex: 1, minWidth: 140, padding: "14px 16px",
      background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4,
    }}>
      <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ── Outcome color ─────────────────────────────────────────────────────────

function outcomeColor(outcome: string): string {
  if (outcome === "booked") return "var(--green)";
  if (outcome === "lost_price") return "var(--osa-red)";
  if (outcome === "lost_timing") return "var(--amber)";
  if (outcome === "lost_ghosted") return "var(--text-muted)";
  return "var(--text-secondary)";
}

// ── Main component ────────────────────────────────────────────────────────

export function IntelligenceView({ entries, summary, onExportCSV }: Props) {
  const thStyle: React.CSSProperties = {
    padding: "8px 10px", fontSize: 10, fontWeight: 600, color: "var(--text-muted)",
    textTransform: "uppercase", letterSpacing: 0.5, textAlign: "left",
    borderBottom: "1px solid var(--border)", whiteSpace: "nowrap",
    fontFamily: "var(--font-mono)",
  };

  const tdStyle: React.CSSProperties = {
    padding: "7px 10px", fontSize: 11, fontFamily: "var(--font-mono)",
    color: "var(--text-primary)", borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
  };

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: 0, letterSpacing: 0.5, textTransform: "uppercase" }}>
          Intelligence
        </h2>
        <button
          onClick={onExportCSV}
          style={{
            padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 4,
            background: "var(--surface)", color: "var(--text-secondary)", cursor: "pointer",
            fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 600,
          }}
        >
          Export CSV
        </button>
      </div>

      {/* KPI cards */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <KPICard
          label="Total Deals"
          value={String(summary.totalDeals)}
          sub={`${summary.bookedDeals} booked`}
        />
        <KPICard
          label="Win Rate"
          value={summary.totalDeals > 0 ? `${(summary.winRate * 100).toFixed(1)}%` : "\u2014"}
        />
        <KPICard
          label="Avg Margin"
          value={summary.avgMargin > 0 ? `${(summary.avgMargin * 100).toFixed(1)}%` : "\u2014"}
        />
        <KPICard
          label="Avg Response"
          value={summary.avgResponseTime > 0 ? `${Math.round(summary.avgResponseTime)}m` : "\u2014"}
          sub="operator response"
        />
      </div>

      {/* Ledger table */}
      {entries.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
          No ledger entries yet. Complete deals to populate intelligence data.
        </div>
      ) : (
        <div style={{ overflow: "auto", border: "1px solid var(--border)", borderRadius: 4 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000 }}>
            <thead>
              <tr style={{ background: "var(--surface)" }}>
                <th style={thStyle}>Route</th>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Lead Time</th>
                <th style={thStyle}>RLI</th>
                <th style={thStyle}>Physics Est</th>
                <th style={thStyle}>Op Quote</th>
                <th style={thStyle}>OSA Price</th>
                <th style={thStyle}>Margin%</th>
                <th style={thStyle}>Response</th>
                <th style={thStyle}>Outcome</th>
                <th style={{ ...thStyle, minWidth: 120 }}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "var(--surface)" }}>
                  <td style={tdStyle}>{entry.route}</td>
                  <td style={tdStyle}>{entry.date}</td>
                  <td style={tdStyle}>{entry.leadTimeHours}h</td>
                  <td style={tdStyle}>{entry.rliAtQuote}</td>
                  <td style={tdStyle}>{fmtPrice(entry.dumontPhysicsEstimate)}</td>
                  <td style={tdStyle}>{fmtPrice(entry.operatorQuotedPrice)}</td>
                  <td style={tdStyle}>{fmtPrice(entry.osaClientPrice)}</td>
                  <td style={tdStyle}>{fmtPct(entry.realizedMarginPct)}</td>
                  <td style={tdStyle}>{entry.operatorResponseMinutes != null ? `${entry.operatorResponseMinutes}m` : "\u2014"}</td>
                  <td style={{ ...tdStyle, color: outcomeColor(entry.outcome), fontWeight: 600 }}>{entry.outcome}</td>
                  <td style={{ ...tdStyle, whiteSpace: "normal", maxWidth: 200, fontSize: 10, color: "var(--text-muted)" }}>{entry.notes || "\u2014"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
