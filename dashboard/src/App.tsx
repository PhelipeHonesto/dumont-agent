/**
 * Mission Control — OSA Connect Dashboard
 * Tab navigation: Pipeline | Inbox | Calls | SDR | Autonomy | Intelligence
 */

import { useState, useCallback, useEffect } from "react";
import { PipelineView } from "./components/PipelineView";
import { DealDetail } from "./components/DealDetail";
import { OperatorNetwork } from "./components/OperatorNetwork";
import { LearningMetrics } from "./components/LearningMetrics";
import { StatusLine } from "./components/StatusLine";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { InboxFeed } from "./components/InboxFeed";
import { CallAssist } from "./components/CallAssist";
import { SDRQueue } from "./components/SDRQueue";
import { AutonomyDashboard } from "./components/AutonomyDashboard";
import { IntelligenceView } from "./components/IntelligenceView";
import { ChatView, type ChatMessage } from "./components/ChatView";
import { useDealStore } from "./hooks/useDealStore";
import { CommandBar } from "./components/CommandBar";
import { Phone } from "./components/Icons";

type Tab = "pipeline" | "inbox" | "calls" | "sdr" | "autonomy" | "intelligence" | "dumont";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

const TABS: { key: Tab; label: string }[] = [
  { key: "pipeline", label: "Pipeline" },
  { key: "inbox", label: "Inbox" },
  { key: "calls", label: "Calls" },
  { key: "sdr", label: "SDR" },
  { key: "autonomy", label: "Autonomy" },
  { key: "intelligence", label: "Intelligence" },
  { key: "dumont", label: "Dumont" },
];

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  if (typeof window !== "undefined") {
    const mql = window.matchMedia(query);
    mql.onchange = () => setMatches(mql.matches);
  }
  return matches;
}

