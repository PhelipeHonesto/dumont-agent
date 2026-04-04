import React from "react";
/** Conversation thread — all messages for a deal, chronological, multi-channel. */

import { useRef, useEffect } from "react";
import { Mail, Phone, MessageSquare, Globe, Mic } from "./Icons";
import { fmtRelative } from "../utils";

interface Msg {
  id: string; channel: string; direction: string; from: string;
  fromName: string | null; body: string; receivedAt: string | null;
  sentAt: string | null; intent: string | null;
  parsedData: Record<string, unknown> | null;
  draftedBy: string | null;
}

const CHANNEL_ICON: Record<string, (p: { size?: number; color?: string }) => React.ReactElement> = {
  email: Mail, bland_voice: Phone, bland_text: MessageSquare,
  voice_copilot: Mic, web_form: Globe,
};

function ChannelIcon({ channel }: { channel: string }) {
  const Icon = CHANNEL_ICON[channel] ?? MessageSquare;
  return <Icon size={12} color="var(--text-muted)" />;
}

function EntityBadges({ data }: { data: Record<string, unknown> | null }) {
  if (!data) return null;
  const badges: string[] = [];
  if (data["departure"]) badges.push(String(data["departure"]));
  if (data["arrival"]) badges.push(String(data["arrival"]));
  if (data["pax"]) badges.push(`${data["pax"]}pax`);
  if (data["budget"]) badges.push("budget");
  if (badges.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
      {badges.map((b, i) => (
        <span key={i} style={{ fontSize: 9, fontFamily: "var(--font-mono)", padding: "1px 4px", borderRadius: 3, background: "var(--surface-hover)", color: "var(--text-muted)" }}>{b}</span>
      ))}
    </div>
  );
}

interface Props { messages: Msg[]; }

export function ConversationThread({ messages }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  if (messages.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-muted)", padding: 8 }}>No messages yet</div>;
  }

  return (
    <div role="log" aria-label="Conversation thread" style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 300, overflow: "auto", padding: "4px 0" }}>
      {messages.map((m) => {
        const isOutbound = m.direction === "outbound";
        const ts = m.sentAt ?? m.receivedAt;
        return (
          <div key={m.id} aria-label={`${isOutbound ? "Outbound" : "Inbound"} ${m.channel} message from ${m.fromName ?? m.from}`} style={{
            display: "flex", gap: 8, padding: "6px 8px", borderRadius: 6,
            background: isOutbound ? "rgba(231,75,29,0.04)" : "transparent",
            animation: "fadeIn 0.2s ease-out",
          }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 20, paddingTop: 2 }}>
              <ChannelIcon channel={m.channel} />
              <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{isOutbound ? "→" : "←"}</span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>
                  {m.fromName ?? m.from.split("@")[0]}
                  {m.draftedBy === "dumont" && <span style={{ marginLeft: 4, fontSize: 9, color: "var(--osa-orange)", fontWeight: 500 }}>DUMONT</span>}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{fmtRelative(ts)}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2, lineHeight: 1.4, wordBreak: "break-word" }}>
                {m.body.length > 200 ? m.body.slice(0, 200) + "..." : m.body}
              </div>
              <EntityBadges data={m.parsedData} />
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
