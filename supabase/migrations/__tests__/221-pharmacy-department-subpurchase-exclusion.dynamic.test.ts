/**
 * PDA-PROC-1 / M221 — DYNAMIC proof that a pharmacy department authority
 * (organization_kind = 'pharmacy_department_authority') holds no persistent
 * supplementary (local) procurement state, for ANY writer, against a real
 * disposable PostgreSQL.
 *
 * M221 binds TWELVE BEFORE ROW triggers on eight tables: procurement_suppliers,
 * procurement_orders and procurement_order_lines (INSERT; re-label of
 * organization_id - procurement_order_lines has no immutability trigger),
 * procurement_order_events, procurement_receipts, procurement_receipt_lines
 * and procurement_returns (INSERT ONLY - their UPDATE is refused for every role
 * by the M087 immutability triggers, latest body M141, which the prelude pins)
 * and warehouse_stock (a lot with purchase_origin = 'supplementary', WHATEVER
 * its supply_type, entering the PDA domain: INSERT and the reforge UPDATE).
 * warehouse_quarantine_stock is a custody destination and deliberately NOT
 * guarded. The cross-care child label mismatch (a care institution B label
 * under care institution A's order) is a deferred residual: it stays accepted.
 *
 * The rig is built through 220 first. On that chain the suite reproduces the
 * finding (a super_admin creates a PDA supplier through the canonical RPC; the
 * owner writes a PDA supplementary lot - also with supply_type NULL, which the
 * M088 CHECK lets through - and the owner and service_role write a PDA-labelled
 * order line, order event and receipt under a CARE order), fingerprints the
 * twelve procurement routines and every public routine, snapshots the triggers
 * of the child and custody tables, and exercises the migration's fail-closed
 * prelude (isolation, idempotence, partial set, applier, schema drift including
 * the four-trigger immutability pin, the legacy census - which custody rows
 * never trip), its bounded activation lock (the eight guarded tables only) and
 * VERIFY (tampering after the DDL, a thirteenth binding on quarantine or an
 * UPDATE binding on receipts or order events, and a non-care row another
 * connection commits between the prelude and the lock). M221 is then applied
 * through applyMigrationSql (the same replay buildRig() performs) and the
 * contract runs on the 001..221 chain:
 *
 *   1-6, 11  every PDA write is refused with
 *            pharmacy_department_supplementary_procurement_forbidden (23514,
 *            static detail) and writes nothing: supplier INSERT (owner,
 *            service_role, save_supplier as super_admin), supplier and order
 *            re-label, order INSERT, supplementary lot INSERT (owner SQL and a
 *            service_role call of the internal poster with a fabricated PDA
 *            order), provenance and organization reforge - with supply_type
 *            NULL too; a superuser session is no exception; a missing
 *            organization (also the data-modifying CTE that would create it
 *            after the check) is never eligible;
 *   7-9      the care institution flows are unchanged: save_supplier,
 *            create/add/submit/decide, receive_order, direct entry and the
 *            return to supplier;
 *   10       unrelated stock is unaffected (aid, kimadia, purchase/central and
 *            unspecified lots in a PDA central warehouse, raw and through the
 *            canonical central intake; quantity updates) and, with
 *            track_functions = 'all', unrelated stock writes and every custody
 *            (quarantine) write make ZERO calls of the guard while a care
 *            supplementary insert - (NULL, 'supplementary') included - makes
 *            at least one;
 *   12       a retried refusal is identical and still writes nothing;
 *   FORGED_PDA_CHILD_UNDER_CARE_ORDER
 *            a PDA-labelled procurement_order_lines, procurement_order_events,
 *            procurement_receipts, procurement_receipt_lines or
 *            procurement_returns row under a CARE parent is refused for the
 *            owner and service_role (whose INSERT/UPDATE/DELETE privileges are
 *            proven first by a care-labelled positive control); re-labelling an
 *            existing care order line onto the PDA is refused, the row
 *            unchanged; care-labelled children stay legal (raw, and through
 *            add_order_line and the RPCs that write the order events);
 *   IMMUTABILITY
 *            UPDATE ... SET organization_id = <PDA> (or any other column) on an
 *            existing care order event, receipt, receipt line or return is
 *            refused for the owner and service_role with 42501
 *            procurement_history_is_immutable, the row unchanged - by the M087
 *            trigger itself (still refused with M221 dropped; accepted only with
 *            that trigger disabled) - so M221 needs no UPDATE guard on them;
 *   PDA_RECEIPT_RETURN_BOUNDARY
 *            the M087 FK chain is in the catalog; a PDA order cannot be
 *            created (raw, RPC); a raw child with a non-existent parent is
 *            refused by M221 when PDA-labelled and fails 23503 when
 *            care-labelled; receive_order and return_to_supplier have no PDA
 *            order or receipt line to act on (P0002); every RPC-written
 *            receipt/return carries its care order's organization;
 *   QUARANTINE_RETURN_REGRESSION
 *            a legacy purchase/supplementary lot returned to a PDA central
 *            warehouse: after M221 the RESTOCKABLE receive is refused by the
 *            warehouse_stock guard (nothing written, line still in transit),
 *            and the QUARANTINED receive SUCCEEDS with the provenance
 *            preserved - identically to the same operation on the same state
 *            with M221 absent; M221 re-applies cleanly over that custody row;
 *            a care-institution return lands in quarantine and in stock as
 *            before;
 *   RESIDUAL the deferred cross-care child label mismatch is recorded as still
 *            accepted (evidence only, rolled back);
 *   extra    negative controls (the refusal IS the trigger, per binding), the
 *            twelve procurement routines and every other public routine
 *            byte-identical across M221, the custody table's triggers
 *            unchanged, the read-only duplicate-candidates RPC for a PDA
 *            central warehouse, idempotence before any lock.
 *
 * Every refusal names the expected SQLSTATE and message and proves no partial
 * write. Gated on PHOENIX_RIG_PG; skipped when no database is configured.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  applyMigrationSql, buildRig, migrationFiles, MIGRATIONS_DIR, rigAvailable, shimSql,
} from '../../../tools/pg-rig/rig.mjs';

const M221 = '221_phoenix_pharmacy_department_subpurchase_exclusion.sql';
const GUARD_SIG = 'public._phoenix_pda_supplementary_procurement_guard_v1()';
const GUARD_FN = '_phoenix_pda_supplementary_procurement_guard_v1';
const TOKEN = 'pharmacy_department_supplementary_procurement_forbidden';
const STATIC_DETAIL = 'Supplementary procurement is limited to care institutions.';
const LEGACY = '221_precondition_failed: legacy non-care procurement rows present';
const OWNER_OF_EIGHT = '221_precondition_failed: M221 must be applied by the owner of the eight guarded tables';
const IMMUTABILITY_DRIFT = '221_precondition_failed: schema drift: the M087 order-event, receipt, receipt-line and return immutability triggers are absent or changed';
const TWELVE = 'VERIFY FAILED (221): the guard is not bound by exactly the twelve reviewed triggers';
const FIRES_FIRST = 'VERIFY FAILED (221): a guard trigger does not fire before every other BEFORE ROW trigger of its table';
const IMMUTABLE = { code: '42501', message: 'procurement_history_is_immutable' };
/** The twelve bindings, in byte (C collation) order of their names. */
const TRIGGERS = [
  'phoenix_pda_order_event_insert_guard', 'phoenix_pda_order_insert_guard',
  'phoenix_pda_order_line_insert_guard', 'phoenix_pda_order_line_reassign_guard', 'phoenix_pda_order_reassign_guard',
  'phoenix_pda_receipt_insert_guard', 'phoenix_pda_receipt_line_insert_guard', 'phoenix_pda_return_insert_guard',
  'phoenix_pda_supplementary_stock_insert_guard', 'phoenix_pda_supplementary_stock_reforge_guard',
  'phoenix_pda_supplier_insert_guard', 'phoenix_pda_supplier_reassign_guard',
];
/** The eight guarded tables (C collation order). */
const GUARDED = ['procurement_order_events', 'procurement_order_lines', 'procurement_orders', 'procurement_receipt_lines',
  'procurement_receipts', 'procurement_returns', 'procurement_suppliers', 'warehouse_stock'];
/**
 * The five child tables (each carries its own organization_id under a procurement order), with their M221 INSERT
 * binding, their M221 re-label binding (procurement_order_lines only: it has no immutability trigger) and their M087
 * immutability trigger (the other four: it refuses every UPDATE, so M221 binds their INSERT only).
 */
const CHILD: Array<{ table: string; guard: string; reassign: string | null; immutable: string | null }> = [
  { table: 'procurement_order_lines', guard: 'phoenix_pda_order_line_insert_guard', reassign: 'phoenix_pda_order_line_reassign_guard', immutable: null },
  { table: 'procurement_order_events', guard: 'phoenix_pda_order_event_insert_guard', reassign: null, immutable: 'procurement_order_events_immutable' },
  { table: 'procurement_receipts', guard: 'phoenix_pda_receipt_insert_guard', reassign: null, immutable: 'procurement_receipts_immutable' },
  { table: 'procurement_receipt_lines', guard: 'phoenix_pda_receipt_line_insert_guard', reassign: null, immutable: 'procurement_receipt_lines_immutable' },
  { table: 'procurement_returns', guard: 'phoenix_pda_return_insert_guard', reassign: null, immutable: 'procurement_returns_immutable' },
];
/** The four INSERT-only children whose UPDATE the M087 immutability trigger refuses. */
const IMMUTABLE_CHILD = CHILD.filter((c) => c.immutable !== null) as Array<{ table: string; guard: string; reassign: null; immutable: string }>;
/** No PDA-labelled row in any of the five child tables. */
const NO_PDA_CHILDREN = { order_lines: 0, order_events: 0, receipts: 0, receipt_lines: 0, returns: 0 };
/** The custody destination M221 deliberately leaves unguarded. */
const UNGUARDED = ['warehouse_quarantine_stock'];
/** Tables whose triggers are snapshotted on 220 and compared on 221 (children gain exactly their insert binding). */
const SNAPSHOTTED = ['procurement_order_events', 'procurement_order_lines', 'procurement_receipt_lines', 'procurement_receipts',
  'procurement_returns', 'warehouse_quarantine_stock'];
const PROCUREMENT_ROUTINES = [
  '_phoenix_procurement_post_receipt_line', 'phoenix_procurement_add_order_line', 'phoenix_procurement_cancel_order',
  'phoenix_procurement_create_order', 'phoenix_procurement_decide_order', 'phoenix_procurement_receive_order',
  'phoenix_procurement_remove_order_line', 'phoenix_procurement_return_to_supplier', 'phoenix_procurement_save_supplier',
  'phoenix_procurement_submit_order', 'phoenix_subpurchase_direct_entry', 'phoenix_subpurchase_duplicate_candidates',
];

const ORG_PDA = '00000000-0000-0000-0000-000000221001';   // pharmacy department authority
const ORG_CARE = '00000000-0000-0000-0000-000000221002';  // care institution (hospital)
const ORG_CARE2 = '00000000-0000-0000-0000-000000221003'; // a second care institution
const WH_PDA = '00000000-0000-0000-0000-000000221101';    // PDA central warehouse
const WH_CARE = '00000000-0000-0000-0000-000000221102';   // care institution warehouse (procurement root)
const WH_CARE_CENTRAL = '00000000-0000-0000-0000-000000221103'; // a care-owned central warehouse
const ROUTE_CARE = '00000000-0000-0000-0000-000000221201'; // care central -> care institution (primary)
const ROUTE_PDA = '00000000-0000-0000-0000-000000221202';  // PDA central -> care institution (fallback)
const U_OFFICER = '00000000-0000-0000-0000-000000221401';  // warehouse_officer @ WH_CARE
const U_APPROVER = '00000000-0000-0000-0000-000000221402'; // institution_admin of ORG_CARE

/** Every table a refusal must leave untouched (row counts). */
const COUNTED = [
  'organizations', 'procurement_suppliers', 'procurement_orders', 'procurement_order_lines', 'procurement_receipts',
  'procurement_receipt_lines', 'procurement_returns', 'procurement_order_events', 'warehouse_stock', 'warehouse_stock_movements',
  'warehouse_quarantine_stock', 'warehouse_quarantine_stock_movements', 'warehouse_return_shipment_lines', 'audit_logs',
];

interface Refusal { code: string; message: string; detail?: string }

