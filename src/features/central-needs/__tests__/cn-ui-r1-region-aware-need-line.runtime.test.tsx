/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { T } from '@/shared/i18n/strings';
import type { BeneficiaryColumnSummary, BeneficiaryRegionVersion } from '../central-needs.service';
import type { RegionReadState } from '../regions/beneficiaryRegions';

/**
 * CN-UI-R1 — REGION-AWARE NEED-LINE UI CONVERGENCE.
 *
 * The need-line panel resolves a cell's beneficiary at the SAME grain the
 * server proves at write time (M216 `_resolve_region_v1`, M217
 * `set_need_line`): a column an ACTIVE beneficiary region spans resolves
 * through exactly one covering ACTIVE region and never through M213; every
 * other column keeps the M213 rule unchanged; an unreadable or torn region
 * layer resolves nothing and withholds every need-line write.
 *
 * R1–R13 refer to the owner task's mandatory matrix. The pure resolver is
 * proven directly; the rendered panel proves what reaches `setNeedLine`.
 *
 * Known, accepted residual: M216 judges a coordinate by its jsonb TEXT (a
 * stored `5.0` is not "plain digits"), while the client only sees the parsed
 * number (`5`). JSON.stringify never writes `5.0`, so only a non-canonical
 * writer could produce one; the server then refuses that cell at write time
 * (it stays the authority). Conversely the client is STRICTER for -0, which
 * PostgreSQL's numeric normalizes to 0 and which therefore never arrives.
 */

const setNeedLine = vi.fn();
const deleteNeedLine = vi.fn();
const listBeneficiaryRegions = vi.fn();
const listScopeColumnMappings = vi.fn();
const getOrganizations = vi.fn();
const getWarehouses = vi.fn();

vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    rpc: () => { throw new Error('the need-line panel must not call an RPC directly'); },
    from: () => { throw new Error('the need-line panel must not read tables directly'); },
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
    listBeneficiaryRegions: (...a: unknown[]) => listBeneficiaryRegions(...a),
    listScopeColumnMappings: (...a: unknown[]) => listScopeColumnMappings(...a),
  };
});

const { CentralNeedsNeedLinePanel } = await import('../CentralNeedsNeedLinePanel');
const {
  indexColumnDecisions, needLineRegionEvidence, resolveNeedLineBeneficiary, safeCellOf, safeCoordinate,
  SAFE_SHEET_INDEX_CEILING,
} = await import('../regions/beneficiaryRegions');
const { centralNeedsErrorText } = await import('../central-needs.i18n');
const { REGION_MAX_COLUMN_INDEX, REGION_WHOLE_COLUMN_ROW_END } = await import('../central-needs.service');

const BENE = '00000000-0000-0000-0000-0000000000b1';
const BENE2 = '00000000-0000-0000-0000-0000000000b2';
const ITEM = '00000000-0000-0000-0000-0000000000a1';
const ROW_5 = 'sheet:0:row:5';
const ROW_6 = 'sheet:0:row:6';

const envelope = (value: unknown) => ({ value, valueType: typeof value === 'number' ? 'number' : 'string', isFormula: false, formula: null });

const disposition = (entity: string) => ({
  id: `d-${entity}`, importSessionId: 's1', targetEntity: entity,
  decision: 'mapped' as const, centralItemId: ITEM, decisionReason: null, decidedAt: '2026-01-01T00:00:00.000Z',
});

/** A source record with its OWN persisted provenance, verbatim. */
const record = (id: string, entity: string, fieldName: string, value: unknown, ordinal: number,
  sourceProvenance: Record<string, unknown> | null) => ({
  id, importSessionId: 's1', recordOrdinal: ordinal, targetEntity: entity, fieldName,
  sourceValues: envelope(value), sourceProvenance,
});
const cell = (row: unknown, col: unknown, sheetIndex: unknown = 0) => ({ sheetIndex, coordinate: { row, col, a1: 'X' } });

const column = (columnIndex: number, decision: 'beneficiary' | 'non_beneficiary' | null, beneficiaryOrganizationId: string | null = null,
  over: Partial<BeneficiaryColumnSummary> = {}): BeneficiaryColumnSummary => ({
  importSessionId: 's1', originalFilename: 'need-2026.xlsx', archiveEntryPath: null, sheetIndex: 0, sheetName: null,
  columnIndex, sourceFieldName: null, numericValueCount: 1, zeroValueCount: 0, nonzeroNumericCount: 1,
  mappingId: decision ? `bc-${columnIndex}` : null, decision, beneficiaryOrganizationId,
  mappingReason: decision ? 'confirmed' : null, mappedAt: decision ? '2026-01-01T00:00:00.000Z' : null,
  mappedRowNumericCount: 1, reviewRequired: decision === null, ...over,
});

