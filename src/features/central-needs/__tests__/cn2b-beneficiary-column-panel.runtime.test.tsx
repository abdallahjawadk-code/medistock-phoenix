/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type { BeneficiaryColumnSummary } from '../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

/**
 * CN-2B CORRECTIVE EXTENSION (213) — `CentralNeedsBeneficiaryColumnPanel`.
 *
 * This is the ONLY place a physical imported column's review decision is ever
 * made. Every assertion here traces back to the rules in the component's own
 * header: workbook text is evidence only; no whole-file shortcut (every
 * physical column persists independently even under a group apply); every
 * column is in exactly one explicit state — BENEFICIARY, NON-BENEFICIARY or
 * UNRESOLVED — and "no decision" is never read as "not a beneficiary"; any
 * change to an existing decision, and any non-beneficiary decision, carries a
 * human-entered reason (independent review finding 2); and the server — not
 * this component — is the eventual authority.
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
  { id: HOSPITAL_A, name: 'Hospital A', name_ar: 'مستشفى أ', code: 'ha', status: 'active', organizationKind: 'care_institution' },
  { id: HOSPITAL_B, name: 'Hospital B', name_ar: 'مستشفى ب', code: 'hb', status: 'active', organizationKind: 'care_institution' },
] as unknown as OrgRow[];

/** An UNRESOLVED column (no review decision) carrying numeric cells on mapped rows. */
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
    lang,
    planRevisionId: 'rev-1',
    editable: true,
    columns: [],
    activeCareInstitutions: ORGS,
    onChanged: () => {},
    ...over,
  };
  return render(<CentralNeedsBeneficiaryColumnPanel {...props} />);
}

function rowFor(columnIndex: number): HTMLElement {
  // Each row shows "<file> · <sheet> · #<columnIndex>" as its own text div,
  // nested two levels inside the actual row (text div → info block → row) —
  // the row itself is what carries the state badge, picker, reason and buttons.
  const infoLine = screen.getByText(new RegExp(`#${columnIndex}$`));
  return infoLine.parentElement!.parentElement as HTMLElement;
}

const confirmIn = (row: HTMLElement) => within(row).getByRole('button', { name: T.cn2b_beneficiary_column_confirm.en });
const chooseIn = (row: HTMLElement, value: string) => fireEvent.change(within(row).getByRole('combobox'), { target: { value } });
const requiredReasonIn = (row: HTMLElement) =>
  within(row).getByRole('textbox', { name: T.cn2b_beneficiary_column_reason_required.en });

beforeEach(() => {
  setBeneficiaryColumns.mockReset().mockResolvedValue({ confirmed: [] });
});
afterEach(() => cleanup());

