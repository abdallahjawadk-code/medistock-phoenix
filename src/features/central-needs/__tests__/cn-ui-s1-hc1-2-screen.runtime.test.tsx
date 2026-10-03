/** @vitest-environment jsdom */
/**
 * CN-UI-S1 HC1.2 — LINEAGE REMEDY CLOSURE through the REAL `CentralNeedsScreen`
 * (Simple, its default). Only the service boundary, the organization / warehouse
 * reads and `useApp` are mocked; the Supabase client throws on any direct call.
 *
 *   H1_2_13  the Simple remedy for a `binding_invalid` cell with a proven
 *            numeric current head is REAL: the canonical need-line panel deletes
 *            the refused line, designates the exact cell again, pins the CURRENT
 *            head, and saves through `setNeedLine` — no override created, no
 *            Advanced switch;
 *   H1_2_01/04/05/08/10/11/12 the same conditions through the screen (the
 *            override chain comes from the screen's own `listOverrides` state);
 *   H1_2_14/15/17/18 invalid immutable evidence: a READINESS diagnostic, the
 *            click lands on that stage, and the switch is presentation-only;
 *   §18      permissions are not broadened.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type {
  BeneficiaryColumnSummary, FieldOverride, ImportBatch, ImportSession, NeedLine, NeedLineSourceLink,
  PlanRevision, RecordDisposition, ReviewReadiness, SourceRecord,
} from '../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

const ORG = 'org-1';
const REV = 'rev-1';
const BENE = '00000000-0000-0000-0000-0000000000b1';
const ITEM = '00000000-0000-0000-0000-0000000000a1';
const ROW_5 = 'sheet:0:row:5';
const ROW_9 = 'sheet:0:row:9';

const appState = {
  lang: 'en' as 'ar' | 'en', dir: 'ltr' as 'rtl' | 'ltr', activeOrgId: ORG as string | null,
  profile: { organization_id: ORG } as { organization_id: string | null } | null,
  myPermissions: new Set<string>(),
};

const svc = {
  listPlanRevisions: vi.fn(),
  listImportSessions: vi.fn(),
  listImportBatches: vi.fn(),
  listOverrides: vi.fn(),
  fetchReviewReadiness: vi.fn(),
  listNeedLineLineage: vi.fn(),
  listBeneficiaryColumns: vi.fn(),
  listBeneficiaryRegions: vi.fn(),
  listSourceRecords: vi.fn(),
  listDispositions: vi.fn(),
  searchCentralItems: vi.fn(),
  setNeedLine: vi.fn(),
  deleteNeedLine: vi.fn(),
  setRecordDisposition: vi.fn(),
  setBeneficiaryColumns: vi.fn(),
  recordFieldOverride: vi.fn(),
  submitRevision: vi.fn(),
  approveRevision: vi.fn(),
  rejectRevision: vi.fn(),
  openPlanRevision: vi.fn(),
  openCorrectionRevision: vi.fn(),
};

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
/** Every direct backend touch the screen's tree attempts (it must travel through the mocked service instead). */
const directBackend: string[] = [];
vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    rpc: (name: string) => { directBackend.push(`rpc:${name}`); throw new Error('no direct RPC may run'); },
    from: (name: string) => { directBackend.push(`from:${name}`); throw new Error('no direct table read may run'); },
  },
}));
vi.mock('@/shared/supabase/services/organizations.service', () => ({ getOrganizations: async () => ORGS }));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({ getWarehouses: async () => [] }));
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  const forwarded = Object.fromEntries(Object.entries(svc).map(([name, fn]) => [name, (...a: unknown[]) => fn(...a)]));
  return {
    ...actual,
    ...forwarded,
    searchBatchEntries: vi.fn(async () => []),
    searchSourceFiles: vi.fn(async () => []),
  };
});

const { CentralNeedsScreen } = await import('../CentralNeedsScreen');
const { CentralNeedsError } = await import('../central-needs.service');

const ORGS = [
  { id: BENE, name: 'Beneficiary Hospital', name_ar: 'مستشفى المنتفع', code: 'b1', status: 'active', organizationKind: 'care_institution' },
] as unknown as OrgRow[];

