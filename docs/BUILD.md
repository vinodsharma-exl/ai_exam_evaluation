# Building AnswerEval AI

## Prerequisites (developer machine only)

- Windows 10/11 x64
- Node.js 20 or newer (tested with Node 24) and npm
- Internet access for `npm install`, and for the **first** installer build: electron-builder downloads its NSIS and 7-Zip tools from GitHub once, then caches them in `%LOCALAPPDATA%\electron-builder\Cache`

The professor's PC needs **nothing** installed. The installer contains Electron (Chromium + Node), pdf.js and its offline decoders, and every library.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Run with hot reload (Vite dev server) |
| `npm run typecheck` | TypeScript check of main, preload, renderer, tests |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run test:ui` | Build, then drive the real app through every screen with the offline mock AI; screenshots go to `%TEMP%\answereval-ui-walkthrough\screenshots` |
| `npm run pack` | Unpacked app in `release\win-unpacked\` (quick smoke test, no installer) |
| `npm run dist` | Typecheck + tests + build + **installer** → `release\AnswerEval-AI-Setup-<version>.exe` |
| `npm run icon` | Re-render `build/icon.png` from the SVG in `scripts/make-icon.cjs` |
| `npm run samples` | Re-create the sample PDFs/PNGs in `samples/` used by tests and checks |
| `npm run schemas` | Regenerate JSON Schemas in `schemas/` from the zod source |

## Releasing a new version

1. Bump `"version"` in `package.json` (e.g. `0.2.0`).
2. `npm run dist`.
3. Give the professor the new `AnswerEval-AI-Setup-0.2.0.exe`. Running it over the old version upgrades in place. Data in `Documents\AnswerEvalAI` is untouched, and files from older versions are migrated on first read (see `src/main/store/migrations.ts`).

## Code signing (recommended before wide distribution)

Unsigned installers trigger Windows SmartScreen ("Windows protected your PC" → More info → Run anyway). To sign, get a code-signing certificate (OV or EV) and set before `npm run dist`:

```powershell
$env:CSC_LINK = "C:\path\to\certificate.pfx"   # or a base64 string
$env:CSC_KEY_PASSWORD = "…"
npm run dist
```

Never commit the certificate or password. EV certificates on hardware tokens need electron-builder's `win.signtoolOptions`; see the electron-builder code-signing docs.

## Diagnostics

- Logs: `%APPDATA%\AnswerEval AI\logs\main.log` (keys are redacted, prompts and student text are never logged).
- PDF rendering self-test (also works on the installed app):
  ```powershell
  & "$env:LOCALAPPDATA\Programs\AnswerEval AI\AnswerEval AI.exe" --selftest-render="C:\path\to\file.pdf"
  ```
  It renders every page into `%APPDATA%\AnswerEval AI\selftest\` and writes `result.json` (size, ink ratio, text-layer length per page). Exit code 0 means it worked.

## Troubleshooting the build

| Problem | Fix |
|---|---|
| First `npm run dist` fails downloading `nsis` / `winCodeSign` | Network or proxy blocked GitHub. Retry, or set `ELECTRON_BUILDER_BINARIES_MIRROR`. |
| `EPERM` / file in use while packaging | Close any running AnswerEval AI window; antivirus may hold `release\` briefly, so retry. |
| App starts but shows a blank window | Run `npm run test:ui`; it fails on the first broken screen and saves a screenshot. |
| `npm audit` reports issues in `electron-builder` | They are build-time tools that are not shipped. Check `npm audit --omit=dev` (should be 0). |
