/**
 * Deal Pipeline View — deal list with stage bars, timers, budget bars.
 * Keyboard navigable (arrow keys), responsive, full tooltips.
 */

import { useCallback, useRef, useEffect } from "react";
import type { DealContext, DealStage } from "../types";
import { ShieldCheck, ShieldAlert, ShieldX, Clock, Plane } from "./Icons";
import { fmtPrice, fmtRelative, stageIndex, nextStep, timerRemaining, timerLevel, budgetUtilization } from "../utils";

// ── Stage config ─────────────────────────────────────────────────────────

const STAGES: { key: DealStage; label: string; full: string }[] = [
  { key: "intake", label: "INT", full: "Intake" },
  { key: "qualified", label: "QUA", full: "Qualified" },
  { key: "estimated", label: "EST", full: "Estimated" },
  { key: "sourced", label: "SRC", full: "Sourced" },
  { key: "quoted", label: "QOT", full: "Quoted" },
  { key: "presented", label: "PRS", full: "Presented" },
  { key: "confirmed", label: "CNF", full: "Confirmed" },
  { key: "closed", label: "CLS", full: "Closed" },
];

// ── Stage indicators ─────────────────────────────────────────────────────

function StageBar({ stage }: { stage: DealStage }) {
  const current = stageIndex(stage);
  const isFailed = stage === "failed";

  return (
    <div style={{ display: "flex", gap: 3, alignItems: "center" }} role="list" aria-label="Pipeline stages">
      {STAGES.map((s, i) => {
        const done = i < current;
        const active = i === current && !isFailed;
        const bg = isFailed
          ? (i <= current ? "var(--osa-red)" : "var(--border)")
          : done ? "var(--green)" : active ? "var(--osa-orange)" : "var(--border)";
        const opacity = done || active ? 1 : 0.3;

        return (
          <div
            key={s.key}
            role="listitem"
            title={s.full}
            aria-label={`${s.full}: ${done ? "complete" : active ? "current" : "pending"}`}
            style={{
              width: 28, height: 18, borderRadius: 3,
              background: bg, opacity,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 8, fontWeight: 600, fontFamily: "var(--font-mono)",
              color: done || active ? "#fff" : "var(--text-muted)",
              letterSpacing: 0.5,
              transition: "background 0.3s, opacity 0.3s",
            }}
          >
            {s.label}
          </div>
        );
      })}
    </div>
  );
}

// ── Guardian badge ───────────────────────────────────────────────────────

function GuardianBadge({ status }: { status: string }) {
  if (status === "blocked") return <ShieldX size={14} color="var(--osa-red)" />;
  if (status === "warning") return <ShieldAlert size={14} color="var(--amber)" />;
  return <ShieldCheck size={14} color="var(--green)" />;
}

// ── Budget bar ───────────────────────────────────────────────────────────

function BudgetBar({ deal }: { deal: DealContext }) {
  const util = budgetUtilization(deal);
  if (util === null) return null;
  const pct = Math.min(util * 100, 100);
  const color = util > 1 ? "var(--osa-red)" : util > 0.9 ? "var(--amber)" : "var(--green)";
  return (
    <div title={`${Math.round(pct)}% of budget max`} style={{ width: "100%", height: 3, background: "var(--border)", borderRadius: 2, marginTop: 4 }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.3s" }} />
    </div>
  );
}

// ── Timer badge ──────────────────────────────────────────────────────────

function TimerBadge({ deal }: { deal: DealContext }) {
  const remaining = timerRemaining(deal);
  if (remaining === null) return null;
  const level = timerLevel(deal);
  const color = level === "red" ? "var(--osa-red)" : level === "amber" ? "var(--amber)" : "var(--text-muted)";
  return (
    <span title={`Quote expires in ${remaining} minutes`} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, color, fontFamily: "var(--font-mono)" }}>
      <Clock size={10} color={color} />
      {remaining}m
    </span>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px", gap: 12 }}>
      <Plane size={40} color="var(--border)" />
      <div style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center" }}>No active deals</div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", opacity: 0.6 }}>Deals appear here when the pipeline starts</div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────

interface Props {
  deals: DealContext[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading?: boolean;
}

export function PipelineView({ deals, selectedId, onSelect, loading }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!deals.length) return;
    const idx = deals.findIndex((d) => d.id === selectedId);
    if (e.key === "ArrowDown" && idx < deals.length - 1) {
      e.preventDefault();
      onSelect(deals[idx + 1]!.id);
    } else if (e.key === "ArrowUp" && idx > 0) {
      e.preventDefault();
      onSelect(deals[idx - 1]!.id);
    }
  }, [deals, selectedId, onSelect]);

  // Scroll selected into view
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-deal-id="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <nav aria-label="Deal pipeline" style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px 8px", display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: 0, letterSpacing: 0.5, textTransform: "uppercase" }}>
          Pipeline
        </h2>
        <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {deals.length} deal{deals.length !== 1 ? "s" : ""}
        </span>
      </div>

      {loading ? (
        <div style={{ padding: "0 8px" }}>
          {[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 72, marginBottom: 4, borderRadius: 6 }} />)}
        </div>
      ) : deals.length === 0 ? (
        <EmptyState />
      ) : (
        <div ref={listRef} role="listbox" aria-label="Deal list" tabIndex={0} onKeyDown={onKeyDown} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 8px 8px", outline: "none" }}>
          {deals.map((deal) => {
            const selected = deal.id === selectedId;
            const next = nextStep(deal);
            return (
              <div
                key={deal.id}
                role="option"
                aria-selected={selected}
                aria-label={`${deal.client.name || deal.id}, ${deal.trip.departure || "??"} to ${deal.trip.arrival || "??"}, stage ${deal.stage}`}
                data-deal-id={deal.id}
                tabIndex={-1}
                onClick={() => onSelect(deal.id)}
                onKeyDown={(e) => { if (e.key === "Enter") onSelect(deal.id); }}
                style={{
                  display: "flex", flexDirection: "column", gap: 5,
                  padding: "10px 12px", borderRadius: 6, border: "none",
                  background: selected ? "var(--surface-active)" : "transparent",
                  cursor: "pointer", textAlign: "left", width: "100%",
                  animation: "fadeIn 0.2s ease-out",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLElement).style.background = "var(--surface-hover)"; }}
                onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                {/* Row 1: name + badges */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <GuardianBadge status={deal.guardian.currentStatus} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
                      {deal.client.name || deal.id}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <TimerBadge deal={deal} />
                    <span style={{
                      fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 500,
                      color: deal.mode === "live" ? "var(--osa-orange)" : "var(--text-muted)",
                      background: deal.mode === "live" ? "rgba(231,75,29,0.1)" : "var(--surface-hover)",
                      padding: "1px 5px", borderRadius: 3,
                    }}>
                      {deal.mode.toUpperCase()}
                    </span>
                  </div>
                </div>

                {/* Row 2: route + price */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                    {deal.trip.departure || "??"}→{deal.trip.arrival || "??"} · {deal.trip.pax}pax
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                    {fmtPrice(deal.quote.osaPrice)}
                  </span>
                </div>

                {/* Row 3: stage bar + budget utilization */}
                <StageBar stage={deal.stage} />
                <BudgetBar deal={deal} />

                {/* Row 4: next step hint */}
                {next && deal.stage !== "closed" && deal.stage !== "failed" && (
                  <div style={{ fontSize: 10, color: "var(--text-muted)", opacity: 0.7 }}>
                    Next: {next} · {fmtRelative(deal.updatedAt)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </nav>
  );
}
