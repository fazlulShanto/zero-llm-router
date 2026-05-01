import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import type { ResolvedModel, RetryConfig, RouterEvent, TokenUsage } from "./types.ts";
import type { UsageTracker } from "./usage-tracker.ts";
import type { CircuitBreaker } from "./circuit-breaker.ts";
import { backoff, delay, mergeSignals, timeoutSignal } from "./utils.ts";

// ─── Defaults ────────────────────────────────────────────────────────

const DEFAULT_RETRY: Required<RetryConfig> = {
  maxRetries: 1,
  initialDelay: 500,
  backoffMultiplier: 2,
  jitter: true,
};

// ─── Router Model ────────────────────────────────────────────────────

/**
 * A `LanguageModelV3` implementation that routes requests through
 * a priority-ordered chain of models with rate-limit checking,
 * circuit-breaking, and automatic retries.
 */
export class RouterLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider: string;
  readonly modelId: string;

  /**
   * Merge `supportedUrls` from all configured models.
   *
   * A URL is considered supported if *any* model in the chain supports it.
   */
  readonly supportedUrls: Record<string, RegExp[]>;

  private readonly chain: ResolvedModel[];
  private readonly retryConfig: Required<RetryConfig>;
  private readonly tracker: UsageTracker;
  private readonly breakers: Map<string, CircuitBreaker>;
  private readonly emit: ((event: RouterEvent) => void) | undefined;

  constructor(opts: {
    chain: ResolvedModel[];
    retry?: RetryConfig;
    tracker: UsageTracker;
    breakers: Map<string, CircuitBreaker>;
    onEvent?: (event: RouterEvent) => void;
  }) {
    this.chain = opts.chain;
    this.retryConfig = { ...DEFAULT_RETRY, ...opts.retry };
    this.tracker = opts.tracker;
    this.breakers = opts.breakers;
    this.emit = opts.onEvent;

    // Derive a composite provider / modelId for display purposes.
    const primary = opts.chain[0]!;
    this.provider = "zero-llm-router";
    this.modelId = primary.id;

    // Merge supportedUrls from all models.
    this.supportedUrls = mergeSupportedUrls(opts.chain.map((m) => m.model));
  }

  // ── LanguageModelV3 — doGenerate ────────────────────────────────

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    await this.tracker.ensureLoaded();

    const errors: Array<{ modelId: string; error: unknown }> = [];

    for (let i = 0; i < this.chain.length; i++) {
      const entry = this.chain[i]!;
      const breaker = this.breakers.get(entry.id)!;

      // 1. Circuit breaker check.
      if (!breaker.isAvailable()) {
        this.emit?.({ type: "circuit-open", modelId: entry.model.modelId, provider: entry.model.provider });
        continue;
      }

      // 2. Rate limit check.
      const limitViolation = this.tracker.checkLimits(entry.id, entry.limits);
      if (limitViolation) {
        this.emit?.({ type: "rate-limited", modelId: entry.model.modelId, provider: entry.model.provider, limit: limitViolation });
        if (i + 1 < this.chain.length) {
          this.emit?.({ type: "fallback", from: entry.id, to: this.chain[i + 1]!.id, reason: `rate-limited:${limitViolation}` });
        }
        continue;
      }

      // 3. Attempt with retries.
      const result = await this.attemptGenerate(entry, options, errors);
      if (result) return result;

      // Move to next fallback.
      if (i + 1 < this.chain.length) {
        this.emit?.({ type: "fallback", from: entry.id, to: this.chain[i + 1]!.id, reason: "error" });
      }
    }

    throw new AggregateError(
      errors.map((e) => e.error),
      `All models exhausted. Tried: ${errors.map((e) => e.modelId).join(", ")}`,
    );
  }

  // ── LanguageModelV3 — doStream ──────────────────────────────────

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    await this.tracker.ensureLoaded();

    const errors: Array<{ modelId: string; error: unknown }> = [];

    for (let i = 0; i < this.chain.length; i++) {
      const entry = this.chain[i]!;
      const breaker = this.breakers.get(entry.id)!;

      if (!breaker.isAvailable()) {
        this.emit?.({ type: "circuit-open", modelId: entry.model.modelId, provider: entry.model.provider });
        continue;
      }

      const limitViolation = this.tracker.checkLimits(entry.id, entry.limits);
      if (limitViolation) {
        this.emit?.({ type: "rate-limited", modelId: entry.model.modelId, provider: entry.model.provider, limit: limitViolation });
        if (i + 1 < this.chain.length) {
          this.emit?.({ type: "fallback", from: entry.id, to: this.chain[i + 1]!.id, reason: `rate-limited:${limitViolation}` });
        }
        continue;
      }

      const result = await this.attemptStream(entry, options, errors);
      if (result) return result;

      if (i + 1 < this.chain.length) {
        this.emit?.({ type: "fallback", from: entry.id, to: this.chain[i + 1]!.id, reason: "error" });
      }
    }

    throw new AggregateError(
      errors.map((e) => e.error),
      `All models exhausted. Tried: ${errors.map((e) => e.modelId).join(", ")}`,
    );
  }

  // ── Attempt helpers ─────────────────────────────────────────────

  private async attemptGenerate(
    entry: ResolvedModel,
    options: LanguageModelV3CallOptions,
    errors: Array<{ modelId: string; error: unknown }>,
  ): Promise<LanguageModelV3GenerateResult | null> {
    const { maxRetries, initialDelay, backoffMultiplier, jitter } = this.retryConfig;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await delay(backoff(attempt - 1, initialDelay, backoffMultiplier, jitter));
      }

      const breaker = this.breakers.get(entry.id)!;
      this.emit?.({ type: "attempt", modelId: entry.model.modelId, provider: entry.model.provider });

      const callOptions = applySettings(options, entry);
      const start = Date.now();

      try {
        await this.tracker.recordRequest(entry.id);
        const result = await entry.model.doGenerate(callOptions);

        const usage = extractUsage(result);
        await this.tracker.recordUsage(entry.id, usage);
        breaker.recordSuccess();

        this.emit?.({
          type: "success",
          modelId: entry.model.modelId,
          provider: entry.model.provider,
          durationMs: Date.now() - start,
          usage,
        });

        return result;
      } catch (err) {
        breaker.recordFailure();
        this.emit?.({ type: "error", modelId: entry.model.modelId, provider: entry.model.provider, error: err });
        errors.push({ modelId: entry.id, error: err });

        // If the breaker just opened, stop retrying this provider.
        if (!breaker.isAvailable()) break;
      }
    }

    return null;
  }

  private async attemptStream(
    entry: ResolvedModel,
    options: LanguageModelV3CallOptions,
    errors: Array<{ modelId: string; error: unknown }>,
  ): Promise<LanguageModelV3StreamResult | null> {
    const { maxRetries, initialDelay, backoffMultiplier, jitter } = this.retryConfig;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await delay(backoff(attempt - 1, initialDelay, backoffMultiplier, jitter));
      }

      const breaker = this.breakers.get(entry.id)!;
      this.emit?.({ type: "attempt", modelId: entry.model.modelId, provider: entry.model.provider });

      const callOptions = applySettings(options, entry);
      const start = Date.now();

      try {
        await this.tracker.recordRequest(entry.id);
        const result = await entry.model.doStream(callOptions);

        // Wrap the stream to capture usage from the `finish` part and
        // record it once the stream completes.
        const wrappedStream = this.wrapStreamForUsage(result.stream, entry, start);

        breaker.recordSuccess();

        return {
          ...result,
          stream: wrappedStream,
        };
      } catch (err) {
        breaker.recordFailure();
        this.emit?.({ type: "error", modelId: entry.model.modelId, provider: entry.model.provider, error: err });
        errors.push({ modelId: entry.id, error: err });

        if (!breaker.isAvailable()) break;
      }
    }

    return null;
  }

  /**
   * Wrap a stream to intercept the `finish` part and record token usage.
   */
  private wrapStreamForUsage(
    stream: LanguageModelV3StreamResult["stream"],
    entry: ResolvedModel,
    startTime: number,
  ): LanguageModelV3StreamResult["stream"] {
    const tracker = this.tracker;
    const emit = this.emit;

    return stream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (chunk.type === "finish") {
            const rawUsage = chunk.usage;
            const usage: TokenUsage = {
              inputTokens: rawUsage.inputTokens.total ?? 0,
              outputTokens: rawUsage.outputTokens.total ?? 0,
            };

            void tracker.recordUsage(entry.id, usage);
            emit?.({
              type: "success",
              modelId: entry.model.modelId,
              provider: entry.model.provider,
              durationMs: Date.now() - startTime,
              usage,
            });
          }
          controller.enqueue(chunk);
        },
      }),
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Merge `supportedUrls` across all models.
 * For each media-type key, concatenate the RegExp arrays.
 */
