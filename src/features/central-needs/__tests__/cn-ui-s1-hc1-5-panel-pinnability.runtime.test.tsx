/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type { BeneficiaryColumnSummary, FieldOverride } from '../central-needs.service';
import { isNumericOverride, numericOverrideLexeme, overrideHeads } from '../central-needs.lineage';

/**
 * CN-UI-S1 HC1.5 — CANONICAL PANEL PINNABILITY ALIGNMENT, through the REAL `CentralNeedsNeedLinePanel`.
 *
 * HC1.4 taught Simple readiness that "numeric" is not "pinnable" (`numericOverrideLexeme(head) !== null`).
 * The canonical panel still offered "Base it on the recorded override" for any NUMERIC head. HC1.5 closes
 * exactly that: the pin control, the pin guard and the stale-pin check all ask ONE gate, `pinnableLexemeOf`,
 * which wraps the canonical helper and the exact current-head identity — and nothing else.
 *
 *   H1_5_01  a current 256-character head (integer AND fraction) → the pin control EXISTS
 *   H1_5_02  a current numeric-but-unpinnable head (257 characters, 309 digits, …) → the control is ABSENT
 *   H1_5_03  its evidence reports numeric=true and, SEPARATELY, pinnable=false
 *   H1_5_04  its note says "a number, but not usable as a canonical quantity" — NOT "not a number" (EN and AR)
 *   H1_5_05  text / blank / null / boolean / object / negative / non-finite: the established "not a number" behaviour
 *   H1_5_06  a programmatic useOverride(on=true) with an unpinnable override: no state change, no pin
 *   H1_5_07  … with an OLDER pinnable override while a newer head exists (and another record's): no pin
 *   H1_5_08  a successful pin sends EXACTLY numericOverrideLexeme(currentHead) as the designated quantity
 *   H1_5_09  … and the exact current head's id as appliedOverrideId
 *   H1_5_11  a current unpinnable head with an older pinnable override behind it: the older is never offered or substituted
 *   H1_5_14  a pinnable head still pins and saves through the existing setNeedLine
 *   H1_5_15  a stale/local pin on a head that has become unpinnable is cleared (visibly, with its value),
 *            Save is unavailable, and nothing carries it into a write
 * (H1_5_10 is the static no-fallback pin in cn-ui-s1-hc1-5-static-contract.test.ts; H1_5_12 / H1_5_13 are the
 *  real-screen proofs in cn-ui-s1-hc1-5-screen.runtime.test.tsx.)
 *
 * Fixtures are realistic: an override is exactly what `listOverrides` returns — `finalValue` the JSON.parse of the
 * jsonb, `finalValueText` PostgreSQL's `final_value::text`. The need-line writes are mocked at the service boundary.
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

/**
 * A handle on the Map the panel memoises for the chain it was given. `useOverride` is a closure over that very
 * Map, so changing the Map changes what the closure React attached sees as the cell's head (a newer head
 * arriving, a head disappearing) WITHOUT a re-render — the only way to drive the REAL `useOverride` with an
 * override that is not the current head. Everything else in the module is the real one.
 */
const liveHeads = vi.hoisted(() => ({ last: null as Map<string, unknown> | null }));
vi.mock('../central-needs.lineage', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.lineage')>('../central-needs.lineage');
  return {
    ...actual,
    overrideHeads: (overrides: readonly FieldOverride[]) => {
      const heads = actual.overrideHeads(overrides) as Map<string, FieldOverride>;
      liveHeads.last = heads;
      return heads;
    },
  };
});

const { CentralNeedsNeedLinePanel, pinnableLexemeOf } = await import('../CentralNeedsNeedLinePanel');

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

/** `len` characters of plain integer — what PostgreSQL prints for a jsonb integer of that many digits. */
const intText = (len: number) => `1${'0'.repeat(len - 1)}`;
/** `len` characters of plain decimal fraction ("0." then ones). */
const fracText = (len: number) => `0.${'1'.repeat(len - 2)}`;
/** An override exactly as `listOverrides` returns one: `finalValue` is the JSON.parse of the jsonb, `finalValueText` is `final_value::text`. */
const pg = (id: string, sourceRecordId: string, text: string, over: Partial<FieldOverride> = {}): FieldOverride =>
  ({ ...override(id, sourceRecordId, JSON.parse(text)), finalValueText: text, ...over });

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
    // rec-5 is NOT a plain number ('12 boxes'): only a pinned numeric override can count for it.
    records: [
      record('rec-5', ROW_5, 'qty', envelope('12 boxes'), 1),
      record('rec-6', ROW_6, 'qty', envelope(40), 2),
    ],
    overrides: [],
    overrideReadFailure: null,
    needLines: [],
    claimedSources: [],
    beneficiaryColumns: [column(1), column(2)],
    beneficiaryRegions: { phase: 'ready', versions: [] },
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
const pinBox = (entity: string, lang: 'en' | 'ar' = 'en') =>
  within(candidateFor(entity)).queryByRole('checkbox', { name: T.cn2b_nl_use_override[lang] }) as HTMLInputElement | null;
const contribution = (entity: string, lang: 'en' | 'ar' = 'en') =>
  within(candidateFor(entity)).getByLabelText(`${T.cn2b_nl_contribution[lang]} — qty`) as HTMLInputElement;