let versionSeq = 0;
const region = (bounds: { rowStart: number; rowEnd: number; columnStart: number; columnEnd: number },
  decision: 'beneficiary' | 'non_beneficiary', beneficiaryOrganizationId: string | null,
  over: Partial<BeneficiaryRegionVersion> = {}): BeneficiaryRegionVersion => {
  versionSeq += 1;
  return {
    versionId: `v-${versionSeq}`, regionId: `r-${versionSeq}`, versionNo: 1, supersedesVersionId: null,
    planRevisionId: 'rev-1', importSessionId: 's1', sheetIndex: 0, ...bounds,
    decision, beneficiaryOrganizationId, decisionReason: 'declared', decidedBy: null, decidedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
};
const READY = (versions: BeneficiaryRegionVersion[] = []): RegionReadState => ({ phase: 'ready', versions });

// ============================================================================
// A. The pure resolver (regions/beneficiaryRegions.ts).
// ============================================================================
describe('CN-UI-R1 · safe coordinates mirror M216 (R8)', () => {
  it('accepts only non-negative safe integers of at most nine digits within the ceiling', () => {
    expect(safeCoordinate(0, 10)).toBe(0);
    expect(safeCoordinate(7, 10)).toBe(7);
    expect(safeCoordinate(10, 10)).toBe(10);
    expect(safeCoordinate(REGION_MAX_COLUMN_INDEX, REGION_MAX_COLUMN_INDEX)).toBe(REGION_MAX_COLUMN_INDEX);
    expect(safeCoordinate(999_999_999, SAFE_SHEET_INDEX_CEILING)).toBe(999_999_999);
    for (const bad of [11, -1, -0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined, true, {}, [3]]) {
      expect(safeCoordinate(bad, 10), String(bad)).toBeNull();
    }
    // Ten digits are never "plain 1–9 digits", whatever the ceiling.
    expect(safeCoordinate(1_000_000_000, SAFE_SHEET_INDEX_CEILING)).toBeNull();
    expect(safeCoordinate(REGION_MAX_COLUMN_INDEX + 1, REGION_MAX_COLUMN_INDEX)).toBeNull();
    expect(safeCoordinate(REGION_WHOLE_COLUMN_ROW_END + 1, REGION_WHOLE_COLUMN_ROW_END)).toBeNull();
  });

  it('reads only the persisted sheetIndex / coordinate.row / coordinate.col, each fail-closed', () => {
    expect(safeCellOf(cell(4, 2))).toEqual({ sheetIndex: 0, row: 4, column: 2 });
    expect(safeCellOf({ sheetIndex: 0, coordinate: { col: 2 } })).toEqual({ sheetIndex: 0, row: null, column: 2 });
    for (const p of [null, undefined, 'x', 7, [], { coordinate: [] }, { sheetIndex: 0 }, { sheetIndex: 0, coordinate: null }]) {
      expect(safeCellOf(p).column, JSON.stringify(p)).toBeNull();
    }
    expect(safeCellOf(cell(1, 16_384)).column).toBeNull();
    expect(safeCellOf(cell(-1, 2)).row).toBeNull();
    expect(safeCellOf(cell(1.5, 2)).row).toBeNull();
    expect(safeCellOf(cell(1, 2, '0')).sheetIndex).toBeNull();
  });
});

describe('CN-UI-R1 · resolveNeedLineBeneficiary (R1–R8)', () => {
  const rec = (provenance: unknown, importSessionId = 's1') => ({ importSessionId, sourceProvenance: provenance });
  const idx = (cols: BeneficiaryColumnSummary[]) => indexColumnDecisions(cols);

  it('R1 — a column no ACTIVE region spans keeps the M213 rule exactly', () => {
    const cols = idx([column(2, 'beneficiary', BENE), column(3, 'non_beneficiary'), column(4, null), column(5, 'beneficiary', null)]);
    // A region elsewhere (other column, other sheet, other session) governs nothing here.
    const elsewhere = [
      region({ rowStart: 0, rowEnd: 99, columnStart: 9, columnEnd: 9 }, 'beneficiary', BENE2),
      region({ rowStart: 0, rowEnd: 99, columnStart: 2, columnEnd: 3 }, 'beneficiary', BENE2, { sheetIndex: 1 }),
      region({ rowStart: 0, rowEnd: 99, columnStart: 2, columnEnd: 3 }, 'beneficiary', BENE2, { importSessionId: 's2' }),
    ];
    for (const active of [[], elsewhere]) {
      expect(resolveNeedLineBeneficiary(rec(cell(7, 2)), active, cols)).toEqual({ state: 'beneficiary', beneficiaryOrganizationId: BENE, grain: 'column' });
      expect(resolveNeedLineBeneficiary(rec({ sheetIndex: 0, coordinate: { col: 2 } }), active, cols))
        .toEqual({ state: 'beneficiary', beneficiaryOrganizationId: BENE, grain: 'column' });
      expect(resolveNeedLineBeneficiary(rec(cell(7, 3)), active, cols)).toEqual({ state: 'non_beneficiary', grain: 'column' });
      expect(resolveNeedLineBeneficiary(rec(cell(7, 4)), active, cols)).toEqual({ state: 'unresolved' });
      expect(resolveNeedLineBeneficiary(rec(cell(7, 5)), active, cols)).toEqual({ state: 'unresolved' });
      expect(resolveNeedLineBeneficiary(rec(cell(7, 6)), active, cols)).toEqual({ state: 'unresolved' });
    }
  });

  it('R2 — exactly one ACTIVE beneficiary region covering the exact cell resolves its beneficiary', () => {
    const active = [region({ rowStart: 4, rowEnd: 9, columnStart: 2, columnEnd: 3 }, 'beneficiary', BENE2)];
    expect(resolveNeedLineBeneficiary(rec(cell(4, 2)), active, idx([]))).toEqual({ state: 'beneficiary', beneficiaryOrganizationId: BENE2, grain: 'region' });
    expect(resolveNeedLineBeneficiary(rec(cell(9, 3)), active, idx([]))).toEqual({ state: 'beneficiary', beneficiaryOrganizationId: BENE2, grain: 'region' });
  });

  it('R3 — a covering non_beneficiary region is never designatable', () => {
    const active = [region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'non_beneficiary', null)];
    expect(resolveNeedLineBeneficiary(rec(cell(5, 2)), active, idx([]))).toEqual({ state: 'non_beneficiary', grain: 'region' });
  });

  it('R4 — a governed column whose exact cell no region covers (or whose row is unlocatable) is blocked', () => {
    const active = [region({ rowStart: 0, rowEnd: 3, columnStart: 2, columnEnd: 2 }, 'beneficiary', BENE)];
    expect(resolveNeedLineBeneficiary(rec(cell(4, 2)), active, idx([]))).toEqual({ state: 'blocked', code: 'beneficiary_region_required' });
    expect(resolveNeedLineBeneficiary(rec({ sheetIndex: 0, coordinate: { col: 2 } }), active, idx([])))
      .toEqual({ state: 'blocked', code: 'beneficiary_region_required' });
    expect(resolveNeedLineBeneficiary(rec(cell(-1, 2)), active, idx([]))).toEqual({ state: 'blocked', code: 'beneficiary_region_required' });
  });

  it('R5 — more than one covering ACTIVE region fails closed (no precedence)', () => {
    const active = [
      region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'beneficiary', BENE),
      region({ rowStart: 5, rowEnd: 5, columnStart: 0, columnEnd: 4 }, 'beneficiary', BENE),
    ];
    expect(resolveNeedLineBeneficiary(rec(cell(5, 2)), active, idx([]))).toEqual({ state: 'blocked', code: 'beneficiary_region_overlap' });
  });

  it('R6 — a region-governed record never resolves through M213, even when an M213 row would name a beneficiary', () => {
    const covering = [region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'beneficiary', BENE2)];
    const uncovering = [region({ rowStart: 50, rowEnd: 60, columnStart: 2, columnEnd: 2 }, 'beneficiary', BENE2)];
    const m213 = idx([column(2, 'beneficiary', BENE)]);
    // An M213 row on a governed column is the server's grain conflict — never its beneficiary.
    expect(resolveNeedLineBeneficiary(rec(cell(5, 2)), covering, m213)).toEqual({ state: 'blocked', code: 'beneficiary_decision_grain_conflict' });
    expect(resolveNeedLineBeneficiary(rec(cell(5, 2)), uncovering, m213)).toEqual({ state: 'blocked', code: 'beneficiary_decision_grain_conflict' });
    // An undecided M213 summary row on a governed, uncovered column: blocked, not "unresolved by M213".
    expect(resolveNeedLineBeneficiary(rec(cell(5, 2)), uncovering, idx([column(2, null)]))).toEqual({ state: 'blocked', code: 'beneficiary_region_required' });
  });

  it('R2/R6 — a beneficiary region with a null beneficiary is inconsistent evidence, never designatable', () => {
    const active = [region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'beneficiary', null)];
    expect(resolveNeedLineBeneficiary(rec(cell(5, 2)), active, idx([]))).toEqual({ state: 'blocked', code: 'beneficiary_regions_read_inconsistent' });
  });

  it('R8 — unsafe provenance resolves nothing, even where the old typeof check would have matched an M213 key', () => {
    const cols = idx([column(0, 'beneficiary', BENE), column(20_000, 'beneficiary', BENE)]);
    for (const p of [cell(1, -0), cell(1, 20_000), cell(1, 0, -0), cell(1, 0.5), cell(1, '0'), cell(1, 0, 1.5), null, {}]) {
      expect(resolveNeedLineBeneficiary(rec(p), [], cols), JSON.stringify(p)).toEqual({ state: 'blocked', code: 'beneficiary_column_mapping_required' });
    }
  });
});

