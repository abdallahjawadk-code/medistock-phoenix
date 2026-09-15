/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { T } from '@/shared/i18n/strings';
import type { BeneficiaryColumnSummary, FieldOverride, NeedLine, NeedLineSourceLink } from '../central-needs.service';

/**
 * UX-2C — the NEED LINES WORKSPACE.
 *
 * The summary, the evidence filters, the three-band row, the selection summary,
 * the richer preview and the register are presentation. This suite keeps them
 * that way, around the failures such a workspace invites:
 *
 *   1. A FILTER THAT DECIDES. Narrowing the view must never reach a service,
 *      never drop a designation, and never lose a contribution or an override
 *      choice made against a cell the filter then hides.
 *   2. A SUMMARY THAT INVENTS TRUTH. Every count is derived from props already
 *      loaded; nothing issues a request.
 *   3. A PREVIEW THAT IS NOT WHAT EXECUTES. Every stage is mounted on one page,
 *      so the revision can reload while a preview is open. The confirmation must
 *      execute exactly what the preview shows, or nothing. The block marked
 *      CONFIRMATION INTEGRITY pins hazards that existed at BASE (47f8ab05).
 *
 * The M212/213 business contract itself — per-column beneficiary resolution,
 * exact decimals, revision-wide lineage, reasoned deletion, stale refusals — is
 * owned by cn2b-need-line-mapping.runtime.test.tsx, which UX-2C leaves
 * untouched. It is only re-checked here where the redesign could have eroded it.
 */

const setNeedLine = vi.fn();
const deleteNeedLine = vi.fn();
const getOrganizations = vi.fn();
const getWarehouses = vi.fn();
const rpc = vi.fn();

vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => { throw new Error('the need-line workspace must not read tables directly'); },
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

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const PANEL_PATH = 'src/features/central-needs/CentralNeedsNeedLinePanel.tsx';

const BENE = '00000000-0000-0000-0000-0000000000b1';
const BENE2 = '00000000-0000-0000-0000-0000000000b2';
const ITEM_A = '00000000-0000-0000-0000-0000000000a1';
const ITEM_B = '00000000-0000-0000-0000-0000000000a2';
const ROW_5 = 'sheet:0:row:5';
const ROW_6 = 'sheet:0:row:6';
const ROW_7 = 'sheet:0:row:7';

const disposition = (entity: string, item: string | null = ITEM_A, decision: 'mapped' | 'not_applicable' = 'mapped') => ({
  id: `d-${entity}`, importSessionId: 's1', targetEntity: entity,
  decision, centralItemId: decision === 'mapped' ? item : null, decisionReason: decision === 'mapped' ? null : 'subtotal',
  decidedAt: '2026-01-01T00:00:00.000Z',
});

const record = (
  id: string, entity: string, fieldName: string, value: unknown, ordinal: number, columnIndex: number,
  extra: { a1?: string; originalFilename?: string; importSessionId?: string } = {},
) => ({
  id, importSessionId: extra.importSessionId ?? 's1', recordOrdinal: ordinal, targetEntity: entity, fieldName,
  sourceValues: { value },
  sourceProvenance: {
    sheetIndex: 0,
    coordinate: { col: columnIndex, ...(extra.a1 ? { a1: extra.a1 } : {}) },
    ...(extra.originalFilename ? { originalFilename: extra.originalFilename } : {}),
  },
});

const beneficiaryColumn = (
  columnIndex: number, beneficiaryOrganizationId: string | null, over: Partial<BeneficiaryColumnSummary> = {},
): BeneficiaryColumnSummary => ({
  importSessionId: 's1', originalFilename: 'need-2026.xlsx', archiveEntryPath: null, sheetIndex: 0, sheetName: null,
  columnIndex, sourceFieldName: null, numericValueCount: 1, zeroValueCount: 0, nonzeroNumericCount: 1,
  mappingId: beneficiaryOrganizationId ? `bc-${columnIndex}` : null,
  decision: beneficiaryOrganizationId ? 'beneficiary' : null,
  beneficiaryOrganizationId,
  mappingReason: beneficiaryOrganizationId ? 'confirmed' : null,
  mappedAt: beneficiaryOrganizationId ? '2026-01-01T00:00:00.000Z' : null,
  mappedRowNumericCount: 1, reviewRequired: !beneficiaryOrganizationId, ...over,
});

const nonBeneficiaryColumn = (columnIndex: number) => beneficiaryColumn(columnIndex, null, {
  mappingId: `bc-${columnIndex}`, decision: 'non_beneficiary', mappingReason: 'unit price column', reviewRequired: false,
});

const link = (needLineId: string, sourceRecordId: string, designatedQuantity: string,
  importSessionId = 's1', targetEntity = ROW_5, fieldName = 'final', appliedOverrideId: string | null = null,
): NeedLineSourceLink => ({
  needLineId, sourceRecordId, designatedQuantity, appliedOverrideId, importSessionId, targetEntity, fieldName,
});

const line = (over: Partial<NeedLine> = {}): NeedLine => ({
  id: 'nl-0', planRevisionId: 'rev-1', organizationId: 'owner', beneficiaryOrganizationId: BENE,
  targetWarehouseId: null, centralItemId: ITEM_A, approvedQuantity: '0.1', approvedUnit: 'box',
  unitConversionState: 'canonical', sourceUnitText: null, mappingReason: 'earlier session',
  updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});

type PanelProps = Parameters<typeof CentralNeedsNeedLinePanel>[0];

/** Default: two confirmed-BENE cells on two rows of the same material, one unconfirmed, one non-beneficiary. */
function renderPanel(lang: 'ar' | 'en', over: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    lang,
    planRevisionId: 'rev-1',
    editable: true,
    dispositions: [disposition(ROW_5), disposition(ROW_6), disposition(ROW_7, ITEM_B)],
    records: [
      record('rec-5-final', ROW_5, 'final', 120.5, 1, 2, { a1: 'C6', originalFilename: 'alpha-needs.xlsx' }),
      record('rec-6-final', ROW_6, 'final', 40, 2, 3, { a1: 'D7' }),
      record('rec-7-open', ROW_7, 'Hospital X', 9, 3, 9),
      record('rec-7-price', ROW_7, 'unit price', 7, 4, 10),
    ],
    overrides: [],
    needLines: [],
    claimedSources: [],
    beneficiaryColumns: [beneficiaryColumn(2, BENE), beneficiaryColumn(3, BENE), nonBeneficiaryColumn(10)],
    onChanged: () => {},
    ...over,
  };
  const view = render(<CentralNeedsNeedLinePanel {...props} />);
  const rerenderWith = (next: Partial<PanelProps>) =>
    view.rerender(<CentralNeedsNeedLinePanel {...props} {...next} />);
  return { ...view, props, rerenderWith };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const candidateFor = (entity: string, field: string) =>
  screen.getByText(new RegExp(`^${esc(entity)} · ${esc(field)}$`)).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
const pickBox = (entity: string, field: string) => within(candidateFor(entity, field)).getAllByRole('checkbox')[0] as HTMLInputElement;
const pick = (entity: string, field: string) => fireEvent.click(pickBox(entity, field));
const contribution = (field: string) => screen.getByLabelText(`${T.cn2b_nl_contribution.en} — ${field}`) as HTMLInputElement;
/**
 * The contribution label names the field, not the row (the M212 contract test
 * pins that exact label), so two selected cells sharing a field name are told
 * apart by their own evidence row.
 */
const contributionIn = (entity: string, field: string) =>
  within(candidateFor(entity, field)).getByLabelText(`${T.cn2b_nl_contribution.en} — ${field}`) as HTMLInputElement;
const visibleIdents = () => screen.queryAllByTestId('cn2b-nl-candidate')
  .map((c) => c.querySelector('.cn2b-nl-row__ident')!.textContent);
