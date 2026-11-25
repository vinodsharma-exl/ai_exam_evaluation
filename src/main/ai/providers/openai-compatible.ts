/**
 * OpenAI Chat Completions format. Used for Groq, OpenRouter, Mistral, OpenAI and "Custom".
 * Differences between them are kept to a few flags.
 */
import type { CallContext, CompletionRequest, CompletionResponse, ProviderAdapter, ProviderInfo } from '../../../shared/providers/types';
import { ProviderError } from '../../../shared/providers/types';
import { genericHttpError, getJson, postJson, type FetchLike } from './http';
import { parseDuration } from '../backoff';

export interface OpenAiCompatOptions {
  /** Mistral wants image_url as a plain string. Others use { url }. */
  imageUrlAsString?: boolean;
  /** OpenAI's newer models want max_completion_tokens. */
  useMaxCompletionTokens?: boolean;
  /** Headers added to every request (OpenRouter attribution). */
  defaultHeaders?: Record<string, string>;
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  constructor(
    readonly info: ProviderInfo,
    private readonly opts: OpenAiCompatOptions = {},
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {}

  private base(ctx: CallContext): string {
    const b = ctx.baseUrl ?? this.info.defaultBaseUrl;
    if (!b) throw new ProviderError('bad_request', 'No base URL set for this provider');
    return b.replace(/\/+$/, '');
  }

  private headers(ctx: CallContext): Record<string, string> {
    return {
      ...(this.opts.defaultHeaders ?? {}),
      ...(ctx.extraHeaders ?? {}),
      ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
    };
  }

  async complete(req: CompletionRequest, ctx: CallContext): Promise<CompletionResponse> {
    const content: unknown[] = [];
    for (const img of req.images ?? []) {
      if (img.label) content.push({ type: 'text', text: img.label });
      const url = `data:${img.mime};base64,${img.base64}`;
      content.push({ type: 'image_url', image_url: this.opts.imageUrlAsString ? url : { url } });
    }
    content.push({ type: 'text', text: req.user });

    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        { role: 'system', content: req.system },
        // A text-only request uses a plain string, which more servers accept.
        { role: 'user', content: req.images?.length ? content : req.user },
      ],
      temperature: req.temperature,
      [this.opts.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens']: req.maxOutputTokens,
    };
    if (req.json) body.response_format = { type: 'json_object' };

    const res = await postJson(this.fetchImpl, `${this.base(ctx)}/chat/completions`, this.headers(ctx), body, ctx.signal, ctx.timeoutMs);
    if (!res.ok) {
      const err = await genericHttpError(res);
      // Some servers reject response_format; the queue retries without JSON mode once.
      if (req.json && err.kind === 'bad_request' && /response_format|json/i.test(err.message)) {
        throw new ProviderError('bad_request', `json_mode_unsupported: ${err.message}`, err.status);
      }
      throw err;
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    // OpenRouter sometimes returns 200 with an error object.
    if (data.error) throw new ProviderError('server', `Provider error: ${data.error.message ?? 'unknown'}`);
    const choice = data.choices?.[0];
    const raw = choice?.message?.content;
    const text = Array.isArray(raw) ? raw.map((p) => p.text ?? '').join('') : raw ?? '';
    const fr = choice?.finish_reason;
    const remainingDay = res.headers.get('x-ratelimit-remaining-requests-day');
    return {
      text,
      finishReason: fr === 'stop' ? 'stop' : fr === 'length' ? 'length' : fr === 'content_filter' ? 'content_filter' : 'other',
      usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
      rateLimit: {
        remainingRequests: numHeader(res.headers.get('x-ratelimit-remaining-requests')),
        remainingRequestsDay: numHeader(remainingDay),
        resetRequestsMs: parseDuration(res.headers.get('x-ratelimit-reset-requests')),
      },
    };
  }

  async listModels(ctx: CallContext): Promise<string[]> {
    const data = (await getJson(this.fetchImpl, `${this.base(ctx)}/models`, this.headers(ctx), ctx.signal, ctx.timeoutMs)) as {
      data?: Array<{ id: string }>;
    };
    return (data.data ?? []).map((m) => m.id).sort();
  }
}

function numHeader(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
