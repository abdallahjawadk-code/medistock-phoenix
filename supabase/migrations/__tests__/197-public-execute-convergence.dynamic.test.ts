/**
 * M197 — POSTGRESQL PUBLIC EXECUTE CONVERGENCE — dynamic proof.
 *
 * Replays 001→196 onto a disposable database, exercises the real behaviour
 * that PUBLIC EXECUTE currently underwrites, applies M197, and exercises the
 * SAME behaviour again. The point is not that the ACL changed — the migration's
 * own VERIFY proves that — but that removing the widest grant in the cluster
 * changed nothing a legitimate caller can observe.
 *
 * Every "still works" assertion below is a real call or a real write. None of
 * them is satisfied by has_function_privilege() alone, because an effective
 * privilege inherited through PUBLIC would have answered true before M197 and
 * would prove nothing about what happens after it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const run = rigAvailable() ? describe : describe.skip;

const SQL_197 = readFileSync(join(__dirname, '..', '197_phoenix_public_execute_convergence.sql'), 'utf8');

const ORG   = '00000000-0000-0000-0000-000000197001';
const WH    = '00000000-0000-0000-0000-000000197201';
const DP    = '00000000-0000-0000-0000-000000197301';
const QRT   = '00000000-0000-0000-0000-000000197501';
const QTK   = '00000000-0000-0000-0000-000000197601';
const PUB_ID = 'M197PUBLICQR0001';
const USER_A = '00000000-0000-0000-0000-000000197701';
const USER_B = '00000000-0000-0000-0000-000000197702';

const SIX = [
  'public.get_public_qr_payload(text)',
  'public.phoenix_my_org()',
  'public.phoenix_my_role()',
  'public.phoenix_guard_dp_archive_update()',
  'public.phoenix_handle_new_user()',
  'public.phoenix_populate_actor_snapshot()',
];

const ACL_SQL = `
  SELECT t.sig,
         (SELECT coalesce(string_agg(coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC')||'='||a.privilege_type,
                  ',' ORDER BY (coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC')||'='||a.privilege_type) COLLATE "C"),'')
            FROM aclexplode(p.proacl) a) AS acl,
         p.oid::text AS fn_oid, md5(p.prosrc) AS body, pg_get_userbyid(p.proowner) AS owner,
         coalesce(array_to_string(p.proconfig,'; '),'') AS cfg, p.prosecdef,
         pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS res,
         p.provolatile, p.proisstrict, p.proparallel, p.proleakproof
    FROM unnest($1::text[]) AS t(sig)
    JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
   ORDER BY t.sig`;

const PUBLIC_SECDEF_SQL = `
  SELECT count(*)::int AS n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
     AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                  WHERE a.grantee=0 AND a.privilege_type='EXECUTE')`;

const TRIGGERS_SQL = `
  SELECT tn.nspname||'.'||tc.relname||':'||tg.tgname AS binding, tp.proname AS fn
    FROM pg_trigger tg JOIN pg_proc tp ON tp.oid=tg.tgfoid
    JOIN pg_class tc ON tc.oid=tg.tgrelid JOIN pg_namespace tn ON tn.oid=tc.relnamespace
   WHERE NOT tg.tgisinternal AND tp.proname = ANY($1) ORDER BY 1`;
const TRIG_FNS = ['phoenix_guard_dp_archive_update', 'phoenix_handle_new_user', 'phoenix_populate_actor_snapshot'];

run('M197 · PostgreSQL PUBLIC EXECUTE convergence · dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  let aclBefore: any[]; let aclAfter: any[];
  let publicBefore: number; let publicAfter: number;
  let trigBefore: any[]; let trigAfter: any[];
  let policiesBefore: any[]; let policiesAfter: any[];

  let qrAnonBefore: any; let qrAnonAfter: any;
  let qrAuthBefore: any; let qrAuthAfter: any;
  let rlsBefore: any; let rlsAfter: any;
  let snapshotBefore: any; let snapshotAfter: any;
  let newUserBefore: any; let newUserAfter: any;

  /** Real anonymous call, exactly as the public QR portal reaches it. */
  const qrAsAnon = () => rig.asUser(null, (c: any) =>
    c.query('SELECT public.get_public_qr_payload($1) AS payload', [PUB_ID]).then((r: any) => r.rows[0].payload),
    { role: 'anon' });

  const qrAsAuthenticated = () => rig.asUser(USER_A, (c: any) =>
    c.query('SELECT public.get_public_qr_payload($1) AS payload', [PUB_ID]).then((r: any) => r.rows[0].payload));

  /**
   * A real RLS-filtered read as an authenticated member of ORG. The policies on
   * organizations call phoenix_my_org()/phoenix_my_role(), so this only returns
   * a row while authenticated genuinely holds EXECUTE on those helpers.
   */
  const rlsRead = () => rig.asUser(USER_A, (c: any) =>
    c.query('SELECT id, name FROM public.organizations WHERE id = $1', [ORG]).then((r: any) => r.rows));

  /** A real write that fires trg_actor_snapshot on qr_tokens. */
  const fireActorSnapshot = (tokenId: string, publicId: string) => rig.asAdmin(async (c: any) => {
    await c.query(
      // status 'disabled': qr_tokens_active_per_target permits only one ACTIVE
      // token per target, and the actor-snapshot trigger fires on INSERT either
      // way — the probe is about the trigger, not about token state.
      `INSERT INTO public.qr_tokens (id, qr_target_id, organization_id, public_id, token_hash, status)
       VALUES ($1, $2, $3, $4, 'hash-' || $4, 'disabled')`, [tokenId, QRT, ORG, publicId]);
    const r = await c.query('SELECT count(*)::int AS n FROM public.qr_tokens WHERE id = $1', [tokenId]);
    return r.rows[0].n;
  }, { commit: true });

  /** A real auth.users insert that fires on_auth_user_created. */
  const fireNewUser = (userId: string, email: string) => rig.asAdmin(async (c: any) => {
    await c.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data)
       VALUES ($1, $2, jsonb_build_object('full_name','M197 Probe','role','outlet_officer'))`, [userId, email]);
    const r = await c.query('SELECT count(*)::int AS n FROM public.profiles WHERE id = $1', [userId]);
    return r.rows[0].n;
  }, { commit: true });

  beforeAll(async () => {
    rig = await buildRig({ upTo: 196 });

    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO auth.users (id, email, raw_user_meta_data)
         VALUES ($1,$2, jsonb_build_object('full_name','M197 Member','role','super_admin'))`,
        [USER_A, 'm197-member@phoenix.local']);
      await c.query(
        `INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class)
         VALUES ($1,'M197 Org','M197 Org','197-org','care_institution','hospital')
         ON CONFLICT (id) DO NOTHING`, [ORG]);
      await c.query(
        `UPDATE public.profiles SET organization_id=$2, role='super_admin', status='active' WHERE id=$1`,
        [USER_A, ORG]);
      await c.query(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
         VALUES ($1,$2,'M197 WH','M197 WH','institution',NULL,false,'active')
         ON CONFLICT (id) DO NOTHING`, [WH, ORG]);
      await c.query(
        `INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ($1,$2,$3,'M197 DP','M197 DP','pharmacy','active','non_emergency')
         ON CONFLICT (id) DO NOTHING`, [DP, WH, ORG]);
      await c.query(
        `INSERT INTO qr_targets (id,organization_id,target_type,target_id,label,status)
         VALUES ($1,$2,'distribution_point',$3,'M197 Point','active')
         ON CONFLICT (id) DO NOTHING`, [QRT, ORG, DP]);
      await c.query(
        `INSERT INTO qr_tokens (id,qr_target_id,organization_id,public_id,token_hash,status)
         VALUES ($1,$2,$3,$4,'hash-197','active')
         ON CONFLICT (id) DO NOTHING`, [QTK, QRT, ORG, PUB_ID]);
    }, { commit: true });

    aclBefore      = (await rig.asAdmin((c: any) => c.query(ACL_SQL, [SIX]))).rows;
    publicBefore   = (await rig.asAdmin((c: any) => c.query(PUBLIC_SECDEF_SQL))).rows[0].n;
    trigBefore     = (await rig.asAdmin((c: any) => c.query(TRIGGERS_SQL, [TRIG_FNS]))).rows;
    policiesBefore = (await rig.asAdmin((c: any) => c.query(
      `SELECT tablename, policyname, cmd, coalesce(qual,'') q, coalesce(with_check,'') w
         FROM pg_policies WHERE schemaname='public' ORDER BY 1,2`))).rows;

    qrAnonBefore    = await qrAsAnon();
    qrAuthBefore    = await qrAsAuthenticated();
    rlsBefore       = await rlsRead();
    snapshotBefore  = await fireActorSnapshot('00000000-0000-0000-0000-000000197611', 'M197PROBEBEFORE1');
    newUserBefore   = await fireNewUser(USER_B, 'm197-before@phoenix.local');

    await rig.asAdmin((c: any) => c.query(SQL_197), { commit: true });

    aclAfter      = (await rig.asAdmin((c: any) => c.query(ACL_SQL, [SIX]))).rows;
    publicAfter   = (await rig.asAdmin((c: any) => c.query(PUBLIC_SECDEF_SQL))).rows[0].n;
    trigAfter     = (await rig.asAdmin((c: any) => c.query(TRIGGERS_SQL, [TRIG_FNS]))).rows;
    policiesAfter = (await rig.asAdmin((c: any) => c.query(
      `SELECT tablename, policyname, cmd, coalesce(qual,'') q, coalesce(with_check,'') w
         FROM pg_policies WHERE schemaname='public' ORDER BY 1,2`))).rows;

    qrAnonAfter   = await qrAsAnon();
    qrAuthAfter   = await qrAsAuthenticated();
    rlsAfter      = await rlsRead();
    snapshotAfter = await fireActorSnapshot('00000000-0000-0000-0000-000000197612', 'M197PROBEAFTER01');
    newUserAfter  = await fireNewUser('00000000-0000-0000-0000-000000197703', 'm197-after@phoenix.local');
  }, 900_000);

  afterAll(async () => { await rig?.end(); });

  it('replays 001→196, then applies M197 including its fail-closed preconditions and VERIFY', () => {
    expect(aclBefore).toHaveLength(6);
    expect(aclAfter).toHaveLength(6);
  });

  it('starts from exactly six PUBLIC-executable SECURITY DEFINER routines and ends with none', () => {
    expect(publicBefore).toBe(6);
    expect(publicAfter).toBe(0);
  });

  it('converges each ACL to the exact reviewed posture', () => {
    const acl = (rows: any[], sig: string) => rows.find((r) => r.sig === sig).acl;
    expect(acl(aclBefore, 'public.phoenix_my_org()')).toBe('PUBLIC=EXECUTE,postgres=EXECUTE,service_role=EXECUTE');
    expect(acl(aclAfter,  'public.phoenix_my_org()')).toBe('authenticated=EXECUTE,postgres=EXECUTE,service_role=EXECUTE');

    expect(acl(aclAfter, 'public.phoenix_my_role()'))
      .toBe('authenticated=EXECUTE,phoenix_demo_purger=EXECUTE,postgres=EXECUTE,service_role=EXECUTE');

    expect(acl(aclAfter, 'public.get_public_qr_payload(text)'))
      .toBe('anon=EXECUTE,authenticated=EXECUTE,postgres=EXECUTE,service_role=EXECUTE');

    for (const t of ['public.phoenix_guard_dp_archive_update()', 'public.phoenix_handle_new_user()',
                     'public.phoenix_populate_actor_snapshot()']) {
      expect(acl(aclAfter, t), t).toBe('postgres=EXECUTE,service_role=EXECUTE');
    }
  });

  it('changes ONLY the ACL: oid, body, owner, search_path, signature and every attribute survive', () => {
    const strip = ({ acl: _acl, ...rest }: any) => rest;
    expect(aclAfter.map(strip)).toEqual(aclBefore.map(strip));
  });

  // ── behaviour, not privilege bits ───────────────────────────────────────────

  it('keeps the anonymous QR portal working — a real anon call returns the same payload', () => {
    expect(qrAnonBefore).toBeTruthy();
    expect(qrAnonAfter).toBeTruthy();
    expect(qrAnonAfter).toEqual(qrAnonBefore);
  });

  it('keeps the authenticated QR path working, unchanged', () => {
    expect(qrAuthBefore).toBeTruthy();
    expect(qrAuthAfter).toEqual(qrAuthBefore);
  });

  it('keeps authenticated RLS reads working — the policies call the helpers that lost PUBLIC', () => {
    expect(rlsBefore).toHaveLength(1);
    expect(rlsAfter).toEqual(rlsBefore);
  });

  it('keeps every trigger firing: actor snapshot and new-user still run after the revoke', () => {
    expect(snapshotBefore).toBe(1);
    expect(snapshotAfter).toBe(1);
    expect(newUserBefore).toBe(1);
    expect(newUserAfter).toBe(1);
  });

  it('leaves all eight trigger bindings and every RLS policy untouched', () => {
    expect(trigAfter).toEqual(trigBefore);
    expect(trigAfter).toHaveLength(8);
    expect(policiesAfter).toEqual(policiesBefore);
  });

  // ── the boundary that PUBLIC used to blur ───────────────────────────────────

  it('closes anon and authenticated out of the trigger-only routines entirely', async () => {
    const rows = (await rig.asAdmin((c: any) => c.query(`
      SELECT t.sig,
             has_function_privilege('anon', t.sig::regprocedure, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', t.sig::regprocedure, 'EXECUTE') AS auth,
             has_function_privilege('service_role', t.sig::regprocedure, 'EXECUTE') AS svc
        FROM unnest($1::text[]) AS t(sig)`,
      [['public.phoenix_guard_dp_archive_update()', 'public.phoenix_handle_new_user()',
        'public.phoenix_populate_actor_snapshot()']]))).rows;
    for (const r of rows) {
      expect(r.anon, r.sig).toBe(false);
      expect(r.auth, r.sig).toBe(false);
      expect(r.svc, r.sig).toBe(true);
    }
  });

  it('stops anon reaching the identity helpers while authenticated keeps them', async () => {
    const r = (await rig.asAdmin((c: any) => c.query(`
      SELECT has_function_privilege('anon','public.phoenix_my_org()','EXECUTE') AS anon_org,
             has_function_privilege('anon','public.phoenix_my_role()','EXECUTE') AS anon_role,
             has_function_privilege('authenticated','public.phoenix_my_org()','EXECUTE') AS auth_org,
             has_function_privilege('authenticated','public.phoenix_my_role()','EXECUTE') AS auth_role,
             has_function_privilege('phoenix_demo_purger','public.phoenix_my_role()','EXECUTE') AS purger_role`))).rows[0];
    expect(r.anon_org).toBe(false);
    expect(r.anon_role).toBe(false);
    expect(r.auth_org).toBe(true);
    expect(r.auth_role).toBe(true);
    expect(r.purger_role).toBe(true);
  });

  it('refuses a direct client call to a trigger-only routine', async () => {
    // Two independent reasons this must fail, and the test accepts either:
    // the privilege is gone (42501), and a trigger-returning function cannot be
    // invoked as an ordinary statement anyway (0A000).
    await expect(rig.asUser(USER_A, (c: any) =>
      c.query('SELECT public.phoenix_populate_actor_snapshot()'))).rejects.toThrow();
  });

  it('is fail-closed on re-application: the preconditions refuse an already-converged database', async () => {
    // Not idempotent by design. Re-running must be refused loudly rather than
    // silently re-issuing privilege statements against an unexpected state.
    await expect(rig.asAdmin((c: any) => c.query(SQL_197))).rejects.toThrow(/M197 PRECONDITION/);
  });
});
