/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { T } from '@/shared/i18n/strings';

/**
 * CN-2B CONFORMANCE (M212) — the operational need-line mapping surface.
 *
 * Covers what only a rendered component can prove: both languages, the mandatory
 * reason, that NOTHING can be saved without designated source provenance, that
 * the approved total is the EXACT sum of the designated contributions (no float
 * drift), that a bulk apply previews its exact reach and asks a second time
 * before writing anything, that one ROW may feed several beneficiaries while one
 * CELL feeds one line, that saving into an existing line ADDS to it with the
 * lineage it saw, that a stale or conflicting save is shown as normal localized
 * text, and that deleting a line is a confirmed, reasoned correction.
 *
 * The need-line writes are mocked at the service boundary, so those tests assert
 * the COMPONENT's behaviour; the service's own exactness and error mapping are
 * asserted against a mocked Supabase client below. The server contract itself is
 * proven against a real PostgreSQL in
 * supabase/migrations/__tests__/212-*.dynamic.test.ts, and the real PostgREST
 * transport by tools/e2e-acceptance/m212-postgrest-proof.mjs.
 */

const setNeedLine = vi.fn();
const deleteNeedLine = vi.fn();
const getOrganizations = vi.fn();
const getWarehouses = vi.fn();
const rpc = vi.fn();

vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => { throw new Error('the need-line path must not read tables directly'); },
  },
}));
vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganizations: (...a: unknown[]) => getOrganizations(...a),
}));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({
  getWarehouses: (...a: unknown[]) => getWarehouses(...a),
}));
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  return {
    ...actual,
    setNeedLine: (...a: unknown[]) => setNeedLine(...a),
    deleteNeedLine: (...a: unknown[]) => deleteNeedLine(...a),
  };
});

const { CentralNeedsNeedLinePanel, sumExactDecimals } = await import('../CentralNeedsNeedLinePanel');
const { CentralNeedsError } = await import('../central-needs.service');
const { centralNeedsErrorText } = await import('../central-needs.i18n');

const BENE = '00000000-0000-0000-0000-0000000000b1';
const BENE2 = '00000000-0000-0000-0000-0000000000b2';
const ITEM_A = '00000000-0000-0000-0000-0000000000a1';
const ITEM_B = '00000000-0000-0000-0000-0000000000a2';
const ROW_5 = 'sheet:0:row:5';
const ROW_6 = 'sheet:0:row:6';
const REC_5_FINAL = 'rec-5-final';
const REC_5_REQUESTED = 'rec-5-requested';
const REC_6_FINAL = 'rec-6-final';

const disposition = (entity: string, item = ITEM_A) => ({
  id: `d-${entity}`, importSessionId: 's1', targetEntity: entity,
  decision: 'mapped' as const, centralItemId: item, decisionReason: null,
  decidedAt: '2026-01-01T00:00:00.000Z',
});

const record = (id: string, entity: string, fieldName: string, value: unknown, ordinal: number) => ({
  id, importSessionId: 's1', recordOrdinal: ordinal, targetEntity: entity, fieldName,
  sourceValues: { value }, sourceProvenance: null,
});

const link = (needLineId: string, sourceRecordId: string, designatedQuantity: string,
  importSessionId = 's1', targetEntity = ROW_5, fieldName = 'final') => ({
  needLineId, sourceRecordId, designatedQuantity, appliedOverrideId: null, importSessionId, targetEntity, fieldName,
});

/** A line that already exists for (BENE, ITEM_A, institution-level) — built in ANOTHER session. */
const EXISTING = {
  id: 'nl-0', planRevisionId: 'rev-1', organizationId: 'owner', beneficiaryOrganizationId: BENE,
  targetWarehouseId: null, centralItemId: ITEM_A, approvedQuantity: '0.1', approvedUnit: 'box' as const,
  unitConversionState: 'canonical' as const, sourceUnitText: null, mappingReason: 'earlier session',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const EXISTING_LINK = link('nl-0', 'rec-s0-final', '0.1', 's0', 'sheet:0:row:9', 'final');

type PanelProps = Parameters<typeof CentralNeedsNeedLinePanel>[0];

function renderPanel(lang: 'ar' | 'en', over: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    lang,
    planRevisionId: 'rev-1',
    editable: true,
    dispositions: [disposition(ROW_5), disposition(ROW_6)],
    records: [
      record(REC_5_REQUESTED, ROW_5, 'requested', 900, 1),
      record(REC_5_FINAL, ROW_5, 'final', 120.5, 2),
      record(REC_6_FINAL, ROW_6, 'final', 40, 3),
    ],
    overrides: [],
    needLines: [],
    claimedSources: [],
    onChanged: () => {},
    ...over,
  };
  return render(<CentralNeedsNeedLinePanel {...props} />);
}

