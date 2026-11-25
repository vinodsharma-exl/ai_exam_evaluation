/**
 * Electron entry point.
 * Start-up order: single-instance lock → data dir → services (recovers interrupted jobs) → IPC → window
 * → resume the global queue if it was left running.
 */
import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import { join } from 'node:path';
import { APP_NAME } from '../shared/constants';
import { AppError, ERROR_INFO } from '../shared/errors';
import { Logger } from './logger';
import { resolveDataDir, saveDataDir, type DataDirPaths } from './store/data-dir';
import { createServices, type Services } from './services';
import { registerIpc } from './ipc-handlers';
import { createMainWindow, hardenSession, isTrustedUrl, DEV_SERVER_URL } from './window';
import { ElectronRenderHost } from './pdf/render-host';
import { detectKind, renderOptions } from './pages/page-service';
import { promises as fs } from 'node:fs';

app.setName(APP_NAME);
app.setAppUserModelId('ai.answereval.desktop');

let mainWindow: BrowserWindow | null = null;
let services: Services | null = null;
let renderHost: ElectronRenderHost | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  // A second copy would fight over the same files. Focus the first one instead.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start, (err) => fatal(err));
}

const here = import.meta.dirname; // out/main
const logger = new Logger(join(app.getPath('userData'), 'logs'));

async function start(): Promise<void> {
  logger.info(`starting ${APP_NAME} ${app.getVersion()}`);
  hardenSession();

  const paths: DataDirPaths = { userData: app.getPath('userData'), documents: app.getPath('documents') };
  const dataDir = await resolveDataDir(paths);
  await saveDataDir(paths, dataDir);
  logger.info(`data dir: ${dataDir}`);

  renderHost = new ElectronRenderHost(join(here, '../preload'), join(here, '../renderer'), DEV_SERVER_URL, logger.info);
  try {
    services = await createServices({ dataDir, encryptor: safeStorage, render: renderHost, log: logger.info });
  } catch (err) {
    return fatal(err);
  }

  const selftest = process.argv.find((a) => a.startsWith('--selftest-render='));
  if (selftest) return runRenderSelfTest(selftest.slice('--selftest-render='.length));

  registerIpc({ services, paths, getWindow: () => mainWindow, isTrustedUrl });
  mainWindow = createMainWindow(join(here, '../preload'), join(here, '../renderer'));
  mainWindow.on('closed', () => (mainWindow = null));

  await services.queue.startIfAutoRun();
}

/**
 * Diagnostics: renders every page of a PDF/JPG/PNG through the real pipeline (hidden window + pdf.js)
 * into <userData>/selftest/, writes a JSON summary, then quits. Used for build checks and support.
 */
async function runRenderSelfTest(file: string): Promise<void> {
  const outDir = join(app.getPath('userData'), 'selftest');
  await fs.mkdir(outDir, { recursive: true });
  const summary: Record<string, unknown> = { file };
  try {
    const bytes = new Uint8Array(await fs.readFile(file));
    const kind = detectKind(bytes, file);
    summary.kind = kind;
    summary.pages = await renderHost!.withDocument(bytes, kind === 'pdf' ? 'pdf' : 'image', async (doc) => {
      const out = [];
      const text = kind === 'pdf' ? await doc.text() : [];
      for (let i = 0; i < doc.pageCount; i++) {
        const r = await doc.render(i, renderOptions('medium', 0));
        await fs.writeFile(join(outDir, `p${i + 1}.jpg`), r.jpeg);
        out.push({ width: r.width, height: r.height, jpegBytes: r.jpeg.length, thumbBytes: r.thumb.length, inkRatio: Number(r.inkRatio.toFixed(4)), textChars: text[i]?.length ?? 0, textStart: (text[i] ?? '').slice(0, 60) });
      }
      return out;
    });
    summary.ok = true;
  } catch (err) {
    summary.ok = false;
    summary.error = String((err as Error)?.message ?? err);
  }
  await fs.writeFile(join(outDir, 'result.json'), JSON.stringify(summary, null, 2));
  logger.info(`selftest: ${JSON.stringify(summary)}`);
  app.exit(summary.ok ? 0 : 1);
}

function fatal(err: unknown): void {
  const code = err instanceof AppError ? err.code : 'UNKNOWN';
  const info = ERROR_INFO[code];
  logger.error(`fatal: ${(err as Error)?.stack ?? err}`);
  dialog.showErrorBox(`${APP_NAME}: ${info.title}`, `${info.message}\n\n${(err as Error)?.message ?? ''}`);
  app.exit(1);
}

// Stop work cleanly so every job is saved as paused('app_closed') and resumes next time.
app.on('before-quit', (e) => {
  if (quitting || !services) return;
  e.preventDefault();
  quitting = true;
  const s = services;
  const timeout = new Promise((r) => setTimeout(r, 5000));
  void Promise.race([s.runner.stopAll(), timeout]).finally(() => {
    renderHost?.dispose();
    app.quit();
  });
});

app.on('window-all-closed', () => app.quit());

process.on('unhandledRejection', (r) => logger.error(`unhandledRejection: ${(r as Error)?.stack ?? r}`));
process.on('uncaughtException', (e) => logger.error(`uncaughtException: ${e.stack ?? e}`));
