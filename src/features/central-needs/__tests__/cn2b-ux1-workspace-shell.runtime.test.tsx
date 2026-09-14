/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type {
  BeneficiaryColumnSummary, FieldOverride, ImportBatch, ImportSession,
  NeedLine, NeedLineSourceLink, PlanRevision, RecordDisposition, ReviewReadiness, SourceRecord,
} from '../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

/**
 * UX-1 — the Annual Needs WORKSPACE SHELL.
 *
 * This asserts the presentation contract of the redesign against the REAL
 * `CentralNeedsScreen`, with only the Supabase-backed service boundary and
 * `useApp` mocked. Two things it is deliberately built to catch:
 *
 *   1. A SHELL THAT HIDES WORK. UX-1 groups the existing panels into six
 *      stages; it must not turn them into tabs. Every stage section, and every
 *      panel that was mounted before, is asserted present at once — so a later
 *      change to conditional rendering fails here rather than silently
 *      changing which data the screen loads and when.
 *
 *   2. A SHELL THAT CHANGES AUTHORITY. The action gates stay exactly what they
 *      were: `central_needs.import` / `.edit` / `.approve`, read from EFFECTIVE
 *      permissions. Every render below supplies NO role at all, so an action
 *      that appeared because of a role name could not pass these tests.
 *
 * Horizontal-overflow freedom and computed direction are layout facts jsdom
 * cannot answer; those stay where they already are, in the real-browser
 * acceptance suite (tests/central-needs-cn2b.chromium.test.ts).
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const ORG = 'org-1';
const REV = 'rev-1';
const SESSION_ID = 's1';
const ROW = 'sheet:0:row:1';
const ITEM = '00000000-0000-0000-0000-0000000000a1';
const HOSPITAL_A = '00000000-0000-0000-0000-0000000000b1';

/** THE canonical stage order UX-1 ships. Spelled out, not imported, so a
 *  reordering of the source declaration has to be a deliberate edit here. */
const EXPECTED_STAGE_ORDER = ['plan', 'source', 'review', 'beneficiaries', 'need-lines', 'readiness'] as const;

interface AppState {
  lang: 'ar' | 'en';
  dir: 'rtl' | 'ltr';
  activeOrgId: string | null;
  profile: { organization_id: string | null } | null;
  myPermissions: Set<string>;
}

const ALL_PERMISSIONS = ['central_needs.import', 'central_needs.edit', 'central_needs.approve'];

/** Mutated per test; `useApp` reads it at render time, never at module load. */
const appState: AppState = {
  lang: 'en', dir: 'ltr', activeOrgId: ORG,
  profile: { organization_id: ORG },
  myPermissions: new Set(ALL_PERMISSIONS),
};

const listBeneficiaryColumns = vi.fn();
const listImportSessions = vi.fn();
const listImportBatches = vi.fn();
const listOverrides = vi.fn();
const fetchReviewReadiness = vi.fn();
const listNeedLineLineage = vi.fn();
const listSourceRecords = vi.fn();
const listDispositions = vi.fn();
const listPlanRevisions = vi.fn();
const getOrganizations = vi.fn();

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));

vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganizations: () => getOrganizations(),
}));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({
  getWarehouses: async () => [],
}));

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
    setBeneficiaryColumns: vi.fn(async () => ({ confirmed: [] })),
    recordFieldOverride: vi.fn(),
    searchCentralItems: vi.fn(async () => []),
    setRecordDisposition: vi.fn(),
    searchBatchEntries: vi.fn(async () => []),
    searchSourceFiles: vi.fn(async () => []),
  };
});

const { CentralNeedsScreen } = await import('../CentralNeedsScreen');
const { CENTRAL_NEEDS_STAGES, stageDomId } = await import('../CentralNeedsWorkflowNav');

const ORGS: OrgRow[] = [
  { id: HOSPITAL_A, name: 'Beneficiary Hospital', name_ar: 'مستشفى المنتفع', code: 'ha', status: 'active', organizationKind: 'care_institution' },
] as unknown as OrgRow[];

