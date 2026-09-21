/**
 * E2-C — Multi-Institution Mapping.
 *
 * A HUMAN's explicit, in-memory declaration, for ONE trusted sheet, of the
 * institutions whose Need quantities that sheet carries. Each entry states
 * three things, every one of them chosen by the human:
 *   - ANCHOR       where the institution's name is shown in the workbook: one
 *                  cell (a merged block's anchor coordinate) or one rectangle;
 *   - NEED SOURCE  where its Need quantities are: one whole physical column,
 *                  or a rectangle kept exactly as E2-A reported it;
 *   - BENEFICIARY  which MediStock care institution that is: an organization
 *                  id from the trusted list the screen already loaded.
 *
 * IT EXTENDS E2-B WITHOUT CHANGING IT. The Sheet Mapping Profile keeps the
 * National Code and Material columns; this module only reads them, and a Need
 * source may cover neither. Draft identity is E2-B's profile identity (trusted
 * source + sheet, compared field by field with E2-B's own functions), and
 * every selection is accepted through E2-B's `canonicalSelection`.
 *
 * DECLARED, NEVER INFERRED. Nothing here reads a cell, a header, a sheet name
 * or a file name, and no institution is proposed, matched or ranked. The
 * beneficiary is exactly the id the human picked. The plan owner's
 * organization is not an input: it cannot stand in for a beneficiary because
 * this module never sees it. No rule limits how many entries one beneficiary
 * may have: only a duplicate declaration or an ambiguous overlap is refused.
 *
 * GEOMETRY ONLY. No cell value is read, parsed, rounded or defaulted, so a
 * blank cell can never become 0 here and the National Code column stays a
 * column identity, never a value.
 *
 * FAIL CLOSED. Every operation returns a reason instead of a repaired value.
 * Pure: no React, no service, no network, no storage.
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
import {
  canonicalSelection,
  isValidProfile,
  roleColumn,
  sameProfileIdentity,
  sameSourceIdentity,
  type SheetMappingProfile,
} from './sheetMappingProfile';

/** Where the institution's name is shown. A merged block is its anchor coordinate (E2-A); covered cells are not implied. */
export type InstitutionAnchor =
  | { kind: 'cell'; rowIndex: number; columnIndex: number; mergedRange: string | null }
  | { kind: 'range'; startRow: number; endRow: number; startColumn: number; endColumn: number };

/**
 * Where the institution's Need quantities are: a whole physical column, or a
 * rectangle with exactly the normalized coordinates E2-A reported — never
 * narrowed to one column.
 */
export type NeedSource =
  | { kind: 'column'; columnIndex: number }
  | { kind: 'range'; startRow: number; endRow: number; startColumn: number; endColumn: number };

export interface InstitutionMapping {
  /** Key of this entry inside this draft only ('im-1', 'im-2', …). */
  id: string;
  anchor: InstitutionAnchor;
  need: NeedSource;
  /** The chosen care institution's organization id — never a workbook label, never the plan owner. */
  beneficiaryOrganizationId: string;
}

/** The trusted source + sheet a draft belongs to: exactly E2-B's profile identity. */
export interface MappingSheetContext {
  source: WorkbookSourceIdentity;
  sheetIndex: number;
  /** The verified sheet's label; carried, never used to decide anything. */
  sheetName: string;
}

export type InstitutionMappingFailure =
  | 'NO_TRUSTED_SELECTION'
  | 'INVALID_SELECTION'
  | 'INVALID_CONTEXT'
  | 'INVALID_MAPPING'
  | 'SOURCE_MISMATCH'
  | 'SHEET_MISMATCH'
  | 'ANCHOR_NOT_CELL_OR_RANGE'
  | 'NEED_NOT_COLUMN_OR_RANGE'
  | 'INCOMPLETE_MAPPING'
  | 'BENEFICIARY_NOT_ELIGIBLE'
  | 'PROFILE_MISMATCH'
  | 'NEED_IS_NATIONAL_CODE_COLUMN'
  | 'NEED_IS_MATERIAL_COLUMN'
  | 'DUPLICATE_MAPPING'
  | 'NEED_OVERLAP'
  | 'ANCHOR_IN_OWN_NEED'
  | 'ANCHOR_OVERLAP'
  | 'ANCHOR_IN_NEED'
  | 'NEED_COVERS_ANCHOR'
  | 'UNKNOWN_MAPPING';

