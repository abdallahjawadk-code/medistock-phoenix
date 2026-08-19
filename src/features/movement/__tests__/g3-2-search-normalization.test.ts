/**
 * G3.2 / U3 — one canonical normalizer for human material search.
 *
 * The defect these pin down was not theoretical. `searchStock` lower-cased and
 * nothing else, so an operator typing "أموكسيسيلين" in the supply picker got an
 * empty list while the SAME text in PhoenixMaterialResolver found the material,
 * because the resolver had always used `normalizeSearchText`. Two search boxes
 * disagreeing about whether a material exists is worse than either being wrong
 * consistently: it teaches operators not to trust the one that works.
 *
 * DECISION F is also pinned here: OCR keeps its OWN normalizer. Its input is
 * scanner noise, not typed intent, and forcing the two domains through one
 * function would make each worse at its own job.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { searchStock, type StockCandidate } from '../composer-model';
import { normalizeSearchText } from '@/shared/lib/search-normalize';
import { normalizeForMatching } from '@/features/inventory/ocr/parse/normalize';

const candidate = (over: Partial<StockCandidate> = {}): StockCandidate => ({
  warehouseStockId: 's1',
  centralItemId: 'c1',
  scientificName: 'Amoxicillin',
  tradeName: null,
  concentration: '500mg',
  dosageForm: 'capsule',
  unit: 'box',
  nationalCode: 'NC-1',
  batchNumber: 'B-1',
  internalBatchReference: null,
  expiryDate: '2099-01-01',
  onHandQuantity: 10,
  reservedQuantity: 0,
  availableQuantity: 10,
  ...over,
});

describe('U3 — Arabic orthographic normalization in the supply picker', () => {
  const arabicRow = candidate({ scientificName: 'اموكسيسيلين' });

  it('POSITIVE — a hamza-seat variant finds the row written without it', () => {
    // This is the exact family named in the implementation contract.
    expect(searchStock([arabicRow], 'أموكسيسيلين')).toHaveLength(1);
  });

  it('POSITIVE — the reverse direction matches too', () => {
    const written = candidate({ scientificName: 'أموكسيسيلين' });
    expect(searchStock([written], 'اموكسيسيلين')).toHaveLength(1);
  });

  it('POSITIVE — harakat and tatweel in the query do not prevent a match', () => {
    expect(searchStock([arabicRow], 'اَمــوكسيسيلين')).toHaveLength(1);
  });

  it('POSITIVE — taa marbuta and final yaa fold as the canonical normalizer defines', () => {
    const row = candidate({ scientificName: 'حقنة كبرى' });
    expect(searchStock([row], 'حقنه كبري')).toHaveLength(1);
  });

  it('agrees with the canonical normalizer rather than implementing its own rules', () => {
    // If these two ever disagree the picker has forked the definition again.
    expect(normalizeSearchText('أموكسيسيلين')).toBe(normalizeSearchText('اموكسيسيلين'));
  });
});

describe('U3 — English behaviour is preserved exactly', () => {
  it('stays case-insensitive', () => {
    expect(searchStock([candidate()], 'AMOXICILLIN')).toHaveLength(1);
    expect(searchStock([candidate()], 'amoxicillin')).toHaveLength(1);
  });

  it('still requires EVERY term to match (AND, not OR)', () => {
    const rows = [candidate()];
    expect(searchStock(rows, 'amoxicillin capsule')).toHaveLength(1);
    expect(searchStock(rows, 'amoxicillin tablet')).toHaveLength(0);
  });

  it('still searches every recalled field, not just the scientific name', () => {
    const rows = [candidate()];
    expect(searchStock(rows, 'NC-1')).toHaveLength(1);
    expect(searchStock(rows, 'B-1')).toHaveLength(1);
    expect(searchStock(rows, '500mg')).toHaveLength(1);
    expect(searchStock(rows, '2099-01-01')).toHaveLength(1);
  });

  it('an empty or whitespace-only query returns every candidate, unchanged', () => {
    const rows = [candidate(), candidate({ warehouseStockId: 's2' })];
    expect(searchStock(rows, '')).toHaveLength(2);
    expect(searchStock(rows, '   ')).toHaveLength(2);
  });

  it('a non-matching query returns nothing rather than everything', () => {
    expect(searchStock([candidate()], 'zzzznomatch')).toHaveLength(0);
  });

  it('does not mutate the candidate array it was given', () => {
    const rows = [candidate()];
    const snapshot = [...rows];
    searchStock(rows, 'amox');
    expect(rows).toEqual(snapshot);
  });
});

describe('U3 — identity is never derived from the typed text', () => {
  it('filtering returns the ORIGINAL rows, so identity stays warehouseStockId', () => {
    const rows = [candidate()];
    const [hit] = searchStock(rows, 'amoxicillin');
    expect(hit).toBe(rows[0]);
    expect(hit.warehouseStockId).toBe('s1');
  });
});

describe('DECISION F — OCR normalization stays separate, deliberately', () => {
  const composerSource = readFileSync(
    join(process.cwd(), 'src', 'features', 'movement', 'composer-model.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('the human search path imports the canonical operator normalizer', () => {
    expect(composerSource).toContain("import { normalizeSearchText } from '@/shared/lib/search-normalize'");
  });

  it('the human search path does not fall back to a bare toLowerCase', () => {
    // Scoped to searchStock deliberately. `lineIdentityKey` further up the file
    // also lower-cases, but it is DUPLICATE DETECTION inside an unsent local
    // draft — reached only when a line has neither a stock id nor a provenance
    // id — not material-search normalization. U3 governs the search path; that
    // function is out of its scope and was left exactly as found.
    const executable = composerSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    const start = executable.indexOf('export function searchStock');
    expect(start).toBeGreaterThan(-1);
    const body = executable.slice(start, executable.indexOf('\n}', start));

    expect(body).not.toContain('toLowerCase()');
    expect(body).not.toContain('toLocaleLowerCase()');
    expect(body).toContain('normalizeSearchText');
  });

  it('the OCR normalizer remains a DIFFERENT function serving a different domain', () => {
    expect(normalizeForMatching).not.toBe(normalizeSearchText);
  });

  it('OCR normalization still collapses scanner noise the operator normalizer keeps', () => {
    // Not a claim that either is "better" — a demonstration that the two
    // domains genuinely differ, which is why DECISION F keeps them apart.
    expect(normalizeForMatching('AMOX-500 mg')).not.toBe(normalizeSearchText('AMOX-500 mg'));
  });
});
