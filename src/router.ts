import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { RouterConfig, ResolvedModel } from "./types.ts";
import { RouterLanguageModel } from "./router-model.ts";
import { UsageTracker } from "./usage-tracker.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { deriveModelId } from "./utils.ts";

/**
 * Create a routed `LanguageModelV3` that transparently balances
 * requests across multiple providers with rate-limit awareness,
 * circuit-breaking, and automatic retries.
 *
 * @example
 * ```ts
 * import { createRouter } from 'zero-llm-router';
 * import { google } from '@ai-sdk/google';
 * import { openai } from '@ai-sdk/openai';
 * import { generateText } from 'ai';
 *
 * const model = createRouter({
 *   primary: {
 *     model: google('gemini-2.0-flash'),
 *     limits: { requestsPerMinute: 15, tokensPerDay: 1_000_000 },
 *   },
 *   fallbacks: [
 *     { model: openai('gpt-4o-mini'), limits: { tokensPerDay: 200_000 } },
 *   ],
 * });
 *
 * const { text } = await generateText({ model, prompt: 'Hello!' });
 * ```
 */
export function createRouter(config: RouterConfig): LanguageModelV3 {
  // ── Validate ──────────────────────────────────────────────────
  if (!config.primary?.model) {
    throw new Error("[zero-llm-router] `primary.model` is required.");
  }

  // ── Build the ordered chain ───────────────────────────────────
  const chain: ResolvedModel[] = [
    resolveModel(config.primary),
    ...(config.fallbacks ?? []).map(resolveModel),
  ];

  // Check for duplicate IDs.
  const ids = new Set<string>();
  for (const entry of chain) {
    if (ids.has(entry.id)) {
      throw new Error(
        `[zero-llm-router] Duplicate model ID "${entry.id}". ` +
          `Provide an explicit \`id\` in ModelConfig to disambiguate.`,
      );
    }
    ids.add(entry.id);
  }

  // ── Initialise subsystems ─────────────────────────────────────
  const tracker = new UsageTracker(config.storage);

  const breakers = new Map<string, CircuitBreaker>();
  for (const entry of chain) {
    breakers.set(entry.id, new CircuitBreaker(config.circuitBreaker));
  }

  // ── Return the proxy model ────────────────────────────────────
  return new RouterLanguageModel({
    chain,
    retry: config.retry,
    tracker,
    breakers,
    onEvent: config.onEvent,
  });
}

// ─── Internal ────────────────────────────────────────────────────────

function resolveModel(cfg: RouterConfig["primary"]): ResolvedModel {
  const model = cfg.model;
  return {
    id: cfg.id ?? deriveModelId(model.provider, model.modelId),
    model,
    limits: cfg.limits,
    settings: cfg.settings,
  };
}
