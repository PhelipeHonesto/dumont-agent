/**
 * POST /chat/completions — OpenAI-compatible LLM endpoint for Vapi.
 * Vapi sends transcript → Dumont extracts fields → Claude generates spoken response → SSE back to Vapi.
 */

import { Router, type Request, type Response } from "express";
import { randomUUID, createHash } from "crypto";
import { processConversation } from "../dumont-brain.js";
import { streamClaudeResponse, getClaudeResponse, type MessageParam } from "../claude-sdr.js";
import { WebhookDedup } from "../../memory/webhook-dedup.js";

export const vapiRouter = Router();

// Webhook dedup — prevents duplicate processing from Vapi retries
const dedup = new WebhookDedup();

// ── Call ID resolution ──────────────────────────────────────────────────

const CALL_ID_TTL_MS = 60 * 60 * 1000; // 1 hour
const callIdMap = new Map<string, { id: string; ts: number }>();

// Evict stale call ID mappings every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - CALL_ID_TTL_MS;
  for (const [fp, entry] of callIdMap) {
    if (entry.ts < cutoff) callIdMap.delete(fp);
  }
}, 10 * 60 * 1000).unref();

function deriveCallId(req: Request, messages: Array<{ role: string; content: string }>): string {
  const vapiHeader = req.headers["x-vapi-call-id"] as string | undefined;
  if (vapiHeader) return vapiHeader;
  if (req.body?.call_id) return req.body.call_id as string;

  const systemMsg = messages.find((m) => m.role === "system");
  const firstUser = messages.find((m) => m.role === "user");
  const fingerprint = createHash("md5")
    .update((systemMsg?.content ?? "") + "|" + (firstUser?.content ?? ""))
    .digest("hex")
    .slice(0, 16);

  const existing = callIdMap.get(fingerprint);
  if (existing) { existing.ts = Date.now(); return existing.id; }
  const newId = `vapi_${randomUUID().slice(0, 12)}`;
  callIdMap.set(fingerprint, { id: newId, ts: Date.now() });
  return newId;
}

function buildTranscript(messages: Array<{ role: string; content: string }>): string {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "Caller" : "Dumont"}: ${m.content}`)
    .join("\n");
}

function toClaudeMessages(messages: Array<{ role: string; content: string }>): MessageParam[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

// ── SSE helpers ─────────────────────────────────────────────────────────

function sseChunk(id: string, ts: number, delta: Record<string, unknown>, finish?: string) {
  return JSON.stringify({
    id, object: "chat.completion.chunk", created: ts, model: "dumont",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  });
}

function transferToolCall(destination: string) {
  return [{
    index: 0,
    id: `call_${randomUUID().slice(0, 8)}`,
    type: "function",
    function: { name: "transferCall", arguments: JSON.stringify({ destination }) },
  }];
}

// ── Auth ────────────────────────────────────────────────────────────────

const VAPI_SECRET = process.env.VAPI_SECRET;
const IS_PROD = process.env.NODE_ENV === "production";

function checkAuth(req: Request, res: Response): boolean {
  if (!VAPI_SECRET) {
    if (IS_PROD) {
      res.status(401).json({ error: "VAPI_SECRET required in production" });
      return false;
    }
    return true; // Dev only — allow without secret
  }
  const header = req.headers.authorization;
  if (header === `Bearer ${VAPI_SECRET}`) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

// ── Route ───────────────────────────────────────────────────────────────

vapiRouter.post("/chat/completions", async (req: Request, res: Response) => {
  if (!checkAuth(req, res)) return;

  const { messages = [], stream = false } = req.body ?? {};

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages array required" });
    return;
  }

  // Idempotency: deduplicate webhook retries
  const bodyHash = createHash("sha256").update(JSON.stringify(req.body)).digest("hex").slice(0, 16);
  if (dedup.isDuplicate(bodyHash)) {
    res.status(200).json({ id: `chatcmpl-dedup`, choices: [{ message: { role: "assistant", content: "" } }] });
    return;
  }

  const callId = deriveCallId(req, messages);
  const turnCount = messages.filter((m: { role: string }) => m.role === "user").length;
  console.log("[vapi] call_id:", callId, "turn:", turnCount);

  const lastUser = [...messages].reverse().find((m: { role: string }) => m.role === "user");
  const result = processConversation({
    call_id: callId,
    transcript: buildTranscript(messages),
    last_utterance: lastUser?.content ?? "",
    extracted: null,
  });

  const completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const ts = Math.floor(Date.now() / 1000);
  const claudeMessages = toClaudeMessages(messages);

  // ── Non-streaming ─────────────────────────────────────────────────
  if (!stream) {
    let content: string;
    try {
      content = await getClaudeResponse(claudeMessages, result);
    } catch (err) {
      console.error("[vapi] Claude fallback:", (err as Error).message);
      content = result.response;
    }

    const message: Record<string, unknown> = { role: "assistant", content };
    if (result.action === "transfer" && result.transfer_to) {
      message.tool_calls = transferToolCall(result.transfer_to);
    }
    res.json({
      id: completionId, object: "chat.completion", created: ts, model: "dumont",
      choices: [{ index: 0, message, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    return;
  }

  // ── Streaming ─────────────────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: string) => res.write(`data: ${data}\n\n`);
  send(sseChunk(completionId, ts, { role: "assistant" }));

  try {
    for await (const text of streamClaudeResponse(claudeMessages, result)) {
      send(sseChunk(completionId, ts, { content: text }));
    }
  } catch (err) {
    console.error("[vapi] Claude stream fallback:", (err as Error).message);
    const words = result.response.split(/(\s+)/);
    for (const w of words) {
      if (w) send(sseChunk(completionId, ts, { content: w }));
    }
  }

  if (result.action === "transfer" && result.transfer_to) {
    send(sseChunk(completionId, ts, { tool_calls: transferToolCall(result.transfer_to) }));
  }

  send(sseChunk(completionId, ts, {}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
});
