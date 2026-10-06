/**
 * PDA-PROC-1 / M221 — STATIC guard over the pharmacy department supplementary
 * procurement exclusion.
 *
 * Proves, from the migration text alone, the frozen shape of M221. The dynamic
 * PostgreSQL suite (221-pharmacy-department-subpurchase-exclusion.dynamic.test.ts)
 * is the behavioural proof; this suite pins what the file may and may not do:
 *
 *   * registration and hygiene: the canonical filename, the ONLY file above
 *     220 (no 222+), one BEGIN;/COMMIT; ending the file, ASCII and LF only,
 *     never MANUAL APPLY ONLY; M220 byte-identical (SHA-256 and the git blob
 *     HEAD records) and no tracked migration modified;
 *   * the activation shape, statement by statement: search_path pinned first,
 *     both timeouts, the fail-closed prelude (which pins the FOUR M087
 *     immutability triggers of the order events, receipts, receipt lines and
 *     returns), the bounded (no NOWAIT) lock of exactly the eight guarded
 *     tables, ONE new function, ONE REVOKE, TWELVE triggers, the comments,
 *     VERIFY, COMMIT — nothing else at top level;
 *   * forward-only: zero CREATE OR REPLACE, no CREATE/ALTER/DROP of any
 *     existing routine (the procurement RPC family named by the order in
 *     particular), no GRANT, no ALTER TABLE, no DROP, no TRUNCATE, no DML, no
 *     Central Needs or catalog-item token;
 *   * the guard: SECURITY DEFINER, plpgsql, VOLATILE, search_path pg_catalog,
 *     pg_temp; its ONE stock-field read (purchase_origin, never supply_type)
 *     only inside the NESTED block keyed on TG_TABLE_NAME = 'warehouse_stock';
 *     a missing organization fails closed; the refusal token with 23514 and a
 *     STATIC detail; reads exactly public.organizations; writes nothing;
 *   * the twelve triggers on eight tables: exact table, timing, events, UPDATE
 *     OF column list and WHEN text, named to fire first — procurement_suppliers,
 *     procurement_orders and procurement_order_lines (INSERT; UPDATE OF
 *     organization_id WHEN it changes: procurement_order_lines has no
 *     immutability trigger), procurement_order_events, procurement_receipts,
 *     procurement_receipt_lines and procurement_returns (INSERT ONLY: their
 *     UPDATE is refused by the pinned M087 immutability triggers) and
 *     warehouse_stock (INSERT WHEN purchase_origin = 'supplementary'; UPDATE OF
 *     purchase_origin, organization_id) — and NO trigger on
 *     warehouse_quarantine_stock (a custody destination, deliberately not
 *     guarded), which no statement of the file even names;
 *   * the stock predicate is purchase_origin ALONE: no supply_type predicate in
 *     the function, the two stock WHENs, the census or VERIFY;
 *   * VERIFY re-proves the function, its ACL, the exact twelve bindings, the
 *     firing order and the census of the eight guarded tables under the lock.
 *
 * Structural assertions run against comment-stripped SQL (stripSqlComments);
 * negative assertions run against executable SQL with literals blanked
 * (executableSql), so neither prose nor a RAISE message can satisfy or trip a
 * check.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executableSql, normalizeSql, stripSqlComments } from './helpers/sql-source';

const MIGRATIONS = join(__dirname, '..');
const ROOT = join(__dirname, '..', '..', '..');
const FILENAME = '221_phoenix_pharmacy_department_subpurchase_exclusion.sql';
const PRESENT = existsSync(join(MIGRATIONS, FILENAME));
const RAW = PRESENT ? readFileSync(join(MIGRATIONS, FILENAME)) : Buffer.alloc(0);
const SQL = RAW.toString('utf8');
const CODE = stripSqlComments(SQL);
const EXEC = executableSql(SQL);
const VERIFY_AT = CODE.indexOf('DO $verify$');
const VERIFY = VERIFY_AT >= 0 ? CODE.slice(VERIFY_AT, CODE.indexOf('$verify$;', VERIFY_AT)) : '';
const PRELUDE_AT = CODE.indexOf('DO $prelude$');
const PRELUDE = PRELUDE_AT >= 0 ? CODE.slice(PRELUDE_AT, CODE.indexOf('$prelude$;', PRELUDE_AT)) : '';

const M220_FILE = '220_phoenix_central_needs_active_item_guard.sql';
const M220_SHA256 = '1e7636a23122572faed2f639d56cd5a09a8de67c4197ea88531b766de0d8e669';
const M220_BLOB = '70ab8424a69503b7ebbbcafc1c5dfc103a079c28';

const GUARD = 'public._phoenix_pda_supplementary_procurement_guard_v1';
const GUARD_HEAD = `CREATE FUNCTION ${GUARD}()`;
const TOKEN = 'pharmacy_department_supplementary_procurement_forbidden';
const EXEC_GUARD = `EXECUTE FUNCTION ${GUARD}();`;
/** The eight guarded tables, in the order of the activation LOCK and of the applier-ownership probe. */
const GUARDED_TABLES = ['procurement_suppliers', 'procurement_orders', 'procurement_order_lines', 'procurement_order_events',
  'procurement_receipts', 'procurement_receipt_lines', 'procurement_returns', 'warehouse_stock'];
/**
 * The four child tables M221 guards on INSERT ONLY: their UPDATE (organization_id included) is refused by the M087
 * immutability triggers the prelude pins. procurement_order_lines is NOT one of them: it has no immutability trigger,
 * so its UPDATE OF organization_id is guarded too.
 */
const INSERT_ONLY_CHILD_TABLES = ['procurement_order_events', 'procurement_receipts', 'procurement_receipt_lines', 'procurement_returns'];
/** Tables M221 must NOT bind: warehouse_quarantine_stock is a custody destination (deliberately unguarded); outlet_stock is a reported residual. */
const UNBOUND_TABLES = ['warehouse_quarantine_stock', 'outlet_stock'];
/** The prelude census, in its order: the procurement tables and supplementary warehouse_stock. */
const PRELUDE_CENSUS = ['procurement_suppliers', 'procurement_orders', 'warehouse_stock', 'procurement_order_lines', 'procurement_receipts',
  'procurement_receipt_lines', 'procurement_returns', 'procurement_order_events'];
/** The census VERIFY re-runs under the lock: exactly the eight guarded tables, in VERIFY's order. */
const VERIFY_CENSUS = ['procurement_suppliers', 'procurement_orders', 'procurement_order_lines', 'procurement_order_events',
  'procurement_receipts', 'procurement_receipt_lines', 'procurement_returns', 'warehouse_stock'];

/** The procurement routines PDA-PROC-1 must never redefine (Director order + the internal poster). */
const PROTECTED_ROUTINES = [
  'phoenix_procurement_save_supplier', 'phoenix_procurement_create_order', 'phoenix_procurement_add_order_line',
  'phoenix_procurement_remove_order_line', 'phoenix_procurement_submit_order', 'phoenix_procurement_decide_order',
  'phoenix_procurement_cancel_order', 'phoenix_procurement_receive_order', 'phoenix_procurement_return_to_supplier',
  'phoenix_subpurchase_direct_entry', 'phoenix_subpurchase_duplicate_candidates', '_phoenix_procurement_post_receipt_line',
];

/** The re-label WHEN of the suppliers, orders and order-lines UPDATE OF organization_id bindings, exactly as authored. */
const REASSIGN_WHEN = 'WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)';

