/**
 * POST /api/chat — Dumont AI co-pilot SSE streaming endpoint.
 * Layer: server
 *
 * Uses Anthropic SDK streaming directly (NOT safeLlmCall — that waits for full response).
 * Manual token metering on the streaming path.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { authMiddleware, validateBody } from "../middleware.js";
import { BASE_PROMPT, buildChatContext } from "../chat-context.js";
import { estimateInputTokens } from "../../utils/safe-llm-call.js";

export const chatRouter = Router();

chatRouter.use(authMiddleware);

const ChatBodySchema = z.object({
  message: z.string().min(1).max(2000),
  dealId: z.string().optional(),
});

const client = new Anthropic();

chatRouter.post("/api/chat", validateBody(ChatBodySchema), async (req: Request, res: Response) => {
  const { message, dealId } = req.body;

  // Build token-optimized context
  const context = buildChatContext(dealId);
  const systemPrompt = `${BASE_PROMPT}\n\n${context}`;

  // Log estimated input tokens
  const inputEst = estimateInputTokens(systemPrompt, message);
  console.log(`[chat] deal=${dealId ?? "none"} inputEst=${inputEst}`);

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const stream = await client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: message }],
      temperature: 0.3,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    // Final event with usage for token metering
    const final = await stream.finalMessage();
    const inputTokens = final.usage.input_tokens;
    const outputTokens = final.usage.output_tokens;
    console.log(`[chat] deal=${dealId ?? "none"} in=${inputTokens} out=${outputTokens} total=${inputTokens + outputTokens}`);

    res.write("data: [DONE]\n\n");
  } catch (err) {
    console.error(`[chat] ${err instanceof Error ? err.message : String(err)}`);
    res.write(`data: ${JSON.stringify({ error: err instanceof Error ? err.message : "Stream failed" })}\n\n`);
  }

  res.end();
});
