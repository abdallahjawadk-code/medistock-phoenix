/** @vitest-environment jsdom */
/**
 * CN-UI-S1 HC1.1 — the beneficiary-region layer's own activity, surfaced upward
 * (H1_1_17, H1_1_18, H1_1_19, H1_1_20, H1_1_22).
 *
 * The layer reports `{ busy, dirty, failed }` read off the state it already had:
 *
 *   * dirty — a column marked for conversion, a pending confirmation, or a reason
 *     typed for it. Server-saved ACTIVE regions are saved truth, never work;
 *   * busy  — a `setBeneficiaryRegions` call in flight;
 *   * failed — the last write was refused;
 *   * and every report is released (all false) when the layer leaves the tree.
 *
 * Nothing about persistence changes: the write payload, the stale fence and the
 * reload rules are proven by the C4 suite beside this one.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type { BeneficiaryRegionVersion, ImportSession, ScopeColumnMapping } from '../../central-needs.service';
import type { InstitutionMappingController } from '../../mapping/useInstitutionMapping';
import type { InstitutionMappingState } from '../../mapping/institutionMapping';
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

const { BeneficiaryRegionLayer, regionLayerHasLocalWork } = await import('../BeneficiaryRegionLayer');
const { RUNNING_PARSER_IDENTITY } = await import('../beneficiaryRegions');
const { CentralNeedsError } = await import('../../central-needs.service');

type Activity = { busy: boolean; dirty: boolean; failed: boolean };
const IDLE: Activity = { busy: false, dirty: false, failed: false };

const SESSION = 'session-1';
const ORGS = [
  { id: 'org-a', name: 'Hospital A', name_ar: 'مستشفى أ', code: 'a' },
  { id: 'org-b', name: 'Hospital B', name_ar: 'مستشفى ب', code: 'b' },
];
const session = (): ImportSession => ({
  id: SESSION, planRevisionId: 'rev-1', sourceFileId: 'f', status: 'completed', previewDigest: null,
  authoritativeDigest: null, parserIdentity: { ...RUNNING_PARSER_IDENTITY, runtime: 'node' }, startedAt: 't', completedAt: 't', notes: null,
});
const version = (): BeneficiaryRegionVersion => ({
  versionId: 'v-1', regionId: 'r-1', versionNo: 2, supersedesVersionId: 'v-0', planRevisionId: 'rev-1',
  importSessionId: SESSION, sheetIndex: 0, rowStart: 1, rowEnd: 20, columnStart: 2, columnEnd: 2,
  decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', decisionReason: 'confirmed', decidedBy: 'u', decidedAt: 't',
});
const m213 = (): ScopeColumnMapping => ({
  mappingId: 'm-5', importSessionId: SESSION, sheetIndex: 0, columnIndex: 5, decision: 'beneficiary',
  beneficiaryOrganizationId: 'org-b', mappedAt: '2026-09-01T10:00:00.123456+00:00',
});
const source = { batchId: 'b', entryId: 'e', entryOrdinal: 1, entrySha256: 'a'.repeat(64), importSessionId: SESSION, workbookIndex: 0 };
const RANGE_SELECTION = {
  kind: 'range' as const, source, sheetIndex: 0, sheetName: 'Needs 2026', startRow: 1, endRow: 10, startColumn: 2, endColumn: 2, a1Range: 'C2:C11',
};

function controller(selection: InstitutionMappingState['selection'] = null): InstitutionMappingController {
  const state: InstitutionMappingState = {
    selection, context: { source, sheetIndex: 0, sheetName: 'Needs 2026' }, mappings: [], draft: EMPTY_INSTITUTION_DRAFT,
    nextKey: 1, resetPending: false, outcome: null, outcomeSeq: 0,
  };
  return {
    state, observeSelection: vi.fn(), captureAnchor: vi.fn(), captureNeed: vi.fn(), chooseBeneficiary: vi.fn(),
    commit: vi.fn(), edit: vi.fn(), cancelEdit: vi.fn(), remove: vi.fn(), requestReset: vi.fn(),
    confirmReset: vi.fn(), cancelReset: vi.fn(),
  } satisfies InstitutionMappingController;
}

const activity = vi.fn<(a: Activity) => void>();
const last = (): Activity => activity.mock.calls.at(-1)?.[0] as Activity;

function renderLayer(opts: { selection?: InstitutionMappingState['selection']; canWrite?: boolean } = {}) {
  return render(
    <BeneficiaryRegionLayer
      lang="en" planRevisionId="rev-1" canWrite={opts.canWrite ?? true} careInstitutions={ORGS} sessions={[session()]}
      institutions={controller(opts.selection ?? null)} onChanged={() => {}} onActivityChange={activity}
    />,
  );
}
const ready = async () => waitFor(() => expect(screen.getByTestId('cn4-region-layer')).toHaveAttribute('data-phase', 'ready'));
const beginNonBeneficiary = () => fireEvent.click(screen.getByTestId('cn4-region-mark-non-beneficiary'));
const typeReason = (text: string) => fireEvent.change(screen.getByTestId('cn4-region-reason'), { target: { value: text } });
const confirmSend = () => fireEvent.click(screen.getByTestId('cn4-region-confirm-send'));

beforeEach(() => {
  activity.mockReset();
  listBeneficiaryRegions.mockResolvedValue([version()]);
  listScopeColumnMappings.mockResolvedValue([]);
  setBeneficiaryRegions.mockResolvedValue({ operationBatchId: 'b', activeVersions: [], changes: [], convertedColumns: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('HC1.1 — regionLayerHasLocalWork: the pure contract', () => {
  it('H1_1_17/18 — each unsaved local decision is work, and nothing else is', () => {
    expect(regionLayerHasLocalWork({ convertingCount: 0, hasPending: false, reason: '' })).toBe(false);
    expect(regionLayerHasLocalWork({ convertingCount: 1, hasPending: false, reason: '' })).toBe(true);
    expect(regionLayerHasLocalWork({ convertingCount: 3, hasPending: false, reason: '' })).toBe(true);
    expect(regionLayerHasLocalWork({ convertingCount: 0, hasPending: true, reason: '' })).toBe(true);
    expect(regionLayerHasLocalWork({ convertingCount: 0, hasPending: false, reason: 'because' })).toBe(true);
    // Blank text is not work.
    expect(regionLayerHasLocalWork({ convertingCount: 0, hasPending: false, reason: '   ' })).toBe(false);
  });
});

describe('HC1.1 — what the layer reports while the person works', () => {
  it('H1_1_20 — server-saved ACTIVE regions and M213 columns by themselves are not work: every report is idle', async () => {
    listScopeColumnMappings.mockResolvedValue([m213()]);
    renderLayer({ selection: RANGE_SELECTION });
    await ready();
    expect(screen.getAllByTestId('cn4-region-version')).toHaveLength(1);
    expect(screen.getAllByTestId('cn4-region-m213-column')).toHaveLength(1);
    expect(activity).toHaveBeenCalled();
    for (const [report] of activity.mock.calls) expect(report).toEqual(IDLE);
  });

  it('H1_1_17 — marking a column for conversion is work; unmarking it is not', async () => {
    listScopeColumnMappings.mockResolvedValue([m213()]);
    renderLayer();
    await ready();
    expect(last()).toEqual(IDLE);
    fireEvent.click(screen.getByTestId('cn4-region-convert'));
    expect(screen.getByTestId('cn4-region-m213-column')).toHaveAttribute('data-converting', 'true');
    expect(last()).toEqual({ busy: false, dirty: true, failed: false });
    fireEvent.click(screen.getByTestId('cn4-region-convert'));
    expect(last()).toEqual(IDLE);
  });

  it('H1_1_18 — a pending confirmation is work, and so is the reason typed for it; cancelling leaves nothing behind', async () => {
    renderLayer({ selection: RANGE_SELECTION });
    await ready();
    expect(last()).toEqual(IDLE);

    beginNonBeneficiary();
    expect(screen.getByTestId('cn4-region-confirm')).toBeInTheDocument();
    expect(last()).toEqual({ busy: false, dirty: true, failed: false }); // pending, no text yet
    typeReason('not a beneficiary column');
    expect(last()).toEqual({ busy: false, dirty: true, failed: false });

    fireEvent.click(screen.getByRole('button', { name: T.cn2b_simple_cancel.en }));
    expect(screen.queryByTestId('cn4-region-confirm')).toBeNull();
    // The typed reason went with its confirmation: no invisible text keeps the layer "dirty".
    expect(last()).toEqual(IDLE);
    // And a NEW pending starts with an empty reason — the cancelled text was not kept.
    beginNonBeneficiary();
    expect(screen.getByTestId('cn4-region-reason')).toHaveValue('');
  });

  it('H1_1_19 — a region write in flight is busy (and still dirty); settling clears both', async () => {
    let finish!: () => void;
    setBeneficiaryRegions.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ operationBatchId: 'b', activeVersions: [], changes: [], convertedColumns: [] });
    }));
    renderLayer({ selection: RANGE_SELECTION });
    await ready();
    beginNonBeneficiary();
    typeReason('footer block');
    confirmSend();
    await waitFor(() => expect(setBeneficiaryRegions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(last()).toEqual({ busy: true, dirty: true, failed: false }));
    // The write itself is untouched: one call, the same fenced payload.
    expect(setBeneficiaryRegions).toHaveBeenCalledWith(expect.objectContaining({
      planRevisionId: 'rev-1', importSessionId: SESSION, sheetIndex: 0, reason: 'footer block', expectedVersionIds: ['v-1'],
    }));

    await act(async () => { finish(); });
    await waitFor(() => expect(last()).toEqual(IDLE));
    expect(setBeneficiaryRegions).toHaveBeenCalledTimes(1);
  });

  it('a refused write is reported as failed (and the decision stays pending, so still dirty) — busy is over', async () => {
    setBeneficiaryRegions.mockRejectedValue(new CentralNeedsError('beneficiary_region_overlap'));
    renderLayer({ selection: RANGE_SELECTION });
    await ready();
    beginNonBeneficiary();
    typeReason('footer block');
    confirmSend();
    await waitFor(() => expect(screen.getByTestId('cn4-region-message')).toHaveAttribute('data-tone', 'error'));
    expect(last()).toEqual({ busy: false, dirty: true, failed: true });
  });

  it('a stale refusal reloads and drops the decision: nothing is pending any more, so nothing is dirty', async () => {
    setBeneficiaryRegions.mockRejectedValue(new CentralNeedsError('beneficiary_region_stale'));
    renderLayer({ selection: RANGE_SELECTION });
    await ready();
    beginNonBeneficiary();
    typeReason('footer block');
    confirmSend();
    await waitFor(() => expect(screen.getByTestId('cn4-region-message')).toHaveAttribute('data-tone', 'error'));
    await waitFor(() => expect(screen.queryByTestId('cn4-region-confirm')).toBeNull());
    expect(last()).toEqual({ busy: false, dirty: false, failed: true });
  });
});

describe('HC1.1 — releasing the report when the layer leaves the tree', () => {
  it('H1_1_22 — unmounting a dirty layer releases its activity', async () => {
    const view = renderLayer({ selection: RANGE_SELECTION });
    await ready();
    beginNonBeneficiary();
    typeReason('footer block');
    expect(last()).toEqual({ busy: false, dirty: true, failed: false });
    view.unmount();
    expect(last()).toEqual(IDLE);
  });

  it('H1_1_22 — unmounting mid-write releases BUSY too: nothing keeps blocking anything after the layer is gone', async () => {
    setBeneficiaryRegions.mockImplementation(() => new Promise(() => {}));
    const view = renderLayer({ selection: RANGE_SELECTION });
    await ready();
    beginNonBeneficiary();
    typeReason('footer block');
    confirmSend();
    await waitFor(() => expect(last()).toEqual({ busy: true, dirty: true, failed: false }));
    view.unmount();
    expect(last()).toEqual(IDLE);
  });

  it('reports to the callback it was LAST given: a re-render with a new callback moves every later report (and the release) there', async () => {
    const first = vi.fn<(a: Activity) => void>();
    const second = vi.fn<(a: Activity) => void>();
    const institutions = controller(RANGE_SELECTION);
    const el = (cb: (a: Activity) => void) => (
      <BeneficiaryRegionLayer
        lang="en" planRevisionId="rev-1" canWrite careInstitutions={ORGS} sessions={[session()]}
        institutions={institutions} onChanged={() => {}} onActivityChange={cb}
      />
    );
    const view = render(el(first));
    await ready();
    view.rerender(el(second));
    beginNonBeneficiary();
    expect(second).toHaveBeenLastCalledWith({ busy: false, dirty: true, failed: false });
    expect(first.mock.calls.some(([a]) => a.dirty)).toBe(false); // the old callback hears nothing after the swap
    view.unmount();
    expect(second).toHaveBeenLastCalledWith(IDLE);
    expect(first.mock.calls.some(([a]) => a.dirty)).toBe(false);
  });

  it('works with no callback at all (older harnesses): nothing throws', async () => {
    const view = render(
      <BeneficiaryRegionLayer
        lang="en" planRevisionId="rev-1" canWrite careInstitutions={ORGS} sessions={[session()]}
        institutions={controller(RANGE_SELECTION)} onChanged={() => {}}
      />,
    );
    await ready();
    beginNonBeneficiary();
    typeReason('x');
    expect(() => view.unmount()).not.toThrow();
  });
});
