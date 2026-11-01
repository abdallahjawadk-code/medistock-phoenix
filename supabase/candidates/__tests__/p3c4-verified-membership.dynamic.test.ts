import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import pg, { type PoolClient } from 'pg';
import * as XLSX from 'xlsx';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — canonical disposable harness is JavaScript.
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { runC3IsolatedWorker } from '../../../api/_cn2b-core/annual-c3-worker-boundary.ts';
import type { C3OriginalMetadata } from '../../../api/_cn2b-core/annual-c3-authorized-source.ts';

const run = rigAvailable() ? describe.sequential : describe.skip;
const F = { org: 'c4100000-0000-4000-8000-000000000001', other: 'c4100000-0000-4000-8000-000000000002',
  actor: 'c4100000-0000-4000-8000-000000000011', second: 'c4100000-0000-4000-8000-000000000012',
  viewer: 'c4100000-0000-4000-8000-000000000013', outsider: 'c4100000-0000-4000-8000-000000000014' };
const scope = { ownerOrgId: F.org, planningYear: 2026 };
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface Sealed { proofId: string; proofSha256: string; requestId: string }
interface Result { membership: { annualItemId: string }; fieldVersion: { fieldVersionId: string };
  sourceAttestation: string; idempotentReplay: boolean; selectable: boolean;
  c4Verification: { attestation: string; reviewedById: string; reviewedByName: string } }
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


