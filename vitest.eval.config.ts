import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * PHARMA-OCR-A — config for the OCR accuracy evaluation ONLY.
 *
 * Kept separate from the normal suite because the evaluation needs generated
 * fixtures and runs the real OCR engine over the whole corpus, which takes
 * minutes. It must never slow down or gate `npm test` / CI. Run it deliberately
 * with `npm run ocr:eval`.
 */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
  test: {
    include: ['tools/ocr-eval/**/*.eval.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    // The engine is single-threaded WASM; parallel files would just contend.
    fileParallelism: false,
  },
});