const session = (id: string, startedAt: string): ImportSession => ({
  id, planRevisionId: REV, sourceFileId: `f-${id}`, status: 'completed', previewDigest: 'd', authoritativeDigest: 'd',
  parserIdentity: null, startedAt, completedAt: startedAt, notes: null,
});
const SESSIONS = [session('s1', '2026-01-01T00:00:00.000Z'), session('s2', '2026-01-02T00:00:00.000Z')];
const envelope = (value: unknown) => ({ value, valueType: typeof value === 'number' ? 'number' : 'string', isFormula: false, formula: null });
const recordsFor = (qty: unknown): Record<string, SourceRecord[]> => ({
  s1: [{
    id: 'rec-5', importSessionId: 's1', recordOrdinal: 1, targetEntity: ROW_5, fieldName: 'qty',
    sourceValues: envelope(qty), sourceProvenance: { sheetIndex: 0, coordinate: { row: 5, col: 2, a1: 'C6' } },
  }],
  s2: [{
    id: 'rec-9', importSessionId: 's2', recordOrdinal: 1, targetEntity: ROW_9, fieldName: 'Item',
    sourceValues: envelope('Amoxicillin'), sourceProvenance: { sheetIndex: 0, coordinate: { row: 9, col: 1, a1: 'B10' } },
  }],
});
const MAPPED_ROW_5: RecordDisposition = {
  id: 'd-5', importSessionId: 's1', targetEntity: ROW_5, decision: 'mapped', centralItemId: ITEM,
  decisionReason: null, decidedAt: '2026-01-01T00:00:00.000Z',
};
const M213_COLUMN: BeneficiaryColumnSummary = {
  importSessionId: 's1', originalFilename: 'need-2026.xlsx', archiveEntryPath: null, sheetIndex: 0, sheetName: null,
  columnIndex: 2, sourceFieldName: null, numericValueCount: 1, zeroValueCount: 0, nonzeroNumericCount: 1,
  mappingId: 'bc-2', decision: 'beneficiary', beneficiaryOrganizationId: BENE, mappingReason: 'confirmed',
  mappedAt: '2026-01-01T00:00:00.000Z', mappedRowNumericCount: 1, reviewRequired: false,
};

// ---- the mocked server's own state ------------------------------------------
let blockersOverride: ReviewReadiness['blockers'] | null = null;
let readyNow = false;
let records = recordsFor(12);
let lineage: { needLines: NeedLine[]; sources: NeedLineSourceLink[] } = { needLines: [], sources: [] };
let overrides: FieldOverride[] = [];
const revision = (): PlanRevision => ({ id: REV, planId: 'plan-1', organizationId: ORG, planYear: 2026, revisionNumber: 1, status: 'draft' });
const readinessNow = (): ReviewReadiness => ({
  planRevisionId: REV, status: 'draft', ready: readyNow,
  blockers: blockersOverride ?? [{ blocker: 'mapped_target_entity_without_need_line', detail: `session=s1 target_entity=${ROW_5}` }],
});