/** A reason, and — when another entry is involved — which one. */
export interface InstitutionProblem {
  reason: InstitutionMappingFailure;
  conflictId?: string;
}

export type AnchorResult = { ok: true; anchor: InstitutionAnchor } | { ok: false; reason: InstitutionMappingFailure };
export type NeedResult = { ok: true; need: NeedSource } | { ok: false; reason: InstitutionMappingFailure };

// ---------------------------------------------------------------------------
// Context and trusted input
// ---------------------------------------------------------------------------

export function isValidContext(context: MappingSheetContext | null | undefined): context is MappingSheetContext {
  return !!context && typeof context === 'object'
    && isValidSourceIdentity(context.source)
    && Number.isInteger(context.sheetIndex) && context.sheetIndex >= 0
    && typeof context.sheetName === 'string';
}

/** The draft context a trusted selection establishes, or null for anything E2-B would not accept. */
export function contextOf(selection: WorkbookSelection | null): MappingSheetContext | null {
  const trusted = selection === null ? null : canonicalSelection(selection);
  return trusted ? { source: trusted.source, sheetIndex: trusted.sheetIndex, sheetName: trusted.sheetName } : null;
}

function mismatch(context: MappingSheetContext, selection: WorkbookSelection): InstitutionMappingFailure | null {
  if (!sameSourceIdentity(context.source, selection.source)) return 'SOURCE_MISMATCH';
  if (!sameProfileIdentity(context, selection)) return 'SHEET_MISMATCH';
  return null;
}

const sheetOf = (context: MappingSheetContext) => ({ sheetIndex: context.sheetIndex, sheetName: context.sheetName });

/**
 * The anchor for the human's selection: a cell or a rectangle.
 * Order of checks: context → selection → kind → source → sheet.
 */
export function anchorFromSelection(context: MappingSheetContext, selection: WorkbookSelection): AnchorResult {
  if (!isValidContext(context)) return { ok: false, reason: 'INVALID_CONTEXT' };
  const trusted = canonicalSelection(selection);
  if (!trusted) return { ok: false, reason: 'INVALID_SELECTION' };
  if (trusted.kind === 'column') return { ok: false, reason: 'ANCHOR_NOT_CELL_OR_RANGE' };
  const wrong = mismatch(context, trusted);
  if (wrong) return { ok: false, reason: wrong };
  return trusted.kind === 'cell'
    ? { ok: true, anchor: { kind: 'cell', rowIndex: trusted.rowIndex, columnIndex: trusted.columnIndex, mergedRange: trusted.mergedRange } }
    : {
      ok: true,
      anchor: {
        kind: 'range',
        startRow: trusted.startRow,
        endRow: trusted.endRow,
        startColumn: trusted.startColumn,
        endColumn: trusted.endColumn,
      },
    };
}

/**
 * The Need source for the human's selection: a whole column, or the range with
 * all four of its E2-A coordinates.
 * Order of checks: context → selection → kind → source → sheet.
 */
export function needFromSelection(context: MappingSheetContext, selection: WorkbookSelection): NeedResult {
  if (!isValidContext(context)) return { ok: false, reason: 'INVALID_CONTEXT' };
  const trusted = canonicalSelection(selection);
  if (!trusted) return { ok: false, reason: 'INVALID_SELECTION' };
  if (trusted.kind === 'cell') return { ok: false, reason: 'NEED_NOT_COLUMN_OR_RANGE' };
  const wrong = mismatch(context, trusted);
  if (wrong) return { ok: false, reason: wrong };
  return trusted.kind === 'column'
    ? { ok: true, need: { kind: 'column', columnIndex: trusted.columnIndex } }
    : {
      ok: true,
      need: {
        kind: 'range',
        startRow: trusted.startRow,
        endRow: trusted.endRow,
        startColumn: trusted.startColumn,
        endColumn: trusted.endColumn,
      },
    };
}

