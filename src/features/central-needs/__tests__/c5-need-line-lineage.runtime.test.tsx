/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type { BeneficiaryColumnSummary, FieldOverride } from '../central-needs.service';

/**
 * C5 (M217 companion) — the need-line surface against quantity lineage.
 *
 *   §14  the override offered for a cell is ITS head — the first server row
 *        of its exact source record — never another record's override that
 *        shares its row and header text; a pin that stops being the head is
 *        cleared visibly with its value and must be chosen again; the preview
 *        lists every pin the write carries (filter-hidden cells included);
 *        a stale-binding refusal clears the pin and reloads at once.
 *   §15  suggestions only from the two safe evidence shapes; typed quantities
 *        in the exact server grammar, untrimmed; only a JSON-number head can
 *        be pinned.
 *   §13  while the override chain is unavailable, nothing is saved.
 *   §14  refusals are decided by businessCode and explained by `reason=`;
 *        a retryable contention says "try again" and is never retried.
 *   UI-F1 a stale binding re-reads the override chain on its own, after the
 *        revision reload; UI-F2 a refusal part-way through a multi-scope
 *        confirmation says how many scopes were saved, and an unknown outcome
 *        is never titled a refusal; UI-F3 refusals reach the screen; UI-F5 an
 *        unavailable chain can be re-read on its own.
 *
 * The need-line writes are mocked at the service boundary; the server's own
 * refusals are proven against PostgreSQL by the M217 suites.
 */

const setNeedLine = vi.fn();
const deleteNeedLine = vi.fn();
const getOrganizations = vi.fn();
const getWarehouses = vi.fn();

vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    rpc: () => { throw new Error('the need-line panel must go through the service'); },
    from: () => { throw new Error('the need-line panel must not read tables directly'); },
  },
}));
vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganizations: (...a: unknown[]) => getOrganizations(...a),
}));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({
  getWarehouses: (...a: unknown[]) => getWarehouses(...a),
}));
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  return {
    ...actual,
    setNeedLine: (...a: unknown[]) => setNeedLine(...a),
    deleteNeedLine: (...a: unknown[]) => deleteNeedLine(...a),
  };
});

const { CentralNeedsNeedLinePanel } = await import('../CentralNeedsNeedLinePanel');
const { CentralNeedsError, centralNeedsErrorFromPostgrest } = await import('../central-needs.service');

const BENE = '00000000-0000-0000-0000-0000000000b1';
const ITEM = '00000000-0000-0000-0000-0000000000a1';
const ROW_5 = 'sheet:0:row:5';
const ROW_6 = 'sheet:0:row:6';

const envelope = (value: unknown, valueType = typeof value === 'number' ? 'number' : 'string') =>
  ({ value, valueType, isFormula: false, formula: null });

const record = (id: string, entity: string, fieldName: string, sourceValues: Record<string, unknown>, ordinal: number,
  importSessionId = 's1') => ({
  id, importSessionId, recordOrdinal: ordinal, targetEntity: entity, fieldName, sourceValues,
  sourceProvenance: { sheetIndex: 0, coordinate: { col: ordinal } },
});

const column = (columnIndex: number): BeneficiaryColumnSummary => ({
  importSessionId: 's1', originalFilename: 'need.xlsx', archiveEntryPath: null, sheetIndex: 0, sheetName: null,
  columnIndex, sourceFieldName: null, numericValueCount: 1, zeroValueCount: 0, nonzeroNumericCount: 1,
  mappingId: `bc-${columnIndex}`, decision: 'beneficiary', beneficiaryOrganizationId: BENE, mappingReason: 'confirmed',
  mappedAt: '2026-01-01T00:00:00.000Z', mappedRowNumericCount: 1, reviewRequired: false,
});

const override = (id: string, sourceRecordId: string, finalValue: unknown, over: Partial<FieldOverride> = {}): FieldOverride => ({
  id, sourceRecordId, targetEntity: ROW_5, fieldName: 'qty', previousValue: null, finalValue,
  finalValueText: typeof finalValue === 'number' ? String(finalValue) : JSON.stringify(finalValue),
  overrideReason: `reason for ${id}`, overrideNote: null, createdAt: '2026-09-26T10:00:00+00:00', ...over,
});

