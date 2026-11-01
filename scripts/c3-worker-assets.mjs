/** Build only reviewed source code. No registry, source workbook or environment
 * value is embedded. The output is private function data, never a Vite asset. */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  absWorkingDir: root,
  entryPoints: ['api/_c3-core/worker-entry.ts'],
  outfile: '.c3-runtime/worker.mjs',
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  logLevel: 'silent', sourcemap: false,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
console.log('C3 private worker asset built (code only).');