describe('CN-UI-R1 · needLineRegionEvidence (R7, R9)', () => {
  it('R9 — an unread region layer is not usable, whatever M213 says', () => {
    expect(needLineRegionEvidence({ phase: 'unavailable', code: 'beneficiary_regions_not_loaded' }, [column(2, 'beneficiary', BENE)]))
      .toEqual({ usable: false, code: 'beneficiary_regions_not_loaded' });
  });

  it('R7 — an ACTIVE region spanning a column that also carries an M213 row is a torn layer', () => {
    const active = [region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'beneficiary', BENE2)];
    expect(needLineRegionEvidence(READY(active), [column(2, 'beneficiary', BENE)])).toEqual({ usable: false, code: 'beneficiary_decision_grain_conflict' });
    expect(needLineRegionEvidence(READY(active), [column(2, 'non_beneficiary')])).toEqual({ usable: false, code: 'beneficiary_decision_grain_conflict' });
    // An undecided summary row is no M213 row; another column's decision is no conflict.
    expect(needLineRegionEvidence(READY(active), [column(2, null), column(3, 'beneficiary', BENE)])).toEqual({ usable: true, active });
  });
});

// ============================================================================
// B. The rendered panel — what can and cannot reach setNeedLine.
// ============================================================================
type PanelProps = Parameters<typeof CentralNeedsNeedLinePanel>[0];

function renderPanel(over: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    lang: 'en',
    planRevisionId: 'rev-1',
    editable: true,
    dispositions: [disposition(ROW_5), disposition(ROW_6)],
    records: [record('rec-5', ROW_5, 'qty', 12, 1, cell(5, 2))],
    overrides: [],
    overrideReadFailure: null,
    needLines: [],
    claimedSources: [],
    beneficiaryColumns: [],
    beneficiaryRegions: READY(),
    onChanged: () => {},
    ...over,
  };
  const view = render(<CentralNeedsNeedLinePanel {...props} />);
  return { ...view, rerenderWith: (next: Partial<PanelProps>) => view.rerender(<CentralNeedsNeedLinePanel {...props} {...next} />) };
}

const candidateFor = (fieldName: string) =>
  screen.getByText(new RegExp(`· ${fieldName}$`)).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;

function designateAndSave(fieldName: string) {
  fireEvent.click(within(candidateFor(fieldName)).getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'reviewed request' } });
  const unit = screen.queryByTestId('cn2b-nl-unit-select') as HTMLSelectElement | null;
  if (unit && unit.value === '') fireEvent.change(unit, { target: { value: 'box' } });
  fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
  fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
}

const EXPECTED_INPUT = (beneficiaryOrganizationId: string) => ({
  planRevisionId: 'rev-1',
  beneficiaryOrganizationId,
  centralItemId: ITEM,
  approvedQuantity: '12',
  mappingReason: 'reviewed request',
  quantitySources: [{ sourceRecordId: 'rec-5', designatedQuantity: '12', appliedOverrideId: null }],
  expectedSourceRecordIds: [],
  approvedUnit: 'box',
  unitConversionState: 'canonical',
  targetWarehouseId: null,
  sourceUnitText: null,
});

