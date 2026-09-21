/**
 * E2-C.1 — Multi-Institution Mapping, pure.
 *
 * A HUMAN's explicit declaration, for one trusted sheet, of each institution's
 * name cell, Need source and beneficiary organization. Every coordinate comes
 * from an E2-A selection accepted through E2-B's `canonicalSelection`; every
 * beneficiary is an id from the trusted list; E2-B's roles are read, never
 * written. Invalid input fails closed with an explicit reason.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCellSelection,
  buildColumnSelection,
  buildRangeSelection,
  type WorkbookSelection,
  type WorkbookSourceIdentity,
} from '../../excel-first/workbookSelection';
import {
  EMPTY_INSTITUTION_DRAFT,
  INITIAL_INSTITUTION_MAPPING_STATE,
  anchorFromSelection,
  checkInstitutionMapping,
  contextOf,
  draftCandidate,
  evaluateInstitutionMappings,
  institutionMappingProblems,
  institutionMappingReducer,
  isValidInstitutionMapping,
  needFromSelection,
  type InstitutionMapping,
  type InstitutionMappingAction,
  type InstitutionMappingState,
  type MappingSheetContext,
} from '../institutionMapping';
import {
  INITIAL_SHEET_MAPPING_STATE,
  sheetMappingReducer,
  type SheetMappingProfile,
  type SheetMappingState,
} from '../sheetMappingProfile';

const SOURCE: WorkbookSourceIdentity = {
  batchId: 'batch-1',
  entryId: 'entry-1',
  entryOrdinal: 1,
  entrySha256: 'a'.repeat(64),
  importSessionId: 'session-1',
  workbookIndex: 0,
};
const SHEET = { sheetIndex: 0, sheetName: 'الاحتياج' };
const OTHER_SHEET = { sheetIndex: 1, sheetName: 'Other' };
const CONTEXT: MappingSheetContext = { source: SOURCE, ...SHEET };

/** The plan owner (authorizing organization): NOT a care institution in the trusted list. */
const PLAN_OWNER = 'org-plan-owner';
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const ORG_C = 'org-c';
const ELIGIBLE = [ORG_A, ORG_B, ORG_C];

const column = (col: number, source = SOURCE, sheet = SHEET) => buildColumnSelection(source, sheet, col) as WorkbookSelection;
const cell = (row: number, col: number, merged: string | null = null, source = SOURCE, sheet = SHEET) =>
  buildCellSelection(source, sheet, row, col, merged) as WorkbookSelection;
const range = (r0: number, c0: number, r1: number, c1: number, source = SOURCE, sheet = SHEET) =>
  buildRangeSelection(source, sheet, { row: r0, col: c0 }, { row: r1, col: c1 }) as WorkbookSelection;

/** An E2-B profile for the same sheet with National Code in column A (0) and Material in column B (1). */
function profileWithRoles(nationalCode: number | null = 0, material: number | null = 1, sheet = SHEET): SheetMappingProfile {
  return {
    source: { ...SOURCE },
    sheetIndex: sheet.sheetIndex,
    sheetName: sheet.sheetName,
    nationalCodeColumn: nationalCode === null ? null : { columnIndex: nationalCode },
    materialColumn: material === null ? null : { columnIndex: material },
  };
}

const CHECKS = { context: CONTEXT, profile: profileWithRoles(), eligibleBeneficiaryIds: ELIGIBLE };

function entry(id: string, anchor: WorkbookSelection, need: WorkbookSelection, beneficiaryOrganizationId: string): InstitutionMapping {
  const a = anchorFromSelection(CONTEXT, anchor);
  const n = needFromSelection(CONTEXT, need);
  if (!a.ok || !n.ok) throw new Error('fixture failed');
  return { id, anchor: a.anchor, need: n.need, beneficiaryOrganizationId };
}

const run = (state: InstitutionMappingState, ...actions: InstitutionMappingAction[]) =>
  actions.reduce(institutionMappingReducer, state);
const observe = (selection: WorkbookSelection | null): InstitutionMappingAction => ({ type: 'selection_changed', selection });
const commit = (profile: SheetMappingProfile | null = profileWithRoles(), eligible: readonly string[] = ELIGIBLE): InstitutionMappingAction =>
  ({ type: 'commit', profile, eligibleBeneficiaryIds: eligible });
const choose = (beneficiaryOrganizationId: string | null): InstitutionMappingAction => ({ type: 'choose_beneficiary', beneficiaryOrganizationId });

/** Select the name cell, then the Need source, then choose the beneficiary, then commit. */
function mapInstitution(
  state: InstitutionMappingState,
  anchor: WorkbookSelection,
  need: WorkbookSelection,
  beneficiary: string,
  profile: SheetMappingProfile | null = profileWithRoles(),
): InstitutionMappingState {
  return run(
    state,
    observe(anchor), { type: 'capture_anchor' },
    observe(need), { type: 'capture_need' },
    choose(beneficiary),
    commit(profile),
  );
}

const opened = () => run(INITIAL_INSTITUTION_MAPPING_STATE, observe(cell(0, 2)));

