/**
 * OUTLET-RETURN composer & picker — structural contract.
 *
 * These static scans hold the draft-first discipline the composer cannot be
 * unit-rendered to prove (no DOM test env in this repo): nothing persists before
 * confirmation, provenance is mandatory, the picker performs no writes, and no
 * free-text / OCR / manual-balance path exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const composerRaw = read('src', 'features', 'outlet', 'OutletReturnComposer.tsx');
const pickerRaw = read('src', 'features', 'outlet', 'OutletReturnProvenancePicker.tsx');
const composer = stripComments(composerRaw);
const picker = stripComments(pickerRaw);

function bodyOf(source: string, declaration: string, span = 2600): string {
  const start = source.indexOf(declaration);
  expect(start, `not found: ${declaration}`).toBeGreaterThan(-1);
  return source.slice(start, start + span);
}

describe('nothing is persisted before confirmation', () => {
  it('the create RPC appears exactly once', () => {
    expect(composer.match(/requestOutletReturn\(/g) ?? []).toHaveLength(1);
  });

  it('both write RPCs live inside confirmAndCreate (add-line also in retry)', () => {
    const body = bodyOf(composer, 'const confirmAndCreate');
    expect(body).toContain('requestOutletReturn(');
    expect(body).toContain('addOutletReturnLine(');
  });

  it('nothing before the confirm handler can create or add a line', () => {
    const before = composer.slice(0, composer.indexOf('const confirmAndCreate'));
    expect(before).not.toContain('requestOutletReturn(');
    expect(before).not.toContain('addOutletReturnLine(');
  });

  it('confirmAndCreate refuses unless the draft is confirmable', () => {
    expect(bodyOf(composer, 'const confirmAndCreate')).toMatch(/if \(!confirmable \|\| committing\) return;/);
  });

  it('the retry never re-creates the header', () => {
    const retry = bodyOf(composer, 'const retryUnsent');
    expect(retry).toContain('getOutletReturnRequestLines(');
    expect(retry).toContain('planOutletReturnRetry(');
    expect(retry).not.toContain('requestOutletReturn(');
  });
});

describe('provenance is mandatory and free text / OCR / manual balance are impossible', () => {
  it('every added line carries originalDispatchLineId from the candidate', () => {
    expect(composer).toContain('draftLineFromReturnable(candidate');
    expect(composer).toContain('originalDispatchLineId: line.originalDispatchLineId');
  });

  it('materials come only from the canonical returnable-sources provider', () => {
    expect(composer).toContain('loadOutletReturnableSources(');
  });

  it('neither composer nor picker creates stock, uses OCR, or changes a balance manually', () => {
    for (const source of [composer, picker]) {
      for (const forbidden of [
        'receiveWarehouseStock', 'applyWarehouseStockMovement',
        'phoenix_receive_warehouse_stock', 'Ocr', 'OCR', 'set_exact',
      ]) {
        expect(source, forbidden).not.toContain(forbidden);
      }
    }
  });

  it('the provenance picker performs no writes at all', () => {
    for (const forbidden of ['supabase', '.rpc(', 'requestOutletReturn', 'addOutletReturnLine']) {
      expect(picker, forbidden).not.toContain(forbidden);
    }
  });
});

describe('canonical reload and cap enforcement', () => {
  it('review reloads returnable sources and revalidates caps', () => {
    const review = bodyOf(composer, 'const enterReview');
    expect(review).toContain('loadOutletReturnableSources(');
    expect(review).toContain('revalidateOutletReturnDraft(');
  });
});