// ---------------------------------------------------------------------------
// Stored geometry: re-derived through E2-A, exact shape only
// ---------------------------------------------------------------------------

function sameShape(value: unknown, canonical: unknown): boolean {
  try {
    return JSON.stringify(value) === JSON.stringify(canonical);
  } catch {
    return false;
  }
}

function validAnchor(context: MappingSheetContext, anchor: InstitutionAnchor | null | undefined): boolean {
  if (!anchor || typeof anchor !== 'object') return false;
  const rebuilt = anchor.kind === 'cell'
    ? buildCellSelection(context.source, sheetOf(context), anchor.rowIndex, anchor.columnIndex, anchor.mergedRange)
    : anchor.kind === 'range'
      ? buildRangeSelection(
        context.source,
        sheetOf(context),
        { row: anchor.startRow, col: anchor.startColumn },
        { row: anchor.endRow, col: anchor.endColumn },
      )
      : null;
  const derived = rebuilt ? anchorFromSelection(context, rebuilt) : null;
  return !!derived && derived.ok && sameShape(anchor, derived.anchor);
}

function validNeed(context: MappingSheetContext, need: NeedSource | null | undefined): boolean {
  if (!need || typeof need !== 'object') return false;
  const rebuilt = need.kind === 'column'
    ? buildColumnSelection(context.source, sheetOf(context), need.columnIndex)
    : need.kind === 'range'
      ? buildRangeSelection(
        context.source,
        sheetOf(context),
        { row: need.startRow, col: need.startColumn },
        { row: need.endRow, col: need.endColumn },
      )
      : null;
  const derived = rebuilt ? needFromSelection(context, rebuilt) : null;
  return !!derived && derived.ok && sameShape(need, derived.need);
}

const isOrganizationId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.trim() === value;

export function isValidInstitutionMapping(
  context: MappingSheetContext,
  mapping: InstitutionMapping | null | undefined,
): mapping is InstitutionMapping {
  if (!isValidContext(context) || !mapping || typeof mapping !== 'object') return false;
  return typeof mapping.id === 'string' && mapping.id !== ''
    && validAnchor(context, mapping.anchor)
    && validNeed(context, mapping.need)
    && isOrganizationId(mapping.beneficiaryOrganizationId)
    && sameShape(Object.keys(mapping), ['id', 'anchor', 'need', 'beneficiaryOrganizationId']);
}

// ---------------------------------------------------------------------------
// Conflicts (deterministic, rule order fixed)
// ---------------------------------------------------------------------------