const evidence = (entity: string) => within(candidateFor(entity)).getAllByTestId('cn2b-nl-override-evidence');
const notePinnable = (entity: string) => within(candidateFor(entity)).queryByTestId('cn2b-nl-override-not-pinnable');
const noteNumeric = (entity: string) => within(candidateFor(entity)).queryByTestId('cn2b-nl-override-not-numeric');
const fillReasonAndUnit = () => {
  fireEvent.change(screen.getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'pinnability review' } });
  const unit = screen.queryByTestId('cn2b-nl-unit-select') as HTMLSelectElement | null;
  if (unit && unit.value === '') fireEvent.change(unit, { target: { value: 'box' } });
};
const saveButton = () => screen.getByRole('button', { name: T.cn2b_nl_save.en });
const openPreview = () => fireEvent.click(saveButton());
const confirm = () => fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
const blockers = () => [...(screen.queryByTestId('cn2b-nl-save-blockers')?.querySelectorAll('[data-blocker]') ?? [])]
  .map((b) => b.getAttribute('data-blocker'));

/** The `onChange` React attached to a node — the very closure a click would run (the "programmatic" path). */
function onChangeOf(el: Element): (e: { target: { checked: boolean } }) => void {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  if (!key) throw new Error('not a React-rendered node');
  return (el as unknown as Record<string, { onChange: (e: { target: { checked: boolean } }) => void }>)[key].onChange;
}

beforeEach(() => {
  setNeedLine.mockReset().mockResolvedValue({ needLineId: 'nl-1', created: true, sourceLinkCount: 1, addedLinkCount: 1, approvedQuantity: '1' });
  deleteNeedLine.mockReset();
  getOrganizations.mockReset().mockResolvedValue([
    { id: BENE, name: 'Beneficiary Hospital', name_ar: 'مستشفى', code: 'b1', status: 'active', organizationKind: 'care_institution' },
  ]);
  getWarehouses.mockReset().mockResolvedValue([]);
});
afterEach(() => cleanup());

// ---- the shapes ------------------------------------------------------------------------------------
/** Heads the panel can pin: the canonical helper gives each an exact lexeme. */
const PINNABLE: ReadonlyArray<readonly [label: string, text: string]> = [
  ['256-character integer (exactly at the ceiling)', intText(256)],
  ['256-character fraction (the dot counts)', fracText(256)],
  ['an ordinary integer', '12'],
  ['a trailing-zero fraction — the exact text, not the JS rendering', '12.50'],
  ['a tiny decimal whose JS rendering has an exponent', '0.0000001'],
  ['a 22-digit integer whose JS rendering has an exponent', intText(22)],
];
/** Heads that ARE numbers — finite and ≥ 0 to the client — but that the canonical contract cannot take as a quantity. */
const NUMERIC_BUT_UNPINNABLE: ReadonlyArray<readonly [label: string, text: string]> = [
  ['257-character integer', intText(257)],
  ['257-character fraction', fracText(257)],
  ['309-digit integer (still a finite JS number)', intText(309)],
  ['300-digit integer', intText(300)],
  ['302-character tiny fraction (1e-300 written out)', `0.${'0'.repeat(299)}1`],
  ['a tiny negative that underflows to -0 (numeric to isNumericOverride; the sign blocks the lexeme)', `-0.${'0'.repeat(400)}1`],
];
/** Heads that are not numbers at all — the behaviour that must stay exactly as it was. */
const NOT_NUMBERS: ReadonlyArray<readonly [label: string, make: () => FieldOverride]> = [
  ['text', () => override('ovr-x', 'rec-5', 'twelve')],
  ['blank text', () => override('ovr-x', 'rec-5', '')],
  ['null', () => override('ovr-x', 'rec-5', null)],
  ['boolean', () => override('ovr-x', 'rec-5', true)],
  ['an object', () => override('ovr-x', 'rec-5', { qty: 12 })],
  ['a negative number', () => pg('ovr-x', 'rec-5', '-5')],
  ['a 400-digit integer (JSON.parse gives Infinity: not finite)', () => pg('ovr-x', 'rec-5', intText(400))],
];

// ==============================================================================================
describe('H1_5_01 — a current PINNABLE head: the pin control EXISTS', () => {
  it.each(PINNABLE)('H1_5_01 — %s', (_label, text) => {
    const head = pg('ovr-head', 'rec-5', text);
    expect(numericOverrideLexeme(head)).toBe(text); // the helper's own verdict, byte for byte
    renderPanel({ overrides: [head] });
    pick(ROW_5);
    const box = pinBox(ROW_5);
    expect(box).not.toBeNull();
    expect(box).toBeEnabled();
    expect(notePinnable(ROW_5)).toBeNull();
    expect(noteNumeric(ROW_5)).toBeNull();
  });
});

