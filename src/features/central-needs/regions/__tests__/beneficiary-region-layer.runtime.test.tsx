/** @vitest-environment jsdom */
/**
 * C4 — the persisted region layer on the Excel-first surface.
 *
 * Saved ACTIVE versions and unsaved E2-C drafts are two layers; drafts become
 * server truth only through an explicit, reasoned, fenced call; a conversion
 * sends the M213 fence verbatim and never a region of its own; a stale refusal
 * reloads and asks again (never an automatic retry); a failed read, a missing
 * permission or a G3 mismatch leaves every write unavailable.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  BeneficiaryRegionVersion, ImportSession, ScopeColumnMapping,
} from '../../central-needs.service';
import type { InstitutionMappingController } from '../../mapping/useInstitutionMapping';
import type { InstitutionMapping, InstitutionMappingState } from '../../mapping/institutionMapping';
import { EMPTY_INSTITUTION_DRAFT } from '../../mapping/institutionMapping';

const listBeneficiaryRegions = vi.fn();
const listScopeColumnMappings = vi.fn();
const setBeneficiaryRegions = vi.fn();
vi.mock('../../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../../central-needs.service')>('../../central-needs.service');
  return {
    ...actual,
    listBeneficiaryRegions: (...a: unknown[]) => listBeneficiaryRegions(...a),
    listScopeColumnMappings: (...a: unknown[]) => listScopeColumnMappings(...a),
    setBeneficiaryRegions: (...a: unknown[]) => setBeneficiaryRegions(...a),
  };
});

const { BeneficiaryRegionLayer } = await import('../BeneficiaryRegionLayer');
const { RUNNING_PARSER_IDENTITY } = await import('../beneficiaryRegions');
const { CentralNeedsError } = await import('../../central-needs.service');

const WHOLE = 1_048_575;
const SESSION = 'session-1';
const ORGS = [
  { id: 'org-a', name: 'Hospital A', name_ar: 'مستشفى أ', code: 'a' },
  { id: 'org-b', name: 'Hospital B', name_ar: 'مستشفى ب', code: 'b' },
];

const session = (identity: Record<string, unknown> = { ...RUNNING_PARSER_IDENTITY, runtime: 'node' }): ImportSession => ({
  id: SESSION, planRevisionId: 'rev-1', sourceFileId: 'f', status: 'completed', previewDigest: null,
  authoritativeDigest: null, parserIdentity: identity, startedAt: 't', completedAt: 't', notes: null,
});
const version = (over: Partial<BeneficiaryRegionVersion> = {}): BeneficiaryRegionVersion => ({
  versionId: 'v-1', regionId: 'r-1', versionNo: 2, supersedesVersionId: 'v-0', planRevisionId: 'rev-1',
  importSessionId: SESSION, sheetIndex: 0, rowStart: 1, rowEnd: 20, columnStart: 2, columnEnd: 2,
  decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', decisionReason: 'confirmed', decidedBy: 'u', decidedAt: 't',
  ...over,
});
const m213 = (over: Partial<ScopeColumnMapping> = {}): ScopeColumnMapping => ({
  mappingId: 'm-5', importSessionId: SESSION, sheetIndex: 0, columnIndex: 5, decision: 'beneficiary',
  beneficiaryOrganizationId: 'org-b', mappedAt: '2026-09-01T10:00:00.123456+00:00', ...over,
});
const draft = (id: string, need: InstitutionMapping['need'], ben = 'org-a'): InstitutionMapping => ({
  id, anchor: { kind: 'cell', rowIndex: 0, columnIndex: 9, mergedRange: null }, need, beneficiaryOrganizationId: ben,
});

function controller(mappings: InstitutionMapping[] = [], selection: InstitutionMappingState['selection'] = null) {
  const source = { batchId: 'b', entryId: 'e', entryOrdinal: 1, entrySha256: 'a'.repeat(64), importSessionId: SESSION, workbookIndex: 0 };
  const state: InstitutionMappingState = {
    selection, context: { source, sheetIndex: 0, sheetName: 'Needs 2026' }, mappings, draft: EMPTY_INSTITUTION_DRAFT,
    nextKey: mappings.length + 1, resetPending: false, outcome: null, outcomeSeq: 0,
  };
  return {
    state, observeSelection: vi.fn(), captureAnchor: vi.fn(), captureNeed: vi.fn(), chooseBeneficiary: vi.fn(),
    commit: vi.fn(), edit: vi.fn(), cancelEdit: vi.fn(), remove: vi.fn(), requestReset: vi.fn(),
    confirmReset: vi.fn(), cancelReset: vi.fn(),
  } satisfies InstitutionMappingController;
}

function renderLayer(opts: {
  institutions?: InstitutionMappingController; canWrite?: boolean; sessions?: ImportSession[]; onChanged?: () => void;
  planRevisionId?: string;
} = {}) {
  const institutions = opts.institutions ?? controller();
  const onChanged = opts.onChanged ?? vi.fn();
  const view = render(
    <BeneficiaryRegionLayer
      lang="en" planRevisionId={opts.planRevisionId ?? 'rev-1'} canWrite={opts.canWrite ?? true}
      careInstitutions={ORGS} sessions={opts.sessions ?? [session()]} institutions={institutions} onChanged={onChanged}
    />,
  );
  return { ...view, institutions, onChanged };
}

const ready = async () => waitFor(() => expect(screen.getByTestId('cn4-region-layer')).toHaveAttribute('data-phase', 'ready'));
const writeControls = () => [
  ...screen.queryAllByTestId('cn4-region-save-drafts'), ...screen.queryAllByTestId('cn4-region-remove'),
  ...screen.queryAllByTestId('cn4-region-replace'), ...screen.queryAllByTestId('cn4-region-convert'),
  ...screen.queryAllByTestId('cn4-region-mark-non-beneficiary'),
];

beforeEach(() => {
  listBeneficiaryRegions.mockResolvedValue([version()]);
  listScopeColumnMappings.mockResolvedValue([]);
  setBeneficiaryRegions.mockResolvedValue({ operationBatchId: 'b', activeVersions: [], changes: [], convertedColumns: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('C4 region layer — two layers, never mixed', () => {
  it('shows the server\'s ACTIVE versions apart from the unsaved E2-C drafts, and injects nothing into E2-C', async () => {
    const { institutions } = renderLayer({ institutions: controller([draft('im-1', { kind: 'column', columnIndex: 3 })]) });
    await ready();
    expect(listBeneficiaryRegions).toHaveBeenCalledWith({ planRevisionId: 'rev-1', importSessionId: SESSION, sheetIndex: 0 });
    expect(listScopeColumnMappings).toHaveBeenCalledWith({ planRevisionId: 'rev-1', importSessionId: SESSION, sheetIndex: 0 });
    const saved = screen.getByTestId('cn4-region-saved');
    expect(within(saved).getAllByTestId('cn4-region-version').map((li) => li.getAttribute('data-version-id'))).toEqual(['v-1']);
    expect(within(saved).getByText(/Hospital A/)).toBeInTheDocument();
    expect(screen.getByTestId('cn4-region-unsaved-draft')).toHaveAttribute('data-draft-id', 'im-1');
    expect(within(screen.getByTestId('cn4-region-unsaved')).queryByText(/v-1/)).toBeNull();
    expect(institutions.commit).not.toHaveBeenCalled();
    expect(institutions.captureNeed).not.toHaveBeenCalled();
    expect(institutions.remove).not.toHaveBeenCalled();
  });

  it('a correction revision reads only ITS OWN regions — nothing is carried over from a predecessor', async () => {
    listBeneficiaryRegions.mockResolvedValue([]);
    renderLayer({ planRevisionId: 'rev-correction' });
    await ready();
    expect(listBeneficiaryRegions).toHaveBeenCalledWith(expect.objectContaining({ planRevisionId: 'rev-correction' }));
    expect(screen.getByTestId('cn4-region-empty')).toBeInTheDocument();
  });
});

describe('C4 region layer — fail closed', () => {
  it('without the write gate every region control is absent', async () => {
    renderLayer({ canWrite: false, institutions: controller([draft('im-1', { kind: 'column', columnIndex: 3 })]) });
    await ready();
    expect(screen.getByTestId('cn4-region-read-only')).toBeInTheDocument();
    expect(writeControls()).toHaveLength(0);
  });

  it('G3: a session imported under another parser identity is view only', async () => {
    renderLayer({ sessions: [session({ ...RUNNING_PARSER_IDENTITY, sheetjsTarballSha256: 'f'.repeat(64), runtime: 'node' })] });
    await ready();
    expect(screen.getByTestId('cn4-region-g3-read-only')).toBeInTheDocument();
    expect(writeControls()).toHaveLength(0);
  });

  it('a failed or inconsistent read shows the layer as unavailable, with no write', async () => {
    listBeneficiaryRegions.mockRejectedValue(new CentralNeedsError('beneficiary_regions_read_inconsistent'));
    renderLayer();
    await waitFor(() => expect(screen.getByTestId('cn4-region-unavailable')).toBeInTheDocument());
    expect(writeControls()).toHaveLength(0);
  });

  it('a loaded scope where an ACTIVE version spans an M213 column is unavailable (X1 cannot hold both)', async () => {
    listBeneficiaryRegions.mockResolvedValue([version({ columnStart: 4, columnEnd: 6 })]);
    listScopeColumnMappings.mockResolvedValue([m213({ columnIndex: 5 })]);
    renderLayer();
    await waitFor(() => expect(screen.getByTestId('cn4-region-unavailable')).toBeInTheDocument());
    expect(writeControls()).toHaveLength(0);
  });
});

describe('C4 region layer — explicit, reasoned, fenced writes', () => {
  it('saves committed drafts as adds (a whole column is full height), fenced on the loaded ACTIVE ids, only with a reason', async () => {
    const drafts = [draft('im-1', { kind: 'column', columnIndex: 3 }), draft('im-2', { kind: 'range', startRow: 21, endRow: 40, startColumn: 2, endColumn: 2 }, 'org-b')];
    const onChanged = vi.fn();
    const institutions = controller(drafts);
    renderLayer({ institutions, onChanged });
    await ready();
    fireEvent.click(screen.getByTestId('cn4-region-save-drafts'));
    const send = screen.getByTestId('cn4-region-confirm-send');
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByTestId('cn4-region-reason'), { target: { value: '   ' } });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByTestId('cn4-region-reason'), { target: { value: 'declared from the workbook' } });
    fireEvent.click(send);
    await waitFor(() => expect(setBeneficiaryRegions).toHaveBeenCalledTimes(1));
    expect(setBeneficiaryRegions).toHaveBeenCalledWith({
      planRevisionId: 'rev-1', importSessionId: SESSION, sheetIndex: 0,
      renderedParserIdentity: RUNNING_PARSER_IDENTITY, expectedSheetName: 'Needs 2026',
      expectedVersionIds: ['v-1'], reason: 'declared from the workbook',
      changes: [
        { op: 'add', rowStart: 0, rowEnd: WHOLE, columnStart: 3, columnEnd: 3, decision: 'beneficiary', beneficiaryOrganizationId: 'org-a' },
        { op: 'add', rowStart: 21, rowEnd: 40, columnStart: 2, columnEnd: 2, decision: 'beneficiary', beneficiaryOrganizationId: 'org-b' },
      ],
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(institutions.remove.mock.calls.map((c) => c[0])).toEqual(['im-1', 'im-2']);
    expect(listBeneficiaryRegions).toHaveBeenCalledTimes(2);
  });

  it('a draft overlapping a saved region, or lying on an M213 column, cannot be saved', async () => {
    listScopeColumnMappings.mockResolvedValue([m213()]);
    renderLayer({ institutions: controller([
      draft('im-1', { kind: 'range', startRow: 10, endRow: 30, startColumn: 2, endColumn: 2 }),
      draft('im-2', { kind: 'column', columnIndex: 5 }),
    ]) });
    await ready();
    expect(screen.getAllByTestId('cn4-region-obstacle').map((o) => o.getAttribute('data-reason'))).toEqual(['REGION_OVERLAP', 'M213_COLUMN']);
    expect(screen.getByTestId('cn4-region-save-drafts')).toBeDisabled();
  });

  it('convert to regions: explicit, nothing prefilled, the M213 fence sent verbatim with the human\'s own regions', async () => {
    listBeneficiaryRegions.mockResolvedValue([]);
    listScopeColumnMappings.mockResolvedValue([m213({ decision: 'non_beneficiary', beneficiaryOrganizationId: null })]);
    const { rerender, institutions, onChanged } = renderLayer({ institutions: controller([]) });
    await ready();
    // Choosing to convert creates nothing by itself.
    fireEvent.click(screen.getByTestId('cn4-region-convert'));
    expect(screen.getByTestId('cn4-region-converting-hint')).toBeInTheDocument();
    expect(screen.getByTestId('cn4-region-conversion-needs-region')).toBeInTheDocument();
    expect(screen.getByTestId('cn4-region-save-drafts')).toBeDisabled();
    expect(screen.queryAllByTestId('cn4-region-unsaved-draft')).toHaveLength(0);
    expect(institutions.commit).not.toHaveBeenCalled();
    // The human draws two stacked rectangles over column 5 on the workbook.
    const drawn = controller([
      draft('im-1', { kind: 'range', startRow: 1, endRow: 20, startColumn: 5, endColumn: 5 }, 'org-a'),
      draft('im-2', { kind: 'range', startRow: 22, endRow: 40, startColumn: 5, endColumn: 5 }, 'org-b'),
    ]);
    rerender(
      <BeneficiaryRegionLayer lang="en" planRevisionId="rev-1" canWrite careInstitutions={ORGS} sessions={[session()]}
        institutions={drawn} onChanged={onChanged} />,
    );
    await waitFor(() => expect(screen.getByTestId('cn4-region-save-drafts')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('cn4-region-save-drafts'));
    fireEvent.change(screen.getByTestId('cn4-region-reason'), { target: { value: 'stacked column' } });
    fireEvent.click(screen.getByTestId('cn4-region-confirm-send'));
    await waitFor(() => expect(setBeneficiaryRegions).toHaveBeenCalledTimes(1));
    const { changes } = setBeneficiaryRegions.mock.calls[0][0];
    expect(changes).toEqual([
      { op: 'convert_column', columnIndex: 5, expectedMappingId: 'm-5', previousDecision: 'non_beneficiary',
        previousBeneficiaryOrganizationId: null, previousMappedAt: '2026-09-01T10:00:00.123456+00:00' },
      { op: 'add', rowStart: 1, rowEnd: 20, columnStart: 5, columnEnd: 5, decision: 'beneficiary', beneficiaryOrganizationId: 'org-a' },
      { op: 'add', rowStart: 22, rowEnd: 40, columnStart: 5, columnEnd: 5, decision: 'beneficiary', beneficiaryOrganizationId: 'org-b' },
    ]);
  });

  it('a stale refusal reloads the layer and asks again — the call is never retried and the drafts stay unsaved', async () => {
    setBeneficiaryRegions.mockRejectedValue(new CentralNeedsError('beneficiary_region_stale'));
    const { institutions, onChanged } = renderLayer({ institutions: controller([draft('im-1', { kind: 'column', columnIndex: 3 })]) });
    await ready();
    fireEvent.click(screen.getByTestId('cn4-region-save-drafts'));
    fireEvent.change(screen.getByTestId('cn4-region-reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('cn4-region-confirm-send'));
    await waitFor(() => expect(screen.getByTestId('cn4-region-message')).toHaveAttribute('data-tone', 'error'));
    expect(screen.getByTestId('cn4-region-message').textContent).toMatch(/changed since they were loaded/);
    await new Promise((r) => setTimeout(r, 30));
    expect(setBeneficiaryRegions).toHaveBeenCalledTimes(1);
    expect(listBeneficiaryRegions).toHaveBeenCalledTimes(2);
    expect(institutions.remove).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByTestId('cn4-region-confirm')).toBeNull();
  });

  it('remove names the ACTIVE version and needs a reason; a refusal (in use) is shown and nothing else happens', async () => {
    setBeneficiaryRegions.mockRejectedValue(new CentralNeedsError('beneficiary_region_in_use'));
    renderLayer();
    await ready();
    fireEvent.click(screen.getByTestId('cn4-region-remove'));
    fireEvent.change(screen.getByTestId('cn4-region-reason'), { target: { value: 'wrong area' } });
    fireEvent.click(screen.getByTestId('cn4-region-confirm-send'));
    await waitFor(() => expect(setBeneficiaryRegions).toHaveBeenCalledTimes(1));
    expect(setBeneficiaryRegions.mock.calls[0][0]).toMatchObject({ expectedVersionIds: ['v-1'], changes: [{ op: 'remove', versionId: 'v-1' }] });
    await waitFor(() => expect(screen.getByTestId('cn4-region-message').textContent).toMatch(/delete that line with a reason first/i));
  });

  it('replace takes the CURRENT selection and an explicit decision and beneficiary — nothing is prefilled', async () => {
    const source = { batchId: 'b', entryId: 'e', entryOrdinal: 1, entrySha256: 'a'.repeat(64), importSessionId: SESSION, workbookIndex: 0 };
    const selection = { kind: 'range' as const, source, sheetIndex: 0, sheetName: 'Needs 2026', startRow: 1, endRow: 10, startColumn: 2, endColumn: 2, a1Range: 'C2:C11' };
    renderLayer({ institutions: controller([], selection) });
    await ready();
    fireEvent.click(screen.getByTestId('cn4-region-replace'));
    expect(screen.getByTestId('cn4-region-beneficiary')).toHaveValue('');
    fireEvent.change(screen.getByTestId('cn4-region-reason'), { target: { value: 'narrowed' } });
    expect(screen.getByTestId('cn4-region-confirm-send')).toBeDisabled();
    fireEvent.change(screen.getByTestId('cn4-region-beneficiary'), { target: { value: 'org-b' } });
    fireEvent.click(screen.getByTestId('cn4-region-confirm-send'));
    await waitFor(() => expect(setBeneficiaryRegions).toHaveBeenCalledTimes(1));
    expect(setBeneficiaryRegions.mock.calls[0][0].changes).toEqual([
      { op: 'replace', versionId: 'v-1', rowStart: 1, rowEnd: 10, columnStart: 2, columnEnd: 2, decision: 'beneficiary', beneficiaryOrganizationId: 'org-b' },
    ]);
  });
});
