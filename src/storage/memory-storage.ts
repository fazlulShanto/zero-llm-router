import type { UsageData } from "../types.ts";
import type { StorageAdapter } from "./types.ts";

/**
 * In-memory storage adapter.
 *
 * Fast and simple — but usage data is lost when the process exits.
 * This is the default adapter used when no storage is configured.
 */
export class MemoryStorage implements StorageAdapter {
  private data: UsageData = {};

  async load(): Promise<UsageData> {
    return this.data;
  }

  async save(data: UsageData): Promise<void> {
    this.data = data;
  }
}