beforeEach(() => {
  vi.clearAllMocks();
  appState.lang = 'en';
  appState.dir = 'ltr';
  appState.myPermissions = new Set(['central_needs.view', 'central_needs.import', 'central_needs.edit', 'central_needs.approve']);
  blockersOverride = null;
  readyNow = false;
  records = recordsFor(12);
  lineage = { needLines: [], sources: [] };
  overrides = [];
  directBackend.length = 0;
  svc.listPlanRevisions.mockImplementation(async () => [revision()]);
  svc.listImportSessions.mockResolvedValue(SESSIONS);
  svc.listImportBatches.mockResolvedValue([] as ImportBatch[]);
  svc.listOverrides.mockImplementation(async () => overrides);
  svc.fetchReviewReadiness.mockImplementation(async () => readinessNow());
  svc.listNeedLineLineage.mockImplementation(async () => ({ needLines: [...lineage.needLines], sources: [...lineage.sources] }));
  svc.listBeneficiaryColumns.mockResolvedValue([M213_COLUMN]);
  svc.listBeneficiaryRegions.mockResolvedValue([]);
  svc.listSourceRecords.mockImplementation(async (id: string) => records[id] ?? []);
  svc.listDispositions.mockImplementation(async (id: string) => (id === 's1' ? [{ ...MAPPED_ROW_5 }] : []));
  svc.searchCentralItems.mockResolvedValue([]);
  svc.deleteNeedLine.mockReset();
  svc.setNeedLine.mockResolvedValue({ needLineId: 'nl-new', created: true, sourceLinkCount: 1, addedLinkCount: 1, approvedQuantity: '12' });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ---- helpers -------------------------------------------------------------------
const stepOf = () => screen.getByTestId('cn2b-simple-workspace').getAttribute('data-step');
const picker = () => within(screen.getByTestId('cn2b-simple-context')).getByRole('combobox') as HTMLSelectElement;
const needLines = () => screen.getByTestId('cn2b-simple-need-lines');
const candidateFor = (fieldName: string) =>
  within(needLines()).getByText(new RegExp(`· ${fieldName}$`)).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
const escapeBlock = () => screen.queryByTestId('cn2b-simple-expert-escape');
const expertButton = () => screen.getByTestId('cn2b-simple-expert-open');
const stages = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('section.cn2b-stage')];
const visibleStages = (container: HTMLElement) => stages(container).filter((s) => !s.hasAttribute('hidden')).map((s) => s.getAttribute('data-stage'));
const stageOf = (container: HTMLElement, id: string) => container.querySelector(`section.cn2b-stage[data-stage="${id}"]`) as HTMLElement;
const modeOf = (container: HTMLElement) => container.querySelector('div.cn2b')?.getAttribute('data-mode');
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

const READ_FNS = [
  'listPlanRevisions', 'listImportSessions', 'listImportBatches', 'listOverrides', 'fetchReviewReadiness', 'listNeedLineLineage',
  'listBeneficiaryColumns', 'listBeneficiaryRegions', 'listSourceRecords', 'listDispositions',
] as const;
/** How many times every service READ has run — a presentation-only switch must not move any of them. */
const readCounts = () => READ_FNS.map((name) => svc[name].mock.calls.length);
const WRITE_FNS = [
  'setNeedLine', 'deleteNeedLine', 'setRecordDisposition', 'setBeneficiaryColumns', 'recordFieldOverride',
  'submitRevision', 'approveRevision', 'rejectRevision', 'openPlanRevision', 'openCorrectionRevision',
] as const;
const NO_BUSINESS_WRITE = () => { for (const w of WRITE_FNS) expect(svc[w], w).not.toHaveBeenCalled(); };

async function openSimpleAt(step: string) {
  const view = render(<CentralNeedsScreen />);
  await waitFor(() => expect(stepOf()).toBe(step));
  return view;
}

const override = (id: string, finalValue: unknown, createdAt: string, sourceRecordId = 'rec-5'): FieldOverride => ({
  id, sourceRecordId, targetEntity: ROW_5, fieldName: 'qty', previousValue: '12 boxes', finalValue,
  finalValueText: typeof finalValue === 'number' ? String(finalValue) : JSON.stringify(finalValue),
  overrideReason: `reason for ${id}`, overrideNote: null, createdAt,
});
const BINDING = 'source_quantity_override_binding_invalid';
const detail = (record: string | null, reason: string | null) =>
  ['session=s1', record === null ? null : `source_record=${record}`, 'need_line=nl-1', reason === null ? null : `reason=${reason}`].filter(Boolean).join(' ');
const lineageBlocker = (reason: string | null, record: string | null = 'rec-5') => ({ blocker: 'need_line_quantity_lineage_unsafe', detail: detail(record, reason) });

const HEAD = override('ov-head', 12, '2026-09-26T10:00:00+00:00');
const OLD = override('ov-old', 9, '2026-09-20T10:00:00+00:00');
const LINE: NeedLine = {
  id: 'nl-1', planRevisionId: REV, organizationId: ORG, beneficiaryOrganizationId: BENE, targetWarehouseId: null, centralItemId: ITEM,
  approvedQuantity: '10', approvedUnit: 'box', unitConversionState: 'canonical', sourceUnitText: null, mappingReason: 'reviewed', updatedAt: '2026-09-27T10:00:00+00:00',
};
const link = (appliedOverrideId: string, designatedQuantity: string): NeedLineSourceLink => ({
  needLineId: 'nl-1', sourceRecordId: 'rec-5', designatedQuantity, appliedOverrideId, importSessionId: 's1', targetEntity: ROW_5, fieldName: 'qty',
});

// ==============================================================================
describe('HC1.2 · the Simple remedy for a binding_invalid cell with a PROVEN numeric current head is REAL (H1_2_13, H1_2_01)', () => {
  it('H1_2_13 — delete the refused line with a reason → designate the exact cell again → pin the CURRENT head → save through setNeedLine; no override created, no Advanced switch', async () => {
    records = recordsFor('12 boxes'); // a cell that is not a plain number: only a pinned numeric override can count
    overrides = [HEAD, OLD]; // server order: newest first, so ov-head is the cell's current head (ov-old is what the refused line was pinned to)
    lineage = { needLines: [LINE], sources: [link('ov-old', '9')] };
    blockersOverride = [lineageBlocker(BINDING)];
    svc.deleteNeedLine.mockImplementation(async () => {
      lineage = { needLines: [], sources: [] }; // the server's state after the delete: no line, no claim on the cell
      blockersOverride = null;
      return { needLineId: 'nl-1' };
    });
    const { container } = await openSimpleAt('need-lines');

    // 1) HC1.2: the cell's current head is a numeric override, so this is Simple's — the sentence says what to do, and there is NO escape.
    expect(screen.getByTestId('cn2b-simple-readiness-messages')).toHaveTextContent(T.cn2b_simple_blocker_lineage_source_quantity_override_binding_invalid.en);
    expect(escapeBlock()).toBeNull();
    // 2) The refused line is IN the canonical panel, with its own delete control — the canonical write, with a reason.
    await waitFor(() => expect(within(needLines()).getAllByTestId('cn2b-nl-line')).toHaveLength(1));
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_delete.en }));
    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_delete_reason.en), { target: { value: 'rebuild on the current correction' } });
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_delete_confirm.en }));
    await waitFor(() => expect(svc.deleteNeedLine).toHaveBeenCalledTimes(1));
    expect(svc.deleteNeedLine).toHaveBeenCalledWith({ needLineId: 'nl-1', reason: 'rebuild on the current correction', expectedSourceRecordIds: ['rec-5'] });
    // 3) The exact cell is free again: designate it, and select the CURRENT numeric head (never the stale one it was pinned to).
    await waitFor(() => expect(within(needLines()).queryAllByTestId('cn2b-nl-line')).toHaveLength(0));
    await waitFor(() => expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital'));
    fireEvent.click(within(candidateFor('qty')).getAllByRole('checkbox')[0]);
    const evidence = within(candidateFor('qty')).getByTestId('cn2b-nl-override-evidence');
    expect(evidence).toHaveAttribute('data-override-id', 'ov-head');
    expect(evidence).toHaveAttribute('data-numeric', 'true');
    fireEvent.click(within(candidateFor('qty')).getByRole('checkbox', { name: T.cn2b_nl_use_override.en }));
    const contribution = within(candidateFor('qty')).getByLabelText(`${T.cn2b_nl_contribution.en} — qty`) as HTMLInputElement;
    expect(contribution.value).toBe('12');
    const shown = contribution.value;
    // 4) Save through the existing canonical path: pinned to the EXACT current head, the contribution being what the panel showed.
    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'rebuilt on the current correction' } });
    fireEvent.change(within(needLines()).getByTestId('cn2b-nl-unit-select'), { target: { value: 'box' } });
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_save.en }));
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(svc.setNeedLine).toHaveBeenCalledTimes(1));
    const sent = svc.setNeedLine.mock.calls[0][0] as { quantitySources: Array<{ sourceRecordId: string; designatedQuantity: string; appliedOverrideId: string | null }>; approvedQuantity: string };
    expect(sent.quantitySources).toEqual([{ sourceRecordId: 'rec-5', designatedQuantity: shown, appliedOverrideId: 'ov-head' }]);
    expect(sent.quantitySources[0].appliedOverrideId).not.toBe('ov-old');
    expect(sent.approvedQuantity).toBe(shown);
    expect(svc.setNeedLine).toHaveBeenCalledWith(expect.objectContaining({ planRevisionId: REV, beneficiaryOrganizationId: BENE, centralItemId: ITEM }));
    // The whole remedy happened in Simple: never Advanced, never an override created, never a direct backend call, never an escape.
    await settle();
    expect(modeOf(container)).toBe('simple');
    expect(stages(container)).toHaveLength(0);
    expect(escapeBlock()).toBeNull();
    expect(svc.recordFieldOverride).not.toHaveBeenCalled();
    expect(directBackend).toEqual([]);
    expect(svc.deleteNeedLine).toHaveBeenCalledTimes(1);
    expect(svc.setNeedLine).toHaveBeenCalledTimes(1);
  });

  it('H1_2_01 — through the screen: the complete chain\'s current head for the exact record is numeric → no escape (including an older non-numeric override behind it, H1_2_12)', async () => {
    records = recordsFor('12 boxes');
    overrides = [override('ov-new', 12, '2026-09-30T00:00:00+00:00'), override('ov-text', 'old text', '2026-09-01T00:00:00+00:00'), override('ov-null', null, '2026-08-01T00:00:00+00:00')];
    blockersOverride = [lineageBlocker(BINDING)];
    await openSimpleAt('need-lines');
    await settle();
    expect(screen.getByTestId('cn2b-simple-readiness-messages')).toHaveTextContent(T.cn2b_simple_blocker_lineage_source_quantity_override_binding_invalid.en);
    expect(escapeBlock()).toBeNull();
  });
});

