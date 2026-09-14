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
 * UX-2A — SOURCE & REVIEW OPERATIONAL DENSITY.
 *
 * The review workbench and the source-search toolbar are PRESENTATION. This
 * suite exists to keep them that way, and it is built around the two ways such
 * a surface usually goes wrong:
 *
 *   1. A FILTER THAT SILENTLY DECIDES. Narrowing the view must never select an
 *      entity, deselect one, write a disposition, or quietly drop a reviewer's
 *      existing selection because it is currently hidden. Every filter action
 *      below is asserted against the real service mocks: they must record ZERO
 *      calls.
 *
 *   2. A FILTER THAT HIDES EVIDENCE. Filtering matches ENTITY GROUPS. A matched
 *      entity is shown with all of its source fields, because a partially shown
 *      entity would misrepresent the workbook — which is precisely what this
 *      screen exists to prevent.
 *
 * Everything is rendered through the real `CentralNeedsScreen` and the real
 * `CentralNeedsDispositionTable`; only the Supabase-backed service boundary and
 * `useApp` are mocked.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const ORG = 'org-1';
const REV = 'rev-1';
const SESSION_ID = 's1';
const HOSPITAL_A = '00000000-0000-0000-0000-0000000000b1';
const ITEM = '00000000-0000-0000-0000-0000000000a1';

/** Three entities, each with two source fields — mapped, not-applicable, undecided. */
const ROW_MAPPED = 'sheet:0:row:1';
const ROW_NA = 'sheet:0:row:2';
const ROW_UNDECIDED = 'sheet:0:row:3';

interface AppState {
  lang: 'ar' | 'en';
  dir: 'rtl' | 'ltr';
  activeOrgId: string | null;
  profile: { organization_id: string | null } | null;
  myPermissions: Set<string>;
}

const ALL_PERMISSIONS = ['central_needs.import', 'central_needs.edit', 'central_needs.approve'];

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
const searchSourceFiles = vi.fn();
const searchBatchEntries = vi.fn();
const searchCentralItems = vi.fn();
const setRecordDisposition = vi.fn();
const recordFieldOverride = vi.fn();

/** Every Central Needs read/search the screen or the table can reach. */
const ALL_SERVICE_READS = [
  listBeneficiaryColumns, listImportSessions, listImportBatches, listOverrides,
  fetchReviewReadiness, listNeedLineLineage, listSourceRecords, listDispositions,
  listPlanRevisions, searchSourceFiles, searchBatchEntries, searchCentralItems,
];
/** Every Central Needs WRITE. A presentation filter must never reach one. */
const ALL_SERVICE_WRITES = [setRecordDisposition, recordFieldOverride];

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganizations: () => getOrganizations(),
}));
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
    searchSourceFiles: (...a: unknown[]) => searchSourceFiles(...a),
    searchBatchEntries: (...a: unknown[]) => searchBatchEntries(...a),
    searchCentralItems: (...a: unknown[]) => searchCentralItems(...a),
    setRecordDisposition: (...a: unknown[]) => setRecordDisposition(...a),
    recordFieldOverride: (...a: unknown[]) => recordFieldOverride(...a),
    setBeneficiaryColumns: vi.fn(async () => ({ confirmed: [] })),
  };
});

const { CentralNeedsScreen } = await import('../CentralNeedsScreen');

const ORGS: OrgRow[] = [
  { id: HOSPITAL_A, name: 'Beneficiary Hospital', name_ar: 'مستشفى', code: 'ha', status: 'active', organizationKind: 'care_institution' },
] as unknown as OrgRow[];

const REVISION: PlanRevision = { id: REV, planId: 'plan-1', organizationId: ORG, planYear: 2026, revisionNumber: 1, status: 'draft' };
const SESSION: ImportSession = {
  id: SESSION_ID, planRevisionId: REV, sourceFileId: 'f1', status: 'completed',
  previewDigest: 'digest', authoritativeDigest: 'digest', parserIdentity: null,
  startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', notes: null,
};
const READINESS: ReviewReadiness = { planRevisionId: REV, status: 'draft', ready: false, blockers: [] } as unknown as ReviewReadiness;

