/**
 * E2-B.1 — the Sheet Mapping Profile, pure.
 *
 * A HUMAN's explicit declaration of which physical column of one trusted sheet
 * holds the National Code and which holds the Material. Every assignment comes
 * from an E2-A ColumnSelection, re-derived through E2-A's own builders; nothing
 * reads a cell, a header, a sheet name or a file name to decide anything.
 * Invalid input fails closed with an explicit reason — never a repaired value.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCellSelection,
  buildColumnSelection,
  buildRangeSelection,
  type ColumnSelection,
  type WorkbookSelection,
  type WorkbookSourceIdentity,
} from '../../excel-first/workbookSelection';
import {
  INITIAL_SHEET_MAPPING_STATE,
  MAPPING_ROLES,
  assignRole,
  clearRole,
  createSheetMappingProfile,
  isValidProfile,
  resetProfile,
  roleColumn,
  sameProfileIdentity,
  sameSourceIdentity,
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

const column = (columnIndex: number, source = SOURCE, sheet = SHEET): ColumnSelection =>
  buildColumnSelection(source, sheet, columnIndex) as ColumnSelection;
const cell = (row: number, col: number) => buildCellSelection(SOURCE, SHEET, row, col) as WorkbookSelection;
const range = () => buildRangeSelection(SOURCE, SHEET, { row: 0, col: 0 }, { row: 3, col: 2 }) as WorkbookSelection;

function profileOf(selection: WorkbookSelection = column(0)): SheetMappingProfile {
  const created = createSheetMappingProfile(selection);
  if (!created.ok) throw new Error(`fixture failed: ${created.reason}`);
  return created.profile;
}

function assigned(profile: SheetMappingProfile, role: 'national_code' | 'material', selection: WorkbookSelection) {
  const result = assignRole(profile, role, selection);
  if (!result.ok) throw new Error(`fixture failed: ${result.reason}`);
  return result.profile;
}

describe('E2-B.1 — creating a profile', () => {
  it('creates an empty profile from a trusted column selection, carrying exactly its source and sheet', () => {
    const result = createSheetMappingProfile(column(3));
    expect(result).toEqual({
      ok: true,
      profile: { source: SOURCE, sheetIndex: 0, sheetName: 'الاحتياج', nationalCodeColumn: null, materialColumn: null },
    });
    expect(Object.keys(result.ok && result.profile).sort()).toEqual(
      ['materialColumn', 'nationalCodeColumn', 'sheetIndex', 'sheetName', 'source'],
    );
  });

  it('a cell or range selection also establishes the context — but assigns no role', () => {
    for (const selection of [cell(4, 1), range()]) {
      const result = createSheetMappingProfile(selection);
      expect(result.ok && result.profile.nationalCodeColumn).toBeNull();
      expect(result.ok && result.profile.materialColumn).toBeNull();
    }
  });

  it('the profile is detached — mutating the selection afterwards cannot reach it', () => {
    const selection = column(1);
    const profile = profileOf(selection);
    (selection.source as { batchId: string }).batchId = 'tampered';
    expect(profile.source.batchId).toBe('batch-1');
  });

  it.each([
    ['null', null],
    ['a bare number', 3],
    ['a column index with no source', { kind: 'column', sheetIndex: 0, sheetName: 'x', columnIndex: 1 }],
    ['an unknown kind', { ...column(1), kind: 'row' }],
    ['a bad SHA-256', column(1, { ...SOURCE, entrySha256: 'nope' })],
    ['a negative column', { ...column(1), columnIndex: -1 }],
    ['a column past XFD', { ...column(1), columnIndex: 16_384 }],
    ['a fractional column', { ...column(1), columnIndex: 1.5 }],
    ['an extra field smuggled in', { ...column(1), role: 'national_code' }],
    ['an altered A1 on a cell', { ...cell(1, 1), a1: 'Z9' }],
    ['a non-normalized range', { ...range(), startRow: 3, endRow: 0 }],
  ])('rejects %s as INVALID_SELECTION', (_label, selection) => {
    expect(createSheetMappingProfile(selection as never)).toEqual({ ok: false, reason: 'INVALID_SELECTION' });
  });
});

describe('E2-B.2 — assigning and clearing roles', () => {
  it('assigns National Code from a column selection', () => {
    const profile = assigned(profileOf(), 'national_code', column(0));
    expect(profile.nationalCodeColumn).toEqual({ columnIndex: 0 });
    expect(profile.materialColumn).toBeNull();
  });

  it('assigns Material from a column selection', () => {
    const profile = assigned(profileOf(), 'material', column(2));
    expect(profile.materialColumn).toEqual({ columnIndex: 2 });
    expect(profile.nationalCodeColumn).toBeNull();
  });

  it('preserves two distinct valid columns', () => {
    const profile = assigned(assigned(profileOf(), 'national_code', column(0)), 'material', column(2));
    expect(profile).toMatchObject({ nationalCodeColumn: { columnIndex: 0 }, materialColumn: { columnIndex: 2 } });
    expect(isValidProfile(profile)).toBe(true);
    expect(roleColumn(profile, 'national_code')).toBe(0);
    expect(roleColumn(profile, 'material')).toBe(2);
  });

  it('clears National Code and leaves Material', () => {
    const both = assigned(assigned(profileOf(), 'national_code', column(0)), 'material', column(2));
    const result = clearRole(both, 'national_code');
    expect(result).toEqual({ ok: true, profile: { ...both, nationalCodeColumn: null } });
  });

  it('clears Material and leaves National Code', () => {
    const both = assigned(assigned(profileOf(), 'national_code', column(0)), 'material', column(2));
    const result = clearRole(both, 'material');
    expect(result).toEqual({ ok: true, profile: { ...both, materialColumn: null } });
  });

  it('never mutates the profile it was given', () => {
    const before = profileOf();
    const snapshot = JSON.stringify(before);
    assignRole(before, 'national_code', column(0));
    clearRole(before, 'material');
    resetProfile(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('moving a role to another column of the same sheet is an explicit, allowed action', () => {
    const moved = assigned(assigned(profileOf(), 'national_code', column(0)), 'national_code', column(4));
    expect(moved.nationalCodeColumn).toEqual({ columnIndex: 4 });
  });

  it('re-assigning a role to the column it already has is a no-op success', () => {
    const once = assigned(profileOf(), 'material', column(1));
    expect(assignRole(once, 'material', column(1))).toEqual({ ok: true, profile: once });
  });

  it('only E2-B roles exist', () => {
    expect(MAPPING_ROLES).toEqual(['national_code', 'material']);
    expect(assignRole(profileOf(), 'institution' as never, column(1))).toEqual({ ok: false, reason: 'INVALID_ROLE' });
    expect(clearRole(profileOf(), 'need' as never)).toEqual({ ok: false, reason: 'INVALID_ROLE' });
  });
});

describe('E2-B.3 — fail closed: only a whole trusted column of the SAME source and sheet', () => {
  it('rejects a cell selection', () => {
    expect(assignRole(profileOf(), 'national_code', cell(1, 0))).toEqual({ ok: false, reason: 'NOT_COLUMN_SELECTION' });
  });

  it('rejects a range selection', () => {
    expect(assignRole(profileOf(), 'material', range())).toEqual({ ok: false, reason: 'NOT_COLUMN_SELECTION' });
  });

  it('rejects the same physical column for both roles — no swap, no silent clear', () => {
    const withCode = assigned(profileOf(), 'national_code', column(1));
    expect(assignRole(withCode, 'material', column(1))).toEqual({ ok: false, reason: 'ROLE_CONFLICT' });
    const withMaterial = assigned(profileOf(), 'material', column(3));
    expect(assignRole(withMaterial, 'national_code', column(3))).toEqual({ ok: false, reason: 'ROLE_CONFLICT' });
  });

  it.each([
    ['batch', { batchId: 'batch-2' }],
    ['entry', { entryId: 'entry-2' }],
    ['entry ordinal', { entryOrdinal: 2 }],
    ['entry SHA-256', { entrySha256: 'b'.repeat(64) }],
    ['import session', { importSessionId: 'session-2' }],
    ['workbook (ZIP member)', { workbookIndex: 1 }],
  ])('rejects a %s mismatch as SOURCE_MISMATCH', (_label, change) => {
    const other = column(1, { ...SOURCE, ...change });
    expect(assignRole(profileOf(), 'national_code', other)).toEqual({ ok: false, reason: 'SOURCE_MISMATCH' });
  });

  it('rejects a sheet mismatch (index, or the label a verified source fixes)', () => {
    expect(assignRole(profileOf(), 'material', column(1, SOURCE, { sheetIndex: 1, sheetName: 'الاحتياج' })))
      .toEqual({ ok: false, reason: 'SHEET_MISMATCH' });
    expect(assignRole(profileOf(), 'material', column(1, SOURCE, { sheetIndex: 0, sheetName: 'Other' })))
      .toEqual({ ok: false, reason: 'SHEET_MISMATCH' });
  });

  it('rejects an untrusted column and a malformed profile', () => {
    expect(assignRole(profileOf(), 'material', { ...column(1), columnIndex: -2 } as never))
      .toEqual({ ok: false, reason: 'INVALID_SELECTION' });
    expect(assignRole({ ...profileOf(), sheetIndex: -1 }, 'material', column(1)))
      .toEqual({ ok: false, reason: 'INVALID_PROFILE' });
    const dual = { ...profileOf(), nationalCodeColumn: { columnIndex: 1 }, materialColumn: { columnIndex: 1 } };
    expect(isValidProfile(dual)).toBe(false);
    expect(clearRole(dual, 'material')).toEqual({ ok: false, reason: 'INVALID_PROFILE' });
  });

  it('checks in a fixed order: a cell from another source is NOT_COLUMN_SELECTION first', () => {
    const foreignCell = buildCellSelection({ ...SOURCE, batchId: 'batch-2' }, SHEET, 0, 0) as WorkbookSelection;
    expect(assignRole(profileOf(), 'material', foreignCell)).toEqual({ ok: false, reason: 'NOT_COLUMN_SELECTION' });
  });
});

describe('E2-B.4 — identity and reset', () => {
  it('reset is deterministic: both roles cleared, identity unchanged', () => {
    const both = assigned(assigned(profileOf(), 'national_code', column(0)), 'material', column(2));
    const a = resetProfile(both);
    const b = resetProfile(both);
    expect(a).toEqual(b);
    expect(a).toEqual({ ok: true, profile: { ...both, nationalCodeColumn: null, materialColumn: null } });
  });

  it('identity is compared on primitive trusted fields, never by object reference', () => {
    const p1 = profileOf(column(0));
    const p2 = profileOf(column(5));
    expect(p1.source).not.toBe(p2.source);
    expect(sameProfileIdentity(p1, p2)).toBe(true);
    expect(sameSourceIdentity(p1.source, { ...SOURCE })).toBe(true);
    expect(sameSourceIdentity(p1.source, { ...SOURCE, importSessionId: 'session-2' })).toBe(false);
    expect(sameProfileIdentity(p1, profileOf(column(0, SOURCE, { sheetIndex: 1, sheetName: 'x' })))).toBe(false);
  });
});

describe('E2-B.5 — the transition contract (reducer)', () => {
  const observe = (state: SheetMappingState, selection: WorkbookSelection | null) =>
    sheetMappingReducer(state, { type: 'selection_changed', selection });

  it('starts with no selection and no profile', () => {
    expect(INITIAL_SHEET_MAPPING_STATE).toEqual({ selection: null, profile: null, outcome: null });
  });

  it('a trusted selection opens an empty profile; assign uses ONLY the held selection', () => {
    let state = observe(INITIAL_SHEET_MAPPING_STATE, column(1));
    expect(state.profile).toMatchObject({ nationalCodeColumn: null, materialColumn: null });
    state = sheetMappingReducer(state, { type: 'assign', role: 'national_code' });
    expect(state.profile?.nationalCodeColumn).toEqual({ columnIndex: 1 });
    expect(state.outcome).toEqual({ kind: 'assigned', role: 'national_code', columnIndex: 1 });
  });

  it('a new selection in the same source + sheet keeps the profile', () => {
    let state = observe(INITIAL_SHEET_MAPPING_STATE, column(1));
    state = sheetMappingReducer(state, { type: 'assign', role: 'national_code' });
    state = observe(state, cell(5, 3));
    state = observe(state, column(2));
    state = sheetMappingReducer(state, { type: 'assign', role: 'material' });
    expect(state.profile).toMatchObject({ nationalCodeColumn: { columnIndex: 1 }, materialColumn: { columnIndex: 2 } });
  });

  it('a cell or range selection cannot assign — the profile is unchanged and the refusal is recorded', () => {
    for (const selection of [cell(1, 1), range()]) {
      const opened = observe(INITIAL_SHEET_MAPPING_STATE, selection);
      const after = sheetMappingReducer(opened, { type: 'assign', role: 'material' });
      expect(after.profile).toEqual(opened.profile);
      expect(after.outcome).toEqual({ kind: 'refused', role: 'material', reason: 'NOT_COLUMN_SELECTION' });
    }
  });

  it('a conflict is refused and recorded; nothing is swapped or cleared', () => {
    let state = observe(INITIAL_SHEET_MAPPING_STATE, column(1));
    state = sheetMappingReducer(state, { type: 'assign', role: 'national_code' });
    const before = state.profile;
    state = sheetMappingReducer(state, { type: 'assign', role: 'material' });
    expect(state.profile).toEqual(before);
    expect(state.outcome).toEqual({ kind: 'refused', role: 'material', reason: 'ROLE_CONFLICT', columnIndex: 1 });
  });

  it.each([
    ['another sheet', column(1, SOURCE, { sheetIndex: 1, sheetName: 'Other' })],
    ['another workbook of the ZIP', column(1, { ...SOURCE, workbookIndex: 1, entryId: 'entry-2', entryOrdinal: 2 })],
    ['another batch', column(1, { ...SOURCE, batchId: 'batch-2' })],
    ['another import session', column(1, { ...SOURCE, importSessionId: 'session-2' })],
  ])('a selection from %s discards the old profile and starts empty', (_label, selection) => {
    let state = observe(INITIAL_SHEET_MAPPING_STATE, column(1));
    state = sheetMappingReducer(state, { type: 'assign', role: 'national_code' });
    state = observe(state, selection);
    expect(state.profile).toMatchObject({ nationalCodeColumn: null, materialColumn: null });
    expect(state.profile?.source).toEqual(selection.source);
  });

  it('null (sheet switch, close, identity lost) discards the profile; returning cannot resurrect it', () => {
    let state = observe(INITIAL_SHEET_MAPPING_STATE, column(1));
    state = sheetMappingReducer(state, { type: 'assign', role: 'national_code' });
    state = observe(state, null);
    expect(state).toEqual(INITIAL_SHEET_MAPPING_STATE);
    state = observe(state, column(1));
    expect(state.profile).toMatchObject({ nationalCodeColumn: null, materialColumn: null });
  });

  it('a malformed selection is treated as no trusted context', () => {
    let state = observe(INITIAL_SHEET_MAPPING_STATE, column(1));
    state = sheetMappingReducer(state, { type: 'assign', role: 'national_code' });
    state = observe(state, { ...column(1), columnIndex: -1 } as never);
    expect(state).toEqual(INITIAL_SHEET_MAPPING_STATE);
  });

  it('with no trusted selection, assign and clear are refused or ignored — never invented', () => {
    const refused = sheetMappingReducer(INITIAL_SHEET_MAPPING_STATE, { type: 'assign', role: 'national_code' });
    expect(refused).toEqual({ selection: null, profile: null, outcome: { kind: 'refused', role: 'national_code', reason: 'NO_TRUSTED_SELECTION' } });
    expect(sheetMappingReducer(INITIAL_SHEET_MAPPING_STATE, { type: 'clear', role: 'material' })).toBe(INITIAL_SHEET_MAPPING_STATE);
  });

  it('clear and reset act on the held profile', () => {
    let state = observe(INITIAL_SHEET_MAPPING_STATE, column(1));
    state = sheetMappingReducer(state, { type: 'assign', role: 'national_code' });
    state = observe(state, column(3));
    state = sheetMappingReducer(state, { type: 'assign', role: 'material' });
    state = sheetMappingReducer(state, { type: 'clear', role: 'national_code' });
    expect(state.profile).toMatchObject({ nationalCodeColumn: null, materialColumn: { columnIndex: 3 } });
    expect(state.outcome).toEqual({ kind: 'cleared', role: 'national_code' });
    state = sheetMappingReducer(state, { type: 'reset' });
    expect(state.profile).toMatchObject({ nationalCodeColumn: null, materialColumn: null });
  });

  it('re-reporting the identical selection returns the identical state (no churn)', () => {
    const state = observe(INITIAL_SHEET_MAPPING_STATE, column(1));
    expect(observe(state, column(1))).toBe(state);
  });

  it('the state holds a canonical copy of the selection, not the caller\'s object', () => {
    const selection = column(2);
    const state = observe(INITIAL_SHEET_MAPPING_STATE, selection);
    expect(state.selection).toEqual(selection);
    expect(state.selection).not.toBe(selection);
  });
});