/** The twelve bindings, exactly as authored (whitespace-normalized), in file order. */
const TRIGGERS: Array<{ name: string; table: string; sql: string }> = [
  { name: 'phoenix_pda_supplier_insert_guard', table: 'procurement_suppliers',
    sql: `CREATE TRIGGER phoenix_pda_supplier_insert_guard BEFORE INSERT ON public.procurement_suppliers FOR EACH ROW ${EXEC_GUARD}` },
  { name: 'phoenix_pda_supplier_reassign_guard', table: 'procurement_suppliers',
    sql: 'CREATE TRIGGER phoenix_pda_supplier_reassign_guard BEFORE UPDATE OF organization_id ON public.procurement_suppliers FOR EACH ROW '
      + `WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id) ${EXEC_GUARD}` },
  { name: 'phoenix_pda_order_insert_guard', table: 'procurement_orders',
    sql: `CREATE TRIGGER phoenix_pda_order_insert_guard BEFORE INSERT ON public.procurement_orders FOR EACH ROW ${EXEC_GUARD}` },
  { name: 'phoenix_pda_order_reassign_guard', table: 'procurement_orders',
    sql: 'CREATE TRIGGER phoenix_pda_order_reassign_guard BEFORE UPDATE OF organization_id ON public.procurement_orders FOR EACH ROW '
      + `WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id) ${EXEC_GUARD}` },
  { name: 'phoenix_pda_order_line_insert_guard', table: 'procurement_order_lines',
    sql: `CREATE TRIGGER phoenix_pda_order_line_insert_guard BEFORE INSERT ON public.procurement_order_lines FOR EACH ROW ${EXEC_GUARD}` },
  { name: 'phoenix_pda_order_line_reassign_guard', table: 'procurement_order_lines',
    sql: 'CREATE TRIGGER phoenix_pda_order_line_reassign_guard BEFORE UPDATE OF organization_id ON public.procurement_order_lines FOR EACH ROW '
      + `${REASSIGN_WHEN} ${EXEC_GUARD}` },
  { name: 'phoenix_pda_order_event_insert_guard', table: 'procurement_order_events',
    sql: `CREATE TRIGGER phoenix_pda_order_event_insert_guard BEFORE INSERT ON public.procurement_order_events FOR EACH ROW ${EXEC_GUARD}` },
  { name: 'phoenix_pda_receipt_insert_guard', table: 'procurement_receipts',
    sql: `CREATE TRIGGER phoenix_pda_receipt_insert_guard BEFORE INSERT ON public.procurement_receipts FOR EACH ROW ${EXEC_GUARD}` },
  { name: 'phoenix_pda_receipt_line_insert_guard', table: 'procurement_receipt_lines',
    sql: `CREATE TRIGGER phoenix_pda_receipt_line_insert_guard BEFORE INSERT ON public.procurement_receipt_lines FOR EACH ROW ${EXEC_GUARD}` },
  { name: 'phoenix_pda_return_insert_guard', table: 'procurement_returns',
    sql: `CREATE TRIGGER phoenix_pda_return_insert_guard BEFORE INSERT ON public.procurement_returns FOR EACH ROW ${EXEC_GUARD}` },
  { name: 'phoenix_pda_supplementary_stock_insert_guard', table: 'warehouse_stock',
    sql: 'CREATE TRIGGER phoenix_pda_supplementary_stock_insert_guard BEFORE INSERT ON public.warehouse_stock FOR EACH ROW '
      + `WHEN (NEW.purchase_origin = 'supplementary') ${EXEC_GUARD}` },
  { name: 'phoenix_pda_supplementary_stock_reforge_guard', table: 'warehouse_stock',
    sql: 'CREATE TRIGGER phoenix_pda_supplementary_stock_reforge_guard BEFORE UPDATE OF purchase_origin, organization_id '
      + "ON public.warehouse_stock FOR EACH ROW WHEN (NEW.purchase_origin = 'supplementary' "
      + 'AND (OLD.purchase_origin IS DISTINCT FROM NEW.purchase_origin '
      + `OR OLD.organization_id IS DISTINCT FROM NEW.organization_id)) ${EXEC_GUARD}` },
];

/** The BEFORE ROW triggers that already exist on the guarded tables (M060/M078/M087/M140/M150/M184). */
const EXISTING_BEFORE_TRIGGERS: Record<string, string[]> = {
  procurement_suppliers: [],
  procurement_orders: ['phoenix_procurement_order_root_guard', 'procurement_orders_bump_generation', 'procurement_orders_demo_marker_write_once'],
  procurement_order_lines: ['procurement_order_lines_demo_marker_write_once'],
  procurement_order_events: ['procurement_order_events_demo_marker_write_once', 'procurement_order_events_immutable'],
  procurement_receipts: ['procurement_receipts_demo_marker_write_once', 'procurement_receipts_immutable'],
  procurement_receipt_lines: ['procurement_receipt_lines_demo_marker_write_once', 'procurement_receipt_lines_immutable'],
  procurement_returns: ['procurement_returns_demo_marker_write_once', 'procurement_returns_immutable'],
  warehouse_stock: ['set_updated_at', 'trg_warehouse_stock_fefo_insert_lock_v150', 'warehouse_stock_bump_movement_seq'],
};

/** The prelude pin of the FOUR M087 immutability triggers (tgtype 27 = ROW | BEFORE | DELETE | UPDATE). */
const IMMUTABILITY_PIN = `IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid IN ('public.procurement_order_events'::pg_catalog.regclass, 'public.procurement_receipts'::pg_catalog.regclass,
                           'public.procurement_receipt_lines'::pg_catalog.regclass, 'public.procurement_returns'::pg_catalog.regclass)
         AND t.tgname IN ('procurement_order_events_immutable', 'procurement_receipts_immutable', 'procurement_receipt_lines_immutable',
                          'procurement_returns_immutable')
         AND t.tgname = (SELECT c.relname FROM pg_catalog.pg_class c WHERE c.oid = t.tgrelid) || '_immutable'
         AND t.tgtype = 27 AND t.tgenabled = 'O' AND NOT t.tgisinternal
         AND t.tgfoid = pg_catalog.to_regprocedure('public.phoenix_procurement_forbid_mutation()')) <> 4 THEN
    RAISE EXCEPTION '221_precondition_failed: schema drift: the M087 order-event, receipt, receipt-line and return immutability triggers are absent or changed';
  END IF;`;

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const gitBlob = (b: Buffer) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: ROOT, encoding: 'utf8' });
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Index of `needle` in `text`, asserted present. */
function at(text: string, needle: string | RegExp, label: string): number {
  const i = typeof needle === 'string' ? text.indexOf(needle) : text.search(needle);
  expect(i, `${label} present`).toBeGreaterThanOrEqual(0);
  return i;
}

/** Top-level statements: dollar-quoted bodies collapsed to $$, split on ';', whitespace normalized. */
function topLevelStatements(src: string): string[] {
  let flat = '';
  let i = 0;
  while (i < src.length) {
    const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
    if (open) {
      const close = src.indexOf(open[0], i + open[0].length);
      flat += '$$';
      i = close < 0 ? src.length : close + open[0].length;
      continue;
    }
    flat += src[i];
    i += 1;
  }
  return flat.split(';').map((s) => normalizeSql(s)).filter((s) => s.length > 0);
}

/** The guard's whole definition (comment-stripped), from its head through `$fn$;`. */
function guardDef(): string {
  const start = at(CODE, GUARD_HEAD, 'the guard function');
  const end = CODE.indexOf('\n$fn$;', start);
  expect(end, 'the guard body terminator').toBeGreaterThan(start);
  return CODE.slice(start, end + '\n$fn$;'.length);
}
const guardBody = () => {
  const def = guardDef();
  return def.slice(def.indexOf('AS $fn$') + 'AS $fn$'.length, def.lastIndexOf('$fn$'));
};

/** The census subqueries of a DO block: [ord, rel, normalized `FROM public.<rel> t WHERE ...`] in order. */
function censusOf(block: string): Array<[number, string, string]> {
  const re = /SELECT (\d+)(?: AS ord)?, '([a-z_]+)'(?:::text AS rel)?, pg_catalog\.count\(\*\)(?: AS n)?\s+(FROM public\.[a-z_]+ t\s+WHERE [\s\S]*?)(?=\s+UNION ALL|\) x\s)/g;
  return [...block.matchAll(re)].map((m) => [Number(m[1]), m[2], normalizeSql(m[3])]);
}