const attr = (name: string, value: string) => document.querySelector(`[${name}="${value}"]`)?.textContent;
const sum = (which: string) => attr('data-nl-sum', which);
const count = (which: string) => attr('data-nl-count', which);
const sel = (which: string) => attr('data-nl-sel', which);
const searchBox = () => screen.getByRole('searchbox', { name: T.cn2b_nl_filter_search.en });
const filterBtn = (key: string) => screen.getByRole('button', { name: T[key].en });
const clearBtn = () => screen.getByRole('button', { name: T.cn2b_nl_filter_clear.en });
const fillReason = (text = 'reviewer designated the final block') =>
  fireEvent.change(screen.getByLabelText(T.cn2b_nl_reason.en), { target: { value: text } });
const openPreview = () => {
  const btn = screen.queryByRole('button', { name: T.cn2b_nl_save.en })
    ?? screen.getByRole('button', { name: T.cn2b_nl_bulk_preview.en });
  fireEvent.click(btn);
};
const confirmBtn = () => screen.queryByRole('button', { name: T.cn2b_nl_bulk_confirm.en });
const scopeFacts = (group: HTMLElement) => Object.fromEntries(
  [...group.querySelectorAll('[data-nl-scope]')].map((el) => [el.getAttribute('data-nl-scope'), el.textContent]),
);
const namesLoaded = () => waitFor(() => expect(getOrganizations).toHaveBeenCalled());

/**
 * Locators that exist identically at BASE 47f8ab05 and in UX-2C — the M212
 * contract test's own (an unanchored "row · field" text match, its enclosing
 * label's checkbox, the reason label and the save/confirm button names). The
 * confirmation-integrity proofs select and confirm through these only, so run
 * against BASE they fail on the defect itself, not on missing UX-2C markup.
 */
const legacyPick = (entity: string, field: string) => {
  const text = screen.getByText(new RegExp(`${esc(entity)} · ${esc(field)}`));
  fireEvent.click(text.closest('label')!.querySelector('input[type="checkbox"]')!);
};
/** Lets an async click handler run past its first await before absence is asserted. */
const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  setNeedLine.mockReset().mockResolvedValue({
    needLineId: 'nl-1', created: true, sourceLinkCount: 1, addedLinkCount: 1, approvedQuantity: '1',
  });
  deleteNeedLine.mockReset().mockResolvedValue({ needLineId: 'nl-0', deletedSourceCount: 2 });
  rpc.mockReset();
  getOrganizations.mockReset().mockResolvedValue([
    { id: BENE, name: 'Beneficiary Hospital', name_ar: 'مستشفى المنتفع', code: 'b1', status: 'active', organizationKind: 'care_institution' },
    { id: BENE2, name: 'Second Hospital', name_ar: 'المستشفى الثاني', code: 'b2', status: 'active', organizationKind: 'care_institution' },
  ]);
  getWarehouses.mockReset().mockResolvedValue([
    { id: 'w1', name: 'Live store', name_ar: 'مخزن فعال', status: 'active' },
    { id: 'w2', name: 'Archived store', name_ar: 'مخزن مؤرشف', status: 'archived' },
  ]);
});
afterEach(() => cleanup());

// ============================================================================
// A. The workspace summary counts already-loaded state.
// ============================================================================
describe('UX-2C — workspace summary', () => {
  it('counts available, selected, unresolved, non-beneficiary, existing lines and claimed cells from props alone', async () => {
    renderPanel('en', {
      records: [
        record('rec-5-final', ROW_5, 'final', 120.5, 1, 2),
        record('rec-6-final', ROW_6, 'final', 40, 2, 3),
        record('rec-7-open', ROW_7, 'Hospital X', 9, 3, 9),
        record('rec-7-price', ROW_7, 'unit price', 7, 4, 10),
        record('rec-5-claimed', ROW_5, 'requested', 5, 5, 2),
      ],
      needLines: [line()],
      claimedSources: [link('nl-0', 'rec-5-claimed', '5', 's1', ROW_5, 'requested'), link('nl-0', 'rec-s0', '0.1', 's0', 'sheet:0:row:9')],
    });
    await namesLoaded();
    expect(sum('available')).toBe('2');
    expect(sum('selected')).toBe('0');
    expect(sum('unresolved')).toBe('1');
    expect(sum('non_beneficiary')).toBe('1');
    expect(sum('lines')).toBe('1');
    expect(sum('claimed')).toBe('2');
    expect(count('total'), 'the claimed cell is not a candidate').toBe('4');

    pick(ROW_5, 'final');
    expect(sum('available')).toBe('1');
    expect(sum('selected')).toBe('1');
    // available + selected + unresolved + non-beneficiary partitions the candidates.
    expect(['available', 'selected', 'unresolved', 'non_beneficiary'].reduce((n, k) => n + Number(sum(k)), 0)).toBe(4);
    expect(rpc).not.toHaveBeenCalled();
    expect(getOrganizations).toHaveBeenCalledTimes(1);
  });

  it('keeps the active-session completeness indicator', async () => {
    renderPanel('en', { claimedSources: [link('nl-1', 'rec-5-final', '120.5')] });
    expect(await screen.findByTestId('cn2b-nl-completeness')).toHaveTextContent('1/3');
  });
});

