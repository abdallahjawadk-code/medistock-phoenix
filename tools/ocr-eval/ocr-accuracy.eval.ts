/**
 * PHARMA-OCR-A — measured field-level accuracy over the de-identified corpus.
 *
 * NOT part of the normal test suite. It needs generated fixtures and runs the
 * real OCR engine over 30 images, which takes minutes. Run it deliberately:
 *
 *   npm run ocr:fixtures   # generate the corpus (playwright + sharp)
 *   npm run ocr:eval       # measure and print the report
 *
 * It reports per-field precision so accuracy claims are grounded in numbers
 * rather than impressions. A field is scored ONLY on the fields the ground
 * truth actually declares — a document with no price is not counted against
 * price accuracy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createWorker, PSM } from 'tesseract.js';
import { extractPharmaFields, bestCandidatePerField, type PharmaFieldName } from '../../src/features/inventory/ocr/parse/fields';
import type { OcrDocumentResult, OcrLine } from '../../src/features/inventory/ocr/types';

const FIXTURES = join(process.cwd(), 'tools', 'ocr-eval', 'fixtures');
const TRUTH_PATH = join(FIXTURES, 'ground-truth.json');

interface Fixture {
  file: string;
  documentId: string;
  variant: string;
  variantLabel: string;
  language: string;
  truth: Partial<Record<PharmaFieldName, string>>;
}

/** Fields reported separately, as the milestone requires. */
const REPORTED_FIELDS: PharmaFieldName[] = [
  'scientificName', 'batchNumber', 'expiryDate', 'quantity', 'nationalCode', 'unitPrice',
];

interface Tally { correct: number; wrong: number; missed: number }
const emptyTally = (): Tally => ({ correct: 0, wrong: 0, missed: 0 });

function toDocumentResult(data: {
  blocks: unknown; text: string;
}, width: number, height: number): OcrDocumentResult {
  const lines: OcrLine[] = [];
  for (const block of (data.blocks as { paragraphs?: { lines?: OcrLine[] }[] }[] | null) ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        lines.push({
          text: line.text,
          box: { ...line.box },
          confidence: line.confidence,
          words: (line.words ?? []).map(w => ({
            text: w.text, box: { ...w.box }, confidence: w.confidence, language: null,
          })),
        });
      }
    }
  }
  return {
    text: data.text, lines, words: lines.flatMap(l => l.words),
    imageWidth: width, imageHeight: height,
    language: 'ara+eng', durationMs: 0, providerId: 'tesseract-eval',
  };
}

describe('OCR field-level accuracy over the de-identified corpus', () => {
  it('measures and reports per-field results', async () => {
    if (!existsSync(TRUTH_PATH)) {
      throw new Error('Fixtures missing. Run `npm run ocr:fixtures` first.');
    }
    const fixtures: Fixture[] = JSON.parse(readFileSync(TRUTH_PATH, 'utf8'));

    const byField = new Map<PharmaFieldName, Tally>(REPORTED_FIELDS.map(f => [f, emptyTally()]));
    const byVariant = new Map<string, Tally>();
    const failures: string[] = [];

    // One worker for the whole run; ara+eng matches the app's default.
    const worker = await createWorker(['ara', 'eng'], 1, {
      langPath: join(process.cwd(), 'public', 'assets', 'ocr'),
      gzip: false,
    });
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });

    try {
      for (const fixture of fixtures) {
        const imagePath = join(FIXTURES, fixture.file);
        // `blocks` must be requested explicitly — tesseract.js returns
        // data.blocks === null by default, which silently yields zero lines and
        // therefore zero extracted fields.
        const { data } = await worker.recognize(imagePath, {}, { text: true, blocks: true });
        const document = toDocumentResult(data as never, 1240, 1754);
        const best = bestCandidatePerField(extractPharmaFields(document).candidates);

        const variantTally = byVariant.get(fixture.variant) ?? emptyTally();

        for (const field of REPORTED_FIELDS) {
          const expected = fixture.truth[field];
          if (!expected) continue; // Not declared for this document — not scored.

          const tally = byField.get(field)!;
          const actual = best.get(field)?.best.value;

          if (actual === undefined) {
            tally.missed += 1;
            variantTally.missed += 1;
            failures.push(`${fixture.file} ${field}: MISSED (expected ${expected})`);
          } else if (actual === expected) {
            tally.correct += 1;
            variantTally.correct += 1;
          } else {
            tally.wrong += 1;
            variantTally.wrong += 1;
            failures.push(`${fixture.file} ${field}: got "${actual}", expected "${expected}"`);
          }
        }
        byVariant.set(fixture.variant, variantTally);
      }
    } finally {
      await worker.terminate();
    }

    const pct = (t: Tally) => {
      const total = t.correct + t.wrong + t.missed;
      return total === 0 ? 'n/a' : `${((t.correct / total) * 100).toFixed(1)}%`;
    };

    const report: string[] = ['', '── OCR field accuracy (de-identified corpus) ──', ''];
    report.push('Field'.padEnd(20) + 'Correct'.padEnd(10) + 'Wrong'.padEnd(8) + 'Missed'.padEnd(9) + 'Accuracy');
    for (const field of REPORTED_FIELDS) {
      const t = byField.get(field)!;
      report.push(
        field.padEnd(20) + String(t.correct).padEnd(10) + String(t.wrong).padEnd(8) +
        String(t.missed).padEnd(9) + pct(t),
      );
    }
    report.push('', '── By capture condition ──', '');
    for (const [variant, t] of byVariant) {
      report.push(variant.padEnd(20) + pct(t));
    }
    report.push('', `Fixtures: ${fixtures.length}`, '');
    if (failures.length > 0) {
      report.push('── Misses and errors ──');
      report.push(...failures);
    }
    // eslint-disable-next-line no-console
    console.log(report.join('\n'));

    // WRONG values are far more dangerous than MISSED ones: a missed field is
    // typed by the operator, a wrong one may be waved through. This asserts the
    // corpus was actually processed; the numbers above are the real deliverable.
    expect(fixtures.length).toBeGreaterThan(0);
  }, 900_000);
});
