/** @vitest-environment jsdom */
/**
 * CN-UI-S1 HC1.5 — CANONICAL PANEL PINNABILITY ALIGNMENT through the REAL `CentralNeedsScreen` and the REAL
 * canonical `CentralNeedsNeedLinePanel` (Simple, its default). Only the service boundary, the organization /
 * warehouse reads and `useApp` are mocked; the Supabase client throws on any direct call.
 *
 * HC1.4 made Simple readiness ask "can this head be PINNED?" (`numericOverrideLexeme(head) !== null`). HC1.5 makes
 * the panel the same: it no longer shows "Base it on the recorded override" for a head that is merely NUMERIC.
 *
 *   H1_5_12  the HC1.4 readiness route is unchanged: an unpinnable current head still routes to REVIEW (both reasons)
 *   H1_5_13  the panel offers NO pin control for that head — in English and Arabic — and says truthfully why; the
 *            person who ignores the escape, deletes the refused line and designates the cell is left with a blank
 *            contribution, a disabled Save and no write (the older pinnable override is never substituted)
 *   H1_5_14  a PINNABLE head (256 characters, ordinary, trailing-zero) still pins and saves through the existing
 *            `setNeedLine`: the exact lexeme, the exact current head id, no override created, no mode switch
 *
 * The component-level proofs (the gate, the programmatic guard, the stale-pin path) are in
 * cn-ui-s1-hc1-5-panel-pinnability.runtime.test.tsx; the no-fallback source pin is in cn-ui-s1-hc1-5-static-contract.test.ts.
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

const SHORT_12 = pgOverride('ov-12', '12', '2026-09-26T10:00:00+00:00');
const TRAILING_ZERO = pgOverride('ov-1250', '12.50', '2026-09-26T10:00:00+00:00');

/** The refused line is deleted through the panel's own control, exactly as the canonical flow does it. */
async function deleteRefusedLine() {
  await waitFor(() => expect(within(needLines()).getAllByTestId('cn2b-nl-line')).toHaveLength(1));
  fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_delete.en }));
  fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_delete_reason.en), { target: { value: 'rebuild on a correction' } });
  fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_delete_confirm.en }));
  await waitFor(() => expect(svc.deleteNeedLine).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(within(needLines()).queryAllByTestId('cn2b-nl-line')).toHaveLength(0));
  await waitFor(() => expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital'));
}
const serverDropsTheLine = () => svc.deleteNeedLine.mockImplementation(async () => {
  lineage = { needLines: [], sources: [] }; // the server's state after the delete: no line, no claim on the cell
  blockersOverride = null;
  return { needLineId: 'nl-1' };
});
const pinControl = (name: string) => within(candidateFor('qty')).queryByRole('checkbox', { name });

// ==============================================================================
describe('HC1.5 · H1_5_12 — the HC1.4 readiness route is unchanged: an unpinnable current head still routes to REVIEW', () => {
  it.each(BOTH_REASONS)('H1_5_12 — %s: the contextual escape is shown (stage review, reason numeric_override); the click only changes the presentation', async (reason) => {
    expect(numericOverrideLexeme(HEAD_257)).toBeNull();
    records = recordsFor('12 boxes');
    overrides = [HEAD_257, OLDER_PINNABLE]; // the newest head is the unpinnable one; an older pinnable override sits behind it
    lineage = { needLines: [LINE], sources: [refusedLinkFor(reason)] };
    blockersOverride = [lineageBlocker(reason)];
    const { container } = await openSimpleAt('need-lines');
    await waitFor(() => expect(escapeBlock()).toBeInTheDocument()); // NOT resolved in Simple
    await settle();

    const block = escapeBlock() as HTMLElement;
    expect(block).toHaveAttribute('data-stage', 'review');
    expect(block).toHaveAttribute('data-reason', 'numeric_override');
    expect(block.textContent).toMatch(/usable numeric correction/);
    const reads = readCounts();
    fireEvent.click(expertButton());
    await settle();
    expect(modeOf(container)).toBe('advanced');
    expect(visibleStages(container)).toEqual(['review']);
    expect(readCounts()).toEqual(reads); // presentation only
    NO_BUSINESS_WRITE();
    expect(directBackend).toEqual([]);
  });

  it.each(BOTH_REASONS)('H1_5_12 — %s: with a PINNABLE current head the same row still has no escape (Simple resolves it)', async (reason) => {
    records = recordsFor('12 boxes');
    overrides = [HEAD_256, OLDER_PINNABLE];
    lineage = { needLines: [LINE], sources: [refusedLinkFor(reason)] };
    blockersOverride = [lineageBlocker(reason)];
    await openSimpleAt('need-lines');
    // a POSITIVE anchor first: the refused line has loaded and the readiness has been derived, so "no escape" cannot be a not-yet-loaded accident
    await waitFor(() => expect(within(needLines()).getAllByTestId('cn2b-nl-line')).toHaveLength(1));
    await settle();
    expect(escapeBlock()).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-expert-open')).toBeNull();
  });
});

