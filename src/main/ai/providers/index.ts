import type { ProviderAdapter } from '../../../shared/providers/types';
import type { ProviderId } from '../../../shared/schemas/common';
import { PROVIDER_CATALOG } from '../../../shared/providers/catalog';
import { APP_NAME } from '../../../shared/constants';
import { OpenAiCompatibleAdapter } from './openai-compatible';
import { GeminiAdapter } from './gemini';
import { AnthropicAdapter } from './anthropic';
import { MockAdapter } from './mock';
import type { FetchLike } from './http';

export type AdapterRegistry = Record<ProviderId, ProviderAdapter>;

export function createAdapters(opts: { fetchImpl?: FetchLike; mockLatencyMs?: number } = {}): AdapterRegistry {
  const f = opts.fetchImpl;
  const c = PROVIDER_CATALOG;
  return {
    gemini: new GeminiAdapter(c.gemini, f),
    groq: new OpenAiCompatibleAdapter(c.groq, {}, f),
    openrouter: new OpenAiCompatibleAdapter(
      c.openrouter,
      // OpenRouter asks apps to identify themselves. This sends only the app name, nothing about the user.
      { defaultHeaders: { 'HTTP-Referer': 'https://answereval.local', 'X-Title': APP_NAME } },
      f,
    ),
    mistral: new OpenAiCompatibleAdapter(c.mistral, { imageUrlAsString: true }, f),
    openai: new OpenAiCompatibleAdapter(c.openai, { useMaxCompletionTokens: true }, f),
    anthropic: new AnthropicAdapter(c.anthropic, f),
    custom: new OpenAiCompatibleAdapter(c.custom, {}, f),
    mock: new MockAdapter(c.mock, opts.mockLatencyMs),
  };
}