export function App() {
  const store = useDealStore();
  const { deals, selectedDeal, selectedDealId, setSelectedDealId, mode, toggleMode, metrics, operatorStats, ledgerEntries, ledgerSummary, triggerRefresh } = store;
  const isMobile = useMediaQuery("(max-width: 767px)");
  const isTablet = useMediaQuery("(max-width: 1199px)");
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("pipeline");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [terminalOpen, setTerminalOpen] = useState(false);

  // Global Cmd+K / Ctrl+K to toggle terminal panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setTerminalOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const onSelectDeal = useCallback((id: string) => {
    setSelectedDealId(id);
    setActiveTab("pipeline");
    if (isMobile) setMobileShowDetail(true);
  }, [setSelectedDealId, isMobile]);

  const onBack = useCallback(() => setMobileShowDetail(false), []);
  const activeDealCount = deals.filter((d) => d.stage !== "closed" && d.stage !== "failed").length;

  // Review action handler — calls API then triggers refetch
  const onReviewAction = useCallback(async (dealId: string, action: "approve" | "reject", reason: string) => {
    try {
      const key = import.meta.env.VITE_DUMONT_API_KEY ?? localStorage.getItem("DUMONT_API_KEY") ?? "";
      await fetch(`${API_BASE}/api/deals/${dealId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ action, reason }),
      });
    } catch {
      // API may not be running — that is fine in dev mode
    }
    triggerRefresh();
  }, [triggerRefresh]);

  // Mock data for new tabs (same pattern as useDealStore fixture data)
  const draftPendingCount = deals.filter((d) => d.stage === "awaiting_review").length || 1;
  const hasActiveCall = false;

  return (
    <ErrorBoundary>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)", color: "var(--text-primary)", fontFamily: "var(--font-sans)", paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
        {/* Header */}
        <header style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "12px 20px", background: "var(--surface-elevated)",
          borderBottom: "1px solid var(--border)",
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            {isMobile && mobileShowDetail && (
              <button onClick={onBack} aria-label="Back to deal list" style={{ background: "none", border: "none", color: "var(--osa-orange)", fontSize: 14, cursor: "pointer", padding: "0 8px 0 0" }}>←</button>
            )}
            <h1 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: -0.3 }}>Mission Control</h1>
            <span style={{ fontSize: 11, color: "var(--osa-orange)", fontWeight: 600, fontFamily: "var(--font-mono)" }}>OSA CONNECT</span>
            {hasActiveCall && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 8 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--osa-red)", animation: "pulse 1.5s infinite" }} />
                <Phone size={12} color="var(--osa-red)" />
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
          </div>
        </header>

        {/* Tab bar */}
        <nav aria-label="Dashboard sections" style={{
          display: "flex", gap: 0, background: "var(--surface)", borderBottom: "1px solid var(--border)",
          padding: "0 16px", overflow: "auto",
        }}>
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              aria-selected={activeTab === key}
              role="tab"
              style={{
                padding: "8px 14px", border: "none", cursor: "pointer",
                fontSize: 11, fontWeight: 600, fontFamily: "var(--font-mono)",
                background: "transparent",
                color: activeTab === key ? "var(--osa-orange)" : "var(--text-muted)",
                borderBottom: activeTab === key ? "2px solid var(--osa-orange)" : "2px solid transparent",
                transition: "color 0.15s, border-color 0.15s",
                position: "relative",
              }}
            >
              {label}
              {key === "pipeline" && draftPendingCount > 0 && (
                <span style={{ position: "absolute", top: 4, right: 2, width: 6, height: 6, borderRadius: "50%", background: "var(--osa-orange)" }} />
              )}
            </button>
          ))}
        </nav>

        {/* Tab content */}
        <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
          {activeTab === "pipeline" && (
            <div style={{ display: "flex", flex: 1, overflow: "hidden", flexDirection: isTablet && !isMobile ? "column" : "row" }}>
              {(!isMobile || !mobileShowDetail) && (
                <div style={{ width: isMobile ? "100%" : isTablet ? "100%" : 360, minWidth: isMobile ? undefined : 320, display: "flex", flexDirection: "column", background: "var(--surface)", overflow: "hidden", maxHeight: isTablet && !isMobile ? "50vh" : undefined }}>
                  <PipelineView deals={deals} selectedId={selectedDealId} onSelect={onSelectDeal} />
                </div>
              )}
              {(!isMobile || mobileShowDetail) && (
                <div style={{ flex: isTablet && !isMobile ? undefined : 2, overflow: "auto" }}>
                  <DealDetail deal={selectedDeal} onReviewAction={onReviewAction} />
                </div>
              )}
            </div>
          )}

          {activeTab === "inbox" && (
            <InboxFeed
              items={[
                { id: "in_1", channel: "bland_voice", from: "+1-312-555-0199", fromName: "Sarah Chen", body: "Client requests TEB to PBI, April 15, 4 pax, ~$30K budget.", receivedAt: new Date(Date.now() - 300000).toISOString(), dealId: deals[0]?.id ?? null, sdrClassification: "qualified_with_budget", intent: "quote_request" },
                { id: "in_2", channel: "email", from: "marcus@rivera.co", fromName: "Marcus Rivera", body: "Hi, I'd like to charter a flight from Chicago to Aspen for 6 with ski gear.", receivedAt: new Date(Date.now() - 1200000).toISOString(), dealId: deals[1]?.id ?? null, sdrClassification: "qualified_no_budget", intent: "quote_request" },
                { id: "in_3", channel: "web_form", from: "james@wright.io", fromName: "James Wright", body: "Quote request from Las Vegas to Van Nuys, 2 passengers.", receivedAt: new Date(Date.now() - 60000).toISOString(), dealId: null, sdrClassification: "not_qualified", intent: "quote_request" },
              ]}
              onSelectDeal={onSelectDeal}
            />
          )}

          {activeTab === "calls" && (
            <CallAssist
              active={hasActiveCall}
              brief={null}
              transcript={[]}
              entities={[]}
              callDuration={0}
            />
          )}

          {activeTab === "sdr" && (
            <SDRQueue
              items={[
                { id: "sdr_1", clientName: "Sarah Chen", route: "KTEB → KPBI", classification: "qualified_with_budget", reason: "Route, date, pax, and budget confirmed.", draftStatus: "sent", receivedAt: new Date(Date.now() - 300000).toISOString(), dealId: deals[0]?.id ?? null },
                { id: "sdr_2", clientName: "Marcus Rivera", route: "KORD → KASE", classification: "qualified_no_budget", reason: "Qualified. Awaiting budget.", draftStatus: "pending", receivedAt: new Date(Date.now() - 1200000).toISOString(), dealId: deals[1]?.id ?? null },
                { id: "sdr_3", clientName: "James Wright", route: "KLAS → KVNY", classification: "not_qualified", reason: "Missing: date, passengers.", draftStatus: "auto", receivedAt: new Date(Date.now() - 60000).toISOString(), dealId: null },
              ]}
              onSelectDeal={onSelectDeal}
            />
          )}

          {activeTab === "autonomy" && (
            <AutonomyDashboard
              rules={[
                { channel: "email", intent: "follow_up", recipientType: "client", autoSendEnabled: true, autoSendAfter: 10, currentApprovals: 12, lastUsed: new Date(Date.now() - 3600000).toISOString(), editRate: 0.05 },
                { channel: "email", intent: "quote_request", recipientType: "operator", autoSendEnabled: false, autoSendAfter: 10, currentApprovals: 7, lastUsed: new Date(Date.now() - 7200000).toISOString(), editRate: 0.15 },
                { channel: "bland_text", intent: "follow_up", recipientType: "client", autoSendEnabled: false, autoSendAfter: 10, currentApprovals: 3, lastUsed: null, editRate: 0.3 },
                { channel: "email", intent: "info_request", recipientType: "client", autoSendEnabled: false, autoSendAfter: 10, currentApprovals: 0, lastUsed: null, editRate: 0 },
              ]}
            />
          )}

          {activeTab === "intelligence" && (
            <IntelligenceView
              entries={ledgerEntries}
              summary={ledgerSummary}
              onExportCSV={() => { window.open(`${API_BASE}/api/ledger/export`); }}
            />
          )}

          {activeTab === "dumont" && (
            <ChatView messages={chatMessages} setMessages={setChatMessages} dealId={selectedDealId} apiUrl={API_BASE} />
          )}
        </div>

        {/* Command Bar — always visible, terminal panel toggles separately */}
        <CommandBar
          callbacks={{
            selectedDealId,
            onSelectDeal,
            onNewDeal: () => {},
            onCloseDeal: () => {},
            onRegressDeal: () => {},
            onSetTab: (tab) => setActiveTab(tab as Tab),
          }}
          terminalOpen={terminalOpen}
          onToggleTerminal={() => setTerminalOpen((o) => !o)}
        />

        {/* Footer */}
        <StatusLine mode={mode} onToggle={toggleMode} dealCount={activeDealCount} terminalOpen={terminalOpen} onToggleTerminal={() => setTerminalOpen((o) => !o)} />
      </div>
    </ErrorBoundary>
  );
}
