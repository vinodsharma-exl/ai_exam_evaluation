/**
 * THE way the app talks to AI. Every call, including Test connection, goes through request():
 *
 *   capability check → response cache → API key → daily cap → rate limiter → adapter call
 *   → retry with backoff (429/5xx/network, honouring Retry-After) → JSON extract + zod validate
 *   → ONE repair request if invalid → cache the validated output → usage ledger
 *
 * It never logs prompts, page images, responses or keys.
 */
import { EventEmitter } from 'node:events';
import type { z } from 'zod';
import { AI_OUTPUT_SCHEMAS, type PromptKind } from '../../shared/schemas/ai-output';
import type { ModelRef } from '../../shared/schemas/common';
import type { ModelCapabilities } from '../../shared/schemas/config';
import { ProviderError, type CompletionRequest, type CompletionResponse, type ImageInput } from '../../shared/providers/types';
import { AppError, type ErrorCode } from '../../shared/errors';
import { BACKOFF } from '../../shared/constants';
import { limiterKey } from '../../shared/defaults';
import {
  PROBE_TEXT_SYSTEM,
  PROBE_TEXT_USER,
  PROBE_VISION_EXPECTED,
  PROBE_VISION_USER,
  buildRepairPrompt,
} from '../../shared/prompts/templates';
import type { ConfigService } from '../store/config-service';
import type { SecretStore } from '../store/secret-store';
import type { AdapterRegistry } from './providers/index';
import { RateLimiter, realClock, type Clock } from './rate-limiter';
import { UsageLedger, quotaResetAt } from './usage-ledger';
import { ResponseCache, cacheKey, sha256 } from './response-cache';
import { ARRAY_KEYS, extractJson, parseAndValidate } from './json-repair';
import { backoffDelay } from './backoff';
import { probePng } from './probe-image';

export type HashedImage = ImageInput & { sha256: string };

export interface AiRequest<K extends PromptKind> {
  kind: K;
  ref: ModelRef;
  prompt: { system: string; user: string; maxOutputTokens: number; temperature: number };
  images?: HashedImage[];
  bypassCache?: boolean;
  signal: AbortSignal;
  onWaiting?: (resumeAt: number | null) => void;
}

export interface AiResult<T> {
  output: T;
  cacheKey: string;
  cacheHit: boolean;
  /** HTTP requests actually sent (retries and the repair call included). */
  requestsUsed: number;
}

export interface UsageSnapshot {
  key: string;
  usedToday: number;
  dailyLimit: number | null;
  rpm: number;
}

const ERROR_FOR_KIND: Record<ProviderError['kind'], ErrorCode> = {
  auth: 'INVALID_API_KEY',
  rate_limit: 'RATE_LIMITED',
  quota_exhausted: 'QUOTA_EXHAUSTED',
  no_vision: 'MODEL_NO_VISION',
  model_not_found: 'MODEL_NOT_FOUND',
  context_too_long: 'CONTEXT_TOO_LONG',
  content_filtered: 'CONTENT_FILTERED',
  bad_request: 'UNKNOWN',
  server: 'PROVIDER_UNAVAILABLE',
  network: 'NETWORK_OFFLINE',
  timeout: 'TIMEOUT',
  cancelled: 'CANCELLED',
};

const MAX_NETWORK_ATTEMPTS = 3;

export interface AiClientDeps {
  config: ConfigService;
  secrets: SecretStore;
  adapters: AdapterRegistry;
  ledger: UsageLedger;
  cache: ResponseCache;
  limiter?: RateLimiter;
  clock?: Clock;
  random?: () => number;
  log?: (msg: string) => void;
}

export class AiClient extends EventEmitter {
  readonly limiter: RateLimiter;
  private readonly clock: Clock;
  private readonly log: (msg: string) => void;

  constructor(private readonly d: AiClientDeps) {
    super();
    this.clock = d.clock ?? realClock;
    this.limiter = d.limiter ?? new RateLimiter(this.clock);
    this.log = d.log ?? (() => undefined);
  }

  async usageSnapshot(ref: ModelRef): Promise<UsageSnapshot> {
    const caps = await this.d.config.capabilities(ref);
    const key = limiterKey(ref);
    return { key, usedToday: await this.d.ledger.usedToday(key, ref.providerId), dailyLimit: caps.dailyLimit, rpm: caps.requestsPerMinute };
  }

