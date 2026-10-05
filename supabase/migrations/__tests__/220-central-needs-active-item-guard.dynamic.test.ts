/**
 * PRE3-B / M220 — DYNAMIC proof that a MAPPED central item must EXIST and be
 * ACTIVE at the authoritative server boundary, against a real disposable
 * PostgreSQL.
 *
 * The rig is built through 219 first. On that chain the suite reproduces the
 * finding (an eligible editor maps an inactive and a discontinued item through
 * the disposition RPC and through the legacy wrapper), records the replaced
 * function's catalog shape, and exercises the migration's fail-closed prelude
 * and activation lock. It then rehearses the apply seam by seam on one
 * connection (always rolled back) to prove that VERIFY judges only this
 * migration's own transaction: unrelated writes OTHER connections commit
 * between the prelude and VERIFY (a submit, dispositions, need lines, catalog
 * item changes, audit rows, unrelated DDL and grants) never fail the apply,
 * while any catalog or business row the M220 transaction ITSELF writes beyond
 * the RPC, the gate and the trigger is refused, and rows that carried its id
 * before the prelude are excluded exactly. Then M220 is applied through
 * applyMigrationSql (the same replay buildRig() performs) and the contract
 * runs on the 001..220 chain:
 *
 *   * catalog: same oid, owner, SECURITY DEFINER, search_path, ACL, arguments
 *     and result; the private gate and its trigger; the M218 seal intact;
 *   * A. the disposition boundary: active maps, inactive / discontinued /
 *     nonexistent refused, the legacy wrapper and a direct RPC call cannot
 *     bypass it; replay, not_applicable, re-map and the audit row preserved;
 *   * B. authorization and DRAFT precede the item judgement (wrong role, other
 *     organization, no key, no identity, anon, a submitted revision);
 *   * C. concurrency with two real connections: the mapping holds the item
 *     exactly FOR SHARE (a NOWAIT FOR NO KEY UPDATE probe is refused, FOR
 *     SHARE granted) and blocks a status change (lock_timeout -> 55P03,
 *     pg_blocking_pids), a change committed first refuses the mapping, an
 *     in-flight change makes the mapping wait and then refuse;
 *   * D. the submit -> approve window: deactivated after mapping, after the
 *     need line, or between submit and approve — submit / approve refused with
 *     nothing written; reject still works; forged transitions keep their M217 /
 *     M218 fence errors first; submit and approve hold EVERY referenced item
 *     exactly FOR SHARE (several mapped items, an item reached only through a
 *     need line) and an in-flight status change makes submit and approve wait,
 *     then refuse.
 *
 * Every refusal names the expected SQLSTATE and message and proves no partial
 * write. Gated on PHOENIX_RIG_PG; skipped when no database is configured.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  applyMigrationSql, buildRig, migrationFiles, MIGRATIONS_DIR, rigAvailable, shimSql,
} from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const M220 = '220_phoenix_central_needs_active_item_guard.sql';
const DISPOSITION_SIG = 'public.phoenix_central_needs_set_record_disposition(uuid, text, text, uuid, text)';
const WRAPPER_SIG = 'public.phoenix_central_needs_set_record_mapping(uuid, text, uuid)';
const GATE_SIG = 'phoenix_private.central_needs_active_item_gate_v1()';
const TRIGGER = 'central_needs_plan_revisions_m220_active_item_gate';

const ORG_OWNER = '00000000-0000-0000-0000-000000220001'; // pharmacy department authority, owns every plan
const ORG_BENE_A = '00000000-0000-0000-0000-000000220002';
const ORG_OTHER = '00000000-0000-0000-0000-000000220005'; // unrelated owner organization

const U_EDIT = '00000000-0000-0000-0000-000000220401';    // view/import/edit on the owner
const U_APPROVE = '00000000-0000-0000-0000-000000220402'; // view/approve on the owner
const U_VIEW = '00000000-0000-0000-0000-000000220403';    // view only
const U_NOPERM = '00000000-0000-0000-0000-000000220404';  // eligible role, no key
const U_INST = '00000000-0000-0000-0000-000000220405';    // ineligible role (institution_admin), every key
const U_OTHER = '00000000-0000-0000-0000-000000220406';   // eligible role, every key, OTHER organization

const PARSER_IDENTITY = {
  contractVersion: '1.0.0', sheetjsVersion: '0.20.3',
  sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
  runtime: 'node',
};

const DISPOSE = 'SELECT public.phoenix_central_needs_set_record_disposition($1,$2,$3,$4,$5) AS result';
const MAP_LEGACY = 'SELECT public.phoenix_central_needs_set_record_mapping($1,$2,$3) AS result';
const SET_LINE = 'SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6::jsonb,$7::uuid[],$8,$9,$10,$11) AS result';
const SET_COLUMNS = 'SELECT public.phoenix_central_needs_set_beneficiary_columns($1,$2::jsonb,$3) AS result';
const OPEN_DRAFT = 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,$3) AS result';
const SUBMIT = 'SELECT public.phoenix_central_needs_submit_revision($1) AS result';
const APPROVE = 'SELECT public.phoenix_central_needs_approve_revision($1) AS result';
const REJECT = 'SELECT public.phoenix_central_needs_reject_revision($1,$2) AS result';
const STORE = 'phoenix_private.central_needs_lifecycle_attestations';
const DIRECT_SUBMIT = `UPDATE public.central_needs_plan_revisions SET status = 'submitted' WHERE id = $1`;
const DIRECT_APPROVE = `UPDATE public.central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`;
const NOT_ACTIVE = 'central_item_not_active';
const WINDOW_NOT_ACTIVE = 'central_needs_central_item_not_active';

interface Refusal { code: string; message: string; detail?: string }
type Outcome = { ok: boolean; rows?: any[]; rowCount?: number; error?: Refusal };

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

run('PRE3-B/M220 active central item guard — dynamic (PostgreSQL)', { timeout: 120_000 }, () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let year = 1999;
  let fileSeq = 0;
  let fnBefore: any = null;
  let wrapperBefore: any = null;
  const nextYear = () => {
    year += 1;
    if (year > 2100) throw new Error('plan_year counter exhausted (CHECK 2000-2100)');
    return year;
  };

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      { role, commit: true });
  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  /** An explicitly held transaction, for deterministic interleavings. `setup` runs before SET ROLE. */
  const held = async (userId: string | null, role = 'authenticated', setup: string[] = []) => {
    const client = await rig.pool.connect();
    let open = true;
    await client.query('BEGIN');
    for (const s of setup) await client.query(s);
    if (role !== 'superuser') await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    const [{ pid }] = (await client.query('SELECT pg_backend_pid() AS pid')).rows;
    const finish = async (verb: 'COMMIT' | 'ROLLBACK'): Promise<Outcome> => {
      if (!open) return { ok: true };
      open = false;
      try {
        await client.query(verb);
        return { ok: true };
      } catch (e) {
        const err = e as any;
        return { ok: false, error: { code: String(err.code), message: String(err.message), detail: err.detail } };
      } finally {
        client.release();
      }
    };
    return {
      pid: pid as number,
      q: (sql: string, params: unknown[] = []): Promise<Outcome> => client.query(sql, params).then(
        (r: any) => ({ ok: true, rows: r.rows, rowCount: r.rowCount }),
        (e: any) => ({ ok: false, error: { code: String(e.code), message: String(e.message), detail: e.detail } })),
      commit: () => finish('COMMIT'),
      rollback: () => finish('ROLLBACK'),
    };
  };

  /** Waits until `pid` is waiting on a heavyweight lock held by `by` (pg_stat_activity + pg_blocking_pids). */
  const waitBlocked = async (pid: number, by: number) => {
    for (let i = 0; i < 200; i += 1) {
      const [row] = await admin(
        `SELECT wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1`, [pid]);
      if (row && row.wait_event_type === 'Lock' && (row.blockers as number[]).includes(by)) return row;
      await sleep(50);
    }
    throw new Error(`backend ${pid} never waited on a lock held by ${by}`);
  };

  // ---- the migration text --------------------------------------------------
  const m220Text = () => readFileSync(join(MIGRATIONS_DIR, M220), 'utf8');
  const tryApplyM220 = (c: any, text = m220Text()): Promise<Refusal | null> =>
    applyMigrationSql(c, M220, shimSql(M220, text)).then(() => null, async (e: any) => {
      await c.query('ROLLBACK').catch(() => undefined);
      return { code: String(e.code), message: String(e.message), detail: e.detail };
    });
  /** The M220 text WITHOUT its final COMMIT (asserted to be the last statement). */
  const m220Uncommitted = () => {
    const text = m220Text();
    const commitAt = text.lastIndexOf('COMMIT;');
    expect(text.slice(commitAt + 'COMMIT;'.length).trim()).toBe('');
    return text.slice(0, commitAt);
  };
  /** REHEARSAL ONLY: `setup`, then the M220 text without COMMIT, in ONE superuser transaction that is ALWAYS rolled back. */
  const rehearseM220 = (setup: string[] = [], isolation = 'READ COMMITTED'): Promise<Refusal | null> => rig.asAdmin(async (c: any) => {
    await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    try {
      for (const s of setup) await c.query(s);
      return await c.query(m220Uncommitted()).then(() => null,
        (e: any) => ({ code: String(e.code), message: String(e.message), detail: e.detail } as Refusal));
    } finally {
      await c.query('ROLLBACK');
    }
  });
  const M220_STATE = `SELECT pg_catalog.to_regprocedure('${GATE_SIG}') IS NOT NULL AS gate,
            EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = '${TRIGGER}') AS trigger,
            pg_catalog.strpos(pg_catalog.pg_get_functiondef('${DISPOSITION_SIG}'::pg_catalog.regprocedure), 'central_item_not_active') > 0 AS guard`;
  const m220Present = async () => (await admin(M220_STATE))[0];

  /** The M220 text cut at its two seams: [BEGIN .. the prelude] [the activation lock and the DDL] [VERIFY], then COMMIT. */
  const m220Parts = (text = m220Text()) => {
    const preludeEnd = text.indexOf('$prelude$;') + '$prelude$;'.length;
    const verifyAt = text.indexOf('DO $verify$');
    const verifyEnd = text.indexOf('$verify$;', verifyAt + 'DO $verify$'.length) + '$verify$;'.length;
    expect(preludeEnd).toBeGreaterThan('$prelude$;'.length);
    expect(verifyAt).toBeGreaterThan(preludeEnd);
    expect(verifyEnd).toBeGreaterThan(verifyAt);
    const parts = { prelude: text.slice(0, preludeEnd), ddl: text.slice(preludeEnd, verifyAt), verify: text.slice(verifyAt, verifyEnd) };
    expect(text.slice(verifyEnd).trim()).toBe('COMMIT;');
    expect(parts.prelude).not.toContain('LOCK TABLE');
    expect(parts.ddl).toContain('LOCK TABLE public.central_needs_plan_revisions IN SHARE ROW EXCLUSIVE MODE NOWAIT;');
    return parts;
  };
  type SplitOutcome = { stage: 'prelude' | 'ddl' | 'verify'; error: Refusal } | { stage: 'passed'; inTxn: Record<string, boolean> };
  /**
   * REHEARSAL ONLY: M220 on ONE superuser connection, seam by seam, ALWAYS rolled back —
   * [beforePrelude, inside an already open transaction] -> BEGIN .. prelude -> afterPrelude -> lock + DDL -> afterDdl -> VERIFY.
   * Each hook gets the migration's own connection; hooks that act through OTHER connections commit there.
   * Resolves to the stage that refused, or 'passed' with the in-transaction M220 state.
   */
  const rehearseSplit = (hooks: { beforePrelude?: (c: any) => Promise<void>; afterPrelude?: (c: any) => Promise<void>;
    afterDdl?: (c: any) => Promise<void>; text?: string } = {}): Promise<SplitOutcome> => rig.asAdmin(async (c: any) => {
    const p = m220Parts(hooks.text);
    const step = (sql: string): Promise<Refusal | null> => c.query(sql).then(() => null,
      (e: any) => ({ code: String(e.code), message: String(e.message), detail: e.detail }));
    try {
      if (hooks.beforePrelude) {
        await c.query('BEGIN');
        await hooks.beforePrelude(c);
      }
      let e = await step(p.prelude);
      if (e) return { stage: 'prelude', error: e };
      if (hooks.afterPrelude) await hooks.afterPrelude(c);
      e = await step(p.ddl);
      if (e) return { stage: 'ddl', error: e };
      if (hooks.afterDdl) await hooks.afterDdl(c);
      e = await step(p.verify);
      if (e) return { stage: 'verify', error: e };
      return { stage: 'passed', inTxn: (await c.query(M220_STATE)).rows[0] };
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
    }
  });
  const CENSUS_REFUSAL = 'VERIFY FAILED (220): this transaction wrote beyond the disposition RPC, the gate and its trigger: ';

  /** One NOWAIT row-lock probe on a central item from a separate connection (always rolled back). */
  const probeRow = async (item: string, strength: 'KEY SHARE' | 'SHARE' | 'NO KEY UPDATE'): Promise<Outcome> => {
    const p = await held(null, 'superuser');
    try {
      return await p.q(`SELECT 1 FROM public.central_items WHERE id = $1 FOR ${strength} NOWAIT`, [item]);
    } finally { await p.rollback(); }
  };
  const ROW_LOCKED = { ok: false, error: { code: '55P03', message: 'could not obtain lock on row in relation "central_items"' } };

  /** Catalog shape of one routine (superuser read). */
  const fnShape = async (sig: string) => (await admin(`
    SELECT p.oid::int AS oid, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.provolatile AS volatile,
           p.proconfig AS config, p.proacl::text AS acl, pg_get_function_arguments(p.oid) AS args,
           pg_get_function_result(p.oid) AS result, p.prorettype::regtype::text AS rettype,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_exec,
           EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_exec,
           md5(replace(p.prosrc, E'\\r\\n', E'\\n')) AS body_md5
      FROM pg_proc p WHERE p.oid = $1::regprocedure`, [sig]))[0];

  // ---- fixtures --------------------------------------------------------------
  const mkItem = async (status: 'active' | 'inactive' | 'discontinued' = 'active', label = 'M220 item') => {
    const id = randomUUID();
    await admin(`INSERT INTO central_items (id, name, name_ar, unit, status) VALUES ($1, $2, $2, 'box', $3)`,
      [id, `${label} ${id.slice(0, 8)}`, status]);
    return id;
  };
  const setStatus = (id: string, status: string) => admin(`UPDATE central_items SET status = $2 WHERE id = $1`, [id, status]);
  const statusOf = async (id: string) => (await admin(`SELECT status FROM central_items WHERE id = $1`, [id]))[0]?.status;

  const provenance = (row: number, col: number, fileHash: string) => ({
    fileFingerprintSha256: fileHash, originalFilename: `needs-${fileHash.slice(0, 6)}.xlsx`, parserVersion: '1.0.0',
    sheetIndex: 0, sheetName: 'Sheet0', sheetHidden: 'visible',
    coordinate: { row, col, a1: `${String.fromCharCode(65 + (col % 26))}${row + 1}` },
    extractedAt: '2026-10-05T00:00:00.000Z',
  });

  /** One completed import session (root fixture) with one record per row in column `col`, NO disposition yet. */
  async function addSession(revId: string, rows: number[], col = 1) {
    fileSeq += 1;
    const fileHash = `${fileSeq}`.padStart(64, 'b');
    const [{ id: fileId }] = await admin(
      `INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash, byte_size)
       VALUES ($1,$2,$3,$4,2048) RETURNING id`, [revId, ORG_OWNER, `needs-${fileSeq}.xlsx`, fileHash]);
    const digest = `${fileSeq}`.padStart(64, 'e');
    const [{ id: sessionId }] = await admin(
      `INSERT INTO central_needs_import_sessions
         (plan_revision_id, organization_id, source_file_id, status, preview_digest, authoritative_digest, parser_identity, completed_at)
       VALUES ($1,$2,$3,'completed',$4,$4,$5::jsonb, now()) RETURNING id`,
      [revId, ORG_OWNER, fileId, digest, JSON.stringify(PARSER_IDENTITY)]);
    const records = new Map<number, string>();
    let ordinal = 0;
    for (const row of rows) {
      ordinal += 1;
      const sv = { value: 10, valueType: 'number', isFormula: false, formula: null };
      const [{ id }] = await admin(
        `INSERT INTO central_needs_source_records
           (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values, source_provenance)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id`,
        [sessionId, ORG_OWNER, ordinal, `sheet:0:row:${row}`, `col:${col}`, JSON.stringify(sv), JSON.stringify(provenance(row, col, fileHash))]);
      records.set(row, id);
    }
    return { sessionId: sessionId as string, fileHash, rec: (row: number) => records.get(row)! };
  }

  const openDraft = async (y = nextYear()) => {
    const r = await call(U_EDIT, OPEN_DRAFT, [ORG_OWNER, y, false]);
    const [{ plan_id: planId }] = await admin(`SELECT plan_id FROM central_needs_plan_revisions WHERE id = $1`, [r.plan_revision_id]);
    return { y, rev: r.plan_revision_id as string, planId: planId as string };
  };
  const dispose = (user: string | null, session: string, entity: string, decision: string, item: string | null, reason: string | null, role = 'authenticated') =>
    call(user, DISPOSE, [session, entity, decision, item, reason], role);
  const confirm = (revId: string, sessionId: string, col = 1) => call(U_EDIT, SET_COLUMNS, [revId,
    JSON.stringify([{ importSessionId: sessionId, sheetIndex: 0, columnIndex: col, beneficiaryOrganizationId: ORG_BENE_A }]),
    'confirmed beneficiary column']);
  const setLine = (revId: string, item: string, sourceRecordId: string) =>
    call(U_EDIT, SET_LINE, [revId, ORG_BENE_A, item, 10, 'designated by reviewer',
      JSON.stringify([{ sourceRecordId, designatedQuantity: '10', appliedOverrideId: null }]), [], 'box', 'canonical', null, null]);
  const trustBatch = async (revId: string, sessionIds: string[]) => {
    fileSeq += 1;
    const [{ id: batchId }] = await admin(
      `INSERT INTO central_needs_import_batches
         (plan_revision_id, organization_id, container_kind, container_filename, container_sha256,
          storage_locator, accepted_entry_count, parser_identity)
       VALUES ($1,$2,'file','needs.xlsx',$3,'permanent/x',$4,$5::jsonb) RETURNING id`,
      [revId, ORG_OWNER, `${fileSeq}`.padStart(64, 'c'), sessionIds.length, JSON.stringify(PARSER_IDENTITY)]);
    for (const [i, sessionId] of sessionIds.entries()) {
      await admin(
        `INSERT INTO central_needs_import_batch_entries
           (batch_id, plan_revision_id, organization_id, entry_ordinal, entry_sha256, import_session_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [batchId, revId, ORG_OWNER, i + 1, `${fileSeq}${i}`.padStart(64, 'd'), sessionId]);
    }
    return batchId as string;
  };
  /** A draft with one session and one row, mapped through the canonical RPC to `item` (while active), nothing else. */
  const mappedDraft = async (item: string) => {
    const d = await openDraft();
    const s = await addSession(d.rev, [1]);
    expect(await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', item, null)).toMatchObject({ ok: true, idempotent_replay: false });
    return { ...d, ...s };
  };
  /** Completes a mapped draft: confirmed column, need line on `item`, trusted batch — READY. */
  const complete = async (d: Awaited<ReturnType<typeof mappedDraft>>, item: string) => {
    await confirm(d.rev, d.sessionId);
    const line = await setLine(d.rev, item, d.rec(1));
    await trustBatch(d.rev, [d.sessionId]);
    return line.need_line_id as string;
  };
  const blockers = (revId: string) => admin(`SELECT blocker, detail FROM public._phoenix_central_needs_review_blockers_v1($1)`, [revId]);
  const readyDraft = async (item: string) => {
    const d = await mappedDraft(item);
    const lineId = await complete(d, item);
    expect(await blockers(d.rev)).toEqual([]);
    return { ...d, lineId };
  };
  const submitted = async (item: string) => {
    const d = await readyDraft(item);
    expect(await call(U_EDIT, SUBMIT, [d.rev])).toEqual({ ok: true, plan_revision_id: d.rev, status: 'submitted' });
    return d;
  };

  const mapping = async (session: string, entity = 'sheet:0:row:1') => (await admin(
    `SELECT id, decision, central_item_id, decision_reason FROM central_needs_record_mappings
      WHERE import_session_id = $1 AND target_entity = $2`, [session, entity]))[0] ?? null;
  const auditTotal = async () => Number((await admin(`SELECT count(*)::int AS n FROM audit_logs`))[0].n);

  /** Everything a refusal must leave untouched: the revision family, its lines and links, its mappings, all audits and attestations. */
  async function snapshot(revId: string) {
    const [row] = await admin(`
      SELECT
        (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)
           FROM central_needs_plan_revisions r
          WHERE r.plan_id = (SELECT plan_id FROM central_needs_plan_revisions WHERE id = $1)) AS revisions,
        (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.id), '[]'::jsonb)
           FROM central_needs_need_lines n WHERE n.plan_revision_id = $1) AS lines,
        (SELECT coalesce(jsonb_agg(to_jsonb(ls) ORDER BY ls.id), '[]'::jsonb)
           FROM central_needs_need_line_sources ls JOIN central_needs_need_lines n ON n.id = ls.need_line_id
          WHERE n.plan_revision_id = $1) AS links,
        (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb)
           FROM central_needs_record_mappings m
          WHERE m.import_session_id IN (SELECT id FROM central_needs_import_sessions WHERE plan_revision_id = $1)) AS mappings,
        (SELECT count(*) FROM audit_logs)::int AS audit,
        (SELECT count(*) FROM ${STORE})::int AS attestations`, [revId]);
    return row;
  }
  /** Asserts the exact SQLSTATE and message, and an unchanged snapshot (zero audit and attestation delta). */
  async function refused(revId: string, action: () => Promise<unknown>, message: string, sqlstate = '23514') {
    const before = await snapshot(revId);
    const r = await refusal(action());
    expect({ code: r.code, message: r.message }).toEqual({ code: sqlstate, message });
    expect(await snapshot(revId)).toEqual(before);
    return r;
  }
  const revStatus = async (rev: string) => (await admin(`SELECT status FROM central_needs_plan_revisions WHERE id = $1`, [rev]))[0].status;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 219 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
        ($1,'M220 Pharmacy Dept','دائرة صحة','p220-owner','pharmacy_department_authority',NULL),
        ($2,'M220 Hospital A','مستشفى أ','p220-bene-a','care_institution','hospital'),
        ($3,'M220 Other Owner','جهة أخرى','p220-other','pharmacy_department_authority',NULL)`,
      [ORG_OWNER, ORG_BENE_A, ORG_OTHER]);
      await c.query(`INSERT INTO auth.users (id, email) VALUES
        ($1,'p220-edit@rig'),($2,'p220-approve@rig'),($3,'p220-view@rig'),($4,'p220-noperm@rig'),($5,'p220-inst@rig'),($6,'p220-other@rig')`,
      [U_EDIT, U_APPROVE, U_VIEW, U_NOPERM, U_INST, U_OTHER]);
      for (const [u, org, role] of [
        [U_EDIT, ORG_OWNER, 'central_warehouse_manager'], [U_APPROVE, ORG_OWNER, 'central_warehouse_manager'],
        [U_VIEW, ORG_OWNER, 'central_warehouse_manager'], [U_NOPERM, ORG_OWNER, 'central_warehouse_manager'],
        [U_INST, ORG_OWNER, 'institution_admin'], [U_OTHER, ORG_OTHER, 'central_warehouse_manager'],
      ] as const) {
        await c.query(`UPDATE profiles SET role=$1, status='active', organization_id=$2 WHERE id=$3`, [role, org, u]);
      }
      const grants: Array<[string, string[]]> = [
        [U_EDIT, ['view', 'import', 'edit']], [U_APPROVE, ['view', 'approve']], [U_VIEW, ['view']],
        [U_INST, ['view', 'import', 'edit', 'approve']], [U_OTHER, ['view', 'import', 'edit', 'approve']],
      ];
      for (const [u, keys] of grants) {
        for (const k of keys) {
          await c.query(
            `INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
               ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`, [u, `central_needs.${k}`]);
        }
      }
    });
  }, 600000);

  afterAll(async () => { await rig?.end(); });

  // =========================================================================
  // THE 219 CHAIN — the finding, the baseline, the activation preconditions
  // =========================================================================
  describe('on the 001..219 chain (before M220)', () => {
    it('reproduces the finding: an eligible editor maps an INACTIVE and a DISCONTINUED item, directly and through the legacy wrapper', async () => {
      expect(await m220Present()).toEqual({ gate: false, trigger: false, guard: false });
      const inactive = await mkItem('inactive');
      const discontinued = await mkItem('discontinued');
      const d = await openDraft();
      const s = await addSession(d.rev, [1, 2]);
      expect(await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', inactive, null)).toMatchObject({ ok: true, central_item_id: inactive });
      expect(await call(U_EDIT, MAP_LEGACY, [s.sessionId, 'sheet:0:row:2', discontinued])).toMatchObject({ ok: true, central_item_id: discontinued });
      expect(await mapping(s.sessionId, 'sheet:0:row:1')).toMatchObject({ decision: 'mapped', central_item_id: inactive });
      expect(await mapping(s.sessionId, 'sheet:0:row:2')).toMatchObject({ decision: 'mapped', central_item_id: discontinued });
    });

    it('records the replaced function and its wrapper exactly as M211/M218 left them', async () => {
      fnBefore = await fnShape(DISPOSITION_SIG);
      wrapperBefore = await fnShape(WRAPPER_SIG);
      expect(fnBefore).toMatchObject({
        secdef: true, config: ['search_path=public, pg_temp'], rettype: 'jsonb', result: 'jsonb',
        args: 'p_import_session_id uuid, p_target_entity text, p_decision text, p_central_item_id uuid DEFAULT NULL::uuid, p_decision_reason text DEFAULT NULL::text',
        authenticated_exec: true, anon_exec: false, public_exec: false, body_md5: '4ea96f468d115bce414d7b0bf2bcf7cf',
      });
      // M218 11d revoked service_role EXECUTE on every Central Needs SECURITY DEFINER routine but three.
      expect(fnBefore.service_role_exec).toBe(false);
      expect(wrapperBefore).toMatchObject({ secdef: true, body_md5: 'e71ae559b00600951180349afcae6fb3' });
      console.log('[M220 evidence] disposition RPC BEFORE M220:', JSON.stringify(fnBefore));
    });

    it('refuses REPEATABLE READ and SERIALIZABLE with 220_requires_read_committed', async () => {
      for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
        expect(await rehearseM220([], level), level).toMatchObject({ message: '220_requires_read_committed' });
      }
    });

    it('fails closed when the disposition body or the wrapper is not the reviewed M211 definition, or M218 is missing', async () => {
      const def = (await admin(`SELECT pg_get_functiondef('${DISPOSITION_SIG}'::regprocedure) AS d`))[0].d as string;
      const drifted = def.replace("RAISE EXCEPTION 'central_item_not_found' USING ERRCODE = 'P0002';",
        "RAISE EXCEPTION 'central_item_not_found' USING ERRCODE = 'P0002'; -- drift");
      expect(drifted).not.toBe(def);
      expect(await rehearseM220([drifted])).toMatchObject({
        message: '220_precondition_failed: phoenix_central_needs_set_record_disposition is not the reviewed M211 definition' });
      const wdef = (await admin(`SELECT pg_get_functiondef('${WRAPPER_SIG}'::regprocedure) AS d`))[0].d as string;
      expect(await rehearseM220([wdef.replace('-- M210', '-- drifted M210')])).toMatchObject({
        message: '220_precondition_failed: phoenix_central_needs_set_record_mapping is not the reviewed M211 wrapper' });
      expect(await rehearseM220(['DROP TRIGGER central_needs_plan_revisions_c6_submission_gate ON public.central_needs_plan_revisions'])).toMatchObject({
        message: '220_precondition_failed: M218 (the sealed submission) is not applied' });
      expect(await m220Present()).toEqual({ gate: false, trigger: false, guard: false });
    });

    it('fails closed NOWAIT (55P03) while a revision writer holds the table, applying nothing', async () => {
      const h = await held(null, 'superuser');
      try {
        expect((await h.q('LOCK TABLE public.central_needs_plan_revisions IN ROW EXCLUSIVE MODE')).ok).toBe(true);
        const r = await rig.asAdmin((c: any) => tryApplyM220(c));
        expect(r).toMatchObject({ code: '55P03' });
      } finally { await h.rollback(); }
      expect(await m220Present()).toEqual({ gate: false, trigger: false, guard: false });
    });

    it('VERIFY judges only this transaction: unrelated writes other connections commit after the prelude and after the DDL never fail the apply (rehearsal, rolled back)', async () => {
      // Unrelated traffic, set up and committed before the apply.
      const bystander = await mkItem('active', 'Bystander');
      const [i1, i2, i3, i4] = [await mkItem('active'), await mkItem('active'), await mkItem('active'), await mkItem('active')];
      const editing = await openDraft();
      const edit = await addSession(editing.rev, [1, 2]);
      const lining = await openDraft();
      const lines = await addSession(lining.rev, [1, 2]);
      await dispose(U_EDIT, lines.sessionId, 'sheet:0:row:1', 'mapped', i3, null);
      await dispose(U_EDIT, lines.sessionId, 'sheet:0:row:2', 'mapped', i4, null);
      await confirm(lining.rev, lines.sessionId);
      const toSubmit = await readyDraft(await mkItem('active'));
      const heldOff = await readyDraft(await mkItem('active'));
      await admin('CREATE SCHEMA m220_probe');
      await admin('CREATE TABLE m220_probe.unrelated (id integer)');
      // What the Run-3 whole-table fingerprint compared: counts and contents of these tables between the prelude and VERIFY.
      const traffic = async () => (await admin(`
        SELECT (SELECT count(*) FROM audit_logs)::int AS audit, (SELECT count(*) FROM central_items)::int AS items,
               (SELECT count(*) FROM central_needs_record_mappings)::int AS mappings, (SELECT count(*) FROM central_needs_need_lines)::int AS lines,
               (SELECT count(*) FROM ${STORE})::int AS attestations`))[0];
      let atPrelude: any = null;
      let beforeVerify: any = null;
      try {
        const outcome = await rehearseSplit({
          // Between the prelude and the activation lock: a revision transition (row version, SUBMIT attestation,
          // audits), a disposition, a need line, a catalog item status change and a new catalog item.
          afterPrelude: async () => {
            atPrelude = await traffic();
            expect(await call(U_EDIT, SUBMIT, [toSubmit.rev])).toEqual({ ok: true, plan_revision_id: toSubmit.rev, status: 'submitted' });
            expect(await dispose(U_EDIT, edit.sessionId, 'sheet:0:row:1', 'mapped', i1, null)).toMatchObject({ ok: true, idempotent_replay: false });
            expect(await setLine(lining.rev, i3, lines.rec(1))).toMatchObject({ ok: true });
            await setStatus(bystander, 'inactive');
            await mkItem('active', 'Window-1 item');
          },
          // Between the DDL and VERIFY (the activation lock held): another disposition through the still-committed
          // M211 body, another need line, another item change and a new item, unrelated DDL, a comment and a grant —
          // while a revision WRITER is held off by the activation lock (it would queue; with a lock_timeout it fails).
          afterDdl: async () => {
            expect(await dispose(U_EDIT, edit.sessionId, 'sheet:0:row:2', 'mapped', i2, null)).toMatchObject({ ok: true, idempotent_replay: false });
            expect(await setLine(lining.rev, i4, lines.rec(2))).toMatchObject({ ok: true });
            await setStatus(bystander, 'discontinued');
            await mkItem('active', 'Window-2 item');
            await admin(`CREATE FUNCTION public.m220_concurrency_probe_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
            await admin(`COMMENT ON FUNCTION public.m220_concurrency_probe_fn() IS 'unrelated to M220'`);
            await admin('GRANT SELECT ON m220_probe.unrelated TO anon');
            const w = await held(U_EDIT, 'authenticated', [`SET LOCAL lock_timeout = '300ms'`]);
            expect(await w.q(SUBMIT, [heldOff.rev])).toMatchObject({ ok: false, error: { code: '55P03', message: 'canceling statement due to lock timeout' } });
            await w.rollback();
            beforeVerify = await traffic();
          },
        });
        expect(outcome).toEqual({ stage: 'passed', inTxn: { gate: true, trigger: true, guard: true } });
      } finally {
        await admin('DROP FUNCTION IF EXISTS public.m220_concurrency_probe_fn()');
        await admin('DROP SCHEMA IF EXISTS m220_probe CASCADE');
      }
      // The rehearsal rolled back; every unrelated write it raced is committed and intact.
      expect(await m220Present()).toEqual({ gate: false, trigger: false, guard: false });
      expect(await revStatus(toSubmit.rev)).toBe('submitted');
      expect(await revStatus(heldOff.rev)).toBe('draft');
      expect(await mapping(edit.sessionId, 'sheet:0:row:1')).toMatchObject({ decision: 'mapped', central_item_id: i1 });
      expect(await mapping(edit.sessionId, 'sheet:0:row:2')).toMatchObject({ decision: 'mapped', central_item_id: i2 });
      expect((await admin(`SELECT central_item_id FROM central_needs_need_lines WHERE plan_revision_id = $1 ORDER BY central_item_id`, [lining.rev]))
        .map((r: any) => r.central_item_id)).toEqual([i3, i4].sort());
      expect(await statusOf(bystander)).toBe('discontinued');
      console.log('[M220 evidence] committed by OTHER connections between the prelude and VERIFY:', JSON.stringify({ atPrelude, beforeVerify }));
      const delta = Object.fromEntries(Object.keys(atPrelude).map((k) => [k, beforeVerify[k] - atPrelude[k]]));
      expect(delta).toEqual({ audit: 6, items: 2, mappings: 2, lines: 2, attestations: 1 });
    });

    it('VERIFY F is not vacuous: a catalog or business row the M220 transaction ITSELF writes beyond the RPC, the gate and the trigger is refused by name', async () => {
      const item = await mkItem('active');
      const other = await mkItem('active');
      const d = await openDraft();
      const s = await addSession(d.rev, [1, 2]);
      await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', item, null);
      const m = await mapping(s.sessionId);
      const [{ pg_proc: procClass, pg_class: classClass, items: itemsOid, upd: updOid }] = await admin(`
        SELECT 'pg_catalog.pg_proc'::regclass::oid::text AS pg_proc, 'pg_catalog.pg_class'::regclass::oid::text AS pg_class,
               'public.central_items'::regclass::oid::text AS items, 'public.phoenix_set_updated_at()'::regprocedure::oid::text AS upd`);
      const cases: Array<[string, (c: any) => Promise<unknown>, string | RegExp]> = [
        ['a revision row version (the M218 SUBMIT attestation is bound to xmin)',
          (c) => c.query('UPDATE public.central_needs_plan_revisions SET updated_at = updated_at WHERE id = $1', [d.rev]),
          `${CENSUS_REFUSAL}central_needs_plan_revisions ${d.rev}`],
        ['a catalog item row', (c) => c.query('UPDATE public.central_items SET status = status WHERE id = $1', [item]),
          `${CENSUS_REFUSAL}central_items ${item}`],
        ['a mapping row', (c) => c.query('UPDATE public.central_needs_record_mappings SET decision_reason = decision_reason WHERE id = $1', [m.id]),
          `${CENSUS_REFUSAL}central_needs_record_mappings ${m.id}`],
        ['a disposition through the (new) RPC inside the apply: a mapping and its audit row', async (c) => {
          await c.query(`SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
          await c.query(DISPOSE, [s.sessionId, 'sheet:0:row:2', 'mapped', other, null]);
        }, new RegExp(`^${CENSUS_REFUSAL.replace(/[()]/g, '\\$&')}audit_logs [0-9a-f-]{36}; central_needs_record_mappings [0-9a-f-]{36}$`)],
        ['another routine', (c) => c.query(`ALTER FUNCTION public.phoenix_set_updated_at() SET work_mem = '64kB'`),
          `${CENSUS_REFUSAL}pg_proc ${procClass}:${updOid}`],
        ['a comment on another object', (c) => c.query(`COMMENT ON TABLE public.central_items IS 'M220 census probe'`),
          `${CENSUS_REFUSAL}pg_description ${classClass}:${itemsOid}`],
        ['a relation ACL', (c) => c.query('GRANT SELECT ON public.central_items TO anon'),
          `${CENSUS_REFUSAL}pg_class public.central_items`],
      ];
      for (const [label, write, expected] of cases) {
        const r = await rehearseSplit({ afterDdl: async (c) => { await write(c); } });
        expect(r.stage, label).toBe('verify');
        const message = r.stage === 'passed' ? '' : r.error.message;
        if (typeof expected === 'string') expect(message, label).toBe(expected);
        else expect(message, label).toMatch(expected);
      }
      // The same rehearsal with no stray write passes: only the RPC, the gate and the trigger carry the transaction's id.
      expect(await rehearseSplit()).toEqual({ stage: 'passed', inTxn: { gate: true, trigger: true, guard: true } });
      expect(await m220Present()).toEqual({ gate: false, trigger: false, guard: false });
      expect(await mapping(s.sessionId, 'sheet:0:row:2')).toBeNull();
    });

    it('rows that already carried the transaction id before the prelude (the stand-in for rows frozen in an earlier xid epoch) are excluded exactly', async () => {
      const before = await mkItem('active');
      const after = await mkItem('active');
      // Written in the same transaction BEFORE the prelude: recorded as pre-existing, ignored by VERIFY.
      const preWrite = (c: any) => c.query('UPDATE public.central_items SET status = status WHERE id = $1', [before]);
      expect(await rehearseSplit({ beforePrelude: preWrite })).toEqual({ stage: 'passed', inTxn: { gate: true, trigger: true, guard: true } });
      // ... while a write AFTER the prelude, by the same transaction, is still refused — and only that one is named.
      const r = await rehearseSplit({ beforePrelude: preWrite,
        afterDdl: async (c) => { await c.query('UPDATE public.central_items SET status = status WHERE id = $1', [after]); } });
      expect(r).toMatchObject({ stage: 'verify', error: { message: `${CENSUS_REFUSAL}central_items ${after}` } });
      // ... and an update after the prelude of the pre-written row itself is a new row version: refused too.
      const again = await rehearseSplit({ beforePrelude: preWrite,
        afterDdl: async (c) => { await c.query(`UPDATE public.central_items SET status = 'inactive' WHERE id = $1`, [before]); } });
      expect(again).toMatchObject({ stage: 'verify', error: { message: `${CENSUS_REFUSAL}central_items ${before}` } });
      expect(await statusOf(before)).toBe('active');
    });
  });

  // =========================================================================
  // THE 220 CHAIN
  // =========================================================================
  describe('on the 001..220 chain', () => {
    beforeAll(async () => {
      const rest = migrationFiles().filter((f: string) => Number(f.slice(0, 3)) > 219 && Number(f.slice(0, 3)) <= 220);
      expect(rest).toEqual([M220]);
      await rig.asAdmin(async (c: any) => {
        for (const f of rest) await applyMigrationSql(c, f, shimSql(f, readFileSync(join(MIGRATIONS_DIR, f), 'utf8')));
      });
      expect(await m220Present()).toEqual({ gate: true, trigger: true, guard: true });
    }, 600000);

    it('idempotence: a second application fails 220_already_applied before any lock', async () => {
      const h = await held(null, 'superuser');
      try {
        await h.q('LOCK TABLE public.central_needs_plan_revisions IN ROW EXCLUSIVE MODE');
        expect(await rig.asAdmin((c: any) => tryApplyM220(c))).toMatchObject({ message: '220_already_applied' });
      } finally { await h.rollback(); }
    });

    it('catalog: the disposition RPC keeps oid, owner, SECURITY DEFINER, search_path, ACL, arguments and result; the wrapper is untouched', async () => {
      const after = await fnShape(DISPOSITION_SIG);
      console.log('[M220 evidence] disposition RPC AFTER M220:', JSON.stringify(after));
      const { body_md5: _b, ...shapeBefore } = fnBefore;
      const { body_md5: bodyAfter, ...shapeAfter } = after;
      expect(shapeAfter).toEqual(shapeBefore);
      expect(bodyAfter).not.toBe(fnBefore.body_md5);
      expect(after.config).toEqual(['search_path=public, pg_temp']);
      expect(after.service_role_exec).toBe(false);
      expect(await fnShape(WRAPPER_SIG)).toEqual(wrapperBefore);
    });

    it('catalog: the private gate is SECURITY INVOKER, pinned, owner-only, and its trigger fires after both fences and before set_updated_at', async () => {
      const gate = await fnShape(GATE_SIG);
      console.log('[M220 evidence] gate:', JSON.stringify(gate));
      expect(gate).toMatchObject({ secdef: false, config: ['search_path=pg_catalog, pg_temp'], rettype: 'trigger',
        authenticated_exec: false, anon_exec: false, service_role_exec: false, public_exec: false });
      const [{ owner_only: ownerOnly }] = await admin(`
        SELECT NOT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                            WHERE p.oid = '${GATE_SIG}'::regprocedure AND a.grantee <> p.proowner) AS owner_only`);
      expect(ownerOnly).toBe(true);
      const triggers = await admin(`
        SELECT t.tgname AS name, t.tgtype AS type, t.tgenabled AS enabled, t.tgfoid::regprocedure::text AS fn
          FROM pg_trigger t WHERE t.tgrelid = 'public.central_needs_plan_revisions'::regclass AND NOT t.tgisinternal
         ORDER BY t.tgname COLLATE "C"`);
      console.log('[M220 evidence] plan_revisions triggers (firing order):', JSON.stringify(triggers));
      expect(triggers.map((t: any) => t.name)).toEqual([
        'central_needs_plan_revisions_c5_approval_gate', 'central_needs_plan_revisions_c6_submission_gate', TRIGGER, 'set_updated_at']);
      expect(triggers[2]).toEqual({ name: TRIGGER, type: 19, enabled: 'O', fn: GATE_SIG });
    });

    it('catalog: the M218 seal stays empty and service_role keeps exactly its three Central Needs SECURITY DEFINER routines', async () => {
      expect(await admin(`SELECT x.breach FROM phoenix_private.central_needs_capability_breaches_v1() AS x(breach)`)).toEqual([]);
      const [{ svc }] = await admin(`
        SELECT array_agg(p.proname::text ORDER BY p.proname::text COLLATE "C") AS svc FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%central\\_needs\\_%' AND p.prosecdef
           AND has_function_privilege('service_role', p.oid, 'EXECUTE')`);
      expect(svc).toEqual(['_phoenix_central_needs_payload_digest_v1', 'phoenix_central_needs_apply_authoritative_replay',
        'phoenix_central_needs_register_import_batch']);
    });

    // -----------------------------------------------------------------------
    // A. the disposition boundary
    // -----------------------------------------------------------------------
    describe('A. the disposition boundary', () => {
      it('an ACTIVE item maps: ok, the mapping row and exactly one audit row', async () => {
        const item = await mkItem('active', 'Active A');
        const d = await openDraft();
        const s = await addSession(d.rev, [1]);
        const audit0 = await auditTotal();
        const r = await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', item, null);
        expect(r).toMatchObject({ ok: true, idempotent_replay: false, decision: 'mapped', central_item_id: item,
          previous_decision: null, previous_central_item_id: null });
        expect(await mapping(s.sessionId)).toMatchObject({ id: r.mapping_id, decision: 'mapped', central_item_id: item });
        expect(await auditTotal()).toBe(audit0 + 1);
        const [a] = await admin(`SELECT actor_id, action, entity_type, entity_label, payload FROM audit_logs WHERE entity_id = $1`, [r.mapping_id]);
        expect(a).toMatchObject({ actor_id: U_EDIT, action: 'central_needs.record_disposition.set', entity_type: 'central_needs_record_mapping',
          entity_label: `Active A ${item.slice(0, 8)}` });
        expect(a.payload).toMatchObject({ decision: 'mapped', central_item_id: item, plan_revision_id: d.rev, previous_decision: null });
      });

      it('an INACTIVE item is refused central_item_not_active (23514, reason=inactive); nothing written', async () => {
        const item = await mkItem('inactive');
        const d = await openDraft();
        const s = await addSession(d.rev, [1]);
        const r = await refused(d.rev, () => dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', item, null), NOT_ACTIVE);
        expect(r.detail).toBe(`central_item=${item} status=inactive reason=inactive`);
        expect(await mapping(s.sessionId)).toBeNull();
      });

      it('a DISCONTINUED item is refused central_item_not_active (reason=discontinued); nothing written', async () => {
        const item = await mkItem('discontinued');
        const d = await openDraft();
        const s = await addSession(d.rev, [1]);
        const r = await refused(d.rev, () => dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', item, null), NOT_ACTIVE);
        expect(r.detail).toBe(`central_item=${item} status=discontinued reason=discontinued`);
        expect(await mapping(s.sessionId)).toBeNull();
      });

      it('a NONEXISTENT item is still refused central_item_not_found (P0002)', async () => {
        const d = await openDraft();
        const s = await addSession(d.rev, [1]);
        await refused(d.rev, () => dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', randomUUID(), null), 'central_item_not_found', 'P0002');
        expect(await mapping(s.sessionId)).toBeNull();
      });

      it('the legacy wrapper cannot bypass the guard (inactive, discontinued) and keeps its M210 response shape for an active item', async () => {
        const inactive = await mkItem('inactive');
        const discontinued = await mkItem('discontinued');
        const active = await mkItem('active');
        const d = await openDraft();
        const s = await addSession(d.rev, [1]);
        const r1 = await refused(d.rev, () => call(U_EDIT, MAP_LEGACY, [s.sessionId, 'sheet:0:row:1', inactive]), NOT_ACTIVE);
        expect(r1.detail).toBe(`central_item=${inactive} status=inactive reason=inactive`);
        const r2 = await refused(d.rev, () => call(U_EDIT, MAP_LEGACY, [s.sessionId, 'sheet:0:row:1', discontinued]), NOT_ACTIVE);
        expect(r2.detail).toBe(`central_item=${discontinued} status=discontinued reason=discontinued`);
        expect(await mapping(s.sessionId)).toBeNull();
        const ok = await call(U_EDIT, MAP_LEGACY, [s.sessionId, 'sheet:0:row:1', active]);
        expect(Object.keys(ok).sort()).toEqual(['central_item_id', 'idempotent_replay', 'import_session_id', 'mapping_id', 'ok',
          'previous_central_item_id', 'target_entity']);
        expect(ok).toMatchObject({ ok: true, idempotent_replay: false, central_item_id: active, previous_central_item_id: null });
      });

      it('a direct authenticated RPC call by an eligible editor cannot re-map an existing row onto an inactive item', async () => {
        const active = await mkItem('active');
        const inactive = await mkItem('inactive');
        const d = await openDraft();
        const s = await addSession(d.rev, [1, 2]);
        await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', active, null);
        await dispose(U_EDIT, s.sessionId, 'sheet:0:row:2', 'not_applicable', null, 'subtotal row');
        await refused(d.rev, () => dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', inactive, null), NOT_ACTIVE);
        await refused(d.rev, () => dispose(U_EDIT, s.sessionId, 'sheet:0:row:2', 'mapped', inactive, null), NOT_ACTIVE);
        expect(await mapping(s.sessionId, 'sheet:0:row:1')).toMatchObject({ decision: 'mapped', central_item_id: active });
        expect(await mapping(s.sessionId, 'sheet:0:row:2')).toMatchObject({ decision: 'not_applicable', central_item_id: null, decision_reason: 'subtotal row' });
      });

      it('idempotent replay, re-map between two ACTIVE items and the audit trail are preserved', async () => {
        const a = await mkItem('active', 'Item A');
        const b = await mkItem('active', 'Item B');
        const d = await openDraft();
        const s = await addSession(d.rev, [1]);
        const first = await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', a, null);
        const audit0 = await auditTotal();
        expect(await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', a, null)).toEqual({
          ok: true, idempotent_replay: true, mapping_id: first.mapping_id, import_session_id: s.sessionId,
          target_entity: 'sheet:0:row:1', decision: 'mapped', central_item_id: a });
        expect(await auditTotal()).toBe(audit0);
        const remap = await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', b, null);
        expect(remap).toMatchObject({ ok: true, idempotent_replay: false, mapping_id: first.mapping_id, central_item_id: b,
          previous_decision: 'mapped', previous_central_item_id: a });
        expect(await auditTotal()).toBe(audit0 + 1);
        const [audit] = await admin(`SELECT entity_label, payload FROM audit_logs WHERE entity_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [first.mapping_id]);
        expect(audit.entity_label).toBe(`Item B ${b.slice(0, 8)}`);
        expect(audit.payload).toMatchObject({ central_item_id: b, previous_central_item_id: a, previous_decision: 'mapped' });
      });

      it('a replay of a mapping whose item has since become inactive fails closed; not_applicable and a re-map to an active item remain the remedies', async () => {
        const flip = await mkItem('active');
        const other = await mkItem('active');
        const d = await openDraft();
        const s = await addSession(d.rev, [1]);
        await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', flip, null);
        await setStatus(flip, 'inactive');
        await refused(d.rev, () => dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', flip, null), NOT_ACTIVE);
        expect(await mapping(s.sessionId)).toMatchObject({ decision: 'mapped', central_item_id: flip });
        expect(await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'not_applicable', null, 'item withdrawn from the catalog'))
          .toMatchObject({ ok: true, decision: 'not_applicable', central_item_id: null, previous_central_item_id: flip });
        expect(await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', other, null))
          .toMatchObject({ ok: true, decision: 'mapped', central_item_id: other, previous_decision: 'not_applicable' });
      });

      it('not_applicable and shape refusals are unchanged and precede the item judgement', async () => {
        const inactive = await mkItem('inactive');
        const d = await openDraft();
        const s = await addSession(d.rev, [1]);
        await refused(d.rev, () => dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'not_applicable', inactive, 'x'),
          'not_applicable_decision_must_not_carry_central_item_id');
        await refused(d.rev, () => dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'not_applicable', null, '  '),
          'not_applicable_decision_requires_reason');
        await refused(d.rev, () => dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', null, null),
          'mapped_decision_requires_central_item_id');
        await refused(d.rev, () => dispose(U_EDIT, s.sessionId, 'sheet:0:row:9', 'mapped', inactive, null),
          'target_entity_not_in_import_session', 'P0002');
        expect(await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'not_applicable', null, 'note row'))
          .toMatchObject({ ok: true, idempotent_replay: false, decision: 'not_applicable', central_item_id: null });
        expect(await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'not_applicable', null, 'note row'))
          .toMatchObject({ ok: true, idempotent_replay: true });
      });
    });

    // -----------------------------------------------------------------------
    // B. authorization and DRAFT precede the item judgement
    // -----------------------------------------------------------------------
    describe('B. authorization and DRAFT precede the item judgement (no status oracle)', () => {
      it('every unauthorized caller gets the SAME refusal for an inactive and an active item, never central_item_not_active', async () => {
        const inactive = await mkItem('inactive');
        const active = await mkItem('active');
        const d = await openDraft();
        const s = await addSession(d.rev, [1]);
        const callers: Array<[string, string | null, string, Refusal]> = [
          ['institution_admin with every key (ineligible role)', U_INST, 'authenticated', { code: '42501', message: 'forbidden_central_needs_role' }],
          ['central_warehouse_manager of another organization', U_OTHER, 'authenticated', { code: '42501', message: 'forbidden_central_needs' }],
          ['eligible role without the edit key', U_NOPERM, 'authenticated', { code: '42501', message: 'forbidden_central_needs' }],
          ['view-only editor', U_VIEW, 'authenticated', { code: '42501', message: 'forbidden_central_needs' }],
          ['no identity', null, 'authenticated', { code: '28000', message: 'not_authenticated' }],
          ['anon', null, 'anon', { code: '42501', message: 'permission denied for function phoenix_central_needs_set_record_disposition' }],
          ['service_role', null, 'service_role', { code: '42501', message: 'permission denied for function phoenix_central_needs_set_record_disposition' }],
        ];
        for (const [label, user, role, expected] of callers) {
          for (const item of [inactive, active]) {
            const r = await refused(d.rev, () => dispose(user, s.sessionId, 'sheet:0:row:1', 'mapped', item, null, role), expected.message, expected.code);
            expect(r.message, label).not.toBe(NOT_ACTIVE);
          }
          const w = await refusal(call(user, MAP_LEGACY, [s.sessionId, 'sheet:0:row:1', inactive], role));
          expect(w.message, `${label} (wrapper)`).not.toBe(NOT_ACTIVE);
        }
        expect(await mapping(s.sessionId)).toBeNull();
      });

      it('a non-DRAFT revision is refused plan_revision_not_editable before the item is judged', async () => {
        const item = await mkItem('active');
        const inactive = await mkItem('inactive');
        const d = await submitted(item);
        for (const target of [inactive, item]) {
          await refused(d.rev, () => dispose(U_EDIT, d.sessionId, 'sheet:0:row:1', 'mapped', target, null), 'plan_revision_not_editable');
        }
      });
    });

    // -----------------------------------------------------------------------
    // C. concurrency — two real connections
    // -----------------------------------------------------------------------
    describe('C. concurrency: the FOR SHARE item lock', () => {
      it('(i) a mapping transaction holds the item: a status change by the superuser and by service_role times out (55P03) or waits until it commits', async () => {
        const [{ svc }] = await admin(`SELECT has_table_privilege('service_role', 'public.central_items', 'UPDATE') AS svc`);
        expect(svc).toBe(true); // service_role is a realistic catalog writer
        const item = await mkItem('active');
        const d = await openDraft();
        const s = await addSession(d.rev, [1]);
        const m = await held(U_EDIT);
        try {
          const r = await m.q(DISPOSE, [s.sessionId, 'sheet:0:row:1', 'mapped', item, null]);
          expect(r.ok).toBe(true);
          // The item row is held exactly FOR SHARE: the row lock a status UPDATE needs (FOR NO KEY UPDATE) is refused
          // at once, while FOR SHARE (and FOR KEY SHARE, what a foreign-key check takes) is still granted.
          expect(await probeRow(item, 'NO KEY UPDATE')).toEqual(ROW_LOCKED);
          expect(await probeRow(item, 'SHARE')).toMatchObject({ ok: true });
          expect(await probeRow(item, 'KEY SHARE')).toMatchObject({ ok: true });
          for (const role of ['superuser', 'service_role']) {
            const u = await held(null, role, [`SET LOCAL lock_timeout = '300ms'`]);
            const upd = await u.q(`UPDATE public.central_items SET status = 'inactive' WHERE id = $1`, [item]);
            expect(upd, role).toMatchObject({ ok: false, error: { code: '55P03', message: 'canceling statement due to lock timeout' } });
            await u.rollback();
          }
          // Without a timeout the writer WAITS on the mapping transaction (pg_blocking_pids), then proceeds after COMMIT.
          const w = await held(null, 'superuser');
          const pending = w.q(`UPDATE public.central_items SET status = 'inactive' WHERE id = $1`, [item]);
          const blocked = await waitBlocked(w.pid, m.pid);
          console.log('[M220 evidence] status UPDATE blocked by the mapping txn:', JSON.stringify({ updater: w.pid, mapping: m.pid, ...blocked }));
          expect(await statusOf(item)).toBe('active');
          expect(await m.commit()).toEqual({ ok: true });
          expect(await pending).toMatchObject({ ok: true, rowCount: 1 });
          expect(await w.commit()).toEqual({ ok: true });
        } finally { await m.rollback(); }
        // Serialized: the mapping committed while the item was active; the deactivation came after it.
        expect(await mapping(s.sessionId)).toMatchObject({ decision: 'mapped', central_item_id: item });
        expect(await statusOf(item)).toBe('inactive');
      });

      it('(ii) a status change committed first makes the mapping fail', async () => {
        const item = await mkItem('active');
        const d = await openDraft();
        const s = await addSession(d.rev, [1]);
        const u = await held(null, 'service_role');
        expect((await u.q(`UPDATE public.central_items SET status = 'discontinued' WHERE id = $1`, [item])).ok).toBe(true);
        expect(await u.commit()).toEqual({ ok: true });
        const r = await refused(d.rev, () => dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', item, null), NOT_ACTIVE);
        expect(r.detail).toBe(`central_item=${item} status=discontinued reason=discontinued`);
      });

      it('(iii) an in-flight status change makes the mapping WAIT, then refuse once it commits (no check-then-write gap); a rolled-back change lets it through', async () => {
        for (const outcome of ['commit', 'rollback'] as const) {
          const item = await mkItem('active');
          const d = await openDraft();
          const s = await addSession(d.rev, [1]);
          const u = await held(null, 'superuser');
          expect((await u.q(`UPDATE public.central_items SET status = 'inactive' WHERE id = $1`, [item])).ok).toBe(true);
          const m = await held(U_EDIT);
          try {
            const pending = m.q(DISPOSE, [s.sessionId, 'sheet:0:row:1', 'mapped', item, null]);
            await waitBlocked(m.pid, u.pid);
            expect(await (outcome === 'commit' ? u.commit() : u.rollback())).toEqual({ ok: true });
            const r = await pending;
            if (outcome === 'commit') {
              expect(r).toMatchObject({ ok: false, error: { code: '23514', message: NOT_ACTIVE,
                detail: `central_item=${item} status=inactive reason=inactive` } });
              await m.rollback();
              expect(await mapping(s.sessionId)).toBeNull();
            } else {
              expect(r.ok).toBe(true);
              expect(await m.commit()).toEqual({ ok: true });
              expect(await mapping(s.sessionId)).toMatchObject({ decision: 'mapped', central_item_id: item });
            }
          } finally { await m.rollback(); await u.rollback(); }
        }
      });
    });

    // -----------------------------------------------------------------------
    // D. the submit -> approve window
    // -----------------------------------------------------------------------
    describe('D. the submit -> approve window', () => {
      it('item deactivated after the mapping and before the need line: set_need_line still accepts (existence-only), submit is refused, nothing written', async () => {
        const item = await mkItem('active');
        const d = await mappedDraft(item);
        await setStatus(item, 'inactive');
        await confirm(d.rev, d.sessionId);
        const line = await setLine(d.rev, item, d.rec(1));
        expect(line).toMatchObject({ ok: true });
        await trustBatch(d.rev, [d.sessionId]);
        expect(await blockers(d.rev)).toEqual([]);
        const [{ id: mappingId }] = await admin(`SELECT id FROM central_needs_record_mappings WHERE import_session_id = $1`, [d.sessionId]);
        const r = await refused(d.rev, () => call(U_EDIT, SUBMIT, [d.rev]), WINDOW_NOT_ACTIVE);
        expect(r.detail).toBe(`phase=submit revision=${d.rev} source=mapping mapping=${mappingId} session=${d.sessionId} target_entity=sheet:0:row:1 central_item=${item} status=inactive reason=inactive`);
        expect(await revStatus(d.rev)).toBe('draft');
        // Reactivated, the very same draft submits: the gate is the only refusal.
        await setStatus(item, 'active');
        expect(await call(U_EDIT, SUBMIT, [d.rev])).toEqual({ ok: true, plan_revision_id: d.rev, status: 'submitted' });
      });

      it('item deactivated after the need line (before submit): submit refused for inactive and discontinued', async () => {
        for (const status of ['inactive', 'discontinued']) {
          const item = await mkItem('active');
          const d = await readyDraft(item);
          await setStatus(item, status);
          const r = await refused(d.rev, () => call(U_EDIT, SUBMIT, [d.rev]), WINDOW_NOT_ACTIVE);
          expect(r.detail, status).toMatch(new RegExp(`^phase=submit revision=${d.rev} source=mapping .* central_item=${item} status=${status} reason=${status}$`));
          expect(await revStatus(d.rev)).toBe('draft');
        }
      });

      it('the need-line branch is judged on its own (root-of-trust probe, rolled back): a need line naming an inactive item refuses approve with source=need_line', async () => {
        const item = await mkItem('active');
        const other = await mkItem('inactive');
        const d = await submitted(item);
        // Only the root of trust can rewrite sealed state; it does so here inside a transaction that is ALWAYS rolled back,
        // so the mapping still names the ACTIVE item and only the need line names the inactive one.
        const r = await rig.asAdmin(async (c: any) => {
          await c.query('BEGIN');
          try {
            await c.query('UPDATE public.central_needs_need_lines SET central_item_id = $2 WHERE id = $1', [d.lineId, other]);
            await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [U_APPROVE]);
            return await c.query(APPROVE, [d.rev]).then(() => null,
              (e: any) => ({ code: String(e.code), message: String(e.message), detail: e.detail }));
          } finally { await c.query('ROLLBACK'); }
        });
        expect(r).toEqual({ code: '23514', message: WINDOW_NOT_ACTIVE,
          detail: `phase=approve revision=${d.rev} source=need_line need_line=${d.lineId} central_item=${other} status=inactive reason=inactive` });
        expect(await revStatus(d.rev)).toBe('submitted');
        // With every item active the same submitted revision approves.
        expect(await call(U_APPROVE, APPROVE, [d.rev])).toMatchObject({ ok: true, status: 'approved' });
      });

      it('item deactivated BETWEEN submit and approve: approve refused (phase=approve), nothing written; reject still works', async () => {
        const item = await mkItem('active');
        const d = await submitted(item);
        await setStatus(item, 'inactive');
        const r = await refused(d.rev, () => call(U_APPROVE, APPROVE, [d.rev]), WINDOW_NOT_ACTIVE);
        expect(r.detail).toMatch(new RegExp(`^phase=approve revision=${d.rev} source=mapping .* central_item=${item} status=inactive reason=inactive$`));
        expect(await revStatus(d.rev)).toBe('submitted');
        expect(await admin(`SELECT phase FROM ${STORE} WHERE plan_revision_id = $1 AND phase = 'approve'`, [d.rev])).toEqual([]);
        expect(await admin(`SELECT action FROM audit_logs WHERE entity_id = $1 AND action IN
          ('central_needs.plan_revision.approval_gate', 'central_needs.plan_revision.approve')`, [d.rev])).toEqual([]);
        // The governed remedy is untouched by the gate.
        expect(await call(U_APPROVE, REJECT, [d.rev, 'material withdrawn from the catalog'])).toMatchObject({ ok: true });
        expect(await revStatus(d.rev)).toBe('rejected');
      });

      it('discontinued between submit and approve is refused too; reactivated, the same submitted revision approves', async () => {
        const item = await mkItem('active');
        const d = await submitted(item);
        await setStatus(item, 'discontinued');
        const r = await refused(d.rev, () => call(U_APPROVE, APPROVE, [d.rev]), WINDOW_NOT_ACTIVE);
        expect(r.detail).toMatch(/ status=discontinued reason=discontinued$/);
        await setStatus(item, 'active');
        expect(await call(U_APPROVE, APPROVE, [d.rev])).toMatchObject({ ok: true, status: 'approved', idempotent_replay: false });
        expect(await revStatus(d.rev)).toBe('approved');
      });

      it('approve holds every referenced item FOR SHARE until it ends: a status change times out (55P03) or waits, and an in-flight change makes approve wait and refuse', async () => {
        // (a) approve first
        const item = await mkItem('active');
        const d = await submitted(item);
        const a = await held(U_APPROVE);
        try {
          expect((await a.q(APPROVE, [d.rev])).ok).toBe(true);
          const u = await held(null, 'service_role', [`SET LOCAL lock_timeout = '300ms'`]);
          expect(await u.q(`UPDATE public.central_items SET status = 'inactive' WHERE id = $1`, [item]))
            .toMatchObject({ ok: false, error: { code: '55P03' } });
          await u.rollback();
          expect(await a.commit()).toEqual({ ok: true });
        } finally { await a.rollback(); }
        expect(await revStatus(d.rev)).toBe('approved');
        // (b) status change first, in flight
        const item2 = await mkItem('active');
        const d2 = await submitted(item2);
        const u2 = await held(null, 'superuser');
        expect((await u2.q(`UPDATE public.central_items SET status = 'inactive' WHERE id = $1`, [item2])).ok).toBe(true);
        const a2 = await held(U_APPROVE);
        try {
          const pending = a2.q(APPROVE, [d2.rev]);
          await waitBlocked(a2.pid, u2.pid);
          expect(await u2.commit()).toEqual({ ok: true });
          expect(await pending).toMatchObject({ ok: false, error: { code: '23514', message: WINDOW_NOT_ACTIVE } });
        } finally { await a2.rollback(); await u2.rollback(); }
        expect(await revStatus(d2.rev)).toBe('submitted');
      });

      it('submit holds EVERY referenced item exactly FOR SHARE until it ends — two mapped items and their need lines — and no other item', async () => {
        const x = await mkItem('active');
        const y = await mkItem('active');
        const unrelated = await mkItem('active');
        const d = await openDraft();
        const s = await addSession(d.rev, [1, 2]);
        await dispose(U_EDIT, s.sessionId, 'sheet:0:row:1', 'mapped', x, null);
        await dispose(U_EDIT, s.sessionId, 'sheet:0:row:2', 'mapped', y, null);
        await confirm(d.rev, s.sessionId);
        expect(await setLine(d.rev, x, s.rec(1))).toMatchObject({ ok: true });
        expect(await setLine(d.rev, y, s.rec(2))).toMatchObject({ ok: true });
        await trustBatch(d.rev, [s.sessionId]);
        expect(await blockers(d.rev)).toEqual([]);
        const sub = await held(U_EDIT);
        try {
          expect(await sub.q(SUBMIT, [d.rev])).toMatchObject({ ok: true });
          for (const ref of [x, y]) {
            expect(await probeRow(ref, 'NO KEY UPDATE')).toEqual(ROW_LOCKED);
            expect(await probeRow(ref, 'SHARE')).toMatchObject({ ok: true });
          }
          expect(await probeRow(unrelated, 'NO KEY UPDATE')).toMatchObject({ ok: true });
          expect(await sub.commit()).toEqual({ ok: true });
        } finally { await sub.rollback(); }
        expect(await revStatus(d.rev)).toBe('submitted');
        for (const ref of [x, y]) expect(await probeRow(ref, 'NO KEY UPDATE')).toMatchObject({ ok: true });
      });

      it('approve also locks an item reached ONLY through a need line (root-of-trust probe in a held transaction, rolled back)', async () => {
        const item = await mkItem('active');
        const lineOnly = await mkItem('active');
        const d = await submitted(item);
        const a = await held(U_APPROVE, 'superuser');
        try {
          // The need line now names an item no mapping references; its foreign-key check holds only FOR KEY SHARE.
          expect((await a.q('UPDATE public.central_needs_need_lines SET central_item_id = $2 WHERE id = $1', [d.lineId, lineOnly])).ok).toBe(true);
          expect(await probeRow(lineOnly, 'NO KEY UPDATE')).toMatchObject({ ok: true });
          expect(await a.q(APPROVE, [d.rev])).toMatchObject({ ok: true });
          for (const ref of [item, lineOnly]) {
            expect(await probeRow(ref, 'NO KEY UPDATE')).toEqual(ROW_LOCKED);
            expect(await probeRow(ref, 'SHARE')).toMatchObject({ ok: true });
          }
        } finally { await a.rollback(); }
        expect(await revStatus(d.rev)).toBe('submitted');
      });

      it('an in-flight status change makes SUBMIT wait on the item, then refuse once it commits (phase=submit); nothing written', async () => {
        const item = await mkItem('active');
        const d = await readyDraft(item);
        const before = await snapshot(d.rev);
        const u = await held(null, 'superuser');
        expect((await u.q(`UPDATE public.central_items SET status = 'inactive' WHERE id = $1`, [item])).ok).toBe(true);
        const sub = await held(U_EDIT);
        try {
          const pending = sub.q(SUBMIT, [d.rev]);
          await waitBlocked(sub.pid, u.pid);
          expect(await u.commit()).toEqual({ ok: true });
          const r = await pending;
          expect(r).toMatchObject({ ok: false, error: { code: '23514', message: WINDOW_NOT_ACTIVE } });
          expect(r.error?.detail).toMatch(new RegExp(`^phase=submit revision=${d.rev} source=mapping .* central_item=${item} status=inactive reason=inactive$`));
        } finally { await sub.rollback(); await u.rollback(); }
        expect(await revStatus(d.rev)).toBe('draft');
        expect(await snapshot(d.rev)).toEqual(before);
      });

      it('forged transitions keep their M218 / M217 fence refusals first (the gate fires after both fences)', async () => {
        const item = await mkItem('active');
        const draft = await readyDraft(item);
        const sub = await submitted(await mkItem('active'));
        await setStatus(item, 'inactive');
        const subItem = (await admin(`SELECT central_item_id FROM central_needs_need_lines WHERE plan_revision_id = $1`, [sub.rev]))[0].central_item_id;
        await setStatus(subItem, 'inactive');
        const asSuper = (sql: string, params: unknown[]) => rig.asAdmin(async (c: any) => {
          await c.query('BEGIN');
          try {
            await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
            return await c.query(sql, params);
          } finally { await c.query('ROLLBACK'); }
        });
        expect(await refusal(asSuper(DIRECT_SUBMIT, [draft.rev]))).toMatchObject({ code: '23514', message: 'central_needs_submission_gate_missing' });
        expect(await refusal(asSuper(DIRECT_APPROVE, [sub.rev, U_APPROVE]))).toMatchObject({ code: '23514', message: 'central_needs_approval_gate_missing' });
        expect(await revStatus(draft.rev)).toBe('draft');
        expect(await revStatus(sub.rev)).toBe('submitted');
      });
    });
  });
});