// ==============================================================================
describe('HC1.2 · every other condition escapes — and the click lands on the right stage, presentation-only (H1_2_04/05/08/10/11, H1_2_17/18)', () => {
  type Case = {
    id: string; name: string; blockers: ReviewReadiness['blockers']; overrides?: FieldOverride[]; chainFails?: boolean;
    stage: 'review' | 'readiness'; reason: string; bodyKey: string;
  };
  const NUMERIC_BODY = 'cn2b_simple_expert_body_numeric_override';
  const UNPROVEN_BODY = 'cn2b_simple_expert_body_override_head_unproven';
  const EVIDENCE_BODY = 'cn2b_simple_expert_body_source_evidence_invalid';
  const CASES: Case[] = [
    { id: 'H1_2_04', name: 'binding_invalid, no current head for the record (another record\'s numeric head does not count)', blockers: [lineageBlocker(BINDING)], overrides: [override('ov-other', 12, '2026-09-26T10:00:00+00:00', 'rec-OTHER')], stage: 'review', reason: 'numeric_override', bodyKey: NUMERIC_BODY },
    { id: 'H1_2_05', name: 'binding_invalid, current head is a TEXT override', blockers: [lineageBlocker(BINDING)], overrides: [override('ov-text', 'twelve', '2026-09-26T10:00:00+00:00')], stage: 'review', reason: 'numeric_override', bodyKey: NUMERIC_BODY },
    { id: 'H1_2_11', name: 'binding_invalid, an older NUMERIC override behind a NEWER text head', blockers: [lineageBlocker(BINDING)], overrides: [override('ov-newest-text', 'text', '2026-09-30T00:00:00+00:00'), override('ov-older-number', 12, '2026-09-01T00:00:00+00:00')], stage: 'review', reason: 'numeric_override', bodyKey: NUMERIC_BODY },
    { id: 'H1_2_08', name: 'binding_invalid, the server\'s detail does not name the record', blockers: [lineageBlocker(BINDING, null)], overrides: [HEAD], stage: 'readiness', reason: 'override_head_unproven', bodyKey: UNPROVEN_BODY },
    { id: 'H1_2_10', name: 'binding_invalid, the override chain could not be read', blockers: [lineageBlocker(BINDING)], overrides: [HEAD], chainFails: true, stage: 'readiness', reason: 'override_head_unproven', bodyKey: UNPROVEN_BODY },
    { id: 'H1_2_14', name: 'standalone source_cell_value_contract_invalid', blockers: [{ blocker: 'source_cell_value_contract_invalid', detail: 'session=s1 source_record=rec-5 reason=invalid_evidence' }], stage: 'readiness', reason: 'source_evidence_invalid', bodyKey: EVIDENCE_BODY },
    { id: 'H1_2_15', name: 'lineage reason source_cell_value_contract_invalid', blockers: [lineageBlocker('source_cell_value_contract_invalid')], stage: 'readiness', reason: 'source_evidence_invalid', bodyKey: EVIDENCE_BODY },
  ];

  for (const c of CASES) {
    it(`${c.id}/17/18 — ${c.name}: the escape names the ${c.stage.toUpperCase()} stage; the click lands on exactly that stage with nothing else painted first, and changes the presentation ONLY`, async () => {
      records = recordsFor('12 boxes');
      overrides = c.overrides ?? [];
      blockersOverride = c.blockers;
      if (c.chainFails) svc.listOverrides.mockRejectedValue(new CentralNeedsError('central_needs_request_failed'));
      const { container } = await openSimpleAt('need-lines');
      const block = escapeBlock() as HTMLElement;
      expect(block).toBeInTheDocument();
      expect(block).toHaveAttribute('data-reason', c.reason);
      expect(block).toHaveAttribute('data-stage', c.stage);
      expect(block).toHaveTextContent(T[c.bodyKey].en.replace('__STAGE__', T[`cn2b_stage_${c.stage}`].en));
      expect(block.textContent).not.toContain('__STAGE__');
      expect(screen.getAllByTestId('cn2b-simple-expert-open')).toHaveLength(1);
      await settle();
      const reads = readCounts();
      const planReads = svc.listPlanRevisions.mock.calls.length;
      const sessionBefore = picker().value;

      // Watch every stage section from here on: a transient stage would flip one of these attributes.
      const flips: string[] = [];
      const observer = new MutationObserver((rs) => {
        for (const r of rs) {
          if (r.type === 'attributes' && (r.target as Element).matches('section.cn2b-stage')) flips.push(`${(r.target as Element).getAttribute('data-stage')}:${r.attributeName}`);
        }
      });
      observer.observe(container, { subtree: true, attributes: true, attributeFilter: ['hidden', 'data-active'], childList: true });
      fireEvent.click(expertButton());
      await settle();
      observer.disconnect();

      // H1_2_17 — it lands directly on the stage, and the first Advanced paint already had it.
      expect(modeOf(container)).toBe('advanced');
      expect(visibleStages(container)).toEqual([c.stage]);
      expect(flips).toEqual([]);
      // H1_2_18 — presentation only: no read, no write, no revision change, no session change, no automatic retry.
      expect(readCounts()).toEqual(reads);
      expect(svc.listPlanRevisions.mock.calls.length).toBe(planReads);
      NO_BUSINESS_WRITE();
      expect(directBackend.filter((n) => /set_|delete_|record_|submit|approve|reject|open_|abandon|finalize|upload/.test(n))).toEqual([]);
      await settle();
      await settle();
      expect(readCounts()).toEqual(reads); // still nothing, a moment later: no retry
      fireEvent.click(screen.getByTestId('cn2b-mode-toggle')); // the way back keeps the same session and still reads nothing
      await waitFor(() => expect(stepOf()).toBe('need-lines'));
      expect(picker().value).toBe(sessionBefore);
      expect(readCounts()).toEqual(reads);
    });
  }

  it('H1_2_23 — the server says READY: no escape through the real screen either, whatever stale blocker rows came with it', async () => {
    readyNow = true;
    blockersOverride = [
      lineageBlocker('source_cell_value_contract_invalid'), lineageBlocker(BINDING), lineageBlocker(BINDING, null),
      { blocker: 'import_session_still_open', detail: 'session=s9 status=pending' }, { blocker: 'a_blocker_from_the_future', detail: null },
    ];
    await openSimpleAt('pending');
    expect(escapeBlock()).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-expert-open')).toBeNull();
  });

  it('H1_2_17 — the READINESS stage shows exactly what the server returned for the invalid evidence (the blocker rows are there to read)', async () => {
    blockersOverride = [lineageBlocker('source_cell_value_contract_invalid'), { blocker: 'source_cell_value_contract_invalid', detail: 'session=s1 source_record=rec-5 reason=invalid_evidence' }];
    const { container } = await openSimpleAt('need-lines');
    fireEvent.click(expertButton());
    await settle();
    expect(visibleStages(container)).toEqual(['readiness']);
    expect(within(stageOf(container, 'readiness')).getAllByText(/source_cell_value_contract_invalid|need_line_quantity_lineage_unsafe/).length).toBeGreaterThan(0);
  });

  it('H1_2_10 — the diagnostic says the current head could not be proven, in Arabic too', async () => {
    appState.lang = 'ar';
    appState.dir = 'rtl';
    overrides = [HEAD];
    blockersOverride = [lineageBlocker(BINDING)];
    svc.listOverrides.mockRejectedValue(new CentralNeedsError('central_needs_request_failed'));
    await openSimpleAt('need-lines');
    const block = escapeBlock() as HTMLElement;
    expect(block).toHaveTextContent(T.cn2b_simple_expert_title_unknown.ar);
    expect(block).toHaveTextContent(T.cn2b_simple_expert_body_override_head_unproven.ar.replace('__STAGE__', T.cn2b_stage_readiness.ar));
    expect(block.textContent).toMatch(/لم تستطع إثبات/);
  });
});