describe('PDA-PROC-1/M221 static — the file exists under its canonical name', () => {
  it(`${FILENAME} is present`, () => {
    expect(PRESENT, `${FILENAME} is not on disk`).toBe(true);
    expect(FILENAME).toMatch(/^221_phoenix_[a-z0-9_]+\.sql$/);
  });
});

describe('PDA-PROC-1/M221 static — registration and hygiene', () => {
  it('221 is the ONLY migration above 220 (no 222+), and the only 221_ file', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files.filter((f) => Number(f.slice(0, 3)) > 220)).toEqual([FILENAME]);
    expect(files.filter((f) => f.startsWith('221_'))).toEqual([FILENAME]);
    expect(files.filter((f) => Number(f.slice(0, 3)) >= 222)).toEqual([]);
    expect(readdirSync(MIGRATIONS).filter((f) => /^2(2[2-9]|[3-9]\d)/.test(f))).toEqual([]);
  });

  it('one BEGIN; and one COMMIT;, the file ends with COMMIT;, ASCII and LF only, never MANUAL APPLY ONLY', () => {
    expect(EXEC.match(/^\s*BEGIN\s*;/gim)).toHaveLength(1);
    expect(EXEC.match(/^\s*COMMIT\s*;/gim)).toHaveLength(1);
    expect(EXEC.match(/\bBEGIN\s*;/g)).toHaveLength(1);
    expect(EXEC.match(/\bCOMMIT\s*;/g)).toHaveLength(1);
    expect(EXEC).not.toMatch(/\bROLLBACK\b/i);
    expect(EXEC.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(SQL.endsWith('COMMIT;\n')).toBe(true);
    expect([...RAW].every((b) => b < 0x80), 'ASCII only').toBe(true);
    expect(SQL.includes('\r')).toBe(false);
    expect(SQL).not.toMatch(/MANUAL APPLY ONLY/i);
  });

  it('the header names PDA-PROC-1, the persistent procurement-state invariant, the purchase_origin-only stock predicate, the five guarded children (order lines also on re-label) with the four-trigger immutability pin, the unguarded quarantine and the residuals (cross-care label mismatch deferred)', () => {
    const header = SQL.slice(0, SQL.indexOf('\nBEGIN;'));
    for (const needle of [
      'PDA-PROC-1 / M221', 'THE INVARIANT - the persistent procurement-state boundary', 'Forward-only.', 'No RPC is created or replaced',
      'phoenix_subpurchase_duplicate_candidates', 'super_admin is no exception', 'RESIDUALS',
      'service_role, which holds direct INSERT,\n--   UPDATE and DELETE on warehouse_stock and on the procurement tables',
      'a PDA-labelled order line, order event,\n--   receipt, receipt line or return under a CARE order, re-label a supplier,\n--   an order or an order line onto a PDA',
      'A row of procurement_suppliers, procurement_orders,\n--   procurement_order_lines, procurement_order_events, procurement_receipts,\n--   procurement_receipt_lines or procurement_returns may be written for an\n--   organization',
      "purchase_origin = 'supplementary' (WHATEVER its supply_type)",
      'The stock predicate is purchase_origin alone, on purpose: the M088 CHECK',
      "UNKNOWN - and therefore passes - for supply_type NULL with\n--   purchase_origin 'supplementary'", 'M088 is not modified.',
      'ORDER LINES, ORDER EVENTS, RECEIPTS, RECEIPT LINES AND RETURNS - THE CHILDREN',
      'with no foreign key tying\n--   it to the parent\'s',
      'PDA-labelled child under a care order is refused at write time (INSERT).',
      'UPDATE: procurement_order_lines has no immutability trigger, so its\n--   UPDATE OF organization_id is guarded too.',
      'The other four need no UPDATE\n--   guard: the M087 immutability triggers (procurement_order_events_immutable,\n--   procurement_receipts_immutable, procurement_receipt_lines_immutable,\n--   procurement_returns_immutable;',
      'latest body M141\n--   phoenix_procurement_forbid_mutation)', 'the prelude pins all four and the\n--   dynamic suite proves it.',
      'M087:403 does.',
      'Twelve BEFORE ROW triggers',
      '--        procurement_order_lines    INSERT; UPDATE OF organization_id\n--        procurement_order_events   INSERT\n',
      '221_already_applied                    the function and all 12 triggers',
      'SHARE ROW EXCLUSIVE on the eight guarded tables', 'the census of the eight guarded tables', 'the exact twelve bindings',
      'owner of the eight guarded tables',
      'QUARANTINE - DELIBERATELY NOT GUARDED', 'M088,\n--   M128, M135, M157, M162, M185',
      'CROSS-CARE CHILD LABEL MISMATCH (deferred, separate defect)',
      "service_role SQL can still label a child row with care institution A\n--     under care institution B's order. M221 enforces only the PDA exclusion;",
      'child/parent organization consistency is left to a later Director\n--     decision.',
      'warehouse_quarantine_stock (custody, out of scope', 'outlet_stock',
      'session_replication_role = replica', 'pharmacy_department_supplementary_procurement_forbidden', 'SQLSTATE 23514',
    ]) {
      expect(header, needle).toContain(needle);
    }
    expect(header).not.toMatch(/cross-route/i);
    // The superseded shapes are gone from the prose: no transitive-closure claim, no six-/nine-trigger, six-table or
    // free-label (order lines / order events unguarded) wording.
    expect(header).not.toMatch(/CLOSED TRANSITIVELY|CREATION authority|Six BEFORE ROW|Nine BEFORE ROW|three guarded tables|six guarded tables/);
    expect(header).not.toMatch(/all 6 triggers|all 9 triggers|nine bindings|free-label columns|GUARDED ON INSERT|Pin those three/);
    expect(header).not.toMatch(/procurement_order_lines or procurement_order_events row under a CARE/);
  });

  it('M220 is byte-identical: its SHA-256, and its git blob equals the blob HEAD records', () => {
    const m220 = readFileSync(join(MIGRATIONS, M220_FILE));
    expect(sha256(m220)).toBe(M220_SHA256);
    expect(gitBlob(m220)).toBe(M220_BLOB);
    const tree = git('ls-tree', 'HEAD', '--', `supabase/migrations/${M220_FILE}`).trim();
    expect(tree).toBe(`100644 blob ${M220_BLOB}\tsupabase/migrations/${M220_FILE}`);
  });

  it('no tracked migration is modified against HEAD', () => {
    expect(git('diff', '--name-only', 'HEAD', '--', 'supabase/migrations/*.sql').trim()).toBe('');
  });
});

