/**
 * Delay execution for `ms` milliseconds.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute backoff delay with optional jitter.
 *
 * @param attempt   – Zero-based attempt index (0 = first retry).
 * @param base      – Initial delay in ms.
 * @param multiplier – Exponential multiplier.
 * @param jitter    – Whether to add ±25 % random jitter.
 */
export function backoff(
  attempt: number,
  base: number,
  multiplier: number,
  jitter: boolean,
): number {
  let ms = base * multiplier ** attempt;
  if (jitter) {
    const range = ms * 0.25;
    ms += Math.random() * range * 2 - range; // ±25 %
  }
  return Math.max(0, Math.round(ms));
}

/**
 * Derive a stable tracking ID from a model config.
 */
export function deriveModelId(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

/**
 * Create an `AbortSignal` that fires after `ms` milliseconds.
 */
export function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * Merge two `AbortSignal` instances — the combined signal aborts
 * when *either* of the originals fires.
 */
export function mergeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  return AbortSignal.any([a, b]);
}
