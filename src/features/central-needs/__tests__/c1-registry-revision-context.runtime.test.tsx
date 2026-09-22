/** @vitest-environment jsdom */
/**
 * C1 — Registry + Revision Context, proven against the REAL `CentralNeedsScreen`
 * with only the service boundary and `useApp` mocked (the idiom of
 * cn2b-ux1-workspace-shell and simple-default-mode).
 *
 * PD-1 (HIGH): an explicit correction / open-next request must target the
 * SELECTED revision's own plan year. The screen used to pass an independent
 * `planYear` state (seeded from the calendar year and edited through the
 * new-draft year input), so a closed revision of year X could request a
 * successor for year Y. The PD-1 tests below deliberately use only selectors
 * that already existed before C1, so the same file demonstrates the defect on
 * the baseline and its absence after the fix.
 *
 * What C1 does NOT change is asserted nowhere here: the server lifecycle
 * (M210's supersession timing, stale fence, correction reason) is C2.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type {
  BeneficiaryColumnSummary, FieldOverride, ImportBatch, NeedLine, NeedLineSourceLink,
  PlanRevision, RevisionStatus, ReviewReadiness,
} from '../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

const ORG = 'org-1';

interface AppState {
  lang: 'ar' | 'en';
  dir: 'rtl' | 'ltr';
  activeOrgId: string | null;
  profile: { organization_id: string | null } | null;
  myPermissions: Set<string>;
}

const appState: AppState = {
  lang: 'en', dir: 'ltr', activeOrgId: ORG,
  profile: { organization_id: ORG },
  myPermissions: new Set(['central_needs.import', 'central_needs.edit', 'central_needs.approve']),
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

/** The screen seeds its new-draft year from the real calendar; the tests read it the same way. */
const THIS_YEAR = new Date().getFullYear();

const rev = (id: string, planYear: number | null, revisionNumber: number, status: RevisionStatus): PlanRevision => ({
  id, planId: `plan-${planYear ?? 'unknown'}`, organizationId: ORG, planYear, revisionNumber, status,
});

/** The registry exactly as `listPlanRevisions` hands it over: newest plan year first. */
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
  openPlanRevision.mockImplementation(async (_org: string, planYear: number) => ({
    planRevisionId: 'rev-opened', revisionNumber: 99, planYear, idempotent: false,
  }));
}

/**
 * Shows the Plan-and-revision stage the way a person does: through the stage
 * navigation. A revision switch resets the workspace (existing, pre-C1
 * behaviour: `resetRevisionScopedState`), so the stage is shown again after it.
 */
async function showPlanStage(): Promise<HTMLElement> {
  const nav = await screen.findByRole('navigation', { name: T.cn2b_workflow_label.en });
  fireEvent.click(within(nav).getByRole('button', { name: new RegExp(T.cn2b_stage_plan.en, 'i') }));
  const planStage = document.getElementById(stageDomId('plan')) as HTMLElement;
  await waitFor(() => expect(planStage).not.toHaveAttribute('hidden'));
  return planStage;
}

/** Advanced Mode, painted, with the Plan-and-revision stage selected. */
async function renderAdvanced(firstRevisionId: string | null) {
  const view = render(<CentralNeedsScreen initialMode="advanced" />);
  await waitFor(() => expect(listPlanRevisions).toHaveBeenCalled());
  if (firstRevisionId !== null) {
    await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledWith(firstRevisionId));
  }
  const planStage = await showPlanStage();
  return { ...view, planStage };
}

/** The Advanced "open next revision" control, found by the label it carried before C1 too. */
const openNextButton = (planStage: HTMLElement) =>
  within(planStage).getByRole('button', { name: /^Open next revision/ });

/**
 * `hidden: true` because a revision switch hides the stage sections until the
 * workspace re-resolves (pre-C1 behaviour); the select itself is unchanged.
 */
function selectRevision(planStage: HTMLElement, revisionId: string) {
  fireEvent.change(within(planStage).getByRole('combobox', { hidden: true }), { target: { value: revisionId } });
}

/** Switches the selected revision, waits for its reload, and shows the Plan stage again. */
async function switchRevision(planStage: HTMLElement, revisionId: string): Promise<HTMLElement> {
  selectRevision(planStage, revisionId);
  await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledWith(revisionId));
  return showPlanStage();
}

function typeDraftYear(planStage: HTMLElement, year: number) {
  fireEvent.change(within(planStage).getByRole('spinbutton'), { target: { value: String(year) } });
}

/** Simple Mode, painted, with the correction control enabled once the registry has loaded. */
async function renderSimpleClosed() {
  const view = render(<CentralNeedsScreen />);
  const button = await screen.findByTestId('cn2b-simple-create-correction');
  await waitFor(() => expect(listPlanRevisions).toHaveBeenCalled());
  return { ...view, button };
}

beforeEach(() => {
  vi.clearAllMocks();
  appState.lang = 'en';
  appState.dir = 'ltr';
  appState.myPermissions = new Set(['central_needs.import', 'central_needs.edit', 'central_needs.approve']);
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});
afterEach(() => cleanup());