// ==============================================================================
describe('HC1.5 · H1_5_13 — real screen + real panel: NO misleading pin affordance for the unpinnable head', () => {
  it.each(BOTH_REASONS)('H1_5_13 — %s: the escape is shown; if it is ignored and the line is deleted, designating the cell offers the head as evidence only — no pin control, the truthful note, a blank contribution, Save disabled, nothing written', async (reason) => {
    records = recordsFor('12 boxes');
    overrides = [HEAD_257, OLDER_PINNABLE];
    lineage = { needLines: [LINE], sources: [refusedLinkFor(reason)] };
    blockersOverride = [lineageBlocker(reason)];
    serverDropsTheLine();
    const { container } = await openSimpleAt('need-lines');
    await settle();
    expect(escapeBlock()).toBeInTheDocument(); // the path the copy prescribes

    await deleteRefusedLine(); // …ignored: the person deletes the refused line and designates the cell again
    fireEvent.click(within(candidateFor('qty')).getAllByRole('checkbox')[0]);

    // The panel shows the CURRENT head as evidence — with its value — and says what it is: a number that cannot be a quantity.
    const ev = within(candidateFor('qty')).getAllByTestId('cn2b-nl-override-evidence');
    expect(ev).toHaveLength(1); // the older, pinnable override is not offered
    expect(ev[0]).toHaveAttribute('data-override-id', 'ov-head-257');
    expect(ev[0]).toHaveAttribute('data-numeric', 'true');
    expect(ev[0]).toHaveAttribute('data-pinnable', 'false');
    expect(ev[0]).toHaveTextContent(T.cn2b_nl_override_recorded.en);
    expect(ev[0]).toHaveTextContent(LEXEME_257); // its VALUE stays visible: a reviewer can see that a correction exists, and what it says
    expect(pinControl(T.cn2b_nl_use_override.en)).toBeNull(); // no "Base it on the recorded override"
    expect(within(candidateFor('qty')).queryByText(T.cn2b_nl_use_override.en)).toBeNull();
    expect(within(candidateFor('qty')).getByTestId('cn2b-nl-override-not-pinnable')).toHaveTextContent(T.cn2b_nl_override_not_pinnable.en);
    expect(within(candidateFor('qty')).queryByTestId('cn2b-nl-override-not-numeric')).toBeNull(); // not "not a number"
    expect(within(candidateFor('qty')).queryByTestId('cn2b-nl-override-applied')).toBeNull();

    // Nothing was suggested from it, so there is nothing to save.
    const contribution = within(candidateFor('qty')).getByLabelText(`${T.cn2b_nl_contribution.en} — qty`) as HTMLInputElement;
    expect(contribution.value).toBe('');
    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'ignored the escape' } });
    fireEvent.change(within(needLines()).getByTestId('cn2b-nl-unit-select'), { target: { value: 'box' } });
    const save = within(needLines()).getByRole('button', { name: T.cn2b_nl_save.en });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    await settle();
    expect(screen.queryByRole('button', { name: T.cn2b_nl_bulk_confirm.en })).toBeNull();
    expect(svc.setNeedLine).not.toHaveBeenCalled();
    expect(svc.recordFieldOverride).not.toHaveBeenCalled();
    expect(modeOf(container)).toBe('simple'); // the panel itself never switches mode
    expect(directBackend).toEqual([]);
  });

  it('H1_5_13 — Arabic: the same states, with the Arabic copy and no pin control', async () => {
    appState.lang = 'ar';
    appState.dir = 'rtl';
    records = recordsFor('12 boxes');
    overrides = [HEAD_257, OLDER_PINNABLE];
    lineage = { needLines: [], sources: [] };
    blockersOverride = null;
    await openSimpleAt('need-lines');
    await waitFor(() => expect(within(needLines()).getAllByTestId('cn2b-nl-candidate').length).toBeGreaterThan(0));
    const cand = within(needLines()).getAllByTestId('cn2b-nl-candidate')[0];
    fireEvent.click(within(cand).getAllByRole('checkbox')[0]);
    expect(within(cand).getByTestId('cn2b-nl-override-evidence')).toHaveAttribute('data-pinnable', 'false');
    expect(within(cand).queryByRole('checkbox', { name: T.cn2b_nl_use_override.ar })).toBeNull();
    expect(within(cand).getByTestId('cn2b-nl-override-not-pinnable')).toHaveTextContent(T.cn2b_nl_override_not_pinnable.ar);
    expect(within(cand).queryByTestId('cn2b-nl-override-not-numeric')).toBeNull();
  });
});

