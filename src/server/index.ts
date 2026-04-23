/**
 * Dumont Agent — Express server.
 * Voice AI via Vapi /chat/completions endpoint.
 * Port 3001.
 */

import express from "express";
import cors from "cors";
import { conversationRouter } from "./routes/conversation.js";
import { healthRouter } from "./routes/health.js";
import { vapiRouter } from "./routes/vapi-llm.js";
import { dealsRouter } from "./routes/deals.js";
import { chatRouter } from "./routes/chat.js";
import { radarRouter } from "./routes/radar.js";
import { intelligenceRouter } from "./routes/intelligence.js";
import { analyticsRouter } from "./routes/analytics.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { closeDb, setPgBridge } from "../memory/database.js";
import { closePg } from "../memory/pg-database.js";
import { globalLimiter, heavyLimiter } from "./middleware/rate-limit.js";
import { errorTracker, errorRouter } from "./middleware/error-tracker.js";
import { childLogger } from "../utils/logger.js";
import { initSentry, installProcessHandlers } from "../utils/sentry.js";

initSentry();
installProcessHandlers("server");
const log = childLogger("server");

// ── Env Validation ──────────────────────────────────────────────────────

const IS_PROD = process.env.NODE_ENV === "production";

if (!process.env.ANTHROPIC_API_KEY) {
  log.warn({}, "ANTHROPIC_API_KEY not set — chat/LLM endpoints will fail, intelligence API will work");
}

if (!process.env.VAPI_SECRET) {
  log.warn({ mode: IS_PROD ? "PRODUCTION" : "dev" }, "VAPI_SECRET not set — /chat/completions is unauthenticated");
}

// ── Database Backend ───────────────────────────────────────────────────

if (process.env.DATABASE_TYPE === "postgres") {
  const { getPgBridge } = await import("../memory/pg-database.js");
  setPgBridge(getPgBridge());
  console.log("[dumont] Database: PostgreSQL (Supabase)");
} else {
  console.log("[dumont] Database: SQLite");
}

// ── CORS ────────────────────────────────────────────────────────────────

const PROD_ORIGINS = [
  "https://orangesunshineaviation.com",
  "https://www.orangesunshineaviation.com",
  "https://api.orangesunshineaviation.com",
];

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : PROD_ORIGINS;

const app = express();
const PORT = parseInt(process.env.PORT ?? "3001", 10);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, Vapi webhooks)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // Dev: allow any localhost origin
    if (!IS_PROD && origin.match(/^http:\/\/localhost(:\d+)?$/)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
}));
app.use(express.json());

// Rate limiting — global + heavy endpoint limiter
app.use(globalLimiter);
app.use("/api/analytics", heavyLimiter);
app.use("/api/routes", heavyLimiter);
app.use("/api/market", heavyLimiter);

app.use(conversationRouter);
app.use(healthRouter);
app.use(vapiRouter);
app.use(dealsRouter);
app.use(chatRouter);
app.use(radarRouter);
app.use(intelligenceRouter);
app.use(analyticsRouter);
app.use(errorRouter);
app.use(dashboardRouter);

// ── Global Error Handler (must be last) ───────────────────────────────────

app.use(errorTracker);

// ── Start + Graceful Shutdown ───────────────────────────────────────────

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[dumont] Server running on port ${PORT}`);
});

function shutdown() {
  console.log("[dumont] Shutting down gracefully...");
  server.close(() => {
    closeDb();
    if (process.env.DATABASE_TYPE === "postgres") closePg().catch(() => {});
    process.exit(0);
  });
  // Force exit after 5s if connections don't close
  setTimeout(() => {
    closeDb();
    if (process.env.DATABASE_TYPE === "postgres") closePg().catch(() => {});
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { app };
