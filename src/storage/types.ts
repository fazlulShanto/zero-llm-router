import type { UsageData } from "../types.ts";

/**
 * Pluggable persistence backend for usage data.
 *
 * Implementations must be able to load and save the entire
 * `UsageData` map atomically.
 */
export interface StorageAdapter {
  /** Load persisted usage data (return empty object `{}` on first run). */
  load(): Promise<UsageData>;
  /** Persist usage data. */
  save(data: UsageData): Promise<void>;
}