beforeEach(() => {
  versionSeq = 0;
  setNeedLine.mockReset().mockResolvedValue({ needLineId: 'nl-1', created: true, sourceLinkCount: 1, addedLinkCount: 1, approvedQuantity: '12' });
  deleteNeedLine.mockReset().mockResolvedValue({ needLineId: 'nl-0', deletedSourceCount: 1 });
  listBeneficiaryRegions.mockReset().mockRejectedValue(new Error('the panel must never read regions'));
  listScopeColumnMappings.mockReset().mockRejectedValue(new Error('the panel must never read M213 rows itself'));
  getOrganizations.mockReset().mockResolvedValue([
    { id: BENE, name: 'Beneficiary Hospital', name_ar: 'مستشفى المنتفع', code: 'b1', status: 'active', organizationKind: 'care_institution' },
    { id: BENE2, name: 'Second Hospital', name_ar: 'المستشفى الثاني', code: 'b2', status: 'active', organizationKind: 'care_institution' },
  ]);
  getWarehouses.mockReset().mockResolvedValue([]);
});
afterEach(() => cleanup());

describe('CN-UI-R1 · rendered panel', () => {
  it('R1/R10/R11 — with no ACTIVE region, the M213 beneficiary is written with the unchanged payload, once', async () => {
    renderPanel({ beneficiaryColumns: [column(2, 'beneficiary', BENE)] });
    expect(await within(candidateFor('qty')).findByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital');
    designateAndSave('qty');
    await vi.waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine).toHaveBeenCalledWith(EXPECTED_INPUT(BENE));
  });

  it('R2/R11 — a covering ACTIVE beneficiary region supplies the beneficiary; the payload shape and RPC count are unchanged', async () => {
    renderPanel({
      beneficiaryColumns: [column(2, null)],
      beneficiaryRegions: READY([region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'beneficiary', BENE2)]),
    });
    expect(await within(candidateFor('qty')).findByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Second Hospital');
    designateAndSave('qty');
    await vi.waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine).toHaveBeenCalledWith(EXPECTED_INPUT(BENE2));
    expect(deleteNeedLine).not.toHaveBeenCalled();
  });

  it('R3 — a non_beneficiary region cell is labelled so and cannot be designated', () => {
    renderPanel({ beneficiaryRegions: READY([region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'non_beneficiary', null)]) });
    const c = candidateFor('qty');
    expect(c).toHaveAttribute('data-column-decision', 'non_beneficiary');
    expect(within(c).getByRole('checkbox')).toBeDisabled();
    expect(within(c).getByTestId('cn2b-nl-candidate-why')).toHaveTextContent(centralNeedsErrorText('beneficiary_region_not_beneficiary', 'en'));
  });

  it.each([
    ['R4 uncovered', [region({ rowStart: 6, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'beneficiary', BENE)], 'beneficiary_region_required'],
    ['R5 overlap', [
      region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'beneficiary', BENE),
      region({ rowStart: 5, rowEnd: 5, columnStart: 2, columnEnd: 4 }, 'beneficiary', BENE),
    ], 'beneficiary_region_overlap'],
    ['null beneficiary', [region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'beneficiary', null)], 'beneficiary_regions_read_inconsistent'],
  ] as const)('%s — the cell is blocked with the server refusal it would meet, and nothing is written', (_label, versions, code) => {
    renderPanel({ beneficiaryRegions: READY([...versions]) });
    const c = candidateFor('qty');
    expect(c).toHaveAttribute('data-beneficiary-resolved', 'false');
    expect(within(c).getByRole('checkbox')).toBeDisabled();
    const why = within(c).getByTestId('cn2b-nl-candidate-why');
    expect(why).toHaveAttribute('data-refusal', code);
    expect(why).toHaveTextContent(centralNeedsErrorText(code, 'en'));
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('R6/R7 — an M213 row on a region-governed column tears the layer: nothing resolves (not even the M213 beneficiary) and writes are withheld', () => {
    renderPanel({
      records: [record('rec-5', ROW_5, 'qty', 12, 1, cell(5, 2)), record('rec-6', ROW_6, 'other', 3, 2, cell(6, 7))],
      beneficiaryColumns: [column(2, 'beneficiary', BENE), column(7, 'beneficiary', BENE)],
      beneficiaryRegions: READY([region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'beneficiary', BENE2)]),
    });
    expect(screen.getByTestId('cn2b-nl-regions-unavailable')).toHaveAttribute('data-code', 'beneficiary_decision_grain_conflict');
    for (const field of ['qty', 'other']) {
      const c = candidateFor(field);
      expect(c, field).toHaveAttribute('data-beneficiary-resolved', 'false');
      expect(within(c).getByRole('checkbox')).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('R8 — a record whose column is not safely locatable is never designatable, though the old typeof check would have keyed it to an M213 column', () => {
    // Beyond the Excel column ceiling (16,383): M216 extracts nothing, so set_need_line
    // refuses it — but the summary's (text)::integer cast still lists an M213 column there.
    renderPanel({
      records: [record('rec-5', ROW_5, 'qty', 12, 1, { sheetIndex: 0, coordinate: { col: 20_000 } })],
      beneficiaryColumns: [column(20_000, 'beneficiary', BENE)],
    });
    const c = candidateFor('qty');
    expect(c).toHaveAttribute('data-beneficiary-resolved', 'false');
    expect(within(c).getByRole('checkbox')).toBeDisabled();
    // The M213 wording is kept for an unlocatable column (no region is involved).
    expect(within(c).getByTestId('cn2b-nl-candidate-why')).toHaveTextContent(T.cn2b_nl_why_unresolved.en);
  });

  it('R9 — while the regions are not read, nothing resolves, saving and deleting are withheld, and the reason is shown', () => {
    const existing = {
      id: 'nl-0', planRevisionId: 'rev-1', organizationId: 'owner', beneficiaryOrganizationId: BENE, targetWarehouseId: null,
      centralItemId: ITEM, approvedQuantity: '1', approvedUnit: 'box' as const, unitConversionState: 'canonical' as const,
      sourceUnitText: null, mappingReason: 'earlier', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    renderPanel({
      beneficiaryColumns: [column(2, 'beneficiary', BENE)],
      beneficiaryRegions: { phase: 'unavailable', code: 'beneficiary_regions_not_loaded' },
      needLines: [existing],
      claimedSources: [{ needLineId: 'nl-0', sourceRecordId: 'rec-9', designatedQuantity: '1', appliedOverrideId: null, importSessionId: 's1', targetEntity: 'sheet:0:row:9', fieldName: 'old' }],
    });
    const banner = screen.getByTestId('cn2b-nl-regions-unavailable');
    expect(banner).toHaveAttribute('data-code', 'beneficiary_regions_not_loaded');
    expect(banner).toHaveTextContent(T.cn4_region_unavailable.en);
    const c = candidateFor('qty');
    expect(c).toHaveAttribute('data-beneficiary-resolved', 'false');
    expect(within(c).getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    expect(document.querySelector('[data-blocker="cn4_region_unavailable"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: T.cn2b_nl_delete.en })).toBeDisabled();
    expect(setNeedLine).not.toHaveBeenCalled();
    expect(deleteNeedLine).not.toHaveBeenCalled();
  });

  it('R9 — a selection made while the layer was usable becomes unavailable when the layer is lost, and cannot be saved', async () => {
    const view = renderPanel({ beneficiaryColumns: [column(2, 'beneficiary', BENE)] });
    fireEvent.click(within(candidateFor('qty')).getByRole('checkbox'));
    view.rerenderWith({ beneficiaryColumns: [column(2, 'beneficiary', BENE)], beneficiaryRegions: { phase: 'unavailable', code: 'beneficiary_regions_read_inconsistent' } });
    expect(candidateFor('qty')).toHaveAttribute('data-unavailable', 'true');
    fireEvent.change(screen.getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'reviewed request' } });
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('R9 — a delete confirmation already open when the layer is lost cannot be confirmed', () => {
    const existing = {
      id: 'nl-0', planRevisionId: 'rev-1', organizationId: 'owner', beneficiaryOrganizationId: BENE, targetWarehouseId: null,
      centralItemId: ITEM, approvedQuantity: '1', approvedUnit: 'box' as const, unitConversionState: 'canonical' as const,
      sourceUnitText: null, mappingReason: 'earlier', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const view = renderPanel({
      beneficiaryColumns: [column(2, 'beneficiary', BENE)],
      needLines: [existing],
      claimedSources: [{ needLineId: 'nl-0', sourceRecordId: 'rec-9', designatedQuantity: '1', appliedOverrideId: null, importSessionId: 's1', targetEntity: 'sheet:0:row:9', fieldName: 'old' }],
    });
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_delete.en }));
    fireEvent.change(screen.getByLabelText(T.cn2b_nl_delete_reason.en), { target: { value: 'duplicate line' } });
    expect(screen.getByRole('button', { name: T.cn2b_nl_delete_confirm.en })).toBeEnabled();
    view.rerenderWith({
      beneficiaryColumns: [column(2, 'beneficiary', BENE)],
      needLines: [existing],
      claimedSources: [{ needLineId: 'nl-0', sourceRecordId: 'rec-9', designatedQuantity: '1', appliedOverrideId: null, importSessionId: 's1', targetEntity: 'sheet:0:row:9', fieldName: 'old' }],
      beneficiaryRegions: { phase: 'unavailable', code: 'beneficiary_regions_read_inconsistent' },
    });
    const confirm = screen.getByRole('button', { name: T.cn2b_nl_delete_confirm.en });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(deleteNeedLine).not.toHaveBeenCalled();
  });

  it('R9 — an unusable layer offers a re-read through the screen\'s own reload (onChanged) and nothing else', () => {
    const onChanged = vi.fn();
    const view = renderPanel({ onChanged, beneficiaryRegions: { phase: 'unavailable', code: 'beneficiary_regions_read_inconsistent' } });
    fireEvent.click(screen.getByTestId('cn2b-nl-regions-reload'));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(setNeedLine).not.toHaveBeenCalled();
    expect(listBeneficiaryRegions).not.toHaveBeenCalled();
    view.rerenderWith({ onChanged, beneficiaryRegions: READY() });
    expect(screen.queryByTestId('cn2b-nl-regions-reload')).toBeNull();
    expect(screen.queryByTestId('cn2b-nl-regions-unavailable')).toBeNull();
  });

  it('the M213 "confirm the column" guidance is shown only when M213 is really what is missing', () => {
    // Unusable layer: the layer banner explains; the column guidance would be wrong.
    const view = renderPanel({ beneficiaryRegions: { phase: 'unavailable', code: 'beneficiary_regions_not_loaded' } });
    expect(screen.queryByTestId('cn2b-nl-none-designatable')).toBeNull();
    // Region-grain block (governed, uncovered): the per-row reason explains; no column guidance.
    view.rerenderWith({ beneficiaryRegions: READY([region({ rowStart: 50, rowEnd: 60, columnStart: 2, columnEnd: 2 }, 'beneficiary', BENE)]) });
    expect(screen.queryByTestId('cn2b-nl-none-designatable')).toBeNull();
    // Plain M213 unresolved column, no region involved: the unchanged guidance.
    view.rerenderWith({ beneficiaryRegions: READY(), beneficiaryColumns: [column(2, null)] });
    expect(screen.getByTestId('cn2b-nl-none-designatable')).toHaveAttribute('data-empty', 'all-unresolved');
  });

  it('R11/R12 — one row split across two ACTIVE regions writes one line per beneficiary, each with only its own cell', async () => {
    renderPanel({
      records: [record('rec-a', ROW_5, 'Hospital A', 100, 1, cell(5, 2)), record('rec-b', ROW_5, 'Hospital B', 50, 2, cell(5, 3))],
      beneficiaryRegions: READY([
        region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'beneficiary', BENE),
        region({ rowStart: 0, rowEnd: 9, columnStart: 3, columnEnd: 3 }, 'beneficiary', BENE2),
      ]),
    });
    fireEvent.click(within(candidateFor('Hospital A')).getByRole('checkbox'));
    fireEvent.click(within(candidateFor('Hospital B')).getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'row split by regions' } });
    fireEvent.change(screen.getByTestId('cn2b-nl-unit-select'), { target: { value: 'box' } });
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_preview.en }));
    expect(screen.getAllByTestId('cn2b-nl-preview-group').map((g) => g.getAttribute('data-beneficiary')).sort()).toEqual([BENE, BENE2].sort());
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await vi.waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(2));
    const calls = setNeedLine.mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.beneficiaryOrganizationId === BENE).quantitySources)
      .toEqual([{ sourceRecordId: 'rec-a', designatedQuantity: '100', appliedOverrideId: null }]);
    expect(calls.find((c) => c.beneficiaryOrganizationId === BENE2).quantitySources)
      .toEqual([{ sourceRecordId: 'rec-b', designatedQuantity: '50', appliedOverrideId: null }]);
  });

  it('R13 — the panel reads no regions and no M213 rows of its own; it uses only the state it is handed', async () => {
    renderPanel({ beneficiaryRegions: READY([region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'beneficiary', BENE2)]) });
    await within(candidateFor('qty')).findByTestId('cn2b-nl-candidate-beneficiary');
    expect(listBeneficiaryRegions).not.toHaveBeenCalled();
    expect(listScopeColumnMappings).not.toHaveBeenCalled();
  });
});

