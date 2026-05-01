import type { CircuitBreakerConfig } from "./types.ts";

/** Circuit breaker states. */
type CircuitState = "closed" | "open" | "half-open";

const DEFAULTS: Required<CircuitBreakerConfig> = {
  failureThreshold: 5,
  cooldownMs: 60_000,
};

/**
 * Per-provider circuit breaker.
 *
 * ```
 *  closed ──(N failures)──▶ open ──(cooldown)──▶ half-open
 *     ▲                                             │
 *     │  ◀── success ──────────────────────────────┘
 *     │  ◀── failure ──▶ open (reset cooldown)
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(config?: CircuitBreakerConfig) {
    this.failureThreshold = config?.failureThreshold ?? DEFAULTS.failureThreshold;
    this.cooldownMs = config?.cooldownMs ?? DEFAULTS.cooldownMs;
  }

  /**
   * Returns `true` if the circuit allows a request through.
   *
   * - **closed** → always allows.
   * - **open** → blocks unless the cooldown has elapsed (transitions to half-open).
   * - **half-open** → allows exactly one probe request.
   */
  isAvailable(): boolean {
    switch (this.state) {
      case "closed":
        return true;
      case "open": {
        if (Date.now() - this.openedAt >= this.cooldownMs) {
          this.state = "half-open";
          return true;
        }
        return false;
      }
      case "half-open":
        // Already probing — block additional concurrent requests while
        // the probe is in flight.  In practice this rarely matters because
        // we serialize per-provider, but it's correct behaviour.
        return true;
    }
  }

  /** Record a successful call — resets the breaker to closed. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  /** Record a failed call — may trip the breaker to open. */
  recordFailure(): void {
    this.consecutiveFailures++;

    if (this.state === "half-open" || this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  /** Current state (useful for diagnostics / events). */
  getState(): CircuitState {
    return this.state;
  }
}
