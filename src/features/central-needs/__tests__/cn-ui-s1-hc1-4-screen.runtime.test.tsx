/** @vitest-environment jsdom */
/**
 * CN-UI-S1 HC1.4 — PINNABLE NUMERIC HEAD CLOSURE through the REAL `CentralNeedsScreen` and the REAL,
 * UNCHANGED canonical `CentralNeedsNeedLinePanel` (Simple, its default). Only the service boundary, the
 * organization / warehouse reads and `useApp` are mocked; the Supabase client throws on any direct call.
 *
 * "Numeric" is not "pinnable": the canonical quantity lexeme is a plain decimal of at most 256 characters.
 *
 *   H1_4_10  a PINNABLE 256-character current head is a REAL Simple remedy: the panel offers it, the SAME
 *            lexeme `numericOverrideLexeme(head)` returns becomes the designated quantity, `appliedOverrideId`
 *            is the exact current head, `setNeedLine` is the only write, no override is created, no mode switch;
 *            proven for BOTH head-dependent reasons;
 *   H1_4_11  a 257-character numeric head is NOT presented as locally resolvable: the contextual escape routes
 *            to REVIEW (both reasons); the default Simple flow through the panel has nothing to save (no lexeme
 *            is offered, the contribution starts blank, Save stays disabled until a value is typed by hand —
 *            the server stays the guard for that); and no older override is ever substituted.
 *
 * (HC1.5 closed what this header used to record as out of scope: the canonical panel showed its "Base it on the
 * recorded override" control for any NUMERIC head, because it gated on `isNumericOverride`. It now gates on
 * pinnability, so for the 257-character head there is no pin control at all — see cn-ui-s1-hc1-5-*.)
 */
import { numericOverrideLexeme } from '../central-needs.lineage';
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
const needLines = () => screen.getByTestId('cn2b-simple-need-lines');
const candidateFor = (fieldName: string) =>
  within(needLines()).getByText(new RegExp(`· ${fieldName}$`)).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
const escapeBlock = () => screen.queryByTestId('cn2b-simple-expert-escape');
const expertButton = () => screen.getByTestId('cn2b-simple-expert-open');
const stages = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('section.cn2b-stage')];
const visibleStages = (container: HTMLElement) => stages(container).filter((s) => !s.hasAttribute('hidden')).map((s) => s.getAttribute('data-stage'));
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
const detail = (record: string | null, reason: string | null) =>
  ['session=s1', record === null ? null : `source_record=${record}`, 'need_line=nl-1', reason === null ? null : `reason=${reason}`].filter(Boolean).join(' ');
const lineageBlocker = (reason: string | null, record: string | null = 'rec-5') => ({ blocker: 'need_line_quantity_lineage_unsafe', detail: detail(record, reason) });

const LINE: NeedLine = {
  id: 'nl-1', planRevisionId: REV, organizationId: ORG, beneficiaryOrganizationId: BENE, targetWarehouseId: null, centralItemId: ITEM,
  approvedQuantity: '10', approvedUnit: 'box', unitConversionState: 'canonical', sourceUnitText: null, mappingReason: 'reviewed', updatedAt: '2026-09-27T10:00:00+00:00',
};
const link = (appliedOverrideId: string, designatedQuantity: string): NeedLineSourceLink => ({
  needLineId: 'nl-1', sourceRecordId: 'rec-5', designatedQuantity, appliedOverrideId, importSessionId: 's1', targetEntity: ROW_5, fieldName: 'qty',
});


// The real screen mounts many times per test here; give a loaded full-suite run the headroom the HC1.1 / HC1.3 screen suites have.
vi.setConfig({ testTimeout: 30_000 });

