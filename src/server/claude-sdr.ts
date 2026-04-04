/**
 * Claude SDR — natural language layer over Dumont's extraction engine.
 * Haiku generates the spoken response; dumont-brain handles field extraction + estimates.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { DumontResponse } from "./dumont-brain.js";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are Dumont, the AI charter assistant at Orange Sunshine Aviation. You're a warm, professional concierge — not a call center agent. You sound like someone who works at a premium FBO.

CURRENT CONVERSATION STATE:
{state_json}

YOUR JOB:
- Have a natural conversation to collect: departure, arrival, date, and passenger count
- Don't interrogate — ask naturally, combine questions when it makes sense
- If the caller gives multiple details at once, acknowledge ALL of them
- Mirror aviation language when appropriate (FBOs, tail numbers, etc.) but don't over-do it
- If they mention budget, note it but don't push
- When you have all 4 fields, present the estimate naturally

RULES:
- Never make up prices — only quote from the estimate data
- Never promise specific aircraft availability
- Be concise — this is a phone call, not an email
- If they ask about safety: "All operators in our network hold FAA Part 135 certificates"
- If asked what OSA does: "We arrange private charter flights. Door to door, no lines, no hassle."
- End every qualifying call by offering to connect with Phelipe

ESTIMATE DATA (only if all fields collected):
{estimate_json}

Respond in 1-2 sentences max. This is spoken aloud on a phone call — keep it tight.`;

function buildSystemPrompt(result: DumontResponse): string {
  const state = JSON.stringify(result.deal_data, null, 2);
  const estimate = result.action === "transfer"
    ? JSON.stringify(result.deal_data, null, 2)
    : "Not yet available — still collecting trip details.";
  return SYSTEM_PROMPT
    .replace("{state_json}", state)
    .replace("{estimate_json}", estimate);
}

export type MessageParam = { role: "user" | "assistant"; content: string };

/**
 * Stream Claude's response as an async iterator of text chunks.
 * Caller is responsible for formatting as SSE.
 */
export async function* streamClaudeResponse(
  messages: MessageParam[],
  result: DumontResponse,
): AsyncGenerator<string> {
  const stream = client.messages.stream({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    system: buildSystemPrompt(result),
    messages,
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}

/**
 * Non-streaming: get the full response as a string.
 */
export async function getClaudeResponse(
  messages: MessageParam[],
  result: DumontResponse,
): Promise<string> {
  const resp = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    system: buildSystemPrompt(result),
    messages,
  });

  const block = resp.content[0];
  return block?.type === "text" ? block.text : result.response;
}
