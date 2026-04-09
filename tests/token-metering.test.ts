/**
 * Tests for token metering utilities in safe-llm-call.ts.
 * Covers: estimateInputTokens, getDealTokenUsage, getTokenUsageLog,
 *         evictDealTokenBudget, _resetTokenTracking, log capping, budget warnings.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  estimateInputTokens,
  getDealTokenUsage,
  getTokenUsageLog,
  evictDealTokenBudget,
  _resetTokenTracking,
  type TokenUsageEntry,
} from "../src/utils/safe-llm-call.js";

/** Helper: build a TokenUsageEntry and push it via the internal recordTokenUsage
 *  path. Since recordTokenUsage is private, we use safeLlmCall — but that needs
 *  an Anthropic client. Instead, we exploit the fact that _resetTokenTracking
 *  clears the module-level arrays, and we directly test the exported readers.
 *
 *  For tests that need entries in the log/budget, we import the module internals
 *  by re-importing the module and accessing the non-exported function through
 *  a dynamic import workaround — OR we simply accept that some tests can only
 *  verify the "empty" baseline through the public API.
 *
 *  Strategy: We use vi.importActual + module-level access to call recordTokenUsage
 *  indirectly. The cleanest approach is to cast the module and call the private fn.
 */

// Access the private recordTokenUsage by importing the full module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;

beforeEach(async () => {
  _resetTokenTracking();
  // Dynamically import to get a reference that includes the private function
  mod = await import("../src/utils/safe-llm-call.js");
  mod._resetTokenTracking();
});

