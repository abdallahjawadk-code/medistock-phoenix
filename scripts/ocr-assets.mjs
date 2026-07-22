#!/usr/bin/env node
/**
 * PHARMA-OCR-A — vendor every Tesseract runtime asset into public/assets/ocr/
 * so the browser loads OCR exclusively from OUR origin. No CDN, ever.
 *
 * Two classes of asset:
 *
 *   1. Worker script + WASM core — COPIED from node_modules. No network, fully
 *      deterministic, versioned by package-lock.json.
 *   2. Trained language data — DOWNLOADED once from the pinned tessdata_fast
 *      release and verified against a hardcoded SHA-256. A hash mismatch is a
 *      hard failure: these files are executed as model input by the OCR engine,
 *      so an unverified download is a supply-chain hole, not a convenience.
 *
 * Output is gitignored — the repo stays lean and the assets are reproducible
 * from the lockfile plus these pinned hashes. Run automatically via `prebuild`.
 *
 * Usage: node scripts/ocr-assets.mjs [--verify-only]
 */
import { createHash } from 'node:crypto';
import { mkdir, copyFile, writeFile, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets', 'ocr');

/**
 * Pinned to the tessdata_fast tree at this exact commit. `main` is deliberately
 * NOT used: a moving ref would silently change the model behind a passing hash
 * update and make OCR accuracy irreproducible across builds.
 */
const TESSDATA_COMMIT = '87416418657359cb625c412a48b6e1d6d41c29bd';
const TESSDATA_BASE = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_COMMIT}`;

/** SHA-256 of each traineddata file. Verified on every run, not just on download. */
const LANGUAGE_DATA = [
  { file: 'eng.traineddata', sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2' },
  { file: 'ara.traineddata', sha256: 'e3206d3dc87fd50c24a0fb9f01838615911d25168f4e64415244b67d2bb3e729' },
];

/** Copied verbatim from node_modules — the lockfile is the integrity guarantee. */
const LOCAL_ASSETS = [
  { from: 'tesseract.js/dist/worker.min.js', to: 'worker.min.js' },
  { from: 'tesseract.js-core/tesseract-core-lstm.wasm', to: 'tesseract-core-lstm.wasm' },
  { from: 'tesseract.js-core/tesseract-core-lstm.wasm.js', to: 'tesseract-core-lstm.wasm.js' },
  { from: 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm', to: 'tesseract-core-relaxedsimd-lstm.wasm' },
  { from: 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', to: 'tesseract-core-relaxedsimd-lstm.wasm.js' },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const exists = async (p) => access(p).then(() => true, () => false);

async function copyLocalAssets() {
  for (const asset of LOCAL_ASSETS) {
    const src = join(ROOT, 'node_modules', asset.from);
    if (!(await exists(src))) {
      throw new Error(
        `Missing ${asset.from} in node_modules. Run \`npm ci\` before building OCR assets.`,
      );
    }
    await copyFile(src, join(OUT, asset.to));
  }
  console.log(`  ✓ copied ${LOCAL_ASSETS.length} runtime assets from node_modules`);
}

async function ensureLanguageData({ verifyOnly }) {
  for (const lang of LANGUAGE_DATA) {
    const dest = join(OUT, lang.file);

    if (await exists(dest)) {
      const digest = sha256(await readFile(dest));
      if (lang.sha256 && digest !== lang.sha256) {
        throw new Error(
          `Integrity failure for ${lang.file}\n  expected ${lang.sha256}\n  actual   ${digest}\n` +
          `Delete the file and re-run to re-download, or update the pin if this is an intentional model change.`,
        );
      }
      console.log(`  ✓ ${lang.file} present${lang.sha256 ? ' and verified' : ''} (sha256 ${digest.slice(0, 16)}…)`);
      continue;
    }

    if (verifyOnly) {
      throw new Error(`${lang.file} is missing and --verify-only was set.`);
    }

    console.log(`  … downloading ${lang.file}`);
    const response = await fetch(`${TESSDATA_BASE}/${lang.file}`);
    if (!response.ok) {
      throw new Error(`Download failed for ${lang.file}: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const digest = sha256(buffer);

    if (lang.sha256 && digest !== lang.sha256) {
      throw new Error(
        `Integrity failure for freshly downloaded ${lang.file}\n  expected ${lang.sha256}\n  actual   ${digest}`,
      );
    }
    if (!lang.sha256) {
      // First run for a new pin: report the hash so it can be recorded, but do
      // not silently trust it on subsequent builds.
      console.warn(`  ! ${lang.file} has no pinned sha256. Record this value: ${digest}`);
    }
    await writeFile(dest, buffer);
    console.log(`  ✓ ${lang.file} downloaded (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
  }
}

async function main() {
  const verifyOnly = process.argv.includes('--verify-only');
  await mkdir(OUT, { recursive: true });
  console.log('OCR assets → public/assets/ocr/');
  if (!verifyOnly) await copyLocalAssets();
  await ensureLanguageData({ verifyOnly });
  console.log('OCR assets ready. Served from this origin only — no CDN.');
}

main().catch((error) => {
  console.error(`\nOCR asset preparation failed:\n${error.message}\n`);
  process.exit(1);
});
