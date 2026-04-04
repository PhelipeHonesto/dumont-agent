/** Learning Loop metrics — 4 summary cards. */

interface Metrics {
  totalDeals: number;
  closedDeals: number;
  totalRevenue: number;
  avgEstimateDelta: number;
  conversionRate: number;
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{
      padding: "12px 14px", borderRadius: 6,
      background: "var(--surface-hover)", flex: 1, minWidth: 110,
    }}>
      <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", fontFamily: "var(--font-mono)" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function LearningMetrics({ metrics }: { metrics: Metrics }) {
  return (
    <section aria-label="Learning loop metrics" style={{ padding: "16px 20px", borderTop: "1px solid var(--border)" }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 12px", letterSpacing: 0.5, textTransform: "uppercase" }}>
        Learning Loop
      </h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Card label="Deals" value={String(metrics.totalDeals)} sub={`${metrics.closedDeals} closed`} />
        <Card label="Revenue" value={`$${metrics.totalRevenue.toLocaleString()}`} />
        <Card label="Conv. Rate" value={`${(metrics.conversionRate * 100).toFixed(0)}%`} />
        <Card label="Avg Delta" value={`${(metrics.avgEstimateDelta * 100).toFixed(1)}%`} sub="estimate accuracy" />
      </div>
    </section>
  );
}
