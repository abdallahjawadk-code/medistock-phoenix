/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type { FieldOverride, SourceRecord } from '../central-needs.service';

/**
 * C5 (M217 companion) — the review table's override surface.
 *
 *   §14  the effective value is each record's HEAD: the first row of its exact
 *        `sourceRecordId` in server order (the last row of an ascending list
 *        was the pre-C5 rule, and is now wrong);
 *   §15  a NUMERIC override is typed in the exact server grammar, and the JSON
 *        number that will actually be stored is shown for an explicit second
 *        confirmation before the RPC; a text override is never numeric;
 *   §14  after an override is recorded the chain is re-read at once, and the
 *        new override is never pinned for anyone;
 *   §13  with the chain unavailable, no effective value is claimed and no
 *        override can be recorded — and the chain can be re-read on its own
 *        (UI-F5);
 *   UI-F8 an exact value JSON.stringify prints in exponent form is exact;
 *   UI-F3 every refusal reaches the screen; UI-F2 a bulk decision refused
 *        part-way says how many were saved.
 */

const recordFieldOverride = vi.fn();
const setRecordDisposition = vi.fn();

vi.mock('@/app/AppContext', () => ({ useApp: () => ({ lang: 'en' }) }));
vi.mock('@/shared/supabase/client', () => ({
  supabase: { rpc: () => { throw new Error('writes go through the service'); }, from: () => { throw new Error('no direct reads'); } },
}));
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  return {
    ...actual,
    recordFieldOverride: (...a: unknown[]) => recordFieldOverride(...a),
    setRecordDisposition: (...a: unknown[]) => setRecordDisposition(...a),
    searchCentralItems: vi.fn(async () => []),
  };
});

const { CentralNeedsDispositionTable } = await import('../CentralNeedsDispositionTable');
const { centralNeedsErrorFromPostgrest } = await import('../central-needs.service');

const ROW = 'sheet:0:row:5';
const RECORD: SourceRecord = {
  id: 'rec-qty', importSessionId: 's1', recordOrdinal: 1, targetEntity: ROW, fieldName: 'Quantity',
  sourceValues: { value: '12 boxes', valueType: 'string', isFormula: false, formula: null },
  sourceProvenance: { sheetIndex: 0, sheetName: 'Needs', coordinate: { a1: 'C6' } },
};
const override = (id: string, finalValue: unknown, sourceRecordId = 'rec-qty'): FieldOverride => ({
  id, sourceRecordId, targetEntity: ROW, fieldName: 'Quantity', previousValue: '12 boxes', finalValue,
  finalValueText: typeof finalValue === 'number' ? String(finalValue) : JSON.stringify(finalValue),
  overrideReason: `why ${id}`, overrideNote: null, createdAt: '2026-09-26T10:00:00+00:00',
});

type TableProps = Parameters<typeof CentralNeedsDispositionTable>[0];
const onChanged = vi.fn();
const onOverridesChanged = vi.fn();

function renderTable(over: Partial<TableProps> = {}) {
  const props: TableProps = {
    importSessionId: 's1', records: [RECORD], dispositions: [], overrides: [], overrideReadFailure: null,
    organizationId: 'org-1', canEdit: true, onChanged, onOverridesChanged, ...over,
  };
  return render(<CentralNeedsDispositionTable {...props} />);
}

