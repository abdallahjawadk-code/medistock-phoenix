/**
 * PHARMA-OCR-A — catalog matching, identity conflicts and field confidence.
 * Run: npm test -- --run
 */
import { describe, it, expect } from 'vitest';
import {
  matchCatalog, similarity, levenshtein,
  FUZZY_FLOOR, type CatalogMaterial,
} from '../match/catalog-match';
import { assessBatchIdentity, type ExistingBatchIdentity } from '../match/duplicate-identity';
import {
  assessFieldConfidence, orderForReview, combineEvidence, scoreToBand,
  checkExpiryAfterManufacturing, checkQuantityAgainstPackSize,
  REQUIRED_CONFIRMATION_FIELDS,
} from '../confidence';
import type { FieldCandidate } from '../parse/fields';

const material = (over: Partial<CatalogMaterial> & { id: string; scientificName: string }): CatalogMaterial => ({
  tradeName: null, concentration: null, dosageForm: null, unit: null, nationalCode: null, ...over,
});

const CATALOG: CatalogMaterial[] = [
  material({ id: 'm1', scientificName: 'Amoxicillin', concentration: '500 mg', dosageForm: 'Capsule', nationalCode: '1234567' }),
  material({ id: 'm2', scientificName: 'Amoxicillin', concentration: '250 mg', dosageForm: 'Capsule', nationalCode: '1234568' }),
  material({ id: 'm3', scientificName: 'Paracetamol', concentration: '500 mg', dosageForm: 'Tablet', nationalCode: '7654321', tradeName: 'Panadol' }),
  material({ id: 'm4', scientificName: 'أموكسيسيلين', concentration: '500 mg', dosageForm: 'Capsule' }),
];

describe('Catalog matching tiers', () => {
  it('an exact national code wins outright', () => {
    const outcome = matchCatalog({ nationalCode: '7654321', scientificName: 'Amoxicillin' }, CATALOG);
    expect(outcome.kind).toBe('unique');
    expect(outcome.kind === 'unique' && outcome.candidate.material.id).toBe('m3');
    expect(outcome.kind === 'unique' && outcome.candidate.tier).toBe('national_code');
  });

  it('a national-code match reports the disagreeing name as a conflict rather than hiding it', () => {
    const outcome = matchCatalog({ nationalCode: '7654321', scientificName: 'Amoxicillin' }, CATALOG);
    expect(outcome.kind === 'unique' && outcome.candidate.conflictingFields).toContain('scientificName');
  });

  it('an exact scientific name with one catalog entry is unique', () => {
    const outcome = matchCatalog({ scientificName: 'Paracetamol' }, CATALOG);
    expect(outcome.kind).toBe('unique');
    expect(outcome.kind === 'unique' && outcome.candidate.tier).toBe('scientific_exact');
  });

  it('a name shared by several strengths is disambiguated by concentration and form', () => {
    const outcome = matchCatalog(
      { scientificName: 'Amoxicillin', concentration: '250 mg', dosageForm: 'Capsule' },
      CATALOG,
    );
    expect(outcome.kind).toBe('unique');
    expect(outcome.kind === 'unique' && outcome.candidate.material.id).toBe('m2');
  });

  it('a name shared by several strengths with NO discriminator is ambiguous, not a guess', () => {
    const outcome = matchCatalog({ scientificName: 'Amoxicillin' }, CATALOG);
    expect(outcome.kind).toBe('ambiguous');
    expect(outcome.kind === 'ambiguous' && outcome.candidates.length).toBe(2);
  });

  it('matches an Arabic name through orthographic folding', () => {
    const outcome = matchCatalog({ scientificName: 'اموكسيسيلين' }, CATALOG);
    expect(outcome.kind).toBe('unique');
    expect(outcome.kind === 'unique' && outcome.candidate.material.id).toBe('m4');
  });

  it('a near-miss OCR reading falls through to ranked fuzzy', () => {
    const outcome = matchCatalog({ scientificName: 'Paracetamoi' }, CATALOG);
    expect(outcome.kind).toBe('unique');
    expect(outcome.kind === 'unique' && outcome.candidate.material.id).toBe('m3');
    expect(outcome.kind === 'unique' && outcome.candidate.tier).toBe('fuzzy');
  });

  it('matches on trade name when the scientific name was not read', () => {
    const outcome = matchCatalog({ scientificName: 'Panadol' }, CATALOG);
    expect(outcome.kind).toBe('unique');
    expect(outcome.kind === 'unique' && outcome.candidate.material.id).toBe('m3');
  });

  it('returns no_match rather than inventing a material', () => {
    const outcome = matchCatalog({ scientificName: 'Zzzyxwvut' }, CATALOG);
    expect(outcome.kind).toBe('no_match');
  });

  it('returns no_match on an empty catalog instead of erroring', () => {
    expect(matchCatalog({ scientificName: 'Amoxicillin' }, []).kind).toBe('no_match');
  });

  it('returns no_match when there is no identifying signal at all', () => {
    expect(matchCatalog({ concentration: '500 mg' }, CATALOG).kind).toBe('no_match');
  });

  it('a duplicated national code in the catalog is surfaced as ambiguous, not silently won', () => {
    const collided = [...CATALOG, material({ id: 'm5', scientificName: 'Other', nationalCode: '1234567' })];
    const outcome = matchCatalog({ nationalCode: '1234567' }, collided);
    expect(outcome.kind).toBe('ambiguous');
  });

  it('two close fuzzy candidates are ambiguous rather than resolved by a hair', () => {
    const twins = [
      material({ id: 'a', scientificName: 'Cefixime' }),
      material({ id: 'b', scientificName: 'Cefexime' }),
    ];
    const outcome = matchCatalog({ scientificName: 'Cefixim' }, twins);
    expect(outcome.kind).toBe('ambiguous');
  });

  it('similarity and distance behave sanely', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('abc', 'abd')).toBe(1);
    expect(similarity('Amoxicillin', 'Amoxicillin')).toBe(1);
    expect(similarity('Amoxicillin', 'Paracetamol')).toBeLessThan(FUZZY_FLOOR);
  });
});

