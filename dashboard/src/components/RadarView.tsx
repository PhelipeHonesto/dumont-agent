/**
 * Radar View — ADS-B Fleet Intelligence placeholder.
 * Activates when ADS-B feed is connected.
 */

export function RadarView() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, color: "var(--text-muted)" }}>
      <div style={{ fontSize: 14, fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--osa-orange)", letterSpacing: 1 }}>RADAR — ADS-B FLEET INTELLIGENCE</div>
      <div style={{ fontSize: 11 }}>Connect ADS-B feed to activate live fleet tracking</div>
      <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
        {["Aircraft Tracked", "Ghost Opportunities", "Fleet Utilization"].map((label) => (
          <div key={label} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4, padding: 12, minWidth: 140 }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{"\u2014"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
