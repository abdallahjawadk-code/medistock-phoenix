/**
 * E2-D.1 — the Mapping Approval Gate, pure.
 *
 * Validation reuses E2-B/E2-C truth and names it as approval blockers; the
 * canonical evidence is deterministic and free of transient state; the
 * fingerprint is a real SHA-256 (Web Crypto) that fails closed; the local
 * approval is valid only for the exact fingerprint it was given for.
 * States are built with the REAL E2-B and E2-C reducers.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCellSelection,
  buildColumnSelection,
  buildRangeSelection,
  type WorkbookSelection,
  type WorkbookSourceIdentity,
} from '../../excel-first/workbookSelection';
import {
  INITIAL_INSTITUTION_MAPPING_STATE,
  evaluateInstitutionMappings,
  institutionMappingReducer,
  type InstitutionMapping,
  type InstitutionMappingAction,
  type InstitutionMappingState,
} from '../institutionMapping';
import {
  INITIAL_LOCAL_APPROVAL,
  MAPPING_APPROVAL_BLOCKERS,
  MAPPING_APPROVAL_SCHEMA_VERSION,
  buildMappingApprovalEvidence,
  canonicalEvidenceJson,
  fingerprintCanonicalEvidence,
  isLocallyApproved,
  isSha256Hex,
  localApprovalReducer,
  mappingApprovalChecklist,
  mappingApprovalStatus,
  validateMappingForApproval,
  type MappingApprovalInput,
} from '../mappingApprovalGate';
import {
  INITIAL_SHEET_MAPPING_STATE,
  sheetMappingReducer,
  type SheetMappingAction,
  type SheetMappingState,
} from '../sheetMappingProfile';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SOURCE: WorkbookSourceIdentity = {
  batchId: 'batch-1', entryId: 'entry-1', entryOrdinal: 1, entrySha256: 'a'.repeat(64),
  importSessionId: 'session-1', workbookIndex: 0,
};
const SHEET = { sheetIndex: 0, sheetName: 'الاحتياج' };
const OTHER_SHEET = { sheetIndex: 1, sheetName: 'Other' };
const ELIGIBLE = ['org-c', 'org-a', 'org-b'];

const column = (col: number, source = SOURCE, sheet = SHEET) => buildColumnSelection(source, sheet, col) as WorkbookSelection;
const cell = (row: number, col: number, merged: string | null = null, sheet = SHEET) => buildCellSelection(SOURCE, sheet, row, col, merged) as WorkbookSelection;
const range = (r0: number, c0: number, r1: number, c1: number) => buildRangeSelection(SOURCE, SHEET, { row: r0, col: c0 }, { row: r1, col: c1 }) as WorkbookSelection;

const sheetRun = (s: SheetMappingState, ...a: SheetMappingAction[]) => a.reduce(sheetMappingReducer, s);
const instRun = (s: InstitutionMappingState, ...a: InstitutionMappingAction[]) => a.reduce(institutionMappingReducer, s);

/** Both drafts, fed the same selections exactly as `useWorkbookMapping` feeds them. */
interface Drafts { sheet: SheetMappingState; inst: InstitutionMappingState }
function observe(d: Drafts, selection: WorkbookSelection | null): Drafts {
  return {
    sheet: sheetMappingReducer(d.sheet, { type: 'selection_changed', selection }),
    inst: institutionMappingReducer(d.inst, { type: 'selection_changed', selection }),
  };
}
function assignRole(d: Drafts, col: number, role: 'national_code' | 'material'): Drafts {
  const seen = observe(d, column(col));
  return { ...seen, sheet: sheetRun(seen.sheet, { type: 'assign', role }) };
}
function mapInstitution(d: Drafts, anchor: WorkbookSelection, need: WorkbookSelection, org: string, eligible = ELIGIBLE): Drafts {
  let next = observe(d, anchor);
  next = { ...next, inst: instRun(next.inst, { type: 'capture_anchor' }) };
  next = observe(next, need);
  next = {
    ...next,
    inst: instRun(
      next.inst,
      { type: 'capture_need' },
      { type: 'choose_beneficiary', beneficiaryOrganizationId: org },
      { type: 'commit', profile: next.sheet.profile, eligibleBeneficiaryIds: eligible },
    ),
  };
  return next;
}

