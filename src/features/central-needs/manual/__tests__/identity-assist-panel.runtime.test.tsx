/** @vitest-environment jsdom */
/**
 * R1-A3/A4 — the identity-assist panel (REAL component, REAL A3 entry point).
 *
 * Director final A4 correction: BEFORE the header row is confirmed the panel renders ROW NUMBERS ONLY - it accesses no property of any
 * worksheet cell (a spy getter on every cell property records any access). AFTER confirmation only the confirmed header row and the
 * identity columns of the data rows are touched, through the single A3 entry point. No regex / masking is relied on as proof: the proof
 * is the access log. Quantity cells of every kind are in the fixture: numeric, text that is a number, and ambiguous text.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ResolverHit } from '../../excel-identity';

vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
const { IdentityAssistPanel } = await import('../IdentityAssistPanel');

type Log = string[];
/** Every data property of the cell is a spy getter; `coordinate` is plain data (a position, not a value). */
function spyCell(row: number, col: number, spec: { type: string; value: string | number | null; formatted?: string }, log: Log) {
  const c: Record<string, unknown> = { coordinate: { row, col, a1: `${row}:${col}` } };
  const prop = (name: string, v: unknown) => Object.defineProperty(c, name, { get() { log.push(`${row}:${col}:${name}`); return v; }, enumerable: true });
  prop('presence', 'value'); prop('valueType', spec.type); prop('rawValue', spec.value); prop('formattedText', spec.formatted); prop('formula', undefined);
  return c;
}
const text = (r: number, c: number, v: string, log: Log) => spyCell(r, c, { type: 'string', value: v }, log);
const num = (r: number, c: number, v: number, log: Log) => spyCell(r, c, { type: 'number', value: v, formatted: String(v) }, log);

const QTY = { numeric: [987001, 987002], textNumber: ['4500', '12 boxes'], ambiguous: ['N/A', 'Total 7'] };
function workbook(log: Log, sheetExtra: Record<string, unknown> = {}) {
  const cells = [
    text(0, 0, 'Medicine name', log), text(0, 1, 'Strength', log), text(0, 2, 'Dosage form', log), text(0, 3, 'Annual quantity', log), text(0, 4, 'Qty text', log), text(0, 5, 'Remarks', log),
    text(1, 0, 'Aspirin', log), text(1, 1, '100 mg', log), text(1, 2, 'Tablet', log), num(1, 3, QTY.numeric[0], log), text(1, 4, QTY.textNumber[0], log), text(1, 5, QTY.ambiguous[0], log),
    text(2, 0, 'Zolpidem', log), text(2, 1, '10 mg', log), text(2, 2, 'Tablet', log), num(2, 3, QTY.numeric[1], log), text(2, 4, QTY.textNumber[1], log), text(2, 5, QTY.ambiguous[1], log),
  ];
  const sheet = { index: 0, name: 'Plan', hidden: 'visible', usedRange: { startRow: 0, startCol: 0, endRow: 2, endCol: 5 }, nonEmptyCellCount: 18, mergedRanges: [], duplicateHeaderGroups: [], cells, ...sheetExtra };
  return { outcome: 'ok', input: { originalFilename: 'needs.xlsx', sha256: 'c'.repeat(64), byteSize: 10 }, workbook: { format: 'xlsx', sheets: [sheet], vbaPresent: false } };
}
const SENTINELS = [...QTY.numeric.map(String), ...QTY.textNumber, ...QTY.ambiguous];
const handle = (state: unknown) => ({ state: state as never, parse: vi.fn(), reset: vi.fn() });
const ready = (result: unknown, kind = 'file') => ({ phase: 'ready', filename: 'needs.xlsx', outcome: { kind, result, json: '' } });
const hit = (o: Partial<ResolverHit> = {}): ResolverHit => ({ source: 'catalog', centralItemId: 'item-1', scientificName: 'Aspirin', tradeName: null, concentration: '100 mg', dosageForm: 'Tablet', unit: 'box', nationalCode: null, grade: 'confirmed', ...o });

