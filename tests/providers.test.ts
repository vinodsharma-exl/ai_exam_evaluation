/** Adapter request shapes and error mapping, with a fake fetch (no network). */
import { describe, expect, it } from 'vitest';
import { GeminiAdapter } from '../src/main/ai/providers/gemini';
import { OpenAiCompatibleAdapter } from '../src/main/ai/providers/openai-compatible';
import { AnthropicAdapter } from '../src/main/ai/providers/anthropic';
import { MockAdapter } from '../src/main/ai/providers/mock';
import { PROVIDER_CATALOG } from '../src/shared/providers/catalog';
import { ProviderError, type CompletionRequest } from '../src/shared/providers/types';
import { buildAnswerOcrPrompt, buildEvaluationPrompt } from '../src/shared/prompts/templates';
import { AnswerOcrOutput, EvaluationOutput } from '../src/shared/schemas/ai-output';

type Captured = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const captured: Captured[] = [];
  const f = async (url: string, init: RequestInit) => {
    captured.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { f, captured };
}

const req: CompletionRequest = {
  model: 'm',
  system: 'sys',
  user: 'hello',
  images: [{ mime: 'image/jpeg', base64: 'AAAA', label: 'Page 1' }],
  json: true,
  maxOutputTokens: 100,
  temperature: 0,
};
const ctx = { apiKey: 'AIzaSySECRETKEY1234567890abc', signal: new AbortController().signal, timeoutMs: 5000 };

async function errOf(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('expected an error');
}

describe('Gemini adapter', () => {
  it('sends the key in a header (never the URL), images inline, JSON mode and no thinking on 2.5 Flash', async () => {
    const { f, captured } = fakeFetch(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } });
    const a = new GeminiAdapter(PROVIDER_CATALOG.gemini, f);
    const res = await a.complete({ ...req, model: 'gemini-2.5-flash' }, ctx);
    expect(res.text).toBe('{"ok":true}');
    expect(captured[0]!.url).not.toContain('AIza');
    expect((captured[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe(ctx.apiKey);
    const body = JSON.parse(captured[0]!.init.body as string);
    expect(body.contents[0].parts[1].inline_data.mime_type).toBe('image/jpeg');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(0);
  });

  it('tells per-minute 429 (retry) from per-day quota (stop)', async () => {
    const perMinute = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' }] } };
    const e1 = await errOf(new GeminiAdapter(PROVIDER_CATALOG.gemini, fakeFetch(429, perMinute).f).complete(req, ctx));
    expect(e1.kind).toBe('rate_limit');
    expect(e1.retryAfterMs).toBe(42000);

    const perDay = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } };
    const e2 = await errOf(new GeminiAdapter(PROVIDER_CATALOG.gemini, fakeFetch(429, perDay).f).complete(req, ctx));
    expect(e2.kind).toBe('quota_exhausted');
  });

  it('maps invalid key and safety blocks', async () => {
    const e = await errOf(new GeminiAdapter(PROVIDER_CATALOG.gemini, fakeFetch(400, { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }).f).complete(req, ctx));
    expect(e.kind).toBe('auth');
    const blocked = await errOf(new GeminiAdapter(PROVIDER_CATALOG.gemini, fakeFetch(200, { promptFeedback: { blockReason: 'SAFETY' } }).f).complete(req, ctx));
    expect(blocked.kind).toBe('content_filtered');
  });
});

