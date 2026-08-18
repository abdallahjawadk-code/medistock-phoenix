/**
 * G3.2 / U6 — the OCR catalog adapter carries REAL identity discriminators.
 *
 * The adapter used to zero out `concentration`, `dosageForm` and `nationalCode`
 * and explain in a comment that closing the gap needed a migration. Migration
 * 114 had already added the first two, and owner DECISION A settles the third:
 * `central_items.barcode` IS the catalog's national-code identity. So the fix
 * was never schema work — it was reading columns that already existed.
 *
 * The important half of this file is the NEGATIVE half. Improving a matcher by
 * feeding it real discriminators is legitimate; "improving" it by lowering the
 * bar for certainty is the reward-hacking failure this unit must not commit.
 * Those thresholds are pinned below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { toCatalogMaterials } from '../catalog-adapter';
import {
  matchCatalog, FUZZY_FLOOR, FUZZY_UNIQUE_FLOOR, AMBIGUITY_MARGIN,
} from '../match/catalog-match';
import type { CentralItem } from '@/shared/supabase/services/registry.service';

const item = (over: Partial<CentralItem> = {}): CentralItem => ({
  id: 'c1',
  name: 'Amoxicillin',
  name_ar: 'أموكسيسيلين',
  unit: 'box',
  status: 'active',
  ...over,
});

describe('U6 — 114 catalog detail reaches the matcher', () => {
  it('maps concentration and dosage form from the real columns', () => {
    const [material] = toCatalogMaterials([item({ concentration: '500mg', dosage_form: 'capsule' })]);
    expect(material.concentration).toBe('500mg');
    expect(material.dosageForm).toBe('capsule');
  });

  it('DECISION A — barcode becomes the catalog national-code semantic', () => {
    const [material] = toCatalogMaterials([item({ barcode: 'NC-9001' })]);
    expect(material.nationalCode).toBe('NC-9001');
  });

  it('prefers a real trade_name and falls back to name_ar only when absent', () => {
    expect(toCatalogMaterials([item({ trade_name: 'Amoxil' })])[0].tradeName).toBe('Amoxil');
    expect(toCatalogMaterials([item({ trade_name: null })])[0].tradeName).toBe('أموكسيسيلين');
  });

  it('BOUNDARY — a genuinely absent column stays null; nothing is invented', () => {
    const [material] = toCatalogMaterials([item()]);
    expect(material.concentration).toBeNull();
    expect(material.dosageForm).toBeNull();
    expect(material.nationalCode).toBeNull();
  });

  it('BOUNDARY — blank strings collapse to null rather than becoming empty labels', () => {
    const [material] = toCatalogMaterials([item({ concentration: '  ', dosage_form: '', barcode: '   ' })]);
    expect(material.concentration).toBeNull();
    expect(material.dosageForm).toBeNull();
    expect(material.nationalCode).toBeNull();
  });

  it('still excludes non-active catalog rows', () => {
    expect(toCatalogMaterials([
      item({ id: 'a', status: 'active' }),
      item({ id: 'b', status: 'inactive' }),
      item({ id: 'c', status: 'discontinued' }),
    ]).map(m => m.id)).toEqual(['a']);
  });
});

describe('U6 — real discriminators resolve ambiguity honestly', () => {
  const catalog = toCatalogMaterials([
    item({ id: 'c250', concentration: '250mg', dosage_form: 'capsule' }),
    item({ id: 'c500', concentration: '500mg', dosage_form: 'capsule' }),
  ]);

  it('POSITIVE — a reading that names the strength now resolves to ONE material', () => {
    const outcome = matchCatalog(
      { scientificName: 'Amoxicillin', concentration: '500mg', dosageForm: 'capsule' },
      catalog,
    );
    expect(outcome.kind).toBe('unique');
    if (outcome.kind === 'unique') expect(outcome.candidate.material.id).toBe('c500');
  });

  it('NEGATIVE — a reading WITHOUT the strength stays ambiguous; certainty is not fabricated', () => {
    const outcome = matchCatalog({ scientificName: 'Amoxicillin' }, catalog);
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') expect(outcome.candidates).toHaveLength(2);
  });

  it('NEGATIVE — when the CATALOG lacks the discriminator, ambiguity remains', () => {
    const undiscriminated = toCatalogMaterials([
      item({ id: 'a' }), item({ id: 'b' }),
    ]);
    const outcome = matchCatalog(
      { scientificName: 'Amoxicillin', concentration: '500mg' },
      undiscriminated,
    );
    expect(outcome.kind).toBe('ambiguous');
  });

  it('POSITIVE — tier 1 exact national code now works against a real catalog', () => {
    const coded = toCatalogMaterials([
      item({ id: 'x', barcode: 'NC-1' }),
      item({ id: 'y', name: 'Other', barcode: 'NC-2' }),
    ]);
    const outcome = matchCatalog({ nationalCode: 'NC-2' }, coded);
    expect(outcome.kind).toBe('unique');
    if (outcome.kind === 'unique') {
      expect(outcome.candidate.material.id).toBe('y');
      expect(outcome.candidate.tier).toBe('national_code');
    }
  });

  it('a DUPLICATED national code is surfaced as ambiguous, never silently won', () => {
    const dupes = toCatalogMaterials([
      item({ id: 'x', barcode: 'NC-1' }),
      item({ id: 'y', name: 'Other', barcode: 'NC-1' }),
    ]);
    const outcome = matchCatalog({ nationalCode: 'NC-1' }, dupes);
    expect(outcome.kind).toBe('ambiguous');
  });

  it('an unmatched reading is still no_match — never a newly invented material', () => {
    const outcome = matchCatalog({ scientificName: 'Zzzznotamaterial' }, catalog);
    expect(outcome.kind).toBe('no_match');
  });

  it('an empty catalog can never produce a match', () => {
    expect(matchCatalog({ scientificName: 'Amoxicillin' }, []).kind).toBe('no_match');
  });
});

describe('U6 — ANTI-REWARD-HACKING: certainty thresholds are unchanged', () => {
  it('the fuzzy thresholds still hold their pre-G3.2 values', () => {
    // Lowering any of these would raise the "unique match" rate without making
    // a single match more correct. Changing them requires a separate owner task.
    expect(FUZZY_FLOOR).toBe(0.72);
    expect(FUZZY_UNIQUE_FLOOR).toBe(0.88);
    expect(AMBIGUITY_MARGIN).toBe(0.06);
  });

  it('the adapter contains no threshold, score or confidence logic at all', () => {
    // Comments are stripped: this file's own documentation names the thresholds
    // precisely in order to say it does not touch them, and a naive scan would
    // read that promise as a violation of itself.
    const executable = readFileSync(
      join(process.cwd(), 'src', 'features', 'inventory', 'ocr', 'catalog-adapter.ts'),
      'utf8',
    )
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .toLowerCase();

    for (const forbidden of ['fuzzy', 'score', 'confidence', 'threshold', 'similarity']) {
      expect(executable).not.toContain(forbidden);
    }
  });
});
