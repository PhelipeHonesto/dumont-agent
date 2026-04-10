import React from "react";
/** Inbox feed — all inbound messages across all channels, chronological. */

import { useState, useMemo, useCallback } from "react";
import { Mail, Phone, MessageSquare, Globe, Mic } from "./Icons";
import { fmtRelative } from "../utils";

interface InboxItem {
  id: string; channel: string; from: string; fromName: string | null;
  body: string; receivedAt: string; dealId: string | null;
  sdrClassification: string | null; intent: string | null;
}

const CHANNEL_ICONS: Record<string, (p: { size?: number; color?: string }) => React.ReactElement> = {
  bland_voice: Phone, bland_text: MessageSquare, email: Mail,
  web_form: Globe, voice_copilot: Mic,
};

const SDR_COLORS: Record<string, string> = {
  qualified_with_budget: "var(--green)",
  qualified_no_budget: "var(--amber)",
  not_qualified: "var(--text-muted)",
  budget_mismatch: "var(--osa-red)",
};

type FilterChannel = "all" | "bland_voice" | "bland_text" | "email" | "web_form";

interface Props {
  items: InboxItem[];
  onSelectDeal?: (dealId: string) => void;
}

export function InboxFeed({ items, onSelectDeal }: Props) {
  const [filter, setFilter] = useState<FilterChannel>("all");

  const filtered = useMemo(() => {
    const sorted = [...items].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    if (filter === "all") return sorted;
    return sorted.filter((i) => i.channel === filter);
  }, [items, filter]);

  const onFilterClick = useCallback((ch: FilterChannel) => setFilter(ch), []);

  const filters: { key: FilterChannel; label: string }[] = [
    { key: "all", label: "All" },
    { key: "bland_voice", label: "Voice" },
    { key: "bland_text", label: "Text" },
    { key: "email", label: "Email" },
    { key: "web_form", label: "Web" },
  ];

  return (
    <div role="feed" aria-label="Inbox feed" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Filter bar */}
      <div style={{ display: "flex", gap: 4, padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
        {filters.map(({ key, label }) => (
          <button key={key} onClick={() => onFilterClick(key)} aria-pressed={filter === key} aria-label={`Filter by ${label}`} style={{
            padding: "3px 10px", borderRadius: 4, border: "none", fontSize: 10, fontWeight: 600,
            fontFamily: "var(--font-mono)", cursor: "pointer",
            background: filter === key ? "var(--osa-orange)" : "var(--surface-hover)",
            color: filter === key ? "#fff" : "var(--text-muted)",
          }}>
            {label} {key === "all" ? `(${items.length})` : ""}
          </button>
        ))}
      </div>

      {/* Message list */}
      <div style={{ flex: 1, overflow: "auto", padding: "4px 8px" }}>
        {filtered.length === 0 && (
          <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>No messages</div>
        )}
        {filtered.map((item) => {
          const Icon = CHANNEL_ICONS[item.channel] ?? MessageSquare;
          return (
            <div
              key={item.id}
              role="article"
              aria-label={`${item.channel} message from ${item.fromName ?? item.from}`}
              onClick={() => item.dealId && onSelectDeal?.(item.dealId)}
              style={{
                display: "flex", gap: 10, padding: "8px 10px", borderRadius: 4,
                cursor: item.dealId ? "pointer" : "default",
                animation: "fadeIn 0.2s ease-out", transition: "background 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <div style={{ paddingTop: 2 }}><Icon size={14} color="var(--text-muted)" /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>{item.fromName ?? item.from}</span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{fmtRelative(item.receivedAt)}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item.body.slice(0, 80)}{item.body.length > 80 ? "..." : ""}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
                  {item.dealId ? (
                    <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--osa-orange)" }}>{item.dealId}</span>
                  ) : (
                    <span style={{ fontSize: 9, color: "var(--text-muted)" }}>Unmatched</span>
                  )}
                  {item.sdrClassification && (
                    <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: SDR_COLORS[item.sdrClassification] ?? "var(--text-muted)" }}>
                      {item.sdrClassification.replace(/_/g, " ")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