/** Resolves to the database error a call was refused with; fails the test if it succeeded. */
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string };
    return { code: String(err.code), message: String(err.message), detail: err.detail };
  }
  throw new Error('expected the database to refuse this call, but it succeeded');
}

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${(seq += 1)}`;

describe.runIf(rigAvailable())('PDA-PROC-1/M221 pharmacy department supplementary procurement exclusion — dynamic (PostgreSQL)', { timeout: 180_000 }, () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let fingerprintsBefore: any[] = [];
  let routinesBefore: any[] = [];
  let snapshotTriggersBefore: any[] = [];
  let supplierCare = '';      // care supplier created on the 220 chain (referenced by an order)
  let draftOrderCare = '';    // care draft order created on the 220 chain
  let draftOrderLineCare = ''; // its order line

  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));
  /** Runs `fn` on one superuser connection inside a transaction that is ALWAYS rolled back. */
  const rolledBack = <T>(fn: (c: any) => Promise<T>): Promise<T> => rig.asAdmin(async (c: any) => {
    await c.query('BEGIN');
    try { return await fn(c); } finally { await c.query('ROLLBACK'); }
  });
  /** One RPC as an authenticated user, committed. */
  const rpc = (userId: string, fn: string, args: unknown[], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((r: any) => r.rows[0].r), { role, commit: true });
  /** Raw SQL as service_role (bypasses RLS, not superuser), committed. */
  const asService = (sql: string, params: unknown[] = []) =>
    rig.asUser(null, (c: any) => c.query(sql, params).then((r: any) => r.rows), { role: 'service_role', commit: true });
  /** Runs `fn` as service_role inside a transaction that is ALWAYS rolled back. */
  const serviceRolledBack = <T>(fn: (c: any) => Promise<T>): Promise<T> => rig.asUser(null, fn, { role: 'service_role' });
  /** One statement inside a SAVEPOINT: its error (or null) without aborting the surrounding transaction. */
  const attempt = async (c: any, sql: string, params: unknown[] = []): Promise<Refusal | null> => {
    await c.query('SAVEPOINT m221_attempt');
    try {
      await c.query(sql, params);
      await c.query('RELEASE SAVEPOINT m221_attempt');
      return null;
    } catch (e: any) {
      await c.query('ROLLBACK TO SAVEPOINT m221_attempt');
      return { code: String(e.code), message: String(e.message), detail: e.detail };
    }
  };

  const counts = async () => (await admin(`SELECT ${COUNTED.map((t) => `(SELECT count(*) FROM public.${t})::int AS ${t}`).join(', ')}`))[0];

  /**
   * The refusal contract: exact SQLSTATE and message (and, for the M221 token, the static
   * detail), nothing written — and a RETRY of the very same call is refused identically
   * and still writes nothing (Director test 12).
   */
  async function refused(action: () => Promise<unknown>, expected: { code: string; message: string } = { code: '23514', message: TOKEN }) {
    const before = await counts();
    const first = await refusal(action());
    expect({ code: first.code, message: first.message }).toEqual(expected);
    if (expected.message === TOKEN) expect(first.detail).toBe(STATIC_DETAIL);
    expect(await counts()).toEqual(before);
    const retry = await refusal(action());
    expect(retry).toEqual(first);
    expect(await counts()).toEqual(before);
    return first;
  }

  // ---- fixtures ----------------------------------------------------------------
  const LOT = `INSERT INTO public.warehouse_stock
      (organization_id, warehouse_id, scientific_name, has_no_national_code, batch_number, has_no_batch_number,
       expiry_date, on_hand_quantity, supply_type, purchase_origin)
    VALUES ($1, $2, $3, true, $4, false, '2028-01-01', $5, $6, $7) RETURNING id`;
  const lotParams = (org: string, wh: string, supply: string | null, origin: string | null, qty = 10) =>
    [org, wh, uniq('M221 lot'), uniq('B'), qty, supply, origin];
  const insertLot = async (org: string, wh: string, supply: string | null, origin: string | null, qty = 10) =>
    (await admin(LOT, lotParams(org, wh, supply, origin, qty)))[0].id as string;
  const lotRow = async (id: string) => (await admin(
    `SELECT organization_id, warehouse_id, supply_type, purchase_origin, on_hand_quantity FROM public.warehouse_stock WHERE id = $1`, [id]))[0];
  const QLOT = `INSERT INTO public.warehouse_quarantine_stock
      (organization_id, warehouse_id, scientific_name, has_no_national_code, batch_number, has_no_batch_number,
       expiry_date, quarantine_reason, quantity, supply_type, purchase_origin)
    VALUES ($1, $2, $3, true, $4, false, '2028-01-01', 'damaged', $5, $6, $7) RETURNING id`;
  const qlotParams = (org: string, wh: string, supply: string | null, origin: string | null, qty = 3) =>
    [org, wh, uniq('M221 quarantine'), uniq('Q'), qty, supply, origin];
  /** PDA rows with purchase_origin 'supplementary', WHATEVER their supply_type. */
  const pdaSupplementaryQuarantine = async () => (await admin(`SELECT count(*)::int AS n FROM public.warehouse_quarantine_stock
    WHERE organization_id = $1 AND purchase_origin = 'supplementary'`, [ORG_PDA]))[0].n as number;
  const pdaSupplementaryStock = async () => (await admin(`SELECT count(*)::int AS n FROM public.warehouse_stock
    WHERE organization_id = $1 AND purchase_origin = 'supplementary'`, [ORG_PDA]))[0].n as number;
  const pdaChildren = async () => (await admin(`SELECT (SELECT count(*) FROM procurement_order_lines WHERE organization_id = $1)::int AS order_lines,
      (SELECT count(*) FROM procurement_order_events WHERE organization_id = $1)::int AS order_events,
      (SELECT count(*) FROM procurement_receipts WHERE organization_id = $1)::int AS receipts,
      (SELECT count(*) FROM procurement_receipt_lines WHERE organization_id = $1)::int AS receipt_lines,
      (SELECT count(*) FROM procurement_returns WHERE organization_id = $1)::int AS returns`, [ORG_PDA]))[0];
  const supplierRow = async (id: string) => (await admin(`SELECT * FROM public.procurement_suppliers WHERE id = $1`, [id]))[0];
  const orderRow = async (id: string) => (await admin(`SELECT * FROM public.procurement_orders WHERE id = $1`, [id]))[0];
  const rowJson = async (table: string, id: string) => (await admin(`SELECT to_jsonb(t) AS j FROM public.${table} t WHERE t.id = $1`, [id]))[0]?.j;

  // ---- raw child-table writes (every id fixed by the caller, so a retry is the identical statement) ----
  const ORDER_LINE = `INSERT INTO public.procurement_order_lines (order_id, organization_id, scientific_name, ordered_quantity)
      VALUES ($1, $2, $3, 1) RETURNING id, organization_id`;
  const ORDER_EVENT = `INSERT INTO public.procurement_order_events (order_id, organization_id, event_type, notes)
      VALUES ($1, $2, 'm221_probe', $3) RETURNING id, organization_id`;
  const orderLineParams = (order: string, org: string) => [order, org, uniq('M221 line')];
  const orderEventParams = (order: string, org: string) => [order, org, uniq('M221 event')];
  const RECEIPT =`INSERT INTO public.procurement_receipts (order_id, organization_id, warehouse_id, supplier_id, receipt_number,
      request_id, request_fingerprint, received_by) VALUES ($1, $2, $3, $4, $5, $6, repeat('a', 64), $7) RETURNING id, organization_id`;
  const RECEIPT_LINE = `INSERT INTO public.procurement_receipt_lines (receipt_id, order_line_id, organization_id, quantity,
      batch_number, has_no_batch_number, has_no_national_code) VALUES ($1, $2, $3, 1, NULL, true, true) RETURNING id, organization_id`;
  const RETURN = `INSERT INTO public.procurement_returns (request_id, request_fingerprint, order_id, receipt_line_id, organization_id,
      warehouse_id, quantity, reason) VALUES ($1, repeat('b', 64), $2, $3, $4, $5, 1, 'M221 probe') RETURNING id, organization_id`;
  const receiptParams = (order: string, org: string, supplier: string, wh = WH_CARE) =>
    [order, org, wh, supplier, uniq('R221'), randomUUID(), rig.superAdminId];
  const receiptLineParams = (receipt: string, orderLine: string, org: string) => [receipt, orderLine, org];
  const returnParams = (order: string, receiptLine: string, org: string, wh = WH_CARE) => [randomUUID(), order, receiptLine, org, wh];

  const saveSupplier = (actor: string, org: string, name = uniq('Supplier')) =>
    rpc(actor, 'phoenix_procurement_save_supplier', [org, null, name, null, null, null, null, null, null, null, null]);
  const createOrder = (actor: string, supplier: string, warehouse = WH_CARE) =>
    rpc(actor, 'phoenix_procurement_create_order', [warehouse, supplier, uniq('PO'), uniq('INV'), '2026-07-01', null, 'IQD', 'M221 order', false]);
  const addLine = (actor: string, orderId: string, qty = 30) =>
    rpc(actor, 'phoenix_procurement_add_order_line',
      [orderId, uniq('Amoxicillin'), qty, null, 'Amoxil', '500mg', 'capsule', 'box', null, uniq('BATCH'), '2027-06-01', 300, 'IQD', null]);
  const directEntry = (actor: string, warehouse: string, scientific = uniq('Metformin')) =>
    rpc(actor, 'phoenix_subpurchase_direct_entry', [
      randomUUID(), warehouse, scientific, 15, uniq('DE'), false, '2027-06-01', 90, '2026-07-01', uniq('REF'), null, null,
      null, 'Glucophage', '500mg', 'tablet', 'box', null, null]);
  const centralIntake = (supply: string, origin: string | null, scientific = uniq('Intake')) =>
    rpc(rig.superAdminId, 'phoenix_receive_warehouse_stock_guarded', [
      randomUUID(), WH_PDA, scientific, 50, true, true, 0,
      null, null, null, null, null, null, null, null, null, null, null, null, null, null, supply, origin]);

  /** Catalog fingerprint of the twelve procurement routines (superuser read). */
  const fingerprints = () => admin(`
    SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS body,
           p.proconfig AS config, p.prosecdef AS secdef, p.provolatile AS volatile, p.proacl::text AS acl,
           pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[])
     ORDER BY p.proname COLLATE "C", 2`, [PROCUREMENT_ROUTINES]);
  /** Catalog fingerprint of EVERY public routine (the quarantine, return, recall and exception RPCs included). */
  const allRoutines = () => admin(`
    SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS body,
           p.proconfig AS config, p.prosecdef AS secdef, p.provolatile AS volatile, p.proacl::text AS acl,
           pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
     ORDER BY p.proname COLLATE "C", pg_get_function_identity_arguments(p.oid) COLLATE "C"`);
  /** Every non-internal trigger of the given tables, with its function. */
  const tableTriggers = (rels: string[]) => admin(`
    SELECT c.relname AS rel, t.tgname AS name, t.tgtype AS type, t.tgenabled AS enabled, p.proname AS fn
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[]) AND NOT t.tgisinternal
     ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C"`, [rels]);

  // ---- the migration text ------------------------------------------------------
  const m221Text = () => readFileSync(join(MIGRATIONS_DIR, M221), 'utf8');
  const tryApplyM221 = (c: any, text = m221Text()): Promise<Refusal | null> =>
    applyMigrationSql(c, M221, shimSql(M221, text)).then(() => null, async (e: any) => {
      await c.query('ROLLBACK').catch(() => undefined);
      return { code: String(e.code), message: String(e.message), detail: e.detail };
    });
  /** The M221 text WITHOUT its final COMMIT (asserted to be the last statement). */
  const m221Uncommitted = () => {
    const text = m221Text();
    const commitAt = text.lastIndexOf('COMMIT;');
    expect(text.slice(commitAt + 'COMMIT;'.length).trim()).toBe('');
    return text.slice(0, commitAt);
  };
  /**
   * REHEARSAL ONLY: `setup`, then the M221 text without COMMIT, in ONE superuser transaction that is ALWAYS rolled
   * back. When `notices` is given, every NOTICE the rehearsal raises is appended to it.
   */
  const rehearse = (setup: string[] = [], isolation = 'READ COMMITTED', notices?: string[]): Promise<Refusal | null> => rig.asAdmin(async (c: any) => {
    const onNotice = (n: any) => notices?.push(String(n.message));
    if (notices) c.on('notice', onNotice);
    await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    try {
      for (const s of setup) await c.query(s);
      return await c.query(m221Uncommitted()).then(() => null,
        (e: any) => ({ code: String(e.code), message: String(e.message), detail: e.detail } as Refusal));
    } finally {
      await c.query('ROLLBACK');
      if (notices) c.off('notice', onNotice);
    }
  });
  /** The M221 text cut at its two seams: [BEGIN .. the prelude] [the lock and the DDL] [VERIFY], then COMMIT. */
  const m221Parts = () => {
    const text = m221Text();
    const preludeEnd = text.indexOf('$prelude$;') + '$prelude$;'.length;
    const verifyAt = text.indexOf('DO $verify$');
    const verifyEnd = text.indexOf('$verify$;', verifyAt + 'DO $verify$'.length) + '$verify$;'.length;
    expect(preludeEnd).toBeGreaterThan('$prelude$;'.length);
    expect(verifyAt).toBeGreaterThan(preludeEnd);
    expect(text.slice(verifyEnd).trim()).toBe('COMMIT;');
    const parts = { prelude: text.slice(0, preludeEnd), ddl: text.slice(preludeEnd, verifyAt), verify: text.slice(verifyAt, verifyEnd) };
    expect(parts.prelude).not.toContain('LOCK TABLE');
    expect(parts.ddl).toContain('LOCK TABLE public.procurement_suppliers');
    return parts;
  };
  type SplitOutcome = { stage: 'prelude' | 'ddl' | 'verify'; error: Refusal } | { stage: 'passed' };
  /** REHEARSAL ONLY: M221 seam by seam on one superuser connection, ALWAYS rolled back. */
  const rehearseSplit = (hooks: { afterPrelude?: (c: any) => Promise<void>; afterDdl?: (c: any) => Promise<void> } = {}): Promise<SplitOutcome> =>
    rig.asAdmin(async (c: any) => {
      const p = m221Parts();
      const step = (sql: string): Promise<Refusal | null> => c.query(sql).then(() => null,
        (e: any) => ({ code: String(e.code), message: String(e.message), detail: e.detail }));
      try {
        let e = await step(p.prelude);
        if (e) return { stage: 'prelude', error: e };
        if (hooks.afterPrelude) await hooks.afterPrelude(c);
        e = await step(p.ddl);
        if (e) return { stage: 'ddl', error: e };
        if (hooks.afterDdl) await hooks.afterDdl(c);
        e = await step(p.verify);
        if (e) return { stage: 'verify', error: e };
        return { stage: 'passed' };
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
      }
    });
  const M221_STATE = `SELECT to_regprocedure('${GUARD_SIG}') IS NOT NULL AS guard,
            (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'phoenix\\_pda\\_%') AS triggers`;
  const m221Present = async () => (await admin(M221_STATE))[0];
  const ABSENT = { guard: false, triggers: 0 };
  const PRESENT = { guard: true, triggers: 12 };

  beforeAll(async () => {
    rig = await buildRig({ upTo: 220 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
        ($1,'M221 Pharmacy Dept','دائرة صحة','p221-pda','pharmacy_department_authority',NULL),
        ($2,'M221 Hospital','مستشفى','p221-care','care_institution','hospital'),
        ($3,'M221 Hospital Two','مستشفى ٢','p221-care2','care_institution','hospital')`, [ORG_PDA, ORG_CARE, ORG_CARE2]);
      await c.query(`INSERT INTO warehouses (id, organization_id, name, name_ar, status, warehouse_kind, code) VALUES
        ($1,$2,'M221 PDA Central','مخزن مركزي','active','central','p221-wpda'),
        ($3,$4,'M221 Care WH','مخزن','active','institution','p221-wcare'),
        ($5,$4,'M221 Care Central','مخزن مركزي ٢','active','central','p221-wcc')`, [WH_PDA, ORG_PDA, WH_CARE, ORG_CARE, WH_CARE_CENTRAL]);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active, priority) VALUES
        ($1,$2,$3,'central','institution',true,1), ($4,$5,$3,'central','institution',true,2)`,
      [ROUTE_CARE, WH_CARE_CENTRAL, WH_CARE, ROUTE_PDA, WH_PDA]);
      await c.query(`INSERT INTO auth.users (id, email) VALUES ($1,'p221-officer@rig'), ($2,'p221-approver@rig')`, [U_OFFICER, U_APPROVER]);
      await c.query(`UPDATE profiles SET role='warehouse_officer', status='active', organization_id=$2 WHERE id=$1`, [U_OFFICER, ORG_CARE]);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active', organization_id=$2 WHERE id=$1`, [U_APPROVER, ORG_CARE]);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ($1,$2,'warehouse',$3,true)`, [U_OFFICER, ORG_CARE, WH_CARE]);
    });
    // Care procurement history that exists BEFORE M221: it must not trip the census.
    supplierCare = (await saveSupplier(U_OFFICER, ORG_CARE)).supplier_id;
    draftOrderCare = (await createOrder(U_OFFICER, supplierCare)).order_id;
    await addLine(U_OFFICER, draftOrderCare);
    draftOrderLineCare = (await admin(`SELECT id FROM procurement_order_lines WHERE order_id = $1`, [draftOrderCare]))[0].id;
  }, 600_000);

  afterAll(async () => { await rig?.end(); });

  // =========================================================================
  // THE 220 CHAIN — the finding, the baseline, the activation preconditions
  // =========================================================================
  describe('on the 001..220 chain (before M221)', () => {
    it('reproduces the finding: a super_admin creates a PDA supplier through save_supplier; the owner writes a PDA supplementary lot (purchase AND supply_type NULL); the owner and service_role write a PDA-labelled order line, order event and receipt under a CARE order, and re-label a care order line onto the PDA (all rolled back)', async () => {
      expect(await m221Present()).toEqual(ABSENT);
      const saved = await rig.asUser(rig.superAdminId, (c: any) => c.query(
        `SELECT public.phoenix_procurement_save_supplier($1,null,$2,null,null,null,null,null,null,null,null) AS r`, [ORG_PDA, uniq('PDA supplier')])
        .then((r: any) => r.rows[0].r));   // asUser rolls back by default
      expect(saved).toMatchObject({ ok: true });
      const lot = await rolledBack(async (c) => (await c.query(LOT, lotParams(ORG_PDA, WH_PDA, 'purchase', 'supplementary'))).rows[0]);
      expect(lot.id).toBeTruthy();
      // The M088 CHECK ((supply_type = 'purchase') = (purchase_origin IS NOT NULL)) is UNKNOWN - so it passes - for
      // supply_type NULL with purchase_origin 'supplementary'.
      const nullSupply = await rolledBack(async (c) => (await c.query(
        `${LOT.replace('RETURNING id', 'RETURNING supply_type, purchase_origin, organization_id')}`, lotParams(ORG_PDA, WH_PDA, null, 'supplementary'))).rows[0]);
      expect(nullSupply).toEqual({ supply_type: null, purchase_origin: 'supplementary', organization_id: ORG_PDA });
      const forgedOwner = await rolledBack(async (c) => (await c.query(RECEIPT, receiptParams(draftOrderCare, ORG_PDA, supplierCare))).rows[0]);
      expect(forgedOwner.organization_id).toBe(ORG_PDA);
      const forgedService = await serviceRolledBack(async (c) => (await c.query(RECEIPT, receiptParams(draftOrderCare, ORG_PDA, supplierCare))).rows[0]);
      expect(forgedService.organization_id).toBe(ORG_PDA);
      console.log('[M221 evidence] 220 chain: PDA (NULL, supplementary) lot and PDA-labelled receipt under a care order accepted (rolled back):',
        JSON.stringify({ nullSupply, forgedOwner: forgedOwner.organization_id, forgedService: forgedService.organization_id }));
      // The order lines and order events (Director correction #3): before M221 a PDA label under a CARE order, and a
      // re-label of an existing care order line onto the PDA, are accepted for the owner and service_role alike.
      const forgedLines = async (c: any) => ({
        line: (await c.query(ORDER_LINE, orderLineParams(draftOrderCare, ORG_PDA))).rows[0].organization_id,
        event: (await c.query(ORDER_EVENT, orderEventParams(draftOrderCare, ORG_PDA))).rows[0].organization_id,
        relabel: (await c.query(`UPDATE public.procurement_order_lines SET organization_id = $2 WHERE id = $1 RETURNING organization_id`,
          [draftOrderLineCare, ORG_PDA])).rows[0].organization_id,
        parent: (await c.query(`SELECT organization_id FROM public.procurement_orders WHERE id = $1`, [draftOrderCare])).rows[0].organization_id,
      });
      const linesOwner = await rolledBack(forgedLines);
      const linesService = await serviceRolledBack(forgedLines);
      console.log('[M221 evidence] 220 chain: PDA-labelled order line and order event under a care order, and a care order line re-labelled onto the PDA, accepted (rolled back):',
        JSON.stringify({ owner: linesOwner, service: linesService }));
      expect(linesOwner).toEqual({ line: ORG_PDA, event: ORG_PDA, relabel: ORG_PDA, parent: ORG_CARE });
      expect(linesService).toEqual({ line: ORG_PDA, event: ORG_PDA, relabel: ORG_PDA, parent: ORG_CARE });
      expect((await rowJson('procurement_order_lines', draftOrderLineCare)).organization_id).toBe(ORG_CARE);
      // Orders were already closed before M221, but by the M184 warehouse root guard - not with this invariant's token.
      expect(await refusal(admin(`INSERT INTO public.procurement_orders (organization_id, warehouse_id, supplier_id, order_number, status, created_by)
        VALUES ($1,$2,$3,'P221-PRE','draft',$4)`, [ORG_PDA, WH_PDA, randomUUID(), rig.superAdminId])))
        .toMatchObject({ code: '23514', message: 'destination_must_be_active_institution_warehouse' });
      expect((await admin(`SELECT count(*)::int AS n FROM procurement_suppliers WHERE organization_id = $1`, [ORG_PDA]))[0].n).toBe(0);
      expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
    });

    it('records the twelve procurement routines, every public routine and the triggers of the child and custody tables exactly as 220 left them', async () => {
      fingerprintsBefore = await fingerprints();
      expect(fingerprintsBefore.map((f: any) => f.name)).toEqual(PROCUREMENT_ROUTINES);
      console.log('[M221 evidence] procurement routines BEFORE M221:', JSON.stringify(fingerprintsBefore.map((f: any) => [f.name, f.body, f.config, f.secdef, f.owner])));
      routinesBefore = await allRoutines();
      expect(routinesBefore.length).toBeGreaterThan(100);
      snapshotTriggersBefore = await tableTriggers(SNAPSHOTTED);
      console.log('[M221 evidence] triggers of the child and custody tables BEFORE M221:', JSON.stringify(snapshotTriggersBefore));
      expect(snapshotTriggersBefore.filter((t: any) => t.rel === 'warehouse_quarantine_stock').map((t: any) => `${t.name}:${t.type}:${t.enabled}`))
        .toEqual(['set_updated_at:19:O']);
      // The four INSERT-only child tables (order events, receipts, receipt lines, returns) carry exactly the M141 demo
      // marker (BEFORE UPDATE) and the M087 immutability trigger (BEFORE UPDATE OR DELETE, tgtype 27) on
      // phoenix_procurement_forbid_mutation; procurement_order_lines carries the demo marker ONLY - no immutability
      // trigger, which is why M221 guards its UPDATE OF organization_id. No child has an INSERT trigger.
      for (const { table, immutable } of CHILD) {
        expect(snapshotTriggersBefore.filter((t: any) => t.rel === table).map((t: any) => `${t.name}:${t.type}:${t.enabled}:${t.fn}`), table).toEqual([
          `${table}_demo_marker_write_once:19:O:phoenix_demo_marker_is_write_once`,
          ...(immutable ? [`${immutable}:27:O:phoenix_procurement_forbid_mutation`] : []),
        ]);
      }
      expect(snapshotTriggersBefore.filter((t: any) => t.fn === 'phoenix_procurement_forbid_mutation').map((t: any) => t.rel))
        .toEqual(['procurement_order_events', 'procurement_receipt_lines', 'procurement_receipts', 'procurement_returns']);
    });

    it('refuses REPEATABLE READ and SERIALIZABLE before anything else', async () => {
      for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
        expect(await rehearse([], level), level).toMatchObject({ message: '221_precondition_failed: READ COMMITTED isolation is required' });
      }
    });

    it('refuses a partial M221 object set (an order-line or order-event binding alone included), an applier without RLS bypass and an applier that does not own all eight guarded tables', async () => {
      expect(await rehearse([
        `CREATE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$`,
      ])).toMatchObject({ message: '221_precondition_failed: partial M221 object set', detail: 'function_present=true triggers_present=0' });
      expect(await rehearse([
        `CREATE FUNCTION public.m221_probe_fn() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$`,
        `CREATE TRIGGER phoenix_pda_return_insert_guard BEFORE INSERT ON public.procurement_returns FOR EACH ROW EXECUTE FUNCTION public.m221_probe_fn()`,
      ])).toMatchObject({ message: '221_precondition_failed: partial M221 object set', detail: 'function_present=false triggers_present=1' });
      // The idempotence probe names the three correction-#3 bindings too: any one of them alone is a partial set.
      for (const [name, table, event] of [['phoenix_pda_order_event_insert_guard', 'procurement_order_events', 'INSERT'],
        ['phoenix_pda_order_line_insert_guard', 'procurement_order_lines', 'INSERT'],
        ['phoenix_pda_order_line_reassign_guard', 'procurement_order_lines', 'UPDATE OF organization_id']]) {
        expect(await rehearse([
          `CREATE FUNCTION public.m221_probe_fn() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$`,
          `CREATE TRIGGER ${name} BEFORE ${event} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.m221_probe_fn()`,
        ]), name).toMatchObject({ message: '221_precondition_failed: partial M221 object set', detail: 'function_present=false triggers_present=1' });
      }
      expect(await rehearse([
        `CREATE ROLE m221_probe NOLOGIN`, `GRANT USAGE ON SCHEMA public TO m221_probe`, `SET LOCAL ROLE m221_probe`,
      ])).toMatchObject({ message: '221_precondition_failed: the applying role must bypass row-level security', detail: 'role=m221_probe' });
      expect(await rehearse([
        `CREATE ROLE m221_probe NOLOGIN BYPASSRLS`, `GRANT USAGE ON SCHEMA public TO m221_probe`, `SET LOCAL ROLE m221_probe`,
      ])).toMatchObject({ message: OWNER_OF_EIGHT, detail: 'role=m221_probe' });
      // warehouse_stock is one of them: a BYPASSRLS role owning the two procurement tables but not warehouse_stock is still refused.
      expect(await rehearse([
        `CREATE ROLE m221_probe NOLOGIN BYPASSRLS`, `GRANT USAGE ON SCHEMA public TO m221_probe`,
        ...['procurement_suppliers', 'procurement_orders'].map((t) => `ALTER TABLE public.${t} OWNER TO m221_probe`),
        `SET LOCAL ROLE m221_probe`,
      ])).toMatchObject({ message: OWNER_OF_EIGHT, detail: 'role=m221_probe' });
      // ... and so are the child tables: owning suppliers, orders and warehouse_stock but not the five children is refused;
      // owning the six tables of the nine-trigger shape but NOT procurement_order_lines and procurement_order_events is
      // refused; and owning seven of the eight (all but procurement_order_events) is refused too.
      const without = (...missing: string[]) => GUARDED.filter((t) => !missing.includes(t));
      for (const owned of [['procurement_suppliers', 'procurement_orders', 'warehouse_stock'],
        without('procurement_order_lines', 'procurement_order_events'), without('procurement_order_events'), without('procurement_order_lines')]) {
        expect(await rehearse([
          `CREATE ROLE m221_probe NOLOGIN BYPASSRLS`, `GRANT USAGE ON SCHEMA public TO m221_probe`,
          ...owned.map((t) => `ALTER TABLE public.${t} OWNER TO m221_probe`),
          `SET LOCAL ROLE m221_probe`,
        ]), owned.join(',')).toMatchObject({ message: OWNER_OF_EIGHT, detail: 'role=m221_probe' });
      }
      expect(await m221Present()).toEqual(ABSENT);
    });

    it('an applier owning exactly the eight guarded tables - procurement_order_lines and procurement_order_events included, and NOT warehouse_quarantine_stock - applies M221 (rehearsal, rolled back)', async () => {
      const owners = await admin(`SELECT c.relname AS rel, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
        WHERE c.oid = ANY(ARRAY['public.warehouse_quarantine_stock', 'public.outlet_stock']::regclass[]) ORDER BY 1`);
      expect(owners).toHaveLength(2);
      expect(owners.every((o: any) => o.owner !== 'm221_probe')).toBe(true);
      expect(GUARDED).toHaveLength(8);
      expect(await rehearse([
        `CREATE ROLE m221_probe NOLOGIN BYPASSRLS`, `GRANT USAGE, CREATE ON SCHEMA public TO m221_probe`,
        ...GUARDED.map((t) => `ALTER TABLE public.${t} OWNER TO m221_probe`),
        `GRANT SELECT ON public.organizations TO m221_probe`,
        `SET LOCAL ROLE m221_probe`,
      ])).toBeNull();
      expect(await m221Present()).toEqual(ABSENT);
    });

    it('refuses schema drift: organizations forcing RLS, the kind immutability trigger disabled, the order root guard disabled, and any change of the four M087 immutability triggers (order events included)', async () => {
      expect(await rehearse(['ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY'])).toMatchObject({
        message: '221_precondition_failed: schema drift: public.organizations forces row-level security' });
      expect(await rehearse(['ALTER TABLE public.organizations DISABLE TRIGGER organizations_kind_immutable_trg'])).toMatchObject({
        message: '221_precondition_failed: schema drift: organizations_kind_immutable_trg is not the enabled M171 BEFORE UPDATE OF organization_kind trigger' });
      expect(await rehearse(['ALTER TABLE public.procurement_orders DISABLE TRIGGER phoenix_procurement_order_root_guard'])).toMatchObject({
        message: '221_precondition_failed: schema drift: phoenix_procurement_order_root_guard is absent or disabled' });
      // The order-event/receipt/receipt-line/return UPDATE closure M221 relies on: disabled, dropped, re-enabled ALWAYS,
      // re-pointed at another function, or narrowed to DELETE (or UPDATE) only - each is drift.
      const immutabilityDrift: Array<[string, string[]]> = [
        ['order events immutability disabled', ['ALTER TABLE public.procurement_order_events DISABLE TRIGGER procurement_order_events_immutable']],
        ['order events immutability dropped', ['DROP TRIGGER procurement_order_events_immutable ON public.procurement_order_events']],
        ['order events immutability ENABLE REPLICA', ['ALTER TABLE public.procurement_order_events ENABLE REPLICA TRIGGER procurement_order_events_immutable']],
        ['order events immutability narrowed to UPDATE only', ['DROP TRIGGER procurement_order_events_immutable ON public.procurement_order_events',
          `CREATE TRIGGER procurement_order_events_immutable BEFORE UPDATE ON public.procurement_order_events FOR EACH ROW EXECUTE FUNCTION public.phoenix_procurement_forbid_mutation()`]],
        ['receipts immutability disabled', ['ALTER TABLE public.procurement_receipts DISABLE TRIGGER procurement_receipts_immutable']],
        ['returns immutability dropped', ['DROP TRIGGER procurement_returns_immutable ON public.procurement_returns']],
        ['receipt lines immutability ENABLE ALWAYS', ['ALTER TABLE public.procurement_receipt_lines ENABLE ALWAYS TRIGGER procurement_receipt_lines_immutable']],
        ['receipts immutability on another function', ['DROP TRIGGER procurement_receipts_immutable ON public.procurement_receipts',
          `CREATE TRIGGER procurement_receipts_immutable BEFORE UPDATE OR DELETE ON public.procurement_receipts FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at()`]],
        ['receipt lines immutability narrowed to DELETE', ['DROP TRIGGER procurement_receipt_lines_immutable ON public.procurement_receipt_lines',
          `CREATE TRIGGER procurement_receipt_lines_immutable BEFORE DELETE ON public.procurement_receipt_lines FOR EACH ROW EXECUTE FUNCTION public.phoenix_procurement_forbid_mutation()`]],
      ];
      for (const [label, setup] of immutabilityDrift) {
        expect(await rehearse(setup), label).toMatchObject({ code: 'P0001', message: IMMUTABILITY_DRIFT });
      }
      expect(await m221Present()).toEqual(ABSENT);
    });

    it('the legacy census refuses any pre-existing non-care procurement row - a PDA-labelled order line, order event, receipt, receipt line or return and a PDA (NULL, supplementary) lot included - by table and count only, and never a custody row (rehearsals, rolled back)', async () => {
      const careReceiptId = randomUUID();
      const careLineId = randomUUID();
      const receipt = (id: string, org: string) => `INSERT INTO public.procurement_receipts (id, order_id, organization_id, warehouse_id, supplier_id,
          receipt_number, request_id, request_fingerprint, received_by) VALUES ('${id}', 'ORDER_ID', '${org}', '${WH_CARE}', 'SUPPLIER_ID',
          '${uniq('P221-LEGACY-R')}', '${randomUUID()}', repeat('a', 64), 'SUPER_ADMIN')`;
      const line = (id: string, org: string) => `INSERT INTO public.procurement_receipt_lines (id, receipt_id, order_line_id, organization_id,
          quantity, batch_number, has_no_batch_number, has_no_national_code) VALUES ('${id}', '${careReceiptId}', 'ORDER_LINE_ID', '${org}', 1, NULL, true, true)`;
      const ret = (org: string) => `INSERT INTO public.procurement_returns (request_id, request_fingerprint, order_id, receipt_line_id, organization_id,
          warehouse_id, quantity, reason) VALUES ('${randomUUID()}', repeat('b', 64), 'ORDER_ID', '${careLineId}', '${org}', '${WH_CARE}', 1, 'legacy')`;
      const orderLine = (org: string) => `INSERT INTO public.procurement_order_lines (order_id, organization_id, scientific_name, ordered_quantity)
          VALUES ('ORDER_ID', '${org}', 'Legacy line', 1)`;
      const orderEvent = (org: string) => `INSERT INTO public.procurement_order_events (order_id, organization_id, event_type)
          VALUES ('ORDER_ID', '${org}', 'legacy')`;
      const cases: Array<[string, string[], string]> = [
        ['a PDA supplier', [`INSERT INTO public.procurement_suppliers (organization_id, name) VALUES ('${ORG_PDA}', 'legacy PDA supplier')`],
          'procurement_suppliers=1'],
        ['a PDA purchase/supplementary lot', [`INSERT INTO public.warehouse_stock (organization_id, warehouse_id, scientific_name,
            has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, supply_type, purchase_origin)
          VALUES ('${ORG_PDA}', '${WH_PDA}', 'Legacy PDA lot', true, false, 'LEG-1', 5, 'purchase', 'supplementary')`],
          'warehouse_stock=1'],
        ['a PDA lot with supply_type NULL and purchase_origin supplementary (the census is purchase_origin alone)', [`INSERT INTO public.warehouse_stock
            (organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, supply_type,
             purchase_origin)
          VALUES ('${ORG_PDA}', '${WH_PDA}', 'Legacy PDA null-supply lot', true, false, 'LEG-2', 5, NULL, 'supplementary')`],
          'warehouse_stock=1'],
        ['an order line labelled with a dangling organization under a care order',
          [`INSERT INTO public.procurement_order_lines (order_id, organization_id, scientific_name, ordered_quantity)
            VALUES ('ORDER_ID', '${randomUUID()}', 'Dangling', 1)`], 'procurement_order_lines=1'],
        ['a PDA-labelled receipt under a care order', [receipt(randomUUID(), ORG_PDA)], 'procurement_receipts=1'],
        ['a PDA-labelled receipt line under a care receipt', [receipt(careReceiptId, ORG_CARE), line(randomUUID(), ORG_PDA)],
          'procurement_receipt_lines=1'],
        ['a PDA-labelled return under a care receipt line', [receipt(careReceiptId, ORG_CARE), line(careLineId, ORG_CARE), ret(ORG_PDA)],
          'procurement_returns=1'],
        ['a PDA-labelled order line under a care order', [orderLine(ORG_PDA)], 'procurement_order_lines=1'],
        ['an existing care order line re-labelled onto the PDA', [`UPDATE public.procurement_order_lines SET organization_id = '${ORG_PDA}'
            WHERE id = 'ORDER_LINE_ID'`], 'procurement_order_lines=1'],
        ['a PDA-labelled order event under a care order', [orderEvent(ORG_PDA)], 'procurement_order_events=1'],
      ];
      const fill = (s: string) => s.replace(/ORDER_LINE_ID/g, draftOrderLineCare).replace(/ORDER_ID/g, draftOrderCare)
        .replace(/SUPPLIER_ID/g, supplierCare).replace(/SUPER_ADMIN/g, rig.superAdminId);
      for (const [label, setup, detail] of cases) {
        const r = await rehearse(setup.map(fill));
        expect(r, label).toMatchObject({ code: 'P0001', message: LEGACY, detail });
      }
      // The same care-labelled chain is NOT legacy: a care order line, order event, receipt, receipt line and return never
      // trip the census (nor does a care institution B label under care institution A's order: the census, like the
      // guard, judges each row's OWN organization - the cross-care mismatch is the deferred residual).
      expect(await rehearse([orderLine(ORG_CARE), orderEvent(ORG_CARE), orderLine(ORG_CARE2), orderEvent(ORG_CARE2),
        receipt(careReceiptId, ORG_CARE), line(careLineId, ORG_CARE), ret(ORG_CARE)].map(fill))).toBeNull();
      // Several at once: the DETAIL lists each table and its count in census order, nothing else.
      const all = await rehearse([...cases[0][1], ...cases[1][1], ...cases[2][1], ...cases[4][1]].map(fill));
      expect(all).toMatchObject({ message: LEGACY, detail: 'procurement_suppliers=1, warehouse_stock=2, procurement_receipts=1' });
      const withChildren = await rehearse([...cases[0][1], ...cases[4][1], ...cases[7][1], ...cases[8][1], ...cases[9][1]].map(fill));
      expect(withChildren).toMatchObject({ message: LEGACY,
        detail: 'procurement_suppliers=1, procurement_order_lines=2, procurement_receipts=1, procurement_order_events=1' });
      // A PDA purchase/supplementary QUARANTINE (custody) row is not procurement: it never trips the census.
      const custody = `INSERT INTO public.warehouse_quarantine_stock (organization_id, warehouse_id, scientific_name, has_no_national_code,
          batch_number, has_no_batch_number, quarantine_reason, quantity, supply_type, purchase_origin)
        VALUES ('${ORG_PDA}', '${WH_PDA}', 'Custody quarantine', true, 'CUSTODY-Q', false, 'damaged', 3, 'purchase', 'supplementary')`;
      expect(await rehearse([custody])).toBeNull();
      expect(await m221Present()).toEqual(ABSENT);
      expect((await admin(`SELECT count(*)::int AS n FROM procurement_suppliers WHERE organization_id = $1`, [ORG_PDA]))[0].n).toBe(0);
      expect(await pdaSupplementaryQuarantine()).toBe(0);
      expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
    });

    it('a bounded wait, never NOWAIT: a writer holding warehouse_stock, procurement_order_lines, procurement_order_events, procurement_receipts, procurement_receipt_lines or procurement_returns makes M221 fail 55P03 after lock_timeout, applying nothing', async () => {
      expect(CHILD.map((c) => c.table)).toEqual(['procurement_order_lines', 'procurement_order_events', 'procurement_receipts',
        'procurement_receipt_lines', 'procurement_returns']);
      for (const table of ['warehouse_stock', ...CHILD.map((c) => c.table)]) {
        const client = await rig.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`LOCK TABLE public.${table} IN ROW EXCLUSIVE MODE`);
          const t0 = Date.now();
          const r = await rig.asAdmin((c: any) => tryApplyM221(c));
          const waited = Date.now() - t0;
          expect(r, table).toMatchObject({ code: '55P03', message: 'canceling statement due to lock timeout' });
          expect(waited, table).toBeGreaterThanOrEqual(2500);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      }
      expect(await m221Present()).toEqual(ABSENT);
    });

    it('the lock is the eight guarded tables only: writers holding warehouse_quarantine_stock, outlet_stock and the stock/quarantine movement ledgers do not delay M221 (rehearsal, rolled back)', async () => {
      const client = await rig.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`LOCK TABLE public.warehouse_quarantine_stock, public.outlet_stock, public.warehouse_stock_movements,
            public.warehouse_quarantine_stock_movements IN ROW EXCLUSIVE MODE`);
        const t0 = Date.now();
        expect(await rehearse()).toBeNull();
        expect(Date.now() - t0).toBeLessThan(2500);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(await m221Present()).toEqual(ABSENT);
    });

    it('VERIFY re-runs the census UNDER the lock: a PDA supplier, a PDA (NULL, supplementary) lot, a PDA-labelled receipt, order line or order event, or a care order line re-labelled onto the PDA, that another connection commits between the prelude and the lock is refused', async () => {
      let committed = '';
      try {
        const r = await rehearseSplit({
          afterPrelude: async () => {
            committed = (await admin(`INSERT INTO public.procurement_suppliers (organization_id, name) VALUES ($1, $2) RETURNING id`,
              [ORG_PDA, uniq('Racing PDA supplier')]))[0].id;
          },
        });
        expect(r).toMatchObject({ stage: 'verify', error: { message: 'VERIFY FAILED (221): legacy non-care procurement rows present', detail: 'procurement_suppliers=1' } });
      } finally {
        if (committed) await admin(`DELETE FROM public.procurement_suppliers WHERE id = $1`, [committed]);
      }
      // The same race on warehouse_stock with the provenance the M088 CHECK lets through: supply_type NULL, supplementary.
      let committedLot = '';
      try {
        const r = await rehearseSplit({
          afterPrelude: async () => { committedLot = await insertLot(ORG_PDA, WH_PDA, null, 'supplementary'); },
        });
        expect(r).toMatchObject({ stage: 'verify', error: { message: 'VERIFY FAILED (221): legacy non-care procurement rows present', detail: 'warehouse_stock=1' } });
      } finally {
        if (committedLot) await admin(`DELETE FROM public.warehouse_stock WHERE id = $1`, [committedLot]);
      }
      // And on a child table: a PDA-labelled receipt under a care order. Receipts are immutable (M087), so the racing row
      // is removed afterwards in replica mode (fixture cleanup only).
      let committedReceipt = '';
      try {
        const r = await rehearseSplit({
          afterPrelude: async () => {
            committedReceipt = (await admin(RECEIPT, receiptParams(draftOrderCare, ORG_PDA, supplierCare)))[0].id;
          },
        });
        expect(r).toMatchObject({ stage: 'verify', error: { message: 'VERIFY FAILED (221): legacy non-care procurement rows present', detail: 'procurement_receipts=1' } });
      } finally {
        if (committedReceipt) {
          await rig.asAdmin(async (c: any) => {
            await c.query('BEGIN');
            await c.query('SET LOCAL session_replication_role = replica');
            await c.query('DELETE FROM public.procurement_receipts WHERE id = $1', [committedReceipt]);
            await c.query('COMMIT');
          });
        }
      }
      // ... on procurement_order_lines: a PDA-labelled order line under a care order, and an existing care order line
      // re-labelled onto the PDA (no immutability trigger there: restored afterwards).
      let committedLine = '';
      try {
        const r = await rehearseSplit({
          afterPrelude: async () => { committedLine = (await admin(ORDER_LINE, orderLineParams(draftOrderCare, ORG_PDA)))[0].id; },
        });
        expect(r).toMatchObject({ stage: 'verify', error: { message: 'VERIFY FAILED (221): legacy non-care procurement rows present', detail: 'procurement_order_lines=1' } });
      } finally {
        if (committedLine) await admin(`DELETE FROM public.procurement_order_lines WHERE id = $1`, [committedLine]);
      }
      let relabelled = false;
      try {
        const r = await rehearseSplit({
          afterPrelude: async () => {
            relabelled = (await admin(`UPDATE public.procurement_order_lines SET organization_id = $2 WHERE id = $1 RETURNING id`,
              [draftOrderLineCare, ORG_PDA])).length === 1;
          },
        });
        expect(r).toMatchObject({ stage: 'verify', error: { message: 'VERIFY FAILED (221): legacy non-care procurement rows present', detail: 'procurement_order_lines=1' } });
      } finally {
        if (relabelled) await admin(`UPDATE public.procurement_order_lines SET organization_id = $2 WHERE id = $1`, [draftOrderLineCare, ORG_CARE]);
      }
      expect((await rowJson('procurement_order_lines', draftOrderLineCare)).organization_id).toBe(ORG_CARE);
      // ... and on procurement_order_events: a PDA-labelled event under a care order (immutable: replica-mode cleanup).
      let committedEvent = '';
      try {
        const r = await rehearseSplit({
          afterPrelude: async () => { committedEvent = (await admin(ORDER_EVENT, orderEventParams(draftOrderCare, ORG_PDA)))[0].id; },
        });
        expect(r).toMatchObject({ stage: 'verify', error: { message: 'VERIFY FAILED (221): legacy non-care procurement rows present', detail: 'procurement_order_events=1' } });
      } finally {
        if (committedEvent) {
          await rig.asAdmin(async (c: any) => {
            await c.query('BEGIN');
            await c.query('SET LOCAL session_replication_role = replica');
            await c.query('DELETE FROM public.procurement_order_events WHERE id = $1', [committedEvent]);
            await c.query('COMMIT');
          });
        }
      }
      expect(await pdaSupplementaryStock()).toBe(0);
      expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      expect(await m221Present()).toEqual(ABSENT);
    });

    it('VERIFY is not vacuous: tampering after the DDL is refused by name - including a binding on warehouse_quarantine_stock, an UPDATE binding on procurement_receipts or procurement_order_events, an order-line binding dropped, disabled or stripped of its WHEN, and the supply_type-weakened stock WHEN (rehearsals, rolled back)', async () => {
      const cases: Array<[string, string[], string]> = [
        ['EXECUTE granted to authenticated', [`GRANT EXECUTE ON FUNCTION ${GUARD_SIG} TO authenticated`],
          'VERIFY FAILED (221): the guard is executable by PUBLIC, anon, authenticated or service_role'],
        ['EXECUTE granted to PUBLIC', [`GRANT EXECUTE ON FUNCTION ${GUARD_SIG} TO PUBLIC`],
          'VERIFY FAILED (221): the guard is executable by PUBLIC, anon, authenticated or service_role'],
        ['EXECUTE granted to service_role', [`GRANT EXECUTE ON FUNCTION ${GUARD_SIG} TO service_role`],
          'VERIFY FAILED (221): the guard is executable by PUBLIC, anon, authenticated or service_role'],
        ['the search_path changed', [`ALTER FUNCTION ${GUARD_SIG} SET search_path = public, pg_temp`],
          'VERIFY FAILED (221): the guard must be a VOLATILE SECURITY DEFINER plpgsql trigger function in public, owned by the migration owner, pinned to pg_catalog, pg_temp'],
        ['made STABLE', [`ALTER FUNCTION ${GUARD_SIG} STABLE`],
          'VERIFY FAILED (221): the guard must be a VOLATILE SECURITY DEFINER plpgsql trigger function in public, owned by the migration owner, pinned to pg_catalog, pg_temp'],
        ['a binding disabled', ['ALTER TABLE public.procurement_suppliers DISABLE TRIGGER phoenix_pda_supplier_insert_guard'], TWELVE],
        ['a thirteenth binding', [`CREATE TRIGGER phoenix_pda_extra BEFORE INSERT ON public.procurement_order_lines FOR EACH ROW EXECUTE FUNCTION ${GUARD_SIG}`], TWELVE],
        ['a thirteenth binding on warehouse_quarantine_stock', [`CREATE TRIGGER phoenix_pda_quarantine_probe BEFORE INSERT ON public.warehouse_quarantine_stock FOR EACH ROW EXECUTE FUNCTION ${GUARD_SIG}`], TWELVE],
        ['an UPDATE binding on procurement_receipts', [`CREATE TRIGGER phoenix_pda_receipt_update_probe BEFORE UPDATE ON public.procurement_receipts FOR EACH ROW EXECUTE FUNCTION ${GUARD_SIG}`], TWELVE],
        ['an UPDATE OF organization_id binding on procurement_order_events', [`CREATE TRIGGER phoenix_pda_order_event_reassign_guard BEFORE UPDATE OF organization_id ON public.procurement_order_events FOR EACH ROW
             WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id) EXECUTE FUNCTION ${GUARD_SIG}`], TWELVE],
        ['a binding dropped', ['DROP TRIGGER phoenix_pda_order_reassign_guard ON public.procurement_orders'], TWELVE],
        ['the order-line insert binding dropped', ['DROP TRIGGER phoenix_pda_order_line_insert_guard ON public.procurement_order_lines'], TWELVE],
        ['the order-line re-label binding disabled', ['ALTER TABLE public.procurement_order_lines DISABLE TRIGGER phoenix_pda_order_line_reassign_guard'], TWELVE],
        ['the order-line re-label binding stripped of its WHEN', [
          'DROP TRIGGER phoenix_pda_order_line_reassign_guard ON public.procurement_order_lines',
          `CREATE TRIGGER phoenix_pda_order_line_reassign_guard BEFORE UPDATE OF organization_id ON public.procurement_order_lines FOR EACH ROW
             EXECUTE FUNCTION ${GUARD_SIG}`], TWELVE],
        ['the order-line re-label binding widened to every UPDATE', [
          'DROP TRIGGER phoenix_pda_order_line_reassign_guard ON public.procurement_order_lines',
          `CREATE TRIGGER phoenix_pda_order_line_reassign_guard BEFORE UPDATE ON public.procurement_order_lines FOR EACH ROW
             WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id) EXECUTE FUNCTION ${GUARD_SIG}`], TWELVE],
        ['the order-event binding dropped', ['DROP TRIGGER phoenix_pda_order_event_insert_guard ON public.procurement_order_events'], TWELVE],
        ['the order-event binding ENABLE REPLICA', ['ALTER TABLE public.procurement_order_events ENABLE REPLICA TRIGGER phoenix_pda_order_event_insert_guard'], TWELVE],
        ['the receipt binding dropped', ['DROP TRIGGER phoenix_pda_receipt_insert_guard ON public.procurement_receipts'], TWELVE],
        ['the receipt-line binding disabled', ['ALTER TABLE public.procurement_receipt_lines DISABLE TRIGGER phoenix_pda_receipt_line_insert_guard'], TWELVE],
        ['the return binding dropped', ['DROP TRIGGER phoenix_pda_return_insert_guard ON public.procurement_returns'], TWELVE],
        ['a stock binding disabled', ['ALTER TABLE public.warehouse_stock DISABLE TRIGGER phoenix_pda_supplementary_stock_insert_guard'], TWELVE],
        ['the stock reforge binding dropped', ['DROP TRIGGER phoenix_pda_supplementary_stock_reforge_guard ON public.warehouse_stock'], TWELVE],
        ['the stock insert WHEN weakened back to supply_type = purchase', [
          'DROP TRIGGER phoenix_pda_supplementary_stock_insert_guard ON public.warehouse_stock',
          `CREATE TRIGGER phoenix_pda_supplementary_stock_insert_guard BEFORE INSERT ON public.warehouse_stock FOR EACH ROW
             WHEN (NEW.supply_type = 'purchase' AND NEW.purchase_origin = 'supplementary') EXECUTE FUNCTION ${GUARD_SIG}`], TWELVE],
        ['an earlier BEFORE trigger on warehouse_stock', ['CREATE TRIGGER aaa_m221_probe BEFORE UPDATE ON public.warehouse_stock FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at()'],
          FIRES_FIRST],
        ['an earlier BEFORE trigger', ['CREATE TRIGGER aaa_m221_probe BEFORE INSERT ON public.procurement_suppliers FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at()'],
          FIRES_FIRST],
        ['an earlier BEFORE INSERT trigger on procurement_receipt_lines', ['CREATE TRIGGER aaa_m221_probe BEFORE INSERT ON public.procurement_receipt_lines FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at()'],
          FIRES_FIRST],
        ['an earlier BEFORE INSERT trigger on procurement_order_events', ['CREATE TRIGGER aaa_m221_probe BEFORE INSERT ON public.procurement_order_events FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at()'],
          FIRES_FIRST],
        ['an earlier BEFORE UPDATE trigger on procurement_order_lines', ['CREATE TRIGGER aaa_m221_probe BEFORE UPDATE ON public.procurement_order_lines FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at()'],
          FIRES_FIRST],
      ];
      for (const [label, sqls, message] of cases) {
        const r = await rehearseSplit({ afterDdl: async (c) => { for (const sql of sqls) await c.query(sql); } });
        expect(r, label).toMatchObject({ stage: 'verify', error: { message } });
      }
      // The same rehearsal with no tampering passes.
      expect(await rehearseSplit()).toEqual({ stage: 'passed' });
      expect(await m221Present()).toEqual(ABSENT);
    });
  });

  // =========================================================================
  // THE 221 CHAIN
  // =========================================================================
  describe('on the 001..221 chain', () => {
    let careSupplier = '';
    let careOrder = '';           // approved care order (create/add/submit/decide)
    let careOrderLine = '';       // its order line
    let careSuppLot = '';         // care purchase/supplementary lot (receive_order)
    let careReceipt = '';         // the receipt receive_order wrote
    let careReceiptLine = '';
    let careReturn = '';          // the return return_to_supplier wrote
    let pdaAidLot = '';
    let pdaNullLot = '';          // PDA lot, supply_type NULL, purchase_origin NULL
    let pdaCentralLot = '';       // PDA lot, purchase / central
    let careNullSuppLot = '';     // CARE lot, supply_type NULL, purchase_origin supplementary
    let custodyQuarantineLot = ''; // the PDA quarantine custody row of QUARANTINE_RETURN_REGRESSION

    beforeAll(async () => {
      const rest = migrationFiles().filter((f: string) => Number(f.slice(0, 3)) > 220 && Number(f.slice(0, 3)) <= 221);
      expect(rest).toEqual([M221]);
      const notices: string[] = [];
      await rig.asAdmin(async (c: any) => {
        const onNotice = (n: any) => notices.push(String(n.message));
        c.on('notice', onNotice);
        try {
          for (const f of rest) await applyMigrationSql(c, f, shimSql(f, readFileSync(join(MIGRATIONS_DIR, f), 'utf8')));
        } finally { c.off('notice', onNotice); }
      });
      // M221 is applied (the exact twelve bindings are asserted by the catalog test below).
      expect((await m221Present()).guard).toBe(true);
      // M221 reports nothing: the custody-side NOTICEs are gone with the quarantine scope.
      expect(notices.filter((n) => n.startsWith('221'))).toEqual([]);
      pdaAidLot = await insertLot(ORG_PDA, WH_PDA, 'aid', null);
      pdaNullLot = await insertLot(ORG_PDA, WH_PDA, null, null);
      pdaCentralLot = await insertLot(ORG_PDA, WH_PDA, 'purchase', 'central');
      careNullSuppLot = await insertLot(ORG_CARE, WH_CARE, null, 'supplementary');
    }, 600_000);

    it('idempotence: a second application fails 221_already_applied before any lock (a writer holds warehouse_stock)', async () => {
      const client = await rig.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE public.warehouse_stock IN ROW EXCLUSIVE MODE');
        expect(await rig.asAdmin((c: any) => tryApplyM221(c))).toMatchObject({ code: 'P0001', message: '221_already_applied' });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(await m221Present()).toEqual(PRESENT);
    });

    it('catalog: the guard is owner-only SECURITY DEFINER, pinned, bound by exactly twelve triggers on eight tables, fires first on INSERT everywhere; of the five children only procurement_order_lines has an M221 UPDATE (re-label) trigger, the other four keep their M087 immutability trigger; quarantine is untouched', async () => {
      const [g] = await admin(`
        SELECT p.prosecdef AS secdef, p.provolatile AS volatile, p.proconfig AS config, p.proowner = (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user) AS owner,
               has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
               has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
               EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_exec
          FROM pg_proc p WHERE p.oid = '${GUARD_SIG}'::regprocedure`);
      expect(g).toEqual({ secdef: true, volatile: 'v', config: ['search_path=pg_catalog, pg_temp'], owner: true,
        anon: false, auth: false, svc: false, public_exec: false });
      expect(await m221Present()).toEqual(PRESENT);
      const triggers = await admin(`
        SELECT c.relname AS rel, t.tgname AS name, t.tgtype AS type FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE t.tgfoid = '${GUARD_SIG}'::regprocedure AND NOT t.tgisinternal AND t.tgenabled = 'O' ORDER BY t.tgname COLLATE "C"`);
      expect(triggers.map((t: any) => t.name)).toEqual(TRIGGERS);
      expect(triggers).toHaveLength(12);
      expect([...new Set(triggers.map((t: any) => t.rel))].sort()).toEqual(GUARDED);
      // Per table: suppliers 2, orders 2, order lines 2, order events 1, receipts 1, receipt lines 1, returns 1, stock 2.
      expect(Object.fromEntries(GUARDED.map((rel) => [rel, triggers.filter((t: any) => t.rel === rel).length]))).toEqual({
        procurement_order_events: 1, procurement_order_lines: 2, procurement_orders: 2, procurement_receipt_lines: 1, procurement_receipts: 1,
        procurement_returns: 1, procurement_suppliers: 2, warehouse_stock: 2 });
      // The five child bindings: BEFORE INSERT ROW (tgtype 7) on each; and ONLY procurement_order_lines (no immutability
      // trigger) also carries the BEFORE UPDATE ROW re-label binding (tgtype 19). No DELETE binding anywhere.
      expect(triggers.filter((t: any) => CHILD.some((c) => c.table === t.rel)).map((t: any) => `${t.rel}:${t.name}:${t.type}`).sort()).toEqual(
        CHILD.flatMap((c) => [`${c.table}:${c.guard}:7`, ...(c.reassign ? [`${c.table}:${c.reassign}:19`] : [])]).sort());
      expect(triggers.filter((t: any) => CHILD.some((c) => c.table === t.rel) && (t.type & 16) !== 0).map((t: any) => t.name))
        .toEqual(['phoenix_pda_order_line_reassign_guard']);
      expect(triggers.filter((t: any) => (t.type & 8) !== 0)).toEqual([]);
      // Deparsed under VERIFY's search_path (pg_catalog, pg_temp), so every name is schema-qualified exactly as VERIFY pins it.
      const defs = await rolledBack(async (c) => {
        await c.query('SET LOCAL search_path = pg_catalog, pg_temp');
        return (await c.query(`SELECT t.tgname AS name, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
           WHERE t.tgname = ANY($1::text[]) ORDER BY t.tgname COLLATE "C"`,
        [['phoenix_pda_order_event_insert_guard', 'phoenix_pda_order_line_insert_guard', 'phoenix_pda_order_line_reassign_guard']])).rows;
      });
      expect(defs).toEqual([
        { name: 'phoenix_pda_order_event_insert_guard', def: `CREATE TRIGGER phoenix_pda_order_event_insert_guard BEFORE INSERT ON public.procurement_order_events FOR EACH ROW EXECUTE FUNCTION ${GUARD_SIG}` },
        { name: 'phoenix_pda_order_line_insert_guard', def: `CREATE TRIGGER phoenix_pda_order_line_insert_guard BEFORE INSERT ON public.procurement_order_lines FOR EACH ROW EXECUTE FUNCTION ${GUARD_SIG}` },
        { name: 'phoenix_pda_order_line_reassign_guard', def: 'CREATE TRIGGER phoenix_pda_order_line_reassign_guard BEFORE UPDATE OF organization_id ON public.procurement_order_lines '
          + `FOR EACH ROW WHEN ((old.organization_id IS DISTINCT FROM new.organization_id)) EXECUTE FUNCTION ${GUARD_SIG}` },
      ]);
      // Same-timing row triggers fire in byte order of their names: per table and event, the first BEFORE ROW trigger.
      const beforeRow = await admin(`
        SELECT c.relname AS rel, t.tgname AS name, t.tgtype AS type
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = ANY($1::text[]) AND c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND (t.tgtype & 3) = 3
           AND t.tgenabled <> 'D'
         ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C"`, [GUARDED]);
      const first = (rel: string, bit: number) => beforeRow.find((r: any) => r.rel === rel && (r.type & bit) !== 0)?.name;
      const firstInsert = GUARDED.map((rel) => `${rel}:insert:${first(rel, 4)}`);
      const firstUpdate = GUARDED.map((rel) => `${rel}:update:${first(rel, 16)}`);
      console.log('[M221 evidence] first BEFORE ROW trigger per table and event:', JSON.stringify({ firstInsert, firstUpdate }));
      expect(firstInsert).toEqual([
        'procurement_order_events:insert:phoenix_pda_order_event_insert_guard', 'procurement_order_lines:insert:phoenix_pda_order_line_insert_guard',
        'procurement_orders:insert:phoenix_pda_order_insert_guard', 'procurement_receipt_lines:insert:phoenix_pda_receipt_line_insert_guard',
        'procurement_receipts:insert:phoenix_pda_receipt_insert_guard', 'procurement_returns:insert:phoenix_pda_return_insert_guard',
        'procurement_suppliers:insert:phoenix_pda_supplier_insert_guard', 'warehouse_stock:insert:phoenix_pda_supplementary_stock_insert_guard',
      ]);
      expect(firstUpdate).toEqual([
        'procurement_order_events:update:procurement_order_events_demo_marker_write_once',
        'procurement_order_lines:update:phoenix_pda_order_line_reassign_guard',
        'procurement_orders:update:phoenix_pda_order_reassign_guard', 'procurement_receipt_lines:update:procurement_receipt_lines_demo_marker_write_once',
        'procurement_receipts:update:procurement_receipts_demo_marker_write_once', 'procurement_returns:update:procurement_returns_demo_marker_write_once',
        'procurement_suppliers:update:phoenix_pda_supplier_reassign_guard', 'warehouse_stock:update:phoenix_pda_supplementary_stock_reforge_guard',
      ]);
      // The children's BEFORE UPDATE triggers: on the four INSERT-only children exactly the M141 demo marker and the M087
      // immutability trigger (no M221 trigger); on procurement_order_lines the M221 re-label binding and the demo marker.
      for (const { table, immutable, reassign } of CHILD) {
        expect(beforeRow.filter((r: any) => r.rel === table && (r.type & 16) !== 0).map((r: any) => `${r.name}:${r.type}`), table)
          .toEqual(immutable ? [`${table}_demo_marker_write_once:19`, `${immutable}:27`] : [`${reassign}:19`, `${table}_demo_marker_write_once:19`]);
      }
      // The snapshotted tables: everything 220 left them is unchanged; the ONLY additions are one phoenix_pda_* INSERT
      // binding per child table and the order-line re-label binding; warehouse_quarantine_stock gains nothing.
      const after = await tableTriggers(SNAPSHOTTED);
      console.log('[M221 evidence] triggers of the child and custody tables AFTER M221:', JSON.stringify(after));
      expect(after.filter((t: any) => !t.name.startsWith('phoenix_pda_'))).toEqual(snapshotTriggersBefore);
      const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
      expect(after.filter((t: any) => t.name.startsWith('phoenix_pda_') || t.fn === GUARD_FN)).toEqual(
        CHILD.flatMap((c) => [{ rel: c.table, name: c.guard, type: 7, enabled: 'O', fn: GUARD_FN },
          ...(c.reassign ? [{ rel: c.table, name: c.reassign, type: 19, enabled: 'O', fn: GUARD_FN }] : [])])
          .sort((a, b) => byteOrder(`${a.rel}|${a.name}`, `${b.rel}|${b.name}`)));
      expect(after.filter((t: any) => UNGUARDED.includes(t.rel)).map((t: any) => `${t.name}:${t.type}:${t.enabled}`)).toEqual(['set_updated_at:19:O']);
    });

    it('the twelve procurement routines are byte-identical across M221 (md5(prosrc), search_path, SECURITY DEFINER, volatility, ACL, owner)', async () => {
      const after = await fingerprints();
      expect(fingerprintsBefore).toHaveLength(12);
      expect(after).toEqual(fingerprintsBefore);
    });

    it('every other public routine - the quarantine, return, recall and exception RPCs and phoenix_procurement_forbid_mutation included - is byte-identical across M221; the guard is the only new one', async () => {
      const after = await allRoutines();
      expect(after.filter((r: any) => r.name !== GUARD_FN)).toEqual(routinesBefore);
      expect(after.filter((r: any) => r.name === GUARD_FN).map((r: any) => r.args)).toEqual(['']);
      for (const rpcName of ['phoenix_receive_warehouse_return_shipment_line', 'phoenix_send_warehouse_return_shipment_line',
        'phoenix_receive_warehouse_transfer_line', 'phoenix_send_warehouse_transfer_line', 'phoenix_procurement_forbid_mutation']) {
        expect(routinesBefore.some((r: any) => r.name === rpcName), rpcName).toBe(true);
      }
    });

    // -----------------------------------------------------------------------
    // 7-9. care institutions keep their whole flow
    // -----------------------------------------------------------------------
    describe('7-9. the care institution flows are unchanged', () => {
      it('7. save_supplier creates a care supplier (one row, one audit)', async () => {
        const before = await counts();
        const r = await saveSupplier(U_OFFICER, ORG_CARE);
        expect(r).toMatchObject({ ok: true });
        careSupplier = r.supplier_id;
        expect(await supplierRow(careSupplier)).toMatchObject({ organization_id: ORG_CARE });
        const after = await counts();
        expect(after.procurement_suppliers - before.procurement_suppliers).toBe(1);
        expect(after.audit_logs - before.audit_logs).toBe(1);
      });

      it('8. create_order + add_order_line + submit + decide approve a care order', async () => {
        const created = await createOrder(U_OFFICER, careSupplier);
        expect(created).toMatchObject({ ok: true });
        careOrder = created.order_id;
        await addLine(U_OFFICER, careOrder, 30);
        expect(await rpc(U_OFFICER, 'phoenix_procurement_submit_order', [careOrder, null])).toMatchObject({ status: 'submitted' });
        expect(await rpc(U_APPROVER, 'phoenix_procurement_decide_order', [careOrder, true, 'ok', null])).toMatchObject({ status: 'approved' });
        expect(await orderRow(careOrder)).toMatchObject({ organization_id: ORG_CARE, warehouse_id: WH_CARE, status: 'approved' });
      });

      it('9a. receive_order posts a care purchase/supplementary lot (receipt, receipt line, stock, movement)', async () => {
        const [line] = await admin(`SELECT id, batch_number FROM procurement_order_lines WHERE order_id = $1`, [careOrder]);
        careOrderLine = line.id;
        const before = await counts();
        const rec = await rpc(U_OFFICER, 'phoenix_procurement_receive_order', [randomUUID(), careOrder, JSON.stringify([
          { order_line_id: line.id, quantity: 12, batch_number: line.batch_number, has_no_batch_number: false, expiry_date: '2027-06-01' },
        ]), null, null]);
        expect(rec).toMatchObject({ ok: true, order_status: 'partially_received' });
        careSuppLot = rec.lines[0].warehouse_stock_id;
        careReceiptLine = rec.lines[0].receipt_line_id;
        careReceipt = rec.receipt_id;
        expect(await lotRow(careSuppLot)).toMatchObject({ organization_id: ORG_CARE, warehouse_id: WH_CARE, supply_type: 'purchase',
          purchase_origin: 'supplementary', on_hand_quantity: 12 });
        expect((await admin(`SELECT receipt_id, organization_id FROM procurement_receipt_lines WHERE id = $1`, [careReceiptLine]))[0])
          .toEqual({ receipt_id: careReceipt, organization_id: ORG_CARE });
        const after = await counts();
        expect(after.procurement_receipts - before.procurement_receipts).toBe(1);
        expect(after.procurement_receipt_lines - before.procurement_receipt_lines).toBe(1);
        expect(after.warehouse_stock - before.warehouse_stock).toBe(1);
      });

      it('9b. phoenix_subpurchase_direct_entry records a care supplementary purchase end to end', async () => {
        const before = await counts();
        const r = await directEntry(U_OFFICER, WH_CARE, 'Metformin');
        expect(r).toMatchObject({ ok: true });
        const after = await counts();
        expect(after.procurement_orders - before.procurement_orders).toBe(1);
        expect(after.procurement_receipts - before.procurement_receipts).toBe(1);
        expect(after.procurement_receipt_lines - before.procurement_receipt_lines).toBe(1);
        expect(after.warehouse_stock - before.warehouse_stock).toBe(1);
        const [lot] = await admin(`SELECT organization_id, supply_type, purchase_origin FROM warehouse_stock
          WHERE warehouse_id = $1 ORDER BY created_at DESC LIMIT 1`, [WH_CARE]);
        expect(lot).toEqual({ organization_id: ORG_CARE, supply_type: 'purchase', purchase_origin: 'supplementary' });
      });

      it('9c. return_to_supplier records a care return and debits the supplementary lot', async () => {
        const before = await counts();
        const r = await rpc(U_OFFICER, 'phoenix_procurement_return_to_supplier', [randomUUID(), careReceiptLine, 2, 'damaged on arrival', null, null, 'damaged']);
        expect(r).toMatchObject({ ok: true, quantity_after: 10 });
        careReturn = r.return_id;
        expect((await lotRow(careSuppLot)).on_hand_quantity).toBe(10);
        expect((await admin(`SELECT organization_id, order_id, receipt_line_id FROM procurement_returns WHERE id = $1`, [careReturn]))[0])
          .toEqual({ organization_id: ORG_CARE, order_id: careOrder, receipt_line_id: careReceiptLine });
        expect((await counts()).procurement_returns - before.procurement_returns).toBe(1);
      });
    });

    // -----------------------------------------------------------------------
    // 1-6, 11. every PDA write is refused, for every writer
    // -----------------------------------------------------------------------
    describe('1-6, 11. PDA supplementary procurement state is refused for every writer', () => {
      it('the owner session used below IS a superuser (test 11 is not vacuous)', async () => {
        expect((await admin(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`))[0].rolsuper).toBe(true);
      });

      it('1. a PDA supplier INSERT: raw owner SQL, raw service_role SQL, and save_supplier as super_admin', async () => {
        const raw = `INSERT INTO public.procurement_suppliers (organization_id, name) VALUES ($1, $2)`;
        await refused(() => admin(raw, [ORG_PDA, 'PDA supplier (owner)']));
        await refused(() => asService(raw, [ORG_PDA, 'PDA supplier (service_role)']));
        await refused(() => saveSupplier(rig.superAdminId, ORG_PDA, 'PDA supplier (super_admin)'));
        expect((await admin(`SELECT count(*)::int AS n FROM procurement_suppliers WHERE organization_id = $1`, [ORG_PDA]))[0].n).toBe(0);
      });

      it('2. re-labelling a care supplier onto the PDA is refused; the row is unchanged (care -> care still works)', async () => {
        const fresh = (await saveSupplier(U_OFFICER, ORG_CARE)).supplier_id;
        const before = await supplierRow(fresh);
        await refused(() => admin(`UPDATE public.procurement_suppliers SET organization_id = $2 WHERE id = $1`, [fresh, ORG_PDA]));
        await refused(() => asService(`UPDATE public.procurement_suppliers SET organization_id = $2 WHERE id = $1`, [fresh, ORG_PDA]));
        expect(await supplierRow(fresh)).toEqual(before);
        // A supplier referenced by an order: the guard still answers first (before the composite foreign key).
        await refused(() => admin(`UPDATE public.procurement_suppliers SET organization_id = $2 WHERE id = $1`, [careSupplier, ORG_PDA]));
        const moved = await rolledBack(async (c) => (await c.query(
          `UPDATE public.procurement_suppliers SET organization_id = $2 WHERE id = $1 RETURNING organization_id`, [fresh, ORG_CARE2])).rows[0]);
        expect(moved).toEqual({ organization_id: ORG_CARE2 });
        expect(await supplierRow(fresh)).toEqual(before);
      });

      it('3. a PDA procurement order INSERT is refused with the PDA token (the guard fires before the M184 root guard)', async () => {
        const raw = `INSERT INTO public.procurement_orders (organization_id, warehouse_id, supplier_id, order_number, status, created_by)
          VALUES ($1, $2, $3, $4, 'draft', $5)`;
        await refused(() => admin(raw, [ORG_PDA, WH_PDA, careSupplier, 'P221-RAW-1', rig.superAdminId]));
        await refused(() => asService(raw, [ORG_PDA, WH_PDA, careSupplier, 'P221-RAW-2', rig.superAdminId]));
        // The PDA has no institution warehouse; direct entry into its central warehouse is refused by the existing RPC check first.
        await refused(() => directEntry(rig.superAdminId, WH_PDA), { code: '23514', message: 'destination_must_be_active_institution_warehouse' });
      });

      it('4. re-labelling a care order onto the PDA is refused; the order is unchanged', async () => {
        const before = await orderRow(careOrder);
        await refused(() => admin(`UPDATE public.procurement_orders SET organization_id = $2 WHERE id = $1`, [careOrder, ORG_PDA]));
        await refused(() => admin(`UPDATE public.procurement_orders SET organization_id = $2, warehouse_id = $3 WHERE id = $1`, [careOrder, ORG_PDA, WH_PDA]));
        await refused(() => asService(`UPDATE public.procurement_orders SET organization_id = $2 WHERE id = $1`, [careOrder, ORG_PDA]));
        expect(await orderRow(careOrder)).toEqual(before);
      });

      it('5. a PDA purchase/supplementary lot is refused: raw owner and service_role INSERT, and the internal poster called with a fabricated PDA order', async () => {
        await refused(() => admin(LOT, lotParams(ORG_PDA, WH_PDA, 'purchase', 'supplementary')));
        await refused(() => asService(LOT, lotParams(ORG_PDA, WH_PDA, 'purchase', 'supplementary')));
        expect((await admin(`SELECT has_function_privilege('service_role', '_phoenix_procurement_post_receipt_line(procurement_receipt_lines, procurement_orders, procurement_order_lines, uuid, text, text)'::regprocedure, 'EXECUTE') AS x`))[0].x).toBe(true);
        const poster = `SELECT * FROM public._phoenix_procurement_post_receipt_line(
            jsonb_populate_record(NULL::public.procurement_receipt_lines, $1::jsonb),
            jsonb_populate_record(NULL::public.procurement_orders, $2::jsonb),
            jsonb_populate_record(NULL::public.procurement_order_lines, $3::jsonb), $4, 'service_role', 'svc')`;
        const fabricated = [
          JSON.stringify({ id: randomUUID(), quantity: 5, has_no_batch_number: true, has_no_national_code: true, expiry_date: '2028-01-01' }),
          JSON.stringify({ id: randomUUID(), organization_id: ORG_PDA, warehouse_id: WH_PDA, order_number: 'FABRICATED-221', currency: 'IQD' }),
          JSON.stringify({ id: randomUUID(), scientific_name: 'Fabricated PDA purchase', ordered_quantity: 5 }),
          rig.superAdminId,
        ];
        await refused(() => asService(poster, fabricated));
        await refused(() => admin(poster, fabricated));
        expect(await pdaSupplementaryStock()).toBe(0);
      });

      it('6. an existing lot cannot be reforged into PDA supplementary: provenance flip on a PDA central lot, organization flip of a care supplementary lot', async () => {
        const pdaBefore = await lotRow(pdaAidLot);
        await refused(() => admin(`UPDATE public.warehouse_stock SET supply_type = 'purchase', purchase_origin = 'supplementary' WHERE id = $1`, [pdaAidLot]));
        await refused(() => asService(`UPDATE public.warehouse_stock SET supply_type = 'purchase', purchase_origin = 'supplementary' WHERE id = $1`, [pdaAidLot]));
        expect(await lotRow(pdaAidLot)).toEqual(pdaBefore);
        const careBefore = await lotRow(careSuppLot);
        await refused(() => admin(`UPDATE public.warehouse_stock SET organization_id = $2, warehouse_id = $3 WHERE id = $1`, [careSuppLot, ORG_PDA, WH_PDA]));
        await refused(() => admin(`UPDATE public.warehouse_stock SET organization_id = $2 WHERE id = $1`, [careSuppLot, ORG_PDA]));
        expect(await lotRow(careSuppLot)).toEqual(careBefore);
        // The guard judges the organization, not the provenance: a care lot may still become purchase/supplementary (rolled back).
        const careAid = await insertLot(ORG_CARE, WH_CARE, 'aid', null);
        const flipped = await rolledBack(async (c) => (await c.query(
          `UPDATE public.warehouse_stock SET supply_type = 'purchase', purchase_origin = 'supplementary' WHERE id = $1 RETURNING supply_type`, [careAid])).rows[0]);
        expect(flipped).toEqual({ supply_type: 'purchase' });
      });

      it('6b. a PDA lot with supply_type NULL and purchase_origin supplementary is refused (owner and service_role), zero rows - and the M088 CHECK alone would accept it (negative control, rolled back)', async () => {
        const [check] = await admin(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
          WHERE c.conrelid = 'public.warehouse_stock'::regclass AND c.conname = 'warehouse_stock_purchase_origin_chk'`);
        expect(check.def).toBe("CHECK (((supply_type = 'purchase'::text) = (purchase_origin IS NOT NULL)))");
        const owner = await refused(() => admin(LOT, lotParams(ORG_PDA, WH_PDA, null, 'supplementary')));
        const service = await refused(() => asService(LOT, lotParams(ORG_PDA, WH_PDA, null, 'supplementary')));
        expect(await pdaSupplementaryStock()).toBe(0);
        // The negative control: with ONLY the stock insert binding disabled (rolled back) the very same row inserts - the
        // M088 CHECK evaluates to UNKNOWN for supply_type NULL and lets it through; the refusal above IS M221.
        const unguarded = await rolledBack(async (c) => {
          await c.query('ALTER TABLE public.warehouse_stock DISABLE TRIGGER phoenix_pda_supplementary_stock_insert_guard');
          const row = (await c.query(LOT.replace('RETURNING id', 'RETURNING organization_id, supply_type, purchase_origin'),
            lotParams(ORG_PDA, WH_PDA, null, 'supplementary'))).rows[0];
          const checkValue = (await c.query(`SELECT ((NULL::text = 'purchase') = ('supplementary'::text IS NOT NULL)) AS v`)).rows[0].v;
          return { row, checkValue };
        });
        console.log('[M221 evidence] 6b PDA (NULL, supplementary) lot:', JSON.stringify({ owner, service, m088CheckAloneAccepts: unguarded }));
        expect(unguarded).toEqual({ row: { organization_id: ORG_PDA, supply_type: null, purchase_origin: 'supplementary' }, checkValue: null });
        expect((await admin(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'phoenix_pda_supplementary_stock_insert_guard'`))[0].tgenabled).toBe('O');
        expect(await pdaSupplementaryStock()).toBe(0);
      });

      it('6c. a legal non-supplementary PDA lot cannot be mutated into purchase_origin supplementary: (NULL, NULL) -> (NULL, supplementary), (purchase, central) -> (purchase, supplementary); nor a care (NULL, supplementary) lot moved onto the PDA - refused, unchanged', async () => {
        const nullBefore = await lotRow(pdaNullLot);
        expect(nullBefore).toMatchObject({ organization_id: ORG_PDA, supply_type: null, purchase_origin: null });
        await refused(() => admin(`UPDATE public.warehouse_stock SET purchase_origin = 'supplementary' WHERE id = $1`, [pdaNullLot]));
        await refused(() => asService(`UPDATE public.warehouse_stock SET purchase_origin = 'supplementary' WHERE id = $1`, [pdaNullLot]));
        expect(await lotRow(pdaNullLot)).toEqual(nullBefore);
        const centralBefore = await lotRow(pdaCentralLot);
        expect(centralBefore).toMatchObject({ organization_id: ORG_PDA, supply_type: 'purchase', purchase_origin: 'central' });
        await refused(() => admin(`UPDATE public.warehouse_stock SET purchase_origin = 'supplementary' WHERE id = $1`, [pdaCentralLot]));
        await refused(() => asService(`UPDATE public.warehouse_stock SET purchase_origin = 'supplementary' WHERE id = $1`, [pdaCentralLot]));
        expect(await lotRow(pdaCentralLot)).toEqual(centralBefore);
        const careBefore = await lotRow(careNullSuppLot);
        expect(careBefore).toMatchObject({ organization_id: ORG_CARE, supply_type: null, purchase_origin: 'supplementary' });
        await refused(() => admin(`UPDATE public.warehouse_stock SET organization_id = $2, warehouse_id = $3 WHERE id = $1`, [careNullSuppLot, ORG_PDA, WH_PDA]));
        await refused(() => admin(`UPDATE public.warehouse_stock SET organization_id = $2 WHERE id = $1`, [careNullSuppLot, ORG_PDA]));
        await refused(() => asService(`UPDATE public.warehouse_stock SET organization_id = $2, warehouse_id = $3 WHERE id = $1`, [careNullSuppLot, ORG_PDA, WH_PDA]));
        expect(await lotRow(careNullSuppLot)).toEqual(careBefore);
        expect(await pdaSupplementaryStock()).toBe(0);
      });

      it('7. care supplementary stock stays legal: (NULL, supplementary) and (purchase, supplementary) inserts by owner and service_role, and a care (NULL, NULL) -> (NULL, supplementary) flip', async () => {
        const committed = await insertLot(ORG_CARE, WH_CARE, null, 'supplementary');
        expect(await lotRow(committed)).toMatchObject({ organization_id: ORG_CARE, supply_type: null, purchase_origin: 'supplementary' });
        const viaService = await serviceRolledBack(async (c) => [
          (await c.query(LOT.replace('RETURNING id', 'RETURNING organization_id, supply_type, purchase_origin'), lotParams(ORG_CARE, WH_CARE, null, 'supplementary'))).rows[0],
          (await c.query(LOT.replace('RETURNING id', 'RETURNING organization_id, supply_type, purchase_origin'), lotParams(ORG_CARE, WH_CARE, 'purchase', 'supplementary'))).rows[0],
        ]);
        expect(viaService).toEqual([
          { organization_id: ORG_CARE, supply_type: null, purchase_origin: 'supplementary' },
          { organization_id: ORG_CARE, supply_type: 'purchase', purchase_origin: 'supplementary' },
        ]);
        const careNull = await insertLot(ORG_CARE, WH_CARE, null, null);
        const flipped = await rolledBack(async (c) => (await c.query(
          `UPDATE public.warehouse_stock SET purchase_origin = 'supplementary' WHERE id = $1 RETURNING organization_id, supply_type, purchase_origin`, [careNull])).rows[0]);
        expect(flipped).toEqual({ organization_id: ORG_CARE, supply_type: null, purchase_origin: 'supplementary' });
        console.log('[M221 evidence] 7 care supplementary stock legal:', JSON.stringify({ committed: await lotRow(committed), viaService, flipped }));
      });

      it('11. a missing organization is never eligible: an unknown id, and the data-modifying CTE that would create the PDA (or even a care institution) after the check - for a supplier, a lot and a receipt', async () => {
        const ghost = randomUUID();
        await refused(() => admin(`INSERT INTO public.procurement_suppliers (organization_id, name) VALUES ($1, 'Ghost')`, [ghost]));
        for (const [kind, klass] of [['pharmacy_department_authority', null], ['care_institution', 'hospital']]) {
          const id = randomUUID();
          await refused(() => admin(`WITH o AS (INSERT INTO public.organizations (id, name, name_ar, code, organization_kind, institution_class)
              VALUES ($1, $2, $2, $3, $4, $5))
            INSERT INTO public.procurement_suppliers (organization_id, name) VALUES ($1, 'CTE supplier')`,
          [id, `CTE ${kind}`, `p221-cte-${id.slice(0, 8)}`, kind, klass]));
          expect((await admin(`SELECT count(*)::int AS n FROM organizations WHERE id = $1`, [id]))[0].n).toBe(0);
        }
        // The same CTE trick against the stock guard: organization, central warehouse and supplementary lot in one statement.
        const org = randomUUID();
        const wh = randomUUID();
        await refused(() => admin(`WITH o AS (INSERT INTO public.organizations (id, name, name_ar, code, organization_kind, institution_class)
              VALUES ($1, 'CTE PDA', 'CTE', $2, 'pharmacy_department_authority', NULL)),
            w AS (INSERT INTO public.warehouses (id, organization_id, name, name_ar, status, warehouse_kind, code)
              VALUES ($3, $1, 'CTE WH', 'CTE', 'active', 'central', $4))
          INSERT INTO public.warehouse_stock (organization_id, warehouse_id, scientific_name, has_no_national_code, batch_number,
              has_no_batch_number, on_hand_quantity, supply_type, purchase_origin)
            VALUES ($1, $3, 'CTE lot', true, 'CTE-B', false, 5, NULL, 'supplementary')`,
        [org, `p221-cte2-${org.slice(0, 8)}`, wh, `p221-ctew-${wh.slice(0, 8)}`]));
        expect((await admin(`SELECT (SELECT count(*) FROM organizations WHERE id = $1)::int AS o, (SELECT count(*) FROM warehouses WHERE id = $2)::int AS w`,
          [org, wh]))[0]).toEqual({ o: 0, w: 0 });
        // ... and against a child table: a care institution created in the same statement as a receipt labelled with it.
        const careId = randomUUID();
        const receiptArgs = receiptParams(careOrder, careId, careSupplier);
        await refused(() => admin(`WITH o AS (INSERT INTO public.organizations (id, name, name_ar, code, organization_kind, institution_class)
              VALUES ($2, 'CTE care', 'CTE', $8, 'care_institution', 'hospital'))
          INSERT INTO public.procurement_receipts (order_id, organization_id, warehouse_id, supplier_id, receipt_number, request_id,
              request_fingerprint, received_by) VALUES ($1, $2, $3, $4, $5, $6, repeat('a', 64), $7)`,
        [...receiptArgs, `p221-cte3-${careId.slice(0, 8)}`]));
        expect((await admin(`SELECT count(*)::int AS n FROM organizations WHERE id = $1`, [careId]))[0].n).toBe(0);
      });
    });

    // -----------------------------------------------------------------------
    // FORGED_PDA_CHILD_UNDER_CARE_ORDER — order lines, order events, receipts, receipt lines and returns are guarded on
    // INSERT; order lines (no immutability trigger) also on the re-label of organization_id
    // -----------------------------------------------------------------------
    describe('FORGED_PDA_CHILD_UNDER_CARE_ORDER: a PDA-labelled order line, order event, receipt, receipt line or return under a CARE parent is refused for every writer', () => {
      let freshDraftOrder = '';   // a care DRAFT order created through create_order on the 221 chain
      let freshDraftLine = '';    // its line, added through add_order_line on the 221 chain

      it('positive control: service_role holds INSERT, UPDATE and DELETE on warehouse_stock and the five child tables - a care-labelled row of each inserts (and a care order line is re-labelled care -> care) as service_role (rolled back), so no refusal below can be a 42501 privilege error', async () => {
        const tables = ['procurement_order_events', 'procurement_order_lines', 'procurement_receipt_lines', 'procurement_receipts',
          'procurement_returns', 'warehouse_stock'];
        const privileges = await admin(`SELECT t AS rel, has_table_privilege('service_role', 'public.' || t, 'INSERT') AS ins,
            has_table_privilege('service_role', 'public.' || t, 'UPDATE') AS upd, has_table_privilege('service_role', 'public.' || t, 'DELETE') AS del
          FROM unnest($1::text[]) AS t ORDER BY 1`, [tables]);
        expect(privileges).toEqual(tables.map((rel) => ({ rel, ins: true, upd: true, del: true })));
        const inserted = await serviceRolledBack(async (c) => {
          const who = (await c.query(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`)).rows[0];
          const orderLine = (await c.query(ORDER_LINE, orderLineParams(careOrder, ORG_CARE))).rows[0];
          const orderEvent = (await c.query(ORDER_EVENT, orderEventParams(careOrder, ORG_CARE))).rows[0];
          const relabel = (await c.query(`UPDATE public.procurement_order_lines SET organization_id = $2 WHERE id = $1 RETURNING organization_id`,
            [orderLine.id, ORG_CARE2])).rows[0];
          const receipt = (await c.query(RECEIPT, receiptParams(careOrder, ORG_CARE, careSupplier))).rows[0];
          const line = (await c.query(RECEIPT_LINE, receiptLineParams(receipt.id, careOrderLine, ORG_CARE))).rows[0];
          const ret = (await c.query(RETURN, returnParams(careOrder, line.id, ORG_CARE))).rows[0];
          const lot = (await c.query(LOT.replace('RETURNING id', 'RETURNING organization_id, supply_type, purchase_origin'),
            lotParams(ORG_CARE, WH_CARE, 'purchase', 'supplementary'))).rows[0];
          return { who, orderLine: orderLine.organization_id, orderEvent: orderEvent.organization_id, relabel: relabel.organization_id,
            receipt: receipt.organization_id, line: line.organization_id, ret: ret.organization_id, lot };
        });
        console.log('[M221 evidence] service_role positive control (care-labelled, rolled back):', JSON.stringify({ privileges, inserted }));
        expect(inserted).toEqual({ who: { u: 'service_role', su: false }, orderLine: ORG_CARE, orderEvent: ORG_CARE, relabel: ORG_CARE2,
          receipt: ORG_CARE, line: ORG_CARE, ret: ORG_CARE, lot: { organization_id: ORG_CARE, supply_type: 'purchase', purchase_origin: 'supplementary' } });
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });

      it('1. a PDA-labelled procurement_receipts INSERT under a CARE order is refused - owner and service_role', async () => {
        const owner = receiptParams(careOrder, ORG_PDA, careSupplier);
        const service = receiptParams(careOrder, ORG_PDA, careSupplier);
        const r1 = await refused(() => admin(RECEIPT, owner));
        const r2 = await refused(() => asService(RECEIPT, service));
        console.log('[M221 evidence] 1 PDA-labelled receipt under a care order:', JSON.stringify({ owner: r1, service: r2 }));
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });

      it('2. a PDA-labelled procurement_receipt_lines INSERT under a CARE receipt and a care order line is refused - owner and service_role', async () => {
        const params = receiptLineParams(careReceipt, careOrderLine, ORG_PDA);
        const r1 = await refused(() => admin(RECEIPT_LINE, params));
        const r2 = await refused(() => asService(RECEIPT_LINE, params));
        console.log('[M221 evidence] 2 PDA-labelled receipt line under a care receipt:', JSON.stringify({ owner: r1, service: r2 }));
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });

      it('3. a PDA-labelled procurement_returns INSERT under a care order and a care receipt line is refused - owner and service_role', async () => {
        const owner = returnParams(careOrder, careReceiptLine, ORG_PDA);
        const service = returnParams(careOrder, careReceiptLine, ORG_PDA);
        const r1 = await refused(() => admin(RETURN, owner));
        const r2 = await refused(() => asService(RETURN, service));
        console.log('[M221 evidence] 3 PDA-labelled return under a care receipt line:', JSON.stringify({ owner: r1, service: r2 }));
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });

      it('4. care-labelled receipts, receipt lines and returns with every foreign key valid stay legal - owner and service_role (inserted, verified, rolled back); the RPC flows 9a-9c passed above', async () => {
        const chain = async (c: any) => {
          const receipt = (await c.query(RECEIPT, receiptParams(careOrder, ORG_CARE, careSupplier))).rows[0];
          const line = (await c.query(RECEIPT_LINE, receiptLineParams(receipt.id, careOrderLine, ORG_CARE))).rows[0];
          const ret = (await c.query(RETURN, returnParams(careOrder, line.id, ORG_CARE))).rows[0];
          const read = (await c.query(`SELECT r.organization_id AS receipt, l.organization_id AS line, t.organization_id AS ret,
              r.order_id = $4 AS receipt_under_care_order, l.receipt_id = r.id AS line_under_receipt, t.receipt_line_id = l.id AS return_under_line
            FROM procurement_receipts r, procurement_receipt_lines l, procurement_returns t WHERE r.id = $1 AND l.id = $2 AND t.id = $3`,
          [receipt.id, line.id, ret.id, careOrder])).rows[0];
          // The guard judges the kind of the row's OWN label: a second care institution's label is a care label too.
          const care2 = (await c.query(RECEIPT, receiptParams(careOrder, ORG_CARE2, careSupplier))).rows[0].organization_id;
          return { read, care2 };
        };
        const before = await counts();
        const owner = await rolledBack(chain);
        const service = await serviceRolledBack(chain);
        const expected = { read: { receipt: ORG_CARE, line: ORG_CARE, ret: ORG_CARE, receipt_under_care_order: true, line_under_receipt: true,
          return_under_line: true }, care2: ORG_CARE2 };
        console.log('[M221 evidence] 4 care-labelled children legal (rolled back):', JSON.stringify({ owner, service }));
        expect(owner).toEqual(expected);
        expect(service).toEqual(expected);
        expect(await counts()).toEqual(before);
      });

      it('5. a PDA-labelled procurement_order_lines INSERT under a valid CARE order (the draft and the approved one) is refused - owner and service_role; zero rows', async () => {
        const parents = await admin(`SELECT o.id, o.status, g.organization_kind AS kind FROM procurement_orders o JOIN organizations g ON g.id = o.organization_id
          WHERE o.id = ANY($1::uuid[]) ORDER BY o.status`, [[draftOrderCare, careOrder]]);
        expect(parents.map((p: any) => [p.id === draftOrderCare ? 'draft order' : 'approved order', p.status, p.kind])).toEqual([
          ['draft order', 'draft', 'care_institution'], ['approved order', 'partially_received', 'care_institution']]);
        const evidence: Record<string, unknown> = {};
        for (const [label, order] of [['draft', draftOrderCare], ['approved', careOrder]] as const) {
          const params = orderLineParams(order, ORG_PDA);
          const owner = await refused(() => admin(ORDER_LINE, params));
          const service = await refused(() => asService(ORDER_LINE, params));
          evidence[label] = { owner, service };
        }
        console.log('[M221 evidence] 5 PDA-labelled order line under a care order:', JSON.stringify(evidence));
        expect((await admin(`SELECT count(*)::int AS n FROM procurement_order_lines WHERE organization_id = $1`, [ORG_PDA]))[0].n).toBe(0);
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });

      it('6. care-labelled procurement_order_lines stay legal: a raw care-labelled line under a care draft order (owner and service_role, parent link verified, rolled back) and phoenix_procurement_add_order_line on a care DRAFT order (committed)', async () => {
        const raw = async (c: any) => {
          const line = (await c.query(ORDER_LINE, orderLineParams(draftOrderCare, ORG_CARE))).rows[0];
          return (await c.query(`SELECT l.organization_id AS line, o.organization_id AS parent, o.status, l.order_id = o.id AS under_order
            FROM procurement_order_lines l JOIN procurement_orders o ON o.id = l.order_id WHERE l.id = $1`, [line.id])).rows[0];
        };
        const before = await counts();
        const owner = await rolledBack(raw);
        const service = await serviceRolledBack(raw);
        const expected = { line: ORG_CARE, parent: ORG_CARE, status: 'draft', under_order: true };
        expect(owner).toEqual(expected);
        expect(service).toEqual(expected);
        expect(await counts()).toEqual(before);
        // The canonical path: create_order + add_order_line on a care draft order, after M221 (committed).
        const created = await createOrder(U_OFFICER, careSupplier);
        expect(created).toMatchObject({ ok: true });
        freshDraftOrder = created.order_id;
        const added = await addLine(U_OFFICER, freshDraftOrder, 7);
        expect(added).toMatchObject({ ok: true });
        freshDraftLine = added.order_line_id;
        const [row] = await admin(`SELECT l.organization_id AS line, o.organization_id AS parent, o.status, l.ordered_quantity
          FROM procurement_order_lines l JOIN procurement_orders o ON o.id = l.order_id WHERE l.id = $1`, [freshDraftLine]);
        console.log('[M221 evidence] 6 care order lines legal (raw rolled back; add_order_line committed):', JSON.stringify({ owner, service, rpc: row }));
        expect(row).toEqual({ line: ORG_CARE, parent: ORG_CARE, status: 'draft', ordered_quantity: 7 });
        const after = await counts();
        expect(after.procurement_orders - before.procurement_orders).toBe(1);
        expect(after.procurement_order_lines - before.procurement_order_lines).toBe(1);
        expect(after.procurement_order_events - before.procurement_order_events).toBe(1);
      });

      it('7. re-labelling an existing legal care order line onto the PDA is refused 23514 - owner and service_role, organization_id alone and with a quantity change; the whole row is unchanged; a care -> care2 re-label is NOT refused by M221 (cross-care mismatch deferred; rolled back)', async () => {
        expect(freshDraftLine).toBeTruthy();
        const evidence: Record<string, unknown> = {};
        for (const [label, lineId] of [['approved order line', careOrderLine], ['draft order line (add_order_line)', freshDraftLine]] as const) {
          const before = await rowJson('procurement_order_lines', lineId);
          expect(before.organization_id, label).toBe(ORG_CARE);
          const owner = await refused(() => admin(`UPDATE public.procurement_order_lines SET organization_id = $2 WHERE id = $1`, [lineId, ORG_PDA]));
          const service = await refused(() => asService(`UPDATE public.procurement_order_lines SET organization_id = $2 WHERE id = $1`, [lineId, ORG_PDA]));
          const combined = await refused(() => asService(`UPDATE public.procurement_order_lines
              SET organization_id = $2, ordered_quantity = ordered_quantity + 1, notes = 'M221 re-label' WHERE id = $1`, [lineId, ORG_PDA]));
          const ownerCombined = await refused(() => admin(`UPDATE public.procurement_order_lines
              SET ordered_quantity = ordered_quantity + 1, organization_id = $2 WHERE id = $1`, [lineId, ORG_PDA]));
          expect(await rowJson('procurement_order_lines', lineId), label).toEqual(before);
          evidence[label] = { owner, service, combined, ownerCombined };
        }
        // The guard judges the kind of the NEW organization only: care -> care2 passes M221 (the deferred residual).
        const relabel = async (c: any) => (await c.query(`UPDATE public.procurement_order_lines SET organization_id = $2 WHERE id = $1
          RETURNING organization_id`, [freshDraftLine, ORG_CARE2])).rows[0];
        const care2 = { owner: await rolledBack(relabel), service: await serviceRolledBack(relabel) };
        console.log('[M221 evidence] 7 care order line re-label onto the PDA refused; care -> care2 accepted (rolled back):', JSON.stringify({ evidence, care2 }));
        expect(care2).toEqual({ owner: { organization_id: ORG_CARE2 }, service: { organization_id: ORG_CARE2 } });
        expect((await rowJson('procurement_order_lines', freshDraftLine)).organization_id).toBe(ORG_CARE);
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });

      it('8. a PDA-labelled procurement_order_events INSERT under a valid CARE order (the draft and the approved one) is refused - owner and service_role; zero rows', async () => {
        const evidence: Record<string, unknown> = {};
        for (const [label, order] of [['draft', draftOrderCare], ['approved', careOrder]] as const) {
          const params = orderEventParams(order, ORG_PDA);
          const owner = await refused(() => admin(ORDER_EVENT, params));
          const service = await refused(() => asService(ORDER_EVENT, params));
          evidence[label] = { owner, service };
        }
        console.log('[M221 evidence] 8 PDA-labelled order event under a care order:', JSON.stringify(evidence));
        expect((await admin(`SELECT count(*)::int AS n FROM procurement_order_events WHERE organization_id = $1`, [ORG_PDA]))[0].n).toBe(0);
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });

      it('9. care-labelled order events stay legal: every event the canonical RPCs wrote (create_order, submit, decide, receive_order, return_to_supplier; create_order after M221) carries the care organization; a raw care-labelled event inserts (owner and service_role, rolled back)', async () => {
        const events = await admin(`SELECT event_type, from_status, to_status, organization_id FROM procurement_order_events
          WHERE order_id = $1 ORDER BY created_at, event_type`, [careOrder]);
        const fresh = await admin(`SELECT event_type, to_status, organization_id FROM procurement_order_events WHERE order_id = $1`, [freshDraftOrder]);
        console.log('[M221 evidence] 9 order events written by the canonical RPCs for the care orders:', JSON.stringify({ careOrder: events, freshDraftOrder: fresh }));
        expect(events.map((e: any) => e.event_type)).toEqual(['created', 'submitted', 'approved', 'receipt_posted', 'return_posted']);
        expect(events.map((e: any) => e.organization_id)).toEqual(Array(5).fill(ORG_CARE));
        expect(fresh).toEqual([{ event_type: 'created', to_status: 'draft', organization_id: ORG_CARE }]);
        const raw = async (c: any) => (await c.query(ORDER_EVENT, orderEventParams(careOrder, ORG_CARE))).rows[0].organization_id;
        const before = await counts();
        expect({ owner: await rolledBack(raw), service: await serviceRolledBack(raw) }).toEqual({ owner: ORG_CARE, service: ORG_CARE });
        expect(await counts()).toEqual(before);
      });

      it('FORGED_PDA_CHILD_UNDER_CARE_ORDER: for each of the five child tables the parent chain is a care institution and the PDA label is refused with the M221 token, writing nothing', async () => {
        const [parents] = await admin(`SELECT (SELECT g.organization_kind FROM procurement_orders o JOIN organizations g ON g.id = o.organization_id WHERE o.id = $1) AS order_kind,
            (SELECT g.organization_kind FROM procurement_receipts r JOIN organizations g ON g.id = r.organization_id WHERE r.id = $2) AS receipt_kind,
            (SELECT g.organization_kind FROM procurement_receipt_lines l JOIN organizations g ON g.id = l.organization_id WHERE l.id = $3) AS receipt_line_kind,
            (SELECT g.organization_kind FROM procurement_order_lines l JOIN organizations g ON g.id = l.organization_id WHERE l.id = $5) AS order_line_kind,
            (SELECT organization_kind FROM organizations WHERE id = $4) AS label_kind`, [careOrder, careReceipt, careReceiptLine, ORG_PDA, careOrderLine]);
        expect(parents).toEqual({ order_kind: 'care_institution', receipt_kind: 'care_institution', receipt_line_kind: 'care_institution',
          order_line_kind: 'care_institution', label_kind: 'pharmacy_department_authority' });
        const forged: Array<[string, string, unknown[]]> = [
          ['procurement_order_lines', ORDER_LINE, orderLineParams(careOrder, ORG_PDA)],
          ['procurement_order_events', ORDER_EVENT, orderEventParams(careOrder, ORG_PDA)],
          ['procurement_receipts', RECEIPT, receiptParams(careOrder, ORG_PDA, careSupplier)],
          ['procurement_receipt_lines', RECEIPT_LINE, receiptLineParams(careReceipt, careOrderLine, ORG_PDA)],
          ['procurement_returns', RETURN, returnParams(careOrder, careReceiptLine, ORG_PDA)],
        ];
        expect(forged.map(([table]) => table)).toEqual(CHILD.map((c) => c.table));
        const outcome: Record<string, unknown> = {};
        for (const [table, sql, params] of forged) {
          const owner = await refused(() => admin(sql, params));
          const service = await refused(() => asService(sql, params));
          expect({ owner, service }, table).toEqual({ owner: { code: '23514', message: TOKEN, detail: STATIC_DETAIL }, service: { code: '23514', message: TOKEN, detail: STATIC_DETAIL } });
          outcome[table] = owner.code;
        }
        console.log('[M221 evidence] FORGED_PDA_CHILD_UNDER_CARE_ORDER:', JSON.stringify({ parents, outcome }));
        expect(outcome).toEqual(Object.fromEntries(CHILD.map((c) => [c.table, '23514'])));
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });
    });

    // -----------------------------------------------------------------------
    // IMMUTABILITY — the M087 triggers refuse every UPDATE of the four INSERT-only child tables
    // -----------------------------------------------------------------------
    describe('IMMUTABILITY: UPDATE of order events, receipts, receipt lines and returns is refused by the M087 triggers (M221 needs no UPDATE guard on them)', () => {
      const careEvent = async () => (await admin(`SELECT id FROM procurement_order_events WHERE order_id = $1 AND event_type = 'approved'`, [careOrder]))[0].id as string;

      it('UPDATE ... SET organization_id = <PDA> on an existing care order event, receipt, receipt line and return - owner and service_role - is refused 42501 procurement_history_is_immutable; the row is unchanged', async () => {
        const evidence: Record<string, unknown> = {};
        const eventId = await careEvent();
        for (const [table, id] of [['procurement_order_events', eventId], ['procurement_receipts', careReceipt], ['procurement_receipt_lines', careReceiptLine],
          ['procurement_returns', careReturn]] as const) {
          expect(id, table).toBeTruthy();
          const before = await rowJson(table, id);
          expect(before.organization_id, table).toBe(ORG_CARE);
          const sql = `UPDATE public.${table} SET organization_id = $2 WHERE id = $1`;
          const owner = await refused(() => admin(sql, [id, ORG_PDA]), IMMUTABLE);
          const service = await refused(() => asService(sql, [id, ORG_PDA]), IMMUTABLE);
          expect(await rowJson(table, id), table).toEqual(before);
          evidence[table] = { owner, service };
        }
        expect(Object.keys(evidence)).toEqual(IMMUTABLE_CHILD.map((c) => c.table));
        console.log('[M221 evidence] IMMUTABILITY organization_id re-label of care children:', JSON.stringify(evidence));
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });

      it('procurement_order_events: a harmless column change (notes, payload, event_type) is refused 42501 too - owner and service_role - and so is a re-label onto a second care institution; the row is unchanged', async () => {
        const eventId = await careEvent();
        const before = await rowJson('procurement_order_events', eventId);
        const evidence: Record<string, unknown> = {};
        for (const [label, sql, params] of [
          ['notes', `UPDATE public.procurement_order_events SET notes = 'M221 harmless' WHERE id = $1`, [eventId]],
          ['payload', `UPDATE public.procurement_order_events SET payload = payload || '{"m221": true}'::jsonb WHERE id = $1`, [eventId]],
          ['event_type', `UPDATE public.procurement_order_events SET event_type = 'approved_m221' WHERE id = $1`, [eventId]],
          ['care -> care2', `UPDATE public.procurement_order_events SET organization_id = $2 WHERE id = $1`, [eventId, ORG_CARE2]],
        ] as const) {
          evidence[label] = { owner: await refused(() => admin(sql, [...params]), IMMUTABLE), service: await refused(() => asService(sql, [...params]), IMMUTABLE) };
        }
        console.log('[M221 evidence] IMMUTABILITY order event, harmless changes:', JSON.stringify(evidence));
        expect(await rowJson('procurement_order_events', eventId)).toEqual(before);
      });

      it('the order-event UPDATE refusal IS procurement_order_events_immutable, independently of M221: with the M221 guard dropped CASCADE (rolled back) the re-label and a harmless change are STILL refused 42501; with ONLY that immutability trigger disabled (rolled back) the very same re-label onto the PDA goes through - M221 binds no UPDATE trigger on order events', async () => {
        const eventId = await careEvent();
        const before = await rowJson('procurement_order_events', eventId);
        const dropped = await rolledBack(async (c) => {
          await c.query(`DROP FUNCTION ${GUARD_SIG} CASCADE`);
          const m221 = (await c.query(M221_STATE)).rows[0];
          const relabel = await attempt(c, `UPDATE public.procurement_order_events SET organization_id = $2 WHERE id = $1`, [eventId, ORG_PDA]);
          const harmless = await attempt(c, `UPDATE public.procurement_order_events SET notes = 'M221 harmless' WHERE id = $1`, [eventId]);
          return { m221, relabel, harmless };
        });
        expect(dropped).toEqual({ m221: ABSENT, relabel: { ...IMMUTABLE, detail: undefined }, harmless: { ...IMMUTABLE, detail: undefined } });
        const unguardedUpdate = await rolledBack(async (c) => {
          await c.query('ALTER TABLE public.procurement_order_events DISABLE TRIGGER procurement_order_events_immutable');
          const m221 = (await c.query(M221_STATE)).rows[0];
          const m221UpdateTriggers = (await c.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.procurement_order_events'::regclass
            AND tgfoid = '${GUARD_SIG}'::regprocedure AND (tgtype & 16) <> 0`)).rows[0].n;
          const row = (await c.query(`UPDATE public.procurement_order_events SET organization_id = $2 WHERE id = $1 RETURNING organization_id`,
            [eventId, ORG_PDA])).rows[0];
          return { m221, m221UpdateTriggers, row };
        });
        console.log('[M221 evidence] IMMUTABILITY order-event refusal is the M087 trigger (both rolled back):', JSON.stringify({ dropped, unguardedUpdate }));
        expect(unguardedUpdate).toEqual({ m221: PRESENT, m221UpdateTriggers: 0, row: { organization_id: ORG_PDA } });
        expect((await admin(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'procurement_order_events_immutable'`))[0].tgenabled).toBe('O');
        expect(await m221Present()).toEqual(PRESENT);
        expect(await rowJson('procurement_order_events', eventId)).toEqual(before);
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });

      it('neither sanctioned exemption can carry a re-label: the demo marking transition (receipt, order event) and the ledger-pointer fill with organization_id changed are refused 42501 (the plain fill alone still works; rolled back)', async () => {
        const eventId = await careEvent();
        const out = await rolledBack(async (c) => {
          await c.query(`SET LOCAL phoenix.demo_marking = 'on'`);
          const demo = await attempt(c, `UPDATE public.procurement_receipts SET demo_dataset_id = 'PHOENIX_DEMO_V1', organization_id = $2 WHERE id = $1`,
            [careReceipt, ORG_PDA]);
          const eventDemo = await attempt(c, `UPDATE public.procurement_order_events SET demo_dataset_id = 'PHOENIX_DEMO_V1', organization_id = $2 WHERE id = $1`,
            [eventId, ORG_PDA]);
          const receipt = (await c.query(RECEIPT, receiptParams(careOrder, ORG_CARE, careSupplier))).rows[0];
          const line = (await c.query(RECEIPT_LINE, receiptLineParams(receipt.id, careOrderLine, ORG_CARE))).rows[0];
          const ret = (await c.query(RETURN, returnParams(careOrder, line.id, ORG_CARE))).rows[0];
          const [movement] = (await c.query(`SELECT movement_id FROM procurement_receipt_lines WHERE id = $1`, [careReceiptLine])).rows;
          const lineFill = await attempt(c, `UPDATE public.procurement_receipt_lines SET warehouse_stock_id = $2, organization_id = $3 WHERE id = $1`,
            [line.id, careSuppLot, ORG_PDA]);
          const returnFill = await attempt(c, `UPDATE public.procurement_returns SET movement_id = $2, organization_id = $3 WHERE id = $1`,
            [ret.id, movement.movement_id, ORG_PDA]);
          const plainFill = await attempt(c, `UPDATE public.procurement_receipt_lines SET warehouse_stock_id = $2 WHERE id = $1`, [line.id, careSuppLot]);
          const labels = (await c.query(`SELECT (SELECT organization_id FROM procurement_receipt_lines WHERE id = $1) AS line,
              (SELECT organization_id FROM procurement_returns WHERE id = $2) AS ret`, [line.id, ret.id])).rows[0];
          return { demo, eventDemo, lineFill, returnFill, plainFill, labels };
        });
        console.log('[M221 evidence] IMMUTABILITY exemptions cannot carry a re-label (rolled back):', JSON.stringify(out));
        expect(out).toEqual({ demo: { ...IMMUTABLE, detail: undefined }, eventDemo: { ...IMMUTABLE, detail: undefined },
          lineFill: { ...IMMUTABLE, detail: undefined }, returnFill: { ...IMMUTABLE, detail: undefined }, plainFill: null,
          labels: { line: ORG_CARE, ret: ORG_CARE } });
        expect((await rowJson('procurement_receipts', careReceipt)).organization_id).toBe(ORG_CARE);
        expect((await rowJson('procurement_order_events', eventId)).organization_id).toBe(ORG_CARE);
      });
    });

    // -----------------------------------------------------------------------
    // PDA_RECEIPT_RETURN_BOUNDARY
    // -----------------------------------------------------------------------
    describe('PDA_RECEIPT_RETURN_BOUNDARY: the receipt chain cannot be initialized for a PDA', () => {
      it('the M087 foreign-key chain: every order line, order event, receipt, receipt line and return hangs off a procurement order (NOT NULL, validated, ON DELETE RESTRICT)', async () => {
        const fks = await admin(`
          SELECT cr.relname || '.' || a.attname || ' -> ' || fr.relname || '.' || fa.attname AS fk, c.conname AS name,
                 a.attnotnull AS not_null, c.convalidated AS validated, c.condeferrable AS deferrable, c.confdeltype AS on_delete
            FROM pg_constraint c
            JOIN pg_class cr ON cr.oid = c.conrelid JOIN pg_class fr ON fr.oid = c.confrelid
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
            JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = c.confkey[1]
           WHERE c.contype = 'f' AND cardinality(c.conkey) = 1 AND cr.relnamespace = 'public'::regnamespace
             AND (cr.relname, a.attname) IN (('procurement_receipts', 'order_id'), ('procurement_receipt_lines', 'receipt_id'),
                  ('procurement_receipt_lines', 'order_line_id'), ('procurement_returns', 'order_id'),
                  ('procurement_returns', 'receipt_line_id'), ('procurement_order_lines', 'order_id'), ('procurement_order_events', 'order_id'))
           ORDER BY 1`);
        console.log('[M221 evidence] PDA_RECEIPT_RETURN_BOUNDARY foreign-key chain:', JSON.stringify(fks));
        expect(fks).toEqual([
          ['procurement_order_events.order_id -> procurement_orders.id', 'procurement_order_events_order_id_fkey'],
          ['procurement_order_lines.order_id -> procurement_orders.id', 'procurement_order_lines_order_id_fkey'],
          ['procurement_receipt_lines.order_line_id -> procurement_order_lines.id', 'procurement_receipt_lines_order_line_id_fkey'],
          ['procurement_receipt_lines.receipt_id -> procurement_receipts.id', 'procurement_receipt_lines_receipt_id_fkey'],
          ['procurement_receipts.order_id -> procurement_orders.id', 'procurement_receipts_order_id_fkey'],
          ['procurement_returns.order_id -> procurement_orders.id', 'procurement_returns_order_id_fkey'],
          ['procurement_returns.receipt_line_id -> procurement_receipt_lines.id', 'procurement_returns_receipt_line_id_fkey'],
        ].map(([fk, name]) => ({ fk, name, not_null: true, validated: true, deferrable: false, on_delete: 'r' })));
      });

      it('a PDA order cannot be created - raw (owner, service_role) nor through create_order / direct entry as super_admin - and none exists', async () => {
        const raw = `INSERT INTO public.procurement_orders (organization_id, warehouse_id, supplier_id, order_number, status, created_by)
          VALUES ($1, $2, $3, $4, 'draft', $5)`;
        await refused(() => admin(raw, [ORG_PDA, WH_PDA, careSupplier, uniq('P221-BOUNDARY'), rig.superAdminId]));
        await refused(() => asService(raw, [ORG_PDA, WH_PDA, careSupplier, uniq('P221-BOUNDARY'), rig.superAdminId]));
        // The canonical RPCs refuse a PDA (central) warehouse with their pre-existing M184 token before any write; a PDA
        // supplier to order from cannot exist either (test 1).
        await refused(() => createOrder(rig.superAdminId, careSupplier, WH_PDA), { code: '23514', message: 'destination_must_be_active_institution_warehouse' });
        await refused(() => directEntry(rig.superAdminId, WH_PDA), { code: '23514', message: 'destination_must_be_active_institution_warehouse' });
        expect((await admin(`SELECT count(*)::int AS n FROM procurement_orders WHERE organization_id = $1`, [ORG_PDA]))[0].n).toBe(0);
      });

      it('a raw order line, order event, receipt, receipt line or return pointing at a non-existent parent: PDA-labelled it is refused by M221 before the foreign key (23514); care-labelled it fails on the foreign key (23503); zero rows either way', async () => {
        // Every id is fixed BEFORE the first attempt, so the retry inside refused() is the identical statement.
        const missingOrder = randomUUID();
        const missingReceipt = randomUUID();
        for (const org of [ORG_PDA, ORG_CARE]) {
          const pda = org === ORG_PDA;
          await refused(() => admin(RECEIPT, receiptParams(missingOrder, org, careSupplier)), pda ? undefined : {
            code: '23503', message: 'insert or update on table "procurement_receipts" violates foreign key constraint "procurement_receipts_order_id_fkey"' });
          await refused(() => admin(RECEIPT_LINE, receiptLineParams(missingReceipt, careOrderLine, org)), pda ? undefined : {
            code: '23503', message: 'insert or update on table "procurement_receipt_lines" violates foreign key constraint "procurement_receipt_lines_receipt_id_fkey"' });
          await refused(() => admin(RETURN, returnParams(missingOrder, careReceiptLine, org)), pda ? undefined : {
            code: '23503', message: 'insert or update on table "procurement_returns" violates foreign key constraint "procurement_returns_order_id_fkey"' });
          await refused(() => asService(ORDER_LINE, orderLineParams(missingOrder, org)), pda ? undefined : {
            code: '23503', message: 'insert or update on table "procurement_order_lines" violates foreign key constraint "procurement_order_lines_order_id_fkey"' });
          await refused(() => asService(ORDER_EVENT, orderEventParams(missingOrder, org)), pda ? undefined : {
            code: '23503', message: 'insert or update on table "procurement_order_events" violates foreign key constraint "procurement_order_events_order_id_fkey"' });
        }
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });

      it('receive_order and return_to_supplier cannot run for a PDA: there is no PDA order or receipt line to act on (P0002, nothing written)', async () => {
        const receive = await refused(() => rpc(rig.superAdminId, 'phoenix_procurement_receive_order', [randomUUID(), randomUUID(), JSON.stringify([
          { order_line_id: randomUUID(), quantity: 1, batch_number: 'PDA-B', has_no_batch_number: false, expiry_date: '2027-06-01' },
        ]), null, null]), { code: 'P0002', message: 'order_not_found' });
        const ret = await refused(() => rpc(rig.superAdminId, 'phoenix_procurement_return_to_supplier',
          [randomUUID(), randomUUID(), 1, 'probe', null, null, 'damaged']), { code: 'P0002', message: 'receipt_line_not_found' });
        console.log('[M221 evidence] PDA_RECEIPT_RETURN_BOUNDARY receive_order / return_to_supplier without a PDA parent:', JSON.stringify({ receive, ret }));
      });

      it('every committed order line, order event, receipt, receipt line and return carries its parent order\'s (care) organization; none hangs off a PDA order', async () => {
        const [row] = await admin(`
          SELECT (SELECT count(*) FROM procurement_receipts)::int AS receipts,
                 (SELECT count(*) FROM procurement_returns)::int AS returns,
                 (SELECT count(*) FROM procurement_order_lines)::int AS order_lines,
                 (SELECT count(*) FROM procurement_order_events)::int AS order_events,
                 (SELECT count(*) FROM procurement_order_lines l JOIN procurement_orders o ON o.id = l.order_id
                   WHERE l.organization_id IS DISTINCT FROM o.organization_id)::int AS order_line_label_mismatch,
                 (SELECT count(*) FROM procurement_order_events e JOIN procurement_orders o ON o.id = e.order_id
                   WHERE e.organization_id IS DISTINCT FROM o.organization_id)::int AS order_event_label_mismatch,
                 (SELECT count(*) FROM procurement_order_lines l JOIN procurement_orders o ON o.id = l.order_id
                   JOIN organizations g ON g.id = o.organization_id WHERE g.organization_kind <> 'care_institution')::int AS order_lines_under_non_care,
                 (SELECT count(*) FROM procurement_order_events e JOIN procurement_orders o ON o.id = e.order_id
                   JOIN organizations g ON g.id = o.organization_id WHERE g.organization_kind <> 'care_institution')::int AS order_events_under_non_care,
                 (SELECT count(*) FROM procurement_receipts r JOIN procurement_orders o ON o.id = r.order_id
                   WHERE r.organization_id IS DISTINCT FROM o.organization_id)::int AS receipt_label_mismatch,
                 (SELECT count(*) FROM procurement_receipt_lines l JOIN procurement_receipts r ON r.id = l.receipt_id
                   WHERE l.organization_id IS DISTINCT FROM r.organization_id)::int AS receipt_line_label_mismatch,
                 (SELECT count(*) FROM procurement_returns t JOIN procurement_orders o ON o.id = t.order_id
                   WHERE t.organization_id IS DISTINCT FROM o.organization_id)::int AS return_label_mismatch,
                 (SELECT count(*) FROM procurement_receipts r JOIN procurement_orders o ON o.id = r.order_id
                   JOIN organizations g ON g.id = o.organization_id WHERE g.organization_kind <> 'care_institution')::int AS receipts_under_non_care,
                 (SELECT count(*) FROM procurement_returns t JOIN procurement_orders o ON o.id = t.order_id
                   JOIN organizations g ON g.id = o.organization_id WHERE g.organization_kind <> 'care_institution')::int AS returns_under_non_care`);
        expect(row.receipts).toBeGreaterThanOrEqual(2);   // 9a receive_order + 9b direct entry
        expect(row.returns).toBeGreaterThanOrEqual(1);    // 9c return_to_supplier
        expect(row.order_lines).toBeGreaterThanOrEqual(3); // the 220-chain draft line, test 8, test 6 (add_order_line) - and 9b
        expect(row.order_events).toBeGreaterThanOrEqual(6); // create/submit/decide/receipt/return of the care order + test 6
        expect(row).toMatchObject({ receipt_label_mismatch: 0, receipt_line_label_mismatch: 0, return_label_mismatch: 0,
          receipts_under_non_care: 0, returns_under_non_care: 0, order_line_label_mismatch: 0, order_event_label_mismatch: 0,
          order_lines_under_non_care: 0, order_events_under_non_care: 0 });
      });

      it('RESIDUAL (deferred cross-care child label mismatch; evidence only, rolled back): a care institution B label on an order line, order event, receipt, receipt line or return under care institution A\'s order - and an order line re-labelled A -> B - is still ACCEPTED (owner and service_role); the PDA label on the very same rows is refused', async () => {
        const crossCare = async (c: any) => {
          const orderLine = (await c.query(ORDER_LINE, orderLineParams(careOrder, ORG_CARE2))).rows[0];
          const orderEvent = (await c.query(ORDER_EVENT, orderEventParams(careOrder, ORG_CARE2))).rows[0];
          const receipt = (await c.query(RECEIPT, receiptParams(careOrder, ORG_CARE2, careSupplier))).rows[0];
          const receiptLine = (await c.query(RECEIPT_LINE, receiptLineParams(careReceipt, careOrderLine, ORG_CARE2))).rows[0];
          const ret = (await c.query(RETURN, returnParams(careOrder, careReceiptLine, ORG_CARE2))).rows[0];
          const relabel = (await c.query(`UPDATE public.procurement_order_lines SET organization_id = $2 WHERE id = $1 RETURNING organization_id`,
            [careOrderLine, ORG_CARE2])).rows[0];
          const parent = (await c.query(`SELECT o.organization_id, g.organization_kind FROM procurement_orders o JOIN organizations g ON g.id = o.organization_id
            WHERE o.id = $1`, [careOrder])).rows[0];
          // In the same transaction, the PDA label on the very same rows is refused (the PDA exclusion is what M221 enforces).
          const pda = [
            await attempt(c, ORDER_LINE, orderLineParams(careOrder, ORG_PDA)),
            await attempt(c, ORDER_EVENT, orderEventParams(careOrder, ORG_PDA)),
            await attempt(c, RECEIPT, receiptParams(careOrder, ORG_PDA, careSupplier)),
            await attempt(c, RECEIPT_LINE, receiptLineParams(careReceipt, careOrderLine, ORG_PDA)),
            await attempt(c, RETURN, returnParams(careOrder, careReceiptLine, ORG_PDA)),
            await attempt(c, `UPDATE public.procurement_order_lines SET organization_id = $2 WHERE id = $1`, [orderLine.id, ORG_PDA]),
          ].map((r) => r && `${r.code} ${r.message}`);
          return { orderLine: orderLine.organization_id, orderEvent: orderEvent.organization_id, receipt: receipt.organization_id,
            receiptLine: receiptLine.organization_id, ret: ret.organization_id, relabel: relabel.organization_id, parent, pda };
        };
        const before = await counts();
        const owner = await rolledBack(crossCare);
        const service = await serviceRolledBack(crossCare);
        console.log('[M221 evidence] RESIDUAL cross-care child label mismatch accepted (deferred; rolled back):', JSON.stringify({ owner, service }));
        const expected = { orderLine: ORG_CARE2, orderEvent: ORG_CARE2, receipt: ORG_CARE2, receiptLine: ORG_CARE2, ret: ORG_CARE2, relabel: ORG_CARE2,
          parent: { organization_id: ORG_CARE, organization_kind: 'care_institution' }, pda: Array(6).fill(`23514 ${TOKEN}`) };
        expect(owner).toEqual(expected);
        expect(service).toEqual(expected);
        expect(await counts()).toEqual(before);
        expect((await rowJson('procurement_order_lines', careOrderLine)).organization_id).toBe(ORG_CARE);
        expect((await admin(`SELECT count(*)::int AS n FROM procurement_order_lines WHERE organization_id = $1`, [ORG_PDA]))[0].n).toBe(0);
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });
    });

    // -----------------------------------------------------------------------
    // 10. unrelated stock is unaffected — and never calls the guard
    // -----------------------------------------------------------------------
    describe('10. unrelated stock is unaffected', () => {
      it('aid, kimadia, purchase/central and unspecified lots enter the PDA central warehouse (raw and through central intake); supplementary lots take quantity updates', async () => {
        for (const [supply, origin] of [['aid', null], ['kimadia', null], ['purchase', 'central'], [null, null]] as const) {
          const id = await insertLot(ORG_PDA, WH_PDA, supply, origin);
          expect(await lotRow(id)).toMatchObject({ organization_id: ORG_PDA, supply_type: supply, purchase_origin: origin });
        }
        for (const [supply, origin, expected] of [['aid', null, null], ['kimadia', null, null], ['purchase', null, 'central']] as const) {
          const r = await centralIntake(supply, origin);
          expect(r).toMatchObject({ ok: true });
          expect(await lotRow(r.warehouse_stock_id)).toMatchObject({ organization_id: ORG_PDA, supply_type: supply, purchase_origin: expected });
        }
        // Central intake keeps refusing supplementary origin with ITS OWN pre-existing token (it answers before any write).
        await refused(() => centralIntake('purchase', 'supplementary'), { code: '23514', message: 'central_intake_supplementary_origin_forbidden' });
        for (const lot of [careSuppLot, careNullSuppLot, pdaCentralLot, pdaNullLot]) {
          const before = (await lotRow(lot)).on_hand_quantity;
          await admin(`UPDATE public.warehouse_stock SET on_hand_quantity = on_hand_quantity + 5, notes = 'M221 qty' WHERE id = $1`, [lot]);
          expect((await lotRow(lot)).on_hand_quantity).toBe(before + 5);
          await admin(`UPDATE public.warehouse_stock SET on_hand_quantity = on_hand_quantity - 5 WHERE id = $1`, [lot]);
        }
      });

      it('narrowness: with track_functions = all, aid/kimadia/purchase-central/NULL-NULL stock writes, quantity updates, order-line quantity/progress/descriptive updates, order status changes, unchanged organization_id writes and every custody (quarantine) write make ZERO guard calls; a care supplementary insert - (NULL, supplementary) included - a care child insert, a care order line and order event insert and a care -> care2 order-line re-label make one each (rolled back)', async () => {
        const calls = await rolledBack(async (c) => {
          await c.query(`SET LOCAL track_functions = 'all'`);
          // Counted from a baseline: this backend may still hold unflushed calls of an earlier transaction (the
          // statistics flush is rate-limited and only happens between transactions, never inside this one).
          const counted = async () => Number((await c.query(
            `SELECT coalesce(sum(calls), 0)::int AS n FROM pg_stat_xact_user_functions WHERE funcid = '${GUARD_SIG}'::regprocedure`)).rows[0].n);
          const baseline = await counted();
          const guardCalls = async () => (await counted()) - baseline;
          for (const [org, wh, supply, origin] of [[ORG_PDA, WH_PDA, 'aid', null], [ORG_PDA, WH_PDA, 'kimadia', null],
            [ORG_PDA, WH_PDA, 'purchase', 'central'], [ORG_PDA, WH_PDA, null, null], [ORG_CARE, WH_CARE, null, null],
            [ORG_CARE, WH_CARE, 'aid', null], [ORG_CARE, WH_CARE, 'purchase', 'central']] as const) {
            await c.query(LOT, lotParams(org, wh, supply, origin));
          }
          for (const lot of [careSuppLot, careNullSuppLot, pdaCentralLot, pdaNullLot, pdaAidLot]) {
            await c.query(`UPDATE public.warehouse_stock SET on_hand_quantity = on_hand_quantity + 1, notes = 'M221' WHERE id = $1`, [lot]);
          }
          await c.query(`UPDATE public.warehouse_stock SET supply_type = 'aid' WHERE id = $1`, [pdaAidLot]);              // unlisted column
          await c.query(`UPDATE public.warehouse_stock SET purchase_origin = 'central' WHERE id = $1`, [pdaCentralLot]);   // listed, WHEN false
          await c.query(`UPDATE public.warehouse_stock SET purchase_origin = NULL WHERE id = $1`, [pdaNullLot]);          // listed, WHEN false
          await c.query(`UPDATE public.warehouse_stock SET organization_id = organization_id WHERE id = $1`, [careSuppLot]); // listed, unchanged
          await c.query(`UPDATE public.warehouse_stock SET organization_id = organization_id, purchase_origin = purchase_origin WHERE id = $1`, [careNullSuppLot]);
          await c.query(`UPDATE public.procurement_suppliers SET notes = 'M221' WHERE id = $1`, [careSupplier]);
          await c.query(`UPDATE public.procurement_suppliers SET organization_id = organization_id WHERE id = $1`, [careSupplier]);
          await c.query(`UPDATE public.procurement_orders SET notes = 'M221' WHERE id = $1`, [careOrder]);
          // Order lines (no immutability trigger): quantity, receipt progress, price and descriptive updates, and the listed
          // column written unchanged (WHEN false) - none reaches the guard; nor does an order status change.
          await c.query(`UPDATE public.procurement_order_lines SET ordered_quantity = ordered_quantity + 1, notes = 'M221', updated_at = now()
            WHERE id = $1`, [careOrderLine]);
          await c.query(`UPDATE public.procurement_order_lines SET received_quantity = received_quantity + 1 WHERE id = $1`, [careOrderLine]);
          await c.query(`UPDATE public.procurement_order_lines SET unit_price = 7, currency = 'IQD', trade_name = 'M221' WHERE id = $1`, [careOrderLine]);
          await c.query(`UPDATE public.procurement_order_lines SET organization_id = organization_id WHERE id = $1`, [careOrderLine]);
          await c.query(`UPDATE public.procurement_order_lines SET organization_id = organization_id, ordered_quantity = ordered_quantity + 1
            WHERE order_id = $1`, [draftOrderCare]);
          await c.query(`UPDATE public.procurement_orders SET status = 'submitted' WHERE id = $1 AND status = 'draft'`, [draftOrderCare]);
          await c.query(`UPDATE public.procurement_orders SET organization_id = organization_id WHERE id = $1`, [careOrder]);
          const orderLineUpdates = (await c.query(`SELECT count(*)::int AS n FROM procurement_order_lines WHERE id = $1 AND notes = 'M221'
            AND trade_name = 'M221'`, [careOrderLine])).rows[0].n;
          const unrelated = await guardCalls();
          // Custody is not guarded: supplementary quarantine rows - care AND PDA, purchase AND supply_type NULL - never reach the guard.
          const careQ = (await c.query(QLOT, qlotParams(ORG_CARE, WH_CARE, 'purchase', 'supplementary'))).rows[0].id;
          await c.query(QLOT, qlotParams(ORG_PDA, WH_PDA, 'purchase', 'supplementary'));
          await c.query(QLOT, qlotParams(ORG_PDA, WH_PDA, null, 'supplementary'));
          await c.query(`UPDATE public.warehouse_quarantine_stock SET quantity = quantity + 1 WHERE id = $1`, [careQ]);
          const custody = await guardCalls();
          await c.query(LOT, lotParams(ORG_CARE, WH_CARE, 'purchase', 'supplementary'));       // positive control
          const purchaseSupplementary = (await guardCalls()) - custody;
          await c.query(LOT, lotParams(ORG_CARE, WH_CARE, null, 'supplementary'));             // positive control, supply_type NULL
          const nullSupplementary = (await guardCalls()) - custody - purchaseSupplementary;
          await c.query(RECEIPT, receiptParams(careOrder, ORG_CARE, careSupplier));            // positive control, a child table
          const childInsert = (await guardCalls()) - custody - purchaseSupplementary - nullSupplementary;
          let seen = await guardCalls();
          const since = async () => { const n = await guardCalls(); const d = n - seen; seen = n; return d; };
          await c.query(ORDER_LINE, orderLineParams(careOrder, ORG_CARE));                     // positive control, an order line
          const orderLineInsert = await since();
          await c.query(ORDER_EVENT, orderEventParams(careOrder, ORG_CARE));                   // positive control, an order event
          const orderEventInsert = await since();
          await c.query(`UPDATE public.procurement_order_lines SET organization_id = $2 WHERE id = $1`, [careOrderLine, ORG_CARE2]); // re-label, WHEN true
          const orderLineRelabel = await since();
          return { baseline, unrelated, custody, purchaseSupplementary, nullSupplementary, childInsert, orderLineInsert, orderEventInsert,
            orderLineRelabel, orderLineUpdates };
        });
        console.log('[M221 evidence] guard calls (track_functions=all):', JSON.stringify(calls));
        expect(calls.orderLineUpdates).toBe(1);   // the unrelated order-line updates really happened
        expect(calls.unrelated).toBe(0);
        expect(calls.custody).toBe(0);
        expect(calls.purchaseSupplementary).toBeGreaterThanOrEqual(1);
        expect(calls.nullSupplementary).toBeGreaterThanOrEqual(1);
        expect(calls.childInsert).toBeGreaterThanOrEqual(1);
        expect(calls.orderLineInsert).toBe(1);
        expect(calls.orderEventInsert).toBe(1);
        expect(calls.orderLineRelabel).toBe(1);
      });
    });

    // -----------------------------------------------------------------------
    // extra
    // -----------------------------------------------------------------------
    describe('extra', () => {
      it('negative control: with the binding disabled (rolled back) a PDA supplier INSERT succeeds — the refusal IS the trigger', async () => {
        const inserted = await rolledBack(async (c) => {
          await c.query('ALTER TABLE public.procurement_suppliers DISABLE TRIGGER phoenix_pda_supplier_insert_guard');
          return (await c.query(`INSERT INTO public.procurement_suppliers (organization_id, name) VALUES ($1, 'Unguarded PDA supplier') RETURNING organization_id`, [ORG_PDA])).rows[0];
        });
        expect(inserted).toEqual({ organization_id: ORG_PDA });
        expect((await admin(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'phoenix_pda_supplier_insert_guard'`))[0].tgenabled).toBe('O');
        expect((await admin(`SELECT count(*)::int AS n FROM procurement_suppliers WHERE organization_id = $1`, [ORG_PDA]))[0].n).toBe(0);
      });

      it('negative control per child table: with ONLY its insert binding disabled (rolled back) the forged PDA-labelled child under a care parent inserts — each child refusal IS its trigger', async () => {
        const forged: Array<[string, string, string, unknown[]]> = [
          ['procurement_order_lines', 'phoenix_pda_order_line_insert_guard', ORDER_LINE, orderLineParams(careOrder, ORG_PDA)],
          ['procurement_order_events', 'phoenix_pda_order_event_insert_guard', ORDER_EVENT, orderEventParams(careOrder, ORG_PDA)],
          ['procurement_receipts', 'phoenix_pda_receipt_insert_guard', RECEIPT, receiptParams(careOrder, ORG_PDA, careSupplier)],
          ['procurement_receipt_lines', 'phoenix_pda_receipt_line_insert_guard', RECEIPT_LINE, receiptLineParams(careReceipt, careOrderLine, ORG_PDA)],
          ['procurement_returns', 'phoenix_pda_return_insert_guard', RETURN, returnParams(careOrder, careReceiptLine, ORG_PDA)],
        ];
        expect(forged.map(([table, trigger]) => [table, trigger])).toEqual(CHILD.map((c) => [c.table, c.guard]));
        for (const [table, trigger, sql, params] of forged) {
          const inserted = await rolledBack(async (c) => {
            await c.query(`ALTER TABLE public.${table} DISABLE TRIGGER ${trigger}`);
            const enabled = (await c.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'phoenix\\_pda\\_%' AND tgenabled = 'O'`)).rows[0].n;
            return { enabled, label: (await c.query(sql, params)).rows[0].organization_id };
          });
          expect(inserted, table).toEqual({ enabled: 11, label: ORG_PDA });
          expect((await admin(`SELECT tgenabled FROM pg_trigger WHERE tgname = $1`, [trigger]))[0].tgenabled, trigger).toBe('O');
        }
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });

      it('negative control for the order-line re-label: with ONLY phoenix_pda_order_line_reassign_guard disabled (rolled back) a care order line is re-labelled onto the PDA — the re-label refusal IS that binding (the INSERT binding never fires on UPDATE)', async () => {
        const before = await rowJson('procurement_order_lines', careOrderLine);
        const out = await rolledBack(async (c) => {
          await c.query('ALTER TABLE public.procurement_order_lines DISABLE TRIGGER phoenix_pda_order_line_reassign_guard');
          const enabled = (await c.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'phoenix\\_pda\\_%' AND tgenabled = 'O'`)).rows[0].n;
          const insertGuard = (await c.query(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'phoenix_pda_order_line_insert_guard'`)).rows[0].tgenabled;
          const row = (await c.query(`UPDATE public.procurement_order_lines SET organization_id = $2 WHERE id = $1 RETURNING organization_id`,
            [careOrderLine, ORG_PDA])).rows[0];
          return { enabled, insertGuard, row };
        });
        console.log('[M221 evidence] negative control, order-line re-label binding disabled (rolled back):', JSON.stringify(out));
        expect(out).toEqual({ enabled: 11, insertGuard: 'O', row: { organization_id: ORG_PDA } });
        expect((await admin(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'phoenix_pda_order_line_reassign_guard'`))[0].tgenabled).toBe('O');
        expect(await rowJson('procurement_order_lines', careOrderLine)).toEqual(before);
        expect(await pdaChildren()).toEqual(NO_PDA_CHILDREN);
      });

      it('phoenix_subpurchase_duplicate_candidates (read-only, unchanged) for a PDA central warehouse returns no supplementary lot', async () => {
        const rows = await rig.asUser(rig.superAdminId, (c: any) => c.query(
          `SELECT * FROM public.phoenix_subpurchase_duplicate_candidates($1, 'M221 lot', NULL, NULL, 20)`, [WH_PDA]).then((r: any) => r.rows));
        console.log('[M221 evidence] duplicate candidates for the PDA central warehouse:', JSON.stringify(rows));
        expect(rows.filter((r: any) => r.source !== 'catalog')).toEqual([]);
        // The same advisory read for the care warehouse does surface that institution's own supplementary lots.
        const care = await rig.asUser(U_OFFICER, (c: any) => c.query(
          `SELECT * FROM public.phoenix_subpurchase_duplicate_candidates($1, 'Metformin', NULL, NULL, 20)`, [WH_CARE]).then((r: any) => r.rows));
        expect(care.some((r: any) => r.source === 'existing_lot')).toBe(true);
      });

      // ---------------------------------------------------------------------
      // QUARANTINE_RETURN_REGRESSION (and the care-institution custody flow)
      // ---------------------------------------------------------------------
      describe('QUARANTINE_RETURN_REGRESSION: M221 adds no rejection to the quarantine custody path of a legitimate return', () => {
        const sa = () => rig.superAdminId;
        let forwardLine = '';
        let pdaShipmentLine = '';
        const RECEIVE_RETURN = `SELECT public.phoenix_receive_warehouse_return_shipment_line($1, $2, $3, NULL, NULL, $4) AS r`;

        /** Requests, approves and SENDS a return of `qty` from the care institution warehouse along `route`; returns the shipment line. */
        async function sendReturn(route: string, qty: number): Promise<string> {
          const wr = await rpc(sa(), 'phoenix_request_warehouse_return', [route, WH_CARE, uniq('WR')]);
          const wrId = wr.return_request_id ?? wr.id;
          const line = await rpc(sa(), 'phoenix_add_warehouse_return_request_line', [wrId, forwardLine, qty, 'excess', 'M221 custody return']);
          const lineId = line.return_request_line_id ?? line.id;
          await rpc(sa(), 'phoenix_submit_warehouse_return_request', [wrId]);
          await rpc(sa(), 'phoenix_review_warehouse_return_request', [wrId, JSON.stringify([{ line_id: lineId, approved_quantity: qty }])]);
          const shipped = await rpc(sa(), 'phoenix_send_warehouse_return_shipment_line', [randomUUID(), route, lineId, qty, uniq('WRS'), null, null]);
          return shipped.shipment_line_id as string;
        }
        const lineState = async (id: string) => (await admin(`SELECT l.status, l.custody_state, l.disposition, l.received_quantity,
            l.supply_type, l.purchase_origin, s.destination_organization_id AS dest, s.destination_warehouse_id AS dest_wh
          FROM warehouse_return_shipment_lines l JOIN warehouse_return_shipments s ON s.id = l.shipment_id WHERE l.id = $1`, [id]))[0];
        /** What one receive did, ids reduced to their presence so two runs of the same operation compare equal. */
        async function receiveOutcome(c: any, shipmentLine: string, r: any) {
          const line = (await c.query(`SELECT l.status, l.custody_state, l.disposition, l.received_quantity, s.status AS shipment_status
            FROM warehouse_return_shipment_lines l JOIN warehouse_return_shipments s ON s.id = l.shipment_id WHERE l.id = $1`, [shipmentLine])).rows[0];
          const quarantineRow = r.quarantine_stock_id ? (await c.query(`SELECT organization_id, warehouse_id, supply_type, purchase_origin, quantity
            FROM warehouse_quarantine_stock WHERE id = $1`, [r.quarantine_stock_id])).rows[0] : null;
          const stockRow = r.warehouse_stock_id ? (await c.query(`SELECT organization_id, warehouse_id, supply_type, purchase_origin
            FROM warehouse_stock WHERE id = $1`, [r.warehouse_stock_id])).rows[0] : null;
          const present = (v: unknown) => (v ? 'set' : null);
          return {
            result: { ok: r.ok, idempotent_replay: r.idempotent_replay, line_status: r.line_status, disposition: r.disposition,
              custody_state: r.custody_state, quantity_before: r.quantity_before, quantity_delta: r.quantity_delta,
              quantity_after: r.quantity_after, warehouse_stock_id: present(r.warehouse_stock_id),
              quarantine_stock_id: present(r.quarantine_stock_id), movement_id: present(r.movement_id) },
            line, quarantineRow, stockRow,
          };
        }
        /**
         * REHEARSAL ONLY: one receive of `shipmentLine` as the super_admin in ONE superuser transaction that is ALWAYS
         * rolled back. With dropM221 the guard (and, CASCADE, its twelve triggers) is dropped first INSIDE that transaction:
         * the identical operation on the identical state, with M221 absent.
         */
        const receiveRehearsal = (shipmentLine: string, qty: number, disposition: string, dropM221: boolean) => rig.asAdmin(async (c: any) => {
          await c.query('BEGIN');
          try {
            if (dropM221) await c.query(`DROP FUNCTION ${GUARD_SIG} CASCADE`);
            const m221 = (await c.query(M221_STATE)).rows[0];
            await c.query('SET LOCAL ROLE authenticated');
            await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sa()]);
            let r: any;
            try {
              r = (await c.query(RECEIVE_RETURN, [randomUUID(), shipmentLine, qty, disposition])).rows[0].r;
            } catch (e: any) {
              return { m221, error: { code: String(e.code), message: String(e.message), detail: e.detail } as Refusal };
            }
            await c.query('RESET ROLE');
            return { m221, outcome: await receiveOutcome(c, shipmentLine, r) };
          } finally {
            await c.query('ROLLBACK');
          }
        });

        it('fixture within pre-M221 contracts: a legacy purchase/supplementary lot of a CARE-owned central warehouse reaches the care institution and is returned towards the PDA central warehouse', async () => {
          // A legacy purchase/supplementary lot in a CARE-owned central warehouse is legitimate history: central intake
          // accepted that provenance from M088 until M118 forbade it. It is created here as the owner, the
          // way such a historical row exists; organization and warehouse satisfy the composite FK and M171.
          const legacy = await insertLot(ORG_CARE, WH_CARE_CENTRAL, 'purchase', 'supplementary', 40);
          const sent = await rpc(sa(), 'phoenix_send_warehouse_transfer_line', [randomUUID(), ROUTE_CARE, legacy, 20, uniq('WT'), null, null, null]);
          forwardLine = sent.transfer_line_id;
          const recv = await rpc(sa(), 'phoenix_receive_warehouse_transfer_line', [randomUUID(), forwardLine, 20, null, null]);
          expect(await lotRow(recv.warehouse_stock_id)).toMatchObject({ organization_id: ORG_CARE, supply_type: 'purchase', purchase_origin: 'supplementary' });
          // ... returned through the PDA route: nothing ties the return route to the forward one.
          pdaShipmentLine = await sendReturn(ROUTE_PDA, 5);
          expect(await lineState(pdaShipmentLine)).toEqual({ status: 'in_transit', custody_state: 'in_transit', disposition: null, received_quantity: null,
            supply_type: 'purchase', purchase_origin: 'supplementary', dest: ORG_PDA, dest_wh: WH_PDA });
        });

        it('after M221 the RESTOCKABLE receive is refused by the warehouse_stock guard (token, nothing written, retry identical); the line stays in transit; with M221 absent it would write a PDA purchase/supplementary lot', async () => {
          const restockable = await refused(() => rpc(sa(), 'phoenix_receive_warehouse_return_shipment_line', [randomUUID(), pdaShipmentLine, 5, null, null, 'restockable']));
          console.log('[M221 evidence] QUARANTINE_RETURN_REGRESSION restockable receive after M221:', JSON.stringify(restockable));
          expect(await lineState(pdaShipmentLine)).toMatchObject({ status: 'in_transit', custody_state: 'in_transit', disposition: null });
          expect(await pdaSupplementaryStock()).toBe(0);
          // The identical operation with M221 absent (rolled back): it succeeds and the PDA would hold purchase/supplementary
          // STOCK - exactly what the warehouse_stock guard exists to refuse; the refusal is M221's only effect on this line.
          const absent = await receiveRehearsal(pdaShipmentLine, 5, 'restockable', true);
          console.log('[M221 evidence] QUARANTINE_RETURN_REGRESSION restockable receive with M221 absent (rolled back):', JSON.stringify(absent));
          expect(absent).toMatchObject({ m221: ABSENT, outcome: { result: { ok: true, disposition: 'restockable', custody_state: 'destination_stock' },
            stockRow: { organization_id: ORG_PDA, warehouse_id: WH_PDA, supply_type: 'purchase', purchase_origin: 'supplementary' } } });
          const present = await receiveRehearsal(pdaShipmentLine, 5, 'restockable', false);
          expect(present).toEqual({ m221: PRESENT, error: { code: '23514', message: TOKEN, detail: STATIC_DETAIL } });
          expect(await m221Present()).toEqual(PRESENT);
        });

        it('the QUARANTINED receive SUCCEEDS after M221 - identical to the same operation on the same state with M221 absent - and the quarantine row keeps the purchase/supplementary provenance', async () => {
          const absent = await receiveRehearsal(pdaShipmentLine, 5, 'quarantined', true);
          const present = await receiveRehearsal(pdaShipmentLine, 5, 'quarantined', false);
          console.log('[M221 evidence] QUARANTINE_RETURN_REGRESSION quarantined receive, M221 absent vs present (both rolled back):', JSON.stringify({ absent, present }));
          expect(absent.m221).toEqual(ABSENT);
          expect(present.m221).toEqual(PRESENT);
          expect('error' in absent || 'error' in present).toBe(false);
          expect(present.outcome).toEqual(absent.outcome);
          // Now for real (committed), M221 present.
          const before = await counts();
          const r = await rpc(sa(), 'phoenix_receive_warehouse_return_shipment_line', [randomUUID(), pdaShipmentLine, 5, null, null, 'quarantined']);
          const committed = await rig.asAdmin((c: any) => receiveOutcome(c, pdaShipmentLine, r));
          console.log('[M221 evidence] QUARANTINE_RETURN_REGRESSION quarantined receive after M221 (committed):', JSON.stringify({ r, committed }));
          expect(committed).toEqual(absent.outcome);
          expect(committed).toEqual({
            result: { ok: true, idempotent_replay: false, line_status: 'received', disposition: 'quarantined', custody_state: 'destination_quarantine',
              quantity_before: 0, quantity_delta: 5, quantity_after: 5, warehouse_stock_id: null, quarantine_stock_id: 'set', movement_id: 'set' },
            line: { status: 'received', custody_state: 'destination_quarantine', disposition: 'quarantined', received_quantity: 5, shipment_status: 'received' },
            quarantineRow: { organization_id: ORG_PDA, warehouse_id: WH_PDA, supply_type: 'purchase', purchase_origin: 'supplementary', quantity: 5 },
            stockRow: null,
          });
          custodyQuarantineLot = r.quarantine_stock_id;
          expect((await lineState(pdaShipmentLine)).status).not.toBe('in_transit');
          const after = await counts();
          expect(after.warehouse_quarantine_stock - before.warehouse_quarantine_stock).toBe(1);
          expect(after.warehouse_quarantine_stock_movements - before.warehouse_quarantine_stock_movements).toBe(1);
          expect(after.warehouse_stock - before.warehouse_stock).toBe(0);
          expect(await pdaSupplementaryQuarantine()).toBe(1);
          expect(await pdaSupplementaryStock()).toBe(0);
        });

        it('M221 re-applies cleanly over that custody row: the census never counts quarantine (rehearsal, rolled back)', async () => {
          expect(await pdaSupplementaryQuarantine()).toBe(1);
          const notices: string[] = [];
          expect(await rehearse([`DROP FUNCTION ${GUARD_SIG} CASCADE`], 'READ COMMITTED', notices)).toBeNull();
          expect(notices.filter((n) => n.startsWith('221'))).toEqual([]);
          expect(await m221Present()).toEqual(PRESENT);
        });

        it('(c) a care-institution return lands purchase/supplementary in care QUARANTINE and in care STOCK exactly as before', async () => {
          const quarantinedLine = await sendReturn(ROUTE_CARE, 4);
          expect(await lineState(quarantinedLine)).toMatchObject({ status: 'in_transit', dest: ORG_CARE, dest_wh: WH_CARE_CENTRAL,
            supply_type: 'purchase', purchase_origin: 'supplementary' });
          const q = await rpc(sa(), 'phoenix_receive_warehouse_return_shipment_line', [randomUUID(), quarantinedLine, 4, null, null, 'quarantined']);
          const qOut = await rig.asAdmin((c: any) => receiveOutcome(c, quarantinedLine, q));
          expect(qOut).toMatchObject({ result: { ok: true, disposition: 'quarantined', custody_state: 'destination_quarantine' },
            quarantineRow: { organization_id: ORG_CARE, warehouse_id: WH_CARE_CENTRAL, supply_type: 'purchase', purchase_origin: 'supplementary', quantity: 4 } });
          const restockLine = await sendReturn(ROUTE_CARE, 3);
          const s = await rpc(sa(), 'phoenix_receive_warehouse_return_shipment_line', [randomUUID(), restockLine, 3, null, null, 'restockable']);
          const sOut = await rig.asAdmin((c: any) => receiveOutcome(c, restockLine, s));
          console.log('[M221 evidence] (c) care-institution return, quarantined and restockable:', JSON.stringify({ qOut, sOut }));
          expect(sOut).toMatchObject({ result: { ok: true, disposition: 'restockable', custody_state: 'destination_stock' },
            stockRow: { organization_id: ORG_CARE, warehouse_id: WH_CARE_CENTRAL, supply_type: 'purchase', purchase_origin: 'supplementary' } });
        });
      });

      it('the PDA holds no procurement footprint after every refusal above; its only supplementary row is the quarantine CUSTODY row of the return', async () => {
        const [row] = await admin(`
          SELECT (SELECT count(*) FROM procurement_suppliers WHERE organization_id = $1)::int AS suppliers,
                 (SELECT count(*) FROM procurement_orders WHERE organization_id = $1)::int AS orders,
                 (SELECT count(*) FROM procurement_order_lines WHERE organization_id = $1)::int AS order_lines,
                 (SELECT count(*) FROM procurement_order_events WHERE organization_id = $1)::int AS order_events,
                 (SELECT count(*) FROM procurement_receipts WHERE organization_id = $1)::int AS receipts,
                 (SELECT count(*) FROM procurement_receipt_lines WHERE organization_id = $1)::int AS receipt_lines,
                 (SELECT count(*) FROM procurement_returns WHERE organization_id = $1)::int AS returns,
                 (SELECT count(*) FROM warehouse_stock WHERE organization_id = $1 AND purchase_origin = 'supplementary')::int AS supplementary_lots,
                 (SELECT array_agg(id) FROM warehouse_quarantine_stock WHERE organization_id = $1 AND purchase_origin = 'supplementary') AS custody`,
        [ORG_PDA]);
        expect(row).toEqual({ suppliers: 0, orders: 0, order_lines: 0, order_events: 0, receipts: 0, receipt_lines: 0, returns: 0, supplementary_lots: 0,
          custody: [custodyQuarantineLot] });
      });
    });
  });
});
