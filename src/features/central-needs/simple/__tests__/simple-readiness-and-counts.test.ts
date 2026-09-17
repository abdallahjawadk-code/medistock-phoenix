import { describe, expect, it } from 'vitest';
import { summarizeSimpleReadiness } from '../simpleReadiness';
import { computeSimpleCounts } from '../simpleCounts';
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

  it('quantityCandidateCount requires BOTH a mapped disposition AND a resolved beneficiary column for that exact record', () => {
    const mappedNoColumn = computeSimpleCounts(
      [], [rec({ id: 'r1', targetEntity: 'e1' })], [disp({ targetEntity: 'e1' })],
    );
    expect(mappedNoColumn.quantityCandidateCount).toBe(0);

    const mappedAndResolved = computeSimpleCounts(
      [bcol({ columnIndex: 2, decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', reviewRequired: false })],
      [rec({ id: 'r1', targetEntity: 'e1' })],
      [disp({ targetEntity: 'e1' })],
    );
    expect(mappedAndResolved.quantityCandidateCount).toBe(1);
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
