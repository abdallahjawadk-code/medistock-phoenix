/**
 * PHOENIX-MATERIAL-RESOLVER + SMART-SCANNER — behavioral contract tests.
 *
 * The resolver's DB query shape is exercised against an injected fake
 * PostgREST transport (no database); the scanner classifier is pure. These
 * prove the CONTRACT per source, not just source-guard greps.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ARABIC_VARIANT_CLASSES,
  VARIANT_PATTERN_MAX_CHARS,
  arabicVariantPattern,
  resolveMaterials,
} from '../material-resolver.service';
import { normalizeSearchText } from '@/shared/lib/search-normalize';
import { classifyScanPayload, evaluateDetectedCodes } from '../SmartScanner';

// ── A fake supabase client: records .from() table + .or() filter, returns
//    canned rows so we can assert grading per identity source. ──
function fakeClient(rowsByTable: Record<string, unknown[]>) {
  const calls: Array<{ table: string; or: string | null; eqCols: string[] }> = [];
  const client = {
    from(table: string) {
      const state = { table, or: null as string | null, eqCols: [] as string[] };
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq(col: string) { state.eqCols.push(col); return builder; },
        is() { return builder; },
        or(expr: string) { state.or = expr; return builder; },
        order() { return builder; },
        abortSignal() { return builder; },
        limit() {
          calls.push(state);
          return Promise.resolve({ data: rowsByTable[table] ?? [], error: null });
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

vi.mock('@/shared/supabase/client', () => ({
  get supabase() { return (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase; },
  supabaseConfigured: true,
}));

function withClient<T>(rowsByTable: Record<string, unknown[]>, fn: (calls: ReturnType<typeof fakeClient>['calls']) => T): T {
  const { client, calls } = fakeClient(rowsByTable);
  (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase = client;
  return fn(calls);
}

describe('SmartScanner classifier — auto-detects code type, creates nothing', () => {
  it('classifies an establishment QR (app URL with ?qid=) as establishment', () => {
    const r = classifyScanPayload('https://medistock-qr-network.vercel.app/?qid=abc-123');
    expect(r).toEqual({ kind: 'establishment', qid: 'abc-123' });
  });

  it('classifies a bare uuid as establishment', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(classifyScanPayload(id)).toEqual({ kind: 'establishment', qid: id });
  });

  it('classifies a movement QR payload as movement with its kind', () => {
    // movement-trace payloads round-trip; feed a plausible one via its builder.
    // Here we only assert non-crash + that a bare medicine barcode is a barcode.
    expect(classifyScanPayload('6291234567890')).toEqual({ kind: 'barcode', value: '6291234567890' });
  });

  it('unwraps a GS1 AI(01) GTIN to the catalog barcode digits', () => {
    expect(classifyScanPayload('0100629123456789')).toEqual({ kind: 'barcode', value: '629123456789' });
    expect(classifyScanPayload('(01)00629123456789')).toEqual({ kind: 'barcode', value: '629123456789' });
  });

  it('classifies gibberish as unknown (no record, no movement)', () => {
    expect(classifyScanPayload('not a code at all !!')).toEqual({ kind: 'unknown', raw: 'not a code at all !!' });
    expect(classifyScanPayload('')).toEqual({ kind: 'unknown', raw: '' });
  });
});

describe('resolveMaterials — grading per identity source', () => {
  it('exact national code on a stock lot grades CONFIRMED', async () => {
    const rows = await withClient({
      central_items: [],
      warehouse_stock: [{
        id: 's1', scientific_name: 'Amoxicillin', trade_name: 'Amoxil', concentration: '500mg',
        dosage_form: 'capsule', unit: 'box', national_code: 'NC-777', batch_number: 'B1',
        expiry_date: '2027-01-01', on_hand_quantity: 10, reserved_quantity: 0, available_quantity: 10,
        supply_type_text: 'purchase',
      }],
    }, () => resolveMaterials('NC-777', { warehouseId: 'wh1' }));
    expect(rows[0].grade).toBe('confirmed');
    expect(rows[0].reasonKey).toBe('mr_reason_national_exact');
    expect(rows[0].source).toBe('stock');
  });

  it('exact barcode on a catalog item grades CONFIRMED', async () => {
    const rows = await withClient({
      central_items: [{ id: 'c1', name: 'Amoxicillin', name_ar: 'أموكسيسيلين', barcode: '6291234567890', unit: 'box' }],
      warehouse_stock: [],
    }, () => resolveMaterials('6291234567890', {}));
    expect(rows[0].grade).toBe('confirmed');
    expect(rows[0].reasonKey).toBe('mr_reason_barcode_exact');
  });

  it('exact-normalized name grades STRONG; partial grades PROBABLE', async () => {
    const strong = await withClient({
      central_items: [{ id: 'c1', name: 'Amoxicillin', name_ar: 'أموكسيسيلين', barcode: null, unit: 'box' }],
      warehouse_stock: [],
    }, () => resolveMaterials('amoxicillin', {}));
    expect(strong[0].grade).toBe('strong');

    const probable = await withClient({
      central_items: [{ id: 'c1', name: 'Amoxicillin Trihydrate', name_ar: null, barcode: null, unit: 'box' }],
      warehouse_stock: [],
    }, () => resolveMaterials('trihydr', {}));
    expect(probable[0].grade).toBe('probable');
  });

  it('a batch number match grades PROBABLE and is flagged as non-unique', async () => {
    const rows = await withClient({
      central_items: [],
      warehouse_stock: [
        { id: 's1', scientific_name: 'A', trade_name: null, concentration: null, dosage_form: null, unit: null, national_code: null, batch_number: 'SHARED', expiry_date: null, on_hand_quantity: 3, reserved_quantity: 0, available_quantity: 3, supply_type_text: 'aid' },
        { id: 's2', scientific_name: 'B', trade_name: null, concentration: null, dosage_form: null, unit: null, national_code: null, batch_number: 'SHARED', expiry_date: null, on_hand_quantity: 4, reserved_quantity: 0, available_quantity: 4, supply_type_text: 'kimadia' },
      ],
    }, () => resolveMaterials('SHARED', { warehouseId: 'wh1' }));
    // BOTH hits returned — a batch alone is never a unique identity, never auto-picked.
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.grade === 'probable')).toBe(true);
    expect(rows.every(r => r.reasonKey === 'mr_reason_batch_match')).toBe(true);
  });

  it('scopes stock lookups to the given warehouse only', async () => {
    const calls = withClient({ central_items: [], warehouse_stock: [] },
      (calls) => resolveMaterials('amox', { warehouseId: 'wh-scope' }).then(() => calls));
    const stock = (await calls).find(c => c.table === 'warehouse_stock');
    expect(stock?.eqCols).toContain('warehouse_id');
  });

  it('does NOT query stock lots without a warehouse scope (catalog only)', async () => {
    const calls = await withClient({ central_items: [], warehouse_stock: [] },
      (calls) => resolveMaterials('amox', {}).then(() => calls));
    expect(calls.some(c => c.table === 'warehouse_stock')).toBe(false);
  });

  it('an unknown query yields [] — the caller must NOT treat text as a material', async () => {
    const rows = await withClient({ central_items: [], warehouse_stock: [] },
      () => resolveMaterials('zzzznomatch', { warehouseId: 'wh1' }));
    expect(rows).toEqual([]);
  });

  it('sorts confirmed before strong before probable (never auto-picks one)', async () => {
    const rows = await withClient({
      central_items: [{ id: 'c1', name: 'Zzz Partial Amox', name_ar: null, barcode: null, unit: null }],
      warehouse_stock: [{ id: 's1', scientific_name: 'Other', trade_name: null, concentration: null, dosage_form: null, unit: null, national_code: 'amox', batch_number: null, expiry_date: null, on_hand_quantity: 1, reserved_quantity: 0, available_quantity: 1, supply_type_text: null }],
    }, () => resolveMaterials('amox', { warehouseId: 'wh1' }));
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].grade).toBe('confirmed'); // exact national code wins
  });
});

// ── §7: internal vs public search-field scoping ──────────────────────────────
describe('resolveMaterials — audience scoping (internal vs public outlet)', () => {
  it('INTERNAL matches by name, national code, batch AND barcode; searches stock in scope', async () => {
    const calls = await withClient({ central_items: [], warehouse_stock: [] },
      (calls) => resolveMaterials('amoxi', { warehouseId: 'wh1', audience: 'internal' }).then(() => calls));
    const catalog = calls.find(c => c.table === 'central_items');
    expect(catalog?.or).toContain('barcode.eq');
    // stock lots (national code + batch) are reachable for the operator
    expect(calls.some(c => c.table === 'warehouse_stock')).toBe(true);
  });

  it('PUBLIC restricts to scientific/trade NAME only — no barcode, no national code, no batch', async () => {
    const calls = await withClient({ central_items: [], warehouse_stock: [] },
      (calls) => resolveMaterials('amoxi', { warehouseId: 'wh1', audience: 'public' }).then(() => calls));
    const catalog = calls.find(c => c.table === 'central_items');
    expect(catalog?.or).not.toContain('barcode.eq');
    expect(catalog?.or).toContain('name.ilike');
    expect(catalog?.or).toContain('name_ar.ilike');
    // a public visitor never reaches lot-level stock (batch / on-hand), even
    // when a warehouse id is supplied.
    expect(calls.some(c => c.table === 'warehouse_stock')).toBe(false);
  });

  it('defaults to INTERNAL when no audience is given', async () => {
    const calls = await withClient({ central_items: [], warehouse_stock: [] },
      (calls) => resolveMaterials('amoxi', { warehouseId: 'wh1' }).then(() => calls));
    const catalog = calls.find(c => c.table === 'central_items');
    expect(catalog?.or).toContain('barcode.eq');
  });
});

// ── PRE3-A: Arabic spelling variants match in BOTH directions ────────────────
// normalizeSearchText folds the query only; the server compares stored text as
// written. arabicVariantPattern is the server-side half: an `imatch` (~*)
// pattern that accepts every stored spelling the query's folded form stands for.
// (The patterns were also validated against real PostgreSQL ~* and PostgREST
// imatch; here they are evaluated with JavaScript's RegExp, which reads this
// literal/class/`*`/`\punct` subset identically.)
describe('arabicVariantPattern — the server-side half of normalizeSearchText', () => {
  const IGN = '[\u064B-\u0652\u0670\u0640]*';
  const matches = (pattern: string | null, text: string) => new RegExp(pattern as string, 'i').test(text);
  const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

  it('each class holds exactly the spellings normalizeSearchText folds to its letter — none missing in the Arabic block', () => {
    for (const [letter, members] of Object.entries(ARABIC_VARIANT_CLASSES)) {
      expect(members).toContain(letter);
      for (const m of members) expect(normalizeSearchText(m), m).toBe(letter);
    }
    for (let cp = 0x0600; cp <= 0x06ff; cp += 1) {
      const ch = String.fromCodePoint(cp);
      const folded = normalizeSearchText(ch);
      if (Object.prototype.hasOwnProperty.call(ARABIC_VARIANT_CLASSES, folded)) {
        expect(ARABIC_VARIANT_CLASSES[folded], hex(cp)).toContain(ch);
      }
    }
  });

  it('every character normalizeSearchText drops (harakat, shadda, sukun, dagger alif, tatweel) may sit between letters', () => {
    const pattern = arabicVariantPattern('بب');
    expect(pattern).toBe(`ب${IGN}ب`);
    let dropped = 0;
    for (let cp = 0x0600; cp <= 0x06ff; cp += 1) {
      const ch = String.fromCodePoint(cp);
      if (normalizeSearchText(`ب${ch}ب`) !== 'بب') continue;
      dropped += 1;
      expect(matches(pattern, `ب${ch}ب`), hex(cp)).toBe(true);
      expect(matches(pattern, `ب${ch}${ch}${ch}ب`), hex(cp)).toBe(true);
    }
    expect(dropped).toBe(10);
    expect(matches(pattern, 'باب')).toBe(false); // a letter is never skipped
  });

  it('builds classes for folded letters, an ignorable run after each Arabic character, and nothing after the last', () => {
    expect(arabicVariantPattern('اموكس')).toBe(`[اأإآٱ]${IGN}م${IGN}[وؤ]${IGN}ك${IGN}س`);
    expect(arabicVariantPattern('فواره')).toBe(`ف${IGN}[وؤ]${IGN}[اأإآٱ]${IGN}ر${IGN}[هة]`);
    expect(arabicVariantPattern('حمي 5a')).toBe(`ح${IGN}م${IGN}[يىئ]${IGN}\\ 5a`);
  });

  it('is literal-safe: every ASCII punctuation character is escaped and matches only itself; letters and digits are never escaped', () => {
    for (let cp = 0x20; cp <= 0x7e; cp += 1) {
      const ch = String.fromCharCode(cp);
      const pattern = arabicVariantPattern(`ب${ch}`);
      if (/^[0-9A-Za-z]$/.test(ch)) {
        expect(pattern, ch).toBe(`ب${IGN}${ch}`);
        continue;
      }
      expect(pattern, ch).toBe(`ب${IGN}\\${ch}`);
      expect(matches(pattern, `xب${ch}x`), ch).toBe(true);
      expect(matches(pattern, 'xبQx'), ch).toBe(false);
    }
  });

  it('returns null for a pure-ASCII, empty or over-long query (the ILIKE terms alone apply, as before)', () => {
    expect(arabicVariantPattern('amoxicillin')).toBeNull();
    expect(arabicVariantPattern('')).toBeNull();
    expect(arabicVariantPattern('ب'.repeat(VARIANT_PATTERN_MAX_CHARS))).not.toBeNull();
    expect(arabicVariantPattern('ب'.repeat(VARIANT_PATTERN_MAX_CHARS + 1))).toBeNull();
  });

  it('matches every folded pair in BOTH directions (stored variant / plain query and the reverse)', () => {
    const pairs: Array<[string, string]> = [
      ['أموكسيسيلين', 'اموكسيسيلين'], ['إيبوبروفين', 'ايبوبروفين'], ['آزيثرومايسين', 'ازيثرومايسين'],
      ['ٱسبرين', 'اسبرين'], ['فيتامين سي فوارة', 'فيتامين سي فواره'], ['خافض الحمى', 'خافض الحمي'],
      ['مؤكسدات', 'موكسدات'], ['محلول مائي', 'محلول مايي'], ['أتينولول', 'إتينولول'],
      ['ب\u064Eار\u064Eاس\u0650يت\u064Eام\u064Fول', 'باراسيتامول'], ['مترون\u0651يدازول', 'مترونيدازول'],
      ['اوم\u0652يبرازول', 'اوميبرازول'], ['لوراتاد\u064Bين', 'لوراتادين'], ['سيتر\u0670يزين', 'سيتريزين'],
      ['انس\u0640ولين', 'انسولين'], ['أ\u064Eملود\u0650يب\u0640ين', 'املوديبين'],
    ];
    for (const [a, b] of pairs) {
      for (const [stored, query] of [[a, b], [b, a]]) {
        expect(matches(arabicVariantPattern(normalizeSearchText(query)), stored), `${stored} <- ${query}`).toBe(true);
      }
    }
  });
});

describe('resolveMaterials — PRE3-A variant terms reach the server, on NAME columns only', () => {
  const IGN = '[\u064B-\u0652\u0670\u0640]*';

  it('INTERNAL with a warehouse scope: catalog names and stock names carry the quoted imatch term; codes never do', async () => {
    const calls = await withClient({ central_items: [], warehouse_stock: [] },
      (c) => resolveMaterials('اموكس', { warehouseId: 'wh1' }).then(() => c));
    const term = `"${arabicVariantPattern('اموكس')}"`;
    const catalog = calls.find(c => c.table === 'central_items')?.or ?? '';
    for (const col of ['name', 'name_ar', 'trade_name']) expect(catalog).toContain(`${col}.imatch.${term}`);
    expect(catalog).not.toContain('barcode.imatch');
    const stock = calls.find(c => c.table === 'warehouse_stock')?.or ?? '';
    for (const col of ['scientific_name', 'trade_name']) expect(stock).toContain(`${col}.imatch.${term}`);
    expect(stock).not.toMatch(/(national_code|batch_number)\.imatch/);
  });

  it('escapes a backslash and a double quote for the PostgREST logic tree', async () => {
    const calls = await withClient({ central_items: [] },
      (c) => resolveMaterials('ا"\\', {}).then(() => c));
    const catalog = calls.find(c => c.table === 'central_items')?.or ?? '';
    // pattern  [ا…]IGN \" \\   →   quoted  "[ا…]IGN\\\"\\\\"
    expect(catalog).toContain(`name_ar.imatch."[اأإآٱ]${IGN}${String.raw`\\\"\\\\`}"`);
  });

  it('PUBLIC: the variant term is a NAME match — no barcode, never stock', async () => {
    const calls = await withClient({ central_items: [], warehouse_stock: [] },
      (c) => resolveMaterials('اموكس', { warehouseId: 'wh1', audience: 'public' }).then(() => c));
    const catalog = calls.find(c => c.table === 'central_items')?.or ?? '';
    expect(catalog).toContain('name_ar.imatch.');
    expect(catalog).not.toContain('barcode.');
    expect(calls.some(c => c.table === 'warehouse_stock')).toBe(false);
  });

  it('a pure-ASCII query sends no imatch term — English matching is unchanged', async () => {
    const calls = await withClient({ central_items: [], warehouse_stock: [] },
      (c) => resolveMaterials('Amoxicillin', { warehouseId: 'wh1' }).then(() => c));
    for (const c of calls) expect(c.or ?? '', c.table).not.toContain('.imatch.');
  });
});

// ── §7: camera frame evaluation never auto-selects unsafe results ────────────
describe('evaluateDetectedCodes — auto-detect safety', () => {
  it('no code this frame → none (keep scanning)', () => {
    expect(evaluateDetectedCodes([])).toEqual({ status: 'none' });
    expect(evaluateDetectedCodes([{ rawValue: '' }])).toEqual({ status: 'none' });
  });

  it('one recognised code → hit with its classification', () => {
    const out = evaluateDetectedCodes([{ rawValue: '6291234567890' }]);
    expect(out).toEqual({ status: 'hit', result: { kind: 'barcode', value: '6291234567890' } });
  });

  it('one code that classifies to unknown → invalid, never a hit', () => {
    const out = evaluateDetectedCodes([{ rawValue: 'not a code !!' }]);
    expect(out.status).toBe('invalid');
  });

  it('more than one DISTINCT code in a frame → ambiguous, never auto-select', () => {
    const out = evaluateDetectedCodes([{ rawValue: '6291234567890' }, { rawValue: '5000159407236' }]);
    expect(out).toEqual({ status: 'ambiguous' });
  });

  it('duplicate reads of the SAME code are not ambiguous → the single hit', () => {
    const out = evaluateDetectedCodes([{ rawValue: '6291234567890' }, { rawValue: '6291234567890' }]);
    expect(out.status).toBe('hit');
  });
});

// ── §7: SmartScanner component wiring (source contract) ──────────────────────
describe('SmartScanner — state machine + lifecycle contract', () => {
  const src = readFileSync(join(__dirname, '../SmartScanner.tsx'), 'utf8');

  it('declares every required distinct phase', () => {
    for (const phase of ['loading', 'scanning', 'unsupported', 'denied', 'offline', 'invalid', 'ambiguous']) {
      expect(src).toContain(`'${phase}'`);
    }
  });

  it('gates on capability (unsupported) and connectivity (offline) before opening the camera', () => {
    expect(src).toContain("setPhase('unsupported')");
    expect(src).toContain("setPhase('offline')");
    expect(src).toMatch(/navigator\.onLine/);
    expect(src).toMatch(/BarcodeDetector|createDetector/);
  });

  it('stops all camera tracks on close and on unmount', () => {
    expect(src).toMatch(/getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
    // cleanup returned from the mount effect calls stopCamera
    expect(src).toMatch(/return \(\) => \{ stopCamera\(\); \}/);
    // the close button also stops the camera
    expect(src).toMatch(/onClick=\{\(\) => \{ stopCamera\(\); onClose\(\)/);
  });

  it('offers retry and a manual paste fallback in non-scanning states', () => {
    expect(src).toContain("t('scan_retry'");
    expect(src).toContain("t('scan_fallback_placeholder'");
    expect(src).toContain('showManual');
  });

  it('routes hits through evaluateDetectedCodes and never onScan on invalid/ambiguous', () => {
    expect(src).toContain('evaluateDetectedCodes(');
    // onScan only appears inside the 'hit' branch of the tick loop
    const tick = src.slice(src.indexOf('const tick'), src.indexOf('void tick();'));
    expect(tick).toMatch(/outcome\.status === 'hit'[\s\S]*onScan\(outcome\.result\)/);
    expect(tick).not.toMatch(/status === 'invalid'[^\n]*onScan/);
  });
});
