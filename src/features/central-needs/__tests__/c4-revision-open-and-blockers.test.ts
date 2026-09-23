/**
 * C4 — reopen by lifecycle identity (never `rows[0]`), the display-only
 * "effective" label that fails closed to "ambiguous", and the registration of
 * the five region readiness blockers.
 */
import { describe, expect, it } from 'vitest';
import { effectiveLabelOf, revisionToOpen } from '../central-needs.revision-open';
import { BLOCKERS_BY_STAGE, KNOWN_BLOCKERS, summarizeSessionBlockers } from '../CentralNeedsWorkspaceState';
import { summarizeSimpleReadiness } from '../simple/simpleReadiness';
import type { PlanRevision, RevisionLifecycle, RevisionStatus } from '../central-needs.service';

const rev = (id: string, planYear: number, n: number, status: RevisionStatus, planId = `plan-${planYear}`): PlanRevision => ({
  id, planId, organizationId: 'org', planYear, revisionNumber: n, status,
});

describe('revisionToOpen — identity, not list position', () => {
  it('an id the person already chose always wins', () => {
    const rows = [rev('a', 2026, 2, 'draft'), rev('b', 2026, 1, 'approved')];
    expect(revisionToOpen(rows, 'b')).toBe('b');
  });

  it('opens the newest plan\'s single open draft even when the list hands another row first', () => {
    const rows = [rev('approved-1', 2026, 1, 'approved'), rev('draft-2', 2026, 2, 'draft'), rev('old', 2025, 4, 'approved')];
    expect(revisionToOpen(rows, null)).toBe('draft-2');
  });

  it('without a draft, opens the plan\'s LATEST revision (the lifecycle anchor), e.g. a rejected correction', () => {
    expect(revisionToOpen([rev('r1', 2025, 1, 'approved'), rev('r2', 2025, 2, 'rejected')], null)).toBe('r2');
    expect(revisionToOpen([rev('only', 2024, 2, 'rejected')], null)).toBe('only');
  });

  it('an ambiguous lifecycle opens NOTHING: two drafts, or two approved revisions, in one plan', () => {
    expect(revisionToOpen([rev('d1', 2026, 1, 'draft'), rev('d2', 2026, 2, 'draft')], null)).toBeNull();
    expect(revisionToOpen([rev('a1', 2026, 1, 'approved'), rev('a2', 2026, 2, 'approved')], null)).toBeNull();
    expect(revisionToOpen([], null)).toBeNull();
  });

  it('a stale chosen id (no longer listed) is not kept', () => {
    expect(revisionToOpen([rev('d', 2026, 1, 'draft')], 'gone')).toBe('d');
  });
});

describe('effectiveLabelOf — display only, fails closed', () => {
  const lifecycle = (revisions: RevisionLifecycle['revisions'], effectiveRevisionId: string | null): RevisionLifecycle => ({
    planId: 'p', planYear: 2026, effectiveRevisionId, revisions, events: [],
  });

  it('exactly one approved revision that the server also names: that revision', () => {
    expect(effectiveLabelOf(lifecycle([
      { id: 'r1', revisionNumber: 1, status: 'superseded', effective: false },
      { id: 'r2', revisionNumber: 2, status: 'approved', effective: true },
    ], 'r2'))).toEqual({ kind: 'effective', revisionId: 'r2', revisionNumber: 2 });
  });

  it('more than one approved revision: "ambiguous", nothing marked — never the newest-first pick', () => {
    expect(effectiveLabelOf(lifecycle([
      { id: 'r1', revisionNumber: 1, status: 'approved', effective: true },
      { id: 'r2', revisionNumber: 2, status: 'approved', effective: true },
    ], 'r2'))).toEqual({ kind: 'ambiguous' });
  });

  it('a disagreement between the list and the single-row pick is ambiguous too; none approved is "none"', () => {
    expect(effectiveLabelOf(lifecycle([{ id: 'r1', revisionNumber: 1, status: 'approved', effective: true }], null)))
      .toEqual({ kind: 'ambiguous' });
    expect(effectiveLabelOf(lifecycle([{ id: 'r1', revisionNumber: 1, status: 'draft', effective: false }], null)))
      .toEqual({ kind: 'none' });
  });
});

describe('the five region readiness blockers are registered, session-attributable and never unknown', () => {
  const REGION = ['beneficiary_region_cell_uncovered', 'beneficiary_region_overlap',
    'beneficiary_decision_grain_conflict', 'beneficiary_region_geometry_invalid'];

  it('14, 16, 17, 18 under beneficiaries; 15 under need lines', () => {
    for (const code of REGION) expect(BLOCKERS_BY_STAGE.beneficiaries.has(code), code).toBe(true);
    expect(BLOCKERS_BY_STAGE['need-lines'].has('beneficiary_region_cell_without_need_line')).toBe(true);
    for (const code of [...REGION, 'beneficiary_region_cell_without_need_line']) expect(KNOWN_BLOCKERS.has(code)).toBe(true);
  });

  it('their session-first detail attributes to the session', () => {
    const summary = summarizeSessionBlockers({
      planRevisionId: 'rev', status: 'draft', ready: false,
      blockers: [...REGION, 'beneficiary_region_cell_without_need_line'].map((blocker) => ({
        blocker, detail: 'session=s-1 sheet=0 region=v1',
      })),
    });
    expect(summary.bySession.get('s-1')).toBe(5);
    expect(summary.unattributed).toBe(0);
  });

  it('Simple Mode categorizes them with the same vocabulary; unknown codes stay fail-closed', () => {
    const summary = summarizeSimpleReadiness({
      planRevisionId: 'rev', status: 'draft', ready: false,
      blockers: [
        { blocker: 'beneficiary_region_cell_uncovered', detail: 'session=s sheet=0 column=1' },
        { blocker: 'beneficiary_region_cell_without_need_line', detail: 'session=s sheet=0 row=1' },
        { blocker: 'beneficiary_region_something_new', detail: null },
      ],
    })!;
    expect(summary.countsByCategory.beneficiary).toBe(1);
    expect(summary.countsByCategory.need_line).toBe(1);
    expect(summary.hasUnknownBlocker).toBe(true);
  });
});
