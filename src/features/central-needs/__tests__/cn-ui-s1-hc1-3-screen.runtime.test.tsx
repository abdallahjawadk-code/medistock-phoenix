/** @vitest-environment jsdom */
/**
 * CN-UI-S1 HC1.3 — FINAL LINEAGE UX CONSISTENCY through the REAL `CentralNeedsScreen`
 * (Simple, its default). Only the service boundary, the organization / warehouse
 * reads and `useApp` are mocked; the Supabase client throws on any direct call.
 *
 *   H1_3_10  the Simple remedy for a `source_quantity_requires_explicit_numeric_override`
 *            cell whose CURRENT head is already a recorded numeric correction is REAL:
 *            the canonical need-line panel deletes the refused line, designates the
 *            exact cell again, pins the CURRENT head, and saves through `setNeedLine` —
 *            no override created, no Advanced switch, no extra override read;
 *   H1_3_01/03/05/06/07/08/09  the same head conditions through the screen (the chain
 *            comes from the screen's own `listOverrides` state), each landing on the right
 *            stage presentation-only;
 *   H1_3_14/16  invalid immutable evidence: the diagnostic escape AND the Advanced
 *            readiness labels carry the truthful copy, in both languages;
 *   H1_3_18  Simple still offers no generic way into Advanced;
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

// The real screen mounts many times in some tests (H1_3_18 five times per language); give a loaded full-suite run the headroom the HC1.1 screen suite has.
vi.setConfig({ testTimeout: 30_000 });

// ---- HC1.3 fixtures --------------------------------------------------------------
const NUMERIC_REQUIRED = 'source_quantity_requires_explicit_numeric_override';
/** A LEGACY link: it designated the cell's quantity but pins NO override (the server's helper then answers `…requires_explicit_numeric_override`). */
const unpinnedLink = (designatedQuantity: string): NeedLineSourceLink => ({ ...link('unused', designatedQuantity), appliedOverrideId: null });
const numericRequiredBlocker = (record: string | null = 'rec-5') => lineageBlocker(NUMERIC_REQUIRED, record);