describe('OpenAI-compatible adapter (Groq / OpenRouter / Mistral / OpenAI / Custom)', () => {
  it('builds chat/completions with image_url parts and Bearer auth', async () => {
    const { f, captured } = fakeFetch(200, { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }, { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2.5s' });
    const res = await new OpenAiCompatibleAdapter(PROVIDER_CATALOG.groq, {}, f).complete(req, ctx);
    expect(captured[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(captured[0]!.init.body as string);
    expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(res.rateLimit).toMatchObject({ remainingRequests: 0, resetRequestsMs: 2500 });
  });

  it('uses Mistral string image_url and OpenAI max_completion_tokens', async () => {
    const m = fakeFetch(200, { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] });
    await new OpenAiCompatibleAdapter(PROVIDER_CATALOG.mistral, { imageUrlAsString: true }, m.f).complete(req, ctx);
    expect(JSON.parse(m.captured[0]!.init.body as string).messages[1].content[1].image_url).toBe('data:image/jpeg;base64,AAAA');
    const o = fakeFetch(200, { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] });
    await new OpenAiCompatibleAdapter(PROVIDER_CATALOG.openai, { useMaxCompletionTokens: true }, o.f).complete(req, ctx);
    expect(JSON.parse(o.captured[0]!.init.body as string).max_completion_tokens).toBe(100);
  });

  it('maps statuses: 401 auth, 429 daily vs minute, 413 context, 5xx server, Retry-After', async () => {
    const A = (status: number, body: unknown, h?: Record<string, string>) => errOf(new OpenAiCompatibleAdapter(PROVIDER_CATALOG.groq, {}, fakeFetch(status, body, h).f).complete(req, ctx));
    expect((await A(401, { error: { message: 'Invalid API Key' } })).kind).toBe('auth');
    const rl = await A(429, { error: { message: 'Rate limit reached for requests per minute' } }, { 'retry-after': '7' });
    expect(rl.kind).toBe('rate_limit');
    expect(rl.retryAfterMs).toBe(7000);
    expect((await A(429, { error: { message: 'Rate limit reached for model on requests per day (RPD)' } })).kind).toBe('quota_exhausted');
    expect((await A(413, { error: { message: 'Request too large' } })).kind).toBe('context_too_long');
    expect((await A(400, { error: { message: 'This model does not support image input' } })).kind).toBe('no_vision');
    expect((await A(503, { error: { message: 'Service Unavailable' } })).kind).toBe('server');
    expect((await A(404, { error: { message: 'The model `x` does not exist' } })).kind).toBe('model_not_found');
  });

  it('redacts keys that a server echoes back in an error', async () => {
    const e = await errOf(new OpenAiCompatibleAdapter(PROVIDER_CATALOG.groq, {}, fakeFetch(401, { error: { message: 'bad key gsk_abcdefghijklmnop' } }).f).complete(req, ctx));
    expect(e.message).not.toContain('gsk_abcdef');
  });

  it('maps network failures and timeouts', async () => {
    const boom = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    };
    expect((await errOf(new OpenAiCompatibleAdapter(PROVIDER_CATALOG.groq, {}, boom).complete(req, ctx))).kind).toBe('network');
    const hang = (_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
    expect((await errOf(new OpenAiCompatibleAdapter(PROVIDER_CATALOG.groq, {}, hang).complete(req, { ...ctx, timeoutMs: 20 }))).kind).toBe('timeout');
  });
});

describe('Anthropic adapter', () => {
  it('sends x-api-key and base64 image blocks; 529 overloaded is retryable', async () => {
    const { f, captured } = fakeFetch(200, { content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' });
    await new AnthropicAdapter(PROVIDER_CATALOG.anthropic, f).complete({ ...req, model: 'claude-haiku-5-5' }, ctx);
    expect((captured[0]!.init.headers as Record<string, string>)['x-api-key']).toBe(ctx.apiKey);
    expect(JSON.parse(captured[0]!.init.body as string).messages[0].content[1].source.type).toBe('base64');
    const e = await errOf(new AnthropicAdapter(PROVIDER_CATALOG.anthropic, fakeFetch(529, { error: { message: 'Overloaded' } }).f).complete(req, ctx));
    expect(e.retryable).toBe(true);
  });
});

describe('Mock adapter (offline demo)', () => {
  it('answers our real OCR and evaluation prompts with schema-valid JSON', async () => {
    const mock = new MockAdapter(PROVIDER_CATALOG.mock, 0);
    const ocrP = buildAnswerOcrPrompt({ questionLabels: ['1(a)', '1(b)', '2'], previousQuestion: null, pageFrom: 1, pageTo: 2, pageTotal: 2 });
    const ocr = await mock.complete({ ...req, system: ocrP.system, user: ocrP.user }, ctx);
    expect(AnswerOcrOutput.safeParse(JSON.parse(ocr.text)).success).toBe(true);
    const evP = buildEvaluationPrompt({
      strictness: 'standard',
      allowHalfMarks: true,
      items: [{ label: '1a', maxMarks: 2, type: 'theory', questionText: 'Define', modelAnswer: 'LIFO', markingPoints: [{ id: 'p1', description: 'LIFO', marks: 2 }], studentAnswer: 'Last in first out' }],
    });
    const ev = await mock.complete({ ...req, images: [], system: evP.system, user: evP.user }, ctx);
    const parsed = EvaluationOutput.parse(JSON.parse(ev.text));
    expect(parsed.results[0]!.criteria[0]!.id).toBe('p1');
  });
});