function field(id: string, entity: string, ordinal: number, name: string, value: unknown, a1: string): SourceRecord {
  return {
    id, importSessionId: SESSION_ID, recordOrdinal: ordinal, targetEntity: entity, fieldName: name,
    sourceValues: { value },
    sourceProvenance: { sheetIndex: 0, sheetName: 'Requirements', coordinate: { a1 } },
  } as unknown as SourceRecord;
}

const RECORDS: SourceRecord[] = [
  field('r1a', ROW_MAPPED, 1, 'Material', 'Paracetamol 500mg', 'B2'),
  field('r1b', ROW_MAPPED, 1, 'Quantity', 120, 'C2'),
  field('r2a', ROW_NA, 2, 'Material', 'Ibuprofen 400mg', 'B3'),
  field('r2b', ROW_NA, 2, 'Quantity', 80, 'C3'),
  field('r3a', ROW_UNDECIDED, 3, 'Material', 'Amoxicillin 250mg', 'B4'),
  field('r3b', ROW_UNDECIDED, 3, 'Quantity', 50, 'C4'),
];

const DISPOSITIONS: RecordDisposition[] = [
  { id: 'd1', importSessionId: SESSION_ID, targetEntity: ROW_MAPPED, decision: 'mapped', centralItemId: ITEM, decisionReason: null, decidedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'd2', importSessionId: SESSION_ID, targetEntity: ROW_NA, decision: 'not_applicable', centralItemId: null, decisionReason: 'Subtotal line', decidedAt: '2026-01-01T00:00:00.000Z' },
];

function loadAll() {
  listPlanRevisions.mockResolvedValue([REVISION]);
  listImportSessions.mockResolvedValue([SESSION]);
  listImportBatches.mockResolvedValue([] as ImportBatch[]);
  listOverrides.mockResolvedValue([] as FieldOverride[]);
  fetchReviewReadiness.mockResolvedValue(READINESS);
  listNeedLineLineage.mockResolvedValue({ needLines: [] as NeedLine[], sources: [] as NeedLineSourceLink[] });
  listBeneficiaryColumns.mockResolvedValue([] as BeneficiaryColumnSummary[]);
  listSourceRecords.mockResolvedValue(RECORDS);
  listDispositions.mockResolvedValue(DISPOSITIONS);
  getOrganizations.mockResolvedValue(ORGS);
  searchSourceFiles.mockResolvedValue([]);
  searchBatchEntries.mockResolvedValue([]);
  searchCentralItems.mockResolvedValue([]);
}

/** Renders and waits until the review table has painted its three entities. */
async function renderWorkbench() {
  const view = render(<CentralNeedsScreen />);
  await waitFor(() => expect(listSourceRecords).toHaveBeenCalledWith(SESSION_ID));
  // The entity id appears twice per row (the visually-hidden checkbox label and
  // the row header code), so wait on the painted table rather than on the text.
  await waitFor(() => expect(visibleEntities()).toHaveLength(3));
  return view;
}

const count = (which: string) => document.querySelector(`[data-count="${which}"]`)?.textContent;
const visibleEntities = () =>
  [...document.querySelectorAll('.cn2b-table--review tbody th[scope="row"] code')].map((c) => c.textContent);
const fieldNamesFor = () =>
  [...document.querySelectorAll('.cn2b-table--review tbody tr')].map((r) => r.textContent ?? '');

beforeEach(() => {
  vi.clearAllMocks();
  appState.lang = 'en';
  appState.dir = 'ltr';
  appState.myPermissions = new Set(ALL_PERMISSIONS);
  loadAll();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), writable: true, configurable: true });
});
afterEach(() => cleanup());

// ============================================================================
// A. The review workbench counts what is actually on screen.
// ============================================================================
describe('UX-2A — review workbench counts', () => {
  it('renders total, visible, undecided and selected from already-loaded state', async () => {
    await renderWorkbench();
    expect(count('total')).toBe('3');
    expect(count('visible')).toBe('3');
    expect(count('undecided')).toBe('1');
    expect(count('selected')).toBe('0');
  });

  it('shows every UX-1 workflow stage still mounted alongside the workbench', async () => {
    const { container } = await renderWorkbench();
    expect([...container.querySelectorAll('section.cn2b-stage')].map((s) => (s as HTMLElement).dataset.stage))
      .toEqual(['plan', 'source', 'review', 'beneficiaries', 'need-lines', 'readiness']);
  });
});

