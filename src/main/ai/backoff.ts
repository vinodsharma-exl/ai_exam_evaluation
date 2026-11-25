/**
 * Retry timing. Exponential backoff with jitter, overridden by whatever the provider tells us
 * (Retry-After, Gemini RetryInfo, x-ratelimit-reset-* headers).
 */
import { BACKOFF } from '../../shared/constants';

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF.maxMs, BACKOFF.baseMs * 2 ** Math.max(0, attempt));
  const jitter = BACKOFF.jitterMin + random() * (BACKOFF.jitterMax - BACKOFF.jitterMin);
  return Math.round(Math.min(BACKOFF.maxMs, exp * jitter));
}

/** Retry-After: either delta-seconds ("42") or an HTTP date. Returns ms from now, or undefined. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return Math.max(0, t - now);
  return undefined;
}

/**
 * Durations as used by Groq/OpenAI rate-limit headers and Gemini RetryInfo:
 * "42s", "1.5s", "2m59.56s", "1h2m", "250ms", "0.5". Returns ms.
 */
export function parseDuration(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const m of v.matchAll(re)) {
    matched = true;
    const n = parseFloat(m[1]!);
    const unit = m[2]!;
    total += unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n;
  }
  return matched ? Math.round(total) : undefined;
}

/** Sleep that rejects with an AbortError when the signal fires. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * Milliseconds until the next midnight in an IANA time zone. Gemini's free daily quota resets at
 * midnight Pacific time, not local midnight.
 */
export function msUntilMidnightIn(timeZone: string, now = Date.now()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const h = get('hour') % 24;
  const elapsed = ((h * 60 + get('minute')) * 60 + get('second')) * 1000 + (now % 1000);
  return 86_400_000 - elapsed;
}

/** Calendar date (YYYY-MM-DD) in a time zone, or local when timeZone is undefined. */
export function dateIn(timeZone: string | undefined, now = Date.now()): string {
  const d = new Date(now);
  if (!timeZone) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