const REVISION: PlanRevision = { id: REV, planId: 'plan-1', organizationId: ORG, planYear: 2026, revisionNumber: 1, status: 'draft' };
const SESSION: ImportSession = {
  id: SESSION_ID, planRevisionId: REV, sourceFileId: 'f1', status: 'completed',
  previewDigest: 'digest', authoritativeDigest: 'digest', parserIdentity: null,
  startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', notes: null,
};
const BATCH: ImportBatch = {
  id: 'b1', planRevisionId: REV, containerFilename: 'need-2026.zip', containerKind: 'zip',
  containerSha256: 'a'.repeat(64), acceptedEntryCount: 1, excludedEntryCount: 0,
} as unknown as ImportBatch;
const READINESS: ReviewReadiness = {
  planRevisionId: REV, status: 'draft', ready: false,
  blockers: [{ blocker: 'target_entity_without_disposition', detail: ROW }],
} as unknown as ReviewReadiness;
const DISPOSITION: RecordDisposition = {
  id: 'd1', importSessionId: SESSION_ID, targetEntity: ROW,
  decision: 'mapped', centralItemId: ITEM, decisionReason: null, decidedAt: '2026-01-01T00:00:00.000Z',
};
const RECORD: SourceRecord = {
  id: 'rec-1', importSessionId: SESSION_ID, recordOrdinal: 1, targetEntity: ROW, fieldName: 'Hospital A',
  sourceValues: { value: 100 }, sourceProvenance: { sheetIndex: 0, coordinate: { col: 5 } },
};
const COLUMN: BeneficiaryColumnSummary = {
  importSessionId: SESSION_ID, originalFilename: 'need-2026.xlsx', archiveEntryPath: null,
  sheetIndex: 0, sheetName: 'Sheet1', columnIndex: 5, sourceFieldName: 'Hospital A',
  numericValueCount: 1, zeroValueCount: 0, nonzeroNumericCount: 1,
  mappingId: 'm-1', decision: 'beneficiary', beneficiaryOrganizationId: HOSPITAL_A,
  mappingReason: 'confirmed', mappedAt: '2026-01-02T00:00:00.000Z',
  mappedRowNumericCount: 1, reviewRequired: false,
};

let scrollIntoView: ReturnType<typeof vi.fn>;

function loadRevision(revision: PlanRevision = REVISION) {
  listPlanRevisions.mockResolvedValue([revision]);
  listImportSessions.mockResolvedValue([SESSION]);
  listImportBatches.mockResolvedValue([BATCH]);
  listOverrides.mockResolvedValue([] as FieldOverride[]);
  fetchReviewReadiness.mockResolvedValue(READINESS);
  listNeedLineLineage.mockResolvedValue({ needLines: [] as NeedLine[], sources: [] as NeedLineSourceLink[] });
  listBeneficiaryColumns.mockResolvedValue([COLUMN]);
  listDispositions.mockResolvedValue([DISPOSITION]);
  listSourceRecords.mockResolvedValue([RECORD]);
  getOrganizations.mockResolvedValue(ORGS);
}

/** Waits for the first revision-scoped read, i.e. a fully painted workspace. */
async function renderWorkspace() {
  const view = render(<CentralNeedsScreen />);
  await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledWith(REV));
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  appState.lang = 'en';
  appState.dir = 'ltr';
  appState.myPermissions = new Set(ALL_PERMISSIONS);
  loadRevision();
  // jsdom implements neither scrollIntoView nor IntersectionObserver. The
  // screen calls the first optionally and guards the second, so the shell has
  // to work without either — this stub only lets the test SEE the call.
  scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: scrollIntoView, writable: true, configurable: true,
  });
});
afterEach(() => cleanup());

