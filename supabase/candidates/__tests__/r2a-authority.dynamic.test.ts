import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
// @ts-expect-error — canonical disposable harness is JavaScript.
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe.sequential : describe.skip;
const F = { org: 'a2100000-0000-4000-8000-000000000001', other: 'a2100000-0000-4000-8000-000000000002',
  actor: 'a2100000-0000-4000-8000-000000000011', viewer: 'a2100000-0000-4000-8000-000000000012',
  outsider: 'a2100000-0000-4000-8000-000000000013', sa: 'a2100000-0000-4000-8000-000000000014' };

/** No destructive buildRig action precedes a read-only target identity proof. */
async function verifyTarget() {
  const url = new URL(process.env.PHOENIX_RIG_PG ?? '');
  expect(['postgres:', 'postgresql:']).toContain(url.protocol);
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname); expect(url.username).toBe('postgres');
  expect(url.pathname).toBe('/postgres'); expect(url.search).toBe(''); expect(url.hash).toBe('');
  expect(process.env.PHOENIX_RIG_CANDIDATES || '').toBe('');
  const native = process.env.PHOENIX_R2_NATIVE_SYSTEM_IDENTIFIER;
  const database = process.env.PHOENIX_RIG_DB || 'phoenix_rig';
  if (native) {
    expect(native).toMatch(/^\d{16,24}$/); expect(url.hostname).toBe('127.0.0.1'); expect(url.port).toBe('55436'); expect(database).toBe('phoenix_r2_local');
    expect(process.env.PHOENIX_R2_NATIVE_CLUSTER).toBe('medistock_r2_local_20261101');
    expect(resolve(process.env.PHOENIX_R2_NATIVE_DATA_DIRECTORY ?? '')).toBe(resolve(process.cwd(), '../native-r2-pg18/data'));
  } else {
    expect(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true').toBe(true);
    expect(url.port).toBe('55432'); expect(database).toBe('phoenix_rig');
  }
  const c = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 }); await c.connect();
  try {
    const { rows: [identity] } = await c.query(`SELECT current_database() db,current_user actor,host(inet_server_addr()) address,
      inet_server_port() port,current_setting('data_directory') directory,current_setting('cluster_name') cluster,
      current_setting('server_version_num')::int version,(SELECT system_identifier::text FROM pg_control_system()) sysid`);
    expect(identity.db).toBe('postgres'); expect(identity.actor).toBe('postgres');
    expect([17, 18]).toContain(Math.trunc(identity.version / 10000));
    if (native) {
      expect(identity.sysid).toBe(native); expect(identity.address).toBe('127.0.0.1'); expect(identity.port).toBe(55436);
      expect(resolve(identity.directory)).toBe(resolve(process.env.PHOENIX_R2_NATIVE_DATA_DIRECTORY!));
      expect(identity.cluster).toBe(process.env.PHOENIX_R2_NATIVE_CLUSTER);
    }
    const { rows } = await c.query('SELECT datname,pg_get_userbyid(datdba) owner FROM pg_database WHERE NOT datistemplate');
    expect(rows.every(r => ['postgres', database].includes(r.datname) && r.owner === 'postgres')).toBe(true);
    return identity.sysid;
  } finally { await c.end(); }
}