describe('H1_5_02 / H1_5_03 — a current numeric-but-UNPINNABLE head: the control is ABSENT, and the evidence says numeric=true AND pinnable=false', () => {
  it.each(NUMERIC_BUT_UNPINNABLE)('H1_5_02/03 — %s', (_label, text) => {
    const head = pg('ovr-head', 'rec-5', text);
    expect(isNumericOverride(head)).toBe(true); // a number …
    expect(numericOverrideLexeme(head)).toBeNull(); // … that cannot be a designated quantity
    renderPanel({ overrides: [head] });
    pick(ROW_5);

    // H1_5_02 — nothing to tick, anywhere in the row (not by role, not by label text)
    expect(pinBox(ROW_5)).toBeNull();
    expect(within(candidateFor(ROW_5)).queryByText(T.cn2b_nl_use_override.en)).toBeNull();
    expect(within(candidateFor(ROW_5)).queryAllByRole('checkbox').filter((c) => c.closest('.cn2b-nl-contrib__override'))).toHaveLength(0);

    // H1_5_03 — the evidence stays visible, with its value, and reports the two facts SEPARATELY
    const ev = evidence(ROW_5);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toHaveAttribute('data-override-id', 'ovr-head');
    expect(ev[0]).toHaveAttribute('data-numeric', 'true');
    expect(ev[0]).toHaveAttribute('data-pinnable', 'false');
    expect(ev[0]).toHaveTextContent(T.cn2b_nl_override_recorded.en);
    expect(ev[0]).toHaveTextContent('reason for ovr-head');
    expect(ev[0]).toHaveTextContent(text); // the override's VALUE stays visible: the reviewer can see a correction exists, and what it says
  });

  /**
   * The exponent-form cause. A healthy `listOverrides` always carries PostgreSQL's `final_value::text`, so this shape is
   * only reachable when that alias is not applied (`finalValueText` null): the canonical helper then falls back to the
   * JavaScript rendering — which, for these numbers, is an exponent form the server grammar refuses. It must fail closed
   * exactly like the long shapes, and a short number in the same degraded state must still be pinnable.
   */
  it.each([
    ['1e21 (JS prints 1e+21)', 1e21],
    ['1e-7 (JS prints 1e-7)', 1e-7],
  ] as const)('H1_5_02/03 — degraded transport (finalValueText null): %s is numeric but unpinnable → no control, numeric=true, pinnable=false, the note', (_label, value) => {
    const head = override('ovr-head', 'rec-5', value, { finalValueText: null });
    expect(isNumericOverride(head)).toBe(true);
    expect(numericOverrideLexeme(head)).toBeNull();
    renderPanel({ overrides: [head] });
    pick(ROW_5);
    expect(pinBox(ROW_5)).toBeNull();
    expect(evidence(ROW_5)[0]).toHaveAttribute('data-numeric', 'true');
    expect(evidence(ROW_5)[0]).toHaveAttribute('data-pinnable', 'false');
    expect(notePinnable(ROW_5)).toHaveTextContent(T.cn2b_nl_override_not_pinnable.en);
    expect(noteNumeric(ROW_5)).toBeNull();
  });

  it('H1_5_01 — … and the counter-case: a short number in the same degraded state (finalValueText null → String() is canonical) still pins, to exactly that text', () => {
    const head = override('ovr-head', 'rec-5', 12, { finalValueText: null });
    expect(numericOverrideLexeme(head)).toBe('12');
    renderPanel({ overrides: [head] });
    pick(ROW_5);
    expect(evidence(ROW_5)[0]).toHaveAttribute('data-pinnable', 'true');
    fireEvent.click(pinBox(ROW_5)!);
    expect(contribution(ROW_5).value).toBe('12');
  });

  it('H1_5_03 — the three states report distinct (numeric, pinnable) pairs: pinnable → (true, true); numeric-but-unpinnable → (true, false); not a number → (false, false)', () => {
    const seen: Array<[string, string | null, string | null]> = [];
    for (const [label, head] of [
      ['pinnable', pg('ovr-head', 'rec-5', '12')],
      ['numeric but unpinnable', pg('ovr-head', 'rec-5', intText(257))],
      ['not a number', override('ovr-head', 'rec-5', 'twelve')],
    ] as const) {
      const { unmount } = renderPanel({ overrides: [head] });
      pick(ROW_5);
      const ev = evidence(ROW_5)[0];
      seen.push([label, ev.getAttribute('data-numeric'), ev.getAttribute('data-pinnable')]);
      unmount();
    }
    expect(seen).toEqual([['pinnable', 'true', 'true'], ['numeric but unpinnable', 'true', 'false'], ['not a number', 'false', 'false']]);
  });
});

describe('H1_5_04 — a numeric-but-unpinnable head shows the truthful "a number, but not usable as a canonical quantity" note, never "not a number"', () => {
  it.each([['en'], ['ar']] as const)('%s', (lang) => {
    renderPanel({ lang, overrides: [pg('ovr-head', 'rec-5', intText(257))] });
    pick(ROW_5);
    const note = notePinnable(ROW_5);
    expect(note).not.toBeNull();
    expect(note).toHaveTextContent(T.cn2b_nl_override_not_pinnable[lang]);
    // It is NOT the not-numeric presentation — that testid and sentence are for something else.
    expect(noteNumeric(ROW_5)).toBeNull();
    expect(note!.textContent).not.toBe(T.cn2b_nl_override_not_numeric[lang]);
    expect(within(candidateFor(ROW_5)).queryByText(T.cn2b_nl_override_not_numeric[lang])).toBeNull();
    // …and it is not implementation jargon.
    expect(note!.textContent).not.toMatch(/256|lexeme|JSON|exponent|character|حرف|رمز/i);
  });

  it('the two sentences say different things, in both languages (a "not a number" sentence would be false for a 257-digit number)', () => {
    for (const lang of ['en', 'ar'] as const) {
      expect(T.cn2b_nl_override_not_pinnable[lang]).not.toBe(T.cn2b_nl_override_not_numeric[lang]);
    }
    expect(T.cn2b_nl_override_not_pinnable.en).toBe('This override is a number, but it cannot be used as a canonical quantity.');
    expect(T.cn2b_nl_override_not_pinnable.ar).toBe('هذا التعديل رقمي، لكنه غير صالح للاستخدام ككمية معيارية.');
    expect(T.cn2b_nl_override_not_pinnable.en).toMatch(/is a number/);
    expect(T.cn2b_nl_override_not_numeric.en).toMatch(/is not a number/);
  });
});

describe('H1_5_05 — a head that is NOT a number keeps the established behaviour: no control, the "not a number" note, no pinnable note', () => {
  it.each(NOT_NUMBERS)('H1_5_05 — %s', (_label, make) => {
    const head = make();
    expect(numericOverrideLexeme(head)).toBeNull();
    expect(isNumericOverride(head)).toBe(false);
    renderPanel({ overrides: [head] });
    pick(ROW_5);
    expect(pinBox(ROW_5)).toBeNull();
    expect(noteNumeric(ROW_5)).toHaveTextContent(T.cn2b_nl_override_not_numeric.en);
    expect(notePinnable(ROW_5)).toBeNull();
    const ev = evidence(ROW_5)[0];
    expect(ev).toHaveAttribute('data-numeric', 'false');
    expect(ev).toHaveAttribute('data-pinnable', 'false');
  });
});