describe('CN-UI-R1 · static surface (R13, no new authority)', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('the panel takes the region layer as a REQUIRED prop and calls no new service read', () => {
    const panel = read('src/features/central-needs/CentralNeedsNeedLinePanel.tsx');
    expect(panel).toMatch(/\n {2}beneficiaryRegions: RegionReadState;\n/);
    for (const token of ['listBeneficiaryRegions', 'listScopeColumnMappings', 'listBeneficiaryColumns', 'supabase/client', 'fetch(', '.rpc(']) {
      expect(panel, token).not.toContain(token);
    }
    // The only non-service reads remain the two it always had (institutions and warehouses for the pickers).
    expect(panel.match(/from '@\/shared\/supabase\/services\/[\w.-]+'/g)).toEqual([
      "from '@/shared/supabase/services/organizations.service'",
      "from '@/shared/supabase/services/warehouses.service'",
    ]);
    const serviceImport = panel.slice(panel.indexOf('import {\n  CentralNeedsError'), panel.indexOf("} from './central-needs.service';"));
    expect(serviceImport).toContain('deleteNeedLine, reasonOf, setNeedLine');
    expect(serviceImport).not.toMatch(/\blist[A-Z]\w*/);
  });

  it('the resolver module stays pure: no service function, no React, no network', () => {
    const regions = read('src/features/central-needs/regions/beneficiaryRegions.ts');
    const serviceImport = regions.slice(regions.indexOf('import {'), regions.indexOf("} from '../central-needs.service';"));
    expect(serviceImport.replace(/\s+/g, ' ')).toBe(
      'import { REGION_MAX_COLUMN_INDEX, REGION_WHOLE_COLUMN_ROW_END, type BeneficiaryColumnDecision, type BeneficiaryRegionChange, type BeneficiaryRegionVersion, type RenderedParserIdentity, type ScopeColumnMapping, ',
    );
    for (const token of ['react', 'supabase', 'fetch(', 'localStorage', 'setNeedLine', 'deleteNeedLine']) expect(regions, token).not.toContain(token);
  });

  it('the screen hands the panel its one revision-wide region read', () => {
    const screenSrc = read('src/features/central-needs/CentralNeedsScreen.tsx');
    const mount = screenSrc.slice(screenSrc.indexOf('<CentralNeedsNeedLinePanel'), screenSrc.indexOf('/>', screenSrc.indexOf('<CentralNeedsNeedLinePanel')));
    expect(mount).toContain('beneficiaryRegions={beneficiaryRegions}');
    expect(screenSrc.match(/listBeneficiaryRegions\(/g)).toHaveLength(1);
  });
});

