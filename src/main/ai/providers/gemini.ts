/**
 * Google Gemini (AI Studio) generateContent API.
 * The key goes in the x-goog-api-key header, never in the URL, so it can't end up in logs.
 */
import type { CallContext, CompletionRequest, CompletionResponse, ProviderAdapter, ProviderInfo } from '../../../shared/providers/types';
import { ProviderError, type ProviderErrorKind } from '../../../shared/providers/types';
import { getJson, postJson, readErrorText, type FetchLike } from './http';
import { parseDuration, parseRetryAfter } from '../backoff';

interface GeminiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ '@type'?: string; retryDelay?: string; violations?: Array<{ quotaId?: string; quotaMetric?: string }> }>;
  };
}

export class GeminiAdapter implements ProviderAdapter {
  constructor(
    readonly info: ProviderInfo,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {}

  private base(ctx: CallContext): string {
    return (ctx.baseUrl ?? this.info.defaultBaseUrl!).replace(/\/+$/, '');
  }

  async complete(req: CompletionRequest, ctx: CallContext): Promise<CompletionResponse> {
    const parts: unknown[] = [];
    for (const img of req.images ?? []) {
      if (img.label) parts.push({ text: img.label });
      parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
    }
    parts.push({ text: req.user });

    const generationConfig: Record<string, unknown> = {
      temperature: req.temperature,
      maxOutputTokens: req.maxOutputTokens,
    };
    if (req.json) generationConfig.responseMimeType = 'application/json';
    // 2.5 Flash/Flash-Lite "think" by default, which spends output tokens and time. Extraction and
    // rubric grading don't need it on a free tier.
    if (/2\.5-flash/.test(req.model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts }],
      generationConfig,
    };
    const url = `${this.base(ctx)}/models/${encodeURIComponent(req.model)}:generateContent`;
    const res = await postJson(this.fetchImpl, url, { 'x-goog-api-key': ctx.apiKey, ...(ctx.extraHeaders ?? {}) }, body, ctx.signal, ctx.timeoutMs);
    if (!res.ok) throw await geminiError(res);

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    if (data.promptFeedback?.blockReason) {
      throw new ProviderError('content_filtered', `Blocked by Gemini safety filter (${data.promptFeedback.blockReason})`);
    }
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    const fr = cand?.finishReason;
    if ((fr === 'SAFETY' || fr === 'PROHIBITED_CONTENT' || fr === 'BLOCKLIST') && !text) {
      throw new ProviderError('content_filtered', `Blocked by Gemini safety filter (${fr})`);
    }
    return {
      text,
      finishReason: fr === 'STOP' ? 'stop' : fr === 'MAX_TOKENS' ? 'length' : fr === 'SAFETY' ? 'content_filter' : 'other',
      usage: { inputTokens: data.usageMetadata?.promptTokenCount, outputTokens: data.usageMetadata?.candidatesTokenCount },
    };
  }

  async listModels(ctx: CallContext): Promise<string[]> {
    const data = (await getJson(this.fetchImpl, `${this.base(ctx)}/models?pageSize=200`, { 'x-goog-api-key': ctx.apiKey }, ctx.signal, ctx.timeoutMs)) as {
      models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
    };
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .sort();
  }
}

export async function geminiError(res: Response): Promise<ProviderError> {
  const raw = await res.clone().text().catch(() => '');
  let body: GeminiErrorBody = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* not JSON */
  }
  const msg = await readErrorText(res);
  const details = body.error?.details ?? [];
  const retryInfo = details.find((d) => d['@type']?.endsWith('RetryInfo'));
  const violations = details.flatMap((d) => d.violations ?? []);
  const perDay = violations.some((v) => /PerDay|per_day|daily/i.test(`${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`));
  const retryAfter = parseDuration(retryInfo?.retryDelay) ?? parseRetryAfter(res.headers.get('retry-after'));
  const status = body.error?.status ?? '';

  let kind: ProviderErrorKind;
  if (res.status === 429 || status === 'RESOURCE_EXHAUSTED') kind = perDay ? 'quota_exhausted' : 'rate_limit';
  else if (res.status === 401 || res.status === 403 || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)) kind = 'auth';
  else if (res.status === 404) kind = 'model_not_found';
  else if (res.status === 400 && /exceeds the maximum number of tokens|too long|token count/i.test(msg)) kind = 'context_too_long';
  else if (res.status === 400 && /image|inline_data|mime/i.test(msg)) kind = 'no_vision';
  else if (res.status >= 500) kind = 'server';
  else kind = 'bad_request';
  return new ProviderError(kind, `HTTP ${res.status}: ${msg}`, res.status, retryAfter);
}
