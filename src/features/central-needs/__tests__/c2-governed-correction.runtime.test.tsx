/** @vitest-environment jsdom */
/**
 * C2 — Governed Correction Lifecycle, UI contract, proven against the REAL
 * `CentralNeedsScreen` with only the service boundary and `useApp` mocked (the
 * idiom of the C1 runtime suite).
 *
 *   * A correction names "year YYYY / revision N", asks for a human reason and
 *     sends the SELECTED revision's own year and id (the server's stale fence).
 *   * Cancel and blank reasons send nothing.
 *   * A stale refusal is surfaced, the registry is re-read, and the request is
 *     NEVER retried.
 *   * A correction is withheld (and says why) when a newer revision of the same
 *     plan exists, or when the selected revision is not yet decided.
 *   * Simple and Advanced Mode behave the same.
 *   * The lifecycle history is read only on request.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type {
  BeneficiaryColumnSummary, FieldOverride, ImportBatch, NeedLine, NeedLineSourceLink,
  PlanRevision, RevisionStatus, ReviewReadiness, RevisionLifecycle,
} from '../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

const ORG = 'org-1';
const REASON = 'hospital resubmitted its annual return';

const appState = {
  lang: 'en' as 'ar' | 'en',
  dir: 'ltr' as 'rtl' | 'ltr',
  activeOrgId: ORG as string | null,
  profile: { organization_id: ORG } as { organization_id: string | null } | null,
  myPermissions: new Set(['central_needs.view', 'central_needs.import', 'central_needs.edit', 'central_needs.approve']),
};

const listPlanRevisions = vi.fn();
const listImportSessions = vi.fn();
const listImportBatches = vi.fn();
const listOverrides = vi.fn();
const fetchReviewReadiness = vi.fn();
const listNeedLineLineage = vi.fn();
const listBeneficiaryColumns = vi.fn();
const listSourceRecords = vi.fn();
const listDispositions = vi.fn();
const openPlanRevision = vi.fn();
const openCorrectionRevision = vi.fn();
const fetchRevisionLifecycle = vi.fn();
const getOrganizations = vi.fn();

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/supabase/services/organizations.service', () => ({ getOrganizations: () => getOrganizations() }));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({ getWarehouses: async () => [] }));
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  return {
    ...actual,
    listPlanRevisions: (...a: unknown[]) => listPlanRevisions(...(a as [string])),
    listImportSessions: (...a: unknown[]) => listImportSessions(...(a as [string])),
    listImportBatches: (...a: unknown[]) => listImportBatches(...(a as [string])),
    listOverrides: (...a: unknown[]) => listOverrides(...(a as [string])),
    fetchReviewReadiness: (...a: unknown[]) => fetchReviewReadiness(...(a as [string])),
    listNeedLineLineage: (...a: unknown[]) => listNeedLineLineage(...(a as [string])),
    listBeneficiaryColumns: (...a: unknown[]) => listBeneficiaryColumns(...(a as [string])),
    listSourceRecords: (...a: unknown[]) => listSourceRecords(...(a as [string])),
    listDispositions: (...a: unknown[]) => listDispositions(...(a as [string])),
    openPlanRevision: (...a: unknown[]) => openPlanRevision(...a),
    openCorrectionRevision: (...a: unknown[]) => openCorrectionRevision(...a),
    fetchRevisionLifecycle: (...a: unknown[]) => fetchRevisionLifecycle(...a),
    setBeneficiaryColumns: vi.fn(async () => ({ confirmed: [] })),
    recordFieldOverride: vi.fn(),
    searchCentralItems: vi.fn(async () => []),
    setRecordDisposition: vi.fn(),
    searchBatchEntries: vi.fn(async () => []),
    searchSourceFiles: vi.fn(async () => []),
  };
});

const { CentralNeedsScreen } = await import('../CentralNeedsScreen');
const { stageDomId } = await import('../CentralNeedsWorkflowNav');
const { CentralNeedsError } = await import('../central-needs.service');

const rev = (id: string, planYear: number, revisionNumber: number, status: RevisionStatus): PlanRevision => ({
  id, planId: `plan-${planYear}`, organizationId: ORG, planYear, revisionNumber, status,
});

function loadRegistry(revisions: PlanRevision[]) {
  listPlanRevisions.mockResolvedValue(revisions);
  listImportSessions.mockResolvedValue([]);
  listImportBatches.mockResolvedValue([] as ImportBatch[]);
  listOverrides.mockResolvedValue([] as FieldOverride[]);
  fetchReviewReadiness.mockImplementation(async (id: string) => ({
    planRevisionId: id,
    status: revisions.find((r) => r.id === id)?.status ?? 'draft',
    ready: false,
    blockers: [{ blocker: 'no_finalized_import', detail: null }],
  }) as ReviewReadiness);
  listNeedLineLineage.mockResolvedValue({ needLines: [] as NeedLine[], sources: [] as NeedLineSourceLink[] });
  listBeneficiaryColumns.mockResolvedValue([] as BeneficiaryColumnSummary[]);
  listSourceRecords.mockResolvedValue([]);
  listDispositions.mockResolvedValue([]);
  getOrganizations.mockResolvedValue([] as OrgRow[]);
  openCorrectionRevision.mockImplementation(async (_org: string, planYear: number, expected: string) => ({
    planRevisionId: 'rev-correction', revisionNumber: 99, planYear,
    openedAfterRevisionId: expected, effectiveApprovedRevisionId: null,
  }));
}

async function showPlanStage(): Promise<HTMLElement> {
  const nav = await screen.findByRole('navigation', { name: T.cn2b_workflow_label.en });
  fireEvent.click(within(nav).getByRole('button', { name: new RegExp(T.cn2b_stage_plan.en, 'i') }));
  const planStage = document.getElementById(stageDomId('plan')) as HTMLElement;
  await waitFor(() => expect(planStage).not.toHaveAttribute('hidden'));
  return planStage;
}

async function renderAdvanced(firstRevisionId: string) {
  const view = render(<CentralNeedsScreen initialMode="advanced" />);
  await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledWith(firstRevisionId));
  const planStage = await showPlanStage();
  return { ...view, planStage };
}

async function switchRevision(planStage: HTMLElement, revisionId: string): Promise<HTMLElement> {
  fireEvent.change(within(planStage).getByRole('combobox', { hidden: true }), { target: { value: revisionId } });
  await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledWith(revisionId));
  return showPlanStage();
}

const control = (planStage: HTMLElement) => within(planStage).getByTestId('cn2b-open-next-revision');
let prompt: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  appState.lang = 'en';
  appState.dir = 'ltr';
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  prompt = vi.spyOn(window, 'prompt').mockReturnValue(REASON);
});
afterEach(() => cleanup());

describe('C2 — Advanced Mode correction', () => {
  it('names year and revision, asks for the reason naming them, and sends the selected revision trimmed', async () => {
    loadRegistry([rev('rev-2025', 2025, 1, 'approved')]);
    prompt.mockReturnValue(`   ${REASON}   `);
    const { planStage } = await renderAdvanced('rev-2025');
    expect(control(planStage)).toHaveTextContent('Open next revision — correction of year 2025 / revision 1');
    expect(control(planStage)).toHaveAttribute('data-target-revision', '1');
    expect(within(planStage).getByText(T.cn2b_correction_keeps_effective.en)).toBeInTheDocument();
    fireEvent.click(control(planStage));
    await waitFor(() => expect(openCorrectionRevision).toHaveBeenCalledTimes(1));
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('Correction of year 2025 / revision 1.'));
    expect(openCorrectionRevision).toHaveBeenCalledWith(ORG, 2025, 'rev-2025', REASON);
    expect(openPlanRevision).not.toHaveBeenCalled();
    expect(await screen.findByText(T.cn2b_notice_correction_opened.en)).toBeInTheDocument();
    // The registry is re-read after the correction opens.
    expect(listPlanRevisions.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a cancelled prompt sends nothing', async () => {
    loadRegistry([rev('rev-2025', 2025, 1, 'approved')]);
    prompt.mockReturnValue(null);
    const { planStage } = await renderAdvanced('rev-2025');
    fireEvent.click(control(planStage));
    await new Promise((r) => setTimeout(r, 20));
    expect(openCorrectionRevision).not.toHaveBeenCalled();
  });

  it('a blank reason sends nothing and says a reason is required', async () => {
    loadRegistry([rev('rev-2025', 2025, 1, 'approved')]);
    prompt.mockReturnValue('   \t ');
    const { planStage } = await renderAdvanced('rev-2025');
    fireEvent.click(control(planStage));
    expect(await screen.findByText(T.cn2b_err_correction_reason_required.en)).toBeInTheDocument();
    expect(openCorrectionRevision).not.toHaveBeenCalled();
  });

  it('a stale refusal is surfaced, the registry is re-read, and the request is never retried', async () => {
    loadRegistry([rev('rev-2025', 2025, 1, 'approved')]);
    openCorrectionRevision.mockRejectedValue(new CentralNeedsError('central_needs_revision_stale'));
    const { planStage } = await renderAdvanced('rev-2025');
    const readsBefore = listPlanRevisions.mock.calls.length;
    fireEvent.click(control(planStage));
    expect(await screen.findByText(T.cn2b_err_central_needs_revision_stale.en)).toBeInTheDocument();
    await waitFor(() => expect(listPlanRevisions.mock.calls.length).toBeGreaterThan(readsBefore));
    await new Promise((r) => setTimeout(r, 50));
    expect(openCorrectionRevision).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('withholds the correction from an older revision while a newer one of the same plan exists', async () => {
    // Newest first, as the registry orders it: Rev2 (rejected) is newest in plan 2025.
    loadRegistry([rev('rev-2025-2', 2025, 2, 'rejected'), rev('rev-2025-1', 2025, 1, 'approved')]);
    const { planStage: first } = await renderAdvanced('rev-2025-2');
    expect(control(first)).not.toBeDisabled();
    const planStage = await switchRevision(first, 'rev-2025-1');
    expect(control(planStage)).toBeDisabled();
    expect(within(planStage).getByTestId('cn2b-correction-newer-revision'))
      .toHaveTextContent(T.cn2b_correction_newer_revision_exists.en.replace('__N__', '2'));
    fireEvent.click(control(planStage));
    await new Promise((r) => setTimeout(r, 20));
    expect(openCorrectionRevision).not.toHaveBeenCalled();
    // Back on the newest revision the correction follows IT.
    const back = await switchRevision(planStage, 'rev-2025-2');
    fireEvent.click(control(back));
    await waitFor(() => expect(openCorrectionRevision).toHaveBeenCalledTimes(1));
    expect(openCorrectionRevision).toHaveBeenCalledWith(ORG, 2025, 'rev-2025-2', REASON);
  });

  it('revisions of OTHER plan years never withhold a correction', async () => {
    loadRegistry([rev('rev-2026', 2026, 3, 'approved'), rev('rev-2025', 2025, 1, 'approved')]);
    const { planStage: first } = await renderAdvanced('rev-2026');
    const planStage = await switchRevision(first, 'rev-2025');
    expect(control(planStage)).not.toBeDisabled();
    expect(within(planStage).queryByTestId('cn2b-correction-newer-revision')).toBeNull();
  });
});

describe('C2 — Simple Mode parity', () => {
  it('names the correction target, keeps the approved revision in effect, and sends the selected revision', async () => {
    loadRegistry([rev('rev-2024', 2024, 2, 'approved')]);
    render(<CentralNeedsScreen />);
    const button = await screen.findByTestId('cn2b-simple-create-correction');
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(screen.getByTestId('cn2b-simple-correction-target'))
      .toHaveTextContent('Correction of year 2024 / revision 2.');
    expect(screen.getByTestId('cn2b-simple-correction-target')).toHaveTextContent(T.cn2b_correction_keeps_effective.en);
    fireEvent.click(button);
    await waitFor(() => expect(openCorrectionRevision).toHaveBeenCalledTimes(1));
    expect(openCorrectionRevision).toHaveBeenCalledWith(ORG, 2024, 'rev-2024', REASON);
  });

  it('withholds the correction for an older revision selected in Advanced Mode, and says why', async () => {
    loadRegistry([rev('rev-2025-2', 2025, 2, 'rejected'), rev('rev-2025-1', 2025, 1, 'approved')]);
    const { planStage } = await renderAdvanced('rev-2025-2');
    await switchRevision(planStage, 'rev-2025-1');
    fireEvent.click(screen.getByTestId('cn2b-mode-toggle'));
    const button = await screen.findByTestId('cn2b-simple-create-correction');
    expect(button).toBeDisabled();
    expect(screen.getByTestId('cn2b-simple-correction-newer-revision'))
      .toHaveTextContent(T.cn2b_correction_newer_revision_exists.en.replace('__N__', '2'));
  });

  it('a revision still in review cannot be corrected yet', async () => {
    loadRegistry([rev('rev-2025', 2025, 2, 'submitted')]);
    render(<CentralNeedsScreen />);
    const button = await screen.findByTestId('cn2b-simple-create-correction');
    await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledWith('rev-2025'));
    expect(button).toBeDisabled();
    fireEvent.click(button);
    await new Promise((r) => setTimeout(r, 20));
    expect(openCorrectionRevision).not.toHaveBeenCalled();
  });
});

describe('C2 — lifecycle history', () => {
  it('is read only on request and states the correction lineage', async () => {
    loadRegistry([rev('rev-2025-2', 2025, 2, 'approved'), rev('rev-2025-1', 2025, 1, 'superseded')]);
    const history: RevisionLifecycle = {
      planId: 'plan-2025', planYear: 2025, effectiveRevisionId: 'rev-2025-2',
      revisions: [
        { id: 'rev-2025-1', revisionNumber: 1, status: 'superseded', effective: false },
        { id: 'rev-2025-2', revisionNumber: 2, status: 'approved', effective: true },
      ],
      events: [
        { action: 'open', revisionId: 'rev-2025-1', revisionNumber: 1, occurredAt: '2026-01-01T08:00:00Z', actorId: 'u', actorRole: 'central_warehouse_manager', fromStatus: null, toStatus: null, reason: null, openedAfterRevisionId: null, effectiveApprovedRevisionId: null, predecessorRevisionId: null, supersededByRevisionId: null },
        { action: 'open_correction', revisionId: 'rev-2025-2', revisionNumber: 2, occurredAt: '2026-02-01T08:00:00Z', actorId: 'u', actorRole: 'central_warehouse_manager', fromStatus: null, toStatus: null, reason: 'recount', openedAfterRevisionId: 'rev-2025-1', effectiveApprovedRevisionId: 'rev-2025-1', predecessorRevisionId: null, supersededByRevisionId: null },
        { action: 'supersede', revisionId: 'rev-2025-1', revisionNumber: 1, occurredAt: '2026-03-01T08:00:00Z', actorId: 'a', actorRole: 'central_warehouse_manager', fromStatus: 'approved', toStatus: 'superseded', reason: null, openedAfterRevisionId: null, effectiveApprovedRevisionId: null, predecessorRevisionId: null, supersededByRevisionId: 'rev-2025-2' },
        { action: 'approve', revisionId: 'rev-2025-2', revisionNumber: 2, occurredAt: '2026-03-01T08:00:00Z', actorId: 'a', actorRole: 'central_warehouse_manager', fromStatus: 'submitted', toStatus: 'approved', reason: null, openedAfterRevisionId: null, effectiveApprovedRevisionId: null, predecessorRevisionId: 'rev-2025-1', supersededByRevisionId: null },
      ],
    };
    fetchRevisionLifecycle.mockResolvedValue(history);
    const { planStage } = await renderAdvanced('rev-2025-2');
    const section = within(planStage).getByTestId('cn2b-revision-history');
    expect(fetchRevisionLifecycle).not.toHaveBeenCalled();
    fireEvent.click(within(section).getByRole('button', { name: T.cn2b_history_show.en }));
    await waitFor(() => expect(fetchRevisionLifecycle).toHaveBeenCalledWith(ORG, 2025));
    expect(await within(section).findByText('Revision 2 opened as a correction after revision 1')).toBeInTheDocument();
    expect(within(section).getByText('Reason: recount')).toBeInTheDocument();
    expect(within(section).getByText('Revision 1 superseded by revision 2')).toBeInTheDocument();
    expect(within(section).getByText('Revision 2 approved, replacing revision 1')).toBeInTheDocument();
  });
});
