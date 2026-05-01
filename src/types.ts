import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { StorageAdapter } from "./storage/types.ts";

// ─── User-Facing Config ─────────────────────────────────────────────

/** Top-level configuration for `createRouter()`. */
export interface RouterConfig {
  /** Primary model configuration — tried first on every request. */
  primary: ModelConfig;
  /** Ordered list of fallback models tried when the primary is unavailable. */
  fallbacks?: ModelConfig[];
  /** Global retry settings applied to each provider attempt. */
  retry?: RetryConfig;
  /** Circuit-breaker settings (shared defaults for all providers). */
  circuitBreaker?: CircuitBreakerConfig;
  /** Storage adapter for persisting usage data (defaults to in-memory). */
  storage?: StorageAdapter;
  /** Callback invoked on every routing event (logging / observability). */
  onEvent?: (event: RouterEvent) => void;
}

/** Configuration for a single model / provider endpoint. */
export interface ModelConfig {
  /** A `LanguageModelV3` instance from any AI SDK provider. */
  model: LanguageModelV3;
  /** Rate limits enforced for this model / provider / key. */
  limits?: RateLimits;
  /** Per-model settings overrides applied to every call through this model. */
  settings?: ModelSettings;
  /**
   * Unique tracking ID.
   * Auto-derived from `provider:modelId` if omitted.
   */
  id?: string;
}

// ─── Rate Limits ─────────────────────────────────────────────────────

export interface RateLimits {
  /** Max requests per second. */
  requestsPerSecond?: number;
  /** Max requests per minute. */
  requestsPerMinute?: number;
  /** Max requests per day. */
  requestsPerDay?: number;
  /** Max total (input + output) tokens per day. */
  tokensPerDay?: number;
  /** Max total tokens per rolling 7-day window. */
  tokensPerWeek?: number;
  /** Max total tokens per rolling 30-day window. */
  tokensPerMonth?: number;
}

// ─── Model Settings ──────────────────────────────────────────────────

export interface ModelSettings {
  /** Override temperature for this model. */
  temperature?: number;
  /** Override max output tokens for this model. */
  maxOutputTokens?: number;
  /** Timeout in ms — if the provider doesn't respond within this time, fail. */
  timeout?: number;
  /** Extra provider-specific options merged into `providerOptions`. */
  providerOptions?: LanguageModelV3CallOptions["providerOptions"];
}

// ─── Retry ───────────────────────────────────────────────────────────

export interface RetryConfig {
  /** Max retry attempts per provider (default: `1`). */
  maxRetries?: number;
  /** Initial backoff delay in ms (default: `500`). */
  initialDelay?: number;
  /** Backoff multiplier (default: `2`). */
  backoffMultiplier?: number;
  /** Add jitter to prevent thundering herd (default: `true`). */
  jitter?: boolean;
}

// ─── Circuit Breaker ─────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit (default: `5`). */
  failureThreshold?: number;
  /** Time in ms to keep circuit open before allowing a probe (default: `60_000`). */
  cooldownMs?: number;
}

// ─── Events ──────────────────────────────────────────────────────────

export type RouterEvent =
  | { type: "attempt"; modelId: string; provider: string }
  | { type: "success"; modelId: string; provider: string; durationMs: number; usage: TokenUsage }
  | { type: "error"; modelId: string; provider: string; error: unknown }
  | { type: "fallback"; from: string; to: string; reason: string }
  | { type: "rate-limited"; modelId: string; provider: string; limit: string }
  | { type: "circuit-open"; modelId: string; provider: string };

// ─── Token Usage ─────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// ─── Internal: Usage Data (persisted via StorageAdapter) ─────────────

/** A single usage record: either a request timestamp or a token count. */
export interface UsageRecord {
  /** Unix timestamp (ms) when this event happened. */
  timestamp: number;
  /** Number of tokens consumed (input + output). 0 for request-only records. */
  tokens: number;
}

/** Persisted usage data — a map from model-tracking-id → list of records. */
export interface UsageData {
  [modelId: string]: UsageRecord[];
}

// ─── Internal: Resolved Model (after config normalisation) ───────────

export interface ResolvedModel {
  /** Unique tracking ID. */
  id: string;
  /** The underlying AI SDK model. */
  model: LanguageModelV3;
  /** Rate limits (may be undefined if no limits configured). */
  limits?: RateLimits;
  /** Settings overrides. */
  settings?: ModelSettings;
}