// ============================================================================
// B. Filtering is presentation. It calls nothing and decides nothing.
// ============================================================================
describe('UX-2C — evidence filtering is client-only', () => {
  it('[1][2] makes ZERO service calls for every search and filter interaction', async () => {
    renderPanel('en');
    await namesLoaded();
    pick(ROW_5, 'final');
    await waitFor(() => expect(getWarehouses).toHaveBeenCalledTimes(1));

    fireEvent.change(searchBox(), { target: { value: 'row:6' } });
    for (const key of ['cn2b_nl_filter_available', 'cn2b_nl_filter_selected', 'cn2b_nl_filter_resolved',
      'cn2b_nl_filter_unresolved', 'cn2b_nl_filter_non_beneficiary', 'cn2b_nl_filter_all']) {
      fireEvent.click(filterBtn(key));
    }
    fireEvent.click(clearBtn());

    expect(getOrganizations).toHaveBeenCalledTimes(1);
    expect(getWarehouses).toHaveBeenCalledTimes(1);
    expect(setNeedLine).not.toHaveBeenCalled();
    expect(deleteNeedLine).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('narrows to each evidence state correctly while the totals keep describing every candidate', async () => {
    renderPanel('en');
    pick(ROW_5, 'final');

    fireEvent.click(filterBtn('cn2b_nl_filter_available'));
    expect(visibleIdents()).toEqual([`${ROW_6} · final`]);
    fireEvent.click(filterBtn('cn2b_nl_filter_selected'));
    expect(visibleIdents()).toEqual([`${ROW_5} · final`]);
    fireEvent.click(filterBtn('cn2b_nl_filter_resolved'));
    expect(visibleIdents()).toEqual([`${ROW_5} · final`, `${ROW_6} · final`]);
    fireEvent.click(filterBtn('cn2b_nl_filter_unresolved'));
    expect(visibleIdents()).toEqual([`${ROW_7} · Hospital X`]);
    fireEvent.click(filterBtn('cn2b_nl_filter_non_beneficiary'));
    expect(visibleIdents()).toEqual([`${ROW_7} · unit price`]);
    expect(count('visible')).toBe('1');
    expect(count('total')).toBe('4');
    fireEvent.click(filterBtn('cn2b_nl_filter_all'));
    expect(visibleIdents()).toHaveLength(4);
  });

  it('searches row, field, beneficiary name in both languages, material, raw value and location evidence', async () => {
    renderPanel('en');
    await waitFor(() => expect(screen.getAllByTestId('cn2b-nl-candidate-beneficiary')[0]).toHaveTextContent('Beneficiary Hospital'));
    const search = (v: string) => fireEvent.change(searchBox(), { target: { value: v } });

    search('row:6');
    expect(visibleIdents()).toEqual([`${ROW_6} · final`]);
    search('unit price');
    expect(visibleIdents()).toEqual([`${ROW_7} · unit price`]);
    search('beneficiary hospital');
    expect(visibleIdents()).toEqual([`${ROW_5} · final`, `${ROW_6} · final`]);
    search('مستشفى المنتفع');
    expect(visibleIdents()).toEqual([`${ROW_5} · final`, `${ROW_6} · final`]);
    search(ITEM_B);
    expect(visibleIdents()).toEqual([`${ROW_7} · Hospital X`, `${ROW_7} · unit price`]);
    search('120.5');
    expect(visibleIdents()).toEqual([`${ROW_5} · final`]);
    search('D7');
    expect(visibleIdents()).toEqual([`${ROW_6} · final`]);
    search('#10');
    expect(visibleIdents()).toEqual([`${ROW_7} · unit price`]);
    search('alpha-needs');
    expect(visibleIdents()).toEqual([`${ROW_5} · final`]);
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('[3][4][5] a selection hidden by a filter stays selected with its contribution AND its override choice', async () => {
    const override: FieldOverride = {
      id: 'ovr-1', sourceRecordId: 'rec-5-final', targetEntity: ROW_5, fieldName: 'final',
      previousValue: 120.5, finalValue: 150, overrideReason: 'signed request', overrideNote: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    renderPanel('en', { overrides: [override] });
    pick(ROW_5, 'final');
    fireEvent.click(within(candidateFor(ROW_5, 'final')).getByRole('checkbox', { name: T.cn2b_nl_use_override.en }));
    expect(contribution('final').value).toBe('150');
    pick(ROW_6, 'final');
    const sixth = within(candidateFor(ROW_6, 'final')).getByRole('textbox');
    fireEvent.change(sixth, { target: { value: '7.25' } });

    // Hide ROW_5 behind a search, then behind a state filter.
    fireEvent.change(searchBox(), { target: { value: 'row:6' } });
    expect(visibleIdents()).toEqual([`${ROW_6} · final`]);
    expect(count('selected_hidden')).toBe('1');
    expect(sel('sources'), 'the hidden cell is still designated').toBe('2');
    expect(screen.getByTestId('cn2b-nl-total')).toHaveTextContent(`${ITEM_A}=157.25`);
    fireEvent.change(searchBox(), { target: { value: '' } });
    fireEvent.click(filterBtn('cn2b_nl_filter_unresolved'));
    expect(sel('sources')).toBe('2');

    fireEvent.click(clearBtn());
    expect(pickBox(ROW_5, 'final')).toBeChecked();
    expect(within(candidateFor(ROW_5, 'final')).getByRole('checkbox', { name: T.cn2b_nl_use_override.en })).toBeChecked();
    expect(contributionIn(ROW_5, 'final').value).toBe('150');
    expect(contributionIn(ROW_6, 'final').value).toBe('7.25');

    // ...and the write carries both, override provenance included.
    fillReason();
    openPreview();
    fireEvent.click(confirmBtn()!);
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0].quantitySources).toEqual([
      { sourceRecordId: 'rec-5-final', designatedQuantity: '150', appliedOverrideId: 'ovr-1' },
      { sourceRecordId: 'rec-6-final', designatedQuantity: '7.25', appliedOverrideId: null },
    ]);
    expect(setNeedLine.mock.calls[0][0].approvedQuantity).toBe('157.25');
  });

  it('[6] clearing the filters restores every row and the search text', () => {
    renderPanel('en');
    fireEvent.change(searchBox(), { target: { value: 'row:6' } });
    fireEvent.click(filterBtn('cn2b_nl_filter_resolved'));
    expect(visibleIdents()).toEqual([`${ROW_6} · final`]);
    fireEvent.click(clearBtn());
    expect(visibleIdents()).toHaveLength(4);
    expect((searchBox() as HTMLInputElement).value).toBe('');
    expect(clearBtn()).toBeDisabled();
  });
});

// ============================================================================
// C. Unresolved and non-beneficiary evidence stays visible, explained and inert.
// ============================================================================
describe('UX-2C — cells that cannot be designated', () => {
  it('[7][8] keeps an UNRESOLVED cell visible, labelled, explained, and non-designatable', () => {
    renderPanel('en');
    const cell = candidateFor(ROW_7, 'Hospital X');
    expect(cell).toHaveAttribute('data-column-decision', 'unresolved');
    expect(within(cell).getByTestId('cn2b-nl-candidate-unmapped')).toHaveTextContent(T.cn2b_beneficiary_column_state_unresolved.en);
    expect(within(cell).getByTestId('cn2b-nl-candidate-why')).toHaveTextContent(T.cn2b_nl_why_unresolved.en);
    const box = within(cell).getByRole('checkbox');
    expect(box).toBeDisabled();
    fireEvent.click(box);
    expect(box).not.toBeChecked();
    expect(sum('selected')).toBe('0');
    expect(screen.queryByTestId('cn2b-nl-selection')).toBeNull();
  });

  it('[9][10] keeps a NON-BENEFICIARY cell visible, labelled, explained, and non-designatable', () => {
    renderPanel('en');
    const cell = candidateFor(ROW_7, 'unit price');
    expect(cell).toHaveAttribute('data-column-decision', 'non_beneficiary');
    expect(within(cell).getByTestId('cn2b-nl-candidate-non-beneficiary')).toHaveTextContent(T.cn2b_beneficiary_column_state_non_beneficiary.en);
    expect(within(cell).getByTestId('cn2b-nl-candidate-why')).toHaveTextContent(T.cn2b_nl_why_non_beneficiary.en);
    const box = within(cell).getByRole('checkbox');
    expect(box).toBeDisabled();
    fireEvent.click(box);
    expect(sum('selected')).toBe('0');
  });

  it('says so when no candidate can be designated yet, while still listing the evidence', () => {
    renderPanel('en', { beneficiaryColumns: [] });
    expect(screen.getByTestId('cn2b-nl-none-designatable')).toHaveAttribute('data-empty', 'all-unresolved');
    expect(screen.getByText(T.cn2b_nl_empty_all_unresolved.en)).toBeInTheDocument();
    expect(visibleIdents()).toHaveLength(4);
    for (const box of screen.getAllByRole('checkbox', { name: /sheet:0:row/ })) expect(box).toBeDisabled();
  });
});

// ============================================================================
// D. Evidence is evidence; the contribution is the reviewer's.
// ============================================================================
describe('UX-2C — source value versus designated contribution', () => {
  it('[11][12] shows the SOURCE VALUE as evidence and prefills an editable DESIGNATED CONTRIBUTION as a suggestion', () => {
    renderPanel('en');
    const cell = candidateFor(ROW_5, 'final');
    expect(within(cell).getByTestId('cn2b-nl-source-value')).toHaveTextContent(`${T.cn2b_nl_source_value.en}: 120.5`);
    pick(ROW_5, 'final');
    expect(contribution('final').value).toBe('120.5');
    expect(within(cell).getByText(T.cn2b_nl_suggestion_note.en)).toBeInTheDocument();

    fireEvent.change(contribution('final'), { target: { value: '99' } });
    expect(contribution('final').value).toBe('99');
    // The evidence did not move, and the suggestion label left once it was replaced.
    expect(within(cell).getByTestId('cn2b-nl-source-value')).toHaveTextContent('120.5');
    expect(within(cell).queryByText(T.cn2b_nl_suggestion_note.en)).toBeNull();
  });

  it('shows a non-decimal source value as text evidence and suggests nothing', () => {
    renderPanel('en', {
      records: [record('rec-name', ROW_5, 'item_name', 'Paracetamol 500mg', 1, 2)],
    });
    const cell = candidateFor(ROW_5, 'item_name');
    expect(within(cell).getByTestId('cn2b-nl-source-value')).toHaveTextContent('Paracetamol 500mg');
    expect(within(cell).getByTestId('cn2b-nl-source-value')).toHaveTextContent(T.cn2b_nl_source_value_not_decimal.en);
    pick(ROW_5, 'item_name');
    expect(contribution('item_name').value).toBe('');
  });

  it('[13] keeps the sum exact end to end — selection, total, preview and payload agree without float drift', async () => {
    expect(sumExactDecimals(['0.1', '0.2'])).toBe('0.3');
    renderPanel('en');
    pick(ROW_5, 'final');
    pick(ROW_6, 'final');
    fireEvent.change(contributionIn(ROW_5, 'final'), { target: { value: '0.1' } });
    fireEvent.change(contributionIn(ROW_6, 'final'), { target: { value: '0.2' } });
    expect(document.querySelector('[data-testid="cn2b-nl-selection-scope"] [data-nl-scope="added"]')).toHaveTextContent('0.3');
    expect(screen.getByTestId('cn2b-nl-total')).toHaveTextContent(`${ITEM_A}=0.3`);
    fillReason();
    openPreview();
    const facts = scopeFacts(screen.getByTestId('cn2b-nl-preview-group'));
    expect(facts.added).toBe('0.3');
    expect(facts.resulting).toBe('0.3');
    fireEvent.click(confirmBtn()!);
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0].approvedQuantity).toBe('0.3');
  });

  it('[14] offers no directly editable approved total anywhere', () => {
    renderPanel('en');
    pick(ROW_5, 'final');
    const names = screen.getAllByRole('textbox').map((el) => el.getAttribute('aria-label')
      ?? document.querySelector(`label[for="${el.id}"]`)?.textContent ?? '');
    expect(names.sort()).toEqual([
      `${T.cn2b_nl_contribution.en} — final`, T.cn2b_nl_reason.en, T.cn2b_nl_source_unit.en,
    ].sort());
    expect(screen.getByTestId('cn2b-nl-total').tagName).toBe('P');
    expect(screen.queryByLabelText(new RegExp(T.cn2b_nl_total.en, 'i'))).toBeNull();
    expect(screen.queryByLabelText(/approved quantity/i)).toBeNull();
  });
});

// ============================================================================
// E. The selection summary is read off the canonical grouping.
// ============================================================================
describe('UX-2C — selected-source summary', () => {
  const multi = () => renderPanel('en', {
    dispositions: [disposition(ROW_5, ITEM_A), disposition(ROW_6, ITEM_B)],
    records: [
      record('rec-a', ROW_5, 'Hospital A', 100, 1, 1),
      record('rec-b', ROW_5, 'Hospital B', 50, 2, 2),
      record('rec-c', ROW_6, 'Hospital A', 10, 3, 3),
      record('rec-d', ROW_5, 'Hospital A extra', 5, 4, 4),
    ],
    beneficiaryColumns: [beneficiaryColumn(1, BENE), beneficiaryColumn(2, BENE2), beneficiaryColumn(3, BENE), beneficiaryColumn(4, BENE)],
  });

  it('[15][16][17] counts selected sources, beneficiaries and resulting scopes', () => {
    multi();
    expect(screen.queryByTestId('cn2b-nl-selection')).toBeNull();
    pick(ROW_5, 'Hospital A');
    pick(ROW_5, 'Hospital B');
    pick(ROW_6, 'Hospital A');
    expect(sel('sources')).toBe('3');
    expect(sel('beneficiaries')).toBe('2');
    expect(sel('scopes')).toBe('3');
    const scopes = screen.getAllByTestId('cn2b-nl-selection-scope');
    expect(scopes.map((s) => s.getAttribute('data-beneficiary')).sort()).toEqual([BENE, BENE, BENE2].sort());
    for (const s of scopes) expect(s).toHaveTextContent(T.cn2b_nl_creates_new.en);
  });

  it('[18] groups by beneficiary + material (+ warehouse): a same-scope cell joins its scope instead of adding one', () => {
    multi();
    pick(ROW_5, 'Hospital A');
    pick(ROW_6, 'Hospital A');
    expect(sel('scopes')).toBe('2'); // same beneficiary, different material → two scopes
    pick(ROW_5, 'Hospital A extra');
    expect(sel('sources')).toBe('3');
    expect(sel('scopes')).toBe('2'); // same beneficiary AND material → same scope
    const itemA = screen.getAllByTestId('cn2b-nl-selection-scope').find((s) => s.textContent!.includes(ITEM_A))!;
    expect(within(itemA).getByText('105')).toBeInTheDocument();
  });

  it('[18] the target warehouse is part of the scope: a warehouse-scoped save does not extend the institution-level line', async () => {
    renderPanel('en', { needLines: [line({ approvedQuantity: '1' })], claimedSources: [link('nl-0', 'rec-old', '1', 's0', 'sheet:0:row:9')] });
    pick(ROW_5, 'final');
    expect(screen.getByTestId('cn2b-nl-selection-scope')).toHaveAttribute('data-existing', 'true');
    const select = screen.getByLabelText(T.cn2b_nl_warehouse.en);
    await waitFor(() => expect(select.textContent).toContain('Live store'));
    fireEvent.change(select, { target: { value: 'w1' } });
    expect(screen.getByTestId('cn2b-nl-selection-scope')).toHaveAttribute('data-existing', 'false');
    fillReason();
    openPreview();
    const group = screen.getByTestId('cn2b-nl-preview-group');
    expect(scopeFacts(group).warehouse).toBe('Live store');
    expect(group).toHaveTextContent(T.cn2b_nl_creates_new.en);
    fireEvent.click(confirmBtn()!);
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0]).toMatchObject({ targetWarehouseId: 'w1', expectedSourceRecordIds: [], approvedQuantity: '120.5' });
  });

  it('[19] a multi-beneficiary selection stays independent scopes all the way to the write', async () => {
    multi();
    pick(ROW_5, 'Hospital A');
    pick(ROW_5, 'Hospital B');
    fillReason();
    openPreview();
    const groups = screen.getAllByTestId('cn2b-nl-preview-group');
    expect(groups.map((g) => g.getAttribute('data-beneficiary')).sort()).toEqual([BENE, BENE2].sort());
    expect(screen.getByTestId('cn2b-nl-beneficiary-count')).toHaveTextContent('2');
    fireEvent.click(confirmBtn()!);
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(2));
    expect(setNeedLine.mock.calls.map((c) => [c[0].beneficiaryOrganizationId, c[0].approvedQuantity]).sort())
      .toEqual([[BENE, '100'], [BENE2, '50']].sort());
  });
});