// ============================================================================
// B. The filter is presentation. It calls nothing and decides nothing.
// ============================================================================
describe('UX-2A — the review filter is client-only', () => {
  it('filters without invoking ANY Central Needs read, search or write', async () => {
    await renderWorkbench();
    for (const m of [...ALL_SERVICE_READS, ...ALL_SERVICE_WRITES]) m.mockClear();

    fireEvent.change(screen.getByLabelText(T.cn2b_filter_text.en), { target: { value: 'Ibuprofen' } });
    fireEvent.change(screen.getByLabelText(T.cn2b_filter_decision.en), { target: { value: 'undecided' } });
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_filter_clear.en }));

    for (const m of ALL_SERVICE_READS) expect(m, m.getMockName()).not.toHaveBeenCalled();
    for (const m of ALL_SERVICE_WRITES) expect(m).not.toHaveBeenCalled();
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('matches an ENTITY GROUP and keeps every source field of that entity', async () => {
    await renderWorkbench();
    // "Ibuprofen" appears in ONE field of the not-applicable entity.
    fireEvent.change(screen.getByLabelText(T.cn2b_filter_text.en), { target: { value: 'Ibuprofen' } });

    expect(visibleEntities()).toEqual([ROW_NA]);
    expect(count('visible')).toBe('1');
    expect(count('total')).toBe('3');

    // Both of that entity's fields survive — evidence is never shown in part.
    const rows = fieldNamesFor();
    expect(rows).toHaveLength(2);
    expect(rows.join(' ')).toContain('Material');
    expect(rows.join(' ')).toContain('Quantity');
    expect(rows.join(' ')).toContain('80');
  });

  it('matches on provenance and on a recorded decision reason, not only on values', async () => {
    await renderWorkbench();
    fireEvent.change(screen.getByLabelText(T.cn2b_filter_text.en), { target: { value: 'C4' } });
    expect(visibleEntities()).toEqual([ROW_UNDECIDED]);

    fireEvent.change(screen.getByLabelText(T.cn2b_filter_text.en), { target: { value: 'Subtotal line' } });
    expect(visibleEntities()).toEqual([ROW_NA]);
  });

  it('offers exactly ALL / UNDECIDED / MAPPED / NOT APPLICABLE, and each narrows correctly', async () => {
    await renderWorkbench();
    const select = screen.getByLabelText(T.cn2b_filter_decision.en) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['all', 'undecided', 'mapped', 'not_applicable']);

    fireEvent.change(select, { target: { value: 'undecided' } });
    expect(visibleEntities()).toEqual([ROW_UNDECIDED]);

    fireEvent.change(select, { target: { value: 'mapped' } });
    expect(visibleEntities()).toEqual([ROW_MAPPED]);

    fireEvent.change(select, { target: { value: 'not_applicable' } });
    expect(visibleEntities()).toEqual([ROW_NA]);

    fireEvent.change(select, { target: { value: 'all' } });
    expect(visibleEntities()).toEqual([ROW_MAPPED, ROW_NA, ROW_UNDECIDED]);
  });

  it('restores every group when the filters are cleared', async () => {
    await renderWorkbench();
    fireEvent.change(screen.getByLabelText(T.cn2b_filter_text.en), { target: { value: 'Amoxicillin' } });
    fireEvent.change(screen.getByLabelText(T.cn2b_filter_decision.en), { target: { value: 'undecided' } });
    expect(visibleEntities()).toEqual([ROW_UNDECIDED]);

    fireEvent.click(screen.getByRole('button', { name: T.cn2b_filter_clear.en }));
    expect(visibleEntities()).toEqual([ROW_MAPPED, ROW_NA, ROW_UNDECIDED]);
    expect(count('visible')).toBe('3');
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('says so, rather than showing an empty table, when a filter matches nothing', async () => {
    await renderWorkbench();
    fireEvent.change(screen.getByLabelText(T.cn2b_filter_text.en), { target: { value: 'no-such-material' } });
    expect(count('visible')).toBe('0');
    expect(screen.getByText(T.cn2b_filter_no_matches.en)).toBeInTheDocument();
    expect(document.querySelector('.cn2b-table--review')).toBeNull();
  });
});