// ============================================================================
// PD-1 — Advanced Mode: the selected revision's year outranks the draft-year input.
// ============================================================================
describe('C1 / PD-1 — Advanced Mode correction targets the SELECTED revision year', () => {
  it('A) draft-year input 2026, selected closed revision of 2025 -> requests 2025, exactly once', async () => {
    loadRegistry([rev('rev-2025', 2025, 1, 'approved')]);
    const { planStage } = await renderAdvanced('rev-2025');
    typeDraftYear(planStage, 2026);
    fireEvent.click(openNextButton(planStage));
    await waitFor(() => expect(openPlanRevision).toHaveBeenCalledTimes(1));
    expect(openPlanRevision).toHaveBeenCalledWith(ORG, 2025, true);
  });

  it('B) draft-year input 2027, selected rejected revision of 2024 -> requests 2024', async () => {
    loadRegistry([rev('rev-2024', 2024, 2, 'rejected')]);
    const { planStage } = await renderAdvanced('rev-2024');
    typeDraftYear(planStage, 2027);
    fireEvent.click(openNextButton(planStage));
    await waitFor(() => expect(openPlanRevision).toHaveBeenCalledTimes(1));
    expect(openPlanRevision).toHaveBeenCalledWith(ORG, 2024, true);
  });

  it('D) switching the selected revision re-targets the correction, whatever the draft-year input says', async () => {
    loadRegistry([rev('rev-2026', 2026, 2, 'approved'), rev('rev-2025', 2025, 1, 'approved')]);
    const { planStage: first } = await renderAdvanced('rev-2026');
    typeDraftYear(first, 2030);
    const planStage = await switchRevision(first, 'rev-2025');
    // The draft-year input is untouched by the switch; it still says 2030.
    expect(within(planStage).getByRole('spinbutton')).toHaveValue(2030);
    fireEvent.click(openNextButton(planStage));
    await waitFor(() => expect(openPlanRevision).toHaveBeenCalledTimes(1));
    expect(openPlanRevision).toHaveBeenCalledWith(ORG, 2025, true);
  });

  it('E) a selected revision with no trustworthy plan year never borrows the draft-year input', async () => {
    loadRegistry([rev('rev-unknown', null, 1, 'approved')]);
    const { planStage } = await renderAdvanced('rev-unknown');
    typeDraftYear(planStage, 2026);
    const button = openNextButton(planStage);
    fireEvent.click(button);
    // Give any (wrong) asynchronous request every chance to be issued.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openPlanRevision).not.toHaveBeenCalled();
  });
});

// ============================================================================
// PD-1 — Simple Mode: no year input is shown for a loaded revision, so the
// defect used the calendar year seeded into the parent's `planYear`.
// ============================================================================
describe('C1 / PD-1 — Simple Mode correction targets the SELECTED revision year', () => {
  it('a closed revision two years back requests ITS year, not the calendar year, exactly once', async () => {
    const year = THIS_YEAR - 2;
    loadRegistry([rev('rev-old', year, 3, 'approved')]);
    const { button } = await renderSimpleClosed();
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(openPlanRevision).toHaveBeenCalledTimes(1));
    expect(openPlanRevision).toHaveBeenCalledWith(ORG, year, true);
  });

  it('a revision chosen in Advanced Mode stays the correction target after switching back to Simple Mode', async () => {
    loadRegistry([rev('rev-2026', 2026, 2, 'approved'), rev('rev-2025', 2025, 1, 'rejected')]);
    const { planStage } = await renderAdvanced('rev-2026');
    typeDraftYear(planStage, 2031);
    await switchRevision(planStage, 'rev-2025');
    fireEvent.click(screen.getByTestId('cn2b-mode-toggle'));
    const button = await screen.findByTestId('cn2b-simple-create-correction');
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(openPlanRevision).toHaveBeenCalledTimes(1));
    expect(openPlanRevision).toHaveBeenCalledWith(ORG, 2025, true);
  });

  it('E) a closed revision with no trustworthy plan year cannot be corrected with the calendar year', async () => {
    loadRegistry([rev('rev-unknown', null, 1, 'approved')]);
    const { button } = await renderSimpleClosed();
    await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledWith('rev-unknown'));
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openPlanRevision).not.toHaveBeenCalled();
    // And the calendar year is never presented as this revision's year.
    expect(screen.getByTestId('cn2b-simple-upload')).not.toHaveTextContent(String(THIS_YEAR));
  });
});