// ==============================================================================
describe('HC1.2 · permissions are not broadened (§18)', () => {
  const VIEW_ONLY = ['central_needs.view'];

  it('the DATA REVIEW remedy still needs the edit capability: without it the person is told who to ask — no button, no new permission', async () => {
    records = recordsFor('12 boxes');
    overrides = [override('ov-text', 'twelve', '2026-09-26T10:00:00+00:00')];
    blockersOverride = [lineageBlocker(BINDING)];
    appState.myPermissions = new Set(VIEW_ONLY);
    await openSimpleAt('need-lines');
    const block = escapeBlock() as HTMLElement;
    expect(block).toHaveAttribute('data-stage', 'review');
    expect(screen.queryByTestId('cn2b-simple-expert-open')).toBeNull();
    expect(within(block).getByTestId('cn2b-simple-expert-no-permission')).toHaveTextContent(T.cn2b_simple_expert_no_permission.en);
  });

  it('a view-only person with BOTH a numeric need and invalid evidence is offered the one escape they can act on (the diagnostic); the numeric need is still named in the summary — the owner-frozen selection rule', async () => {
    records = recordsFor('12 boxes');
    overrides = [override('ov-text', 'twelve', '2026-09-26T10:00:00+00:00')];
    blockersOverride = [lineageBlocker('source_cell_value_contract_invalid'), lineageBlocker(BINDING)];
    appState.myPermissions = new Set(VIEW_ONLY);
    await openSimpleAt('need-lines');
    expect(escapeBlock()).toHaveAttribute('data-stage', 'readiness');
    expect(escapeBlock()).toHaveAttribute('data-reason', 'source_evidence_invalid');
    expect(screen.getByTestId('cn2b-simple-expert-open')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-readiness-messages')).toHaveTextContent(T.cn2b_simple_blocker_lineage_source_quantity_override_binding_invalid.en);
  });

  it('the READINESS diagnostic stays readable under the existing view access alone, and opens', async () => {
    blockersOverride = [lineageBlocker('source_cell_value_contract_invalid')];
    appState.myPermissions = new Set(VIEW_ONLY);
    const { container } = await openSimpleAt('need-lines');
    expect(escapeBlock()).toHaveAttribute('data-stage', 'readiness');
    fireEvent.click(expertButton());
    await settle();
    expect(visibleStages(container)).toEqual(['readiness']);
    NO_BUSINESS_WRITE();
  });

  it('with the edit capability the same DATA REVIEW case offers the button and it opens the review stage, where the canonical override editor is', async () => {
    records = recordsFor('12 boxes');
    overrides = [override('ov-other', 12, '2026-09-26T10:00:00+00:00', 'rec-OTHER')]; // rec-5 has no override at all (no current head)
    blockersOverride = [lineageBlocker(BINDING)];
    const { container } = await openSimpleAt('need-lines');
    fireEvent.click(expertButton());
    await settle();
    expect(visibleStages(container)).toEqual(['review']);
    expect(within(stageOf(container, 'review')).getAllByRole('button', { name: T.cn2b_override.en }).length).toBeGreaterThan(0); // the canonical override editor is there
  });

  it('the first escape the person can ACT on is offered: with edit (no import) rights a numeric correction beats a diagnostic', async () => {
    records = recordsFor('12 boxes');
    overrides = [override('ov-text', 'twelve', '2026-09-26T10:00:00+00:00')];
    blockersOverride = [lineageBlocker('source_cell_value_contract_invalid'), lineageBlocker(BINDING)];
    appState.myPermissions = new Set(['central_needs.view', 'central_needs.edit']);
    await openSimpleAt('need-lines');
    expect(escapeBlock()).toHaveAttribute('data-stage', 'review');
    expect(screen.getByTestId('cn2b-simple-expert-open')).toBeInTheDocument();
  });
});
