/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type { BeneficiaryColumnSummary } from '../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

/**
 * UX-2B — the BENEFICIARY MAPPING WORKSPACE.
 *
 * The summary, the filters and the denser row are presentation. This suite
 * exists to keep them that way, and it is built around the two failures such a
 * workspace invites:
 *
 *   1. A FILTER THAT DECIDES. Narrowing the view must never write, never
 *      select, never discard a decision a reviewer has already typed, and never
 *      reach the server. Every filter action below is asserted against the real
 *      service mock: it must record ZERO calls.
 *
 *   2. A SUMMARY THAT INVENTS TRUTH. Every count is derived from the `columns`
 *      prop the server already supplied — including "blocking submission",
 *      which counts the server's own `reviewRequired` marker rather than
 *      re-deriving when a column ought to block.
 *
 * The business contract itself — three persisted states, suggestion-only exact
 * match, reason-on-correction, unresolved-only group apply and the write-time
 * re-filter — is owned by cn2b-beneficiary-column-panel.runtime.test.tsx and is
 * deliberately NOT re-litigated here, only re-checked where UX-2B could have
 * eroded it.
 */

const setBeneficiaryColumns = vi.fn();
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  return { ...actual, setBeneficiaryColumns: (...a: unknown[]) => setBeneficiaryColumns(...a) };
});

const { CentralNeedsBeneficiaryColumnPanel, NON_BENEFICIARY_CHOICE } = await import('../CentralNeedsBeneficiaryColumnPanel');

const HOSPITAL_A = '00000000-0000-0000-0000-0000000000c1';
const HOSPITAL_B = '00000000-0000-0000-0000-0000000000c2';

const ORGS: OrgRow[] = [
  { id: HOSPITAL_A, name: 'Hospital A', name_ar: 'مستشفى أ', code: 'alpha', status: 'active', organizationKind: 'care_institution' },
  { id: HOSPITAL_B, name: 'Hospital B', name_ar: 'مستشفى ب', code: 'bravo', status: 'active', organizationKind: 'care_institution' },
] as unknown as OrgRow[];

const col = (columnIndex: number, over: Partial<BeneficiaryColumnSummary> = {}): BeneficiaryColumnSummary => ({
  importSessionId: 's1',
  originalFilename: 'need-2026.xlsx',
  archiveEntryPath: null,
  sheetIndex: 0,
  sheetName: 'Sheet1',
  columnIndex,
  sourceFieldName: null,
  numericValueCount: 5,
  zeroValueCount: 1,
  nonzeroNumericCount: 4,
  mappingId: null,
  decision: null,
  beneficiaryOrganizationId: null,
  mappingReason: null,
  mappedAt: null,
  mappedRowNumericCount: 5,
  reviewRequired: true,
  ...over,
});

const beneficiaryCol = (columnIndex: number, orgId: string, over: Partial<BeneficiaryColumnSummary> = {}) =>
  col(columnIndex, {
    mappingId: `m-${columnIndex}`, decision: 'beneficiary', beneficiaryOrganizationId: orgId,
    mappingReason: 'confirmed', mappedAt: '2026-01-02T00:00:00.000Z', reviewRequired: false, ...over,
  });

const nonBeneficiaryCol = (columnIndex: number, over: Partial<BeneficiaryColumnSummary> = {}) =>
  col(columnIndex, {
    mappingId: `m-${columnIndex}`, decision: 'non_beneficiary', beneficiaryOrganizationId: null,
    mappingReason: 'row number column', mappedAt: '2026-01-02T00:00:00.000Z', reviewRequired: false, ...over,
  });

type PanelProps = Parameters<typeof CentralNeedsBeneficiaryColumnPanel>[0];

function renderPanel(lang: 'ar' | 'en', over: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    lang, planRevisionId: 'rev-1', editable: true, columns: [],
    activeCareInstitutions: ORGS, onChanged: () => {}, ...over,
  };
  return render(<CentralNeedsBeneficiaryColumnPanel {...props} />);
}

/** The same two-level walk the original suite uses, so both agree on "a row". */
function rowFor(columnIndex: number): HTMLElement {
  const infoLine = screen.getByText(new RegExp(`#${columnIndex}$`));
  return infoLine.parentElement!.parentElement as HTMLElement;
}

