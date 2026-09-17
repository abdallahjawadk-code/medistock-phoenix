/** @vitest-environment jsdom */
/**
 * Simple Mode is the DEFAULT product experience (Owner task "Simple UX Visual
 * Activation & Convergence"), proven against the REAL `CentralNeedsScreen`
 * with only the service boundary and `useApp` mocked — the same idiom as
 * cn2b-ux1-workspace-shell.runtime.test.tsx.
 *
 * Three things this exists to catch:
 *   1. the FIRST paint being Advanced (a flash before Simple), or Advanced
 *      chrome wrapping the Simple view;
 *   2. Advanced Mode becoming unreachable, or unreturnable;
 *   3. a mode switch re-reading or resetting canonical state — both modes
 *      must read the SAME loaded state, so switching may issue no read at all.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  BeneficiaryColumnSummary, FieldOverride, ImportBatch, ImportSession,
  NeedLine, NeedLineSourceLink, PlanRevision, RecordDisposition, ReviewReadiness, SourceRecord,
} from '../../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

const ORG = 'org-1';
const REV = 'rev-1';
const SESSION_ID = 's1';
const ROW = 'sheet:0:row:1';
const ITEM = '00000000-0000-0000-0000-0000000000a1';

interface AppState {
  lang: 'ar' | 'en';
  dir: 'rtl' | 'ltr';
  activeOrgId: string | null;
  profile: { organization_id: string | null } | null;
  myPermissions: Set<string>;
}

const appState: AppState = {
  lang: 'ar', dir: 'rtl', activeOrgId: ORG,
  profile: { organization_id: ORG },
  myPermissions: new Set(['central_needs.import', 'central_needs.edit', 'central_needs.approve']),
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
vi.mock('@/shared/supabase/services/organizations.service', () => ({ getOrganizations: () => getOrganizations() }));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({ getWarehouses: async () => [] }));
vi.mock('../../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../../central-needs.service')>('../../central-needs.service');
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

const { CentralNeedsScreen } = await import('../../CentralNeedsScreen');

const REVISION: PlanRevision = { id: REV, planId: 'plan-1', organizationId: ORG, planYear: 2026, revisionNumber: 1, status: 'draft' };
const SESSION: ImportSession = {
  id: SESSION_ID, planRevisionId: REV, sourceFileId: 'f1', status: 'completed',
  previewDigest: 'digest', authoritativeDigest: 'digest', parserIdentity: null,
  startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', notes: null,
};
const BATCH = {
  id: 'b1', planRevisionId: REV, containerFilename: 'need-2026.zip', containerKind: 'zip',
  containerSha256: 'a'.repeat(64), acceptedEntryCount: 1, excludedEntryCount: 0,
} as unknown as ImportBatch;
const READINESS = {
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

function loadRevision() {
  listPlanRevisions.mockResolvedValue([REVISION]);
  listImportSessions.mockResolvedValue([SESSION]);
  listImportBatches.mockResolvedValue([BATCH]);
  listOverrides.mockResolvedValue([] as FieldOverride[]);
  fetchReviewReadiness.mockResolvedValue(READINESS);
  listNeedLineLineage.mockResolvedValue({ needLines: [] as NeedLine[], sources: [] as NeedLineSourceLink[] });
  listBeneficiaryColumns.mockResolvedValue([] as BeneficiaryColumnSummary[]);
  listDispositions.mockResolvedValue([DISPOSITION]);
  listSourceRecords.mockResolvedValue([RECORD]);
  getOrganizations.mockResolvedValue([] as OrgRow[]);
}

const totalReads = () =>
  listPlanRevisions.mock.calls.length + listImportSessions.mock.calls.length + listImportBatches.mock.calls.length
  + listOverrides.mock.calls.length + fetchReviewReadiness.mock.calls.length + listNeedLineLineage.mock.calls.length
  + listBeneficiaryColumns.mock.calls.length + listSourceRecords.mock.calls.length + listDispositions.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  appState.lang = 'ar';
  appState.dir = 'rtl';
  loadRevision();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});
afterEach(() => cleanup());

describe('CentralNeedsScreen — Simple Mode is the first and default paint', () => {
  it('the very first render is the Simple workspace — no Advanced shell, no six-stage workspace, no flash', () => {
    const { container } = render(<CentralNeedsScreen />);
    // Synchronously, before any read has resolved: Simple is already the one thing on screen.
    expect(container.querySelector('div.cn2b')?.getAttribute('data-mode')).toBe('simple');
    expect(screen.getByTestId('cn2b-simple-workspace')).toBeInTheDocument();
    expect(container.querySelectorAll('section.cn2b-stage')).toHaveLength(0);
    expect(container.querySelector('header.cn2b-header')).toBeNull();
    expect(container.querySelector('.cn2b-workflow')).toBeNull();
    expect(container.querySelector('.cn2b-guidance')).toBeNull();
  });

  it('the Simple page carries the title, the six-step indicator and ONE task card', async () => {
    const { container } = render(<CentralNeedsScreen />);
    await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledWith(REV));
    expect(container.querySelectorAll('div.cn2b h1')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('الاحتياج السنوي');
    expect(container.querySelectorAll('.cn2b-simple-stepper__item')).toHaveLength(6);
    expect(container.querySelectorAll('.cn2b-simple-stepper__item[data-state="current"]')).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-workspace').getAttribute('data-step')).toBe('summary'));
    expect(container.querySelectorAll('.cn2b-simple-card')).toHaveLength(1);
  });

  it('honours the app direction rather than hard-coding one', async () => {
    appState.lang = 'en';
    appState.dir = 'ltr';
    const { container } = render(<CentralNeedsScreen />);
    await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledWith(REV));
    expect(container.querySelector('div.cn2b')?.getAttribute('dir')).toBe('ltr');
    expect(screen.getByTestId('cn2b-simple-workspace').getAttribute('dir')).toBe('ltr');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Annual Needs');
  });
});

describe('CentralNeedsScreen — Advanced Mode survives as the secondary entry', () => {
  it('"Advanced options" is a single control at the end of the Simple page, and it opens the six-stage workspace', async () => {
    const { container } = render(<CentralNeedsScreen />);
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-workspace').getAttribute('data-step')).toBe('summary'));
    const links = screen.getAllByTestId('cn2b-simple-advanced-link');
    expect(links).toHaveLength(1);
    expect(links[0].closest('footer')).not.toBeNull();

    fireEvent.click(links[0]);
    expect(container.querySelector('div.cn2b')?.getAttribute('data-mode')).toBe('advanced');
    expect(screen.queryByTestId('cn2b-simple-workspace')).toBeNull();
    expect(container.querySelectorAll('section.cn2b-stage')).toHaveLength(6);
    expect(container.querySelector('header.cn2b-header')).not.toBeNull();
    expect(container.querySelector('.cn2b-workflow')).not.toBeNull();
  });

  it('switching to Advanced and back issues NO read and replaces NO canonical state', async () => {
    const { container } = render(<CentralNeedsScreen />);
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-workspace').getAttribute('data-step')).toBe('summary'));
    await waitFor(() => expect(listSourceRecords).toHaveBeenCalledWith(SESSION_ID));
    const before = totalReads();
    const materialsBefore = screen.getByTestId('cn2b-simple-count-materials').textContent;

    fireEvent.click(screen.getByTestId('cn2b-simple-advanced-link'));
    expect(container.querySelectorAll('section.cn2b-stage')).toHaveLength(6);
    // The Advanced header restates the SAME loaded revision.
    expect(container.querySelector('.cn2b-revchip__plan')).toHaveTextContent('2026');

    fireEvent.click(screen.getByTestId('cn2b-mode-toggle'));
    expect(container.querySelector('div.cn2b')?.getAttribute('data-mode')).toBe('simple');
    expect(container.querySelectorAll('section.cn2b-stage')).toHaveLength(0);
    // Same dataset, same figures, and its summary is presented again.
    expect(screen.getByTestId('cn2b-simple-workspace').getAttribute('data-step')).toBe('summary');
    expect(screen.getByTestId('cn2b-simple-count-materials').textContent).toBe(materialsBefore);
    expect(totalReads()).toBe(before);
  });

  it('initialMode="advanced" opens the six-stage workspace first — the expert entry point', () => {
    const { container } = render(<CentralNeedsScreen initialMode="advanced" />);
    expect(container.querySelector('div.cn2b')?.getAttribute('data-mode')).toBe('advanced');
    expect(container.querySelectorAll('section.cn2b-stage')).toHaveLength(6);
    expect(screen.queryByTestId('cn2b-simple-workspace')).toBeNull();
  });

  it('the Advanced header offers the way back to the Simple view, and that is its only mode control', () => {
    const { container } = render(<CentralNeedsScreen initialMode="advanced" />);
    const toggles = container.querySelectorAll('[data-testid="cn2b-mode-toggle"]');
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toHaveTextContent('الواجهة البسيطة');
    fireEvent.click(toggles[0]);
    expect(screen.getByTestId('cn2b-simple-workspace')).toBeInTheDocument();
  });
});

describe('CentralNeedsScreen — human-readable messages reach the Simple view', () => {
  it('a failed revision list read is shown as translated text, never as a raw code', async () => {
    listPlanRevisions.mockRejectedValue(new Error('boom'));
    render(<CentralNeedsScreen />);
    await waitFor(() => expect(screen.getAllByTestId('cn2b-simple-error').length).toBeGreaterThan(0));
    const text = screen.getAllByTestId('cn2b-simple-error').map((el) => el.textContent ?? '').join(' ');
    expect(text).toContain('تعذّر تحميل البيانات');
    expect(text).not.toContain('load_failed');
  });
});
