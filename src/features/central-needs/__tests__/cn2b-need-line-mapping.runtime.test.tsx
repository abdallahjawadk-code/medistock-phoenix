/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { T } from '@/shared/i18n/strings';
import type { BeneficiaryColumnSummary, NeedLineUnit } from '../central-needs.service';

/**
 * CN-2B CONFORMANCE (M212, corrected by 213) — the operational need-line
 * mapping surface.
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
 * (213) There is no single global "beneficiary" selector any more. A candidate
 * cell's beneficiary is resolved from its CONFIRMED physical-column mapping —
 * identity (importSessionId, sheetIndex, columnIndex), read from the record's
 * own `sourceProvenance`, never from header/field-name text (the real corpus
 * duplicates header labels across distinct columns) and never chosen in this
 * panel. `beneficiaryColumns` fixtures below stand in for
 * `CentralNeedsBeneficiaryColumnPanel`'s confirmed mappings, exactly as
 * `CentralNeedsScreen` wires them (`listBeneficiaryColumns()` → this panel).
 *
 * The need-line writes are mocked at the service boundary, so those tests assert
 * the COMPONENT's behaviour; the service's own exactness and error mapping are
 * asserted against a mocked Supabase client below. The server contract itself is
 * proven against a real PostgreSQL in
 * supabase/migrations/__tests__/212-*.dynamic.test.ts and
 * supabase/migrations/__tests__/213-*.dynamic.test.ts, and the real PostgREST
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

/**
 * C5 §15/§18 — the parser's own `source_values` envelope (`parser-core.ts`):
 * a quantity is suggested only from a typed `number` or an exact whole-number
 * `string`, so fixtures carry `valueType` exactly as imported evidence does.
 */
const envelope = (value: unknown) => ({
  value,
  valueType: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string',
  isFormula: false,
  formula: null,
});

/**
 * A designatable source record. `column` is the record's OWN physical-column
 * identity, persisted verbatim in `sourceProvenance` exactly as the real
 * parser writes it (`{ sheetIndex, coordinate: { col } }`) — the only thing
 * `CentralNeedsNeedLinePanel` reads to resolve a beneficiary. It defaults to
 * one distinct column per record (keyed on `ordinal`) so unrelated tests don't
 * have to think about column identity at all; tests that care about column
 * identity (duplicate headers, unmapped columns, several beneficiaries on one
 * row) pass it explicitly.
 */
const record = (
  id: string, entity: string, fieldName: string, value: unknown, ordinal: number,
  column: { sheetIndex?: number; columnIndex?: number; importSessionId?: string } = {},
) => ({
  id, importSessionId: column.importSessionId ?? 's1', recordOrdinal: ordinal, targetEntity: entity, fieldName,
  sourceValues: envelope(value),
  // Partial overrides (e.g. `{ columnIndex: 3 }`) must still default sheetIndex —
  // a JS default parameter only applies when the whole argument is omitted, so
  // each field is defaulted individually here rather than relying on that.
  sourceProvenance: { sheetIndex: column.sheetIndex ?? 0, coordinate: { col: column.columnIndex ?? ordinal } },
});

/** A record whose column identity cannot even be read — never resolvable. */
const recordWithoutProvenance = (id: string, entity: string, fieldName: string, value: unknown, ordinal: number) => ({
  id, importSessionId: 's1', recordOrdinal: ordinal, targetEntity: entity, fieldName,
  sourceValues: envelope(value), sourceProvenance: null,
});

const link = (needLineId: string, sourceRecordId: string, designatedQuantity: string,
  importSessionId = 's1', targetEntity = ROW_5, fieldName = 'final') => ({
  needLineId, sourceRecordId, designatedQuantity, appliedOverrideId: null, importSessionId, targetEntity, fieldName,
});

/**
 * (213) One physical column's CONFIRMED beneficiary mapping, exactly the shape
 * `listBeneficiaryColumns()` returns and `CentralNeedsBeneficiaryColumnPanel`
 * writes. `beneficiaryOrganizationId: null` models a column nobody has
 * reviewed yet — present in the revision's column list, but unresolved.
 */