// ==============================================================================
describe('HC1.3 · the Simple remedy for a numeric-required cell with a PROVEN numeric current head is REAL (H1_3_10, H1_3_01)', () => {
  it('H1_3_10 — delete the refused line with a reason → designate the exact cell again → pin the CURRENT head → save through setNeedLine; no override created, no mode switch, and no override read beyond the panel\'s own single post-write refresh', async () => {
    records = recordsFor('12 boxes'); // a cell that is not a plain number: only a pinned numeric override can count
    overrides = [HEAD, OLD]; // server order: newest first, so ov-head is the cell's current head (a numeric correction ALREADY recorded)
    lineage = { needLines: [LINE], sources: [unpinnedLink('12')] };
    blockersOverride = [numericRequiredBlocker()];
    svc.deleteNeedLine.mockImplementation(async () => {
      lineage = { needLines: [], sources: [] }; // the server's state after the delete: no line, no claim on the cell
      blockersOverride = null;
      return { needLineId: 'nl-1' };
    });
    const { container } = await openSimpleAt('need-lines');
    await settle();

    // 1) HC1.3: the cell's current head is a recorded numeric correction, so this is Simple's — the sentence names both steps, and there is NO escape.
    const messages = screen.getByTestId('cn2b-simple-readiness-messages');
    expect(messages).toHaveTextContent(T.cn2b_simple_blocker_lineage_source_quantity_requires_explicit_numeric_override.en);
    expect(messages).toHaveTextContent('delete the need line, designate the cell again and pin the current correction');
    expect(escapeBlock()).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-expert-open')).toBeNull();
    // The derivation read nothing: the override chain was fetched ONCE, by the screen's own load, and rendering the escape decision did not add a read.
    const overrideReadsAfterLoad = svc.listOverrides.mock.calls.length;
    expect(overrideReadsAfterLoad).toBeGreaterThan(0);
    await settle();
    await settle();
    expect(svc.listOverrides.mock.calls.length).toBe(overrideReadsAfterLoad);

    // 2) The refused line is IN the canonical panel, with its own delete control — the canonical write, with a reason.
    await waitFor(() => expect(within(needLines()).getAllByTestId('cn2b-nl-line')).toHaveLength(1));
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_delete.en }));
    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_delete_reason.en), { target: { value: 'rebuild on the current correction' } });
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_delete_confirm.en }));
    await waitFor(() => expect(svc.deleteNeedLine).toHaveBeenCalledTimes(1));
    expect(svc.deleteNeedLine).toHaveBeenCalledWith({ needLineId: 'nl-1', reason: 'rebuild on the current correction', expectedSourceRecordIds: ['rec-5'] });
    await settle();
    const overrideReadsAfterDelete = svc.listOverrides.mock.calls.length;
    // 3) The exact cell is free again: designate it, and select the CURRENT numeric head (never the older one).
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
    expect(sent.quantitySources[0].appliedOverrideId).not.toBeNull(); // the link is no longer the unpinned one the server refused
    expect(sent.approvedQuantity).toBe(shown); // the contribution matches the panel's chosen quantity
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
    // …and no read came from the derivation: the only chain reads after the screen's own load are the panel's existing post-write refresh —
    // EXACTLY one per canonical write (the delete, then the save) — and once those settle nothing reads again, however often the escape is re-derived.
    expect(overrideReadsAfterDelete - overrideReadsAfterLoad).toBe(1);
    expect(svc.listOverrides.mock.calls.length - overrideReadsAfterDelete).toBe(1);
    const overrideReadsSettled = svc.listOverrides.mock.calls.length;
    await settle();
    await settle();
    expect(svc.listOverrides.mock.calls.length).toBe(overrideReadsSettled);
  });

  it('H1_3_01 — through the screen: the complete chain\'s current head for the exact record is numeric → no escape (including an older non-numeric override behind it)', async () => {
    records = recordsFor('12 boxes');
    overrides = [override('ov-new', 12, '2026-09-30T00:00:00+00:00'), override('ov-text', 'old text', '2026-09-01T00:00:00+00:00'), override('ov-null', null, '2026-08-01T00:00:00+00:00')];
    blockersOverride = [numericRequiredBlocker()];
    await openSimpleAt('need-lines');
    await settle();
    expect(screen.getByTestId('cn2b-simple-readiness-messages')).toHaveTextContent(T.cn2b_simple_blocker_lineage_source_quantity_requires_explicit_numeric_override.en);
    expect(escapeBlock()).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-expert-open')).toBeNull();
  });

  it('H1_3_01 — the server\'s verdict is NOT suppressed: the revision is still not ready, the blocker is still listed, and nothing claims it is ready', async () => {
    records = recordsFor('12 boxes');
    overrides = [HEAD];
    blockersOverride = [numericRequiredBlocker()];
    await openSimpleAt('need-lines');
    expect(screen.getByTestId('cn2b-simple-readiness-messages')).toBeInTheDocument();
    expect(screen.queryByTestId('cn2b-simple-ready')).toBeNull();
    expect(stepOf()).toBe('need-lines');
    expect(svc.fetchReviewReadiness).toHaveBeenCalled();
  });
});