// ============================================================================
// C. Selection belongs to the reviewer, not to the filter.
// ============================================================================
describe('UX-2A — selection survives filtering', () => {
  it('keeps a hidden entity selected, and keeps saying so in the SELECTED count', async () => {
    await renderWorkbench();
    fireEvent.click(screen.getByRole('checkbox', { name: ROW_UNDECIDED }));
    expect(count('selected')).toBe('1');

    // Filter the selected entity OUT of view.
    fireEvent.change(screen.getByLabelText(T.cn2b_filter_text.en), { target: { value: 'Ibuprofen' } });
    expect(visibleEntities()).toEqual([ROW_NA]);
    expect(count('selected'), 'a hidden entity must stay selected').toBe('1');

    // Bring it back: still selected, and still checked.
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_filter_clear.en }));
    expect(count('selected')).toBe('1');
    expect(screen.getByRole('checkbox', { name: ROW_UNDECIDED })).toBeChecked();
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('never selects an entity as a side effect of filtering', async () => {
    await renderWorkbench();
    expect(count('selected')).toBe('0');
    fireEvent.change(screen.getByLabelText(T.cn2b_filter_text.en), { target: { value: 'Quantity' } });
    expect(count('visible')).toBe('3');
    expect(count('selected')).toBe('0');
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
  });
});

// ============================================================================
// D. The bulk gate keeps its two steps.
// ============================================================================
describe('UX-2A — bulk disposition still previews before it confirms', () => {
  it('requires a selection, a reason and an explicit count before confirm appears', async () => {
    await renderWorkbench();
    const previewBtn = () => screen.getByRole('button', { name: T.cn2b_bulk_preview.en });
    const confirmBtn = () => screen.queryByRole('button', { name: T.cn2b_bulk_confirm.en });

    // No selection, no reason — preview is refused and confirm does not exist.
    expect(previewBtn()).toBeDisabled();
    expect(confirmBtn()).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: ROW_UNDECIDED }));
    fireEvent.change(screen.getByLabelText(T.cn2b_bulk_reason.en), { target: { value: 'Not a dispensable material' } });
    expect(previewBtn()).toBeEnabled();
    expect(confirmBtn()).toBeNull();

    // The count is stated BEFORE confirm is offered, and nothing was written.
    fireEvent.click(previewBtn());
    expect(screen.getByText(new RegExp(`${T.cn2b_bulk_will_change.en}: 1`))).toBeInTheDocument();
    expect(confirmBtn()).not.toBeNull();
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });
});

// ============================================================================
// E. The source-search toolbar names its four states.
// ============================================================================
describe('UX-2A — source search state model', () => {
  const state = () => document.querySelector('.cn2b-searchstate') as HTMLElement | null;

  it('starts NOT STARTED, never "no results"', async () => {
    await renderWorkbench();
    expect(state()?.dataset.phase).toBe('idle');
    expect(state()).toHaveTextContent(T.cn2b_source_search_idle.en);
    expect(screen.queryByText(T.cn2b_source_search_empty.en)).toBeNull();
    expect(searchSourceFiles).not.toHaveBeenCalled();
  });

  it('reports SEARCHING while the existing bounded request is in flight, then the result count', async () => {
    await renderWorkbench();
    let release!: () => void;
    searchSourceFiles.mockImplementation(() => new Promise((resolve) => { release = () => resolve([]); }));
    searchBatchEntries.mockResolvedValue([]);

    fireEvent.change(screen.getByLabelText(T.cn2b_source_search.en), { target: { value: 'annual' } });
    await waitFor(() => expect(state()?.dataset.phase).toBe('searching'));
    expect(state()).toHaveTextContent(T.cn2b_source_search_running.en);

    release();
    await waitFor(() => expect(state()?.dataset.phase).toBe('done'));
    // Completed with zero results — stated as a result, not as the idle hint.
    expect(state()).toHaveTextContent(`${T.cn2b_source_search_results.en}: 0`);
    expect(screen.getByText(T.cn2b_source_search_empty.en)).toBeInTheDocument();
  });

  it('reports a non-zero result count when the same bounded search returns rows', async () => {
    await renderWorkbench();
    searchSourceFiles.mockResolvedValue([{ id: 'f1', originalFilename: 'needs-2026.xlsx', fileHash: 'a'.repeat(64) }]);
    searchBatchEntries.mockResolvedValue([]);

    fireEvent.change(screen.getByLabelText(T.cn2b_source_search.en), { target: { value: 'needs' } });
    await waitFor(() => expect(state()?.dataset.phase).toBe('done'));
    expect(state()).toHaveTextContent(`${T.cn2b_source_search_results.en}: 1`);
    expect(screen.getByText('needs-2026.xlsx')).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_source_search_empty.en)).toBeNull();
  });

  it('clears back to NOT STARTED and writes nothing', async () => {
    await renderWorkbench();
    searchSourceFiles.mockResolvedValue([{ id: 'f1', originalFilename: 'needs-2026.xlsx', fileHash: 'a'.repeat(64) }]);
    searchBatchEntries.mockResolvedValue([]);
    fireEvent.change(screen.getByLabelText(T.cn2b_source_search.en), { target: { value: 'needs' } });
    await waitFor(() => expect(state()?.dataset.phase).toBe('done'));

    for (const m of ALL_SERVICE_WRITES) m.mockClear();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_source_search_clear.en }));

    expect(state()?.dataset.phase).toBe('idle');
    expect(screen.queryByText('needs-2026.xlsx')).toBeNull();
    expect(screen.queryByText(T.cn2b_source_search_empty.en)).toBeNull();
    for (const m of ALL_SERVICE_WRITES) expect(m).not.toHaveBeenCalled();
  });
});

