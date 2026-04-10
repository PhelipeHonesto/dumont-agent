/**
 * Command Bar — terminal-style input for controlling Dumont.
 * Input bar always visible. Terminal output panel toggles separately.
 * FMS CDU aesthetic: monospace, orange prompt, green output.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from "react";

// ── Command Registry ─────────────────────────────────────────────────────

interface CmdDef {
  command: string;
  description: string;
  category: "Deal" | "Pipeline" | "Comms" | "System";
}

const COMMANDS: CmdDef[] = [
  { command: "/deal new", description: "Create a new deal", category: "Deal" },
  { command: "/deal", description: "Select a deal by ID", category: "Deal" },
  { command: "/deal close", description: "Close deal with outcome", category: "Deal" },
  { command: "/deal regress", description: "Regress deal to earlier stage", category: "Deal" },
  { command: "/run intake", description: "Run intake parser on text", category: "Pipeline" },
  { command: "/run quote", description: "Run quote pipeline for deal", category: "Pipeline" },
  { command: "/run source", description: "Run sourcing for deal", category: "Pipeline" },
  { command: "/run guardian", description: "Run guardian check for deal", category: "Pipeline" },
  { command: "/run sim", description: "Run a scenario through pipeline", category: "Pipeline" },
  { command: "/call", description: "Start copilot call to operator", category: "Comms" },
  { command: "/send", description: "Approve and send pending draft", category: "Comms" },
  { command: "/draft", description: "Show draft for deal", category: "Comms" },
  { command: "/sdr", description: "Show SDR queue summary", category: "Comms" },
  { command: "/status", description: "Pipeline status summary", category: "System" },
  { command: "/metrics", description: "Learning loop metrics", category: "System" },
  { command: "/operators", description: "Operator network summary", category: "System" },
  { command: "/autonomy", description: "Autonomy tracking status", category: "System" },
  { command: "/clear", description: "Clear terminal history", category: "System" },
  { command: "/help", description: "Show all commands", category: "System" },
];

// ── Types ────────────────────────────────────────────────────────────────

export interface OutputLine {
  text: string;
  type: "info" | "success" | "warning" | "error";
}

interface HistoryEntry {
  command: string;
  output: OutputLine[];
  timestamp: string;
}

const OUTPUT_COLORS: Record<string, string> = {
  info: "var(--green)", success: "var(--green)", warning: "var(--amber)", error: "var(--osa-red)",
};

export interface CommandBarCallbacks {
  onNewDeal?: () => void;
  onSelectDeal?: (id: string) => void;
  onCloseDeal?: (id: string, result: string) => void;
  onRegressDeal?: (id: string, stage: string, reason: string) => void;
  onRunCommand?: (cmd: string, args: string[]) => OutputLine[];
  onSetTab?: (tab: string) => void;
  selectedDealId?: string | null;
}

interface Props {
  callbacks: CommandBarCallbacks;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
}

// ── Component ────────────────────────────────────────────────────────────

export function CommandBar({ callbacks, terminalOpen, onToggleTerminal }: Props) {
  const [input, setInput] = useState("");
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [acIndex, setAcIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll terminal to bottom on new entry
  useEffect(() => {
    if (terminalOpen) scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length, terminalOpen]);

  // Global Escape closes terminal (not the input bar)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && terminalOpen) {
        onToggleTerminal();
        setShowAutocomplete(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [terminalOpen, onToggleTerminal]);

  // Autocomplete filtering
  const filtered = useMemo(() => {
    if (!input.startsWith("/")) return [];
    return COMMANDS.filter((c) => c.command.toLowerCase().startsWith(input.toLowerCase()));
  }, [input]);

  // ── Execute command ────────────────────────────────────────────────

  const executeCommand = useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    setCmdHistory((h) => [trimmed, ...h].slice(0, 50));
    setHistoryIdx(-1);
    setInput("");
    setShowAutocomplete(false);

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0]!.toLowerCase();
    const args = parts.slice(1);
    const lines: OutputLine[] = [];

    if (cmd === "/help") {
      lines.push({ text: "DUMONT COMMAND BAR", type: "info" });
      lines.push({ text: "", type: "info" });
      let lastCat = "";
      for (const c of COMMANDS) {
        if (c.category !== lastCat) { lines.push({ text: `── ${c.category} ──`, type: "warning" }); lastCat = c.category; }
        lines.push({ text: `  ${c.command.padEnd(28)} ${c.description}`, type: "info" });
      }
    } else if (cmd === "/clear") {
      setEntries([]);
      return;
    } else if (cmd === "/status") {
      lines.push({ text: "Pipeline: operational", type: "success" });
      lines.push({ text: `Selected deal: ${callbacks.selectedDealId ?? "none"}`, type: "info" });
    } else if (cmd === "/metrics") {
      lines.push({ text: "Learning loop metrics — use /help for available queries", type: "info" });
      callbacks.onSetTab?.("pipeline");
    } else if (cmd === "/operators") {
      lines.push({ text: "Showing operator network...", type: "info" });
      callbacks.onSetTab?.("pipeline");
    } else if (cmd === "/autonomy") {
      lines.push({ text: "Showing autonomy dashboard...", type: "info" });
      callbacks.onSetTab?.("autonomy");
    } else if (cmd === "/sdr") {
      lines.push({ text: "Showing SDR queue...", type: "info" });
      callbacks.onSetTab?.("sdr");
    } else if (cmd === "/deal") {
      if (args[0] === "new") { callbacks.onNewDeal?.(); lines.push({ text: "Creating new deal...", type: "success" }); }
      else if (args[0] === "close" && args[1]) { callbacks.onCloseDeal?.(args[1], args[2] ?? "closed"); lines.push({ text: `Closing deal ${args[1]} as ${args[2] ?? "closed"}`, type: "success" }); }
      else if (args[0] === "regress" && args[1] && args[2]) { callbacks.onRegressDeal?.(args[1], args[2], args.slice(3).join(" ") || "Manual regression"); lines.push({ text: `Regressing ${args[1]} to ${args[2]}`, type: "warning" }); }
      else if (args[0]) { callbacks.onSelectDeal?.(args[0]); callbacks.onSetTab?.("pipeline"); lines.push({ text: `Selected deal ${args[0]}`, type: "info" }); }
      else { lines.push({ text: `Current deal: ${callbacks.selectedDealId ?? "none"}`, type: "info" }); }
    } else if (cmd === "/call") {
      lines.push({ text: `Starting copilot call${args[0] ? ` to ${args[0]}` : ""}...`, type: "info" });
      callbacks.onSetTab?.("calls");
    } else if (cmd === "/send") {
      lines.push({ text: `Sending draft for ${args[0] ?? callbacks.selectedDealId ?? "?"}...`, type: "success" });
    } else if (cmd === "/draft") {
      lines.push({ text: `Showing draft for ${args[0] ?? callbacks.selectedDealId ?? "?"}...`, type: "info" });
    } else if (cmd.startsWith("/run")) {
      const subcmd = args[0] ?? "";
      const target = args[1] ?? callbacks.selectedDealId ?? "?";
      if (callbacks.onRunCommand) { lines.push(...callbacks.onRunCommand(subcmd, args.slice(1))); }
      else { lines.push({ text: `Running ${subcmd} for ${target}...`, type: "info" }); }
    } else {
      lines.push({ text: `Unknown command: ${cmd}. Type /help for available commands.`, type: "error" });
    }

    if (lines.length > 0) {
      const now = new Date();
      const ts = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      setEntries((prev) => [...prev, { command: trimmed, output: lines, timestamp: ts }].slice(-50));
    }
  }, [callbacks]);

  // ── Key handling ───────────────────────────────────────────────────

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showAutocomplete && filtered.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setAcIndex((i) => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setAcIndex((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Tab" || (e.key === "Enter" && acIndex >= 0)) {
        e.preventDefault();
        const sel = filtered[acIndex];
        if (sel) { setInput(sel.command + " "); setShowAutocomplete(false); }
        return;
      }
      if (e.key === "Escape") { setShowAutocomplete(false); return; }
    }
    if (e.key === "Enter") { e.preventDefault(); executeCommand(input); return; }
    if (e.key === "Escape") { setInput(""); setShowAutocomplete(false); return; }
    if (e.key === "ArrowUp" && !showAutocomplete) {
      e.preventDefault();
      if (historyIdx < cmdHistory.length - 1) { const idx = historyIdx + 1; setHistoryIdx(idx); setInput(cmdHistory[idx]!); }
    }
    if (e.key === "ArrowDown" && !showAutocomplete) {
      e.preventDefault();
      if (historyIdx > 0) { const idx = historyIdx - 1; setHistoryIdx(idx); setInput(cmdHistory[idx]!); }
      else { setHistoryIdx(-1); setInput(""); }
    }
  }, [input, showAutocomplete, filtered, acIndex, cmdHistory, historyIdx, executeCommand]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInput(val);
    setShowAutocomplete(val.startsWith("/") && val.length > 0);
    setAcIndex(0);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div>
      {/* Terminal output panel — shown only when toggled open */}
      {terminalOpen && (
        <div role="log" aria-label="Terminal output" style={{
          maxHeight: 200, overflow: "auto", padding: "8px 20px",
          background: "var(--bg)", borderTop: "1px solid var(--border)",
          fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.6,
          animation: "fadeIn 0.15s ease-out",
        }}>
          {entries.length === 0 && (
            <div style={{ color: "var(--text-muted)" }}>Terminal ready. Type a command below.</div>
          )}
          {entries.map((entry, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              <div style={{ color: "var(--text-muted)" }}>
                <span style={{ color: "var(--border)", marginRight: 6 }}>{entry.timestamp}</span>
                <span style={{ color: "var(--osa-orange)" }}>{">"}</span>{" "}
                <span style={{ color: "var(--text-secondary)" }}>{entry.command}</span>
              </div>
              {entry.output.map((line, j) => (
                <div key={j} style={{ color: OUTPUT_COLORS[line.type] ?? "var(--text-muted)", whiteSpace: "pre-wrap", paddingLeft: 12 }}>
                  {line.text}
                </div>
              ))}
            </div>
          ))}
          <div ref={scrollRef} />
        </div>
      )}

      {/* Command input bar — always visible */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 20px", background: "var(--surface-elevated)",
        borderTop: "1px solid var(--border)", position: "relative",
      }}>
        <span style={{ color: "var(--osa-orange)", fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, userSelect: "none" }} aria-hidden="true">{">"}</span>
        <input
          ref={inputRef}
          data-command-input
          type="text"
          value={input}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onFocus={() => { if (input.startsWith("/")) setShowAutocomplete(true); }}
          onBlur={() => setTimeout(() => setShowAutocomplete(false), 150)}
          placeholder="Type a command... (/ for help)"
          aria-label="Command input. Press slash for commands, Cmd+K to open terminal."
          autoComplete="off"
          spellCheck={false}
          style={{
            flex: 1, background: "transparent", border: "none", outline: "none",
            color: "var(--text-primary)", fontFamily: "var(--font-mono)", fontSize: 12,
            padding: "2px 0",
          }}
        />
        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
          {callbacks.selectedDealId ?? "no deal selected"}
        </span>
        <span style={{ fontSize: 9, color: "var(--border)", fontFamily: "var(--font-mono)" }}>⌘K</span>

        {/* Autocomplete dropdown */}
        {showAutocomplete && filtered.length > 0 && (
          <div role="listbox" aria-label="Command suggestions" style={{
            position: "absolute", bottom: "100%", left: 20, right: 20,
            background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: "4px 4px 0 0", maxHeight: 240, overflow: "auto",
            zIndex: 100, boxShadow: "0 -4px 12px rgba(0,0,0,0.4)",
          }}>
            {(() => {
              let lastCat = "";
              return filtered.map((cmd, i) => {
                const showCat = cmd.category !== lastCat;
                lastCat = cmd.category;
                return (
                  <div key={cmd.command}>
                    {showCat && (
                      <div style={{ padding: "4px 12px", fontSize: 9, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, borderTop: i > 0 ? "1px solid var(--border)" : "none" }}>
                        {cmd.category}
                      </div>
                    )}
                    <div
                      role="option"
                      aria-selected={i === acIndex}
                      id={`cmd-option-${i}`}
                      onClick={() => { setInput(cmd.command + " "); setShowAutocomplete(false); inputRef.current?.focus(); }}
                      style={{
                        display: "flex", justifyContent: "space-between", padding: "5px 12px",
                        cursor: "pointer", fontSize: 11, fontFamily: "var(--font-mono)",
                        background: i === acIndex ? "var(--surface-active)" : "transparent",
                        color: i === acIndex ? "var(--osa-orange)" : "var(--text-secondary)",
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{cmd.command}</span>
                      <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{cmd.description}</span>
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