// ==============================================================================
describe('HC1.3 · every other head condition escapes — and the click lands on the right stage, presentation-only (H1_3_03/05/06/07/08/09)', () => {
  type Case = { id: string; name: string; blockers: ReviewReadiness['blockers']; overrides?: FieldOverride[]; chainFails?: boolean; stage: 'review' | 'readiness'; reason: string; bodyKey: string };
  const NUMERIC_BODY = 'cn2b_simple_expert_body_numeric_override';
  const UNPROVEN_BODY = 'cn2b_simple_expert_body_override_head_unproven';
  const CASES: Case[] = [
    { id: 'H1_3_05', name: 'numeric-required, no override exists at all for the record', blockers: [numericRequiredBlocker()], overrides: [], stage: 'review', reason: 'numeric_override', bodyKey: NUMERIC_BODY },
    { id: 'H1_3_09', name: 'numeric-required, only ANOTHER record has a numeric head', blockers: [numericRequiredBlocker()], overrides: [override('ov-other', 12, '2026-09-26T10:00:00+00:00', 'rec-OTHER')], stage: 'review', reason: 'numeric_override', bodyKey: NUMERIC_BODY },
    { id: 'H1_3_06', name: 'numeric-required, current head is a TEXT override', blockers: [numericRequiredBlocker()], overrides: [override('ov-text', 'twelve', '2026-09-26T10:00:00+00:00')], stage: 'review', reason: 'numeric_override', bodyKey: NUMERIC_BODY },
    { id: 'H1_3_06', name: 'numeric-required, current head is a NEGATIVE number', blockers: [numericRequiredBlocker()], overrides: [override('ov-neg', -4, '2026-09-26T10:00:00+00:00')], stage: 'review', reason: 'numeric_override', bodyKey: NUMERIC_BODY },
    { id: 'H1_3_03', name: 'numeric-required, an older NUMERIC override behind a NEWER text head', blockers: [numericRequiredBlocker()], overrides: [override('ov-newest-text', 'text', '2026-09-30T00:00:00+00:00'), override('ov-older-number', 12, '2026-09-01T00:00:00+00:00')], stage: 'review', reason: 'numeric_override', bodyKey: NUMERIC_BODY },
    { id: 'H1_3_07', name: 'numeric-required, the server\'s detail does not name the record', blockers: [numericRequiredBlocker(null)], overrides: [HEAD], stage: 'readiness', reason: 'override_head_unproven', bodyKey: UNPROVEN_BODY },
    { id: 'H1_3_08', name: 'numeric-required, the override chain could not be read', blockers: [numericRequiredBlocker()], overrides: [HEAD], chainFails: true, stage: 'readiness', reason: 'override_head_unproven', bodyKey: UNPROVEN_BODY },
  ];

  for (const c of CASES) {
    it(`${c.id} — ${c.name}: the escape names the ${c.stage.toUpperCase()} stage; the click lands on exactly that stage, and changes the presentation ONLY`, async () => {
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
      const sessionBefore = picker().value;

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

      expect(modeOf(container)).toBe('advanced');
      expect(visibleStages(container)).toEqual([c.stage]);
      expect(flips).toEqual([]);
      expect(readCounts()).toEqual(reads); // presentation only: no read, no retry
      NO_BUSINESS_WRITE();
      expect(directBackend.filter((n) => /set_|delete_|record_|submit|approve|reject|open_|abandon|finalize|upload/.test(n))).toEqual([]);
      await settle();
      expect(readCounts()).toEqual(reads);
      fireEvent.click(screen.getByTestId('cn2b-mode-toggle'));
      await waitFor(() => expect(stepOf()).toBe('need-lines'));
      expect(picker().value).toBe(sessionBefore);
      expect(readCounts()).toEqual(reads);
    });
  }

  it('H1_3_05 — the DATA REVIEW stage the escape opens has the canonical override editor, where the missing numeric correction is recorded', async () => {
    records = recordsFor('12 boxes');
    overrides = [];
    blockersOverride = [numericRequiredBlocker()];
    const { container } = await openSimpleAt('need-lines');
    fireEvent.click(expertButton());
    await settle();
    expect(visibleStages(container)).toEqual(['review']);
    expect(within(stageOf(container, 'review')).getAllByRole('button', { name: T.cn2b_override.en }).length).toBeGreaterThan(0);
  });

  it('H1_3_08 — the unproven diagnostic is truthful in Arabic too (RTL), and says it did not guess', async () => {
    appState.lang = 'ar';
    appState.dir = 'rtl';
    overrides = [HEAD];
    blockersOverride = [numericRequiredBlocker()];
    svc.listOverrides.mockRejectedValue(new CentralNeedsError('central_needs_request_failed'));
    await openSimpleAt('need-lines');
    const block = escapeBlock() as HTMLElement;
    expect(block).toHaveTextContent(T.cn2b_simple_expert_title_unknown.ar);
    expect(block).toHaveTextContent(T.cn2b_simple_expert_body_override_head_unproven.ar.replace('__STAGE__', T.cn2b_stage_readiness.ar));
    expect(block.textContent).toMatch(/لم تستطع إثبات/);
    expect(block.textContent).toMatch(/غير مثبَّتة على أي تصحيح/); // it names the numeric-required state too, not only a stale pin
  });

  it('the unproven diagnostic names BOTH states it may be about (a stale pin, and no pin) — it was written for binding_invalid alone and is now true for both', async () => {
    overrides = [HEAD];
    blockersOverride = [numericRequiredBlocker(null)];
    await openSimpleAt('need-lines');
    const block = escapeBlock() as HTMLElement;
    expect(block.textContent).toMatch(/pinned to a correction that is not its cell’s current one, or to none/);
    expect(block.textContent).toMatch(/does not guess/);
    expect(block.textContent).not.toMatch(/could not be read/); // it may merely be loading: the reason is "not available"
  });
});