// ============================================================================
// F. The preview states each scope's effect, and units are locked up front.
// ============================================================================
describe('UX-2C — final scope preview', () => {
  const withExisting = () => renderPanel('en', {
    records: [
      record('rec-5-final', ROW_5, 'final', 120.5, 1, 2),
      record('rec-5-b', ROW_5, 'Hospital B', 45, 2, 4),
    ],
    beneficiaryColumns: [beneficiaryColumn(2, BENE), beneficiaryColumn(4, BENE2)],
    needLines: [line()],
    claimedSources: [link('nl-0', 'rec-s0-final', '0.1', 's0', 'sheet:0:row:9')],
  });

  it('[20][21][22][23] distinguishes NEW from EXISTING with added, current and resulting quantity and the locked unit', async () => {
    withExisting();
    await namesLoaded();
    pick(ROW_5, 'final');
    fireEvent.change(contribution('final'), { target: { value: '0.2' } });
    pick(ROW_5, 'Hospital B');
    // Told before any confirmation that the existing line keeps its unit.
    expect(screen.getByTestId('cn2b-nl-unit-locked-note')).toHaveTextContent(T.cn2b_nl_unit_locked_note.en);
    fireEvent.change(screen.getByLabelText(T.cn2b_nl_unit.en), { target: { value: 'vial' } });
    fillReason('two scopes');
    openPreview();

    const groups = screen.getAllByTestId('cn2b-nl-preview-group');
    const extends_ = groups.find((g) => g.getAttribute('data-existing') === 'true')!;
    const creates = groups.find((g) => g.getAttribute('data-existing') === 'false')!;
    expect(extends_).toHaveTextContent(T.cn2b_nl_adds_to_existing.en);
    expect(scopeFacts(extends_)).toMatchObject({
      material: ITEM_A, warehouse: T.cn2b_nl_warehouse_none.en, 'new-sources': '1',
      added: '0.2', current: '0.1', 'existing-sources': '1', resulting: '0.3',
      unit: `box (${T.cn2b_nl_scope_unit_locked.en})`,
    });
    expect(creates).toHaveTextContent(T.cn2b_nl_creates_new.en);
    expect(scopeFacts(creates)).toMatchObject({ added: '45', resulting: '45', unit: 'vial' });
    expect(scopeFacts(creates).current).toBeUndefined();
    expect(screen.getByTestId('cn2b-nl-unit-locked')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-nl-preview-reason')).toHaveTextContent('two scopes');

    fireEvent.click(confirmBtn()!);
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(2));
    const byBene = Object.fromEntries(setNeedLine.mock.calls.map((c) => [c[0].beneficiaryOrganizationId, c[0]]));
    expect(byBene[BENE]).toMatchObject({ approvedQuantity: '0.3', approvedUnit: 'box', expectedSourceRecordIds: ['rec-s0-final'] });
    expect(byBene[BENE2]).toMatchObject({ approvedQuantity: '45', approvedUnit: 'vial', expectedSourceRecordIds: [] });
  });

  it('distinguishes approved unit, source unit text and conversion required, and previews a conversion-required line honestly', async () => {
    renderPanel('en');
    expect(screen.getByTestId('cn2b-nl-unit-explainer')).toHaveTextContent(T.cn2b_nl_unit_explainer.en);
    pick(ROW_5, 'final');
    fireEvent.click(screen.getByLabelText(T.cn2b_nl_unit_conversion_required.en));
    fireEvent.change(screen.getByLabelText(T.cn2b_nl_source_unit.en), { target: { value: 'strip of 10' } });
    fillReason();
    openPreview();
    expect(scopeFacts(screen.getByTestId('cn2b-nl-preview-group')).unit).toBe(T.cn2b_nl_unit_conversion_required.en);
    fireEvent.click(confirmBtn()!);
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0]).toMatchObject({
      approvedUnit: null, unitConversionState: 'conversion_required', sourceUnitText: 'strip of 10',
    });
  });
});