function mergeSupportedUrls(models: LanguageModelV3[]): Record<string, RegExp[]> {
  const merged: Record<string, RegExp[]> = {};

  for (const model of models) {
    const urls = model.supportedUrls;

    // supportedUrls can be a PromiseLike — in the merged result we only
    // include synchronous values for simplicity. Async values would need
    // to be resolved lazily which complicates the interface significantly.
    if (typeof (urls as PromiseLike<unknown>).then === "function") continue;

    const syncUrls = urls as Record<string, RegExp[]>;
    for (const [mediaType, patterns] of Object.entries(syncUrls)) {
      (merged[mediaType] ??= []).push(...patterns);
    }
  }

  return merged;
}

/**
 * Apply model-specific settings overrides to call options.
 */
function applySettings(
  options: LanguageModelV3CallOptions,
  entry: ResolvedModel,
): LanguageModelV3CallOptions {
  const s = entry.settings;
  if (!s) return options;

  const merged: LanguageModelV3CallOptions = { ...options };

  if (s.temperature != null) merged.temperature = s.temperature;
  if (s.maxOutputTokens != null) merged.maxOutputTokens = s.maxOutputTokens;
  if (s.providerOptions) {
    merged.providerOptions = { ...options.providerOptions, ...s.providerOptions };
  }

  // Merge timeout into the abort signal.
  if (s.timeout != null) {
    merged.abortSignal = mergeSignals(options.abortSignal, timeoutSignal(s.timeout));
  }

  return merged;
}

/**
 * Extract token usage from a doGenerate result.
 */
function extractUsage(result: LanguageModelV3GenerateResult): TokenUsage {
  return {
    inputTokens: result.usage.inputTokens.total ?? 0,
    outputTokens: result.usage.outputTokens.total ?? 0,
  };
}
