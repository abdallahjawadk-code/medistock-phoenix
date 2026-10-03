import { describe, expect, it } from 'vitest';
import { deriveSimpleExpertEscape, deriveSimpleExpertEscapes, summarizeSimpleReadiness } from '../simpleReadiness';
import { computeSimpleCounts } from '../simpleCounts';
import { KNOWN_BLOCKERS } from '../../CentralNeedsWorkspaceState';
import type { BeneficiaryColumnSummary, RecordDisposition, ReviewReadiness, SourceRecord } from '../../central-needs.service';

const readiness = (blockers: Array<{ blocker: string; detail?: string | null }>, ready = false): ReviewReadiness => ({
  planRevisionId: 'rev-1',
  status: 'draft',
  ready,
  blockers: blockers.map((b) => ({ blocker: b.blocker, detail: b.detail ?? null })),
});

describe('summarizeSimpleReadiness — fail-closed readiness projection (item 12 of the test checklist)', () => {
  it('returns null when there is no readiness yet — caller must not assume ready', () => {
    expect(summarizeSimpleReadiness(null)).toBeNull();
  });

  it('never synthesizes `ready` — it is read verbatim from the server', () => {
    expect(summarizeSimpleReadiness(readiness([], true))!.ready).toBe(true);
    expect(summarizeSimpleReadiness(readiness([{ blocker: 'beneficiary_column_review_required' }], false))!.ready).toBe(false);
  });

  it('categorizes each known blocker family into its own plain-language message key', () => {
    const s = summarizeSimpleReadiness(readiness([
      { blocker: 'beneficiary_column_review_required' },
      { blocker: 'target_entity_without_disposition' },
      { blocker: 'mapped_target_entity_without_need_line' },
      { blocker: 'no_finalized_import' },
    ]))!;
    expect(s.messageKeys).toEqual([
      'cn2b_simple_blocker_source',
      'cn2b_simple_blocker_beneficiary',
      'cn2b_simple_blocker_material',
      'cn2b_simple_blocker_need_line',
    ]);
    expect(s.hasUnknownBlocker).toBe(false);
  });

  it('FAILS CLOSED on a blocker code outside the known vocabulary: reported as unknown, never dropped or mis-filed', () => {
    const s = summarizeSimpleReadiness(readiness([{ blocker: 'some_future_blocker_code_this_build_has_never_seen' }]))!;
    expect(s.hasUnknownBlocker).toBe(true);
    expect(s.countsByCategory.unknown).toBe(1);
    expect(s.messageKeys).toEqual(['cn2b_simple_blocker_unknown']);
  });

  it('C5 §7: gives invalid evidence and each lineage reason their OWN keys alongside the category sentences', () => {
    const s = summarizeSimpleReadiness(readiness([
      { blocker: 'no_finalized_import' },
      { blocker: 'source_cell_value_contract_invalid', detail: 'session=s1 source_record=r1 reason=invalid_evidence' },
      { blocker: 'target_entity_without_disposition' },
      { blocker: 'need_line_quantity_lineage_unsafe', detail: 'session=s1 source_record=r1 need_line=n1 reason=source_quantity_override_value_invalid' },
      { blocker: 'need_line_quantity_lineage_unsafe', detail: 'session=s1 source_record=r2 need_line=n1 reason=source_cell_value_contract_invalid' },
    ]))!;
    expect(s.messageKeys).toEqual([
      'cn2b_simple_blocker_source',
      'cn2b_simple_blocker_source_evidence_invalid',
      'cn2b_simple_blocker_material',
      'cn2b_simple_blocker_lineage_source_cell_value_contract_invalid',
      'cn2b_simple_blocker_lineage_source_quantity_override_value_invalid',
    ]);
    expect(s.countsByCategory).toMatchObject({ source: 2, material: 1, need_line: 2, unknown: 0 });
    expect(s.hasUnknownBlocker).toBe(false);
  });

  it('reports no message lines when there are no blockers, without claiming a business fact beyond the server’s own `ready`', () => {
    const s = summarizeSimpleReadiness(readiness([], true))!;
    expect(s.messageKeys).toEqual([]);
  });
});

const rec = (over: Partial<SourceRecord>): SourceRecord => ({
  id: over.id ?? 'r1',
  importSessionId: 's1',
  recordOrdinal: 1,
  targetEntity: 'sheet:0:row:5',
  fieldName: 'col:2',
  sourceValues: { value: 'x' },
  sourceProvenance: { sheetIndex: 0, coordinate: { col: 2 } },
  ...over,
});