const rows = () => screen.queryAllByTestId('cn2b-bc-row');
const visibleColumnNumbers = () =>
  rows().map((r) => Number((r.querySelector('.cn2b-bc__ident')!.textContent!.match(/#(\d+)$/) ?? [])[1]));
const count = (which: string) => document.querySelector(`[data-bc-count="${which}"]`)?.textContent;

const searchBox = () => screen.getByRole('searchbox', { name: T.cn2b_bc_filter_search.en });
const stateBtn = (name: string) => screen.getByRole('button', { name });
const confirmIn = (row: HTMLElement) => within(row).getByRole('button', { name: T.cn2b_beneficiary_column_confirm.en });
const chooseIn = (row: HTMLElement, value: string) => fireEvent.change(within(row).getByRole('combobox'), { target: { value } });
const requiredReasonIn = (row: HTMLElement) =>
  within(row).getByRole('textbox', { name: T.cn2b_beneficiary_column_reason_required.en });

/** A realistic mixed workbook: unresolved, beneficiary, non-beneficiary. */
function mixedColumns() {
  return [
    col(1, { sourceFieldName: 'قطاع كوثى', originalFilename: 'alpha-2026.xlsx' }),
    col(2, { sourceFieldName: 'قطاع كوثى', originalFilename: 'alpha-2026.xlsx' }),
    beneficiaryCol(3, HOSPITAL_A, { sourceFieldName: 'Hospital A', sheetName: 'Ward' }),
    nonBeneficiaryCol(4, { sourceFieldName: 'Serial', mappingReason: 'row counter column' }),
  ];
}

beforeEach(() => {
  setBeneficiaryColumns.mockReset().mockResolvedValue({ confirmed: [] });
});
afterEach(() => cleanup());

// ============================================================================
// A. The workspace summary counts the server's own answers.
// ============================================================================
describe('UX-2B — workspace summary', () => {
  it('counts total, unresolved, beneficiary, non-beneficiary and visible from the loaded columns', () => {
    renderPanel('en', { columns: mixedColumns() });
    expect(count('total')).toBe('4');
    expect(count('unresolved')).toBe('2');
    expect(count('beneficiary')).toBe('1');
    expect(count('non_beneficiary')).toBe('1');
    expect(count('visible')).toBe('4');
  });

  it('counts BLOCKING READINESS from the server-provided reviewRequired, not from a local rule', () => {
    renderPanel('en', {
      columns: [
        // Unresolved but the SERVER says it does not block — the count must obey
        // the server, not infer "unresolved therefore blocking".
        col(1, { reviewRequired: false }),
        col(2, { reviewRequired: true }),
        // Reviewed yet still flagged by the server: counted, because the server said so.
        beneficiaryCol(3, HOSPITAL_A, { reviewRequired: true }),
      ],
    });
    expect(count('unresolved')).toBe('2');
    expect(count('blocking'), 'blocking must mirror reviewRequired exactly').toBe('2');
  });

  it('keeps one physical column per row even when two share an identical header', () => {
    renderPanel('en', { columns: [col(20, { sourceFieldName: 'مرجان' }), col(21, { sourceFieldName: 'مرجان' })] });
    expect(rows()).toHaveLength(2);
    expect(visibleColumnNumbers()).toEqual([20, 21]);
    expect(count('total')).toBe('2');
  });

  it('still labels the three explicit review states, one per row', () => {
    renderPanel('en', { columns: mixedColumns() });
    expect(within(rowFor(1)).getByTestId('cn2b-bc-state')).toHaveTextContent(T.cn2b_beneficiary_column_state_unresolved.en);
    expect(within(rowFor(3)).getByTestId('cn2b-bc-state')).toHaveTextContent(T.cn2b_beneficiary_column_state_beneficiary.en);
    expect(within(rowFor(4)).getByTestId('cn2b-bc-state')).toHaveTextContent(T.cn2b_beneficiary_column_state_non_beneficiary.en);
  });
});

// ============================================================================
// B. Filtering is presentation. It calls nothing and decides nothing.
// ============================================================================
describe('UX-2B — filtering is client-only', () => {
  it('makes ZERO service calls for any filter interaction', () => {
    renderPanel('en', { columns: mixedColumns() });
    fireEvent.change(searchBox(), { target: { value: 'alpha' } });
    fireEvent.click(stateBtn(T.cn2b_bc_filter_state_unresolved.en));
    fireEvent.click(screen.getByRole('checkbox', { name: T.cn2b_bc_filter_blocking_only.en }));
    fireEvent.click(stateBtn(T.cn2b_bc_filter_state_all.en));
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_bc_filter_clear.en }));
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });

  it('narrows to each persisted state correctly', () => {
    renderPanel('en', { columns: mixedColumns() });

    fireEvent.click(stateBtn(T.cn2b_bc_filter_state_unresolved.en));
    expect(visibleColumnNumbers()).toEqual([1, 2]);
    expect(count('visible')).toBe('2');
    expect(count('total'), 'the totals describe the workbook, not the view').toBe('4');

    fireEvent.click(stateBtn(T.cn2b_bc_filter_state_beneficiary.en));
    expect(visibleColumnNumbers()).toEqual([3]);

    fireEvent.click(stateBtn(T.cn2b_bc_filter_state_non_beneficiary.en));
    expect(visibleColumnNumbers()).toEqual([4]);

    fireEvent.click(stateBtn(T.cn2b_bc_filter_state_all.en));
    expect(visibleColumnNumbers()).toEqual([1, 2, 3, 4]);
  });

  it('filters to the columns the server marks as blocking submission', () => {
    renderPanel('en', { columns: mixedColumns() });
    fireEvent.click(screen.getByRole('checkbox', { name: T.cn2b_bc_filter_blocking_only.en }));
    // Only the two unresolved fixtures carry reviewRequired.
    expect(visibleColumnNumbers()).toEqual([1, 2]);
  });

  it('searches the source evidence — filename, sheet, header, column number, institution and reason', () => {
    renderPanel('en', { columns: mixedColumns() });
    const search = (v: string) => fireEvent.change(searchBox(), { target: { value: v } });

    search('alpha-2026');                       // filename
    expect(visibleColumnNumbers()).toEqual([1, 2]);
    search('Ward');                             // sheet name
    expect(visibleColumnNumbers()).toEqual([3]);
    search('قطاع كوثى');                        // source header, Arabic
    expect(visibleColumnNumbers()).toEqual([1, 2]);
    search('#4');                               // physical column number
    expect(visibleColumnNumbers()).toEqual([4]);
    search('Hospital A');                       // mapped institution name
    expect(visibleColumnNumbers()).toEqual([3]);
    search('row counter');                      // recorded mapping reason
    expect(visibleColumnNumbers()).toEqual([4]);
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });

  it('restores every row when the filters are cleared', () => {
    renderPanel('en', { columns: mixedColumns() });
    fireEvent.change(searchBox(), { target: { value: 'alpha-2026' } });
    fireEvent.click(stateBtn(T.cn2b_bc_filter_state_unresolved.en));
    expect(visibleColumnNumbers()).toEqual([1, 2]);

    fireEvent.click(screen.getByRole('button', { name: T.cn2b_bc_filter_clear.en }));
    expect(visibleColumnNumbers()).toEqual([1, 2, 3, 4]);
    expect(count('visible')).toBe('4');
    expect((searchBox() as HTMLInputElement).value).toBe('');
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });

  it('does not silently discard a decision typed against a column a filter then hides', () => {
    renderPanel('en', { columns: mixedColumns() });
    // Stage a correction on the already-reviewed column 3.
    const row3 = rowFor(3);
    chooseIn(row3, HOSPITAL_B);
    fireEvent.change(requiredReasonIn(row3), { target: { value: 'Re-read: column 3 is Hospital B' } });
    expect(confirmIn(rowFor(3))).toBeEnabled();

    // Hide it behind a filter, then bring it back.
    fireEvent.click(stateBtn(T.cn2b_bc_filter_state_unresolved.en));
    expect(visibleColumnNumbers()).toEqual([1, 2]);
    fireEvent.click(stateBtn(T.cn2b_bc_filter_state_all.en));

    const back = rowFor(3);
    expect((within(back).getByRole('combobox') as HTMLSelectElement).value).toBe(HOSPITAL_B);
    expect((requiredReasonIn(back) as HTMLInputElement).value).toBe('Re-read: column 3 is Hospital B');
    expect(confirmIn(back)).toBeEnabled();
    expect(setBeneficiaryColumns, 'filtering must never write').not.toHaveBeenCalled();
  });
});

// ============================================================================
// C. The business contract UX-2B could have eroded.
// ============================================================================
describe('UX-2B — the decision contract survives the redesign', () => {
  it('shows an exact header match as a SUGGESTION, pre-filled but never saved', () => {
    renderPanel('en', { columns: [col(1, { sourceFieldName: '  Hospital A  ' })] });
    const row = rowFor(1);
    expect(within(row).getByText(T.cn2b_beneficiary_column_status_suggested.en)).toBeInTheDocument();
    expect((within(row).getByRole('combobox') as HTMLSelectElement).value).toBe(HOSPITAL_A);
    // Still unresolved, still marked as a suggestion rather than a decision.
    expect(within(row).getByTestId('cn2b-bc-state')).toHaveTextContent(T.cn2b_beneficiary_column_state_unresolved.en);
    expect(row.dataset.suggested).toBe('true');
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });

  it('leaves a header that matches nothing unresolved, unselected and unmarked', () => {
    renderPanel('en', { columns: [col(1, { sourceFieldName: 'Hospital A (Main Store)' })] });
    const row = rowFor(1);
    expect((within(row).getByRole('combobox') as HTMLSelectElement).value).toBe('');
    expect(within(row).getByText(T.cn2b_beneficiary_column_hint_no_exact_match.en)).toBeInTheDocument();
    expect(row.dataset.suggested).toBeUndefined();
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });

  it('still requires a typed reason to correct a reviewed column, and states current → proposed', () => {
    renderPanel('en', { columns: [beneficiaryCol(3, HOSPITAL_A)] });
    const row = rowFor(3);
    chooseIn(row, HOSPITAL_B);

    const change = within(row).getByTestId('cn2b-bc-change');
    expect(change).toHaveTextContent('Hospital A');
    expect(change).toHaveTextContent('Hospital B');

    expect(confirmIn(row)).toBeDisabled();
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();

    fireEvent.change(requiredReasonIn(row), { target: { value: 'Signed correction letter' } });
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns.mock.calls[0][0]).toMatchObject({
      mappingReason: 'Signed correction letter',
      mappings: [{ decision: 'beneficiary', beneficiaryOrganizationId: HOSPITAL_B, previousDecision: 'beneficiary' }],
    });
  });

  it('still requires a typed reason for NON-BENEFICIARY, even on a first decision', () => {
    renderPanel('en', { columns: [col(2, { sourceFieldName: 'Serial' })] });
    const row = rowFor(2);
    chooseIn(row, NON_BENEFICIARY_CHOICE);
    expect(confirmIn(row)).toBeDisabled();
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();

    fireEvent.change(requiredReasonIn(row), { target: { value: 'Serial number column' } });
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns.mock.calls[0][0]).toMatchObject({
      mappingReason: 'Serial number column',
      mappings: [{ decision: 'non_beneficiary', beneficiaryOrganizationId: null, previousDecision: null }],
    });
  });

  it('preserves the adopted initial-confirmation reason for a first BENEFICIARY decision', () => {
    renderPanel('en', { columns: [col(3)] });
    const row = rowFor(3);
    chooseIn(row, HOSPITAL_A);
    fireEvent.click(confirmIn(row));
    const arg = setBeneficiaryColumns.mock.calls[0][0];
    expect(arg.mappingReason).toBe(T.cn2b_beneficiary_column_initial_reason.en);
    expect(arg.mappingReason).not.toBe(T.cn2b_beneficiary_column_confirm.en);
  });

  it('lets a human FIND an institution without selecting one for them', () => {
    renderPanel('en', { columns: [col(1)] });
    const picker = screen.getByRole('searchbox', { name: T.cn2b_bc_filter_institution.en });

    // Search by code — the option list narrows, the selection does not move.
    fireEvent.change(picker, { target: { value: 'bravo' } });
    const select = within(rowFor(1)).getByRole('combobox') as HTMLSelectElement;
    expect(within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value))
      .toEqual(['', HOSPITAL_B, NON_BENEFICIARY_CHOICE]);
    expect(select.value, 'a search must never auto-select').toBe('');
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();

    // Arabic name finds it too.
    fireEvent.change(picker, { target: { value: 'مستشفى أ' } });
    expect(within(within(rowFor(1)).getByRole('combobox')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value))
      .toEqual(['', HOSPITAL_A, NON_BENEFICIARY_CHOICE]);
  });
});

