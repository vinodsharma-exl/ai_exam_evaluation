/** Messages between main and the hidden render window (pdf.js + canvas). */

export interface RenderOptions {
  /** Target resolution for PDF pages. Photos are only scaled down. */
  dpi: number;
  maxLongEdge: number;
  /** 0..1 */
  jpegQuality: number;
  grayscale: boolean;
  /** Extra clockwise rotation chosen by the professor. */
  rotation: 0 | 90 | 180 | 270;
  thumbLongEdge: number;
}

export interface RenderedPage {
  jpeg: Uint8Array;
  thumb: Uint8Array;
  width: number;
  height: number;
  /** Share of pixels clearly darker than the page's paper, 0..1. Below BLANK_INK_RATIO the page counts as blank. */
  inkRatio: number;
}

export interface RenderMethods {
  open(docId: string, bytes: Uint8Array, kind: 'pdf' | 'image'): Promise<{ pageCount: number }>;
  render(docId: string, pageIndex: number, opts: RenderOptions): Promise<RenderedPage>;
  /** Text layer per page (typed PDFs). '' for scanned pages and images. */
  text(docId: string): Promise<string[]>;
  close(docId: string): Promise<void>;
}

export type RenderMethod = keyof RenderMethods;

/**
 * Below this share of ink pixels a page is skipped as blank. Deliberately low: one short handwritten
 * line on A4 is ~0.1%. A speckled truly-blank scan may cost one request; skipping a real answer is worse.
 */
export const BLANK_INK_RATIO = 0.0003;