const EMPTY: Drafts = { sheet: INITIAL_SHEET_MAPPING_STATE, inst: INITIAL_INSTITUTION_MAPPING_STATE };
/** National Code = A, Material = B; Al Amal at C1 over column C; Al Noor at E1 over E2:G10. */
function readyDrafts(): Drafts {
  let d = assignRole(EMPTY, 0, 'national_code');
  d = assignRole(d, 1, 'material');
  d = mapInstitution(d, cell(0, 2, 'C1:D1'), column(2), 'org-a');
  d = mapInstitution(d, cell(0, 4), range(1, 4, 9, 6), 'org-b');
  return d;
}
const input = (d: Drafts, over: Partial<MappingApprovalInput> = {}): MappingApprovalInput => ({
  planRevisionId: 'rev-1', sheet: d.sheet, institutions: d.inst, eligibleBeneficiaryIds: ELIGIBLE, ...over,
});
const blockersOf = (d: Drafts, over: Partial<MappingApprovalInput> = {}) => validateMappingForApproval(input(d, over)).blockers;
const jsonOf = (d: Drafts, over: Partial<MappingApprovalInput> = {}) => {
  const i = input(d, over);
  return canonicalEvidenceJson(buildMappingApprovalEvidence(i, validateMappingForApproval(i)));
};

