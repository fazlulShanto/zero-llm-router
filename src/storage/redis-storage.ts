import type { UsageData } from "../types.ts";
import type { StorageAdapter } from "./types.ts";

/**
 * Minimal Redis client interface.
 *
 * Users provide their own Redis client instance (e.g. from `ioredis` or `redis`).
 * We only require the two methods we actually use so there's no hard dependency.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

/**
 * Redis-backed storage adapter.
 *
 * Stores the full `UsageData` JSON blob under a single Redis key.
 * For production use you may want something more granular, but this keeps
 * the interface simple and consistent with the other adapters.
 */
export class RedisStorage implements StorageAdapter {
  private readonly client: RedisLike;
  private readonly key: string;

  constructor(client: RedisLike, key = "zero-llm-router:usage") {
    this.client = client;
    this.key = key;
  }

  async load(): Promise<UsageData> {
    const raw = await this.client.get(this.key);
    if (raw === null) return {};
    return JSON.parse(raw) as UsageData;
  }

  async save(data: UsageData): Promise<void> {
    await this.client.set(this.key, JSON.stringify(data));
  }
}
