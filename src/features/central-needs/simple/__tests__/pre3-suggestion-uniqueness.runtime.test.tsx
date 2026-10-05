/** @vitest-environment jsdom */
/**
 * PRE3 Run 4 — a one-click material suggestion requires PROVEN uniqueness.
 *
 * End to end through the REAL card, the REAL central-needs service and the REAL
 * shared resolver; only the Supabase client is replaced, by an in-memory
 * PostgREST stand-in that behaves like the server where it matters: every
 * filter first (`eq`, `or` with match/imatch/ilike/eq terms), then the order,
 * then the limit; `count=exact` over the filtered rows; an optional db-max-rows
 * cap; and every RPC recorded — so "no write before [Correct]" is checked at the
 * wire, not on a mock of the service.
 *
 * The defect this closes: the suggestion used to be decided inside a capped,
 * alphabetical search window (10 rows ordered by name), so a second exact item
 * past the cut was invisible and ONE suggestion was offered where the rule
 * requires a choice. Scenario 3 reproduces exactly that catalog and first shows
 * the old window really does see only one exact item.
 */
import '@testing-library/jest-dom/vitest';
import { useLayoutEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { T } from '@/shared/i18n/strings';
import type { SourceRecord } from '../../central-needs.service';

type Row = Record<string, unknown>;
const U = (...cps: number[]): string => String.fromCodePoint(...cps);

// ───────────────────────────── the PostgREST stand-in ─────────────────────────────
const db: { central_items: Row[] } = { central_items: [] };
const requests: Array<{ table: string; ops: Array<[string, ...unknown[]]> }> = [];
const rpcs: Array<{ name: string; params: unknown }> = [];
const server = {
  maxRows: null as number | null,
  failing: false,
  /** When set, every read of central_items waits for this promise (stale-reply tests). */
  gate: null as null | ((ops: Array<[string, ...unknown[]]>) => Promise<void> | null),
};

function splitOr(expr: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (quoted && ch === '\\') { current += ch + expr[i + 1]; i += 1; continue; }
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts;
}
const unquote = (v: string) => (v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/gs, '$1') : v);
const escapeRe = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function ilike(value: unknown, pattern: string): boolean {
  if (typeof value !== 'string') return false;
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) { i += 1; re += escapeRe(pattern[i]); continue; }
    if (ch === '%' || ch === '*') re += '.*';
    else if (ch === '_') re += '.';
    else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`, 'isu').test(value);
}
function orTerm(part: string): (row: Row) => boolean {
  const m = /^([a-z_]+)\.(eq|ilike|imatch|match)\.(.*)$/s.exec(part);
  if (!m) throw new Error(`unsupported or() term: ${part}`);
  const [, col, op, raw] = m;
  if (op === 'eq') { const v = unquote(raw); return (r) => typeof r[col] === 'string' && r[col] === v; }
  if (op === 'ilike') {
    const pattern = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1') : raw;
    return (r) => ilike(r[col], pattern);
  }
  // PostgREST match = PostgreSQL ~ (case-sensitive), imatch = ~* ; JS non-unicode RegExp reads the emitted subset alike.
  const re = new RegExp(unquote(raw), op === 'imatch' ? 'i' : '');
  return (r) => typeof r[col] === 'string' && re.test(r[col] as string);
}

class FakeQuery implements PromiseLike<{ data: Row[] | null; error: unknown; count: number | null }> {
  private filters: Array<(row: Row) => boolean> = [];
  private orders: string[] = [];
  private max: number | null = null;
  private wantCount = false;
  private readonly rec: { table: string; ops: Array<[string, ...unknown[]]> };
  constructor(table: string) { this.rec = { table, ops: [] }; requests.push(this.rec); }
  select(cols: string, opts?: { count?: string }) { this.rec.ops.push(['select', cols, opts?.count ?? null]); this.wantCount = opts?.count === 'exact'; return this; }
  eq(col: string, value: unknown) { this.rec.ops.push(['eq', col, value]); this.filters.push((r) => String(r[col]) === String(value)); return this; }
  or(expr: string) { this.rec.ops.push(['or', expr]); const t = splitOr(expr).map(orTerm); this.filters.push((r) => t.some((c) => c(r))); return this; }
  order(col: string) { this.rec.ops.push(['order', col]); this.orders.push(col); return this; }
  limit(n: number) { this.rec.ops.push(['limit', n]); this.max = n; return this; }
  abortSignal() { return this; }
  private async resolve() {
    const gate = server.gate?.(this.rec.ops) ?? null;
    if (gate) await gate;
    if (server.failing) return { data: null, error: { message: 'boom', code: 'XX000' }, count: null };
    let rows = db.central_items.filter((r) => this.filters.every((f) => f(r)));
    const count = rows.length;
    rows = [...rows].sort((a, b) => {
      for (const col of this.orders) if (a[col] !== b[col]) return String(a[col]) < String(b[col]) ? -1 : 1;
      return 0;
    });
    if (this.max !== null) rows = rows.slice(0, this.max);
    if (server.maxRows !== null) rows = rows.slice(0, server.maxRows);
    return { data: rows.map((r) => ({ ...r })), error: null, count: this.wantCount ? count : null };
  }
  then<A = { data: Row[] | null; error: unknown; count: number | null }, B = never>(
    ok?: ((v: { data: Row[] | null; error: unknown; count: number | null }) => A | PromiseLike<A>) | null,
    ko?: ((r: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.resolve().then(ok, ko);
  }
}

vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    from: (table: string) => new FakeQuery(table),
    rpc: async (name: string, params: unknown) => { rpcs.push({ name, params }); return { data: null, error: null }; },
  },
  supabaseConfigured: true,
}));

const { SimpleMaterialCard } = await import('../SimpleMaterialCard');
const service = await import('../../central-needs.service');
const { EXACT_CANDIDATE_CAP } = await import('@/shared/materials/material-resolver.service');

function reset() {
  db.central_items = [];
  requests.length = 0;
  rpcs.length = 0;
  server.maxRows = null;
  server.failing = false;
  server.gate = null;
}
beforeEach(reset);
afterEach(() => { cleanup(); reset(); });

// ───────────────────────────── fixtures and helpers ─────────────────────────────
let seq = 0;
const item = (over: Row): Row => {
  seq += 1;
  return {
    id: `ci-${String(seq).padStart(4, '0')}`, name: 'Unnamed', name_ar: null, trade_name: null, barcode: null,
    unit: 'tablet', concentration: null, dosage_form: null, status: 'active', ...over,
  };
};
const rec = (value: string, fieldName = 'ITEMS'): SourceRecord => ({
  id: `r-${fieldName}`, importSessionId: 's1', recordOrdinal: 1, targetEntity: 'sheet:0:row:8', fieldName,
  sourceValues: { value }, sourceProvenance: { sheetIndex: 0, coordinate: { col: 1 } },
});

function renderCard(evidence: string) {
  const onResolved = vi.fn();
  const view = render(
    <SimpleMaterialCard lang="en" importSessionId="s1" editable targetEntity="sheet:0:row:8" fields={[rec(evidence)]} onResolved={onResolved} />,
  );
  return { ...view, onResolved, card: screen.getByTestId('cn2b-simple-material-card') };
}

/** The exact-candidate requests (count=exact reads of central_items). */
const exactReads = () => requests.filter((r) => r.table === 'central_items' && r.ops.some((o) => o[0] === 'select' && o[2] === 'exact'));

/** Waits until the card's uniqueness check has been asked AND answered. */
async function settled(expectedReads = 4) {
  await waitFor(() => expect(exactReads().length).toBeGreaterThanOrEqual(expectedReads));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const suggestionOf = (card: HTMLElement) => within(card).queryByTestId('cn2b-simple-material-suggestion');
const correctButton = (card: HTMLElement) => within(card).queryByRole('button', { name: T.cn2b_simple_correct.en });
const multiple = (card: HTMLElement) => within(card).queryByTestId('cn2b-simple-material-multiple-matches');
const unconfirmed = (card: HTMLElement) => within(card).queryByTestId('cn2b-simple-material-suggestion-unconfirmed');

/** A choice, never a suggestion: no suggestion, no [Correct], the multiple-matches note, nothing written. */
function expectChoice(card: HTMLElement) {
  expect(suggestionOf(card)).toBeNull();
  expect(correctButton(card)).toBeNull();
  expect(multiple(card)).toBeInTheDocument();
  expect(rpcs).toEqual([]);
}

// Nine active combination products that sort BEFORE 'Paracetamol' and contain its name.
const combos = () => ['Codeine', 'Caffeine', 'Chlorphenamine', 'Diphenhydramine', 'Ibuprofen', 'Orphenadrine', 'Phenylephrine', 'Pseudoephedrine', 'Aspirin']
  .map((other, i) => item({ name: `Paracetamol + ${other}`.replace('Paracetamol + Aspirin', 'Aspirin + Paracetamol'), name_ar: `باراسيتامول مع ${i}` }))
  .map((r) => ({ ...r, name: `A${r.name}` }));

// ─────────────────────────────────────── tests ───────────────────────────────────────
describe('PRE3 Run 4 — exactly one PROVEN exact candidate is a suggestion, and nothing is written before [Correct]', () => {
  it('one exact candidate among many partial ones → one suggestion; the write happens only on [Correct]', async () => {
    const para = item({ name: 'Paracetamol', name_ar: 'باراسيتامول', concentration: '500 mg', dosage_form: 'Tablet', barcode: '6291000000028' });
    db.central_items = [...combos(), para, item({ name: 'Paracetamol 500 mg Syrup' }), item({ name: 'Zinc', name_ar: 'باراسيتامول ٥٠٠' })];
    const { card, onResolved } = renderCard('باراسيتامول');
    await settled();
    expect(suggestionOf(card)).toHaveTextContent('Paracetamol');
    expect(within(card).getByTestId('cn2b-simple-material-facts')).toHaveTextContent('500 mg');
    expect(unconfirmed(card)).toBeNull();
    expect(rpcs).toEqual([]);

    // "Choose another" is not a decision either.
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_choose_another_material.en }));
    expect(rpcs).toEqual([]);
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_cancel.en }));

    fireEvent.click(correctButton(card) as HTMLElement);
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(rpcs).toEqual([{
      name: 'phoenix_central_needs_set_record_disposition',
      params: { p_import_session_id: 's1', p_target_entity: 'sheet:0:row:8', p_decision: 'mapped', p_central_item_id: para.id, p_decision_reason: null },
    }]);
  });

  it('two exact candidates → a choice, not a suggestion', async () => {
    db.central_items = [
      item({ name: 'Amoxicillin', concentration: '500 mg', dosage_form: 'Capsule' }),
      item({ name: 'Amoxicillin', concentration: '250 mg/5 ml', dosage_form: 'Suspension' }),
    ];
    const { card } = renderCard('Amoxicillin');
    await settled();
    expectChoice(card);
  });

  it('the reviewer’s catalog: the second exact item sorts outside the old 10-row window → a choice, not one suggestion', async () => {
    const tab = item({ name: 'Paracetamol', name_ar: 'باراسيتامول', concentration: '500 mg', dosage_form: 'Tablet' });
    const syr = item({ name: 'Paracetamol Syrup', name_ar: 'باراسيتامول', concentration: '120 mg/5 ml', dosage_form: 'Syrup' });
    db.central_items = [...combos(), tab, syr];
    // The old decision: the first 10 rows (ordered by name) of the general search, filtered by the exact rule.
    const window = await service.searchCentralItems('باراسيتامول', 10);
    expect(window).toHaveLength(10);
    expect(window.filter((o) => service.centralItemExactlyNames(o, 'باراسيتامول')).map((o) => o.id)).toEqual([tab.id]);
    requests.length = 0;

    const { card } = renderCard('باراسيتامول');
    await settled();
    expectChoice(card);
  });

  it('a second exact candidate beyond the picker cap (25) → no single suggestion', async () => {
    const partials = Array.from({ length: 30 }, (_, i) => item({ name: `Ibuprofen ${String(i).padStart(2, '0')} combination` }));
    db.central_items = [...partials, item({ name: 'Ibuprofen', concentration: '400 mg' }), item({ name: 'zz other', trade_name: 'IBUPROFEN' })];
    const { card } = renderCard('Ibuprofen');
    await settled();
    expectChoice(card);
  });

  it('many partial candidates around ONE exact candidate are never counted: still one suggestion', async () => {
    db.central_items = [
      ...Array.from({ length: 15 }, (_, i) => item({ name: `Cefixime ${i} mg` })),
      item({ name: 'Cefixime', concentration: '400 mg' }),
      ...Array.from({ length: 15 }, (_, i) => item({ name: `Cefixime + Clavulanate ${i}`, trade_name: `Cefix ${i}` })),
      item({ name: 'Cefiximes' }), item({ name: 'Cefixim' }), item({ name: 'X', name_ar: 'سيفكسيم' }),
    ];
    const { card } = renderCard('Cefixime');
    await settled();
    expect(suggestionOf(card)).toHaveTextContent('Cefixime');
    expect(multiple(card)).toBeNull();
  });

  it('fuzzy-only results (prefix, partial, longer names) → no suggestion and no false "multiple" or "unconfirmed" note', async () => {
    db.central_items = [item({ name: 'Paracetamol 500 mg' }), item({ name: 'Paracetamol Syrup' }), item({ name: 'Paracetamo' }), item({ name: 'Co-Paracetamol' })];
    const { card } = renderCard('Paracetamol');
    await settled();
    expect(suggestionOf(card)).toBeNull();
    expect(multiple(card)).toBeNull();
    expect(unconfirmed(card)).toBeNull();
  });
});

describe('PRE3 Run 4 — unknown completeness is NO suggestion', () => {
  it('a truncated server set (more than the cap) → no suggestion, and the card says it could not confirm one', async () => {
    db.central_items = [
      item({ name: 'Paracetamol' }),
      // Rows the server cannot mirror are fetched whatever they say — here enough of them to pass the cap.
      ...Array.from({ length: EXACT_CANDIDATE_CAP + 1 }, (_, i) => item({ name: `Legacy ${i}`, name_ar: `${U(0xfe8d)}${i}` })),
    ];
    const { card } = renderCard('Paracetamol');
    await settled();
    expect(suggestionOf(card)).toBeNull();
    expect(correctButton(card)).toBeNull();
    expect(unconfirmed(card)).toHaveTextContent(T.cn2b_simple_material_suggestion_unconfirmed.en);
  });

  it('a server that silently caps rows below the exact count (db-max-rows) → no suggestion', async () => {
    db.central_items = [item({ name: 'Paracetamol' }), item({ name: 'x', name_ar: 'y', trade_name: 'z' })];
    server.maxRows = 0;
    const { card } = renderCard('Paracetamol');
    await settled();
    expect(suggestionOf(card)).toBeNull();
    expect(unconfirmed(card)).toBeInTheDocument();
  });

  it('a failed check → no suggestion, an honest note, and nothing written', async () => {
    db.central_items = [item({ name: 'Paracetamol' })];
    server.failing = true;
    const { card } = renderCard('Paracetamol');
    await waitFor(() => expect(unconfirmed(card)).toBeInTheDocument());
    expect(suggestionOf(card)).toBeNull();
    expect(rpcs).toEqual([]);
  });

  it('a row text too long to send proves nothing → no suggestion', async () => {
    const long = 'باراسيتامول '.repeat(60).trim();
    db.central_items = [item({ name: long })];
    const { card } = renderCard(long);
    await waitFor(() => expect(unconfirmed(card)).toBeInTheDocument());
    expect(exactReads()).toHaveLength(0);
    expect(suggestionOf(card)).toBeNull();
  });
});

describe('PRE3 Run 4 — inactive items are never counted or offered', () => {
  it('an inactive exact twin does not turn one suggestion into a choice', async () => {
    const active = item({ name: 'Ceftriaxone', concentration: '1 g' });
    db.central_items = [active, item({ name: 'Ceftriaxone', concentration: '500 mg', status: 'discontinued' }), item({ name: 'Ceftriaxone', status: 'inactive' })];
    const { card } = renderCard('Ceftriaxone');
    await settled();
    expect(suggestionOf(card)).toHaveTextContent('Ceftriaxone');
    expect(multiple(card)).toBeNull();
    for (const r of exactReads()) expect(r.ops).toContainEqual(['eq', 'status', 'active']);
  });

  it('only inactive exact items → no suggestion', async () => {
    db.central_items = [item({ name: 'Ceftriaxone', status: 'discontinued' })];
    const { card } = renderCard('Ceftriaxone');
    await settled();
    expect(suggestionOf(card)).toBeNull();
    expect(multiple(card)).toBeNull();
  });
});

describe('PRE3 Run 4 — a second exact item is found however it is spelled on the server', () => {
  const twins: Array<[string, string, Row]> = [
    ['an Arabic hamza variant (stored with the hamza, row without)', 'ايبوبروفين', { name: 'B', name_ar: 'إيبوبروفين' }],
    ['an Arabic hamza variant (stored without, row with)', 'إيبوبروفين', { name: 'B', name_ar: 'ايبوبروفين' }],
    ['harakat and tatweel', 'ايبوبروفين', { name: 'B', name_ar: `ا${U(0x064a, 0x0650)}بوبـــروفين` }],
    ['an Arabic presentation form', 'ايبوبروفين', { name: 'B', name_ar: `${U(0xfe8d)}يبوبروفين` }],
    ['a decomposed hamza (alef + combining hamza)', 'إيبوبروفين', { name: 'B', name_ar: `ا${U(0x0655)}يبوبروفين` }],
    ['upper case', 'ibuprofen', { name: 'IBUPROFEN' }],
    ['a no-break space and surrounding whitespace', 'Ibuprofen 400 mg', { name: `${U(0xfeff)} Ibuprofen${U(0xa0)}400 mg${U(0x2028)}` }],
    ['an exotic space the server cannot fold', 'Ibuprofen 400 mg', { name: `Ibuprofen${U(0x3000)}400 mg` }],
    ['a stray mark after a Latin letter', 'Ibuprofen', { name: `Ibuprofen${U(0x064e)}` }],
    ['a fullwidth letter', 'ibuprofen', { name: `${U(0xff29)}buprofen` }],
    ['the trade name', 'Brufen', { name: 'B', trade_name: ' BRUFEN ' }],
    ['the national code', '6291000000099', { name: 'B', barcode: ' 6291000000099 ' }],
  ];
  for (const [label, text, twin] of twins) {
    it(`${label} → a choice`, async () => {
      const first = item({ name: 'A', name_ar: text, trade_name: text, barcode: /^\d+$/.test(text) ? text : null });
      db.central_items = [first, item(twin), ...combos()];
      const { card } = renderCard(text);
      await settled(/^\d+$/.test(text) ? 4 : 4);
      expectChoice(card);
    });
  }
});

describe('PRE3 Run 4 — only the newest check counts', () => {
  /** Holds every exact-candidate read until its text is released ('para' first: "paracetamol" contains "amo"). */
  const gateByText = (releases: Record<string, () => void>) => (ops: Array<[string, ...unknown[]]>) => {
    const or = ops.find((o) => o[0] === 'or')?.[1] as string | undefined;
    const key = or?.includes('[Pp][Aa][Rr]') || or?.includes('Paracetamol') ? 'para'
      : or?.includes('[Xx]') || or?.includes('Amoxicillin') ? 'amox' : null;
    if (!key) return null;
    return new Promise<void>((resolve) => {
      const prev = releases[key];
      releases[key] = () => { prev?.(); resolve(); };
    });
  };

  it('an older reply that lands last never replaces the newer row text’s result', async () => {
    const amox = item({ name: 'Amoxicillin' });
    const para = item({ name: 'Paracetamol' });
    db.central_items = [amox, para];
    const releases: Record<string, () => void> = {};
    server.gate = gateByText(releases);
    const view = render(
      <SimpleMaterialCard lang="en" importSessionId="s1" editable targetEntity="sheet:0:row:8" fields={[rec('Amoxicillin')]} onResolved={vi.fn()} />,
    );
    await waitFor(() => expect(releases.amox).toBeDefined());
    view.rerender(
      <SimpleMaterialCard lang="en" importSessionId="s1" editable targetEntity="sheet:0:row:8" fields={[rec('Paracetamol')]} onResolved={vi.fn()} />,
    );
    await waitFor(() => expect(releases.para).toBeDefined());
    const card = screen.getByTestId('cn2b-simple-material-card');
    await act(async () => { releases.para(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(suggestionOf(card)).toHaveTextContent('Paracetamol'));
    await act(async () => { releases.amox(); await new Promise((r) => setTimeout(r, 10)); });
    expect(suggestionOf(card)).toHaveTextContent('Paracetamol');
    expect(suggestionOf(card)).not.toHaveTextContent('Amoxicillin');
    fireEvent.click(correctButton(card) as HTMLElement);
    await waitFor(() => expect(rpcs).toHaveLength(1));
    expect((rpcs[0].params as { p_central_item_id: string }).p_central_item_id).toBe(para.id);
  });

  it('a new row text never shows the previous text’s suggestion — not even for one committed render', async () => {
    // 'Paracetamol' → 'PARACETAMOL': the same normalized name, but a different verbatim national code. The
    // first check (complete, one match) does NOT answer the second text, which also matches item Z's code.
    const p1 = item({ name: 'Paracetamol' });
    db.central_items = [p1, item({ name: 'zz coded', barcode: 'PARACETAMOL' })];
    let release: (() => void) | null = null;
    /** What the DOM shows at every commit (layout effects run after the DOM update, before any passive effect). */
    const commits: Array<{ evidence: string; suggestion: string | null }> = [];
    function Probe({ text }: { text: string }) {
      useLayoutEffect(() => {
        const card = document.querySelector('[data-testid="cn2b-simple-material-card"]');
        commits.push({
          evidence: card?.querySelector('[data-testid="cn2b-simple-material-evidence"]')?.textContent ?? '',
          suggestion: card?.querySelector('[data-testid="cn2b-simple-material-suggestion"]')?.textContent ?? null,
        });
      });
      return <SimpleMaterialCard lang="en" importSessionId="s1" editable targetEntity="sheet:0:row:8" fields={[rec(text)]} onResolved={vi.fn()} />;
    }
    const view = render(<Probe text="Paracetamol" />);
    const card = () => screen.getByTestId('cn2b-simple-material-card');
    await waitFor(() => expect(suggestionOf(card())).toHaveTextContent('Paracetamol'));
    // Hold every read of the next check until released.
    const held = new Promise<void>((resolve) => { release = resolve; });
    server.gate = () => held;
    commits.length = 0;
    view.rerender(<Probe text="PARACETAMOL" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(commits.some((c) => c.evidence.includes('PARACETAMOL'))).toBe(true);
    for (const c of commits) {
      if (c.evidence.includes('PARACETAMOL')) expect(c.suggestion, JSON.stringify(c)).toBeNull();
    }
    await act(async () => { (release as unknown as () => void)(); await new Promise((r) => setTimeout(r, 0)); });
    // The second text's own (complete) check: name AND national code — a choice.
    await waitFor(() => expect(multiple(card())).toBeInTheDocument());
    expect(suggestionOf(card())).toBeNull();
    expect(rpcs).toEqual([]);
  });

  it('an older reply that lands FIRST is dropped too: nothing is suggested until the newest reply', async () => {
    db.central_items = [item({ name: 'Amoxicillin' }), item({ name: 'Paracetamol' })];
    const releases: Record<string, () => void> = {};
    server.gate = gateByText(releases);
    const view = render(
      <SimpleMaterialCard lang="en" importSessionId="s1" editable targetEntity="sheet:0:row:8" fields={[rec('Amoxicillin')]} onResolved={vi.fn()} />,
    );
    await waitFor(() => expect(releases.amox).toBeDefined());
    view.rerender(
      <SimpleMaterialCard lang="en" importSessionId="s1" editable targetEntity="sheet:0:row:8" fields={[rec('Paracetamol')]} onResolved={vi.fn()} />,
    );
    await waitFor(() => expect(releases.para).toBeDefined());
    const card = screen.getByTestId('cn2b-simple-material-card');
    await act(async () => { releases.amox(); await new Promise((r) => setTimeout(r, 10)); });
    expect(suggestionOf(card)).toBeNull();
    await act(async () => { releases.para(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(suggestionOf(card)).toHaveTextContent('Paracetamol'));
  });
});

describe('PRE3 Run 4 — the picker says when its window is capped', () => {
  const openPicker = (card: HTMLElement) =>
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_choose_material.en }));
  const typeSearch = (card: HTMLElement, value: string) =>
    fireEvent.change(within(card).getByLabelText(T.cn2b_simple_search_material.en), { target: { value } });

  it('26 matching materials: 25 listed and a note that more match', async () => {
    db.central_items = Array.from({ length: 26 }, (_, i) => item({ name: `Vitamin ${String(i).padStart(2, '0')}` }));
    const { card } = renderCard('xx-seed');
    openPicker(card);
    typeSearch(card, 'Vitamin');
    await waitFor(() => expect(within(card).getByTestId('cn2b-simple-material-search-capped')).toHaveTextContent(T.cn2b_material_search_capped.en));
    expect(within(card).getAllByRole('button', { name: /^Vitamin/ })).toHaveLength(25);
  });

  it('25 matching materials: all listed, no note', async () => {
    db.central_items = Array.from({ length: 25 }, (_, i) => item({ name: `Vitamin ${String(i).padStart(2, '0')}` }));
    const { card } = renderCard('xx-seed');
    openPicker(card);
    typeSearch(card, 'Vitamin');
    await waitFor(() => expect(within(card).getAllByRole('button', { name: /^Vitamin/ })).toHaveLength(25));
    expect(within(card).queryByTestId('cn2b-simple-material-search-capped')).toBeNull();
  });
});

describe('PRE3 Run 4 — the two new notes have Arabic and English copy', () => {
  it('cn2b_simple_material_suggestion_unconfirmed and cn2b_material_search_capped', () => {
    for (const key of ['cn2b_simple_material_suggestion_unconfirmed', 'cn2b_material_search_capped']) {
      expect(T[key], key).toBeDefined();
      expect(T[key].ar.trim(), key).not.toBe('');
      expect(T[key].en.trim(), key).not.toBe('');
      expect(T[key].ar, key).toMatch(/[\u0600-\u06FF]/);
      expect(T[key].ar, key).not.toContain('المراجعة');
    }
  });
});
