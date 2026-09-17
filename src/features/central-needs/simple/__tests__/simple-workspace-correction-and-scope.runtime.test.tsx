/** @vitest-environment jsdom */
/**
 * Director correction pass — the three confirmed defects, proven at runtime.
 *
 *  1. a closed revision's "create correction revision" action must actually
 *     reach `onOpenRevision(true)`, exactly once, and only on an explicit
 *     click by a permitted, non-busy actor;
 *  2. Simple Mode must honour the SAME `canEdit` boolean the screen passes,
 *     rather than declaring it and ignoring it;
 *  3. the summary must not let an active-session count read as a
 *     whole-annual-need total.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PreviewState } from '../../useCentralNeedsPreview';
import type {
  BeneficiaryColumnSummary, PlanRevision, RecordDisposition, RevisionStatus, SourceRecord,
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
    onSwitchToAdvanced: () => {},
    ...over,
  };
}

/**
 * Renders the workspace and hands back a `rerenderWith` that keeps the SAME
 * component instance (so its navigation state survives the way it would in the
 * app) while changing props — which is how the stale-navigation cases below
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

/**
 * Renders, then steps past the analysis summary the way a human does. Since
 * defect 4 was fixed the summary is presented first, so any test about the
 * review steps has to pass through it rather than landing there directly.
 */