// ============================================================================
// D. CN-UI-R1-HC1 — E1, the Owner-approved lexical-coordinate exception.
// ============================================================================
describe('CN-UI-R1-HC1 · E1 — the client check stays bounded; only the lost numeric spelling is excepted', () => {
  it('E1-A — safeCoordinate still rejects every non-lexical violation', () => {
    const rejected: Array<[string, unknown, number]> = [
      ['non-number: string', '5', REGION_MAX_COLUMN_INDEX],
      ['non-number: boolean', true, REGION_MAX_COLUMN_INDEX],
      ['non-number: null', null, REGION_MAX_COLUMN_INDEX],
      ['non-number: undefined', undefined, REGION_MAX_COLUMN_INDEX],
      ['non-number: object', { v: 5 }, REGION_MAX_COLUMN_INDEX],
      ['non-number: bigint', 5n, REGION_MAX_COLUMN_INDEX],
      ['non-safe-integer: 2^53', 2 ** 53, SAFE_SHEET_INDEX_CEILING],
      ['non-safe-integer: NaN', Number.NaN, REGION_MAX_COLUMN_INDEX],
      ['non-safe-integer: Infinity', Number.POSITIVE_INFINITY, SAFE_SHEET_INDEX_CEILING],
      ['fraction', 2.5, REGION_MAX_COLUMN_INDEX],
      ['fraction below one', 0.1, REGION_MAX_COLUMN_INDEX],
      ['negative', -1, REGION_MAX_COLUMN_INDEX],
      ['-0', -0, REGION_MAX_COLUMN_INDEX],
      ['more than nine digits (sheet)', 1_000_000_000, SAFE_SHEET_INDEX_CEILING],
      ['row above 1,048,575', REGION_WHOLE_COLUMN_ROW_END + 1, REGION_WHOLE_COLUMN_ROW_END],
      ['column above 16,383', REGION_MAX_COLUMN_INDEX + 1, REGION_MAX_COLUMN_INDEX],
    ];
    for (const [label, value, ceiling] of rejected) expect(safeCoordinate(value, ceiling), label).toBeNull();
    // The bounds themselves are still accepted.
    expect(safeCoordinate(999_999_999, SAFE_SHEET_INDEX_CEILING)).toBe(999_999_999);
    expect(safeCoordinate(REGION_WHOLE_COLUMN_ROW_END, REGION_WHOLE_COLUMN_ROW_END)).toBe(REGION_WHOLE_COLUMN_ROW_END);
    expect(safeCoordinate(REGION_MAX_COLUMN_INDEX, REGION_MAX_COLUMN_INDEX)).toBe(REGION_MAX_COLUMN_INDEX);
    // The same bounds through the provenance reader, part by part.
    expect(safeCellOf(cell(REGION_WHOLE_COLUMN_ROW_END + 1, 2)).row).toBeNull();
    expect(safeCellOf(cell(1, REGION_MAX_COLUMN_INDEX + 1)).column).toBeNull();
    expect(safeCellOf(cell(1, 2, 1_000_000_000)).sheetIndex).toBeNull();
  });

  it('E1-B — parsed JavaScript cannot tell a persisted 5 from a persisted 5.0: that lost spelling, and only it, is the approved exception', () => {
    // M216 refuses the jsonb text "5.0" (^[0-9]{1,9}$), but JSON parsing hands the browser the same number for both.
    const canonical = JSON.parse('{"sheetIndex":0,"coordinate":{"row":5,"col":2}}');
    const respelled = JSON.parse('{"sheetIndex":0.0,"coordinate":{"row":5.0,"col":2.0}}');
    expect(Object.is(respelled.coordinate.row, canonical.coordinate.row)).toBe(true);
    expect(JSON.stringify(respelled)).toBe(JSON.stringify(canonical));
    expect(safeCellOf(respelled)).toEqual(safeCellOf(canonical));
    expect(safeCellOf(respelled)).toEqual({ sheetIndex: 0, row: 5, column: 2 });
    // A canonical writer never produces the refused spelling in the first place.
    expect(JSON.stringify({ row: 5.0 })).toBe('{"row":5}');
    // The same parse loss collapses decimal text beyond double precision onto the integer: the
    // browser receives exactly 5 and cannot know better; M216 refuses the stored text server-side.
    expect(Object.is(JSON.parse('5.0000000000000001'), 5)).toBe(true);
    expect(safeCoordinate(JSON.parse('5.0000000000000001'), REGION_WHOLE_COLUMN_ROW_END)).toBe(5);
    // E1 relaxes nothing that survives parsing: a real fraction, a sign or -0 is still refused.
    expect(safeCellOf(JSON.parse('{"sheetIndex":0,"coordinate":{"row":5.5,"col":2}}')).row).toBeNull();
    expect(safeCellOf(JSON.parse('{"sheetIndex":0,"coordinate":{"row":-5,"col":2}}')).row).toBeNull();
    expect(safeCellOf(JSON.parse('{"sheetIndex":0,"coordinate":{"row":-0,"col":2}}')).row).toBeNull();
    expect(safeCellOf(JSON.parse('{"sheetIndex":0,"coordinate":{"row":"5","col":2}}')).row).toBeNull();
  });

  describe('E1-C — the authoritative server guard is still in the unchanged migrations', () => {
    const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
    const sqlFiles = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    // Line endings are normalized so a CRLF checkout reads the same text.
    const sqlOf = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8').replace(/\r\n/g, '\n');
    /** Any (re)definition of `fn`, in any letter case, schema-qualified or not. */
    const definesFn = (sql: string, fn: string) =>
      new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+(public\\.)?${fn}\\s*\\(`, 'i').test(sql);
    const definers = (fn: string) => sqlFiles.filter((f) => definesFn(sqlOf(f), fn));
    /**
     * One function's whole definition: from its CREATE to the closing `$$;` line,
     * with SQL comments removed — a guard commented out does not count.
     */
    const definition = (file: string, fn: string) => {
      const sql = sqlOf(file);
      const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
      return sql.slice(start, sql.indexOf('\n$$;', start)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
    };
    /**
     * M216's lexical guard: a jsonb number whose TEXT is 1–9 plain digits, within the
     * ceiling — each refusal live (not commented out) and reached BEFORE the value is returned.
     */
    const hasLexicalGuard = (body: string) => {
      const returned = body.indexOf('RETURN v_text::integer;');
      const before = (needle: string) => body.includes(needle) && body.indexOf(needle) < returned;
      return returned > 0
        && before("jsonb_typeof(p_value) <> 'number'")
        && before("v_text := p_value #>> '{}';")
        && before("IF v_text !~ '^[0-9]{1,9}$' THEN\n    RETURN NULL;")
        && before('IF v_text::integer > p_ceiling THEN\n    RETURN NULL;');
    };

    it('M216 alone defines _phoenix_central_needs_safe_coordinate_v1, and it still carries ^[0-9]{1,9}$', () => {
      expect(definers('_phoenix_central_needs_safe_coordinate_v1')).toEqual(['216_phoenix_central_needs_region_persistence.sql']);
      const guard = definition('216_phoenix_central_needs_region_persistence.sql', '_phoenix_central_needs_safe_coordinate_v1');
      expect(guard).toContain('^[0-9]{1,9}$');
      expect(hasLexicalGuard(guard)).toBe(true);
      // The check is discriminating: without the lexical line (or the type or ceiling line) it fails,
      // and so it does when the lexical guard is commented out or moved after the value is returned.
      const lexical = "IF v_text !~ '^[0-9]{1,9}$' THEN\n    RETURN NULL;\n  END IF;";
      expect(guard).toContain(lexical);
      expect(hasLexicalGuard(guard.replace("IF v_text !~ '^[0-9]{1,9}$' THEN\n    RETURN NULL;", ''))).toBe(false);
      expect(hasLexicalGuard(guard.replace("jsonb_typeof(p_value) <> 'number'", 'false'))).toBe(false);
      expect(hasLexicalGuard(guard.replace('IF v_text::integer > p_ceiling THEN\n    RETURN NULL;', ''))).toBe(false);
      const removed = definition('216_phoenix_central_needs_region_persistence.sql', '_phoenix_central_needs_safe_coordinate_v1')
        .replace(lexical, '');
      expect(hasLexicalGuard(removed)).toBe(false);
      const sqlWithGuardCommented = sqlOf('216_phoenix_central_needs_region_persistence.sql').replace(lexical, `/* ${lexical} */`);
      const start = sqlWithGuardCommented.indexOf('CREATE OR REPLACE FUNCTION public._phoenix_central_needs_safe_coordinate_v1(');
      const commentStripped = sqlWithGuardCommented.slice(start, sqlWithGuardCommented.indexOf('\n$$;', start)).replace(/\/\*[\s\S]*?\*\//g, '');
      expect(hasLexicalGuard(commentStripped)).toBe(false);
      const moved = guard.replace(lexical, '').replace('RETURN v_text::integer;', `RETURN v_text::integer;\n  ${lexical}`);
      expect(hasLexicalGuard(moved)).toBe(false);
    });

    it('the M216 resolver extracts sheet, row and column only through that guard, with the Excel ceilings', () => {
      expect(definers('_phoenix_central_needs_resolve_region_v1')).toEqual(['216_phoenix_central_needs_region_persistence.sql']);
      const resolver = definition('216_phoenix_central_needs_region_persistence.sql', '_phoenix_central_needs_resolve_region_v1');
      expect(resolver).toContain("cell_sheet := public._phoenix_central_needs_safe_coordinate_v1(p_source_provenance->'sheetIndex', 2147483647);");
      expect(resolver).toContain("cell_row   := public._phoenix_central_needs_safe_coordinate_v1(p_source_provenance->'coordinate'->'row', 1048575);");
      expect(resolver).toContain("cell_col   := public._phoenix_central_needs_safe_coordinate_v1(p_source_provenance->'coordinate'->'col', 16383);");
    });

    it('the production write path re-proves every record: the newest set_need_line (M217) refuses an unextractable cell', () => {
      const setters = definers('phoenix_central_needs_set_need_line');
      expect(setters.at(-1)).toBe('217_phoenix_central_needs_c5_safety_convergence.sql');
      const setNeedLineSql = definition('217_phoenix_central_needs_c5_safety_convergence.sql', 'phoenix_central_needs_set_need_line');
      expect(setNeedLineSql).toContain('FROM public._phoenix_central_needs_resolve_region_v1(v_record.import_session_id, v_record.source_provenance);');
      expect(setNeedLineSql).toMatch(/IF v_cell\.cell_sheet IS NULL OR v_cell\.cell_col IS NULL THEN\s+RAISE EXCEPTION 'beneficiary_column_mapping_required'/);
      // ...and the client's only need-line write goes to exactly that server function.
      const service = readFileSync(join(process.cwd(), 'src/features/central-needs/central-needs.service.ts'), 'utf8');
      expect(service).toContain("supabase.rpc('phoenix_central_needs_set_need_line', {");
    });
  });
});

// ============================================================================
// E. CN-UI-R1-HC1 — the non-beneficiary badge names its grain.
// ============================================================================
describe('CN-UI-R1-HC1 · non-beneficiary badge wording', () => {
  it('a cell in a REGION reviewed as not a beneficiary carries the region wording, never the column wording', () => {
    renderPanel({ beneficiaryRegions: READY([region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'non_beneficiary', null)]) });
    const badge = within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-non-beneficiary');
    expect(badge).toHaveAttribute('data-state', 'non_beneficiary');
    expect(badge).toHaveAttribute('data-grain', 'region');
    expect(badge).toHaveTextContent(centralNeedsErrorText('beneficiary_region_not_beneficiary', 'en'));
    expect(badge.textContent).toMatch(/region/i);
    expect(badge.textContent).not.toContain(T.cn2b_beneficiary_column_state_non_beneficiary.en);
    expect(badge.textContent).not.toMatch(/column/i);
    // The row's reason still names the region refusal.
    expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-why'))
      .toHaveTextContent(centralNeedsErrorText('beneficiary_region_not_beneficiary', 'en'));
  });

  it('the region wording is shown in Arabic too, without leaking the column wording', () => {
    renderPanel({ lang: 'ar', beneficiaryRegions: READY([region({ rowStart: 0, rowEnd: 9, columnStart: 2, columnEnd: 2 }, 'non_beneficiary', null)]) });
    const badge = screen.getByTestId('cn2b-nl-candidate-non-beneficiary');
    expect(badge).toHaveTextContent(centralNeedsErrorText('beneficiary_region_not_beneficiary', 'ar'));
    expect(badge.textContent).not.toContain(T.cn2b_beneficiary_column_state_non_beneficiary.ar);
  });

  it('a legacy M213 non-beneficiary COLUMN keeps its unchanged column badge and reason', () => {
    renderPanel({ beneficiaryColumns: [column(2, 'non_beneficiary')] });
    const badge = within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-non-beneficiary');
    expect(badge).toHaveAttribute('data-state', 'non_beneficiary');
    expect(badge).toHaveAttribute('data-grain', 'column');
    expect(badge).toHaveTextContent(T.cn2b_beneficiary_column_state_non_beneficiary.en);
    expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-why')).toHaveTextContent(T.cn2b_nl_why_non_beneficiary.en);
    expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-why')).not.toHaveAttribute('data-refusal');
  });
});