  private async emitUsage(ref: ModelRef): Promise<void> {
    try {
      this.emit('usage', await this.usageSnapshot(ref));
    } catch {
      /* UI hint only */
    }
  }

  // ------------------------------------------------------------------------------------------
  async request<K extends PromptKind>(req: AiRequest<K>): Promise<AiResult<z.infer<(typeof AI_OUTPUT_SCHEMAS)[K]>>> {
    type Out = z.infer<(typeof AI_OUTPUT_SCHEMAS)[K]>;
    const schema = AI_OUTPUT_SCHEMAS[req.kind] as unknown as z.ZodType<Out>;
    const caps = await this.d.config.capabilities(req.ref);
    const images = req.images ?? [];
    if (images.length > 0 && !caps.supportsVision) throw new AppError('MODEL_NO_VISION', `${req.ref.providerId}:${req.ref.model}`);
    if (images.length > Math.max(1, caps.maxImagesPerRequest)) {
      throw new AppError('UNKNOWN', `Too many images (${images.length}) for ${req.ref.model}`);
    }

    const key = cacheKey(req.ref, req.prompt.system, req.prompt.user, images.map((i) => i.sha256));
    const lk = limiterKey(req.ref);
    if (!req.bypassCache) {
      const hit = await this.d.cache.get(key, schema);
      if (hit !== null) {
        await this.d.ledger.recordResult(lk, req.ref.providerId, { cacheHit: true });
        return { output: hit, cacheKey: key, cacheHit: true, requestsUsed: 0 };
      }
    }

    const completion: CompletionRequest = {
      model: req.ref.model,
      system: req.prompt.system,
      user: req.prompt.user,
      images: images.map(({ sha256: _s, ...img }) => img),
      json: caps.supportsJsonMode,
      maxOutputTokens: Math.min(req.prompt.maxOutputTokens, caps.maxOutputTokens),
      temperature: req.prompt.temperature,
    };
    let requestsUsed = 0;
    const first = await this.send(req.ref, caps, completion, req.signal, req.onWaiting);
    requestsUsed += first.requestsUsed;
    let res = first.res;
    let usage = { ...res.usage };

    if (res.finishReason === 'content_filter' && !res.text.trim()) throw new AppError('CONTENT_FILTERED');

    let v = parseAndValidate(res.text, schema, ARRAY_KEYS[req.kind]);
    if (!v.ok) {
      if (res.finishReason === 'length') {
        // Cut-off output can't be repaired honestly. Evaluation splits the batch instead.
        throw new AppError(req.kind === 'evaluation' ? 'INVALID_AI_JSON' : 'CONTEXT_TOO_LONG', 'The AI response was cut off (output limit).');
      }
      const rp = buildRepairPrompt({ kind: req.kind, errors: v.errors, badOutput: res.text });
      const repaired = await this.send(
        req.ref,
        caps,
        { model: req.ref.model, system: rp.system, user: rp.user, json: caps.supportsJsonMode, maxOutputTokens: completion.maxOutputTokens, temperature: 0 },
        req.signal,
        req.onWaiting,
      );
      requestsUsed += repaired.requestsUsed;
      res = repaired.res;
      usage = {
        inputTokens: (usage.inputTokens ?? 0) + (res.usage?.inputTokens ?? 0),
        outputTokens: (usage.outputTokens ?? 0) + (res.usage?.outputTokens ?? 0),
      };
      v = parseAndValidate(res.text, schema, ARRAY_KEYS[req.kind]);
      if (!v.ok) throw new AppError('INVALID_AI_JSON', v.errors.slice(0, 3).join('; '));
    }

    await this.d.cache.put(key, req.ref, req.kind, v.value, usage);
    await this.d.ledger.recordResult(lk, req.ref.providerId, usage);
    return { output: v.value, cacheKey: key, cacheHit: false, requestsUsed };
  }

