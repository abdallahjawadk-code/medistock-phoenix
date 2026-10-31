import { describe, expect, it } from 'vitest';
import type { AnnualCatalogMembership, AnnualFieldVersion, AnnualFieldState } from '../annual-catalog.contract';
import { annualScopeKey, assertAnnualMembershipSet, assessAnnualFields, prepareAnnualSelection, reviewAnnualSourceOccurrences } from '../annual-catalog.model';
import { extractAnnualIdentityBlock } from '../annual-catalog-source';
import { cell, simpleInput, structuralInput, SCOPE } from './fixture-helpers';

function candidate() {
  const occurrences = extractAnnualIdentityBlock(simpleInput());
  const review = reviewAnnualSourceOccurrences(SCOPE, occurrences);
  const membership: AnnualCatalogMembership = { scope: { ...SCOPE }, annualItemId: 'annual-a-2026', canonicalItemId: 'legal-a',
    status: 'active', currentFieldVersionId: 'version-a-1', occurrenceKeys: review.occurrenceKeys };
  const version: AnnualFieldVersion = { scope: { ...SCOPE }, annualItemId: membership.annualItemId,
    fieldVersionId: membership.currentFieldVersionId, versionNumber: 1, fields: review.fields };
  return { membership, version, occurrences };
}

describe('annual membership, version and evidence preparation', () => {
  it('keeps matching material witnesses and classifications, without deciding legal identity', () => {
    const occurrences = ['shared-code-oncology', 'shared-code-essential'].flatMap((id) => extractAnnualIdentityBlock(structuralInput(id)));
    const review = reviewAnnualSourceOccurrences(SCOPE, occurrences);
    expect(review.fields.nationalCode).toMatchObject({ state: 'known', value: '04-H00-035' });
    expect(review.fields.unit).toMatchObject({ state: 'known', value: 'bottle' });
    const known = review.fields.nationalCode;
    expect(known.state === 'known' && known.origins).toHaveLength(2);
    expect(occurrences.map((entry) => entry.classification?.label)).toEqual(['oncology-drugs', 'essential-drugs']);
    expect(review.occurrenceKeys).toHaveLength(2);
    expect(review.canonicalIdentity).toBe('unresolved');
    expect(review).not.toHaveProperty('canonicalItemId');
  });

  it('does not silently equate tab/tablet or collapse a matching code over differing fields', () => {
    const occurrences = ['unit-difference-oncology', 'unit-difference-essential'].flatMap((id) => extractAnnualIdentityBlock(structuralInput(id)));
    const review = reviewAnnualSourceOccurrences(SCOPE, occurrences);
    expect(review.fields.nationalCode).toMatchObject({ state: 'known', value: '05-C00-033' });
    expect(review.fields.unit).toMatchObject({ state: 'conflict', alternatives: [{ value: 'tab' }, { value: 'tablet' }] });
    expect(assessAnnualFields(review.fields)).toContainEqual({ field: 'unit', code: 'conflicting_values' });
    expect(review.canonicalIdentity).toBe('unresolved');
  });

  it('retains the missing witness even when another source supplies unit evidence', () => {
    const occurrences = ['missing-unit-oncology-shared', 'present-unit-essential-shared'].flatMap((id) => extractAnnualIdentityBlock(structuralInput(id)));
    const review = reviewAnnualSourceOccurrences(SCOPE, occurrences);
    expect(occurrences[0].fields.unit.state).toBe('missing');
    expect(review.fields.unit).toMatchObject({ state: 'known', value: 'vial' });
    expect(review.sourceIssues).toContainEqual({ occurrenceKey: occurrences[0].occurrenceKey, field: 'unit', reason: 'missing_cell' });
    const value = review.fields.unit;
    expect(value.state === 'known' && value.origins).toEqual([{ kind: 'source', occurrenceKey: occurrences[1].occurrenceKey, field: 'unit' }]);
  });

  it('surfaces differing current and generic national codes as conflict, never prioritizes one silently', () => {
    const input = simpleInput(); input.block.columns.currentNationalCode = { column: 3, expectedHeaderText: 'NEW CODE' };
    input.parsed.workbook!.sheets[0].cells.push(cell(0, 3, 'NEW CODE'), cell(1, 3, '999999-05'));
    const review = reviewAnnualSourceOccurrences(SCOPE, extractAnnualIdentityBlock(input));
    expect(review.fields.nationalCode).toMatchObject({ state: 'conflict', alternatives: [{ value: '000123-04' }, { value: '999999-05' }] });
  });

  it('refuses cross-owner/year evidence and duplicated occurrences before merging fields', () => {
    const { occurrences } = candidate();
    expect(() => reviewAnnualSourceOccurrences({ ...SCOPE, planningYear: 2027 }, occurrences)).toThrow('annual_catalog_scope_mismatch');
    expect(() => reviewAnnualSourceOccurrences({ ...SCOPE, ownerOrgId: 'owner-b' }, occurrences)).toThrow('annual_catalog_scope_mismatch');
    expect(() => reviewAnnualSourceOccurrences(SCOPE, [occurrences[0], occurrences[0]])).toThrow('annual_catalog_duplicate_occurrence');
    expect(() => annualScopeKey({ ...SCOPE, planningYear: 2026.5 })).toThrow('annual_catalog_invalid_scope');
  });

  it('requires explicit owner/year membership and field-version consistency for a selection', () => {
    const { membership, version } = candidate();
    expect(() => prepareAnnualSelection({ ...SCOPE, planningYear: 2027 }, membership, version)).toThrow('annual_catalog_scope_mismatch');
    expect(() => prepareAnnualSelection(SCOPE, membership, { ...version, scope: { ...SCOPE, ownerOrgId: 'owner-b' } })).toThrow('annual_catalog_scope_mismatch');
    expect(() => prepareAnnualSelection(SCOPE, membership, { ...version, fieldVersionId: 'different' })).toThrow('annual_catalog_version_mismatch');
    expect(() => prepareAnnualSelection(SCOPE, membership, { ...version, annualItemId: 'other-material' })).toThrow('annual_catalog_version_mismatch');
  });

  it('prevents two annual records for one lawful item while allowing explicit separate-year membership', () => {
    const { membership } = candidate();
    expect(() => assertAnnualMembershipSet(SCOPE, [membership, { ...membership, annualItemId: 'duplicate-annual' }]))
      .toThrow('annual_catalog_duplicate_canonical_membership');
    expect(() => assertAnnualMembershipSet(SCOPE, [membership, { ...membership, canonicalItemId: 'different-legal' }]))
      .toThrow('annual_catalog_duplicate_annual_item');
    const nextYear = { ...SCOPE, planningYear: 2027 };
    const explicitNext = { ...membership, scope: nextYear, annualItemId: 'annual-a-2027', currentFieldVersionId: 'version-2027-1', occurrenceKeys: [] };
    expect(() => assertAnnualMembershipSet(nextYear, [explicitNext])).not.toThrow();
    expect(() => assertAnnualMembershipSet(nextYear, [membership])).toThrow('annual_catalog_scope_mismatch');
    expect(() => assertAnnualMembershipSet(nextYear, [])).not.toThrow();
  });

  it.each(['preparing', 'retired'] as const)('does not select %s material or unresolved legal identity', (status) => {
    const { membership, version } = candidate();
    expect(() => prepareAnnualSelection(SCOPE, { ...membership, status }, version)).toThrow('annual_catalog_not_selectable');
    expect(() => prepareAnnualSelection(SCOPE, { ...membership, canonicalItemId: null }, version)).toThrow('annual_catalog_not_selectable');
  });

  it('keeps missing and reviewed not-applicable distinct; required units cannot be waived', () => {
    const { membership, version } = candidate();
    expect(version.fields.dosageForm.state).toBe('missing');
    const fields = { ...version.fields, dosageForm: { state: 'not_applicable' as const, reason: 'Supplies profile reviewed', decisionReference: 'decision-form-1' } };
    expect(assessAnnualFields(fields)).toEqual([]);
    expect(assessAnnualFields(fields, ['dosageForm'])).toContainEqual({ field: 'dosageForm', code: 'required_not_applicable' });
    const waived = { ...fields, unit: { state: 'not_applicable' as const, reason: 'Cannot waive unit', decisionReference: 'decision-unit-1' } };
    expect(() => prepareAnnualSelection(SCOPE, membership, { ...version, fields: waived })).toThrow('annual_catalog_fields_unresolved');
    expect(assessAnnualFields({ ...fields, unit: { state: 'missing', reason: 'No source unit' } })).toContainEqual({ field: 'unit', code: 'missing_required' });
    expect(version.fields.dosageForm.state).toBe('missing');
  });

  it('requires reviewed provenance instead of letting a missing/NA flag hide an unexplained edit', () => {
    const { version } = candidate();
    const fields = { ...version.fields,
      dosageForm: { state: 'not_applicable' as const, reason: '', decisionReference: '' },
      unit: { state: 'known' as const, value: 'box', origins: [] },
    };
    expect(assessAnnualFields(fields)).toEqual(expect.arrayContaining([
      { field: 'dosageForm', code: 'invalid_field_state' }, { field: 'unit', code: 'invalid_field_state' },
    ]));
  });

  it('never makes an old code or barcode selectable as a missing national code', () => {
    const input = simpleInput();
    delete input.block.columns.nationalCode;
    input.block.columns.previousNationalCode = { column: 1, expectedHeaderText: 'OLD CODE' };
    input.parsed.workbook!.sheets[0].cells[1].rawValue = 'OLD CODE';
    input.block.columns.barcode = { column: 3, expectedHeaderText: 'Barcode' };
    input.parsed.workbook!.sheets[0].cells.push(cell(0, 3, 'Barcode'), cell(1, 3, '0000001234567'));
    const occurrences = extractAnnualIdentityBlock(input);
    const review = reviewAnnualSourceOccurrences(SCOPE, occurrences);
    expect(review.fields.scientificName.state).toBe('known');
    expect(review.fields.unit.state).toBe('known');
    expect(review.fields.barcode.state).toBe('known');
    expect(assessAnnualFields(review.fields)).toContainEqual({ field: 'nationalCode', code: 'missing_required' });
    const { membership, version } = candidate();
    expect(() => prepareAnnualSelection(SCOPE, { ...membership, occurrenceKeys: review.occurrenceKeys }, { ...version, fields: review.fields })).toThrow('annual_catalog_fields_unresolved');
    expect(assessAnnualFields({ ...review.fields, nationalCode: { state: 'not_applicable', reason: 'Cannot waive national code', decisionReference: 'decision-1' } }))
      .toContainEqual({ field: 'nationalCode', code: 'required_not_applicable' });
  });

  it('blocks field evidence from another canonical item or an occurrence outside this membership', () => {
    const { membership, version } = candidate();
    const other: AnnualFieldState = { state: 'known', value: 'box', origins: [{ kind: 'canonical', canonicalItemId: 'other-item', decisionReference: 'decision-1' }] };
    expect(() => prepareAnnualSelection(SCOPE, membership, { ...version, fields: { ...version.fields, unit: other } })).toThrow('annual_catalog_origin_mismatch');
    expect(() => prepareAnnualSelection(SCOPE, { ...membership, occurrenceKeys: [] }, version)).toThrow('annual_catalog_origin_mismatch');
    const relabelledOldCode: AnnualFieldState = { state: 'known', value: '000123-04', origins: [{ kind: 'source', occurrenceKey: membership.occurrenceKeys[0], field: 'previousNationalCode' }] };
    expect(() => prepareAnnualSelection(SCOPE, membership, { ...version, fields: { ...version.fields, nationalCode: relabelledOldCode } })).toThrow('annual_catalog_origin_mismatch');
  });

  it('returns explicit annual/version/canonical references without creating a quantity or mutating snapshots', () => {
    const { membership, version } = candidate();
    const before = JSON.stringify(version);
    const selection = prepareAnnualSelection(SCOPE, membership, version);
    expect(selection).toEqual({ scope: SCOPE, annualItemId: 'annual-a-2026', fieldVersionId: 'version-a-1', canonicalItemId: 'legal-a' });
    expect(selection).not.toHaveProperty('quantity');
    expect(selection).not.toHaveProperty('beneficiaryId');
    expect(JSON.stringify(version)).toBe(before);
    selection.scope.planningYear = 2027;
    expect(version.scope.planningYear).toBe(2026);
  });
});