async function chooseBeneficiary(id = BENE) {
  // The institution list loads asynchronously; a select cannot hold a value
  // whose <option> has not rendered yet.
  const beneSelect = await screen.findByLabelText(T.cn2b_nl_beneficiary.en);
  await waitFor(() => expect(beneSelect.querySelector(`option[value="${id}"]`)).not.toBeNull());
  fireEvent.change(beneSelect, { target: { value: id } });
  expect((screen.getByLabelText(T.cn2b_nl_beneficiary.en) as HTMLSelectElement).value).toBe(id);
}

/** Tick a candidate record's checkbox by its row · field label. */
function designate(entity: string, fieldName: string) {
  const label = screen.getByText(new RegExp(`${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · ${fieldName}`));
  const box = label.closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement;
  fireEvent.click(box);
  return box;
}

function contributionInput(fieldName: string) {
  return screen.getByLabelText(`${T.cn2b_nl_contribution.en} — ${fieldName}`) as HTMLInputElement;
}

const reasonText = 'reviewer designated the final block';
function fillReason(text = reasonText) {
  fireEvent.change(screen.getByLabelText(T.cn2b_nl_reason.en), { target: { value: text } });
}

function saveAndConfirm() {
  fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
  fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
}

beforeEach(() => {
  setNeedLine.mockReset().mockResolvedValue({
    needLineId: 'nl-1', created: true, sourceLinkCount: 1, addedLinkCount: 1, approvedQuantity: '120.5',
  });
  deleteNeedLine.mockReset().mockResolvedValue({ needLineId: 'nl-0', deletedSourceCount: 1 });
  rpc.mockReset();
  getOrganizations.mockReset().mockResolvedValue([
    { id: BENE, name: 'Beneficiary Hospital', name_ar: 'مستشفى المنتفع', code: 'b1', status: 'active', organizationKind: 'care_institution' },
    { id: BENE2, name: 'Second Hospital', name_ar: 'المستشفى الثاني', code: 'b2', status: 'active', organizationKind: 'care_institution' },
    { id: 'x1', name: 'Authority', name_ar: 'سلطة', code: 'a1', status: 'active', organizationKind: 'pharmacy_department_authority' },
    { id: 'x2', name: 'Inactive Hospital', name_ar: 'معطل', code: 'i1', status: 'inactive', organizationKind: 'care_institution' },
  ]);
  getWarehouses.mockReset().mockResolvedValue([]);
});
afterEach(() => cleanup());

describe('M212 need-line panel — exact decimal arithmetic', () => {
  it('sums contributions exactly, where a float would drift', () => {
    expect(sumExactDecimals(['0.1', '0.2'])).toBe('0.3');
    expect(0.1 + 0.2).not.toBe(0.3); // the reason this helper exists
    expect(sumExactDecimals(['120.1239', '0.0001'])).toBe('120.1240');
    expect(sumExactDecimals(['10', '5.5', '0.25'])).toBe('15.75');
    expect(sumExactDecimals(['12345678901234567.891', '120.1239'])).toBe('12345678901234688.0149');
    expect(sumExactDecimals(['0'])).toBe('0');
    expect(sumExactDecimals([])).toBe('0');
    // An invalid member makes the whole sum invalid rather than silently 0.
    expect(sumExactDecimals(['10', 'abc'])).toBe('');
  });
});

