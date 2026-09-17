/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  BeneficiaryColumnSummary, FieldOverride, ImportBatch, ImportSession,
  NeedLine, NeedLineSourceLink, PlanRevision, RecordDisposition, ReviewReadiness, SourceRecord,
} from '../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

/**
 * BENEFICIARY_PANEL_INTEGRATION_TEST (213) — the actual screen wiring, not
 * source inspection: `listBeneficiaryColumns()` → shared `beneficiaryColumns`
 * state → `CentralNeedsBeneficiaryColumnPanel` (confirms one column) →
 * `onChanged` → `reloadRevision` → a FRESH `listBeneficiaryColumns()` read →
 * the SAME state, now flowing into `CentralNeedsNeedLinePanel`, which must
 * re-render its candidate from "unresolved" to "resolved" without a page
 * reload or any manual prop wiring in the test itself.
 *
 * Both real, unmocked panels are rendered inside the real `CentralNeedsScreen`
 * — only the Supabase-backed service boundary and `useApp` are mocked, so
 * this proves the SCREEN's own data flow, not a hand-assembled substitute.
 */

const ORG = 'org-1';
const REV = 'rev-1';
const SESSION_ID = 's1';
const ROW = 'sheet:0:row:1';
const ITEM = '00000000-0000-0000-0000-0000000000a1';
const HOSPITAL_A = '00000000-0000-0000-0000-0000000000b1';

const setBeneficiaryColumns = vi.fn();
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

vi.mock('@/app/AppContext', () => ({
  useApp: () => ({
    lang: 'en', dir: 'ltr', activeOrgId: ORG,
    profile: { organization_id: ORG },
    myPermissions: new Set(['central_needs.import', 'central_needs.edit', 'central_needs.approve']),
  }),
}));

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
    setBeneficiaryColumns: (...a: unknown[]) => setBeneficiaryColumns(...a),
    // Not exercised by this test — present only so nothing destructures undefined.
    recordFieldOverride: vi.fn(),
    searchCentralItems: vi.fn(async () => []),
    setRecordDisposition: vi.fn(),
    searchBatchEntries: vi.fn(async () => []),
    searchSourceFiles: vi.fn(async () => []),
  };
});

const { CentralNeedsScreen } = await import('../CentralNeedsScreen');


function showStage(id: 'beneficiaries' | 'need-lines') {
  const button = document.querySelector<HTMLButtonElement>(`.cn2b-stagelink[data-stage="${id}"]`);
  expect(button, id).not.toBeNull();
  fireEvent.click(button!);
}

const ORGS: OrgRow[] = [
  { id: HOSPITAL_A, name: 'Beneficiary Hospital', name_ar: 'مستشفى المنتفع', code: 'ha', status: 'active', organizationKind: 'care_institution' },
] as unknown as OrgRow[];

const REVISION: PlanRevision = { id: REV, planId: 'plan-1', organizationId: ORG, planYear: 2026, revisionNumber: 1, status: 'draft' };
const SESSION: ImportSession = {
  id: SESSION_ID, planRevisionId: REV, sourceFileId: 'f1', status: 'completed',
  previewDigest: 'digest', authoritativeDigest: 'digest', parserIdentity: null,
  startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', notes: null,
};
const READINESS: ReviewReadiness = { planRevisionId: REV, status: 'draft', ready: false, blockers: [] };
const DISPOSITION: RecordDisposition = {
  id: 'd1', importSessionId: SESSION_ID, targetEntity: ROW,
  decision: 'mapped', centralItemId: ITEM, decisionReason: null, decidedAt: '2026-01-01T00:00:00.000Z',
};
const RECORD: SourceRecord = {
  id: 'rec-1', importSessionId: SESSION_ID, recordOrdinal: 1, targetEntity: ROW, fieldName: 'Hospital A',
  sourceValues: { value: 100 }, sourceProvenance: { sheetIndex: 0, coordinate: { col: 5 } },
};
const UNCONFIRMED_COLUMN: BeneficiaryColumnSummary = {
  importSessionId: SESSION_ID, originalFilename: 'need-2026.xlsx', archiveEntryPath: null,
  sheetIndex: 0, sheetName: 'Sheet1', columnIndex: 5, sourceFieldName: 'Hospital A',
  numericValueCount: 1, zeroValueCount: 0, nonzeroNumericCount: 1,
  mappingId: null, decision: null, beneficiaryOrganizationId: null, mappingReason: null, mappedAt: null,
  mappedRowNumericCount: 1, reviewRequired: true,
};
const CONFIRMED_COLUMN: BeneficiaryColumnSummary = {
  ...UNCONFIRMED_COLUMN, mappingId: 'm-1', decision: 'beneficiary', beneficiaryOrganizationId: HOSPITAL_A,
  mappingReason: 'confirmed', mappedAt: '2026-01-02T00:00:00.000Z', reviewRequired: false,
};

