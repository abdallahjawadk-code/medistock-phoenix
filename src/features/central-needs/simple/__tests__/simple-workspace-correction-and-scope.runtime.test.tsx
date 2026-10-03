/** @vitest-environment jsdom */
/**
 * Director correction pass — the three confirmed defects, proven at runtime.
 *
 *  1. a closed revision's "create correction revision" action must actually
 *     reach `onOpenRevision(true)`, exactly once, and only on an explicit
 *     click by a permitted, non-busy actor;
 *  2. Simple Mode must honour the SAME `canEdit` boolean the screen passes,
 *     rather than declaring it and ignoring it;
 *  3. no active-session count may read as a whole-annual-need total.
 *
 * CN-UI-S1 (superseded, updated):
 *   * the summary step and its dataset-keyed acknowledgement are gone (owner
 *     decision), so Director defect 4 / finding 5's summary cases are replaced
 *     by the step model they protected — derived from props alone, with
 *     nothing left that could go stale;
 *   * opening an annual draft or a correction is gated on `canEdit` (the
 *     server's edit guard), no longer on `canImport`;
 *   * finding 3's scope labels now sit on the compact session context, and
 *     the M213-only quantity figure is gone.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PreviewState } from '../../useCentralNeedsPreview';
import type {
  BeneficiaryColumnSummary, PlanRevision, RecordDisposition, ReviewReadiness, RevisionStatus, SourceRecord,
} from '../../central-needs.service';

const setBeneficiaryColumns = vi.fn();
const setRecordDisposition = vi.fn();
vi.mock('../../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../../central-needs.service')>('../../central-needs.service');
  return {
    ...actual,
    setBeneficiaryColumns: (...a: unknown[]) => setBeneficiaryColumns(...a),
    setRecordDisposition: (...a: unknown[]) => setRecordDisposition(...a),
    searchCentralItems: () => Promise.resolve([]),
  };
});

const { CentralNeedsSimpleWorkspace } = await import('../CentralNeedsSimpleWorkspace');

afterEach(() => { cleanup(); setBeneficiaryColumns.mockReset(); setRecordDisposition.mockReset(); });

const IDLE: PreviewState = { phase: 'idle' };

const revisionOf = (status: RevisionStatus): PlanRevision => ({
  id: 'rev-1',
  planId: 'plan-1',
  organizationId: 'org-1',
  planYear: 2026,
  revisionNumber: 1,
  status,
});

const rec = (over: Partial<SourceRecord>): SourceRecord => ({
  id: over.id ?? 'r1',
  importSessionId: 's1',
  recordOrdinal: 1,
  targetEntity: 'sheet:0:row:5',
  fieldName: 'ITEMS',
  sourceValues: { value: 'PARACETAMOL 500 MG' },
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
  originalFilename: 'need-2026.xls',
  archiveEntryPath: null,
  sheetIndex: 0,
  sheetName: 'Sheet1',
  columnIndex: 2,
  sourceFieldName: 'مستشفى الحلة التعليمي',
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

const readinessOf = (ready: boolean, blockers: ReviewReadiness['blockers'] = []): ReviewReadiness => ({
  planRevisionId: 'rev-1', status: 'draft', ready, blockers,
});

type WorkspaceProps = Parameters<typeof CentralNeedsSimpleWorkspace>[0];

const onOpenRevision = vi.fn();

function propsOf(over: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    lang: 'ar',
    planYear: 2026,
    onPlanYearChange: () => {},
    revisionsLoading: false,
    revision: null,
    isDraft: true,
    revisionDataReady: true,
    canImport: true,
    canEdit: true,
    busy: false,
    activity: null,
    onOpenRevision,
    preview: IDLE,
    pendingFile: null,
    onPickFile: () => {},
    onVerify: () => {},
    error: null,
    notice: null,
    readiness: null,
    beneficiaryColumns: [],
    careInstitutions: [],
    records: [],
    dispositions: [],
    activeSessionId: 's1',
    onChanged: () => {},
    ...over,
  };
}

/**
 * Renders the workspace and hands back a `rerenderWith` that keeps the SAME
 * component instance while changing props — which is how the cases below
 * simulate switching session, revision, or readiness.
 */
