/**
 * C5 / M217 — DYNAMIC proof of the Central Needs C5 safety convergence against
 * a real disposable PostgreSQL.
 *
 * The rig is built through 216; the 216-state measurements that need the SAME
 * database before M217 exists run first — (j) the submit/approve/reject ACL
 * baseline and (k) the isolation assertion, NOWAIT behaviour and the lock
 * budget of the migration text held open without its COMMIT. Then the rest of
 * the canonical chain (exactly M217) is applied through applyMigrationSql, so
 * every later test runs on the full 001..217 chain buildRig() would produce.
 *
 * Every attack below names the attacker/actor, the expected SQLSTATE and
 * message, and proves no partial write: a byte-identical snapshot of the
 * revision family, its need lines, links and overrides, and a zero global
 * audit delta. Privileged "bypass" writes use the rig superuser on purpose:
 * they are the paths the deferred trigger and the approval fence must still
 * bind. Gated on PHOENIX_RIG_PG; skipped when no database is configured.
 *
 *   (a) classifier: the 77 frozen v1.9 vectors, attributes and grants
 *   (b) the NOT VALID source-value CHECK binds every future write
 *   (c) lineage helper: first-failure order A-F, NULL cases, no client EXECUTE
 *   (d) set_need_line: the designatedQuantity lexeme and the immediate refusal
 *   (e) deferred integrity scoping: same code/DETAIL, touched link only
 *   (f) blockers: A1 CSV/XLSX parity, list equivalence, C5 blockers, reasons
 *   (g) override chronology (the tie-break head agreed by helper, writer, chain)
 *   (h) approval fence: INSERT + UPDATE from submitted, draft, superseded and
 *       rejected, exact same-transaction gate only
 *   (i) approve A2: guard order, owner FOR SHARE after the guard (refused
 *       callers never wait), exact DETAIL, precedence
 *   (j) ACL neutrality of submit/approve/reject across M217
 *   (k) lock budget, NOWAIT, READ COMMITTED, idempotence; the RLS-bypass
 *       prelude refusal (M217-F2); rehearsal-only negative controls proving the
 *       VERIFY pg_locks self-check (M217-F3) and the VERIFY ACL-neutrality check
 *       on a FROZEN submit/approve ACL (TR-1: blanket GRANT, re-grant,
 *       DROP+CREATE) actually trip — every rehearsal is rolled back
 *   (l) A2 deadlock matrix (P6/P7 shapes), the ascending beneficiary-then-
 *       warehouse lock order observed on held rows (TR-3), the owner-archive ×
 *       approve cycle (M217-F1), and untranslated 40P01/55P03/57014
 *
 * The §7.1 invalid-evidence blocker needs a source row older than the CHECK;
 * the full chain cannot hold one, so its DETAIL and DRAFT-only proofs live in
 * the dedicated 217 lifecycle-chain runner (built to 216 first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyMigrationSql, buildRig, migrationFiles, MIGRATIONS_DIR, rigAvailable, shimSql,
} from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const M217 = '217_phoenix_central_needs_c5_safety_convergence.sql';

const ORG_OWNER = '00000000-0000-0000-0000-000000217001'; // pharmacy department authority, owns every plan
const ORG_BENE_A = '00000000-0000-0000-0000-000000217002';
const ORG_BENE_B = '00000000-0000-0000-0000-000000217003';
const ORG_AUTH = '00000000-0000-0000-0000-000000217004'; // not a care institution
const ORG_OTHER = '00000000-0000-0000-0000-000000217005'; // unrelated owner organization

const U_EDIT = '00000000-0000-0000-0000-000000217401';    // view/import/edit on the owner
const U_APPROVE = '00000000-0000-0000-0000-000000217402'; // view/approve on the owner
const U_VIEW = '00000000-0000-0000-0000-000000217403';    // view only
const U_NOPERM = '00000000-0000-0000-0000-000000217404';  // eligible role, no key
const U_INST = '00000000-0000-0000-0000-000000217405';    // ineligible role, every key
const U_OTHER = '00000000-0000-0000-0000-000000217406';   // every key, other organization

const ITEM_A = '00000000-0000-0000-0000-000000217801';
const ITEM_B = '00000000-0000-0000-0000-000000217802';
const ITEM_C = '00000000-0000-0000-0000-000000217803';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PARSER_IDENTITY = {
  contractVersion: '1.0.0', sheetjsVersion: '0.20.3',
  sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
  runtime: 'node',
};
const RENDERED = { ...PARSER_IDENTITY, runtime: 'browser_worker' };

const CLASSIFY = 'public._phoenix_central_needs_review_numeric_class_v1';
const LINEAGE = 'public._phoenix_central_needs_quantity_lineage_violation_v1';
const SET_LINE = 'SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6::jsonb,$7::uuid[],$8,$9,$10,$11) AS result';
const OVERRIDE = 'SELECT public.phoenix_central_needs_record_field_override($1,$2::jsonb,$3) AS result';
const SET_COLUMNS = 'SELECT public.phoenix_central_needs_set_beneficiary_columns($1,$2::jsonb,$3) AS result';
const REGIONS = 'SELECT public.phoenix_central_needs_set_beneficiary_regions($1,$2,$3,$4::jsonb,$5,$6::uuid[],$7::jsonb,$8) AS result';
const OPEN_DRAFT = 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,$3) AS result';
const OPEN_CORRECTION = 'SELECT public.phoenix_central_needs_open_correction_revision($1,$2,$3,$4) AS result';
const SUBMIT = 'SELECT public.phoenix_central_needs_submit_revision($1) AS result';
const APPROVE = 'SELECT public.phoenix_central_needs_approve_revision($1) AS result';
const REJECT = 'SELECT public.phoenix_central_needs_reject_revision($1,$2) AS result';
const READINESS = 'SELECT public.phoenix_central_needs_review_readiness($1) AS result';
const LIFECYCLE_SIGS = [
  'public.phoenix_central_needs_submit_revision(uuid)',
  'public.phoenix_central_needs_approve_revision(uuid)',
  'public.phoenix_central_needs_reject_revision(uuid, text)',
];

// ---------------------------------------------------------------------------
// (a) The frozen v1.9 classifier vectors (04-VECTORS/v19-vectors.mjs), ported
// verbatim: raw JSON text, expected class.
// ---------------------------------------------------------------------------
const E = (value: unknown, valueType: unknown) => ({ value, valueType, isFormula: false, formula: null });
const S = (v: string) => E(v, 'string');
const cp = (n: number) => String.fromCodePoint(n);
const VECTORS: Array<{ group: string; label: string; raw: string; expect: string }> = [];
const vector = (group: string, label: string, raw: unknown, expect: string) =>
  VECTORS.push({ group, label, raw: typeof raw === 'string' ? raw : JSON.stringify(raw), expect });
([
  ['non-object array', [25], 'invalid_evidence'], ['non-object string', '"x"', 'invalid_evidence'], ['JSON null', 'null', 'invalid_evidence'],
  ['{}', {}, 'invalid_evidence'], ['valueType missing', { value: 25 }, 'invalid_evidence'],
  ['valueType JSON null', { value: 25, valueType: null }, 'invalid_evidence'], ['valueType number (not string)', { value: 25, valueType: 5 }, 'invalid_evidence'],
  ['valueType "Number"', E(25, 'Number'), 'invalid_evidence'], ['valueType "number "', E(25, 'number '), 'invalid_evidence'],
  ['value key missing', { valueType: 'number' }, 'invalid_evidence'], ['number+null (NaN path)', E(null, 'number'), 'invalid_evidence'],
  ['string+null (parser default branch; rule 4)', E(null, 'string'), 'not_numeric'],
  ['string, value key absent', { valueType: 'string', isFormula: false, formula: null }, 'invalid_evidence'],
  ['string+null, bare', { value: null, valueType: 'string' }, 'not_numeric'],
  ['boolean+null', E(null, 'boolean'), 'invalid_evidence'], ['date+null', E(null, 'date'), 'invalid_evidence'], ['error+null', E(null, 'error'), 'invalid_evidence'],
] as Array<[string, unknown, string]>).forEach(([l, v, x]) => vector('presence', l, v, x));
([
  ['number+number', E(25, 'number'), 'native_number'], ['number+0', E(0, 'number'), 'native_number'],
  ['number+string', E('25', 'number'), 'invalid_evidence'], ['number+bool', E(true, 'number'), 'invalid_evidence'],
  ['string+number', E(25, 'string'), 'invalid_evidence'], ['boolean+bool', E(true, 'boolean'), 'not_numeric'],
  ['boolean+string', E('TRUE', 'boolean'), 'invalid_evidence'], ['date+ISO string', E('2023-03-15T00:00:00.000Z', 'date'), 'not_numeric'],
  ['date+serial number', E(45000, 'date'), 'not_numeric'], ['date+boolean', E(true, 'date'), 'invalid_evidence'],
  ['error+string', E('#VALUE!', 'error'), 'not_numeric'], ['error+number', E(7, 'error'), 'invalid_evidence'],
  ['extra keys', { value: 25, valueType: 'number', x: 1 }, 'native_number'],
] as Array<[string, unknown, string]>).forEach(([l, v, x]) => vector('pairs', l, v, x));
for (const [s, x] of [['0', 'canonical_integer_text'], ['25', 'canonical_integer_text'], ['007123', 'ambiguous_numeric_text'],
  ['25.5', 'ambiguous_numeric_text'], ['1'.repeat(256), 'canonical_integer_text'], ['1'.repeat(257), 'ambiguous_numeric_text'],
  ['25\n', 'ambiguous_numeric_text'], ['\n25', 'ambiguous_numeric_text'], ['abc', 'not_numeric'], ['', 'not_numeric'], [' ', 'not_numeric']]) {
  vector('5a/5d', JSON.stringify(s).slice(0, 30), S(s), x);
}
for (const [s, x] of [['NaN', 'ambiguous_numeric_text'], ['nan', 'ambiguous_numeric_text'], ['NAN', 'ambiguous_numeric_text'],
  ['nAn', 'ambiguous_numeric_text'], ['inf', 'ambiguous_numeric_text'], ['INF', 'ambiguous_numeric_text'], ['+Inf', 'ambiguous_numeric_text'],
  ['-Infinity', 'ambiguous_numeric_text'], ['INFINITY', 'ambiguous_numeric_text'], ['+-Inf', 'not_numeric'], ['Infinit', 'not_numeric'],
  ['NaN ', 'not_numeric'], [' NaN', 'not_numeric'], ['NaNa', 'not_numeric'], ['İnf', 'not_numeric'], ['ınf', 'not_numeric'],
  ['Knf', 'not_numeric']]) {
  vector('5b tokens', JSON.stringify(s), S(s), x);
}
for (const [n, x] of [[0x2F, 'not_numeric'], [0x30, 'ambiguous_numeric_text'], [0x39, 'ambiguous_numeric_text'], [0x3A, 'not_numeric'],
  [0x65F, 'not_numeric'], [0x660, 'ambiguous_numeric_text'], [0x669, 'ambiguous_numeric_text'], [0x66A, 'not_numeric'],
  [0x6EF, 'not_numeric'], [0x6F0, 'ambiguous_numeric_text'], [0x6F9, 'ambiguous_numeric_text'], [0x6FA, 'not_numeric'],
  [0xFF0F, 'not_numeric'], [0xFF10, 'ambiguous_numeric_text'], [0xFF19, 'ambiguous_numeric_text'], [0xFF1A, 'not_numeric'],
  [0x9E6, 'not_numeric'], [0x966, 'not_numeric'], [0xB2, 'not_numeric']] as Array<[number, string]>) {
  vector('5c boundary', `U+${n.toString(16).toUpperCase().padStart(4, '0')} in x?x`, S(`x${cp(n)}x`), x);
}

interface Refusal { code: string; message: string; detail?: string; constraint?: string }

/** Resolves to the database error a call was refused with; fails the test if it succeeded. */
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string; constraint?: string };
    return { code: String(err.code), message: String(err.message), detail: err.detail, constraint: err.constraint };
  }
  throw new Error('expected the database to refuse this call, but it succeeded');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Cell = { col: number; value?: unknown; valueType?: string; sv?: Record<string, unknown> };
type Row = { row: number; item?: string; decision?: 'mapped' | 'not_applicable'; cells: Cell[] };
type LineSpec = { beneficiary: string; warehouse?: string | null; item?: string };
type Outcome = { ok: boolean; rows?: any[]; error?: Refusal };

