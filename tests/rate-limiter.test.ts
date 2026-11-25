import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/main/ai/rate-limiter';
import { backoffDelay, parseDuration, parseRetryAfter, msUntilMidnightIn, dateIn } from '../src/main/ai/backoff';
import { fakeClock } from './ai-helpers';

describe('RateLimiter (token bucket + min gap + penalty)', () => {
  it('spaces requests at 60/RPM seconds', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(clock);
    const spec = { requestsPerMinute: 10, maxConcurrent: 1 };
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      const release = await rl.acquire('g:flash', spec);
      times.push(clock.now());
      release();
    }
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(gaps.every((g) => g >= 6000)).toBe(true);
  });

  it('never exceeds RPM in any 60s window', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(clock);
    const spec = { requestsPerMinute: 15, maxConcurrent: 1 };
    const times: number[] = [];
    for (let i = 0; i < 60; i++) {
      const r = await rl.acquire('k', spec);
      times.push(clock.now());
      r();
    }
    for (let i = 0; i < times.length; i++) {
      const inWindow = times.filter((t) => t >= times[i]! && t < times[i]! + 60_000).length;
      expect(inWindow).toBeLessThanOrEqual(15);
    }
  });

  it('keeps separate buckets per provider:model', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(clock);
    const spec = { requestsPerMinute: 1, maxConcurrent: 1 };
    (await rl.acquire('a', spec))();
    const before = clock.now();
    (await rl.acquire('b', spec))();
    expect(clock.now()).toBe(before); // b didn't wait for a
  });

  it('blocks everyone after a 429 penalty and reports the wait', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(clock);
    const spec = { requestsPerMinute: 60, maxConcurrent: 1 };
    (await rl.acquire('k', spec))();
    rl.penalize('k', clock.now() + 42_000);
    const waits: Array<number | null> = [];
    const start = clock.now();
    (await rl.acquire('k', spec, undefined, (t) => waits.push(t)))();
    expect(clock.now() - start).toBeGreaterThanOrEqual(42_000);
    expect(waits[0]).toBe(start + 42_000);
    expect(waits[waits.length - 1]).toBeNull();
  });

  it('serves waiters first-in, first-out', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(clock);
    const spec = { requestsPerMinute: 30, maxConcurrent: 1 };
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map(async (n) => {
        const r = await rl.acquire('k', spec);
        order.push(n);
        r();
      }),
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('respects maxConcurrent until release', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(clock);
    const spec = { requestsPerMinute: 600, maxConcurrent: 1 };
    const r1 = await rl.acquire('k', spec);
    let second = false;
    const p = rl.acquire('k', spec).then((r) => {
      second = true;
      r();
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(second).toBe(false);
    r1();
    await p;
    expect(second).toBe(true);
  });

  it('stops waiting when cancelled', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(clock);
    const spec = { requestsPerMinute: 1, maxConcurrent: 1 };
    (await rl.acquire('k', spec))();
    const ac = new AbortController();
    ac.abort();
    await expect(rl.acquire('k', spec, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('backoff and header parsing', () => {
  it('grows exponentially with jitter and is capped', () => {
    expect(backoffDelay(0, () => 0.5)).toBe(2000);
    expect(backoffDelay(3, () => 0.5)).toBe(16000);
    expect(backoffDelay(10, () => 1)).toBe(60000);
    expect(backoffDelay(0, () => 0)).toBe(1000);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.parse('2026-11-25T10:00:00Z');
    expect(parseRetryAfter('42', now)).toBe(42000);
    expect(parseRetryAfter('Wed, 25 Nov 2026 10:01:00 GMT', now)).toBe(60000);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
  });

  it('parses provider durations (Groq/OpenAI headers, Gemini RetryInfo)', () => {
    expect(parseDuration('42s')).toBe(42000);
    expect(parseDuration('2m59.56s')).toBe(179560);
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('1h2m')).toBe(3720000);
  });

  it('computes the Gemini reset at midnight Pacific', () => {
    // 10:00 UTC = 02:00 PST → 22h until midnight Pacific.
    expect(msUntilMidnightIn('America/Los_Angeles', Date.parse('2026-11-25T10:00:00Z'))).toBe(22 * 3600_000);
    expect(dateIn('America/Los_Angeles', Date.parse('2026-11-25T05:00:00Z'))).toBe('2026-11-24');
  });
});