// ==============================================================================
describe('HC1.3 · invalid IMMUTABLE evidence: the diagnostic and the Advanced readiness labels say what is true (H1_3_14, H1_3_16)', () => {
  const STANDALONE = { blocker: 'source_cell_value_contract_invalid', detail: 'session=s1 source_record=rec-5 reason=invalid_evidence' };

  for (const lang of ['en', 'ar'] as const) {
    it(`${lang}: the Simple diagnostic says it cannot be repaired in this workflow, points at diagnosis and escalation, and promises no re-import / replacement / automatic repair`, async () => {
      appState.lang = lang;
      appState.dir = lang === 'ar' ? 'rtl' : 'ltr';
      blockersOverride = [STANDALONE, lineageBlocker('source_cell_value_contract_invalid')];
      await openSimpleAt('need-lines');
      const block = escapeBlock() as HTMLElement;
      expect(block).toHaveAttribute('data-reason', 'source_evidence_invalid');
      expect(block).toHaveTextContent(T.cn2b_simple_expert_body_source_evidence_invalid[lang].replace('__STAGE__', T.cn2b_stage_readiness[lang]));
      // Not the escape alone: the blocker sentences beside it (the server's own list, in plain words) make no phantom promise either.
      // (Scoped to those two blocks: the need-line panel below them has unrelated sentences of its own, e.g. "no link is inferred automatically".)
      const everything = `${screen.getByTestId('cn2b-simple-readiness-messages').textContent ?? ''} ${block.textContent ?? ''}`;
      if (lang === 'en') {
        expect(everything).toMatch(/cannot be repaired in this workflow/);
        expect(everything).not.toMatch(/re-?import|replacement|automatic|fixed in place|remove that cell/i);
      } else {
        expect(everything).toMatch(/لا يمكن إصلاح/);
        expect(everything).not.toMatch(/إعادة استيراد|استبدال|تلقائ|أزل تلك الخلية/);
      }
      expect(screen.getByTestId('cn2b-simple-readiness-messages')).toHaveTextContent(T.cn2b_simple_blocker_source_evidence_invalid[lang]);
      expect(screen.getByTestId('cn2b-simple-readiness-messages')).toHaveTextContent(T.cn2b_simple_blocker_lineage_source_cell_value_contract_invalid[lang]);
    });
  }

  it('the READINESS stage the diagnostic opens labels both rows with the truthful copy (and still shows what the server returned)', async () => {
    blockersOverride = [STANDALONE, lineageBlocker('source_cell_value_contract_invalid')];
    const { container } = await openSimpleAt('need-lines');
    fireEvent.click(expertButton());
    await settle();
    const readiness = stageOf(container, 'readiness');
    expect(visibleStages(container)).toEqual(['readiness']);
    expect(readiness).toHaveTextContent(T.cn2b_blocker_source_cell_value_contract_invalid.en);
    expect(readiness).toHaveTextContent(T.cn2b_blocker_need_line_quantity_lineage_unsafe__source_cell_value_contract_invalid.en);
    expect(readiness.textContent).not.toMatch(/re-?import|replacement|automatic|delete that source|fixed in place/i);
    expect(within(readiness).getAllByText(/source_cell_value_contract_invalid|need_line_quantity_lineage_unsafe/).length).toBeGreaterThan(0);
  });

  it('the Advanced numeric-required label — as the READINESS stage really renders it — names both legitimate next steps (record one first; then delete the need line, designate the cell again and pin the current one)', async () => {
    // A numeric-required row that names no record: the head is unproven, so the escape opens the READINESS stage, which labels every blocker row.
    blockersOverride = [numericRequiredBlocker(null)];
    const { container } = await openSimpleAt('need-lines');
    expect(escapeBlock()).toHaveAttribute('data-stage', 'readiness');
    fireEvent.click(expertButton());
    await settle();
    expect(visibleStages(container)).toEqual(['readiness']);
    const label = T.cn2b_blocker_need_line_quantity_lineage_unsafe__source_quantity_requires_explicit_numeric_override.en;
    expect(label).toMatch(/record one first; once it has one, delete the need line, designate the cell again and pin the current override/);
    expect(stageOf(container, 'readiness')).toHaveTextContent(label); // rendered, not merely present in the table
    expect(stageOf(container, 'readiness').textContent).not.toMatch(/re-?import|replacement|delete that source/i);
    // …and in Arabic.
    cleanup();
    appState.lang = 'ar';
    appState.dir = 'rtl';
    blockersOverride = [numericRequiredBlocker(null)];
    const arabic = await openSimpleAt('need-lines');
    fireEvent.click(expertButton());
    await settle();
    expect(stageOf(arabic.container, 'readiness')).toHaveTextContent(T.cn2b_blocker_need_line_quantity_lineage_unsafe__source_quantity_requires_explicit_numeric_override.ar);
  });
});

