import type { RateLimits, UsageData, UsageRecord, TokenUsage } from "./types.ts";
import type { StorageAdapter } from "./storage/types.ts";
import { MemoryStorage } from "./storage/memory-storage.ts";

// ─── Time windows in milliseconds ────────────────────────────────────

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

// ─── Limit check descriptor ─────────────────────────────────────────

interface LimitCheck {
  /** Human-readable name of the limit (used in events). */
  name: string;
  /** Size of the sliding window in ms. */
  windowMs: number;
  /** Maximum allowed value within the window. */
  max: number;
  /** What to count: number of records (`"requests"`) or sum of `tokens` (`"tokens"`). */
  mode: "requests" | "tokens";
}

/**
 * Sliding-window usage tracker.
 *
 * Maintains per-model usage records and checks them against configured
 * rate limits before each request.
 */
export class UsageTracker {
  private storage: StorageAdapter;
  private data: UsageData = {};
  private loaded = false;

  /** Optional debounce timer for batching saves. */
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly saveDebounceMs = 500;

  constructor(storage?: StorageAdapter) {
    this.storage = storage ?? new MemoryStorage();
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Ensure usage data has been loaded from storage at least once.
   */
  async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.data = await this.storage.load();
      this.loaded = true;
    }
  }

  /**
   * Check whether `modelId` would violate any of its configured `limits`
   * if a new request were made right now.
   *
   * @returns The name of the first violated limit, or `null` if OK.
   */
  checkLimits(modelId: string, limits: RateLimits | undefined): string | null {
    if (!limits) return null;

    const checks = buildChecks(limits);
    const records = this.data[modelId] ?? [];
    const now = Date.now();

    for (const check of checks) {
      const cutoff = now - check.windowMs;
      let total = 0;

      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i]!;
        if (r.timestamp < cutoff) break; // records are sorted by time
        total += check.mode === "tokens" ? r.tokens : 1;
      }

      if (total >= check.max) {
        return check.name;
      }
    }

    return null;
  }

  /**
   * Record a completed request's usage.
   */
  async recordUsage(modelId: string, usage: TokenUsage): Promise<void> {
    const records = (this.data[modelId] ??= []);
    records.push({
      timestamp: Date.now(),
      tokens: usage.inputTokens + usage.outputTokens,
    });

    // Prune records older than 30 days to keep data bounded.
    this.prune(modelId);
    this.scheduleSave();
  }

  /**
   * Record a request attempt (even if it hasn't completed yet).
   * Useful for per-second / per-minute request rate limits.
   */
  async recordRequest(modelId: string): Promise<void> {
    const records = (this.data[modelId] ??= []);
    records.push({ timestamp: Date.now(), tokens: 0 });
    this.scheduleSave();
  }

  /**
   * Immediately persist any pending data.
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.storage.save(this.data);
  }

  // ── Internals ───────────────────────────────────────────────────

  private prune(modelId: string): void {
    const records = this.data[modelId];
    if (!records) return;
    const cutoff = Date.now() - MONTH;
    const firstValid = records.findIndex((r) => r.timestamp >= cutoff);
    if (firstValid > 0) {
      records.splice(0, firstValid);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.storage.save(this.data);
    }, this.saveDebounceMs);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function buildChecks(limits: RateLimits): LimitCheck[] {
  const checks: LimitCheck[] = [];

  if (limits.requestsPerSecond != null) {
    checks.push({ name: "requestsPerSecond", windowMs: SECOND, max: limits.requestsPerSecond, mode: "requests" });
  }
  if (limits.requestsPerMinute != null) {
    checks.push({ name: "requestsPerMinute", windowMs: MINUTE, max: limits.requestsPerMinute, mode: "requests" });
  }
  if (limits.requestsPerDay != null) {
    checks.push({ name: "requestsPerDay", windowMs: DAY, max: limits.requestsPerDay, mode: "requests" });
  }
  if (limits.tokensPerDay != null) {
    checks.push({ name: "tokensPerDay", windowMs: DAY, max: limits.tokensPerDay, mode: "tokens" });
  }
  if (limits.tokensPerWeek != null) {
    checks.push({ name: "tokensPerWeek", windowMs: WEEK, max: limits.tokensPerWeek, mode: "tokens" });
  }
  if (limits.tokensPerMonth != null) {
    checks.push({ name: "tokensPerMonth", windowMs: MONTH, max: limits.tokensPerMonth, mode: "tokens" });
  }

  return checks;
}
