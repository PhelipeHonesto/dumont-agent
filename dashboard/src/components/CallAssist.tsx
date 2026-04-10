/** Live call assist panel — transcript, entities, call brief, quick actions. */

import { useRef, useEffect, useState, useCallback } from "react";
import { Phone, Mic, Zap } from "./Icons";
import { fmtDuration } from "../utils";

interface Entity { type: string; value: string; speaker: string; confidence: number; }
interface Chunk { speaker: string; text: string; timestampMs: number; isFinal: boolean; }
interface CallBrief { route: string; date: string; pax: number; estimateRange: string; operatorName: string; talkingPoints: string[]; }

const ENTITY_COLORS: Record<string, string> = {
  price: "var(--green)", aircraft_type: "var(--color-info)", tail_number: "var(--color-purple)",
  airport: "var(--text-secondary)", availability: "var(--amber)",
  negotiation_signal: "var(--osa-orange)", hold_duration: "var(--text-muted)",
};

interface Props {
  active: boolean;
  brief: CallBrief | null;
  transcript: Chunk[];
  entities: Entity[];
  callDuration: number;
  onEnterQuote?: (price: number) => void;
  onNotAvailable?: () => void;
  onEndCall?: () => void;
}

export function CallAssist({ active, brief, transcript, entities, callDuration, onEnterQuote, onNotAvailable, onEndCall }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [quoteInput, setQuoteInput] = useState("");

  useEffect(() => { scrollRef.current?.scrollIntoView({ behavior: "smooth" }); }, [transcript.length]);

  const submitQuote = useCallback(() => {
    const price = parseFloat(quoteInput.replace(/[$,]/g, ""));
    if (price > 0 && onEnterQuote) { onEnterQuote(price); setQuoteInput(""); }
  }, [quoteInput, onEnterQuote]);

  if (!active && transcript.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40, gap: 12 }}>
        <Phone size={32} color="var(--border)" />
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>No active call</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", opacity: 0.6 }}>Start a call from a deal's operator panel</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Call brief */}
      {brief && (
        <div style={{ padding: "12px 16px", background: "var(--surface-elevated)", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {active && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--osa-red)", animation: "pulse 1.5s infinite" }} />}
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{brief.operatorName}</span>
              <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{brief.route}</span>
            </div>
            <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{fmtDuration(callDuration)}</span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {brief.talkingPoints.map((tp, i) => (
              <span key={i} style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: "var(--surface-hover)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{tp}</span>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Transcript */}
        <div style={{ flex: 1, overflow: "auto", padding: "8px 12px" }}>
          {transcript.map((c, i) => (
            <div key={i} style={{ marginBottom: 4, animation: "fadeIn 0.15s ease-out" }}>
              <span style={{ fontSize: 9, fontWeight: 600, fontFamily: "var(--font-mono)", color: c.speaker === "broker" ? "var(--osa-orange)" : "var(--text-muted)", marginRight: 6 }}>
                {c.speaker === "broker" ? "YOU" : "OP"}
              </span>
              <span style={{ fontSize: 12, color: c.isFinal ? "var(--text-primary)" : "var(--text-muted)", fontStyle: c.isFinal ? "normal" : "italic" }}>
                {c.text}
              </span>
            </div>
          ))}
          <div ref={scrollRef} />
        </div>

        {/* Entities sidebar */}
        <div aria-live="assertive" aria-label="Detected entities" style={{ width: 180, borderLeft: "1px solid var(--border)", overflow: "auto", padding: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 6, letterSpacing: 0.5 }}>Detected</div>
          {entities.length === 0 && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Listening...</div>}
          {entities.map((e, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 0", animation: "fadeIn 0.2s ease-out" }}>
              <Zap size={10} color={ENTITY_COLORS[e.type] ?? "var(--text-muted)"} />
              <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: ENTITY_COLORS[e.type] ?? "var(--text-secondary)", fontWeight: 600 }}>{e.value}</span>
              <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{e.type}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Quick actions */}
      {active && (
        <div style={{ display: "flex", gap: 6, padding: "8px 12px", borderTop: "1px solid var(--border)", alignItems: "center" }}>
          <input
            type="text" value={quoteInput} onChange={(e) => setQuoteInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitQuote(); }}
            placeholder="Enter quote $..."
            aria-label="Enter operator quote amount"
            style={{ flex: 1, padding: "5px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-primary)", fontSize: 11, fontFamily: "var(--font-mono)", outline: "none" }}
          />
          <button onClick={submitQuote} aria-label="Submit quote" style={{ padding: "5px 10px", borderRadius: 4, border: "none", background: "var(--green)", color: "#fff", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>Quote</button>
          <button onClick={onNotAvailable} aria-label="Mark not available" style={{ padding: "5px 10px", borderRadius: 4, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", fontSize: 10, cursor: "pointer" }}>N/A</button>
          <button onClick={onEndCall} aria-label="End call" style={{ padding: "5px 10px", borderRadius: 4, border: "none", background: "var(--osa-red)", color: "#fff", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>End</button>
        </div>
      )}
    </div>
  );
}