// ==============================================================================
describe('HC1.3 · the Simple remedy\'s own failure mode — re-designating the cell but forgetting to PIN the existing head — is refused with copy that names the right step, and the retry works (H1_3_10b)', () => {
  it('the server refuses the unpinned save with numeric-required; the panel says to PIN the current override (not to record another); ticking it and saving again succeeds, pinned to the exact current head', async () => {
    records = recordsFor('12 boxes');
    overrides = [HEAD, OLD];
    lineage = { needLines: [], sources: [] };
    blockersOverride = null; // the cell is free: only the panel's designation flow is under test
    svc.setNeedLine.mockRejectedValueOnce(new CentralNeedsError('need_line_quantity_lineage_unsafe', 'need_line_quantity_lineage_unsafe', {
      sqlstate: '23514', details: `session=s1 source_record=rec-5 need_line=nl-1 reason=${NUMERIC_REQUIRED}`,
    }));
    const { container } = await openSimpleAt('need-lines');
    await waitFor(() => expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital'));
    fireEvent.click(within(candidateFor('qty')).getAllByRole('checkbox')[0]);
    // The cell is text, so nothing is prefilled: typing a quantity WITHOUT ticking the recorded override is the natural slip.
    const contribution = within(candidateFor('qty')).getByLabelText(`${T.cn2b_nl_contribution.en} — qty`) as HTMLInputElement;
    expect(contribution.value).toBe('');
    fireEvent.change(contribution, { target: { value: '12' } });
    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'first attempt' } });
    fireEvent.change(within(needLines()).getByTestId('cn2b-nl-unit-select'), { target: { value: 'box' } });
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_save.en }));
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    const banner = await within(needLines()).findByTestId('cn2b-nl-error');
    // The first write was the unpinned one the server refused …
    expect(svc.setNeedLine).toHaveBeenCalledTimes(1);
    const first = svc.setNeedLine.mock.calls[0][0] as { quantitySources: Array<{ appliedOverrideId: string | null }> };
    expect(first.quantitySources[0].appliedOverrideId).toBeNull();
    // … and the refusal tells the person the step they actually need: PIN the current override (it already exists), not record another.
    expect(banner).toHaveTextContent(T.cn2b_err_need_line_quantity_lineage_unsafe__source_quantity_requires_explicit_numeric_override.en);
    expect(banner.textContent).toMatch(/once it has one, pin the current override to the designated cell/);
    expect(banner.textContent).not.toMatch(/Record a numeric override for it and pin that override/);
    // Nothing opened Advanced for them, and nothing was recorded.
    expect(escapeBlock()).toBeNull();
    expect(svc.recordFieldOverride).not.toHaveBeenCalled();

    // The retry the message points at: tick the recorded (current) override, and save.
    fireEvent.click(within(candidateFor('qty')).getByRole('checkbox', { name: T.cn2b_nl_use_override.en }));
    expect(within(candidateFor('qty')).getByLabelText(`${T.cn2b_nl_contribution.en} — qty`)).toHaveValue('12');
    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'second attempt' } });
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_save.en }));
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(svc.setNeedLine).toHaveBeenCalledTimes(2));
    const second = svc.setNeedLine.mock.calls[1][0] as { quantitySources: Array<{ sourceRecordId: string; designatedQuantity: string; appliedOverrideId: string | null }> };
    expect(second.quantitySources).toEqual([{ sourceRecordId: 'rec-5', designatedQuantity: '12', appliedOverrideId: 'ov-head' }]); // the exact CURRENT head, not the older one
    await settle();
    expect(modeOf(container)).toBe('simple');
    expect(svc.recordFieldOverride).not.toHaveBeenCalled();
    expect(directBackend).toEqual([]);
  });
});