describe('E2-D.1 — validation reuses E2-B/E2-C truth and fails closed', () => {
  it('the fixture is really ready: two committed mappings, both roles, nothing pending', () => {
    const d = readyDrafts();
    expect(d.inst.mappings).toHaveLength(2);
    expect(validateMappingForApproval(input(d))).toEqual({ ready: true, blockers: [] });
  });

  it('no trusted context → NO_TRUSTED_MAPPING_CONTEXT', () => {
    expect(blockersOf(EMPTY)).toEqual(['NO_TRUSTED_MAPPING_CONTEXT']);
    // Losing the context (sheet switch → null) blocks a previously complete mapping.
    expect(blockersOf(observe(readyDrafts(), null))).toEqual(['NO_TRUSTED_MAPPING_CONTEXT']);
  });

  it('National Code or Material missing → NATIONAL_CODE_NOT_MAPPED / MATERIAL_NOT_MAPPED', () => {
    const d = readyDrafts();
    expect(blockersOf({ ...d, sheet: sheetRun(d.sheet, { type: 'clear', role: 'material' }) })).toEqual(['MATERIAL_NOT_MAPPED']);
    expect(blockersOf({ ...d, sheet: sheetRun(d.sheet, { type: 'clear', role: 'national_code' }) })).toEqual(['NATIONAL_CODE_NOT_MAPPED']);
    expect(blockersOf({ ...d, sheet: sheetRun(d.sheet, { type: 'reset' }) })).toEqual(['NATIONAL_CODE_NOT_MAPPED', 'MATERIAL_NOT_MAPPED']);
  });

  it('an invalid E2-B profile (roles on one column — impossible through E2-B, so hand-made) → INVALID_SHEET_PROFILE + ROLE_COLUMNS_NOT_DISTINCT', () => {
    const d = readyDrafts();
    const profile = { ...d.sheet.profile!, nationalCodeColumn: { columnIndex: 1 }, materialColumn: { columnIndex: 1 } };
    expect(blockersOf({ ...d, sheet: { ...d.sheet, profile } })).toEqual(['INVALID_SHEET_PROFILE', 'ROLE_COLUMNS_NOT_DISTINCT']);
  });

  it('E2-B profile and E2-C context on different sheets → PROFILE_CONTEXT_MISMATCH', () => {
    const d = readyDrafts();
    const profile = { ...d.sheet.profile!, sheetIndex: OTHER_SHEET.sheetIndex, sheetName: OTHER_SHEET.sheetName };
    expect(blockersOf({ ...d, sheet: { ...d.sheet, profile } })).toEqual(['PROFILE_CONTEXT_MISMATCH']);
  });

  it('zero committed institution mappings → NO_INSTITUTION_MAPPINGS', () => {
    let d = assignRole(EMPTY, 0, 'national_code');
    d = assignRole(d, 1, 'material');
    expect(blockersOf(d)).toEqual(['NO_INSTITUTION_MAPPINGS']);
  });

  it('a mapped beneficiary that left the CURRENT eligible list → BENEFICIARY_NOT_ELIGIBLE', () => {
    expect(blockersOf(readyDrafts(), { eligibleBeneficiaryIds: ['org-a', 'org-c'] })).toEqual(['BENEFICIARY_NOT_ELIGIBLE']);
    expect(blockersOf(readyDrafts(), { eligibleBeneficiaryIds: [] })).toEqual(['BENEFICIARY_NOT_ELIGIBLE']);
  });

  it('an E2-C conflict → INSTITUTION_MAPPING_CONFLICT, exactly when E2-C itself reports one', () => {
    const d = readyDrafts();
    // E2-B later puts Material on Al Amal's Need column C.
    const moved = observe(d, column(2));
    const conflicted = { ...moved, sheet: sheetRun(moved.sheet, { type: 'clear', role: 'material' }, { type: 'assign', role: 'material' }) };
    expect(blockersOf(conflicted)).toEqual(['INSTITUTION_MAPPING_CONFLICT']);
    // Hand-made overlapping entries (E2-C refuses to commit them) are reported through E2-C's own verdict.
    const [a] = d.inst.mappings;
    const overlapping: InstitutionMapping = { ...a, id: 'im-9', beneficiaryOrganizationId: 'org-c', anchor: { kind: 'cell', rowIndex: 30, columnIndex: 9, mergedRange: null } };
    const withOverlap = { ...d, inst: { ...d.inst, mappings: [...d.inst.mappings, overlapping] } };
    expect(blockersOf(withOverlap)).toEqual(['INSTITUTION_MAPPING_CONFLICT']);
    // The blocker follows E2-C's truth, entry by entry.
    for (const state of [d, conflicted, withOverlap]) {
      const e2c = evaluateInstitutionMappings(
        { context: state.inst.context!, profile: state.sheet.profile, eligibleBeneficiaryIds: ELIGIBLE }, state.inst.mappings,
      ).some((s) => s.problems.some((p) => !['BENEFICIARY_NOT_ELIGIBLE', 'PROFILE_MISMATCH', 'INVALID_MAPPING', 'INVALID_CONTEXT'].includes(p.reason)));
      expect(blockersOf(state).includes('INSTITUTION_MAPPING_CONFLICT')).toBe(e2c);
    }
  });

  it('a structurally invalid entry or duplicate entry key (hand-made) → INVALID_INSTITUTION_MAPPING', () => {
    const d = readyDrafts();
    const [a, b] = d.inst.mappings;
    const reversed = { ...b, need: { kind: 'range' as const, startRow: 9, endRow: 1, startColumn: 4, endColumn: 6 } };
    expect(blockersOf({ ...d, inst: { ...d.inst, mappings: [a, reversed] } })).toEqual(['INVALID_INSTITUTION_MAPPING']);
    expect(blockersOf({ ...d, inst: { ...d.inst, mappings: [a, { ...b, id: a.id }] } })).toContain('INVALID_INSTITUTION_MAPPING');
  });

  it('any uncommitted E2-C draft — add in progress, edit started, a chosen beneficiary — → UNCOMMITTED_MAPPING_DRAFT', () => {
    const d = readyDrafts();
    const adding = observe(d, cell(20, 8));
    expect(blockersOf({ ...adding, inst: instRun(adding.inst, { type: 'capture_anchor' }) })).toEqual(['UNCOMMITTED_MAPPING_DRAFT']);
    expect(blockersOf({ ...d, inst: instRun(d.inst, { type: 'edit', id: 'im-1' }) })).toEqual(['UNCOMMITTED_MAPPING_DRAFT']);
    expect(blockersOf({ ...d, inst: instRun(d.inst, { type: 'choose_beneficiary', beneficiaryOrganizationId: 'org-c' }) })).toEqual(['UNCOMMITTED_MAPPING_DRAFT']);
  });

  it('a pending E2-C reset → RESET_PENDING', () => {
    const d = readyDrafts();
    expect(blockersOf({ ...d, inst: instRun(d.inst, { type: 'request_reset' }) })).toEqual(['RESET_PENDING']);
  });

  it.each([['null', null], ['undefined', undefined], ['empty', ''], ['padded', ' rev-1']])('a %s revision id → INVALID_REVISION_ID', (_l, id) => {
    expect(blockersOf(readyDrafts(), { planRevisionId: id as never })).toEqual(['INVALID_REVISION_ID']);
  });

  it('blockers are cumulative and always in the same fixed order', () => {
    const d = readyDrafts();
    const messy = { ...d, sheet: sheetRun(d.sheet, { type: 'clear', role: 'material' }), inst: instRun(d.inst, { type: 'request_reset' }) };
    const first = blockersOf(messy, { planRevisionId: '', eligibleBeneficiaryIds: ['org-a'] });
    expect(first).toEqual(['INVALID_REVISION_ID', 'MATERIAL_NOT_MAPPED', 'BENEFICIARY_NOT_ELIGIBLE', 'RESET_PENDING']);
    expect(first).toEqual(MAPPING_APPROVAL_BLOCKERS.filter((b) => first.includes(b)));
    for (let i = 0; i < 3; i += 1) expect(blockersOf(messy, { planRevisionId: '', eligibleBeneficiaryIds: ['org-a'] })).toEqual(first);
  });

  it('moving the selection inside the same trusted sheet is not a readiness input', () => {
    const d = readyDrafts();
    for (const selection of [cell(40, 9), range(3, 3, 5, 5), column(7)]) {
      expect(validateMappingForApproval(input(observe(d, selection)))).toEqual({ ready: true, blockers: [] });
    }
  });

  it('the checklist mirrors the blockers', () => {
    expect(mappingApprovalChecklist({ ready: true, blockers: [] }).every((c) => c.met)).toBe(true);
    const list = mappingApprovalChecklist(validateMappingForApproval(input(readyDrafts(), { eligibleBeneficiaryIds: ['org-a'] })));
    expect(list.filter((c) => !c.met).map((c) => c.check)).toEqual(['institutions']);
    expect(mappingApprovalChecklist(validateMappingForApproval(input(EMPTY))).filter((c) => c.met).map((c) => c.check))
      .toEqual(['revision', 'noUnsavedEdit']);
  });
});