describe('PDA-PROC-1/M221 static — activation shape', () => {
  const STATEMENTS = topLevelStatements(EXEC);

  it('the exact top-level statement sequence: nothing but the reviewed activation, DDL and VERIFY', () => {
    const kinds = STATEMENTS.map((s) => {
      if (s.startsWith('CREATE TRIGGER ')) return 'CREATE TRIGGER';
      if (s.startsWith('COMMENT ON TRIGGER ')) return 'COMMENT ON TRIGGER';
      return s.replace(/ (AS|IS) .*$/, '').replace(/\(.*$/, '').replace(/ = .*$/, '');
    });
    expect(kinds).toEqual([
      'BEGIN',
      'SET LOCAL search_path', 'SET LOCAL lock_timeout', 'SET LOCAL statement_timeout',
      'DO $$',
      'LOCK TABLE public.procurement_suppliers, public.procurement_orders, public.procurement_order_lines, '
        + 'public.procurement_order_events, public.procurement_receipts, public.procurement_receipt_lines, '
        + 'public.procurement_returns, public.warehouse_stock IN SHARE ROW EXCLUSIVE MODE',
      `CREATE FUNCTION ${GUARD}`,
      `REVOKE ALL ON FUNCTION ${GUARD}`,
      ...Array(12).fill('CREATE TRIGGER'),
      `COMMENT ON FUNCTION ${GUARD}`,
      ...Array(12).fill('COMMENT ON TRIGGER'),
      'DO $$',
      'COMMIT',
    ]);
    expect(STATEMENTS.slice(0, 4)).toEqual([
      'BEGIN', 'SET LOCAL search_path = pg_catalog, pg_temp', "SET LOCAL lock_timeout = ''", "SET LOCAL statement_timeout = ''",
    ]);
    expect(CODE).toContain("SET LOCAL lock_timeout = '3s';");
    expect(CODE).toContain("SET LOCAL statement_timeout = '60s';");
  });

  it('order: prelude < LOCK < CREATE FUNCTION < first CREATE TRIGGER < VERIFY; the lock is bounded, never NOWAIT, and names exactly the eight guarded tables (order lines and order events included, never quarantine)', () => {
    const prelude = at(EXEC, 'DO $prelude$', 'prelude');
    const lock = at(EXEC, /LOCK TABLE public\.procurement_suppliers/, 'lock');
    const fn = at(EXEC, GUARD_HEAD, 'create function');
    const firstTrigger = at(EXEC, /CREATE TRIGGER /, 'first trigger');
    const verify = at(EXEC, 'DO $verify$', 'verify');
    expect(prelude).toBeLessThan(lock);
    expect(lock).toBeLessThan(fn);
    expect(fn).toBeLessThan(firstTrigger);
    expect(firstTrigger).toBeLessThan(verify);
    expect(EXEC.slice(0, lock)).not.toMatch(/\bCREATE\b|\bREVOKE\b|\bGRANT\b|\bALTER\b/);
    expect(EXEC).not.toMatch(/\bNOWAIT\b/i);
    expect(EXEC.match(/\bLOCK\s+TABLE\b/gi)).toHaveLength(1);
    expect(PRELUDE).not.toMatch(/\bLOCK\s+TABLE\b|FOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i);
    const lockStmt = /LOCK TABLE ([^;]*) IN SHARE ROW EXCLUSIVE MODE;/.exec(EXEC);
    const locked = lockStmt?.[1].split(',').map((x) => x.trim().replace(/^public\./, ''));
    expect(locked).toEqual(GUARDED_TABLES);
    expect(locked).toHaveLength(8);
    expect(locked).toContain('procurement_order_lines');
    expect(locked).toContain('procurement_order_events');
    for (const table of UNBOUND_TABLES) expect(lockStmt?.[1], table).not.toContain(table);
  });

  it('the prelude refuses deterministically: isolation, idempotence, applier (owner of the eight tables), schema drift (the four M087 immutability triggers pinned) and the legacy census', () => {
    const order = [
      "RAISE EXCEPTION '221_precondition_failed: READ COMMITTED isolation is required'",
      "RAISE EXCEPTION '221_already_applied';",
      "RAISE EXCEPTION '221_precondition_failed: partial M221 object set'",
      "RAISE EXCEPTION '221_precondition_failed: the applying role must bypass row-level security'",
      "RAISE EXCEPTION '221_precondition_failed: schema drift: table public.% is absent', v_row.rel;",
      "RAISE EXCEPTION '221_precondition_failed: M221 must be applied by the owner of the eight guarded tables'",
      "RAISE EXCEPTION '221_precondition_failed: schema drift: public.%.% is not % %'",
      "RAISE EXCEPTION '221_precondition_failed: schema drift: organization_kind vocabulary is not {care_institution, pharmacy_department_authority}'",
      "RAISE EXCEPTION '221_precondition_failed: schema drift: organizations_kind_immutable_trg is not the enabled M171 BEFORE UPDATE OF organization_kind trigger';",
      "RAISE EXCEPTION '221_precondition_failed: schema drift: public.organizations forces row-level security';",
      "RAISE EXCEPTION '221_precondition_failed: schema drift: warehouses_owner_kind_guard_trg is absent or disabled';",
      "RAISE EXCEPTION '221_precondition_failed: schema drift: phoenix_procurement_order_root_guard is absent or disabled';",
      "RAISE EXCEPTION '221_precondition_failed: schema drift: the M087 order-event, receipt, receipt-line and return immutability triggers are absent or changed';",
      "RAISE EXCEPTION '221_precondition_failed: legacy non-care procurement rows present'",
    ].map((needle) => at(PRELUDE, needle, needle));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(PRELUDE.match(/\bRAISE\s+EXCEPTION\b/g)).toHaveLength(order.length);
    // Reports nothing: no NOTICE (the custody-side NOTICEs are out of scope).
    expect(PRELUDE).not.toMatch(/\bRAISE\s+NOTICE\b/i);
    // The immutability pin: the FOUR M087 BEFORE UPDATE OR DELETE ROW triggers (order events, receipts, receipt lines,
    // returns), enabled, on the M141 body - exactly four. procurement_order_lines has none and is not in the pin.
    expect(normalizeSql(PRELUDE)).toContain(normalizeSql(IMMUTABILITY_PIN));
    expect([...PRELUDE.matchAll(/'([a-z_]+_immutable)'/g)].map((m) => m[1])).toEqual(
      ['procurement_order_events_immutable', 'procurement_receipts_immutable', 'procurement_receipt_lines_immutable', 'procurement_returns_immutable']);
    const pinAt = PRELUDE.indexOf("AND t.tgname IN ('procurement_order_events_immutable'");
    const pin = PRELUDE.slice(PRELUDE.lastIndexOf('WHERE t.tgrelid IN (', pinAt), pinAt);
    expect([...pin.matchAll(/'public\.([a-z_]+)'::pg_catalog\.regclass/g)].map((m) => m[1])).toEqual(INSERT_ONLY_CHILD_TABLES);
    expect(pin).not.toContain('procurement_order_lines');
    expect(PRELUDE).not.toMatch(/procurement_order_lines_immutable/);
    expect(PRELUDE).toContain("AND t.tgfoid = pg_catalog.to_regprocedure('public.phoenix_procurement_forbid_mutation()')) <> 4 THEN");
    // The idempotence probe names exactly the twelve triggers.
    for (const t of TRIGGERS) expect(PRELUDE, t.name).toContain(`'${t.name}'`);
    const probeAt = PRELUDE.indexOf('WHERE t.tgname IN (');
    const probe = PRELUDE.slice(probeAt, PRELUDE.indexOf(');', probeAt));
    expect([...probe.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(TRIGGERS.map((t) => t.name).sort());
    expect([...probe.matchAll(/'([a-z_]+)'/g)]).toHaveLength(12);
    expect(PRELUDE).toContain('IF v_fn IS NOT NULL AND v_triggers = 12 THEN');
    // The applier must own exactly the eight guarded tables (CREATE TRIGGER, COMMENT ON TRIGGER, LOCK).
    const owner = PRELUDE.slice(PRELUDE.indexOf('WHERE c.oid IN ('), PRELUDE.indexOf('AND c.relowner <> v_me'));
    expect([...owner.matchAll(/'public\.([a-z_]+)'::pg_catalog\.regclass/g)].map((m) => m[1])).toEqual(GUARDED_TABLES);
    // The census: every procurement table and supplementary warehouse_stock, in its order (ord 1..8).
    expect(censusOf(PRELUDE).map(([ord, rel]) => [ord, rel])).toEqual(PRELUDE_CENSUS.map((rel, i) => [i + 1, rel]));
    for (const rel of PRELUDE_CENSUS) {
      expect(PRELUDE, rel).toMatch(new RegExp(`'${rel}'(::text AS rel)?, pg_catalog\\.count\\(\\*\\)`));
    }
    // Eligibility is NOT EXISTS an existing care institution: a dangling label counts as legacy too.
    expect(PRELUDE.match(/NOT EXISTS \(SELECT 1 FROM public\.organizations o WHERE o\.id = t\.organization_id AND o\.organization_kind = 'care_institution'\)/g))
      .toHaveLength(8);
    expect(PRELUDE.match(/NOT EXISTS \(SELECT 1 FROM public\.organizations o WHERE/g)).toHaveLength(8);
    // The stock census is purchase_origin ALONE (any supply_type).
    expect(normalizeSql(PRELUDE)).toContain(normalizeSql(`SELECT 3, 'warehouse_stock', pg_catalog.count(*)
            FROM public.warehouse_stock t
           WHERE t.purchase_origin = 'supplementary'
             AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')`));
    expect(PRELUDE).not.toMatch(/supply_type/);
    expect(PRELUDE).toContain('USING DETAIL = v_census;');
    // The schema-drift probe: exactly the relations and columns the guard and the census read - purchase_origin, never supply_type.
    const rels = PRELUDE.slice(PRELUDE.indexOf('SELECT x.rel FROM (VALUES'), PRELUDE.indexOf(') AS x(rel)'));
    expect([...rels.matchAll(/\('([a-z_]+)'\)/g)].map((m) => m[1])).toEqual(['organizations', 'warehouses',
      'procurement_suppliers', 'procurement_orders', 'warehouse_stock', 'procurement_order_lines', 'procurement_receipts',
      'procurement_receipt_lines', 'procurement_returns', 'procurement_order_events']);
    const cols = PRELUDE.slice(PRELUDE.indexOf('FROM (VALUES (\'organizations\', \'id\''), PRELUDE.indexOf(') AS x(rel, col, typ, nn)'));
    expect([...cols.matchAll(/\('([a-z_]+)', '([a-z_]+)', '([a-z]+)', (true|false)\)/g)].map((m) => `${m[1]}.${m[2]}:${m[3]}:${m[4]}`)).toEqual([
      'organizations.id:uuid:true', 'organizations.organization_kind:text:true',
      'procurement_suppliers.organization_id:uuid:true', 'procurement_orders.organization_id:uuid:true',
      'warehouse_stock.organization_id:uuid:true', 'warehouse_stock.purchase_origin:text:false',
      ...['procurement_order_lines', 'procurement_receipts', 'procurement_receipt_lines', 'procurement_returns', 'procurement_order_events']
        .map((t) => `${t}.organization_id:uuid:true`),
    ]);
    // Nothing of the custody side: no quarantine, return-shipment or transfer-line read anywhere in the file's code.
    expect(CODE).not.toMatch(/warehouse_quarantine_stock|warehouse_return_shipment|warehouse_transfer_lines/);
  });
});

describe('PDA-PROC-1/M221 static — forward-only DDL inventory', () => {
  it('zero CREATE OR REPLACE; exactly ONE CREATE FUNCTION (the guard); no other routine created, altered or dropped', () => {
    expect(SQL).not.toMatch(/CREATE\s+OR\s+REPLACE/i);
    expect([...EXEC.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z0-9_."]+)\s*\(/gi)].map((m) => m[1])).toEqual([GUARD]);
    expect(EXEC).not.toMatch(/\b(ALTER|DROP)\s+(FUNCTION|PROCEDURE|ROUTINE)\b/i);
    expect(EXEC).not.toMatch(/\bCREATE\s+(PROCEDURE|AGGREGATE)\b/i);
    for (const name of [...PROTECTED_ROUTINES, 'phoenix_procurement_forbid_mutation', 'phoenix_procurement_update_order_line',
      '_phoenix_procurement_log_event']) {
      expect(EXEC, name).not.toMatch(new RegExp(`\\b(CREATE|ALTER|DROP)\\b[^;]*\\b${name}\\b`, 'i'));
      expect(CODE, name).not.toMatch(new RegExp(`\\b(CREATE|ALTER|DROP)\\b[^;]*\\b${name}\\b`, 'i'));
    }
  });

  it('exactly one REVOKE (the guard, from PUBLIC, anon, authenticated, service_role) and no GRANT', () => {
    expect([...EXEC.matchAll(/^\s*REVOKE\b[^;]*;/gim)].map((m) => normalizeSql(m[0])))
      .toEqual([`REVOKE ALL ON FUNCTION ${GUARD}() FROM PUBLIC, anon, authenticated, service_role;`]);
    expect(EXEC).not.toMatch(/\bGRANT\b/i);
  });

  it('no table, column, constraint, index, policy, schema or privilege change; no DROP, TRUNCATE or DML anywhere', () => {
    for (const forbidden of [/\bALTER\s+(TABLE|DEFAULT|SCHEMA|ROLE|POLICY|TRIGGER|INDEX|SEQUENCE|TYPE|VIEW|DATABASE|SYSTEM)\b/i, /\bDROP\b/i,
      /\bTRUNCATE\b/i, /\bCREATE\s+(TABLE|INDEX|UNIQUE|POLICY|SCHEMA|TYPE|VIEW|RULE|SEQUENCE|EXTENSION|ROLE|DOMAIN|EVENT)\b/i,
      /\bINSERT\s+INTO\b/i, /\bUPDATE\s+(ONLY\s+)?[a-z_."]+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bMERGE\s+INTO\b/i, /\bCOPY\b/i,
      /\bSECURITY\s+LABEL\b/i, /\bDISABLE\s+TRIGGER\b/i, /\bsession_replication_role\b/i, /\bset_config\s*\(/i]) {
      expect(EXEC, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('touches nothing of Central Needs or the central catalog', () => {
    expect(SQL).not.toMatch(/central_items|central_needs/i);
  });
});

describe('PDA-PROC-1/M221 static — the guard function', () => {
  it('is SECURITY DEFINER, plpgsql, VOLATILE, RETURNS trigger, search_path pg_catalog, pg_temp (the only SECURITY DEFINER of the file)', () => {
    const def = guardDef();
    expect(normalizeSql(def.slice(0, def.indexOf('AS $fn$')))).toBe(normalizeSql(
      `${GUARD_HEAD} RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp`));
    expect(EXEC.match(/SECURITY\s+DEFINER/gi)).toHaveLength(1);
    expect(EXEC).not.toMatch(/SECURITY\s+INVOKER|\bSTABLE\b|\bIMMUTABLE\b|\bLEAKPROOF\b|\bPARALLEL\s+SAFE\b/i);
  });

  it("reads the stock provenance - purchase_origin ALONE - ONLY inside the nested TG_TABLE_NAME = 'warehouse_stock' block (no 42703 on the procurement tables)", () => {
    const body = guardBody();
    expect(normalizeSql(body)).toContain(normalizeSql(`IF TG_TABLE_NAME = 'warehouse_stock' THEN
      IF NEW.purchase_origin IS DISTINCT FROM 'supplementary' THEN
        RETURN NEW;
      END IF;
    END IF;`));
    const outer = body.indexOf("IF TG_TABLE_NAME = 'warehouse_stock' THEN");
    const inner = body.indexOf("IF NEW.purchase_origin IS DISTINCT FROM 'supplementary' THEN", outer);
    const innerEnd = body.indexOf('END IF;', inner);
    const outerEnd = body.indexOf('END IF;', innerEnd + 'END IF;'.length);
    expect(outer).toBeGreaterThan(0);
    expect(inner).toBeGreaterThan(outer);
    expect(outerEnd).toBeGreaterThan(innerEnd);
    // Exactly ONE provenance field reference, strictly inside the nested block - and it is purchase_origin.
    const fieldRefs = [...body.matchAll(/\b(NEW|OLD)\.(supply_type|purchase_origin)\b/gi)];
    expect(fieldRefs.map((m) => m[0])).toEqual(['NEW.purchase_origin']);
    for (const m of fieldRefs) {
      expect(m.index ?? -1).toBeGreaterThan(inner);
      expect(m.index ?? -1).toBeLessThan(innerEnd);
    }
    // No supply_type predicate whatsoever: the M088 CHECK lets supply_type NULL pass with 'supplementary'.
    expect(body).not.toMatch(/supply_type/i);
    // TG_TABLE_NAME is compared once, by equality against exactly warehouse_stock, and never combined with a
    // provenance read in one expression.
    expect(body.match(/TG_TABLE_NAME/g)).toHaveLength(1);
    expect(/IF TG_TABLE_NAME = '([a-z_]+)' THEN/.exec(body)?.[1]).toBe('warehouse_stock');
    expect(body).not.toMatch(/TG_TABLE_NAME\s*(<>|!=|\bIN\b|NOT\s+IN|LIKE|~)/i);
    expect(body).not.toMatch(/TG_TABLE_NAME[^;\n]*(supply_type|purchase_origin)/i);
    expect(body).not.toMatch(/TG_OP/);
    expect(body).not.toMatch(/warehouse_quarantine_stock|procurement_receipt|procurement_return|procurement_order/i);
    // The only other NEW field the guard reads is organization_id, common to all eight tables.
    expect([...new Set([...body.matchAll(/\bNEW\.([a-z_]+)/gi)].map((m) => m[1]))].sort())
      .toEqual(['organization_id', 'purchase_origin']);
    expect(body).not.toMatch(/\bOLD\./);
  });

  it('judges the canonical kind; a missing organization fails closed; 23514 with a STATIC detail', () => {
    const body = guardBody();
    expect(normalizeSql(body)).toContain(normalizeSql(`SELECT o.organization_kind INTO v_kind
      FROM public.organizations o
     WHERE o.id = NEW.organization_id;
    IF NOT FOUND OR v_kind IS DISTINCT FROM 'care_institution' THEN
      RAISE EXCEPTION '${TOKEN}'
        USING ERRCODE = '23514',
              DETAIL = 'Supplementary procurement is limited to care institutions.';
    END IF;
    RETURN NEW;`));
    expect(body.match(/RAISE\s+EXCEPTION/gi)).toHaveLength(1);
    const raise = body.slice(body.indexOf('RAISE EXCEPTION'), body.indexOf(';', body.indexOf('RAISE EXCEPTION')));
    expect(raise).not.toMatch(/format\s*\(|TG_TABLE_NAME|TG_OP|NEW\.|OLD\.|v_kind|%|\|\|/i);
    expect(raise).not.toMatch(/\bHINT\b/i);
    // Never inferred from a role, a permission, a warehouse or a name.
    expect(body).not.toMatch(/auth\.uid|phoenix_my_role|permission|warehouse_kind|\bname\b|profiles|super_admin/i);
    expect(body).not.toMatch(/\bRETURN\s+NULL\b/i);
  });

  it('reads exactly public.organizations; writes nothing; no dynamic SQL; every application object qualified', () => {
    const body = guardBody();
    expect([...body.matchAll(/\bFROM\s+([a-z_."]+)/gi)].map((m) => m[1])).toEqual(['public.organizations']);
    expect(body).not.toMatch(/\bJOIN\b/i);
    expect(body).not.toMatch(/\b(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+/i);
    expect(body).not.toMatch(/\bexecute\b|\bperform\b/i);
    expect(body).not.toMatch(/(from|join|into|update|table)\s+(only\s+)?"?(organizations|warehouses|warehouse_stock|procurement_)/i);
    expect(body).not.toMatch(/FOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i);
  });
});

describe('PDA-PROC-1/M221 static — the twelve triggers on eight tables (narrow events)', () => {
  // Before VERIFY only: VERIFY's pinned inventory quotes each definition as a string.
  const created = [...CODE.slice(0, VERIFY_AT).matchAll(/CREATE TRIGGER[^;]*;/g)].map((m) => normalizeSql(m[0]));
  const targetsOf = (src: string) => [...src.matchAll(/CREATE\s+TRIGGER\s+[a-z_"]+\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\s+[^;]*?\bON\s+(?:ONLY\s+)?("?[a-z_]+"?\.)?"?([a-z_]+)"?\s/gi)]
    .map((m) => m[2]);
  const onTable = (table: string) => new RegExp(`\\bON\\s+(ONLY\\s+)?("?public"?\\.)?"?${table}"?\\b`, 'i');

  it('exactly the twelve reviewed CREATE TRIGGER statements: table, timing, events, UPDATE OF list and WHEN text', () => {
    expect(created).toEqual(TRIGGERS.map((t) => normalizeSql(t.sql)));
    expect(created).toHaveLength(12);
    expect(EXEC.match(/CREATE\s+TRIGGER/gi)).toHaveLength(12);
    expect(CODE.match(/CREATE\s+TRIGGER/gi)).toHaveLength(12 + 12); // the twelve statements + the twelve pinned VERIFY strings
  });

  it('binds exactly the eight guarded tables (suppliers 2, orders 2, order lines 2, order events 1, receipts 1, receipt lines 1, returns 1, warehouse_stock 2) - and NO trigger on warehouse_quarantine_stock (never even named) or outlet_stock', () => {
    // Every CREATE TRIGGER in the executable SQL (literals blanked) targets a guarded table.
    const targets = targetsOf(EXEC);
    expect(targets).toHaveLength(12);
    expect([...new Set(targets)].sort()).toEqual([...GUARDED_TABLES].sort());
    const perTableCount: Record<string, number> = {
      procurement_suppliers: 2, procurement_orders: 2, procurement_order_lines: 2, procurement_order_events: 1, procurement_receipts: 1,
      procurement_receipt_lines: 1, procurement_returns: 1, warehouse_stock: 2,
    };
    expect(Object.keys(perTableCount).sort()).toEqual([...GUARDED_TABLES].sort());
    for (const table of GUARDED_TABLES) expect(targets.filter((t) => t === table), table).toHaveLength(perTableCount[table]);
    // The four INSERT-ONLY children (order events, receipts, receipt lines, returns): ONE binding each, BEFORE INSERT, no
    // WHEN (the whole row is judged), and NO UPDATE or DELETE binding by M221 - their UPDATE is refused by the M087
    // immutability triggers the prelude pins.
    for (const table of INSERT_ONLY_CHILD_TABLES) {
      const own = TRIGGERS.filter((t) => t.table === table);
      expect(own, table).toHaveLength(1);
      expect(normalizeSql(own[0].sql)).toBe(`CREATE TRIGGER ${own[0].name} BEFORE INSERT ON public.${table} FOR EACH ROW ${EXEC_GUARD}`);
      expect(own[0].name, table).toMatch(/^phoenix_pda_[a-z_]+_insert_guard$/);
      expect(EXEC, table).not.toMatch(new RegExp(`CREATE\\s+TRIGGER[^;]*\\bUPDATE\\b[^;]*${onTable(table).source}`, 'i'));
      expect(EXEC, table).not.toMatch(new RegExp(`CREATE\\s+TRIGGER[^;]*\\bDELETE\\b[^;]*${onTable(table).source}`, 'i'));
      const stmts = created.filter((s) => s.includes(` ON public.${table} `));
      expect(stmts, table).toHaveLength(1);
      for (const stmt of stmts) {
        expect(stmt, table).toMatch(/ BEFORE INSERT ON /);
        expect(stmt, table).not.toMatch(/\bUPDATE\b| WHEN \(/);
      }
    }
    // procurement_order_events in particular: the immutability trigger refuses its UPDATE, so M221 binds INSERT only.
    expect(created.filter((s) => s.includes(' ON public.procurement_order_events '))).toEqual([
      `CREATE TRIGGER phoenix_pda_order_event_insert_guard BEFORE INSERT ON public.procurement_order_events FOR EACH ROW ${EXEC_GUARD}`]);
    // procurement_order_lines has NO immutability trigger: INSERT (whole row, no WHEN) AND UPDATE OF organization_id WHEN
    // it changes - never DELETE, never a bare UPDATE.
    expect(created.filter((s) => s.includes(' ON public.procurement_order_lines '))).toEqual([
      `CREATE TRIGGER phoenix_pda_order_line_insert_guard BEFORE INSERT ON public.procurement_order_lines FOR EACH ROW ${EXEC_GUARD}`,
      'CREATE TRIGGER phoenix_pda_order_line_reassign_guard BEFORE UPDATE OF organization_id ON public.procurement_order_lines FOR EACH ROW '
        + `${REASSIGN_WHEN} ${EXEC_GUARD}`,
    ]);
    expect(EXEC).not.toMatch(new RegExp(`CREATE\\s+TRIGGER[^;]*\\bDELETE\\b[^;]*${onTable('procurement_order_lines').source}`, 'i'));
    expect(EXEC).not.toMatch(new RegExp(`CREATE\\s+TRIGGER[^;]*\\bBEFORE\\s+UPDATE\\s+ON\\b[^;]*${onTable('procurement_order_lines').source}`, 'i'));
    for (const table of UNBOUND_TABLES) {
      expect(targets, table).not.toContain(table);
      expect(EXEC, table).not.toMatch(new RegExp(`CREATE\\s+TRIGGER[^;]*${onTable(table).source}`, 'i'));
      expect(CODE, table).not.toMatch(new RegExp(`COMMENT\\s+ON\\s+TRIGGER[^;]*${onTable(table).source}`, 'i'));
      expect(TRIGGERS.map((t) => t.table), table).not.toContain(table);
    }
    // warehouse_quarantine_stock is named by no CREATE TRIGGER at all (statement or pinned VERIFY string), and by no
    // statement of the file whatsoever.
    for (const stmt of CODE.match(/CREATE\s+TRIGGER[^;]*;/gi) ?? []) expect(stmt).not.toMatch(/warehouse_quarantine_stock/i);
    expect(EXEC).not.toMatch(/warehouse_quarantine_stock/i);
    expect(CODE).not.toMatch(/warehouse_quarantine_stock/i);
    expect(targetsOf(CODE)).toHaveLength(12 + 12);
    expect(new Set(targetsOf(CODE))).toEqual(new Set(GUARDED_TABLES));
  });

  it('narrow: BEFORE ROW only; INSERT or UPDATE OF a column list, never both, never DELETE/TRUNCATE/STATEMENT/AFTER; every stock trigger and every UPDATE trigger has a WHEN', () => {
    for (const s of created) {
      expect(s).toMatch(/ BEFORE (INSERT|UPDATE OF [a-z_, ]+) ON public\.[a-z_]+ FOR EACH ROW /);
      expect(s).not.toMatch(/\bAFTER\b|\bINSTEAD\b|\bDELETE\b|\bTRUNCATE\b|FOR EACH STATEMENT|\bOR\s+(INSERT|UPDATE)\b|BEFORE UPDATE ON/);
      expect(s.endsWith(EXEC_GUARD)).toBe(true);
      if (/BEFORE UPDATE OF/.test(s) || /ON public\.warehouse_stock /.test(s)) expect(s, s).toMatch(/ WHEN \(/);
    }
    // Per table: suppliers/orders/order lines insert + re-label; order events, receipts, receipt lines and returns insert
    // only; stock insert + reforge.
    const perTable = (table: string) => TRIGGERS.filter((t) => t.table === table).map((t) => t.name);
    expect(perTable('procurement_suppliers')).toEqual(['phoenix_pda_supplier_insert_guard', 'phoenix_pda_supplier_reassign_guard']);
    expect(perTable('procurement_orders')).toEqual(['phoenix_pda_order_insert_guard', 'phoenix_pda_order_reassign_guard']);
    expect(perTable('procurement_order_lines')).toEqual(['phoenix_pda_order_line_insert_guard', 'phoenix_pda_order_line_reassign_guard']);
    expect(perTable('procurement_order_events')).toEqual(['phoenix_pda_order_event_insert_guard']);
    expect(perTable('procurement_receipts')).toEqual(['phoenix_pda_receipt_insert_guard']);
    expect(perTable('procurement_receipt_lines')).toEqual(['phoenix_pda_receipt_line_insert_guard']);
    expect(perTable('procurement_returns')).toEqual(['phoenix_pda_return_insert_guard']);
    expect(perTable('warehouse_stock')).toEqual(['phoenix_pda_supplementary_stock_insert_guard', 'phoenix_pda_supplementary_stock_reforge_guard']);
    expect([...new Set(TRIGGERS.map((t) => t.table))].sort()).toEqual([...GUARDED_TABLES].sort());
    // The UPDATE OF column lists: organization_id on suppliers/orders/order lines; purchase_origin, organization_id on
    // stock (no supply_type). No UPDATE binding on any INSERT-only child.
    expect(created.map((s) => /BEFORE UPDATE OF ([a-z_, ]+) ON public\.([a-z_]+) /.exec(s)).filter(Boolean).map((m) => `${m![2]}:${m![1]}`))
      .toEqual(['procurement_suppliers:organization_id', 'procurement_orders:organization_id', 'procurement_order_lines:organization_id',
        'warehouse_stock:purchase_origin, organization_id']);
    // The three organization re-label bindings judge only a CHANGED organization_id: the identical WHEN on each.
    for (const table of ['procurement_suppliers', 'procurement_orders', 'procurement_order_lines']) {
      const update = created.filter((s) => s.includes(` ON public.${table} `) && s.includes('BEFORE UPDATE OF'));
      expect(update, table).toHaveLength(1);
      expect(update[0], table).toContain(`BEFORE UPDATE OF organization_id ON public.${table} FOR EACH ROW ${REASSIGN_WHEN} ${EXEC_GUARD}`);
    }
  });

  it("the stock predicate is purchase_origin ALONE: no supply_type in either stock WHEN, column list, the function, the census or VERIFY - only in prose", () => {
    const stock = created.filter((s) => s.includes(' ON public.warehouse_stock '));
    expect(stock).toHaveLength(2);
    for (const s of stock) {
      expect(s).not.toMatch(/supply_type/i);
      expect(s).toContain("NEW.purchase_origin = 'supplementary'");
    }
    expect(stock[0]).toContain("WHEN (NEW.purchase_origin = 'supplementary') EXECUTE");
    expect(stock[1]).toContain("WHEN (NEW.purchase_origin = 'supplementary' AND (OLD.purchase_origin IS DISTINCT FROM NEW.purchase_origin "
      + 'OR OLD.organization_id IS DISTINCT FROM NEW.organization_id))');
    // Executable SQL (literals blanked) never names supply_type; in the comment-stripped code it survives only inside the
    // COMMENT ON literals ("any supply_type").
    expect(EXEC).not.toMatch(/supply_type/i);
    const withoutComments = CODE.replace(/COMMENT ON (FUNCTION|TRIGGER)[^;]*;/g, '');
    expect(withoutComments).not.toMatch(/supply_type/i);
    expect(PRELUDE).not.toMatch(/supply_type/i);
    expect(VERIFY).not.toMatch(/supply_type/i);
    expect(guardBody()).not.toMatch(/supply_type/i);
  });

  it('each trigger fires before every existing BEFORE ROW trigger of its table (byte order of names)', () => {
    expect(Object.keys(EXISTING_BEFORE_TRIGGERS).sort()).toEqual([...GUARDED_TABLES].sort());
    for (const t of TRIGGERS) {
      for (const existing of EXISTING_BEFORE_TRIGGERS[t.table]) {
        expect(byteOrder(t.name, existing), `${t.name} < ${existing}`).toBe(-1);
      }
    }
  });

  it('every trigger and the function carry a PDA-PROC-1 comment; the INSERT-only child comments name the immutability trigger that refuses their UPDATE; the order-line re-label comment says why it exists', () => {
    for (const t of TRIGGERS) {
      expect(normalizeSql(CODE), t.name).toMatch(new RegExp(`COMMENT ON TRIGGER ${t.name} ON public\\.${t.table} IS 'PDA-PROC-1 \\(221\\): `));
    }
    expect(normalizeSql(CODE).match(/COMMENT ON TRIGGER /g)).toHaveLength(12);
    expect(normalizeSql(CODE)).toContain(`COMMENT ON FUNCTION ${GUARD}() IS 'PDA-PROC-1 (221) internal: `);
    expect(normalizeSql(CODE)).toContain('BEFORE ROW guard on procurement_suppliers, procurement_orders, procurement_order_lines, '
      + 'procurement_order_events, procurement_receipts, procurement_receipt_lines, procurement_returns and warehouse_stock rows');
    for (const table of INSERT_ONLY_CHILD_TABLES) {
      const name = TRIGGERS.find((t) => t.table === table)!.name;
      const comment = new RegExp(`COMMENT ON TRIGGER ${name} ON public\\.${table} IS '[^']*\\(UPDATE is refused by ${table}_immutable\\)\\.'`);
      expect(normalizeSql(CODE), table).toMatch(comment);
    }
    expect(normalizeSql(CODE)).toContain("COMMENT ON TRIGGER phoenix_pda_order_line_insert_guard ON public.procurement_order_lines IS "
      + "'PDA-PROC-1 (221): a procurement order line may be recorded only for a care institution.';");
    expect(normalizeSql(CODE)).toContain("COMMENT ON TRIGGER phoenix_pda_order_line_reassign_guard ON public.procurement_order_lines IS "
      + "'PDA-PROC-1 (221): a procurement order line may be re-labelled only onto a care institution (the table has no immutability trigger).';");
    expect(normalizeSql(CODE)).toContain("COMMENT ON TRIGGER phoenix_pda_order_event_insert_guard ON public.procurement_order_events IS "
      + "'PDA-PROC-1 (221): a procurement order event may be recorded only for a care institution (UPDATE is refused by procurement_order_events_immutable).';");
  });
});

describe('PDA-PROC-1/M221 static — VERIFY', () => {
  it('re-proves the function, its ACL, the exact twelve bindings, the firing order and the census of the eight guarded tables under the lock', () => {
    expect(VERIFY.length).toBeGreaterThan(0);
    for (const needle of [
      "AND p.prosecdef AND p.provolatile = 'v' AND p.prokind = 'f' AND NOT p.proretset",
      "AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype",
      "AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']",
      'AND p.proowner = v_me) THEN',
      'WHERE p.oid = v_fn AND a.grantee = 0)',
      "OR pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')",
      "OR pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')",
      "OR pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') THEN",
      'WHERE t.tgfoid = v_fn AND NOT t.tgisinternal) s;',
      "RAISE EXCEPTION 'VERIFY FAILED (221): the guard is not bound by exactly the twelve reviewed triggers'",
      'AND (o.tgtype & 3) = 3',
      'AND o.tgname COLLATE "C" < t.tgname COLLATE "C") THEN',
      "RAISE EXCEPTION 'VERIFY FAILED (221): legacy non-care procurement rows present'",
    ]) {
      expect(VERIFY, needle).toContain(needle);
    }
    // The pinned inventory names each trigger once, on its own table, with its tgtype (7 INSERT, 19 UPDATE OF).
    const inventory = VERIFY.slice(VERIFY.indexOf('IF v_found IS DISTINCT FROM ARRAY['), VERIFY.indexOf(']::text[] THEN'));
    const rows = [...inventory.matchAll(/'([a-z_]+)\|([a-z_]+)\|(\d+)\|O\|([a-z_,-]+)\|CREATE TRIGGER ([a-z_]+) /g)];
    expect(rows.map((m) => [m[1], m[2], Number(m[3]), m[4]])).toEqual(
      [...TRIGGERS].sort((a, b) => byteOrder(`${a.table}|${a.name}`, `${b.table}|${b.name}`)).map((t) => [
        t.table, t.name, t.sql.includes('BEFORE UPDATE OF') ? 19 : 7,
        t.sql.includes('BEFORE UPDATE OF') ? t.sql.replace(/^.* BEFORE UPDATE OF ([a-z_, ]+) ON .*$/, '$1').replace(/, /g, ',') : '-',
      ]));
    for (const m of rows) expect(m[5]).toBe(m[2]);
    expect(rows).toHaveLength(12);
    expect(inventory.match(/\|CREATE TRIGGER /g)).toHaveLength(12);
    for (const table of UNBOUND_TABLES) expect(inventory, table).not.toContain(table);
    expect(inventory).not.toMatch(/supply_type/);
    // The four INSERT-only child bindings are pinned as plain BEFORE INSERT (tgtype 7, no column list, no WHEN), and
    // nothing else on their tables.
    for (const table of INSERT_ONLY_CHILD_TABLES) {
      const t = TRIGGERS.find((x) => x.table === table)!;
      expect(inventory).toContain(`'${table}|${t.name}|7|O|-|CREATE TRIGGER ${t.name} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION ${GUARD}()'`);
      expect(rows.filter((m) => m[1] === table), table).toHaveLength(1);
    }
    // The two order-line bindings: INSERT, and UPDATE OF organization_id WHEN it changes (deparsed form).
    expect(rows.filter((m) => m[1] === 'procurement_order_lines').map((m) => m[2])).toEqual(
      ['phoenix_pda_order_line_insert_guard', 'phoenix_pda_order_line_reassign_guard']);
    expect(inventory).toContain(`'procurement_order_lines|phoenix_pda_order_line_insert_guard|7|O|-|CREATE TRIGGER phoenix_pda_order_line_insert_guard BEFORE INSERT ON public.procurement_order_lines FOR EACH ROW EXECUTE FUNCTION ${GUARD}()'`);
    expect(inventory).toContain(`'procurement_order_lines|phoenix_pda_order_line_reassign_guard|19|O|organization_id|CREATE TRIGGER phoenix_pda_order_line_reassign_guard BEFORE UPDATE OF organization_id ON public.procurement_order_lines FOR EACH ROW WHEN ((old.organization_id IS DISTINCT FROM new.organization_id)) EXECUTE FUNCTION ${GUARD}()'`);
    // Each pinned definition is the deparsed form of the authored statement (spot-checked on the two stock bindings).
    expect(inventory).toContain("'warehouse_stock|phoenix_pda_supplementary_stock_insert_guard|7|O|-|CREATE TRIGGER phoenix_pda_supplementary_stock_insert_guard BEFORE INSERT ON public.warehouse_stock FOR EACH ROW WHEN ((new.purchase_origin = ''supplementary''::text)) EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()'");
    expect(inventory).toContain("'warehouse_stock|phoenix_pda_supplementary_stock_reforge_guard|19|O|purchase_origin,organization_id|CREATE TRIGGER phoenix_pda_supplementary_stock_reforge_guard BEFORE UPDATE OF purchase_origin, organization_id ON public.warehouse_stock FOR EACH ROW WHEN (((new.purchase_origin = ''supplementary''::text) AND ((old.purchase_origin IS DISTINCT FROM new.purchase_origin) OR (old.organization_id IS DISTINCT FROM new.organization_id)))) EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()'");
    // The census VERIFY re-runs is exactly the eight guarded tables (ord 1..8), each subquery identical to the prelude's.
    const verifyCensus = censusOf(VERIFY);
    expect(verifyCensus.map(([ord, rel]) => [ord, rel])).toEqual(VERIFY_CENSUS.map((rel, i) => [i + 1, rel]));
    expect([...VERIFY_CENSUS].sort()).toEqual([...GUARDED_TABLES].sort());
    const preludeCensus = new Map(censusOf(PRELUDE).map(([, rel, clause]) => [rel, clause]));
    for (const [, rel, clause] of verifyCensus) expect(clause, rel).toBe(preludeCensus.get(rel));
    expect(verifyCensus.find(([, rel]) => rel === 'warehouse_stock')?.[2]).toBe(normalizeSql(`FROM public.warehouse_stock t
           WHERE t.purchase_origin = 'supplementary'
             AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')`));
    expect(VERIFY).not.toContain('SELECT 9,');
    expect(VERIFY).not.toMatch(/warehouse_quarantine_stock|outlet_stock/);
    expect(VERIFY).not.toMatch(/supply_type/);
    // The prelude and VERIFY read, never write, and call no application routine (literals blanked).
    const verifyExec = EXEC.slice(EXEC.indexOf('DO $verify$'), EXEC.indexOf('$verify$;'));
    const preludeExec = EXEC.slice(EXEC.indexOf('DO $prelude$'), EXEC.indexOf('$prelude$;'));
    for (const block of [verifyExec, preludeExec]) {
      expect(block.length).toBeGreaterThan(0);
      expect(block).not.toMatch(/\b(public|phoenix_private)\.[a-z_0-9]+\s*\(/i);
      expect(block).not.toMatch(/\b(insert\s+into|update\s+[a-z_."]+\s+set|delete\s+from|truncate|merge\s+into)\b/i);
    }
  });
});
