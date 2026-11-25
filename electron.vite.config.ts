import { defineConfig, type Plugin } from 'electron-vite';
import { resolve } from 'node:path';
import { cpSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = import.meta.dirname;
const pdfjsDir = resolve(root, 'node_modules/pdfjs-dist');
const PDFJS_ASSETS = ['wasm', 'cmaps', 'standard_fonts', 'iccs'];

/** Copies pdf.js decoders (JBIG2/JPEG2000 wasm), CMaps and fonts next to the renderer, so the app works offline. */
function copyPdfjsAssets(outDir: string): Plugin {
  return {
    name: 'copy-pdfjs-assets',
    apply: 'build',
    closeBundle() {
      for (const d of PDFJS_ASSETS) cpSync(resolve(pdfjsDir, d), resolve(outDir, 'pdfjs', d), { recursive: true });
    },
  };
}

export default defineConfig(({ command }) => ({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { main: resolve(root, 'src/main/main.ts') } },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          preload: resolve(root, 'src/preload/preload.ts'),
          'render-preload': resolve(root, 'src/preload/render-preload.ts'),
        },
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    define: {
      __PDFJS_ASSET_BASE__: JSON.stringify(command === 'serve' ? `/@fs/${pdfjsDir.replace(/\\/g, '/')}/` : './pdfjs/'),
    },
    plugins: [react(), tailwindcss(), copyPdfjsAssets(resolve(root, 'out/renderer'))],
    build: {
      outDir: 'out/renderer',
      target: 'chrome140',
      rollupOptions: {
        input: {
          index: resolve(root, 'src/renderer/index.html'),
          render: resolve(root, 'src/renderer/render.html'),
        },
      },
    },
  },
}));
