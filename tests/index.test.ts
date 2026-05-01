import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { createRouter } from "../src/router.ts";
import { UsageTracker } from "../src/usage-tracker.ts";
import { CircuitBreaker } from "../src/circuit-breaker.ts";
import { MemoryStorage } from "../src/storage/memory-storage.ts";
import { FileStorage } from "../src/storage/file-storage.ts";
import { RedisStorage } from "../src/storage/redis-storage.ts";
import { backoff, deriveModelId } from "../src/utils.ts";

// ─── Test Helpers ────────────────────────────────────────────────────

function makeUsage(input = 100, output = 50): LanguageModelV3Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

function makeResult(text = "hello"): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: makeUsage(),
    warnings: [],
  };
}

function makeStreamResult(): LanguageModelV3StreamResult {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start" as const, warnings: [] });
      controller.enqueue({ type: "text-start" as const, id: "1" });
      controller.enqueue({ type: "text-delta" as const, id: "1", delta: "hi" });
      controller.enqueue({ type: "text-end" as const, id: "1" });
      controller.enqueue({
        type: "finish" as const,
        usage: makeUsage(),
        finishReason: { unified: "stop" as const, raw: "stop" },
      });
      controller.close();
    },
  });
  return { stream };
}

function mockModel(
  provider: string,
  modelId: string,
  overrides?: {
    doGenerate?: LanguageModelV3["doGenerate"];
    doStream?: LanguageModelV3["doStream"];
  },
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: overrides?.doGenerate ?? vi.fn(async () => makeResult()),
    doStream: overrides?.doStream ?? vi.fn(async () => makeStreamResult()),
  };
}

const dummyPrompt: LanguageModelV3CallOptions = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

// ═══════════════════════════════════════════════════════════════════
// Utils
// ═══════════════════════════════════════════════════════════════════