// ==============================================================================================
describe('H1_5_06 — a PROGRAMMATIC useOverride(on=true) fails closed on its own: an override that cannot be pinned changes nothing', () => {
  /**
   * The control is not rendered for such a head, so the only way to run the handler is the closure React
   * attached while the head WAS pinnable — and then the head's content changes underneath it (the same
   * object, the same id, still the cell's current head). The guard must read the head at call time.
   */
  const becomeUnpinnable: ReadonlyArray<readonly [label: string, change: Partial<FieldOverride>]> = [
    ['a 257-character number', { finalValue: JSON.parse(intText(257)), finalValueText: intText(257) }],
    ['an exponent-form text', { finalValue: 1e21, finalValueText: '1e+21' }],
    ['a negative number', { finalValue: -5, finalValueText: '-5' }],
    ['text', { finalValue: 'twelve', finalValueText: '"twelve"' }],
    ['null', { finalValue: null, finalValueText: 'null' }],
  ];

  it.each(becomeUnpinnable)('the head turns into %s: no pin, no state change — not even the open preview closes', async (_label, change) => {
    const head = pg('ovr-head', 'rec-5', '12');
    renderPanel({ overrides: [head] });
    pick(ROW_5);
    fireEvent.change(contribution(ROW_5), { target: { value: '5' } }); // the reviewer's own typed contribution
    fillReasonAndUnit();
    openPreview();
    expect(screen.getByTestId('cn2b-nl-preview')).toBeInTheDocument();
    const handler = onChangeOf(pinBox(ROW_5)!);

    Object.assign(head, change); // no re-render: the markup still carries the old closure
    act(() => handler({ target: { checked: true } }));

    expect(screen.getByTestId('cn2b-nl-preview')).toBeInTheDocument(); // a state change would have closed it
    expect(contribution(ROW_5).value).toBe('5'); // no stand-in quantity, no clearing
    expect(screen.queryByTestId('cn2b-nl-override-applied')).toBeNull();
    confirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0].quantitySources).toEqual([
      { sourceRecordId: 'rec-5', designatedQuantity: '5', appliedOverrideId: null }, // NO pin was made
    ]);
  });

  it('un-ticking is always allowed (the guard applies to on=true only): a pinned head can be released, keeping the typed value', () => {
    renderPanel({ overrides: [pg('ovr-head', 'rec-5', '12.50')] });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    expect(contribution(ROW_5).value).toBe('12.50');
    expect(pinBox(ROW_5)).toBeChecked();
    fireEvent.click(pinBox(ROW_5)!);
    expect(pinBox(ROW_5)).not.toBeChecked();
    expect(contribution(ROW_5).value).toBe('12.50');
    expect(screen.queryByTestId('cn2b-nl-override-applied')).toBeNull();
  });

  it('…and it is allowed even when the head the pin was made on has SINCE become unpinnable (the guard is on=true only): the closure releases the pin, keeps the value, and nothing is reported as stale', () => {
    const head = pg('ovr-head', 'rec-5', '12');
    renderPanel({ overrides: [head] });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    expect(contribution(ROW_5).value).toBe('12');
    const untick = onChangeOf(pinBox(ROW_5)!);

    Object.assign(head, { finalValue: JSON.parse(intText(257)), finalValueText: intText(257) }); // no re-render yet
    act(() => untick({ target: { checked: false } }));

    // the pin is released (a refused untick would leave the "applied" note and the checked control behind) …
    expect(screen.queryByTestId('cn2b-nl-override-applied')).toBeNull();
    expect(notePinnable(ROW_5)).not.toBeNull(); // the row now shows the truth about the head: a number that cannot be used
    expect(pinBox(ROW_5)).toBeNull();
    // … what was in the box stays, and this was the person's own act, not a stale clearing
    expect(contribution(ROW_5).value).toBe('12');
    expect(screen.queryByTestId('cn2b-nl-stale-pins-cleared')).toBeNull();
  });
});

// ==============================================================================================
describe('H1_5_07 (closure level) — the REAL useOverride closure, driven with an override that is NOT the cell\'s current head: no pin, no state change', () => {
  const OLD = pg('ovr-old', 'rec-5', '12', { createdAt: '2026-09-20T10:00:00+00:00' });
  const NEWER_SHORT = pg('ovr-newer-short', 'rec-5', '15', { createdAt: '2026-09-27T10:00:00+00:00' });
  const NEWER_257 = pg('ovr-newer-257', 'rec-5', intText(257), { createdAt: '2026-09-27T10:00:00+00:00' });

  /** The cell is designated, the OLD override is its head (so its control exists), a contribution is typed and a preview is open. */
  function armed() {
    renderPanel({ overrides: [OLD] });
    pick(ROW_5);
    fireEvent.change(contribution(ROW_5), { target: { value: '5' } });
    fillReasonAndUnit();
    openPreview();
    expect(screen.getByTestId('cn2b-nl-preview')).toBeInTheDocument();
    return onChangeOf(pinBox(ROW_5)!); // the very closure a click on the older override's control would run
  }
  const expectNothingHappened = async () => {
    expect(screen.getByTestId('cn2b-nl-preview')).toBeInTheDocument(); // a state change would have closed it
    expect(contribution(ROW_5).value).toBe('5');
    expect(screen.queryByTestId('cn2b-nl-override-applied')).toBeNull();
    confirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0].quantitySources).toEqual([{ sourceRecordId: 'rec-5', designatedQuantity: '5', appliedOverrideId: null }]);
  };

  it('a NEWER pinnable head has arrived since: the older override cannot be pinned', async () => {
    const run = armed();
    liveHeads.last!.set('rec-5', NEWER_SHORT);
    act(() => run({ target: { checked: true } }));
    await expectNothingHappened();
  });

  it('a NEWER UNPINNABLE head has arrived since: the older pinnable override is not substituted for it', async () => {
    const run = armed();
    liveHeads.last!.set('rec-5', NEWER_257);
    act(() => run({ target: { checked: true } }));
    await expectNothingHappened();
  });

  it('the cell has no head any more: nothing to pin', async () => {
    const run = armed();
    liveHeads.last!.delete('rec-5');
    act(() => run({ target: { checked: true } }));
    await expectNothingHappened();
  });

  it('ANOTHER record\'s override sits under this record\'s key: it is not this cell\'s head either', async () => {
    const run = armed();
    liveHeads.last!.set('rec-5', pg('ovr-6', 'rec-6', '7', { targetEntity: ROW_6 }));
    act(() => run({ target: { checked: true } }));
    await expectNothingHappened();
  });
});

