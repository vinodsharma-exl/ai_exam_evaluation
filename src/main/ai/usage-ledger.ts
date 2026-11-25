/**
 * Daily request counters (usage.json), so daily caps survive restarts.
 * Each provider's "day" is counted in the time zone where its quota resets: Pacific time for
 * Gemini, local time otherwise. The provider's own "quota exhausted" answer always wins; we
 * remember it in quotaExhaustedUntil.
 */
import { EventEmitter } from 'node:events';
import type { UsageFile } from '../../shared/schemas/usage';
import type { ProviderId } from '../../shared/schemas/common';
import { SCHEMA_VERSIONS } from '../../shared/constants';
import { ROOT_FILES } from '../../shared/paths';
import type { FileStore } from '../store/file-store';
import { dateIn, msUntilMidnightIn } from './backoff';

const PROVIDER_TZ: Partial<Record<ProviderId, string>> = { gemini: 'America/Los_Angeles' };
const KEEP_DAYS = 31;

export function quotaDay(providerId: ProviderId, now = Date.now()): string {
  return dateIn(PROVIDER_TZ[providerId], now);
}

/** When a daily quota is assumed to reset if the provider gives no Retry-After. */
export function quotaResetAt(providerId: ProviderId, now = Date.now()): number {
  const tz = PROVIDER_TZ[providerId];
  if (tz) return now + msUntilMidnightIn(tz, now);
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export class UsageLedger extends EventEmitter {
  constructor(
    private readonly store: FileStore,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  private empty(): UsageFile {
    return { schemaVersion: SCHEMA_VERSIONS.usage, byModel: {}, quotaExhaustedUntil: {}, updatedAt: new Date(this.now()).toISOString() };
  }

  async read(): Promise<UsageFile> {
    try {
      return (await this.store.read('usage', ROOT_FILES.usage)) ?? this.empty();
    } catch {
      return this.empty();
    }
  }

  private async mutate(fn: (u: UsageFile) => void): Promise<UsageFile> {
    const out = await this.store.update('usage', ROOT_FILES.usage, (cur) => {
      const u = structuredClone(cur ?? this.empty());
      fn(u);
      // Drop old days.
      const cutoff = new Date(this.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
      for (const days of Object.values(u.byModel)) for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
      u.updatedAt = new Date(this.now()).toISOString();
      return u;
    });
    return out!;
  }

  async usedToday(key: string, providerId: ProviderId): Promise<number> {
    const u = await this.read();
    return u.byModel[key]?.[quotaDay(providerId, this.now())]?.requests ?? 0;
  }

  /** Epoch ms until which the provider said the quota is gone, or null. */
  async exhaustedUntil(key: string): Promise<number | null> {
    const u = await this.read();
    const iso = u.quotaExhaustedUntil[key];
    if (!iso) return null;
    const t = Date.parse(iso);
    return t > this.now() ? t : null;
  }

  async recordRequest(key: string, providerId: ProviderId): Promise<number> {
    const day = quotaDay(providerId, this.now());
    let used = 0;
    await this.mutate((u) => {
      const days = (u.byModel[key] ??= {});
      const d = (days[day] ??= { requests: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, errors429: 0 });
      d.requests++;
      used = d.requests;
    });
    this.emit('changed', key);
    return used;
  }

  async recordResult(
    key: string,
    providerId: ProviderId,
    r: { cacheHit?: boolean; inputTokens?: number; outputTokens?: number; got429?: boolean },
  ): Promise<void> {
    const day = quotaDay(providerId, this.now());
    await this.mutate((u) => {
      const days = (u.byModel[key] ??= {});
      const d = (days[day] ??= { requests: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, errors429: 0 });
      if (r.cacheHit) d.cacheHits++;
      d.inputTokens += r.inputTokens ?? 0;
      d.outputTokens += r.outputTokens ?? 0;
      if (r.got429) d.errors429++;
    });
    if (r.cacheHit) this.emit('changed', key);
  }

  async markExhausted(key: string, untilMs: number): Promise<void> {
    await this.mutate((u) => {
      u.quotaExhaustedUntil[key] = new Date(untilMs).toISOString();
    });
    this.emit('changed', key);
  }

  async clearExhausted(key: string): Promise<void> {
    await this.mutate((u) => {
      delete u.quotaExhaustedUntil[key];
    });
  }
}