describe('E2-D.2 — canonical evidence is deterministic and semantic only', () => {
  it('has the e2d-mapping-approval-v1 shape, with keys sorted at every level', () => {
    const evidence = JSON.parse(jsonOf(readyDrafts()));
    expect(evidence.schemaVersion).toBe(MAPPING_APPROVAL_SCHEMA_VERSION);
    expect(Object.keys(evidence)).toEqual(['eligibilityBasis', 'institutionMappings', 'planRevisionId', 'schemaVersion', 'sheet', 'sheetMapping', 'source', 'validation']);
    expect(evidence.source).toEqual({ batchId: 'batch-1', entryId: 'entry-1', entryOrdinal: 1, entrySha256: 'a'.repeat(64), importSessionId: 'session-1', workbookIndex: 0 });
    expect(evidence.sheet).toEqual({ sheetIndex: 0, sheetName: 'الاحتياج' });
    expect(evidence.sheetMapping).toEqual({ materialColumn: 1, nationalCodeColumn: 0 });
    expect(evidence.institutionMappings).toEqual([
      { anchor: { columnIndex: 2, kind: 'cell', mergedRange: 'C1:D1', rowIndex: 0 }, beneficiaryOrganizationId: 'org-a', id: 'im-1', need: { columnIndex: 2, kind: 'column' } },
      { anchor: { columnIndex: 4, kind: 'cell', mergedRange: null, rowIndex: 0 }, beneficiaryOrganizationId: 'org-b', id: 'im-2', need: { endColumn: 6, endRow: 9, kind: 'range', startColumn: 4, startRow: 1 } },
    ]);
    expect(evidence.eligibilityBasis).toEqual({ eligibleBeneficiaryIds: ['org-a', 'org-b', 'org-c'] });
    expect(evidence.validation).toEqual({ blockers: [], ready: true });
    const sortedEverywhere = (v: unknown): boolean => Array.isArray(v) ? v.every(sortedEverywhere)
      : v !== null && typeof v === 'object' ? Object.keys(v).join() === Object.keys(v).sort().join() && Object.values(v).every(sortedEverywhere) : true;
    expect(sortedEverywhere(evidence)).toBe(true);
  });

  it('identical semantic input → byte-identical canonical JSON (built twice, independently)', () => {
    expect(jsonOf(readyDrafts())).toBe(jsonOf(readyDrafts()));
  });

  it('eligible-id order and duplicates do not change it', () => {
    const d = readyDrafts();
    expect(jsonOf(d, { eligibleBeneficiaryIds: ['org-b', 'org-a', 'org-c', 'org-a'] })).toBe(jsonOf(d, { eligibleBeneficiaryIds: ['org-a', 'org-b', 'org-c'] }));
  });

  it('selection moves, outcomes and outcome counters do not change it', () => {
    const d = readyDrafts();
    const base = jsonOf(d);
    expect(jsonOf(observe(d, cell(40, 9)))).toBe(base);
    const refused = { ...d, inst: instRun(d.inst, { type: 'remove', id: 'im-404' }, { type: 'edit', id: 'im-404' }) };
    expect(refused.inst.outcome?.kind).toBe('refused');
    expect(refused.inst.outcomeSeq).not.toBe(d.inst.outcomeSeq);
    expect(jsonOf(refused)).toBe(base);
    const text = jsonOf(d);
    expect(text).not.toMatch(/"selection"|"outcome"|"outcomeSeq"|"lang"|"name"|"name_ar"|"code"|"resetPending"|"nextKey"/);
  });

  it('every semantic change changes it', () => {
    const d = readyDrafts();
    const base = jsonOf(d);
    const variants: Array<[string, string]> = [
      ['revision', jsonOf(d, { planRevisionId: 'rev-2' })],
      ['eligible set', jsonOf(d, { eligibleBeneficiaryIds: ['org-a', 'org-b'] })],
      ['role column', (() => { const m = observe(d, column(3)); return jsonOf({ ...m, sheet: sheetRun(m.sheet, { type: 'assign', role: 'material' }) }); })()],
      ['mapping removed', jsonOf({ ...d, inst: instRun(d.inst, { type: 'remove', id: 'im-2' }) })],
      ['mapping added', jsonOf(mapInstitution(d, cell(0, 8), column(8), 'org-c'))],
      ['Need rectangle', jsonOf({ ...d, inst: { ...d.inst, mappings: [d.inst.mappings[0], { ...d.inst.mappings[1], need: { kind: 'range', startRow: 1, endRow: 9, startColumn: 4, endColumn: 7 } }] } })],
      ['beneficiary', jsonOf({ ...d, inst: { ...d.inst, mappings: [{ ...d.inst.mappings[0], beneficiaryOrganizationId: 'org-c' }, d.inst.mappings[1]] } })],
      ['anchor', jsonOf({ ...d, inst: { ...d.inst, mappings: [{ ...d.inst.mappings[0], anchor: { kind: 'cell', rowIndex: 1, columnIndex: 2, mergedRange: null } }, d.inst.mappings[1]] } })],
      ['source identity', jsonOf({ ...d, sheet: { ...d.sheet, profile: { ...d.sheet.profile!, source: { ...SOURCE, batchId: 'batch-2' } } }, inst: { ...d.inst, context: { ...d.inst.context!, source: { ...SOURCE, batchId: 'batch-2' } } } })],
      ['sheet identity', jsonOf(observe(d, cell(0, 0, null, OTHER_SHEET)))],
      ['readiness (draft)', jsonOf({ ...d, inst: instRun(d.inst, { type: 'edit', id: 'im-1' }) })],
    ];
    for (const [label, json] of variants) expect(json, label).not.toBe(base);
    expect(new Set(variants.map(([, j]) => j)).size).toBe(variants.length);
  });
});