run('C4 restricted native roles and actual C2/worker evidence; not JWT acceptance', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const admin = async (sql: string, args: unknown[] = []) => rig.asAdmin(async (c: PoolClient) => (await c.query(sql, args)).rows);
  const user = async <T>(sql: string, args: unknown[] = [], actor: string | null = F.actor, role = 'authenticated'): Promise<T> =>
    rig.asUser(actor, async (c: PoolClient) => (await c.query(sql, args)).rows[0].r as T, { role, commit: true });
  const command = (name: string, args: unknown[]) => `SELECT public.phoenix_c4_${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`;
  const call = <T = unknown>(name: string, args: unknown[], actor: string | null = F.actor, role = 'authenticated') => user<T>(command(name, args), args, actor, role);
  const oldSeal = () => admin('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()');
  const seal = () => admin('SELECT * FROM phoenix_c4.capability_breaches_v1()');
  const activation = (enabled: boolean) => admin('INSERT INTO phoenix_c4.activation_events(enabled,reason) VALUES($1,$2)', [enabled, 'Explicit disposable native fixture only']);
  const snapshot = async () => (await admin(`SELECT
    (SELECT count(*) FROM public.central_items)::int canonical_items,
    (SELECT count(*) FROM public.central_needs_annual_items)::int memberships,
    (SELECT count(*) FROM public.central_needs_annual_versions)::int versions,
    (SELECT count(*) FROM public.central_needs_annual_occurrences)::int occurrences,
    (SELECT count(*) FROM public.central_needs_annual_receipts)::int receipts,
    (SELECT count(*) FROM public.audit_logs)::int audit,
    (SELECT count(*) FROM phoenix_c4.commits)::int commits`))[0];
  let forbiddenBefore: unknown;
  const forbidden = async () => (await admin(`SELECT
    (SELECT count(*) FROM public.central_needs_manual_need_events)::int manual_events,
    (SELECT count(*) FROM public.central_needs_need_lines)::int need_lines,
    (SELECT count(*) FROM public.warehouse_stock_movements)::int warehouse_movements,
    (SELECT count(*) FROM public.outlet_stock_movements)::int outlet_movements`))[0];
  const registration = { workbookSheets: [{ index: 0, name: 'Identity' }], template: {
    id: 'synthetic-c4-native', version: 1, reviewReference: 'synthetic native C4 review', parserContractVersion: '1.2.0',
    classificationCells: [], blocks: [{ blockId: 'identity', sheetIndex: 0, headerRow: 0, firstRow: 1, lastRow: 9999,
      classification: null, mappingReference: 'synthetic-only', columns: {
        scientificName: { column: 0, expectedHeaderText: 'Name' }, nationalCode: { column: 1, expectedHeaderText: 'Code' },
        unit: { column: 2, expectedHeaderText: 'Unit' },
      } }],
  } };
  async function fixture(unit = 'box') {
    const requestId = randomUUID(), name = `Synthetic C4 ${requestId}`, code = `00-${requestId}`;
    const canonical = (await admin(`INSERT INTO public.central_items(name,name_ar,unit,national_code,status)
      VALUES($1,'مادة اصطناعية','box',$2,'active') RETURNING id`, [name, code]))[0].id as string;
    const fingerprint = (await user<{ canonicalFingerprint: string }>(`SELECT public.phoenix_central_needs_preview_annual_canonical($1,2026,$2) r`, [F.org, canonical])).canonicalFingerprint;
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['Name', 'Code', 'Unit', 'Quantity'], [name, code, unit, 987654],
    ]), 'Identity');
    const bytes = Uint8Array.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    const stored = await user<{ original: C3OriginalMetadata }>(`SELECT public.phoenix_central_needs_store_annual_original($1,2026,$2,$3,$4,$5,$6,$7) r`,
      [F.org, `synthetic-${requestId}.xlsx`, sha(bytes), bytes.length, Buffer.from(bytes).toString('base64'), `source-${requestId}`, F.actor]);
    const downloaded = await user<{ original: C3OriginalMetadata; base64: string }>(`SELECT public.phoenix_central_needs_download_annual_original($1,2026,$2) r`, [F.org, stored.original.originalId]);
    const worker = resolve('.c3-runtime/worker.mjs');
    const page = await runC3IsolatedWorker(pathToFileURL(worker), { source: { scope,
      original: downloaded.original, bytes: Uint8Array.from(Buffer.from(downloaded.base64, 'base64')) },
    template: { manifest: registration, expectedSha256: sha(JSON.stringify(registration)) }, cursor: null, pageSize: 50 });
    expect(page.preparationStatus).toBe('prepared'); expect(JSON.stringify(page)).not.toContain('987654');
    const evidence = { scope: page.scope, original: { ...page.original, firstFilename: downloaded.original.firstFilename },
      template: page.template, coreTemplate: page.coreTemplate, parser: page.parser, registrySha256: page.registrySha256,
      classifications: page.classifications, rows: page.rows, workerSha256: sha(readFileSync(worker)) };
    const args: unknown[] = [F.org, 2026, F.actor, requestId, canonical, fingerprint, JSON.stringify(evidence), 'Explicit synthetic identity review'];
    return { args, requestId, canonical, evidence };
  }
  const prepare = (args: unknown[]) => call<Sealed>('seal', args, null, 'service_role');
  const commitArgs = (proof: Sealed) => [F.org, 2026, proof.requestId, proof.proofId, proof.proofSha256];
  beforeAll(async () => {
    const candidates = {
      'P1_dossier_workbook_reservation_NOT_APPLIED.sql': 'd0f914e47b559fa027e9372beb17dc5cc4fe46affee29b480149b5a3be9440ff',
      'P3A1_annual_catalog_NOT_APPLIED.sql': '1cfab7101634410288702e71bde670d6816ceeaea1dd06a21f510f9cc86e90bf',
      'P3B_annual_needs_audit_NOT_APPLIED.sql': 'a761e97aa8c2c37ed1790d645d55ec26e1945c887f6402f9179d72e6a5d41074',
      'P3C2_annual_originals_NOT_APPLIED.sql': '17cd88fa51492c9b5722c4ae95a31275976360205f82584f46c676b65522f600',
      'P3C4_verified_membership_NOT_APPLIED.sql': '0e6112b48e26ce35681970a1765f333efb1bab33f1ab679ec8194c55840130a7',
    };
    const programs = Object.entries(candidates).map(([file, expected]) => {
      const bytes = readFileSync(new URL(`../${file}`, import.meta.url)); expect(sha(bytes)).toBe(expected); return bytes.toString('utf8');
    });
    const identity = await verifyTarget(); rig = await buildRig({ upTo: 235 });
    expect((await admin('SELECT system_identifier::text sysid FROM pg_control_system()'))[0].sysid).toBe(identity);
    for (const program of programs) {
      await rig.asAdmin(async (c: PoolClient) => { try { await c.query(program); }
        catch (error) { await c.query('ROLLBACK'); throw error; } });
      expect(await oldSeal()).toEqual([]);
    }
    expect(await seal()).toEqual([]);
    await admin(`INSERT INTO public.organizations(id,name,name_ar,code,organization_kind,status) VALUES
      ($1,'C4 synthetic owner','مالك اصطناعي','c4-native-owner','pharmacy_department_authority','active'),
      ($2,'C4 synthetic other','مالك آخر','c4-native-other','pharmacy_department_authority','active')`, [F.org, F.other]);
    for (const [id, owner] of [[F.actor, F.org], [F.second, F.org], [F.viewer, F.org], [F.outsider, F.other]]) {
      await admin('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, `${id}@fixture.invalid`]);
      await admin("UPDATE public.profiles SET organization_id=$2,role='warehouse_officer',status='active',full_name='Synthetic C4 employee' WHERE id=$1", [id, owner]);
      for (const key of ['view', 'edit']) await admin(`INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed)
        VALUES($1,$2,$3) ON CONFLICT(profile_id,permission_key) DO UPDATE SET allowed=excluded.allowed`, [id, `central_needs.${key}`, id !== F.viewer || key === 'view']);
    }
    await user('SELECT public.phoenix_central_needs_open_catalog_year($1,2026,$2) r', [F.org, `open-${randomUUID()}`]);
    forbiddenBefore = await forbidden();
    execFileSync(process.execPath, ['scripts/c3-worker-assets.mjs'], { stdio: 'pipe' });
  }, 120000);
  afterAll(async () => { if (rig) await rig.end(); });

  it('installs inert and preserves old/new seals', async () => {
    expect(await call('catalog_contract', [F.org, 2026])).toMatchObject({ version: 1, enabled: false });
    const f = await fixture(); await expect(prepare(f.args)).rejects.toThrow('c4_not_enabled');
    expect(await oldSeal()).toEqual([]); expect(await seal()).toEqual([]);
  });
  it('separates service preparation, caller commit and direct-table access', async () => {
    const f = await fixture();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await expect(user('SELECT count(*) r FROM phoenix_c4.proofs', [], F.actor, role)).rejects.toThrow(/permission denied/);
    }
    for (const role of ['anon', 'authenticated']) await expect(call('seal', f.args, F.actor, role)).rejects.toThrow(/permission denied/);
    await activation(true);
    const p = await prepare(f.args);
    await expect(call('commit', commitArgs(p), null, 'service_role')).rejects.toThrow(/permission denied/);
    await expect(call('commit', commitArgs(p), F.second)).rejects.toThrow('c4_proof_unavailable');
    await expect(call('commit', commitArgs(p), F.outsider)).rejects.toThrow(/forbidden/);
  });
  it('creates one lawful membership with separate verification and trusted employee snapshot', async () => {
    const f = await fixture(); const p = await prepare(f.args); const before = await snapshot();
    expect(await call('receipt', [F.org, 2026, f.requestId])).toMatchObject({ status: 'prepared' });
    const result = await call<Result>('commit', commitArgs(p));
    expect(result.sourceAttestation).toBe('client_attested'); expect(result.c4Verification).toMatchObject({
      attestation: 'server_verified_c2_extraction_v1', reviewedById: F.actor, reviewedByName: 'Synthetic C4 employee' });
    const after = await snapshot(); expect(after.memberships).toBe(before.memberships + 1);
    expect(after.canonical_items).toBe(before.canonical_items);
    expect(after.versions).toBe(before.versions + 1); expect(after.commits).toBe(before.commits + 1);
    expect(after.occurrences).toBe(before.occurrences + 1); expect(after.receipts).toBe(before.receipts + 1); expect(after.audit).toBe(before.audit + 1);
    expect((await call<Result>('commit', commitArgs(p))).idempotentReplay).toBe(true);
    expect(await snapshot()).toEqual(after);
    expect(await call('receipt', [F.org, 2026, f.requestId])).toMatchObject({ status: 'committed', result: { selectable: false, idempotentReplay: true } });
  });
  it('observes current edit revocation after sealing without deleting the prepared proof', async () => {
    const f = await fixture(); const p = await prepare(f.args); const before = await snapshot();
    await admin("UPDATE public.profile_permission_overrides SET allowed=false WHERE profile_id=$1 AND permission_key='central_needs.edit'", [F.actor]);
    try { await expect(call('commit', commitArgs(p))).rejects.toThrow(/forbidden/);
      expect(await call('receipt', [F.org, 2026, f.requestId])).toMatchObject({ status: 'prepared' }); expect(await snapshot()).toEqual(before);
    } finally { await admin("UPDATE public.profile_permission_overrides SET allowed=true WHERE profile_id=$1 AND permission_key='central_needs.edit'", [F.actor]); }
  });
  it('holds a real source unit conflict and rejects quantity-bearing evidence', async () => {
    const f = await fixture('Vial'); await expect(prepare(f.args)).rejects.toThrow('c4_source_identity_conflict');
    const valid = await fixture(); valid.args[6] = JSON.stringify({ ...valid.evidence, annualQuantity: 987654 });
    await expect(prepare(valid.args)).rejects.toThrow('annual_catalog_payload_invalid');
  });
  it('does not refresh an existing membership merely to attach another proof', async () => {
    const f = await fixture(); const p = await prepare(f.args); await call('commit', commitArgs(p)); const before = await snapshot();
    const second = [...f.args]; second[3] = randomUUID(); const next = await prepare(second);
    await expect(call('commit', commitArgs(next))).rejects.toThrow('annual_catalog_membership_exists');
    expect(await snapshot()).toEqual(before);
  });
  it('binds preparation to the full intent and rejects missing source identity', async () => {
    const f = await fixture(); const p = await prepare(f.args);
    expect(await prepare(f.args)).toEqual(p);
    const changed = [...f.args]; changed[7] = 'Changed review reason';
    await expect(prepare(changed)).rejects.toThrow('c4_idempotency_conflict');
    const invalid = [...f.args]; invalid[3] = randomUUID(); invalid[6] = JSON.stringify({ ...f.evidence,
      original: { ...f.evidence.original, originalId: null } });
    await expect(prepare(invalid)).rejects.toThrow('c4_evidence_identity_invalid');
    expect(await call('receipt', [F.org, 2026, randomUUID()])).toMatchObject({ status: 'missing' });
  });
  it('rechecks canonical drift and stored original metadata before any membership write', async () => {
    const f = await fixture(); const p = await prepare(f.args); const before = await snapshot();
    const oldName = (await admin('SELECT name FROM public.central_items WHERE id=$1', [f.canonical]))[0].name;
    await admin('UPDATE public.central_items SET name=$2 WHERE id=$1', [f.canonical, `${oldName} changed`]);
    try { await expect(call('commit', commitArgs(p))).rejects.toThrow('c4_canonical_stale_or_incomplete'); }
    finally { await admin('UPDATE public.central_items SET name=$2 WHERE id=$1', [f.canonical, oldName]); }
    expect(await snapshot()).toEqual(before);
    const bad = await fixture();
    bad.evidence.original.byteSize += 1; bad.args[6] = JSON.stringify(bad.evidence);
    const invalid = await prepare(bad.args); const secondBefore = await snapshot();
    await expect(call('commit', commitArgs(invalid))).rejects.toThrow('c4_source_binding_invalid');
    expect(await snapshot()).toEqual(secondBefore);
    expect(await call('receipt', [F.org, 2026, bad.requestId])).toMatchObject({ status: 'prepared' });
  });
  it('rolls back membership, version, source, receipt and audit together on a late audit failure', async () => {
    const f = await fixture(); const p = await prepare(f.args); const before = await snapshot();
    await admin(`CREATE FUNCTION public.c4_native_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='central_needs.annual_catalog.c4_add_membership' THEN RAISE EXCEPTION 'synthetic_late_audit_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER c4_native_fail_audit BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.c4_native_fail_audit()`);
    try {
      expect(await oldSeal()).toEqual([]); expect(await seal()).toEqual([]);
      await expect(call('commit', commitArgs(p))).rejects.toThrow('synthetic_late_audit_failure');
      expect(await snapshot()).toEqual(before);
      expect(await call('receipt', [F.org, 2026, f.requestId])).toMatchObject({ status: 'prepared' });
    } finally { await admin('DROP TRIGGER c4_native_fail_audit ON public.audit_logs; DROP FUNCTION public.c4_native_fail_audit()'); }
  });
  it('detects column grants, function attributes and inherited global access without changing old seals', async () => {
    for (const sql of [
      'GRANT SELECT (intent) ON phoenix_c4.proofs TO authenticated',
      'ALTER FUNCTION phoenix_c4.active_v1() STRICT',
      'CREATE ROLE c4_native_global_alias NOLOGIN; GRANT pg_read_all_data TO c4_native_global_alias',
    ]) {
      await rig.asAdmin(async (c: PoolClient) => {
        await c.query('BEGIN');
        try { await c.query(sql);
          expect((await c.query('SELECT * FROM phoenix_c4.capability_breaches_v1()')).rows.length).toBeGreaterThan(0);
        } finally { await c.query('ROLLBACK'); }
      });
      expect(await oldSeal()).toEqual([]); expect(await seal()).toEqual([]);
    }
  });
  it('serializes two concurrent commits of one proof and recovers an unknown response by receipt', async () => {
    const f = await fixture(); const p = await prepare(f.args); const before = await snapshot();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let firstReady!: () => void; const firstDone = new Promise<void>(resolve => { firstReady = resolve; });
    let secondReady!: () => void; const secondStarted = new Promise<void>(resolve => { secondReady = resolve; });
    let pid = 0;
    const first = rig.asUser(F.actor, async (c: PoolClient) => {
      const result = (await c.query(command('commit', commitArgs(p)), commitArgs(p))).rows[0].r as Result;
      firstReady(); await held; return result;
    }, { commit: true });
    let second: Promise<Result> | undefined;
    try {
      await Promise.race([firstDone, first.then(() => { throw new Error('first commit did not hold'); })]);
      second = rig.asUser(F.actor, async (c: PoolClient) => {
        pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid; secondReady();
        return (await c.query(command('commit', commitArgs(p)), commitArgs(p))).rows[0].r as Result;
      }, { commit: true });
      await secondStarted;
      const deadline = Date.now() + 5000; let blocked = false;
      while (Date.now() < deadline) {
        blocked = (await admin("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1", [pid]))[0]?.blocked === true;
        if (blocked) break; await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
    } finally { release(); }
    const results = await Promise.all([first, second!]);
    expect(results.map((r: Result) => r.idempotentReplay).sort()).toEqual([false, true]);
    const after = await snapshot(); expect(after.memberships).toBe(before.memberships + 1); expect(after.commits).toBe(before.commits + 1);
    expect(results[0].membership).toEqual(results[1].membership);
    expect(await call('receipt', [F.org, 2026, f.requestId])).toMatchObject({ status: 'committed', result: { selectable: false } });
    expect(await snapshot()).toEqual(after);
  });
  it('preserves immutable proof and activation history and leaves planning/stock unchanged', async () => {
    const f = await fixture(); await prepare(f.args);
    await expect(admin('UPDATE phoenix_c4.proofs SET sealed_at=clock_timestamp()')).rejects.toThrow('c4_history_immutable');
    await expect(admin('DELETE FROM phoenix_c4.activation_events')).rejects.toThrow('c4_history_immutable');
    expect(await forbidden()).toEqual(forbiddenBefore); expect(await oldSeal()).toEqual([]); expect(await seal()).toEqual([]);
  });
  it('orders owner deactivation after an already admitted transaction, then refuses new writes', async () => {
    const f = await fixture(); const p = await prepare(f.args);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let admitted!: () => void; const admission = new Promise<void>(resolve => { admitted = resolve; });
    const writing = rig.asUser(F.actor, async (c: PoolClient) => {
      const result = (await c.query(command('commit', commitArgs(p)), commitArgs(p))).rows[0].r;
      admitted(); await held; return result;
    }, { commit: true });
    let disabling: Promise<unknown> | undefined;
    try {
      await Promise.race([admission, writing.then(() => { throw new Error('write did not hold'); })]);
      let pid = 0; let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
      disabling = rig.asAdmin(async (c: PoolClient) => {
        pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid; started();
        return c.query("INSERT INTO phoenix_c4.activation_events(enabled,reason) VALUES(false,'Explicit disposable deactivation')");
      });
      await waiting; const deadline = Date.now() + 5000; let blocked = false;
      while (Date.now() < deadline) {
        blocked = (await admin("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1", [pid]))[0]?.blocked === true;
        if (blocked) break; await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
    } finally { release(); await Promise.allSettled([writing, disabling]); }
    try {
      const before = await snapshot(); await expect(call('commit', commitArgs(p))).rejects.toThrow('c4_not_enabled');
      expect(await snapshot()).toEqual(before);
      expect(await call('receipt', [F.org, 2026, f.requestId])).toMatchObject({ status: 'committed' });
    } finally { await activation(true); }
  });
});
