/**
 * Dumont MCP Server — SSE transport for remote access.
 *
 * Exposes the same 9 tools as the stdio server over HTTP/SSE on port 3002.
 * Auth: Bearer token via MCP_AUTH_TOKEN env var. Skipped if unset (dev mode).
 *
 * Endpoints:
 *   GET  /sse      — SSE stream (client connects here)
 *   POST /messages — JSON-RPC messages from client
 *
 * Usage: npx tsx src/mcp/server-sse.ts
 */

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { closeDb } from "../memory/database.js";
import { registerTools } from "./tools.js";

const PORT = parseInt(process.env.MCP_SSE_PORT ?? "3002", 10);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.warn("[mcp-sse] MCP_AUTH_TOKEN not set — running without auth (dev mode)");
}

// ── Auth check ──────────────────────────────────────────────────────────

function checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!AUTH_TOKEN) return true;

  const header = req.headers.authorization;
  if (header === `Bearer ${AUTH_TOKEN}`) return true;

  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
  return false;
}

// ── Server setup ────────────────────────────────────────────────────────

const mcpServer = new McpServer(
  { name: "dumont-intelligence", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Dumont Aviation Intelligence — query FAA registry, ADS-B flight data, " +
      "ghost fleet candidates, market listings, and route analytics for US " +
      "charter-class aircraft.",
  },
);

registerTools(mcpServer);

// Track active transports by session ID
const transports = new Map<string, SSEServerTransport>();

// ── HTTP server ─────────────────────────────────────────────────────────

const httpServer = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // GET /sse — establish SSE connection
  if (req.method === "GET" && url.pathname === "/sse") {
    if (!checkAuth(req, res)) return;

    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);

    transport.onclose = () => {
      transports.delete(transport.sessionId);
    };

    await mcpServer.connect(transport);
    return;
  }

  // POST /messages — receive JSON-RPC messages
  if (req.method === "POST" && url.pathname === "/messages") {
    if (!checkAuth(req, res)) return;

    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing sessionId query parameter" }));
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

    await transport.handlePostMessage(req, res, body);
    return;
  }

  // Health check
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", transport: "sse", sessions: transports.size }));
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// ── Start ───────────────────────────────────────────────────────────────

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[mcp-sse] Dumont MCP server (SSE) running on port ${PORT}`);
  console.log(`[mcp-sse] SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`[mcp-sse] Auth: ${AUTH_TOKEN ? "enabled" : "disabled (dev mode)"}`);
});

function shutdown() {
  console.log("[mcp-sse] Shutting down...");
  for (const transport of transports.values()) {
    transport.close().catch(() => {});
  }
  closeDb();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