// ============================================================================
// A. Six stages, in one declared order, always mounted.
// ============================================================================
describe('UX-1 — the six workflow stages', () => {
  it('declares exactly six stages, in the canonical order, with unique ids', () => {
    expect(CENTRAL_NEEDS_STAGES).toHaveLength(6);
    expect(CENTRAL_NEEDS_STAGES.map((s) => s.id)).toEqual([...EXPECTED_STAGE_ORDER]);
    expect(new Set(CENTRAL_NEEDS_STAGES.map((s) => s.id)).size).toBe(6);
  });

  it('renders all six stage sections, in document order, each labelled by its own heading', async () => {
    const { container } = await renderWorkspace();

    const sections = [...container.querySelectorAll<HTMLElement>('section.cn2b-stage')];
    expect(sections).toHaveLength(6);
    expect(sections.map((s) => s.dataset.stage)).toEqual([...EXPECTED_STAGE_ORDER]);
    expect(sections.map((s) => s.id)).toEqual(EXPECTED_STAGE_ORDER.map(stageDomId));

    // Each section is named by its own visible heading, and numbered 1..6.
    sections.forEach((section, index) => {
      const heading = document.getElementById(section.getAttribute('aria-labelledby') ?? '');
      expect(heading, section.id).not.toBeNull();
      expect(heading!.tagName).toBe('H2');
      expect(heading!).toHaveTextContent(String(index + 1));
      expect(heading!).toHaveTextContent(T[CENTRAL_NEEDS_STAGES[index].titleKey].en);
    });

    // Exactly one page title above them all.
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('keeps every stage MOUNTED — navigating never unmounts one', async () => {
    const { container } = await renderWorkspace();
    const ids = () => [...container.querySelectorAll<HTMLElement>('section.cn2b-stage')].map((s) => s.id);
    const before = ids();

    for (const stage of CENTRAL_NEEDS_STAGES) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(T[stage.titleKey].en, 'i') }));
      expect(ids(), stage.id).toEqual(before);
    }
    expect(before).toHaveLength(6);
  });

  it('renders all six stages even with no revision, no session and no permissions at all', async () => {
    appState.myPermissions = new Set();
    listPlanRevisions.mockResolvedValue([]);
    const { container } = render(<CentralNeedsScreen />);
    await waitFor(() => expect(listPlanRevisions).toHaveBeenCalled());

    const sections = [...container.querySelectorAll<HTMLElement>('section.cn2b-stage')];
    expect(sections.map((s) => s.dataset.stage)).toEqual([...EXPECTED_STAGE_ORDER]);
  });
});

// ============================================================================
// B. The navigator is a real, accessible navigation control.
// ============================================================================
describe('UX-1 — the workflow navigator', () => {
  it('is a named navigation landmark holding an ORDERED list of six real buttons', async () => {
    await renderWorkspace();

    const nav = screen.getByRole('navigation', { name: T.cn2b_workflow_label.en });
    expect(nav.querySelector('ol')).not.toBeNull();

    const buttons = within(nav).getAllByRole('button');
    expect(buttons).toHaveLength(6);
    buttons.forEach((button, index) => {
      // A real <button type="button"> — never a clickable div, and never a
      // link that would hijack application routing.
      expect(button.tagName).toBe('BUTTON');
      expect(button).toHaveAttribute('type', 'button');
      expect(button.dataset.stage).toBe(EXPECTED_STAGE_ORDER[index]);
      expect(button).toHaveTextContent(String(index + 1));
      expect(button).toHaveTextContent(T[CENTRAL_NEEDS_STAGES[index].titleKey].en);
    });

    // No clickable <div>, and no anchor: the rail moves the page, it does not
    // navigate the application.
    const navSource = read('src/features/central-needs/CentralNeedsWorkflowNav.tsx');
    expect(navSource).not.toMatch(/<div[^>]*onClick=/);
    expect(navSource).not.toMatch(/<a[\s>]/);
    expect(navSource).not.toContain('href');
  });

  it('marks exactly one stage current, and moves it to whichever stage was chosen', async () => {
    await renderWorkspace();
    const nav = screen.getByRole('navigation', { name: T.cn2b_workflow_label.en });
    const current = () => within(nav).getAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'step');

    expect(current()).toHaveLength(1);
    expect(current()[0].dataset.stage).toBe('plan');

    fireEvent.click(within(nav).getByRole('button', { name: new RegExp(T.cn2b_stage_readiness.en, 'i') }));
    expect(current()).toHaveLength(1);
    expect(current()[0].dataset.stage).toBe('readiness');
  });

  it('sends focus and scroll to the CORRECT stage section, not merely to some section', async () => {
    await renderWorkspace();
    const nav = screen.getByRole('navigation', { name: T.cn2b_workflow_label.en });

    for (const stage of CENTRAL_NEEDS_STAGES) {
      scrollIntoView.mockClear();
      fireEvent.click(within(nav).getByRole('button', { name: new RegExp(T[stage.titleKey].en, 'i') }));

      // The stage section is focused — the section carries tabIndex -1 for
      // exactly this, so a keyboard user continues INSIDE the chosen stage.
      expect(document.activeElement, stage.id).toBe(document.getElementById(stageDomId(stage.id)));
      expect(document.activeElement, stage.id).toHaveAttribute('tabindex', '-1');
      expect(scrollIntoView, stage.id).toHaveBeenCalledTimes(1);
    }
  });
});

