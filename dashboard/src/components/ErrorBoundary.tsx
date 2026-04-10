/** Error boundary with retry button. */

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props { children: ReactNode; }
interface State { error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Dashboard error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100%", gap: 16, padding: 40,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--osa-red)" }}>
            Dashboard Error
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", maxWidth: 400 }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            aria-label="Retry loading dashboard"
            style={{
              padding: "8px 20px", borderRadius: 4, border: "none",
              background: "var(--osa-orange)", color: "#fff",
              fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