// ============================================================================
// F. Authority is exactly what it was.
// ============================================================================
describe('UX-2A — authorization is untouched', () => {
  it('gates the workbench on the same effective permissions, with no role supplied at all', async () => {
    await renderWorkbench();
    expect(screen.getByLabelText(T.cn2b_bulk_reason.en)).toBeInTheDocument();
    expect(screen.getByLabelText(T.cn2b_item_search.en)).toBeInTheDocument();

    cleanup();
    vi.clearAllMocks();
    loadAll();
    appState.myPermissions = new Set();
    await renderWorkbench();

    // Read-only: the filter workbench still works, the write surfaces do not exist.
    expect(screen.queryByLabelText(T.cn2b_bulk_reason.en)).toBeNull();
    expect(screen.queryByLabelText(T.cn2b_item_search.en)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByLabelText(T.cn2b_filter_text.en)).toBeInTheDocument();
    expect(count('total')).toBe('3');
  });

  it('introduces no role-name authorization shortcut in the UX-2A product source', () => {
    for (const rel of [
      'src/features/central-needs/CentralNeedsScreen.tsx',
      'src/features/central-needs/CentralNeedsDispositionTable.tsx',
    ]) {
      const body = read(rel);
      for (const role of [
        'super_admin', 'institution_admin', 'central_warehouse_manager',
        'warehouse_officer', 'outlet_officer', 'health_center_manager',
      ]) expect(body, `${rel} names ${role}`).not.toContain(role);
    }

    const screenSrc = read('src/features/central-needs/CentralNeedsScreen.tsx');
    for (const key of ['import', 'edit', 'approve']) {
      expect(screenSrc).toContain(`myPermissions.has('central_needs.${key}')`);
    }

    // The table decides authority from its canEdit prop alone — never a role.
    const tableSrc = read('src/features/central-needs/CentralNeedsDispositionTable.tsx');
    expect(tableSrc).not.toContain('myPermissions');
    expect(tableSrc).not.toMatch(/normalizeRole|isScreenAuthorized/);
  });

  it('contains no literal U+0000 byte in any UX-2A production file', () => {
    // A raw NUL makes the file binary to git and to every review tool that
    // reads it. The separator it stood for is kept, written as an escape.
    for (const rel of [
      'src/features/central-needs/CentralNeedsScreen.tsx',
      'src/features/central-needs/CentralNeedsDispositionTable.tsx',
      'src/shared/lib/central-needs.css',
      'src/shared/i18n/strings.ts',
    ]) {
      const bytes = readFileSync(join(ROOT, rel));
      expect(bytes.includes(0), `${rel} contains a literal NUL byte`).toBe(false);
    }
    const tableSrc = read('src/features/central-needs/CentralNeedsDispositionTable.tsx');
    expect(tableSrc).toContain("haystack.join('\\u0000')");
  });

  it('adds no new service call and keeps auto-mapping impossible', () => {
    const tableSrc = read('src/features/central-needs/CentralNeedsDispositionTable.tsx');
    // The filter reads props; it must not reach for a service inside the memo.
    const memo = tableSrc.slice(tableSrc.indexOf('const visibleGroups'), tableSrc.indexOf('function clearFilters'));
    for (const forbidden of ['searchCentralItems', 'setRecordDisposition', 'recordFieldOverride', 'await ']) {
      expect(memo, forbidden).not.toContain(forbidden);
    }
    // Mapping still takes an explicit per-row action with a reviewer-chosen id.
    expect(tableSrc).toContain("applyOne(group.targetEntity, 'mapped', itemQuery.trim())");
    expect(tableSrc).toContain('if (bulkPreview === null || bulkReason.trim() === \'\') return;');
  });
});

