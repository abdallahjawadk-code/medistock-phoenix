/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { T } from '@/shared/i18n/strings';

/**
 * CN-2B CONFORMANCE (M212) — the operational need-line mapping surface.
 *
 * Covers what only a rendered component can prove: both languages, the mandatory
 * reason, that NOTHING can be saved without designated source provenance, that
 * the approved total is the EXACT sum of the designated contributions (no float
 * drift), and that a bulk apply previews its exact reach and asks a second time
 * before writing anything.
 *
 * The service module is mocked at the boundary, so these tests assert the
 * COMPONENT's behaviour. The server contract itself is proven against a real
 * PostgreSQL in supabase/migrations/__tests__/212-*.dynamic.test.ts — a mocked
 * RPC could never prove authorization, a CHECK or the provenance sum — and the
 * real PostgREST transport is proven by the disposable-Supabase E2E phase.
 */

const setNeedLine = vi.fn();
const getOrganizations = vi.fn();
const getWarehouses = vi.fn();

vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganizations: (...a: unknown[]) => getOrganizations(...a),
}));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({
  getWarehouses: (...a: unknown[]) => getWarehouses(...a),
}));
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  return { ...actual, setNeedLine: (...a: unknown[]) => setNeedLine(...a) };
});

const { CentralNeedsNeedLinePanel, sumExactDecimals } = await import('../CentralNeedsNeedLinePanel');

const BENE = '00000000-0000-0000-0000-0000000000b1';
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
    onSaved: () => {},
    ...over,
  };
  return render(<CentralNeedsNeedLinePanel {...props} />);
}