// ============================================================================
// G. Warehouse targeting.
// ============================================================================
describe('UX-2C — warehouse targeting', () => {
  it('[24] explains why a multi-beneficiary selection cannot target a warehouse, and keeps every line institution-level', async () => {
    renderPanel('en', {
      records: [record('rec-a', ROW_5, 'Hospital A', 100, 1, 1), record('rec-b', ROW_5, 'Hospital B', 50, 2, 2)],
      beneficiaryColumns: [beneficiaryColumn(1, BENE), beneficiaryColumn(2, BENE2)],
    });
    expect(screen.getByTestId('cn2b-nl-warehouse-hint')).toHaveAttribute('data-warehouse-state', 'none');
    expect(screen.getByTestId('cn2b-nl-warehouse-hint')).toHaveTextContent(T.cn2b_nl_warehouse_needs_selection.en);
    pick(ROW_5, 'Hospital A');
    await waitFor(() => expect(getWarehouses).toHaveBeenCalledWith(BENE));
    pick(ROW_5, 'Hospital B');
    const hint = screen.getByTestId('cn2b-nl-warehouse-hint');
    expect(hint).toHaveAttribute('data-warehouse-state', 'multi');
    expect(hint).toHaveTextContent(T.cn2b_nl_warehouse_multi_beneficiary_disabled.en);
    expect(screen.getByLabelText(T.cn2b_nl_warehouse.en)).toBeDisabled();
    expect(getWarehouses).toHaveBeenCalledTimes(1);
    fillReason();
    openPreview();
    for (const g of screen.getAllByTestId('cn2b-nl-preview-group')) {
      expect(scopeFacts(g).warehouse).toBe(T.cn2b_nl_warehouse_none.en);
    }
    fireEvent.click(confirmBtn()!);
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(2));
    for (const c of setNeedLine.mock.calls) expect(c[0].targetWarehouseId).toBeNull();
  });

  it('[25] a single beneficiary still reads its own ACTIVE warehouses through the existing read', async () => {
    renderPanel('en');
    await namesLoaded();
    pick(ROW_5, 'final');
    const select = screen.getByLabelText(T.cn2b_nl_warehouse.en);
    await waitFor(() => expect(select.textContent).toContain('Live store'));
    expect(select).toBeEnabled();
    expect(select.textContent).not.toContain('Archived store');
    expect(getWarehouses).toHaveBeenCalledWith(BENE);
    const hint = screen.getByTestId('cn2b-nl-warehouse-hint');
    expect(hint).toHaveAttribute('data-warehouse-state', 'single');
    await waitFor(() => expect(hint).toHaveTextContent('Beneficiary Hospital'));
  });
});

