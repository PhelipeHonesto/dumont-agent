/** Footer status line with SIM/LIVE toggle, terminal toggle, deal count, version. */

import type { DealMode } from "../types";

interface Props {
  mode: DealMode;
  onToggle: () => void;
  dealCount: number;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
}

export function StatusLine({ mode, onToggle, dealCount, terminalOpen, onToggleTerminal }: Props) {
  return (
    <footer style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "6px 20px", background: "var(--surface-elevated)",
      borderTop: "1px solid var(--border)",
      fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Terminal toggle */}
        {onToggleTerminal && (
          <button
            onClick={onToggleTerminal}
            aria-label={terminalOpen ? "Close terminal" : "Open terminal (Cmd+K)"}
            aria-pressed={terminalOpen}
            title="Toggle terminal (⌘K)"
            style={{
              display: "flex", alignItems: "center", gap: 4,
              background: "none", border: "1px solid var(--border)",
              borderRadius: 4, padding: "3px 8px", cursor: "pointer",
              color: terminalOpen ? "var(--osa-orange)" : "var(--text-muted)",
              fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600,
              transition: "color 0.15s, border-color 0.15s",
              borderColor: terminalOpen ? "var(--osa-orange)" : "var(--border)",
            }}
          >
            {">"}_
          </button>
        )}

        {/* SIM/LIVE toggle */}
        <button
          onClick={onToggle}
          aria-label={`Switch to ${mode === "live" ? "simulation" : "live"} mode`}
          aria-pressed={mode === "live"}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            background: "none", border: "1px solid var(--border)",
            borderRadius: 4, padding: "3px 10px", cursor: "pointer",
            color: mode === "live" ? "var(--osa-orange)" : "var(--text-muted)",
            fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 6, height: 6, borderRadius: "50%",
              background: mode === "live" ? "var(--osa-orange)" : "var(--text-muted)",
              animation: mode === "live" ? "pulse 2s infinite" : "none",
            }}
          />
          {mode.toUpperCase()}
        </button>
        <span aria-live="polite">{dealCount} active deal{dealCount !== 1 ? "s" : ""}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span>Dumont Agent v0.1.0</span>
        <span style={{ color: "var(--osa-orange)" }}>OSA Connect</span>
      </div>
    </footer>
  );
}
