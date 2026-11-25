/**
 * The only bridge between the sandboxed renderer and main. It exposes `window.api` with exactly the
 * whitelisted channels from shared/ipc.ts. No ipcRenderer, no Node.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS, type AppApi, type AppEvents } from '../shared/ipc';

const api: Record<string, unknown> = {};
for (const channel of IPC_CHANNELS) {
  api[channel] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}

const EVENTS: ReadonlyArray<keyof AppEvents> = ['job:progress', 'usage:update', 'queue:update', 'config:changed'];

api.on = <E extends keyof AppEvents>(event: E, cb: (payload: AppEvents[E]) => void) => {
  if (!EVENTS.includes(event)) throw new Error(`Unknown event ${String(event)}`);
  const listener = (_e: Electron.IpcRendererEvent, name: string, payload: unknown) => {
    if (name === event) cb(payload as AppEvents[E]);
  };
  ipcRenderer.on('app-event', listener);
  return () => ipcRenderer.removeListener('app-event', listener);
};

// Drag and drop: sandboxed renderers can't see file paths; webUtils gives the path of a dropped File.
api.pathForFile = (file: File) => webUtils.getPathForFile(file);

contextBridge.exposeInMainWorld('api', api as unknown as AppApi);
