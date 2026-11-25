/**
 * Anthropic Messages API (paid keys). There is no JSON mode flag here; the prompt asks for JSON only
 * and json-repair.ts extracts and validates it.
 */
import type { CallContext, CompletionRequest, CompletionResponse, ProviderAdapter, ProviderInfo } from '../../../shared/providers/types';
import { ProviderError } from '../../../shared/providers/types';
import { genericHttpError, postJson, type FetchLike } from './http';

export class AnthropicAdapter implements ProviderAdapter {
  constructor(
    readonly info: ProviderInfo,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {}

  async complete(req: CompletionRequest, ctx: CallContext): Promise<CompletionResponse> {
    const content: unknown[] = [];
    for (const img of req.images ?? []) {
      if (img.label) content.push({ type: 'text', text: img.label });
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
    }
    content.push({ type: 'text', text: req.user });
    const base = (ctx.baseUrl ?? this.info.defaultBaseUrl!).replace(/\/+$/, '');
    const res = await postJson(
      this.fetchImpl,
      `${base}/messages`,
      { 'x-api-key': ctx.apiKey, 'anthropic-version': '2023-06-01', ...(ctx.extraHeaders ?? {}) },
      {
        model: req.model,
        system: req.system,
        max_tokens: req.maxOutputTokens,
        temperature: req.temperature,
        messages: [{ role: 'user', content }],
      },
      ctx.signal,
      ctx.timeoutMs,
    );
    if (!res.ok) {
      const err = await genericHttpError(res);
      // 529 = overloaded: retryable like any other 5xx.
      throw err;
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    if (data.stop_reason === 'refusal' && !text) throw new ProviderError('content_filtered', 'The model declined this content');
    return {
      text,
      finishReason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason === 'max_tokens' ? 'length' : 'other',
      usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens },
    };
  }
}