// ============================================================================
// C. Every panel that existed before is still on screen, inside its stage.
// ============================================================================
describe('UX-1 — the existing panels survive the regrouping', () => {
  it('renders every CN-2B panel at once, each inside the stage that owns it', async () => {
    const { container } = await renderWorkspace();
    // The need-line PANEL title and the need-line panel's own internal title
    // read identically in English, so every lookup here is narrowed to the
    // panel heading itself rather than to the words.
    await screen.findAllByText(T.cn2b_panel_need_lines.en);

    const stageOf = (panelTitle: string) => {
      const heading = screen.getAllByText(panelTitle)
        .find((el) => el.classList.contains('cn2b-panel__title'));
      expect(heading, panelTitle).toBeDefined();
      return heading!.closest('section.cn2b-stage')?.getAttribute('data-stage');
    };

    expect(stageOf(T.cn2b_panel_revision.en)).toBe('plan');
    expect(stageOf(T.cn2b_panel_upload.en)).toBe('source');
    expect(stageOf(T.cn2b_panel_batches.en)).toBe('source');
    expect(stageOf(T.cn2b_panel_source_search.en)).toBe('source');
    expect(stageOf(T.cn2b_panel_sessions.en)).toBe('source');
    expect(stageOf(T.cn2b_panel_review.en)).toBe('review');
    expect(stageOf(T.cn2b_panel_beneficiary_columns.en)).toBe('beneficiaries');
    expect(stageOf(T.cn2b_panel_need_lines.en)).toBe('need-lines');
    expect(stageOf(T.cn2b_panel_readiness.en)).toBe('readiness');

    // The panel heading level moved under the new stage heading; it is still
    // a heading, and the outline has no gap.
    const panelTitles = [...container.querySelectorAll('.cn2b-panel__title')];
    expect(panelTitles.length).toBeGreaterThanOrEqual(9);
    for (const title of panelTitles) expect(title.tagName).toBe('H3');
  });

  it('keeps the server-computed readiness verdict and its blockers exactly as before', async () => {
    await renderWorkspace();
    // Completeness is still the SERVER's answer, projected verbatim.
    expect(await screen.findByText(T.cn2b_readiness_blocked.en)).toBeInTheDocument();
    expect(screen.getAllByText(T.cn2b_state_incomplete.en).length).toBeGreaterThan(0);
    expect(screen.getByText(T.cn2b_blocker_target_entity_without_disposition.en)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: T.cn2b_submit.en })).toBeDisabled();
  });

  it('summarises only figures already on screen, and adds no read of its own', async () => {
    await renderWorkspace();
    const summary = screen.getByRole('region', { name: T.cn2b_summary_label.en });

    /** The value rendered beside one summary label, never "some cell says X". */
    const metric = (labelKey: string) => {
      const label = within(summary).getByText(T[labelKey].en);
      return label.closest('.cn2b-summary__cell')?.querySelector('.cn2b-summary__value')?.textContent;
    };

    expect(metric('cn2b_sum_sessions')).toBe('1/1');        // one completed session, of one
    expect(metric('cn2b_sum_batches')).toBe('1');
    expect(metric('cn2b_sum_columns')).toBe('1/1');         // one decided column, of one
    expect(metric('cn2b_sum_need_lines')).toBe('0');
    expect(metric('cn2b_sum_blockers')).toBe('1');          // the server's blocker, counted not judged

    // The strip is rendered from state the panels already loaded: the revision
    // reads happened ONCE each, exactly as before UX-1.
    expect(listImportSessions).toHaveBeenCalledTimes(1);
    expect(listImportBatches).toHaveBeenCalledTimes(1);
    expect(listBeneficiaryColumns).toHaveBeenCalledTimes(1);
    expect(fetchReviewReadiness).toHaveBeenCalledTimes(1);
    expect(listNeedLineLineage).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// D. Authority is untouched: EFFECTIVE permissions, never a role name.
// ============================================================================
describe('UX-1 — Annual Needs actions stay permission-driven', () => {
  it('offers import and edit actions only to the effective keys that always gated them', async () => {
    await renderWorkspace();
    expect(screen.getByLabelText(T.cn2b_choose_file.en)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: T.cn2b_open_draft.en })).toBeInTheDocument();

    cleanup();
    vi.clearAllMocks();
    loadRevision();
    appState.myPermissions = new Set();
    await renderWorkspace();

    // No role is supplied to this render AT ALL — nothing but the empty
    // effective set could admit these, and it does not.
    expect(screen.queryByLabelText(T.cn2b_choose_file.en)).toBeNull();
    expect(screen.queryByRole('button', { name: T.cn2b_open_draft.en })).toBeNull();
    expect(screen.queryByRole('button', { name: T.cn2b_submit.en })).toBeNull();
  });

  it('offers approve and reject only on central_needs.approve, and only for a submitted revision', async () => {
    appState.myPermissions = new Set(['central_needs.approve']);
    loadRevision({ ...REVISION, status: 'submitted' });
    await renderWorkspace();
    expect(screen.getByRole('button', { name: T.cn2b_approve.en })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: T.cn2b_reject.en })).toBeInTheDocument();

    cleanup();
    vi.clearAllMocks();
    loadRevision({ ...REVISION, status: 'submitted' });
    appState.myPermissions = new Set(['central_needs.edit']);
    await renderWorkspace();
    expect(screen.queryByRole('button', { name: T.cn2b_approve.en })).toBeNull();
    expect(screen.queryByRole('button', { name: T.cn2b_reject.en })).toBeNull();
  });

  it('names no role anywhere in the workspace shell', () => {
    for (const rel of [
      'src/features/central-needs/CentralNeedsScreen.tsx',
      'src/features/central-needs/CentralNeedsWorkflowNav.tsx',
    ]) {
      const body = read(rel);
      for (const role of [
        'super_admin', 'institution_admin', 'central_warehouse_manager',
        'warehouse_officer', 'outlet_officer', 'health_center_manager',
      ]) expect(body, `${rel} names ${role}`).not.toContain(role);
    }

    // The three action gates are still read from the effective set, verbatim.
    const shell = read('src/features/central-needs/CentralNeedsScreen.tsx');
    for (const key of ['import', 'edit', 'approve']) {
      expect(shell).toContain(`myPermissions.has('central_needs.${key}')`);
    }
    // The navigator decides nothing: it holds no permission or role reasoning.
    const nav = read('src/features/central-needs/CentralNeedsWorkflowNav.tsx');
    expect(nav).not.toContain('myPermissions');
    expect(nav).not.toContain('permissions');
    expect(nav).not.toContain('isScreenAuthorized');
  });
});

