/** M222-A-GLOCAL-01: paired responses on exact baseline and candidate; LOCAL rig only. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildRig } from '../../../tools/pg-rig/rig.mjs';

// No DB variable means the ordinary quality-only job skips dynamic DB tests.
// A supplied but empty/malformed target must run the guard and fail, never skip.
const run = process.env.PHOENIX_RIG_PG === undefined ? describe.skip : describe;
type RigEnvironment = Partial<Record<'PHOENIX_RIG_PG' | 'PHOENIX_RIG_DB' | 'GITHUB_ACTIONS' | 'CI', string>>;

function assertM222aRigTarget(env: RigEnvironment): 'dedicated-local' | 'github-ci' {
  const refuse = (): never => { throw new Error('M222A rig target not allowed'); };
  const dsn = env.PHOENIX_RIG_PG;
  if (!dsn || !/^postgres(?:ql)?:\/\//.test(dsn) || /[\u0000-\u0020\u007f\\?#]/.test(dsn)) return refuse();
  let target: URL;
  try { target = new URL(dsn); } catch { return refuse(); }
  if (target.username !== 'postgres' || target.pathname !== '/postgres') return refuse();

  if (target.hostname === '127.0.0.1' && target.port === '55741'
    && env.PHOENIX_RIG_DB === 'm222a_disposable') return 'dedicated-local';

  // Exact official CI DSN: no password, query options, alternate hostname or maintenance DB.
  if (dsn === 'postgres://postgres@localhost:55432/postgres'
    && env.GITHUB_ACTIONS === 'true' && env.CI === 'true'
    && (env.PHOENIX_RIG_DB === undefined || env.PHOENIX_RIG_DB === 'phoenix_rig')) return 'github-ci';
  return refuse();
}

describe('M222-A exact disposable target validation (no database side effects)', () => {
  const local: RigEnvironment = { PHOENIX_RIG_PG: 'postgresql://postgres:synthetic@127.0.0.1:55741/postgres',
    PHOENIX_RIG_DB: 'm222a_disposable' };
  const ci: RigEnvironment = { PHOENIX_RIG_PG: 'postgres://postgres@localhost:55432/postgres',
    GITHUB_ACTIONS: 'true', CI: 'true' };
  it.each([
    ['dedicated with password', local, 'dedicated-local'],
    ['dedicated without password', { ...local, PHOENIX_RIG_PG: 'postgres://postgres@127.0.0.1:55741/postgres' }, 'dedicated-local'],
    ['CI default disposable database', ci, 'github-ci'],
    ['CI explicit disposable database', { ...ci, PHOENIX_RIG_DB: 'phoenix_rig' }, 'github-ci'],
  ] as const)('accepts %s', (_label, env, expected) => { expect(assertM222aRigTarget(env)).toBe(expected); });

  it.each([
    ['remote DNS', { ...local, PHOENIX_RIG_PG: 'postgres://postgres@remote.invalid:55741/postgres' }],
    ['remote IP', { ...local, PHOENIX_RIG_PG: 'postgres://postgres@192.0.2.1:55741/postgres' }],
    ['hostname suffix', { ...ci, PHOENIX_RIG_PG: 'postgres://postgres@localhost.remote.invalid:55432/postgres' }],
    ['alternate loopback', { ...local, PHOENIX_RIG_PG: 'postgres://postgres@[::1]:55741/postgres' }],
    ['wrong local port', { ...local, PHOENIX_RIG_PG: 'postgres://postgres@127.0.0.1:55742/postgres' }],
    ['wrong CI port', { ...ci, PHOENIX_RIG_PG: 'postgres://postgres@localhost:55433/postgres' }],
    ['wrong maintenance database', { ...local, PHOENIX_RIG_PG: 'postgres://postgres@127.0.0.1:55741/template1' }],
    ['disposable DB in maintenance DSN', { ...ci, PHOENIX_RIG_PG: 'postgres://postgres@localhost:55432/phoenix_rig' }],
    ['wrong user', { ...local, PHOENIX_RIG_PG: 'postgres://not_postgres@127.0.0.1:55741/postgres' }],
    ['encoded user', { ...local, PHOENIX_RIG_PG: 'postgres://%70ostgres@127.0.0.1:55741/postgres' }],
    ['missing local disposable database', { ...local, PHOENIX_RIG_DB: undefined }],
    ['wrong local disposable database', { ...local, PHOENIX_RIG_DB: 'postgres' }],
    ['wrong CI disposable database', { ...ci, PHOENIX_RIG_DB: 'm222a_disposable' }],
    ['empty CI disposable database', { ...ci, PHOENIX_RIG_DB: '' }],
    ['ambiguous padded database', { ...ci, PHOENIX_RIG_DB: 'phoenix_rig ' }],
    ['database identifier injection', { ...local, PHOENIX_RIG_DB: 'm222a_disposable;SELECT 1' }],
    ['CI missing Actions flag', { ...ci, GITHUB_ACTIONS: undefined }],
    ['CI missing CI flag', { ...ci, CI: undefined }],
    ['CI false flag', { ...ci, CI: 'false' }],
    ['CI nonexact Actions flag', { ...ci, GITHUB_ACTIONS: 'True' }],
    ['CI numeric flag', { ...ci, CI: '1' }],
    ['non-CI use of CI endpoint', { ...ci, CI: undefined, GITHUB_ACTIONS: undefined }],
    ['CI password variant', { ...ci, PHOENIX_RIG_PG: 'postgres://postgres:synthetic@localhost:55432/postgres' }],
    ['CI scheme variant', { ...ci, PHOENIX_RIG_PG: 'postgresql://postgres@localhost:55432/postgres' }],
    ['CI hostname variant', { ...ci, PHOENIX_RIG_PG: 'postgres://postgres@127.0.0.1:55432/postgres' }],
    ['query host override', { ...local, PHOENIX_RIG_PG: local.PHOENIX_RIG_PG + '?host=remote.invalid' }],
    ['empty query marker', { ...local, PHOENIX_RIG_PG: local.PHOENIX_RIG_PG + '?' }],
    ['fragment', { ...local, PHOENIX_RIG_PG: local.PHOENIX_RIG_PG + '#x' }],
    ['wrong protocol', { ...local, PHOENIX_RIG_PG: 'http://postgres@127.0.0.1:55741/postgres' }],
    ['malformed URL', { ...local, PHOENIX_RIG_PG: 'postgres://' }],
    ['empty supplied DSN', { ...local, PHOENIX_RIG_PG: '' }],
    ['missing DSN', { ...local, PHOENIX_RIG_PG: undefined }],
    ['raw whitespace', { ...local, PHOENIX_RIG_PG: ' ' + local.PHOENIX_RIG_PG }],
    ['encoded maintenance database', { ...local, PHOENIX_RIG_PG: 'postgres://postgres@127.0.0.1:55741/%70ostgres' }],
  ] as const)('rejects %s before the rig is called', (_label, env) => {
    expect(() => assertM222aRigTarget(env)).toThrow('M222A rig target not allowed');
  });
});
const EVIDENCE = process.env.M222A_EVIDENCE_DIR;
const phase = process.env.M222A_PHASE ?? 'unspecified';
const ORG = '00000000-0000-4000-8000-0000222a0001';
const OTHER = '00000000-0000-4000-8000-0000222a0002';
const WH = '00000000-0000-4000-8000-0000222a0011';
const WH_OTHER = '00000000-0000-4000-8000-0000222a0012';
const uid = (n: number) => `00000000-0000-4000-8000-${(0x222a1000 + n).toString(16).padStart(12, '0')}`;
const OWNER = uid(1), PEER = uid(2), FOREIGN = uid(3), DENY = uid(4), SCOPE = uid(5), SUSPEND = uid(6);
const ROLE = uid(7), DELETED = uid(8), DELEGATE = uid(9), PEER_DENY = uid(10), NO_ORG = uid(11);
const CORRECTION_ID = '00000000-0000-4000-8000-0000222a2001';
const EXACT_ID = '00000000-0000-4000-8000-0000222a2002';
const ABSENT_ID = '00000000-0000-4000-8000-0000222a2003';
const ABSENT_LOT = '00000000-0000-4000-8000-0000222a2004';

run('M222-A authorization before replay', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let lot: string;
  let SUPER: string;
  const catalogBefore: Record<string, unknown>[] = [];
  const log = (kind: string, value: unknown) => {
    if (EVIDENCE) {
      mkdirSync(EVIDENCE, { recursive: true });
      appendFileSync(join(EVIDENCE, `${phase}-${kind}.jsonl`), JSON.stringify(value) + '\n');
    }
  };
  const admin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));
  const as = (actor: string | null, fn: string, args: any[], role = 'authenticated') =>
    rig.asUser(actor, async (c: any) => (await c.query(
      `SELECT public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) r`, args)).rows[0].r,
    { role, commit: true });
  const generic = (actor: string | null, id: string | null, stock: string | null, type: string | null,
    amount: number | null = 95, gen: number | null = null, reason: string | null = 'historical',
    doc: string | null = 'DOC-A', notes: string | null = 'NOTE-A', role = 'authenticated') =>
    as(actor, 'phoenix_apply_warehouse_stock_movement_guarded', [id, stock, type, amount, reason, gen, doc, notes], role);
  const request = (actor: string, id: string, stock: string, qty: number, reason = 'count', doc: string | null = null,
    notes: string | null = null, gen: number | null = null) =>
    as(actor, 'phoenix_request_warehouse_stock_correction', [id, stock, qty, reason, gen, doc, notes]);
  const error = async (promise: Promise<unknown>) => {
    try { return { success: true, result: await promise }; }
    catch (e: any) { return { success: false, code: e.code, message: e.message,
      detail: e.detail ?? null, detail_present: e.detail !== undefined }; }
  };
  const world = async () => {
    const out: Record<string, unknown> = {};
    for (const table of ['warehouse_stock', 'warehouse_stock_movements', 'phoenix_warehouse_correction_requests', 'audit_logs']) {
      out[table] = (await admin(`SELECT count(*)::int count,
        md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY id),'empty')) hash FROM public.${table} t`)).rows[0];
    }
    return out;
  };
  const newLot = async (qty = 100, reserved = 0) => {
    const id = randomUUID();
    await admin(`INSERT INTO warehouse_stock(id,organization_id,warehouse_id,scientific_name,has_no_national_code,
      has_no_batch_number,batch_number,on_hand_quantity,reserved_quantity,movement_seq)
      VALUES($1,$2,$3,$4,true,false,$4,$5,$6,0)`, [id, ORG, WH, 'M222A-' + id, qty, reserved]);
    return id;
  };
  const catalog = async () => (await admin(`SELECT p.proname,p.oid::regprocedure::text signature,
    r.rolname owner,p.prosecdef,p.proconfig,p.proacl::text,
    md5(p.prosrc) body_hash FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='public' AND p.proname IN
    ('phoenix_apply_warehouse_stock_movement','phoenix_apply_warehouse_stock_movement_guarded',
    'phoenix_request_warehouse_stock_correction','phoenix_approve_warehouse_stock_correction',
    'phoenix_profile_has_scoped_permission') ORDER BY p.proname`)).rows;

  beforeAll(async () => {
    const targetMode = assertM222aRigTarget(process.env);
    log('target-validation', { mode: targetMode, effective_database: process.env.PHOENIX_RIG_DB ?? 'phoenix_rig' });
    // Historical movement fixtures are posted legitimately BEFORE M222, never via a candidate bypass.
    rig = await buildRig({ upTo: 221, log: (m: string) => log('chain', m) });
    SUPER = rig.superAdminId;
    await admin(`INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES
      ($1,'M222A Central','اصطناعي','m222a-p','pharmacy_department_authority',NULL),
      ($2,'M222A Other','اصطناعي','m222a-b','care_institution','hospital')`, [ORG, OTHER]);
    await admin(`INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
      ($1,$3,'M222A Central','اصطناعي','active','central','m222a-wp'),
      ($2,$4,'M222A Other','اصطناعي','active','institution','m222a-wb')`, [WH, WH_OTHER, ORG, OTHER]);
    for (const actor of [OWNER, PEER, FOREIGN, DENY, SCOPE, SUSPEND, ROLE, DELETED, DELEGATE, PEER_DENY, NO_ORG]) {
      const foreign = actor === FOREIGN || actor === DELEGATE;
      await admin('INSERT INTO auth.users(id,email) VALUES($1,$2)', [actor, actor + '@m222a.invalid']);
      await admin(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id=$2 WHERE id=$1`,
        [actor, foreign ? OTHER : ORG]);
      await admin(`INSERT INTO profile_scope_assignments(profile_id,organization_id,scope_type,warehouse_id,is_active)
        VALUES($1,$2,'warehouse',$3,true)`, [actor, foreign ? OTHER : ORG, foreign ? WH_OTHER : WH]);
    }
    lot = await newLot();
    await generic(OWNER, CORRECTION_ID, lot, 'correction', 95);
    await generic(OWNER, EXACT_ID, lot, 'set_exact', 90);
    const historical = (await admin(`SELECT reference_id,actor_id,movement_type,request_fingerprint,on_hand_before,
      on_hand_after,reason_code FROM warehouse_stock_movements WHERE reference_id IN ($1,$2) ORDER BY reference_id`,
    [CORRECTION_ID, EXACT_ID])).rows;
    expect(historical).toHaveLength(2);
    log('historical-fixtures', { lot, historical, created_under: 'M221/M186 generic writer before M222' });
    // Mutations here affect disposable identity fixtures only.
    for (const actor of [DENY, PEER_DENY]) await as(SUPER, 'assign_profile_permissions',
      [actor, { 'warehouse_stock.correct': false, 'warehouse_stock.adjust': false }]);
    await admin(`UPDATE profile_scope_assignments SET is_active=false,revoked_at=now(),revoked_by=$2,
      revoke_reason='M222A synthetic' WHERE profile_id=$1`, [SCOPE, SUPER]);
    await admin(`UPDATE profiles SET status='suspended' WHERE id=$1`, [SUSPEND]);
    await admin(`UPDATE profiles SET role='outlet_officer' WHERE id=$1`, [ROLE]);
    await admin('DELETE FROM profiles WHERE id=$1', [DELETED]);
    await admin('UPDATE profiles SET organization_id=NULL WHERE id=$1', [NO_ORG]);
    const grant = await as(SUPER, 'phoenix_admin_grant_delegated_scope', [DELEGATE, ORG, 'warehouse', WH, null, false]);
    await as(SUPER, 'phoenix_admin_revoke_delegated_scope', [grant.assignment_id, null, 'M222A synthetic']);
    catalogBefore.push(...await catalog());
    const sqlPath = 'supabase/migrations/222_phoenix_governed_warehouse_correction_security.sql';
    const baselineMode = process.env.M222A_SQL_VARIANT === 'baseline';
    const sql = baselineMode
      ? execFileSync('git', ['--no-optional-locks', 'show', 'bc602c068fd7224e756b6167fdf4adb11309a633:' + sqlPath], { encoding: 'utf8' })
      : readFileSync(resolve(sqlPath), 'utf8');
    const sqlHash = createHash('sha256').update(sql).digest('hex');
    if (baselineMode) expect(sqlHash).toBe('b2bb6640ed5b506ad09f48fa5744897925e85a3f900e174de5ea20ff3701554a');
    log('sql-pin', { sha256: sqlHash, baselineMode });
    await rig.asAdmin((c: any) => c.query(sql));
    log('catalog', { before: catalogBefore, after: await catalog() });
  }, 600_000);
  afterAll(async () => { if (rig) await rig.end(); });

  it('A-RED/GREEN unauthorized known/unknown SQLSTATE MESSAGE DETAIL are identical with zero persistent delta', async () => {
    const callers: Array<[string, string | null]> = [['cross-org', FOREIGN], ['same-org-no-permission', PEER_DENY],
      ['permission-revoked', DENY], ['scope-revoked', SCOPE], ['suspended', SUSPEND], ['role-revoked', ROLE],
      ['deleted-profile', DELETED], ['delegation-revoked', DELEGATE], ['unassigned-org', NO_ORG],
      ['missing-profile', uid(99)], ['sentinel', '00000000-0000-0000-0000-000000000000'], ['null-auth', null]];
    const before = await world();
    const mismatches: unknown[] = [];
    let pairs = 0;
    for (const [label, actor] of callers) for (const id of [CORRECTION_ID, EXACT_ID]) {
      for (const type of ['correction', 'set_exact', 'add', 'subtract', 'invalid', null]) {
        for (const stock of [lot, ABSENT_LOT, null]) for (const gen of [null, 999]) {
          const known = await error(generic(actor, id, stock, type, 95, gen));
          const unused = await error(generic(actor, ABSENT_ID, stock, type, 95, gen));
          const row = { label, actor, id, stock, type, gen, known, unused, equal: JSON.stringify(known) === JSON.stringify(unused) };
          log('paired', row);
          if (!row.equal || known.success || unused.success) mismatches.push(row);
          pairs++;
        }
      }
    }
    const after = await world();
    log('zero-delta', { before, after, equal: JSON.stringify(before) === JSON.stringify(after), pairs, mismatches: mismatches.length });
    expect(after).toEqual(before);
    expect(mismatches, `all ${pairs} paired responses; complete raw census retained`).toEqual([]);
  }, 180_000);

  it('A anon cannot EXECUTE and null request controls remain constant', async () => {
    const before = await world();
    for (const id of [CORRECTION_ID, ABSENT_ID]) {
      const r = await error(generic(FOREIGN, id, lot, 'correction', 95, null, 'historical', 'DOC-A', 'NOTE-A', 'anon'));
      expect(r).toMatchObject({ code: '42501' });
      log('anon', r);
    }
    const controls = await Promise.all([CORRECTION_ID, ABSENT_ID].map(() => error(generic(FOREIGN, null, lot, 'correction'))));
    expect(controls[0]).toEqual(controls[1]);
    expect(controls[0]).toMatchObject({ code: '23514', message: 'request_id_required' });
    expect(await world()).toEqual(before);
  });

  it('A original historical correction/set_exact replays remain actor/payload bound with stale generation', async () => {
    const before = await world();
    for (const [id, type, qty] of [[CORRECTION_ID, 'correction', 95], [EXACT_ID, 'set_exact', 90]] as const) {
      expect(await generic(OWNER, id, lot, type, qty, 999)).toMatchObject({ ok: true, idempotent_replay: true });
      expect(await error(generic(PEER, id, lot, type, qty))).toMatchObject({ code: '42501', message: 'warehouse_correction_requires_governed_request' });
      for (const args of [[qty + 1, 'historical', 'DOC-A', 'NOTE-A'], [qty, 'different', 'DOC-A', 'NOTE-A'],
        [qty, 'historical', 'DOC-B', 'NOTE-A'], [qty, 'historical', 'DOC-A', 'NOTE-B']] as const) {
        expect(await error(generic(OWNER, id, lot, type, args[0], null, args[1], args[2], args[3])))
          .toMatchObject({ code: '23505', message: 'request_id_conflict' });
      }
    }
    expect(await world()).toEqual(before);
    const otherLot = await newLot();
    const afterFixture = await world();
    expect(await error(generic(OWNER, CORRECTION_ID, otherLot, 'correction'))).toMatchObject({ code: '23505' });
    expect(await world()).toEqual(afterFixture);
    log('legitimate-historical-replay', { before, replay_writes: 0, otherLot });
  });

  it('A current authorization is required even for the original historical requester', async () => {
    await as(SUPER, 'assign_profile_permissions', [OWNER, { 'warehouse_stock.correct': false }]);
    try {
      const before = await world();
      const known = await error(generic(OWNER, CORRECTION_ID, lot, 'correction'));
      const unused = await error(generic(OWNER, ABSENT_ID, lot, 'correction'));
      log('revoked-owner', { known, unused });
      expect(known).toEqual(unused);
      expect(known.success).toBe(false);
      expect(await world()).toEqual(before);
    } finally { await as(SUPER, 'assign_profile_permissions', [OWNER, { 'warehouse_stock.correct': true }]); }
  });

  it('A queued approved rejected applied states keep exact replay and reject every changed payload field', async () => {
    const otherLot = await newLot();
    const states: Array<[string, string, number]> = [];
    for (const state of ['pending', 'approved', 'rejected', 'applied']) {
      const l = await newLot();
      await as(SUPER, 'phoenix_set_variance_approval_policy', [ORG, state === 'applied' ? 200 : 0]);
      const id = randomUUID();
      const qty = state === 'applied' ? 22 : 20;
      const first = await request(OWNER, id, l, qty, 'state-count', 'D', 'N');
      if (state === 'approved') await as(SUPER, 'phoenix_approve_warehouse_stock_correction', [first.correction_request_id, null]);
      if (state === 'rejected') await as(SUPER, 'phoenix_reject_warehouse_stock_correction', [first.correction_request_id, 'synthetic reject']);
      const before = await world();
      const replay = await request(OWNER, id, l, qty, 'state-count', 'D', 'N', 999);
      expect(replay).toMatchObject({ ok: true, idempotent_replay: true });
      if (state !== 'applied') expect(replay.status).toBe(state);
      for (const args of [[l, qty + 1, 'state-count', 'D', 'N'], [l, qty, 'different', 'D', 'N'],
        [l, qty, 'state-count', 'D2', 'N'], [l, qty, 'state-count', 'D', 'N2'], [otherLot, qty, 'state-count', 'D', 'N']] as const) {
        expect(await error(request(OWNER, id, args[0], args[1], args[2], args[3], args[4])))
          .toMatchObject({ code: '23505', message: 'request_id_conflict' });
      }
      expect(await world()).toEqual(before);
      states.push([state, id, qty]);
    }
    log('state-replays', states);
    await as(SUPER, 'phoenix_set_variance_approval_policy', [ORG, 0]);
  });

  it('A duplicate-ID generic/request race posts once and identical concurrent requests stay idempotent', async () => {
    await as(SUPER, 'phoenix_set_variance_approval_policy', [ORG, 200]);
    try {
      const l = await newLot();
      const id = randomUUID();
      const results = await Promise.allSettled([
        request(OWNER, id, l, 80, 'race', 'R', null),
        generic(OWNER, id, l, 'correction', 80, null, 'race', 'R', null),
      ]);
      expect(results[0].status).toBe('fulfilled');
      if (results[1].status === 'rejected') expect(results[1].reason.message).toBe('warehouse_correction_requires_governed_request');
      else expect(results[1].value.idempotent_replay).toBe(true);
      const retry = await Promise.all(Array.from({ length: 6 }, () => request(OWNER, id, l, 80, 'race', 'R', null)));
      const count = (await admin(`SELECT count(*)::int n FROM warehouse_stock_movements WHERE reference_id=$1`, [id])).rows[0].n;
      const stock = (await admin('SELECT on_hand_quantity,movement_seq FROM warehouse_stock WHERE id=$1', [l])).rows[0];
      expect(count).toBe(1);
      expect(stock.on_hand_quantity).toBe(80);
      expect(retry.every((r: any) => r.idempotent_replay)).toBe(true);
      log('concurrency', { id, results, retry, count, stock });
    } finally { await as(SUPER, 'phoenix_set_variance_approval_policy', [ORG, 0]); }
  }, 60_000);

  it('A catalog contracts, unchanged canonical/approve/helper, no overload or privilege widening', async () => {
    const after = await catalog();
    expect(after).toHaveLength(5);
    for (const before of catalogBefore) {
      const current = after.find((r: any) => r.proname === before.proname);
      if (before.proname === 'phoenix_apply_warehouse_stock_movement_guarded'
        || before.proname === 'phoenix_request_warehouse_stock_correction') {
        expect({ ...current, body_hash: null }).toEqual({ ...before, body_hash: null });
      } else expect(current).toEqual(before);
    }
    const rows = (await admin(`SELECT p.proname,r.rolname,has_function_privilege(r.oid,p.oid,'EXECUTE') allowed
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN pg_roles r
      WHERE n.nspname='public' AND p.proname IN ('phoenix_apply_warehouse_stock_movement',
      '_phoenix_apply_governed_warehouse_correction') AND r.rolname IN ('authenticated','anon')`)).rows;
    expect(rows.every((r: any) => !r.allowed)).toBe(true);
    log('effective-acl', rows);
    const identity = await rig.asUser(OWNER, (c: any) => c.query(
      `SELECT current_user,session_user,auth.uid(),(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`));
    expect(identity.rows[0]).toMatchObject({ current_user: 'authenticated', uid: OWNER, superuser: false });
    log('low-privilege-identity', identity.rows);
  });

  it('A every catalogued application role including super_admin is refused fresh direct correction/set_exact', async () => {
    const roles = (await admin('SELECT DISTINCT role FROM role_permission_defaults ORDER BY role')).rows;
    const sector = randomUUID();
    await admin(`INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class,status)
      VALUES($1,'M222A Sector','قطاع اصطناعي',$2,'care_institution','health_sector','active')`, [sector, 'm222a-' + sector]);
    const tested: string[] = [];
    for (const { role } of roles) {
      const actor = randomUUID();
      await admin('INSERT INTO auth.users(id,email) VALUES($1,$2)', [actor, actor + '@allroles.invalid']);
      await admin(`UPDATE profiles SET role=$2,status='active',organization_id=$3 WHERE id=$1`,
        [actor, role, role === 'health_center_manager' ? sector : ORG]);
      // M182 permits only facility assignments for this role; no scope is needed to test a direct-call refusal.
      if (role !== 'health_center_manager') await admin(`INSERT INTO profile_scope_assignments(profile_id,organization_id,scope_type,warehouse_id,is_active)
        VALUES($1,$2,'warehouse',$3,true)`, [actor, ORG, WH]);
      const before = await world();
      for (const type of ['correction', 'set_exact']) {
        const r = await error(generic(actor, randomUUID(), lot, type));
        expect(r).toMatchObject({ code: '42501', message: 'warehouse_correction_requires_governed_request' });
        log('all-role-direct-refusal', { role, type, r });
      }
      expect(await world()).toEqual(before);
      tested.push(role);
    }
    expect(tested).toContain('super_admin');
    log('all-role-census', tested);
  });

  it('A invalid amount/reason inputs do not recreate the unauthorized known/unknown oracle', async () => {
    const before = await world();
    for (const type of ['correction', 'set_exact', 'add', null]) {
      for (const amount of [null, -1, 0, 1]) for (const reason of [null, '', 'historical']) {
        const known = await error(generic(FOREIGN, CORRECTION_ID, lot, type, amount, null, reason));
        const unused = await error(generic(FOREIGN, ABSENT_ID, lot, type, amount, null, reason));
        log('invalid-paired', { type, amount, reason, known, unused });
        expect(known).toEqual(unused);
      }
    }
    expect(await world()).toEqual(before);
  });

  it('A authorized substitute lot and authorized same-org peer cannot probe another actors correction IDs', async () => {
    const decoy = randomUUID();
    await admin(`INSERT INTO warehouse_stock(id,organization_id,warehouse_id,scientific_name,has_no_national_code,
      has_no_batch_number,batch_number,on_hand_quantity,reserved_quantity,movement_seq)
      VALUES($1::uuid,$2,$3,'M222A foreign decoy',true,false,($1::uuid)::text,100,0,0)`, [decoy, OTHER, WH_OTHER]);
    const before = await world();
    for (const [actor, suppliedLot] of [[FOREIGN, decoy], [PEER, lot]]) {
      for (const id of [CORRECTION_ID, EXACT_ID]) for (const type of ['correction', 'set_exact']) {
        const known = await error(generic(actor, id, suppliedLot, type));
        const unused = await error(generic(actor, ABSENT_ID, suppliedLot, type));
        log('decoy-lot-paired', { actor, suppliedLot, id, type, known, unused });
        expect(known).toEqual(unused);
        expect(known).toMatchObject({ code: '42501', message: 'warehouse_correction_requires_governed_request' });
      }
    }
    expect(await world()).toEqual(before);
  });

  it('A inherited B stock existence and C generation diagnostics remain unchanged and separate', async () => {
    const knownStock = await error(request(FOREIGN, randomUUID(), lot, 1));
    const missingStock = await error(request(FOREIGN, randomUUID(), ABSENT_LOT, 1));
    expect(knownStock).toMatchObject({ code: '42501' });
    expect(missingStock).toMatchObject({ code: 'P0002' });
    const generation = await error(generic(FOREIGN, randomUUID(), lot, 'add', 1, 999));
    expect(generation).toMatchObject({ code: '40001', message: 'warehouse_receipt_generation_conflict' });
    expect((generation as any).detail).toContain('canonical generation');
    log('inherited-B-C-not-fixed', { knownStock, missingStock, generation });
  });
});