describe('E2-C.1 — initial state and context', () => {
  it('starts with no context, no entries and an empty draft', () => {
    expect(INITIAL_INSTITUTION_MAPPING_STATE).toEqual({
      selection: null, context: null, mappings: [], draft: EMPTY_INSTITUTION_DRAFT,
      nextKey: 1, resetPending: false, outcome: null, outcomeSeq: 0,
    });
    expect(EMPTY_INSTITUTION_DRAFT).toEqual({ editingId: null, anchor: null, need: null, beneficiaryOrganizationId: null });
  });

  it('a trusted selection sets E2-B\'s profile identity as the context — and maps nothing', () => {
    const state = opened();
    expect(state.context).toEqual({ source: SOURCE, sheetIndex: 0, sheetName: 'الاحتياج' });
    expect(state.mappings).toEqual([]);
    expect(state.draft).toEqual(EMPTY_INSTITUTION_DRAFT);
  });

  it('contextOf accepts only what E2-B accepts', () => {
    expect(contextOf(column(3))).toEqual(CONTEXT);
    expect(contextOf(null)).toBeNull();
    expect(contextOf({ ...column(1), columnIndex: -1 } as never)).toBeNull();
    expect(contextOf({ ...column(1), role: 'institution' } as never)).toBeNull();
  });
});

