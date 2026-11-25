/**
 * AiClient: the free-tier survival behaviour, with a scripted fake adapter and virtual time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/main/store/file-store';
import { ConfigService } from '../src/main/store/config-service';
import { SecretStore } from '../src/main/store/secret-store';
import { UsageLedger } from '../src/main/ai/usage-ledger';
import { ResponseCache } from '../src/main/ai/response-cache';
import { AiClient, hashImage } from '../src/main/ai/ai-client';
import { createAdapters } from '../src/main/ai/providers/index';
import { ProviderError, type CompletionRequest, type CompletionResponse, type ProviderAdapter } from '../src/shared/providers/types';
import { PROVIDER_CATALOG } from '../src/shared/providers/catalog';
import { ensureLayout } from '../src/main/store/data-dir';
import { tempDir, fakeEncryptor } from './helpers';
import { fakeClock, FIXTURE_JPEG } from './ai-helpers';

const REF = { providerId: 'groq' as const, model: 'llama-3.3-70b-versatile' };
const GOOD = JSON.stringify({ results: [{ q: '1', criteria: [{ id: 'overall', awarded: 2 }], confidence: 0.9 }] });
const prompt = { system: 'You recommend marks...', user: 'Q 1 | max 2', maxOutputTokens: 500, temperature: 0 };

type Step = string | ProviderError | ((req: CompletionRequest) => string);

let t: ReturnType<typeof tempDir>;
let client: AiClient;
let ledger: UsageLedger;
let clock: ReturnType<typeof fakeClock>;
let calls: CompletionRequest[];
let script: Step[];
let config: ConfigService;

beforeEach(async () => {
  t = tempDir();
  await ensureLayout(t.dir);
  const store = new FileStore(t.dir);
  config = new ConfigService(store);
  const secrets = new SecretStore(store, fakeEncryptor());
  await secrets.setKey('groq', 'gsk_testkey123');
  clock = fakeClock();
  ledger = new UsageLedger(store, () => clock.now());
  calls = [];
  script = [];
  const fake: ProviderAdapter = {
    info: PROVIDER_CATALOG.groq,
    async complete(req): Promise<CompletionResponse> {
      calls.push(req);
      const step = script.shift() ?? GOOD;
      if (step instanceof ProviderError) throw step;
      const text = typeof step === 'function' ? step(req) : step;
      return { text, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  const adapters = { ...createAdapters(), groq: fake };
  client = new AiClient({ config, secrets, adapters, ledger, cache: new ResponseCache(store), clock, random: () => 0.5 });
});
afterEach(() => t.cleanup());

const signal = () => new AbortController().signal;

describe('AiClient', () => {
  it('returns validated output and caches it (second call is free)', async () => {
    const r1 = await client.request({ kind: 'evaluation', ref: REF, prompt, signal: signal() });
    expect(r1.output.results[0]!.q).toBe('1');
    expect(r1.cacheHit).toBe(false);
    const r2 = await client.request({ kind: 'evaluation', ref: REF, prompt, signal: signal() });
    expect(r2.cacheHit).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await ledger.usedToday('groq:llama-3.3-70b-versatile', 'groq')).toBe(1);
    // bypassCache (Re-evaluate) does call again.
    await client.request({ kind: 'evaluation', ref: REF, prompt, signal: signal(), bypassCache: true });
    expect(calls).toHaveLength(2);
  });

  it('retries a 429 after Retry-After and tells the UI how long it waits', async () => {
    script = [new ProviderError('rate_limit', 'slow down', 429, 42_000), GOOD];
    const waits: Array<number | null> = [];
    const start = clock.now();
    const r = await client.request({ kind: 'evaluation', ref: REF, prompt, signal: signal(), onWaiting: (x) => waits.push(x) });
    expect(r.requestsUsed).toBe(2);
    expect(clock.now() - start).toBeGreaterThanOrEqual(42_000);
    expect(waits.some((w) => w !== null && w >= start + 42_000)).toBe(true);
  });

  it('retries 5xx with exponential backoff', async () => {
    script = [new ProviderError('server', 'overloaded', 503), new ProviderError('server', 'overloaded', 503), GOOD];
    const r = await client.request({ kind: 'evaluation', ref: REF, prompt, signal: signal() });
    expect(r.requestsUsed).toBe(3);
    expect(clock.sleeps).toContain(2000);
    expect(clock.sleeps).toContain(4000);
  });

  it('stops at the provider daily quota and refuses further calls until reset', async () => {
    script = [new ProviderError('quota_exhausted', 'requests per day', 429)];
    await expect(client.request({ kind: 'evaluation', ref: REF, prompt, signal: signal() })).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
    expect(await ledger.exhaustedUntil('groq:llama-3.3-70b-versatile')).not.toBeNull();
    await expect(client.request({ kind: 'evaluation', ref: REF, prompt: { ...prompt, user: 'other' }, signal: signal() })).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
    expect(calls).toHaveLength(1); // the second call never reached the provider
  });

  it('enforces our own daily cap from Settings', async () => {
    await config.updateModelCapabilities(REF, { dailyLimit: 2 });
    for (let i = 0; i < 2; i++) await client.request({ kind: 'evaluation', ref: REF, prompt: { ...prompt, user: `u${i}` }, signal: signal() });
    await expect(client.request({ kind: 'evaluation', ref: REF, prompt: { ...prompt, user: 'u3' }, signal: signal() })).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
    expect(calls).toHaveLength(2);
  });

  it('makes exactly ONE repair call for invalid JSON', async () => {
    script = ['Here you go: {results: [{q: "1", confidence: 0.9', GOOD];
    const r = await client.request({ kind: 'evaluation', ref: REF, prompt, signal: signal() });
    expect(r.requestsUsed).toBe(2);
    expect(calls[1]!.system).toMatch(/fix malformed JSON/);
  });

  it('fails with INVALID_AI_JSON if the repair is also invalid (and caches nothing)', async () => {
    script = ['not json', 'still not json'];
    await expect(client.request({ kind: 'evaluation', ref: REF, prompt, signal: signal() })).rejects.toMatchObject({ code: 'INVALID_AI_JSON' });
    expect(calls).toHaveLength(2);
    script = [GOOD];
    const r = await client.request({ kind: 'evaluation', ref: REF, prompt, signal: signal() });
    expect(r.cacheHit).toBe(false);
  });

  it('maps a bad key to INVALID_API_KEY without retrying', async () => {
    script = [new ProviderError('auth', 'invalid key', 401)];
    await expect(client.request({ kind: 'evaluation', ref: REF, prompt, signal: signal() })).rejects.toMatchObject({ code: 'INVALID_API_KEY' });
    expect(calls).toHaveLength(1);
  });

  it('refuses images for a text-only model with MODEL_NO_VISION (no request sent)', async () => {
    const img = hashImage(FIXTURE_JPEG, 'image/jpeg', 'Page 1');
    await expect(client.request({ kind: 'answer_ocr', ref: REF, prompt, images: [img], signal: signal() })).rejects.toMatchObject({ code: 'MODEL_NO_VISION' });
    expect(calls).toHaveLength(0);
  });

  it('asks for a key that is missing', async () => {
    await expect(client.request({ kind: 'evaluation', ref: { providerId: 'gemini', model: 'gemini-2.5-flash' }, prompt, signal: signal() })).rejects.toMatchObject({ code: 'MISSING_API_KEY' });
  });

  it('turns cancellation into CANCELLED', async () => {
    const ac = new AbortController();
    script = [new ProviderError('cancelled', 'x')];
    ac.abort();
    await expect(client.request({ kind: 'evaluation', ref: REF, prompt, signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('Test connection detects vision and records it in Settings', async () => {
    script = ['{"ok":true}', '{"word":"TEST"}'];
    const res = await client.testConnection(REF, signal());
    expect(res).toMatchObject({ text: true, vision: true });
    expect(calls[1]!.images).toHaveLength(1);
    expect((await config.capabilities(REF)).supportsVision).toBe(true);

    script = ['{"ok":true}', new ProviderError('no_vision', 'image input not supported', 400)];
    const res2 = await client.testConnection(REF, signal());
    expect(res2.vision).toBe(false);
    expect((await config.capabilities(REF)).supportsVision).toBe(false);
  });
});
