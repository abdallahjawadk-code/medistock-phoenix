/** @vitest-environment jsdom */
/**
 * PRE3-A — the Advanced review table on the shared resolver.
 *
 * Before PRE3 the per-row "Map" action sent the TYPED search text as the
 * central item id (a datalist offered ids, but anything typed was accepted).
 * Now typed text is only a search term: the reviewer selects one registered
 * result, and the row's own Map action sends that selected item's id. A search
 * that finds nothing, or fails, leaves nothing to map.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type { CentralItemOption, SourceRecord } from '../central-needs.service';

const setRecordDisposition = vi.fn();
const searchCentralItems = vi.fn();

vi.mock('@/app/AppContext', () => ({ useApp: () => ({ lang: 'en' }) }));
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  return {
    ...actual,
    recordFieldOverride: vi.fn(),
    setRecordDisposition: (...a: unknown[]) => setRecordDisposition(...a),
    searchCentralItems: (...a: unknown[]) => searchCentralItems(...a),
  };
});

const { CentralNeedsDispositionTable } = await import('../CentralNeedsDispositionTable');
const { CentralNeedsError } = await import('../central-needs.service');

const ROW = 'sheet:0:row:5';
const RECORD: SourceRecord = {
  id: 'rec-item', importSessionId: 's1', recordOrdinal: 1, targetEntity: ROW, fieldName: 'Material',
  sourceValues: { value: 'Panadol 500', valueType: 'string', isFormula: false, formula: null },
  sourceProvenance: { sheetIndex: 0, sheetName: 'Needs', coordinate: { a1: 'B6' } },
};
const PARA: CentralItemOption = {
  id: 'ci-para', name: 'Paracetamol', unit: 'tablet', nameAr: 'باراسيتامول', tradeName: 'Panadol',
  concentration: '500 mg', dosageForm: 'Tablet', nationalCode: '6291000000028',
};
const PARA_SYRUP: CentralItemOption = { id: 'ci-para-syr', name: 'Paracetamol', unit: 'bottle', tradeName: 'Panadol Baby', concentration: '120 mg/5 ml', dosageForm: 'Syrup' };

const onChanged = vi.fn();
function renderTable() {
  return render(
    <CentralNeedsDispositionTable
      importSessionId="s1" records={[RECORD]} dispositions={[]} overrides={[]} overrideReadFailure={null}
      organizationId="org-1" canEdit onChanged={onChanged} onOverridesChanged={vi.fn()}
    />,
  );
}

const search = (value: string) => fireEvent.change(screen.getByLabelText(T.cn2b_item_search.en), { target: { value } });
const mapButton = () => screen.getByRole('button', { name: T.cn2b_decide_map.en });
const results = () => screen.queryByRole('list', { name: T.cn2b_material_search_results.en });
const searchState = () => document.querySelector('.cn2b-lookup .cn2b-searchstate') as HTMLElement | null;

beforeEach(() => {
  setRecordDisposition.mockReset();
  searchCentralItems.mockReset();
  onChanged.mockReset();
});
afterEach(() => cleanup());

describe('PRE3-A — Advanced mapping takes a SELECTED registered item, never typed text', () => {
  it('typed text alone can never be mapped: Map stays disabled until a result is selected', async () => {
    searchCentralItems.mockResolvedValue([PARA, PARA_SYRUP]);
    renderTable();
    expect(document.querySelector('datalist')).toBeNull();
    search('ci-para');
    await waitFor(() => expect(results()).not.toBeNull());
    expect(mapButton()).toBeDisabled();
    fireEvent.click(mapButton());
    expect(setRecordDisposition).not.toHaveBeenCalled();
    expect(screen.getByTestId('cn2b-item-selected')).toHaveTextContent(T.cn2b_item_none_selected.en);
  });

  it('selecting a result writes nothing; the row\'s Map sends exactly that item\'s id', async () => {
    searchCentralItems.mockResolvedValue([PARA, PARA_SYRUP]);
    setRecordDisposition.mockResolvedValue(undefined);
    renderTable();
    search('panadol');
    const list = await screen.findByRole('list', { name: T.cn2b_material_search_results.en });
    // Discriminators tell the two Paracetamols apart.
    const syrup = within(list).getByRole('button', { name: /Panadol Baby/ });
    expect(syrup).toHaveTextContent('120 mg/5 ml');
    expect(syrup).toHaveTextContent('Syrup');
    fireEvent.click(syrup);
    expect(setRecordDisposition).not.toHaveBeenCalled();
    expect(syrup).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('cn2b-item-selected')).toHaveTextContent('Paracetamol (bottle)');

    fireEvent.click(mapButton());
    await waitFor(() => expect(setRecordDisposition).toHaveBeenCalledTimes(1));
    expect(setRecordDisposition).toHaveBeenCalledWith({
      importSessionId: 's1', targetEntity: ROW, decision: 'mapped', centralItemId: 'ci-para-syr', decisionReason: undefined,
    });
  });

  it('a new search clears the selection, so a stale choice is never mapped', async () => {
    searchCentralItems.mockResolvedValue([PARA]);
    renderTable();
    search('panadol');
    const list = await screen.findByRole('list', { name: T.cn2b_material_search_results.en });
    fireEvent.click(within(list).getByRole('button', { name: /Paracetamol/ }));
    expect(mapButton()).toBeEnabled();
    search('panadol b');
    expect(mapButton()).toBeDisabled();
  });

  it('6 · no registered match: an honest "not registered" state, and nothing to map', async () => {
    searchCentralItems.mockResolvedValue([]);
    renderTable();
    search('zzyzx');
    await waitFor(() => expect(searchState()?.dataset.phase).toBe('done'));
    expect(searchState()).toHaveTextContent(T.cn2b_material_not_registered.en);
    expect(screen.getByText(T.cn2b_material_not_registered_note.en)).toBeInTheDocument();
    expect(mapButton()).toBeDisabled();
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('a failed search is reported as a failure, never as "not registered"', async () => {
    searchCentralItems.mockRejectedValue(new CentralNeedsError('central_needs_request_failed'));
    renderTable();
    search('panadol');
    await waitFor(() => expect(searchState()?.dataset.phase).toBe('failed'));
    expect(searchState()).toHaveTextContent(T.cn2b_material_search_failed.en);
    expect(screen.queryByText(T.cn2b_material_not_registered.en)).toBeNull();
    expect(mapButton()).toBeDisabled();
  });

  it('keeps the newest search: a slower earlier reply never replaces a later one', async () => {
    const replies: Record<string, (rows: CentralItemOption[]) => void> = {};
    searchCentralItems.mockImplementation((q: string) => new Promise((resolve) => { replies[q] = resolve; }));
    renderTable();
    search('pa');
    search('panadol baby');
    replies['panadol baby']([PARA_SYRUP]);
    await waitFor(() => expect(results()).not.toBeNull());
    replies.pa([PARA]);
    await new Promise((r) => setTimeout(r, 20));
    expect(within(results() as HTMLElement).getAllByRole('button')).toHaveLength(1);
    expect(within(results() as HTMLElement).getByRole('button')).toHaveTextContent('Panadol Baby');
  });

  it('M220 · a mapping the server refuses central_item_not_active is reported in words, not swallowed', async () => {
    searchCentralItems.mockResolvedValue([PARA]);
    setRecordDisposition.mockRejectedValue(new CentralNeedsError('central_item_not_active', 'central_item_not_active', {
      sqlstate: '23514', details: 'central_item=ci-para status=inactive reason=inactive',
    }));
    renderTable();
    search('panadol');
    const list = await screen.findByRole('list', { name: T.cn2b_material_search_results.en });
    fireEvent.click(within(list).getByRole('button', { name: /Paracetamol/ }));
    fireEvent.click(mapButton());
    expect(await screen.findByText(T.cn2b_err_central_item_not_active.en)).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('7 · "not applicable" is still its own decision, with a reason and no item', async () => {
    setRecordDisposition.mockResolvedValue(undefined);
    renderTable();
    const na = screen.getByRole('button', { name: T.cn2b_decide_na.en });
    expect(na).toBeDisabled();
    fireEvent.change(screen.getByLabelText(T.cn2b_bulk_reason.en), { target: { value: 'Subtotal line' } });
    fireEvent.click(na);
    await waitFor(() => expect(setRecordDisposition).toHaveBeenCalledTimes(1));
    expect(setRecordDisposition).toHaveBeenCalledWith({
      importSessionId: 's1', targetEntity: ROW, decision: 'not_applicable', centralItemId: undefined, decisionReason: 'Subtotal line',
    });
  });
});