describe('M212 need-line panel — both languages, no leakage', () => {
  it('renders Arabic and English without leaking the other language', async () => {
    renderPanel('en');
    expect(await screen.findByText(T.cn2b_nl_title.en)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_nl_title.ar)).toBeNull();
    cleanup();
    renderPanel('ar');
    expect(await screen.findByText(T.cn2b_nl_title.ar)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_nl_title.en)).toBeNull();
  });

  it('gives every new key a distinct Arabic and English value', () => {
    const keys = Object.keys(T).filter((k) => k.startsWith('cn2b_nl_'));
    expect(keys.length).toBeGreaterThan(30);
    for (const k of keys) {
      const entry = (T as Record<string, { ar: string; en: string }>)[k];
      expect(entry.ar, k).toBeTruthy();
      expect(entry.en, k).toBeTruthy();
      expect(entry.ar, k).not.toBe(entry.en);
    }
  });

  it('offers only LIVE care institutions as beneficiaries', async () => {
    renderPanel('en');
    const select = await screen.findByLabelText(T.cn2b_nl_beneficiary.en);
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    expect(select.textContent).toContain('Beneficiary Hospital');
    expect(select.textContent).not.toContain('Authority');
    expect(select.textContent).not.toContain('Inactive Hospital');
  });

  it('offers only ACTIVE warehouses of the chosen beneficiary', async () => {
    getWarehouses.mockResolvedValue([
      { id: 'w1', name: 'Live store', name_ar: 'مخزن فعال', status: 'active' },
      { id: 'w2', name: 'Archived store', name_ar: 'مخزن مؤرشف', status: 'archived' },
      { id: 'w3', name: 'Inactive store', name_ar: 'مخزن معطل', status: 'inactive' },
    ]);
    renderPanel('en');
    await chooseBeneficiary();
    const select = screen.getByLabelText(T.cn2b_nl_warehouse.en);
    await waitFor(() => expect(select.textContent).toContain('Live store'));
    expect(getWarehouses).toHaveBeenCalledWith(BENE);
    expect(select.textContent).not.toContain('Archived store');
    expect(select.textContent).not.toContain('Inactive store');
  });
});