// ---- HC1.4 fixtures --------------------------------------------------------------
const NUMERIC_REQUIRED = 'source_quantity_requires_explicit_numeric_override';
const BINDING_INVALID = 'source_quantity_override_binding_invalid';
const BOTH_REASONS = [NUMERIC_REQUIRED, BINDING_INVALID] as const;
/** `len` characters of plain integer (what PostgreSQL prints for a jsonb integer of that many digits). */
const intText = (len: number) => `1${'0'.repeat(len - 1)}`;
/** An override exactly as `listOverrides` returns one: `finalValue` is the JSON.parse of the jsonb, `finalValueText` is `final_value::text`. */
const pgOverride = (id: string, text: string, createdAt: string, sourceRecordId = 'rec-5'): FieldOverride =>
  ({ ...override(id, JSON.parse(text), createdAt, sourceRecordId), finalValueText: text });
const unpinnedLink = (designatedQuantity: string): NeedLineSourceLink => ({ ...link('unused', designatedQuantity), appliedOverrideId: null });
const refusedLinkFor = (reason: string): NeedLineSourceLink => (reason === NUMERIC_REQUIRED ? unpinnedLink('12') : link('ov-old', '9'));

const LEXEME_256 = intText(256);
const LEXEME_257 = intText(257);
const HEAD_256 = pgOverride('ov-head-256', LEXEME_256, '2026-09-26T10:00:00+00:00');
const HEAD_257 = pgOverride('ov-head-257', LEXEME_257, '2026-09-26T10:00:00+00:00');
const OLDER_PINNABLE = pgOverride('ov-old', '9', '2026-09-20T10:00:00+00:00');

