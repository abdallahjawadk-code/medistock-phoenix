/** @vitest-environment jsdom */
/**
 * PRE3-B — the Work Session selector, rendered through the real screen.
 *
 *   * the label says only what the search can do;
 *   * every session has one stable number ("Session K of N"), counted over ALL
 *     sessions of the revision and never renumbered by a search;
 *   * the current selection is not a search hit — a session the search did not
 *     match is never listed as one;
 *   * the newest search wins, a failure is not "no match", and a revision
 *     switch never carries one revision's search into another;
 *   * (N1) a server hit for a session the loaded list does not hold is never
 *     dropped: it is reported as an out-of-date list, with a way to re-read it;
 *   * a failed batch-membership read is "source name unavailable", never the
 *     claim that a session is outside every trusted batch.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type {
  ImportBatch, ImportSession, PlanRevision, ReviewReadiness, SourceRecord, WorkSessionSearchResult,
} from '../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

const ORG = 'org-1';
const REV = 'rev-1';
const REV_B = 'rev-2';

const appState = {
  lang: 'en' as 'ar' | 'en', dir: 'ltr' as 'ltr' | 'rtl', activeOrgId: ORG,
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
const listBeneficiaryRegions = vi.fn();
const listSourceRecords = vi.fn();
const listDispositions = vi.fn();
const searchBatchEntries = vi.fn();
const searchWorkSessions = vi.fn();
const getOrganizations = vi.fn();

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/supabase/services/organizations.service', () => ({ getOrganizations: () => getOrganizations() }));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({ getWarehouses: async () => [] }));
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  return {
    ...actual,
    listPlanRevisions: (...a: unknown[]) => listPlanRevisions(...a),
    listImportSessions: (...a: unknown[]) => listImportSessions(...a),
    listImportBatches: (...a: unknown[]) => listImportBatches(...a),
    listOverrides: (...a: unknown[]) => listOverrides(...a),
    fetchReviewReadiness: (...a: unknown[]) => fetchReviewReadiness(...a),
    listNeedLineLineage: (...a: unknown[]) => listNeedLineLineage(...a),
    listBeneficiaryColumns: (...a: unknown[]) => listBeneficiaryColumns(...a),
    listBeneficiaryRegions: (...a: unknown[]) => listBeneficiaryRegions(...a),
    listSourceRecords: (...a: unknown[]) => listSourceRecords(...a),
    listDispositions: (...a: unknown[]) => listDispositions(...a),
    searchBatchEntries: (...a: unknown[]) => searchBatchEntries(...a),
    searchWorkSessions: (...a: unknown[]) => searchWorkSessions(...a),
    searchSourceFiles: vi.fn(async () => []),
    searchCentralItems: vi.fn(async () => []),
    setRecordDisposition: vi.fn(),
    recordFieldOverride: vi.fn(),
  };
});

const { CentralNeedsScreen } = await import('../CentralNeedsScreen');
const { CentralNeedsError } = await import('../central-needs.service');

const REVISION: PlanRevision = { id: REV, planId: 'plan-1', organizationId: ORG, planYear: 2026, revisionNumber: 1, status: 'draft' };
const REVISION_B: PlanRevision = { ...REVISION, id: REV_B, planId: 'plan-2', planYear: 2025 };

const SA = 'aaaaaaaa-0000-4000-8000-000000000001';
const SB = 'bbbbbbbb-0000-4000-8000-000000000002';
const SC = 'cccccccc-0000-4000-8000-000000000003';
const SD = 'dddddddd-0000-4000-8000-000000000004';
const SB2 = 'eeeeeeee-0000-4000-8000-000000000005';

const session = (id: string, rev: string, status: ImportSession['status'], startedAt: string, entryPath: string | null): ImportSession => ({
  id, planRevisionId: rev, sourceFileId: `f-${id}`, status, previewDigest: 'd', authoritativeDigest: 'd',
  parserIdentity: null, startedAt, completedAt: null, notes: null, entryPath,
});

const SESSIONS: ImportSession[] = [
  session(SA, REV, 'completed', '2026-01-01T08:00:00Z', 'north/clinic-a.xlsx'),
  session(SB, REV, 'completed', '2026-01-02T08:00:00Z', 'south/clinic-b.xlsx'),
  session(SC, REV, 'failed', '2026-01-03T08:00:00Z', 'west/clinic-c.xlsx'),
  session(SD, REV, 'completed', '2026-01-04T08:00:00Z', null),
];
const ENTRIES = [
  { id: 'e1', batchId: 'b1', entryOrdinal: 1, archiveEntryPath: 'north/clinic-a.xlsx', entrySha256: 'a'.repeat(64), importSessionId: SA, containerFilename: 'Hospitals-2026.zip' },
  { id: 'e2', batchId: 'b1', entryOrdinal: 2, archiveEntryPath: 'south/clinic-b.xlsx', entrySha256: 'b'.repeat(64), importSessionId: SB, containerFilename: 'Hospitals-2026.zip' },
];
const READINESS = { planRevisionId: REV, status: 'draft', ready: false, blockers: [] } as unknown as ReviewReadiness;
const RECORDS: SourceRecord[] = [{
  id: 'r1', importSessionId: SA, recordOrdinal: 1, targetEntity: 'sheet:0:row:1', fieldName: 'Material',
  sourceValues: { value: 'Paracetamol', valueType: 'string', isFormula: false, formula: null },
  sourceProvenance: { sheetIndex: 0, sheetName: 'Needs', coordinate: { a1: 'B2' } },
} as unknown as SourceRecord];

function loadAll() {
  listPlanRevisions.mockResolvedValue([REVISION]);
  listImportSessions.mockImplementation(async (rev: string) => (rev === REV ? SESSIONS : [session(SB2, REV_B, 'completed', '2025-01-01T08:00:00Z', 'bravo/only.xlsx')]));
  listImportBatches.mockResolvedValue([] as ImportBatch[]);
  listOverrides.mockResolvedValue([]);
  fetchReviewReadiness.mockResolvedValue(READINESS);
  listNeedLineLineage.mockResolvedValue({ needLines: [], sources: [] });
  listBeneficiaryColumns.mockResolvedValue([]);
  listBeneficiaryRegions.mockResolvedValue([]);
  listSourceRecords.mockResolvedValue(RECORDS);
  listDispositions.mockResolvedValue([]);
  searchBatchEntries.mockImplementation(async (rev: string) => (rev === REV ? ENTRIES : []));
  searchWorkSessions.mockResolvedValue({ hits: [], truncated: false } satisfies WorkSessionSearchResult);
  getOrganizations.mockResolvedValue([] as OrgRow[]);
}

beforeEach(() => {
  vi.clearAllMocks();
  appState.lang = 'en';
  appState.dir = 'ltr';
  loadAll();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), writable: true, configurable: true });
});
afterEach(() => cleanup());

/** The ONE visible Work Session selector (the other stages that hold one are hidden). */
const selector = () => screen.getByRole('region', { name: T.cn2b_work_session.en });
const searchBox = () => within(selector()).getByLabelText(T.cn2b_work_session_search.en) as HTMLInputElement;
const optionTexts = () => within(selector()).getAllByRole('option').map((o) => o.textContent ?? '');
const hitList = () => within(selector()).queryByRole('list', { name: T.cn2b_work_session_search_results.en });
const hitButtons = () => {
  const list = hitList();
  return list ? within(list).getAllByRole('button') : [];
};
const phase = () => (selector().querySelector('.cn2b-searchstate') as HTMLElement | null)?.dataset.phase ?? null;
const ordinal = (k: number, n: number) => T.cn2b_work_session_ordinal.en.replace('__K__', String(k)).replace('__N__', String(n));