// ==============================================================================
describe('HC1.5 · H1_5_14 — real screen + real panel: a PINNABLE head still pins and saves through the existing setNeedLine', () => {
  it.each([
    ['256-character', HEAD_256],
    ['ordinary', SHORT_12],
    ['trailing-zero fraction (the exact text, not the JS rendering)', TRAILING_ZERO],
  ] as const)('H1_5_14 — a %s current head: the control exists, the lexeme is the contribution, setNeedLine carries the exact lexeme and head id, and nothing else is written', async (_label, head) => {
    const lexeme = numericOverrideLexeme(head);
    expect(lexeme).not.toBeNull();
    records = recordsFor('12 boxes'); // not a plain number: only a pinned numeric override can count
    overrides = [head, OLDER_PINNABLE]; // newest first: `head` is the cell's current head
    lineage = { needLines: [], sources: [] };
    blockersOverride = null;
    const { container } = await openSimpleAt('need-lines');
    await waitFor(() => expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital'));
    fireEvent.click(within(candidateFor('qty')).getAllByRole('checkbox')[0]);

    const ev = within(candidateFor('qty')).getAllByTestId('cn2b-nl-override-evidence');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toHaveAttribute('data-override-id', head.id);
    expect(ev[0]).toHaveAttribute('data-numeric', 'true');
    expect(ev[0]).toHaveAttribute('data-pinnable', 'true');
    expect(within(candidateFor('qty')).queryByTestId('cn2b-nl-override-not-pinnable')).toBeNull();
    fireEvent.click(pinControl(T.cn2b_nl_use_override.en) as HTMLInputElement);
    const contribution = within(candidateFor('qty')).getByLabelText(`${T.cn2b_nl_contribution.en} — qty`) as HTMLInputElement;
    expect(contribution.value).toBe(lexeme);

    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'pinned the current correction' } });
    fireEvent.change(within(needLines()).getByTestId('cn2b-nl-unit-select'), { target: { value: 'box' } });
    const save = within(needLines()).getByRole('button', { name: T.cn2b_nl_save.en });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(svc.setNeedLine).toHaveBeenCalledTimes(1));
    const sent = svc.setNeedLine.mock.calls[0][0] as { quantitySources: Array<{ sourceRecordId: string; designatedQuantity: string; appliedOverrideId: string | null }>; approvedQuantity: string };
    expect(sent.quantitySources).toEqual([{ sourceRecordId: 'rec-5', designatedQuantity: lexeme, appliedOverrideId: head.id }]);
    expect(sent.quantitySources[0].appliedOverrideId).not.toBe('ov-old');
    expect(sent.approvedQuantity).toBe(lexeme);

    await settle();
    expect(modeOf(container)).toBe('simple');
    expect(svc.recordFieldOverride).not.toHaveBeenCalled();
    for (const w of WRITE_FNS) if (w !== 'setNeedLine') expect(svc[w], w).not.toHaveBeenCalled();
    expect(directBackend).toEqual([]);
  });
});