// ==============================================================================
describe('HC1.4 · a PINNABLE 256-character current head is a REAL Simple remedy through the unchanged panel (H1_4_10)', () => {
  it.each(BOTH_REASONS)('H1_4_10 — %s: no escape; delete the refused line → designate the exact cell → tick the current head → the SAME lexeme numericOverrideLexeme() returns is the designated quantity, pinned to the exact head id, saved through setNeedLine; no override, no mode switch', async (reason) => {
    // The canonical helper is the authority for what may be sent; the head is exactly at its ceiling.
    expect(LEXEME_256).toHaveLength(256);
    expect(numericOverrideLexeme(HEAD_256)).toBe(LEXEME_256);
    records = recordsFor('12 boxes'); // a cell that is not a plain number: only a pinned numeric override can count
    overrides = [HEAD_256, OLDER_PINNABLE]; // server order: newest first, so ov-head-256 is the cell's current head
    lineage = { needLines: [LINE], sources: [refusedLinkFor(reason)] };
    blockersOverride = [lineageBlocker(reason)];
    svc.deleteNeedLine.mockImplementation(async () => {
      lineage = { needLines: [], sources: [] }; // the server's state after the delete: no line, no claim on the cell
      blockersOverride = null;
      return { needLineId: 'nl-1' };
    });
    const { container } = await openSimpleAt('need-lines');
    await settle();

    // Simple resolves it: the person is NOT sent to the expert tools.
    expect(escapeBlock()).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-expert-open')).toBeNull();
    const overrideReadsAfterLoad = svc.listOverrides.mock.calls.length;

    // The refused line is in the canonical panel with its own delete control, and the cell is free again afterwards.
    await waitFor(() => expect(within(needLines()).getAllByTestId('cn2b-nl-line')).toHaveLength(1));
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_delete.en }));
    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_delete_reason.en), { target: { value: 'rebuild on the current correction' } });
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_delete_confirm.en }));
    await waitFor(() => expect(svc.deleteNeedLine).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(needLines()).queryAllByTestId('cn2b-nl-line')).toHaveLength(0));
    await waitFor(() => expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital'));

    // Designate it: the panel AVAILS the 256-character current head (the exact id, flagged numeric) and the older one is not even offered.
    fireEvent.click(within(candidateFor('qty')).getAllByRole('checkbox')[0]);
    const evidence = within(candidateFor('qty')).getAllByTestId('cn2b-nl-override-evidence');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toHaveAttribute('data-override-id', 'ov-head-256');
    expect(evidence[0]).toHaveAttribute('data-numeric', 'true');
    fireEvent.click(within(candidateFor('qty')).getByRole('checkbox', { name: T.cn2b_nl_use_override.en }));

    // The designated quantity IS the helper's lexeme — all 256 characters, untouched.
    const contribution = within(candidateFor('qty')).getByLabelText(`${T.cn2b_nl_contribution.en} — qty`) as HTMLInputElement;
    expect(contribution.value).toBe(numericOverrideLexeme(HEAD_256));
    expect(contribution.value).toHaveLength(256);

    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'rebuilt on the current correction' } });
    fireEvent.change(within(needLines()).getByTestId('cn2b-nl-unit-select'), { target: { value: 'box' } });
    const save = within(needLines()).getByRole('button', { name: T.cn2b_nl_save.en });
    expect(save).toBeEnabled(); // the canonical panel lets it through
    fireEvent.click(save);
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(svc.setNeedLine).toHaveBeenCalledTimes(1)); // the existing write path, once

    const sent = svc.setNeedLine.mock.calls[0][0] as { quantitySources: Array<{ sourceRecordId: string; designatedQuantity: string; appliedOverrideId: string | null }>; approvedQuantity: string };
    expect(sent.quantitySources).toEqual([{ sourceRecordId: 'rec-5', designatedQuantity: numericOverrideLexeme(HEAD_256), appliedOverrideId: 'ov-head-256' }]);
    expect(sent.quantitySources[0].appliedOverrideId).not.toBe('ov-old'); // never the older override
    expect(sent.quantitySources[0].designatedQuantity).toHaveLength(256);
    expect(sent.approvedQuantity).toBe(numericOverrideLexeme(HEAD_256)); // a single source: the approved quantity is that same lexeme
    expect(svc.setNeedLine).toHaveBeenCalledWith(expect.objectContaining({ planRevisionId: REV, beneficiaryOrganizationId: BENE, centralItemId: ITEM }));

    // The whole remedy happened in Simple: never Advanced, never an override created, never a direct backend call, never an escape.
    await settle();
    expect(modeOf(container)).toBe('simple');
    expect(stages(container)).toHaveLength(0);
    expect(escapeBlock()).toBeNull();
    expect(svc.recordFieldOverride).not.toHaveBeenCalled();
    for (const w of WRITE_FNS) if (w !== 'deleteNeedLine' && w !== 'setNeedLine') expect(svc[w], w).not.toHaveBeenCalled(); // those two writes, and no other
    expect(directBackend).toEqual([]);
    expect(svc.deleteNeedLine).toHaveBeenCalledTimes(1);
    expect(svc.setNeedLine).toHaveBeenCalledTimes(1);
    // …and the only override reads were the panel's own post-write refreshes (one per canonical write), not the derivation's.
    expect(svc.listOverrides.mock.calls.length - overrideReadsAfterLoad).toBe(2);
  });
});