async function chooseBeneficiary() {
  // The institution list loads asynchronously; a select cannot hold a value
  // whose <option> has not rendered yet.
  const beneSelect = await screen.findByLabelText(T.cn2b_nl_beneficiary.en);
  await waitFor(() => expect(beneSelect.querySelector(`option[value="${BENE}"]`)).not.toBeNull());
  fireEvent.change(beneSelect, { target: { value: BENE } });
  expect((screen.getByLabelText(T.cn2b_nl_beneficiary.en) as HTMLSelectElement).value).toBe(BENE);
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

beforeEach(() => {
  setNeedLine.mockReset().mockResolvedValue({
    needLineId: 'nl-1', sourceLinkCount: 1, approvedQuantity: '120.5',
  });
  getOrganizations.mockReset().mockResolvedValue([
    { id: BENE, name: 'Beneficiary Hospital', name_ar: 'مستشفى المنتفع', code: 'b1', status: 'active', organizationKind: 'care_institution' },
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
    expect(keys.length).toBeGreaterThan(20);
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
});

describe('M212 need-line panel — provenance is mandatory', () => {
  it('cannot save with ZERO designated source records', async () => {
    renderPanel('en');
    await chooseBeneficiary();
    fillReason();
    // Everything else is filled in; the only thing missing is the provenance.
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
    expect(screen.queryByTestId('cn2b-nl-preview')).toBeNull();
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('enables saving once a record is designated, and sends that exact record', async () => {
    renderPanel('en');
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    fillReason();
    const save = screen.getByRole('button', { name: T.cn2b_nl_save.en });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    const call = setNeedLine.mock.calls[0][0];
    expect(call.quantitySources).toEqual([
      { sourceRecordId: REC_5_FINAL, designatedQuantity: '120.5', appliedOverrideId: null },
    ]);
    expect(call.approvedQuantity).toBe('120.5');
    expect(call.centralItemId).toBe(ITEM_A);
    expect(call.beneficiaryOrganizationId).toBe(BENE);
    expect(call.mappingReason).toBe(reasonText);
  });

  it('prefills the imported value as a SUGGESTION the reviewer can replace', async () => {
    renderPanel('en');
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    // Suggested from the record itself...
    expect(contributionInput('final').value).toBe('120.5');
    // ...and freely replaced: a suggestion is not an approval.
    fireEvent.change(contributionInput('final'), { target: { value: '99' } });
    fillReason();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
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

  it('offers no designation for a record another need line already claims', async () => {
    renderPanel('en', {
      claimedSources: [
        { needLineId: 'nl-0', sourceRecordId: REC_5_FINAL, designatedQuantity: '120.5', appliedOverrideId: null },
      ],
    });
    await chooseBeneficiary();
    expect(screen.queryByText(new RegExp(`${ROW_5} · final`))).toBeNull();
    expect(screen.getByText(new RegExp(`${ROW_5} · requested`))).toBeInTheDocument();
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
    // The displayed total is the exact sum, not a float's idea of it.
    expect(screen.getByTestId('cn2b-nl-total')).toHaveTextContent('120.1240');
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(setNeedLine).toHaveBeenCalled());
    const call = setNeedLine.mock.calls[0][0];
    expect(call.approvedQuantity).toBe('120.1240');
    expect(call.quantitySources.map((s: { designatedQuantity: string }) => s.designatedQuantity))
      .toEqual(['120.1239', '0.0001']);
    // Every number leaving this component is a string, never a JS number.
    expect(typeof call.approvedQuantity).toBe('string');
    for (const s of call.quantitySources) expect(typeof s.designatedQuantity).toBe('string');
  });

  it('sends a NULL unit when the conversion cannot be made', async () => {
    renderPanel('en');
    await chooseBeneficiary();
    designate(ROW_5, 'final');
    fillReason();
    fireEvent.click(screen.getByLabelText(T.cn2b_nl_unit_conversion_required.en));
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
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
    // Two materials among the designations => two need lines.
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

  it('reports mapping completeness from the claimed rows', async () => {
    renderPanel('en', {
      claimedSources: [
        { needLineId: 'nl-1', sourceRecordId: REC_5_FINAL, designatedQuantity: '120.5', appliedOverrideId: null },
      ],
    });
    expect(await screen.findByTestId('cn2b-nl-completeness')).toHaveTextContent('1/2');
    cleanup();
    renderPanel('en', {
      claimedSources: [
        { needLineId: 'nl-1', sourceRecordId: REC_5_FINAL, designatedQuantity: '120.5', appliedOverrideId: null },
        { needLineId: 'nl-2', sourceRecordId: REC_6_FINAL, designatedQuantity: '40', appliedOverrideId: null },
      ],
    });
    const state = await screen.findByTestId('cn2b-nl-completeness');
    expect(state).toHaveTextContent(T.cn2b_nl_complete.en);
    expect(state).toHaveTextContent('2/2');
  });
});

describe('M212 — the client never becomes the authority', () => {
  const SERVICE = readFileSync(
    join(__dirname, '..', 'central-needs.service.ts'), 'utf8');
  const PANEL = readFileSync(
    join(__dirname, '..', 'CentralNeedsNeedLinePanel.tsx'), 'utf8');

  it('writes need lines only through the canonical RPC', () => {
    expect(SERVICE).toContain("supabase.rpc('phoenix_central_needs_set_need_line'");
    for (const direct of [
      ".from('central_needs_need_lines').insert",
      ".from('central_needs_need_lines').update",
      ".from('central_needs_need_lines').delete",
      ".from('central_needs_need_line_sources').insert",
      ".from('central_needs_need_line_sources').delete",
    ]) {
      expect(SERVICE, direct).not.toContain(direct);
    }
  });

  it('never turns a missing lineage into an empty array on the way out', () => {
    // The service takes `quantitySources` as a required field and passes it
    // through unguarded: no `?? []`, no `|| []`, no default parameter.
    expect(SERVICE).toContain('quantitySources: NeedLineQuantitySource[];');
    expect(SERVICE).toContain('p_quantity_sources: input.quantitySources.map(');
    expect(SERVICE).not.toMatch(/quantitySources\s*\?\?\s*\[\]/);
    expect(SERVICE).not.toMatch(/quantitySources\s*\|\|\s*\[\]/);
    expect(SERVICE).not.toMatch(/quantitySources\?:/);
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