  // ------------------------------------------------------------------------------------------
  /** One logical call with retries. Counts every HTTP attempt against the daily quota. */
  private async send(
    ref: ModelRef,
    caps: ModelCapabilities,
    initial: CompletionRequest,
    signal: AbortSignal,
    onWaiting?: (resumeAt: number | null) => void,
  ): Promise<{ res: CompletionResponse; requestsUsed: number }> {
    const cfg = await this.d.config.get();
    const ps = cfg.providers[ref.providerId];
    const adapter = this.d.adapters[ref.providerId];
    let apiKey = '';
    if (ref.providerId !== 'mock') {
      apiKey = (await this.d.secrets.getKey(ref.providerId)) ?? '';
      if (!apiKey && ref.providerId !== 'custom') throw new AppError('MISSING_API_KEY', ref.providerId);
    }
    if (ref.providerId === 'custom' && !ps?.baseUrl) throw new AppError('VALIDATION', 'Set the base URL for the custom provider in Settings.');

    const lk = limiterKey(ref);
    const spec = { requestsPerMinute: caps.requestsPerMinute, maxConcurrent: ps?.maxConcurrent ?? 1 };
    let req = initial;
    let requestsUsed = 0;
    let networkFailures = 0;
    let lastErr: ProviderError | null = null;

    for (let attempt = 0; attempt < BACKOFF.maxAttempts; attempt++) {
      // Daily limits: our own counter and the provider's last word.
      const until = await this.d.ledger.exhaustedUntil(lk);
      if (until) throw new AppError('QUOTA_EXHAUSTED', `${lk} until ${new Date(until).toISOString()}`, until);
      if (caps.dailyLimit !== null && (await this.d.ledger.usedToday(lk, ref.providerId)) >= caps.dailyLimit) {
        throw new AppError('QUOTA_EXHAUSTED', `${lk}: daily limit of ${caps.dailyLimit} reached`, quotaResetAt(ref.providerId, this.clock.now()));
      }

      let release: () => void;
      try {
        release = await this.limiter.acquire(lk, spec, signal, onWaiting);
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw new AppError('CANCELLED');
        throw err;
      }
      requestsUsed++;
      await this.d.ledger.recordRequest(lk, ref.providerId);
      void this.emitUsage(ref);
      const timeoutMs = req.images?.length ? 120_000 : 90_000;
      try {
        const res = await adapter.complete(req, { apiKey, baseUrl: ps?.baseUrl, extraHeaders: ps?.extraHeaders, signal, timeoutMs });
        release();
        // Learn from rate-limit headers when present.
        if (res.rateLimit?.remainingRequestsDay === 0) await this.d.ledger.markExhausted(lk, quotaResetAt(ref.providerId, this.clock.now()));
        if (res.rateLimit?.remainingRequests === 0 && res.rateLimit.resetRequestsMs) {
          this.limiter.penalize(lk, this.clock.now() + res.rateLimit.resetRequestsMs);
        }
        return { res, requestsUsed };
      } catch (err) {
        release();
        if (!(err instanceof ProviderError)) {
          if ((err as Error)?.name === 'AbortError' || signal.aborted) throw new AppError('CANCELLED');
          throw err;
        }
        lastErr = err;
        this.log(`ai ${lk} attempt ${attempt + 1}: ${err.kind} ${err.status ?? ''}`);
        if (err.kind === 'cancelled') throw new AppError('CANCELLED');
        if (err.kind === 'bad_request' && req.json && err.message.startsWith('json_mode_unsupported')) {
          req = { ...req, json: false }; // retry once without JSON mode
          continue;
        }
        if (err.kind === 'quota_exhausted') {
          const resumeAt = err.retryAfterMs && err.retryAfterMs < 6 * 3_600_000 ? this.clock.now() + err.retryAfterMs : quotaResetAt(ref.providerId, this.clock.now());
          await this.d.ledger.markExhausted(lk, resumeAt);
          throw new AppError('QUOTA_EXHAUSTED', `${lk}: ${err.message}`, resumeAt);
        }
        if (!err.retryable) throw new AppError(ERROR_FOR_KIND[err.kind], err.message);
        if (err.kind === 'network' && ++networkFailures >= MAX_NETWORK_ATTEMPTS) break;

        const delay = Math.min(BACKOFF.maxMs * 5, err.retryAfterMs ?? backoffDelay(attempt, this.d.random));
        const resumeAt = this.clock.now() + delay;
        if (err.kind === 'rate_limit') {
          await this.d.ledger.recordResult(lk, ref.providerId, { got429: true });
          this.limiter.penalize(lk, resumeAt); // acquire() reports the wait to the UI
        } else {
          onWaiting?.(resumeAt);
          try {
            await this.clock.sleep(delay, signal);
          } catch {
            throw new AppError('CANCELLED');
          }
          onWaiting?.(null);
        }
      }
    }
    const kind = lastErr?.kind ?? 'server';
    throw new AppError(ERROR_FOR_KIND[kind], lastErr?.message ?? 'Gave up after retries');
  }