const disp = (over: Partial<RecordDisposition>): RecordDisposition => ({
  id: over.id ?? 'd1',
  importSessionId: 's1',
  targetEntity: 'sheet:0:row:5',
  decision: 'mapped',
  centralItemId: 'item-1',
  decisionReason: null,
  decidedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const bcol = (over: Partial<BeneficiaryColumnSummary>): BeneficiaryColumnSummary => ({
  importSessionId: 's1',
  originalFilename: 'f.xls',
  archiveEntryPath: null,
  sheetIndex: 0,
  sheetName: 'Sheet1',
  columnIndex: 2,
  sourceFieldName: null,
  numericValueCount: 1,
  zeroValueCount: 0,
  nonzeroNumericCount: 1,
  mappingId: null,
  decision: null,
  beneficiaryOrganizationId: null,
  mappingReason: null,
  mappedAt: null,
  mappedRowNumericCount: 1,
  reviewRequired: true,
  ...over,
});

describe('computeSimpleCounts — presentation-only aggregation over already-loaded state (items 3-5 territory)', () => {
  it('an UNRESOLVED column is counted as needing review, never as resolved (invariant #1: UNRESOLVED != NON_BENEFICIARY)', () => {
    const counts = computeSimpleCounts([bcol({ columnIndex: 2, decision: null })], [], []);
    expect(counts.institutionsUnresolved).toBe(1);
    expect(counts.institutionsConfirmed).toBe(0);
  });

  it('a NON_BENEFICIARY column is neither counted as confirmed nor as needing review', () => {
    const counts = computeSimpleCounts(
      [bcol({ columnIndex: 2, decision: 'non_beneficiary', reviewRequired: false })], [], [],
    );
    expect(counts.institutionsUnresolved).toBe(0);
    expect(counts.institutionsConfirmed).toBe(0);
  });

  it('a confirmed beneficiary column counts toward institutionsConfirmed, deduplicated by organization', () => {
    const counts = computeSimpleCounts(
      [
        bcol({ columnIndex: 2, decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', reviewRequired: false }),
        bcol({ columnIndex: 3, decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', reviewRequired: false }),
      ],
      [], [],
    );
    expect(counts.institutionsConfirmed).toBe(1);
  });

  it('a row with no disposition at all counts as needing material review', () => {
    const counts = computeSimpleCounts([], [rec({ id: 'r1', targetEntity: 'sheet:0:row:5' })], []);
    expect(counts.materialsUndispositioned).toBe(1);
    expect(counts.materialsMapped).toBe(0);
  });

  it('a "mapped" disposition removes the row from the review count and counts the distinct material', () => {
    const counts = computeSimpleCounts(
      [], [rec({ id: 'r1', targetEntity: 'sheet:0:row:5' })], [disp({ targetEntity: 'sheet:0:row:5' })],
    );
    expect(counts.materialsUndispositioned).toBe(0);
    expect(counts.materialsMapped).toBe(1);
  });

  // CN-UI-S1 supersedes the old quantityCandidateCount case: that figure
  // re-derived "which cells count" from the M213 column grain alone — a second
  // copy of the need-line panel's resolver, blind to CN-UI-R1 regions — and was
  // removed rather than extended. Its absence is what is pinned now.
  it('carries NO quantity figure — no second, M213-only copy of the need-line resolver', () => {
    const counts = computeSimpleCounts(
      [bcol({ columnIndex: 2, decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', reviewRequired: false })],
      [rec({ id: 'r1', targetEntity: 'e1' })],
      [disp({ targetEntity: 'e1' })],
    );
    expect(Object.keys(counts).sort()).toEqual([
      'institutionsConfirmed', 'institutionsUnresolved', 'materialsMapped', 'materialsUndispositioned', 'reviewItemCount',
    ]);
    expect(counts).not.toHaveProperty('quantityCandidateCount');
  });

  it('reviewItemCount is exactly the sum of unresolved institutions and undispositioned materials', () => {
    const counts = computeSimpleCounts(
      [bcol({ columnIndex: 2, decision: null })],
      [rec({ id: 'r1', targetEntity: 'e1' }), rec({ id: 'r2', targetEntity: 'e2' })],
      [],
    );
    expect(counts.reviewItemCount).toBe(1 + 2);
  });
});

/**
 * CN-UI-S1 HC1 — the contextual expert escape's derivation, pinned alone.
 * Presentation-only: its single input is the readiness the screen already
 * owns, read through the same vocabulary (`KNOWN_BLOCKERS`) and reason parser
 * the summary uses. It returns an Advanced stage for exactly three conditions
 * and `null` for everything else — including everything Simple resolves.
 */
describe('deriveSimpleExpertEscape — a fail-closed, explicit resolver (H1-02)', () => {
  const LINEAGE = 'need_line_quantity_lineage_unsafe';
  const NUMERIC = 'source_quantity_requires_explicit_numeric_override';
  const lineage = (reason: string) => ({ blocker: LINEAGE, detail: `session=s1 source_record=r1 need_line=n1 reason=${reason}` });
  // HC1.3: the numeric-required reason is HEAD-DEPENDENT. A complete chain in which `r1` has no current head is the plain
  // "this cell still needs a numeric correction" case these tests are about (the head-aware cases: cn-ui-s1-hc1-3-lineage-head).
  const EMPTY_CHAIN = { overrides: [], overrideReadFailure: null };

  it('has no escape without a readiness, when the server says ready, or for a revision that is not a draft', () => {
    expect(deriveSimpleExpertEscape(null)).toBeNull();
    expect(deriveSimpleExpertEscape(readiness([], true))).toBeNull();
    // `ready` is the server's: even blockers listed beside ready === true never escape.
    expect(deriveSimpleExpertEscape(readiness([lineage(NUMERIC)], true))).toBeNull();
    for (const status of ['submitted', 'approved', 'rejected', 'superseded'] as const) {
      expect(deriveSimpleExpertEscape({ ...readiness([lineage(NUMERIC)]), status }), status).toBeNull();
    }
    // Merely "not ready" with nothing named is no reason to leave Simple.
    expect(deriveSimpleExpertEscape(readiness([]))).toBeNull();
  });

  it('H1-02C (HC1.3) — a numeric-required row whose cell has NO current numeric correction escapes to the DATA REVIEW stage', () => {
    expect(deriveSimpleExpertEscape(readiness([lineage(NUMERIC)]), EMPTY_CHAIN)).toEqual({ stage: 'review', reason: 'numeric_override' });
    // One such row among others is enough.
    expect(deriveSimpleExpertEscape(readiness([
      { blocker: 'mapped_target_entity_without_need_line' }, lineage('source_quantity_override_mismatch'), lineage(NUMERIC),
    ]), EMPTY_CHAIN)).toEqual({ stage: 'review', reason: 'numeric_override' });
  });

  it('H1-02F — an open import attempt escapes to the SOURCE stage', () => {
    expect(deriveSimpleExpertEscape(readiness([{ blocker: 'import_session_still_open', detail: 'session=s9 status=processing' }])))
      .toEqual({ stage: 'source', reason: 'open_import' });
  });

  it('H1-02G — a blocker code outside the known vocabulary escapes, fail-closed, to the READINESS stage', () => {
    expect(deriveSimpleExpertEscape(readiness([{ blocker: 'some_future_blocker_code_this_build_has_never_seen' }])))
      .toEqual({ stage: 'readiness', reason: 'unknown_blocker' });
    // Unknown beside something Simple resolves: the unknown one is what Simple cannot describe.
    expect(deriveSimpleExpertEscape(readiness([{ blocker: 'target_entity_without_disposition' }, { blocker: 'brand_new_code' }])))
      .toEqual({ stage: 'readiness', reason: 'unknown_blocker' });
  });

  it('H1-02B/H — EVERY other known blocker code is Simple\'s to resolve: no escape, whatever the stage list says (HC1.1/HC1.2: invalid evidence is the one more that escapes — to READINESS, as a diagnosis)', () => {
    // HC1.1-A / HC1.2: the blocker for structurally invalid IMMUTABLE evidence escapes (diagnostic, READINESS), like its lineage reason.
    const resolvable = [...KNOWN_BLOCKERS].filter((code) => code !== 'import_session_still_open' && code !== 'source_cell_value_contract_invalid');
    expect(resolvable.length).toBeGreaterThan(10);
    for (const code of resolvable) {
      // The lineage code gets a reason Simple's own panel resolves unconditionally (delete + designate again with an equal contribution).
      // (`binding_invalid` is NOT unconditional since HC1.2: it needs a proven numeric current head — see cn-ui-s1-hc1-2-lineage-remedy.)
      const row = code === LINEAGE ? lineage('source_quantity_override_mismatch') : { blocker: code, detail: null };
      expect(deriveSimpleExpertEscape(readiness([row])), code).toBeNull();
    }
    // All of them at once still never escapes.
    expect(deriveSimpleExpertEscape(readiness(resolvable.map((code) => (
      code === LINEAGE ? lineage('source_quantity_override_mismatch') : { blocker: code, detail: null }
    ))))).toBeNull();
  });

  it('the numeric-override lineage reason escapes to review; the `reason=` token is the only authority — bare text, a prefix or a longer token never make one (they fail closed instead)', () => {
    // The token is the server's own `reason=`; prose, `note=…` and longer tokens are NOT it, so they are unknown (readiness), never a numeric escape.
    const unknownLineage = { stage: 'readiness', reason: 'unknown_lineage_reason' };
    expect(deriveSimpleExpertEscape(readiness([{ blocker: LINEAGE, detail: null }]))).toEqual(unknownLineage);
    expect(deriveSimpleExpertEscape(readiness([{ blocker: LINEAGE, detail: NUMERIC }]))).toEqual(unknownLineage);
    expect(deriveSimpleExpertEscape(readiness([{ blocker: LINEAGE, detail: `note=${NUMERIC}` }]))).toEqual(unknownLineage);
    expect(deriveSimpleExpertEscape(readiness([lineage(`${NUMERIC}_x`)]))).toEqual(unknownLineage);
    // The reason belongs to the lineage blocker only: the same token on another code is nothing.
    expect(deriveSimpleExpertEscape(readiness([{ blocker: 'target_entity_without_disposition', detail: `reason=${NUMERIC}` }]))).toBeNull();
  });

  it('when several apply, the earliest Advanced stage in workflow order wins: source, then review, then readiness', () => {
    const open = { blocker: 'import_session_still_open', detail: 'session=s9 status=pending' };
    const unknown = { blocker: 'brand_new_code' };
    expect(deriveSimpleExpertEscape(readiness([unknown, lineage(NUMERIC), open]), EMPTY_CHAIN)?.stage).toBe('source');
    expect(deriveSimpleExpertEscape(readiness([unknown, lineage(NUMERIC)]), EMPTY_CHAIN)?.stage).toBe('review');
    expect(deriveSimpleExpertEscape(readiness([unknown]))?.stage).toBe('readiness');
  });

  it('the list form returns EVERY applicable escape in workflow order, and the one-argument form is exactly its head', () => {
    const open = { blocker: 'import_session_still_open', detail: 'session=s9 status=pending' };
    const unknown = { blocker: 'brand_new_code' };
    expect(deriveSimpleExpertEscapes(readiness([unknown, lineage(NUMERIC), open]), EMPTY_CHAIN))
      .toEqual([{ stage: 'source', reason: 'open_import' }, { stage: 'review', reason: 'numeric_override' }, { stage: 'readiness', reason: 'unknown_blocker' }]);
    expect(deriveSimpleExpertEscapes(readiness([lineage(NUMERIC)]), EMPTY_CHAIN)).toEqual([{ stage: 'review', reason: 'numeric_override' }]);
    expect(deriveSimpleExpertEscapes(readiness([]))).toEqual([]);
    expect(deriveSimpleExpertEscapes(null)).toEqual([]);
    expect(deriveSimpleExpertEscapes(readiness([lineage(NUMERIC)], true), EMPTY_CHAIN)).toEqual([]);
    for (const input of [readiness([unknown, lineage(NUMERIC), open]), readiness([unknown]), readiness([]), readiness([], true), null]) {
      expect(deriveSimpleExpertEscape(input, EMPTY_CHAIN)).toEqual(deriveSimpleExpertEscapes(input, EMPTY_CHAIN)[0] ?? null);
      // …and with no override context at all the one-argument form is still exactly the head of the list form.
      expect(deriveSimpleExpertEscape(input)).toEqual(deriveSimpleExpertEscapes(input)[0] ?? null);
    }
  });

  it('is pure: the same readiness always gives the same answer, and it never mutates its input', () => {
    const input = readiness([lineage(NUMERIC), { blocker: 'brand_new_code' }]);
    const before = JSON.stringify(input);
    expect(deriveSimpleExpertEscape(input, EMPTY_CHAIN)).toEqual(deriveSimpleExpertEscape(input, EMPTY_CHAIN));
    expect(JSON.stringify(input)).toBe(before);
  });
});