describe('CentralNeedsBeneficiaryColumnPanel — every physical column, never the whole file', () => {
  it('renders one row per physical column, keyed on (session, sheet, column) — not on header text', () => {
    renderPanel('en', {
      columns: [
        col(3, { sourceFieldName: 'Hospital A' }),
        col(4, { sourceFieldName: 'Hospital B' }),
      ],
    });
    expect(screen.getByText(/#3$/)).toBeInTheDocument();
    expect(screen.getByText(/#4$/)).toBeInTheDocument();
  });

  it('a source header is display/evidence only: two columns with an IDENTICAL header stay two independent rows', () => {
    renderPanel('en', {
      columns: [
        col(20, { sourceFieldName: 'مرجان' }),
        col(21, { sourceFieldName: 'مرجان' }),
      ],
    });
    expect(screen.getByText(/#20$/)).toBeInTheDocument();
    expect(screen.getByText(/#21$/)).toBeInTheDocument();
    expect(screen.getAllByText(/مرجان/).length).toBeGreaterThanOrEqual(2);
  });
});

describe('CentralNeedsBeneficiaryColumnPanel — three explicit review states', () => {
  it('labels BENEFICIARY (naming the institution), NON-BENEFICIARY and UNRESOLVED explicitly', () => {
    renderPanel('en', {
      columns: [
        beneficiaryCol(1, HOSPITAL_A, { sourceFieldName: 'Hospital A' }),
        nonBeneficiaryCol(2, { sourceFieldName: '#' }),
        col(3, { sourceFieldName: 'Hospital B' }),
      ],
    });
    expect(within(rowFor(1)).getByText(T.cn2b_beneficiary_column_state_beneficiary.en)).toBeInTheDocument();
    expect(within(rowFor(1)).getByTestId('cn2b-bc-beneficiary-name')).toHaveTextContent('Hospital A');
    expect(within(rowFor(2)).getByText(T.cn2b_beneficiary_column_state_non_beneficiary.en)).toBeInTheDocument();
    expect(within(rowFor(3)).getByText(T.cn2b_beneficiary_column_state_unresolved.en)).toBeInTheDocument();
  });

  it('an unresolved column that still blocks submission says so; a reviewed column does not', () => {
    renderPanel('en', {
      columns: [
        beneficiaryCol(1, HOSPITAL_A),
        nonBeneficiaryCol(2),
        col(3),
        col(4, { mappedRowNumericCount: 0, reviewRequired: false }),
      ],
    });
    expect(within(rowFor(3)).getByText(T.cn2b_beneficiary_column_blocks_readiness.en)).toBeInTheDocument();
    for (const reviewed of [1, 2, 4]) {
      expect(within(rowFor(reviewed)).queryByText(T.cn2b_beneficiary_column_blocks_readiness.en)).toBeNull();
    }
  });

  it('a header matching no registered institution stays UNRESOLVED with a neutral evidence hint — not labelled an institution, not defaulted, not classified', () => {
    renderPanel('en', { columns: [col(1, { sourceFieldName: 'Hospital A (Main Store)' })] });
    const row = rowFor(1);
    expect(within(row).getByText(T.cn2b_beneficiary_column_state_unresolved.en)).toBeInTheDocument();
    expect(within(row).getByText(T.cn2b_beneficiary_column_hint_no_exact_match.en)).toBeInTheDocument();
    expect(within(row).queryByText(T.cn2b_beneficiary_column_status_suggested.en)).toBeNull();
    expect(within(row).queryByText(T.cn2b_beneficiary_column_state_non_beneficiary.en)).toBeNull();
    expect((within(row).getByRole('combobox') as HTMLSelectElement).value).toBe('');
  });

  it('a column for an institution that is NOT registered yet stays UNRESOLVED and blocking — never silently resolved', () => {
    renderPanel('en', { columns: [col(1, { sourceFieldName: 'قطاع لم يُسجَّل بعد' })] });
    const row = rowFor(1);
    expect(within(row).getByText(T.cn2b_beneficiary_column_state_unresolved.en)).toBeInTheDocument();
    expect(within(row).getByText(T.cn2b_beneficiary_column_blocks_readiness.en)).toBeInTheDocument();
    expect((within(row).getByRole('combobox') as HTMLSelectElement).value).toBe('');
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });

  it('a column with no header text is UNRESOLVED with no header hint at all', () => {
    renderPanel('en', { columns: [col(1, { sourceFieldName: null })] });
    const row = rowFor(1);
    expect(within(row).getByText(T.cn2b_beneficiary_column_state_unresolved.en)).toBeInTheDocument();
    expect(within(row).queryByText(T.cn2b_beneficiary_column_hint_no_exact_match.en)).toBeNull();
  });

  it('offers "not a beneficiary column" as an explicit choice beside every registered care institution', () => {
    renderPanel('en', { columns: [col(1)] });
    const options = within(within(rowFor(1)).getByRole('combobox')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['', HOSPITAL_A, HOSPITAL_B, NON_BENEFICIARY_CHOICE]);
  });
});

describe('CentralNeedsBeneficiaryColumnPanel — evidence is a suggestion, never an authority', () => {
  it('shows an exact (trim-insensitive) header/institution match as a SUGGESTION, never auto-saved', () => {
    renderPanel('en', { columns: [col(1, { sourceFieldName: '  Hospital A  ' })] });
    expect(screen.getByText(T.cn2b_beneficiary_column_status_suggested.en)).toBeInTheDocument();
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
    const select = within(rowFor(1)).getByRole('combobox') as HTMLSelectElement;
    // The suggestion pre-fills the picker so a reviewer can confirm it, but it is not a decision.
    expect(select.value).toBe(HOSPITAL_A);
    expect(within(rowFor(1)).getByText(T.cn2b_beneficiary_column_state_unresolved.en)).toBeInTheDocument();
  });

  it('shows a label matching MORE THAN ONE institution as ambiguous — offers no default choice', () => {
    renderPanel('en', {
      columns: [col(1, { sourceFieldName: 'Shared Name' })],
      activeCareInstitutions: [
        { ...ORGS[0], name: 'Shared Name' } as OrgRow,
        { ...ORGS[1], name: 'Shared Name' } as OrgRow,
      ],
    });
    expect(screen.getByText(T.cn2b_beneficiary_column_status_ambiguous.en)).toBeInTheDocument();
    expect((within(rowFor(1)).getByRole('combobox') as HTMLSelectElement).value).toBe('');
  });
});

describe('CentralNeedsBeneficiaryColumnPanel — first confirmation of an unresolved column', () => {
  it('confirms exactly the one physical column with the explicit decision, its previous (unreviewed) state and the initial-confirmation reason', async () => {
    const onChanged = vi.fn();
    renderPanel('en', { columns: [col(3, { sourceFieldName: 'Hospital A' })], onChanged });
    const row = rowFor(3);
    // A prefilled SUGGESTION is not a pending choice on its own.
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
    chooseIn(row, HOSPITAL_A);
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns).toHaveBeenCalledTimes(1);
    const arg = setBeneficiaryColumns.mock.calls[0][0];
    expect(arg.planRevisionId).toBe('rev-1');
    expect(arg.mappings).toEqual([{
      importSessionId: 's1', sheetIndex: 0, columnIndex: 3,
      decision: 'beneficiary', beneficiaryOrganizationId: HOSPITAL_A,
      previousDecision: null, previousBeneficiaryOrganizationId: null,
    }]);
    // The adopted initial-confirmation policy: a descriptive reason, never the button's action label.
    expect(arg.mappingReason).toBe(T.cn2b_beneficiary_column_initial_reason.en);
    expect(arg.mappingReason).not.toBe(T.cn2b_beneficiary_column_confirm.en);
    await Promise.resolve();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('a reason the reviewer types for a first confirmation is sent exactly as typed (trimmed)', () => {
    renderPanel('en', { columns: [col(3)] });
    const row = rowFor(3);
    chooseIn(row, HOSPITAL_B);
    fireEvent.change(within(row).getByRole('textbox', { name: T.cn2b_beneficiary_column_reason_optional.en }),
      { target: { value: '  per the 2026 request letter  ' } });
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns.mock.calls[0][0].mappingReason).toBe('per the 2026 request letter');
  });

  it('declaring an unresolved column NOT a beneficiary requires a reason, and sends no beneficiary', () => {
    renderPanel('en', { columns: [col(2, { sourceFieldName: '#' })] });
    const row = rowFor(2);
    chooseIn(row, NON_BENEFICIARY_CHOICE);
    expect(confirmIn(row)).toBeDisabled();
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
    fireEvent.change(requiredReasonIn(row), { target: { value: 'Column 2 is the row number' } });
    fireEvent.click(confirmIn(row));
    const arg = setBeneficiaryColumns.mock.calls[0][0];
    expect(arg.mappingReason).toBe('Column 2 is the row number');
    expect(arg.mappings).toEqual([{
      importSessionId: 's1', sheetIndex: 0, columnIndex: 2,
      decision: 'non_beneficiary', beneficiaryOrganizationId: null,
      previousDecision: null, previousBeneficiaryOrganizationId: null,
    }]);
  });
});

describe('CentralNeedsBeneficiaryColumnPanel — correcting a reviewed column needs a human reason (independent review finding 2)', () => {
  it('confirmed A → user chooses B → cannot execute with a blank reason; the supplied reason, previous A and new B reach setBeneficiaryColumns()', () => {
    renderPanel('en', { columns: [beneficiaryCol(3, HOSPITAL_A, { sourceFieldName: 'Hospital A' })] });
    const row = rowFor(3);
    chooseIn(row, HOSPITAL_B);

    // Blank reason: the correction must not execute (before this fix it executed
    // with the action label "Confirm" as its reason).
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
    expect(confirmIn(row)).toBeDisabled();

    const reason = requiredReasonIn(row);
    fireEvent.change(reason, { target: { value: '   ' } });
    expect(confirmIn(row)).toBeDisabled();
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();

    fireEvent.change(reason, { target: { value: 'Column 3 is Hospital B per the signed request letter' } });
    expect(confirmIn(row)).toBeEnabled();
    fireEvent.click(confirmIn(row));

    expect(setBeneficiaryColumns).toHaveBeenCalledTimes(1);
    const arg = setBeneficiaryColumns.mock.calls[0][0];
    expect(arg.mappingReason).toBe('Column 3 is Hospital B per the signed request letter');
    expect(arg.mappings).toEqual([{
      importSessionId: 's1', sheetIndex: 0, columnIndex: 3,
      decision: 'beneficiary', beneficiaryOrganizationId: HOSPITAL_B,
      previousDecision: 'beneficiary', previousBeneficiaryOrganizationId: HOSPITAL_A,
    }]);
  });

  it('BENEFICIARY → NON-BENEFICIARY is a correction too: reason required; previous A stated, no beneficiary sent', () => {
    renderPanel('en', { columns: [beneficiaryCol(3, HOSPITAL_A)] });
    const row = rowFor(3);
    chooseIn(row, NON_BENEFICIARY_CHOICE);
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
    fireEvent.change(requiredReasonIn(row), { target: { value: 'Column 3 is the total, not Hospital A' } });
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns.mock.calls[0][0]).toMatchObject({
      mappingReason: 'Column 3 is the total, not Hospital A',
      mappings: [{ decision: 'non_beneficiary', beneficiaryOrganizationId: null,
        previousDecision: 'beneficiary', previousBeneficiaryOrganizationId: HOSPITAL_A }],
    });
  });

  it('NON-BENEFICIARY → BENEFICIARY changes an explicit decision: reason required; previous non-beneficiary stated', () => {
    renderPanel('en', { columns: [nonBeneficiaryCol(4)] });
    const row = rowFor(4);
    chooseIn(row, HOSPITAL_A);
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
    fireEvent.change(requiredReasonIn(row), { target: { value: 'Header re-read: Hospital A quantity' } });
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns.mock.calls[0][0]).toMatchObject({
      mappingReason: 'Header re-read: Hospital A quantity',
      mappings: [{ decision: 'beneficiary', beneficiaryOrganizationId: HOSPITAL_A,
        previousDecision: 'non_beneficiary', previousBeneficiaryOrganizationId: null }],
    });
  });

  it('choosing the decision a column already has offers no write at all', () => {
    renderPanel('en', { columns: [beneficiaryCol(3, HOSPITAL_A)] });
    const row = rowFor(3);
    chooseIn(row, HOSPITAL_A);
    expect(confirmIn(row)).toBeDisabled();
    fireEvent.click(confirmIn(row));
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });
});

describe('CentralNeedsBeneficiaryColumnPanel — group apply covers UNRESOLVED columns only', () => {
  function threeSiblingColumns() {
    return [
      col(1, { sourceFieldName: 'قطاع كوثى' }),
      col(2, { sourceFieldName: 'قطاع كوثى' }),
      col(3, { sourceFieldName: 'قطاع كوثى' }),
    ];
  }

  it('offers "apply to N matching columns" only once a choice is pending, and states the exact affected count', () => {
    renderPanel('en', { columns: threeSiblingColumns() });
    expect(screen.queryByText(/Apply to \d+ matching columns/)).toBeNull();
    const row1 = rowFor(1);
    chooseIn(row1, HOSPITAL_A);
    expect(within(row1).getByText('Apply to 3 matching columns')).toBeInTheDocument();
  });

  it('requires an explicit second confirmation, previewing every affected column and the scope rule, before writing anything', () => {
    renderPanel('en', { columns: threeSiblingColumns() });
    const row1 = rowFor(1);
    chooseIn(row1, HOSPITAL_A);
    fireEvent.click(within(row1).getByRole('button', { name: 'Apply to 3 matching columns' }));
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
    expect(screen.getAllByText(/#1$/)).toHaveLength(2);
    expect(screen.getAllByText(/#2$/)).toHaveLength(2);
    expect(screen.getAllByText(/#3$/)).toHaveLength(2);
    expect(screen.getByText(T.cn2b_beneficiary_column_group_scope_note.en)).toBeInTheDocument();
  });

  it('writes every affected physical column independently — never one row per label', async () => {
    renderPanel('en', { columns: threeSiblingColumns() });
    const row1 = rowFor(1);
    chooseIn(row1, HOSPITAL_A);
    fireEvent.click(within(row1).getByRole('button', { name: 'Apply to 3 matching columns' }));
    const previewPane = screen.getByRole('button', { name: 'Cancel' }).parentElement as HTMLElement;
    fireEvent.click(within(previewPane).getByRole('button', { name: T.cn2b_beneficiary_column_confirm.en }));
    expect(setBeneficiaryColumns).toHaveBeenCalledTimes(1);
    const { mappings, mappingReason } = setBeneficiaryColumns.mock.calls[0][0];
    expect(mappings).toHaveLength(3);
    expect(mappings.map((m: { columnIndex: number }) => m.columnIndex).sort()).toEqual([1, 2, 3]);
    expect(mappings.every((m: Record<string, unknown>) =>
      m.decision === 'beneficiary' && m.beneficiaryOrganizationId === HOSPITAL_A
      && m.previousDecision === null && m.previousBeneficiaryOrganizationId === null)).toBe(true);
    expect(mappingReason).toBe(T.cn2b_beneficiary_column_initial_reason.en);
  });

  it('cancelling the group preview writes nothing', () => {
    renderPanel('en', { columns: threeSiblingColumns() });
    const row1 = rowFor(1);
    chooseIn(row1, HOSPITAL_A);
    fireEvent.click(within(row1).getByRole('button', { name: 'Apply to 3 matching columns' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('already-REVIEWED siblings (beneficiary or non-beneficiary) are excluded — a group apply never overwrites a decision', () => {
    renderPanel('en', {
      columns: [
        col(1, { sourceFieldName: 'قطاع كوثى' }),
        beneficiaryCol(2, HOSPITAL_B, { sourceFieldName: 'قطاع كوثى' }),
        nonBeneficiaryCol(3, { sourceFieldName: 'قطاع كوثى' }),
      ],
    });
    const row1 = rowFor(1);
    chooseIn(row1, HOSPITAL_A);
    // Only ONE unresolved sibling remains (itself), so no group apply is offered.
    expect(within(row1).queryByText(/Apply to \d+ matching columns/)).toBeNull();
  });

  it('a REVIEWED column never offers a group correction, even with unresolved siblings', () => {
    renderPanel('en', {
      columns: [
        beneficiaryCol(1, HOSPITAL_A, { sourceFieldName: 'قطاع كوثى' }),
        col(2, { sourceFieldName: 'قطاع كوثى' }),
        col(3, { sourceFieldName: 'قطاع كوثى' }),
      ],
    });
    const row1 = rowFor(1);
    chooseIn(row1, HOSPITAL_B);
    expect(within(row1).queryByText(/Apply to \d+ matching columns/)).toBeNull();
  });

  it('a NON-BENEFICIARY group apply needs its reason first, and every column carries that reason', () => {
    renderPanel('en', { columns: threeSiblingColumns() });
    const row1 = rowFor(1);
    chooseIn(row1, NON_BENEFICIARY_CHOICE);
    expect(within(row1).getByRole('button', { name: 'Apply to 3 matching columns' })).toBeDisabled();
    fireEvent.change(requiredReasonIn(row1), { target: { value: 'These are serial-number columns' } });
    fireEvent.click(within(row1).getByRole('button', { name: 'Apply to 3 matching columns' }));
    const previewPane = screen.getByRole('button', { name: 'Cancel' }).parentElement as HTMLElement;
    fireEvent.click(within(previewPane).getByRole('button', { name: T.cn2b_beneficiary_column_confirm.en }));
    const { mappings, mappingReason } = setBeneficiaryColumns.mock.calls[0][0];
    expect(mappingReason).toBe('These are serial-number columns');
    expect(mappings).toHaveLength(3);
    expect(mappings.every((m: Record<string, unknown>) =>
      m.decision === 'non_beneficiary' && m.beneficiaryOrganizationId === null)).toBe(true);
  });
});

describe('CentralNeedsBeneficiaryColumnPanel — read-only state', () => {
  it('a non-draft/read-only revision prevents any mutation control from rendering', () => {
    renderPanel('en', { editable: false, columns: [col(1, { sourceFieldName: 'Hospital A' })] });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: T.cn2b_beneficiary_column_confirm.en })).toBeNull();
  });
});

describe('CentralNeedsBeneficiaryColumnPanel — both languages, no leakage', () => {
  it('renders English without Arabic text leaking through', () => {
    renderPanel('en', { columns: [col(1, { sourceFieldName: null })] });
    expect(screen.getByText(T.cn2b_beneficiary_columns_title.en)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_beneficiary_columns_title.ar)).toBeNull();
    expect(screen.getByText(T.cn2b_beneficiary_column_state_unresolved.en)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_beneficiary_column_state_unresolved.ar)).toBeNull();
  });

  it('renders Arabic without English text leaking through, using each institution\'s Arabic name', () => {
    renderPanel('ar', { columns: [col(1, { sourceFieldName: null })] });
    expect(screen.getByText(T.cn2b_beneficiary_columns_title.ar)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_beneficiary_columns_title.en)).toBeNull();
    expect(screen.getByText(T.cn2b_beneficiary_column_state_unresolved.ar)).toBeInTheDocument();
    const row = rowFor(1);
    expect(within(row).getByText('مستشفى أ')).toBeInTheDocument();
    expect(within(row).queryByText('Hospital A')).toBeNull();
    expect(within(row).getByText(T.cn2b_beneficiary_column_option_non_beneficiary.ar)).toBeInTheDocument();
  });
});