describe("utils", () => {
  test("deriveModelId", () => {
    expect(deriveModelId("openai", "gpt-4o")).toBe("openai:gpt-4o");
  });

  test("backoff — no jitter", () => {
    expect(backoff(0, 500, 2, false)).toBe(500);
    expect(backoff(1, 500, 2, false)).toBe(1000);
    expect(backoff(2, 500, 2, false)).toBe(2000);
  });

  test("backoff — with jitter stays in range", () => {
    for (let i = 0; i < 50; i++) {
      const val = backoff(0, 1000, 2, true);
      expect(val).toBeGreaterThanOrEqual(750);
      expect(val).toBeLessThanOrEqual(1250);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Storage Adapters
// ═══════════════════════════════════════════════════════════════════

describe("MemoryStorage", () => {
  test("load returns empty on first use", async () => {
    const s = new MemoryStorage();
    expect(await s.load()).toEqual({});
  });

  test("save + load round-trips", async () => {
    const s = new MemoryStorage();
    const data = { "model:a": [{ timestamp: 1, tokens: 100 }] };
    await s.save(data);
    expect(await s.load()).toEqual(data);
  });
});

describe("RedisStorage", () => {
  test("load returns empty when key is missing", async () => {
    const client = { get: vi.fn(async () => null), set: vi.fn(async () => "OK") };
    const s = new RedisStorage(client, "test:key");
    expect(await s.load()).toEqual({});
    expect(client.get).toHaveBeenCalledWith("test:key");
  });

  test("save + load round-trips", async () => {
    const store: Record<string, string> = {};
    const client = {
      get: vi.fn(async (k: string) => store[k] ?? null),
      set: vi.fn(async (k: string, v: string) => { store[k] = v; return "OK"; }),
    };
    const s = new RedisStorage(client, "test:key");
    const data = { "model:b": [{ timestamp: 2, tokens: 200 }] };
    await s.save(data);
    expect(await s.load()).toEqual(data);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Circuit Breaker
// ═══════════════════════════════════════════════════════════════════

describe("CircuitBreaker", () => {
  test("starts closed and available", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    expect(cb.getState()).toBe("closed");
    expect(cb.isAvailable()).toBe(true);
  });

  test("opens after N failures", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 100_000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("closed");
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    expect(cb.isAvailable()).toBe(false);
  });

  test("transitions to half-open after cooldown", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 0 });
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    // cooldownMs = 0 → immediately transitions
    expect(cb.isAvailable()).toBe(true);
    expect(cb.getState()).toBe("half-open");
  });

  test("success resets to closed", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 0 });
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    cb.isAvailable(); // triggers half-open
    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");
  });

  test("failure in half-open reopens", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 0 });
    cb.recordFailure();
    cb.isAvailable(); // half-open
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Usage Tracker
// ═══════════════════════════════════════════════════════════════════

describe("UsageTracker", () => {
  let tracker: UsageTracker;

  beforeEach(() => {
    tracker = new UsageTracker(new MemoryStorage());
  });

  test("no limits → always passes", async () => {
    await tracker.ensureLoaded();
    expect(tracker.checkLimits("m1", undefined)).toBeNull();
    expect(tracker.checkLimits("m1", {})).toBeNull();
  });

  test("requestsPerMinute enforcement", async () => {
    await tracker.ensureLoaded();
    const limits = { requestsPerMinute: 2 };

    await tracker.recordRequest("m1");
    expect(tracker.checkLimits("m1", limits)).toBeNull();

    await tracker.recordRequest("m1");
    expect(tracker.checkLimits("m1", limits)).toBe("requestsPerMinute");
  });

  test("tokensPerDay enforcement", async () => {
    await tracker.ensureLoaded();
    const limits = { tokensPerDay: 200 };

    await tracker.recordUsage("m1", { inputTokens: 100, outputTokens: 50 });
    expect(tracker.checkLimits("m1", limits)).toBeNull();

    await tracker.recordUsage("m1", { inputTokens: 40, outputTokens: 20 });
    expect(tracker.checkLimits("m1", limits)).toBe("tokensPerDay");
  });

  test("flush persists data", async () => {
    const storage = new MemoryStorage();
    const t = new UsageTracker(storage);
    await t.ensureLoaded();
    await t.recordRequest("m1");
    await t.flush();
    const data = await storage.load();
    expect(data["m1"]?.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Router — createRouter
// ═══════════════════════════════════════════════════════════════════

describe("createRouter", () => {
  test("throws when primary.model is missing", () => {
    // @ts-expect-error intentionally passing invalid config
    expect(() => createRouter({ primary: {} })).toThrow("`primary.model` is required");
  });

  test("throws on duplicate model IDs", () => {
    const m = mockModel("p", "m");
    expect(() =>
      createRouter({
        primary: { model: m },
        fallbacks: [{ model: m }],
      }),
    ).toThrow("Duplicate model ID");
  });

  test("returns a valid LanguageModelV3", () => {
    const model = createRouter({ primary: { model: mockModel("openai", "gpt-4o") } });
    expect(model.specificationVersion).toBe("v3");
    expect(model.provider).toBe("zero-llm-router");
    expect(model.modelId).toBe("openai:gpt-4o");
    expect(typeof model.doGenerate).toBe("function");
    expect(typeof model.doStream).toBe("function");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Router — doGenerate Routing
// ═══════════════════════════════════════════════════════════════════

describe("Router doGenerate", () => {
  test("calls primary model on success", async () => {
    const primary = mockModel("p1", "m1");
    const router = createRouter({ primary: { model: primary } });

    const result = await router.doGenerate(dummyPrompt);
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });
    expect(primary.doGenerate).toHaveBeenCalledTimes(1);
  });

  test("falls back when primary fails", async () => {
    const primary = mockModel("p1", "m1", {
      doGenerate: vi.fn(async () => { throw new Error("primary down"); }),
    });
    const fallback = mockModel("p2", "m2");

    const events: Array<{ type: string }> = [];
    const router = createRouter({
      primary: { model: primary },
      fallbacks: [{ model: fallback }],
      retry: { maxRetries: 0 },
      onEvent: (e) => events.push(e),
    });

    const result = await router.doGenerate(dummyPrompt);
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });
    expect(primary.doGenerate).toHaveBeenCalled();
    expect(fallback.doGenerate).toHaveBeenCalled();
    expect(events.some((e) => e.type === "fallback")).toBe(true);
  });

  test("throws AggregateError when all models fail", async () => {
    const m1 = mockModel("p1", "m1", {
      doGenerate: vi.fn(async () => { throw new Error("fail1"); }),
    });
    const m2 = mockModel("p2", "m2", {
      doGenerate: vi.fn(async () => { throw new Error("fail2"); }),
    });

    const router = createRouter({
      primary: { model: m1 },
      fallbacks: [{ model: m2 }],
      retry: { maxRetries: 0 },
    });

    await expect(router.doGenerate(dummyPrompt)).rejects.toThrow("All models exhausted");
  });

  test("skips rate-limited models", async () => {
    const primary = mockModel("p1", "m1");
    const fallback = mockModel("p2", "m2");

    const events: Array<{ type: string }> = [];
    const router = createRouter({
      primary: {
        model: primary,
        limits: { requestsPerMinute: 0 }, // immediately limited
      },
      fallbacks: [{ model: fallback }],
      onEvent: (e) => events.push(e),
    });

    const result = await router.doGenerate(dummyPrompt);
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });
    expect(primary.doGenerate).not.toHaveBeenCalled();
    expect(fallback.doGenerate).toHaveBeenCalled();
    expect(events.some((e) => e.type === "rate-limited")).toBe(true);
  });

  test("retries on failure before falling back", async () => {
    let attempts = 0;
    const primary = mockModel("p1", "m1", {
      doGenerate: vi.fn(async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
        return makeResult("recovered");
      }),
    });

    const router = createRouter({
      primary: { model: primary },
      retry: { maxRetries: 3, initialDelay: 1, backoffMultiplier: 1, jitter: false },
    });

    const result = await router.doGenerate(dummyPrompt);
    expect(result.content[0]).toEqual({ type: "text", text: "recovered" });
    expect(attempts).toBe(3);
  });

  test("applies model settings overrides", async () => {
    const primary = mockModel("p1", "m1", {
      doGenerate: vi.fn(async (_opts: LanguageModelV3CallOptions) => makeResult()),
    });

    const router = createRouter({
      primary: {
        model: primary,
        settings: { temperature: 0.5, maxOutputTokens: 100 },
      },
    });

    await router.doGenerate(dummyPrompt);

    const callArgs = (primary.doGenerate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LanguageModelV3CallOptions;
    expect(callArgs.temperature).toBe(0.5);
    expect(callArgs.maxOutputTokens).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Router — doStream Routing
// ═══════════════════════════════════════════════════════════════════

describe("Router doStream", () => {
  test("streams from primary model", async () => {
    const primary = mockModel("p1", "m1");
    const router = createRouter({ primary: { model: primary } });

    const result = await router.doStream(dummyPrompt);
    const reader = result.stream.getReader();

    const chunks: string[] = [];
    let done = false;
    while (!done) {
      const r = await reader.read();
      if (r.done) { done = true; break; }
      chunks.push(r.value.type);
    }

    expect(chunks).toContain("text-delta");
    expect(chunks).toContain("finish");
  });

  test("falls back to next model on stream setup failure", async () => {
    const primary = mockModel("p1", "m1", {
      doStream: vi.fn(async () => { throw new Error("stream setup fail"); }),
    });
    const fallback = mockModel("p2", "m2");

    const router = createRouter({
      primary: { model: primary },
      fallbacks: [{ model: fallback }],
      retry: { maxRetries: 0 },
    });

    const result = await router.doStream(dummyPrompt);
    const reader = result.stream.getReader();

    const chunks: string[] = [];
    let done = false;
    while (!done) {
      const r = await reader.read();
      if (r.done) { done = true; break; }
      chunks.push(r.value.type);
    }

    expect(chunks).toContain("text-delta");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Router — Event System
// ═══════════════════════════════════════════════════════════════════

describe("Router events", () => {
  test("emits attempt, success events on happy path", async () => {
    const events: Array<{ type: string }> = [];
    const router = createRouter({
      primary: { model: mockModel("p", "m") },
      onEvent: (e) => events.push(e),
    });

    await router.doGenerate(dummyPrompt);

    const types = events.map((e) => e.type);
    expect(types).toContain("attempt");
    expect(types).toContain("success");
  });

  test("emits error and fallback events", async () => {
    const events: Array<{ type: string }> = [];
    const primary = mockModel("p1", "m1", {
      doGenerate: vi.fn(async () => { throw new Error("fail"); }),
    });
    const fallback = mockModel("p2", "m2");

    const router = createRouter({
      primary: { model: primary },
      fallbacks: [{ model: fallback }],
      retry: { maxRetries: 0 },
      onEvent: (e) => events.push(e),
    });

    await router.doGenerate(dummyPrompt);

    const types = events.map((e) => e.type);
    expect(types).toContain("error");
    expect(types).toContain("fallback");
    expect(types).toContain("success");
  });
});
