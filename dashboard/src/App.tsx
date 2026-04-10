/**
 * Mission Control — OSA Connect Dashboard
 * Tab navigation: Pipeline | Inbox | Calls | SDR | Autonomy | Intelligence
 */

import { useState, useCallback, useEffect } from "react";
import { PipelineView } from "./components/PipelineView";
import { DealDetail } from "./components/DealDetail";
import { StatusLine } from "./components/StatusLine";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { InboxFeed } from "./components/InboxFeed";
import { CallAssist } from "./components/CallAssist";
import { SDRQueue } from "./components/SDRQueue";
import { AutonomyDashboard } from "./components/AutonomyDashboard";
import { IntelligenceView } from "./components/IntelligenceView";
import { RadarView } from "./components/RadarView";
import { ChatView, type ChatMessage } from "./components/ChatView";
import { useDealStore } from "./hooks/useDealStore";
import { CommandBar } from "./components/CommandBar";

type Tab = "pipeline" | "inbox" | "calls" | "sdr" | "autonomy" | "intelligence" | "dumont" | "radar";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

const TABS: { key: Tab; label: string }[] = [
  { key: "pipeline", label: "Pipeline" },
  { key: "inbox", label: "Inbox" },
  { key: "calls", label: "Calls" },
  { key: "sdr", label: "SDR" },
  { key: "autonomy", label: "Autonomy" },
  { key: "intelligence", label: "Intelligence" },
  { key: "dumont", label: "Dumont" },
  { key: "radar", label: "Radar" },
];

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);
  return matches;
}

export function App() {
  const store = useDealStore();
  const { deals, selectedDeal, selectedDealId, setSelectedDealId, mode, toggleMode, ledgerEntries, ledgerSummary, benchmarks, operators, triggerRefresh } = store;
  const isMobile = useMediaQuery("(max-width: 767px)");
  const isTablet = useMediaQuery("(max-width: 1199px)");
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("pipeline");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [dumontPanelOpen, setDumontPanelOpen] = useState(false);

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

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in input/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Cmd+K: toggle terminal
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setTerminalOpen((o) => !o);
        return;
      }

      // Cmd+\: toggle Dumont side panel on pipeline, switch to tab elsewhere
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        if (activeTab === "pipeline") {
          setDumontPanelOpen((o) => !o);
        } else {
          setActiveTab("dumont");
        }
        return;
      }

      // Tab switching: 1-8
      const tabKeys = ["pipeline", "inbox", "calls", "sdr", "autonomy", "intelligence", "dumont", "radar"] as Tab[];
      const digit = parseInt(e.key);
      if (digit >= 1 && digit <= 8 && !e.metaKey && !e.ctrlKey) {
        setActiveTab(tabKeys[digit - 1]!);
        e.preventDefault();
        return;
      }

      // / to focus command bar
      if (e.key === "/" && !e.metaKey) {
        document.querySelector<HTMLInputElement>('[data-command-input]')?.focus();
        e.preventDefault();
        return;
      }

      // J/K for deal navigation in pipeline
      if (activeTab === "pipeline" && (e.key === "j" || e.key === "k")) {
        const idx = deals.findIndex((d) => d.id === selectedDealId);
        if (e.key === "j" && idx < deals.length - 1) {
          setSelectedDealId(deals[idx + 1]?.id ?? null);
        } else if (e.key === "k" && idx > 0) {
          setSelectedDealId(deals[idx - 1]?.id ?? null);
        }
        e.preventDefault();
        return;
      }

      // Escape: close Dumont panel first, then deselect deal
      if (e.key === "Escape" && !terminalOpen) {
        if (dumontPanelOpen) {
          setDumontPanelOpen(false);
        } else {
          setSelectedDealId(null);
        }
        e.preventDefault();
        return;
      }

      // Cmd+Enter: approve awaiting_review deal
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && selectedDealId) {
        const deal = deals.find(d => d.id === selectedDealId);
        if (deal?.stage === "awaiting_review") {
          onReviewAction(selectedDealId, "approve", "Approved via keyboard shortcut");
        }
        e.preventDefault();
        return;
      }

      // Cmd+Backspace: reject awaiting_review deal
      if (e.key === "Backspace" && (e.metaKey || e.ctrlKey) && selectedDealId) {
        const deal = deals.find(d => d.id === selectedDealId);
        if (deal?.stage === "awaiting_review") {
          onReviewAction(selectedDealId, "reject", "Rejected via keyboard shortcut");
        }
        e.preventDefault();
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab, deals, selectedDealId, terminalOpen, dumontPanelOpen, onReviewAction, setSelectedDealId]);

  // Mock data for new tabs (same pattern as useDealStore fixture data)
  const draftPendingCount = deals.filter((d) => d.stage === "awaiting_review").length || 1;

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
                <div style={{ flex: isTablet && !isMobile ? undefined : 2, overflow: "auto", minWidth: 0 }}>
                  <DealDetail deal={selectedDeal} onReviewAction={onReviewAction} />
                </div>
              )}
              {dumontPanelOpen && !isMobile && (
                <div style={{ width: 400, minWidth: 400, display: "flex", flexDirection: "column", borderLeft: "1px solid var(--border)", background: "var(--bg)", overflow: "hidden" }}>
                  <ChatView
                    messages={chatMessages}
                    setMessages={setChatMessages}
                    dealId={selectedDealId}
                    apiUrl={API_BASE}
                    compact
                    onClose={() => setDumontPanelOpen(false)}
                  />
                </div>
              )}
            </div>
          )}

          {activeTab === "inbox" && (
            <InboxFeed
              // TODO: wire to API — GET /api/inbox
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
              active={false}
              brief={null}
              transcript={[]}
              entities={[]}
              callDuration={0}
            />
          )}

          {activeTab === "sdr" && (
            <SDRQueue
              // TODO: wire to API — GET /api/sdr
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
              // TODO: wire to API — GET /api/autonomy
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
              benchmarks={benchmarks}
              operators={operators}
              onExportCSV={() => { window.open(`${API_BASE}/api/ledger/export`); }}
            />
          )}

          {activeTab === "radar" && (
            <RadarView />
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