describe('E2-C.2 — adding, editing, removing and resetting', () => {
  it('adds a first institution: name cell, Need column, chosen beneficiary', () => {
    const state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    expect(state.mappings).toEqual([{
      id: 'im-1',
      anchor: { kind: 'cell', rowIndex: 0, columnIndex: 2, mergedRange: null },
      need: { kind: 'column', columnIndex: 2 },
      beneficiaryOrganizationId: ORG_A,
    }]);
    expect(state.outcome).toEqual({ kind: 'added', id: 'im-1', beneficiaryOrganizationId: ORG_A });
    expect(state.draft).toEqual(EMPTY_INSTITUTION_DRAFT);
  });

  it('adds several institutions on the same sheet, each with its own Need column or range', () => {
    let state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    state = mapInstitution(state, cell(0, 3), column(3), ORG_B);
    state = mapInstitution(state, cell(30, 0), range(31, 4, 60, 4), ORG_C);
    expect(state.mappings.map((m) => [m.id, m.beneficiaryOrganizationId, m.need])).toEqual([
      ['im-1', ORG_A, { kind: 'column', columnIndex: 2 }],
      ['im-2', ORG_B, { kind: 'column', columnIndex: 3 }],
      ['im-3', ORG_C, { kind: 'range', startRow: 31, endRow: 60, startColumn: 4, endColumn: 4 }],
    ]);
    expect(evaluateInstitutionMappings(CHECKS, state.mappings).every((s) => s.problems.length === 0)).toBe(true);
  });

  it('edits an entry in place: same key, new Need source, others untouched', () => {
    let state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    state = mapInstitution(state, cell(0, 3), column(3), ORG_B);
    state = run(state, { type: 'edit', id: 'im-1' });
    expect(state.draft).toEqual({ editingId: 'im-1', anchor: state.mappings[0].anchor, need: state.mappings[0].need, beneficiaryOrganizationId: ORG_A });
    state = run(state, observe(column(5)), { type: 'capture_need' }, commit());
    expect(state.mappings[0]).toEqual({ ...state.mappings[0], id: 'im-1', need: { kind: 'column', columnIndex: 5 } });
    expect(state.mappings[1].need).toEqual({ kind: 'column', columnIndex: 3 });
    expect(state.outcome).toEqual({ kind: 'updated', id: 'im-1', beneficiaryOrganizationId: ORG_A });
    expect(state.nextKey).toBe(3);
  });

  it('an edit is checked against the OTHER entries only — re-applying an unchanged entry is accepted', () => {
    let state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    state = run(state, { type: 'edit', id: 'im-1' }, commit());
    expect(state.outcome?.kind).toBe('updated');
    expect(state.mappings).toHaveLength(1);
  });

  it('cancelling an edit changes nothing', () => {
    let state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    const before = state.mappings;
    state = run(state, { type: 'edit', id: 'im-1' }, observe(column(6)), { type: 'capture_need' }, { type: 'cancel_edit' });
    expect(state.mappings).toBe(before);
    expect(state.draft).toEqual(EMPTY_INSTITUTION_DRAFT);
    expect(state.outcome).toEqual({ kind: 'draft_cleared' });
  });

  it('removes one entry explicitly; keys are never reused', () => {
    let state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    state = mapInstitution(state, cell(0, 3), column(3), ORG_B);
    state = run(state, { type: 'remove', id: 'im-1' });
    expect(state.mappings.map((m) => m.id)).toEqual(['im-2']);
    expect(state.outcome).toEqual({ kind: 'removed', beneficiaryOrganizationId: ORG_A });
    state = mapInstitution(state, cell(0, 4), column(4), ORG_A);
    expect(state.mappings.map((m) => m.id)).toEqual(['im-2', 'im-3']);
  });

  it('removing the entry being edited also drops its draft', () => {
    let state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    state = run(state, { type: 'edit', id: 'im-1' }, { type: 'remove', id: 'im-1' });
    expect(state.mappings).toEqual([]);
    expect(state.draft).toEqual(EMPTY_INSTITUTION_DRAFT);
  });

  it('reset is explicit and two-step: nothing happens without confirmation, cancel keeps everything', () => {
    let state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    const before = state;
    expect(run(state, { type: 'confirm_reset' })).toBe(before);
    state = run(state, { type: 'request_reset' });
    expect(state.resetPending).toBe(true);
    state = run(state, { type: 'cancel_reset' });
    expect(state.resetPending).toBe(false);
    expect(state.mappings).toEqual(before.mappings);
  });

  it('confirmed reset clears the E2-C entries and draft only — the context and the key counter stay', () => {
    let state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    state = mapInstitution(state, cell(0, 3), column(3), ORG_B);
    state = run(state, observe(cell(0, 5)), { type: 'capture_anchor' }, { type: 'request_reset' }, { type: 'confirm_reset' });
    expect(state.mappings).toEqual([]);
    expect(state.draft).toEqual(EMPTY_INSTITUTION_DRAFT);
    expect(state.context).toEqual(CONTEXT);
    expect(state.nextKey).toBe(3);
    expect(state.outcome).toEqual({ kind: 'reset', removed: 2 });
  });

  it('reset cannot be requested with nothing mapped', () => {
    const state = opened();
    expect(run(state, { type: 'request_reset' })).toBe(state);
  });

  it('E2-B\'s roles are not part of this state: an E2-C reset leaves the E2-B profile as it was', () => {
    let sheet: SheetMappingState = sheetMappingReducer(INITIAL_SHEET_MAPPING_STATE, { type: 'selection_changed', selection: column(0) });
    sheet = sheetMappingReducer(sheet, { type: 'assign', role: 'national_code' });
    let state = mapInstitution(run(INITIAL_INSTITUTION_MAPPING_STATE, observe(column(0))), cell(0, 2), column(2), ORG_A, sheet.profile);
    state = run(state, { type: 'request_reset' }, { type: 'confirm_reset' });
    expect(state.mappings).toEqual([]);
    expect(sheet.profile?.nationalCodeColumn).toEqual({ columnIndex: 0 });
  });

  it('never mutates the state it was given', () => {
    const state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    const snapshot = JSON.stringify(state);
    run(state, { type: 'edit', id: 'im-1' }, observe(column(7)), { type: 'capture_need' }, commit(), { type: 'remove', id: 'im-1' },
      { type: 'request_reset' }, { type: 'confirm_reset' });
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('edit or remove of an unknown key is refused and changes nothing', () => {
    const state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    expect(run(state, { type: 'edit', id: 'im-9' }).outcome).toEqual({ kind: 'refused', step: 'edit', reason: 'UNKNOWN_MAPPING' });
    const removed = run(state, { type: 'remove', id: 'im-9' });
    expect(removed.mappings).toBe(state.mappings);
    expect(removed.outcome).toEqual({ kind: 'refused', step: 'remove', reason: 'UNKNOWN_MAPPING' });
  });
});

describe('E2-C.3 — source and sheet identity, stale selections', () => {
  it.each([
    ['batch', { batchId: 'batch-2' }],
    ['entry', { entryId: 'entry-2' }],
    ['entry ordinal', { entryOrdinal: 2 }],
    ['entry SHA-256', { entrySha256: 'b'.repeat(64) }],
    ['import session', { importSessionId: 'session-2' }],
    ['workbook (ZIP member)', { workbookIndex: 1 }],
  ])('a name cell or Need source from another %s is SOURCE_MISMATCH', (_label, change) => {
    const foreign = { ...SOURCE, ...change };
    expect(anchorFromSelection(CONTEXT, cell(0, 2, null, foreign))).toEqual({ ok: false, reason: 'SOURCE_MISMATCH' });
    expect(needFromSelection(CONTEXT, column(2, foreign))).toEqual({ ok: false, reason: 'SOURCE_MISMATCH' });
  });

  it('a name cell or Need source from another sheet (index or verified label) is SHEET_MISMATCH', () => {
    expect(anchorFromSelection(CONTEXT, cell(0, 2, null, SOURCE, OTHER_SHEET))).toEqual({ ok: false, reason: 'SHEET_MISMATCH' });
    expect(needFromSelection(CONTEXT, column(2, SOURCE, { sheetIndex: 0, sheetName: 'Other' }))).toEqual({ ok: false, reason: 'SHEET_MISMATCH' });
  });

  it('E2-B roles from another sheet cannot vouch for this draft: PROFILE_MISMATCH', () => {
    const candidate = entry('im-1', cell(0, 2), column(2), ORG_A);
    expect(checkInstitutionMapping({ ...CHECKS, profile: profileWithRoles(0, 1, OTHER_SHEET) }, candidate, []))
      .toEqual({ reason: 'PROFILE_MISMATCH' });
    expect(checkInstitutionMapping({ ...CHECKS, profile: null }, candidate, [])).toEqual({ reason: 'PROFILE_MISMATCH' });
  });

  it.each([
    ['another sheet', cell(0, 2, null, SOURCE, OTHER_SHEET)],
    ['another workbook of the ZIP', cell(0, 2, null, { ...SOURCE, workbookIndex: 1, entryId: 'entry-2', entryOrdinal: 2 })],
    ['another batch', cell(0, 2, null, { ...SOURCE, batchId: 'batch-2' })],
    ['another import session', cell(0, 2, null, { ...SOURCE, importSessionId: 'session-2' })],
  ])('a selection from %s discards every entry and the draft, and starts empty there', (_label, selection) => {
    let state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    state = run(state, observe(cell(0, 3)), { type: 'capture_anchor' });
    state = run(state, observe(selection));
    expect(state.mappings).toEqual([]);
    expect(state.draft).toEqual(EMPTY_INSTITUTION_DRAFT);
    expect(state.context?.source).toEqual(selection.source);
  });

  it('null (sheet switch, close, identity lost) discards everything; returning cannot resurrect it', () => {
    let state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    state = run(state, observe(null));
    expect(state).toBe(INITIAL_INSTITUTION_MAPPING_STATE);
    state = run(state, observe(cell(0, 2)));
    expect(state.mappings).toEqual([]);
  });

  it('a malformed selection is treated as no trusted context', () => {
    const state = run(mapInstitution(opened(), cell(0, 2), column(2), ORG_A), observe({ ...column(1), columnIndex: 1.5 } as never));
    expect(state).toBe(INITIAL_INSTITUTION_MAPPING_STATE);
  });

  it('a new selection in the same source + sheet keeps entries and draft', () => {
    let state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    state = run(state, observe(cell(0, 3)), { type: 'capture_anchor' }, observe(range(4, 4, 9, 7)));
    expect(state.mappings).toHaveLength(1);
    expect(state.draft.anchor).toEqual({ kind: 'cell', rowIndex: 0, columnIndex: 3, mergedRange: null });
  });

  it('with no trusted selection, capturing and committing are refused — never invented', () => {
    for (const type of ['capture_anchor', 'capture_need'] as const) {
      const refused = run(INITIAL_INSTITUTION_MAPPING_STATE, { type });
      expect(refused.outcome).toEqual({ kind: 'refused', step: type === 'capture_anchor' ? 'anchor' : 'need', reason: 'NO_TRUSTED_SELECTION' });
      expect(refused.draft).toEqual(EMPTY_INSTITUTION_DRAFT);
    }
    expect(run(INITIAL_INSTITUTION_MAPPING_STATE, commit()).outcome).toEqual({ kind: 'refused', step: 'commit', reason: 'NO_TRUSTED_SELECTION' });
    expect(run(INITIAL_INSTITUTION_MAPPING_STATE, choose(ORG_A))).toBe(INITIAL_INSTITUTION_MAPPING_STATE);
  });

  it('stays in lockstep with E2-B over any sequence of viewer reports', () => {
    const reports: Array<WorkbookSelection | null> = [
      column(1), cell(0, 2), null, column(1), column(1, SOURCE, OTHER_SHEET), range(0, 0, 2, 2, SOURCE, OTHER_SHEET),
      { ...column(1), columnIndex: -1 } as never, cell(3, 3, null, { ...SOURCE, batchId: 'batch-2' }), column(0), null, null, cell(1, 1),
    ];
    let sheet: SheetMappingState = INITIAL_SHEET_MAPPING_STATE;
    let inst: InstitutionMappingState = INITIAL_INSTITUTION_MAPPING_STATE;
    let captured = inst.draft.anchor;
    const seen = { recreated: 0, kept: 0, discarded: 0 };
    for (const report of reports) {
      const before = sheet.profile;
      sheet = sheetMappingReducer(sheet, { type: 'selection_changed', selection: report });
      inst = institutionMappingReducer(inst, observe(report));
      expect(inst.selection).toEqual(sheet.selection);
      if (sheet.profile === null) {
        // E2-B dropped its profile: E2-C dropped everything too.
        expect(inst).toBe(INITIAL_INSTITUTION_MAPPING_STATE);
        seen.discarded += 1;
      } else {
        expect(inst.context).toEqual({ source: sheet.profile.source, sheetIndex: sheet.profile.sheetIndex, sheetName: sheet.profile.sheetName });
        if (sheet.profile === before) {
          // E2-B kept its profile: E2-C kept what the human had captured.
          expect(inst.draft.anchor).toEqual(captured);
          seen.kept += 1;
        } else {
          // E2-B started a new profile: E2-C started a new, empty draft.
          expect(inst.draft).toEqual(EMPTY_INSTITUTION_DRAFT);
          seen.recreated += 1;
        }
      }
      // Give E2-C something to lose before the next report, so a missed discard would show.
      inst = run(inst, { type: 'capture_anchor' });
      captured = inst.draft.anchor;
    }
    expect(seen.recreated).toBeGreaterThanOrEqual(4);
    expect(seen.kept).toBeGreaterThanOrEqual(2);
    expect(seen.discarded).toBeGreaterThanOrEqual(3);
  });
});

describe('E2-C.4 — what a selection may be', () => {
  it('a name cell is a cell (merged anchor carried verbatim) or a rectangle — never a whole column', () => {
    expect(anchorFromSelection(CONTEXT, cell(0, 2, 'C1:E1'))).toEqual({
      ok: true, anchor: { kind: 'cell', rowIndex: 0, columnIndex: 2, mergedRange: 'C1:E1' },
    });
    expect(anchorFromSelection(CONTEXT, range(0, 2, 1, 4))).toEqual({
      ok: true, anchor: { kind: 'range', startRow: 0, endRow: 1, startColumn: 2, endColumn: 4 },
    });
    expect(anchorFromSelection(CONTEXT, column(2))).toEqual({ ok: false, reason: 'ANCHOR_NOT_CELL_OR_RANGE' });
  });

  it('a Need source is a whole column or a range with ALL FOUR of its E2-A coordinates — never a single cell', () => {
    expect(needFromSelection(CONTEXT, column(4))).toEqual({ ok: true, need: { kind: 'column', columnIndex: 4 } });
    expect(needFromSelection(CONTEXT, range(2, 4, 40, 4))).toEqual({
      ok: true, need: { kind: 'range', startRow: 2, endRow: 40, startColumn: 4, endColumn: 4 },
    });
    // A rectangle wider than one column is kept exactly as E2-A reported it (E2C-SEM-002).
    expect(needFromSelection(CONTEXT, range(2, 4, 40, 7))).toEqual({
      ok: true, need: { kind: 'range', startRow: 2, endRow: 40, startColumn: 4, endColumn: 7 },
    });
    expect(needFromSelection(CONTEXT, cell(3, 4))).toEqual({ ok: false, reason: 'NEED_NOT_COLUMN_OR_RANGE' });
  });

  it('a Need range is exactly the trusted E2-A rectangle: same four coordinates as the selection', () => {
    const selected = range(5, 3, 19, 6) as Extract<WorkbookSelection, { kind: 'range' }>;
    const result = needFromSelection(CONTEXT, selected);
    expect(result.ok && result.need).toEqual({
      kind: 'range',
      startRow: selected.startRow,
      endRow: selected.endRow,
      startColumn: selected.startColumn,
      endColumn: selected.endColumn,
    });
  });

  it('a range selected in either direction is the same normalized rectangle', () => {
    const reversed = buildRangeSelection(SOURCE, SHEET, { row: 40, col: 7 }, { row: 2, col: 4 }) as WorkbookSelection;
    expect(needFromSelection(CONTEXT, reversed)).toEqual(needFromSelection(CONTEXT, range(2, 4, 40, 7)));
  });

  it.each([
    ['null', null],
    ['a bare number', 3],
    ['a column index with no source', { kind: 'column', sheetIndex: 0, sheetName: 'x', columnIndex: 1 }],
    ['a reversed range (hand-made)', { ...range(2, 4, 40, 4), startRow: 40, endRow: 2 }],
    ['a range past the last row', { ...range(2, 4, 40, 4), endRow: 1_048_576 }],
    ['a column past XFD', { ...column(1), columnIndex: 16_384 }],
    ['a negative row', { ...cell(1, 1), rowIndex: -1 }],
    ['an altered A1 on a cell', { ...cell(1, 1), a1: 'Z9' }],
    ['an extra field smuggled in', { ...column(1), beneficiaryOrganizationId: ORG_A }],
  ])('rejects %s as INVALID_SELECTION', (_label, selection) => {
    expect(anchorFromSelection(CONTEXT, selection as never)).toEqual({ ok: false, reason: 'INVALID_SELECTION' });
    expect(needFromSelection(CONTEXT, selection as never)).toEqual({ ok: false, reason: 'INVALID_SELECTION' });
  });

  it('a stored entry must be exactly what E2-A would build: reversed, reduced or padded geometry is invalid', () => {
    const good = entry('im-1', cell(0, 2), range(1, 2, 9, 4), ORG_A);
    expect(isValidInstitutionMapping(CONTEXT, good)).toBe(true);
    const reversedRows = { kind: 'range', startRow: 9, endRow: 1, startColumn: 2, endColumn: 4 } as const;
    const reversedColumns = { kind: 'range', startRow: 1, endRow: 9, startColumn: 4, endColumn: 2 } as const;
    // The superseded one-column shape is not a Need source any more.
    const reducedToOneColumn = { kind: 'range', columnIndex: 2, startRow: 1, endRow: 9 };
    for (const need of [reversedRows, reversedColumns, reducedToOneColumn, { kind: 'column', columnIndex: -1 }]) {
      expect(isValidInstitutionMapping(CONTEXT, { ...good, need } as never)).toBe(false);
    }
    expect(isValidInstitutionMapping(CONTEXT, { ...good, anchor: { kind: 'range', startRow: 3, endRow: 0, startColumn: 2, endColumn: 2 } })).toBe(false);
    expect(isValidInstitutionMapping(CONTEXT, { ...good, quantity: 0 } as never)).toBe(false);
    expect(isValidInstitutionMapping(CONTEXT, { ...good, beneficiaryOrganizationId: ' org-a' })).toBe(false);
    expect(checkInstitutionMapping(CHECKS, { ...good, need: reversedRows }, [])).toEqual({ reason: 'INVALID_MAPPING' });
  });
});

describe('E2-C.5 — conflicts use the actual Excel geometry, deterministically', () => {
  const A = entry('im-1', cell(0, 2), column(2), ORG_A);
  /** E2:G21, named at E1. */
  const R1 = entry('im-3', cell(0, 4), range(1, 4, 20, 6), ORG_B);

  it('non-overlapping rectangular ranges are accepted (E2C-SEM-002)', () => {
    const below = entry('im-4', cell(21, 4), range(22, 4, 40, 6), ORG_C); // E23:G41
    const beside = entry('im-5', cell(0, 7), range(1, 7, 20, 9), ORG_B); // H2:J21
    expect(checkInstitutionMapping(CHECKS, R1, [A])).toBeNull();
    expect(checkInstitutionMapping(CHECKS, below, [A, R1])).toBeNull();
    expect(checkInstitutionMapping(CHECKS, beside, [A, R1, below])).toBeNull();
    expect(evaluateInstitutionMappings(CHECKS, [A, R1, below, beside]).map((s) => s.problems)).toEqual([[], [], [], []]);
  });

  it('overlapping rectangular ranges conflict: NEED_OVERLAP (E2C-SEM-002)', () => {
    // G11:I26 shares G11:G21 with E2:G21.
    expect(checkInstitutionMapping(CHECKS, entry('im-6', cell(30, 9), range(10, 6, 25, 8), ORG_C), [R1]))
      .toEqual({ reason: 'NEED_OVERLAP', conflictId: 'im-3' });
    // C6:D10 lies partly in the whole Need column C.
    expect(checkInstitutionMapping(CHECKS, entry('im-7', cell(40, 9), range(5, 2, 9, 3), ORG_C), [A]))
      .toEqual({ reason: 'NEED_OVERLAP', conflictId: 'im-1' });
    // One physical Need column for two beneficiaries.
    expect(checkInstitutionMapping(CHECKS, entry('im-2', cell(0, 3), column(2), ORG_B), [A])).toEqual({ reason: 'NEED_OVERLAP', conflictId: 'im-1' });
  });

  it('a Need source that includes the National Code column is refused — whole column or any range crossing it', () => {
    expect(checkInstitutionMapping(CHECKS, entry('im-2', cell(0, 3), column(0), ORG_B), [A])).toEqual({ reason: 'NEED_IS_NATIONAL_CODE_COLUMN' });
    expect(checkInstitutionMapping(CHECKS, entry('im-2', cell(0, 3), range(2, 0, 9, 0), ORG_B), [A])).toEqual({ reason: 'NEED_IS_NATIONAL_CODE_COLUMN' });
    expect(checkInstitutionMapping(CHECKS, entry('im-2', cell(0, 5), range(2, 0, 9, 3), ORG_B), [A])).toEqual({ reason: 'NEED_IS_NATIONAL_CODE_COLUMN' });
  });

  it('a Need source that includes the Material column is refused — whole column or any range crossing it', () => {
    expect(checkInstitutionMapping(CHECKS, entry('im-2', cell(0, 3), column(1), ORG_B), [A])).toEqual({ reason: 'NEED_IS_MATERIAL_COLUMN' });
    expect(checkInstitutionMapping(CHECKS, entry('im-2', cell(0, 5), range(2, 1, 9, 1), ORG_B), [A])).toEqual({ reason: 'NEED_IS_MATERIAL_COLUMN' });
    expect(institutionMappingProblems(CHECKS, entry('im-2', cell(0, 7), range(2, 1, 9, 5), ORG_B), [A]).map((p) => p.reason))
      .toEqual(['NEED_IS_MATERIAL_COLUMN', 'NEED_OVERLAP']);
  });

  it('with no E2-B role on a column, that column is free for a Need source', () => {
    const noRoles = { ...CHECKS, profile: profileWithRoles(null, null) };
    expect(checkInstitutionMapping(noRoles, entry('im-2', cell(0, 3), column(0), ORG_B), [A])).toBeNull();
    expect(checkInstitutionMapping(noRoles, entry('im-2', cell(0, 5), range(2, 0, 9, 1), ORG_B), [A])).toBeNull();
  });

  it('name cells: two DIFFERENT beneficiaries cannot share one', () => {
    expect(checkInstitutionMapping(CHECKS, entry('im-2', cell(0, 2), column(3), ORG_B), [A])).toEqual({ reason: 'ANCHOR_OVERLAP', conflictId: 'im-1' });
  });

  it('a name cell may not be a quantity cell of an explicit Need range — another entry\'s or its own', () => {
    const ranged = entry('im-3', cell(0, 5), range(2, 5, 9, 6), ORG_B); // F3:G10, named at F1
    expect(checkInstitutionMapping(CHECKS, entry('im-4', cell(5, 6), column(8), ORG_C), [ranged])).toEqual({ reason: 'ANCHOR_IN_NEED', conflictId: 'im-3' });
    expect(checkInstitutionMapping(CHECKS, entry('im-4', cell(12, 8), range(0, 5, 0, 6), ORG_C), [ranged])).toEqual({ reason: 'NEED_COVERS_ANCHOR', conflictId: 'im-3' });
    expect(checkInstitutionMapping(CHECKS, entry('im-4', cell(10, 7), column(5), ORG_C), [ranged])).toEqual({ reason: 'NEED_OVERLAP', conflictId: 'im-3' });
    expect(checkInstitutionMapping(CHECKS, entry('im-2', cell(2, 3), range(1, 3, 9, 4), ORG_B), [])).toEqual({ reason: 'ANCHOR_IN_OWN_NEED' });
  });

  it('a whole Need column is a column identity: name cells in it are headers, its own or another entry\'s', () => {
    expect(checkInstitutionMapping(CHECKS, entry('im-2', cell(0, 3), column(3), ORG_B), [])).toBeNull();
    // C6 lies in A's whole Need column C; it is not one of A's declared quantity cells.
    expect(checkInstitutionMapping(CHECKS, entry('im-2', cell(5, 2), column(3), ORG_B), [A])).toBeNull();
  });

  it('conflict semantics are deterministic: same input, same ordered problems, every time', () => {
    // A1:F5 named at F3: crosses both role columns, holds its own name cell, and overlaps Need column C.
    const candidate = entry('im-9', cell(2, 5), range(1, 0, 4, 5), ORG_B);
    const first = institutionMappingProblems(CHECKS, candidate, [A]);
    expect(first).toEqual([
      { reason: 'NEED_IS_NATIONAL_CODE_COLUMN' },
      { reason: 'NEED_IS_MATERIAL_COLUMN' },
      { reason: 'ANCHOR_IN_OWN_NEED' },
      { reason: 'NEED_OVERLAP', conflictId: 'im-1' },
    ]);
    for (let i = 0; i < 5; i += 1) expect(institutionMappingProblems(CHECKS, candidate, [A])).toEqual(first);
  });

  it('the reducer refuses a conflicting commit and keeps entries and draft untouched', () => {
    let state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    const before = state.mappings;
    state = run(state, observe(cell(0, 3)), { type: 'capture_anchor' }, observe(column(2)), { type: 'capture_need' }, choose(ORG_B), commit());
    expect(state.mappings).toBe(before);
    expect(state.outcome).toEqual({ kind: 'refused', step: 'commit', reason: 'NEED_OVERLAP', conflictId: 'im-1' });
    expect(state.draft).toMatchObject({ need: { kind: 'column', columnIndex: 2 }, beneficiaryOrganizationId: ORG_B });
  });

  it('a role column assigned in E2-B after the fact is reported against the existing entry — column or range', () => {
    const later = { ...CHECKS, profile: profileWithRoles(0, 2) };
    expect(evaluateInstitutionMappings(later, [A])).toEqual([{ id: 'im-1', problems: [{ reason: 'NEED_IS_MATERIAL_COLUMN' }] }]);
    // National Code later placed on column F, inside the range E2:G21.
    const crossing = { ...CHECKS, profile: profileWithRoles(5, 1) };
    expect(evaluateInstitutionMappings(crossing, [A, R1])).toEqual([
      { id: 'im-1', problems: [] },
      { id: 'im-3', problems: [{ reason: 'NEED_IS_NATIONAL_CODE_COLUMN' }] },
    ]);
  });
});

describe('E2C-SEM-001 — one beneficiary may hold several independent Need sources', () => {
  const A = entry('im-1', cell(0, 2), column(2), ORG_A);

  it('1. an exact duplicate declaration is refused as DUPLICATE_MAPPING', () => {
    expect(checkInstitutionMapping(CHECKS, { ...A, id: 'im-2' }, [A])).toEqual({ reason: 'DUPLICATE_MAPPING', conflictId: 'im-1' });
    let state = mapInstitution(opened(), cell(0, 2), column(2), ORG_A);
    state = mapInstitution(state, cell(0, 2), column(2), ORG_A);
    expect(state.mappings).toHaveLength(1);
    expect(state.outcome).toEqual({ kind: 'refused', step: 'commit', reason: 'DUPLICATE_MAPPING', conflictId: 'im-1' });
  });

  it('2. the same beneficiary with an overlapping Need source is refused by the overlap rule — and only by it', () => {
    const overlapping = entry('im-2', cell(0, 3), range(3, 2, 8, 3), ORG_A); // C4:D9 crosses Need column C
    expect(institutionMappingProblems(CHECKS, overlapping, [A])).toEqual([{ reason: 'NEED_OVERLAP', conflictId: 'im-1' }]);
    expect(institutionMappingProblems(CHECKS, entry('im-2', cell(0, 3), column(2), ORG_A), [A]))
      .toEqual([{ reason: 'NEED_OVERLAP', conflictId: 'im-1' }]);
  });

  it('3. the same beneficiary with independent, non-overlapping Need sources is accepted', () => {
    // Separate columns, separate name cells.
    expect(checkInstitutionMapping(CHECKS, entry('im-2', cell(0, 3), column(3), ORG_A), [A])).toBeNull();
    // One name cell (e.g. a merged header) over two separate Need columns.
    expect(checkInstitutionMapping(CHECKS, entry('im-2', cell(0, 2, 'C1:D1'), column(3), ORG_A), [entry('im-1', cell(0, 2, 'C1:D1'), column(2), ORG_A)]))
      .toBeNull();
    // Separate rectangular ranges.
    const top = entry('im-3', cell(0, 4), range(1, 4, 20, 6), ORG_A);
    const bottom = entry('im-4', cell(21, 4), range(22, 4, 40, 6), ORG_A);
    expect(checkInstitutionMapping(CHECKS, bottom, [A, top])).toBeNull();
    expect(evaluateInstitutionMappings(CHECKS, [A, top, bottom]).map((s) => s.problems)).toEqual([[], [], []]);
  });

  it('the reducer adds the second independent entry for the same beneficiary', () => {
    let state = mapInstitution(opened(), cell(0, 2, 'C1:D1'), column(2), ORG_A);
    state = mapInstitution(state, cell(0, 2, 'C1:D1'), column(3), ORG_A);
    expect(state.mappings.map((m) => [m.id, m.beneficiaryOrganizationId, m.need])).toEqual([
      ['im-1', ORG_A, { kind: 'column', columnIndex: 2 }],
      ['im-2', ORG_A, { kind: 'column', columnIndex: 3 }],
    ]);
    expect(state.outcome).toEqual({ kind: 'added', id: 'im-2', beneficiaryOrganizationId: ORG_A });
  });

  it('no rule counts entries per beneficiary: five independent Need columns for one institution are all valid', () => {
    const five = [2, 3, 4, 5, 6].map((col, i) => entry(`im-${i + 1}`, cell(0, col), column(col), ORG_A));
    expect(evaluateInstitutionMappings(CHECKS, five).every((s) => s.problems.length === 0)).toBe(true);
  });
});

describe('E2-C.6 — the beneficiary is an explicit, trusted organization id', () => {
  it('a draft without a beneficiary is INCOMPLETE — nothing is filled in for the human', () => {
    const state = run(opened(), { type: 'capture_anchor' }, observe(column(2)), { type: 'capture_need' }, commit());
    expect(state.outcome).toEqual({ kind: 'refused', step: 'commit', reason: 'INCOMPLETE_MAPPING' });
    expect(state.draft.beneficiaryOrganizationId).toBeNull();
    expect(state.mappings).toEqual([]);
  });

  it('each missing part is INCOMPLETE, whatever the order', () => {
    for (const actions of [
      [choose(ORG_A), commit()],
      [{ type: 'capture_anchor' } as const, choose(ORG_A), commit()],
      [observe(column(2)), { type: 'capture_need' } as const, choose(ORG_A), commit()],
    ]) {
      expect(run(opened(), ...actions).outcome).toMatchObject({ kind: 'refused', reason: 'INCOMPLETE_MAPPING' });
    }
  });

  it('choosing "none" clears the choice; the empty option never counts as a beneficiary', () => {
    const state = run(opened(), choose(ORG_A), choose(''));
    expect(state.draft.beneficiaryOrganizationId).toBeNull();
    expect(run(opened(), choose(null)).draft.beneficiaryOrganizationId).toBeNull();
  });

  it('the plan owner organization is never substituted: it is not an input, and not an eligible choice', () => {
    const complete = run(opened(), { type: 'capture_anchor' }, observe(column(2)), { type: 'capture_need' });
    // Without a choice there is no fallback to any other organization.
    expect(run(complete, commit()).mappings).toEqual([]);
    // Choosing the plan owner (not an active care institution in the trusted list) is refused.
    const owner = run(complete, choose(PLAN_OWNER), commit());
    expect(owner.outcome).toEqual({ kind: 'refused', step: 'commit', reason: 'BENEFICIARY_NOT_ELIGIBLE' });
    // The committed beneficiary is exactly the chosen id.
    const chosen = run(complete, choose(ORG_B), commit());
    expect(chosen.mappings[0].beneficiaryOrganizationId).toBe(ORG_B);
    expect(JSON.stringify(chosen)).not.toContain(PLAN_OWNER);
  });

  it('a workbook label or a code is not an organization id: it cannot become a beneficiary', () => {
    const complete = run(opened(), { type: 'capture_anchor' }, observe(column(2)), { type: 'capture_need' });
    for (const label of ['مستشفى الأمل', 'Hospital A', 'HOSP-A']) {
      expect(run(complete, choose(label), commit()).outcome).toEqual({ kind: 'refused', step: 'commit', reason: 'BENEFICIARY_NOT_ELIGIBLE' });
    }
  });

  it('capturing a name cell or Need source never touches the beneficiary', () => {
    const state = run(opened(), choose(ORG_C), { type: 'capture_anchor' }, observe(column(2)), { type: 'capture_need' });
    expect(state.draft.beneficiaryOrganizationId).toBe(ORG_C);
    const fresh = run(opened(), { type: 'capture_anchor' }, observe(column(2)), { type: 'capture_need' });
    expect(fresh.draft.beneficiaryOrganizationId).toBeNull();
  });

  it('an institution that left the trusted list is reported against its existing entry', () => {
    const A = entry('im-1', cell(0, 2), column(2), ORG_A);
    expect(evaluateInstitutionMappings({ ...CHECKS, eligibleBeneficiaryIds: [ORG_B] }, [A]))
      .toEqual([{ id: 'im-1', problems: [{ reason: 'BENEFICIARY_NOT_ELIGIBLE' }] }]);
  });

  it('the panel pre-check and the commit judge the same candidate', () => {
    const state = run(opened(), { type: 'capture_anchor' }, observe(column(2)), { type: 'capture_need' }, choose(ORG_A));
    const drafted = draftCandidate(state);
    expect(drafted).toEqual({ ok: true, candidate: { id: 'im-1', anchor: state.draft.anchor, need: state.draft.need, beneficiaryOrganizationId: ORG_A } });
    expect(draftCandidate(opened())).toEqual({ ok: false, reason: 'INCOMPLETE_MAPPING' });
    expect(draftCandidate(INITIAL_INSTITUTION_MAPPING_STATE)).toEqual({ ok: false, reason: 'NO_TRUSTED_SELECTION' });
  });
});

describe('E2-C.7 — geometry only: no quantity, no value, no National Code value', () => {
  it('an entry carries coordinates and an id — no cell value, no quantity, no default', () => {
    const state = mapInstitution(opened(), cell(0, 2, 'C1:D1'), range(1, 2, 30, 3), ORG_A);
    const [mapped] = state.mappings;
    expect(Object.keys(mapped)).toEqual(['id', 'anchor', 'need', 'beneficiaryOrganizationId']);
    expect(Object.keys(mapped.anchor)).toEqual(['kind', 'rowIndex', 'columnIndex', 'mergedRange']);
    expect(mapped.need).toEqual({ kind: 'range', startRow: 1, endRow: 30, startColumn: 2, endColumn: 3 });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/quantit|"value"|rawValue|formattedText|nationalCode"\s*:\s*"/i);
  });

  it('the National Code role is read as a column index only — nothing about its values reaches E2-C', () => {
    const problems = institutionMappingProblems(CHECKS, entry('im-1', cell(0, 3), column(0), ORG_A), []);
    expect(problems).toEqual([{ reason: 'NEED_IS_NATIONAL_CODE_COLUMN' }]);
    const profile = profileWithRoles();
    expect(Object.keys(profile.nationalCodeColumn ?? {})).toEqual(['columnIndex']);
  });
});