run('C5/M217 Central Needs safety convergence — dynamic (PostgreSQL)', { timeout: 120_000 }, () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let year = 1999;
  let fileSeq = 0;
  let orgSeq = 0;
  let aclBefore: any[] = [];
  let aclAfter: any[] = [];
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

  /** Superuser transaction (a privileged bypass), committed unless fn throws. */
  const bypass = <T = any>(fn: (c: any) => Promise<T>): Promise<T> => rig.asAdmin(async (c: any) => {
    await c.query('BEGIN');
    try {
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  });

  /** Superuser transaction that is ALWAYS rolled back: a read-only probe of a hypothetical state. */
  const probe = <T = any>(fn: (c: any) => Promise<T>): Promise<T> => rig.asAdmin(async (c: any) => {
    await c.query('BEGIN');
    try {
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });

  /** An explicitly held transaction, for deterministic interleavings. `setup` runs before SET ROLE. */
  const held = async (userId: string | null, role = 'authenticated', setup: string[] = []) => {
    const client = await rig.pool.connect();
    let open = true;
    await client.query('BEGIN');
    for (const s of setup) await client.query(s);
    if (role !== 'superuser') {
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    }
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
        (r: any) => ({ ok: true, rows: r.rows }),
        (e: any) => ({ ok: false, error: { code: String(e.code), message: String(e.message), detail: e.detail } })),
      commit: () => finish('COMMIT'),
      rollback: () => finish('ROLLBACK'),
    };
  };

  /** Waits until `pid` is waiting on a heavyweight lock (held by `by` when given). */
  const waitBlocked = async (pid: number, by?: number) => {
    for (let i = 0; i < 200; i += 1) {
      const [row] = await admin(
        `SELECT wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1`, [pid]);
      if (row && row.wait_event_type === 'Lock' && (by === undefined || (row.blockers as number[]).includes(by))) return row.blockers as number[];
      await sleep(50);
    }
    throw new Error(`backend ${pid} never waited on a lock${by === undefined ? '' : ` held by ${by}`}`);
  };

  const applyM217 = (c: any) => applyMigrationSql(c, M217, shimSql(M217, readFileSync(join(MIGRATIONS_DIR, M217), 'utf8')));
  /** Applies M217 on one client and returns the refusal (with the transaction rolled back), or null on success. */
  const tryApplyM217 = (c: any): Promise<Refusal | null> => applyM217(c).then(() => null, async (e: any) => {
    await c.query('ROLLBACK').catch(() => undefined);
    return { code: String(e.code), message: String(e.message), detail: e.detail };
  });
  /** The M217 text exactly as on disk, WITHOUT its final COMMIT (asserted to be the last statement). */
  const m217Uncommitted = () => {
    const text = readFileSync(join(MIGRATIONS_DIR, M217), 'utf8');
    const commitAt = text.lastIndexOf('COMMIT;');
    expect(text.slice(commitAt + 'COMMIT;'.length).trim()).toBe('');
    return text.slice(0, commitAt);
  };
  /** A copy of `text` with `sql` inserted immediately before the VERIFY block. */
  const beforeVerify = (text: string, sql: string) => {
    const at = text.indexOf('DO $verify$');
    expect(at).toBeGreaterThan(0);
    return `${text.slice(0, at)}${sql}\n\n${text.slice(at)}`;
  };
  /**
   * REHEARSAL ONLY (never a migration path): runs `setup`, then a (possibly
   * modified) M217 text without its COMMIT, inside ONE superuser transaction
   * that is ALWAYS rolled back — whatever the text did, nothing survives.
   * Resolves to the refusal, or null when the whole text ran.
   */
  const rehearseM217 = (text: string, setup: string[] = []): Promise<Refusal | null> => rig.asAdmin(async (c: any) => {
    await c.query('BEGIN');
    try {
      for (const s of setup) await c.query(s);
      return await c.query(text).then(() => null,
        (e: any) => ({ code: String(e.code), message: String(e.message), detail: e.detail } as Refusal));
    } finally {
      await c.query('ROLLBACK');
    }
  });
  const m217Objects = async () => (await admin(`
    SELECT to_regprocedure('${CLASSIFY}(jsonb)') IS NOT NULL AS classifier,
           to_regprocedure('${LINEAGE}(uuid)') IS NOT NULL AS lineage,
           to_regprocedure('public._phoenix_central_needs_approval_gate_fence_v1()') IS NOT NULL AS fence_fn,
           EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'central_needs_plan_revisions_c5_approval_gate') AS fence,
           EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'central_needs_source_records_c5_value_contract') AS value_check`))[0];

  /** The exact ACL of the three lifecycle RPCs: proacl text and the order-insensitive aclexplode tuple set. */
  const lifecycleAcl = () => admin(`
    SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
           (SELECT coalesce(jsonb_agg(t.x ORDER BY t.x::text), '[]'::jsonb) FROM (
              SELECT jsonb_build_object('grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
                                        'grantor', pg_get_userbyid(a.grantor), 'privilege', a.privilege_type,
                                        'grantable', a.is_grantable) AS x
                FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) t) AS tuples
      FROM pg_proc p WHERE p.oid = ANY ($1::regprocedure[]) ORDER BY 1`, [LIFECYCLE_SIGS]);

  // ---- evidence and workflow helpers -------------------------------------
  const mkOrg = async (tag: string, kind: 'care_institution' | 'pharmacy_department_authority' = 'care_institution') => {
    orgSeq += 1;
    const [{ id }] = await admin(
      `INSERT INTO organizations (name, name_ar, code, organization_kind, institution_class)
       VALUES ($1, $1, $2, $3, $4) RETURNING id`,
      [`C5 ${tag} ${orgSeq}`, `p217-${tag}-${orgSeq}`, kind, kind === 'care_institution' ? 'hospital' : null]);
    return id as string;
  };
  const mkWarehouse = async (org: string) => {
    const [{ id }] = await admin(
      `INSERT INTO warehouses (organization_id, name, name_ar, status)
       VALUES ($1, 'C5 WH ' || gen_random_uuid()::text, 'مخزن', 'active') RETURNING id`, [org]);
    return id as string;
  };
  /** Archive (stamps archived_at), then suspend, then reactivate: ACTIVE yet archived (202 keeps the stamp). */
  const archiveButActive = async (org: string) => {
    await admin(`UPDATE organizations SET status = 'inactive' WHERE id = $1`, [org]);
    await admin(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [org]);
    await admin(`UPDATE organizations SET status = 'active' WHERE id = $1`, [org]);
    const [o] = await admin(`SELECT status, archived_at FROM organizations WHERE id = $1`, [org]);
    expect(o.status).toBe('active');
    expect(o.archived_at).not.toBeNull();
  };

  const provenance = (row: number, col: number, fileHash: string) => ({
    fileFingerprintSha256: fileHash, originalFilename: `needs-${fileHash.slice(0, 6)}.xlsx`, parserVersion: '1.0.0',
    sheetIndex: 0, sheetName: 'Sheet0', sheetHidden: 'visible',
    coordinate: { row, col, a1: `${String.fromCharCode(65 + (col % 26))}${row + 1}` },
    extractedAt: '2026-09-26T00:00:00.000Z',
  });

  /** One import session with explicit physical cells on sheet 0. Records keyed `${row}:${col}`. */
  async function addSession(revId: string, rows: Row[], opts: { status?: 'completed' | 'processing' } = {}) {
    fileSeq += 1;
    const fileHash = `${fileSeq}`.padStart(64, 'b');
    const [{ id: fileId }] = await admin(
      `INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash, byte_size)
       VALUES ($1,$2,$3,$4,2048) RETURNING id`, [revId, ORG_OWNER, `needs-${fileSeq}.xlsx`, fileHash]);
    const digest = `${fileSeq}`.padStart(64, 'e');
    const status = opts.status ?? 'completed';
    const [{ id: sessionId }] = await admin(
      status === 'completed'
        ? `INSERT INTO central_needs_import_sessions
             (plan_revision_id, organization_id, source_file_id, status, preview_digest, authoritative_digest, parser_identity, completed_at)
           VALUES ($1,$2,$3,'completed',$4,$4,$5::jsonb, now()) RETURNING id`
        : `INSERT INTO central_needs_import_sessions
             (plan_revision_id, organization_id, source_file_id, status, preview_digest, parser_identity)
           VALUES ($1,$2,$3,'processing',$4,$5::jsonb) RETURNING id`,
      [revId, ORG_OWNER, fileId, digest, JSON.stringify(PARSER_IDENTITY)]);
    const records = new Map<string, string>();
    let ordinal = 0;
    for (const row of rows) {
      const entity = `sheet:0:row:${row.row}`;
      for (const cell of row.cells) {
        ordinal += 1;
        const value = cell.value === undefined ? 10 : cell.value;
        const sv = cell.sv ?? { value, valueType: cell.valueType ?? (typeof value === 'number' ? 'number' : 'string'), isFormula: false, formula: null };
        const [{ id }] = await admin(
          `INSERT INTO central_needs_source_records
             (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values, source_provenance)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id`,
          [sessionId, ORG_OWNER, ordinal, entity, `col:${cell.col}`, JSON.stringify(sv), JSON.stringify(provenance(row.row, cell.col, fileHash))]);
        records.set(`${row.row}:${cell.col}`, id);
      }
      const decision = row.decision ?? 'mapped';
      await admin(
        `INSERT INTO central_needs_record_mappings
           (import_session_id, organization_id, target_entity, central_item_id, decision, decision_reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sessionId, ORG_OWNER, entity, decision === 'mapped' ? (row.item ?? ITEM_A) : null, decision,
          decision === 'mapped' ? null : 'out of scope']);
    }
    return { sessionId, records, rec: (row: number, col: number) => records.get(`${row}:${col}`)! };
  }

  const openDraft = async (y = nextYear()) => {
    const r = await call(U_EDIT, OPEN_DRAFT, [ORG_OWNER, y, false]);
    const [{ plan_id: planId }] = await admin(`SELECT plan_id FROM central_needs_plan_revisions WHERE id = $1`, [r.plan_revision_id]);
    return { y, rev: r.plan_revision_id as string, planId: planId as string };
  };
  const confirm = (revId: string, sessionId: string, cols: Array<[number, string]>) => call(U_EDIT, SET_COLUMNS, [revId,
    JSON.stringify(cols.map(([columnIndex, beneficiaryOrganizationId]) => ({ importSessionId: sessionId, sheetIndex: 0, columnIndex, beneficiaryOrganizationId }))),
    'confirmed beneficiary column']);
  const src = (sourceRecordId: string, designatedQuantity: unknown, appliedOverrideId: string | null = null) =>
    ({ sourceRecordId, designatedQuantity, appliedOverrideId });
  const setLine = (revId: string, o: { beneficiary: string; qty: string | number; sources: unknown[]; item?: string;
    warehouse?: string | null; expected?: string[] }, user = U_EDIT) =>
    call(user, SET_LINE, [revId, o.beneficiary, o.item ?? ITEM_A, o.qty, 'designated by reviewer', JSON.stringify(o.sources),
      o.expected ?? [], 'box', 'canonical', o.warehouse ?? null, null]);
  const override = async (recordId: string, finalValue: string | null, user = U_EDIT) =>
    (await call(user, OVERRIDE, [recordId, finalValue, 'human correction'])).override_id as string;
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
  };

  /**
   * Evidence and need lines for a DRAFT: one mapped row per line, each line's
   * cell in its beneficiary's confirmed column, a trusted batch — READY.
   */
  const populate = async (rev: string, lines: LineSpec[]) => {
    const cols = new Map<string, number>();
    for (const l of lines) if (!cols.has(l.beneficiary)) cols.set(l.beneficiary, cols.size + 1);
    const sess = await addSession(rev, lines.map((l, i) => ({ row: i + 1, item: l.item ?? ITEM_A, cells: [{ col: cols.get(l.beneficiary)!, value: 10 }] })));
    await confirm(rev, sess.sessionId, [...cols.entries()].map(([b, c]) => [c, b] as [number, string]));
    const lineIds: string[] = [];
    for (const [i, l] of lines.entries()) {
      const out = await setLine(rev, { beneficiary: l.beneficiary, warehouse: l.warehouse ?? null, item: l.item ?? ITEM_A, qty: 10,
        sources: [src(sess.rec(i + 1, cols.get(l.beneficiary)!), '10')] });
      lineIds.push(out.need_line_id);
    }
    await trustBatch(rev, [sess.sessionId]);
    return { ...sess, lineIds };
  };
  const submittedPlan = async (lines: LineSpec[]) => {
    const d = await openDraft();
    const p = await populate(d.rev, lines);
    expect(await call(U_EDIT, SUBMIT, [d.rev])).toMatchObject({ status: 'submitted' });
    return { ...d, ...p };
  };
  const statuses = async (planId: string) => (await admin(
    `SELECT revision_number || ':' || status AS s FROM central_needs_plan_revisions WHERE plan_id = $1 ORDER BY revision_number`, [planId]))
    .map((r: any) => r.s);
  const gateRows = (rev: string) => admin(
    `SELECT * FROM audit_logs WHERE action = 'central_needs.plan_revision.approval_gate' AND entity_id = $1`, [rev]);
  const blockers = (revId: string) => admin(`SELECT blocker, detail FROM public._phoenix_central_needs_review_blockers_v1($1)`, [revId]);
  const listed = (revId: string) => rig.asUser(U_VIEW, (c: any) => c.query(
    `SELECT import_session_id, column_index, numeric_value_count::int AS numeric, zero_value_count::int AS zero,
            nonzero_numeric_count::int AS nonzero, mapped_row_numeric_count::int AS mapped_numeric, mapping_id, review_required
       FROM public.phoenix_central_needs_list_beneficiary_columns($1)`, [revId]).then((r: any) => r.rows));

  /** Everything a refusal must leave untouched, plus the global audit count. */
  async function snapshot(revId: string) {
    const [row] = await admin(`
      SELECT
        (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.id), '[]'::jsonb)
           FROM central_needs_need_lines n WHERE n.plan_revision_id = $1) AS lines,
        (SELECT coalesce(jsonb_agg(to_jsonb(ls) ORDER BY ls.id), '[]'::jsonb)
           FROM central_needs_need_line_sources ls JOIN central_needs_need_lines n ON n.id = ls.need_line_id
          WHERE n.plan_revision_id = $1) AS links,
        (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id), '[]'::jsonb)
           FROM central_needs_field_overrides o WHERE o.plan_revision_id = $1) AS overrides,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'updated_at', r.updated_at,
                                                      'approved_by', r.approved_by) ORDER BY r.id), '[]'::jsonb)
           FROM central_needs_plan_revisions r
          WHERE r.plan_id = (SELECT plan_id FROM central_needs_plan_revisions WHERE id = $1)) AS revisions,
        (SELECT count(*) FROM central_needs_need_line_sources)::int AS all_links,
        (SELECT count(*) FROM central_needs_source_records)::int AS all_records,
        (SELECT count(*) FROM audit_logs)::int AS audit`, [revId]);
    return row;
  }

  /** Asserts the exact SQLSTATE and message, an unchanged final state and a zero audit delta. */
  async function refused(revId: string, action: () => Promise<unknown>, message: string, sqlstate = '23514') {
    const before = await snapshot(revId);
    const r = await refusal(action());
    expect(r.message).toBe(message);
    expect(r.code).toBe(sqlstate);
    expect(await snapshot(revId)).toEqual(before);
    return r;
  }

  beforeAll(async () => {
    rig = await buildRig({ upTo: 216 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
        ($1,'C5 Pharmacy Dept','دائرة صحة','p217-owner','pharmacy_department_authority',NULL),
        ($2,'C5 Hospital A','مستشفى أ','p217-bene-a','care_institution','hospital'),
        ($3,'C5 Hospital B','مستشفى ب','p217-bene-b','care_institution','hospital'),
        ($4,'C5 Authority','سلطة','p217-auth','pharmacy_department_authority',NULL),
        ($5,'C5 Other Owner','جهة أخرى','p217-other','pharmacy_department_authority',NULL)`,
      [ORG_OWNER, ORG_BENE_A, ORG_BENE_B, ORG_AUTH, ORG_OTHER]);
      await c.query(`INSERT INTO central_items (id, name, name_ar, unit) VALUES
        ($1,'C5 Item A','مادة أ','box'), ($2,'C5 Item B','مادة ب','box'), ($3,'C5 Item C','مادة ج','box')`, [ITEM_A, ITEM_B, ITEM_C]);
      await c.query(`INSERT INTO auth.users (id, email) VALUES
        ($1,'p217-edit@rig'),($2,'p217-approve@rig'),($3,'p217-view@rig'),($4,'p217-noperm@rig'),($5,'p217-inst@rig'),($6,'p217-other@rig')`,
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
  // THE 216 CHAIN, BEFORE M217 — (j) baseline and (k) the migration text.
  // =========================================================================
  describe('(k) on the 216 chain: READ COMMITTED, NOWAIT and the lock budget of the M217 text', () => {
    beforeAll(async () => {
      expect(migrationFiles().filter((f: string) => Number(f.slice(0, 3)) > 216)).toContain(M217);
      expect(await m217Objects()).toEqual({ classifier: false, lineage: false, fence_fn: false, fence: false, value_check: false });
      aclBefore = await lifecycleAcl();
    }, 60000);

    it('refuses REPEATABLE READ and SERIALIZABLE with 217_requires_read_committed, applying nothing', async () => {
      for (const level of ['repeatable read', 'serializable']) {
        const r = await rig.asAdmin(async (c: any) => {
          await c.query(`SET default_transaction_isolation = '${level}'`);
          try { return await tryApplyM217(c); } finally { await c.query('RESET default_transaction_isolation'); }
        });
        expect(r, level).toMatchObject({ message: '217_requires_read_committed' });
      }
      expect(await m217Objects()).toEqual({ classifier: false, lineage: false, fence_fn: false, fence: false, value_check: false });
    });

    it('NOWAIT: an in-flight reader of source_records makes M217 fail at once with 55P03, applying nothing', async () => {
      const h = await held(null, 'superuser');
      try {
        await h.q('LOCK TABLE public.central_needs_source_records IN ACCESS SHARE MODE');
        const t = Date.now();
        const r = await rig.asAdmin((c: any) => tryApplyM217(c));
        expect(r).toMatchObject({ code: '55P03' });
        expect(r!.message).toContain('central_needs_source_records');
        expect(Date.now() - t).toBeLessThan(5000);
      } finally { await h.rollback(); }
      expect(await m217Objects()).toEqual({ classifier: false, lineage: false, fence_fn: false, fence: false, value_check: false });
    });

    it('NOWAIT: an in-flight writer of plan_revisions makes M217 fail at once with 55P03, applying nothing', async () => {
      const h = await held(null, 'superuser');
      try {
        await h.q('LOCK TABLE public.central_needs_plan_revisions IN ROW EXCLUSIVE MODE');
        const r = await rig.asAdmin((c: any) => tryApplyM217(c));
        expect(r).toMatchObject({ code: '55P03' });
        expect(r!.message).toContain('central_needs_plan_revisions');
      } finally { await h.rollback(); }
      expect(await m217Objects()).toEqual({ classifier: false, lineage: false, fence_fn: false, fence: false, value_check: false });
    });

    it('lock budget: held open without its COMMIT, M217 holds only the frozen relation locks, no advisory or tuple lock', async () => {
      const text = readFileSync(join(MIGRATIONS_DIR, M217), 'utf8');
      const commitAt = text.lastIndexOf('COMMIT;');
      expect(text.slice(commitAt + 'COMMIT;'.length).trim()).toBe('');
      const locks = await rig.asAdmin(async (c: any) => {
        try {
          await c.query(text.slice(0, commitAt));
          const [{ status }] = (await c.query(`SELECT current_setting('transaction_isolation') AS status`)).rows;
          expect(status).toBe('read committed');
          return (await c.query(`
            SELECT l.locktype, l.mode, l.granted, n.nspname, c.relname, c.relkind,
                   coalesce(i.indrelid::regclass::text, c.oid::regclass::text) AS owner_rel
              FROM pg_locks l
              LEFT JOIN pg_class c ON c.oid = l.relation
              LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_index i ON i.indexrelid = c.oid
             WHERE l.pid = pg_backend_pid()`)).rows;
        } finally {
          await c.query('ROLLBACK');
        }
      });
      expect(locks.every((l: any) => l.granted)).toBe(true);
      expect(locks.filter((l: any) => ['advisory', 'tuple'].includes(l.locktype))).toEqual([]);
      const app = locks.filter((l: any) => l.locktype === 'relation' && l.nspname === 'public');
      const on = (rel: string) => app.filter((l: any) => l.relname === rel).map((l: any) => l.mode).sort();
      expect(on('central_needs_source_records')).toContain('AccessExclusiveLock');
      expect(on('central_needs_plan_revisions')).toContain('ExclusiveLock');
      expect(on('central_needs_plan_revisions')).toContain('ShareRowExclusiveLock');
      for (const mode of on('central_needs_plan_revisions')) {
        expect(['ExclusiveLock', 'ShareRowExclusiveLock', 'AccessShareLock'], `plan_revisions ${mode}`).toContain(mode);
      }
      const others = app.filter((l: any) => l.owner_rel !== 'central_needs_source_records'
        && !(l.relname === 'central_needs_plan_revisions'));
      expect(others.filter((l: any) => l.mode !== 'AccessShareLock')
        .map((l: any) => `${l.relname} ${l.mode}`)).toEqual([]);
      // Rolled back: nothing of M217 survives.
      expect(await m217Objects()).toEqual({ classifier: false, lineage: false, fence_fn: false, fence: false, value_check: false });
    });

    it('M217-F2: applied by an object-owning role WITHOUT BYPASSRLS, M217 refuses 217_precondition_failed (DETAIL role=<name>) before any lock; WITH BYPASSRLS the same role gets past it', async () => {
      // Attacker/actor: a delegated migration role that holds the owner's object
      // privileges (member of the owner of the C5 tables) but is neither
      // superuser nor BYPASSRLS — FORCE RLS would show it every C5 table empty,
      // so the preconditions and the VERIFY fingerprint would pass vacuously.
      const [{ owner, ownerIdent }] = await admin(`SELECT pg_get_userbyid(relowner) AS owner, quote_ident(pg_get_userbyid(relowner)) AS "ownerIdent"
                                                     FROM pg_class WHERE oid = 'public.central_needs_source_records'::regclass`);
      const [{ forced }] = await admin(`SELECT bool_and(relforcerowsecurity) AS forced FROM pg_class
                                          WHERE oid IN ('public.central_needs_plan_revisions'::regclass, 'public.central_needs_source_records'::regclass)`);
      expect(forced).toBe(true);
      const role = `p217_applier_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
      const asApplier = (bypassrls: boolean) => rehearseM217(m217Uncommitted(), [
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER ${bypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS'}`,
        `GRANT ${ownerIdent} TO ${role}`,
        `SET LOCAL ROLE ${role}`,
        `DO $who$ BEGIN
           IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS DISTINCT FROM ${bypassrls}
              OR NOT pg_has_role(current_user, ${`'${String(owner).replace(/'/g, "''")}'`}, 'USAGE') THEN
             RAISE EXCEPTION 'rehearsal applier is not the intended role';
           END IF;
         END $who$`,
      ]);
      // "Before any lock": another session holds locks that conflict with BOTH
      // members of the activation pair; any attempt that reached the NOWAIT pair
      // would fail 55P03 instead of the precondition.
      const h = await held(null, 'superuser');
      try {
        await h.q('LOCK TABLE public.central_needs_source_records IN ACCESS SHARE MODE');
        await h.q('LOCK TABLE public.central_needs_plan_revisions IN ROW EXCLUSIVE MODE');
        const t = Date.now();
        const refusedRole = await asApplier(false);
        expect(refusedRole).toEqual({ code: 'P0001', message: '217_precondition_failed: the applying role must bypass row-level security',
          detail: `role=${role}` });
        expect(Date.now() - t).toBeLessThan(5000);
        // Control: the identical role WITH BYPASSRLS passes the prelude and reaches the NOWAIT pair.
        const control = await asApplier(true);
        expect(control).toMatchObject({ code: '55P03' });
        expect(control!.message).toContain('central_needs_source_records');
      } finally { await h.rollback(); }
      expect(await m217Objects()).toEqual({ classifier: false, lineage: false, fence_fn: false, fence: false, value_check: false });
      const [{ leaked }] = await admin(`SELECT count(*)::int AS leaked FROM pg_roles WHERE rolname = $1`, [role]);
      expect(leaked).toBe(0);
    });

    it('M217-F3: the VERIFY pg_locks self-check is not vacuous — a rehearsal copy holding one lock outside the §1 budget, a weakened pair or an advisory lock is refused', async () => {
      const text = m217Uncommitted();
      // Control: the unmodified text runs to the end of VERIFY (rolled back).
      expect(await rehearseM217(text)).toBeNull();
      // 1. One extra relation lock outside the budget, before VERIFY.
      for (const extra of [
        'LOCK TABLE public.central_needs_need_lines IN SHARE MODE;',
        'LOCK TABLE public.central_needs_plan_revisions IN ACCESS EXCLUSIVE MODE;',
        'LOCK TABLE public.organizations IN ROW SHARE MODE;',
      ]) {
        expect(await rehearseM217(beforeVerify(text, extra)), extra).toEqual({ code: 'P0001',
          message: 'VERIFY FAILED (217): 1 Phoenix relation lock(s) outside the §1 budget', detail: undefined });
      }
      // 2. The plan_revisions member of the pair taken one step weaker (SHARE ROW
      //    EXCLUSIVE — inside the budget's carve-out, so only the pair check can see it).
      const pair = 'LOCK TABLE public.central_needs_plan_revisions IN EXCLUSIVE MODE NOWAIT;';
      expect(text.split(pair)).toHaveLength(2);
      expect(await rehearseM217(text.replace(pair, 'LOCK TABLE public.central_needs_plan_revisions IN SHARE ROW EXCLUSIVE MODE NOWAIT;')))
        .toEqual({ code: 'P0001', message: 'VERIFY FAILED (217): the §1 activation lock pair is not held', detail: undefined });
      // 3. An advisory lock held by the migration transaction.
      expect(await rehearseM217(beforeVerify(text, 'SELECT pg_advisory_xact_lock(217217);')))
        .toEqual({ code: 'P0001', message: 'VERIFY FAILED (217): an advisory or tuple lock is held', detail: undefined });
      expect(await m217Objects()).toEqual({ classifier: false, lineage: false, fence_fn: false, fence: false, value_check: false });
    });

    it('TR-1 B2 controls: on a FROZEN submit/approve ACL, M217 applies; a blanket GRANT, a re-grant of submit or a DROP+CREATE of approve is refused by VERIFY', async () => {
      // The activation runbook applies M217 while submit/approve are frozen
      // (owner-only). The rig's unfrozen ACL0 already holds the client tuples, so
      // a re-grant would be a no-op there: the controls run on a frozen ACL.
      const freeze = ['public.phoenix_central_needs_submit_revision(uuid)', 'public.phoenix_central_needs_approve_revision(uuid)']
        .map((sig) => `REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role`);
      const text = m217Uncommitted();
      // Control: the unmodified text applies over the frozen ACL (VERIFY compares, never asserts client grants).
      expect(await rehearseM217(text, freeze)).toBeNull();
      // (a) a blanket schema-wide grant: names no RPC, yet VERIFY refuses it.
      const blanket = await rehearseM217(beforeVerify(text, 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;'), freeze);
      expect(blanket).toMatchObject({ code: 'P0001' });
      expect(blanket!.message).toMatch(/^VERIFY FAILED \(217\): /);
      // ...and with the internal helpers kept private, the ACL-neutrality check itself trips on it.
      const blanketLifecycle = await rehearseM217(beforeVerify(text, [
        'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;',
        'REVOKE ALL ON FUNCTION public._phoenix_central_needs_quantity_lineage_violation_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;',
        'REVOKE ALL ON FUNCTION public._phoenix_central_needs_approval_gate_fence_v1() FROM PUBLIC, anon, authenticated, service_role;',
      ].join('\n')), freeze);
      expect(blanketLifecycle).toMatchObject({ code: 'P0001', message: 'VERIFY FAILED (217): submit/approve/reject privileges changed' });
      // (b) a targeted re-grant of the frozen submit.
      expect(await rehearseM217(beforeVerify(text, 'GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_submit_revision(uuid) TO authenticated;'), freeze))
        .toMatchObject({ code: 'P0001', message: 'VERIFY FAILED (217): submit/approve/reject privileges changed' });
      // (c) DROP + CREATE of approve (ACL reset to the default / default privileges).
      const replace = 'CREATE OR REPLACE FUNCTION public.phoenix_central_needs_approve_revision(';
      expect(text.split(replace)).toHaveLength(2);
      expect(await rehearseM217(text.replace(replace,
        'DROP FUNCTION public.phoenix_central_needs_approve_revision(uuid);\nCREATE FUNCTION public.phoenix_central_needs_approve_revision('), freeze))
        .toMatchObject({ code: 'P0001', message: 'VERIFY FAILED (217): submit/approve/reject privileges changed' });
      // Everything rolled back: no M217 object, and the rig ACL is still ACL0.
      expect(await m217Objects()).toEqual({ classifier: false, lineage: false, fence_fn: false, fence: false, value_check: false });
      expect(await lifecycleAcl()).toEqual(aclBefore);
    });
  });

  // =========================================================================
  // THE FULL CHAIN — the remaining canonical migrations (exactly M217) applied
  // through applyMigrationSql, the same replay buildRig() performs.
  // =========================================================================
  describe('on the 001..217 chain', () => {
    beforeAll(async () => {
      const rest = migrationFiles().filter((f: string) => Number(f.slice(0, 3)) > 216);
      expect(rest[0]).toBe(M217);
      await rig.asAdmin(async (c: any) => {
        for (const f of rest) await applyMigrationSql(c, f, shimSql(f, readFileSync(join(MIGRATIONS_DIR, f), 'utf8')));
      });
      aclAfter = await lifecycleAcl();
    }, 600000);

    // -----------------------------------------------------------------------
    // (j) ACL neutrality
    // -----------------------------------------------------------------------
    describe('(j) ACL neutrality of submit, approve and reject', () => {
      it('the proacl and the aclexplode tuple set of all three are identical before and after M217', () => {
        expect(aclBefore).toHaveLength(3);
        expect(aclAfter).toEqual(aclBefore);
        for (const a of aclAfter) expect(a.acl, a.fn).not.toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    // (k) idempotence
    // -----------------------------------------------------------------------
    describe('(k) idempotence', () => {
      it('a second application fails 217_already_applied BEFORE any lock (a held ACCESS SHARE never trips NOWAIT)', async () => {
        const h = await held(null, 'superuser');
        try {
          await h.q('LOCK TABLE public.central_needs_source_records IN ACCESS SHARE MODE');
          await h.q('LOCK TABLE public.central_needs_plan_revisions IN ROW EXCLUSIVE MODE');
          const r = await rig.asAdmin((c: any) => tryApplyM217(c));
          expect(r).toMatchObject({ message: '217_already_applied' });
        } finally { await h.rollback(); }
        expect(await lifecycleAcl()).toEqual(aclBefore);
      });
    });

    // -----------------------------------------------------------------------
    // (a) classifier
    // -----------------------------------------------------------------------
    describe('(a) the frozen classifier', () => {
      it('ports all 77 v1.9 vectors; as authenticated and as service_role every output matches and none is NULL', async () => {
        expect(VECTORS).toHaveLength(77);
        for (const [user, role] of [[U_VIEW, 'authenticated'], [null, 'service_role']] as const) {
          const got = await call(user, `SELECT coalesce(jsonb_agg(${CLASSIFY}(t.v::jsonb) ORDER BY t.o), '[]'::jsonb) AS result
                                          FROM unnest($1::text[]) WITH ORDINALITY AS t(v, o)`, [VECTORS.map((v) => v.raw)], role);
          const mismatches = VECTORS.map((v, i) => ({ ...v, got: got[i] })).filter((v) => v.got !== v.expect);
          expect(mismatches, role).toEqual([]);
        }
        const [{ c }] = await admin(`SELECT ${CLASSIFY}(NULL::jsonb) AS c`);
        expect(c).toBe('invalid_evidence');
      });

      it('is IMMUTABLE, CALLED ON NULL INPUT, SECURITY INVOKER, sql, search_path pinned', async () => {
        const [p] = await admin(`SELECT p.provolatile, p.proisstrict, p.prosecdef, l.lanname, p.proconfig, p.prorettype::regtype::text AS rt
                                   FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = '${CLASSIFY}(jsonb)'::regprocedure`);
        expect(p).toMatchObject({ provolatile: 'i', proisstrict: false, prosecdef: false, lanname: 'sql', rt: 'text' });
        expect(p.proconfig).toContain('search_path=public, pg_temp');
      });

      it('EXECUTE: authenticated and service_role yes; anon and PUBLIC no (anon call refused 42501)', async () => {
        const can = async (role: string) =>
          (await admin(`SELECT has_function_privilege($1, '${CLASSIFY}(jsonb)', 'EXECUTE') AS ok`, [role]))[0].ok;
        expect(await can('authenticated')).toBe(true);
        expect(await can('service_role')).toBe(true);
        expect(await can('anon')).toBe(false);
        expect(await can('public')).toBe(false);
        const [{ n }] = await admin(`SELECT count(*)::int AS n FROM pg_proc p, aclexplode(p.proacl) a
                                      WHERE p.oid = '${CLASSIFY}(jsonb)'::regprocedure AND a.grantee = 0`);
        expect(n).toBe(0);
        const r = await refusal(call(null, `SELECT ${CLASSIFY}('{}'::jsonb) AS result`, [], 'anon'));
        expect(r.code).toBe('42501');
        expect(r.message).toContain('permission denied for function _phoenix_central_needs_review_numeric_class_v1');
      });
    });

    // -----------------------------------------------------------------------
    // (b) the NOT VALID future-write CHECK
    // -----------------------------------------------------------------------
    describe('(b) the NOT VALID source-value CHECK', () => {
      it('exists on source_records, NOT VALID (convalidated = false), classifier-backed', async () => {
        const [c] = await admin(`SELECT contype, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
                                  WHERE conname = 'central_needs_source_records_c5_value_contract'
                                    AND conrelid = 'public.central_needs_source_records'::regclass`);
        expect(c).toMatchObject({ contype: 'c', convalidated: false });
        expect(c.def).toContain('_phoenix_central_needs_review_numeric_class_v1(source_values)');
        expect(c.def).toContain("'invalid_evidence'");
        expect(c.def).toMatch(/NOT VALID$/);
      });

      it('attacker = privileged direct INSERT: number+JSON-null, a missing value key and a missing valueType are refused 23514; string+null is accepted', async () => {
        const d = await openDraft();
        const sess = await addSession(d.rev, [{ row: 1, cells: [{ col: 1 }] }], { status: 'processing' });
        const insert = (sv: unknown, ordinal: number) => admin(
          `INSERT INTO central_needs_source_records (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values)
           VALUES ($1,$2,$3,'sheet:0:row:9',$4,$5::jsonb)`, [sess.sessionId, ORG_OWNER, ordinal, `f${ordinal}`, JSON.stringify(sv)]);
        const count = async () => (await admin(`SELECT count(*)::int AS n FROM central_needs_source_records WHERE import_session_id = $1`, [sess.sessionId]))[0].n;
        const n0 = await count();
        for (const [i, sv] of [E(null, 'number'), { valueType: 'string', isFormula: false, formula: null }, { value: 25, isFormula: false, formula: null }].entries()) {
          const r = await refusal(insert(sv, 10 + i));
          expect(r, JSON.stringify(sv)).toMatchObject({ code: '23514', constraint: 'central_needs_source_records_c5_value_contract' });
        }
        expect(await count()).toBe(n0);
        await insert(E(null, 'string'), 20);
        await insert(E(25, 'number'), 21);
        expect(await count()).toBe(n0 + 2);
      });

      it('attacker = the service_role replay RPC with a number+null record: refused 23514, nothing written; a parser string+null replay lands', async () => {
        const d = await openDraft();
        /** start_import_session (editor) + the service_role authoritative replay of ONE record, exactly as C2's workflow runs it. */
        const replay = async (sourceValues: unknown) => {
          fileSeq += 1;
          const fh = `${fileSeq}`.padStart(64, 'a');
          const records = [{
            targetEntity: 'sheet:0:row:5', fieldName: 'quantity', sourceValues,
            sourceProvenance: {
              fileFingerprintSha256: fh, originalFilename: 'needs.xls', parserVersion: '1.0.0/0.20.3',
              sheetIndex: 0, sheetName: 'Needs', sheetHidden: 'visible',
              coordinate: { row: 4, col: 2, a1: 'C5' }, extractedAt: '2026-09-26T00:00:00.000Z',
            },
          }];
          const [{ d: digest }] = await admin(`SELECT public._phoenix_central_needs_payload_digest_v1($1::jsonb) AS d`, [JSON.stringify(records)]);
          const started = await call(U_EDIT, `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
            [d.rev, 'needs.xls', fh, digest, JSON.stringify(RENDERED), 1024, `permanent/${fileSeq}`]);
          const session = started.import_session_id as string;
          const apply = () => call(null, `SELECT public.phoenix_central_needs_apply_authoritative_replay($1,$2,$3::jsonb,$4::jsonb) AS result`,
            [session, fh, JSON.stringify(records), JSON.stringify(PARSER_IDENTITY)], 'service_role');
          return { session, apply };
        };
        const bad = await replay(E(null, 'number'));
        expect(await refusal(bad.apply())).toMatchObject({ code: '23514', constraint: 'central_needs_source_records_c5_value_contract' });
        const [{ n, status }] = await admin(`SELECT (SELECT count(*)::int FROM central_needs_source_records WHERE import_session_id = s.id) AS n, s.status
                                               FROM central_needs_import_sessions s WHERE s.id = $1`, [bad.session]);
        expect(n).toBe(0);
        expect(status).not.toBe('completed');
        // The parser's real string+null shape (rule 4) is valid evidence.
        const good = await replay(E(null, 'string'));
        await good.apply();
        const [{ cls }] = await admin(`SELECT ${CLASSIFY}(source_values) AS cls FROM central_needs_source_records WHERE import_session_id = $1`,
          [good.session]);
        expect(cls).toBe('not_numeric');
      });
    });

    // -----------------------------------------------------------------------
    // (c) the shared lineage helper
    // -----------------------------------------------------------------------
    describe('(c) the shared lineage helper', () => {
      const R: Record<string, string> = {};
      const O: Record<string, string> = {};
      let fx: { rev: string; planId: string; sessionId: string; line: string; otherRev: string };

      /** Rolled-back probe: a direct link on the fixture line, judged by the helper. */
      const judge = (record: string, qty: string, overrideId: string | null, pre?: (c: any) => Promise<void>) => probe(async (c: any) => {
        const [{ id }] = (await c.query(
          `INSERT INTO central_needs_need_line_sources (need_line_id, organization_id, source_record_id, designated_quantity, applied_override_id)
           VALUES ($1,$2,$3,$4::numeric,$5) RETURNING id`, [fx.line, ORG_OWNER, record, qty, overrideId])).rows;
        if (pre) await pre(c);
        return (await c.query(`SELECT ${LINEAGE}($1) AS reason`, [id])).rows[0].reason as string | null;
      });

      beforeAll(async () => {
        const d = await openDraft();
        const rows: Array<[string, Cell]> = [
          ['nat', { col: 2, value: 25 }], ['can', { col: 2, value: '25' }], ['amb', { col: 2, value: '25.0' }],
          ['txt', { col: 2, value: 'box' }], ['snull', { col: 2, sv: E(null, 'string') }], ['ambHead', { col: 2, value: '25.0' }],
          ['ambNonHead', { col: 2, value: '25.0' }], ['ambStr', { col: 2, value: '25.0' }], ['ambJsonNull', { col: 2, value: '25.0' }],
          ['ambSqlNull', { col: 2, value: '25.0' }], ['ambNeg', { col: 2, value: '25.0' }], ['ambScale', { col: 2, value: '25.0' }],
          ['ambNegOld', { col: 2, value: '25.0' }], ['txtHead', { col: 2, value: 'box' }],
        ];
        const sess = await addSession(d.rev, rows.map(([, cell], i) => ({ row: i + 1, cells: [cell] })));
        rows.forEach(([k], i) => { R[k] = sess.rec(i + 1, 2); });
        await confirm(d.rev, sess.sessionId, [[2, ORG_BENE_A]]);
        O.head = await override(R.ambHead, '25');
        O.old = await override(R.ambNonHead, '25');
        O.new = await override(R.ambNonHead, '25');
        O.str = await override(R.ambStr, '"25"');
        O.jsonNull = await override(R.ambJsonNull, 'null');
        O.sqlNull = await override(R.ambSqlNull, null);
        O.neg = await override(R.ambNeg, '-5');
        O.scale = await override(R.ambScale, '25.0');
        O.negOld = await override(R.ambNegOld, '-5');
        O.negNew = await override(R.ambNegOld, '25');
        O.txt = await override(R.txtHead, '25');
        const line = await setLine(d.rev, { beneficiary: ORG_BENE_A, qty: 25, sources: [src(R.nat, '25')] });
        const other = await openDraft();
        fx = { rev: d.rev, planId: d.planId, sessionId: sess.sessionId, line: line.need_line_id, otherRev: other.rev };
      }, 60000);

      it('B: native_number and canonical_integer_text are safe whatever the designated quantity or pin', async () => {
        expect(await judge(R.can, '7', null)).toBeNull();
        expect(await judge(R.can, '25', O.head)).toBeNull();           // B precedes D (wrong-source pin ignored)
        const [{ reason }] = await admin(`SELECT ${LINEAGE}(id) AS reason FROM central_needs_need_line_sources WHERE source_record_id = $1`, [R.nat]);
        expect(reason).toBeNull();
      });

      it('C: ambiguous and not_numeric evidence without an override -> source_quantity_requires_explicit_numeric_override', async () => {
        for (const k of ['amb', 'txt', 'snull']) {
          expect(await judge(R[k], '25', null), k).toBe('source_quantity_requires_explicit_numeric_override');
        }
      });

      it('D: a non-head pin, another record\'s override and another revision\'s override -> source_quantity_override_binding_invalid', async () => {
        expect(await judge(R.ambNonHead, '25', O.old)).toBe('source_quantity_override_binding_invalid');
        expect(await judge(R.amb, '25', O.head)).toBe('source_quantity_override_binding_invalid');
        // A privileged queued row: an override of THIS record filed under another revision (the head by recency).
        const reason = await probe(async (c: any) => {
          const [{ id: ov }] = (await c.query(
            `INSERT INTO central_needs_field_overrides (plan_revision_id, organization_id, source_record_id, target_entity, field_name,
                                                        final_value, override_reason)
             SELECT $1, organization_id, id, target_entity, field_name, '25'::jsonb, 'queued elsewhere'
               FROM central_needs_source_records WHERE id = $2 RETURNING id`, [fx.otherRev, R.amb])).rows;
          const [{ id }] = (await c.query(
            `INSERT INTO central_needs_need_line_sources (need_line_id, organization_id, source_record_id, designated_quantity, applied_override_id)
             VALUES ($1,$2,$3,25,$4) RETURNING id`, [fx.line, ORG_OWNER, R.amb, ov])).rows;
          return (await c.query(`SELECT ${LINEAGE}($1) AS reason`, [id])).rows[0].reason;
        });
        expect(reason).toBe('source_quantity_override_binding_invalid');
        // D precedes E: a non-head NEGATIVE pin is a binding failure first.
        expect(await judge(R.ambNegOld, '5', O.negOld)).toBe('source_quantity_override_binding_invalid');
      });

      it('E: a JSON string, JSON null, SQL NULL or negative override -> source_quantity_override_value_invalid (E precedes F)', async () => {
        expect(await judge(R.ambStr, '25', O.str)).toBe('source_quantity_override_value_invalid');
        expect(await judge(R.ambJsonNull, '25', O.jsonNull)).toBe('source_quantity_override_value_invalid');
        expect(await judge(R.ambSqlNull, '25', O.sqlNull)).toBe('source_quantity_override_value_invalid');
        expect(await judge(R.ambNeg, '5', O.neg)).toBe('source_quantity_override_value_invalid');
      });

      it('F: a scale-insensitive numeric mismatch -> source_quantity_override_mismatch; equality (25 vs 25.0 vs 25.000) is safe', async () => {
        expect(await judge(R.ambHead, '26', O.head)).toBe('source_quantity_override_mismatch');
        expect(await judge(R.ambHead, '25', O.head)).toBeNull();
        expect(await judge(R.ambHead, '25.000', O.head)).toBeNull();
        expect(await judge(R.ambScale, '25', O.scale)).toBeNull();
        expect(await judge(R.ambNegOld, '25', O.negNew)).toBeNull();
        expect(await judge(R.txtHead, '25', O.txt)).toBeNull();
      });

      it('a non-DRAFT owner -> NULL; a missing, NULL or deleted link id -> NULL', async () => {
        for (const status of ['submitted', 'rejected', 'superseded']) {
          const reason = await judge(R.amb, '25', null, async (c: any) => {
            await c.query(`UPDATE central_needs_plan_revisions SET status = $2 WHERE id = $1`, [fx.rev, status]);
          });
          expect(reason, status).toBeNull();
        }
        const [{ a, b }] = await admin(`SELECT ${LINEAGE}(gen_random_uuid()) AS a, ${LINEAGE}(NULL) AS b`);
        expect(a).toBeNull();
        expect(b).toBeNull();
        const deleted = await probe(async (c: any) => {
          const [{ id }] = (await c.query(
            `INSERT INTO central_needs_need_line_sources (need_line_id, organization_id, source_record_id, designated_quantity)
             VALUES ($1,$2,$3,25) RETURNING id`, [fx.line, ORG_OWNER, R.amb])).rows;
          expect((await c.query(`SELECT ${LINEAGE}($1) AS r`, [id])).rows[0].r).toBe('source_quantity_requires_explicit_numeric_override');
          await c.query(`DELETE FROM central_needs_need_line_sources WHERE id = $1`, [id]);
          return (await c.query(`SELECT ${LINEAGE}($1) AS r`, [id])).rows[0].r;
        });
        expect(deleted).toBeNull();
      });

      it('no client role can execute it: authenticated, anon, PUBLIC and service_role are all refused', async () => {
        for (const role of ['authenticated', 'anon', 'public', 'service_role']) {
          const [{ ok }] = await admin(`SELECT has_function_privilege($1, '${LINEAGE}(uuid)', 'EXECUTE') AS ok`, [role]);
          expect(ok, role).toBe(false);
        }
        for (const [user, role] of [[U_EDIT, 'authenticated'], [null, 'service_role'], [null, 'anon']] as const) {
          const r = await refusal(call(user, `SELECT ${LINEAGE}(gen_random_uuid()) AS result`, [], role));
          expect(r.code, role).toBe('42501');
          expect(r.message).toContain('permission denied for function _phoenix_central_needs_quantity_lineage_violation_v1');
        }
        const [p] = await admin(`SELECT provolatile, prosecdef, proconfig FROM pg_proc WHERE oid = '${LINEAGE}(uuid)'::regprocedure`);
        expect(p).toMatchObject({ provolatile: 's', prosecdef: true });
        expect(p.proconfig).toContain('search_path=public, pg_temp');
      });
    });

    // -----------------------------------------------------------------------
    // (d) set_need_line — lexeme and immediate lineage refusal
    // -----------------------------------------------------------------------
    describe('(d) set_need_line', () => {
      /** A fresh DRAFT whose column 2 is confirmed for Hospital A; one mapped row per cell. */
      const draft = async (cells: Cell[], item = ITEM_A) => {
        const d = await openDraft();
        const sess = await addSession(d.rev, cells.map((cell, i) => ({ row: i + 1, item, cells: [cell] })));
        await confirm(d.rev, sess.sessionId, [[2, ORG_BENE_A]]);
        return { ...d, ...sess, r: (i: number) => sess.rec(i + 1, 2) };
      };

      it('attacker = editor sending a non-canonical designatedQuantity lexeme: designated_quantity_not_canonical, DETAIL source_record, nothing written', async () => {
        const d = await draft([{ col: 2, value: 25 }]);
        const bad: unknown[] = ['007', '025', '+5', '1e3', '.5', '5.', ' 25', '25 ', 25, '1'.repeat(257), '', '-0', '1,000',
          '٢٥', '２５', '25\n', 'NaN', 'Infinity', '0x19', '25.5.1'];
        for (const lexeme of bad) {
          const r = await refused(d.rev, () => setLine(d.rev, { beneficiary: ORG_BENE_A, qty: 25, sources: [src(d.r(0), lexeme)] }),
            'designated_quantity_not_canonical');
          expect(r.detail, JSON.stringify(lexeme)).toBe(`source_record=${d.r(0)}`);
        }
      });

      it('the canonical lexemes are accepted: 25, 25.50, 0.5 and a 256-character integer', async () => {
        for (const lexeme of ['25', '25.50', '0.5', `1${'0'.repeat(255)}`]) {
          const d = await draft([{ col: 2, value: 25 }]);
          const out = await setLine(d.rev, { beneficiary: ORG_BENE_A, qty: lexeme, sources: [src(d.r(0), lexeme)] });
          expect(out, lexeme).toMatchObject({ ok: true, created: true, added_link_count: 1 });
          const [{ q }] = await admin(`SELECT designated_quantity::text AS q FROM central_needs_need_line_sources WHERE need_line_id = $1`, [out.need_line_id]);
          expect(q).toBe(lexeme);
        }
      });

      it('a missing or JSON-null designatedQuantity keeps source_link_requires_designated_quantity', async () => {
        const d = await draft([{ col: 2, value: 25 }]);
        for (const source of [{ sourceRecordId: d.r(0), appliedOverrideId: null }, src(d.r(0), null)]) {
          const r = await refused(d.rev, () => setLine(d.rev, { beneficiary: ORG_BENE_A, qty: 25, sources: [source] }),
            'source_link_requires_designated_quantity');
          expect(r.detail).toBe(`source_record=${d.r(0)}`);
        }
      });

      it('ambiguous / not_numeric evidence without an override: need_line_quantity_lineage_unsafe, atomic (no line, link or audit)', async () => {
        const d = await draft([{ col: 2, value: '25.0' }, { col: 2, value: 'box' }, { col: 2, sv: E(null, 'string') }, { col: 2, value: 25 }]);
        for (const i of [0, 1, 2]) {
          const r = await refused(d.rev, () => setLine(d.rev, { beneficiary: ORG_BENE_A, qty: 25, sources: [src(d.r(i), '25')] }),
            'need_line_quantity_lineage_unsafe');
          expect(r.detail).toMatch(new RegExp(
            `^session=${d.sessionId} source_record=${d.r(i)} need_line=${UUID} reason=source_quantity_requires_explicit_numeric_override$`));
        }
        // Two sources in one call, the SECOND unsafe: the safe first link is rolled back too.
        const r = await refused(d.rev, () => setLine(d.rev, { beneficiary: ORG_BENE_A, qty: 50,
          sources: [src(d.r(3), '25'), src(d.r(0), '25')] }), 'need_line_quantity_lineage_unsafe');
        expect(r.detail).toContain(`source_record=${d.r(0)} `);
        expect(await admin(`SELECT id FROM central_needs_need_lines WHERE plan_revision_id = $1`, [d.rev])).toEqual([]);
        // IMMEDIATE, not merely deferred: the RPC statement itself raises, before any COMMIT.
        const t = await held(U_EDIT);
        try {
          const out = await t.q(SET_LINE, [d.rev, ORG_BENE_A, ITEM_A, 25, 'designated by reviewer', JSON.stringify([src(d.r(0), '25')]),
            [], 'box', 'canonical', null, null]);
          expect(out.error).toMatchObject({ code: '23514', message: 'need_line_quantity_lineage_unsafe' });
        } finally { await t.rollback(); }
      });

      it('override paths: non-head -> binding_invalid; text or negative -> value_invalid; unequal -> mismatch; equal -> accepted', async () => {
        const d = await draft([{ col: 2, value: '25.0' }, { col: 2, value: '25.0' }, { col: 2, value: '25.0' },
          { col: 2, value: '25.0' }, { col: 2, value: '25.0' }]);
        const o1 = await override(d.r(0), '25');
        await override(d.r(0), '25');
        const text = await override(d.r(1), '"25"');
        const neg = await override(d.r(2), '-5');
        const head = await override(d.r(3), '25');
        const scale = await override(d.r(4), '25.0');
        const unsafe = async (i: number, qty: string, ov: string, reason: string) => {
          const r = await refused(d.rev, () => setLine(d.rev, { beneficiary: ORG_BENE_A, qty, sources: [src(d.r(i), qty, ov)] }),
            'need_line_quantity_lineage_unsafe');
          expect(r.detail).toMatch(new RegExp(`^session=${d.sessionId} source_record=${d.r(i)} need_line=${UUID} reason=${reason}$`));
        };
        await unsafe(0, '25', o1, 'source_quantity_override_binding_invalid');
        await unsafe(1, '25', text, 'source_quantity_override_value_invalid');
        await unsafe(2, '5', neg, 'source_quantity_override_value_invalid');
        await unsafe(3, '26', head, 'source_quantity_override_mismatch');
        // M216 precedence kept: another record's override is refused by the existing binding check first.
        await refused(d.rev, () => setLine(d.rev, { beneficiary: ORG_BENE_A, qty: '25', sources: [src(d.r(0), '25', head)] }),
          'applied_override_does_not_match_source_record');
        const ok = await setLine(d.rev, { beneficiary: ORG_BENE_A, qty: 50, sources: [src(d.r(3), '25', head), src(d.r(4), '25', scale)] });
        expect(ok).toMatchObject({ ok: true, added_link_count: 2 });
        const links = await admin(`SELECT source_record_id, designated_quantity::text AS q, applied_override_id
                                     FROM central_needs_need_line_sources WHERE need_line_id = $1 ORDER BY designated_quantity, source_record_id`, [ok.need_line_id]);
        expect(links.map((l: any) => l.applied_override_id).sort()).toEqual([head, scale].sort());
      });
    });

    // -----------------------------------------------------------------------
    // (e) deferred integrity scoping
    // -----------------------------------------------------------------------
    describe('(e) deferred integrity scoping', () => {
      /** A DRAFT with a SAFE line: rNat (10) + rAmb ('25.0', head override 25) = 35. */
      const lineFixture = async () => {
        const d = await openDraft();
        const sess = await addSession(d.rev, [
          { row: 1, cells: [{ col: 2, value: 10 }, { col: 4, value: 'label' }] },
          { row: 2, cells: [{ col: 2, value: '25.0' }, { col: 4, value: 'label' }] },
          { row: 3, item: ITEM_B, cells: [{ col: 2, value: '25.0' }] },
        ]);
        await confirm(d.rev, sess.sessionId, [[2, ORG_BENE_A]]);
        const rNat = sess.rec(1, 2);
        const rAmb = sess.rec(2, 2);
        const o1 = await override(rAmb, '25');
        const line = await setLine(d.rev, { beneficiary: ORG_BENE_A, qty: 35, sources: [src(rNat, '10'), src(rAmb, '25', o1)] });
        return { ...d, ...sess, rNat, rAmb, rAmb2: sess.rec(3, 2), o1, line: line.need_line_id as string };
      };
      const linkOf = async (record: string) => (await admin(`SELECT * FROM central_needs_need_line_sources WHERE source_record_id = $1`, [record]))[0];

      it('attacker = privileged direct UPDATE of designated_quantity: refused at COMMIT with the SAME code and DETAIL shape as set_need_line', async () => {
        const f = await lineFixture();
        const o2 = await override(f.rAmb2, '25');
        const immediate = await refused(f.rev, () => setLine(f.rev, { beneficiary: ORG_BENE_A, item: ITEM_B, qty: 26,
          sources: [src(f.rAmb2, '26', o2)] }), 'need_line_quantity_lineage_unsafe');
        const deferred = await refused(f.rev, () => bypass(async (c: any) => {
          await c.query(`UPDATE central_needs_need_line_sources SET designated_quantity = 26 WHERE source_record_id = $1`, [f.rAmb]);
          await c.query(`UPDATE central_needs_need_lines SET approved_quantity = 36 WHERE id = $1`, [f.line]);
        }), 'need_line_quantity_lineage_unsafe');
        expect(deferred.detail).toBe(`session=${f.sessionId} source_record=${f.rAmb} need_line=${f.line} reason=source_quantity_override_mismatch`);
        const shape = new RegExp(`^session=${f.sessionId} source_record=${UUID} need_line=${UUID} reason=source_quantity_override_mismatch$`);
        expect(immediate.detail).toMatch(shape);
        expect(deferred.detail).toMatch(shape);
      });

      it('an UPDATE of an unrelated column (or to the same value) is not re-checked; a relevant UPDATE is', async () => {
        const f = await lineFixture();
        const o1b = await override(f.rAmb, '25'); // the pinned o1 is no longer the head: the link is now unsafe
        const unsafe = `session=${f.sessionId} source_record=${f.rAmb} need_line=${f.line} reason=source_quantity_override_binding_invalid`;
        expect(await blockers(f.rev)).toContainEqual({ blocker: 'need_line_quantity_lineage_unsafe', detail: unsafe });
        await bypass((c: any) => c.query(`UPDATE central_needs_need_line_sources SET linked_at = linked_at + interval '1 second' WHERE source_record_id = $1`, [f.rAmb]));
        await bypass((c: any) => c.query(`UPDATE central_needs_need_line_sources SET designated_quantity = designated_quantity, linked_by = NULL WHERE source_record_id = $1`, [f.rAmb]));
        // Re-pinning to the head is a relevant change: re-checked, and now safe.
        await bypass((c: any) => c.query(`UPDATE central_needs_need_line_sources SET applied_override_id = $2 WHERE source_record_id = $1`, [f.rAmb, o1b]));
        expect((await blockers(f.rev)).map((b: any) => b.blocker)).not.toContain('need_line_quantity_lineage_unsafe');
        // Pinning back to the stale override is refused at COMMIT.
        const r = await refused(f.rev, () => bypass((c: any) => c.query(
          `UPDATE central_needs_need_line_sources SET applied_override_id = $2 WHERE source_record_id = $1`, [f.rAmb, f.o1])),
        'need_line_quantity_lineage_unsafe');
        expect(r.detail).toBe(unsafe);
        expect((await linkOf(f.rAmb)).applied_override_id).toBe(o1b);
      });

      it('a DELETE never runs the C5 check, nor does a need_lines UPDATE of its quantity', async () => {
        const f = await lineFixture();
        await override(f.rAmb, '25'); // rAmb's pin becomes non-head (unsafe)
        await bypass(async (c: any) => {
          await c.query(`DELETE FROM central_needs_need_line_sources WHERE source_record_id = $1`, [f.rNat]);
          await c.query(`UPDATE central_needs_need_lines SET approved_quantity = 25 WHERE id = $1`, [f.line]);
        });
        expect(await linkOf(f.rNat)).toBeUndefined();
        expect((await blockers(f.rev)).filter((b: any) => b.blocker === 'need_line_quantity_lineage_unsafe'))
          .toEqual([{ blocker: 'need_line_quantity_lineage_unsafe',
            detail: `session=${f.sessionId} source_record=${f.rAmb} need_line=${f.line} reason=source_quantity_override_binding_invalid` }]);
      });

      it('attacker = privileged re-parenting of a SAFE need line to another draft: every link re-checked at COMMIT', async () => {
        const f = await lineFixture();
        const other = await openDraft();
        const r = await refused(f.rev, () => bypass((c: any) => c.query(
          `UPDATE central_needs_need_lines SET plan_revision_id = $2 WHERE id = $1`, [f.line, other.rev])), 'need_line_quantity_lineage_unsafe');
        expect(r.detail).toBe(`session=${f.sessionId} source_record=${f.rAmb} need_line=${f.line} reason=source_quantity_override_binding_invalid`);
        // (organization_id cannot move alone: the composite link and revision FKs refuse it before any trigger.)
      });

      it('mapping and region events never run the C5 check, even while a touched line holds an unsafe link', async () => {
        const f = await lineFixture();
        await override(f.rAmb, '25'); // unsafe pin on the line
        await bypass((c: any) => c.query(
          `UPDATE central_needs_beneficiary_column_mappings SET mapping_reason = mapping_reason || ' (re-read)'
            WHERE import_session_id = $1 AND sheet_index = 0 AND column_index = 2`, [f.sessionId]));
        const regions = await call(U_EDIT, REGIONS, [f.rev, f.sessionId, 0, JSON.stringify(RENDERED), 'Sheet0', [],
          JSON.stringify([{ op: 'add', rowStart: 1, rowEnd: 2, columnStart: 4, columnEnd: 4, decision: 'beneficiary',
            beneficiaryOrganizationId: ORG_BENE_B }]), 'declared by reviewer']);
        expect(regions.ok).toBe(true);
        expect((await blockers(f.rev)).map((b: any) => b.blocker)).toContain('need_line_quantity_lineage_unsafe');
      });
    });

    // -----------------------------------------------------------------------
    // (f) review blockers and the beneficiary-column list
    // -----------------------------------------------------------------------
    describe('(f) review blockers and the beneficiary-column list', () => {
      it('A1: the four completeness branches count CSV text ("25") and XLSX numbers (25) alike; "box" never counts', async () => {
        const d = await openDraft();
        const sess = await addSession(d.rev, [
          { row: 1, cells: [{ col: 1, value: '25' }, { col: 2, value: 'box' }, { col: 3, value: '25' }, { col: 4, value: '25' },
            { col: 5, value: '12 boxes' }, { col: 6, value: '0' }] },
          { row: 2, cells: [{ col: 1, value: 25 }, { col: 2, value: '' }, { col: 3, value: 25 }, { col: 4, value: 'box' },
            { col: 5, value: '٢٥' }] },
          { row: 3, cells: [{ col: 2, sv: E(null, 'string') }, { col: 3, value: 'box' }, { col: 4, value: '7' }] },
        ]);
        await confirm(d.rev, sess.sessionId, [[3, ORG_BENE_A]]);
        await call(U_EDIT, REGIONS, [d.rev, sess.sessionId, 0, JSON.stringify(RENDERED), 'Sheet0', [],
          JSON.stringify([{ op: 'add', rowStart: 1, rowEnd: 2, columnStart: 4, columnEnd: 4, decision: 'beneficiary',
            beneficiaryOrganizationId: ORG_BENE_A }]), 'declared by reviewer']);
        const [{ version_id: region }] = await admin(
          `SELECT version_id FROM central_needs_beneficiary_regions WHERE import_session_id = $1 AND retired_at IS NULL`, [sess.sessionId]);
        const bl = await blockers(d.rev);
        const of = (code: string) => bl.filter((b: any) => b.blocker === code).map((b: any) => b.detail).sort();
        const s = sess.sessionId;
        expect(of('beneficiary_column_review_required')).toEqual([
          `session=${s} sheet=0 column=1 numeric_cells_on_mapped_rows=2`,
          `session=${s} sheet=0 column=5 numeric_cells_on_mapped_rows=2`,
          `session=${s} sheet=0 column=6 numeric_cells_on_mapped_rows=1`,
        ]);
        expect(of('beneficiary_column_cell_without_need_line')).toEqual([
          `session=${s} sheet=0 column=3 target_entity=sheet:0:row:1 source_record=${sess.rec(1, 3)}`,
          `session=${s} sheet=0 column=3 target_entity=sheet:0:row:2 source_record=${sess.rec(2, 3)}`,
        ].sort());
        expect(of('beneficiary_region_cell_uncovered')).toEqual([
          `session=${s} sheet=0 column=4 uncovered_numeric_cells_on_mapped_rows=1 first_uncovered_row=3`]);
        expect(of('beneficiary_region_cell_without_need_line')).toEqual([
          `session=${s} sheet=0 row=1 column=4 region=${region} target_entity=sheet:0:row:1 source_record=${sess.rec(1, 4)}`]);

        // The list: native counts stay native-only (no cast error on text); review_required ≡ branch 13.
        const cols = new Map((await listed(d.rev)).map((r: any) => [r.column_index, r]));
        expect(cols.get(1)).toMatchObject({ numeric: 1, zero: 0, nonzero: 1, mapped_numeric: 1, review_required: true });
        expect(cols.get(2)).toMatchObject({ numeric: 0, zero: 0, nonzero: 0, mapped_numeric: 0, review_required: false });
        expect(cols.get(3)).toMatchObject({ review_required: false });
        expect(cols.get(3).mapping_id).not.toBeNull();
        expect(cols.get(4)).toMatchObject({ review_required: false });
        expect(cols.get(5)).toMatchObject({ numeric: 0, zero: 0, nonzero: 0, mapped_numeric: 0, review_required: true });
        expect(cols.get(6)).toMatchObject({ numeric: 0, review_required: true });
        const flagged = [...cols.values()].filter((r: any) => r.review_required).map((r: any) => r.column_index).sort();
        const blocked = of('beneficiary_column_review_required').map((x: string) => Number(/ column=(\d+) /.exec(x)![1])).sort();
        expect(flagged).toEqual(blocked);
      });

      it('§7.2: an unsafe link is need_line_quantity_lineage_unsafe with the exact DETAIL, DRAFT only; submit refuses on it', async () => {
        const d = await openDraft();
        const sess = await addSession(d.rev, [{ row: 1, cells: [{ col: 2, value: '25.0' }] }]);
        await confirm(d.rev, sess.sessionId, [[2, ORG_BENE_A]]);
        const r = sess.rec(1, 2);
        const o1 = await override(r, '25');
        const line = await setLine(d.rev, { beneficiary: ORG_BENE_A, qty: 25, sources: [src(r, '25', o1)] });
        await trustBatch(d.rev, [sess.sessionId]);
        expect(await blockers(d.rev)).toEqual([]);
        await override(r, '25'); // a newer head: the stored pin is stale
        const unsafe = { blocker: 'need_line_quantity_lineage_unsafe',
          detail: `session=${sess.sessionId} source_record=${r} need_line=${line.need_line_id} reason=source_quantity_override_binding_invalid` };
        expect(await blockers(d.rev)).toEqual([unsafe]);
        const readiness = await call(U_VIEW, READINESS, [d.rev]);
        expect(readiness).toMatchObject({ ready: false, blockers: [unsafe] });
        const refusedSubmit = await refused(d.rev, () => call(U_EDIT, SUBMIT, [d.rev]), 'plan_revision_not_ready_for_review');
        expect(refusedSubmit.detail).toBe(`blocker=need_line_quantity_lineage_unsafe ${unsafe.detail}`);
        // DRAFT only: the same link under a non-DRAFT owner is not reported.
        const nonDraft = await probe(async (c: any) => {
          await c.query(`UPDATE central_needs_plan_revisions SET status = 'submitted' WHERE id = $1`, [d.rev]);
          return (await c.query(`SELECT blocker FROM public._phoenix_central_needs_review_blockers_v1($1)`, [d.rev])).rows;
        });
        expect(nonDraft).toEqual([]);
      });

      it('eligibility branches carry reason tokens; archived blocks; not_owned wins over not_active', async () => {
        const [bInactive, bArchivedActive, bArchived, bOwner, bOther, bWh] =
          [await mkOrg('ri'), await mkOrg('ra'), await mkOrg('rx'), await mkOrg('ro'), await mkOrg('rt'), await mkOrg('rw')];
        const whMoved = await mkWarehouse(bOwner);
        const whInactive = await mkWarehouse(bWh);
        const d = await openDraft();
        const p = await populate(d.rev, [
          { beneficiary: bInactive }, { beneficiary: bArchivedActive }, { beneficiary: bArchived },
          { beneficiary: bOwner, warehouse: whMoved }, { beneficiary: bWh, warehouse: whInactive },
        ]);
        expect(await blockers(d.rev)).toEqual([]);
        await admin(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [bInactive]);
        await archiveButActive(bArchivedActive);
        await admin(`UPDATE organizations SET status = 'inactive' WHERE id = $1`, [bArchived]);
        await admin(`UPDATE warehouses SET organization_id = $2, status = 'inactive' WHERE id = $1`, [whMoved, bOther]);
        await admin(`UPDATE warehouses SET status = 'inactive' WHERE id = $1`, [whInactive]);
        const bl = await blockers(d.rev);
        const of = (code: string) => bl.filter((b: any) => b.blocker === code).map((b: any) => b.detail).sort();
        expect(of('need_line_beneficiary_ineligible')).toEqual([
          `need_line=${p.lineIds[0]} beneficiary=${bInactive} reason=inactive`,
          `need_line=${p.lineIds[1]} beneficiary=${bArchivedActive} reason=archived`,
          `need_line=${p.lineIds[2]} beneficiary=${bArchived} reason=inactive`,
        ].sort());
        expect(of('need_line_warehouse_org_mismatch')).toEqual([`need_line=${p.lineIds[3]} warehouse=${whMoved} reason=not_owned`]);
        expect(of('need_line_target_warehouse_not_active')).toEqual([
          `need_line=${p.lineIds[4]} warehouse=${whInactive} status=inactive reason=not_active`]);
        // not_care_institution: a privileged line naming an authority (rolled back).
        const probeRows = await probe(async (c: any) => {
          const [{ id }] = (await c.query(
            `INSERT INTO central_needs_need_lines (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
                                                   approved_quantity, approved_unit, unit_conversion_state, mapping_reason)
             VALUES ($1,$2,$3,$4,1,'box','canonical','privileged') RETURNING id`, [d.rev, ORG_OWNER, ORG_AUTH, ITEM_C])).rows;
          return { id, rows: (await c.query(`SELECT detail FROM public._phoenix_central_needs_review_blockers_v1($1)
                                              WHERE blocker = 'need_line_beneficiary_ineligible'`, [d.rev])).rows };
        });
        expect(probeRows.rows.map((r: any) => r.detail)).toContain(`need_line=${probeRows.id} beneficiary=${ORG_AUTH} reason=not_care_institution`);
      });

      it('write side: an archived-but-active beneficiary is beneficiary_organization_archived; an archived inactive one stays not_active', async () => {
        const archivedActive = await mkOrg('wa');
        const archivedInactive = await mkOrg('wi');
        await archiveButActive(archivedActive);
        await admin(`UPDATE organizations SET status = 'inactive' WHERE id = $1`, [archivedInactive]);
        const d = await openDraft();
        const sess = await addSession(d.rev, [{ row: 1, cells: [{ col: 2, value: 10 }] }]);
        let r = await refused(d.rev, () => confirm(d.rev, sess.sessionId, [[2, archivedActive]]), 'beneficiary_organization_archived');
        expect(r.detail).toBe(`beneficiary=${archivedActive}`);
        r = await refused(d.rev, () => confirm(d.rev, sess.sessionId, [[2, archivedInactive]]), 'beneficiary_organization_not_active');
        expect(r.detail).toBe('status=inactive');
        await confirm(d.rev, sess.sessionId, [[2, ORG_BENE_A]]);
        r = await refused(d.rev, () => setLine(d.rev, { beneficiary: archivedActive, qty: 10, sources: [src(sess.rec(1, 2), '10')] }),
          'beneficiary_organization_archived');
        expect(r.detail).toBe(`beneficiary=${archivedActive}`);
      });
    });

    // -----------------------------------------------------------------------
    // (g) override chronology
    // -----------------------------------------------------------------------
    describe('(g) override chronology', () => {
      const ambiguousDraft = async () => {
        const d = await openDraft();
        const sess = await addSession(d.rev, [{ row: 1, cells: [{ col: 2, value: '25.0' }] }]);
        await confirm(d.rev, sess.sessionId, [[2, ORG_BENE_A]]);
        return { ...d, sessionId: sess.sessionId, r: sess.rec(1, 2) };
      };
      const overrides = (record: string) => admin(
        `SELECT id, final_value, previous_value, created_at, to_jsonb(created_at) #>> '{}' AS ts
           FROM central_needs_field_overrides WHERE source_record_id = $1 ORDER BY created_at, id`, [record]);

      it('two overrides in ONE transaction get strictly increasing created_at and chain previous_value from the head', async () => {
        const f = await ambiguousDraft();
        await rig.asUser(U_EDIT, async (c: any) => {
          await c.query(OVERRIDE, [f.r, '25', 'first']);
          await c.query(OVERRIDE, [f.r, '26', 'second']);
        }, { commit: true });
        await override(f.r, '27');
        const rows = await overrides(f.r);
        expect(rows.map((o: any) => o.final_value)).toEqual([25, 26, 27]);
        expect(rows[1].previous_value).toBe(25);
        expect(rows[2].previous_value).toBe(26);
        const [{ strictly }] = await admin(`SELECT bool_and(b.created_at > a.created_at) AS strictly
                                               FROM (SELECT created_at, row_number() OVER (ORDER BY created_at, id) AS n
                                                       FROM central_needs_field_overrides WHERE source_record_id = $1) a
                                               JOIN (SELECT created_at, row_number() OVER (ORDER BY created_at, id) AS n
                                                       FROM central_needs_field_overrides WHERE source_record_id = $1) b ON b.n = a.n + 1`, [f.r]);
        expect(strictly).toBe(true);
      });

      it('head = created_at DESC, id DESC: a same-timestamp tie resolves to the greater id — the helper binds only it, the writer chains from it, the chain orders after it', async () => {
        const f = await ambiguousDraft();
        const lo = '00000000-0000-0000-0000-000000217f01';
        const hi = '00000000-0000-0000-0000-000000217f02';
        await admin(`INSERT INTO central_needs_field_overrides (id, plan_revision_id, organization_id, source_record_id, target_entity, field_name,
                                                                 final_value, override_reason, created_at)
                     SELECT v.id, $2, r.organization_id, r.id, r.target_entity, r.field_name, v.fv, 'queued tie', now() - interval '1 hour'
                       FROM central_needs_source_records r, (VALUES ($3::uuid, '11'::jsonb), ($4::uuid, '22'::jsonb)) v(id, fv)
                      WHERE r.id = $1`, [f.r, f.rev, lo, hi]);
        const [{ tie }] = await admin(`SELECT count(DISTINCT created_at)::int = 1 AS tie FROM central_needs_field_overrides WHERE source_record_id = $1`, [f.r]);
        expect(tie).toBe(true);
        const unsafeLines = async () => (await blockers(f.rev)).filter((b: any) => b.blocker === 'need_line_quantity_lineage_unsafe');
        // Helper: the lesser id is NOT the head — pinning it is a binding failure, exact DETAIL, nothing written.
        const r = await refused(f.rev, () => setLine(f.rev, { beneficiary: ORG_BENE_A, qty: 11, sources: [src(f.r, '11', lo)] }),
          'need_line_quantity_lineage_unsafe');
        expect(r.detail).toMatch(new RegExp(
          `^session=${f.sessionId} source_record=${f.r} need_line=${UUID} reason=source_quantity_override_binding_invalid$`));
        // Helper: the greater id IS the head — pinning it (value 22, designated 22) is accepted and leaves no unsafe link.
        const pinned = await setLine(f.rev, { beneficiary: ORG_BENE_A, qty: 22, sources: [src(f.r, '22', hi)] });
        expect(pinned).toMatchObject({ ok: true, created: true, added_link_count: 1 });
        expect(await unsafeLines()).toEqual([]);
        // Writer: the next override chains its previous_value from the same head (22, not 11).
        const out = await call(U_EDIT, OVERRIDE, [f.r, '33', 'after the tie']);
        expect(out.previous_value).toBe(22);
        // Chain: the new override orders last by (created_at, id)...
        const rows = await overrides(f.r);
        expect(rows.map((o: any) => o.id)).toEqual([lo, hi, out.override_id]);
        // ...and the helper now agrees the head moved past `hi`: the stored pin is stale.
        expect(await unsafeLines()).toEqual([{ blocker: 'need_line_quantity_lineage_unsafe',
          detail: `session=${f.sessionId} source_record=${f.r} need_line=${pinned.need_line_id} reason=source_quantity_override_binding_invalid` }]);
      });

      it('a future-dated head still yields a strictly newer created_at (head + 1 microsecond)', async () => {
        const f = await ambiguousDraft();
        const [{ ts }] = await admin(
          `INSERT INTO central_needs_field_overrides (plan_revision_id, organization_id, source_record_id, target_entity, field_name,
                                                      final_value, override_reason, created_at)
           SELECT $2, organization_id, id, target_entity, field_name, '40'::jsonb, 'future-dated', now() + interval '1 day'
             FROM central_needs_source_records WHERE id = $1 RETURNING to_jsonb(created_at) #>> '{}' AS ts`, [f.r, f.rev]);
        const a = await call(U_EDIT, OVERRIDE, [f.r, '41', 'after a future head']);
        const b = await call(U_EDIT, OVERRIDE, [f.r, '42', 'and again']);
        expect(a.previous_value).toBe(40);
        expect(b.previous_value).toBe(41);
        const [{ ok }] = await admin(
          `SELECT (SELECT created_at FROM central_needs_field_overrides WHERE id = $2) = $1::timestamptz + interval '1 microsecond'
              AND (SELECT created_at FROM central_needs_field_overrides WHERE id = $3) = $1::timestamptz + interval '2 microseconds' AS ok`,
          [ts, a.override_id, b.override_id]);
        expect(ok).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    // (h) the approval fence
    // -----------------------------------------------------------------------
    describe('(h) the approval fence', () => {
      it('attacker = superuser and service_role: a direct INSERT of an APPROVED revision without a gate is refused 23514', async () => {
        const d = await openDraft();
        for (const [who, fn] of [
          ['superuser', (sql: string, params: unknown[]) => admin(sql, params)],
          ['service_role', (sql: string, params: unknown[]) => call(null, sql, params, 'service_role')],
        ] as const) {
          const id = (await admin(`SELECT gen_random_uuid() AS id`))[0].id;
          const r = await refused(d.rev, () => fn(
            `INSERT INTO public.central_needs_plan_revisions (id, plan_id, organization_id, revision_number, status, approved_by, approved_at)
             VALUES ($1,$2,$3,2,'approved',$4,now())`, [id, d.planId, ORG_OWNER, U_APPROVE]), 'central_needs_approval_gate_missing');
          expect(r.detail, who).toBe(`revision=${id}`);
        }
        expect(await statuses(d.planId)).toEqual(['1:draft']);
      });

      it('attacker = superuser and service_role: a direct UPDATE to APPROVED from submitted, draft, superseded or rejected is refused 23514, nothing changed', async () => {
        // Sources reached canonically: submitted (submit RPC), draft (open RPC),
        // superseded (the correction-approve path) and rejected (the reject RPC).
        const s = await submittedPlan([{ beneficiary: ORG_BENE_A }]);
        const d = await openDraft();
        const sup = await submittedPlan([{ beneficiary: ORG_BENE_A }]);
        expect(await call(U_APPROVE, APPROVE, [sup.rev])).toMatchObject({ ok: true, status: 'approved' });
        const sup2 = (await call(U_EDIT, OPEN_CORRECTION, [ORG_OWNER, sup.y, sup.rev, 'correction that supersedes revision 1'])).plan_revision_id;
        await populate(sup2, [{ beneficiary: ORG_BENE_A }]);
        expect(await call(U_EDIT, SUBMIT, [sup2])).toMatchObject({ status: 'submitted' });
        expect(await call(U_APPROVE, APPROVE, [sup2])).toMatchObject({ ok: true, status: 'approved', superseded_revision_id: sup.rev });
        const rej = await submittedPlan([{ beneficiary: ORG_BENE_A }]);
        expect(await call(U_APPROVE, REJECT, [rej.rev, 'figures do not match the hospital return'])).toMatchObject({ status: 'rejected' });
        const expected: Array<[string, string, string[]]> = [
          ['submitted', s.rev, ['1:submitted']], ['draft', d.rev, ['1:draft']],
          ['superseded', sup.rev, ['1:superseded', '2:approved']], ['rejected', rej.rev, ['1:rejected']],
        ];
        const planOf = { [s.rev]: s.planId, [d.rev]: d.planId, [sup.rev]: sup.planId, [rej.rev]: rej.planId };
        for (const [from, rev, family] of expected) {
          expect(await statuses(planOf[rev]), from).toEqual(family);
          for (const [who, fn] of [
            ['superuser', (sql: string, params: unknown[]) => admin(sql, params)],
            ['service_role', (sql: string, params: unknown[]) => call(null, sql, params, 'service_role')],
          ] as const) {
            // refused(): exact code and SQLSTATE, a byte-identical revision family/lines/links and a zero audit delta.
            const r = await refused(rev, () => fn(
              `UPDATE public.central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
              [rev, U_APPROVE]), 'central_needs_approval_gate_missing');
            expect(r.detail, `${who} from ${from}`).toBe(`revision=${rev}`);
          }
          expect(await statuses(planOf[rev]), from).toEqual(family);
          expect(await gateRows(rev), from).toHaveLength(from === 'superseded' ? 1 : 0); // only its own canonical approval
        }
      });

      it('a hand-written same-transaction gate passes ONLY when exact (privileged hand-written gates are policy-forbidden)', async () => {
        const s = await submittedPlan([{ beneficiary: ORG_BENE_A }]);
        const other = await submittedPlan([{ beneficiary: ORG_BENE_A }]);
        const attempt = (gate: { actor?: string | null; org?: string; entity?: string; action?: string; entityType?: string;
          contract?: string; txid?: string; createdAt?: string; claim?: string | null }) => probe(async (c: any) => {
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [gate.claim === undefined ? U_APPROVE : (gate.claim ?? '')]);
          await c.query(
            `INSERT INTO public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, jsonb_build_object('contract', $6::text, 'txid', ${gate.txid ?? 'txid_current()::text'}),
                     ${gate.createdAt ?? 'transaction_timestamp()'})`,
            [gate.org ?? ORG_OWNER, gate.actor === undefined ? U_APPROVE : gate.actor, gate.action ?? 'central_needs.plan_revision.approval_gate',
              gate.entityType ?? 'central_needs_plan_revision', gate.entity ?? s.rev, gate.contract ?? 'c5-v1']);
          return c.query(`UPDATE public.central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
            [s.rev, U_APPROVE]).then(() => 'passed', (e: any) => `${e.code} ${e.message}`);
        });
        const denied = '23514 central_needs_approval_gate_missing';
        expect(await attempt({})).toBe('passed');
        expect(await attempt({ txid: `(txid_current() - 1)::text` })).toBe(denied);
        expect(await attempt({ actor: U_EDIT })).toBe(denied);
        expect(await attempt({ org: ORG_OTHER })).toBe(denied);
        expect(await attempt({ entity: other.rev })).toBe(denied);
        expect(await attempt({ contract: 'c5-v0' })).toBe(denied);
        expect(await attempt({ createdAt: `transaction_timestamp() - interval '1 microsecond'` })).toBe(denied);
        expect(await attempt({ action: 'central_needs.plan_revision.approve' })).toBe(denied);
        expect(await attempt({ entityType: 'central_needs_plan' })).toBe(denied);
        expect(await attempt({ claim: null, actor: null })).toBe(denied);
        // A gate committed by an EARLIER transaction never admits a later UPDATE.
        await rig.asAdmin(async (c: any) => {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_APPROVE]);
          await c.query(`INSERT INTO public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, payload)
                         VALUES ($1,$2,'central_needs.plan_revision.approval_gate','central_needs_plan_revision',$3,
                                 jsonb_build_object('contract','c5-v1','txid', txid_current()::text))`, [ORG_OWNER, U_APPROVE, s.rev]);
          await c.query('COMMIT');
        });
        expect(await attempt({ entity: other.rev })).toBe(denied);
        const r = await refusal(rig.asUser(U_APPROVE, (c: any) => c.query(
          `UPDATE public.central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
          [s.rev, U_APPROVE]), { role: 'service_role', commit: true }));
        expect(r).toMatchObject({ code: '23514', message: 'central_needs_approval_gate_missing' });
        expect(await statuses(s.planId)).toEqual(['1:submitted']);
        // authenticated can never write a gate at all.
        const [{ ins }] = await admin(`SELECT has_table_privilege('authenticated', 'public.audit_logs', 'INSERT')
                                          OR has_any_column_privilege('authenticated', 'public.audit_logs', 'INSERT') AS ins`);
        expect(ins).toBe(false);
      });

      it('canonical approve writes the gate and the approve audit in ONE transaction: same txid, same xmin, same created_at', async () => {
        const s = await submittedPlan([{ beneficiary: ORG_BENE_A }]);
        const out = await call(U_APPROVE, APPROVE, [s.rev]);
        expect(out).toMatchObject({ ok: true, idempotent_replay: false, status: 'approved', superseded_revision_id: null });
        const rows = await admin(
          `SELECT action, actor_id, organization_id, entity_type, payload, xmin::text AS xmin, created_at, to_jsonb(created_at) #>> '{}' AS ts
             FROM audit_logs WHERE entity_id = $1 AND action IN ('central_needs.plan_revision.approval_gate', 'central_needs.plan_revision.approve')`, [s.rev]);
        const gate = rows.find((r: any) => r.action === 'central_needs.plan_revision.approval_gate');
        const audit = rows.find((r: any) => r.action === 'central_needs.plan_revision.approve');
        expect(rows).toHaveLength(2);
        expect(gate).toMatchObject({ actor_id: U_APPROVE, organization_id: ORG_OWNER, entity_type: 'central_needs_plan_revision' });
        expect(gate.payload).toMatchObject({ contract: 'c5-v1' });
        expect(audit.payload.approval_gate_txid).toBe(gate.payload.txid);
        expect(gate.xmin).toBe(audit.xmin);
        expect(String(BigInt(gate.payload.txid) % BigInt(4294967296))).toBe(gate.xmin);
        expect(gate.ts).toBe(audit.ts);
        const [rev] = await admin(`SELECT xmin::text AS xmin, to_jsonb(approved_at) #>> '{}' AS at FROM central_needs_plan_revisions WHERE id = $1`, [s.rev]);
        expect(rev.xmin).toBe(gate.xmin);
        expect(rev.at).toBe(gate.ts);
      });
    });

    // -----------------------------------------------------------------------
    // (i) approve — guard order, owner FOR SHARE, A2
    // -----------------------------------------------------------------------
    describe('(i) approve A2', () => {
      /** Asserts an A2 refusal: exact DETAIL, no status/audit/gate/line change. */
      const a2Refused = async (rev: string, detail: string | RegExp, user = U_APPROVE) => {
        const r = await refused(rev, () => call(user, APPROVE, [rev]), 'central_needs_approval_eligibility_changed');
        if (typeof detail === 'string') expect(r.detail).toBe(detail); else expect(r.detail).toMatch(detail);
        expect(await gateRows(rev)).toEqual([]);
        return r;
      };

      it('guard order is unchanged and precedes A2 (actors: anonymous, editor, other org, ineligible role; no-wait before the owner lock: next test)', async () => {
        const b = await mkOrg('guard');
        const s = await submittedPlan([{ beneficiary: b }]);
        await admin(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [b]);
        await refused(s.rev, () => call(null, APPROVE, [s.rev]), 'not_authenticated', '28000');
        await refused(s.rev, () => call(U_APPROVE, APPROVE, [null]), 'plan_revision_id_required');
        await refused(s.rev, () => call(U_APPROVE, APPROVE, ['00000000-0000-0000-0000-00000000dead']), 'plan_revision_not_found', 'P0002');
        await refused(s.rev, () => call(U_EDIT, APPROVE, [s.rev]), 'forbidden_central_needs', '42501');
        await refused(s.rev, () => call(U_NOPERM, APPROVE, [s.rev]), 'forbidden_central_needs', '42501');
        await refused(s.rev, () => call(U_OTHER, APPROVE, [s.rev]), 'forbidden_central_needs', '42501');
        await refused(s.rev, () => call(U_INST, APPROVE, [s.rev]), 'forbidden_central_needs_role', '42501');
        const anon = await refusal(call(null, APPROVE, [s.rev], 'anon'));
        expect(anon.code).toBe('42501');
        expect(await statuses(s.planId)).toEqual(['1:submitted']);
      });

      it('lifecycle A and B precede A2: an approved replay stays idempotent, a draft stays not_submitted', async () => {
        const b = await mkOrg('ab');
        const s = await submittedPlan([{ beneficiary: b }]);
        await call(U_APPROVE, APPROVE, [s.rev]);
        await admin(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [b]);
        const before = await snapshot(s.rev);
        expect(await call(U_APPROVE, APPROVE, [s.rev])).toEqual({ ok: true, idempotent_replay: true, plan_revision_id: s.rev, status: 'approved' });
        expect(await snapshot(s.rev)).toEqual(before);
        const b2 = await mkOrg('ab2');
        const d = await openDraft();
        await populate(d.rev, [{ beneficiary: b2 }]);
        await admin(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [b2]);
        const r = await refused(d.rev, () => call(U_APPROVE, APPROVE, [d.rev]), 'plan_revision_not_submitted');
        expect(r.detail).toBe(`revision=${d.rev} status=draft`);
      });

      it('owner FOR SHARE after the guard: while the owner row is held FOR NO KEY UPDATE, every caller the guard refuses is refused at once (no wait); an authorized approve waits on it, then proceeds', async () => {
        const s = await submittedPlan([{ beneficiary: ORG_BENE_A }]);
        const x = await held(null, 'superuser');
        const a = await held(U_APPROVE);
        try {
          expect((await x.q(`UPDATE organizations SET name = name || '.' WHERE id = $1`, [ORG_OWNER])).ok).toBe(true);
          // Guard first: a caller the guard refuses never queues behind an org
          // writer. Had the owner FOR SHARE come before the guard, each of these
          // would wait on x and end 55P03 after its 2s lock_timeout instead.
          for (const [user, message] of [
            [U_EDIT, 'forbidden_central_needs'], [U_NOPERM, 'forbidden_central_needs'],
            [U_OTHER, 'forbidden_central_needs'], [U_INST, 'forbidden_central_needs_role'],
          ] as const) {
            const u = await held(user, 'authenticated', ["SET LOCAL lock_timeout = '2s'"]);
            try {
              const t = Date.now();
              const out = await u.q(APPROVE, [s.rev]);
              expect(out.error, user).toMatchObject({ code: '42501', message });
              expect(Date.now() - t, `${user} never waited`).toBeLessThan(1500);
            } finally { await u.rollback(); }
          }
          const [{ pending }] = await admin(`SELECT count(*)::int AS pending FROM pg_stat_activity
                                               WHERE datname = current_database() AND wait_event_type = 'Lock'`);
          expect(pending).toBe(0);
          const approving = a.q(APPROVE, [s.rev]);
          expect(await waitBlocked(a.pid, x.pid)).toContain(x.pid);
          expect(await x.commit()).toEqual({ ok: true });
          const out = await approving;
          expect(out.ok).toBe(true);
          expect(out.rows![0].result).toMatchObject({ status: 'approved' });
          expect(await a.commit()).toEqual({ ok: true });
        } finally { await x.rollback(); await a.rollback(); }
        expect(await statuses(s.planId)).toEqual(['1:approved']);
      });

      it('eligibility changed after submit: the exact DETAIL for every reachable reason', async () => {
        // inactive (suspended)
        let b = await mkOrg('e1');
        let s = await submittedPlan([{ beneficiary: b }]);
        await admin(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [b]);
        await a2Refused(s.rev, `blocker=need_line_beneficiary_ineligible need_line=${s.lineIds[0]} beneficiary=${b} reason=inactive`);
        // archived (active, but carrying the archive stamp)
        b = await mkOrg('e2');
        s = await submittedPlan([{ beneficiary: b }]);
        await archiveButActive(b);
        await a2Refused(s.rev, `blocker=need_line_beneficiary_ineligible need_line=${s.lineIds[0]} beneficiary=${b} reason=archived`);
        // inactive wins over archived (a genuine archive: inactive + stamp)
        b = await mkOrg('e3');
        s = await submittedPlan([{ beneficiary: b }]);
        await admin(`UPDATE organizations SET status = 'inactive' WHERE id = $1`, [b]);
        await a2Refused(s.rev, `blocker=need_line_beneficiary_ineligible need_line=${s.lineIds[0]} beneficiary=${b} reason=inactive`);
        // not_owned
        b = await mkOrg('e4');
        let wh = await mkWarehouse(b);
        s = await submittedPlan([{ beneficiary: b, warehouse: wh }]);
        await admin(`UPDATE warehouses SET organization_id = $2 WHERE id = $1`, [wh, ORG_BENE_B]);
        await a2Refused(s.rev, `blocker=need_line_warehouse_org_mismatch need_line=${s.lineIds[0]} beneficiary=${b} warehouse=${wh} reason=not_owned`);
        // not_active
        b = await mkOrg('e5');
        wh = await mkWarehouse(b);
        s = await submittedPlan([{ beneficiary: b, warehouse: wh }]);
        await admin(`UPDATE warehouses SET status = 'inactive' WHERE id = $1`, [wh]);
        await a2Refused(s.rev, `blocker=need_line_target_warehouse_not_active need_line=${s.lineIds[0]} beneficiary=${b} warehouse=${wh} reason=not_active`);
        // not_owned wins over not_active
        b = await mkOrg('e6');
        wh = await mkWarehouse(b);
        s = await submittedPlan([{ beneficiary: b, warehouse: wh }]);
        await admin(`UPDATE warehouses SET organization_id = $2, status = 'inactive' WHERE id = $1`, [wh, ORG_BENE_B]);
        await a2Refused(s.rev, `blocker=need_line_warehouse_org_mismatch need_line=${s.lineIds[0]} beneficiary=${b} warehouse=${wh} reason=not_owned`);
        // not_care_institution: attacker = a privileged post-submit line injection naming an authority.
        s = await submittedPlan([{ beneficiary: ORG_BENE_A }]);
        const injected = await bypass(async (c: any) => {
          const [{ id: rec }] = (await c.query(
            `INSERT INTO central_needs_source_records (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values, source_provenance)
             VALUES ($1,$2,99,'sheet:0:row:99','col:9',$3::jsonb,$4::jsonb) RETURNING id`,
            [s.sessionId, ORG_OWNER, JSON.stringify(E(1, 'number')), JSON.stringify(provenance(99, 9, 'f'.repeat(64)))])).rows;
          await c.query(`INSERT INTO central_needs_record_mappings (import_session_id, organization_id, target_entity, central_item_id, decision)
                         VALUES ($1,$2,'sheet:0:row:99',$3,'mapped')`, [s.sessionId, ORG_OWNER, ITEM_C]);
          const [{ id }] = (await c.query(
            `INSERT INTO central_needs_need_lines (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
                                                   approved_quantity, approved_unit, unit_conversion_state, mapping_reason)
             VALUES ($1,$2,$3,$4,1,'box','canonical','privileged injection') RETURNING id`, [s.rev, ORG_OWNER, ORG_AUTH, ITEM_C])).rows;
          await c.query(`INSERT INTO central_needs_need_line_sources (need_line_id, organization_id, source_record_id, designated_quantity)
                         VALUES ($1,$2,$3,1)`, [id, ORG_OWNER, rec]);
          return id as string;
        });
        await a2Refused(s.rev, `blocker=need_line_beneficiary_ineligible need_line=${injected} beneficiary=${ORG_AUTH} reason=not_care_institution`);
      });

      it('precedence: lines by id ASC; beneficiary before warehouse on one line', async () => {
        const b1 = await mkOrg('p1');
        const b2 = await mkOrg('p2');
        let s = await submittedPlan([{ beneficiary: b1 }, { beneficiary: b2 }]);
        await admin(`UPDATE organizations SET status = 'suspended' WHERE id = ANY($1::uuid[])`, [[b1, b2]]);
        const [first] = await admin(`SELECT id, beneficiary_organization_id AS b FROM central_needs_need_lines
                                       WHERE plan_revision_id = $1 ORDER BY id LIMIT 1`, [s.rev]);
        await a2Refused(s.rev, `blocker=need_line_beneficiary_ineligible need_line=${first.id} beneficiary=${first.b} reason=inactive`);
        const b3 = await mkOrg('p3');
        const wh = await mkWarehouse(b3);
        s = await submittedPlan([{ beneficiary: b3, warehouse: wh }]);
        await admin(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [b3]);
        await admin(`UPDATE warehouses SET status = 'inactive' WHERE id = $1`, [wh]);
        await a2Refused(s.rev, new RegExp(
          `^blocker=need_line_beneficiary_ineligible need_line=${s.lineIds[0]} beneficiary=${b3}(?: warehouse=${wh})? reason=inactive$`));
      });

      it('A2 failure on a correction mutates nothing: the predecessor stays approved, no gate, no audit', async () => {
        const b = await mkOrg('c1');
        const s = await submittedPlan([{ beneficiary: ORG_BENE_A }]);
        await call(U_APPROVE, APPROVE, [s.rev]);
        const rev2 = (await call(U_EDIT, OPEN_CORRECTION, [ORG_OWNER, s.y, s.rev, 'correct the hospital return'])).plan_revision_id;
        const p2 = await populate(rev2, [{ beneficiary: b }]);
        await call(U_EDIT, SUBMIT, [rev2]);
        await admin(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [b]);
        await a2Refused(rev2, `blocker=need_line_beneficiary_ineligible need_line=${p2.lineIds[0]} beneficiary=${b} reason=inactive`);
        expect(await statuses(s.planId)).toEqual(['1:approved', '2:submitted']);
      });

      it('a correction approve supersedes the predecessor and writes the gate, the supersede audit and the approve audit', async () => {
        const s = await submittedPlan([{ beneficiary: ORG_BENE_A }]);
        await call(U_APPROVE, APPROVE, [s.rev]);
        const rev2 = (await call(U_EDIT, OPEN_CORRECTION, [ORG_OWNER, s.y, s.rev, 'final corrected quantities'])).plan_revision_id;
        await populate(rev2, [{ beneficiary: ORG_BENE_B }]);
        await call(U_EDIT, SUBMIT, [rev2]);
        const out = await call(U_APPROVE, APPROVE, [rev2]);
        expect(out).toMatchObject({ ok: true, status: 'approved', superseded_revision_id: s.rev });
        expect(await statuses(s.planId)).toEqual(['1:superseded', '2:approved']);
        const audits = await admin(`SELECT action, entity_id, payload, xmin::text AS xmin FROM audit_logs
                                     WHERE entity_id IN ($1, $2) AND action IN ('central_needs.plan_revision.approval_gate',
                                       'central_needs.plan_revision.supersede', 'central_needs.plan_revision.approve')
                                       AND xmin::text = (SELECT xmin::text FROM central_needs_plan_revisions WHERE id = $2)
                                     ORDER BY action`, [s.rev, rev2]);
        expect(audits.map((a: any) => `${a.action}:${a.entity_id === rev2 ? 'rev2' : 'rev1'}`)).toEqual([
          'central_needs.plan_revision.approval_gate:rev2', 'central_needs.plan_revision.approve:rev2', 'central_needs.plan_revision.supersede:rev1']);
        expect(audits[1].payload).toMatchObject({ predecessor_revision_id: s.rev, predecessor_to_status: 'superseded',
          approval_gate_txid: audits[0].payload.txid });
      });
    });

    // -----------------------------------------------------------------------
    // (l) the A2 deadlock matrix and untranslated lock errors
    // -----------------------------------------------------------------------
    describe('(l) A2 lock order, deadlock matrix and untranslated 40P01/55P03/57014', () => {
      const deadlocks = (outcomes: Outcome[]) => outcomes.filter((o) => o.error?.code === '40P01');

      /** Two (or one) approvals sharing beneficiaries/warehouses, a warehouse status writer and a beneficiary archive. */
      const matrix = async (approvals: 1 | 2, writerVerb: 'COMMIT' | 'ROLLBACK') => {
        const [b1, b2, b3] = [await mkOrg('dl1'), await mkOrg('dl2'), await mkOrg('dl3')];
        const [w1, w2] = [await mkWarehouse(b1), await mkWarehouse(b2)];
        const plans = [await submittedPlan([{ beneficiary: b2, warehouse: w2 }, { beneficiary: b1, warehouse: w1 }, { beneficiary: b3 }])];
        if (approvals === 2) plans.push(await submittedPlan([{ beneficiary: b1, warehouse: w1 }, { beneficiary: b2, warehouse: w2 }, { beneficiary: b3 }]));
        const ww = await held(null, 'superuser', ["SET LOCAL lock_timeout = '30s'"]);
        const approvers = await Promise.all(plans.map(() => held(U_APPROVE, 'authenticated', ["SET LOCAL lock_timeout = '30s'"])));
        const x = await held(null, 'superuser', ["SET LOCAL lock_timeout = '30s'"]);
        const outcomes: Outcome[] = [];
        try {
          outcomes.push(await ww.q(`UPDATE public.warehouses SET status = 'inactive' WHERE id = $1`, [w2]));
          const approving = approvers.map((a, i) => a.q(APPROVE, [plans[i].rev]));
          for (const a of approvers) await waitBlocked(a.pid, ww.pid);
          const archiving = x.q(`UPDATE public.organizations SET status = 'inactive' WHERE id = $1`, [b3]);
          await waitBlocked(x.pid);
          outcomes.push(await (writerVerb === 'COMMIT' ? ww.commit() : ww.rollback()));
          const results = await Promise.all(approving);
          outcomes.push(...results);
          for (const a of approvers) outcomes.push(await a.commit());
          outcomes.push(await archiving);
          outcomes.push(await x.commit());
          return { plans, results, outcomes, b3, w2 };
        } finally {
          await ww.rollback(); await x.rollback();
          for (const a of approvers) await a.rollback();
        }
      };

      it('P6: one approval (beneficiaries then warehouses FOR SHARE) vs a warehouse status writer vs a beneficiary archive — zero 40P01', async () => {
        const m = await matrix(1, 'COMMIT');
        expect(deadlocks(m.outcomes)).toEqual([]);
        expect(m.results[0].error).toMatchObject({ code: '23514', message: 'central_needs_approval_eligibility_changed' });
        expect(m.results[0].error!.detail).toMatch(new RegExp(`warehouse=${m.w2} reason=not_active$`));
        expect(await statuses(m.plans[0].planId)).toEqual(['1:submitted']);
        const [{ archived }] = await admin(`SELECT archived_at IS NOT NULL AS archived FROM organizations WHERE id = $1`, [m.b3]);
        expect(archived).toBe(true);
      }, 60000);

      it('P7: two approvals with shared beneficiaries/warehouses in opposite input order + both writers — zero 40P01, both refuse A2', async () => {
        const m = await matrix(2, 'COMMIT');
        expect(deadlocks(m.outcomes)).toEqual([]);
        for (const r of m.results) expect(r.error).toMatchObject({ code: '23514', message: 'central_needs_approval_eligibility_changed' });
        for (const p of m.plans) {
          expect(await statuses(p.planId)).toEqual(['1:submitted']);
          expect(await gateRows(p.rev)).toEqual([]);
        }
      }, 60000);

      it('P7b: the same shape with the warehouse writer rolled back — zero 40P01 and both approvals commit with their gates', async () => {
        const m = await matrix(2, 'ROLLBACK');
        expect(deadlocks(m.outcomes)).toEqual([]);
        for (const r of m.results) expect(r.ok).toBe(true);
        for (const p of m.plans) {
          expect(await statuses(p.planId)).toEqual(['1:approved']);
          expect(await gateRows(p.rev)).toHaveLength(1);
        }
      }, 60000);

      // ---- TR-3: the lock ORDER itself, observed on held rows -----------------
      /**
       * Two beneficiaries and their own warehouses with FIXED ids (lo < hi),
       * created hi first and designated hi first, so the physical order of the
       * rows and lines is DESCENDING: only an explicit ascending order can
       * lock `lo` before `hi`.
       */
      const orderedPlan = async (tag: string) => {
        const id = (k: string) => `00000000-0000-0000-0000-000000217${k}`;
        const [bLo, bHi, wLo, wHi] = [id(`a${tag}1`), id(`a${tag}2`), id(`b${tag}1`), id(`b${tag}2`)];
        for (const [b, suffix] of [[bHi, 'hi'], [bLo, 'lo']]) {
          await admin(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class)
                       VALUES ($1, $2, $2, $3, 'care_institution', 'hospital')`, [b, `C5 order ${tag} ${suffix}`, `p217-order-${tag}-${suffix}`]);
        }
        for (const [w, b, suffix] of [[wHi, bHi, 'hi'], [wLo, bLo, 'lo']]) {
          await admin(`INSERT INTO warehouses (id, organization_id, name, name_ar, status) VALUES ($1, $2, $3, 'مخزن', 'active')`,
            [w, b, `C5 WH order ${tag} ${suffix}`]);
        }
        const [{ asc }] = await admin(`SELECT $1::uuid < $2::uuid AND $3::uuid < $4::uuid AS asc`, [bLo, bHi, wLo, wHi]);
        expect(asc).toBe(true);
        const s = await submittedPlan([{ beneficiary: bHi, warehouse: wHi }, { beneficiary: bLo, warehouse: wLo }]);
        return { ...s, bLo, bHi, wLo, wHi };
      };
      /** Rolled-back probe: can FOR NO KEY UPDATE NOWAIT take the row at once? false = someone holds a SHARE-or-stronger lock on it. */
      const rowFree = (table: 'organizations' | 'warehouses', rowId: string) => probe(async (c: any) =>
        c.query(`SELECT id FROM public.${table} WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, [rowId]).then(
          (r: any) => { expect(r.rows).toHaveLength(1); return true; },
          (e: any) => { expect(e.code).toBe('55P03'); return false; }));

      it('TR-3: beneficiaries are locked in ascending id order — blocked on the lesser, approve holds NO lock on the greater (nor any warehouse); the writer then takes the greater and nobody deadlocks', async () => {
        const p = await orderedPlan('1');
        const w = await held(null, 'superuser', ["SET LOCAL lock_timeout = '30s'"]);
        const a = await held(U_APPROVE, 'authenticated', ["SET LOCAL lock_timeout = '30s'"]);
        const outcomes: Outcome[] = [];
        try {
          outcomes.push(await w.q(`UPDATE public.organizations SET name = name || '.' WHERE id = $1`, [p.bLo]));
          const approving = a.q(APPROVE, [p.rev]);
          await waitBlocked(a.pid, w.pid);
          // Non-vacuity: the probe does see approve's FOR SHARE (the owner row, taken after the guard).
          expect(await rowFree('organizations', ORG_OWNER)).toBe(false);
          // Ascending: blocked on bLo, approve has not touched bHi — and no warehouse yet (beneficiaries first).
          expect(await rowFree('organizations', p.bHi)).toBe(true);
          expect(await rowFree('warehouses', p.wLo)).toBe(true);
          expect(await rowFree('warehouses', p.wHi)).toBe(true);
          // The writer's second row: with a descending (or physical-order) approve this would deadlock.
          const t = Date.now();
          outcomes.push(await w.q(`UPDATE public.organizations SET name = name || '.' WHERE id = $1`, [p.bHi]));
          expect(Date.now() - t).toBeLessThan(1000);
          outcomes.push(await w.commit());
          const out = await approving;
          outcomes.push(out, await a.commit());
          expect(out.rows?.[0].result).toMatchObject({ ok: true, status: 'approved' });
        } finally { await w.rollback(); await a.rollback(); }
        expect(outcomes.filter((o) => !o.ok)).toEqual([]);
        expect(await statuses(p.planId)).toEqual(['1:approved']);
        expect(await gateRows(p.rev)).toHaveLength(1);
      }, 60000);

      it('TR-3: warehouses are locked AFTER every beneficiary, in ascending id order — blocked on the lesser warehouse, approve holds both beneficiaries and not the greater warehouse; no deadlock', async () => {
        const p = await orderedPlan('2');
        const w = await held(null, 'superuser', ["SET LOCAL lock_timeout = '30s'"]);
        const a = await held(U_APPROVE, 'authenticated', ["SET LOCAL lock_timeout = '30s'"]);
        const outcomes: Outcome[] = [];
        try {
          outcomes.push(await w.q(`UPDATE public.warehouses SET name = name || '.' WHERE id = $1`, [p.wLo]));
          const approving = a.q(APPROVE, [p.rev]);
          await waitBlocked(a.pid, w.pid);
          expect(await rowFree('organizations', p.bLo)).toBe(false);
          expect(await rowFree('organizations', p.bHi)).toBe(false);
          expect(await rowFree('warehouses', p.wHi)).toBe(true);
          const t = Date.now();
          outcomes.push(await w.q(`UPDATE public.warehouses SET name = name || '.' WHERE id = $1`, [p.wHi]));
          expect(Date.now() - t).toBeLessThan(1000);
          outcomes.push(await w.commit());
          const out = await approving;
          outcomes.push(out, await a.commit());
          expect(out.rows?.[0].result).toMatchObject({ ok: true, status: 'approved' });
        } finally { await w.rollback(); await a.rollback(); }
        expect(outcomes.filter((o) => !o.ok)).toEqual([]);
        expect(await statuses(p.planId)).toEqual(['1:approved']);
        expect(await gateRows(p.rev)).toHaveLength(1);
      }, 60000);

      it('57014 from a statement timeout inside approve surfaces untranslated, and nothing is written', async () => {
        const b = await mkOrg('st');
        const wh = await mkWarehouse(b);
        const s = await submittedPlan([{ beneficiary: b, warehouse: wh }]);
        const before = await snapshot(s.rev);
        const p = await held(null, 'superuser');
        const a = await held(U_APPROVE, 'authenticated', ["SET LOCAL lock_timeout = '30s'", "SET LOCAL statement_timeout = '500ms'"]);
        try {
          await p.q(`UPDATE public.warehouses SET name = name || '.' WHERE id = $1`, [wh]);
          const out = await a.q(APPROVE, [s.rev]);
          expect(out.error).toMatchObject({ code: '57014' });
          expect(out.error!.message).toMatch(/statement timeout/);
        } finally { await a.rollback(); await p.rollback(); }
        expect(await snapshot(s.rev)).toEqual(before);
        expect(await gateRows(s.rev)).toEqual([]);
      }, 60000);

      // ---- M217-F1: owner-org archive × approve --------------------------------
      // The guard (211) takes the owner FOR KEY SHARE; approve then upgrades to
      // FOR SHARE (§3). An owner archive between the two holds FOR NO KEY UPDATE
      // (its UPDATE) and asks FOR UPDATE in the M202 archive trigger: a genuine
      // cycle. The window is frozen deterministically by taking the guard's own
      // FOR KEY SHARE first in the approver's transaction. The archive of the
      // SHARED owner is never committed.
      const ownerArchiveCycle = async (approveDeadlockTimeout: string, archiveDeadlockTimeout: string) => {
        const s = await submittedPlan([{ beneficiary: ORG_BENE_A }]);
        const before = await snapshot(s.rev);
        const a = await held(U_APPROVE, 'authenticated', ["SET LOCAL lock_timeout = '30s'",
          `SET LOCAL deadlock_timeout = '${approveDeadlockTimeout}'`,
          `SELECT 1 FROM public.organizations WHERE id = '${ORG_OWNER}' FOR KEY SHARE`]);
        const x = await held(null, 'superuser', ["SET LOCAL lock_timeout = '30s'", `SET LOCAL deadlock_timeout = '${archiveDeadlockTimeout}'`]);
        try {
          const archiving = x.q(`UPDATE public.organizations SET status = 'inactive' WHERE id = $1`, [ORG_OWNER]);
          await waitBlocked(x.pid, a.pid);            // the archive trigger's FOR UPDATE waits on the guard's KEY SHARE
          const approving = a.q(APPROVE, [s.rev]);   // FOR SHARE waits on the archive's NO KEY UPDATE: a cycle
          return { s, before, approving, archiving, a, x };
        } catch (e) {
          await a.rollback(); await x.rollback();
          throw e;
        }
      };

      it('M217-F1: owner archive × approve, approve the victim — 40P01 surfaces untranslated from approve, nothing written; the retry approves', async () => {
        const c = await ownerArchiveCycle('1s', '20s');
        try {
          const approveOut = await c.approving;
          expect(approveOut.error).toMatchObject({ code: '40P01' });
          expect(approveOut.error!.message).toMatch(/deadlock detected/);
          expect(await c.a.rollback()).toEqual({ ok: true });
          // The archive proceeded once approve released the owner (its outcome observed, then discarded).
          expect(await c.archiving).toEqual({ ok: true, rows: [] });
        } finally { await c.x.rollback(); await c.a.rollback(); }
        expect(await snapshot(c.s.rev)).toEqual(c.before);
        expect(await gateRows(c.s.rev)).toEqual([]);
        expect(await statuses(c.s.planId)).toEqual(['1:submitted']);
        const [owner] = await admin(`SELECT status, archived_at FROM organizations WHERE id = $1`, [ORG_OWNER]);
        expect(owner).toEqual({ status: 'active', archived_at: null });
        expect(await call(U_APPROVE, APPROVE, [c.s.rev])).toMatchObject({ ok: true, status: 'approved' });
      }, 60000);

      it('M217-F1: owner archive × approve, the archive the victim — 40P01 surfaces untranslated from the archive, nothing of it written; approve completes with its gate', async () => {
        const c = await ownerArchiveCycle('20s', '3s');
        try {
          const archiveOut = await c.archiving;
          expect(archiveOut.error).toMatchObject({ code: '40P01' });
          expect(archiveOut.error!.message).toMatch(/deadlock detected/);
          expect(await c.x.rollback()).toEqual({ ok: true });
          const approveOut = await c.approving;
          expect(approveOut.ok).toBe(true);
          expect(approveOut.rows![0].result).toMatchObject({ ok: true, status: 'approved' });
          expect(await c.a.commit()).toEqual({ ok: true });
        } finally { await c.x.rollback(); await c.a.rollback(); }
        const [owner] = await admin(`SELECT status, archived_at FROM organizations WHERE id = $1`, [ORG_OWNER]);
        expect(owner).toEqual({ status: 'active', archived_at: null });
        expect(await statuses(c.s.planId)).toEqual(['1:approved']);
        expect(await gateRows(c.s.rev)).toHaveLength(1);
      }, 60000);

      it('55P03 from a lock timeout inside approve surfaces untranslated, and nothing is written', async () => {
        const b = await mkOrg('lt');
        const wh = await mkWarehouse(b);
        const s = await submittedPlan([{ beneficiary: b, warehouse: wh }]);
        const before = await snapshot(s.rev);
        const p = await held(null, 'superuser');
        const a = await held(U_APPROVE, 'authenticated', ["SET LOCAL lock_timeout = '300ms'"]);
        try {
          await p.q(`UPDATE public.warehouses SET name = name || '.' WHERE id = $1`, [wh]);
          const out = await a.q(APPROVE, [s.rev]);
          expect(out.error).toMatchObject({ code: '55P03' });
          expect(out.error!.message).toMatch(/lock timeout/);
        } finally { await a.rollback(); await p.rollback(); }
        expect(await snapshot(s.rev)).toEqual(before);
      }, 60000);

      it('40P01 from a genuine deadlock (non-product reverse-order writer) surfaces untranslated from approve', async () => {
        const b = await mkOrg('dd');
        const wh = await mkWarehouse(b);
        const s = await submittedPlan([{ beneficiary: b, warehouse: wh }]);
        const before = await snapshot(s.rev);
        const p = await held(null, 'superuser', ["SET LOCAL deadlock_timeout = '10s'"]);
        // lock_timeout bounds the wait: an approve that did NOT already hold the beneficiary could not deadlock and must fail, not hang.
        const a = await held(U_APPROVE, 'authenticated', ["SET LOCAL deadlock_timeout = '1s'", "SET LOCAL lock_timeout = '20s'"]);
        try {
          await p.q(`UPDATE public.warehouses SET name = name || '.' WHERE id = $1`, [wh]);
          const approving = a.q(APPROVE, [s.rev]);
          await waitBlocked(a.pid, p.pid);            // approve holds the beneficiary FOR SHARE, waits on the warehouse
          const reverse = p.q(`UPDATE public.organizations SET name = name || '.' WHERE id = $1`, [b]);
          const out = await approving;
          expect(out.error).toMatchObject({ code: '40P01' });
          expect(out.error!.message).toMatch(/deadlock detected/);
          expect((await reverse).ok).toBe(true);
        } finally { await a.rollback(); await p.rollback(); }
        expect(await snapshot(s.rev)).toEqual(before);
      }, 60000);
    });
  });
});