// ─── Identity conflicts ──────────────────────────────────────────────────────

const existing = (over: Partial<ExistingBatchIdentity> = {}): ExistingBatchIdentity => ({
  warehouseStockId: 's1',
  warehouseId: 'w1',
  scientificName: 'Amoxicillin',
  nationalCode: '1234567',
  batchNumber: 'B4471',
  expiryDate: '2027-06-30',
  onHandQuantity: 100,
  ...over,
});

describe('Duplicate and conflicting stock identity', () => {
  it('flags an exact duplicate and blocks automatic acceptance', () => {
    const assessment = assessBatchIdentity(
      { warehouseId: 'w1', scientificName: 'Amoxicillin', nationalCode: '1234567', batchNumber: 'B4471', expiryDate: '2027-06-30' },
      [existing()],
    );
    expect(assessment.findings[0].kind).toBe('duplicate');
    expect(assessment.blocksAutomaticAccept).toBe(true);
  });

  it('flags the same batch carrying a DIFFERENT expiry as a conflict', () => {
    const assessment = assessBatchIdentity(
      { warehouseId: 'w1', scientificName: 'Amoxicillin', nationalCode: '1234567', batchNumber: 'B4471', expiryDate: '2028-01-31' },
      [existing()],
    );
    expect(assessment.findings.some(f => f.kind === 'expiry_conflict')).toBe(true);
    expect(assessment.blocksAutomaticAccept).toBe(true);
  });

  it('flags the same batch carrying a different national code', () => {
    const assessment = assessBatchIdentity(
      { warehouseId: 'w1', scientificName: 'Amoxicillin', nationalCode: '9999999', batchNumber: 'B4471', expiryDate: '2027-06-30' },
      [existing()],
    );
    expect(assessment.findings.some(f => f.kind === 'national_code_conflict')).toBe(true);
  });

  it('does not flag the same batch in a DIFFERENT warehouse', () => {
    const assessment = assessBatchIdentity(
      { warehouseId: 'w2', scientificName: 'Amoxicillin', nationalCode: '1234567', batchNumber: 'B4471', expiryDate: '2027-06-30' },
      [existing({ warehouseId: 'w1' })],
    );
    expect(assessment.findings).toHaveLength(0);
    expect(assessment.blocksAutomaticAccept).toBe(false);
  });

  it('does not flag a different batch of the same material', () => {
    const assessment = assessBatchIdentity(
      { warehouseId: 'w1', scientificName: 'Amoxicillin', nationalCode: '1234567', batchNumber: 'B9999', expiryDate: '2027-06-30' },
      [existing()],
    );
    expect(assessment.findings).toHaveLength(0);
  });

  it('a clean first-time intake blocks nothing', () => {
    const assessment = assessBatchIdentity(
      { warehouseId: 'w1', scientificName: 'Ibuprofen', nationalCode: '5555555', batchNumber: 'X1', expiryDate: '2028-01-31' },
      [existing()],
    );
    expect(assessment.blocksAutomaticAccept).toBe(false);
  });
});

// ─── Confidence ──────────────────────────────────────────────────────────────

const candidate = (over: Partial<FieldCandidate> = {}): FieldCandidate => ({
  field: 'batchNumber',
  value: 'B4471',
  sourceText: 'B4471',
  matchedLabel: 'lot',
  box: { x0: 0, y0: 0, x1: 10, y1: 10 },
  ocrConfidence: 95,
  corrected: false,
  ...over,
});

