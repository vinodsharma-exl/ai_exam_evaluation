// Renders the app icon (white graduation cap on the sidebar navy) to build/icon.png at 512×512.
// electron-builder converts it to the Windows .ico. Run: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect x="16" y="16" width="480" height="480" rx="104" fill="#0f1b2d"/>
  <rect x="16" y="16" width="480" height="480" rx="104" fill="none" stroke="#1d5bf0" stroke-width="10"/>
  <g transform="translate(64 70) scale(16)" fill="none" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/>
    <path d="M22 10v6"/>
    <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>
  </g>
  <circle cx="388" cy="388" r="62" fill="#1d5bf0"/>
  <path d="M358 388l20 20 38-40" fill="none" stroke="#ffffff" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = (await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })).resize({ width: 512, height: 512 });
  const out = join(__dirname, '..', 'build');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'icon.png'), img.toPNG());
  console.log('wrote build/icon.png');
  app.quit();
});
