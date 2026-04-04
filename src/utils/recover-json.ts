/**
 * Attempts to recover valid JSON from malformed LLM output.
 * Three strategies: strip markdown fences, extract braces, Haiku fix.
 *
 * Migrated from ~/osa/simulator/src/utils/recover-json.ts
 */

import Anthropic from "@anthropic-ai/sdk";

export async function recoverJson(
  raw: string,
  apiClient?: Anthropic,
): Promise<unknown | null> {
  // Attempt 1: Strip markdown code fences
  const fenceStripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    return JSON.parse(fenceStripped);
  } catch {
    // continue
  }

  // Attempt 2: Extract first { to last }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // continue
    }
  }

  // Attempt 3: Ask Haiku to fix it
  if (apiClient) {
    try {
      const response = await apiClient.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system:
          "Fix this invalid JSON. Return ONLY valid JSON, no explanation.",
        messages: [{ role: "user", content: raw }],
      });

      const text =
        response.content[0]?.type === "text" ? response.content[0].text : "";
      return JSON.parse(text.trim());
    } catch {
      // truly unrecoverable
    }
  }

  return null;
}