// ==============================================================================
describe('HC1.3 · Simple still offers NO generic way into Advanced (H1_3_18)', () => {
  const BANNED = /advanced|expert|متقدم|خبير/i;
  const controlsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('button, a[href], [role="button"], [role="link"], [role="switch"], [role="menuitem"], [role="tab"]')];
  const nameOf = (el: HTMLElement) => `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''} ${el.getAttribute('title') ?? ''}`;

  const STATES: Array<[string, () => void]> = [
    ['a plain not-ready list Simple resolves', () => { blockersOverride = null; }],
    ['numeric-required with a PROVEN numeric head (the new Simple remedy)', () => { records = recordsFor('12 boxes'); overrides = [HEAD]; blockersOverride = [numericRequiredBlocker()]; }],
    ['binding_invalid with a proven numeric head', () => { records = recordsFor('12 boxes'); overrides = [HEAD]; blockersOverride = [lineageBlocker(BINDING)]; }],
    ['mismatch', () => { blockersOverride = [lineageBlocker('source_quantity_override_mismatch')]; }],
    ['the server says ready', () => { readyNow = true; blockersOverride = [numericRequiredBlocker()]; }],
  ];

  for (const lang of ['en', 'ar'] as const) {
    it(`${lang}: in every state Simple resolves there is no escape, no control named for Advanced, no footer, no mode toggle — the way in exists only through a contextual escape`, async () => {
      for (const [name, arrange] of STATES) {
        appState.lang = lang;
        appState.dir = lang === 'ar' ? 'rtl' : 'ltr';
        readyNow = false; blockersOverride = null; overrides = []; records = recordsFor(12);
        arrange();
        const { container, unmount } = render(<CentralNeedsScreen />);
        await waitFor(() => expect(['need-lines', 'pending']).toContain(stepOf()));
        await settle();
        expect(escapeBlock(), name).toBeNull();
        expect(screen.queryByTestId('cn2b-simple-expert-open'), name).toBeNull();
        expect(screen.queryByTestId('cn2b-mode-toggle'), name).toBeNull(); // that toggle is the ADVANCED header's way back
        expect(container.querySelector('footer'), name).toBeNull();
        for (const id of ['cn2b-simple-advanced-link', 'cn2b-simple-continue-advanced', 'cn2b-simple-handoff']) expect(screen.queryByTestId(id), `${name}: ${id}`).toBeNull();
        const page = screen.getByTestId('cn2b-simple-workspace');
        for (const control of controlsOf(page)) expect(nameOf(control), `${name}: ${control.outerHTML.slice(0, 80)}`).not.toMatch(BANNED);
        expect(page.textContent ?? '', name).not.toMatch(/Advanced options|advanced options|خيارات متقدمة|الخيارات المتقدمة/);
        expect(modeOf(container), name).toBe('simple');
        unmount();
        cleanup();
        vi.clearAllMocks();
        svc.listPlanRevisions.mockImplementation(async () => [revision()]);
        svc.listOverrides.mockImplementation(async () => overrides);
        svc.fetchReviewReadiness.mockImplementation(async () => readinessNow());
      }
    });
  }
});