function renderWorkspace(over: Partial<WorkspaceProps> = {}) {
  onOpenRevision.mockReset();
  const view = render(<CentralNeedsSimpleWorkspace {...propsOf(over)} />);
  return {
    ...view,
    rerenderWith: (next: Partial<WorkspaceProps>) =>
      view.rerender(<CentralNeedsSimpleWorkspace {...propsOf({ ...over, ...next })} />),
  };
}

describe('Simple Mode — correction revision flow (Director finding 1)', () => {
  for (const status of ['approved', 'submitted', 'rejected'] as const) {
    it(`a ${status} revision renders the correction action instead of dead-ending`, () => {
      renderWorkspace({ revision: revisionOf(status), isDraft: false });
      expect(screen.getByTestId('cn2b-simple-closed-notice')).toBeInTheDocument();
      expect(screen.getByTestId('cn2b-simple-create-correction')).toBeInTheDocument();
    });
  }

  it('never opens a successor merely because the component rendered', () => {
    renderWorkspace({ revision: revisionOf('approved'), isDraft: false });
    expect(onOpenRevision).not.toHaveBeenCalled();
  });

  it('an explicit click calls onOpenRevision(true) exactly once', () => {
    renderWorkspace({ revision: revisionOf('approved'), isDraft: false });
    fireEvent.click(screen.getByTestId('cn2b-simple-create-correction'));
    expect(onOpenRevision).toHaveBeenCalledTimes(1);
    expect(onOpenRevision).toHaveBeenCalledWith(true);
  });

  it('an actor without central_needs.edit is offered no correction control at all — and is told why (CN-UI-S1: was import)', () => {
    renderWorkspace({ revision: revisionOf('approved'), isDraft: false, canEdit: false, canImport: true });
    expect(screen.queryByTestId('cn2b-simple-create-correction')).toBeNull();
    expect(screen.getByTestId('cn2b-simple-correction-no-edit-permission')).toHaveTextContent('ليست لديك صلاحية تعديل الاحتياج المركزي');
    for (const el of screen.queryAllByRole('button')) fireEvent.click(el);
    expect(onOpenRevision).not.toHaveBeenCalled();
  });

  it('an editor WITHOUT central_needs.import is still offered the correction (CN-UI-S1: the server guards it with edit)', () => {
    renderWorkspace({ revision: revisionOf('approved'), isDraft: false, canEdit: true, canImport: false });
    fireEvent.click(screen.getByTestId('cn2b-simple-create-correction'));
    expect(onOpenRevision).toHaveBeenCalledWith(true);
  });

  it('the correction control is disabled while busy, and a click on it does nothing', () => {
    renderWorkspace({ revision: revisionOf('approved'), isDraft: false, busy: true });
    const button = screen.getByTestId('cn2b-simple-create-correction') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onOpenRevision).not.toHaveBeenCalled();
  });

  it('the correction control is disabled while revisions are still loading', () => {
    renderWorkspace({ revision: revisionOf('approved'), isDraft: false, revisionsLoading: true });
    expect((screen.getByTestId('cn2b-simple-create-correction') as HTMLButtonElement).disabled).toBe(true);
  });

  it('creating the FIRST revision still calls onOpenRevision(false), not the successor path', () => {
    renderWorkspace({ revision: null });
    fireEvent.click(screen.getByTestId('cn2b-simple-start'));
    expect(onOpenRevision).toHaveBeenCalledTimes(1);
    expect(onOpenRevision).toHaveBeenCalledWith(false);
  });

  it('opening the first annual draft needs central_needs.edit, not import (CN-UI-S1)', () => {
    renderWorkspace({ revision: null, canEdit: false, canImport: true });
    expect(screen.queryByTestId('cn2b-simple-start')).toBeNull();
    expect(screen.getByTestId('cn2b-simple-no-edit-permission')).toBeInTheDocument();
    cleanup();
    renderWorkspace({ revision: null, canEdit: true, canImport: false });
    fireEvent.click(screen.getByTestId('cn2b-simple-start'));
    expect(onOpenRevision).toHaveBeenCalledWith(false);
  });
});