const beneficiaryColumn = (
  columnIndex: number, beneficiaryOrganizationId: string | null,
  over: Partial<BeneficiaryColumnSummary> = {},
): BeneficiaryColumnSummary => ({
  importSessionId: 's1',
  originalFilename: 'need-2026.xlsx',
  archiveEntryPath: null,
  sheetIndex: 0,
  sheetName: null,
  columnIndex,
  sourceFieldName: null,
  numericValueCount: 1,
  zeroValueCount: 0,
  nonzeroNumericCount: 1,
  mappingId: beneficiaryOrganizationId ? `bc-${columnIndex}` : null,
  decision: beneficiaryOrganizationId ? 'beneficiary' : null,
  beneficiaryOrganizationId,
  mappingReason: beneficiaryOrganizationId ? 'confirmed' : null,
  mappedAt: beneficiaryOrganizationId ? '2026-01-01T00:00:00.000Z' : null,
  mappedRowNumericCount: 1,
  reviewRequired: !beneficiaryOrganizationId,
  ...over,
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
    overrideReadFailure: null,
    needLines: [],
    claimedSources: [],
    // (213) Every default record above (columns 1, 2, 3) is a CONFIRMED BENE
    // column, so ordinary M212 behaviour (arithmetic, provenance, quantity
    // contract, bulk preview, deletion, …) needs no beneficiary interaction of
    // its own. Tests about column resolution itself override this.
    beneficiaryColumns: [
      beneficiaryColumn(1, BENE),
      beneficiaryColumn(2, BENE),
      beneficiaryColumn(3, BENE),
    ],
    onChanged: () => {},
    ...over,
  };
  return render(<CentralNeedsNeedLinePanel {...props} />);
}

/** Tick a candidate record's checkbox by its row · field label (assumes ONE match). */
function designate(entity: string, fieldName: string) {
  const label = screen.getByText(new RegExp(`${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · ${fieldName}`));
  const box = label.closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement;
  fireEvent.click(box);
  return box;
}

/** Tick the ONE candidate matching row · field whose resolved beneficiary label is `beneficiaryText`. */
function designateAmong(entity: string, fieldName: string, beneficiaryText: string) {
  const labels = screen.getAllByText(new RegExp(`${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · ${fieldName}`));
  const candidate = labels
    .map((l) => l.closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement)
    .find((el) => el.textContent?.includes(beneficiaryText));
  if (!candidate) throw new Error(`no ${entity} · ${fieldName} candidate resolved to "${beneficiaryText}"`);
  const box = within(candidate).getByRole('checkbox') as HTMLInputElement;
  fireEvent.click(box);
  return box;
}

function contributionInput(fieldName: string) {
  return screen.getByLabelText(`${T.cn2b_nl_contribution.en} — ${fieldName}`) as HTMLInputElement;
}

const reasonText = 'reviewer designated the final block';
function fillReason(text = reasonText) {
  fireEvent.change(screen.getByLabelText(T.cn2b_nl_reason.en), { target: { value: text } });
  electUnit();
}

/**
 * C3 — a NEW need line now requires an EXPLICIT unit election, exactly as it
 * requires a reason; the panel no longer preselects `box`. These cases are
 * about everything else (lineage, totals, scopes, refusals), so they elect the
 * same `box` the panel used to assume, and do it visibly. The election itself
 * is covered by the "C3 — the approved unit is elected, never defaulted"
 * block at the end of this file. No-op when the picker is hidden, i.e. when
 * the case marked the line `conversion_required`.
 */