async function openReview() {
  render(<CentralNeedsScreen initialMode="advanced" />);
  await waitFor(() => expect(listSourceRecords).toHaveBeenCalledWith(SA));
  const nav = screen.getByRole('navigation', { name: T.cn2b_workflow_label.en });
  fireEvent.click(within(nav).getByRole('button', { name: new RegExp(T.cn2b_stage_review.en, 'i') }));
  await waitFor(() => expect(within(selector()).getByRole('combobox')).toBeEnabled());
}

describe('PRE3-B — a truthful label', () => {
  it('B1 · claims filename, source path and session identifier — and nothing about institutions', () => {
    expect(T.cn2b_work_session_search.ar).toBe('بحث باسم الملف أو مسار المصدر أو معرف الجلسة');
    expect(T.cn2b_work_session_search.en).toBe('Search by filename, source path, or session identifier');
    expect(T.cn2b_work_session_search.en).not.toMatch(/institution/i);
  });
});

describe('PRE3-B — stable numbering, and a selection that is not a hit', () => {
  it('14 · numbers sessions over the whole revision; a search never renumbers or filters the selector', async () => {
    await openReview();
    expect(searchBox().placeholder).toBe(T.cn2b_work_session_search.en);
    const before = optionTexts();
    // Completed sessions only are selectable, numbered among ALL four (the failed one is #3).
    expect(before).toHaveLength(3);
    expect(before[0]).toContain(ordinal(1, 4));
    expect(before[1]).toContain(ordinal(2, 4));
    expect(before[2]).toContain(ordinal(4, 4));

    searchWorkSessions.mockResolvedValue({ hits: [{ importSessionId: SB, matchedOn: ['entry_path'] }], truncated: false });
    fireEvent.change(searchBox(), { target: { value: 'south' } });
    await waitFor(() => expect(hitButtons()).toHaveLength(1));
    expect(optionTexts()).toEqual(before);
    expect(hitButtons()[0]).toHaveTextContent(ordinal(2, 4));
  });

  it('15 · the current session is not listed as a hit when the search did not match it', async () => {
    await openReview();
    expect((within(selector()).getByRole('combobox') as HTMLSelectElement).value).toBe(SA);
    searchWorkSessions.mockResolvedValue({ hits: [{ importSessionId: SB, matchedOn: ['entry_path'] }], truncated: false });
    fireEvent.change(searchBox(), { target: { value: 'south/clinic' } });
    await waitFor(() => expect(phase()).toBe('done'));
    expect(searchWorkSessions).toHaveBeenLastCalledWith(REV, 'south/clinic');
    expect(hitButtons()).toHaveLength(1);
    expect(hitButtons()[0]).toHaveTextContent('south/clinic-b.xlsx');
    expect(hitButtons()[0]).toHaveTextContent(`${T.cn2b_work_session_matched_on.en}: ${T.cn2b_work_session_match_entry_path.en}`);
    expect(hitList()).not.toHaveTextContent('north/clinic-a.xlsx');
    expect(hitList()).not.toHaveTextContent(T.cn2b_session_current.en);
  });

  it('15b · when the search DOES match the current session, it is a hit and is marked as current', async () => {
    await openReview();
    searchWorkSessions.mockResolvedValue({ hits: [{ importSessionId: SA, matchedOn: ['container_filename'] }], truncated: false });
    fireEvent.change(searchBox(), { target: { value: 'hospitals' } });
    await waitFor(() => expect(hitButtons()).toHaveLength(1));
    expect(hitButtons()[0]).toHaveTextContent(T.cn2b_session_current.en);
    expect(hitButtons()[0]).toHaveAttribute('aria-pressed', 'true');
  });

  it('a session number is matched against the stable numbering: "#4" and "٣"', async () => {
    await openReview();
    fireEvent.change(searchBox(), { target: { value: '#4' } });
    await waitFor(() => expect(phase()).toBe('done'));
    expect(hitButtons()).toHaveLength(1);
    expect(hitButtons()[0]).toHaveTextContent(ordinal(4, 4));
    expect(hitButtons()[0]).toHaveTextContent(T.cn2b_work_session_match_ordinal.en);
    expect(hitButtons()[0]).toBeEnabled();
    // #3 is the failed attempt: it is found, numbered, and cannot be switched to.
    fireEvent.change(searchBox(), { target: { value: '٣' } });
    await waitFor(() => expect(searchWorkSessions).toHaveBeenLastCalledWith(REV, '٣'));
    await waitFor(() => expect(hitButtons()).toHaveLength(1));
    expect(hitButtons()[0]).toHaveTextContent(ordinal(3, 4));
    expect(hitButtons()[0]).toBeDisabled();
  });

  it('choosing a hit switches the Work Session through the same guarded path', async () => {
    await openReview();
    searchWorkSessions.mockResolvedValue({ hits: [{ importSessionId: SB, matchedOn: ['entry_path'] }], truncated: false });
    fireEvent.change(searchBox(), { target: { value: 'south' } });
    await waitFor(() => expect(hitButtons()).toHaveLength(1));
    fireEvent.click(hitButtons()[0]);
    await waitFor(() => expect(listSourceRecords).toHaveBeenCalledWith(SB));
    await waitFor(() => expect((within(selector()).getByRole('combobox') as HTMLSelectElement).value).toBe(SB));
  });
});

