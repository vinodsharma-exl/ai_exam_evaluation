/**
 * Main-process side of page rendering. pdf.js needs a real canvas, so rendering runs in a hidden,
 * sandboxed BrowserWindow (render.html). Calls are serialised, one at a time, to keep memory low
 * with large scans. If that window crashes, every pending call fails and the next call starts a
 * fresh window.
 */
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RenderMethods, RenderMethod, RenderOptions, RenderedPage } from '../../shared/render-protocol';
import { AppError } from '../../shared/errors';

/** Implemented by the Electron host here, and by fakes in tests. */
export interface RenderHost {
  withDocument<T>(bytes: Uint8Array, kind: 'pdf' | 'image', fn: (doc: OpenDoc) => Promise<T>): Promise<T>;
  dispose(): void;
}

export interface OpenDoc {
  pageCount: number;
  render(pageIndex: number, opts: RenderOptions): Promise<RenderedPage>;
  text(): Promise<string[]>;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const CALL_TIMEOUT_MS = 120_000;

export class ElectronRenderHost implements RenderHost {
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly onResponse = (e: IpcMainEvent, id: string, payload: { ok: boolean; result?: unknown; error?: string }) => {
    if (!this.win || e.sender !== this.win.webContents) return; // only our render window may answer
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (payload.ok) p.resolve(payload.result);
    else p.reject(new AppError('PDF_RENDER_FAILED', payload.error));
  };

  constructor(
    private readonly preloadDir: string,
    private readonly rendererDir: string,
    private readonly devServerUrl: string | null,
    private readonly log: (m: string) => void = () => undefined,
  ) {
    ipcMain.on('render:res', this.onResponse);
  }

  private ensureWindow(): Promise<void> {
    if (this.ready && this.win && !this.win.isDestroyed()) return this.ready;
    const win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: {
        preload: join(this.preloadDir, 'render-preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        devTools: !!this.devServerUrl,
      },
    });
    this.win = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('render-process-gone', (_e, d) => {
      this.log(`render window gone: ${d.reason}`);
      this.failAll(new AppError('PDF_RENDER_FAILED', `Renderer stopped (${d.reason})`));
      this.win = null;
      this.ready = null;
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (e: IpcMainEvent) => {
        if (e.sender !== win.webContents) return;
        ipcMain.removeListener('render:ready', onReady);
        resolve();
      };
      ipcMain.on('render:ready', onReady);
      win.webContents.once('did-fail-load', (_e, _c, desc) => reject(new AppError('PDF_RENDER_FAILED', desc)));
    });
    if (this.devServerUrl) void win.loadURL(`${this.devServerUrl.replace(/\/$/, '')}/render.html`);
    else void win.loadFile(join(this.rendererDir, 'render.html'));
    return this.ready;
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private async call<M extends RenderMethod>(method: M, ...args: Parameters<RenderMethods[M]>): Promise<Awaited<ReturnType<RenderMethods[M]>>> {
    await this.ensureWindow();
    const id = randomUUID();
    return new Promise<Awaited<ReturnType<RenderMethods[M]>>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError('PDF_RENDER_FAILED', `${method} timed out`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.win!.webContents.send('render:req', id, method, args);
    });
  }

  /** Opens a document, runs fn, always closes it. Serialised with other documents. */
  withDocument<T>(bytes: Uint8Array, kind: 'pdf' | 'image', fn: (doc: OpenDoc) => Promise<T>): Promise<T> {
    const run = async () => {
      const docId = randomUUID();
      const { pageCount } = await this.call('open', docId, bytes, kind);
      try {
        return await fn({
          pageCount,
          render: (i, opts) => this.call('render', docId, i, opts),
          text: () => this.call('text', docId),
        });
      } finally {
        await this.call('close', docId).catch(() => undefined);
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    ipcMain.removeListener('render:res', this.onResponse);
    this.failAll(new AppError('CANCELLED'));
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