describe('Simple Mode — permission parity is wired, not merely declared (Director finding 2)', () => {
  /** Exactly one exact match for the column header, so the confirm control is the one offered. */
  const ORGS = [{
    id: '00000000-0000-0000-0000-0000000000c1',
    name: 'Al-Hillah Teaching Hospital',
    name_ar: 'مستشفى الحلة التعليمي',
    code: 'hillah',
    status: 'active',
    organizationKind: 'care_institution',
  }] as unknown as WorkspaceProps['careInstitutions'];

  const reviewProps: Partial<WorkspaceProps> = {
    revision: revisionOf('draft'),
    isDraft: true,
    careInstitutions: ORGS,
    beneficiaryColumns: [bcol({ columnIndex: 2 })],
  };

  it('canEdit=false renders the institution step read-only, with no write control', () => {
    renderWorkspace({ ...reviewProps, canEdit: false });
    expect(screen.getByTestId('cn2b-simple-institution-progress')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-institution-evidence')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-institution-read-only')).toBeInTheDocument();
    expect(screen.queryByText('صحيح')).toBeNull();
    expect(screen.queryByText('ليست مؤسسة')).toBeNull();
  });

  it('canEdit=false cannot reach setBeneficiaryColumns from the institution step', () => {
    renderWorkspace({ ...reviewProps, canEdit: false });
    for (const el of screen.queryAllByRole('button')) fireEvent.click(el);
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });

  it('canEdit=false renders the material step read-only, with no write control', () => {
    renderWorkspace({
      revision: revisionOf('draft'),
      isDraft: true,
      canEdit: false,
      records: [rec({ id: 'r1', targetEntity: 'sheet:0:row:5' })],
    });
    expect(screen.getByTestId('cn2b-simple-material-progress')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-material-evidence')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-material-read-only')).toBeInTheDocument();
    expect(screen.queryByText('اختيار المادة')).toBeNull();
    expect(screen.queryByText('ليست مادة')).toBeNull();
  });

  it('canEdit=false cannot reach setRecordDisposition from the material step', () => {
    renderWorkspace({
      revision: revisionOf('draft'),
      isDraft: true,
      canEdit: false,
      records: [rec({ id: 'r1', targetEntity: 'sheet:0:row:5' })],
    });
    for (const el of screen.queryAllByRole('button')) fireEvent.click(el);
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('canEdit=true still offers the institution write control (the gate narrows nothing else)', () => {
    renderWorkspace({ ...reviewProps, canEdit: true });
    expect(screen.queryByTestId('cn2b-simple-institution-read-only')).toBeNull();
    expect(screen.getByText('صحيح')).toBeInTheDocument();
  });

  it('a non-draft revision is read-only even for an editor — the same rule Advanced Mode applies', () => {
    // A closed revision routes to the outcome step's closed card, never to review.
    renderWorkspace({
      revision: revisionOf('approved'),
      isDraft: false,
      canEdit: true,
      beneficiaryColumns: [bcol({ columnIndex: 2 })],
    });
    expect(screen.queryByText('صحيح')).toBeNull();
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });
});

/**
 * CN-UI-S1 — the step model (replaces Director defect 4 / finding 5's summary
 * cases): upload → analyzing → institutions → materials → need lines → outcome,
 * derived from current props alone.
 */
