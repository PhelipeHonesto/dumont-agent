/**
 * ChatView — Dumont AI co-pilot, terminal aesthetic.
 * Layer: dashboard
 *
 * SSE streaming from POST /api/chat. Monospaced throughout.
 * No bubbles, no avatars, no timestamps. Terminal, not iMessage.
 */

import { useState, useCallback, useRef, useEffect } from "react";

function authHeaders(): Record<string, string> {
  const key = import.meta.env.VITE_DUMONT_API_KEY ?? localStorage.getItem("DUMONT_API_KEY") ?? "";
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  dealId: string | null;
  apiUrl: string;
}

export function ChatView({ messages, setMessages, dealId, apiUrl }: Props) {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { scrollRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;

    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setInput("");
    setStreaming(true);
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const resp = await fetch(`${apiUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ message: trimmed, dealId: dealId ?? undefined }),
      });

      if (!resp.ok) {
        setMessages((prev) => {
          const u = [...prev];
          u[u.length - 1] = { role: "assistant", content: `ERR ${resp.status}: ${resp.statusText}` };
          return u;
        });
        setStreaming(false);
        return;
      }

      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6);
            if (raw === "[DONE]") continue;
            try {
              const data = JSON.parse(raw);
              if (data.text) {
                setMessages((prev) => {
                  const u = [...prev];
                  const last = u[u.length - 1];
                  if (last?.role === "assistant") u[u.length - 1] = { ...last, content: last.content + data.text };
                  return u;
                });
              }
              if (data.error) {
                setMessages((prev) => {
                  const u = [...prev];
                  const last = u[u.length - 1];
                  if (last?.role === "assistant") u[u.length - 1] = { ...last, content: last.content + `\n[ERR: ${data.error}]` };
                  return u;
                });
              }
            } catch { /* skip */ }
          }
        }
      }
    } catch (err) {
      setMessages((prev) => {
        const u = [...prev];
        u[u.length - 1] = { role: "assistant", content: `CONNECTION ERR: ${err instanceof Error ? err.message : "unknown"}` };
        return u;
      });
    }

    setStreaming(false);
  }, [input, streaming, dealId, apiUrl]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
      {/* Header */}
      <div style={{ padding: "8px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--osa-orange)", letterSpacing: 1 }}>DUMONT AI</span>
        {dealId && (
          <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>CTX: {dealId}</span>
        )}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: "auto", padding: "12px 20px", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7 }}>
        {messages.length === 0 && (
          <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
            {dealId ? `Deal context loaded. Query the intelligence layer.` : "No deal selected. Ask about pipeline, operators, or routes."}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <span style={{ color: msg.role === "user" ? "var(--text-muted)" : "var(--osa-orange)", fontWeight: 600, fontSize: 10, letterSpacing: 0.5 }}>
              {msg.role === "user" ? "PIC" : "DUMONT"}
            </span>
            <span style={{ color: "var(--text-muted)", marginLeft: 4, marginRight: 8 }}>{">"}</span>
            <span style={{ color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>
              {msg.content}
              {streaming && i === messages.length - 1 && msg.role === "assistant" && (
                <span style={{ color: "var(--osa-orange)", animation: "pulse 1s infinite" }}>_</span>
              )}
            </span>
          </div>
        ))}
        <div ref={scrollRef} />
      </div>

      {/* Input */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 20px", borderTop: "1px solid var(--border)", background: "var(--bg)" }}>
        <span style={{ color: "var(--osa-orange)", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700 }}>{">"}</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder={streaming ? "" : "Query intelligence layer..."}
          disabled={streaming}
          autoComplete="off"
          spellCheck={false}
          style={{
            flex: 1, background: "transparent", border: "none", outline: "none",
            color: "var(--text-primary)", fontFamily: "var(--font-mono)", fontSize: 12, padding: "2px 0",
          }}
        />
      </div>
    </div>
  );
}
