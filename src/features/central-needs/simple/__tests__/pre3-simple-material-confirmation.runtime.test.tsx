/** @vitest-environment jsdom */
/**
 * PRE3-A — the Simple material card on the shared resolver.
 *
 *   * a suggestion is offered only for exactly ONE exact match, and is written
 *     only by its explicit [Correct];
 *   * in the picker, choosing a result (whatever its grade) STAGES it beside its
 *     discriminators — the write is a separate confirmation;
 *   * "no registered material" is an honest, unresolved state with no write;
 *     a failed search is a failure, never "not registered";
 *   * "not a material" stays its own decision, with a reason and no item.
 *
 * PRE3 Run 4: the suggestion now comes from `findExactCentralItemMatches` (the
 * shared resolver's exact-candidate mode) and needs `complete: true` — proven
 * uniqueness. Here that service read is stubbed; the end-to-end proof through
 * the real service and resolver is pre3-suggestion-uniqueness.runtime.test.tsx.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type { CentralItemOption, SourceRecord } from '../../central-needs.service';

const setRecordDisposition = vi.fn();
const searchCentralItems = vi.fn();
const findExactCentralItemMatches = vi.fn();
vi.mock('../../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../../central-needs.service')>('../../central-needs.service');
  return {
    ...actual,
    setRecordDisposition: (...a: unknown[]) => setRecordDisposition(...a),
    searchCentralItems: (...a: unknown[]) => searchCentralItems(...a),
    findExactCentralItemMatches: (...a: unknown[]) => findExactCentralItemMatches(...a),
  };
});

const { SimpleMaterialCard } = await import('../SimpleMaterialCard');
const { CentralNeedsError } = await import('../../central-needs.service');

beforeEach(() => { findExactCentralItemMatches.mockResolvedValue({ matches: [], complete: true }); });
afterEach(() => {
  cleanup();
  setRecordDisposition.mockReset();
  searchCentralItems.mockReset();
  findExactCentralItemMatches.mockReset();
});

const AMOX_500: CentralItemOption = {
  id: 'ci-amox-500', name: 'Amoxicillin', unit: 'capsule', nameAr: 'أموكسيسيلين', tradeName: 'Amoxil',
  concentration: '500 mg', dosageForm: 'Capsule', nationalCode: '6291000000011', grade: 'strong', reasonKey: 'mr_reason_name_exact',
};
const AMOX_SUSP: CentralItemOption = {
  id: 'ci-amox-susp', name: 'Amoxicillin', unit: 'bottle', nameAr: 'أموكسيسيلين', tradeName: 'Moxypen',
  concentration: '250 mg/5 ml', dosageForm: 'Suspension', nationalCode: null, grade: 'strong', reasonKey: 'mr_reason_name_exact',
};
const PARA: CentralItemOption = {
  id: 'ci-para', name: 'Paracetamol', unit: 'tablet', nameAr: 'باراسيتامول', tradeName: 'Panadol',
  concentration: '500 mg', dosageForm: 'Tablet', nationalCode: '6291000000028', grade: 'confirmed', reasonKey: 'mr_reason_barcode_exact',
};
const IBU: CentralItemOption = { id: 'ci-ibu', name: 'Ibuprofen', unit: 'tablet', grade: 'probable', reasonKey: 'mr_reason_name_partial' };

const rec = (value: string): SourceRecord => ({
  id: 'r1', importSessionId: 's1', recordOrdinal: 1, targetEntity: 'sheet:0:row:8', fieldName: 'ITEMS',
  sourceValues: { value }, sourceProvenance: { sheetIndex: 0, coordinate: { col: 1 } },
});

function renderCard(evidence: string, onResolved = vi.fn()) {
  render(
    <SimpleMaterialCard
      lang="en" importSessionId="s1" editable targetEntity="sheet:0:row:8" fields={[rec(evidence)]} onResolved={onResolved}
    />,
  );
  return { onResolved, card: screen.getByTestId('cn2b-simple-material-card') };
}

const openPicker = (card: HTMLElement) =>
  fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_choose_material.en }));
const typeSearch = (card: HTMLElement, value: string) =>
  fireEvent.change(within(card).getByLabelText(T.cn2b_simple_search_material.en), { target: { value } });
const searchState = (card: HTMLElement) => within(card).getByTestId('cn2b-simple-material-search-state');

describe('PRE3-A — a suggestion is one exact match, and is written only on [Correct]', () => {
  it('5 · shows the single exact match with its discriminators and writes nothing until confirmed', async () => {
    findExactCentralItemMatches.mockResolvedValue({ matches: [AMOX_500], complete: true });
    const { card, onResolved } = renderCard('Amoxil');
    const suggestion = await within(card).findByTestId('cn2b-simple-material-suggestion');
    expect(suggestion).toHaveTextContent('Amoxicillin');
    const facts = within(card).getByTestId('cn2b-simple-material-facts');
    for (const text of ['أموكسيسيلين', 'Amoxil', '500 mg', 'Capsule', '6291000000011', T.inv_trade_name.en, T.inv_national_code.en]) {
      expect(facts).toHaveTextContent(text);
    }
    expect(setRecordDisposition).not.toHaveBeenCalled();

    setRecordDisposition.mockResolvedValue(undefined);
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_correct.en }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(setRecordDisposition).toHaveBeenCalledTimes(1);
    expect(setRecordDisposition).toHaveBeenCalledWith({
      importSessionId: 's1', targetEntity: 'sheet:0:row:8', decision: 'mapped', centralItemId: 'ci-amox-500',
    });
  });

  it('5b · two exact matches are a choice, not a suggestion', async () => {
    findExactCentralItemMatches.mockResolvedValue({ matches: [AMOX_500, AMOX_SUSP], complete: true });
    const { card } = renderCard('Amoxicillin');
    await within(card).findByTestId('cn2b-simple-material-multiple-matches');
    expect(within(card).queryByTestId('cn2b-simple-material-suggestion')).toBeNull();
    expect(within(card).queryByRole('button', { name: T.cn2b_simple_correct.en })).toBeNull();
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('5b′ · two exact matches stay a choice even when the set is not proven complete', async () => {
    findExactCentralItemMatches.mockResolvedValue({ matches: [AMOX_500, AMOX_SUSP], complete: false });
    const { card } = renderCard('Amoxicillin');
    await within(card).findByTestId('cn2b-simple-material-multiple-matches');
    expect(within(card).queryByTestId('cn2b-simple-material-suggestion')).toBeNull();
    expect(within(card).queryByTestId('cn2b-simple-material-suggestion-unconfirmed')).toBeNull();
  });

  it('5d · ONE exact match from a set NOT proven complete is no suggestion — the card says it could not confirm one', async () => {
    findExactCentralItemMatches.mockResolvedValue({ matches: [AMOX_500], complete: false });
    const { card } = renderCard('Amoxil');
    await within(card).findByTestId('cn2b-simple-material-suggestion-unconfirmed');
    expect(within(card).queryByTestId('cn2b-simple-material-suggestion')).toBeNull();
    expect(within(card).queryByRole('button', { name: T.cn2b_simple_correct.en })).toBeNull();
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('5e · a failed check is no suggestion and says so; the check is never the general search window', async () => {
    findExactCentralItemMatches.mockRejectedValue(new CentralNeedsError('central_needs_request_failed', 'boom'));
    const { card } = renderCard('Amoxil');
    await within(card).findByTestId('cn2b-simple-material-suggestion-unconfirmed');
    expect(within(card).queryByTestId('cn2b-simple-material-suggestion')).toBeNull();
    expect(findExactCentralItemMatches).toHaveBeenCalledWith('Amoxil');
    expect(searchCentralItems).not.toHaveBeenCalled();
  });

  it('a partial or probable seed hit is never offered as a suggestion', async () => {
    findExactCentralItemMatches.mockResolvedValue({ matches: [IBU], complete: true });
    const { card } = renderCard('Ibuprofen 400 mg tablets');
    await waitFor(() => expect(findExactCentralItemMatches).toHaveBeenCalledWith('Ibuprofen 400 mg tablets'));
    await new Promise((r) => setTimeout(r, 10));
    expect(within(card).queryByTestId('cn2b-simple-material-suggestion')).toBeNull();
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });
});

describe('PRE3-A — in the picker, choosing stages; only the confirmation writes', () => {
  it('5c · confirmed, strong and probable results alike are staged on click and written only on confirmation', async () => {
    searchCentralItems.mockImplementation(async (q: string) => (q === 'xx-seed' ? [] : [PARA, AMOX_500, IBU]));
    const { card, onResolved } = renderCard('xx-seed');
    openPicker(card);
    typeSearch(card, 'tab');
    for (const item of [PARA, AMOX_500, IBU]) {
      fireEvent.click(await within(card).findByRole('button', { name: new RegExp(`^${item.name}`) }));
      const pending = within(card).getByTestId('cn2b-simple-material-pending');
      expect(pending).toHaveTextContent(item.name);
      expect(pending).toHaveTextContent(item.unit);
      expect(setRecordDisposition).not.toHaveBeenCalled();
      // Back to the list — still nothing written.
      fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_material_choose_different.en }));
      expect(within(card).queryByTestId('cn2b-simple-material-pending')).toBeNull();
    }
    expect(setRecordDisposition).not.toHaveBeenCalled();

    setRecordDisposition.mockResolvedValue(undefined);
    fireEvent.click(within(card).getByRole('button', { name: /^Ibuprofen/ }));
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_material_confirm.en }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(setRecordDisposition).toHaveBeenCalledTimes(1);
    expect(setRecordDisposition).toHaveBeenCalledWith({
      importSessionId: 's1', targetEntity: 'sheet:0:row:8', decision: 'mapped', centralItemId: 'ci-ibu',
    });
  });

  it('a new search term discards the staged choice', async () => {
    searchCentralItems.mockImplementation(async (q: string) => (q === 'xx-seed' ? [] : [PARA]));
    const { card } = renderCard('xx-seed');
    openPicker(card);
    typeSearch(card, 'para');
    fireEvent.click(await within(card).findByRole('button', { name: /^Paracetamol/ }));
    expect(within(card).getByTestId('cn2b-simple-material-pending')).toBeInTheDocument();
    typeSearch(card, 'parac');
    expect(within(card).queryByTestId('cn2b-simple-material-pending')).toBeNull();
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('keeps the newest search: a slower earlier reply never replaces a later one', async () => {
    const replies: Record<string, (rows: CentralItemOption[]) => void> = {};
    searchCentralItems.mockImplementation((q: string) => (q === 'xx-seed'
      ? Promise.resolve([])
      : new Promise<CentralItemOption[]>((resolve) => { replies[q] = resolve; })));
    const { card } = renderCard('xx-seed');
    openPicker(card);
    typeSearch(card, 'am');
    await waitFor(() => expect(replies.am).toBeDefined());
    typeSearch(card, 'para');
    await waitFor(() => expect(replies.para).toBeDefined());
    replies.para([PARA]);
    await within(card).findByRole('button', { name: /^Paracetamol/ });
    replies.am([AMOX_500]);
    await new Promise((r) => setTimeout(r, 20));
    expect(within(card).queryByRole('button', { name: /^Amoxicillin/ })).toBeNull();
    expect(within(card).getByRole('button', { name: /^Paracetamol/ })).toBeInTheDocument();
  });
});

describe('PRE3-A — no match is honest and unresolved; failure is not "no match"', () => {
  it('6 · "Material not registered": the row stays undecided, nothing is created or mapped', async () => {
    searchCentralItems.mockResolvedValue([]);
    const { card, onResolved } = renderCard('Zzyzx compound');
    openPicker(card);
    typeSearch(card, 'Zzyzx compound');
    const none = await within(card).findByTestId('cn2b-simple-material-not-registered');
    expect(none).toHaveTextContent(T.cn2b_material_not_registered.en);
    expect(none).toHaveTextContent(T.cn2b_material_not_registered_note.en);
    expect(searchState(card).dataset.phase).toBe('done');
    // There is no control that could map the typed text.
    expect(within(card).queryByRole('button', { name: T.cn2b_simple_material_confirm.en })).toBeNull();
    expect(within(card).queryByTestId('cn2b-simple-material-pending')).toBeNull();
    expect(setRecordDisposition).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    // The not-registered copy promises nothing it cannot keep.
    expect(T.cn2b_material_not_registered_note.en).not.toMatch(/Supplementary|Direct Entry|request/i);
  });

  it('a failed search says it failed, and never says "not registered"', async () => {
    searchCentralItems.mockImplementation(async (q: string) => {
      if (q === 'xx-seed') return [];
      throw new CentralNeedsError('central_needs_request_failed', 'boom');
    });
    const { card } = renderCard('xx-seed');
    openPicker(card);
    typeSearch(card, 'para');
    const failed = await within(card).findByTestId('cn2b-simple-material-search-failed');
    expect(failed).toHaveTextContent(T.cn2b_material_search_failed.en);
    expect(within(card).queryByTestId('cn2b-simple-material-not-registered')).toBeNull();
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('a one-character query is "keep typing" — no search, and no "not registered" claim', async () => {
    searchCentralItems.mockResolvedValue([]);
    const { card } = renderCard('xx-seed');
    openPicker(card);
    typeSearch(card, 'p');
    expect(searchState(card).dataset.phase).toBe('too_short');
    expect(searchState(card)).toHaveTextContent(T.cn2b_material_search_min.en);
    await new Promise((r) => setTimeout(r, 200));
    expect(searchCentralItems).not.toHaveBeenCalled();
    expect(within(card).queryByTestId('cn2b-simple-material-not-registered')).toBeNull();
  });
});

describe('PRE3-A — "not a material" stays its own explicit decision', () => {
  it('7 · requires a reason and records not_applicable with no central item', async () => {
    searchCentralItems.mockResolvedValue([]);
    setRecordDisposition.mockResolvedValue(undefined);
    const { card, onResolved } = renderCard('Subtotal');
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_not_a_material.en }));
    const confirm = within(card).getByRole('button', { name: T.cn2b_simple_confirm_not_a_material.en });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(card).getByLabelText(T.cn2b_beneficiary_column_reason_required.en), { target: { value: 'Subtotal line' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(setRecordDisposition).toHaveBeenCalledWith({
      importSessionId: 's1', targetEntity: 'sheet:0:row:8', decision: 'not_applicable', decisionReason: 'Subtotal line',
    });
    expect(setRecordDisposition.mock.calls[0][0]).not.toHaveProperty('centralItemId');
  });
});

describe('PRE3 M220 — the server refusal of a non-active item is explained, never swallowed', () => {
  it('a confirmed mapping refused central_item_not_active shows the translated reason and resolves nothing', async () => {
    searchCentralItems.mockImplementation(async (q: string) => (q === 'xx-seed' ? [] : [PARA]));
    setRecordDisposition.mockRejectedValue(new CentralNeedsError('central_item_not_active', 'central_item_not_active', {
      sqlstate: '23514', details: 'central_item=ci-para status=discontinued reason=discontinued',
    }));
    const { card, onResolved } = renderCard('xx-seed');
    openPicker(card);
    typeSearch(card, 'para');
    fireEvent.click(await within(card).findByRole('button', { name: /^Paracetamol/ }));
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_material_confirm.en }));
    expect(await within(card).findByRole('alert')).toHaveTextContent(T.cn2b_err_central_item_not_active.en);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('both new refusal codes have Arabic and English copy, and the Arabic names the revision «الإصدار»', () => {
    for (const key of ['cn2b_err_central_item_not_active', 'cn2b_err_central_needs_central_item_not_active']) {
      expect(T[key].ar.trim(), key).not.toBe('');
      expect(T[key].en.trim(), key).not.toBe('');
    }
    expect(T.cn2b_err_central_needs_central_item_not_active.ar).toContain('الإصدار');
    expect(T.cn2b_err_central_needs_central_item_not_active.ar).not.toContain('المراجعة');
  });
});