// ==============================================================================================
describe('H1_5_07 / H1_5_11 — only the exact CURRENT head can ever be pinned; no older, convenient or foreign override is substituted', () => {
  const NEW_257 = pg('ovr-new-257', 'rec-5', intText(257), { createdAt: '2026-09-27T10:00:00+00:00' });
  const OLD_PINNABLE = pg('ovr-old', 'rec-5', '12', { createdAt: '2026-09-20T10:00:00+00:00' });
  const NEW_SHORT = pg('ovr-new-short', 'rec-5', '15', { createdAt: '2026-09-27T10:00:00+00:00' });
  const OLD_257 = pg('ovr-old-257', 'rec-5', intText(257), { createdAt: '2026-09-20T10:00:00+00:00' });
  const OTHER_RECORD = pg('ovr-other', 'rec-6', '7');

  describe('the gate (what useOverride, the control and the stale check all ask)', () => {
    it('an OLDER pinnable override behind a newer unpinnable head → null; the unpinnable head itself → null', () => {
      const heads = overrideHeads([NEW_257, OLD_PINNABLE]); // server order: newest first
      expect(pinnableLexemeOf(heads, 'rec-5', 'ovr-old')).toBeNull();
      expect(pinnableLexemeOf(heads, 'rec-5', 'ovr-new-257')).toBeNull();
    });

    it('a pinnable newest head → its exact lexeme; an older unpinnable one behind it changes nothing, and is itself never pinnable', () => {
      const heads = overrideHeads([NEW_SHORT, OLD_257]);
      expect(pinnableLexemeOf(heads, 'rec-5', 'ovr-new-short')).toBe('15');
      expect(pinnableLexemeOf(heads, 'rec-5', 'ovr-old-257')).toBeNull();
    });

    it('another record\'s head, an unknown record and an unknown id → null', () => {
      const heads = overrideHeads([NEW_SHORT, OTHER_RECORD]);
      expect(pinnableLexemeOf(heads, 'rec-5', 'ovr-other')).toBeNull(); // rec-6's override cannot be pinned onto rec-5
      expect(pinnableLexemeOf(heads, 'rec-6', 'ovr-new-short')).toBeNull(); // nor rec-5's onto rec-6
      expect(pinnableLexemeOf(heads, 'rec-404', 'ovr-new-short')).toBeNull();
      expect(pinnableLexemeOf(heads, 'rec-5', 'no-such-override')).toBeNull();
      expect(pinnableLexemeOf(new Map(), 'rec-5', 'ovr-new-short')).toBeNull();
    });

    it('the lexeme is the canonical helper\'s, byte for byte (the exact PostgreSQL text — never a JS rendering, never trimmed)', () => {
      for (const [, text] of PINNABLE) {
        const head = pg('ovr-h', 'rec-5', text);
        expect(pinnableLexemeOf(overrideHeads([head]), 'rec-5', 'ovr-h')).toBe(text);
        expect(pinnableLexemeOf(overrideHeads([head]), 'rec-5', 'ovr-h')).toBe(numericOverrideLexeme(head));
      }
      expect(pinnableLexemeOf(overrideHeads([pg('ovr-h', 'rec-5', '12.50')]), 'rec-5', 'ovr-h')).not.toBe('12.5');
      for (const [, text] of NUMERIC_BUT_UNPINNABLE) {
        expect(pinnableLexemeOf(overrideHeads([pg('ovr-h', 'rec-5', text)]), 'rec-5', 'ovr-h')).toBeNull();
      }
    });
  });

  describe('through the panel', () => {
    it('H1_5_11 — a current unpinnable head with an older pinnable override behind it: exactly ONE evidence row (the head), no control, the older value is shown nowhere and never substituted', () => {
      renderPanel({ overrides: [NEW_257, OLD_PINNABLE] });
      pick(ROW_5);
      const ev = evidence(ROW_5);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toHaveAttribute('data-override-id', 'ovr-new-257');
      expect(ev[0]).toHaveAttribute('data-pinnable', 'false');
      expect(pinBox(ROW_5)).toBeNull();
      expect(within(candidateFor(ROW_5)).queryByText('reason for ovr-old', { exact: false })).toBeNull();
      expect(contribution(ROW_5).value).toBe(''); // nothing was suggested from the older override
    });

    it('H1_5_11 — the chain order is the server\'s: the SAME two overrides the other way round (pinnable newest) DO give a control, bound to the newest only', async () => {
      renderPanel({ overrides: [NEW_SHORT, OLD_257] });
      pick(ROW_5);
      expect(evidence(ROW_5)).toHaveLength(1);
      expect(evidence(ROW_5)[0]).toHaveAttribute('data-override-id', 'ovr-new-short');
      fireEvent.click(pinBox(ROW_5)!);
      expect(contribution(ROW_5).value).toBe('15');
      fillReasonAndUnit();
      openPreview();
      confirm();
      await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
      expect(setNeedLine.mock.calls[0][0].quantitySources).toEqual([
        { sourceRecordId: 'rec-5', designatedQuantity: '15', appliedOverrideId: 'ovr-new-short' },
      ]);
    });

    it('H1_5_07 — another record\'s pinnable head is not offered to this cell (a cell with no head of its own has no evidence and no control)', () => {
      renderPanel({ overrides: [OTHER_RECORD] });
      pick(ROW_5);
      expect(within(candidateFor(ROW_5)).queryByTestId('cn2b-nl-override-evidence')).toBeNull();
      expect(pinBox(ROW_5)).toBeNull();
      expect(contribution(ROW_5).value).toBe('');
    });

    it('H1_5_11 — the order is the SERVER\'s, not the client\'s: a chain whose array order contradicts createdAt AND id still has its FIRST row as the head (no client re-sort)', () => {
      // A chain the server would never send (it sends created_at DESC, id DESC) — which is exactly what makes it a proof:
      // the panel must take the first row of the array as the head, whatever the timestamps and ids say.
      const pinnableFirst = [
        pg('ovr-z', 'rec-5', '12', { createdAt: '2026-09-20T10:00:00+00:00' }), // first = the head, though OLDER and with the greatest id
        pg('ovr-a', 'rec-5', intText(257), { createdAt: '2026-09-27T10:00:00+00:00' }), // later createdAt, smallest id, listed second
      ];
      const unpinnableFirst = [
        pg('ovr-a', 'rec-5', intText(257), { createdAt: '2026-09-20T10:00:00+00:00' }), // first = the head
        pg('ovr-z', 'rec-5', '12', { createdAt: '2026-09-27T10:00:00+00:00' }),
      ];
      const a = renderPanel({ overrides: pinnableFirst });
      pick(ROW_5);
      expect(evidence(ROW_5)).toHaveLength(1);
      expect(evidence(ROW_5)[0]).toHaveAttribute('data-override-id', 'ovr-z');
      expect(pinBox(ROW_5)).not.toBeNull(); // a client re-sort (by createdAt desc, or id asc) would have made the 257-character row the head
      a.unmount();
      renderPanel({ overrides: unpinnableFirst });
      pick(ROW_5);
      expect(evidence(ROW_5)).toHaveLength(1);
      expect(evidence(ROW_5)[0]).toHaveAttribute('data-override-id', 'ovr-a');
      expect(pinBox(ROW_5)).toBeNull(); // a client re-sort (by createdAt desc, or id desc) would have promoted the pinnable row
      expect(notePinnable(ROW_5)).not.toBeNull();
    });
  });
});

