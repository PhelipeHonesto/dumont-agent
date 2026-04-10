/**
 * Deal Detail Panel — full deal context with sections hidden when empty.
 * Shows pipeline progress with next-step hint and Guardian alerts.
 */

import { useState } from "react";
import type { DealContext, GuardianPass, GuardianCheck } from "../types";
import { ShieldCheck, ShieldAlert, ShieldX, Clock, Plane } from "./Icons";
import { fmtPrice, fmtDuration, fmtRelative, fmtPct, nextStep, timerRemaining, timerLevel } from "../utils";

// ── Reusable section + field ─────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} style={{ marginBottom: 16 }}>
      <h3 style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === "" || value === "—") return null;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</span>
      <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-primary)", fontWeight: 500 }}>{value}</span>
    </div>
  );
}

// ── Guardian alerts ──────────────────────────────────────────────────────

function GuardianAlerts({ passes }: { passes: GuardianPass[] }) {
  const issues = passes.flatMap((p) =>
    p.checks
      .filter((c) => c.severity === "warning" || (c.severity === "critical" && !c.passed))
      .map((c) => ({ ...c, stage: p.stage })),
  );

  if (issues.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--green)" }}>
        <ShieldCheck size={14} color="var(--green)" />
        All checks passed
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }} role="list" aria-label="Guardian alerts">
      {issues.map((c, i) => {
        const isCrit = c.severity === "critical";
        return (
          <div
            key={i}
            role="listitem"
            style={{
              padding: "6px 8px", borderRadius: 4, fontSize: 11,
              background: isCrit ? "rgba(239,68,68,0.08)" : "rgba(245,158,11,0.08)",
              borderLeft: `3px solid ${isCrit ? "var(--osa-red)" : "var(--amber)"}`,
              color: "var(--text-primary)", display: "flex", alignItems: "flex-start", gap: 6,
            }}
          >
            {isCrit ? <ShieldX size={12} color="var(--osa-red)" /> : <ShieldAlert size={12} color="var(--amber)" />}
            <div>
              <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)", fontSize: 10 }}>
                {(c as GuardianCheck & { stage: string }).stage.toUpperCase()}:{c.name}
              </span>
              <span style={{ marginLeft: 6 }}>{c.message}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Stage timeline ───────────────────────────────────────────────────────

function StageTimeline({ deal }: { deal: DealContext }) {
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }} role="list" aria-label="Stage history">
      {deal.stageHistory.map((h, i) => (
        <div
          key={i}
          role="listitem"
          aria-label={`${h.stage}${h.duration != null ? `, ${Math.round(h.duration / 1000)} seconds` : ""}`}
          style={{
            padding: "3px 6px", borderRadius: 4, fontSize: 10,
            fontFamily: "var(--font-mono)", fontWeight: 500,
            background: h.stage === deal.stage ? "var(--osa-orange)" : "var(--surface-hover)",
            color: h.stage === deal.stage ? "#fff" : "var(--text-muted)",
            transition: "background 0.3s",
          }}
        >
          {h.stage.toUpperCase().slice(0, 3)}
          {h.duration != null && <span style={{ marginLeft: 3, opacity: 0.7 }}>{Math.round(h.duration / 1000)}s</span>}
        </div>
      ))}
    </div>
  );
}

// ── Timer countdown ──────────────────────────────────────────────────────

function TimerCountdown({ deal }: { deal: DealContext }) {
  const remaining = timerRemaining(deal);
  if (remaining === null) return null;
  const level = timerLevel(deal);
  const color = level === "red" ? "var(--osa-red)" : level === "amber" ? "var(--amber)" : "var(--text-secondary)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 0", fontSize: 12, color }}>
      <Clock size={14} color={color} />
      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{remaining}m remaining</span>
      {level !== "none" && <span style={{ fontSize: 10, opacity: 0.8 }}>({level === "red" ? "urgent" : "approaching expiry"})</span>}
    </div>
  );
}

// ── Pricing waterfall ────────────────────────────────────────────────────

function WaterfallRow({ label, value, delta, color }: { label: string; value: string; delta?: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0" }}>
      <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        {delta && <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: color ?? "var(--text-muted)" }}>{delta}</span>}
        <span style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: color ?? "var(--text-primary)", fontWeight: 500 }}>{value}</span>
      </div>
    </div>
  );
}

