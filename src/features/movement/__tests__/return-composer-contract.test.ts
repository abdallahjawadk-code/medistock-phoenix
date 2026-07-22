/**
 * MOVEMENT-COMPOSER-A — structural contract of the Direct Return composer and
 * its provenance picker.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const composerRaw = read('src', 'features', 'movement', 'DirectReturnComposer.tsx');
const pickerRaw = read('src', 'features', 'movement', 'ui', 'ProvenanceReturnPicker.tsx');
const composer = stripComments(composerRaw);
const picker = stripComments(pickerRaw);

function bodyOf(source: string, declaration: string, span = 2600): string {
  const start = source.indexOf(declaration);
  expect(start, `not found: ${declaration}`).toBeGreaterThan(-1);
  return source.slice(start, start + span);
}

describe('nothing is persisted before confirmation', () => {
  it('each return-create RPC appears exactly once', () => {
    expect(composer.match(/requestDirectReturn\(/g) ?? []).toHaveLength(1);
    expect(composer.match(/recallDirectTransfer\(/g) ?? []).toHaveLength(1);
  });

  it('both create calls live inside confirmAndCreate', () => {
    const body = bodyOf(composer, 'const confirmAndCreate');
    expect(body).toContain('requestDirectReturn(');
    expect(body).toContain('recallDirectTransfer(');
  });

  it('nothing before the confirm handler can create or add a line', () => {
    const before = composer.slice(0, composer.indexOf('const confirmAndCreate'));
    expect(before).not.toContain('requestDirectReturn(');
    expect(before).not.toContain('recallDirectTransfer(');
    expect(before).not.toContain('addDirectReturnLine(');
  });

  it('confirmAndCreate refuses unless the draft is confirmable', () => {
    expect(bodyOf(composer, 'const confirmAndCreate')).toMatch(/if \(!confirmable \|\| committing\) return;/);
  });

  it('the provenance picker performs no writes at all', () => {
    for (const forbidden of ['supabase', '.rpc(', 'requestDirectReturn', 'recallDirectTransfer', 'addDirectReturnLine', 'receiveWarehouseStock']) {
      expect(picker, forbidden).not.toContain(forbidden);
    }
  });
});

describe('provenance is mandatory and free text is impossible', () => {
  it('every added line carries originalTransferLineId', () => {
    expect(composer).toContain('originalTransferLineId: candidate.originalTransferLineId');
  });

  it('the add-line RPC is given provenance as the identity', () => {
    const body = bodyOf(composer, 'const confirmAndCreate');
    expect(body).toContain('originalTransferLineId: line.originalTransferLineId as string');
  });

  it('no free-text material identity input exists in the picker', () => {
    expect(picker).not.toMatch(/setScientificName|scientificName["']?\s*[=:]\s*(?:typed|input|query)/);
  });

  it('the picker never offers arbitrary institution stock', () => {
    // Candidates come from received transfer lines, not from a stock listing.
    expect(picker).not.toContain('getWarehouseStock');
    expect(picker).not.toContain('StockCandidate');
  });

  it('only lines the institution actually RECEIVED become candidates', () => {
    const body = bodyOf(composer, 'const loadCandidates', 3200);
    expect(body).toContain('l.receivedQuantity !== null && l.receivedQuantity > 0');
  });

  it('candidates with nothing left to return are dropped', () => {
    expect(bodyOf(composer, 'const loadCandidates', 3200)).toContain('computeProvenanceCaps(c).safeReturnable > 0');
  });

  it('there is no OCR anywhere in the return flow', () => {
    for (const source of [composer, picker]) {
      expect(source).not.toMatch(/Ocr|tesseract|extractPharmaFields/);
    }
  });
});

describe('caps are enforced from provenance AND physical stock', () => {
  it('the picker caps the quantity on safeReturnable', () => {
    expect(picker).toContain('computeProvenanceCaps(candidate)');
    expect(picker).toContain('quantity <= caps.safeReturnable');
  });

  it('the draft line records safeReturnable as its maximum', () => {
    expect(composer).toContain('maxQuantity: computeProvenanceCaps(candidate).safeReturnable');
  });

  it('physical stock is joined in so the cap is not provenance-only', () => {
    const body = bodyOf(composer, 'const loadCandidates', 3200);
    expect(body).toContain('getWarehouseStock(warehouseId)');
    expect(body).toContain('stockById.get(l.resultingWarehouseStockId)');
  });

  it('provenance is re-derived before creation', () => {
    expect(bodyOf(composer, 'const enterReview', 600)).toContain('loadCandidates(sourceWarehouseId)');
  });

  it('reads are batched — no N+1 walk over transfers', () => {
    const body = bodyOf(composer, 'const loadCandidates', 3200);
    expect(body).toContain('getIncomingTransferLines(transfers.map(x => x.id))');
    expect(body).not.toMatch(/for\s*\([^)]*of transfers[^)]*\)\s*\{[\s\S]{0,200}await/);
  });
});

describe('risk material stays selectable', () => {
  it('the picker flags risk instead of filtering it out', () => {
    expect(picker).toContain('returnRiskFlags(');
    // No exclusion of expired/damaged/recalled from the candidate list.
    expect(picker).not.toMatch(/filter\([^)]*isExpired|filter\([^)]*expired/);
  });

  it('a reason code is required on every line, with detail for "other"', () => {
    expect(picker).toContain("reasonCode === 'other'");
    expect(picker).toContain('needsText && !reasonText.trim()');
  });
});

describe('both existing modes are preserved and not merged', () => {
  it('request and recall route to their own distinct RPCs', () => {
    const body = bodyOf(composer, 'const confirmAndCreate');
    expect(body).toMatch(/mode === 'recall'/);
    expect(body).toContain('recallDirectTransfer({');
    expect(body).toContain('requestDirectReturn({');
  });
});

describe('partial failure recovery', () => {
  it('retry reloads canonical server lines and matches on provenance', () => {
    const body = bodyOf(composer, 'const retryUnsent');
    expect(body).toContain('getReturnRequestLines(');
    expect(body).toContain("planRetry(lines, serverLines.map");
    expect(body).toContain("'return'");
  });

  it('retry never creates a second return request', () => {
    const body = bodyOf(composer, 'const retryUnsent');
    expect(body).not.toContain('requestDirectReturn(');
    expect(body).not.toContain('recallDirectTransfer(');
  });

  it('a partial result is surfaced with a retry affordance', () => {
    expect(composer).toContain('data-testid="return-partial-failure"');
    expect(composer).toContain('mv_retry_unsent');
  });
});

describe('institution is always shown beside its warehouse', () => {
  it('the review pairs both parties', () => {
    expect((composer.match(/pairedPartyLabel\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('the picker shows the original supply reference for each candidate', () => {
    expect(picker).toContain("t('mv_f_original_supply_reference', lang)");
    expect(picker).toContain('candidate.originalTransferNumber');
  });
});

describe('numbering honesty', () => {
  it('the typed reference is labelled external, and nothing is generated', () => {
    expect(composer).toContain("t('mv_external_reference', lang)");
    expect(composer).toContain("t('mv_external_reference_hint', lang)");
    const assignments = composer.match(/returnNumber:\s*[^,\n]+/g) ?? [];
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) expect(a).toContain('externalReference.trim()');
  });
});
