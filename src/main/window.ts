/**
 * Main window with locked-down web preferences. The renderer gets no Node access, runs sandboxed,
 * cannot open new windows or navigate away, and has every permission request (camera, mic,
 * notifications, ...) denied.
 */
import { BrowserWindow, session, shell } from 'electron';
import { join } from 'node:path';
import { APP_NAME } from '../shared/constants';

export const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL ?? null;

export function isTrustedUrl(url: string): boolean {
  if (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL)) return true;
  return url.startsWith('file://');
}

export function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // Production CSP. In dev, Vite's HMR needs inline scripts and websockets, so the dev server is left alone.
  if (!DEV_SERVER_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          ],
        },
      });
    });
  }
}

export function createMainWindow(preloadDir: string, rendererDir: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: '#0f1b2d',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(preloadDir, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      devTools: !!DEV_SERVER_URL,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Links go to the system browser (https only). The app never opens other windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url)) e.preventDefault();
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  if (DEV_SERVER_URL) void win.loadURL(DEV_SERVER_URL);
  else void win.loadFile(join(rendererDir, 'index.html'));
  return win;
}