// ==============================================================================
describe('HC1.3 · permissions are not broadened (§18)', () => {
  const VIEW_ONLY = ['central_needs.view'];

  it('numeric-required + a proven numeric head: no escape for ANYONE — no permission is consulted for a case Simple resolves', async () => {
    records = recordsFor('12 boxes');
    overrides = [HEAD];
    blockersOverride = [numericRequiredBlocker()];
    appState.myPermissions = new Set(VIEW_ONLY);
    await openSimpleAt('need-lines');
    expect(escapeBlock()).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-expert-no-permission')).toBeNull();
    NO_BUSINESS_WRITE();
  });

  it('numeric-required with NO current head still needs the edit capability: without it the person is told who to ask — no button, no new permission', async () => {
    records = recordsFor('12 boxes');
    overrides = [];
    blockersOverride = [numericRequiredBlocker()];
    appState.myPermissions = new Set(VIEW_ONLY);
    await openSimpleAt('need-lines');
    const block = escapeBlock() as HTMLElement;
    expect(block).toHaveAttribute('data-stage', 'review');
    expect(screen.queryByTestId('cn2b-simple-expert-open')).toBeNull();
    expect(within(block).getByTestId('cn2b-simple-expert-no-permission')).toHaveTextContent(T.cn2b_simple_expert_no_permission.en);
  });

  it('the unproven diagnostic stays readable under the existing view access alone, and opens', async () => {
    blockersOverride = [numericRequiredBlocker(null)];
    appState.myPermissions = new Set(VIEW_ONLY);
    const { container } = await openSimpleAt('need-lines');
    expect(escapeBlock()).toHaveAttribute('data-stage', 'readiness');
    fireEvent.click(expertButton());
    await settle();
    expect(visibleStages(container)).toEqual(['readiness']);
    NO_BUSINESS_WRITE();
  });

  it('with the edit capability (and no import) the no-head case offers the button, and the escape needs no other permission', async () => {
    records = recordsFor('12 boxes');
    overrides = [];
    blockersOverride = [numericRequiredBlocker()];
    appState.myPermissions = new Set(['central_needs.view', 'central_needs.edit']);
    await openSimpleAt('need-lines');
    expect(escapeBlock()).toHaveAttribute('data-stage', 'review');
    expect(screen.getByTestId('cn2b-simple-expert-open')).toBeInTheDocument();
  });
});
