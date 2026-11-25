/**
 * Per-"provider:model" request pacing for free tiers.
 *
 * Three rules, all of which must allow a request:
 *   1. Token bucket: capacity = RPM tokens, refilled at RPM/60 per second.
 *   2. Minimum gap of 60/RPM seconds between requests. Many free tiers reject short bursts even when
 *      the per-minute total is fine, so requests are spread evenly.
 *   3. Penalty window: after a 429 the key is blocked until Retry-After (or the backoff delay) ends,
 *      so every queued request waits, not just the one that failed.
 * Plus a concurrency cap (maxConcurrent, default 1).
 *
 * Waiters are served strictly first-in, first-out. Time and sleep are injectable for tests.
 */
import { abortableSleep } from './backoff';

export interface LimitSpec {
  requestsPerMinute: number;
  maxConcurrent: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
  lastIssued: number;
  blockedUntil: number;
  active: number;
  /** FIFO chain: each acquirer waits for the previous one to get its slot. */
  tail: Promise<void>;
  releaseWaiters: Array<() => void>;
}

export type Clock = { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: abortableSleep };

/** Waits longer than this are reported to the UI ("resuming in 42s"). */
const REPORT_WAIT_MS = 1500;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly clock: Clock = realClock) {}

  private bucket(key: string, spec: LimitSpec): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = {
        tokens: Math.max(1, spec.requestsPerMinute),
        lastRefill: this.clock.now(),
        lastIssued: -Infinity,
        blockedUntil: 0,
        active: 0,
        tail: Promise.resolve(),
        releaseWaiters: [],
      };
      this.buckets.set(key, b);
    }
    return b;
  }

  private refill(b: Bucket, spec: LimitSpec, now: number): void {
    const cap = Math.max(1, spec.requestsPerMinute);
    const elapsed = Math.max(0, now - b.lastRefill);
    b.tokens = Math.min(cap, b.tokens + (elapsed * spec.requestsPerMinute) / 60_000);
    b.lastRefill = now;
  }

  /** Milliseconds until a request could be sent, ignoring the concurrency cap. */
  private waitMs(b: Bucket, spec: LimitSpec, now: number): number {
    this.refill(b, spec, now);
    const minGap = 60_000 / spec.requestsPerMinute;
    const gapWait = b.lastIssued + minGap - now;
    const tokenWait = b.tokens >= 1 ? 0 : ((1 - b.tokens) * 60_000) / spec.requestsPerMinute;
    const blockWait = b.blockedUntil - now;
    return Math.max(0, gapWait, tokenWait, blockWait);
  }

  /**
   * Resolves with a release() function once a request may be sent. Always call release() when the
   * HTTP call finishes. onWait(resumeAt) is called for long waits, and onWait(null) once the wait is over.
   */
  async acquire(
    key: string,
    spec: LimitSpec,
    signal?: AbortSignal,
    onWait?: (resumeAt: number | null) => void,
  ): Promise<() => void> {
    if (!(spec.requestsPerMinute > 0)) throw new Error('requestsPerMinute must be > 0');
    const b = this.bucket(key, spec);
    const prev = b.tail;
    let done!: () => void;
    b.tail = new Promise<void>((r) => (done = r));
    try {
      await prev;
      let reported = false;
      for (;;) {
        if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        if (b.active >= Math.max(1, spec.maxConcurrent)) {
          await new Promise<void>((r) => b.releaseWaiters.push(r));
          continue;
        }
        const now = this.clock.now();
        const wait = this.waitMs(b, spec, now);
        if (wait <= 0) break;
        if (wait >= REPORT_WAIT_MS && onWait) {
          onWait(now + wait);
          reported = true;
        }
        await this.clock.sleep(wait, signal);
      }
      if (reported) onWait?.(null);
      const now = this.clock.now();
      b.tokens -= 1;
      b.lastIssued = now;
      b.active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        b.active--;
        b.releaseWaiters.shift()?.();
      };
    } finally {
      done();
    }
  }

  /** After a 429: block this key until `untilMs` and empty the bucket. */
  penalize(key: string, untilMs: number): void {
    const b = this.buckets.get(key);
    if (!b) {
      this.buckets.set(key, {
        tokens: 0,
        lastRefill: this.clock.now(),
        lastIssued: this.clock.now(),
        blockedUntil: untilMs,
        active: 0,
        tail: Promise.resolve(),
        releaseWaiters: [],
      });
      return;
    }
    b.blockedUntil = Math.max(b.blockedUntil, untilMs);
    b.tokens = 0;
  }

  /** For the UI and the estimator: when the next request could go out (epoch ms). */
  nextSlotAt(key: string, spec: LimitSpec): number {
    const b = this.buckets.get(key);
    if (!b) return this.clock.now();
    const now = this.clock.now();
    return now + this.waitMs(b, spec, now);
  }
}
