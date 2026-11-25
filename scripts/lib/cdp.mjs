// Minimal Chrome DevTools Protocol driver for UI walkthroughs of the Electron app (no extra dependencies).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts the app with a remote-debugging port and connects to its main window.
 * exe: electron.exe (dev, with appDir) or the installed "AnswerEval AI.exe" (appDir = null).
 */
export async function launch({ exe, appDir = null, userData, port = 9333 }) {
  const args = [...(appDir ? [appDir] : []), `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`];
  const proc = spawn(exe, args, { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.url.endsWith('index.html'));
    } catch {
      /* not up yet */
    }
  }
  if (!target) {
    proc.kill();
    throw new Error('App window did not appear (is another copy running?)');
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 860, deviceScaleFactor: 1, mobile: false });

  const page = {
    proc,
    send,
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed');
      return r.result?.result?.value;
    },
    async shot(dir, name) {
      mkdirSync(dir, { recursive: true });
      await sleep(400);
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(dir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    },
    async waitText(text, ms = 20000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await page.eval(`document.body.innerText.includes(${JSON.stringify(text)})`)) return;
        await sleep(200);
      }
      throw new Error(`Timed out waiting for text: ${text}`);
    },
    async click(text, { exact = false, nth = 0 } = {}) {
      const ok = await page.eval(`(() => {
        const t = ${JSON.stringify(text)};
        const els = [...document.querySelectorAll('button, [role=tab], [role=radio], a')].filter(b => !b.disabled && (${exact} ? b.innerText.trim() === t : b.innerText.trim().includes(t)));
        const el = els[${nth}];
        if (!el) return false;
        el.scrollIntoView({ block: 'center' }); el.click(); return true;
      })()`);
      if (!ok) throw new Error(`Button not found or disabled: ${text}`);
      await sleep(250);
    },
    /** Sets a React-controlled input/textarea/select the way typing would. */
    async fill(selector, value) {
      const ok = await page.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
        return true;
      })()`);
      if (!ok) throw new Error(`Field not found: ${selector}`);
      await sleep(100);
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      proc.kill();
    },
  };
  return page;
}