/** Helper to build a token usage entry. */
function makeEntry(overrides: Partial<TokenUsageEntry> = {}): TokenUsageEntry {
  return {
    capability: "intake",
    dealId: "DEAL-001",
    model: "claude-haiku-4-5-20251001",
    inputTokens: 100,
    outputTokens: 50,
    estimatedInputTokens: 90,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Since recordTokenUsage is not exported, we need a way to populate the internal
 * state. We access it through the module's internal scope by using a small trick:
 * we call the private function via the module namespace if available, otherwise
 * we test only the public API baseline behavior.
 *
 * For a cleaner approach, we add entries by directly manipulating the exported
 * functions that READ state (they can't write) — so we need the private fn.
 * We'll use Object.keys to find it or fall back to testing only public API.
 */

// The private recordTokenUsage is not on the module exports. We need another way.
// Let's use a workaround: import the module source and call it via eval — NO.
// Better: we test the public surface thoroughly. For budget/log tests that need
// populated state, we mock the module internals.

// Actually, the simplest approach: re-export recordTokenUsage from the module
// for testing, or accept we can test the public API thoroughly.
// Given constraints, let's test everything we can with the public API.

describe("estimateInputTokens", () => {
  it("returns correct estimate based on ~4 chars per token", () => {
    // 20 chars system + 20 chars user = 40 chars => 40/4 = 10 tokens
    const result = estimateInputTokens("a]".repeat(10), "b".repeat(20));
    expect(result).toBe(Math.ceil(40 / 4));
  });

  it("returns 0 for empty strings", () => {
    expect(estimateInputTokens("", "")).toBe(0);
  });

  it("handles long strings correctly", () => {
    const longSystem = "x".repeat(10_000);
    const longUser = "y".repeat(6_000);
    expect(estimateInputTokens(longSystem, longUser)).toBe(Math.ceil(16_000 / 4));
  });

  it("rounds up for non-divisible lengths", () => {
    // 5 chars total => ceil(5/4) = 2
    expect(estimateInputTokens("ab", "cde")).toBe(2);
  });

  it("handles single character input", () => {
    expect(estimateInputTokens("a", "")).toBe(1);
    expect(estimateInputTokens("", "b")).toBe(1);
  });
});

describe("getDealTokenUsage", () => {
  it("returns 0 for unknown deal", () => {
    expect(getDealTokenUsage("DEAL-NONEXISTENT")).toBe(0);
  });

  it("returns 0 after reset", () => {
    _resetTokenTracking();
    expect(getDealTokenUsage("DEAL-001")).toBe(0);
  });
});

describe("getTokenUsageLog", () => {
  it("returns empty array initially", () => {
    expect(getTokenUsageLog()).toEqual([]);
  });

  it("returns empty array after reset", () => {
    _resetTokenTracking();
    const log = getTokenUsageLog();
    expect(log).toEqual([]);
    expect(Array.isArray(log)).toBe(true);
  });

  it("returns a copy, not the internal array reference", () => {
    const log1 = getTokenUsageLog();
    const log2 = getTokenUsageLog();
    expect(log1).not.toBe(log2);
    expect(log1).toEqual(log2);
  });

  it("mutations on returned array do not affect internal state", () => {
    const log = getTokenUsageLog();
    log.push(makeEntry());
    expect(getTokenUsageLog()).toEqual([]);
  });
});

describe("evictDealTokenBudget", () => {
  it("does not throw for unknown deal", () => {
    expect(() => evictDealTokenBudget("DEAL-NONEXISTENT")).not.toThrow();
  });

  it("getDealTokenUsage returns 0 after eviction", () => {
    // Even without populating, eviction of unknown should still yield 0
    evictDealTokenBudget("DEAL-001");
    expect(getDealTokenUsage("DEAL-001")).toBe(0);
  });
});

describe("_resetTokenTracking", () => {
  it("clears all state without throwing", () => {
    expect(() => _resetTokenTracking()).not.toThrow();
    expect(getTokenUsageLog()).toEqual([]);
    expect(getDealTokenUsage("any-deal")).toBe(0);
  });

  it("can be called multiple times safely", () => {
    _resetTokenTracking();
    _resetTokenTracking();
    _resetTokenTracking();
    expect(getTokenUsageLog()).toEqual([]);
  });
});

describe("Token metering through safeLlmCall", () => {
  it("records token usage from a mocked Anthropic API call", async () => {
    const { safeLlmCall } = await import("../src/utils/safe-llm-call.js");
    const { z } = await import("zod");

    _resetTokenTracking();

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '{"result": "ok"}' }],
          usage: { input_tokens: 200, output_tokens: 80 },
        }),
      },
    };

    const schema = z.object({ result: z.string() });

    const result = await safeLlmCall({
      model: "claude-haiku-4-5-20251001",
      systemPrompt: "You are a test assistant.",
      userMessage: "Parse this.",
      schema,
      apiClient: mockClient as any,
      capability: "intake",
      dealId: "DEAL-TEST-001",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toBeDefined();
      expect(result.usage!.inputTokens).toBe(200);
      expect(result.usage!.outputTokens).toBe(80);
      expect(result.usage!.capability).toBe("intake");
      expect(result.usage!.dealId).toBe("DEAL-TEST-001");
    }

    // Verify log was populated
    const log = getTokenUsageLog();
    expect(log).toHaveLength(1);
    expect(log[0].inputTokens).toBe(200);
    expect(log[0].outputTokens).toBe(80);

    // Verify deal budget was updated
    expect(getDealTokenUsage("DEAL-TEST-001")).toBe(280);
  });

  it("accumulates token usage across multiple calls for same deal", async () => {
    const { safeLlmCall } = await import("../src/utils/safe-llm-call.js");
    const { z } = await import("zod");

    _resetTokenTracking();

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '{"v": 1}' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      },
    };

    const schema = z.object({ v: z.number() });
    const opts = {
      model: "claude-haiku-4-5-20251001",
      systemPrompt: "sys",
      userMessage: "usr",
      schema,
      apiClient: mockClient as any,
      capability: "intake",
      dealId: "DEAL-MULTI",
    };

    await safeLlmCall(opts);
    await safeLlmCall(opts);
    await safeLlmCall(opts);

    expect(getDealTokenUsage("DEAL-MULTI")).toBe(450); // 3 * (100+50)
    expect(getTokenUsageLog()).toHaveLength(3);
  });

  it("fires console.warn when deal exceeds 50K token budget", async () => {
    const { safeLlmCall } = await import("../src/utils/safe-llm-call.js");
    const { z } = await import("zod");

    _resetTokenTracking();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '{"ok": true}' }],
          usage: { input_tokens: 30_000, output_tokens: 25_000 },
        }),
      },
    };

    const schema = z.object({ ok: z.boolean() });

    await safeLlmCall({
      model: "claude-haiku-4-5-20251001",
      systemPrompt: "s",
      userMessage: "u",
      schema,
      apiClient: mockClient as any,
      capability: "estimate",
      dealId: "DEAL-OVER-BUDGET",
    });

    // 30000 + 25000 = 55000 > 50000
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("DEAL-OVER-BUDGET"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("exceeded"),
    );

    warnSpy.mockRestore();
  });

  it("evictDealTokenBudget resets deal usage after safeLlmCall", async () => {
    const { safeLlmCall } = await import("../src/utils/safe-llm-call.js");
    const { z } = await import("zod");

    _resetTokenTracking();

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '{"x": 1}' }],
          usage: { input_tokens: 500, output_tokens: 200 },
        }),
      },
    };

    await safeLlmCall({
      model: "claude-haiku-4-5-20251001",
      systemPrompt: "s",
      userMessage: "u",
      schema: z.object({ x: z.number() }),
      apiClient: mockClient as any,
      dealId: "DEAL-EVICT",
    });

    expect(getDealTokenUsage("DEAL-EVICT")).toBe(700);

    evictDealTokenBudget("DEAL-EVICT");
    expect(getDealTokenUsage("DEAL-EVICT")).toBe(0);
  });

  it("caps token log at MAX_TOKEN_LOG_ENTRIES (1000)", async () => {
    const { safeLlmCall } = await import("../src/utils/safe-llm-call.js");
    const { z } = await import("zod");

    _resetTokenTracking();

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '{"n": 1}' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      },
    };

    const schema = z.object({ n: z.number() });
    const opts = {
      model: "claude-haiku-4-5-20251001",
      systemPrompt: "s",
      userMessage: "u",
      schema,
      apiClient: mockClient as any,
      capability: "intake",
      dealId: "DEAL-CAP",
    };

    // Make 1005 calls to exceed the 1000 cap
    for (let i = 0; i < 1005; i++) {
      await safeLlmCall(opts);
    }

    const log = getTokenUsageLog();
    expect(log.length).toBeLessThanOrEqual(1000);
    expect(log.length).toBe(1000);
  }, 30_000);

  it("records estimatedInputTokens in usage entry", async () => {
    const { safeLlmCall } = await import("../src/utils/safe-llm-call.js");
    const { z } = await import("zod");

    _resetTokenTracking();

    const systemPrompt = "You are helpful.";
    const userMessage = "Do something.";

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '{"done": true}' }],
          usage: { input_tokens: 50, output_tokens: 20 },
        }),
      },
    };

    const result = await safeLlmCall({
      model: "claude-haiku-4-5-20251001",
      systemPrompt,
      userMessage,
      schema: z.object({ done: z.boolean() }),
      apiClient: mockClient as any,
      dealId: "DEAL-EST",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = estimateInputTokens(systemPrompt, userMessage);
      expect(result.usage!.estimatedInputTokens).toBe(expected);
    }
  });
});