// ==============================================================================
describe('HC1.4 · a 257-character numeric current head is NOT presented as locally resolvable (H1_4_11)', () => {
  it.each(BOTH_REASONS)('H1_4_11 — %s: the contextual escape routes to REVIEW (not Simple), says a USABLE correction is needed, and the click changes the presentation only', async (reason) => {
    expect(numericOverrideLexeme(HEAD_257)).toBeNull(); // a finite, non-negative number … that cannot be a designated quantity
    records = recordsFor('12 boxes');
    overrides = [HEAD_257, OLDER_PINNABLE]; // the NEWEST head is the unpinnable one; an older, pinnable override sits behind it
    lineage = { needLines: [LINE], sources: [refusedLinkFor(reason)] };
    blockersOverride = [lineageBlocker(reason)];
    const { container } = await openSimpleAt('need-lines');
    await settle();

    const block = escapeBlock() as HTMLElement;
    expect(block).toBeInTheDocument(); // NOT resolved in Simple
    expect(block).toHaveAttribute('data-stage', 'review');
    expect(block).toHaveAttribute('data-reason', 'numeric_override');
    expect(block).toHaveTextContent(T.cn2b_simple_expert_body_numeric_override.en.replace('__STAGE__', T.cn2b_stage_review.en));
    expect(block.textContent).toMatch(/usable numeric correction/);
    expect(block.textContent).not.toMatch(/256|lexeme|JSON/i); // no implementation jargon in the UI
    const reads = readCounts();

    fireEvent.click(expertButton());
    await settle();
    expect(modeOf(container)).toBe('advanced');
    expect(visibleStages(container)).toEqual(['review']); // the canonical override editor's stage, nothing else painted first
    expect(readCounts()).toEqual(reads); // presentation only: no read, no retry
    NO_BUSINESS_WRITE(); // no write — in particular no setNeedLine
    expect(directBackend).toEqual([]);
  });

  it('H1_4_11 — attempting the Simple resolution anyway leaves nothing to save: the panel offers only the CURRENT head as evidence, has no lexeme for it (so, since HC1.5, no pin control), the contribution starts blank and Save stays disabled; the older override is never substituted', async () => {
    records = recordsFor('12 boxes');
    overrides = [HEAD_257, OLDER_PINNABLE];
    lineage = { needLines: [], sources: [] }; // the refused line is already gone (either reason): only the designation flow is under test
    blockersOverride = null;
    await openSimpleAt('need-lines');
    await waitFor(() => expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital'));
    fireEvent.click(within(candidateFor('qty')).getAllByRole('checkbox')[0]);

    // Only the CURRENT head is offered — the older, pinnable override is never substituted for it.
    const evidence = within(candidateFor('qty')).getAllByTestId('cn2b-nl-override-evidence');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toHaveAttribute('data-override-id', 'ov-head-257');
    // …but the canonical helper has no lexeme for it, so (HC1.5) the panel offers no pin control for it at all — it is evidence only —
    // the contribution starts blank and there is nothing to save.
    expect(evidence[0]).toHaveAttribute('data-pinnable', 'false');
    expect(within(candidateFor('qty')).queryByRole('checkbox', { name: T.cn2b_nl_use_override.en })).toBeNull();
    const contribution = within(candidateFor('qty')).getByLabelText(`${T.cn2b_nl_contribution.en} — qty`) as HTMLInputElement;
    expect(contribution.value).toBe('');
    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'attempt' } });
    fireEvent.change(within(needLines()).getByTestId('cn2b-nl-unit-select'), { target: { value: 'box' } });
    const save = within(needLines()).getByRole('button', { name: T.cn2b_nl_save.en });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    await settle();
    expect(screen.queryByRole('button', { name: T.cn2b_nl_bulk_confirm.en })).toBeNull(); // the confirmation step never opens
    expect(svc.setNeedLine).not.toHaveBeenCalled();
    expect(svc.recordFieldOverride).not.toHaveBeenCalled();
    expect(directBackend).toEqual([]);
  });

  it.each(BOTH_REASONS)('H1_4_11 — %s: once a USABLE correction is the newest head the escape is gone (the long override behind it is history; only the current head decides)', async (reason) => {
    // The reviewer records a short numeric correction in DATA REVIEW (the chain is re-read: a new newest head, 12).
    records = recordsFor('12 boxes');
    const NEWER_SHORT = pgOverride('ov-newer-short', '12', '2026-09-27T10:00:00+00:00');
    overrides = [NEWER_SHORT, HEAD_257, OLDER_PINNABLE];
    lineage = { needLines: [LINE], sources: [refusedLinkFor(reason)] };
    blockersOverride = [lineageBlocker(reason)];
    await openSimpleAt('need-lines');
    await settle();
    expect(escapeBlock()).toBeNull();
    // …and the panel, asked for the head, offers exactly the new short one.
    await waitFor(() => expect(within(needLines()).getAllByTestId('cn2b-nl-line')).toHaveLength(1));
  });
});