// ============================================================================
// D. Group apply — preview, scope and the write-time re-filter.
// ============================================================================
describe('UX-2B — group apply preview', () => {
  const siblings = () => [
    col(1, { sourceFieldName: 'قطاع كوثى' }),
    col(2, { sourceFieldName: 'قطاع كوثى' }),
    col(3, { sourceFieldName: 'قطاع كوثى' }),
  ];

  it('previews the exact unresolved target count, the proposed decision and the group header', () => {
    renderPanel('en', { columns: siblings() });
    const row1 = rowFor(1);
    chooseIn(row1, HOSPITAL_A);
    fireEvent.click(within(row1).getByRole('button', { name: 'Apply to 3 matching columns' }));

    expect(setBeneficiaryColumns, 'preview must not write').not.toHaveBeenCalled();
    expect(screen.getByTestId('cn2b-bc-group-proposed')).toHaveTextContent('Hospital A');
    expect(screen.getByTestId('cn2b-bc-group-label')).toHaveTextContent('قطاع كوثى');
    expect(screen.getByText(T.cn2b_beneficiary_column_group_scope_note.en)).toBeInTheDocument();
    // Every targeted physical column is listed, beside its own row.
    for (const n of [1, 2, 3]) expect(screen.getAllByText(new RegExp(`#${n}$`))).toHaveLength(2);
  });

  it('excludes already-reviewed siblings from the offer', () => {
    renderPanel('en', {
      columns: [
        col(1, { sourceFieldName: 'قطاع كوثى' }),
        col(2, { sourceFieldName: 'قطاع كوثى' }),
        beneficiaryCol(3, HOSPITAL_B, { sourceFieldName: 'قطاع كوثى' }),
      ],
    });
    const row1 = rowFor(1);
    chooseIn(row1, HOSPITAL_A);
    // Two unresolved siblings remain, never three.
    expect(within(row1).getByRole('button', { name: 'Apply to 2 matching columns' })).toBeInTheDocument();
    expect(within(row1).queryByRole('button', { name: 'Apply to 3 matching columns' })).toBeNull();
  });

  it('re-filters at write time, so a column reviewed meanwhile is not overwritten', () => {
    const { rerender } = renderPanel('en', { columns: siblings() });
    const row1 = rowFor(1);
    chooseIn(row1, HOSPITAL_A);
    fireEvent.click(within(row1).getByRole('button', { name: 'Apply to 3 matching columns' }));

    // Column 2 is reviewed by someone else while the preview is open.
    rerender(
      <CentralNeedsBeneficiaryColumnPanel
        lang="en" planRevisionId="rev-1" editable columns={[
          col(1, { sourceFieldName: 'قطاع كوثى' }),
          beneficiaryCol(2, HOSPITAL_B, { sourceFieldName: 'قطاع كوثى' }),
          col(3, { sourceFieldName: 'قطاع كوثى' }),
        ]} activeCareInstitutions={ORGS} onChanged={() => {}}
      />,
    );

    const previewPane = screen.getByRole('button', { name: 'Cancel' }).parentElement as HTMLElement;
    fireEvent.click(within(previewPane).getByRole('button', { name: T.cn2b_beneficiary_column_confirm.en }));

    const { mappings } = setBeneficiaryColumns.mock.calls[0][0];
    expect(mappings.map((m: { columnIndex: number }) => m.columnIndex).sort(), 'column 2 was reviewed meanwhile')
      .toEqual([1, 3]);
  });
});