function renderAtReview(over: Partial<WorkspaceProps> = {}) {
  const view = renderWorkspace(over);
  const advance = screen.queryByTestId('cn2b-simple-review-start');
  if (advance) fireEvent.click(advance);
  return view;
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

  it('an actor without central_needs.import is offered no correction control at all', () => {
    renderWorkspace({ revision: revisionOf('approved'), isDraft: false, canImport: false });
    expect(screen.queryByTestId('cn2b-simple-create-correction')).toBeNull();
    for (const el of screen.queryAllByRole('button')) fireEvent.click(el);
    expect(onOpenRevision).not.toHaveBeenCalled();
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
    renderAtReview({ ...reviewProps, canEdit: false });
    expect(screen.getByTestId('cn2b-simple-institution-progress')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-institution-evidence')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-institution-read-only')).toBeInTheDocument();
    expect(screen.queryByText('صحيح')).toBeNull();
    expect(screen.queryByText('ليست مؤسسة')).toBeNull();
  });

  it('canEdit=false cannot reach setBeneficiaryColumns from the institution step', () => {
    renderAtReview({ ...reviewProps, canEdit: false });
    for (const el of screen.queryAllByRole('button')) fireEvent.click(el);
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });

  it('canEdit=false renders the material step read-only, with no write control', () => {
    renderAtReview({
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
    renderAtReview({
      revision: revisionOf('draft'),
      isDraft: true,
      canEdit: false,
      records: [rec({ id: 'r1', targetEntity: 'sheet:0:row:5' })],
    });
    for (const el of screen.queryAllByRole('button')) fireEvent.click(el);
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('canEdit=true still offers the institution write control (the gate narrows nothing else)', () => {
    renderAtReview({ ...reviewProps, canEdit: true });
    expect(screen.queryByTestId('cn2b-simple-institution-read-only')).toBeNull();
    expect(screen.getByText('صحيح')).toBeInTheDocument();
  });

  it('a non-draft revision is read-only even for an editor — the same rule Advanced Mode applies', () => {
    // Reached through the summary step, because a closed revision routes to `upload`.
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

describe('Simple Mode — the approved flow presents the summary FIRST (Director defect 4)', () => {
  const analyzed: Partial<WorkspaceProps> = {
    revision: revisionOf('draft'),
    isDraft: true,
    revisionDataReady: true,
    beneficiaryColumns: [bcol({ columnIndex: 2 })],
    records: [rec({ id: 'r1', targetEntity: 'sheet:0:row:5' })],
  };

  const stepOf = () => screen.getByTestId('cn2b-simple-workspace').getAttribute('data-step');

  it('1. no revision → upload', () => {
    renderWorkspace({ revision: null });
    expect(stepOf()).toBe('upload');
  });

  it('2. a parsing preview → analyzing', () => {
    renderWorkspace({ ...analyzed, preview: { phase: 'parsing', filename: 'need-2026.zip' } });
    expect(stepOf()).toBe('analyzing');
  });

  it('2b. a busy revision → analyzing, and an unready one too', () => {
    renderWorkspace({ ...analyzed, busy: true });
    expect(stepOf()).toBe('analyzing');
    cleanup();
    renderWorkspace({ ...analyzed, revisionDataReady: false });
    expect(stepOf()).toBe('analyzing');
  });

  it('3. newly ready analyzed data lands on SUMMARY, not straight into review', () => {
    renderWorkspace(analyzed);
    expect(stepOf()).toBe('summary');
    expect(screen.getByTestId('cn2b-simple-summary-read')).toBeInTheDocument();
    // The item-by-item cards are NOT shown yet.
    expect(screen.queryByTestId('cn2b-simple-institution-evidence')).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-material-evidence')).toBeNull();
  });

  it('3b. the summary presents every figure and the review count before any review begins', () => {
    renderWorkspace(analyzed);
    expect(screen.getByTestId('cn2b-simple-count-institutions')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-count-materials')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-count-quantities')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-review-remaining')).toBeInTheDocument();
  });

  it('4. the summary carries the finding-3 scope labels and warning', () => {
    renderWorkspace(analyzed);
    expect(screen.getByTestId('cn2b-simple-summary-scope-title')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-scope-institutions')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-scope-materials')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-scope-quantities')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-summary-scope-note')).toBeInTheDocument();
  });

  it('5. the explicit Review action moves to institution review when columns are unresolved', () => {
    renderWorkspace(analyzed);
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(stepOf()).toBe('review-institution');
    expect(screen.getByTestId('cn2b-simple-institution-evidence')).toBeInTheDocument();
  });

  it('6. with institutions resolved it moves to material review instead', () => {
    renderWorkspace({
      ...analyzed,
      beneficiaryColumns: [
        bcol({ columnIndex: 2, decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', reviewRequired: false }),
      ],
    });
    expect(stepOf()).toBe('summary');
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(stepOf()).toBe('review-material');
    expect(screen.getByTestId('cn2b-simple-material-evidence')).toBeInTheDocument();
  });

  it('7. with nothing left to review it moves to pending — the summary is never a dead end', () => {
    renderWorkspace({
      ...analyzed,
      beneficiaryColumns: [
        bcol({ columnIndex: 2, decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', reviewRequired: false }),
      ],
      records: [rec({ id: 'r1', targetEntity: 'sheet:0:row:5' })],
      dispositions: [disp({ targetEntity: 'sheet:0:row:5' })],
    });
    expect(stepOf()).toBe('summary');
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(stepOf()).toBe('pending');
    expect(screen.getByTestId('cn2b-simple-pending-title')).toBeInTheDocument();
  });

  it('8. returning to the summary from a review step works, and leaving it again resumes review', () => {
    renderWorkspace(analyzed);
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(stepOf()).toBe('review-institution');
    fireEvent.click(screen.getByText('الرجوع إلى الملخص'));
    expect(stepOf()).toBe('summary');
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(stepOf()).toBe('review-institution');
  });

  it('9a. switching import session shows the summary again — no stale acknowledgement', () => {
    const { rerenderWith } = renderWorkspace({ ...analyzed, activeSessionId: 's1' });
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(stepOf()).toBe('review-institution');

    rerenderWith({ activeSessionId: 's2' });
    expect(stepOf()).toBe('summary');
  });

  it('9b. switching revision shows the summary again — no stale acknowledgement', () => {
    const { rerenderWith } = renderWorkspace(analyzed);
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(stepOf()).toBe('review-institution');

    rerenderWith({ revision: { ...revisionOf('draft'), id: 'rev-2' } });
    expect(stepOf()).toBe('summary');
  });

  it('the summary gate never invents completion: unresolved work still routes to review after it', () => {
    renderWorkspace(analyzed);
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    // Acknowledging the summary skipped nothing — the unresolved column is still queued.
    expect(stepOf()).toBe('review-institution');
    expect(screen.getByTestId('cn2b-simple-institution-progress')).toHaveTextContent('1');
  });

  it('the summary gate never touches server readiness: blockers are still rendered verbatim at pending', () => {
    renderWorkspace({
      ...analyzed,
      beneficiaryColumns: [
        bcol({ columnIndex: 2, decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', reviewRequired: false }),
      ],
      records: [rec({ id: 'r1', targetEntity: 'sheet:0:row:5' })],
      dispositions: [disp({ targetEntity: 'sheet:0:row:5' })],
      readiness: {
        planRevisionId: 'rev-1',
        status: 'draft',
        ready: false,
        blockers: [{ blocker: 'need_line_unit_conversion_required', detail: null }],
      },
    });
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(stepOf()).toBe('pending');
    expect(screen.getByTestId('cn2b-simple-readiness-messages')).toBeInTheDocument();
    expect(screen.queryByTestId('cn2b-simple-readiness-clear')).toBeNull();
  });
});

/**
 * Director finding 5: `manualStep` was the one piece of navigation state that
 * was NOT dataset-keyed, so a manually-reopened summary could outlive the
 * dataset it described and override a fresh derived step. It has been removed
 * entirely; the dataset-keyed acknowledgement is now the only navigation state.
 */
describe('Simple Mode — a manually-reopened summary can never go stale (Director finding 5)', () => {
  const analyzed: Partial<WorkspaceProps> = {
    revision: revisionOf('draft'),
    isDraft: true,
    revisionDataReady: true,
    beneficiaryColumns: [bcol({ columnIndex: 2 })],
    records: [rec({ id: 'r1', targetEntity: 'sheet:0:row:5' })],
  };

  const stepOf = () => screen.getByTestId('cn2b-simple-workspace').getAttribute('data-step');

  /** Advances past the summary, then deliberately navigates back to it. */
  function renderAtManualSummary(over: Partial<WorkspaceProps> = {}) {
    const view = renderWorkspace({ ...analyzed, ...over });
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(stepOf()).toBe('review-institution');
    fireEvent.click(screen.getByText('الرجوع إلى الملخص'));
    expect(stepOf()).toBe('summary');
    return view;
  }

  it('1. review → Back to Summary works, and the summary is fully rendered', () => {
    renderAtManualSummary();
    expect(screen.getByTestId('cn2b-simple-summary-read')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-summary-scope-title')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-review-start')).toBeInTheDocument();
  });

  it('2. from a manually-returned summary, switching session shows the NEW dataset summary', () => {
    const { rerenderWith } = renderAtManualSummary({ activeSessionId: 's1' });
    rerenderWith({ activeSessionId: 's2' });
    expect(stepOf()).toBe('summary');
    // And it is the new dataset's summary: advancing reviews the new session.
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(stepOf()).toBe('review-institution');
  });

  it('3. from a manually-returned summary, switching revision shows the NEW revision summary', () => {
    const { rerenderWith } = renderAtManualSummary();
    rerenderWith({ revision: { ...revisionOf('draft'), id: 'rev-2' } });
    expect(stepOf()).toBe('summary');
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(stepOf()).toBe('review-institution');
  });

  it('4. a CLOSED revision outranks a manually-returned summary — the correction UI wins', () => {
    const { rerenderWith } = renderAtManualSummary();
    rerenderWith({ revision: revisionOf('approved'), isDraft: false });
    expect(stepOf()).toBe('upload');
    expect(screen.getByTestId('cn2b-simple-closed-notice')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-create-correction')).toBeInTheDocument();
    expect(screen.queryByTestId('cn2b-simple-summary-read')).toBeNull();
  });

  it('5a. unready data outranks a manually-returned summary — analyzing wins', () => {
    const { rerenderWith } = renderAtManualSummary();
    rerenderWith({ revisionDataReady: false });
    expect(stepOf()).toBe('analyzing');
    expect(screen.queryByTestId('cn2b-simple-summary-read')).toBeNull();
  });

  it('5b. a parsing preview outranks a manually-returned summary — analyzing wins', () => {
    const { rerenderWith } = renderAtManualSummary();
    rerenderWith({ preview: { phase: 'parsing', filename: 'need-2026.zip' } });
    expect(stepOf()).toBe('analyzing');
  });

  it('5c. a busy revision outranks a manually-returned summary — analyzing wins', () => {
    const { rerenderWith } = renderAtManualSummary();
    rerenderWith({ busy: true });
    expect(stepOf()).toBe('analyzing');
  });

  it('5d. losing the revision entirely outranks it — upload wins', () => {
    const { rerenderWith } = renderAtManualSummary();
    rerenderWith({ revision: null });
    expect(stepOf()).toBe('upload');
  });

  it('6. unresolved work is still never skipped — after any of the above, review resumes', () => {
    const { rerenderWith } = renderAtManualSummary();
    // Go unready, come back ready: the unresolved column is still queued.
    rerenderWith({ revisionDataReady: false });
    expect(stepOf()).toBe('analyzing');
    rerenderWith({ revisionDataReady: true });
    expect(stepOf()).toBe('summary');
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(stepOf()).toBe('review-institution');
    expect(screen.getByTestId('cn2b-simple-institution-progress')).toHaveTextContent('1');
  });

});

describe('Simple Mode — summary scope cannot claim revision-wide totals (Director finding 3)', () => {
  function renderSummary() {
    // Since defect 4 was fixed the summary is the FIRST step a newly analyzed
    // dataset lands on, so no navigation is needed to reach it.
    return renderWorkspace({
      revision: revisionOf('draft'),
      isDraft: true,
      beneficiaryColumns: [
        bcol({ columnIndex: 2, decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', reviewRequired: false }),
        bcol({ columnIndex: 3 }),
      ],
      records: [rec({ id: 'r1', targetEntity: 'sheet:0:row:5' })],
      dispositions: [disp({ targetEntity: 'sheet:0:row:5' })],
    });
  }

  it('titles the card as the CURRENT WORK SESSION, not the whole annual need', () => {
    renderSummary();
    const title = screen.getByTestId('cn2b-simple-summary-scope-title');
    expect(title).toBeInTheDocument();
    expect(title.textContent ?? '').toMatch(/جلسة العمل الحالية/);
  });

  it('marks the session-scoped metrics as this-file-only and the revision-wide one as such', () => {
    renderSummary();
    expect(screen.getByTestId('cn2b-simple-scope-materials').textContent ?? '').toMatch(/في هذا الملف فقط/);
    expect(screen.getByTestId('cn2b-simple-scope-quantities').textContent ?? '').toMatch(/في هذا الملف فقط/);
    expect(screen.getByTestId('cn2b-simple-scope-institutions').textContent ?? '')
      .toMatch(/في كامل الاحتياج السنوي/);
  });

  it('states in words that the material/quantity figures are not whole-annual-need totals', () => {
    renderSummary();
    const note = screen.getByTestId('cn2b-simple-summary-scope-note');
    expect(note.textContent ?? '').toMatch(/ليست مجموع الاحتياج السنوي بالكامل/);
  });

  it('every session-scoped count carries a scope marker — none is presented bare', () => {
    renderSummary();
    for (const id of ['cn2b-simple-count-materials', 'cn2b-simple-count-quantities']) {
      const dd = screen.getByTestId(id);
      const dt = dd.parentElement?.querySelector('dt');
      expect(dt, id).not.toBeNull();
      expect(dt?.textContent ?? '', id).toMatch(/في هذا الملف فقط/);
    }
  });
});
