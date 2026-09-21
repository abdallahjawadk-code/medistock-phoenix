/**
 * E2-B — the Sheet Mapping Profile.
 *
 * A HUMAN's explicit, in-memory declaration of which physical column of ONE
 * trusted sheet holds the National Code and which holds the Material. It is a
 * draft of column roles, nothing more: it assigns no institution, beneficiary
 * or need, persists nothing and writes nothing.
 *
 * DECLARED, NEVER INFERRED. Nothing here reads a cell, a header, a sheet name,
 * a file name or a column's position to propose, rank or check a role, and no
 * National Code value is read, parsed or normalized. Workbook text is evidence
 * shown by the viewer; the human is the authority.
 *
 * TRUSTED INPUT ONLY. A role comes from an E2-A `ColumnSelection` and nothing
 * else — never from a bare column number. Every selection is re-derived through
 * E2-A's own builders and must reproduce the identical canonical selection, so
 * E2-A's identity, bounds and shape rules apply unchanged.
 *
 * PROFILE IDENTITY = the trusted source identity (batch, entry, ordinal,
 * SHA-256, import session, workbook) + the physical sheet index, compared field
 * by field on primitives. The sheet name is carried as the verified sheet's
 * label and never decides anything.
 *
 * FAIL CLOSED. Every operation returns `{ ok: false, reason }` rather than a
 * repaired value. Pure: no React, no service, no network, no storage.
 */
import {
  buildCellSelection,
  buildColumnSelection,
  buildRangeSelection,
  isValidSourceIdentity,
  selectionKey,
  type WorkbookSelection,
  type WorkbookSourceIdentity,
} from '../excel-first/workbookSelection';

export type MappingRole = 'national_code' | 'material';
export const MAPPING_ROLES: readonly MappingRole[] = ['national_code', 'material'];

export interface PhysicalMappedColumn {
  /** 0-based physical column index on the profile's sheet. */
  columnIndex: number;
}

export interface SheetMappingProfile {
  source: WorkbookSourceIdentity;
  sheetIndex: number;
  /** The verified sheet's label; carried, never used to decide anything. */
  sheetName: string;
  nationalCodeColumn: PhysicalMappedColumn | null;
  materialColumn: PhysicalMappedColumn | null;
}

export type MappingFailure =
  | 'INVALID_SELECTION'
  | 'NOT_COLUMN_SELECTION'
  | 'SOURCE_MISMATCH'
  | 'SHEET_MISMATCH'
  | 'ROLE_CONFLICT'
  | 'INVALID_PROFILE'
  | 'INVALID_ROLE'
  | 'NO_TRUSTED_SELECTION';

export type MappingResult =
  | { ok: true; profile: SheetMappingProfile }
  | { ok: false; reason: MappingFailure };

type RoleField = 'nationalCodeColumn' | 'materialColumn';

const ROLE_FIELD: Record<MappingRole, RoleField> = {
  national_code: 'nationalCodeColumn',
  material: 'materialColumn',
};

const OTHER_ROLE: Record<MappingRole, MappingRole> = {
  national_code: 'material',
  material: 'national_code',
};

const fail = (reason: MappingFailure): MappingResult => ({ ok: false, reason });

const isRole = (role: unknown): role is MappingRole =>
  typeof role === 'string' && (MAPPING_ROLES as readonly string[]).includes(role);

// ---------------------------------------------------------------------------
// Trusted input
// ---------------------------------------------------------------------------