type PanelProps = Parameters<typeof CentralNeedsNeedLinePanel>[0];

function renderPanel(over: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    lang: 'en',
    planRevisionId: 'rev-1',
    editable: true,
    dispositions: [
      { id: 'd5', importSessionId: 's1', targetEntity: ROW_5, decision: 'mapped', centralItemId: ITEM, decisionReason: null, decidedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'd6', importSessionId: 's1', targetEntity: ROW_6, decision: 'mapped', centralItemId: ITEM, decisionReason: null, decidedAt: '2026-01-01T00:00:00.000Z' },
    ],
    records: [
      record('rec-5', ROW_5, 'qty', envelope('12 boxes'), 1),
      record('rec-6', ROW_6, 'qty', envelope(40), 2),
    ],
    overrides: [],
    overrideReadFailure: null,
    needLines: [],
    claimedSources: [],
    beneficiaryColumns: [column(1), column(2)],
    onChanged: () => {},
    ...over,
  };
  const view = render(<CentralNeedsNeedLinePanel {...props} />);
  return { ...view, props, rerenderWith: (next: Partial<PanelProps>) => view.rerender(<CentralNeedsNeedLinePanel {...props} {...next} />) };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const candidateFor = (entity: string, field = 'qty') =>
  screen.getByText(new RegExp(`^${esc(entity)} · ${esc(field)}$`)).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
const pick = (entity: string, field = 'qty') => fireEvent.click(within(candidateFor(entity, field)).getAllByRole('checkbox')[0]);
const pinBox = (entity: string) =>
  within(candidateFor(entity)).queryByRole('checkbox', { name: T.cn2b_nl_use_override.en }) as HTMLInputElement | null;
const contribution = (entity: string) =>
  within(candidateFor(entity)).getByLabelText(`${T.cn2b_nl_contribution.en} — qty`) as HTMLInputElement;
const fillReasonAndUnit = () => {
  fireEvent.change(screen.getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'lineage review' } });
  const unit = screen.queryByTestId('cn2b-nl-unit-select') as HTMLSelectElement | null;
  if (unit && unit.value === '') fireEvent.change(unit, { target: { value: 'box' } });
};
const saveButton = () => screen.getByRole('button', { name: T.cn2b_nl_save.en });
const openPreview = () => fireEvent.click(saveButton());
const confirm = () => fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
const blockers = () => [...(screen.queryByTestId('cn2b-nl-save-blockers')?.querySelectorAll('[data-blocker]') ?? [])]
  .map((b) => b.getAttribute('data-blocker'));

beforeEach(() => {
  setNeedLine.mockReset().mockResolvedValue({ needLineId: 'nl-1', created: true, sourceLinkCount: 1, addedLinkCount: 1, approvedQuantity: '1' });
  deleteNeedLine.mockReset();
  getOrganizations.mockReset().mockResolvedValue([
    { id: BENE, name: 'Beneficiary Hospital', name_ar: 'مستشفى', code: 'b1', status: 'active', organizationKind: 'care_institution' },
  ]);
  getWarehouses.mockReset().mockResolvedValue([]);
});
afterEach(() => cleanup());