const openEditor = () => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^(${T.cn2b_override.en}|${T.cn2b_override_replace.en})$`) }));
const editor = () => screen.getByRole('group', { name: T.cn2b_override.en });
const chooseNumber = () => fireEvent.change(within(editor()).getByLabelText(T.cn2b_override_kind.en), { target: { value: 'number' } });
const typeValue = (v: string) => fireEvent.change(within(editor()).getByLabelText(T.cn2b_override_value.en), { target: { value: v } });
const typeReason = (v = 'signed recount') => fireEvent.change(within(editor()).getByLabelText(T.cn2b_override_reason.en), { target: { value: v } });
const button = (key: string) => within(editor()).queryByRole('button', { name: T[key].en });

beforeEach(() => {
  recordFieldOverride.mockReset().mockResolvedValue({ overrideId: 'ovr-new' });
  setRecordDisposition.mockReset();
  onChanged.mockReset();
  onOverridesChanged.mockReset();
});
afterEach(() => cleanup());

describe('C5 §14 — the effective value is the head: the FIRST server row of the exact record', () => {
  it('shows the newest (first) override, not the last row of the list', () => {
    renderTable({ overrides: [override('ovr-new', 15), override('ovr-old', 12), override('ovr-elsewhere', 99, 'rec-other')] });
    const cell = document.querySelector('.cn2b-effective__value');
    expect(cell).toHaveTextContent('15');
    expect(screen.getByText('why ovr-new')).toBeInTheDocument();
    expect(screen.queryByText('why ovr-old')).toBeNull();
  });
});

describe('C5 §15 — a numeric override: exact grammar, a preview of the stored JSON number, then an explicit confirmation', () => {
  it.each(['007', ' 25', '25 ', '1e3', '-5', '.5', '5.', '0x10', '1'.repeat(257)])('refuses %j and sends nothing', async (raw) => {
    renderTable();
    openEditor();
    chooseNumber();
    typeValue(raw);
    typeReason();
    fireEvent.click(button('cn2b_override_number_preview')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(T.cn2b_err_override_number_not_canonical.en);
    expect(screen.queryByTestId('cn2b-override-number-preview')).toBeNull();
    expect(button('cn2b_override_number_confirm')).toBeNull();
    expect(recordFieldOverride).not.toHaveBeenCalled();
  });

  it('previews JSON.stringify(Number(raw)), writes nothing until confirmed, then records exactly that number', async () => {
    renderTable({ overrides: [override('ovr-a', 12)] });
    openEditor();
    chooseNumber();
    typeValue('12.50');
    typeReason();
    // The first step only shows what would be stored.
    expect(button('cn2b_override_save')).toBeNull();
    fireEvent.click(button('cn2b_override_number_preview')!);
    const preview = screen.getByTestId('cn2b-override-number-preview');
    expect(within(preview).getByTestId('cn2b-override-number-json')).toHaveTextContent('12.5');
    expect(preview).toHaveAttribute('data-exact', 'true');
    expect(recordFieldOverride).not.toHaveBeenCalled();

    fireEvent.click(button('cn2b_override_number_confirm')!);
    await waitFor(() => expect(recordFieldOverride).toHaveBeenCalledTimes(1));
    expect(recordFieldOverride).toHaveBeenCalledWith({
      sourceRecordId: 'rec-qty', finalValue: 12.5, overrideReason: 'signed recount', overrideNote: null,
    });
    // §14: the chain is re-read immediately; nothing is pinned for anyone.
    expect(onOverridesChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('shows the rounding of a value JavaScript cannot hold before it is confirmed', () => {
    renderTable();
    openEditor();
    chooseNumber();
    typeValue('12345678901234567.891');
    typeReason();
    fireEvent.click(button('cn2b_override_number_preview')!);
    expect(screen.getByTestId('cn2b-override-number-json')).toHaveTextContent('12345678901234568');
    expect(screen.getByTestId('cn2b-override-number-not-exact')).toHaveTextContent(T.cn2b_override_number_not_exact.en);
    expect(recordFieldOverride).not.toHaveBeenCalled();
  });

  it('editing the number after the preview withdraws the confirmation', () => {
    renderTable();
    openEditor();
    chooseNumber();
    typeValue('10');
    typeReason();
    fireEvent.click(button('cn2b_override_number_preview')!);
    expect(button('cn2b_override_number_confirm')).not.toBeNull();
    typeValue('11');
    expect(screen.queryByTestId('cn2b-override-number-preview')).toBeNull();
    expect(button('cn2b_override_number_confirm')).toBeNull();
    expect(button('cn2b_override_number_preview')).not.toBeNull();
    expect(recordFieldOverride).not.toHaveBeenCalled();
  });

  it('a text override needs no numeric preview, and says it never counts as a numeric quantity override', async () => {
    renderTable();
    openEditor();
    expect(within(editor()).getByTestId('cn2b-override-text-not-numeric')).toHaveTextContent(T.cn2b_override_text_not_numeric.en);
    typeValue('twelve');
    typeReason();
    fireEvent.click(button('cn2b_override_save')!);
    await waitFor(() => expect(recordFieldOverride).toHaveBeenCalledTimes(1));
    expect(recordFieldOverride.mock.calls[0][0]).toMatchObject({ finalValue: 'twelve' });
  });

  it('a refused override is shown by its code, and a contention by "try again" — never retried', async () => {
    recordFieldOverride.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({ code: '55P03', message: 'canceling statement due to lock timeout' }));
    renderTable();
    openEditor();
    typeValue('twelve');
    typeReason();
    fireEvent.click(button('cn2b_override_save')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(T.cn2b_err_retryable_contention.en);
    expect(recordFieldOverride).toHaveBeenCalledTimes(1);
    expect(onOverridesChanged).not.toHaveBeenCalled();
  });
});

describe('C5 §13 — an unavailable chain claims no effective value and records no override', () => {
  it('shows "unknown", disables the override action and says why', () => {
    renderTable({ overrides: [], overrideReadFailure: 'field_overrides_read_inconsistent' });
    expect(screen.getByTestId('cn2b-overrides-unavailable')).toHaveTextContent(T.cn2b_override_read_unavailable.en);
    expect(screen.queryByText(T.cn2b_effective_same.en)).toBeNull();
    expect(screen.getByText(T.cn2b_effective_unknown.en)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: T.cn2b_override.en })).toBeDisabled();
    // The rest of the review table stays usable to read.
    expect(screen.getByText('12 boxes')).toBeInTheDocument();
  });
});

describe('C5 §15 (UI-F8) — an exact value JSON.stringify prints in exponent form is not flagged "not exact"', () => {
  it.each([['0.0000001', '1e-7'], ['1000000000000000000000', '1e+21']])('%j previews %s as exact', (raw, json) => {
    renderTable();
    openEditor();
    chooseNumber();
    typeValue(raw);
    typeReason();
    fireEvent.click(button('cn2b_override_number_preview')!);
    const preview = screen.getByTestId('cn2b-override-number-preview');
    expect(within(preview).getByTestId('cn2b-override-number-json')).toHaveTextContent(json);
    expect(preview).toHaveAttribute('data-exact', 'true');
    expect(screen.queryByTestId('cn2b-override-number-not-exact')).toBeNull();
    expect(recordFieldOverride).not.toHaveBeenCalled();
  });
});

describe('C5 §13 (UI-F5) — an unavailable chain can be re-read on its own from the review table', () => {
  it('the "reload the overrides" control re-reads only the chain, and is offered even read-only', () => {
    renderTable({ overrides: [], overrideReadFailure: 'field_overrides_read_inconsistent', canEdit: false });
    const reload = screen.getByTestId('cn2b-overrides-reload');
    expect(reload).toHaveTextContent(T.cn2b_overrides_reload.en);
    fireEvent.click(reload);
    expect(onOverridesChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
    expect(recordFieldOverride).not.toHaveBeenCalled();
  });

  it('is not offered while the chain is readable', () => {
    renderTable();
    expect(screen.queryByTestId('cn2b-overrides-reload')).toBeNull();
  });
});

describe('C5 §17 (UI-F3) — every refusal from the table reaches the screen', () => {
  it('an override refused because the revision is no longer editable is reported, not retried', async () => {
    const onRefused = vi.fn();
    recordFieldOverride.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({
      code: '23514', message: 'plan_revision_not_editable', details: 'revision=rev-1 status=submitted',
    }));
    renderTable({ onRefused });
    openEditor();
    typeValue('twelve');
    typeReason();
    fireEvent.click(button('cn2b_override_save')!);
    await waitFor(() => expect(onRefused).toHaveBeenCalledTimes(1));
    expect(onRefused.mock.calls[0][0]).toMatchObject({ businessCode: 'plan_revision_not_editable' });
    expect(recordFieldOverride).toHaveBeenCalledTimes(1);
    expect(onOverridesChanged).not.toHaveBeenCalled();
  });
});

describe('C5 §14 (UI-F2) — a bulk decision refused part-way says how many were saved', () => {
  const RECORD_B: SourceRecord = { ...RECORD, id: 'rec-b', targetEntity: 'sheet:0:row:6', recordOrdinal: 2 };
  it('reports k of n, re-reads, and keeps only the unsaved entities selected', async () => {
    setRecordDisposition
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(centralNeedsErrorFromPostgrest({ code: '55P03', message: 'canceling statement due to lock timeout' }));
    renderTable({ records: [RECORD, RECORD_B] });
    fireEvent.click(screen.getByLabelText(ROW, { selector: 'input' }));
    fireEvent.click(screen.getByLabelText('sheet:0:row:6', { selector: 'input' }));
    fireEvent.change(screen.getByLabelText(T.cn2b_bulk_reason.en), { target: { value: 'subtotal rows' } });
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_bulk_preview.en }));
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_bulk_confirm.en }));
    const partial = await screen.findByTestId('cn2b-bulk-partial-saved');
    expect(partial).toHaveAttribute('data-saved', '1');
    expect(partial).toHaveAttribute('data-total', '2');
    expect(partial).toHaveTextContent(T.cn2b_bulk_partial_saved.en.replace('__K__', '1').replace('__N__', '2'));
    expect(screen.getByRole('alert')).toHaveTextContent(T.cn2b_err_retryable_contention.en);
    expect(setRecordDisposition).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // The saved entity left the selection; only the refused one is still selected.
    expect(document.querySelector('[data-count="selected"]')).toHaveTextContent('1');
    expect(screen.getByLabelText(ROW, { selector: 'input' })).not.toBeChecked();
    expect(screen.getByLabelText('sheet:0:row:6', { selector: 'input' })).toBeChecked();
  });
});