const mount = (preview: ReturnType<typeof handle>, resolve: (q: string) => Promise<ResolverHit[]> = vi.fn(async (_q: string): Promise<ResolverHit[]> => []), over: Partial<React.ComponentProps<typeof IdentityAssistPanel>> = {}) => {
  const onUseItem = vi.fn(); const onRequestRegistration = vi.fn();
  const utils = render(<IdentityAssistPanel lang="en" scopeKey="org-1" preview={preview} resolve={resolve} onUseItem={onUseItem} onRequestRegistration={onRequestRegistration} {...over} />);
  return { ...utils, resolve, onUseItem, onRequestRegistration };
};
const confirmRow = (n: number) => {
  fireEvent.click(screen.getByRole('radio', { name: `Row ${n}` }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm header row and look up' }));
};
afterEach(() => cleanup());

describe('BEFORE confirmation: row numbers only, no worksheet cell is accessed', () => {
  it('rendering the panel with a parsed workbook touches NO property of ANY cell, and shows no cell content at all', () => {
    const log: Log = [];
    mount(handle(ready(workbook(log))));
    expect(log).toEqual([]);                                                // numeric, text-number and ambiguous cells alike: nothing was accessed
    const body = document.body.textContent ?? '';
    for (const s of SENTINELS) expect(body, s).not.toContain(s);
    for (const w of ['Aspirin', 'Zolpidem', '100 mg', 'Medicine name', 'Annual quantity']) expect(body, w).not.toContain(w);   // not even the header text
    expect(screen.getAllByRole('radio').length).toBe(3);                    // rows 1..3 exist, by number
    expect(screen.getByRole('radio', { name: 'Row 3' })).toBeInTheDocument();
  });

  it('choosing a row (radio or typed row number) and re-rendering still accesses nothing; the confirm button waits for a valid row', () => {
    const log: Log = [];
    const m = mount(handle(ready(workbook(log))));
    const confirm = screen.getByRole('button', { name: 'Confirm header row and look up' });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Row 1' }));
    expect(confirm).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('Header row number'), { target: { value: '2' } });
    expect(screen.getByRole('radio', { name: 'Row 2' })).toBeChecked();
    fireEvent.change(screen.getByLabelText('Header row number'), { target: { value: '99' } });       // out of range
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Header row number'), { target: { value: 'abc' } });
    expect(confirm).toBeDisabled();
    expect(log).toEqual([]);
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it('the row count comes from coordinates only: a long sheet offers the first rows as radios and every row through the number field', () => {
    const log: Log = [];
    const wb = workbook(log);
    const sheet = (wb.workbook.sheets[0] as { usedRange: { endRow: number } });
    sheet.usedRange.endRow = 40;
    mount(handle(ready(wb)));
    expect(screen.getAllByRole('radio').length).toBe(15);
    fireEvent.change(screen.getByLabelText('Header row number'), { target: { value: '41' } });
    expect(screen.getByRole('button', { name: 'Confirm header row and look up' })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('Header row number'), { target: { value: '42' } });
    expect(screen.getByRole('button', { name: 'Confirm header row and look up' })).toBeDisabled();
    expect(log).toEqual([]);
  });

  it('the person is told, in both languages, that nothing from the sheet is shown or read until the header row is confirmed', () => {
    mount(handle(ready(workbook([]))));
    expect(screen.getByText('Nothing is read until you confirm the header row.')).toBeInTheDocument();
    expect(screen.getByText('No cell content is shown here. Choose the header row by its number, as in your file.')).toBeInTheDocument();
    cleanup();
    mount(handle(ready(workbook([]))), undefined, { lang: 'ar' });
    expect(screen.getByText('لا يُعرض هنا أي محتوى للخلايا. اختر صف العناوين برقمه كما في ملفك.')).toBeInTheDocument();
  });
});

describe('AFTER confirmation: only the confirmed header row and the identity columns are touched', () => {
  it('quantity columns of EVERY kind (numeric, text-number, ambiguous) are never accessed - not even their type or presence', async () => {
    const log: Log = [];
    const resolve = vi.fn(async (q: string): Promise<ResolverHit[]> => (q === 'Aspirin' ? [hit()] : []));
    mount(handle(ready(workbook(log))), resolve);
    confirmRow(1);
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    expect(resolve.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['Aspirin', 'Zolpidem']);
    await screen.findByText('Matching material');
    const touched = (r: number, c: number) => log.filter((k) => k.startsWith(`${r}:${c}:`));
    for (const r of [1, 2]) for (const c of [3, 4, 5]) expect(touched(r, c), `data cell ${r}:${c}`).toEqual([]);          // every quantity cell untouched
    for (const r of [1, 2]) for (const c of [0, 1, 2]) {
      const props = new Set(touched(r, c).map((k) => k.split(':')[2]));
      expect([...props].every((p) => ['presence', 'valueType', 'rawValue'].includes(p)), `identity cell ${r}:${c}`).toBe(true);   // never formattedText / formula
      expect(touched(r, c).length).toBeGreaterThan(0);
    }
    expect(log.filter((k) => /^[3-9]:|^[1-9]\d:/.test(k))).toEqual([]);                                                        // no row beyond the data we read
  });

  it('nothing quantity-shaped is displayed or handed to a callback after confirmation', async () => {
    const log: Log = [];
    const m = mount(handle(ready(workbook(log))), vi.fn(async (q: string) => (q === 'Aspirin' ? [hit({ centralItemId: 'item-7' })] : [])));
    confirmRow(1);
    fireEvent.click(await screen.findByRole('button', { name: /Use this material: Aspirin/ }));
    const body = document.body.textContent ?? '';
    for (const s of SENTINELS) expect(body, s).not.toContain(s);
    expect(JSON.stringify(m.onUseItem.mock.calls)).not.toMatch(/98700|4500|boxes|N\/A|Total 7/);
    fireEvent.click(screen.getAllByRole('button', { name: 'Request registration' })[0]);
    expect(JSON.stringify(m.onRequestRegistration.mock.calls)).not.toMatch(/98700|4500|boxes|N\/A|Total 7|quantity/i);
  });

  it('changing the chosen row withdraws the confirmation and the results; changing the organization scope resets the panel and the preview', async () => {
    const log: Log = [];
    const p = handle(ready(workbook(log)));
    const { rerender } = mount(p, vi.fn(async () => [hit()]));
    confirmRow(1);
    await screen.findAllByText('Matching material');
    fireEvent.click(screen.getByRole('radio', { name: 'Row 2' }));
    expect(screen.queryByText('Matching material')).toBeNull();
    const before = p.reset.mock.calls.length;
    rerender(<IdentityAssistPanel lang="en" scopeKey="org-2" preview={p} resolve={async () => []} onUseItem={() => undefined} onRequestRegistration={() => undefined} />);
    expect(p.reset.mock.calls.length).toBeGreaterThan(before);
    expect(screen.getByRole('button', { name: 'Confirm header row and look up' })).toBeDisabled();
  });
});

describe('results are suggestions the person acts on', () => {
  it('"use this material" hands over the registered item only (no quantity, no stock)', async () => {
    const m = mount(handle(ready(workbook([]))), vi.fn(async (q: string) => (q === 'Aspirin' ? [hit({ centralItemId: 'item-7' })] : [])));
    confirmRow(1);
    fireEvent.click(await screen.findByRole('button', { name: /Use this material: Aspirin/ }));
    expect(m.onUseItem).toHaveBeenCalledWith({ id: 'item-7', name: 'Aspirin', nameAr: null, concentration: '100 mg', dosageForm: 'Tablet', unit: 'box' });
  });

  it('an unregistered material offers a registration request prefilled with the typed descriptor and an identity-only pointer', async () => {
    const m = mount(handle(ready(workbook([]))), vi.fn(async () => []));
    confirmRow(1);
    const buttons = await screen.findAllByRole('button', { name: 'Request registration' });
    fireEvent.click(buttons[1]);                                       // Zolpidem (sheet row 2, zero-based)
    expect(m.onRequestRegistration).toHaveBeenCalledTimes(1);
    const prefill = m.onRequestRegistration.mock.calls[0][0] as { descriptor: Record<string, unknown>; pointer: Record<string, unknown> };
    expect(prefill.descriptor).toMatchObject({ scientificName: 'Zolpidem', strength: '10 mg', dosageForm: 'Tablet', unit: undefined });
    expect(prefill.pointer).toEqual({ sheet_index: 0, row: 2, column: 0, file_hash: 'c'.repeat(64) });
  });

  it('a failed lookup says "lookup failed", never "not registered"', async () => {
    mount(handle(ready(workbook([]))), vi.fn(async () => { throw new Error('503'); }));
    confirmRow(1);
    expect((await screen.findAllByText('Lookup failed')).length).toBe(2);
    expect(screen.queryByText('Not registered')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request registration' })).toBeNull();
  });

  it('a confirmed row without a name column reports it and extracts nothing', async () => {
    const m = mount(handle(ready(workbook([]))));
    confirmRow(3);                                                      // a data row, not a header
    expect(await screen.findByText('No material-name column in this row.')).toBeInTheDocument();
    expect(m.resolve).not.toHaveBeenCalled();
  });
});

describe('states', () => {
  it('an archive is refused, a failed parse is reported, parsing shows progress; choosing a file asks the existing preview to parse it', () => {
    mount(handle(ready({}, 'archive')));
    expect(screen.getByText('A ZIP archive is not supported here; choose a single workbook.')).toBeInTheDocument();
    cleanup();
    mount(handle({ phase: 'failed', filename: 'x.xlsx', reason: 'bad' }));
    expect(screen.getByText('The file could not be read.')).toBeInTheDocument();
    cleanup();
    mount(handle({ phase: 'parsing', filename: 'x.xlsx' }));
    expect(screen.getAllByRole('status').map((e) => e.textContent).join(' ')).toContain('Loading…');
    cleanup();
    const p = handle({ phase: 'idle' });
    mount(p);
    const file = new File(['x'], 'needs.xlsx');
    fireEvent.change(screen.getByLabelText('Choose an Excel file'), { target: { files: [file] } });
    expect(p.parse).toHaveBeenCalledWith(file);
  });

  it('Arabic: the explanation and the row controls are Arabic; the row labels carry their numbers', () => {
    mount(handle(ready(workbook([]))), undefined, { lang: 'ar' });
    expect(screen.getByText('يُستخدم الملف للتعرف على أسماء المواد فقط. لا تُقرأ أي كمية منه ولا تُنقل إلى الاحتياج.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'الصف 2' })).toBeInTheDocument();
    expect(screen.getByLabelText('رقم صف العناوين')).toBeInTheDocument();
  });

  it('accessibility: the row choices form one labelled group and the status regions are polite', () => {
    mount(handle(ready(workbook([]))));
    const group = screen.getByRole('radiogroup', { name: 'Select the header row' });
    expect(within(group).getAllByRole('radio').length).toBe(3);
    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});

// ===========================================================================================================
// Director final correction: a lookup that is still pending when the selection changes must never surface or be used
// ===========================================================================================================
describe('stale lookup results (selection changes while a lookup is pending)', () => {
  type Entry = { q: string; done: boolean; release: (v: ResolverHit[]) => void; fail: (e: Error) => void };
  /** A resolver whose answers are released by the test, in any order. */
  const controlled = () => {
    const queue: Entry[] = [];
    const resolve = vi.fn((q: string) => new Promise<ResolverHit[]>((res, rej) => {
      const e: Entry = { q, done: false, release: (v) => { e.done = true; res(v); }, fail: (err) => { e.done = true; rej(err); } };
      queue.push(e);
    }));
    return { resolve, queue };
  };
  const twoSheets = (log: Log) => {
    const wb = workbook(log);
    const second = {
      index: 1, name: 'Second', hidden: 'visible', usedRange: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, nonEmptyCellCount: 4, mergedRanges: [], duplicateHeaderGroups: [],
      cells: [text(0, 0, 'Medicine name', log), text(0, 1, 'Strength', log), text(1, 0, 'Ibuprofen', log), text(1, 1, '200 mg', log)],
    };
    (wb.workbook.sheets as unknown[]).push(second);
    return wb;
  };
  const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  /** Let EVERY lookup that is (or becomes) in flight finish, so that a run which was not superseded would complete and show its result. */
  const drain = async (c: ReturnType<typeof controlled>, how: 'hit' | 'none' | 'fail', skip: Entry[] = []) => {
    for (let i = 0; i < 6; i += 1) {
      for (const e of c.queue) {
        if (e.done || skip.includes(e)) continue;
        if (how === 'fail') e.fail(new Error('503')); else e.release(how === 'hit' ? [hit()] : []);
      }
      await tick();
    }
  };
  const noResultSurface = () => {
    expect(screen.queryByText('Matching material')).toBeNull();
    expect(screen.queryByText('Not registered')).toBeNull();
    expect(screen.queryByText('Lookup failed')).toBeNull();
    expect(screen.queryByRole('table', { name: 'Optional medicine-identity help from a workbook' })).toBeNull();
  };
  const confirmEnabled = () => expect(screen.getByRole('button', { name: 'Confirm header row and look up' })).not.toBeDisabled();

  it('changing the header row (radio) while the lookup is pending: the old result never appears, busy is cleared, the new selection can be confirmed', async () => {
    const c = controlled();
    mount(handle(ready(workbook([]))), c.resolve);
    confirmRow(1);
    await waitFor(() => expect(c.queue.length).toBe(1));
    fireEvent.click(screen.getByRole('radio', { name: 'Row 2' }));                          // selection changes while Aspirin is being looked up
    confirmEnabled();                                                                       // not left busy
    await drain(c, 'hit');
    noResultSurface();
  });

  it('changing the header row by TYPING a row number while pending: same guarantee', async () => {
    const c = controlled();
    mount(handle(ready(workbook([]))), c.resolve);
    confirmRow(1);
    await waitFor(() => expect(c.queue.length).toBe(1));
    fireEvent.change(screen.getByLabelText('Header row number'), { target: { value: '3' } });
    confirmEnabled();
    await drain(c, 'hit');
    noResultSurface();
  });

  it('changing the SHEET while pending: the old sheet\'s result never appears under the new sheet', async () => {
    const c = controlled();
    mount(handle(ready(twoSheets([]))), c.resolve);
    confirmRow(1);
    await waitFor(() => expect(c.queue.length).toBe(1));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Confirm header row and look up' })).toBeDisabled();       // new sheet: header not chosen yet, and not busy-locked either
    await drain(c, 'hit');
    noResultSurface();
    expect(screen.queryByText('Aspirin')).toBeNull();
  });

  it('choosing another FILE while pending: nothing from the old file appears and the panel is not left busy', async () => {
    const c = controlled();
    const p = handle(ready(workbook([])));
    mount(p, c.resolve);
    confirmRow(1);
    await waitFor(() => expect(c.queue.length).toBe(1));
    fireEvent.change(screen.getByLabelText('Choose an Excel file'), { target: { files: [new File(['x'], 'other.xlsx')] } });
    expect(p.parse).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Row 1' }));
    confirmEnabled();                                                                       // busy was cleared
    await drain(c, 'hit');
    noResultSurface();
  });

  it('lookups that FAIL after the selection changed do not show a failure for the new selection', async () => {
    const c = controlled();
    mount(handle(ready(workbook([]))), c.resolve);
    confirmRow(1);
    await waitFor(() => expect(c.queue.length).toBe(1));
    fireEvent.click(screen.getByRole('radio', { name: 'Row 2' }));
    await drain(c, 'fail');
    noResultSurface();
    expect(screen.queryByText('Could not load. Nothing was changed.')).toBeNull();
  });

  it('once the selection changed, the superseded request issues NO further lookups', async () => {
    const c = controlled();
    mount(handle(ready(workbook([]))), c.resolve);
    confirmRow(1);
    await waitFor(() => expect(c.queue.length).toBe(1));                                   // "Aspirin" is in flight, "Zolpidem" has not started
    fireEvent.click(screen.getByRole('radio', { name: 'Row 2' }));
    await drain(c, 'none');
    expect(c.resolve).toHaveBeenCalledTimes(1);                                            // no network call for the remaining candidates
  });

  it('out-of-order answers: the OLD request finishing after the NEW one never overwrites it, and nothing of it can be used', async () => {
    const c = controlled();
    const m = mount(handle(ready(twoSheets([]))), c.resolve);
    confirmRow(1);                                                                          // sheet 0 -> "Aspirin" pending (request A)
    await waitFor(() => expect(c.queue.length).toBe(1));
    const requestA = c.queue[0];
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } });
    confirmRow(1);                                                                          // sheet 1 -> "Ibuprofen" pending (request B)
    await waitFor(() => expect(c.queue.length).toBe(2));
    expect(c.queue[1].q).toBe('Ibuprofen');
    c.queue[1].release([]);                                                                 // B answers first: not registered
    await screen.findByText('Not registered');
    requestA.release([hit({ centralItemId: 'stale-item' })]);                               // A answers late
    await drain(c, 'hit');
    expect(screen.getByText('Not registered')).toBeInTheDocument();
    expect(screen.queryByText('Matching material')).toBeNull();
    expect(screen.queryByText('Aspirin')).toBeNull();
    expect(screen.getByText('Ibuprofen')).toBeInTheDocument();
    expect(m.onUseItem).not.toHaveBeenCalled();
    expect(m.onRequestRegistration).not.toHaveBeenCalled();
  });

  it('a normal, un-interrupted lookup still shows its result (the guard does not swallow fresh answers)', async () => {
    const c = controlled();
    mount(handle(ready(workbook([]))), c.resolve);
    confirmRow(1);
    await waitFor(() => expect(c.queue.length).toBe(1));
    c.queue[0].release([hit()]);
    await waitFor(() => expect(c.queue.length).toBe(2));
    c.queue[1].release([]);
    expect(await screen.findByText('Matching material')).toBeInTheDocument();
    expect(screen.getByText('Not registered')).toBeInTheDocument();
    expect(screen.queryByText('Lookup failed')).toBeNull();
  });

  it('after a superseded request, a fresh confirmation of the SAME selection works normally (no leftover busy / error state)', async () => {
    const c = controlled();
    mount(handle(ready(workbook([]))), c.resolve);
    confirmRow(1);
    await waitFor(() => expect(c.queue.length).toBe(1));
    fireEvent.click(screen.getByRole('radio', { name: 'Row 2' }));
    await drain(c, 'none');
    confirmRow(1);
    await waitFor(() => expect(c.queue.filter((e) => !e.done).length).toBeGreaterThan(0));
    await drain(c, 'hit');
    expect(await screen.findByText('Matching material')).toBeInTheDocument();           // Aspirin: the hit matches
    expect(screen.getByText('Strength / form / unit conflict')).toBeInTheDocument();      // Zolpidem vs the same Aspirin hit: a conflict, correctly classified
    expect(screen.queryByText('Lookup failed')).toBeNull();
  });

  it('the sheet selector has a real, translated label (not the name of the sheet itself)', () => {
    mount(handle(ready(twoSheets([]))));
    expect(screen.getByLabelText('Sheet')).toBe(screen.getByRole('combobox'));
    cleanup();
    mount(handle(ready(twoSheets([]))), undefined, { lang: 'ar' });
    expect(screen.getByLabelText('الورقة')).toBe(screen.getByRole('combobox'));
  });
});