describe('Simple Mode — the step is derived from props alone, with no summary stop (CN-UI-S1)', () => {
  const analyzed: Partial<WorkspaceProps> = {
    revision: revisionOf('draft'),
    isDraft: true,
    revisionDataReady: true,
    beneficiaryColumns: [bcol({ columnIndex: 2 })],
    records: [rec({ id: 'r1', targetEntity: 'sheet:0:row:5' })],
  };
  const reviewed: Partial<WorkspaceProps> = {
    ...analyzed,
    beneficiaryColumns: [bcol({ columnIndex: 2, decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', reviewRequired: false })],
    dispositions: [disp({ targetEntity: 'sheet:0:row:5' })],
  };

  const stepOf = () => screen.getByTestId('cn2b-simple-workspace').getAttribute('data-step');

  it('1. no revision → upload; an open draft with no completed session → upload', () => {
    renderWorkspace({ revision: null });
    expect(stepOf()).toBe('upload');
    cleanup();
    renderWorkspace({ revision: revisionOf('draft'), activeSessionId: null });
    expect(stepOf()).toBe('upload');
  });

  it('2. a parsing preview, a verify, an open, unready data or a session still loading → analyzing', () => {
    const { rerenderWith } = renderWorkspace({ ...analyzed, preview: { phase: 'parsing', filename: 'need-2026.zip' } });
    expect(stepOf()).toBe('analyzing');
    rerenderWith({ preview: IDLE, busy: true, activity: 'verifying' });
    expect(stepOf()).toBe('analyzing');
    rerenderWith({ busy: true, activity: 'opening' });
    expect(stepOf()).toBe('analyzing');
    rerenderWith({ busy: false, activity: null, revisionDataReady: false });
    expect(stepOf()).toBe('analyzing');
    rerenderWith({ revisionDataReady: true, sessionLoading: true });
    expect(stepOf()).toBe('analyzing');
    // No card acts on rows that may still be the previous session's.
    expect(screen.queryByTestId('cn2b-simple-institution-card')).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-material-card')).toBeNull();
  });

  it('3. newly analyzed data lands straight on its first queue — no summary card, no "review" button', () => {
    renderWorkspace(analyzed);
    expect(stepOf()).toBe('review-institution');
    expect(screen.getByTestId('cn2b-simple-institution-evidence')).toBeInTheDocument();
    expect(screen.queryByTestId('cn2b-simple-summary')).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-review-start')).toBeNull();
    expect(screen.queryByText('الرجوع إلى الملخص')).toBeNull();
  });

  it('4. with institutions resolved it moves to material review', () => {
    renderWorkspace({ ...analyzed, beneficiaryColumns: reviewed.beneficiaryColumns });
    expect(stepOf()).toBe('review-material');
    expect(screen.getByTestId('cn2b-simple-material-evidence')).toBeInTheDocument();
  });

  it('5. with nothing left to review and the server still blocking → need lines, its blockers verbatim', () => {
    renderWorkspace({
      ...reviewed,
      readiness: readinessOf(false, [{ blocker: 'need_line_unit_conversion_required', detail: null }]),
    });
    expect(stepOf()).toBe('need-lines');
    const card = screen.getByTestId('cn2b-simple-pending');
    expect(within(card).getByTestId('cn2b-simple-readiness-messages')).toBeInTheDocument();
    expect(within(card).queryByTestId('cn2b-simple-readiness-clear')).toBeNull();
    expect(within(card).queryByTestId('cn2b-simple-submit')).toBeNull();
  });

  it('6. an unanswered readiness read never counts as ready — need lines, "not determined yet"', () => {
    renderWorkspace({ ...reviewed, readiness: null });
    expect(stepOf()).toBe('need-lines');
    expect(screen.getByTestId('cn2b-simple-readiness-unknown')).toBeInTheDocument();
  });

  it('7. only the SERVER\'s ready reaches the outcome step', () => {
    const { rerenderWith } = renderWorkspace({ ...reviewed, readiness: readinessOf(false, [{ blocker: 'mapped_target_entity_without_need_line', detail: null }]) });
    expect(stepOf()).toBe('need-lines');
    rerenderWith({ readiness: readinessOf(true) });
    expect(stepOf()).toBe('pending');
    expect(screen.getByTestId('cn2b-simple-readiness-clear')).toBeInTheDocument();
  });

  it('8. a CLOSED revision outranks everything — unresolved work, a busy screen — and lands on the outcome step', () => {
    renderWorkspace({ ...analyzed, revision: revisionOf('approved'), isDraft: false, busy: true, activity: 'opening' });
    expect(stepOf()).toBe('pending');
    expect(screen.getByTestId('cn2b-simple-closed-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('cn2b-simple-institution-card')).toBeNull();
  });

  it('9. switching session or revision re-derives at once — there is no acknowledgement to go stale', () => {
    const { rerenderWith } = renderWorkspace({ ...reviewed, readiness: readinessOf(false) });
    expect(stepOf()).toBe('need-lines');
    // The new session's rows have undecided material: its queue, immediately.
    rerenderWith({ activeSessionId: 's2', records: [rec({ id: 'r9', importSessionId: 's2', targetEntity: 'sheet:0:row:9' })], dispositions: [] });
    expect(stepOf()).toBe('review-material');
    rerenderWith({ revision: { ...revisionOf('draft'), id: 'rev-2' }, beneficiaryColumns: [bcol({ columnIndex: 4 })] });
    expect(stepOf()).toBe('review-institution');
  });
});

describe('Simple Mode — the session context cannot claim revision-wide totals (Director finding 3)', () => {
  const contextProps: Partial<WorkspaceProps> = {
    revision: revisionOf('draft'),
    isDraft: true,
    beneficiaryColumns: [
      bcol({ columnIndex: 2, decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', reviewRequired: false }),
    ],
    records: [rec({ id: 'r1', targetEntity: 'sheet:0:row:5' }), rec({ id: 'r2', targetEntity: 'sheet:0:row:6' })],
    dispositions: [disp({ targetEntity: 'sheet:0:row:5' })],
  };

  it('marks the session-scoped figure as this-file-only and the revision-wide one as such', () => {
    renderWorkspace(contextProps);
    expect(screen.getByTestId('cn2b-simple-workspace')).toHaveAttribute('data-step', 'review-material');
    const context = screen.getByTestId('cn2b-simple-context');
    expect(within(context).getByTestId('cn2b-simple-scope-materials').textContent ?? '').toMatch(/في هذا الملف فقط/);
    expect(within(context).getByTestId('cn2b-simple-scope-institutions').textContent ?? '').toMatch(/في كامل الاحتياج السنوي/);
    expect(within(context).getByTestId('cn2b-simple-count-materials')).toHaveTextContent('1');
    expect(within(context).getByTestId('cn2b-simple-count-institutions')).toHaveTextContent('1');
  });

  it('every figure carries a scope marker beside it — none is presented bare — and there is no quantity figure', () => {
    renderWorkspace(contextProps);
    for (const id of ['cn2b-simple-count-materials', 'cn2b-simple-count-institutions']) {
      const dd = screen.getByTestId(id);
      const dt = dd.parentElement?.querySelector('dt');
      expect(dt, id).not.toBeNull();
      expect(dt?.querySelector('[data-testid^="cn2b-simple-scope-"]'), id).not.toBeNull();
    }
    expect(screen.queryByTestId('cn2b-simple-count-quantities')).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-scope-quantities')).toBeNull();
  });

  it('is shown only where the work is session-scoped — never on the revision-wide institution step or a closed revision', () => {
    const { rerenderWith } = renderWorkspace({ ...contextProps, beneficiaryColumns: [bcol({ columnIndex: 3 })] });
    expect(screen.getByTestId('cn2b-simple-workspace')).toHaveAttribute('data-step', 'review-institution');
    expect(screen.queryByTestId('cn2b-simple-context')).toBeNull();
    rerenderWith({ revision: revisionOf('approved'), isDraft: false });
    expect(screen.queryByTestId('cn2b-simple-context')).toBeNull();
  });
});