// ==============================================================================================
describe('H1_5_08 / H1_5_09 / H1_5_14 — a PINNABLE head still pins and saves through the existing setNeedLine, with EXACTLY the canonical lexeme and the exact current head id', () => {
  it.each(PINNABLE)('%s', async (_label, text) => {
    const head = pg('ovr-head', 'rec-5', text);
    const older = pg('ovr-old', 'rec-5', '9', { createdAt: '2026-09-20T10:00:00+00:00' });
    const lexeme = numericOverrideLexeme(head);
    expect(lexeme).toBe(text);
    renderPanel({ overrides: [head, older] }); // newest first: ovr-head is the cell's current head
    pick(ROW_5);
    expect(evidence(ROW_5)).toHaveLength(1); // the older override is not even offered
    expect(evidence(ROW_5)[0]).toHaveAttribute('data-pinnable', 'true');
    fireEvent.change(contribution(ROW_5), { target: { value: '5' } }); // something typed first: the pin REPLACES it with the lexeme
    fireEvent.click(pinBox(ROW_5)!);
    expect(contribution(ROW_5).value).toBe(lexeme); // H1_5_08 — what the panel shows IS the lexeme
    expect(screen.getByTestId('cn2b-nl-override-applied')).toBeInTheDocument();
    fillReasonAndUnit();
    expect(saveButton()).toBeEnabled();
    openPreview();
    confirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    const sent = setNeedLine.mock.calls[0][0];
    expect(sent.quantitySources).toEqual([{ sourceRecordId: 'rec-5', designatedQuantity: lexeme, appliedOverrideId: 'ovr-head' }]); // H1_5_08 + H1_5_09
    expect(sent.quantitySources[0].designatedQuantity).toHaveLength(text.length);
    expect(sent.quantitySources[0].appliedOverrideId).not.toBe('ovr-old');
    expect(sent.approvedQuantity).toBe(lexeme);
  });

  it('H1_5_09 — each of two cells is pinned to its OWN current head', async () => {
    renderPanel({
      records: [record('rec-5', ROW_5, 'qty', envelope('12 boxes'), 1), record('rec-6', ROW_6, 'qty', envelope('40 boxes'), 2)],
      overrides: [
        pg('ovr-6', 'rec-6', '7', { targetEntity: ROW_6 }),
        pg('ovr-5', 'rec-5', '3'),
      ],
    });
    pick(ROW_5); pick(ROW_6);
    fireEvent.click(pinBox(ROW_5)!);
    fireEvent.click(pinBox(ROW_6)!);
    expect(contribution(ROW_5).value).toBe('3');
    expect(contribution(ROW_6).value).toBe('7');
    fillReasonAndUnit();
    openPreview();
    confirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalled());
    const sources = setNeedLine.mock.calls.flatMap((c) => c[0].quantitySources as Array<{ sourceRecordId: string; designatedQuantity: string; appliedOverrideId: string }>);
    expect(sources.sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId))).toEqual([
      { sourceRecordId: 'rec-5', designatedQuantity: '3', appliedOverrideId: 'ovr-5' },
      { sourceRecordId: 'rec-6', designatedQuantity: '7', appliedOverrideId: 'ovr-6' },
    ]);
  });
});

