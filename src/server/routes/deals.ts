/**
 * Deal API routes — GET /api/deals, GET /api/deals/:id, POST /api/deals/:id/review, POST /api/deals/:id/quote
 * Layer: server
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authMiddleware, validateBody, asyncHandler } from "../middleware.js";
import { DealStore } from "../../memory/deal-store.js";
import { DealEventLog } from "../../memory/deal-event-log.js";
import { ValidationLedgerStore } from "../../memory/composite-stores.js";
import { OperatorProfileStore } from "../../memory/composite-stores.js";
import { getDb } from "../../memory/database.js";

export const dealsRouter = Router();

// All deal routes require auth
dealsRouter.use(authMiddleware);

// Lazy-init stores (created on first request, share the singleton db)
let _dealStore: DealStore | null = null;
let _eventLog: DealEventLog | null = null;
let _ledger: ValidationLedgerStore | null = null;
let _operatorProfiles: OperatorProfileStore | null = null;

function dealStore(): DealStore {
  if (!_dealStore) _dealStore = new DealStore(getDb());
  return _dealStore;
}
function eventLog(): DealEventLog {
  if (!_eventLog) _eventLog = new DealEventLog(getDb());
  return _eventLog;
}
function ledger(): ValidationLedgerStore {
  if (!_ledger) _ledger = new ValidationLedgerStore(getDb());
  return _ledger;
}
function operatorProfiles(): OperatorProfileStore {
  if (!_operatorProfiles) _operatorProfiles = new OperatorProfileStore(getDb());
  return _operatorProfiles;
}

// ── GET /api/deals ──────────────────────────────────────────────────────

dealsRouter.get("/api/deals", asyncHandler(async (_req: Request, res: Response) => {
  const deals = dealStore().getAll();
  res.json({ deals, count: deals.length });
}));

// ── GET /api/deals/:id ──────────────────────────────────────────────────

dealsRouter.get("/api/deals/:id", asyncHandler(async (req: Request, res: Response) => {
  const deals = dealStore().getAll();
  const deal = deals.find((d) => d.id === String(req.params.id));
  if (!deal) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }
  res.json({ deal });
}));

// ── GET /api/deals/:id/events ───────────────────────────────────────────

dealsRouter.get("/api/deals/:id/events", asyncHandler(async (req: Request, res: Response) => {
  const events = eventLog().getEvents(String(req.params.id));
  res.json({ events, count: events.length });
}));

// ── POST /api/deals/:id/review ──────────────────────────────────────────

const ReviewBodySchema = z.object({
  action: z.enum(["approve", "reject"]),
  reason: z.string().min(1, "Reason is required"),
});

dealsRouter.post("/api/deals/:id/review",
  validateBody(ReviewBodySchema),
  asyncHandler(async (req: Request, res: Response) => {
    // Note: resumeDeal operates on DealContext (in-memory), not DealRecord (persisted).
    // In the current architecture, the dashboard sends a review action,
    // and the server would need to hold the DealContext in a session map.
    // For now, we log the review event and return success.
    // The full integration requires wiring the pipeline's DealContext into the server.
    const { action, reason } = req.body;
    const dealId = String(req.params.id);

    eventLog().appendEvent(dealId, "awaiting_review",
      action === "approve" ? "review_approved" : "review_rejected",
      { reason, reviewedBy: "founder" },
    );

    res.json({ status: "ok", dealId, action, reason });
  }),
);

// ── POST /api/deals/:id/quote ───────────────────────────────────────────

const QuoteBodySchema = z.object({
  operatorPrice: z.number().positive("Price must be positive"),
});

dealsRouter.post("/api/deals/:id/quote",
  validateBody(QuoteBodySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { operatorPrice } = req.body;
    const dealId = String(req.params.id);

    eventLog().appendEvent(dealId, "quoted", "manual_quote_entered", {
      operatorPrice,
      enteredBy: "founder",
    });

    res.json({ status: "ok", dealId, operatorPrice });
  }),
);

// ── GET /api/ledger ─────────────────────────────────────────────────────

dealsRouter.get("/api/ledger", asyncHandler(async (_req: Request, res: Response) => {
  const entries = ledger().getAll();
  const booked = entries.filter((e) => e.outcome === "booked");
  const totalRevenue = booked.reduce((sum, e) => sum + ((e.osaClientPrice ?? 0) - (e.operatorQuotedPrice ?? 0)), 0);

  res.json({
    entries,
    count: entries.length,
    summary: {
      totalDeals: entries.length,
      bookedDeals: booked.length,
      winRate: entries.length > 0 ? booked.length / entries.length : 0,
      totalRevenue,
      avgMargin: booked.length > 0
        ? booked.reduce((sum, e) => sum + (e.realizedMarginPct ?? 0), 0) / booked.length
        : 0,
      avgResponseTime: entries.filter((e) => e.operatorResponseMinutes != null).length > 0
        ? entries.filter((e) => e.operatorResponseMinutes != null)
            .reduce((sum, e) => sum + (e.operatorResponseMinutes ?? 0), 0) /
          entries.filter((e) => e.operatorResponseMinutes != null).length
        : 0,
    },
  });
}));

// ── GET /api/ledger/export ──────────────────────────────────────────────

dealsRouter.get("/api/ledger/export", asyncHandler(async (_req: Request, res: Response) => {
  const entries = ledger().getAll();
  const headers = [
    "Route", "Date", "Mode", "Lead Time (h)", "RLI", "Physics Estimate",
    "Ghost Positioning", "Operator Quote", "OSA Price", "Margin %",
    "RFQs Sent", "Quotes Received", "Operator Response (min)",
    "Client Decision (min)", "Outcome", "Fleet Resilience", "Notes",
  ];

  const rows = entries.map((e) => [
    e.route, e.date, e.mode, e.leadTimeHours, e.rliAtQuote,
    e.dumontPhysicsEstimate ?? "", e.ghostPositioningValue ?? "",
    e.operatorQuotedPrice ?? "", e.osaClientPrice ?? "", e.realizedMarginPct ?? "",
    e.rfqsSent, e.quotesReceived, e.operatorResponseMinutes ?? "",
    e.clientDecisionMinutes ?? "", e.outcome, e.fleetResilienceUsed, e.notes,
  ].join(","));

  const csv = [headers.join(","), ...rows].join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=validation-ledger.csv");
  res.send(csv);
}));

// ── GET /api/metrics ────────────────────────────────────────────────────

dealsRouter.get("/api/metrics", asyncHandler(async (_req: Request, res: Response) => {
  const deals = dealStore().getAll();
  const closed = deals.filter((d) => d.result === "closed");
  const withDelta = deals.filter((d) => d.estimateDelta != null);

  res.json({
    totalDeals: deals.length,
    closedDeals: closed.length,
    conversionRate: deals.length > 0 ? closed.length / deals.length : 0,
    totalRevenue: closed.reduce((sum, d) => sum + (d.revenue ?? 0), 0),
    avgDealSize: closed.length > 0
      ? closed.reduce((sum, d) => sum + (d.osaPrice ?? 0), 0) / closed.length
      : 0,
    avgMargin: closed.length > 0
      ? closed.reduce((sum, d) => sum + (d.margin ?? 0), 0) / closed.length
      : 0,
    avgEstimateDelta: withDelta.length > 0
      ? withDelta.reduce((sum, d) => sum + Math.abs(d.estimateDelta!), 0) / withDelta.length
      : 0,
  });
}));

// ── GET /api/operators ──────────────────────────────────────────────────

dealsRouter.get("/api/operators", asyncHandler(async (_req: Request, res: Response) => {
  const profiles = operatorProfiles().getAll();
  res.json({ operators: profiles, count: profiles.length });
}));
