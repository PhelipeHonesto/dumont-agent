/**
 * Intelligence View — Benchmark KPIs, Validation Ledger, Operator Intelligence, Financial Ops.
 */

import { useState, useEffect, useCallback } from "react";
import type { ValidationLedgerEntry, LedgerSummary, BenchmarkMetrics, OperatorProfile } from "../types";
import { fmtPrice, fmtPct } from "../utils";

interface Props {
  entries: ValidationLedgerEntry[];
  summary: LedgerSummary;
  benchmarks: BenchmarkMetrics | null;
  operators: OperatorProfile[];
  onExportCSV: () => void;
}

// ── Benchmark KPI Card ───────────────────────────────────────────────────

function BenchmarkCard({ label, value, valueColor, subtitle }: {
  label: string;
  value: string;
  valueColor?: string;
  subtitle?: string;
}) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4, padding: 12 }}>
      <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)", color: valueColor ?? "var(--text-primary)" }}>
        {value}
      </div>
      {subtitle && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

// ── Color helpers ────────────────────────────────────────────────────────

function outcomeColor(outcome: string): string {
  if (outcome === "booked") return "var(--green)";
  if (outcome === "lost_price") return "var(--osa-red)";
  if (outcome === "lost_timing") return "var(--amber)";
  if (outcome === "lost_ghosted") return "var(--text-muted)";
  if (outcome === "cancelled") return "var(--text-muted)";
  return "var(--text-secondary)";
}

function rliDotColor(rli: string): string {
  if (rli === "high") return "var(--green)";
  if (rli === "medium") return "var(--amber)";
  return "var(--osa-red)";
}

function marginColor(pct: number | null): string {
  if (pct == null) return "var(--text-primary)";
  const m = pct * 100;
  if (m >= 8 && m <= 15) return "var(--green)";
  if ((m >= 5 && m < 8) || (m > 15 && m <= 20)) return "var(--amber)";
  return "var(--osa-red)";
}

function paymentPillColor(status?: string): { bg: string; text: string; bold: boolean } {
  switch (status) {
    case "margin_captured": return { bg: "var(--green)", text: "#000", bold: true };
    case "operator_paid": return { bg: "var(--green)", text: "#000", bold: false };
    case "client_paid": return { bg: "#3b82f6", text: "#fff", bold: false };
    case "invoiced": return { bg: "var(--amber)", text: "#000", bold: false };
    default: return { bg: "var(--surface)", text: "var(--text-muted)", bold: false };
  }
}

function velocityColor(min: number): string {
  if (min < 30) return "var(--green)";
  if (min <= 120) return "var(--amber)";
  return "var(--osa-red)";
}

function accuracyColor(pct: number): string {
  if (pct < 8) return "var(--green)";
  if (pct <= 15) return "var(--amber)";
  return "var(--osa-red)";
}

// ── Pill component ───────────────────────────────────────────────────────

function Pill({ label, bg, color, bold }: { label: string; bg: string; color: string; bold?: boolean }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 3,
      fontSize: 10, fontWeight: bold ? 700 : 600, fontFamily: "var(--font-mono)",
      background: bg, color,
    }}>
      {label}
    </span>
  );
}

// ── Cents → dollars ──────────────────────────────────────────────────────