// ==============================================================================================
describe('H1_5_15 — a stale/local pin whose head has become unpinnable is never a valid pin: cleared visibly with its value, Save unavailable, nothing reaches a write', () => {
  it('the pin was made on a pinnable head; the SAME head (same id, still current) is now unpinnable → the existing stale path clears it, no fallback quantity, no write', async () => {
    const { rerenderWith } = renderPanel({ overrides: [pg('ovr-a', 'rec-5', '12')] });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    expect(contribution(ROW_5).value).toBe('12');
    fillReasonAndUnit();
    expect(saveButton()).toBeEnabled();
    openPreview();
    expect(screen.getByTestId('cn2b-nl-preview')).toBeInTheDocument();

    // The local state now references the current override id, but that override can no longer be pinned.
    rerenderWith({ overrides: [pg('ovr-a', 'rec-5', intText(257))] });

    await waitFor(() => expect(screen.getByTestId('cn2b-nl-stale-pins-cleared')).toBeInTheDocument());
    expect(screen.getByTestId('cn2b-nl-stale-pins-cleared')).toHaveTextContent('1');
    expect(within(candidateFor(ROW_5)).getByTestId('cn2b-nl-stale-pin')).toBeInTheDocument();
    expect(contribution(ROW_5).value).toBe(''); // the pin's value went with it: NOTHING is substituted
    expect(screen.queryByTestId('cn2b-nl-preview')).toBeNull(); // the open preview carried the pin: it is closed
    expect(screen.queryByRole('button', { name: T.cn2b_nl_bulk_confirm.en })).toBeNull();
    expect(saveButton()).toBeDisabled();
    expect(screen.queryByTestId('cn2b-nl-override-applied')).toBeNull();
    expect(pinBox(ROW_5)).toBeNull();
    expect(notePinnable(ROW_5)).not.toBeNull(); // and the row says why
    expect(evidence(ROW_5)[0]).toHaveAttribute('data-pinnable', 'false');

    openPreview(); // a click on the disabled control cannot open anything
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByTestId('cn2b-nl-preview')).toBeNull();
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('once the pin has been cleared, the only blocker left is the blank contribution — nothing is inherited — and what the person types afterwards is theirs alone (no pin is attached)', async () => {
    const { rerenderWith } = renderPanel({ overrides: [pg('ovr-a', 'rec-5', '12')] });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    fillReasonAndUnit();
    rerenderWith({ overrides: [pg('ovr-a', 'rec-5', fracText(257))] });
    await waitFor(() => expect(screen.getByTestId('cn2b-nl-stale-pins-cleared')).toBeInTheDocument());
    expect(blockers()).toContain('cn2b_nl_block_quantity'); // the blank contribution, not an inherited value
    // A typed value is an explicit human act with NO pin: the write plan carries appliedOverrideId null.
    fireEvent.change(contribution(ROW_5), { target: { value: '4' } });
    expect(saveButton()).toBeEnabled();
    openPreview();
    confirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0].quantitySources).toEqual([
      { sourceRecordId: 'rec-5', designatedQuantity: '4', appliedOverrideId: null },
    ]);
  });

  it('a pin on a head that is STILL pinnable is untouched by the reconciliation (no spurious clearing)', async () => {
    const { rerenderWith } = renderPanel({ overrides: [pg('ovr-a', 'rec-5', '12')] });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    fillReasonAndUnit();
    rerenderWith({ overrides: [pg('ovr-a', 'rec-5', '12')] }); // the chain was re-read: same head, equal content
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByTestId('cn2b-nl-stale-pins-cleared')).toBeNull();
    expect(pinBox(ROW_5)).toBeChecked();
    expect(contribution(ROW_5).value).toBe('12');
    expect(saveButton()).toBeEnabled();
  });

  /**
   * NOTE on the two tests above. Override rows are append-only on the server, so a given id never changes its value: the
   * "same id, now unpinnable" swap is a SYNTHETIC state — a fail-closed proof of the new half of the stale predicate, not
   * something real data can produce. The state real data CAN produce is the next one: a pin held on the then-current head,
   * and a chain re-read whose new head is unpinnable.
   */
  it('REALISTIC — a pin on the then-current head, then a chain re-read whose NEW head is a 257-character number: the pin is cleared with its value, the row shows the new head as evidence only (note, no control), Save is unavailable, and a stale closure cannot re-pin the older override', async () => {
    const OLD = pg('ovr-old', 'rec-5', '12', { createdAt: '2026-09-20T10:00:00+00:00' });
    const NEW_257 = pg('ovr-new-257', 'rec-5', intText(257), { createdAt: '2026-09-27T10:00:00+00:00' });
    const { rerenderWith } = renderPanel({ overrides: [OLD] });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    expect(contribution(ROW_5).value).toBe('12');
    fillReasonAndUnit();
    const staleClosure = onChangeOf(pinBox(ROW_5)!); // the closure from BEFORE the chain changed (taken before the preview, which lists the pinned cell too)
    openPreview();

    rerenderWith({ overrides: [NEW_257, OLD] }); // server order: the new head first

    await waitFor(() => expect(screen.getByTestId('cn2b-nl-stale-pins-cleared')).toBeInTheDocument());
    expect(within(candidateFor(ROW_5)).getByTestId('cn2b-nl-stale-pin')).toHaveTextContent(T.cn2b_nl_stale_pin_row.en); // here the wording is literally true
    expect(contribution(ROW_5).value).toBe('');
    expect(evidence(ROW_5)).toHaveLength(1);
    expect(evidence(ROW_5)[0]).toHaveAttribute('data-override-id', 'ovr-new-257');
    expect(evidence(ROW_5)[0]).toHaveAttribute('data-pinnable', 'false');
    expect(evidence(ROW_5)[0]).toHaveTextContent(intText(257));
    expect(pinBox(ROW_5)).toBeNull();
    expect(notePinnable(ROW_5)).toHaveTextContent(T.cn2b_nl_override_not_pinnable.en);
    expect(saveButton()).toBeDisabled();
    expect(screen.queryByTestId('cn2b-nl-preview')).toBeNull();

    // A stale closure runs the older override's control after the fact: whatever it sets is reconciled away again.
    act(() => staleClosure({ target: { checked: true } }));
    await waitFor(() => expect(screen.getByTestId('cn2b-nl-stale-pins-cleared')).toBeInTheDocument());
    expect(contribution(ROW_5).value).toBe('');
    expect(screen.queryByTestId('cn2b-nl-override-applied')).toBeNull();
    expect(saveButton()).toBeDisabled();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('REALISTIC — … and when the new head is PINNABLE the pin is cleared and never re-pointed: the person must choose the new head themselves', async () => {
    const OLD = pg('ovr-old', 'rec-5', '12', { createdAt: '2026-09-20T10:00:00+00:00' });
    const NEW_SHORT = pg('ovr-new-short', 'rec-5', '15', { createdAt: '2026-09-27T10:00:00+00:00' });
    const { rerenderWith } = renderPanel({ overrides: [OLD] });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    fillReasonAndUnit();
    rerenderWith({ overrides: [NEW_SHORT, OLD] });
    await waitFor(() => expect(screen.getByTestId('cn2b-nl-stale-pins-cleared')).toBeInTheDocument());
    expect(contribution(ROW_5).value).toBe('');
    expect(pinBox(ROW_5)).not.toBeChecked();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(pinBox(ROW_5)!); // an explicit choice of the CURRENT head
    expect(contribution(ROW_5).value).toBe('15');
    openPreview();
    confirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0].quantitySources).toEqual([{ sourceRecordId: 'rec-5', designatedQuantity: '15', appliedOverrideId: 'ovr-new-short' }]);
  });

  it('with TWO pinned cells only the pin that cannot be pinned is cleared: the other keeps its pin and its lexeme, and the write carries one pin and one hand-typed value', async () => {
    const records = [record('rec-5', ROW_5, 'qty', envelope('12 boxes'), 1), record('rec-6', ROW_6, 'qty', envelope('40 boxes'), 2)];
    const ov5 = pg('ovr-5', 'rec-5', '3');
    const { rerenderWith } = renderPanel({ records, overrides: [pg('ovr-6', 'rec-6', '7', { targetEntity: ROW_6 }), ov5] });
    pick(ROW_5); pick(ROW_6);
    fireEvent.click(pinBox(ROW_5)!);
    fireEvent.click(pinBox(ROW_6)!);
    expect([contribution(ROW_5).value, contribution(ROW_6).value]).toEqual(['3', '7']);
    fillReasonAndUnit();

    rerenderWith({ records, overrides: [pg('ovr-6', 'rec-6', intText(257), { targetEntity: ROW_6 }), ov5] }); // only rec-6's head can no longer be pinned
    await waitFor(() => expect(screen.getByTestId('cn2b-nl-stale-pins-cleared')).toHaveTextContent('1'));
    expect(pinBox(ROW_5)).toBeChecked(); // untouched
    expect(contribution(ROW_5).value).toBe('3');
    expect(contribution(ROW_6).value).toBe(''); // cleared with its value
    expect(pinBox(ROW_6)).toBeNull();
    expect(within(candidateFor(ROW_6)).queryByTestId('cn2b-nl-stale-pin')).not.toBeNull();
    expect(within(candidateFor(ROW_5)).queryByTestId('cn2b-nl-stale-pin')).toBeNull();

    fireEvent.change(contribution(ROW_6), { target: { value: '4' } });
    openPreview();
    confirm();
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    const sources = setNeedLine.mock.calls[0][0].quantitySources as Array<{ sourceRecordId: string }>;
    expect(sources.slice().sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId))).toEqual([
      { sourceRecordId: 'rec-5', designatedQuantity: '3', appliedOverrideId: 'ovr-5' },
      { sourceRecordId: 'rec-6', designatedQuantity: '4', appliedOverrideId: null },
    ]);
  });

  it('while the override chain is NOT readable the stale reconciliation is suspended (nothing is saved meanwhile), yet a pin on a head that has become unpinnable is still never presented as "applied"', () => {
    const { rerenderWith } = renderPanel({ overrides: [pg('ovr-a', 'rec-5', '12')] });
    pick(ROW_5);
    fireEvent.click(pinBox(ROW_5)!);
    fillReasonAndUnit();
    expect(screen.getByTestId('cn2b-nl-override-applied')).toBeInTheDocument();

    rerenderWith({ overrides: [pg('ovr-a', 'rec-5', intText(257))], overrideReadFailure: 'field_overrides_not_loaded' });

    expect(screen.queryByTestId('cn2b-nl-stale-pins-cleared')).toBeNull(); // §13: nothing is reconciled while the chain is unavailable …
    expect(saveButton()).toBeDisabled(); // … saving is withheld instead
    expect(screen.queryByTestId('cn2b-nl-override-applied')).toBeNull(); // HC1.5: no "contribution based on the recorded override" over a head that cannot carry it
    expect(pinBox(ROW_5)).toBeNull();
    expect(notePinnable(ROW_5)).not.toBeNull();
  });
});