function setupReload(columns: BeneficiaryColumnSummary[]) {
  listImportSessions.mockResolvedValue([SESSION]);
  listImportBatches.mockResolvedValue([] as ImportBatch[]);
  listOverrides.mockResolvedValue([] as FieldOverride[]);
  fetchReviewReadiness.mockResolvedValue(READINESS);
  listNeedLineLineage.mockResolvedValue({ needLines: [] as NeedLine[], sources: [] as NeedLineSourceLink[] });
  listBeneficiaryColumns.mockResolvedValueOnce(columns);
}

beforeEach(() => {
  vi.clearAllMocks();
  getOrganizations.mockResolvedValue(ORGS);
  listPlanRevisions.mockResolvedValue([REVISION]);
  listDispositions.mockResolvedValue([DISPOSITION]);
  listSourceRecords.mockResolvedValue([RECORD]);
  setBeneficiaryColumns.mockResolvedValue({ confirmed: [] });
});
afterEach(() => cleanup());

describe('CentralNeedsScreen — beneficiary-column mapping reaches the need-line panel (213)', () => {
  it('feeds the SAME listBeneficiaryColumns() read into both panels, and a confirmed mapping change reloads both', async () => {
    setupReload([UNCONFIRMED_COLUMN]);
    render(<CentralNeedsScreen initialMode="advanced" />);

    // 1. Initial load reads beneficiary columns for the revision.
    await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledWith(REV));
    expect(listBeneficiaryColumns).toHaveBeenCalledTimes(1);

    // 2. The Need-Line panel's candidate is UNRESOLVED (column not yet confirmed).
    showStage('need-lines');
    const candidate = await screen.findByTestId('cn2b-nl-candidate');
    expect(candidate).toHaveAttribute('data-beneficiary-resolved', 'false');
    expect(within(candidate).getByTestId('cn2b-nl-candidate-unmapped')).toBeInTheDocument();

    // 3. The Beneficiary Column panel shows the SAME physical column, unconfirmed.
    showStage('beneficiaries');
    expect(screen.getByText(/#5$/)).toBeInTheDocument();

    // 4. Confirm it in the (real, unmocked) column panel — this is the ONLY
    // place a beneficiary is ever set, never a choice in the need-line panel.
    setupReload([CONFIRMED_COLUMN]); // what the NEXT listBeneficiaryColumns() call returns, post-reload
    setBeneficiaryColumns.mockResolvedValue({
      confirmed: [{
        importSessionId: SESSION_ID, sheetIndex: 0, columnIndex: 5,
        beneficiaryOrganizationId: HOSPITAL_A, sourceFieldName: 'Hospital A', created: true, changed: false,
      }],
    });
    const columnRow = screen.getByText(/#5$/).parentElement!.parentElement as HTMLElement;
    fireEvent.change(within(columnRow).getByRole('combobox'), { target: { value: HOSPITAL_A } });
    fireEvent.click(within(columnRow).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(setBeneficiaryColumns).toHaveBeenCalledTimes(1));
    expect(setBeneficiaryColumns.mock.calls[0][0].mappings).toEqual([{
      importSessionId: SESSION_ID, sheetIndex: 0, columnIndex: 5,
      decision: 'beneficiary', beneficiaryOrganizationId: HOSPITAL_A,
      previousDecision: null, previousBeneficiaryOrganizationId: null,
    }]);

    // 5. onChanged → reloadRevision → a SECOND listBeneficiaryColumns() read.
    await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledTimes(2));

    // 6. The Need-Line panel's candidate — never told anything directly by
    // this test — now resolves the SAME beneficiary the column panel confirmed.
    showStage('need-lines');
    await waitFor(() => {
      const c = screen.getByTestId('cn2b-nl-candidate');
      expect(c).toHaveAttribute('data-beneficiary-resolved', 'true');
      expect(within(c).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital');
    });
  });

  it('reloads dispositions/need-lines/readiness together with beneficiary columns on every change — one shared revision reload, not a beneficiary-only patch', async () => {
    setupReload([UNCONFIRMED_COLUMN]);
    render(<CentralNeedsScreen initialMode="advanced" />);
    await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledTimes(1));
    expect(fetchReviewReadiness).toHaveBeenCalledTimes(1);
    expect(listNeedLineLineage).toHaveBeenCalledTimes(1);

    setupReload([CONFIRMED_COLUMN]);
    setBeneficiaryColumns.mockResolvedValue({ confirmed: [] });
    showStage('beneficiaries');
    const columnRow = screen.getByText(/#5$/).parentElement!.parentElement as HTMLElement;
    fireEvent.change(within(columnRow).getByRole('combobox'), { target: { value: HOSPITAL_A } });
    fireEvent.click(within(columnRow).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(listBeneficiaryColumns).toHaveBeenCalledTimes(2));
    expect(fetchReviewReadiness).toHaveBeenCalledTimes(2);
    expect(listNeedLineLineage).toHaveBeenCalledTimes(2);
  });
});