interface Area {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

function anchorArea(anchor: InstitutionAnchor): Area {
  return anchor.kind === 'cell'
    ? { startRow: anchor.rowIndex, endRow: anchor.rowIndex, startColumn: anchor.columnIndex, endColumn: anchor.columnIndex }
    : { startRow: anchor.startRow, endRow: anchor.endRow, startColumn: anchor.startColumn, endColumn: anchor.endColumn };
}

/** A whole column covers every row of it; a range covers exactly its rectangle. */
function needArea(need: NeedSource): Area {
  return need.kind === 'column'
    ? { startRow: 0, endRow: Number.POSITIVE_INFINITY, startColumn: need.columnIndex, endColumn: need.columnIndex }
    : { startRow: need.startRow, endRow: need.endRow, startColumn: need.startColumn, endColumn: need.endColumn };
}

const overlaps = (a: Area, b: Area): boolean =>
  a.startRow <= b.endRow && b.startRow <= a.endRow && a.startColumn <= b.endColumn && b.startColumn <= a.endColumn;

/** Whether a Need source's cells include any cell of a whole physical column. */
const coversColumn = (need: NeedSource, columnIndex: number | null): boolean =>
  columnIndex !== null && needArea(need).startColumn <= columnIndex && columnIndex <= needArea(need).endColumn;

/**
 * A name cell collides with a Need source only when the human marked that cell
 * as a quantity cell, i.e. inside an explicit Need RANGE. A whole Need column
 * is a physical column identity (like E2-B's roles) whose header rows may hold
 * name cells — its own or another entry's.
 */
const nameCellInNeedRange = (need: NeedSource, anchor: InstitutionAnchor): boolean =>
  need.kind === 'range' && overlaps(needArea(need), anchorArea(anchor));

const sameDeclaration = (a: InstitutionMapping, b: InstitutionMapping): boolean =>
  a.beneficiaryOrganizationId === b.beneficiaryOrganizationId && sameShape(a.anchor, b.anchor) && sameShape(a.need, b.need);

export interface MappingCheckInput {
  context: MappingSheetContext;
  /** E2-B's profile for the same source + sheet; its roles are read, never written. */
  profile: SheetMappingProfile | null;
  /** Ids of the active care institutions the screen loaded — the only acceptable beneficiaries. */
  eligibleBeneficiaryIds: readonly string[];
}

/**
 * Every problem with `candidate` against the draft's other entries, in a fixed
 * order: shape → eligibility → E2-B identity → Need covering an E2-B role
 * column → its own name cell inside its own Need range → then, rule by rule and
 * entry by entry: exact duplicate, Need overlap, a name cell shared with a
 * DIFFERENT beneficiary, name cell inside another's Need range, Need range
 * covering another's name cell. An entry never conflicts with itself, so an
 * edit is checked against the others only.
 *
 * There is deliberately no "one entry per beneficiary" rule: the same
 * beneficiary may hold several independent, non-overlapping Need sources.
 */
export function institutionMappingProblems(
  input: MappingCheckInput,
  candidate: InstitutionMapping,
  entries: readonly InstitutionMapping[],
): InstitutionProblem[] {
  const { context, profile, eligibleBeneficiaryIds } = input;
  if (!isValidContext(context)) return [{ reason: 'INVALID_CONTEXT' }];
  if (!isValidInstitutionMapping(context, candidate)) return [{ reason: 'INVALID_MAPPING' }];

  const problems: InstitutionProblem[] = [];
  if (!eligibleBeneficiaryIds.includes(candidate.beneficiaryOrganizationId)) problems.push({ reason: 'BENEFICIARY_NOT_ELIGIBLE' });
  if (!isValidProfile(profile) || !sameProfileIdentity(profile, context)) {
    problems.push({ reason: 'PROFILE_MISMATCH' });
  } else {
    if (coversColumn(candidate.need, roleColumn(profile, 'national_code'))) problems.push({ reason: 'NEED_IS_NATIONAL_CODE_COLUMN' });
    if (coversColumn(candidate.need, roleColumn(profile, 'material'))) problems.push({ reason: 'NEED_IS_MATERIAL_COLUMN' });
  }

  if (nameCellInNeedRange(candidate.need, candidate.anchor)) problems.push({ reason: 'ANCHOR_IN_OWN_NEED' });

  const nameCell = anchorArea(candidate.anchor);
  const needCells = needArea(candidate.need);
  const others = entries.filter((e) => e.id !== candidate.id && isValidInstitutionMapping(context, e));
  const rules: Array<[InstitutionMappingFailure, (other: InstitutionMapping) => boolean]> = [
    ['DUPLICATE_MAPPING', (o) => sameDeclaration(o, candidate)],
    ['NEED_OVERLAP', (o) => overlaps(needArea(o.need), needCells)],
    // One name cell may label several entries of the SAME beneficiary (e.g. a merged header over two Need
    // columns); naming two different beneficiaries with one cell is ambiguous.
    ['ANCHOR_OVERLAP', (o) => o.beneficiaryOrganizationId !== candidate.beneficiaryOrganizationId && overlaps(anchorArea(o.anchor), nameCell)],
    ['ANCHOR_IN_NEED', (o) => nameCellInNeedRange(o.need, candidate.anchor)],
    ['NEED_COVERS_ANCHOR', (o) => nameCellInNeedRange(candidate.need, o.anchor)],
  ];
  for (const [reason, conflicts] of rules) {
    for (const other of others) if (conflicts(other)) problems.push({ reason, conflictId: other.id });
  }
  return problems;
}

/** The first problem, or null when `candidate` may join the draft. */
export function checkInstitutionMapping(
  input: MappingCheckInput,
  candidate: InstitutionMapping,
  entries: readonly InstitutionMapping[],
): InstitutionProblem | null {
  return institutionMappingProblems(input, candidate, entries)[0] ?? null;
}

/** Every entry with its current problems (none = valid), in draft order — for the list the human reads. */
export function evaluateInstitutionMappings(
  input: MappingCheckInput,
  entries: readonly InstitutionMapping[],
): Array<{ id: string; problems: InstitutionProblem[] }> {
  return entries.map((entry) => ({ id: entry.id, problems: institutionMappingProblems(input, entry, entries) }));
}

// ---------------------------------------------------------------------------
// Transition contract (pure reducer)
// ---------------------------------------------------------------------------

export interface InstitutionMappingDraft {
  /** The entry being edited, or null while adding a new one. */
  editingId: string | null;
  anchor: InstitutionAnchor | null;
  need: NeedSource | null;
  beneficiaryOrganizationId: string | null;
}

export type InstitutionStep = 'anchor' | 'need' | 'commit' | 'edit' | 'remove';

export type InstitutionOutcome =
  | { kind: 'anchor_set'; anchor: InstitutionAnchor }
  | { kind: 'need_set'; need: NeedSource }
  | { kind: 'added'; id: string; beneficiaryOrganizationId: string }
  | { kind: 'updated'; id: string; beneficiaryOrganizationId: string }
  | { kind: 'removed'; beneficiaryOrganizationId: string }
  | { kind: 'editing'; id: string; beneficiaryOrganizationId: string }
  | { kind: 'draft_cleared' }
  | { kind: 'reset'; removed: number }
  | { kind: 'refused'; step: InstitutionStep; reason: InstitutionMappingFailure; conflictId?: string };

export interface InstitutionMappingState {
  /** The last selection the trusted source viewer reported (canonical copy), or null. */
  selection: WorkbookSelection | null;
  /** The source + sheet every entry belongs to; null without a trusted context. */
  context: MappingSheetContext | null;
  mappings: readonly InstitutionMapping[];
  draft: InstitutionMappingDraft;
  /** Number of the next entry key; keys are never reused within a context. */
  nextKey: number;
  /** An explicit reset was requested and awaits confirmation. */
  resetPending: boolean;
  outcome: InstitutionOutcome | null;
  /** Bumped with every outcome, so a repeated message is announced again. */
  outcomeSeq: number;
}

export type InstitutionMappingAction =
  | { type: 'selection_changed'; selection: WorkbookSelection | null }
  | { type: 'capture_anchor' }
  | { type: 'capture_need' }
  | { type: 'choose_beneficiary'; beneficiaryOrganizationId: string | null }
  | { type: 'commit'; profile: SheetMappingProfile | null; eligibleBeneficiaryIds: readonly string[] }
  | { type: 'edit'; id: string }
  | { type: 'cancel_edit' }
  | { type: 'remove'; id: string }
  | { type: 'request_reset' }
  | { type: 'cancel_reset' }
  | { type: 'confirm_reset' };

export const EMPTY_INSTITUTION_DRAFT: InstitutionMappingDraft = Object.freeze({
  editingId: null,
  anchor: null,
  need: null,
  beneficiaryOrganizationId: null,
}) as InstitutionMappingDraft;

export const INITIAL_INSTITUTION_MAPPING_STATE: InstitutionMappingState = Object.freeze({
  selection: null,
  context: null,
  mappings: Object.freeze([]) as readonly InstitutionMapping[],
  draft: EMPTY_INSTITUTION_DRAFT,
  nextKey: 1,
  resetPending: false,
  outcome: null,
  outcomeSeq: 0,
}) as InstitutionMappingState;

const draftIsEmpty = (draft: InstitutionMappingDraft): boolean =>
  draft.editingId === null && draft.anchor === null && draft.need === null && draft.beneficiaryOrganizationId === null;

function withOutcome(state: InstitutionMappingState, outcome: InstitutionOutcome, patch: Partial<InstitutionMappingState> = {}): InstitutionMappingState {
  return { ...state, ...patch, outcome, outcomeSeq: state.outcomeSeq + 1 };
}

/**
 * The entry the draft would commit — a new key when adding, the edited entry's
 * key when editing — or why there is none yet. Shared by `commit` and by the
 * panel's pre-check, so both judge the same candidate.
 */
export function draftCandidate(
  state: InstitutionMappingState,
): { ok: true; candidate: InstitutionMapping } | { ok: false; reason: InstitutionMappingFailure } {
  if (!state.context) return { ok: false, reason: 'NO_TRUSTED_SELECTION' };
  const { draft } = state;
  if (draft.anchor === null || draft.need === null || draft.beneficiaryOrganizationId === null) {
    return { ok: false, reason: 'INCOMPLETE_MAPPING' };
  }
  const editingId = draft.editingId;
  if (editingId !== null && !state.mappings.some((m) => m.id === editingId)) return { ok: false, reason: 'UNKNOWN_MAPPING' };
  return {
    ok: true,
    candidate: {
      id: editingId ?? `im-${state.nextKey}`,
      anchor: draft.anchor,
      need: draft.need,
      beneficiaryOrganizationId: draft.beneficiaryOrganizationId,
    },
  };
}

function refuse(state: InstitutionMappingState, step: InstitutionStep, problem: InstitutionProblem): InstitutionMappingState {
  const outcome: InstitutionOutcome = problem.conflictId === undefined
    ? { kind: 'refused', step, reason: problem.reason }
    : { kind: 'refused', step, reason: problem.reason, conflictId: problem.conflictId };
  return withOutcome(state, outcome);
}

/**
 * - `selection_changed` follows E2-B exactly: null or a malformed selection
 *   (sheet switch, another workbook or batch, close, lost identity, unmount)
 *   discards every entry and the draft, so returning later starts empty; a
 *   selection in the same source + sheet keeps them; another source or sheet
 *   starts a new, empty draft.
 * - `capture_anchor` / `capture_need` use ONLY the selection held here — the
 *   caller passes no coordinate.
 * - `commit` adds the draft (or replaces the entry being edited) only when it
 *   is complete and `checkInstitutionMapping` finds no problem; a refusal
 *   leaves every entry and the draft untouched.
 * - `confirm_reset` acts only after `request_reset`, and clears the E2-C
 *   entries and draft only: E2-B's roles are not part of this state.
 */
export function institutionMappingReducer(state: InstitutionMappingState, action: InstitutionMappingAction): InstitutionMappingState {
  switch (action.type) {
    case 'selection_changed': {
      const trusted = action.selection === null ? null : canonicalSelection(action.selection);
      if (!trusted) return state === INITIAL_INSTITUTION_MAPPING_STATE ? state : INITIAL_INSTITUTION_MAPPING_STATE;
      if (state.context && state.selection && selectionKey(state.selection) === selectionKey(trusted)) return state;
      const context = contextOf(trusted) as MappingSheetContext;
      if (state.context && sameProfileIdentity(state.context, context)) {
        return { ...state, selection: trusted, outcome: null };
      }
      return { ...INITIAL_INSTITUTION_MAPPING_STATE, selection: trusted, context };
    }
    case 'capture_anchor':
    case 'capture_need': {
      const step: InstitutionStep = action.type === 'capture_anchor' ? 'anchor' : 'need';
      if (!state.context || !state.selection) return refuse(state, step, { reason: 'NO_TRUSTED_SELECTION' });
      if (action.type === 'capture_anchor') {
        const result = anchorFromSelection(state.context, state.selection);
        if (!result.ok) return refuse(state, step, { reason: result.reason });
        return withOutcome(state, { kind: 'anchor_set', anchor: result.anchor }, { draft: { ...state.draft, anchor: result.anchor } });
      }
      const result = needFromSelection(state.context, state.selection);
      if (!result.ok) return refuse(state, step, { reason: result.reason });
      return withOutcome(state, { kind: 'need_set', need: result.need }, { draft: { ...state.draft, need: result.need } });
    }
    case 'choose_beneficiary': {
      if (!state.context) return state;
      const picked = action.beneficiaryOrganizationId;
      const chosen = typeof picked === 'string' && picked !== '' ? picked : null;
      if (chosen === state.draft.beneficiaryOrganizationId) return state;
      return { ...state, draft: { ...state.draft, beneficiaryOrganizationId: chosen }, outcome: null };
    }
    case 'commit': {
      const drafted = draftCandidate(state);
      if (!drafted.ok || !state.context) return refuse(state, 'commit', { reason: drafted.ok ? 'NO_TRUSTED_SELECTION' : drafted.reason });
      const { candidate } = drafted;
      const editingId = state.draft.editingId;
      const problem = checkInstitutionMapping(
        { context: state.context, profile: action.profile, eligibleBeneficiaryIds: action.eligibleBeneficiaryIds },
        candidate,
        state.mappings,
      );
      if (problem) return refuse(state, 'commit', problem);
      const mappings = editingId === null
        ? [...state.mappings, candidate]
        : state.mappings.map((m) => (m.id === editingId ? candidate : m));
      const done = { id: candidate.id, beneficiaryOrganizationId: candidate.beneficiaryOrganizationId };
      return withOutcome(state, editingId === null ? { kind: 'added', ...done } : { kind: 'updated', ...done }, {
        mappings,
        draft: EMPTY_INSTITUTION_DRAFT,
        nextKey: editingId === null ? state.nextKey + 1 : state.nextKey,
        resetPending: false,
      });
    }
    case 'edit': {
      const entry = state.mappings.find((m) => m.id === action.id);
      if (!entry) return refuse(state, 'edit', { reason: 'UNKNOWN_MAPPING' });
      return withOutcome(state, { kind: 'editing', id: entry.id, beneficiaryOrganizationId: entry.beneficiaryOrganizationId }, {
        draft: { editingId: entry.id, anchor: entry.anchor, need: entry.need, beneficiaryOrganizationId: entry.beneficiaryOrganizationId },
        resetPending: false,
      });
    }
    case 'cancel_edit': {
      if (draftIsEmpty(state.draft)) return state;
      return withOutcome(state, { kind: 'draft_cleared' }, { draft: EMPTY_INSTITUTION_DRAFT });
    }
    case 'remove': {
      const entry = state.mappings.find((m) => m.id === action.id);
      if (!entry) return refuse(state, 'remove', { reason: 'UNKNOWN_MAPPING' });
      const mappings = state.mappings.filter((m) => m.id !== action.id);
      return withOutcome(state, { kind: 'removed', beneficiaryOrganizationId: entry.beneficiaryOrganizationId }, {
        mappings,
        draft: state.draft.editingId === action.id ? EMPTY_INSTITUTION_DRAFT : state.draft,
        resetPending: state.resetPending && mappings.length > 0,
      });
    }
    case 'request_reset': {
      if (!state.context || state.mappings.length === 0 || state.resetPending) return state;
      return { ...state, resetPending: true, outcome: null };
    }
    case 'cancel_reset': {
      return state.resetPending ? { ...state, resetPending: false } : state;
    }
    case 'confirm_reset': {
      if (!state.resetPending) return state;
      return withOutcome(state, { kind: 'reset', removed: state.mappings.length }, {
        mappings: [],
        draft: EMPTY_INSTITUTION_DRAFT,
        resetPending: false,
      });
    }
    default:
      return state;
  }
}