function fmtCents(cents: number | undefined): string {
  if (cents == null || cents === 0) return "\u2014";
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// ── Main component ───────────────────────────────────────────────────────

export function IntelligenceView({ entries, summary, benchmarks, operators, onExportCSV }: Props) {
  const [finOpsOpen, setFinOpsOpen] = useState(false);

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

  // Sort operators by deal count descending
  const sortedOperators = [...operators].sort((a, b) => b.dealCount - a.dealCount);

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

      {/* ── 2A: Benchmark KPI Cards (7 cards) ─────────────────────────── */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
        gap: 12,
        marginBottom: 20,
      }}>
        {/* 1. Ghost Positioning */}
        <BenchmarkCard
          label="Ghost Positioning"
          value={benchmarks?.ghostSpread?.totalCents ? fmtCents(benchmarks.ghostSpread.totalCents) : "\u2014"}
          valueColor="var(--green)"
          subtitle={benchmarks?.ghostSpread ? `${benchmarks.ghostSpread.dealCount} deals with ghost capture` : "Close deals to populate"}
        />
        {/* 2. Signal Ratio */}
        <BenchmarkCard
          label="Signal Ratio"
          value={benchmarks?.signalRatio ? `${(benchmarks.signalRatio.ratio * 100).toFixed(1)}%` : "\u2014"}
          valueColor="var(--green)"
          subtitle={benchmarks?.signalRatio ? `${benchmarks.signalRatio.quotesReceived}/${benchmarks.signalRatio.rfqsSent} RFQs` : "Close deals to populate"}
        />
        {/* 3. Margin by Liquidity */}
        <BenchmarkCard
          label="Margin by Liquidity"
          value={benchmarks?.marginByLiquidity
            ? `${benchmarks.marginByLiquidity.high != null ? (benchmarks.marginByLiquidity.high * 100).toFixed(1) : "\u2014"}% liquid / ${benchmarks.marginByLiquidity.low != null ? (benchmarks.marginByLiquidity.low * 100).toFixed(1) : "\u2014"}% constrained`
            : "\u2014"}
          subtitle={!benchmarks ? "Close deals to populate" : undefined}
        />
        {/* 4. Fleet Resilience */}
        <BenchmarkCard
          label="Fleet Resilience"
          value={benchmarks?.fleetResilience
            ? (() => {
                const { recoveredCount, failedCount } = benchmarks.fleetResilience;
                const total = recoveredCount + failedCount;
                const rate = total > 0 ? ((total - failedCount) / total * 100).toFixed(1) : "100.0";
                return `${rate}%`;
              })()
            : "\u2014"}
          subtitle={benchmarks?.fleetResilience ? `${benchmarks.fleetResilience.recoveredCount} recoveries` : "Close deals to populate"}
        />
        {/* 5. Decision Velocity */}
        <BenchmarkCard
          label="Decision Velocity"
          value={benchmarks?.avgClientDecisionMin != null ? `${benchmarks.avgClientDecisionMin.toFixed(0)}m` : "\u2014"}
          valueColor={benchmarks?.avgClientDecisionMin != null ? velocityColor(benchmarks.avgClientDecisionMin) : undefined}
          subtitle={!benchmarks ? "Close deals to populate" : undefined}
        />
        {/* 6. Network Density */}
        <BenchmarkCard
          label="Network Density"
          value={benchmarks?.networkDensity
            ? `${benchmarks.networkDensity.avgOperatorsInNetwork ?? "\u2014"} operators / ${benchmarks.networkDensity.avgOperatorsInMetro ?? "\u2014"} per metro`
            : "\u2014"}
          subtitle={!benchmarks ? "Close deals to populate" : undefined}
        />
        {/* 7. Pricing Accuracy */}
        <BenchmarkCard
          label="Pricing Accuracy"
          value={benchmarks?.pricingAccuracy ? `\u00B1${benchmarks.pricingAccuracy.avgAbsDeltaPct.toFixed(1)}%` : "\u2014"}
          valueColor={benchmarks?.pricingAccuracy ? accuracyColor(benchmarks.pricingAccuracy.avgAbsDeltaPct) : undefined}
          subtitle={benchmarks?.pricingAccuracy ? `${benchmarks.pricingAccuracy.sampleSize} sample deals` : "Close deals to populate"}
        />
      </div>

      {/* ── 2B: Validation Ledger Table ───────────────────────────────── */}
      {entries.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
          No ledger entries yet. Complete deals to populate intelligence data.
        </div>
      ) : (
        <div style={{ overflow: "auto", border: "1px solid var(--border)", borderRadius: 4, marginBottom: 24 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1400 }}>
            <thead>
              <tr style={{ background: "var(--surface)" }}>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Route</th>
                <th style={thStyle}>Lead Time</th>
                <th style={thStyle}>RLI</th>
                <th style={thStyle}>Ghost $</th>
                <th style={thStyle}>Op Quote</th>
                <th style={thStyle}>OSA Price</th>
                <th style={thStyle}>Margin%</th>
                <th style={thStyle}>Signal</th>
                <th style={thStyle}>Op Response</th>
                <th style={thStyle}>Decision</th>
                <th style={thStyle}>Outcome</th>
                <th style={thStyle}>Payment</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => {
                const payPill = paymentPillColor(entry.paymentStatus);
                return (
                  <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "var(--surface)" }}>
                    <td style={tdStyle}>{entry.date}</td>
                    <td style={tdStyle}>{entry.route}</td>
                    <td style={tdStyle}>{entry.leadTimeHours}h</td>
                    <td style={tdStyle}>
                      <span style={{
                        display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                        background: rliDotColor(entry.rliAtQuote),
                      }} />
                    </td>
                    <td style={{ ...tdStyle, color: entry.ghostValueCents ? "var(--green)" : "var(--text-muted)" }}>
                      {entry.ghostValueCents ? fmtCents(entry.ghostValueCents) : "\u2014"}
                    </td>
                    <td style={tdStyle}>{fmtPrice(entry.operatorQuotedPrice)}</td>
                    <td style={tdStyle}>{fmtPrice(entry.osaClientPrice)}</td>
                    <td style={{ ...tdStyle, color: marginColor(entry.realizedMarginPct) }}>
                      {fmtPct(entry.realizedMarginPct)}
                    </td>
                    <td style={tdStyle}>
                      {entry.rfqsSent > 0 ? `${entry.quotesReceived}/${entry.rfqsSent}` : "\u2014"}
                    </td>
                    <td style={tdStyle}>
                      {entry.operatorResponseMinutes != null ? `${entry.operatorResponseMinutes}m` : "\u2014"}
                    </td>
                    <td style={tdStyle}>
                      {entry.clientDecisionMinutes != null ? `${entry.clientDecisionMinutes}m` : "\u2014"}
                    </td>
                    <td style={tdStyle}>
                      <Pill label={entry.outcome} bg={outcomeColor(entry.outcome)} color="#fff" />
                    </td>
                    <td style={tdStyle}>
                      <Pill
                        label={entry.paymentStatus ?? "pending"}
                        bg={payPill.bg}
                        color={payPill.text}
                        bold={payPill.bold}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── 2C: Operator Intelligence ─────────────────────────────────── */}
      {sortedOperators.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 12px", letterSpacing: 0.5, textTransform: "uppercase" }}>
            Operator Intelligence
          </h3>
          <div style={{ overflow: "auto", border: "1px solid var(--border)", borderRadius: 4 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 800 }}>
              <thead>
                <tr style={{ background: "var(--surface)" }}>
                  <th style={thStyle}>Operator</th>
                  <th style={thStyle}>Base</th>
                  <th style={thStyle}>Deals</th>
                  <th style={thStyle}>Response (min)</th>
                  <th style={thStyle}>Book Rate</th>
                  <th style={thStyle}>Pricing Delta</th>
                  <th style={thStyle}>Reliability</th>
                </tr>
              </thead>
              <tbody>
                {sortedOperators.map((op, i) => {
                  const deltaPositive = op.pricingDelta > 0;
                  return (
                    <tr key={op.name} style={{ background: i % 2 === 0 ? "transparent" : "var(--surface)" }}>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{op.name}</td>
                      <td style={tdStyle}>{op.homeBase}</td>
                      <td style={tdStyle}>{op.dealCount}</td>
                      <td style={tdStyle}>{op.avgResponseTime.toFixed(0)}</td>
                      <td style={tdStyle}>{(op.quoteToBookRate * 100).toFixed(1)}%</td>
                      <td style={{ ...tdStyle, color: deltaPositive ? "var(--osa-red)" : "var(--green)" }}>
                        {deltaPositive ? "+" : ""}{(op.pricingDelta * 100).toFixed(1)}%
                      </td>
                      <td style={tdStyle}>{(op.reliabilityScore * 100).toFixed(0)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 2D: Financial Operations (collapsed by default) ───────────── */}
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={() => setFinOpsOpen((o) => !o)}
          style={{
            display: "flex", alignItems: "center", gap: 8, background: "none", border: "none",
            cursor: "pointer", padding: 0, margin: "0 0 12px",
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", letterSpacing: 0.5, textTransform: "uppercase" }}>
            Financial Operations
          </span>
          <span style={{ fontSize: 12, color: "var(--text-muted)", transform: finOpsOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>
            ▶
          </span>
        </button>
        {finOpsOpen && (
          <div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16, fontFamily: "var(--font-mono)" }}>
              Connect Mercury to activate payment tracking
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
              {["Float Exposure", "Avg Float Window", "Revenue Pending"].map((label) => (
                <div key={label} style={{
                  background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4,
                  padding: 12, opacity: 0.5,
                }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, marginBottom: 4 }}>
                    {label}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                    {"\u2014"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
