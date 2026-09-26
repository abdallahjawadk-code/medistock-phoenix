/** @vitest-environment jsdom */
/**
 * C5 (M217 companion) — Simple Mode.
 *
 *   §17  a closed revision lands on the closed card BEFORE any blocker
 *        projection, with its OWN sentence per status (submitted, approved,
 *        rejected, superseded) — none of which reads as an edit task.
 *   §7   the outcome step explains invalid source evidence (§7.1) and each
 *        unsafe-lineage reason (§7.2) with explicit copy, read from the
 *        server's `reason=` token; an unrecognized reason fails closed.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type { PreviewState } from '../../useCentralNeedsPreview';
import type { PlanRevision, ReviewBlocker, ReviewReadiness, RevisionStatus } from '../../central-needs.service';

vi.mock('../../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../../central-needs.service')>('../../central-needs.service');
  return { ...actual, setBeneficiaryColumns: vi.fn(), setRecordDisposition: vi.fn(), searchCentralItems: () => Promise.resolve([]) };
});

const { CentralNeedsSimpleWorkspace } = await import('../CentralNeedsSimpleWorkspace');

afterEach(() => cleanup());

const IDLE: PreviewState = { phase: 'idle' };
const revisionOf = (status: RevisionStatus): PlanRevision => ({
  id: 'rev-1', planId: 'plan-1', organizationId: 'org-1', planYear: 2026, revisionNumber: 1, status,
});
const readinessOf = (status: RevisionStatus, blockers: ReviewBlocker[]): ReviewReadiness => ({
  planRevisionId: 'rev-1', status, ready: blockers.length === 0, blockers,
});

type WorkspaceProps = Parameters<typeof CentralNeedsSimpleWorkspace>[0];
function renderWorkspace(over: Partial<WorkspaceProps>) {
  const props: WorkspaceProps = {
    lang: 'en', planYear: 2026, onPlanYearChange: () => {}, revisionsLoading: false, revision: null, isDraft: true,
    revisionDataReady: true, canImport: true, canEdit: true, busy: false, activity: null, onOpenRevision: () => {},
    preview: IDLE, pendingFile: null, onPickFile: () => {}, onVerify: () => {}, error: null, notice: null,
    readiness: null, beneficiaryColumns: [], careInstitutions: [], records: [], dispositions: [],
    activeSessionId: 's1', onChanged: () => {}, onSwitchToAdvanced: () => {}, ...over,
  };
  return render(<CentralNeedsSimpleWorkspace {...props} />);
}

const EDIT_BLOCKERS: ReviewBlocker[] = [
  { blocker: 'source_cell_value_contract_invalid', detail: 'session=s1 source_record=r1 reason=invalid_evidence' },
  { blocker: 'need_line_quantity_lineage_unsafe', detail: 'session=s1 source_record=r1 need_line=n1 reason=source_quantity_override_binding_invalid' },
];

describe('C5 §17 — Simple Mode: each closed status has its own terminal sentence, before any blocker projection', () => {
  const EXPECTED: Record<Exclude<RevisionStatus, 'draft'>, string> = {
    submitted: 'cn2b_simple_closed_submitted',
    approved: 'cn2b_simple_already_approved',
    rejected: 'cn2b_simple_closed_rejected',
    superseded: 'cn2b_simple_closed_superseded',
  };

  it.each(Object.entries(EXPECTED))('%s lands on the closed card with its own copy, even WITH blockers', (status, key) => {
    renderWorkspace({
      revision: revisionOf(status as RevisionStatus), isDraft: false,
      readiness: readinessOf(status as RevisionStatus, EDIT_BLOCKERS),
    });
    expect(screen.getByTestId('cn2b-simple-workspace')).toHaveAttribute('data-step', 'upload');
    const notice = screen.getByTestId('cn2b-simple-closed-notice');
    expect(notice).toHaveAttribute('data-status', status);
    expect(notice).toHaveTextContent(T[key].en);
    // No blocker copy and no review step is offered for a closed revision.
    expect(screen.queryByTestId('cn2b-simple-readiness-messages')).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-review-start')).toBeNull();
  });

  it('the four sentences are distinct from each other and from the old shared notice', () => {
    const texts = Object.values(EXPECTED).map((k) => T[k].en);
    expect(new Set([...texts, T.cn2b_simple_closed_notice.en]).size).toBe(5);
  });
});

describe('C5 §7 — Simple Mode outcome copy for invalid evidence and each lineage reason', () => {
  function renderPending(blockers: ReviewBlocker[]) {
    renderWorkspace({ revision: revisionOf('draft'), isDraft: true, readiness: readinessOf('draft', blockers) });
    // Past the analysis summary, to the outcome step (nothing is left to review in this dataset).
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(screen.getByTestId('cn2b-simple-workspace')).toHaveAttribute('data-step', 'pending');
    return screen.getByTestId('cn2b-simple-readiness-messages');
  }

  it('says invalid immutable evidence needs a controlled replacement, and a stale pin needs a re-pin or re-designation', () => {
    const messages = renderPending(EDIT_BLOCKERS);
    const items = within(messages).getAllByRole('listitem').map((li) => li.textContent?.trim());
    expect(items).toEqual([
      T.cn2b_simple_blocker_source_evidence_invalid.en,
      T.cn2b_simple_blocker_lineage_source_quantity_override_binding_invalid.en,
    ]);
    expect(messages).not.toHaveTextContent(T.cn2b_simple_blocker_source.en);
    expect(messages).not.toHaveTextContent(T.cn2b_simple_blocker_need_line.en);
  });

  it('fails closed to the advanced-review sentence for a reason this build does not know', () => {
    const messages = renderPending([{ blocker: 'need_line_quantity_lineage_unsafe', detail: 'session=s1 reason=some_future_reason' }]);
    expect(messages).toHaveTextContent(T.cn2b_simple_blocker_lineage_reason_unrecognized.en);
  });
});
