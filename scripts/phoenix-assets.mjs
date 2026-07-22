/* ─── PHOENIX runtime asset derivation ────────────────────────────────────────
   Derives shippable AVIF + WebP runtime textures from the immutable master PNGs
   in design/phoenix-source/. The masters (2–4 MB PNG) are NEVER shipped; only
   these compact derivatives go to production. Runtime textures are capped well
   under 600 KB. Idempotent — safe to re-run. Requires `sharp` (devDependency).

   Usage: node scripts/phoenix-assets.mjs
   ─────────────────────────────────────────────────────────────────────────── */
import sharp from 'sharp';
import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'design', 'phoenix-source');
const OUT = join(ROOT, 'public', 'assets', 'phoenix', 'runtime');
mkdirSync(OUT, { recursive: true });

const MAX_BYTES = 600 * 1024;

/** master file, output basename, target width, avif/webp quality */
const TEXTURES = [
  { src: 'phoenix-login-master.png', base: 'phoenix-login', width: 1680, avifQ: 52, webpQ: 74 },
  { src: 'phoenix-welcome-clean-plate-master.png', base: 'phoenix-welcome-clean', width: 1680, avifQ: 52, webpQ: 74 },
  { src: 'phoenix-dashboard-reference-master.png', base: 'phoenix-dashboard', width: 1440, avifQ: 50, webpQ: 72 },
  { src: 'phoenix-babil-map-master.png', base: 'phoenix-babil-map', width: 1440, avifQ: 50, webpQ: 72 },
];

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

let failed = false;
for (const tex of TEXTURES) {
  const input = join(SRC, tex.src);
  const pipeline = sharp(input).resize({ width: tex.width, withoutEnlargement: true });

  const avifPath = join(OUT, `${tex.base}.avif`);
  const webpPath = join(OUT, `${tex.base}.webp`);
  await pipeline.clone().avif({ quality: tex.avifQ, effort: 5 }).toFile(avifPath);
  await pipeline.clone().webp({ quality: tex.webpQ, effort: 5 }).toFile(webpPath);

  for (const p of [avifPath, webpPath]) {
    const bytes = statSync(p).size;
    const ok = bytes <= MAX_BYTES;
    if (!ok) failed = true;
    console.log(`${ok ? 'OK ' : 'OVER'} ${p.replace(ROOT, '.')}  ${kb(bytes)}`);
  }
}

if (failed) {
  console.error(`\nERROR: a runtime texture exceeded the ${MAX_BYTES / 1024} KB budget.`);
  process.exit(1);
}
console.log('\nRuntime textures derived under budget.');