describe('E2-D.3 — SHA-256 fingerprint (Web Crypto, fail closed)', () => {
  it('is the real SHA-256 of the UTF-8 bytes, lower-case 64-hex', async () => {
    expect(await fingerprintCanonicalEvidence('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const json = jsonOf(readyDrafts());
    const fp = await fingerprintCanonicalEvidence(json);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).toBe(createHash('sha256').update(Buffer.from(json, 'utf8')).digest('hex'));
  });

  it('same canonical JSON → same fingerprint; a semantic change → a different one', async () => {
    const d = readyDrafts();
    expect(await fingerprintCanonicalEvidence(jsonOf(d))).toBe(await fingerprintCanonicalEvidence(jsonOf(readyDrafts())));
    expect(await fingerprintCanonicalEvidence(jsonOf(d, { planRevisionId: 'rev-2' }))).not.toBe(await fingerprintCanonicalEvidence(jsonOf(d)));
  });

  it('without Web Crypto there is no fingerprint — it rejects, it never falls back', async () => {
    vi.stubGlobal('crypto', {});
    await expect(fingerprintCanonicalEvidence('abc')).rejects.toThrow('fingerprint_unavailable');
    vi.stubGlobal('crypto', undefined);
    await expect(fingerprintCanonicalEvidence('abc')).rejects.toThrow('fingerprint_unavailable');
  });

  it('a failing digest rejects too', async () => {
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValue(new Error('boom'));
    await expect(fingerprintCanonicalEvidence('abc')).rejects.toThrow();
  });

  it('isSha256Hex accepts only lower-case 64-hex', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`, null, 42]) expect(isSha256Hex(bad)).toBe(false);
  });
});

describe('E2-D.4 — local approval is bound to one fingerprint', () => {
  const READY = { ready: true, blockers: [] };
  const FP = 'b'.repeat(64);

  it('READY + explicit approve with the current fingerprint → approved locally', () => {
    const approved = localApprovalReducer(INITIAL_LOCAL_APPROVAL, { type: 'approve', fingerprint: FP });
    expect(approved).toEqual({ approvedFingerprint: FP, stale: false });
    expect(isLocallyApproved(READY, FP, approved)).toBe(true);
    expect(mappingApprovalStatus(READY, { value: FP, unavailable: false }, approved)).toBe('approved');
  });

  it('an approval never covers another fingerprint, a non-ready mapping, or a missing fingerprint', () => {
    const approved = localApprovalReducer(INITIAL_LOCAL_APPROVAL, { type: 'approve', fingerprint: FP });
    expect(isLocallyApproved(READY, 'c'.repeat(64), approved)).toBe(false);
    expect(isLocallyApproved({ ready: false, blockers: ['RESET_PENDING'] }, FP, approved)).toBe(false);
    expect(isLocallyApproved(READY, null, approved)).toBe(false);
  });

  it('an invalid fingerprint cannot be approved; revoking marks the approval stale until given again', () => {
    expect(localApprovalReducer(INITIAL_LOCAL_APPROVAL, { type: 'approve', fingerprint: 'not-a-hash' })).toBe(INITIAL_LOCAL_APPROVAL);
    const approved = localApprovalReducer(INITIAL_LOCAL_APPROVAL, { type: 'approve', fingerprint: FP });
    const revoked = localApprovalReducer(approved, { type: 'revoke' });
    expect(revoked).toEqual({ approvedFingerprint: null, stale: true });
    expect(isLocallyApproved(READY, FP, revoked)).toBe(false);
    expect(localApprovalReducer(revoked, { type: 'approve', fingerprint: FP })).toEqual({ approvedFingerprint: FP, stale: false });
  });

  it('status: blocked, fingerprinting, unavailable, ready — never approved without the approval', () => {
    const none = INITIAL_LOCAL_APPROVAL;
    expect(mappingApprovalStatus({ ready: false, blockers: ['NO_INSTITUTION_MAPPINGS'] }, { value: FP, unavailable: false }, none)).toBe('blocked');
    expect(mappingApprovalStatus(READY, { value: null, unavailable: false }, none)).toBe('fingerprinting');
    expect(mappingApprovalStatus(READY, { value: null, unavailable: true }, none)).toBe('fingerprint_unavailable');
    expect(mappingApprovalStatus(READY, { value: FP, unavailable: false }, none)).toBe('ready');
  });
});