describe('PRE3-B — bounded, ordered, newest-wins, and honest about failure', () => {
  it('18 · an empty box is no search: no query, no result list, no result claim', async () => {
    await openReview();
    fireEvent.change(searchBox(), { target: { value: '   ' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(searchWorkSessions).not.toHaveBeenCalled();
    expect(hitList()).toBeNull();
    expect(phase()).toBeNull();
  });

  it('19 · a slower earlier search never overwrites a later one', async () => {
    const replies: Record<string, (r: WorkSessionSearchResult) => void> = {};
    searchWorkSessions.mockImplementation((_rev: string, q: string) => new Promise((resolve) => { replies[q] = resolve; }));
    await openReview();
    fireEvent.change(searchBox(), { target: { value: 'alpha' } });
    await waitFor(() => expect(replies.alpha).toBeDefined());
    fireEvent.change(searchBox(), { target: { value: 'bravo' } });
    await waitFor(() => expect(replies.bravo).toBeDefined());
    replies.bravo({ hits: [{ importSessionId: SD, matchedOn: ['source_filename'] }], truncated: false });
    await waitFor(() => expect(hitButtons()).toHaveLength(1));
    replies.alpha({ hits: [{ importSessionId: SB, matchedOn: ['entry_path'] }], truncated: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(hitButtons()).toHaveLength(1);
    expect(hitButtons()[0]).toHaveTextContent(ordinal(4, 4));
    expect(hitList()).not.toHaveTextContent('south/clinic-b.xlsx');
  });

  it('a failed search says so, and never says that no session matches', async () => {
    searchWorkSessions.mockRejectedValue(new CentralNeedsError('central_needs_request_failed'));
    await openReview();
    fireEvent.change(searchBox(), { target: { value: 'clinic' } });
    await waitFor(() => expect(phase()).toBe('failed'));
    expect(selector()).toHaveTextContent(T.cn2b_work_session_search_failed.en);
    expect(selector()).not.toHaveTextContent(T.cn2b_work_session_search_empty.en);
    expect(hitList()).toBeNull();
    // Not even a session number is offered as "found" beside a failed search.
    fireEvent.change(searchBox(), { target: { value: '#2' } });
    await waitFor(() => expect(searchWorkSessions).toHaveBeenLastCalledWith(REV, '#2'));
    await waitFor(() => expect(phase()).toBe('failed'));
    expect(hitList()).toBeNull();
  });

  it('a search that matches nothing says exactly that', async () => {
    await openReview();
    fireEvent.change(searchBox(), { target: { value: 'nothing-like-this' } });
    await waitFor(() => expect(phase()).toBe('done'));
    expect(selector()).toHaveTextContent(T.cn2b_work_session_search_empty.en);
  });

  it('N1 · a hit for a session the loaded list does not hold is reported as an out-of-date list — never dropped, never "no match"', async () => {
    const LATE = 'ffffffff-0000-4000-8000-000000000009';
    searchWorkSessions.mockResolvedValue({
      hits: [{ importSessionId: LATE, matchedOn: ['session_id'] }, { importSessionId: SB, matchedOn: ['entry_path'] }],
      truncated: false,
    });
    await openReview();
    fireEvent.change(searchBox(), { target: { value: 'late-or-south' } });
    await waitFor(() => expect(phase()).toBe('done'));
    expect(selector()).not.toHaveTextContent(T.cn2b_work_session_search_empty.en);
    // The listed hit is shown with its stable number; the unlisted one is counted, not invented.
    expect(hitButtons()).toHaveLength(1);
    expect(hitButtons()[0]).toHaveTextContent(ordinal(2, 4));
    expect(selector()).toHaveTextContent(`${T.cn2b_work_session_search_results.en}: 2`);
    const note = within(selector()).getByTestId('cn2b-work-session-unlisted');
    expect(note).toHaveAttribute('data-unlisted', '1');
    expect(note).toHaveAttribute('role', 'alert');
    // Reload re-reads the revision — its session list included.
    const reads = listImportSessions.mock.calls.length;
    fireEvent.click(within(note).getByRole('button'));
    await waitFor(() => expect(listImportSessions.mock.calls.length).toBeGreaterThan(reads));
    expect(listImportSessions).toHaveBeenLastCalledWith(REV);
  });

  it('N1 · only hits the search returned count: with every hit listed, no out-of-date note appears', async () => {
    searchWorkSessions.mockResolvedValue({ hits: [{ importSessionId: SB, matchedOn: ['entry_path'] }], truncated: false });
    await openReview();
    fireEvent.change(searchBox(), { target: { value: 'south' } });
    await waitFor(() => expect(hitButtons()).toHaveLength(1));
    expect(within(selector()).queryByTestId('cn2b-work-session-unlisted')).toBeNull();
  });

  it('a cut result says so', async () => {
    searchWorkSessions.mockResolvedValue({ hits: [{ importSessionId: SA, matchedOn: ['container_filename'] }], truncated: true });
    await openReview();
    fireEvent.change(searchBox(), { target: { value: 'hospitals' } });
    await waitFor(() => expect(phase()).toBe('done'));
    expect(selector()).toHaveTextContent(T.cn2b_work_session_search_truncated.en);
  });

  it('20 · a revision switch never shows the previous revision\'s search, even when its reply lands late', async () => {
    listPlanRevisions.mockResolvedValue([REVISION, REVISION_B]);
    let releaseA!: () => void;
    searchWorkSessions.mockImplementation((rev: string) => (rev === REV
      ? new Promise((resolve) => { releaseA = () => resolve({ hits: [{ importSessionId: SB, matchedOn: ['entry_path'] }], truncated: false }); })
      : Promise.resolve({ hits: [], truncated: false })));
    await openReview();
    fireEvent.change(searchBox(), { target: { value: 'south' } });
    await waitFor(() => expect(searchWorkSessions).toHaveBeenCalledWith(REV, 'south'));

    fireEvent.change(screen.getByLabelText(T.cn2b_revision.en), { target: { value: REV_B } });
    await waitFor(() => expect(listImportSessions).toHaveBeenCalledWith(REV_B));
    await waitFor(() => expect(listSourceRecords).toHaveBeenCalledWith(SB2));
    const nav = screen.getByRole('navigation', { name: T.cn2b_workflow_label.en });
    fireEvent.click(within(nav).getByRole('button', { name: new RegExp(T.cn2b_stage_review.en, 'i') }));
    await waitFor(() => expect(optionTexts()[0]).toContain('bravo/only.xlsx'));
    expect(searchBox().value).toBe('');

    releaseA();
    await new Promise((r) => setTimeout(r, 30));
    expect(hitList()).toBeNull();
    expect(phase()).toBeNull();
    expect(selector()).not.toHaveTextContent('south/clinic-b.xlsx');
  });
});

describe('PRE3-B — a failed membership read is not a claim about membership', () => {
  it('labels an unnamed session "source name unavailable" when the batch read failed', async () => {
    searchBatchEntries.mockRejectedValue(new CentralNeedsError('central_needs_request_failed'));
    await openReview();
    const sd = optionTexts().find((text) => text.includes(ordinal(4, 4))) ?? '';
    expect(sd).toContain(T.cn2b_work_session_source_unavailable.en);
    expect(sd).not.toContain(T.cn2b_session_unbatched_fallback.en);
    // A session whose own entry path is known still shows it.
    expect(optionTexts()[0]).toContain('north/clinic-a.xlsx');
  });

  it('claims "not in a trusted batch" only after a complete membership read', async () => {
    await openReview();
    const sd = optionTexts().find((text) => text.includes(ordinal(4, 4))) ?? '';
    expect(sd).toContain(T.cn2b_session_unbatched_fallback.en);
  });
});
