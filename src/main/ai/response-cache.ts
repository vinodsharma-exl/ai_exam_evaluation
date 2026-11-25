/**
 * On-disk cache of VALIDATED AI outputs: cache/<ab>/<sha256>.json.
 * Key = sha256(provider ‖ model ‖ PROMPT_VERSION ‖ system ‖ user ‖ image hashes). The same page with
 * the same prompt and model never costs a second request.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { ModelRef } from '../../shared/schemas/common';
import type { CacheEntry } from '../../shared/schemas/cache';
import { PROMPT_VERSION, SCHEMA_VERSIONS } from '../../shared/constants';
import { cacheEntryPath } from '../../shared/paths';
import type { FileStore } from '../store/file-store';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function cacheKey(ref: ModelRef, system: string, user: string, imageHashes: string[]): string {
  const h = createHash('sha256');
  for (const part of [ref.providerId, ref.model, PROMPT_VERSION, system, user, imageHashes.join(',')]) {
    h.update(part);
    h.update('\u0000'); // separator, so "ab"+"c" ≠ "a"+"bc"
  }
  return h.digest('hex');
}

export class ResponseCache {
  constructor(private readonly store: FileStore) {}

  /** Returns the cached output if present AND still valid for the schema; otherwise null. */
  async get<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      const entry = await this.store.read('cacheEntry', cacheEntryPath(key));
      if (!entry) return null;
      const parsed = schema.safeParse(entry.output);
      return parsed.success ? parsed.data : null;
    } catch {
      return null; // a broken cache entry is just a miss
    }
  }

  async put(key: string, ref: ModelRef, promptKind: CacheEntry['promptKind'], output: unknown, usage: CacheEntry['usage'] = {}): Promise<void> {
    const entry: CacheEntry = {
      schemaVersion: SCHEMA_VERSIONS.cacheEntry,
      key,
      by: ref,
      promptKind,
      output,
      usage,
      createdAt: new Date().toISOString(),
    };
    await this.store.write('cacheEntry', cacheEntryPath(key), entry);
  }
}
