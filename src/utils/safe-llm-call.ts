/**
 * Type-safe LLM call wrapper with retry, backoff, and Zod validation.
 *
 * Migrated from ~/osa/simulator/src/utils/safe-llm-call.ts
 * Updated model IDs to latest.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { recoverJson } from "./recover-json.js";

export interface LlmCallOptions {
  model: string;
  systemPrompt: string;
  userMessage: string;
  schema: z.ZodType;
  maxRetries?: number;
  baseTimeoutMs?: number;
  apiClient: Anthropic;
  temperature?: number;
}

export interface LlmCallError {
  type:
    | "llm_timeout"
    | "llm_api_error"
    | "llm_invalid_json"
    | "schema_validation_failed";
  message: string;
  retriesAttempted: number;
}

export type LlmCallResult<T> =
  | { ok: true; data: T; retriesUsed: number }
  | { ok: false; error: LlmCallError };

const DEFAULT_TIMEOUTS: Record<string, number> = {
  "claude-haiku-4-5-20251001": 30_000,
  "claude-sonnet-4-20250514": 45_000,
  "claude-opus-4-20250514": 60_000,
};

export async function safeLlmCall<T>(
  options: LlmCallOptions & { schema: z.ZodType<T> },
): Promise<LlmCallResult<T>> {
  const {
    model,
    systemPrompt,
    userMessage,
    schema,
    apiClient,
    temperature = 0,
  } = options;
  const maxRetries = options.maxRetries ?? 3;
  let timeoutMs =
    options.baseTimeoutMs ?? DEFAULT_TIMEOUTS[model] ?? 45_000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await apiClient.messages.create(
        {
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          temperature,
        },
        { signal: controller.signal },
      );

      clearTimeout(timer);

      const text =
        response.content[0]?.type === "text" ? response.content[0].text : "";

      let parsed: unknown;
      try {
        parsed = JSON.parse(text.trim());
      } catch {
        parsed = await recoverJson(text, apiClient);
        if (parsed === null) {
          if (attempt < maxRetries) continue;
          return {
            ok: false,
            error: {
              type: "llm_invalid_json",
              message: `Invalid JSON after ${attempt} attempts`,
              retriesAttempted: attempt,
            },
          };
        }
      }

      const result = schema.safeParse(parsed);
      if (result.success) {
        return { ok: true, data: result.data, retriesUsed: attempt - 1 };
      }

      if (attempt < maxRetries) continue;

      return {
        ok: false,
        error: {
          type: "schema_validation_failed",
          message: `Schema validation failed: ${result.error.message}`,
          retriesAttempted: attempt,
        },
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        if (attempt < maxRetries) {
          timeoutMs = Math.round(timeoutMs * 1.5);
          continue;
        }
        return {
          ok: false,
          error: {
            type: "llm_timeout",
            message: `Timed out after ${timeoutMs}ms on attempt ${attempt}`,
            retriesAttempted: attempt,
          },
        };
      }

      if (
        err instanceof Anthropic.RateLimitError ||
        (err instanceof Error && err.message.includes("rate_limit"))
      ) {
        await sleep(2 ** attempt * 1000);
        continue;
      }

      if (attempt < maxRetries) continue;

      return {
        ok: false,
        error: {
          type: "llm_api_error",
          message: err instanceof Error ? err.message : String(err),
          retriesAttempted: attempt,
        },
      };
    }
  }

  return {
    ok: false,
    error: {
      type: "llm_api_error",
      message: "Exhausted all retries",
      retriesAttempted: maxRetries,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
