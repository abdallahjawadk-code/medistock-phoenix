import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg, { type PoolClient } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — canonical disposable harness is JavaScript.
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { decodeMonthlyPolicyReference, proposeFromMonthlyPolicy } from '../../../src/features/central-needs/allocation/monthly-proposal-reference';

const run = rigAvailable() ? describe.sequential : describe.skip;
const id = (n: number) => `b2100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const F = { org: id(1), other: id(2), ben: id(3), otherBen: id(4), actor: id(11) };
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
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




run('R2-B owner-published metadata; restricted native roles, not JWT acceptance', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const admin = (sql: string, args: unknown[] = []) => rig.asAdmin(async (c: PoolClient) => (await c.query(sql, args)).rows);
  const user = <T = unknown>(sql: string, args: unknown[] = [], role = 'authenticated'): Promise<T> =>
    rig.asUser(F.actor, async (c: PoolClient) => (await c.query(sql, args)).rows[0].r as T, { role, commit: true });
  const seals = async () => {
    expect(await admin('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).toEqual([]);
    expect(await admin('SELECT * FROM phoenix_r2.capability_breaches()')).toEqual([]);
    expect(await admin('SELECT * FROM phoenix_monthly.capability_breaches_v1()')).toEqual([]);
  };
  let canonical: string, annual: string, version: string;
  const context = () => ({ ownerOrgId: F.org, planningYear: 2026, annualItemId: annual, fieldVersionId: version,
    canonicalItemId: canonical, unit: 'box', beneficiaryOrganizationId: F.ben });
  const readArgs = (ben = F.ben) => [F.org, 2026, annual, version, canonical, ben];
  const read = (ben = F.ben) => user<{ status: string; reason?: string; reference?: unknown }>(
    'SELECT public.phoenix_monthly_policy_reference($1,$2,$3,$4,$5,$6) r', readArgs(ben));
  const publish = (payload: unknown, previous: string | null = null, active = true) => admin(
    'SELECT phoenix_monthly.publish_reference_v1($1::jsonb,$2,$3) r', [JSON.stringify(payload), previous, active]);
  const policy = (specific = false, ordinal = 1) => ({ policyId: randomUUID(), version: ordinal, fingerprint: 'a'.repeat(64), status: 'approved',
    context: { ...context(), beneficiaryOrganizationId: specific ? F.ben : null }, unitStep: '0.25', eligibleMonths: [2, 4, 6],
    fixedMonths: [{ month: 1, quantity: '2.5', status: 'approved', ledgerReference: 'synthetic-approved-month' }],
    basis: { beneficiaryOrganizationId: F.ben, documentReference: 'Synthetic approved policy', documentSha256: 'b'.repeat(64),
      periodReference: 'Synthetic period decision', priorAllocationStatus: 'snapshot_verified', ledgerSnapshotSha256: 'c'.repeat(64),
      approvedById: F.actor, approvedByName: 'FORGED INPUT NAME', approvedAt: '2026-01-01T10:00:00.000Z' } });
  const counts = async () => (await admin(`SELECT
    (SELECT count(*) FROM public.central_items)::int canonical,
    (SELECT count(*) FROM public.central_needs_annual_items)::int memberships,
    (SELECT count(*) FROM public.central_needs_annual_versions)::int versions,
    (SELECT count(*) FROM public.central_needs_manual_need_events)::int needs,
    (SELECT count(*) FROM public.warehouse_stock_movements)::int stock,
    (SELECT count(*) FROM public.outlet_stock_movements)::int outlet,
    (SELECT count(*) FROM public.audit_logs)::int audit`))[0];
  let before: unknown, generic: ReturnType<typeof policy>;
  beforeAll(async () => {
    const pinned = {
      'P1_dossier_workbook_reservation_NOT_APPLIED.sql': 'd0f914e47b559fa027e9372beb17dc5cc4fe46affee29b480149b5a3be9440ff',
      'P3A1_annual_catalog_NOT_APPLIED.sql': '1cfab7101634410288702e71bde670d6816ceeaea1dd06a21f510f9cc86e90bf',
      'P3B_annual_needs_audit_NOT_APPLIED.sql': 'a761e97aa8c2c37ed1790d645d55ec26e1945c887f6402f9179d72e6a5d41074',
      'P3C2_annual_originals_NOT_APPLIED.sql': '17cd88fa51492c9b5722c4ae95a31275976360205f82584f46c676b65522f600',
      'R2A_authority_NOT_APPLIED.sql': 'a48040a57082fd2519661c755f87c7d2f32c2e8efc351a120308e65b03c56d71',
      'R2B_monthly_policy_reference_NOT_APPLIED.sql': '6db1e13411f5773c0f7ff281a2bbbc76154acdde1eaa8b4eb642d73ef72f44c6',
    };
    const programs = Object.entries(pinned).map(([file, expected]) => {
      const bytes = readFileSync(new URL(`../${file}`, import.meta.url)); expect(sha(bytes)).toBe(expected); return bytes.toString('utf8');
    });
    const identity = await verifyTarget(); rig = await buildRig({ upTo: 235 });
    expect((await admin('SELECT system_identifier::text sysid FROM pg_control_system()'))[0].sysid).toBe(identity);
    for (const program of programs) await rig.asAdmin(async (c: PoolClient) => {
      try { await c.query(program); } catch (error) { await c.query('ROLLBACK'); throw error; }
    });
    await seals();
    await admin(`INSERT INTO public.organizations(id,name,name_ar,code,organization_kind,institution_class,status) VALUES
      ($1,'Monthly owner','مالك شهري','monthly-owner','pharmacy_department_authority',NULL,'active'),
      ($2,'Other owner','مالك آخر','monthly-other','pharmacy_department_authority',NULL,'active'),
      ($3,'Hospital A','مستشفى أ','monthly-ben-a','care_institution','hospital','active'),
      ($4,'Hospital B','مستشفى ب','monthly-ben-b','care_institution','hospital','active')`, [F.org, F.other, F.ben, F.otherBen]);
    await admin('INSERT INTO auth.users(id,email) VALUES($1,$2)', [F.actor, 'monthly-native@fixture.invalid']);
    await admin("UPDATE public.profiles SET organization_id=$2,role='warehouse_officer',status='active',full_name='Synthetic monthly reviewer' WHERE id=$1", [F.actor, F.org]);
    for (const key of ['view', 'edit', 'allocation.view']) await admin('INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed) VALUES($1,$2,true)', [F.actor, `central_needs.${key}`]);
    canonical = (await admin("INSERT INTO public.central_items(name,name_ar,unit,national_code,status) VALUES('Synthetic monthly','مادة اصطناعية','box','MONTHLY-NATIVE','active') RETURNING id"))[0].id;
    await user('SELECT public.phoenix_central_needs_open_catalog_year($1,2026,$2) r', [F.org, `open-${randomUUID()}`]);
    const preview = await user<{ canonicalFingerprint: string }>('SELECT public.phoenix_central_needs_preview_annual_canonical($1,2026,$2) r', [F.org, canonical]);
    const member = await user<{ membership: { annualItemId: string }; fieldVersion: { fieldVersionId: string } }>(
      'SELECT public.phoenix_central_needs_add_annual_catalog_item($1,2026,$2,$3,$4::jsonb,$5,$6) r',
      [F.org, canonical, preview.canonicalFingerprint, '[]', 'Explicit synthetic annual membership', `add-${randomUUID()}`]);
    annual = member.membership.annualItemId; version = member.fieldVersion.fieldVersionId; before = await counts();
  }, 120000);
  afterAll(async () => { if (rig) await rig.end(); });
  it('installs without policy defaults, operational writers or weakened prior seals', async () => {
    expect(await read()).toMatchObject({ status: 'awaiting_policy', reason: 'missing' });
    expect(await user('SELECT public.phoenix_r2_capabilities($1) r', [F.org])).toMatchObject({ operationalWritesImplemented: false });
    await seals();
  });
  it('keeps publication/private tables unavailable to all API identities', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await expect(user('SELECT count(*) r FROM phoenix_monthly.policy_references', [], role)).rejects.toThrow(/permission denied/);
      await expect(user('SELECT phoenix_monthly.publish_reference_v1($1::jsonb,NULL,true) r', [JSON.stringify(policy())], role)).rejects.toThrow(/permission denied/);
    }
  });
  it('refuses a timestamp that the client cannot decode, without publishing a row', async () => {
    const invalid = policy(); invalid.basis.approvedAt = '2026-01-01 10:00:00+00';
    await rig.asAdmin(async (c: PoolClient) => {
      await c.query('BEGIN');
      try { await expect(c.query('SELECT phoenix_monthly.publish_reference_v1($1::jsonb,NULL,true)', [JSON.stringify(invalid)]))
        .rejects.toThrow('monthly_policy_invalid'); }
      finally { await c.query('ROLLBACK'); }
    });
  });
  it('canonicalizes owner-published beneficiary IDs before fingerprinting, reading and client decoding', async () => {
    const upper = policy(); upper.basis.beneficiaryOrganizationId = F.otherBen.toUpperCase();
    await publish(upper);
    try {
      const response = await read(F.otherBen); expect(response.status).toBe('ready');
      const decoded = decodeMonthlyPolicyReference(response.reference, { ...context(), beneficiaryOrganizationId: F.otherBen });
      expect(decoded.basis.beneficiaryOrganizationId).toBe(F.otherBen);
    } finally { await publish({ ...upper, policyId: randomUUID(), version: 2 }, upper.policyId, false); }
  });
  it('publishes a reviewed immutable source snapshot through the database owner only', async () => {
    generic = policy(); const [{ r }] = await publish(generic);
    expect(r.basis.approvedByName).toBe('Synthetic monthly reviewer');
    const response = await read(); expect(response.status).toBe('ready');
    const decoded = decodeMonthlyPolicyReference(response.reference, context());
    expect(decoded.basis.beneficiaryOrganizationId).toBe(F.ben);
    expect(proposeFromMonthlyPolicy('10.25', context(), decoded)).toMatchObject({ status: 'ready', effectiveAllocation: false });
    expect(await read(F.otherBen)).toMatchObject({ status: 'awaiting_policy', reason: 'missing' });
  });
  it('holds generic/specific ambiguity until an explicit publication withdraws one reference', async () => {
    const specific = policy(true); await publish(specific);
    expect(await read()).toMatchObject({ status: 'awaiting_policy', reason: 'ambiguous' });
    const withdrawn = { ...specific, policyId: randomUUID(), version: 2 };
    await publish(withdrawn, specific.policyId, false); expect(await read()).toMatchObject({ status: 'ready' });
  });
  it('fences stale publication and refuses overlapping months without changing history', async () => {
    const next = { ...generic, policyId: randomUUID(), version: 2 };
    await expect(publish(next)).rejects.toThrow('monthly_policy_stale');
    await expect(publish({ ...next, eligibleMonths: [1, 2] }, generic.policyId)).rejects.toThrow('monthly_policy_invalid');
    expect(await read()).toMatchObject({ status: 'ready' });
  });
  it('refuses allocation data when only allocation view is revoked, retaining annual view', async () => {
    await admin("UPDATE public.profile_permission_overrides SET allowed=false WHERE profile_id=$1 AND permission_key='central_needs.allocation.view'", [F.actor]);
    try { await expect(read()).rejects.toThrow('r2_permission_denied'); }
    finally { await admin("UPDATE public.profile_permission_overrides SET allowed=true WHERE profile_id=$1 AND permission_key='central_needs.allocation.view'", [F.actor]); }
    expect(await read()).toMatchObject({ status: 'ready' });
  });
  it('observes current view revocation and preserves history and all business counts', async () => {
    await admin("UPDATE public.profile_permission_overrides SET allowed=false WHERE profile_id=$1 AND permission_key='central_needs.view'", [F.actor]);
    try { await expect(read()).rejects.toThrow(/forbidden/); }
    finally { await admin("UPDATE public.profile_permission_overrides SET allowed=true WHERE profile_id=$1 AND permission_key='central_needs.view'", [F.actor]); }
    await expect(admin('UPDATE phoenix_monthly.policy_references SET published_at=clock_timestamp()')).rejects.toThrow('monthly_history_immutable');
    expect(await counts()).toEqual(before); await seals();
  });
});
