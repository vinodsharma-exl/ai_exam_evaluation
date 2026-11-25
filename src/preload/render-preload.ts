/** Preload for the hidden render window. It exposes only a request/response bridge. */
import { contextBridge, ipcRenderer } from 'electron';

type Handler = (id: string, method: string, args: unknown[]) => void;

contextBridge.exposeInMainWorld('renderBridge', {
  onRequest(cb: Handler) {
    ipcRenderer.on('render:req', (_e, id: string, method: string, args: unknown[]) => cb(id, method, args));
  },
  respond(id: string, payload: { ok: boolean; result?: unknown; error?: string }) {
    ipcRenderer.send('render:res', id, payload);
  },
  ready() {
    ipcRenderer.send('render:ready');
  },
});