function keyOf(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * The canonical E2-A selection this input describes, or null. The input is
 * rebuilt through E2-A's builders and accepted only if the rebuilt selection is
 * identical — so a hand-made object, an altered coordinate or an extra field is
 * refused, and the caller's object is never retained.
 */
function canonicalSelection(input: unknown): WorkbookSelection | null {
  if (!input || typeof input !== 'object') return null;
  const s = input as Record<string, unknown>;
  const source = (s.source ?? null) as WorkbookSourceIdentity | null;
  const sheet = { sheetIndex: s.sheetIndex as number, sheetName: s.sheetName as string };
  let rebuilt: WorkbookSelection | null = null;
  if (s.kind === 'column') {
    rebuilt = buildColumnSelection(source, sheet, s.columnIndex as number);
  } else if (s.kind === 'cell') {
    rebuilt = buildCellSelection(source, sheet, s.rowIndex as number, s.columnIndex as number, (s.mergedRange ?? null) as string | null);
  } else if (s.kind === 'range') {
    rebuilt = buildRangeSelection(
      source,
      sheet,
      { row: s.startRow as number, col: s.startColumn as number },
      { row: s.endRow as number, col: s.endColumn as number },
    );
  }
  if (!rebuilt) return null;
  return keyOf(input) === selectionKey(rebuilt) ? rebuilt : null;
}

// ---------------------------------------------------------------------------
// Identity (primitive comparison only)
// ---------------------------------------------------------------------------

export function sameSourceIdentity(a: WorkbookSourceIdentity, b: WorkbookSourceIdentity): boolean {
  return a.batchId === b.batchId
    && a.entryId === b.entryId
    && a.entryOrdinal === b.entryOrdinal
    && a.entrySha256 === b.entrySha256
    && a.importSessionId === b.importSessionId
    && a.workbookIndex === b.workbookIndex;
}

type SheetContext = Pick<SheetMappingProfile, 'source' | 'sheetIndex' | 'sheetName'>;

export function sameProfileIdentity(a: SheetContext, b: SheetContext): boolean {
  return sameSourceIdentity(a.source, b.source) && a.sheetIndex === b.sheetIndex && a.sheetName === b.sheetName;
}

function contextMismatch(profile: SheetContext, selection: WorkbookSelection): MappingFailure | null {
  if (!sameSourceIdentity(profile.source, selection.source)) return 'SOURCE_MISMATCH';
  if (profile.sheetIndex !== selection.sheetIndex || profile.sheetName !== selection.sheetName) return 'SHEET_MISMATCH';
  return null;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function validMappedColumn(profile: SheetContext, column: unknown): boolean {
  if (column === null) return true;
  if (!column || typeof column !== 'object') return false;
  const { sheetIndex, sheetName } = profile;
  // E2-A's own bounds decide what a physical column index may be.
  return buildColumnSelection(profile.source, { sheetIndex, sheetName }, (column as PhysicalMappedColumn).columnIndex) !== null;
}

export function isValidProfile(profile: SheetMappingProfile | null | undefined): profile is SheetMappingProfile {
  if (!profile || typeof profile !== 'object') return false;
  if (!isValidSourceIdentity(profile.source)) return false;
  if (!Number.isInteger(profile.sheetIndex) || profile.sheetIndex < 0 || typeof profile.sheetName !== 'string') return false;
  if (!validMappedColumn(profile, profile.nationalCodeColumn) || !validMappedColumn(profile, profile.materialColumn)) return false;
  return !(profile.nationalCodeColumn && profile.materialColumn
    && profile.nationalCodeColumn.columnIndex === profile.materialColumn.columnIndex);
}

/** The physical column carrying `role`, or null. */
export function roleColumn(profile: SheetMappingProfile, role: MappingRole): number | null {
  return profile[ROLE_FIELD[role]]?.columnIndex ?? null;
}

function withRole(profile: SheetMappingProfile, role: MappingRole, columnIndex: number | null): SheetMappingProfile {
  return {
    source: { ...profile.source },
    sheetIndex: profile.sheetIndex,
    sheetName: profile.sheetName,
    nationalCodeColumn: profile.nationalCodeColumn ? { columnIndex: profile.nationalCodeColumn.columnIndex } : null,
    materialColumn: profile.materialColumn ? { columnIndex: profile.materialColumn.columnIndex } : null,
    [ROLE_FIELD[role]]: columnIndex === null ? null : { columnIndex },
  };
}

/** An empty profile for the trusted selection's source and sheet. Any selection kind sets the context; none assigns a role. */
export function createSheetMappingProfile(selection: WorkbookSelection): MappingResult {
  const trusted = canonicalSelection(selection);
  if (!trusted) return fail('INVALID_SELECTION');
  return {
    ok: true,
    profile: {
      source: trusted.source,
      sheetIndex: trusted.sheetIndex,
      sheetName: trusted.sheetName,
      nationalCodeColumn: null,
      materialColumn: null,
    },
  };
}

/**
 * Declare `role` for the whole physical column the human selected.
 * Order of checks: profile → role → selection → kind → source → sheet → conflict.
 */
export function assignRole(profile: SheetMappingProfile, role: MappingRole, selection: WorkbookSelection): MappingResult {
  if (!isValidProfile(profile)) return fail('INVALID_PROFILE');
  if (!isRole(role)) return fail('INVALID_ROLE');
  const trusted = canonicalSelection(selection);
  if (!trusted) return fail('INVALID_SELECTION');
  if (trusted.kind !== 'column') return fail('NOT_COLUMN_SELECTION');
  const mismatch = contextMismatch(profile, trusted);
  if (mismatch) return fail(mismatch);
  if (roleColumn(profile, OTHER_ROLE[role]) === trusted.columnIndex) return fail('ROLE_CONFLICT');
  if (roleColumn(profile, role) === trusted.columnIndex) return { ok: true, profile };
  return { ok: true, profile: withRole(profile, role, trusted.columnIndex) };
}

export function clearRole(profile: SheetMappingProfile, role: MappingRole): MappingResult {
  if (!isValidProfile(profile)) return fail('INVALID_PROFILE');
  if (!isRole(role)) return fail('INVALID_ROLE');
  if (roleColumn(profile, role) === null) return { ok: true, profile };
  return { ok: true, profile: withRole(profile, role, null) };
}

export function resetProfile(profile: SheetMappingProfile): MappingResult {
  if (!isValidProfile(profile)) return fail('INVALID_PROFILE');
  return { ok: true, profile: withRole(withRole(profile, 'national_code', null), 'material', null) };
}

// ---------------------------------------------------------------------------
// Transition contract (pure reducer)
// ---------------------------------------------------------------------------

export type MappingOutcome =
  | { kind: 'assigned'; role: MappingRole; columnIndex: number }
  | { kind: 'cleared'; role: MappingRole }
  | { kind: 'reset' }
  | { kind: 'refused'; role: MappingRole; reason: MappingFailure; columnIndex?: number };

export interface SheetMappingState {
  /** The last selection the trusted source viewer reported (canonical copy), or null. */
  selection: WorkbookSelection | null;
  /** The draft for that selection's source + sheet; null without a trusted context. */
  profile: SheetMappingProfile | null;
  /** The result of the last human action, for the accessible status/alert. */
  outcome: MappingOutcome | null;
}

export type SheetMappingAction =
  | { type: 'selection_changed'; selection: WorkbookSelection | null }
  | { type: 'assign'; role: MappingRole }
  | { type: 'clear'; role: MappingRole }
  | { type: 'reset' };

export const INITIAL_SHEET_MAPPING_STATE: SheetMappingState = Object.freeze({
  selection: null,
  profile: null,
  outcome: null,
}) as SheetMappingState;

/**
 * - `selection_changed(null)` — the viewer left the context (sheet, workbook,
 *   batch, close, refused or lost identity, unmount): the profile is discarded,
 *   so returning later starts empty.
 * - `selection_changed(s)` in the same source + sheet keeps the profile; in
 *   another one it starts a new, empty profile. A malformed `s` counts as no
 *   trusted context.
 * - `assign` uses ONLY the selection held here — callers pass a role, never
 *   coordinates. A refusal leaves the profile untouched.
 */
export function sheetMappingReducer(state: SheetMappingState, action: SheetMappingAction): SheetMappingState {
  switch (action.type) {
    case 'selection_changed': {
      const trusted = action.selection === null ? null : canonicalSelection(action.selection);
      if (!trusted) return state === INITIAL_SHEET_MAPPING_STATE ? state : INITIAL_SHEET_MAPPING_STATE;
      if (state.profile && state.selection && selectionKey(state.selection) === selectionKey(trusted)) return state;
      if (state.profile && contextMismatch(state.profile, trusted) === null) {
        return { selection: trusted, profile: state.profile, outcome: null };
      }
      const created = createSheetMappingProfile(trusted);
      return { selection: trusted, profile: created.ok ? created.profile : null, outcome: null };
    }
    case 'assign': {
      if (!state.profile || !state.selection) {
        return { ...state, outcome: { kind: 'refused', role: action.role, reason: 'NO_TRUSTED_SELECTION' } };
      }
      const result = assignRole(state.profile, action.role, state.selection);
      if (!result.ok) {
        const outcome: MappingOutcome = state.selection.kind === 'column'
          ? { kind: 'refused', role: action.role, reason: result.reason, columnIndex: state.selection.columnIndex }
          : { kind: 'refused', role: action.role, reason: result.reason };
        return { ...state, outcome };
      }
      const columnIndex = roleColumn(result.profile, action.role) as number;
      return { ...state, profile: result.profile, outcome: { kind: 'assigned', role: action.role, columnIndex } };
    }
    case 'clear': {
      if (!state.profile) return state;
      const result = clearRole(state.profile, action.role);
      if (!result.ok) return { ...state, outcome: { kind: 'refused', role: action.role, reason: result.reason } };
      return { ...state, profile: result.profile, outcome: { kind: 'cleared', role: action.role } };
    }
    case 'reset': {
      if (!state.profile) return state;
      const result = resetProfile(state.profile);
      return result.ok ? { ...state, profile: result.profile, outcome: { kind: 'reset' } } : state;
    }
    default:
      return state;
  }
}
