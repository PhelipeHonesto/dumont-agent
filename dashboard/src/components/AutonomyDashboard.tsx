/** Autonomy dashboard — per-template autonomy tracking with graduation progress. */

import { useMemo } from "react";

interface AutonomyRule {
  channel: string; intent: string; recipientType: string;
  autoSendEnabled: boolean; autoSendAfter: number;
  currentApprovals: number; lastUsed: string | null;
  editRate: number;
}

const STATUS_COLORS: Record<string, string> = {
  Autonomous: "var(--green)", Delayed: "var(--amber)", Manual: "var(--text-muted)",
};

function ProgressBar({ current, target }: { current: number; target: number }) {
  const pct = Math.min((current / target) * 100, 100);
  const color = pct >= 100 ? "var(--green)" : pct >= 50 ? "var(--amber)" : "var(--text-muted)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 60, height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.3s" }} />
      </div>
      <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{current}/{target}</span>
    </div>
  );
}

interface Props {
  rules: AutonomyRule[];
  onPromote?: (channel: string, intent: string, recipientType: string) => void;
  onDemote?: (channel: string, intent: string, recipientType: string) => void;
}

export function AutonomyDashboard({ rules, onPromote, onDemote }: Props) {
  const sorted = useMemo(() =>
    [...rules].sort((a, b) => b.currentApprovals - a.currentApprovals),
  [rules]);

  return (
    <div aria-label="Autonomy tracking" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: 0, letterSpacing: 0.5, textTransform: "uppercase" }}>Autonomy Tracking</h2>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          Templates earn autonomy after 10 consecutive zero-edit approvals. Any broker edit resets the counter.
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {["Template", "Channel", "Recipient", "Progress", "Edit Rate", "Status", ""].map((h) => (
                <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((rule, i) => {
              const status = rule.autoSendEnabled ? "Autonomous" : rule.currentApprovals > 5 ? "Delayed" : "Manual";
              return (
                <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>{rule.intent.replace(/_/g, " ")}</td>
                  <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{rule.channel}</td>
                  <td style={{ padding: "8px 10px", color: "var(--text-muted)" }}>{rule.recipientType}</td>
                  <td style={{ padding: "8px 10px" }}><ProgressBar current={rule.currentApprovals} target={rule.autoSendAfter} /></td>
                  <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", color: rule.editRate > 0.3 ? "var(--osa-red)" : "var(--text-muted)" }}>{(rule.editRate * 100).toFixed(0)}%</td>
                  <td style={{ padding: "8px 10px" }}>
                    <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 3, background: `${STATUS_COLORS[status]}20`, color: STATUS_COLORS[status] }}>
                      {status}
                    </span>
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    {rule.autoSendEnabled ? (
                      <button onClick={() => onDemote?.(rule.channel, rule.intent, rule.recipientType)} aria-label={`Demote ${rule.intent} autonomy`} style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>Demote</button>
                    ) : rule.currentApprovals >= rule.autoSendAfter ? (
                      <button onClick={() => onPromote?.(rule.channel, rule.intent, rule.recipientType)} aria-label={`Promote ${rule.intent} to autonomous`} style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, border: "1px solid var(--green)", background: "transparent", color: "var(--green)", cursor: "pointer" }}>Promote</button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rules.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
            No autonomy rules yet. Send your first draft to start tracking.
          </div>
        )}
      </div>
    </div>
  );
}