// ============================================================================
// §14 — the head of a cell.
// ============================================================================
describe('C5 §14 — each cell is offered ITS head: the first server row of its exact source record', () => {
  it('uses the first row for the record, and never another record’s override with the same row and header', () => {
    renderPanel({
      records: [
        record('rec-5', ROW_5, 'qty', envelope('12 boxes'), 1),
        // Another SESSION's cell with the identical row and header text.
        record('rec-5-other-session', ROW_5, 'qty', envelope('7 boxes'), 2, 's2'),
      ],
      beneficiaryColumns: [column(1), { ...column(2), importSessionId: 's2' }],
      overrides: [
        // Server order: newest first. The other session's override is the newest row overall.
        override('ovr-other', 'rec-5-other-session', 999),
        override('ovr-head', 'rec-5', 12),
        override('ovr-old', 'rec-5', 10),
      ],
    });
    const [mine, theirs] = screen.getAllByTestId('cn2b-nl-candidate');
    // The override evidence is shown beside a designated contribution.
    for (const candidate of [mine, theirs]) fireEvent.click(within(candidate).getAllByRole('checkbox')[0]);
    expect(within(mine).getByTestId('cn2b-nl-override-evidence')).toHaveAttribute('data-override-id', 'ovr-head');
    expect(within(mine).getByTestId('cn2b-nl-override-evidence')).toHaveTextContent('12');
    expect(within(theirs).getByTestId('cn2b-nl-override-evidence')).toHaveAttribute('data-override-id', 'ovr-other');
  });

  it('pins the head with its exact decimal and sends that id', async () => {
    renderPanel({ overrides: [override('ovr-head', 'rec-5', 12.5, { finalValueText: '12.50' }), override('ovr-old', 'rec-5', 10)] });
    pick(ROW_5);
    expect(contribution(ROW_5).value).toBe(''); // '12 boxes' is text: no automatic suggestion
    fireEvent.click(pinBox(ROW_5)!);
    expect(contribution(ROW_5).value).toBe('12.50');
    fillReasonAndUnit();
    openPreview();
    confirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0].quantitySources).toEqual([
      { sourceRecordId: 'rec-5', designatedQuantity: '12.50', appliedOverrideId: 'ovr-head' },
    ]);
  });

  it('never offers a text override as a numeric one (§15)', () => {
    renderPanel({ overrides: [override('ovr-text', 'rec-5', '12')] });
    pick(ROW_5);
    expect(pinBox(ROW_5)).toBeNull();
    expect(within(candidateFor(ROW_5)).getByTestId('cn2b-nl-override-not-numeric')).toHaveTextContent(T.cn2b_nl_override_not_numeric.en);
  });
});