describe('M212 need-line panel — provenance is mandatory', () => {
  it('cannot save with ZERO designated source records', async () => {
    renderPanel('en');
    await chooseBeneficiary();
    fillReason();
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
    expect(screen.queryByTestId('cn2b-nl-preview')).toBeNull();
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('enables saving once a record is designated, and sends that exact record and an empty expected lineage', async () => {
    renderPanel('en');
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    fillReason();
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeEnabled();
    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    const call = setNeedLine.mock.calls[0][0];
    expect(call.quantitySources).toEqual([
      { sourceRecordId: REC_5_FINAL, designatedQuantity: '120.5', appliedOverrideId: null },
    ]);
    expect(call.expectedSourceRecordIds).toEqual([]);
    expect(call.approvedQuantity).toBe('120.5');
    expect(call.centralItemId).toBe(ITEM_A);
    expect(call.beneficiaryOrganizationId).toBe(BENE);
    expect(call.mappingReason).toBe(reasonText);
  });

  it('prefills the imported value as a SUGGESTION the reviewer can replace', async () => {
    renderPanel('en');
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    expect(contributionInput('final').value).toBe('120.5');
    fireEvent.change(contributionInput('final'), { target: { value: '99' } });
    fillReason();
    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalled());
    expect(setNeedLine.mock.calls[0][0].quantitySources[0].designatedQuantity).toBe('99');
    expect(setNeedLine.mock.calls[0][0].approvedQuantity).toBe('99');
  });

  it('offers no designation for a row no one has mapped', async () => {
    renderPanel('en', {
      dispositions: [{ ...disposition(ROW_5), decision: 'not_applicable', centralItemId: null }],
    });
    await chooseBeneficiary();
    expect(screen.getByTestId('cn2b-nl-no-candidates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
  });

  it('offers no designation for a CELL any line of the revision already claims', async () => {
    renderPanel('en', { claimedSources: [link('nl-0', REC_5_FINAL, '120.5')] });
    await chooseBeneficiary();
    const candidates = screen.getByTestId('cn2b-nl-candidates');
    expect(within(candidates).queryByText(new RegExp(`${ROW_5} · final`))).toBeNull();
    // ...but the SAME ROW's other cell stays available: a row may feed several lines.
    expect(within(candidates).getByText(new RegExp(`${ROW_5} · requested`))).toBeInTheDocument();
  });
});

describe('M212 need-line panel — one row, several beneficiaries (C1)', () => {
  it('lets the second institution cell of a row go to a DIFFERENT beneficiary', async () => {
    const hospitalCells = [
      record('rec-a', ROW_5, 'مستشفى أ', 30, 1),
      record('rec-b', ROW_5, 'مستشفى ب', 45, 2),
    ];
    const lineA = { ...EXISTING, id: 'nl-a', approvedQuantity: '30' };
    renderPanel('en', {
      dispositions: [disposition(ROW_5)],
      records: hospitalCells,
      needLines: [lineA],
      claimedSources: [link('nl-a', 'rec-a', '30', 's1', ROW_5, 'مستشفى أ')],
    });
    await chooseBeneficiary(BENE2);
    // Scoped to the CANDIDATES: the claimed cell must not be designatable, while
    // the existing line's lineage below legitimately still names it.
    const candidates = screen.getByTestId('cn2b-nl-candidates');
    expect(within(candidates).queryByText(new RegExp(`${ROW_5} · مستشفى أ`))).toBeNull();
    expect(within(screen.getByTestId('cn2b-nl-lineage')).getByText(new RegExp(`${ROW_5} · مستشفى أ`))).toBeInTheDocument();
    designate(ROW_5, 'مستشفى ب');
    fillReason('second hospital column');
    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    const call = setNeedLine.mock.calls[0][0];
    expect(call.beneficiaryOrganizationId).toBe(BENE2);
    expect(call.quantitySources).toEqual([{ sourceRecordId: 'rec-b', designatedQuantity: '45', appliedOverrideId: null }]);
    // A different beneficiary is a different scope: a new line, not an addition to BENE's.
    expect(call.expectedSourceRecordIds).toEqual([]);
    expect(call.approvedQuantity).toBe('45');
  });
});

describe('M212 need-line panel — revision-wide provenance (Q1)', () => {
  it('shows an existing line’s whole lineage, marking cells from another import session', async () => {
    renderPanel('en', { needLines: [EXISTING], claimedSources: [EXISTING_LINK] });
    const lineage = await screen.findByTestId('cn2b-nl-lineage');
    expect(lineage).toHaveTextContent('sheet:0:row:9 · final = 0.1');
    expect(lineage).toHaveTextContent(T.cn2b_nl_other_session.en);
  });

  it('ADDS to the existing line of the same scope: the lineage it saw, the exact combined total, the line’s own unit', async () => {
    renderPanel('en', { needLines: [EXISTING], claimedSources: [EXISTING_LINK] });
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    fireEvent.change(contributionInput('final'), { target: { value: '0.2' } });
    // Changing the form's unit does not re-interpret the existing designations.
    fireEvent.change(screen.getByLabelText(T.cn2b_nl_unit.en), { target: { value: 'vial' } });
    fillReason('later session adds its cell');
    expect(screen.getByTestId('cn2b-nl-total')).toHaveTextContent(`${ITEM_A}=0.3`);
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
    const group = screen.getByTestId('cn2b-nl-preview-group');
    expect(group).toHaveAttribute('data-existing', 'true');
    expect(group).toHaveTextContent(T.cn2b_nl_adds_to_existing.en);
    expect(screen.getByTestId('cn2b-nl-unit-locked')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    const call = setNeedLine.mock.calls[0][0];
    expect(call.expectedSourceRecordIds).toEqual(['rec-s0-final']);
    expect(call.approvedQuantity).toBe('0.3');
    expect(call.quantitySources).toEqual([{ sourceRecordId: REC_5_FINAL, designatedQuantity: '0.2', appliedOverrideId: null }]);
    expect(call.approvedUnit).toBe('box');
    expect(call.unitConversionState).toBe('canonical');
  });

  it('shows a STALE refusal as normal localized text and reloads the revision', async () => {
    setNeedLine.mockRejectedValueOnce(new CentralNeedsError('need_line_lineage_stale', 'need_line_lineage_stale'));
    const onChanged = vi.fn();
    renderPanel('en', { onChanged });
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    fillReason();
    saveAndConfirm();
    const alert = await screen.findByTestId('cn2b-nl-error');
    expect(alert).toHaveTextContent(T.cn2b_err_need_line_lineage_stale.en);
    expect(alert.textContent).not.toContain('need_line_lineage_stale');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('shows an already-linked cell as normal localized text — never duplicate / 23505 / a constraint name', async () => {
    setNeedLine.mockRejectedValueOnce(new CentralNeedsError('source_record_already_linked', 'source_record_already_linked'));
    renderPanel('en');
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    fillReason();
    saveAndConfirm();
    const alert = await screen.findByTestId('cn2b-nl-error');
    expect(alert).toHaveTextContent(T.cn2b_err_source_record_already_linked.en);
    expect(alert.textContent).not.toMatch(/duplicate|23505|_record_key|source_record_id/);
  });
});

describe('M212 need-line panel — the explicit correction path (Q3)', () => {
  it('deletes a line only after confirmation and a reason, sending the lineage it saw', async () => {
    const onChanged = vi.fn();
    renderPanel('en', { needLines: [EXISTING], claimedSources: [EXISTING_LINK], onChanged });
    const line = await screen.findByTestId('cn2b-nl-line');
    fireEvent.click(within(line).getByRole('button', { name: T.cn2b_nl_delete.en }));
    const confirm = screen.getByTestId('cn2b-nl-delete-confirm');
    expect(confirm).toHaveTextContent(T.cn2b_nl_delete_explainer.en);
    const go = within(confirm).getByRole('button', { name: T.cn2b_nl_delete_confirm.en });
    expect(go).toBeDisabled();
    expect(within(confirm).getByText(T.cn2b_nl_delete_reason_required.en)).toBeInTheDocument();
    fireEvent.change(within(confirm).getByLabelText(T.cn2b_nl_delete_reason.en), { target: { value: '  wrong beneficiary  ' } });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(deleteNeedLine).toHaveBeenCalledTimes(1));
    expect(deleteNeedLine).toHaveBeenCalledWith({
      needLineId: 'nl-0', reason: 'wrong beneficiary', expectedSourceRecordIds: ['rec-s0-final'],
    });
    expect(await screen.findByTestId('cn2b-nl-notice')).toHaveTextContent(T.cn2b_nl_deleted.en);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('deletes nothing when the confirmation is cancelled', async () => {
    renderPanel('en', { needLines: [EXISTING], claimedSources: [EXISTING_LINK] });
    const line = await screen.findByTestId('cn2b-nl-line');
    fireEvent.click(within(line).getByRole('button', { name: T.cn2b_nl_delete.en }));
    fireEvent.change(screen.getByLabelText(T.cn2b_nl_delete_reason.en), { target: { value: 'x' } });
    fireEvent.click(within(screen.getByTestId('cn2b-nl-delete-confirm')).getByRole('button', { name: T.cn2b_nl_bulk_cancel.en }));
    expect(screen.queryByTestId('cn2b-nl-delete-confirm')).toBeNull();
    expect(deleteNeedLine).not.toHaveBeenCalled();
  });

  it('offers no deletion on a closed revision', async () => {
    renderPanel('en', { editable: false, needLines: [EXISTING], claimedSources: [EXISTING_LINK] });
    const line = await screen.findByTestId('cn2b-nl-line');
    expect(within(line).queryByRole('button', { name: T.cn2b_nl_delete.en })).toBeNull();
  });

  it('shows a refused deletion as localized text', async () => {
    deleteNeedLine.mockRejectedValueOnce(new CentralNeedsError('plan_revision_not_editable', 'plan_revision_not_editable'));
    renderPanel('en', { needLines: [EXISTING], claimedSources: [EXISTING_LINK] });
    const line = await screen.findByTestId('cn2b-nl-line');
    fireEvent.click(within(line).getByRole('button', { name: T.cn2b_nl_delete.en }));
    fireEvent.change(screen.getByLabelText(T.cn2b_nl_delete_reason.en), { target: { value: 'r' } });
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_delete_confirm.en }));
    expect(await screen.findByTestId('cn2b-nl-error'))
      .toHaveTextContent(centralNeedsErrorText('plan_revision_not_editable', 'en'));
  });
});

describe('M212 need-line panel — the quantity contract', () => {
  it('accepts zero, and treats blank as NOT zero', async () => {
    renderPanel('en');
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    fillReason();
    fireEvent.change(contributionInput('final'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeEnabled();
    fireEvent.change(contributionInput('final'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('refuses a negative contribution', async () => {
    renderPanel('en');
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    fillReason();
    fireEvent.change(contributionInput('final'), { target: { value: '-5' } });
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    expect(screen.getByText(T.cn2b_nl_contribution_invalid.en)).toBeInTheDocument();
  });

  it('keeps a high-scale decimal EXACT, end to end, with no rounding', async () => {
    renderPanel('en');
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    designate(ROW_5, 'requested');
    fireEvent.change(contributionInput('final'), { target: { value: '120.1239' } });
    fireEvent.change(contributionInput('requested'), { target: { value: '0.0001' } });
    fillReason();
    expect(screen.getByTestId('cn2b-nl-total')).toHaveTextContent('120.1240');
    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalled());
    const call = setNeedLine.mock.calls[0][0];
    expect(call.approvedQuantity).toBe('120.1240');
    expect(call.quantitySources.map((s: { designatedQuantity: string }) => s.designatedQuantity))
      .toEqual(['120.1239', '0.0001']);
    expect(typeof call.approvedQuantity).toBe('string');
    for (const s of call.quantitySources) expect(typeof s.designatedQuantity).toBe('string');
  });

  it('sends a NULL unit when the conversion cannot be made', async () => {
    renderPanel('en');
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    fillReason();
    fireEvent.click(screen.getByLabelText(T.cn2b_nl_unit_conversion_required.en));
    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalled());
    expect(setNeedLine.mock.calls[0][0].approvedUnit).toBeNull();
    expect(setNeedLine.mock.calls[0][0].unitConversionState).toBe('conversion_required');
  });
});

describe('M212 need-line panel — mandatory reason', () => {
  it('will not save without a mapping justification', async () => {
    renderPanel('en');
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    expect(screen.getByText(T.cn2b_nl_reason_required.en)).toBeInTheDocument();
    fillReason();
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeEnabled();
  });
});

describe('M212 need-line panel — a bulk action is still an explicit act', () => {
  it('previews the exact counts and writes nothing until confirmed', async () => {
    renderPanel('en', {
      dispositions: [disposition(ROW_5, ITEM_A), disposition(ROW_6, ITEM_B)],
    });
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    designate(ROW_6, 'final');
    fillReason();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_preview.en }));
    expect(screen.getByTestId('cn2b-nl-affected')).toHaveTextContent('2');
    expect(screen.getByTestId('cn2b-nl-lines')).toHaveTextContent('2');
    expect(setNeedLine).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(2));
    const items = setNeedLine.mock.calls.map((c) => c[0].centralItemId).sort();
    expect(items).toEqual([ITEM_A, ITEM_B].sort());
  });

  it('writes nothing when the preview is cancelled', async () => {
    renderPanel('en');
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    fillReason();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
    expect(screen.getByTestId('cn2b-nl-preview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_cancel.en }));
    expect(screen.queryByTestId('cn2b-nl-preview')).toBeNull();
    expect(setNeedLine).not.toHaveBeenCalled();
  });
});

describe('M212 need-line panel — read-only and completeness', () => {
  it('offers no editing on a closed revision', async () => {
    renderPanel('en', { editable: false });
    expect(await screen.findByTestId('cn2b-nl-readonly')).toBeInTheDocument();
    expect(screen.queryByLabelText(T.cn2b_nl_beneficiary.en)).toBeNull();
    expect(screen.queryByRole('button', { name: T.cn2b_nl_save.en })).toBeNull();
  });

  it('reports the active session’s mapping completeness from the claimed rows', async () => {
    renderPanel('en', { claimedSources: [link('nl-1', REC_5_FINAL, '120.5')] });
    expect(await screen.findByTestId('cn2b-nl-completeness')).toHaveTextContent('1/2');
    cleanup();
    renderPanel('en', {
      claimedSources: [
        link('nl-1', REC_5_FINAL, '120.5'),
        link('nl-2', REC_6_FINAL, '40', 's1', ROW_6),
        // A cell of ANOTHER session does not count toward this session.
        link('nl-3', 'rec-s0', '1', 's0', ROW_6),
      ],
    });
    const state = await screen.findByTestId('cn2b-nl-completeness');
    expect(state).toHaveTextContent(T.cn2b_nl_complete.en);
    expect(state).toHaveTextContent('2/2');
  });
});

describe('M212 service — the exact read and the domain refusals', () => {
  const actual = () => vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');

  it('reads through the exact-decimal RPC and keeps every quantity a string, decoded exactly as supabase-js decodes', async () => {
    // The body PostgREST returns for the RPC: both quantities are JSON STRINGS.
    const body = JSON.stringify([
      {
        id: 'nl-big', plan_revision_id: 'rev-1', organization_id: 'o', beneficiary_organization_id: BENE,
        target_warehouse_id: null, central_item_id: ITEM_A, approved_quantity: '12345678901234688.0149',
        approved_unit: 'box', unit_conversion_state: 'canonical', source_unit_text: null,
        mapping_reason: 'r', updated_at: '2026-01-01T00:00:00Z',
        sources: [
          { source_record_id: 'r1', designated_quantity: '12345678901234567.891', applied_override_id: null,
            import_session_id: 's1', target_entity: ROW_5, field_name: 'final' },
          { source_record_id: 'r2', designated_quantity: '120.1239', applied_override_id: null,
            import_session_id: 's2', target_entity: ROW_6, field_name: 'final' },
        ],
      },
      {
        id: 'nl-small', plan_revision_id: 'rev-1', organization_id: 'o', beneficiary_organization_id: BENE2,
        target_warehouse_id: null, central_item_id: ITEM_A, approved_quantity: '0.3',
        approved_unit: 'box', unit_conversion_state: 'canonical', source_unit_text: null,
        mapping_reason: 'r', updated_at: '2026-01-01T00:00:00Z',
        sources: [
          { source_record_id: 'r3', designated_quantity: '0.1', applied_override_id: null,
            import_session_id: 's1', target_entity: ROW_5, field_name: 'a' },
          { source_record_id: 'r4', designated_quantity: '0.2', applied_override_id: null,
            import_session_id: 's1', target_entity: ROW_5, field_name: 'b' },
          { source_record_id: 'r5', designated_quantity: '0', applied_override_id: null,
            import_session_id: 's1', target_entity: ROW_5, field_name: 'c' },
        ],
      },
    ]);
    rpc.mockResolvedValue({ data: JSON.parse(body), error: null });
    const { listNeedLineLineage } = await actual();
    const { needLines, sources } = await listNeedLineLineage('rev-1');
    expect(rpc).toHaveBeenCalledWith('phoenix_central_needs_list_need_lines', { p_plan_revision_id: 'rev-1' });
    expect(needLines.map((n) => n.approvedQuantity)).toEqual(['12345678901234688.0149', '0.3']);
    expect(sources.map((s) => s.designatedQuantity)).toEqual(['12345678901234567.891', '120.1239', '0.1', '0.2', '0']);
    expect(sources[1]).toMatchObject({ needLineId: 'nl-big', importSessionId: 's2', targetEntity: ROW_6, fieldName: 'final' });
  });

  it('REFUSES a quantity that arrived as a JSON number — it has already been rounded', async () => {
    const roundedByParse = JSON.parse('[{"id":"x","approved_quantity":12345678901234567.891,"sources":[]}]');
    expect(String(roundedByParse[0].approved_quantity)).not.toBe('12345678901234567.891');
    rpc.mockResolvedValue({ data: roundedByParse, error: null });
    const { listNeedLineLineage } = await actual();
    await expect(listNeedLineLineage('rev-1')).rejects.toMatchObject({ code: 'need_line_quantity_not_exact' });
  });

  it('sends the expected lineage and exact strings on a save, and the reason and lineage on a delete', async () => {
    rpc.mockResolvedValue({ data: { need_line_id: 'nl-9', created: false, source_link_count: 2, added_link_count: 1, approved_quantity: '0.3' }, error: null });
    const svc = await actual();
    const out = await svc.setNeedLine({
      planRevisionId: 'rev-1', beneficiaryOrganizationId: BENE, centralItemId: ITEM_A,
      approvedQuantity: '0.3', mappingReason: 'r',
      quantitySources: [{ sourceRecordId: 'r4', designatedQuantity: '0.2' }],
      expectedSourceRecordIds: ['r3'], approvedUnit: 'box',
    });
    expect(rpc).toHaveBeenLastCalledWith('phoenix_central_needs_set_need_line', expect.objectContaining({
      p_approved_quantity: '0.3',
      p_expected_source_record_ids: ['r3'],
      p_quantity_sources: [{ sourceRecordId: 'r4', designatedQuantity: '0.2', appliedOverrideId: null }],
    }));
    expect(out).toMatchObject({ needLineId: 'nl-9', created: false, addedLinkCount: 1, approvedQuantity: '0.3' });

    rpc.mockResolvedValue({ data: { ok: true, need_line_id: 'nl-9', deleted_source_count: 2 }, error: null });
    const del = await svc.deleteNeedLine({ needLineId: 'nl-9', reason: 'wrong', expectedSourceRecordIds: ['r3', 'r4'] });
    expect(rpc).toHaveBeenLastCalledWith('phoenix_central_needs_delete_need_line', {
      p_need_line_id: 'nl-9', p_reason: 'wrong', p_expected_source_record_ids: ['r3', 'r4'],
    });
    expect(del).toEqual({ needLineId: 'nl-9', deletedSourceCount: 2 });
  });

  it('turns a server domain refusal into its stable code and localized text', async () => {
    // What PostgREST returns for the translated conflict: the domain name, not the raw constraint.
    rpc.mockResolvedValue({
      data: null,
      error: { code: '23514', message: 'source_record_already_linked', details: 'source_record=r1 need_line=nl-0' },
    });
    const svc = await actual();
    const refused = await svc.setNeedLine({
      planRevisionId: 'rev-1', beneficiaryOrganizationId: BENE, centralItemId: ITEM_A,
      approvedQuantity: '1', mappingReason: 'r',
      quantitySources: [{ sourceRecordId: 'r1', designatedQuantity: '1' }], expectedSourceRecordIds: [],
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CentralNeedsError);
    expect((refused as { code: string }).code).toBe('source_record_already_linked');
    const text = centralNeedsErrorText((refused as { code: string }).code, 'ar');
    expect(text).toBe(T.cn2b_err_source_record_already_linked.ar);
    for (const code of ['need_line_scope_conflict', 'need_line_lineage_stale', 'need_line_attributes_conflict',
      'need_line_deletion_reason_required', 'target_warehouse_not_active']) {
      expect(centralNeedsErrorText(code, 'en'), code).not.toBe(code);
      expect(centralNeedsErrorText(code, 'ar'), code).not.toBe(code);
    }
  });
});

describe('M212 — the client never becomes the authority', () => {
  const SERVICE = readFileSync(
    join(__dirname, '..', 'central-needs.service.ts'), 'utf8');
  const PANEL = readFileSync(
    join(__dirname, '..', 'CentralNeedsNeedLinePanel.tsx'), 'utf8');

  it('writes and reads need lines only through the canonical RPCs', () => {
    expect(SERVICE).toContain("supabase.rpc('phoenix_central_needs_set_need_line'");
    expect(SERVICE).toContain("supabase.rpc('phoenix_central_needs_delete_need_line'");
    expect(SERVICE).toContain("supabase.rpc('phoenix_central_needs_list_need_lines'");
    // No table access at all: a write would bypass the RPCs, and a read would
    // hand PostgREST's JSON numbers to JSON.parse.
    expect(SERVICE).not.toContain(".from('central_needs_need_lines')");
    expect(SERVICE).not.toContain(".from('central_needs_need_line_sources')");
  });

  it('never turns a missing lineage or expected lineage into an empty array on the way out', () => {
    expect(SERVICE).toContain('quantitySources: NeedLineQuantitySource[];');
    expect(SERVICE).toContain('p_quantity_sources: input.quantitySources.map(');
    expect((SERVICE.match(/expectedSourceRecordIds: string\[\];/g) ?? []).length).toBe(2);
    expect(SERVICE).toContain('p_expected_source_record_ids: input.expectedSourceRecordIds,');
    for (const field of ['quantitySources', 'expectedSourceRecordIds']) {
      expect(SERVICE).not.toMatch(new RegExp(`${field}\\s*\\?\\?\\s*\\[\\]`));
      expect(SERVICE).not.toMatch(new RegExp(`${field}\\s*\\|\\|\\s*\\[\\]`));
      expect(SERVICE).not.toMatch(new RegExp(`${field}\\?:`));
    }
  });

  it('chooses no material of its own — it reads each row’s existing mapping', () => {
    expect(PANEL).toContain('mappedItemByEntity');
    expect(PANEL).not.toContain('searchCentralItems');
    expect(PANEL).not.toContain('setCentralItemId');
  });

  it('infers no beneficiary from workbook shape — mapping stays human', () => {
    for (const heuristic of [
      'all_institutions_annual_needs', 'individual_institution_annual_needs',
      'INSTITUTION_HEADER_HINTS', 'sheetName', 'detectFamily',
    ]) {
      expect(PANEL, heuristic).not.toContain(heuristic);
    }
  });

  it('keeps the canonical unit vocabulary identical to the migration', () => {
    const sql = readFileSync(
      join(__dirname, '../../../../supabase/migrations/212_phoenix_central_needs_need_lines.sql'), 'utf8');
    for (const u of ['box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other']) {
      expect(SERVICE, u).toContain(`'${u}'`);
      expect(sql, u).toContain(`'${u}'`);
    }
  });
});