function electUnit(u: NeedLineUnit = 'box') {
  const select = screen.queryByTestId('cn2b-nl-unit-select') as HTMLSelectElement | null;
  // Only fills the gap: a case that elected its own unit keeps it.
  if (select && select.value === '') fireEvent.change(select, { target: { value: u } });
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

  it('(213) shows the resolved beneficiary beside its candidate — an active institution by name, never a global choice', async () => {
    renderPanel('en');
    await screen.findByTestId('cn2b-nl-candidates');
    const candidate = screen.getByText(new RegExp(`${ROW_5} · final`)).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
    await waitFor(() => expect(within(candidate).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital'));
    expect(candidate).toHaveAttribute('data-beneficiary-resolved', 'true');
    // There is no institution picker anywhere in this panel any more.
    expect(screen.queryByLabelText(T.cn2b_nl_beneficiary.en)).toBeNull();
    expect(screen.queryByRole('combobox', { name: /beneficiary/i })).toBeNull();
  });

  it('(213) falls back to the raw id rather than a stale name when the resolved beneficiary is no longer an active institution', async () => {
    // 'x2' is inactive, so it is absent from the filtered institutions list —
    // its name/name_ar must not be shown as if it were still live.
    renderPanel('en', { beneficiaryColumns: [beneficiaryColumn(2, 'x2')] });
    const candidate = await screen.findByText(new RegExp(`${ROW_5} · final`));
    await waitFor(() => expect(getOrganizations).toHaveBeenCalled());
    const el = candidate.closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
    expect(within(el).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('x2');
    expect(within(el).queryByText('Inactive Hospital')).toBeNull();
  });

  it('offers only ACTIVE warehouses of the beneficiary a designated cell resolves to', async () => {
    getWarehouses.mockResolvedValue([
      { id: 'w1', name: 'Live store', name_ar: 'مخزن فعال', status: 'active' },
      { id: 'w2', name: 'Archived store', name_ar: 'مخزن مؤرشف', status: 'archived' },
      { id: 'w3', name: 'Inactive store', name_ar: 'مخزن معطل', status: 'inactive' },
    ]);
    renderPanel('en');
    designate(ROW_5, 'final'); // resolves to BENE via the default beneficiaryColumns fixture
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
    fillReason();
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
    expect(screen.queryByTestId('cn2b-nl-preview')).toBeNull();
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('enables saving once a record is designated, and sends that exact record and an empty expected lineage', async () => {
    renderPanel('en');
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
    expect(screen.getByTestId('cn2b-nl-no-candidates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
  });

  it('offers no designation for a CELL any line of the revision already claims', async () => {
    renderPanel('en', { claimedSources: [link('nl-0', REC_5_FINAL, '120.5')] });
    const candidates = screen.getByTestId('cn2b-nl-candidates');
    expect(within(candidates).queryByText(new RegExp(`${ROW_5} · final`))).toBeNull();
    // ...but the SAME ROW's other cell stays available: a row may feed several lines.
    expect(within(candidates).getByText(new RegExp(`${ROW_5} · requested`))).toBeInTheDocument();
  });
});

describe('M212 need-line panel — beneficiary resolved per physical column, never globally (213)', () => {
  it('[A] resolves two candidates to two different beneficiaries purely from their own column identity', async () => {
    renderPanel('en', {
      dispositions: [disposition(ROW_5, ITEM_A), disposition(ROW_6, ITEM_B)],
      records: [
        record('rec-h1', ROW_5, 'final', 100, 1, { sheetIndex: 0, columnIndex: 3 }),
        record('rec-h2', ROW_6, 'final', 50, 2, { sheetIndex: 0, columnIndex: 4 }),
      ],
      beneficiaryColumns: [beneficiaryColumn(3, BENE), beneficiaryColumn(4, BENE2)],
    });
    const c1 = (await screen.findByText(new RegExp(`${ROW_5} · final`))).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
    const c2 = screen.getByText(new RegExp(`${ROW_6} · final`)).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
    await waitFor(() => {
      expect(within(c1).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital');
      expect(within(c2).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Second Hospital');
    });
  });

  it('[B/G] same material, two beneficiary columns on ONE row → two separate lines, never combined, previewed grouped by beneficiary', async () => {
    renderPanel('en', {
      dispositions: [disposition(ROW_5, ITEM_A)],
      records: [
        record('rec-a', ROW_5, 'Hospital A', 100, 1, { columnIndex: 1 }),
        record('rec-b', ROW_5, 'Hospital B', 50, 2, { columnIndex: 2 }),
      ],
      beneficiaryColumns: [beneficiaryColumn(1, BENE), beneficiaryColumn(2, BENE2)],
    });
    designate(ROW_5, 'Hospital A');
    designate(ROW_5, 'Hospital B');
    fillReason('multi-institution row split by confirmed column');
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_preview.en }));

    expect(screen.getByTestId('cn2b-nl-affected')).toHaveTextContent('2');
    expect(screen.getByTestId('cn2b-nl-lines')).toHaveTextContent('2');
    expect(screen.getByTestId('cn2b-nl-beneficiary-count')).toHaveTextContent('2');
    const groups = screen.getAllByTestId('cn2b-nl-preview-group');
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.getAttribute('data-beneficiary')).sort()).toEqual([BENE, BENE2].sort());

    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(2));
    const calls = setNeedLine.mock.calls.map((c) => c[0]);
    const forA = calls.find((c) => c.beneficiaryOrganizationId === BENE);
    const forB = calls.find((c) => c.beneficiaryOrganizationId === BENE2);
    expect(forA.quantitySources).toEqual([{ sourceRecordId: 'rec-a', designatedQuantity: '100', appliedOverrideId: null }]);
    expect(forA.approvedQuantity).toBe('100');
    expect(forB.quantitySources).toEqual([{ sourceRecordId: 'rec-b', designatedQuantity: '50', appliedOverrideId: null }]);
    expect(forB.approvedQuantity).toBe('50');
    // Never combined: each is its own scope, its own RPC call, its own line.
    expect(calls).toHaveLength(2);
  });

  it('[C] an unmapped physical column cannot be designated, submitted, or silently treated as mapped', async () => {
    renderPanel('en', {
      records: [record('rec-u', ROW_5, 'final', 100, 1, { columnIndex: 9 })],
      // Column 9 has no entry at all — nobody has confirmed its beneficiary yet.
      beneficiaryColumns: [],
    });
    const candidate = (await screen.findByText(new RegExp(`${ROW_5} · final`))).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
    expect(candidate).toHaveAttribute('data-beneficiary-resolved', 'false');
    expect(within(candidate).getByTestId('cn2b-nl-candidate-unmapped')).toBeInTheDocument();
    const box = within(candidate).getByRole('checkbox') as HTMLInputElement;
    expect(box).toBeDisabled();
    // A defensive click still must not designate it, inherit BENE from
    // elsewhere, or default to any organization.
    fireEvent.click(box);
    fillReason();
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('[C] a record whose column identity cannot even be read is unresolved the same way — never inherits, never defaults', async () => {
    renderPanel('en', {
      records: [recordWithoutProvenance('rec-legacy', ROW_5, 'final', 100, 1)],
      beneficiaryColumns: [beneficiaryColumn(1, BENE), beneficiaryColumn(2, BENE)],
    });
    const candidate = (await screen.findByText(new RegExp(`${ROW_5} · final`))).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
    expect(candidate).toHaveAttribute('data-beneficiary-resolved', 'false');
    expect(within(candidate).getByRole('checkbox')).toBeDisabled();
  });

  it('[C] a cell of a column reviewed as NOT a beneficiary column says so and can never be designated (independent review finding 1)', async () => {
    renderPanel('en', {
      records: [record('rec-nb', ROW_5, 'unit price', 7, 1, { columnIndex: 9 })],
      beneficiaryColumns: [beneficiaryColumn(9, null, {
        mappingId: 'bc-9', decision: 'non_beneficiary', mappingReason: 'unit price column', reviewRequired: false,
      })],
    });
    const candidate = (await screen.findByText(new RegExp(`${ROW_5} · unit price`))).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
    expect(candidate).toHaveAttribute('data-beneficiary-resolved', 'false');
    expect(candidate).toHaveAttribute('data-column-decision', 'non_beneficiary');
    expect(within(candidate).getByTestId('cn2b-nl-candidate-non-beneficiary'))
      .toHaveTextContent(T.cn2b_beneficiary_column_state_non_beneficiary.en);
    expect(within(candidate).queryByTestId('cn2b-nl-candidate-unmapped')).toBeNull();
    expect(within(candidate).getByRole('checkbox')).toBeDisabled();
  });

  it('[D] duplicate header text on two physical columns of the same row stays independent — never collapsed', async () => {
    renderPanel('en', {
      dispositions: [disposition(ROW_5, ITEM_A)],
      records: [
        // Identical field name AND identical row — only sheetIndex/columnIndex differ.
        record('rec-dup-1', ROW_5, 'مرجان', 30, 1, { columnIndex: 20 }),
        record('rec-dup-2', ROW_5, 'مرجان', 45, 2, { columnIndex: 21 }),
      ],
      beneficiaryColumns: [beneficiaryColumn(20, BENE), beneficiaryColumn(21, BENE2)],
    });
    await screen.findByTestId('cn2b-nl-candidates');
    // Two distinct candidates render despite the identical visible label —
    // column identity, not header text, is what keeps them apart.
    const labels = screen.getAllByText(new RegExp(`${ROW_5} · مرجان`));
    expect(labels).toHaveLength(2);

    designateAmong(ROW_5, 'مرجان', 'Beneficiary Hospital');
    designateAmong(ROW_5, 'مرجان', 'Second Hospital');
    fillReason('duplicate header, distinct columns');
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_preview.en }));
    expect(screen.getByTestId('cn2b-nl-lines')).toHaveTextContent('2');
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(2));
    const beneficiaries = setNeedLine.mock.calls.map((c) => c[0].beneficiaryOrganizationId).sort();
    expect(beneficiaries).toEqual([BENE, BENE2].sort());
  });

  it('[E] a mapped source quantity of exact zero is valid, selectable, and travels through as "0" — blank is NOT zero', async () => {
    renderPanel('en', {
      records: [record('rec-zero', ROW_5, 'final', 0, 1, { columnIndex: 2 })],
    });
    const box = designate(ROW_5, 'final');
    expect(box.disabled).toBe(false);
    expect(contributionInput('final').value).toBe('0'); // prefilled from the raw cell, not blank
    fillReason('zero is a real confirmed value');
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeEnabled();
    // Clearing the field is a DIFFERENT state from designating zero: blank
    // disables saving, and re-typing zero re-enables it — all before ever
    // committing, so the still-mounted candidate is what is being asserted on.
    fireEvent.change(contributionInput('final'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    fireEvent.change(contributionInput('final'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeEnabled();
    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    const call = setNeedLine.mock.calls[0][0];
    expect(call.quantitySources).toEqual([{ sourceRecordId: 'rec-zero', designatedQuantity: '0', appliedOverrideId: null }]);
    expect(call.approvedQuantity).toBe('0');
  });
});

describe('M212 need-line panel — one row, several beneficiaries (C1)', () => {
  it('lets the second institution cell of a row go to a DIFFERENT beneficiary', async () => {
    const hospitalCells = [
      record('rec-a', ROW_5, 'مستشفى أ', 30, 1, { columnIndex: 1 }),
      record('rec-b', ROW_5, 'مستشفى ب', 45, 2, { columnIndex: 2 }),
    ];
    const lineA = { ...EXISTING, id: 'nl-a', approvedQuantity: '30' };
    renderPanel('en', {
      dispositions: [disposition(ROW_5)],
      records: hospitalCells,
      needLines: [lineA],
      claimedSources: [link('nl-a', 'rec-a', '30', 's1', ROW_5, 'مستشفى أ')],
      beneficiaryColumns: [beneficiaryColumn(1, BENE), beneficiaryColumn(2, BENE2)],
    });
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
    designate(ROW_5, 'final');
    fillReason();
    fireEvent.change(contributionInput('final'), { target: { value: '-5' } });
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    expect(screen.getByText(T.cn2b_nl_contribution_invalid.en)).toBeInTheDocument();
  });

  it('keeps a high-scale decimal EXACT, end to end, with no rounding', async () => {
    renderPanel('en');
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
    designate(ROW_5, 'final');
    designate(ROW_6, 'final');
    fillReason();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_preview.en }));
    expect(screen.getByTestId('cn2b-nl-affected')).toHaveTextContent('2');
    expect(screen.getByTestId('cn2b-nl-lines')).toHaveTextContent('2');
    // Same beneficiary (BENE) for both scopes here, so no multi-beneficiary note.
    expect(screen.queryByTestId('cn2b-nl-beneficiary-count')).toBeNull();
    expect(setNeedLine).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(2));
    const items = setNeedLine.mock.calls.map((c) => c[0].centralItemId).sort();
    expect(items).toEqual([ITEM_A, ITEM_B].sort());
  });

  it('writes nothing when the preview is cancelled', async () => {
    renderPanel('en');
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
    expect(screen.queryByTestId('cn2b-nl-candidates')).toBeNull();
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

  it('(213) resolves a beneficiary only from the confirmed column map — never a per-panel selection, never workbook text', () => {
    expect(PANEL).toContain('beneficiaryByRecordId');
    expect(PANEL).toContain('columnIdentity');
    // The removed global control must not have come back.
    expect(PANEL).not.toContain('cn2b_nl_beneficiary\'');
    expect(PANEL).not.toContain('cn2b_nl_beneficiary"');
    expect(PANEL).not.toMatch(/aria-label=\{t\('cn2b_nl_beneficiary'/);
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

/**
 * C3 — the approved unit is ELECTED, never defaulted.
 *
 * Before C3 the picker opened on `box`, so a reviewer who never touched it
 * still stamped every quantity `box` — a unit nobody chose, indistinguishable
 * afterwards from a deliberate one. The unit is now as mandatory, and as
 * explicit, as the mapping justification: a NEW line is saveable only once a
 * human either picks a unit or declares the line `conversion_required`.
 *
 * What this does NOT do: it never proposes a unit. Not the catalog item's unit,
 * not the source text, not the previous line's. There is no conversion factor
 * anywhere and no quantity is ever rescaled.
 */
describe('C3 — the approved unit is elected, never defaulted', () => {
  const typeReason = (text = 'c3 election') =>
    fireEvent.change(screen.getByLabelText(T.cn2b_nl_reason.en), { target: { value: text } });

  it('T32 a NEW line cannot be previewed or confirmed until a unit is elected', async () => {
    renderPanel('en');
    await waitFor(() => expect(getOrganizations).toHaveBeenCalled());
    designate(ROW_5, 'final');
    fireEvent.change(contributionInput('final'), { target: { value: '3' } });
    typeReason();

    // Everything else is satisfied, and the picker opens UNSELECTED.
    const select = screen.getByTestId('cn2b-nl-unit-select') as HTMLSelectElement;
    expect(select.value).toBe('');
    const save = screen.getByRole('button', { name: T.cn2b_nl_save.en });
    expect(save).toBeDisabled();
    // ...and the refusal says why, rather than leaving a dead button.
    expect(screen.getByTestId('cn2b-nl-save-blockers').querySelector('[data-blocker="cn2b_nl_block_unit"]')).not.toBeNull();
    expect(screen.getByTestId('cn2b-nl-unit-required-note')).toHaveTextContent(T.cn2b_nl_unit_required_note.en);

    fireEvent.change(select, { target: { value: 'vial' } });
    expect(save).toBeEnabled();
    expect(screen.queryByTestId('cn2b-nl-unit-required-note')).toBeNull();

    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0]).toMatchObject({ approvedUnit: 'vial', unitConversionState: 'canonical' });
  });

  it('T32 nothing is written while the unit is unelected', async () => {
    renderPanel('en');
    await waitFor(() => expect(getOrganizations).toHaveBeenCalled());
    designate(ROW_5, 'final');
    fireEvent.change(contributionInput('final'), { target: { value: '3' } });
    typeReason();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
    expect(screen.queryByTestId('cn2b-nl-preview')).toBeNull();
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('T33 conversion_required is its own complete decision: saveable, and it carries NO unit', async () => {
    renderPanel('en');
    await waitFor(() => expect(getOrganizations).toHaveBeenCalled());
    designate(ROW_5, 'final');
    fireEvent.change(contributionInput('final'), { target: { value: '3' } });
    typeReason();
    fireEvent.click(screen.getByLabelText(T.cn2b_nl_unit_conversion_required.en));

    // The picker is gone, and the save is unblocked by the declaration itself.
    expect(screen.queryByTestId('cn2b-nl-unit-select')).toBeNull();
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeEnabled();

    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0]).toMatchObject({ approvedUnit: null, unitConversionState: 'conversion_required' });
  });

  it('T34 an EXISTING line keeps its own unit, and is never forced to re-elect one', async () => {
    renderPanel('en', { needLines: [EXISTING], claimedSources: [EXISTING_LINK] });
    await waitFor(() => expect(getOrganizations).toHaveBeenCalled());
    designate(ROW_5, 'final');
    fireEvent.change(contributionInput('final'), { target: { value: '0.2' } });
    typeReason('adds to the existing line');

    // The editor's picker is still unselected, and that does NOT block this
    // save: the existing line already carries its approved unit.
    expect((screen.getByTestId('cn2b-nl-unit-select') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByTestId('cn2b-nl-unit-required-note')).toBeNull();
    const save = screen.getByRole('button', { name: T.cn2b_nl_save.en });
    expect(save).toBeEnabled();

    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0]).toMatchObject({
      approvedUnit: EXISTING.approvedUnit, unitConversionState: EXISTING.unitConversionState, approvedQuantity: '0.3',
    });
  });

  it('T36 no catalog, source or neighbouring unit is ever written as the approved unit', () => {
    const PANEL = readFileSync(join(__dirname, '..', 'CentralNeedsNeedLinePanel.tsx'), 'utf8');
    // The only unit the panel can send for a new line is the elected one; it
    // holds no catalog item unit at all, and never seeds the picker from data.
    expect(PANEL).toContain("useState<NeedLineUnit | ''>('')");
    expect(PANEL).not.toContain("useState<NeedLineUnit>('box')");
    for (const forbidden of ['item.unit', 'centralItem.unit', 'catalogUnit', 'suggestion.unit']) {
      expect(PANEL, forbidden).not.toContain(forbidden);
    }
    // Every setUnit call site is either a clear (session switch, post-commit
    // reset) or the human's own pick. None derives a unit from data — that is
    // the property being asserted, not the number of call sites.
    const assignments = PANEL.match(/setUnit\([^)]*\)/g) ?? [];
    expect(assignments.length).toBeGreaterThanOrEqual(2);
    for (const call of assignments) {
      expect(["setUnit('')", "setUnit(e.target.value as NeedLineUnit | '')"], call).toContain(call);
    }
    // No conversion arithmetic exists anywhere in this surface.
    for (const forbidden of ['conversionFactor', 'convertQuantity', '* factor', 'toBaseUnit']) {
      expect(PANEL, forbidden).not.toContain(forbidden);
    }
  });
});

/**
 * C3 correction #1 — the unit decision belongs to ONE operation.
 *
 * The commit path used to clear the designations, the preview and the reason,
 * but left the line attributes standing. The next new line therefore started
 * with the previous operation's unit, conversion declaration and source-unit
 * text already filled in — a unit nobody elected for THAT line, which is the
 * exact defect C3 exists to remove. The reset now happens only after the whole
 * write plan has succeeded.
 */
describe('C3 — line attributes reset after a successful write (correction #1)', () => {
  const typeReason = (text = 'c3 reset') =>
    fireEvent.change(screen.getByLabelText(T.cn2b_nl_reason.en), { target: { value: text } });
  const unitSelect = () => screen.getByTestId('cn2b-nl-unit-select') as HTMLSelectElement;
  const sourceUnitInput = () => screen.getByLabelText(T.cn2b_nl_source_unit.en) as HTMLInputElement;
  const saveButton = () => screen.getByRole('button', { name: T.cn2b_nl_save.en });

  it('U1 a second NEW line starts with no unit and cannot be saved until a fresh election', async () => {
    renderPanel('en');
    await waitFor(() => expect(getOrganizations).toHaveBeenCalled());
    designate(ROW_5, 'final');
    fireEvent.change(contributionInput('final'), { target: { value: '3' } });
    typeReason();
    fireEvent.change(unitSelect(), { target: { value: 'vial' } });
    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0]).toMatchObject({ approvedUnit: 'vial' });

    // The next operation inherits nothing.
    await waitFor(() => expect(unitSelect().value).toBe(''));
    designate(ROW_6, 'final');
    fireEvent.change(contributionInput('final'), { target: { value: '4' } });
    typeReason('second line');
    expect(saveButton()).toBeDisabled();
    expect(screen.getByTestId('cn2b-nl-save-blockers').querySelector('[data-blocker="cn2b_nl_block_unit"]')).not.toBeNull();

    fireEvent.change(unitSelect(), { target: { value: 'tablet' } });
    expect(saveButton()).toBeEnabled();
    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(2));
    // The second write carries ITS OWN election, never the first one's.
    expect(setNeedLine.mock.calls[1][0]).toMatchObject({ approvedUnit: 'tablet', unitConversionState: 'canonical' });
  });

  it('U2 a conversion_required declaration does not survive into the next line', async () => {
    renderPanel('en');
    await waitFor(() => expect(getOrganizations).toHaveBeenCalled());
    designate(ROW_5, 'final');
    fireEvent.change(contributionInput('final'), { target: { value: '3' } });
    typeReason();
    fireEvent.click(screen.getByLabelText(T.cn2b_nl_unit_conversion_required.en));
    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0]).toMatchObject({ approvedUnit: null, unitConversionState: 'conversion_required' });

    // The checkbox is cleared, so the picker is back and unselected.
    await waitFor(() => expect(screen.getByLabelText(T.cn2b_nl_unit_conversion_required.en)).not.toBeChecked());
    expect(unitSelect().value).toBe('');
    designate(ROW_6, 'final');
    fireEvent.change(contributionInput('final'), { target: { value: '4' } });
    typeReason('second line');
    expect(saveButton()).toBeDisabled();
  });

  it('U3 source-unit evidence is not inherited by the next line', async () => {
    renderPanel('en');
    await waitFor(() => expect(getOrganizations).toHaveBeenCalled());
    designate(ROW_5, 'final');
    fireEvent.change(contributionInput('final'), { target: { value: '3' } });
    fireEvent.change(sourceUnitInput(), { target: { value: 'vial or ampoule' } });
    typeReason();
    fireEvent.change(unitSelect(), { target: { value: 'vial' } });
    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0]).toMatchObject({ sourceUnitText: 'vial or ampoule' });

    await waitFor(() => expect(sourceUnitInput().value).toBe(''));
  });

  it('U4 extending an EXISTING line still keeps that line own unit and state', async () => {
    renderPanel('en', { needLines: [EXISTING], claimedSources: [EXISTING_LINK] });
    await waitFor(() => expect(getOrganizations).toHaveBeenCalled());
    designate(ROW_5, 'final');
    fireEvent.change(contributionInput('final'), { target: { value: '0.2' } });
    typeReason('adds to the existing line');
    // No election is required, and none is invented.
    expect(unitSelect().value).toBe('');
    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0]).toMatchObject({
      approvedUnit: EXISTING.approvedUnit,
      unitConversionState: EXISTING.unitConversionState,
      approvedQuantity: '0.3',
    });
    await waitFor(() => expect(unitSelect().value).toBe(''));
  });

  it('U5 a MULTI-GROUP write applies the one election to every group, and resets only after all of them succeed', async () => {
    renderPanel('en', {
      dispositions: [disposition(ROW_5, ITEM_A)],
      records: [
        record('rec-a', ROW_5, 'Hospital A', 100, 1, { columnIndex: 1 }),
        record('rec-b', ROW_5, 'Hospital B', 50, 2, { columnIndex: 2 }),
      ],
      beneficiaryColumns: [beneficiaryColumn(1, BENE), beneficiaryColumn(2, BENE2)],
    });
    await waitFor(() => expect(getOrganizations).toHaveBeenCalled());
    designate(ROW_5, 'Hospital A');
    designate(ROW_5, 'Hospital B');
    typeReason('one election, two beneficiaries');
    fireEvent.change(unitSelect(), { target: { value: 'ampoule' } });

    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_preview.en }));
    expect(screen.getAllByTestId('cn2b-nl-preview-group')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));

    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(2));
    // Both groups of THIS confirmed write carry the elected unit.
    expect(setNeedLine.mock.calls[0][0]).toMatchObject({ approvedUnit: 'ampoule', beneficiaryOrganizationId: BENE });
    expect(setNeedLine.mock.calls[1][0]).toMatchObject({ approvedUnit: 'ampoule', beneficiaryOrganizationId: BENE2 });
    // Only once every group completed does the editor forget the decision.
    await waitFor(() => expect(unitSelect().value).toBe(''));
    expect(screen.getByLabelText(T.cn2b_nl_unit_conversion_required.en)).not.toBeChecked();
  });

  it('a FAILED write keeps the decision, so it can be corrected and retried', async () => {
    renderPanel('en');
    await waitFor(() => expect(getOrganizations).toHaveBeenCalled());
    designate(ROW_5, 'final');
    fireEvent.change(contributionInput('final'), { target: { value: '3' } });
    fireEvent.change(sourceUnitInput(), { target: { value: 'doz' } });
    typeReason();
    fireEvent.change(unitSelect(), { target: { value: 'vial' } });
    setNeedLine.mockRejectedValueOnce(new CentralNeedsError('need_line_lineage_stale', 'need_line_lineage_stale'));
    saveAndConfirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    // Nothing was written, so nothing is forgotten.
    expect(unitSelect().value).toBe('vial');
    expect(sourceUnitInput().value).toBe('doz');
  });
});