// ============================================================================
// §14 — stale pins.
// ============================================================================
describe('C5 §14 — a pin that stops being the head is cleared visibly and must be chosen again', () => {
  it('after an override is recorded and the chain reloads, the old pin is cleared with its value, and saving waits', async () => {
    const first = [override('ovr-a', 'rec-5', 12)];
    const { rerenderWith } = renderPanel({ overrides: first });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    expect(contribution(ROW_5).value).toBe('12');
    fillReasonAndUnit();
    expect(saveButton()).toBeEnabled();

    // The chain was re-read: a newer override is now this cell's head.
    rerenderWith({ overrides: [override('ovr-b', 'rec-5', 15), ...first] });

    await waitFor(() => expect(screen.getByTestId('cn2b-nl-stale-pins-cleared')).toBeInTheDocument());
    expect(screen.getByTestId('cn2b-nl-stale-pins-cleared')).toHaveTextContent('1');
    expect(within(candidateFor(ROW_5)).getByTestId('cn2b-nl-stale-pin')).toHaveTextContent(T.cn2b_nl_stale_pin_row.en);
    // Never re-pointed at the new head, and the old value is gone with the pin.
    expect(pinBox(ROW_5)).not.toBeChecked();
    expect(contribution(ROW_5).value).toBe('');
    expect(saveButton()).toBeDisabled();

    // An explicit re-selection of the CURRENT head is what saves.
    fireEvent.click(pinBox(ROW_5)!);
    expect(contribution(ROW_5).value).toBe('15');
    expect(screen.queryByTestId('cn2b-nl-stale-pins-cleared')).toBeNull();
    openPreview();
    confirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0].quantitySources[0]).toEqual({
      sourceRecordId: 'rec-5', designatedQuantity: '15', appliedOverrideId: 'ovr-b',
    });
  });

  it('an open preview carrying a pin that became stale can no longer be confirmed', async () => {
    const first = [override('ovr-a', 'rec-5', 12)];
    const { rerenderWith } = renderPanel({ overrides: first });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    fillReasonAndUnit();
    openPreview();
    rerenderWith({ overrides: [override('ovr-b', 'rec-5', 15), ...first] });
    await waitFor(() => expect(screen.queryByTestId('cn2b-nl-preview')).toBeNull());
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('a stale-binding refusal names its reason, clears that pin at once and reloads the chain', async () => {
    const onChanged = vi.fn();
    setNeedLine.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({
      code: '23514', message: 'need_line_quantity_lineage_unsafe',
      details: 'session=s1 source_record=rec-5 need_line=nl-1 reason=source_quantity_override_binding_invalid',
    }));
    renderPanel({ overrides: [override('ovr-a', 'rec-5', 12)], onChanged });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    fillReasonAndUnit();
    openPreview();
    confirm();
    const alert = await screen.findByTestId('cn2b-nl-error');
    expect(alert).toHaveTextContent(T.cn2b_err_need_line_quantity_lineage_unsafe__source_quantity_override_binding_invalid.en);
    expect(alert.textContent).not.toContain('source_quantity_override_binding_invalid');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(pinBox(ROW_5)).not.toBeChecked();
    expect(contribution(ROW_5).value).toBe('');
    expect(within(candidateFor(ROW_5)).getByTestId('cn2b-nl-stale-pin')).toBeInTheDocument();
    expect(setNeedLine).toHaveBeenCalledTimes(1);
  });

  it('UI-F1 — a stale-binding refusal also re-reads the override chain ON ITS OWN, after the revision reload', async () => {
    const calls: string[] = [];
    const onChanged = vi.fn(() => { calls.push('revision'); });
    const onReloadOverrides = vi.fn(() => { calls.push('overrides'); });
    const onRefused = vi.fn();
    setNeedLine.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({
      code: '23514', message: 'need_line_quantity_lineage_unsafe',
      details: 'session=s1 source_record=rec-5 need_line=nl-1 reason=source_quantity_override_binding_invalid',
    }));
    renderPanel({ overrides: [override('ovr-a', 'rec-5', 12)], onChanged, onReloadOverrides, onRefused });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    fillReasonAndUnit();
    openPreview();
    confirm();
    await screen.findByTestId('cn2b-nl-error');
    expect(onReloadOverrides).toHaveBeenCalledTimes(1);
    // The dedicated chain read is the NEWEST read, so it does not depend on the revision reload succeeding.
    expect(calls).toEqual(['revision', 'overrides']);
    expect(onRefused).toHaveBeenCalledWith(expect.objectContaining({ businessCode: 'need_line_quantity_lineage_unsafe' }));
  });

  it('UI-F1 — other lineage reasons do not re-read the chain', async () => {
    const onReloadOverrides = vi.fn();
    setNeedLine.mockRejectedValueOnce(new CentralNeedsError('need_line_quantity_lineage_unsafe', 'need_line_quantity_lineage_unsafe', {
      sqlstate: '23514', details: 'session=s1 source_record=rec-6 need_line=nl-1 reason=source_quantity_override_mismatch',
    }));
    renderPanel({ onReloadOverrides });
    pick(ROW_6);
    fillReasonAndUnit();
    openPreview();
    confirm();
    await screen.findByTestId('cn2b-nl-error');
    expect(onReloadOverrides).not.toHaveBeenCalled();
  });

  it.each([
    'source_cell_value_contract_invalid',
    'source_quantity_requires_explicit_numeric_override',
    'source_quantity_override_value_invalid',
    'source_quantity_override_mismatch',
  ])('reason %s is explained by its own sentence and needs no reload', async (reason) => {
    const onChanged = vi.fn();
    setNeedLine.mockRejectedValueOnce(new CentralNeedsError('need_line_quantity_lineage_unsafe', 'need_line_quantity_lineage_unsafe', {
      sqlstate: '23514', details: `session=s1 source_record=rec-6 need_line=nl-1 reason=${reason}`,
    }));
    renderPanel({ onChanged });
    pick(ROW_6);
    fillReasonAndUnit();
    openPreview();
    confirm();
    expect(await screen.findByTestId('cn2b-nl-error'))
      .toHaveTextContent(T[`cn2b_err_need_line_quantity_lineage_unsafe__${reason}`].en);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('a retryable contention says "try again", reloads nothing and is never retried', async () => {
    const onChanged = vi.fn();
    setNeedLine.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({ code: '40P01', message: 'deadlock detected' }));
    renderPanel({ onChanged });
    pick(ROW_6);
    fillReasonAndUnit();
    openPreview();
    confirm();
    expect(await screen.findByTestId('cn2b-nl-error')).toHaveTextContent(T.cn2b_err_retryable_contention.en);
    expect(setNeedLine).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('the refused designated quantity lexeme is explained, not retried', async () => {
    setNeedLine.mockRejectedValueOnce(new CentralNeedsError('designated_quantity_not_canonical', 'designated_quantity_not_canonical', {
      sqlstate: '23514', details: 'source_record=rec-6',
    }));
    renderPanel();
    pick(ROW_6);
    fillReasonAndUnit();
    openPreview();
    confirm();
    expect(await screen.findByTestId('cn2b-nl-error')).toHaveTextContent(T.cn2b_err_designated_quantity_not_canonical.en);
    expect(setNeedLine).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// §14 — the preview shows every carried pin.
// ============================================================================
describe('C5 §14 — the preview lists every pin the write carries, filtered-out cells included', () => {
  it('shows the hidden cell’s pin, its value and its reason before anything is written', async () => {
    renderPanel({
      records: [
        record('rec-5', ROW_5, 'qty', envelope('12 boxes'), 1),
        record('rec-6', ROW_6, 'qty', envelope(40), 2),
      ],
      overrides: [override('ovr-5', 'rec-5', 12)],
    });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    pick(ROW_6);
    // Hide the pinned cell behind a search.
    fireEvent.change(screen.getByRole('searchbox', { name: T.cn2b_nl_filter_search.en }), { target: { value: 'row:6' } });
    expect(screen.queryByText(new RegExp(`^${esc(ROW_5)} · qty$`))).toBeNull();
    fillReasonAndUnit();
    openPreview();
    const pins = screen.getAllByTestId('cn2b-nl-preview-pin');
    expect(pins).toHaveLength(1);
    expect(pins[0]).toHaveAttribute('data-source-record', 'rec-5');
    expect(pins[0]).toHaveAttribute('data-override-id', 'ovr-5');
    expect(pins[0]).toHaveTextContent(`${ROW_5} · qty = 12`);
    expect(pins[0]).toHaveTextContent('reason for ovr-5');
    expect(setNeedLine).not.toHaveBeenCalled();
    confirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    const sent = setNeedLine.mock.calls[0][0].quantitySources.filter((s: { appliedOverrideId: string | null }) => s.appliedOverrideId);
    expect(sent).toEqual([{ sourceRecordId: 'rec-5', designatedQuantity: '12', appliedOverrideId: 'ovr-5' }]);
  });

  it('shows no pin list when the write carries none', () => {
    renderPanel();
    pick(ROW_6);
    fillReasonAndUnit();
    openPreview();
    expect(screen.queryByTestId('cn2b-nl-preview-pins')).toBeNull();
  });
});

// ============================================================================
// §13 — an unavailable chain withholds every save.
// ============================================================================
describe('C5 §13 — while the override chain is unavailable, nothing is saved and everything stays visible', () => {
  it('says why, blocks the save, and keeps the evidence and the register readable', () => {
    renderPanel({ overrideReadFailure: 'field_overrides_read_inconsistent' });
    expect(screen.getByTestId('cn2b-nl-overrides-unavailable')).toHaveTextContent(T.cn2b_nl_overrides_unavailable.en);
    expect(screen.getByTestId('cn2b-nl-overrides-unavailable')).toHaveTextContent(T.cn2b_err_field_overrides_read_inconsistent.en);
    pick(ROW_6);
    fillReasonAndUnit();
    expect(saveButton()).toBeDisabled();
    expect(blockers()).toContain('cn2b_nl_block_overrides_unavailable');
    expect(screen.getAllByTestId('cn2b-nl-candidate')).toHaveLength(2);
    expect(screen.getByTestId('cn2b-nl-list')).toBeInTheDocument();
    fireEvent.click(saveButton());
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('a pin held while the chain reloads is named, not silently carried, and is kept when it is still the head', async () => {
    const chain = [override('ovr-a', 'rec-5', 12)];
    const { rerenderWith } = renderPanel({ overrides: chain });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    rerenderWith({ overrides: [], overrideReadFailure: 'field_overrides_not_loaded' });
    expect(within(candidateFor(ROW_5)).getByTestId('cn2b-nl-pin-unverified')).toBeInTheDocument();
    fillReasonAndUnit();
    expect(saveButton()).toBeDisabled();
    rerenderWith({ overrides: chain, overrideReadFailure: null });
    await waitFor(() => expect(pinBox(ROW_5)).toBeChecked());
    expect(screen.queryByTestId('cn2b-nl-stale-pins-cleared')).toBeNull();
    expect(saveButton()).toBeEnabled();
  });
});

// ============================================================================
// §15 — suggestions and typed grammar.
// ============================================================================
describe('C5 §15 — suggestions only from subset A/B; typed quantities in the exact server grammar', () => {
  it.each([
    [envelope(120.5), '120.5'],
    [envelope('25', 'string'), '25'],
    [envelope('25.5', 'string'), ''],
    [envelope('007', 'string'), ''],
    [envelope(-5), ''],
    [{ value: 40 }, ''], // no valueType: not the parser envelope
  ])('designating %j suggests %j', (sourceValues, expected) => {
    renderPanel({ records: [record('rec-6', ROW_6, 'qty', sourceValues, 2)] });
    pick(ROW_6);
    expect(contribution(ROW_6).value).toBe(expected);
    if (expected === '') {
      expect(within(candidateFor(ROW_6)).getByTestId('cn2b-nl-source-value')).toHaveTextContent(T.cn2b_nl_source_value_not_decimal.en);
    }
  });

  it.each(['007', ' 25', '25 ', '1e3', '-5', '.5', '5.', '1'.repeat(257)])('refuses the typed quantity %j', (typed) => {
    renderPanel();
    pick(ROW_6);
    fillReasonAndUnit();
    fireEvent.change(contribution(ROW_6), { target: { value: typed } });
    expect(saveButton()).toBeDisabled();
    expect(within(candidateFor(ROW_6)).getByText(T.cn2b_nl_contribution_invalid.en)).toBeInTheDocument();
    expect(blockers()).toContain('cn2b_nl_block_quantity');
  });

  it('sends an accepted lexeme exactly as typed, never trimmed or normalized', async () => {
    renderPanel();
    pick(ROW_6);
    fillReasonAndUnit();
    fireEvent.change(contribution(ROW_6), { target: { value: '25.50' } });
    openPreview();
    confirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0].quantitySources[0].designatedQuantity).toBe('25.50');
    expect(setNeedLine.mock.calls[0][0].approvedQuantity).toBe('25.50');
  });
});

// ============================================================================
// §14 (UI-F2) — a refusal part-way through a multi-scope confirmation.
// ============================================================================
describe('C5 §14 — a refusal never implies that nothing was saved when earlier scopes committed', () => {
  const BENE_2 = '00000000-0000-0000-0000-0000000000b2';
  const twoScopes = () => {
    getOrganizations.mockResolvedValue([
      { id: BENE, name: 'Beneficiary Hospital', name_ar: 'مستشفى', code: 'b1', status: 'active', organizationKind: 'care_institution' },
      { id: BENE_2, name: 'Second Hospital', name_ar: 'مستشفى ثان', code: 'b2', status: 'active', organizationKind: 'care_institution' },
    ]);
    return { beneficiaryColumns: [column(1), { ...column(2), beneficiaryOrganizationId: BENE_2, mappingId: 'bc-2b' }] };
  };
  const confirmBoth = () => {
    pick(ROW_5);
    fireEvent.change(contribution(ROW_5), { target: { value: '12' } });
    pick(ROW_6);
    fillReasonAndUnit();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_preview.en }));
    expect(screen.getByTestId('cn2b-nl-lines')).toHaveTextContent('2');
    confirm();
  };

  it('says how many scopes were saved before the refusal, reloads, and keeps the refusal’s own reason', async () => {
    const onChanged = vi.fn();
    setNeedLine
      .mockResolvedValueOnce({ needLineId: 'nl-1', created: true, sourceLinkCount: 1, addedLinkCount: 1, approvedQuantity: '12' })
      .mockRejectedValueOnce(new CentralNeedsError('need_line_quantity_lineage_unsafe', 'need_line_quantity_lineage_unsafe', {
        sqlstate: '23514', details: 'session=s1 source_record=rec-6 need_line=nl-2 reason=source_quantity_requires_explicit_numeric_override',
      }));
    renderPanel({ ...twoScopes(), onChanged });
    confirmBoth();
    const alert = await screen.findByTestId('cn2b-nl-error');
    expect(setNeedLine).toHaveBeenCalledTimes(2);
    expect(alert).toHaveTextContent(T.cn2b_err_need_line_quantity_lineage_unsafe__source_quantity_requires_explicit_numeric_override.en);
    const partial = within(alert).getByTestId('cn2b-nl-partial-saved');
    expect(partial).toHaveAttribute('data-saved', '1');
    expect(partial).toHaveAttribute('data-total', '2');
    expect(partial).toHaveTextContent(T.cn2b_nl_partial_saved.en.replace('__K__', '1').replace('__N__', '2'));
    expect(alert.textContent).not.toMatch(/nothing was saved/i);
    // The committed scope is re-read; nothing is retried.
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('a contention on the FIRST scope reports no partial save', async () => {
    setNeedLine.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({ code: '40P01', message: 'deadlock detected' }));
    renderPanel(twoScopes());
    confirmBoth();
    const alert = await screen.findByTestId('cn2b-nl-error');
    expect(alert).toHaveTextContent(T.cn2b_err_retryable_contention.en);
    expect(within(alert).queryByTestId('cn2b-nl-partial-saved')).toBeNull();
    expect(setNeedLine).toHaveBeenCalledTimes(1);
  });

  it('an unknown outcome (transport failure) is not titled a refusal, and is reported to the screen', async () => {
    const onRefused = vi.fn();
    setNeedLine.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({ message: 'TypeError: Failed to fetch' }));
    renderPanel({ onRefused });
    pick(ROW_6);
    fillReasonAndUnit();
    openPreview();
    confirm();
    const alert = await screen.findByTestId('cn2b-nl-error');
    expect(alert).toHaveTextContent(T.cn2b_nl_error_title_unconfirmed.en);
    expect(alert).not.toHaveTextContent(T.cn2b_nl_error_title.en);
    expect(alert).toHaveTextContent(T.cn2b_err_central_needs_request_failed.en);
    expect(onRefused).toHaveBeenCalledWith(expect.objectContaining({ businessCode: 'central_needs_request_failed', sqlstate: null }));
  });

  it('UI-F3 — an edit refused because the revision is no longer editable is reported to the screen', async () => {
    const onRefused = vi.fn();
    setNeedLine.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({
      code: '23514', message: 'plan_revision_not_editable', details: 'revision=rev-1 status=submitted',
    }));
    renderPanel({ onRefused });
    pick(ROW_6);
    fillReasonAndUnit();
    openPreview();
    confirm();
    await screen.findByTestId('cn2b-nl-error');
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(onRefused.mock.calls[0][0]).toMatchObject({ businessCode: 'plan_revision_not_editable' });
    expect(setNeedLine).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// §13 (UI-F5) — the chain can be re-read on its own while it is unavailable.
// ============================================================================
describe('C5 §13 — an unavailable chain offers a control that re-reads only the overrides', () => {
  it('shows "reload the overrides" beside the banner and calls only that', () => {
    const onReloadOverrides = vi.fn();
    const onChanged = vi.fn();
    renderPanel({ overrideReadFailure: 'field_overrides_read_inconsistent', onReloadOverrides, onChanged });
    const reload = screen.getByTestId('cn2b-nl-overrides-reload');
    expect(reload).toHaveTextContent(T.cn2b_overrides_reload.en);
    fireEvent.click(reload);
    expect(onReloadOverrides).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('offers no reload control while the chain is readable', () => {
    renderPanel({ onReloadOverrides: vi.fn() });
    expect(screen.queryByTestId('cn2b-nl-overrides-reload')).toBeNull();
  });
});
