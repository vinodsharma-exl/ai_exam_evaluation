/**
 * Runs in the hidden render window. PDF pages (pdf.js) and photos (createImageBitmap, which honours
 * EXIF orientation) become grayscale JPEGs at the chosen quality, plus a thumbnail and an "ink ratio"
 * used to skip blank pages without spending an AI request.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { RenderMethods, RenderOptions, RenderedPage } from '../shared/render-protocol';

declare const __PDFJS_ASSET_BASE__: string;

interface Bridge {
  onRequest(cb: (id: string, method: string, args: unknown[]) => void): void;
  respond(id: string, payload: { ok: boolean; result?: unknown; error?: string }): void;
  ready(): void;
}
const bridge = (window as unknown as { renderBridge: Bridge }).renderBridge;

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const ASSETS = new URL(__PDFJS_ASSET_BASE__, window.location.href).href;

type Doc = { kind: 'pdf'; pdf: pdfjs.PDFDocumentProxy; task: pdfjs.PDFDocumentLoadingTask } | { kind: 'image'; bitmap: ImageBitmap };
const docs = new Map<string, Doc>();

function canvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  return { c, ctx };
}

async function toJpeg(c: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('JPEG encoding failed');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * In place: grayscale (optional), plus the ink ratio = share of pixels clearly darker than THIS page's
 * paper. The paper level is the 90th-percentile luminance, so grey scans and photos with uneven light
 * still work, and faint pencil (only slightly darker than the paper) still counts as writing.
 */
function postProcess(ctx: CanvasRenderingContext2D, w: number, h: number, grayscale: boolean): number {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const y = (0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!) | 0;
    hist[y]!++;
    if (grayscale) d[i] = d[i + 1] = d[i + 2] = y;
  }
  if (grayscale) ctx.putImageData(img, 0, 0);
  const total = w * h;
  let acc = 0;
  let paper = 255;
  for (let y = 0; y < 256; y++) {
    acc += hist[y]!;
    if (acc >= total * 0.9) {
      paper = y;
      break;
    }
  }
  const threshold = Math.max(0, paper - 35);
  let ink = 0;
  for (let y = 0; y < threshold; y++) ink += hist[y]!;
  return ink / total;
}

async function finish(src: HTMLCanvasElement, opts: RenderOptions): Promise<RenderedPage> {
  const { ctx } = { ctx: src.getContext('2d', { willReadFrequently: true })! };
  const inkRatio = postProcess(ctx, src.width, src.height, opts.grayscale);
  const jpeg = await toJpeg(src, opts.jpegQuality);
  const ts = Math.min(1, opts.thumbLongEdge / Math.max(src.width, src.height));
  const t = canvas(src.width * ts, src.height * ts);
  t.ctx.imageSmoothingQuality = 'high';
  t.ctx.drawImage(src, 0, 0, t.c.width, t.c.height);
  const thumb = await toJpeg(t.c, 0.7);
  return { jpeg, thumb, width: src.width, height: src.height, inkRatio };
}

const methods: RenderMethods = {
  async open(docId, bytes, kind) {
    if (kind === 'pdf') {
      const task = pdfjs.getDocument({
        data: bytes,
        enableXfa: false,
        wasmUrl: `${ASSETS}wasm/`,
        cMapUrl: `${ASSETS}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${ASSETS}standard_fonts/`,
        iccUrl: `${ASSETS}iccs/`,
      });
      const pdf = await task.promise;
      docs.set(docId, { kind: 'pdf', pdf, task });
      return { pageCount: pdf.numPages };
    }
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: 'from-image' });
    docs.set(docId, { kind: 'image', bitmap });
    return { pageCount: 1 };
  },

  async render(docId, pageIndex, opts) {
    const doc = docs.get(docId);
    if (!doc) throw new Error('Document not open');
    if (doc.kind === 'pdf') {
      const page = await doc.pdf.getPage(pageIndex + 1);
      const rotation = (page.rotate + opts.rotation) % 360;
      const base = page.getViewport({ scale: 1, rotation });
      const scale = Math.min(opts.dpi / 72, opts.maxLongEdge / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale, rotation });
      const { c, ctx } = canvas(viewport.width, viewport.height);
      await page.render({ canvas: c, canvasContext: ctx, viewport, background: '#ffffff' }).promise;
      page.cleanup();
      return finish(c, opts);
    }
    const b = doc.bitmap;
    const swap = opts.rotation === 90 || opts.rotation === 270;
    const scale = Math.min(1, opts.maxLongEdge / Math.max(b.width, b.height));
    const w = b.width * scale;
    const h = b.height * scale;
    const { c, ctx } = canvas(swap ? h : w, swap ? w : h);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((opts.rotation * Math.PI) / 180);
    ctx.drawImage(b, -w / 2, -h / 2, w, h);
    return finish(c, opts);
  },

  async text(docId) {
    const doc = docs.get(docId);
    if (!doc || doc.kind !== 'pdf') return doc ? [''] : [];
    const out: string[] = [];
    for (let i = 1; i <= doc.pdf.numPages; i++) {
      const page = await doc.pdf.getPage(i);
      const tc = await page.getTextContent();
      let s = '';
      for (const item of tc.items) {
        if ('str' in item) s += item.str + (item.hasEOL ? '\n' : ' ');
      }
      out.push(s.replace(/[ \t]+\n/g, '\n').trim());
      page.cleanup();
    }
    return out;
  },

  async close(docId) {
    const doc = docs.get(docId);
    docs.delete(docId);
    if (doc?.kind === 'pdf') await doc.task.destroy();
    else doc?.bitmap.close();
  },
};

bridge.onRequest(async (id, method, args) => {
  try {
    const fn = methods[method as keyof RenderMethods] as (...a: unknown[]) => Promise<unknown>;
    if (!fn) throw new Error(`Unknown method ${method}`);
    bridge.respond(id, { ok: true, result: await fn(...args) });
  } catch (err) {
    bridge.respond(id, { ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) });
  }
});
bridge.ready();
