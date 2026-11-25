/**
 * HTTP helpers shared by adapters: timeouts, network-error mapping, and safe error-message extraction.
 * Nothing here logs request headers or bodies. Keys travel in headers only, never in URLs.
 */
import { ProviderError, type ProviderErrorKind } from '../../../shared/providers/types';
import { redactSecrets } from '../../../shared/errors';
import { parseDuration, parseRetryAfter } from '../backoff';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    throw mapFetchError(err, signal, timeout);
  }
}

export async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.any([signal, timeout]) });
  } catch (err) {
    throw mapFetchError(err, signal, timeout);
  }
  if (!res.ok) throw await genericHttpError(res);
  return res.json();
}

export function mapFetchError(err: unknown, userSignal: AbortSignal, timeout: AbortSignal): ProviderError {
  if (userSignal.aborted) return new ProviderError('cancelled', 'Cancelled');
  if (timeout.aborted) return new ProviderError('timeout', 'The AI service did not answer in time');
  const cause = (err as { cause?: { code?: string } })?.cause?.code ?? '';
  return new ProviderError('network', `Network error ${cause}`.trim());
}

/** Reads the body as text (bounded) and pulls out a provider error message, redacted. */
export async function readErrorText(res: Response): Promise<string> {
  let text = '';
  try {
    text = (await res.text()).slice(0, 4000);
  } catch {
    /* ignore */
  }
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j?.error?.message ?? j?.message ?? j?.error ?? text;
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
  } catch {
    /* not JSON */
  }
  return redactSecrets(String(msg)).slice(0, 500);
}

const DAILY_PATTERNS = /per.?day|daily|RPD|requests per day|free-models-per-day|quota exceeded for metric.*day|billing|insufficient_quota|credits/i;
const CONTEXT_PATTERNS = /context length|context_length|maximum context|too long|too many tokens|reduce the length|prompt is too long|max_tokens|request too large/i;
const VISION_PATTERNS = /image|vision|multimodal|image_url|does not support (images|image input)/i;

/** Retry delay from the standard and x-ratelimit headers, in ms. */
export function retryAfterFromHeaders(h: Headers): number | undefined {
  return (
    parseRetryAfter(h.get('retry-after')) ??
    parseDuration(h.get('x-ratelimit-reset-requests')) ??
    parseDuration(h.get('x-ratelimit-reset-tokens'))
  );
}

/** Generic status → error kind mapping used by the OpenAI-compatible and Anthropic adapters. */
export async function genericHttpError(res: Response): Promise<ProviderError> {
  const msg = await readErrorText(res);
  const retryAfter = retryAfterFromHeaders(res.headers);
  let kind: ProviderErrorKind;
  if (res.status === 401 || res.status === 403) kind = 'auth';
  else if (res.status === 402) kind = 'quota_exhausted';
  else if (res.status === 404) kind = VISION_PATTERNS.test(msg) ? 'no_vision' : 'model_not_found';
  else if (res.status === 413) kind = 'context_too_long';
  else if (res.status === 429) kind = DAILY_PATTERNS.test(msg) ? 'quota_exhausted' : 'rate_limit';
  else if (res.status === 400 || res.status === 422) {
    kind = CONTEXT_PATTERNS.test(msg) ? 'context_too_long' : VISION_PATTERNS.test(msg) ? 'no_vision' : /safety|moderation|flagged|content/i.test(msg) ? 'content_filtered' : 'bad_request';
  } else if (res.status >= 500) kind = 'server';
  else kind = 'bad_request';
  return new ProviderError(kind, `HTTP ${res.status}: ${msg}`, res.status, retryAfter);
}
