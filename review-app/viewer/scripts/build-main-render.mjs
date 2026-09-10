import { build } from 'esbuild';
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Bundles the paper-form renderer (renderCms1500/renderUb04 + their
 * pdf-lib/@pdf-lib/fontkit/pdfText/layout/model deps) for review-app's main
 * process, separately from `npm run build` (Vite's browser bundle for the
 * viewer window's own UI, which must NOT pull in node:fs or pdf-lib -- see
 * src/render/text.ts's header comment). Output is loaded via a dynamic
 * import() from review-app/main.js's `viewer-render-pdf` IPC handler.
 *
 * Output format is ESM (not CJS): pdfText.ts locates the bundled DejaVu
 * fonts via `fileURLToPath(import.meta.url)`, which esbuild only preserves
 * correctly for the "esm" output format -- bundling to "cjs" replaces
 * import.meta with an empty object, silently breaking font loading. Node
 * (and Electron's main process) can load this via `await import(...)` from
 * plain CommonJS code without issue.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'dist-main');
const fontsSrcDir = join(root, 'src/render/fonts');
const fontsOutDir = join(outDir, 'fonts');

mkdirSync(fontsOutDir, { recursive: true });
for (const name of readdirSync(fontsSrcDir)) {
  if (name.endsWith('.ttf')) {
    copyFileSync(join(fontsSrcDir, name), join(fontsOutDir, name));
  }
}

await build({
  entryPoints: [join(root, 'src/render/mainRender.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: join(outDir, 'render.mjs'),
  logLevel: 'info',
});