run('R2-A authority foundation / restricted native callers', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let annualPredicate: string;
  const admin = async (sql: string, args: unknown[] = []) => rig.asAdmin(async (c: PoolClient) => (await c.query(sql, args)).rows);
  const as = async (actor: string | null, sql: string, args: unknown[] = []) =>
    rig.asUser(actor, async (c: PoolClient) => (await c.query(sql, args)).rows, { commit: true });
  const caps = async (actor = F.actor, owner = F.org) => (await as(actor, 'SELECT public.phoenix_r2_capabilities($1) r', [owner]))[0].r;
  const grant = (suffix: string, allowed = true, scope: string | null = null) => admin(`INSERT INTO public.profile_permission_overrides
    (profile_id,permission_key,allowed,scope_organization_id) VALUES($1,$2,$3,$4)
    ON CONFLICT(profile_id,permission_key) DO UPDATE SET allowed=excluded.allowed,scope_organization_id=excluded.scope_organization_id`,
  [F.actor, `central_needs.allocation.${suffix}`, allowed, scope]);
  const probe = (actor = F.actor, key = 'central_needs.allocation.create') =>
    as(actor, 'SELECT public.r2_native_authority_probe($1,$2) r', [F.org, key]);
  const seal = () => admin('SELECT * FROM phoenix_r2.capability_breaches()');

  beforeAll(async () => {
    const identity = await verifyTarget(); rig = await buildRig({ upTo: 235 });
    expect((await admin('SELECT system_identifier::text sysid FROM pg_control_system()'))[0].sysid).toBe(identity);
    for (const name of ['P1_dossier_workbook_reservation_NOT_APPLIED.sql', 'P3A1_annual_catalog_NOT_APPLIED.sql',
      'P3B_annual_needs_audit_NOT_APPLIED.sql', 'P3C2_annual_originals_NOT_APPLIED.sql']) {
      await admin(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
      expect(await admin('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).toEqual([]);
    }
    annualPredicate = (await admin("SELECT pg_get_functiondef('phoenix_cn_policy.actor_scope_org(text)'::regprocedure) body"))[0].body;
    await admin(readFileSync(new URL('../R2A_authority_NOT_APPLIED.sql', import.meta.url), 'utf8')); expect(await seal()).toEqual([]);
    await admin(`INSERT INTO public.organizations(id,name,name_ar,code,organization_kind,institution_class,status) VALUES
      ($1,'R2 owner','مالك الاختبار','r2-native-owner','pharmacy_department_authority',NULL,'active'),
      ($2,'R2 other','مالك آخر','r2-native-other','pharmacy_department_authority',NULL,'active')`, [F.org, F.other]);
    for (const [id, owner, role] of [[F.actor, F.org, 'warehouse_officer'], [F.viewer, F.org, 'warehouse_officer'],
      [F.outsider, F.other, 'warehouse_officer'], [F.sa, F.org, 'super_admin']]) {
      await admin('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, `${randomUUID()}@fixture.invalid`]);
      await admin("UPDATE public.profiles SET organization_id=$2,role=$3,status='active',full_name='موظف اختبار R2' WHERE id=$1", [id, owner, role]);
      await admin("INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed) VALUES($1,'central_needs.view',true)", [id]);
    }
    // Disposable bridge probes the real private guard as a restricted caller.
    // It is created only by this test; it is not part of the candidate or API.
    await admin(`CREATE FUNCTION public.r2_native_authority_probe(p_org uuid,p_key text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,pg_temp AS 'SELECT phoenix_r2.require_authority(p_org,p_key)';
      REVOKE ALL ON FUNCTION public.r2_native_authority_probe(uuid,text) FROM PUBLIC,anon,service_role;
      GRANT EXECUTE ON FUNCTION public.r2_native_authority_probe(uuid,text) TO authenticated;`);
  }, 900000);
  afterAll(async () => { if (rig) await rig.end(); });

  it('uses actual non-superuser authenticated callers', async () => {
    expect((await as(F.actor, 'SELECT current_user actor,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'))[0])
      .toEqual({ actor: 'authenticated', rolsuper: false, rolbypassrls: false });
  });
  it('starts with no role defaults, implicit grants or operational writer', async () => {
    expect((await admin("SELECT count(*)::int n FROM public.role_permission_defaults WHERE permission_key LIKE 'central_needs.allocation.%'"))[0].n).toBe(0);
    expect(await caps()).toMatchObject({ phase: 'authority_foundation', operationalWritesImplemented: false, authorityActivated: false, view: false, create: false });
    expect((await caps(F.sa)).view).toBe(false);
  });
  it('refuses cross-owner discovery and direct API access to private activation/guards', async () => {
    await expect(caps(F.outsider)).rejects.toThrow();
    await expect(as(F.actor, "INSERT INTO phoenix_r2.activation_events(organization_id,enabled,release_reference) VALUES($1,true,'unauthorized')", [F.org])).rejects.toThrow(/permission denied/);
    await expect(as(F.actor, 'SELECT phoenix_r2.require_authority($1,$2)', [F.org, 'central_needs.allocation.create'])).rejects.toThrow(/permission denied/);
  });
  it('requires the separate R2 view key and administrator-owned activation', async () => {
    await grant('create'); await expect(probe()).rejects.toThrow(/r2_permission_denied/);
    await grant('view'); await expect(probe()).rejects.toThrow(/r2_not_activated/);
    await expect(rig.asUser(F.actor, async (c: PoolClient) => {
      await c.query("SELECT set_config('phoenix.r2.enabled','true',true)");
      await c.query('SELECT public.r2_native_authority_probe($1,$2)', [F.org, 'central_needs.allocation.create']);
    })).rejects.toThrow(/r2_not_activated/);
    await admin("INSERT INTO phoenix_r2.activation_events(organization_id,enabled,release_reference) VALUES($1,true,'disposable-authority-test-only')", [F.org]);
    expect((await probe())[0].r).toEqual({ actorId: F.actor, actorName: 'موظف اختبار R2', actorRole: 'warehouse_officer', ownerOrgId: F.org });
    expect(await caps()).toMatchObject({ create: true, approve: false, operationalWritesImplemented: false });
  });
  it('preserves the canonical refusal of a cross-owner grant', async () => {
    await expect(grant('create', true, F.other)).rejects.toThrow(/PPO_SCOPE_ORG_MISMATCH/);
    expect((await caps()).create).toBe(true);
  });
  it('rechecks revoked permissions, suspended employees and unknown keys', async () => {
    await grant('create', false); await expect(probe()).rejects.toThrow(/r2_permission_denied/); await grant('create');
    await admin("UPDATE public.profiles SET status='suspended' WHERE id=$1", [F.actor]);
    await expect(probe()).rejects.toThrow(); await admin("UPDATE public.profiles SET status='active' WHERE id=$1", [F.actor]);
    await expect(probe(F.actor, 'central_needs.edit')).rejects.toThrow(/r2_permission_denied/);
  });
  it('deactivates through a new immutable event without erasing the first', async () => {
    await admin("INSERT INTO phoenix_r2.activation_events(organization_id,enabled,release_reference) VALUES($1,false,'disposable-authority-deactivation')", [F.org]);
    await expect(probe()).rejects.toThrow(/r2_not_activated/);
    await expect(admin('DELETE FROM phoenix_r2.activation_events WHERE organization_id=$1', [F.org])).rejects.toThrow(/r2_immutable_history/);
    expect((await admin('SELECT count(*)::int n FROM phoenix_r2.activation_events WHERE organization_id=$1', [F.org]))[0].n).toBe(2);
  });
  it('preserves the accepted R1 predicate and prior capability seal', async () => {
    expect((await admin("SELECT pg_get_functiondef('phoenix_cn_policy.actor_scope_org(text)'::regprocedure) body"))[0].body).toBe(annualPredicate);
    expect(await admin('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).toEqual([]); expect(await seal()).toEqual([]);
  });
  it('detects API-grant and unexpected public-writer tampering', async () => {
    await admin('GRANT USAGE ON SCHEMA phoenix_r2 TO authenticated'); expect((await seal()).length).toBeGreaterThan(0);
    await admin('REVOKE USAGE ON SCHEMA phoenix_r2 FROM authenticated'); expect(await seal()).toEqual([]);
    await admin('CREATE FUNCTION public.phoenix_r2_unreviewed_writer() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$');
    expect((await seal()).length).toBeGreaterThan(0); await admin('DROP FUNCTION public.phoenix_r2_unreviewed_writer()'); expect(await seal()).toEqual([]);
  });
});