function PricingWaterfall({ deal }: { deal: DealContext }) {
  const est = deal.estimate.priceRange;
  const estMedian = est ? Math.round((est.low + est.high) / 2) : null;
  const ghost = deal.estimate.positioning;
  const opQuote = deal.quote.operatorPrice;
  const margin = deal.quote.margin;
  const clientPrice = deal.quote.osaPrice;
  const marginAmount = clientPrice && opQuote ? clientPrice - opQuote : null;

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4, padding: "8px 12px" }}>
      {estMedian != null && (
        <WaterfallRow label="Physics Estimate" value={fmtPrice(estMedian)} />
      )}
      {ghost != null && ghost > 0 && (
        <WaterfallRow label="Ghost Positioning" value={`−${fmtPrice(Math.round(ghost * 8))}`} delta="saved" color="var(--green)" />
      )}
      {opQuote != null && (
        <WaterfallRow label="Operator Quote" value={fmtPrice(opQuote)} />
      )}
      {margin != null && marginAmount != null && (
        <WaterfallRow label={`OSA Margin (${fmtPct(margin)})`} value={`+${fmtPrice(marginAmount)}`} color="var(--text-muted)" />
      )}
      {(opQuote != null || marginAmount != null) && (
        <div style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>Client Price</span>
          <span style={{ fontSize: 18, fontFamily: "var(--font-mono)", color: "var(--text-primary)", fontWeight: 700 }}>
            {fmtPrice(clientPrice)}
          </span>
        </div>
      )}
      {deal.outcome.revenue != null && (
        <div style={{ marginTop: 4, display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>Revenue</span>
          <span style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--green)", fontWeight: 600 }}>{fmtPrice(deal.outcome.revenue)}</span>
        </div>
      )}
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────

function EmptyDetail() {
  return (
    <div style={{ flex: 2, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "var(--text-muted)" }}>
      <Plane size={48} color="var(--border)" />
      <div style={{ fontSize: 13 }}>Select a deal from the pipeline</div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────

interface DealDetailProps {
  deal: DealContext | null;
  onReviewAction?: (dealId: string, action: "approve" | "reject", reason: string) => void;
}

export function DealDetail({ deal, onReviewAction }: DealDetailProps) {
  const [reviewMode, setReviewMode] = useState<"approve" | "reject" | null>(null);
  const [reviewReason, setReviewReason] = useState("");

  if (!deal) return <EmptyDetail />;

  const next = nextStep(deal);
  const hasEstimate = deal.estimate.priceRange !== null;
  const hasOperator = deal.sourcing.selectedOperator !== null;
  const hasQuote = deal.quote.operatorPrice !== null;
  const hasOutcome = deal.outcome.result !== null;

  return (
    <article aria-label={`Deal details for ${deal.client.name || deal.id}`} style={{ flex: 2, overflow: "auto", padding: "16px 20px", borderLeft: "1px solid var(--border)" }}>
      {/* Header */}
      <header style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
            {deal.client.name || deal.id}
          </h2>
          <span style={{
            fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 600,
            padding: "2px 8px", borderRadius: 4,
            background: deal.stage === "closed" ? "var(--green)" : deal.stage === "failed" ? "var(--osa-red)" : "var(--osa-orange)",
            color: "#fff",
          }}>
            {deal.stage.toUpperCase()}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: 4 }}>
          {deal.id} · {deal.mode.toUpperCase()} · {fmtRelative(deal.updatedAt)}
        </div>
        {next && deal.stage !== "closed" && deal.stage !== "failed" && (
          <div style={{ fontSize: 11, color: "var(--osa-orange)", marginTop: 6, fontWeight: 500 }}>
            Next step: {next}
          </div>
        )}
      </header>

      {/* Review banner — full width, unmissable, with inline approve/reject */}
      {deal.stage === "awaiting_review" && (
        <div style={{
          padding: "10px 12px", marginBottom: 12, borderRadius: 4,
          background: "rgba(245,158,11,0.08)", border: "1px solid var(--amber)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <ShieldAlert size={16} color="var(--amber)" />
            <span style={{ fontSize: 12, color: "var(--amber)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Review Required</span>
          </div>
          {/* Show specific Guardian warnings */}
          {deal.guardian.passes.flatMap((p) =>
            p.checks.filter((c) => !c.passed && c.severity === "warning").map((c, i) => (
              <div key={`${p.stage}-${i}`} style={{ fontSize: 11, color: "var(--text-primary)", padding: "2px 0 2px 22px" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>{p.stage.toUpperCase()}:</span>{" "}
                {c.message}
              </div>
            )),
          )}
          {/* Inline approve/reject */}
          {onReviewAction && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => { setReviewMode("approve"); setReviewReason(""); }}
                  style={{ padding: "6px 16px", borderRadius: 4, cursor: "pointer", background: reviewMode === "approve" ? "var(--green)" : "var(--surface-hover)", color: reviewMode === "approve" ? "#fff" : "var(--green)", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)", border: reviewMode === "approve" ? "none" : "1px solid var(--green)" }}
                >
                  APPROVE
                </button>
                <button
                  onClick={() => { setReviewMode("reject"); setReviewReason(""); }}
                  style={{ padding: "6px 16px", borderRadius: 4, cursor: "pointer", background: reviewMode === "reject" ? "var(--osa-red)" : "var(--surface-hover)", color: reviewMode === "reject" ? "#fff" : "var(--osa-red)", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)", border: reviewMode === "reject" ? "none" : "1px solid var(--osa-red)" }}
                >
                  REJECT
                </button>
                <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", alignSelf: "center" }}>⌘↵ approve · ⌘⌫ reject</span>
              </div>
              {reviewMode && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                  <textarea
                    value={reviewReason}
                    onChange={(e) => setReviewReason(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        onReviewAction(deal.id, reviewMode, reviewReason || `${reviewMode === "approve" ? "Approved" : "Rejected"} by broker`);
                        setReviewMode(null);
                        setReviewReason("");
                      }
                      if (e.key === "Escape") { setReviewMode(null); setReviewReason(""); }
                    }}
                    placeholder={`${reviewMode === "approve" ? "Approve" : "Reject"} reason (Enter to submit, Esc to cancel)...`}
                    autoFocus
                    style={{
                      width: "100%", minHeight: 48, padding: 8, borderRadius: 4,
                      border: `1px solid ${reviewMode === "approve" ? "var(--green)" : "var(--osa-red)"}`,
                      background: "var(--surface)", color: "var(--text-primary)",
                      fontSize: 11, fontFamily: "var(--font-mono)", resize: "vertical", outline: "none",
                    }}
                  />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => { onReviewAction(deal.id, reviewMode, reviewReason || `${reviewMode === "approve" ? "Approved" : "Rejected"} by broker`); setReviewMode(null); setReviewReason(""); }}
                      style={{ padding: "4px 12px", borderRadius: 4, border: "none", cursor: "pointer", background: reviewMode === "approve" ? "var(--green)" : "var(--osa-red)", color: "#fff", fontSize: 10, fontWeight: 600, fontFamily: "var(--font-mono)" }}
                    >
                      Submit
                    </button>
                    <button
                      onClick={() => { setReviewMode(null); setReviewReason(""); }}
                      style={{ padding: "4px 12px", borderRadius: 4, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", fontSize: 10, cursor: "pointer", fontFamily: "var(--font-mono)" }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <StageTimeline deal={deal} />
      <TimerCountdown deal={deal} />

      <div style={{ marginTop: 12 }} />

      {/* Route — always shown */}
      <Section title="Route">
        <Field label="Route" value={deal.trip.departure && deal.trip.arrival ? `${deal.trip.departure} → ${deal.trip.arrival}` : null} />
        <Field label="Date" value={deal.trip.date || null} />
        <Field label="Passengers" value={deal.trip.pax > 0 ? deal.trip.pax : null} />
        <Field label="Aircraft" value={deal.trip.aircraftType ?? deal.trip.aircraftClass} />
        {deal.trip.isRoundTrip && <Field label="Type" value="Round Trip" />}
        {deal.trip.specialRequirements.length > 0 && <Field label="Special" value={deal.trip.specialRequirements.join(", ")} />}
      </Section>

      {/* Client — always shown */}
      <Section title="Client">
        <Field label="Name" value={deal.client.name || null} />
        <Field label="Contact" value={deal.client.contact || null} />
        <Field label="Type" value={deal.client.type} />
        <Field label="Budget" value={deal.client.budget ? `${fmtPrice(deal.client.budget.min)}–${fmtPrice(deal.client.budget.max)}` : null} />
      </Section>

      {/* Pricing waterfall — each line builds on the last */}
      {hasEstimate && (
        <Section title="Pricing">
          <PricingWaterfall deal={deal} />
        </Section>
      )}

      {/* Operator — only if sourced */}
      {hasOperator && (
        <Section title="Operator">
          <Field label="Name" value={deal.sourcing.selectedOperator!.operatorName} />
          <Field label="Base" value={deal.sourcing.selectedOperator!.baseAirport} />
          <Field label="Aircraft" value={`${deal.sourcing.selectedOperator!.aircraftType} ${deal.sourcing.selectedOperator!.aircraftTail ?? ""}`.trim()} />
          <Field label="Score" value={deal.sourcing.selectedOperator!.score.toFixed(3)} />
          <Field label="Response" value={fmtDuration(deal.outcome.operatorResponseTime)} />
        </Section>
      )}

      {/* Guardian — always shown */}
      <Section title="Guardian">
        <GuardianAlerts passes={deal.guardian.passes} />
      </Section>

      {/* Outcome — only if terminal */}
      {hasOutcome && (
        <Section title="Outcome">
          <Field label="Result" value={deal.outcome.result} />
          <Field label="Deal Time" value={fmtDuration(deal.outcome.totalDealTime)} />
          <Field label="Est. vs Actual" value={deal.outcome.estimateVsActual != null ? fmtPct(deal.outcome.estimateVsActual) : null} />
          {deal.outcome.notes && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, fontStyle: "italic" }}>{deal.outcome.notes}</div>
          )}
        </Section>
      )}
    </article>
  );
}
