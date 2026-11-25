import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../src/main/ai/rate-limiter';
import type { OpenDoc, RenderHost } from '../src/main/pdf/render-host';
import type { RenderOptions, RenderedPage } from '../src/shared/render-protocol';

/** Virtual time: sleep() advances the clock instantly and records every wait. */
export function fakeClock(start = Date.parse('2026-11-25T10:00:00Z')): Clock & { t: number; sleeps: number[] } {
  const c = {
    t: start,
    sleeps: [] as number[],
    now: () => c.t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      c.sleeps.push(ms);
      c.t += Math.max(0, ms);
      await Promise.resolve();
    },
  };
  return c;
}

export const FIXTURE_JPEG = new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', 'page.jpg')));

/**
 * Stands in for the Electron/pdf.js renderer. A "PDF" is any file; its page count is the number of
 * lines in it (so tests can say how many pages they want). blankPages are reported with zero ink.
 */
export function fakeRenderHost(opts: { blankPages?: number[] } = {}): RenderHost & { renders: Array<{ page: number; rotation: number }> } {
  const renders: Array<{ page: number; rotation: number }> = [];
  return {
    renders,
    async withDocument<T>(bytes: Uint8Array, kind: 'pdf' | 'image', fn: (d: OpenDoc) => Promise<T>): Promise<T> {
      const pageCount = kind === 'image' ? 1 : Math.max(1, new TextDecoder().decode(bytes).split('\n').filter((l) => l.startsWith('PAGE')).length);
      return fn({
        pageCount,
        async render(i: number, o: RenderOptions): Promise<RenderedPage> {
          renders.push({ page: i, rotation: o.rotation });
          // Vary the bytes per page and rotation so hashes differ, as with real renders.
          const jpeg = new Uint8Array([...FIXTURE_JPEG.subarray(0, FIXTURE_JPEG.length - 2), ...new TextEncoder().encode(`${i}:${o.rotation}`), 0xff, 0xd9]);
          return { jpeg, thumb: FIXTURE_JPEG, width: 989, height: 1400, inkRatio: opts.blankPages?.includes(i) ? 0 : 0.05 };
        },
        async text() {
          return Array.from({ length: pageCount }, () => '');
        },
      });
    },
    dispose() {},
  };
}

/** A minimal "PDF" for the fake renderer: real %PDF magic bytes plus N page markers. */
export function fakePdf(pages: number): Uint8Array {
  return new TextEncoder().encode('%PDF-1.7\n' + Array.from({ length: pages }, (_, i) => `PAGE ${i + 1}`).join('\n'));
}
