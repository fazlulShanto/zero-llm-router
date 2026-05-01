import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { UsageData } from "../types.ts";
import type { StorageAdapter } from "./types.ts";

/**
 * File-based storage adapter.
 *
 * Persists usage data as a JSON file on the local filesystem.
 * Automatically creates parent directories if they don't exist.
 */
export class FileStorage implements StorageAdapter {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<UsageData> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as UsageData;
    } catch {
      // File doesn't exist yet or is invalid — return empty data.
      return {};
    }
  }

  async save(data: UsageData): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}
