/**
 * config.json: loads with defaults filled in, validates updates, notifies listeners.
 * It never holds API keys (see secret-store.ts).
 */
import { EventEmitter } from 'node:events';
import { ConfigFile, type ModelCapabilities, type ConnectionTestResult } from '../../shared/schemas/config';
import type { ModelRef, Stage } from '../../shared/schemas/common';
import { ROOT_FILES } from '../../shared/paths';
import { defaultConfig, resolveCapabilities } from '../../shared/defaults';
import { AppError } from '../../shared/errors';
import type { FileStore } from './file-store';

/** Deep merge for plain objects. Arrays and primitives in the patch replace the old value. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  return out as T;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class ConfigService extends EventEmitter {
  private cache: ConfigFile | null = null;

  constructor(private readonly store: FileStore) {
    super();
  }

  async get(): Promise<ConfigFile> {
    if (this.cache) return this.cache;
    let cfg: ConfigFile | null = null;
    try {
      cfg = await this.store.read('config', ROOT_FILES.config);
    } catch (err) {
      // A corrupt config is quarantined by the store. Start again from defaults rather than refusing to start.
      if (!(err instanceof AppError && err.code === 'FILE_CORRUPT')) throw err;
    }
    if (!cfg) cfg = await this.store.write('config', ROOT_FILES.config, defaultConfig());
    this.cache = cfg;
    return cfg;
  }

  /** Clears the in-memory copy, e.g. after the data dir changes or a backup is restored. */
  invalidate(): void {
    this.cache = null;
  }

  async update(patch: unknown): Promise<ConfigFile> {
    if (isPlainObject(patch) && 'schemaVersion' in patch) delete (patch as Record<string, unknown>).schemaVersion;
    const next = await this.store.update('config', ROOT_FILES.config, (cur) => {
      const merged = deepMerge(cur ?? defaultConfig(), patch);
      const parsed = ConfigFile.safeParse(merged);
      if (!parsed.success) {
        throw new AppError('VALIDATION', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      }
      return parsed.data;
    });
    this.cache = next!;
    this.emit('changed', next);
    return next!;
  }

  async setStageModel(stage: Stage, ref: ModelRef): Promise<ConfigFile> {
    return this.update({ stages: { [stage]: ref } });
  }

  async capabilities(ref: ModelRef): Promise<ModelCapabilities> {
    return resolveCapabilities(await this.get(), ref);
  }

  /** Saves edited capability values for one model. Marks them userEdited, so catalog defaults no longer apply. */
  async updateModelCapabilities(ref: ModelRef, caps: Partial<ModelCapabilities>): Promise<ModelCapabilities> {
    const cfg = await this.get();
    const base = resolveCapabilities(cfg, ref);
    const existing = cfg.providers[ref.providerId]?.models[ref.model];
    const merged = { ...base, ...caps };
    await this.update({
      providers: {
        [ref.providerId]: {
          models: { [ref.model]: { capabilities: merged, userEdited: true, ...(existing?.lastTest ? { lastTest: existing.lastTest } : {}) } },
        },
      },
    });
    return merged;
  }

  async recordConnectionTest(ref: ModelRef, result: ConnectionTestResult, detectedVision: boolean | null): Promise<void> {
    const cfg = await this.get();
    const caps = resolveCapabilities(cfg, ref);
    const existing = cfg.providers[ref.providerId]?.models[ref.model];
    // If the test showed vision works or fails, keep the flag in line with what we saw.
    const fixedCaps =
      detectedVision === null
        ? caps
        : {
            ...caps,
            supportsVision: detectedVision,
            maxImagesPerRequest: detectedVision ? Math.max(1, caps.maxImagesPerRequest) : 0,
          };
    await this.update({
      providers: {
        [ref.providerId]: {
          models: {
            [ref.model]: {
              capabilities: fixedCaps,
              userEdited: existing?.userEdited ?? false,
              lastTest: result,
            },
          },
        },
      },
    });
  }
}