// ============================================================================
// C) The first / current annual draft stays the EXPLICIT human-chosen year.
// ============================================================================
describe('C1 — a new or current annual draft still uses the explicit year input', () => {
  it('C) Simple Mode, no revision yet: the chosen year 2027 opens the draft for 2027', async () => {
    loadRegistry([]);
    render(<CentralNeedsScreen />);
    const start = await screen.findByTestId('cn2b-simple-start');
    await waitFor(() => expect(start).not.toBeDisabled());
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2027' } });
    fireEvent.click(start);
    await waitFor(() => expect(openPlanRevision).toHaveBeenCalledTimes(1));
    expect(openPlanRevision).toHaveBeenCalledWith(ORG, 2027, false);
  });

  it('C) Advanced Mode, no revision yet: the chosen year 2027 opens the draft for 2027', async () => {
    loadRegistry([]);
    const { planStage } = await renderAdvanced(null);
    typeDraftYear(planStage, 2027);
    fireEvent.click(within(planStage).getByRole('button', { name: T.cn2b_open_draft.en }));
    await waitFor(() => expect(openPlanRevision).toHaveBeenCalledTimes(1));
    expect(openPlanRevision).toHaveBeenCalledWith(ORG, 2027, false);
  });

  it('Advanced "open annual draft" keeps its own year even while a closed revision of another year is selected', async () => {
    loadRegistry([rev('rev-2025', 2025, 1, 'approved')]);
    const { planStage } = await renderAdvanced('rev-2025');
    typeDraftYear(planStage, 2027);
    fireEvent.click(within(planStage).getByRole('button', { name: T.cn2b_open_draft.en }));
    await waitFor(() => expect(openPlanRevision).toHaveBeenCalledTimes(1));
    expect(openPlanRevision).toHaveBeenCalledWith(ORG, 2027, false);
  });
});

// ============================================================================
// Explicit action only.
// ============================================================================
describe('C1 — a correction is never created by rendering', () => {
  it('Simple Mode renders a closed revision and requests nothing', async () => {
    loadRegistry([rev('rev-2025', 2025, 1, 'approved')]);
    await renderSimpleClosed();
    await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledWith('rev-2025'));
    expect(openPlanRevision).not.toHaveBeenCalled();
  });

  it('Advanced Mode renders a closed revision and requests nothing', async () => {
    loadRegistry([rev('rev-2025', 2025, 1, 'rejected')]);
    await renderAdvanced('rev-2025');
    expect(openPlanRevision).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Visible revision context (new in C1).
// ============================================================================
describe('C1 — the selected revision context is stated from the revision itself', () => {
  it('Simple Mode (EN) states plan year, revision number and status of the selected revision', async () => {
    loadRegistry([rev('rev-2025', 2025, 3, 'approved')]);
    render(<CentralNeedsScreen />);
    const context = await screen.findByTestId('cn2b-simple-revision-context');
    expect(context).toHaveAttribute('data-plan-year', '2025');
    expect(context).toHaveAttribute('data-revision-number', '3');
    expect(context).toHaveAttribute('data-status', 'approved');
    expect(context).toHaveTextContent('2025');
    expect(context).toHaveTextContent(`${T.cn2b_revision.en} 3`);
    expect(context).toHaveTextContent(T.cn2b_revstatus_approved.en);
  });

  it('Simple Mode (AR) states the same context in Arabic', async () => {
    appState.lang = 'ar';
    appState.dir = 'rtl';
    loadRegistry([rev('rev-2024', 2024, 2, 'rejected')]);
    render(<CentralNeedsScreen />);
    const context = await screen.findByTestId('cn2b-simple-revision-context');
    expect(context).toHaveAttribute('data-plan-year', '2024');
    expect(context).toHaveTextContent('2024');
    expect(context).toHaveTextContent(`${T.cn2b_revision.ar} 2`);
    expect(context).toHaveTextContent(T.cn2b_revstatus_rejected.ar);
  });

  it('Simple Mode states an unavailable plan year as unavailable, never as the calendar year', async () => {
    loadRegistry([rev('rev-unknown', null, 1, 'approved')]);
    render(<CentralNeedsScreen />);
    const context = await screen.findByTestId('cn2b-simple-revision-context');
    expect(context).toHaveAttribute('data-plan-year', '');
    expect(context).not.toHaveTextContent(String(THIS_YEAR));
    expect(await screen.findByTestId('cn2b-simple-correction-year-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-create-correction')).toBeDisabled();
  });

  it('Advanced Mode names the target year on the open-next control and follows the selection synchronously', async () => {
    loadRegistry([rev('rev-2026', 2026, 2, 'approved'), rev('rev-2025', 2025, 1, 'approved')]);
    const { planStage } = await renderAdvanced('rev-2026');
    // Queried by test id: a revision switch hides the stage sections until the
    // workspace re-resolves (pre-C1 behaviour), and the claim here is about the
    // SAME commit as the selection, before any reload has resolved.
    const control = () => within(planStage).getByTestId('cn2b-open-next-revision');
    expect(control()).toHaveAttribute('data-target-year', '2026');
    expect(control()).toHaveTextContent('2026');
    selectRevision(planStage, 'rev-2025');
    expect(control()).toHaveAttribute('data-target-year', '2025');
    expect(control()).toHaveTextContent('2025');
    selectRevision(planStage, 'rev-2026');
    expect(control()).toHaveAttribute('data-target-year', '2026');
  });

  it('Advanced Mode disables the open-next control and says why when the plan year is unavailable', async () => {
    loadRegistry([rev('rev-unknown', null, 1, 'approved')]);
    const { planStage } = await renderAdvanced('rev-unknown');
    expect(openNextButton(planStage)).toBeDisabled();
    expect(within(planStage).getByText(T.cn2b_err_revision_plan_year_unavailable.en)).toBeInTheDocument();
  });
});