// ============================================================================
// E. Empty, filtered-empty and read-only are three different statements.
// ============================================================================
describe('UX-2B — distinct empty and read-only states', () => {
  it('says "no columns loaded" — not "no matches" — when the revision has none', () => {
    renderPanel('en', { columns: [] });
    expect(screen.getByText(T.cn2b_bc_empty_no_columns.en)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_bc_empty_filtered.en)).toBeNull();
    // With nothing loaded there is nothing to summarise or filter.
    expect(document.querySelector('[data-bc-count="total"]')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('says "no matches" — not "no columns" — when filters hide everything', () => {
    renderPanel('en', { columns: mixedColumns() });
    fireEvent.change(searchBox(), { target: { value: 'no-such-column' } });
    expect(screen.getByText(T.cn2b_bc_empty_filtered.en)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_bc_empty_no_columns.en)).toBeNull();
    expect(count('visible')).toBe('0');
    expect(count('total'), 'the workbook still has its columns').toBe('4');
  });

  it('states the revision is read-only and exposes no mutation control at all', () => {
    renderPanel('en', { editable: false, columns: mixedColumns() });
    expect(screen.getByText(T.cn2b_bc_read_only.en)).toBeInTheDocument();
    // The workspace stays legible and filterable, but nothing can be changed.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: T.cn2b_beneficiary_column_confirm.en })).toBeNull();
    expect(screen.queryByRole('searchbox', { name: T.cn2b_bc_filter_institution.en })).toBeNull();
    expect(rows()).toHaveLength(4);
  });

  it('shows a write failure through the Central Needs translator, and writes nothing further', async () => {
    setBeneficiaryColumns.mockRejectedValueOnce({ code: 'forbidden' });
    renderPanel('en', { columns: [col(3)] });
    const row = rowFor(3);
    chooseIn(row, HOSPITAL_A);
    fireEvent.click(confirmIn(row));
    expect(await screen.findByRole('alert')).toHaveTextContent(T.cn2b_err_forbidden.en);
  });
});

// ============================================================================
// F. Both languages carry every new string.
// ============================================================================
describe('UX-2B — bilingual presentation', () => {
  const NEW_KEYS = [
    'cn2b_bc_sum_total', 'cn2b_bc_sum_unresolved', 'cn2b_bc_sum_beneficiary',
    'cn2b_bc_sum_non_beneficiary', 'cn2b_bc_sum_blocking', 'cn2b_bc_sum_visible',
    'cn2b_bc_filter_search', 'cn2b_bc_filter_search_hint', 'cn2b_bc_filter_state_label',
    'cn2b_bc_filter_state_all', 'cn2b_bc_filter_state_unresolved', 'cn2b_bc_filter_state_beneficiary',
    'cn2b_bc_filter_state_non_beneficiary', 'cn2b_bc_filter_blocking_only',
    'cn2b_bc_filter_institution', 'cn2b_bc_filter_institution_hint', 'cn2b_bc_filter_clear',
    'cn2b_bc_empty_no_columns', 'cn2b_bc_empty_filtered', 'cn2b_bc_read_only',
    'cn2b_bc_current', 'cn2b_bc_proposed', 'cn2b_bc_group_proposed', 'cn2b_bc_group_label',
  ];

  it('defines Arabic and English for every UX-2B string, each distinct from the other', () => {
    for (const key of NEW_KEYS) {
      expect(T[key], key).toBeDefined();
      expect(T[key].ar.trim().length, key).toBeGreaterThan(0);
      expect(T[key].en.trim().length, key).toBeGreaterThan(0);
      expect(T[key].ar, `${key} must not reuse the English text`).not.toBe(T[key].en);
    }
  });

  it('never reuses a persisted STATE label as a filter label', () => {
    // A control that reads exactly like a column's state would misrepresent the
    // three-state contract the moment both are on screen together.
    const stateLabels = [
      T.cn2b_beneficiary_column_state_unresolved, T.cn2b_beneficiary_column_state_beneficiary,
      T.cn2b_beneficiary_column_state_non_beneficiary,
    ];
    const filterLabels = [
      T.cn2b_bc_filter_state_all, T.cn2b_bc_filter_state_unresolved,
      T.cn2b_bc_filter_state_beneficiary, T.cn2b_bc_filter_state_non_beneficiary,
    ];
    for (const f of filterLabels) {
      for (const s of stateLabels) {
        expect(f.en).not.toBe(s.en);
        expect(f.ar).not.toBe(s.ar);
      }
    }
  });

  it('renders the Arabic workspace without English leaking into it', () => {
    renderPanel('ar', { columns: mixedColumns() });
    expect(screen.getByText(T.cn2b_bc_sum_total.ar)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_bc_sum_total.en)).toBeNull();
    expect(screen.getByRole('button', { name: T.cn2b_bc_filter_state_unresolved.ar })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: T.cn2b_bc_filter_state_unresolved.en })).toBeNull();
    expect(within(rowFor(3)).getByTestId('cn2b-bc-beneficiary-name')).toHaveTextContent('مستشفى أ');
  });
});