// ============================================================================
// H. Authority is exactly what it was.
// ============================================================================
describe('UX-2C — no new authority, no new API', () => {
  it('[26][27] has no global beneficiary selector and no material picker', () => {
    renderPanel('en');
    pick(ROW_5, 'final');
    const comboNames = screen.getAllByRole('combobox').map((c) => c.getAttribute('aria-label'));
    expect(comboNames.sort()).toEqual([T.cn2b_nl_unit.en, T.cn2b_nl_warehouse.en].sort());
    expect(screen.queryByRole('combobox', { name: /beneficiary|material|item/i })).toBeNull();
    for (const option of document.querySelectorAll('option')) {
      expect([ITEM_A, ITEM_B, BENE, BENE2]).not.toContain((option as HTMLOptionElement).value);
    }
    // The material is shown as the row's existing mapping, as text.
    expect(within(candidateFor(ROW_5, 'final')).getByTestId('cn2b-nl-candidate-material').tagName).toBe('CODE');
    const panel = read(PANEL_PATH);
    expect(panel).not.toContain('searchCentralItems');
    expect(panel).not.toContain('setCentralItemId');
    expect(panel).not.toMatch(/aria-label=\{t\('cn2b_nl_beneficiary'/);
  });

  it('[40] introduces no new business API call site: the same four service calls, each once, and a filter that reaches none', () => {
    const panel = read(PANEL_PATH);
    const importLines = panel.split('\n').filter((l) => /from '@\/shared\/supabase|from '\.\/central-needs\.service'/.test(l));
    expect(importLines).toEqual([
      "import { getOrganizations, type OrgRow } from '@/shared/supabase/services/organizations.service';",
      "import { getWarehouses, type Warehouse } from '@/shared/supabase/services/warehouses.service';",
      "} from './central-needs.service';",
    ]);
    const occurrences = (needle: string) => panel.split(needle).length - 1;
    expect(occurrences('getOrganizations()')).toBe(1);
    expect(occurrences('getWarehouses(singleSelectedBeneficiary)')).toBe(1);
    expect(occurrences('await setNeedLine(')).toBe(1);
    expect(occurrences('await deleteNeedLine(')).toBe(1);
    expect(panel).not.toMatch(/\bsupabase\.|\.rpc\(|\bfetch\(/);

    const filterMemo = panel.slice(panel.indexOf('const visibleCandidates'), panel.indexOf('function clearFilters'));
    expect(filterMemo.length).toBeGreaterThan(200);
    for (const forbidden of ['await ', 'setNeedLine', 'deleteNeedLine', 'getWarehouses', 'getOrganizations', 'setDesignated']) {
      expect(filterMemo, forbidden).not.toContain(forbidden);
    }
  });

  it('decides nothing from roles or permissions, and the screen still gates it on canEdit && isDraft', () => {
    const panel = read(PANEL_PATH);
    for (const token of ['myPermissions', 'super_admin', 'institution_admin', 'normalizeRole', 'isScreenAuthorized']) {
      expect(panel, token).not.toContain(token);
    }
    const screenSrc = read('src/features/central-needs/CentralNeedsScreen.tsx');
    for (const key of ['import', 'edit', 'approve']) expect(screenSrc).toContain(`myPermissions.has('central_needs.${key}')`);
    const needLineMount = screenSrc.slice(screenSrc.indexOf('<CentralNeedsNeedLinePanel'), screenSrc.indexOf('/>', screenSrc.indexOf('<CentralNeedsNeedLinePanel')));
    expect(needLineMount).toContain('editable={canEdit && isDraft}');
  });
});

// ============================================================================
// I. Provenance stays visible in the register.
// ============================================================================
describe('UX-2C — need-line register and provenance', () => {
  it('[28][29] shows beneficiary, quantity and unit, warehouse level, source count, reason and the whole revision-wide lineage', async () => {
    renderPanel('en', {
      needLines: [
        line({ approvedQuantity: '12.5', mappingReason: 'signed annual request' }),
        line({ id: 'nl-conv', beneficiaryOrganizationId: BENE2, approvedUnit: null, unitConversionState: 'conversion_required', approvedQuantity: '3', sourceUnitText: 'strip' }),
      ],
      claimedSources: [
        link('nl-0', 'rec-s0', '10', 's0', 'sheet:0:row:9', 'final'),
        link('nl-0', 'rec-s1', '2.5', 's1', ROW_6, 'requested', 'ovr-9'),
        link('nl-conv', 'rec-s2', '3', 's1', ROW_7, 'Hospital X'),
      ],
    });
    await namesLoaded();
    const [first, second] = screen.getAllByTestId('cn2b-nl-line');
    await waitFor(() => expect(first).toHaveTextContent('Beneficiary Hospital'));
    expect(first.querySelector('[data-nl-line="quantity"]')).toHaveTextContent('12.5 box');
    expect(first.querySelector('[data-nl-line="warehouse"]')).toHaveTextContent(T.cn2b_nl_warehouse_none.en);
    expect(first.querySelector('[data-nl-line="sources"]')).toHaveTextContent('2');
    expect(first.querySelector('[data-nl-line="reason"]')).toHaveTextContent('signed annual request');
    const lineage = within(first).getByTestId('cn2b-nl-lineage');
    expect(lineage).toHaveTextContent('sheet:0:row:9 · final = 10');
    expect(lineage).toHaveTextContent(T.cn2b_nl_other_session.en);
    expect(lineage).toHaveTextContent(`${ROW_6} · requested = 2.5 (${T.cn2b_nl_override_in_lineage.en})`);
    expect(lineage.querySelector('[data-other-session="true"]')).toHaveTextContent('sheet:0:row:9');

    expect(second).toHaveAttribute('data-conversion', 'true');
    expect(second.querySelector('[data-nl-line="quantity"]')).toHaveTextContent(T.cn2b_nl_unit_conversion_required.en);
    expect(second).toHaveTextContent('strip');
  });

  it('says "no need lines yet" in the register — a different statement from any evidence state', () => {
    renderPanel('en');
    expect(screen.getByTestId('cn2b-nl-list').querySelector('[data-empty="no-lines"]')).toHaveTextContent(T.cn2b_nl_none_yet.en);
  });
});

// ============================================================================
// J. Reason, zero-source, server refusals.
// ============================================================================
describe('UX-2C — reason, provenance and refusals', () => {
  it('[30] keeps the reason mandatory and says what is missing before any preview', () => {
    renderPanel('en');
    pick(ROW_5, 'final');
    const save = screen.getByRole('button', { name: T.cn2b_nl_save.en });
    expect(save).toBeDisabled();
    expect(screen.getByTestId('cn2b-nl-save-blockers').querySelector('[data-blocker="cn2b_nl_block_reason"]')).not.toBeNull();
    fillReason('   ');
    expect(save).toBeDisabled();
    fillReason();
    expect(save).toBeEnabled();
    expect(screen.queryByTestId('cn2b-nl-save-blockers')).toBeNull();
  });

  it('[31] makes a zero-source save impossible', () => {
    renderPanel('en');
    fillReason();
    const save = screen.getByRole('button', { name: T.cn2b_nl_save.en });
    expect(save).toBeDisabled();
    expect(screen.getByTestId('cn2b-nl-save-blockers').querySelector('[data-blocker="cn2b_nl_block_no_selection"]')).not.toBeNull();
    fireEvent.click(save);
    expect(screen.queryByTestId('cn2b-nl-preview')).toBeNull();
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it.each(['need_line_lineage_stale', 'need_line_scope_conflict', 'need_line_not_found'])(
    '[32][33] shows %s as localized refusal text, closes the preview and reloads', async (code) => {
      setNeedLine.mockRejectedValueOnce(new CentralNeedsError(code, code));
      const onChanged = vi.fn();
      renderPanel('en', { onChanged });
      pick(ROW_5, 'final');
      fillReason();
      openPreview();
      fireEvent.click(confirmBtn()!);
      const alert = await screen.findByTestId('cn2b-nl-error');
      expect(alert).toHaveAttribute('role', 'alert');
      expect(alert).toHaveTextContent(T.cn2b_nl_error_title.en);
      expect(alert).toHaveTextContent(T[`cn2b_err_${code}`].en);
      expect(alert.textContent).not.toContain(code);
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('cn2b-nl-preview')).toBeNull();
    });

  it('does not reload after a refusal that is not a staleness signal and wrote nothing', async () => {
    setNeedLine.mockRejectedValueOnce(new CentralNeedsError('target_warehouse_not_active', 'target_warehouse_not_active'));
    const onChanged = vi.fn();
    renderPanel('en', { onChanged });
    pick(ROW_5, 'final');
    fillReason();
    openPreview();
    fireEvent.click(confirmBtn()!);
    expect(await screen.findByTestId('cn2b-nl-error')).toHaveTextContent(T.cn2b_err_target_warehouse_not_active.en);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

// ============================================================================
// K. Deletion stays a two-step, reasoned correction.
// ============================================================================
describe('UX-2C — delete as correction', () => {
  it('[34][35][36] states the line, the affected source count and the consequence, requires a typed reason, and sends the lineage', async () => {
    const onChanged = vi.fn();
    renderPanel('en', {
      onChanged,
      needLines: [line({ approvedQuantity: '12.5' })],
      claimedSources: [link('nl-0', 'rec-s0', '10', 's0', 'sheet:0:row:9'), link('nl-0', 'rec-s1', '2.5', 's1', ROW_6)],
    });
    const registerLine = screen.getByTestId('cn2b-nl-line');
    expect(screen.queryByTestId('cn2b-nl-delete-confirm')).toBeNull();
    fireEvent.click(within(registerLine).getByRole('button', { name: T.cn2b_nl_delete.en }));
    expect(deleteNeedLine).not.toHaveBeenCalled();

    const confirm = screen.getByTestId('cn2b-nl-delete-confirm');
    expect(confirm.querySelector('[data-nl-delete="line"]')).toHaveTextContent(`${ITEM_A} · 12.5 box`);
    expect(confirm.querySelector('[data-nl-delete="sources"]')).toHaveTextContent('2');
    expect(confirm).toHaveTextContent(T.cn2b_nl_delete_explainer.en);
    const go = within(confirm).getByRole('button', { name: T.cn2b_nl_delete_confirm.en });
    expect(go).toBeDisabled();
    fireEvent.change(within(confirm).getByLabelText(T.cn2b_nl_delete_reason.en), { target: { value: '   ' } });
    expect(go).toBeDisabled();
    fireEvent.change(within(confirm).getByLabelText(T.cn2b_nl_delete_reason.en), { target: { value: 'wrong beneficiary' } });
    fireEvent.click(go);
    await waitFor(() => expect(deleteNeedLine).toHaveBeenCalledTimes(1));
    expect(deleteNeedLine).toHaveBeenCalledWith({
      needLineId: 'nl-0', reason: 'wrong beneficiary', expectedSourceRecordIds: ['rec-s0', 'rec-s1'],
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// L. Read-only and the distinct empty states.
// ============================================================================
describe('UX-2C — read-only and empty states', () => {
  it('[37] a read-only revision exposes no mutation control at all, but keeps the summary and the register', () => {
    renderPanel('en', { editable: false, needLines: [line()], claimedSources: [link('nl-0', 'rec-s0', '0.1', 's0', 'sheet:0:row:9')] });
    expect(screen.getByTestId('cn2b-nl-readonly')).toHaveTextContent(T.cn2b_nl_readonly.en);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryAllByRole('searchbox')).toHaveLength(0);
    expect(screen.getByTestId('cn2b-nl-summary')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-nl-lineage')).toBeInTheDocument();
  });

  it('[38] "no candidate evidence" is a different statement from "filters matched nothing"', () => {
    renderPanel('en', { dispositions: [disposition(ROW_5, null, 'not_applicable')] });
    expect(screen.getByTestId('cn2b-nl-no-candidates')).toHaveAttribute('data-empty', 'no-evidence');
    expect(screen.queryByTestId('cn2b-nl-empty-filtered')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    cleanup();

    renderPanel('en');
    fireEvent.change(searchBox(), { target: { value: 'no-such-cell' } });
    expect(screen.getByTestId('cn2b-nl-empty-filtered')).toHaveTextContent(T.cn2b_nl_empty_filtered.en);
    expect(screen.queryByTestId('cn2b-nl-no-candidates')).toBeNull();
    expect(count('visible')).toBe('0');
    expect(count('total')).toBe('4');
  });

  it('"every mapped cell already feeds a line" is its own state too', () => {
    renderPanel('en', {
      records: [record('rec-5-final', ROW_5, 'final', 1, 1, 2)],
      needLines: [line()],
      claimedSources: [link('nl-0', 'rec-5-final', '1')],
    });
    expect(screen.getByTestId('cn2b-nl-all-claimed')).toHaveAttribute('data-empty', 'all-claimed');
    expect(screen.queryByTestId('cn2b-nl-no-candidates')).toBeNull();
  });
});

// ============================================================================
// M. CONFIRMATION INTEGRITY — what the preview shows is what executes, or nothing.
// These pin hazards that existed at BASE 47f8ab05, where the confirm button was
// gated only on `busy` and the write re-read live state at click time.
// ============================================================================
describe('UX-2C — confirmation integrity while the revision reloads', () => {
  it('S1 — a selected cell whose column becomes UNRESOLVED blocks the open preview; nothing is "saved" with nothing written', async () => {
    const { rerenderWith } = renderPanel('en');
    legacyPick(ROW_5, 'final');
    fillReason();
    openPreview();
    expect(confirmBtn()).toBeEnabled();

    rerenderWith({ beneficiaryColumns: [beneficiaryColumn(3, BENE)] }); // column 2 lost its confirmation

    expect(confirmBtn(), 'a confirmation whose only scope vanished must not stay executable').toBeDisabled();
    fireEvent.click(confirmBtn()!);
    await flush();
    expect(setNeedLine).not.toHaveBeenCalled();
    expect(screen.queryByTestId('cn2b-nl-notice'), 'nothing may be reported saved when nothing was written').toBeNull();
    expect(screen.getByTestId('cn2b-nl-preview-stale')).toBeInTheDocument();
  });

  it('S2 — a selected cell whose row is UN-MAPPED is never silently dropped from a confirmed write', async () => {
    const { rerenderWith } = renderPanel('en');
    legacyPick(ROW_5, 'final');
    legacyPick(ROW_6, 'final');
    fillReason();
    openPreview();
    expect(screen.getByTestId('cn2b-nl-affected')).toHaveTextContent('2');

    rerenderWith({ dispositions: [disposition(ROW_5), disposition(ROW_6, null, 'not_applicable'), disposition(ROW_7, ITEM_B)] });

    expect(confirmBtn(), 'the preview promised 2 sources; it must not stay executable once 1 would be written').toBeDisabled();
    fireEvent.click(confirmBtn()!);
    expect(setNeedLine, 'the preview said 2 sources; a 1-source write must not execute under it').not.toHaveBeenCalled();

    // The operator removes the unavailable designation explicitly, and previews again.
    fireEvent.click(within(screen.getByTestId('cn2b-nl-unavailable-selection'))
      .getByRole('button', { name: T.cn2b_nl_unavailable_remove.en }));
    openPreview();
    expect(screen.getByTestId('cn2b-nl-affected')).toHaveTextContent('1');
    fireEvent.click(confirmBtn()!);
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0].quantitySources.map((s: { sourceRecordId: string }) => s.sourceRecordId)).toEqual(['rec-5-final']);
  });

  it('S3 — a selected cell claimed by a line saved elsewhere blocks the confirmation instead of double-counting it', () => {
    const { rerenderWith } = renderPanel('en');
    legacyPick(ROW_5, 'final');
    fillReason();
    openPreview();

    rerenderWith({
      needLines: [line({ id: 'nl-9', approvedQuantity: '120.5' })],
      claimedSources: [link('nl-9', 'rec-5-final', '120.5')],
    });

    expect(confirmBtn(), 'a cell now claimed by another line must not be re-sent under the old preview').toBeDisabled();
    fireEvent.click(confirmBtn()!);
    expect(setNeedLine).not.toHaveBeenCalled();
    expect(screen.getByTestId('cn2b-nl-unavailable-selection')).toHaveTextContent('1');
  });

  it('S4 — a re-mapped beneficiary makes the preview stale; only a refreshed preview executes, exactly as shown', async () => {
    const { rerenderWith } = renderPanel('en');
    await namesLoaded();
    pick(ROW_5, 'final');
    fillReason();
    openPreview();
    expect(screen.getByTestId('cn2b-nl-preview-group')).toHaveAttribute('data-beneficiary', BENE);

    rerenderWith({ beneficiaryColumns: [beneficiaryColumn(2, BENE2), beneficiaryColumn(3, BENE)] });

    expect(screen.getByTestId('cn2b-nl-preview-stale')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-nl-preview-group'), 'the stale preview still shows what was opened').toHaveAttribute('data-beneficiary', BENE);
    expect(confirmBtn()).toBeDisabled();
    fireEvent.click(confirmBtn()!);
    expect(setNeedLine).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_preview_refresh.en }));
    expect(screen.queryByTestId('cn2b-nl-preview-stale')).toBeNull();
    expect(screen.getByTestId('cn2b-nl-preview-group')).toHaveAttribute('data-beneficiary', BENE2);
    fireEvent.click(confirmBtn()!);
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0].beneficiaryOrganizationId).toBe(BENE2);
  });

  it('S5 — clearing the justification while a preview is open cannot confirm a blank reason', () => {
    renderPanel('en');
    legacyPick(ROW_5, 'final');
    fillReason();
    openPreview();
    fillReason('   ');
    const confirm = confirmBtn();
    if (confirm) fireEvent.click(confirm);
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('S6 — in the normal path every previewed scope equals the call that executes', async () => {
    renderPanel('en', {
      records: [record('rec-a', ROW_5, 'Hospital A', 100, 1, 1), record('rec-b', ROW_5, 'Hospital B', 50.25, 2, 2)],
      beneficiaryColumns: [beneficiaryColumn(1, BENE), beneficiaryColumn(2, BENE2)],
    });
    pick(ROW_5, 'Hospital A');
    pick(ROW_5, 'Hospital B');
    fillReason();
    openPreview();
    const shown = screen.getAllByTestId('cn2b-nl-preview-group').map((g) => ({
      beneficiary: g.getAttribute('data-beneficiary'), ...scopeFacts(g),
    }));
    fireEvent.click(confirmBtn()!);
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(2));
    const executed = setNeedLine.mock.calls.map((c) => c[0]);
    for (const s of shown) {
      const call = executed.find((c) => c.beneficiaryOrganizationId === s.beneficiary)!;
      expect(call.centralItemId).toBe(s.material);
      expect(call.approvedQuantity).toBe(s.resulting);
      expect(String(call.quantitySources.length)).toBe(s['new-sources']);
      expect(sumExactDecimals(call.quantitySources.map((q: { designatedQuantity: string }) => q.designatedQuantity))).toBe(s.added);
    }
  });
});

// ============================================================================
// N. Both languages, and presentation coupling other suites rely on.
// ============================================================================
describe('UX-2C — bilingual presentation and coexistence', () => {
  const NEW_KEYS = [
    'cn2b_nl_flow_label', 'cn2b_nl_flow_evidence', 'cn2b_nl_flow_selection', 'cn2b_nl_flow_contribution',
    'cn2b_nl_flow_scope', 'cn2b_nl_flow_line', 'cn2b_nl_flow_confirm', 'cn2b_nl_flow_persisted',
    'cn2b_nl_sum_label', 'cn2b_nl_sum_available', 'cn2b_nl_sum_selected', 'cn2b_nl_sum_unresolved',
    'cn2b_nl_sum_non_beneficiary', 'cn2b_nl_sum_lines', 'cn2b_nl_sum_claimed', 'cn2b_nl_evidence_title',
    'cn2b_nl_filter_search', 'cn2b_nl_filter_search_hint', 'cn2b_nl_filter_state_label', 'cn2b_nl_filter_all',
    'cn2b_nl_filter_available', 'cn2b_nl_filter_selected', 'cn2b_nl_filter_resolved', 'cn2b_nl_filter_unresolved',
    'cn2b_nl_filter_non_beneficiary', 'cn2b_nl_filter_clear', 'cn2b_nl_count_total', 'cn2b_nl_count_visible',
    'cn2b_nl_count_selected', 'cn2b_nl_count_selected_hidden', 'cn2b_nl_col_evidence', 'cn2b_nl_col_authority',
    'cn2b_nl_col_designation', 'cn2b_nl_source_value', 'cn2b_nl_source_value_not_decimal', 'cn2b_nl_location_column',
    'cn2b_nl_location_cell', 'cn2b_nl_material', 'cn2b_nl_why_unresolved', 'cn2b_nl_why_non_beneficiary',
    'cn2b_nl_not_designated', 'cn2b_nl_suggestion_note', 'cn2b_nl_override_recorded', 'cn2b_nl_override_applied',
    'cn2b_nl_unavailable_row', 'cn2b_nl_empty_no_evidence', 'cn2b_nl_empty_all_claimed', 'cn2b_nl_empty_all_unresolved',
    'cn2b_nl_empty_none_designatable', 'cn2b_nl_empty_filtered', 'cn2b_nl_selection_title', 'cn2b_nl_selection_sources',
    'cn2b_nl_selection_beneficiaries', 'cn2b_nl_selection_scopes', 'cn2b_nl_scope_material', 'cn2b_nl_scope_warehouse',
    'cn2b_nl_scope_new_sources', 'cn2b_nl_scope_added', 'cn2b_nl_scope_unit', 'cn2b_nl_scope_unit_locked',
    'cn2b_nl_scope_existing_sources', 'cn2b_nl_quantity_invalid_short', 'cn2b_nl_unavailable_selected',
    'cn2b_nl_unavailable_remove', 'cn2b_nl_attributes_title', 'cn2b_nl_unit_explainer', 'cn2b_nl_unit_locked_note',
    'cn2b_nl_warehouse_needs_selection', 'cn2b_nl_warehouse_of', 'cn2b_nl_review_title', 'cn2b_nl_blockers_title',
    'cn2b_nl_block_no_selection', 'cn2b_nl_block_quantity', 'cn2b_nl_block_reason', 'cn2b_nl_block_unavailable',
    'cn2b_nl_preview_heading', 'cn2b_nl_preview_explainer', 'cn2b_nl_preview_reason', 'cn2b_nl_preview_stale',
    'cn2b_nl_preview_refresh', 'cn2b_nl_error_title', 'cn2b_nl_register_title', 'cn2b_nl_register_hint',
    'cn2b_nl_line_sources', 'cn2b_nl_override_in_lineage', 'cn2b_nl_delete_line_label', 'cn2b_nl_delete_sources_affected',
  ];

  it('[39] defines distinct Arabic and English text for every UX-2C string, and the panel uses no undefined key', () => {
    for (const key of NEW_KEYS) {
      expect(T[key], key).toBeDefined();
      expect(T[key].ar.trim().length, key).toBeGreaterThan(0);
      expect(T[key].en.trim().length, key).toBeGreaterThan(0);
      expect(T[key].ar, key).not.toBe(T[key].en);
    }
    const used = new Set(read(PANEL_PATH).match(/'cn2b_[a-z_]+'/g)!.map((k) => k.slice(1, -1)));
    for (const key of used) expect(T[key], `panel uses undefined key ${key}`).toBeDefined();
  });

  it('renders the Arabic workspace without English leaking into it', async () => {
    renderPanel('ar');
    expect(screen.getByText(T.cn2b_nl_sum_available.ar)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_nl_sum_available.en)).toBeNull();
    expect(screen.getByRole('button', { name: T.cn2b_nl_filter_all.ar })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: T.cn2b_nl_filter_all.en })).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('cn2b-nl-candidate-beneficiary')[0]).toHaveTextContent('مستشفى المنتفع'));
  });

  it('names no button with a workflow stage title (the navigator matches stage buttons by title)', () => {
    renderPanel('en');
    pick(ROW_5, 'final');
    fillReason();
    openPreview();
    const stageTitles = ['cn2b_stage_plan', 'cn2b_stage_source', 'cn2b_stage_review', 'cn2b_stage_beneficiaries',
      'cn2b_stage_need_lines', 'cn2b_stage_readiness'].map((k) => T[k].en.toLowerCase());
    const buttonKeys = [...EVIDENCE_BUTTON_KEYS, 'cn2b_nl_filter_clear', 'cn2b_nl_unavailable_remove', 'cn2b_nl_preview_refresh'];
    for (const key of buttonKeys) {
      for (const title of stageTitles) expect(T[key].en.toLowerCase(), key).not.toContain(title);
    }
    for (const b of screen.getAllByRole('button')) {
      for (const title of stageTitles) expect((b.textContent ?? '').toLowerCase()).not.toContain(title);
    }
  });

  it('renders no location text ending in "#<n>" (the screen locates beneficiary columns that way)', () => {
    renderPanel('en');
    for (const el of document.querySelectorAll('.cn2b-needlines *')) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
      expect(own, own).not.toMatch(/#\d+$/);
    }
  });

  it('contains no literal U+0000 byte in any UX-2C file', () => {
    for (const rel of [
      PANEL_PATH, 'src/shared/i18n/strings.ts', 'src/shared/lib/central-needs.css',
      'src/features/central-needs/__tests__/cn2b-ux2c-need-lines-workspace.runtime.test.tsx',
    ]) {
      expect(readFileSync(join(ROOT, rel)).includes(0), rel).toBe(false);
    }
  });
});

const EVIDENCE_BUTTON_KEYS = [
  'cn2b_nl_filter_all', 'cn2b_nl_filter_available', 'cn2b_nl_filter_selected',
  'cn2b_nl_filter_resolved', 'cn2b_nl_filter_unresolved', 'cn2b_nl_filter_non_beneficiary',
];
