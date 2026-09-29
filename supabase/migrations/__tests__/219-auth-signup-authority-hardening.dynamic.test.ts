/**
 * AUTH-1 / M219 — DYNAMIC proof on a disposable rig (001 -> 219).
 *
 *   * Sign-up metadata is never authority: whatever role / status /
 *     organization / permission keys the client supplies, a new Auth user gets
 *     the non-authoritative placeholder (pending_provisioning, suspended, no
 *     organization); a later metadata change has no RBAC effect.
 *   * The sentinel fails closed: zero permission defaults, no permission, every
 *     probed privileged surface denies it, and SQL comparisons on it are always
 *     definite booleans (never NULL).
 *   * get_effective_permissions: super_admin, self, or the SAME NON-NULL
 *     organization — truth table A-J.
 *   * The sentinel is on no role-assignment interface.
 *   * Trusted admin provisioning still works end to end, exactly once, and
 *     every negative case is denied with its audited reason.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ hookTimeout: 300_000, testTimeout: 60_000 });

const run = rigAvailable() ? describe : describe.skip;

const ROOT = '00000000-0000-0000-0000-0000000000a1'; // rig seed: active super_admin, no organization
const ORG_A = '21900000-0000-4000-8000-0000000000a0';
const ORG_B = '21900000-0000-4000-8000-0000000000b0';
const INST_A = '21900000-0000-4000-8000-000000000a01';     // institution_admin, org A
const OFFICER_A = '21900000-0000-4000-8000-000000000a02';  // warehouse_officer, org A
const OFFICER_A2 = '21900000-0000-4000-8000-000000000a03'; // warehouse_officer, org A
const OFFICER_B = '21900000-0000-4000-8000-000000000b02';  // warehouse_officer, org B
const NOORG_ACTOR = '21900000-0000-4000-8000-000000000c01';  // active outlet_officer, no organization
const NOORG_TARGET = '21900000-0000-4000-8000-000000000c02'; // active outlet_officer, no organization
const SUSP_SUPER = '21900000-0000-4000-8000-000000000c03';   // suspended super_admin
const PENDING = '21900000-0000-4000-8000-000000000d01';      // self-registered, metadata claims super_admin

const SENTINEL = 'pending_provisioning';
const METADATA_ROLES = ['super_admin', 'institution_admin', 'central_warehouse_manager', 'warehouse_officer',
  'outlet_officer', 'health_center_manager'];

type Rig = Awaited<ReturnType<typeof buildRig>>;
type Json = Record<string, unknown>;

let seq = 0;
const nextId = () => `21900000-0000-4000-8000-${(0xe0000 + (seq += 1)).toString(16).padStart(12, '0')}`;

run('migration 219 — sign-up authority hardening (dynamic)', () => {
  let rig: Rig;

  const admin = <T>(fn: (c: any) => Promise<T>) => rig.asAdmin(fn);
  const asUser = <T>(id: string, fn: (c: any) => Promise<T>) => rig.asUser(id, fn);
  const profile = async (id: string) => (await admin((c) => c.query(
    'select role, status, organization_id, full_name from public.profiles where id = $1', [id]))).rows[0];

  async function signUp(id: string, email: string | null, userMeta: Json | null, appMeta: Json = {}) {
    await admin((c) => c.query(
      `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3::jsonb, $4::jsonb)`,
      [id, email, userMeta === null ? null : JSON.stringify(userMeta), JSON.stringify(appMeta)]));
  }
  async function activeProfile(id: string, role: string, org: string | null) {
    await signUp(id, `${id}@rig.local`, { full_name: `P ${id.slice(-4)}` });
    await admin((c) => c.query(
      `update public.profiles set role = $2, status = 'active', organization_id = $3 where id = $1`, [id, role, org]));
  }
  async function provision(args: { actor: string; target: string; nonce: string; org: string; name: string; role: string;
    loginMode?: 'email' | 'local'; username?: string | null; correlation?: string }) {
    const correlation = args.correlation ?? crypto.randomUUID();
    const result = await admin(async (c) => {
      await c.query('begin');
      try {
        await c.query('set local role service_role');
        const r = await c.query(
          `select public.phoenix_admin_provision_profile($1,$2,$3,$4,$5,$6,$7,$8,null,$9) as result`,
          [args.actor, args.target, args.nonce, args.org, args.name, args.role, args.loginMode ?? 'email',
            args.username ?? null, correlation]);
        await c.query('commit');
        return r.rows[0].result as Json;
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
    return { result, correlation };
  }
  const denialReason = async (correlation: string) => (await admin((c) => c.query(
    `select payload->>'reason' as reason from public.audit_logs
      where action = 'security.access_denied' and payload->>'correlation_id' = $1`, [correlation]))).rows.map((r: Json) => r.reason);
  async function freshTarget(actor: string, name: string, nonce = crypto.randomUUID()) {
    const id = nextId();
    await signUp(id, `${id}@rig.local`, { full_name: name },
      { phoenix_provisioning_nonce: nonce, phoenix_provisioning_actor_id: actor });
    return { id, nonce };
  }

  beforeAll(async () => {
    rig = await buildRig({ upTo: 219 });
    await admin(async (c) => {
      await c.query(
        `insert into public.organizations (id, name, name_ar, code, organization_kind, institution_class, status) values
           ($1, 'AUTH-1 Org A', 'مؤسسة أ', 'auth1-a', 'care_institution', 'hospital', 'active'),
           ($2, 'AUTH-1 Org B', 'مؤسسة ب', 'auth1-b', 'care_institution', 'hospital', 'active')
         on conflict (id) do nothing`, [ORG_A, ORG_B]);
    });
    await activeProfile(INST_A, 'institution_admin', ORG_A);
    for (const key of ['users.create', 'users.assign_role']) {
      await admin((c) => c.query(
        `insert into public.profile_permission_overrides (profile_id, permission_key, allowed, created_by)
         values ($1, $2, true, $1) on conflict (profile_id, permission_key) do update set allowed = true`, [INST_A, key]));
    }
    await activeProfile(OFFICER_A, 'warehouse_officer', ORG_A);
    await activeProfile(OFFICER_A2, 'warehouse_officer', ORG_A);
    await activeProfile(OFFICER_B, 'warehouse_officer', ORG_B);
    await activeProfile(NOORG_ACTOR, 'outlet_officer', null);
    await activeProfile(NOORG_TARGET, 'outlet_officer', null);
    await activeProfile(SUSP_SUPER, 'super_admin', null);
    await admin((c) => c.query(`update public.profiles set status = 'suspended' where id = $1`, [SUSP_SUPER]));
    await signUp(PENDING, 'pending@rig.local', {
      full_name: 'Self Registered', role: 'super_admin', status: 'active', organization_id: ORG_A,
      permissions: ['users.create'], is_admin: true, is_super_admin: true, app_role: 'super_admin',
    });
  }, 300_000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  // ---------------------------------------------------------------- metadata
  describe('sign-up metadata is never authority', () => {
    it.each(METADATA_ROLES)('metadata role=%s yields the pending placeholder', async (role) => {
      const id = nextId();
      await signUp(id, `${role}@signup.local`, { full_name: 'Signup', role });
      expect(await profile(id)).toEqual({ role: SENTINEL, status: 'suspended', organization_id: null, full_name: 'Signup' });
      const helpers = await asUser(id, async (c) => (await c.query(
        'select public.phoenix_my_role() as r, public.phoenix_my_org() as o')).rows[0]);
      expect(helpers).toEqual({ r: SENTINEL, o: null });
    });

    it('ignores organization_id, status, permissions, is_admin, is_super_admin and app_role', async () => {
      expect(await profile(PENDING)).toEqual({ role: SENTINEL, status: 'suspended', organization_id: null, full_name: 'Self Registered' });
      const overrides = await admin((c) => c.query(
        'select count(*)::int as n from public.profile_permission_overrides where profile_id = $1', [PENDING]));
      expect(overrides.rows[0].n).toBe(0);
      const granted = await asUser(PENDING, async (c) => (await c.query(
        `select count(*) filter (where public.phoenix_profile_has_permission($1, k.key))::int as n from public.permission_keys k`,
        [PENDING])).rows[0].n);
      expect(granted).toBe(0);
    });

    it('validates the display name: trimmed JSON string of 1-200 characters, else the e-mail, else Unknown', async () => {
      const cases: Array<[Json | null, string | null, string]> = [
        [{ full_name: '  Padded Name  ' }, 'a@x.local', 'Padded Name'],
        [{ full_name: 42 }, 'b@x.local', 'b@x.local'],
        [{ full_name: '   ' }, 'c@x.local', 'c@x.local'],
        [{ full_name: 'x'.repeat(201) }, 'd@x.local', 'd@x.local'],
        [{ full_name: 'x'.repeat(200) }, 'e@x.local', 'x'.repeat(200)],
        [{}, 'f@x.local', 'f@x.local'],
        [{ full_name: '' }, null, 'Unknown'],
      ];
      for (const [meta, email, expected] of cases) {
        const id = nextId();
        await signUp(id, email, meta);
        const p = await profile(id);
        expect(p.full_name, JSON.stringify(meta)).toBe(expected);
        expect(p.role).toBe(SENTINEL);
      }
    });

    it('changing user metadata after creation has no RBAC effect', async () => {
      const id = nextId();
      await signUp(id, 'later@signup.local', { full_name: 'Later' });
      await admin((c) => c.query(
        `update auth.users set raw_user_meta_data = raw_user_meta_data || '{"role":"super_admin","status":"active"}'::jsonb where id = $1`, [id]));
      expect(await profile(id)).toEqual({ role: SENTINEL, status: 'suspended', organization_id: null, full_name: 'Later' });
      const r = await asUser(id, async (c) => (await c.query('select public.phoenix_my_role() as r')).rows[0].r);
      expect(r).toBe(SENTINEL);
    });
  });

  // ---------------------------------------------------------------- sentinel
  describe('the sentinel fails closed', () => {
    it('has zero role_permission_defaults and its shape is pinned (suspended, no organization)', async () => {
      const d = await admin((c) => c.query(`select count(*)::int as n from public.role_permission_defaults where role = $1`, [SENTINEL]));
      expect(d.rows[0].n).toBe(0);
      for (const [status, org] of [['active', null], ['suspended', ORG_A], ['archived', null]] as const) {
        const id = nextId();
        await expect(admin((c) => c.query(
          `insert into public.profiles (id, full_name, role, status, organization_id) values ($1, 'x', $2, $3, $4)`,
          [id, SENTINEL, status, org]))).rejects.toThrow(/profiles_pending_provisioning_shape_chk/);
      }
    });

    it('SQL comparisons on the sentinel are definite booleans that deny', async () => {
      const row = await asUser(PENDING, async (c) => (await c.query(
        `with x as (select public.phoenix_my_role() as r)
         select (r = 'super_admin') as eq, (r <> 'super_admin') as ne,
                (r in ('super_admin', 'institution_admin')) as inn,
                (r not in ('super_admin', 'institution_admin')) as notin,
                (not (r = 'super_admin' or r = 'institution_admin')) as notor
           from x`)).rows[0]);
      expect(row).toEqual({ eq: false, ne: true, inn: false, notin: true, notor: true });
    });

    const PROBES: Array<[string, string, RegExp | Json]> = [
      ['get_effective_permissions(other privileged)', `select public.get_effective_permissions('${ROOT}') as r`, { ok: false, error: 'OUT_OF_SCOPE' }],
      ['assign_profile_role', `select public.assign_profile_role('${OFFICER_A}', 'outlet_officer') as r`, { ok: false, error: 'INSUFFICIENT_ROLE' }],
      ['assign_profile_permissions', `select public.assign_profile_permissions('${PENDING}', '{"users.create":true}'::jsonb) as r`, { ok: false, error: 'INSUFFICIENT_PERMISSION' }],
      ['reset_profile_permissions', `select public.reset_profile_permissions('${ROOT}') as r`, { ok: false, error: 'INSUFFICIENT_PERMISSION' }],
      ['archive_entity', `select public.archive_entity('warehouse', gen_random_uuid(), 'probe') as r`, { ok: false, error: 'INSUFFICIENT_ROLE' }],
      ['purge_entity_with_all_data', `select public.purge_entity_with_all_data('warehouse', gen_random_uuid(), 'probe') as r`, { ok: false, error: 'SUPER_ADMIN_ONLY' }],
      ['create_qr_for_target', `select public.create_qr_for_target('warehouse', gen_random_uuid(), null) as r`, { ok: false, error: 'INSUFFICIENT_PERMISSION' }],
      ['disable_qr_token', `select public.disable_qr_token(gen_random_uuid(), 'probe') as r`, { ok: false, error: 'INSUFFICIENT_PERMISSION' }],
      ['phoenix_create_platform_broadcast', `select public.phoenix_create_platform_broadcast('t', 'b', 'info', 'all', null, now(), null) as r`, { ok: false, error: 'INSUFFICIENT_ROLE' }],
      ['phoenix_purge_inventory_terminal', `select public.phoenix_purge_inventory_terminal(gen_random_uuid(), 30) as r`, /not_authorized_inventory_purge/],
      ['phoenix_demo_purge', `select * from public.phoenix_demo_purge('PHOENIX_DEMO_V1', true)`, /forbidden_demo_purge/],
      ['phoenix_create_warehouse (super_admin only)', `select public.phoenix_create_warehouse(gen_random_uuid(), 'W', 'و', 'central', null, false) as r`, /NOT_AUTHORIZED_WAREHOUSE_MANAGE/],
      ['phoenix_assign_profile_scope (institution operation)', `select public.phoenix_assign_profile_scope('${OFFICER_A}', 'distribution_point', gen_random_uuid()) as r`, /NOT_AUTHORIZED_SCOPE_ASSIGN/],
    ];
    it.each(PROBES)('%s denies a pending_provisioning caller', async (_name, sql, expected) => {
      if (expected instanceof RegExp) {
        await expect(asUser(PENDING, (c) => c.query(sql))).rejects.toThrow(expected);
      } else {
        const r = await asUser(PENDING, async (c) => (await c.query(sql)).rows[0].r);
        expect(r).toEqual(expected);
      }
    });

    it('row-level security shows a pending caller only its own profile and no privileged rows', async () => {
      const row = await asUser(PENDING, async (c) => (await c.query(
        `select (select count(*)::int from public.profiles) as profiles,
                (select count(*)::int from public.profiles where id = $1) as own,
                (select count(*)::int from public.audit_logs) as audit,
                (select count(*)::int from public.profile_permission_overrides) as overrides`, [PENDING])).rows[0]);
      expect(row).toEqual({ profiles: 1, own: 1, audit: 0, overrides: 0 });
    });

    it('the officer availability writer is not even executable by authenticated', async () => {
      const x = await admin((c) => c.query(
        `select has_function_privilege('authenticated',
           'public.phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text)', 'EXECUTE') as x`));
      expect(x.rows[0].x).toBe(false);
    });
  });

  // ------------------------------------------------ get_effective_permissions
  describe('get_effective_permissions: super_admin, self, or the same NON-NULL organization', () => {
    const TABLE: Array<[string, string, string, 'ok' | 'OUT_OF_SCOPE' | 'TARGET_NOT_FOUND']> = [
      ['A pending (org NULL) -> other super_admin (org NULL)', PENDING, ROOT, 'OUT_OF_SCOPE'],
      ['B pending (org NULL) -> other org-less non-super', PENDING, NOORG_TARGET, 'OUT_OF_SCOPE'],
      ['C non-super org A -> other org A', OFFICER_A, OFFICER_A2, 'ok'],
      ['D non-super org A -> other org B', OFFICER_A, OFFICER_B, 'OUT_OF_SCOPE'],
      ['E non-super org NULL -> other org A', NOORG_ACTOR, OFFICER_A, 'OUT_OF_SCOPE'],
      ['F non-super org A -> other org NULL', OFFICER_A, NOORG_TARGET, 'OUT_OF_SCOPE'],
      ['G non-super org NULL -> self', NOORG_ACTOR, NOORG_ACTOR, 'ok'],
      ['H super_admin org NULL -> other org NULL', ROOT, NOORG_TARGET, 'ok'],
      ['I super_admin org NULL -> other org A', ROOT, OFFICER_A, 'ok'],
      ['J missing target', OFFICER_A, '21900000-0000-4000-8000-00000000ffff', 'TARGET_NOT_FOUND'],
    ];
    it.each(TABLE)('%s', async (_name, actor, target, expected) => {
      const r = await asUser(actor, async (c) => (await c.query(
        'select public.get_effective_permissions($1) as r', [target])).rows[0].r as Json);
      if (expected === 'ok') {
        expect(r.ok).toBe(true);
        expect(typeof r.permissions).toBe('object');
      } else {
        expect(r).toEqual({ ok: false, error: expected });
      }
    });

    it('keeps the M196 body apart from the one predicate, and every function property', async () => {
      const row = await admin(async (c) => (await c.query(
        `select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') as sha,
                p.prosecdef, p.proconfig, p.proacl::text as acl, p.provolatile, pg_get_userbyid(p.proowner) as owner
           from pg_proc p where p.oid = 'public.get_effective_permissions(uuid)'::regprocedure`)).rows[0]);
      expect(row).toEqual({
        sha: '8b891cb4b76947517c8d9c0ade96f8f0b0cb893d0c1730f7764c275d14ac09ec', prosecdef: true,
        proconfig: ['search_path=public, pg_temp'], acl: '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}',
        provolatile: 'v', owner: 'postgres',
      });
    });
  });

  // ------------------------------------------------- role-assignment surfaces
  describe('the sentinel is on no role-assignment interface', () => {
    it('assign_profile_role rejects pending_provisioning', async () => {
      const r = await asUser(ROOT, async (c) => (await c.query(
        `select public.assign_profile_role($1, $2) as r`, [OFFICER_A2, SENTINEL])).rows[0].r as Json);
      expect(r).toMatchObject({ ok: false, error: 'INVALID_ROLE' });
      expect((await profile(OFFICER_A2)).role).toBe('warehouse_officer');
    });

    it('phoenix_recycle_apply rejects pending_provisioning', async () => {
      const r = await asUser(ROOT, async (c) => (await c.query(
        `select public.phoenix_recycle_apply($1, 'New Name', $2, $3, 'email', null, null, 'recycled@rig.local', 1, gen_random_uuid()) as r`,
        [OFFICER_A2, SENTINEL, ORG_A])).rows[0].r as Json);
      expect(r.ok).toBe(false);
      expect((await profile(OFFICER_A2)).role).toBe('warehouse_officer');
    });

    it('phoenix_admin_provision_profile rejects a requested pending_provisioning role', async () => {
      const t = await freshTarget(ROOT, 'Sentinel Request');
      const { result } = await provision({ actor: ROOT, target: t.id, nonce: t.nonce, org: ORG_A, name: 'Sentinel Request', role: SENTINEL });
      expect(result).toMatchObject({ ok: false, error: 'INVALID_ROLE' });
      expect((await profile(t.id)).role).toBe(SENTINEL);
    });

    it('a profile can never become an active or organization-bound pending_provisioning profile', async () => {
      await expect(admin((c) => c.query(`update public.profiles set role = $2 where id = $1`, [OFFICER_A2, SENTINEL])))
        .rejects.toThrow(/profiles_pending_provisioning_shape_chk/);
    });
  });

  // ------------------------------------------------------ trusted provisioning
  describe('trusted admin provisioning', () => {
    it('super_admin -> pending placeholder -> requested role, active, organization, exactly once; normal authorization works', async () => {
      const t = await freshTarget(ROOT, 'New Officer');
      expect(await profile(t.id)).toEqual({ role: SENTINEL, status: 'suspended', organization_id: null, full_name: 'New Officer' });
      const { result } = await provision({ actor: ROOT, target: t.id, nonce: t.nonce, org: ORG_A, name: 'New Officer', role: 'warehouse_officer' });
      expect(result).toMatchObject({ ok: true, user_id: t.id, role: 'warehouse_officer' });
      expect(await profile(t.id)).toEqual({ role: 'warehouse_officer', status: 'active', organization_id: ORG_A, full_name: 'New Officer' });
      const key = (await admin((c) => c.query(
        `select permission_key from public.role_permission_defaults where role = 'warehouse_officer' and allowed order by 1 limit 1`))).rows[0].permission_key;
      const authz = await asUser(t.id, async (c) => (await c.query(
        `select public.phoenix_my_role() as r, public.phoenix_my_org() as o, public.phoenix_profile_has_permission($1, $2) as p`,
        [t.id, key])).rows[0]);
      expect(authz).toEqual({ r: 'warehouse_officer', o: ORG_A, p: true });
      const created = await admin((c) => c.query(
        `select count(*)::int as n from public.audit_logs where action = 'user.created' and entity_id = $1`, [t.id]));
      expect(created.rows[0].n).toBe(1);

      // duplicate and replay: the converted profile is no longer a fresh placeholder
      const dup = await provision({ actor: ROOT, target: t.id, nonce: t.nonce, org: ORG_A, name: 'New Officer', role: 'warehouse_officer' });
      expect(dup.result).toMatchObject({ ok: false, error: 'REQUEST_DENIED' });
      expect(await denialReason(dup.correlation)).toEqual(['target_not_fresh_placeholder']);
      const replayCorrelation = crypto.randomUUID();
      for (let i = 0; i < 2; i += 1) {
        const rep = await provision({ actor: ROOT, target: t.id, nonce: t.nonce, org: ORG_B, name: 'New Officer', role: 'super_admin', correlation: replayCorrelation });
        expect(rep.result).toMatchObject({ ok: false, error: 'REQUEST_DENIED' });
      }
      expect(await profile(t.id)).toEqual({ role: 'warehouse_officer', status: 'active', organization_id: ORG_A, full_name: 'New Officer' });
    });

    it('institution_admin provisions an allowed role in its own organization (local login)', async () => {
      const id = nextId();
      const nonce = crypto.randomUUID();
      await signUp(id, 'inst.officer@local.medistock.invalid', { full_name: 'Inst Officer' },
        { phoenix_provisioning_nonce: nonce, phoenix_provisioning_actor_id: INST_A });
      const { result } = await provision({ actor: INST_A, target: id, nonce, org: ORG_A, name: 'Inst Officer', role: 'outlet_officer',
        loginMode: 'local', username: 'inst.officer' });
      expect(result).toMatchObject({ ok: true, role: 'outlet_officer' });
      expect(await profile(id)).toEqual({ role: 'outlet_officer', status: 'active', organization_id: ORG_A, full_name: 'Inst Officer' });
    });

    it('a facility-scoped health_center_manager is provisioned from the suspended placeholder, then scoped (admin-create-user order)', async () => {
      // The placeholder is now SUSPENDED, so this proves the pending -> active
      // conversion clears the profile role/organization guard for the one role
      // it judges, followed by the Edge function's facility-scope step.
      const SECTOR = '21900000-0000-4000-8000-0000000000e0';
      const CENTER = '21900000-0000-4000-8000-0000000000e1';
      await admin(async (c) => {
        await c.query(
          `insert into public.organizations (id, name, name_ar, code, organization_kind, institution_class, status)
           values ($1, 'AUTH-1 Sector', 'قطاع', 'auth1-s', 'care_institution', 'health_sector', 'active') on conflict (id) do nothing`, [SECTOR]);
        await c.query(
          `insert into public.organization_facilities (id, organization_id, parent_institution_class, facility_class, name, name_ar, status)
           values ($1, $2, 'health_sector', 'primary_health_center', 'AUTH-1 Center', 'مركز', 'active') on conflict (id) do nothing`,
          [CENTER, SECTOR]);
      });
      const t = await freshTarget(ROOT, 'HC Manager');
      expect(await profile(t.id)).toEqual({ role: SENTINEL, status: 'suspended', organization_id: null, full_name: 'HC Manager' });
      const { result } = await provision({ actor: ROOT, target: t.id, nonce: t.nonce, org: SECTOR, name: 'HC Manager', role: 'health_center_manager' });
      expect(result).toMatchObject({ ok: true, user_id: t.id, role: 'health_center_manager' });
      expect(await profile(t.id)).toEqual({ role: 'health_center_manager', status: 'active', organization_id: SECTOR, full_name: 'HC Manager' });
      const scopes = await admin(async (c) => {
        await c.query('begin');
        try {
          await c.query('set local role service_role');
          const r = await c.query('select public.phoenix_admin_assign_facility_scopes($1, $2, $3) as r', [ROOT, t.id, [CENTER]]);
          await c.query('commit');
          return r.rows[0].r as Json;
        } catch (e) {
          await c.query('rollback');
          throw e;
        }
      });
      expect(scopes).toMatchObject({ ok: true });
      const active = await admin((c) => c.query(
        `select facility_id from public.profile_scope_assignments where profile_id = $1 and scope_type = 'facility' and is_active`, [t.id]));
      expect(active.rows.map((r: Json) => r.facility_id)).toEqual([CENTER]);
    });

    const DENIALS: Array<[string, () => Promise<{ actor: string; target: string; nonce: string; org: string; name: string; role: string }>, string]> = [
      ['wrong nonce', async () => { const t = await freshTarget(ROOT, 'N1'); return { actor: ROOT, target: t.id, nonce: crypto.randomUUID(), org: ORG_A, name: 'N1', role: 'warehouse_officer' }; }, 'target_not_fresh_placeholder'],
      ['wrong actor binding', async () => { const t = await freshTarget(INST_A, 'N2'); return { actor: ROOT, target: t.id, nonce: t.nonce, org: ORG_A, name: 'N2', role: 'warehouse_officer' }; }, 'target_not_fresh_placeholder'],
      ['stale auth user', async () => {
        const t = await freshTarget(ROOT, 'N3');
        await admin((c) => c.query(`update auth.users set created_at = now() - interval '11 minutes' where id = $1`, [t.id]));
        return { actor: ROOT, target: t.id, nonce: t.nonce, org: ORG_A, name: 'N3', role: 'warehouse_officer' };
      }, 'target_not_fresh_placeholder'],
      ['existing non-placeholder profile', async () => ({ actor: ROOT, target: OFFICER_A2, nonce: crypto.randomUUID(), org: ORG_A, name: 'P a03', role: 'warehouse_officer' }), 'target_not_fresh_placeholder'],
      ['old-contract placeholder (outlet_officer, active)', async () => {
        const t = await freshTarget(ROOT, 'N4');
        await admin((c) => c.query(`update public.profiles set role = 'outlet_officer', status = 'active' where id = $1`, [t.id]));
        return { actor: ROOT, target: t.id, nonce: t.nonce, org: ORG_A, name: 'N4', role: 'warehouse_officer' };
      }, 'target_not_fresh_placeholder'],
      ['cross-org institution_admin', async () => { const t = await freshTarget(INST_A, 'N5'); return { actor: INST_A, target: t.id, nonce: t.nonce, org: ORG_B, name: 'N5', role: 'outlet_officer' }; }, 'cross_org'],
      ['unauthorized actor: active warehouse_officer', async () => { const t = await freshTarget(OFFICER_A, 'N6'); return { actor: OFFICER_A, target: t.id, nonce: t.nonce, org: ORG_A, name: 'N6', role: 'outlet_officer' }; }, 'actor_not_authorized'],
      ['unauthorized actor: pending_provisioning', async () => { const t = await freshTarget(PENDING, 'N7'); return { actor: PENDING, target: t.id, nonce: t.nonce, org: ORG_A, name: 'N7', role: 'outlet_officer' }; }, 'actor_not_authorized'],
      ['unauthorized actor: suspended super_admin', async () => { const t = await freshTarget(SUSP_SUPER, 'N8'); return { actor: SUSP_SUPER, target: t.id, nonce: t.nonce, org: ORG_A, name: 'N8', role: 'outlet_officer' }; }, 'actor_not_authorized'],
      ['institution_admin -> super_admin', async () => { const t = await freshTarget(INST_A, 'N9'); return { actor: INST_A, target: t.id, nonce: t.nonce, org: ORG_A, name: 'N9', role: 'super_admin' }; }, 'cannot_create_privileged_role'],
      ['institution_admin -> institution_admin', async () => { const t = await freshTarget(INST_A, 'N10'); return { actor: INST_A, target: t.id, nonce: t.nonce, org: ORG_A, name: 'N10', role: 'institution_admin' }; }, 'cannot_create_privileged_role'],
      ['institution_admin -> central_warehouse_manager', async () => { const t = await freshTarget(INST_A, 'N11'); return { actor: INST_A, target: t.id, nonce: t.nonce, org: ORG_A, name: 'N11', role: 'central_warehouse_manager' }; }, 'cannot_create_privileged_role'],
    ];
    it.each(DENIALS)('%s is denied', async (_name, setup, reason) => {
      const args = await setup();
      const before = await profile(args.target);
      const { result, correlation } = await provision(args);
      expect(result).toMatchObject({ ok: false, error: 'REQUEST_DENIED' });
      expect(await denialReason(correlation)).toEqual([reason]);
      expect(await profile(args.target)).toEqual(before);
    });
  });
});
