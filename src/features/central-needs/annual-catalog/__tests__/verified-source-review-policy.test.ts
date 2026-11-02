import { describe, expect, it } from 'vitest';
import { extractAnnualIdentityBlock } from '../annual-catalog-source';
import { simpleInput } from './fixture-helpers';
import { canReviewSourceRow, sourceRowsMatchCanonical } from '../verified-source-review-policy';
import type { AnnualCanonicalSnapshot } from '../annual-catalog-server.contract';
const row = () => extractAnnualIdentityBlock(simpleInput())[0];
const canonical: AnnualCanonicalSnapshot = { canonicalItemId: 'canonical', scientificName: 'Amoxicillin 500 mg', nameAr: null,
  nationalCode: '000123-04', barcode: null, dosageForm: null, concentration: null, unit: 'box', status: 'active' };
describe('source review affordance; exact comparison, never authorization', () => {
  it('keeps unknown classification explicit and accepts otherwise matching witnesses', () => {
    expect(canReviewSourceRow(row(), [])).toBe(true); expect(sourceRowsMatchCanonical([row()], canonical)).toBe(true);
  });
  it.each([{ unit: 'Box' }, { nationalCode: '123-04' }, { scientificName: 'Other material' }, { concentration: '500 mg' }])('holds identity differences without normalizing or filling values: %j', patch => {
    expect(sourceRowsMatchCanonical([row()], { ...canonical, ...patch })).toBe(false);
  });
  it('never repairs invalid or missing required evidence with the canonical dropdown', () => {
    const missing = row(); missing.fields.unit = { state: 'missing', reason: 'unmapped', witness: null };
    expect(canReviewSourceRow(missing, [])).toBe(false);
    const invalid = row(), witness = invalid.fields.scientificName.witness; if (!witness) throw new Error('Fixture lacks witness');
    invalid.fields.nameAr = { state: 'invalid', reason: 'formula', witness };
    expect(canReviewSourceRow(invalid, [])).toBe(false); expect(sourceRowsMatchCanonical([invalid], canonical)).toBe(false);
  });
  it('holds a proposed classification and does not infer it from another row', () => {
    const candidate = row(); candidate.classification = { label: 'Synthetic', origin: 'proposed', reference: 'manual' };
    expect(canReviewSourceRow(candidate, [])).toBe(false);
  });
});
