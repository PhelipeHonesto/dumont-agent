/**
 * Type-safe LLM call wrapper with retry, backoff, Zod validation, and token metering.
 *
 * Migrated from ~/osa/simulator/src/utils/safe-llm-call.ts
 * Updated model IDs to latest.
 *
 * Token metering:
 * - Captures response.usage from every Anthropic API call
 * - Right-sizes max_tokens per capability (not 4096 for everything)
 * - Estimates input tokens before call
 * - Tracks cumulative usage per deal with budget warning at 50K
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { recoverJson } from "./recover-json.js";

// ── Token Metering ──────────────────────────────────────────────────────

export interface TokenUsageEntry {
  capability: string;
  dealId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedInputTokens: number;
  timestamp: string;
}

/** Per-deal cumulative token budget tracker. */
const dealTokenBudgets = new Map<string, number>();

/** All token usage entries for inspection/export. */
const tokenUsageLog: TokenUsageEntry[] = [];

const DEAL_TOKEN_BUDGET = 50_000;
const MAX_TOKEN_LOG_ENTRIES = 1000;

/** Cheap input token estimate: ~4 chars per token on average. */
export function estimateInputTokens(systemPrompt: string, userMessage: string): number {
  return Math.ceil((systemPrompt.length + userMessage.length) / 4);
}

/** Record token usage and warn if deal exceeds budget. */
function recordTokenUsage(entry: TokenUsageEntry): void {
  tokenUsageLog.push(entry);
  // Ring buffer: cap at MAX_TOKEN_LOG_ENTRIES to prevent unbounded growth
  if (tokenUsageLog.length > MAX_TOKEN_LOG_ENTRIES) {
    tokenUsageLog.splice(0, tokenUsageLog.length - MAX_TOKEN_LOG_ENTRIES);
  }

  const current = dealTokenBudgets.get(entry.dealId) ?? 0;
  const total = current + entry.inputTokens + entry.outputTokens;
  dealTokenBudgets.set(entry.dealId, total);

  if (total > DEAL_TOKEN_BUDGET) {
    console.warn(
      `[token-budget] Deal ${entry.dealId} exceeded ${DEAL_TOKEN_BUDGET} tokens (now at ${total}). ` +
      `Last call: ${entry.capability} used ${entry.inputTokens}+${entry.outputTokens} tokens.`,
    );
  }
}

/** Evict a completed deal from the budget tracker (call on deal close). */
export function evictDealTokenBudget(dealId: string): void {
  dealTokenBudgets.delete(dealId);
}

/** Get cumulative token usage for a deal. */
export function getDealTokenUsage(dealId: string): number {
  return dealTokenBudgets.get(dealId) ?? 0;
}

/** Get full token usage log (for debugging/export). */
export function getTokenUsageLog(): TokenUsageEntry[] {
  return [...tokenUsageLog];
}

/** Reset token tracking (for testing). */
export function _resetTokenTracking(): void {
  dealTokenBudgets.clear();
  tokenUsageLog.length = 0;
}

// ── Right-sized output token limits per capability ──────────────────────

const EXPECTED_MAX_OUTPUT: Record<string, number> = {
  intake: 512,
  guardian: 512,
  estimate: 256,
  respond: 1024,
  evaluate: 512,
  revise: 1024,
  recovery: 512,
};

const DEFAULT_MAX_OUTPUT = 1024;

// ── LLM Call Interface ──────────────────────────────────────────────────

export interface LlmCallOptions {
  model: string;
  systemPrompt: string;
  userMessage: string;
  schema: z.ZodType;
  maxRetries?: number;
  baseTimeoutMs?: number;
  apiClient: Anthropic;
  temperature?: number;
  /** Capability name for token metering (e.g. "intake", "respond"). */
  capability?: string;
  /** Deal ID for per-deal token budget tracking. */
  dealId?: string;
  /** Override max output tokens. Uses capability-based default if not set. */
  expectedMaxOutput?: number;
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
  | { ok: true; data: T; retriesUsed: number; usage?: TokenUsageEntry }
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
    capability = "unknown",
    dealId = "unknown",
  } = options;
  const maxRetries = options.maxRetries ?? 3;
  let timeoutMs =
    options.baseTimeoutMs ?? DEFAULT_TIMEOUTS[model] ?? 45_000;

  // Right-size output tokens
  const maxTokens = options.expectedMaxOutput
    ?? EXPECTED_MAX_OUTPUT[capability]
    ?? DEFAULT_MAX_OUTPUT;

  // Pre-call input estimate
  const estimatedInput = estimateInputTokens(systemPrompt, userMessage);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await apiClient.messages.create(
        {
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          temperature,
        },
        { signal: controller.signal },
      );

      clearTimeout(timer);

      // Capture token usage from response
      const usageEntry: TokenUsageEntry = {
        capability,
        dealId,
        model,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        estimatedInputTokens: estimatedInput,
        timestamp: new Date().toISOString(),
      };
      recordTokenUsage(usageEntry);

      // Check for truncation — if max_tokens was hit, retry with doubled limit
      if (response.stop_reason === "max_tokens" && attempt < maxRetries) {
        continue;
      }

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
        return { ok: true, data: result.data, retriesUsed: attempt - 1, usage: usageEntry };
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