  // ------------------------------------------------------------------------------------------
  /**
   * Text probe, then a vision probe with a generated "TEST" image. 2 requests at most.
   * The result is saved in config (lastTest) and the vision flag follows what was observed.
   */
  async testConnection(ref: ModelRef, signal: AbortSignal): Promise<{ text: boolean; vision: boolean | null; latencyMs: number; message: string }> {
    const caps = await this.d.config.capabilities(ref);
    const started = this.clock.now();
    let text = false;
    let vision: boolean | null = null;
    let message = '';
    let errorCode: string | undefined;
    try {
      const { res } = await this.send(ref, caps, { model: ref.model, system: PROBE_TEXT_SYSTEM, user: PROBE_TEXT_USER, json: caps.supportsJsonMode, maxOutputTokens: 64, temperature: 0 }, signal);
      const parsed = extractJson(res.text);
      text = parsed.ok || /ok/i.test(res.text);
      message = text ? 'Connected.' : 'Connected, but the reply was not understood.';
    } catch (err) {
      errorCode = err instanceof AppError ? err.code : 'UNKNOWN';
      message = err instanceof AppError ? err.message : String(err);
    }
    if (text) {
      try {
        const png = probePng();
        const { res } = await this.send(
          ref,
          { ...caps, supportsVision: true, maxImagesPerRequest: Math.max(1, caps.maxImagesPerRequest) },
          {
            model: ref.model,
            system: PROBE_TEXT_SYSTEM,
            user: PROBE_VISION_USER,
            images: [{ mime: 'image/png', base64: png.toString('base64') }],
            json: caps.supportsJsonMode,
            maxOutputTokens: 64,
            temperature: 0,
          },
          signal,
        );
        vision = res.text.toUpperCase().includes(PROBE_VISION_EXPECTED);
        message += vision ? ' Vision works: it can read page images.' : ' This model did not read the test image, so use it for grading only.';
      } catch (err) {
        if (err instanceof AppError && (err.code === 'MODEL_NO_VISION' || err.code === 'UNKNOWN' || err.code === 'CONTENT_FILTERED')) {
          vision = false;
          message += ' Text only (no image support): use it for grading.';
        } else {
          message += ` Vision test could not run (${err instanceof AppError ? err.code : 'error'}).`;
        }
      }
    }
    const latencyMs = this.clock.now() - started;
    await this.d.config.recordConnectionTest(ref, { at: new Date().toISOString(), ok: text, vision, latencyMs, errorCode, message: message.slice(0, 500) }, vision);
    return { text, vision, latencyMs, message };
  }

  /** Model ids the key can see, for refreshing the picker. Not rate-limited (a cheap GET), but needs a key. */
  async listModels(providerId: ModelRef['providerId'], signal: AbortSignal): Promise<string[]> {
    const adapter = this.d.adapters[providerId];
    if (!adapter.listModels) return adapter.info.presets.map((p) => p.id);
    const cfg = await this.d.config.get();
    const apiKey = (await this.d.secrets.getKey(providerId)) ?? '';
    try {
      return await adapter.listModels({ apiKey, baseUrl: cfg.providers[providerId]?.baseUrl, signal, timeoutMs: 20_000 });
    } catch (err) {
      if (err instanceof ProviderError) throw new AppError(ERROR_FOR_KIND[err.kind], err.message);
      throw err;
    }
  }
}

export function hashImage(bytes: Uint8Array, mime: ImageInput['mime'], label?: string): HashedImage {
  return { mime, base64: Buffer.from(bytes).toString('base64'), sha256: sha256(bytes), label };
}