describe('Field confidence from separable evidence', () => {
  it('strong evidence across the board reads as high', () => {
    const result = assessFieldConfidence({
      candidate: candidate(),
      formatValid: true,
      catalogAgreement: true,
      crossFieldConsistent: true,
    });
    expect(result.band).toBe('high');
    expect(result.reasons).toHaveLength(0);
  });

  it('an unlabelled value with mediocre OCR drops out of high', () => {
    const result = assessFieldConfidence({
      candidate: candidate({ matchedLabel: null, ocrConfidence: 62 }),
      formatValid: true,
      catalogAgreement: null,
      crossFieldConsistent: null,
    });
    expect(result.band).not.toBe('high');
    expect(result.reasons).toContain('no_label_nearby');
    expect(result.reasons).toContain('low_ocr_confidence');
  });

  it('catalog disagreement forces uncertain regardless of other signals', () => {
    const result = assessFieldConfidence({
      candidate: candidate({ ocrConfidence: 99 }),
      formatValid: true,
      catalogAgreement: false,
      crossFieldConsistent: true,
    });
    expect(result.band).toBe('uncertain');
    expect(result.reasons).toContain('catalog_disagrees');
  });

  it('an ambiguous reading can never be high', () => {
    const result = assessFieldConfidence({
      candidate: candidate({ ocrConfidence: 99, ambiguousAlternatives: ['2027-04-03', '2027-03-04'] }),
      formatValid: true,
      catalogAgreement: true,
      crossFieldConsistent: true,
    });
    expect(result.band).toBe('needs_review');
    expect(result.reasons).toContain('ambiguous_reading');
  });

  it('a format-invalid value can never be high', () => {
    const result = assessFieldConfidence({
      candidate: candidate({ ocrConfidence: 99 }),
      formatValid: false,
      catalogAgreement: true,
      crossFieldConsistent: true,
    });
    expect(result.band).not.toBe('high');
    expect(result.reasons).toContain('format_invalid');
  });

  it('a validator-applied correction is always disclosed', () => {
    const result = assessFieldConfidence({
      candidate: candidate({ corrected: true }),
      formatValid: true,
      catalogAgreement: true,
      crossFieldConsistent: true,
    });
    expect(result.reasons).toContain('ocr_corrected');
  });

  it('inapplicable evidence is excluded from the average, not scored as failure', () => {
    const withNulls = combineEvidence({ ocr: 1, labelProximity: 1, formatValid: 1, catalogAgreement: null, crossField: null });
    expect(withNulls).toBe(1);
  });

  it('bands map from score as documented', () => {
    expect(scoreToBand(0.95)).toBe('high');
    expect(scoreToBand(0.7)).toBe('needs_review');
    expect(scoreToBand(0.3)).toBe('uncertain');
  });

  it('review order puts the least trustworthy fields first', () => {
    const ordered = orderForReview([
      { field: 'notes', band: 'high', evidence: {} as never, reasons: [] },
      { field: 'quantity', band: 'uncertain', evidence: {} as never, reasons: [] },
      { field: 'supplier', band: 'needs_review', evidence: {} as never, reasons: [] },
    ]);
    expect(ordered.map(f => f.field)).toEqual(['quantity', 'supplier', 'notes']);
  });

  it('the critical fields requiring explicit confirmation are exactly the safety-relevant set', () => {
    expect([...REQUIRED_CONFIRMATION_FIELDS].sort()).toEqual(
      ['batchNumber', 'expiryDate', 'nationalCode', 'quantity', 'scientificName', 'unitPrice'].sort(),
    );
  });
});

describe('Cross-field consistency checks', () => {
  it('expiry must follow manufacturing', () => {
    expect(checkExpiryAfterManufacturing('2027-06-30', '2025-01-01')).toBe(true);
    expect(checkExpiryAfterManufacturing('2024-06-30', '2025-01-01')).toBe(false);
  });

  it('returns null — not "consistent" — when a date is missing', () => {
    expect(checkExpiryAfterManufacturing('2027-06-30', null)).toBeNull();
    expect(checkExpiryAfterManufacturing(null, '2025-01-01')).toBeNull();
  });

  it('quantity corroborates when it is a whole number of packs', () => {
    expect(checkQuantityAgainstPackSize(240, 20)).toBe(true);
    expect(checkQuantityAgainstPackSize(241, 20)).toBe(false);
  });

  it('returns null when pack size is unknown or nonsensical', () => {
    expect(checkQuantityAgainstPackSize(240, null)).toBeNull();
    expect(checkQuantityAgainstPackSize(240, 0)).toBeNull();
  });
});
