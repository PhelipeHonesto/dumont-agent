/**
 * Dumont Agent — Express server.
 * Voice AI via Vapi /chat/completions endpoint.
 * Port 3001.
 */

import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import { conversationRouter } from "./routes/conversation.js";
import { healthRouter } from "./routes/health.js";
import { vapiRouter } from "./routes/vapi-llm.js";
import { dealsRouter } from "./routes/deals.js";
import { chatRouter } from "./routes/chat.js";
import { radarRouter } from "./routes/radar.js";
import { intelligenceRouter } from "./routes/intelligence.js";
import { closeDb } from "../memory/database.js";

// ── Env Validation ──────────────────────────────────────────────────────

const IS_PROD = process.env.NODE_ENV === "production";

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("[dumont] WARNING: ANTHROPIC_API_KEY not set — chat/LLM endpoints will fail, intelligence API will work");
}

if (!process.env.VAPI_SECRET) {
  console.warn("[security] VAPI_SECRET not set — /chat/completions is unauthenticated" + (IS_PROD ? " (PRODUCTION)" : " (dev)"));
}


// ── CORS ────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : IS_PROD
    ? [] // In production, require explicit ALLOWED_ORIGINS
    : ["http://localhost:5174", "http://localhost:3001"]; // Dev: dashboard + server

const app = express();
const PORT = parseInt(process.env.PORT ?? "3001", 10);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, Vapi webhooks)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
}));
app.use(express.json());

app.use(conversationRouter);
app.use(healthRouter);
app.use(vapiRouter);
app.use(dealsRouter);
app.use(chatRouter);
app.use(radarRouter);
app.use(intelligenceRouter);

// ── Global Error Handler ────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[dumont] Unhandled error: ${err.message}`);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Start + Graceful Shutdown ───────────────────────────────────────────

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[dumont] Server running on port ${PORT}`);
});

// Start OpenSky ADS-B worker in-process (disable with ENABLE_OPENSKY=false)
if (process.env.ENABLE_OPENSKY !== "false") {
  setTimeout(() => {
    import("../ingestion/opensky-worker.js")
      .then((m) => m.startWorker?.())
      .catch((err) => console.warn(`[opensky] Failed to start: ${err instanceof Error ? err.message : String(err)}`));
  }, 5000);
}

function shutdown() {
  console.log("[dumont] Shutting down gracefully...");
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Force exit after 5s if connections don't close
  setTimeout(() => {
    closeDb();
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { app };