// ============================================================================
// G. Revision isolation — independent-review findings A, B and C.
// ============================================================================
/**
 * Everything beneath a revision belongs to THAT revision. These tests exist
 * because three ways of breaking that are invisible in a fast, single-revision
 * happy path:
 *
 *   * a "no revisions" claim made before the list has actually been read;
 *   * the previous revision's batches, sessions or review rows still on screen
 *     under the new revision's header;
 *   * a slow reply for revision A landing after B was selected and overwriting
 *     B — including a source search that was started under A.
 *
 * Each revision-scoped read is held open deliberately, so the transition itself
 * is observable rather than asserted on after it has already settled.
 */
describe('UX-2A corrective — revision-scoped isolation', () => {
  const REV_B = 'rev-2';
  const SESSION_B = 's2';
  const REVISION_B: PlanRevision = { ...REVISION, id: REV_B, planYear: 2027, revisionNumber: 1 };
  const SESSION_TWO: ImportSession = { ...SESSION, id: SESSION_B, planRevisionId: REV_B };

  const BATCH_A = { id: 'bA', planRevisionId: REV, containerFilename: 'ALPHA-2026.zip', containerKind: 'zip', containerSha256: 'a'.repeat(64), acceptedEntryCount: 1, excludedEntryCount: 0 } as unknown as ImportBatch;
  const BATCH_B = { id: 'bB', planRevisionId: REV_B, containerFilename: 'BRAVO-2027.zip', containerKind: 'zip', containerSha256: 'b'.repeat(64), acceptedEntryCount: 1, excludedEntryCount: 0 } as unknown as ImportBatch;

  const RECORDS_B: SourceRecord[] = [field('rB1', 'sheet:0:row:9', 9, 'Material', 'Ceftriaxone 1g', 'B9')];

  /** Revision-scoped reads, held open until the test releases them, per id. */
  let releasers: Record<string, Array<() => void>>;
  const gate = <T,>(value: (id: string) => T) => (id: string) =>
    new Promise<T>((resolve) => { (releasers[id] ??= []).push(() => resolve(value(id))); });
  const release = (id: string) => {
    const queued = releasers[id] ?? [];
    releasers[id] = [];
    for (const r of queued) r();
  };

  function gateRevisionReads() {
    releasers = {};
    listImportSessions.mockImplementation(gate((id) => (id === REV ? [SESSION] : [SESSION_TWO])));
    listImportBatches.mockImplementation(gate((id) => (id === REV ? [BATCH_A] : [BATCH_B])));
    listOverrides.mockImplementation(gate(() => []));
    fetchReviewReadiness.mockImplementation(gate(() => READINESS));
    listNeedLineLineage.mockImplementation(gate(() => ({ needLines: [], sources: [] })));
    listBeneficiaryColumns.mockImplementation(gate(() => []));
    listSourceRecords.mockImplementation(async (sid: string) => (sid === SESSION_ID ? RECORDS : RECORDS_B));
    listDispositions.mockImplementation(async (sid: string) => (sid === SESSION_ID ? DISPOSITIONS : []));
  }

  const searchState = () => document.querySelector('.cn2b-searchstate') as HTMLElement;
  const selectRevision = (id: string) =>
    fireEvent.change(screen.getByLabelText(T.cn2b_revision.en), { target: { value: id } });

  it('shows the list as LOADING, and never "no revisions", until the read resolves', async () => {
    let resolveList!: (rows: PlanRevision[]) => void;
    listPlanRevisions.mockImplementation(() => new Promise((r) => { resolveList = r; }));

    render(<CentralNeedsScreen />);
    await waitFor(() => expect(listPlanRevisions).toHaveBeenCalled());

    expect(screen.getAllByText(T.cn2b_revisions_loading.en).length).toBeGreaterThan(0);
    expect(screen.queryByText(T.cn2b_no_revisions.en), 'must not answer before the question resolves').toBeNull();

    resolveList([]);
    await waitFor(() => expect(screen.getAllByText(T.cn2b_no_revisions.en).length).toBeGreaterThan(0));
    expect(screen.queryByText(T.cn2b_revisions_loading.en)).toBeNull();
  });

  it('drops the previous revision evidence the moment another revision is selected', async () => {
    listPlanRevisions.mockResolvedValue([REVISION, REVISION_B]);
    gateRevisionReads();

    render(<CentralNeedsScreen />);
    await waitFor(() => expect(listImportBatches).toHaveBeenCalledWith(REV));
    release(REV);
    await screen.findByText('ALPHA-2026.zip');
    await waitFor(() => expect(visibleEntities()).toHaveLength(3));

    // B is now selected and its reads are still open.
    selectRevision(REV_B);
    await waitFor(() => expect(listImportBatches).toHaveBeenCalledWith(REV_B));

    expect(screen.queryByText('ALPHA-2026.zip'), 'an A batch must not sit under B').toBeNull();
    expect(screen.queryByText('BRAVO-2027.zip')).toBeNull();
    expect(visibleEntities(), 'A review rows must not sit under B').toHaveLength(0);
    expect(document.querySelector('.cn2b-table--review')).toBeNull();

    release(REV_B);
    await screen.findByText('BRAVO-2027.zip');
    expect(screen.queryByText('ALPHA-2026.zip')).toBeNull();
    await waitFor(() => expect(visibleEntities()).toEqual(['sheet:0:row:9']));
  });

  it('keeps the newest revision when an older reload resolves late, out of order', async () => {
    listPlanRevisions.mockResolvedValue([REVISION, REVISION_B]);
    gateRevisionReads();

    render(<CentralNeedsScreen />);
    await waitFor(() => expect(listImportBatches).toHaveBeenCalledWith(REV));

    // A is still open when B starts, and B answers first.
    selectRevision(REV_B);
    await waitFor(() => expect(listImportBatches).toHaveBeenCalledWith(REV_B));
    release(REV_B);
    await screen.findByText('BRAVO-2027.zip');

    // A answers afterwards, for a revision nobody is looking at any more.
    release(REV);
    await waitFor(() => expect(screen.queryByText('ALPHA-2026.zip')).toBeNull());
    expect(screen.getByText('BRAVO-2027.zip')).toBeInTheDocument();
    await waitFor(() => expect(visibleEntities()).toEqual(['sheet:0:row:9']));
  });

  it('clears a completed source search when the revision changes', async () => {
    listPlanRevisions.mockResolvedValue([REVISION, REVISION_B]);
    gateRevisionReads();
    searchSourceFiles.mockResolvedValue([{ id: 'f1', originalFilename: 'alpha-evidence.xlsx', fileHash: 'a'.repeat(64) }]);
    searchBatchEntries.mockResolvedValue([]);

    render(<CentralNeedsScreen />);
    await waitFor(() => expect(listImportBatches).toHaveBeenCalledWith(REV));
    release(REV);
    await screen.findByText('ALPHA-2026.zip');

    fireEvent.change(screen.getByLabelText(T.cn2b_source_search.en), { target: { value: 'alpha' } });
    await screen.findByText('alpha-evidence.xlsx');

    selectRevision(REV_B);
    await waitFor(() => expect(listImportBatches).toHaveBeenCalledWith(REV_B));

    expect(searchState().dataset.phase).toBe('idle');
    expect(screen.queryByText('alpha-evidence.xlsx'), 'A hits must not survive into B').toBeNull();
    expect((screen.getByLabelText(T.cn2b_source_search.en) as HTMLInputElement).value).toBe('');
  });

  it('ignores a source-search reply that arrives after the revision changed', async () => {
    listPlanRevisions.mockResolvedValue([REVISION, REVISION_B]);
    gateRevisionReads();
    let releaseSearch!: () => void;
    searchSourceFiles.mockImplementation(() => new Promise((resolve) => {
      releaseSearch = () => resolve([{ id: 'f1', originalFilename: 'late-alpha.xlsx', fileHash: 'a'.repeat(64) }]);
    }));
    searchBatchEntries.mockResolvedValue([]);

    render(<CentralNeedsScreen />);
    await waitFor(() => expect(listImportBatches).toHaveBeenCalledWith(REV));
    release(REV);
    await screen.findByText('ALPHA-2026.zip');

    fireEvent.change(screen.getByLabelText(T.cn2b_source_search.en), { target: { value: 'alpha' } });
    await waitFor(() => expect(searchState().dataset.phase).toBe('searching'));

    selectRevision(REV_B);
    await waitFor(() => expect(listImportBatches).toHaveBeenCalledWith(REV_B));
    release(REV_B);
    await screen.findByText('BRAVO-2027.zip');

    // The A search finally answers, for a revision that is gone.
    releaseSearch();
    await waitFor(() => expect(screen.queryByText('late-alpha.xlsx')).toBeNull());
    expect(searchState().dataset.phase).toBe('idle');
  });

  /**
   * RENDER-TIME attribution, not post-effect cleanup.
   *
   * Clearing the previous revision's state inside an effect happens AFTER the
   * render that already carries the new revisionId, so for one commit the old
   * evidence sits under the new revision's header. `fireEvent`/`act` normally
   * flush that effect before an assertion can observe it, which is exactly why
   * the earlier transition tests cannot prove this.
   *
   * So this asserts on the render itself: the select is changed OUTSIDE act,
   * with the effect deliberately not yet flushed, and the DOM is inspected in
   * that window. A guard that lives only in an effect fails here; a guard
   * evaluated during render passes.
   */
  it('does not render old revision evidence in the commit BEFORE the reset effect runs', async () => {
    listPlanRevisions.mockResolvedValue([REVISION, REVISION_B]);
    gateRevisionReads();

    render(<CentralNeedsScreen />);
    await waitFor(() => expect(listImportBatches).toHaveBeenCalledWith(REV));
    release(REV);
    await screen.findByText('ALPHA-2026.zip');
    await waitFor(() => expect(visibleEntities()).toHaveLength(3));

    const select = screen.getByLabelText(T.cn2b_revision.en) as HTMLSelectElement;
    // Drive React's onChange WITHOUT act(), so the state update commits but the
    // passive effect that resets revision-scoped state has not run yet.
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, REV_B);
    select.dispatchEvent(new Event('change', { bubbles: true }));

    // The selection has moved to B...
    expect((screen.getByLabelText(T.cn2b_revision.en) as HTMLSelectElement).value).toBe(REV_B);
    // ...and in this very commit, nothing from A may be presented as B's.
    expect(screen.queryByText('ALPHA-2026.zip'), 'A batch rendered under B').toBeNull();
    expect(visibleEntities(), 'A review rows rendered under B').toHaveLength(0);
    expect(document.querySelector('.cn2b-table--review')).toBeNull();

    // And the counts refuse to attribute a number to an unproven revision.
    const summary = screen.getByRole('region', { name: T.cn2b_summary_label.en });
    expect(within(summary).getAllByText('—').length).toBeGreaterThan(0);

    // Settle B so the test leaves no pending work behind.
    await waitFor(() => expect(listImportBatches).toHaveBeenCalledWith(REV_B));
    release(REV_B);
    await screen.findByText('BRAVO-2027.zip');
  });

  it('reports a refused search as FAILED with its translated code, never as zero results', async () => {
    const { CentralNeedsError } = await import('../central-needs.service');
    await renderWorkbench();
    searchSourceFiles.mockRejectedValue(new CentralNeedsError('forbidden'));
    searchBatchEntries.mockResolvedValue([]);

    fireEvent.change(screen.getByLabelText(T.cn2b_source_search.en), { target: { value: 'anything' } });
    await waitFor(() => expect(searchState().dataset.phase).toBe('failed'));

    expect(screen.getByText(T.cn2b_source_search_failed.en)).toBeInTheDocument();
    expect(screen.getByText(T.cn2b_err_forbidden.en)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_source_search_empty.en), 'a refusal is not "nothing matched"').toBeNull();
  });
});