// ============================================================================
// E. One mirrored layout — never two hand-written directional behaviours.
// ============================================================================
describe('UX-1 — Arabic RTL and English LTR are the same shell', () => {
  it('projects the app direction onto the workspace root rather than choosing one', async () => {
    const { container } = await renderWorkspace();
    expect(container.querySelector('.cn2b')).toHaveAttribute('dir', 'ltr');

    cleanup();
    vi.clearAllMocks();
    loadRevision();
    appState.lang = 'ar';
    appState.dir = 'rtl';
    const rtl = await renderWorkspace();
    expect(rtl.container.querySelector('.cn2b')).toHaveAttribute('dir', 'rtl');
  });

  it('renders the identical stage structure and navigation in Arabic, only the words change', async () => {
    const { container: ltr } = await renderWorkspace();
    const ltrStages = [...ltr.querySelectorAll<HTMLElement>('section.cn2b-stage')].map((s) => s.dataset.stage);
    const ltrButtons = within(screen.getByRole('navigation', { name: T.cn2b_workflow_label.en }))
      .getAllByRole('button').map((b) => b.dataset.stage);

    cleanup();
    vi.clearAllMocks();
    loadRevision();
    appState.lang = 'ar';
    appState.dir = 'rtl';
    const { container: rtl } = await renderWorkspace();

    expect([...rtl.querySelectorAll<HTMLElement>('section.cn2b-stage')].map((s) => s.dataset.stage))
      .toEqual(ltrStages);
    const arabicNav = screen.getByRole('navigation', { name: T.cn2b_workflow_label.ar });
    expect(within(arabicNav).getAllByRole('button').map((b) => b.dataset.stage)).toEqual(ltrButtons);
    expect(within(arabicNav).getByText(T.cn2b_stage_readiness.ar)).toBeInTheDocument();
  });

  it('carries no direction-specific logic and no physical-direction CSS in the new shell', () => {
    for (const rel of [
      'src/features/central-needs/CentralNeedsScreen.tsx',
      'src/features/central-needs/CentralNeedsWorkflowNav.tsx',
    ]) {
      const body = read(rel);
      expect(body, rel).not.toMatch(/dir\s*===\s*['"](rtl|ltr)['"]/);
      expect(body, rel).not.toMatch(/lang\s*===\s*['"]ar['"]/);
    }
    // Every new rule is written in logical properties, like the rest of the file.
    const css = read('src/shared/lib/central-needs.css');
    expect(css).not.toMatch(/(^|[\s;{])(margin-left|margin-right|padding-left|padding-right|left|right)\s*:/m);
    for (const selector of [
      '.cn2b-workflow__list', '.cn2b-stagelink', '.cn2b-stage__title', '.cn2b-summary__grid',
    ]) expect(css, selector).toContain(selector);
    // The rail scrolls inside itself; the document must never widen for it.
    expect(css).toMatch(/\.cn2b-workflow__list\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.cn2b-workflow\s*\{[^}]*max-inline-size:\s*100%/);
    // Touch-sized stage targets, and a visible keyboard focus ring on them.
    expect(css).toMatch(/\.cn2b-stagelink\s*\{[^}]*min-block-size:\s*38px/);
    expect(css).toContain('.cn2b-stagelink:focus-visible');
  });

  it('gives every new shell label both Arabic and English', () => {
    const keys = [
      ...CENTRAL_NEEDS_STAGES.map((s) => s.titleKey),
      'cn2b_workflow_label', 'cn2b_summary_label',
      'cn2b_sum_sessions', 'cn2b_sum_batches', 'cn2b_sum_columns',
      'cn2b_sum_need_lines', 'cn2b_sum_blockers',
      'cn2b_stage_review_waiting', 'cn2b_stage_revision_waiting',
    ];
    for (const key of keys) {
      expect(T[key], key).toBeDefined();
      expect(T[key].ar.trim().length, key).toBeGreaterThan(0);
      expect(T[key].en.trim().length, key).toBeGreaterThan(0);
    }

    // Nothing the navigator can render is missing from the dictionary — the
    // existing completeness check reads the screen, not this new module.
    const nav = read('src/features/central-needs/CentralNeedsWorkflowNav.tsx');
    for (const [, key] of nav.matchAll(/'(cn2b_[a-z0-9_]+)'/g)) expect(T[key], key).toBeDefined();
  });
});
