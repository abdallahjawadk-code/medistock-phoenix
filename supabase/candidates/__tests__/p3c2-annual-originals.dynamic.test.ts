import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — canonical disposable PostgreSQL harness is JavaScript.
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import * as originalService from '../../../src/features/central-needs/annual-catalog/annual-originals.service';

const bridge = vi.hoisted(() => ({ run: null as null | ((name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>) }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: (name: string, args: Record<string, unknown> = {}) => {
  if (!bridge.run) throw new Error('Native original-file bridge is not initialized');
  return bridge.run(name, args);
} } }));

const run = rigAvailable() ? describe.sequential : describe.skip;
const MAX_BYTES = 3_145_728;
const F = {
  org: 'c3200000-0000-4000-8000-000000000001', otherOrg: 'c3200000-0000-4000-8000-000000000002',
  actor: 'c3200000-0000-4000-8000-000000000011', second: 'c3200000-0000-4000-8000-000000000012',
  viewer: 'c3200000-0000-4000-8000-000000000013', outsider: 'c3200000-0000-4000-8000-000000000014',
  suspended: 'c3200000-0000-4000-8000-000000000015', actorName: 'موظف حفظ الأصل السنوي', renamed: 'الاسم اللاحق للموظف',
};
const BASELINE_HASHES: Record<string, string> = {
  P1_dossier_workbook_reservation_NOT_APPLIED: 'd0f914e47b559fa027e9372beb17dc5cc4fe46affee29b480149b5a3be9440ff',
  P3A1_annual_catalog_NOT_APPLIED: '1cfab7101634410288702e71bde670d6816ceeaea1dd06a21f510f9cc86e90bf',
  P3B_annual_needs_audit_NOT_APPLIED: 'a761e97aa8c2c37ed1790d645d55ec26e1945c887f6402f9179d72e6a5d41074',
};
const ORIGINAL_TABLES = ['central_needs_annual_originals', 'central_needs_annual_original_uploads'];
const FORBIDDEN_TABLES = ['central_items', 'central_needs_annual_items', 'central_needs_annual_versions',
  'central_needs_annual_sources', 'central_needs_annual_occurrences', 'central_needs_plans', 'central_needs_plan_revisions',
  'central_needs_manual_need_events', 'central_needs_need_lines', 'central_needs_annual_need_bindings',
  'warehouse_stock', 'warehouse_stock_movements', 'outlet_stock', 'outlet_stock_movements', 'phoenix_movement_events'];
type Scope = { ownerOrgId: string; planningYear: number };
type Original = { originalId: string; sha256: string; byteSize: number; firstFilename: string; createdBy: string;
  createdByName: string; createdByRole: string; createdAt: string; attestation: string };
type Upload = { uploadId: string; originalId: string; filename: string; actorId: string; actorName: string; actorRole: string; createdAt: string };
type Write = { scope: Scope; idempotencyKey: string; original: Original; upload: Upload; deduplicated: boolean; idempotentReplay: boolean };
type Input = { scope: Scope; actorId: string; filename: string; sha256: string; byteSize: number; base64: string; idempotencyKey: string };
type Command = { statement: string; args: unknown[]; actor?: string | null; privileged?: boolean };
type Row = Record<string, unknown>;
type RaceResult = { rows?: { r: unknown }[]; error?: Error };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** buildRig drops a database. This guard must pass before calling it. */
async function targetGuard(): Promise<string> {
  const url = new URL(process.env.PHOENIX_RIG_PG ?? '');
  expect(['postgres:', 'postgresql:']).toContain(url.protocol);
  expect(['localhost', '127.0.0.1']).toContain(url.hostname);
  expect(url.username).toBe('postgres'); expect(url.pathname).toBe('/postgres');
  expect(url.search).toBe(''); expect(url.hash).toBe('');
  expect(process.env.PHOENIX_RIG_CANDIDATES || '').toBe('');
  const database = process.env.PHOENIX_RIG_DB || 'phoenix_rig';
  const pinned = process.env.PHOENIX_P3C2_NATIVE_SYSTEM_IDENTIFIER;
  if (pinned) {
    expect(url.hostname).toBe('127.0.0.1'); expect(url.port).toBe('55435');
    expect(database).toBe('phoenix_p3b_20261031'); expect(pinned).toBe('7702777155490152202');
  } else {
    expect(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true').toBe(true);
    expect(url.port).toBe('55432'); expect(database).toBe('phoenix_rig');
  }
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY'); await client.query("SET LOCAL statement_timeout='5s'");
    const { rows: [identity] } = await client.query(`SELECT current_database() db,current_user actor,
      host(inet_server_addr()) address,inet_server_port() port,current_setting('data_directory') directory,
      current_setting('cluster_name') cluster,current_setting('server_version_num')::int version,
      (SELECT system_identifier::text FROM pg_control_system()) sysid`);
    expect(identity.db).toBe('postgres'); expect(identity.actor).toBe('postgres');
    expect([17, 18]).toContain(Math.trunc(identity.version / 10000));
    if (pinned) {
      expect(identity.sysid).toBe(pinned); expect(identity.address).toBe('127.0.0.1'); expect(identity.port).toBe(55435);
      expect(identity.version).toBe(170011); expect(identity.directory).toBe('/tmp/medistock-p3b-pg17-20261031/data');
      expect(identity.cluster).toBe('medistock_p3b_20261031');
    }
    const { rows } = await client.query('SELECT datname,pg_get_userbyid(datdba) owner FROM pg_database WHERE NOT datistemplate');
    expect(rows.every(row => ['postgres', database].includes(row.datname) && row.owner === 'postgres')).toBe(true);
    await client.query('ROLLBACK'); return identity.sysid as string;
  } finally { await client.end(); }
}

run('P3-C2 annual originals / native PostgreSQL', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let forbiddenBefore: Record<string, unknown>;
  let transportFault: 'none' | 'drop_after_commit' | 'read_error' = 'none';
  let committedResponseDropped = false;
  let bridgeActor = F.actor;
  const scope = (year = 2026, owner = F.org): Scope => ({ ownerOrgId: owner, planningYear: year });
  const key = () => `c2-${randomUUID()}`;
  const make = (overrides: Partial<Input> = {}, bytes = Buffer.from(`synthetic,c2,${randomUUID()}\n000123,12\n`)): Input => ({
    scope: scope(), actorId: F.actor, filename: 'مصدر-سنوي.CSV', sha256: hash(bytes), byteSize: bytes.length,
    base64: bytes.toString('base64'), idempotencyKey: key(), ...overrides,
  });
  const command = (suffix: string, args: unknown[], actor = F.actor): Command => ({
    statement: `SELECT public.phoenix_central_needs_${suffix}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args, actor,
  });
  const storeCommand = (input: Input): Command => command('store_annual_original', [input.scope.ownerOrgId, input.scope.planningYear,
    input.filename, input.sha256, input.byteSize, input.base64, input.idempotencyKey, input.actorId], input.actorId);
  const receiptCommand = (input: Input): Command => command('get_annual_original_receipt', [input.scope.ownerOrgId, input.scope.planningYear,
    input.filename, input.sha256, input.byteSize, input.idempotencyKey, input.actorId], input.actorId);
  const admin = async <T extends Row = Row>(statement: string, args: unknown[] = []): Promise<T[]> =>
    rig.asAdmin(async (c: PoolClient) => (await c.query(statement, args)).rows);
  const invoke = async <T = Write>(cmd: Command, role = 'authenticated'): Promise<T> =>
    rig.asUser(cmd.actor ?? null, async (c: PoolClient) => (await c.query(cmd.statement, cmd.args)).rows[0].r, { role, commit: true });
  const store = (input: Input) => invoke(storeCommand(input));
  const readReceipt = (input: Input) => invoke<{ scope: Scope; intent: Omit<Input, 'scope' | 'actorId' | 'base64'>; result: Write | null }>(receiptCommand(input));
  const download = (originalId: string, target = scope(), actor = F.actor) => invoke<{ scope: Scope; original: Original; base64: string }>(
    command('download_annual_original', [target.ownerOrgId, target.planningYear, originalId], actor));
  const list = (target = scope(), limit = 25, after: string | null = null, actor = F.actor) => invoke<{
    scope: Scope; uploads: { original: Original; upload: Upload }[]; nextAfterUploadId: string | null;
  }>(command('list_annual_original_uploads', [target.ownerOrgId, target.planningYear, limit, after], actor));
  const open = (year: number, owner = F.org, actor = F.actor) => invoke(command('open_catalog_year', [owner, year, key()], actor));
  const effects = async () => {
    const result: Record<string, number> = {};
    for (const table of [...ORIGINAL_TABLES, 'central_needs_annual_receipts', 'audit_logs']) {
      result[table] = (await admin<{ n: number }>(`SELECT count(*)::int n FROM public.${table}`))[0].n;
    }
    return result;
  };
  const forbiddenSnapshot = async () => Object.fromEntries(await Promise.all(FORBIDDEN_TABLES.map(async table => [table,
    (await admin(`SELECT count(*)::int n, md5(coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) fingerprint FROM public.${table} t`))[0],
  ])));
  const seal = () => admin('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()');

  beforeAll(async () => {
    const systemIdentifier = await targetGuard();
    rig = await buildRig({ upTo: 235 });
    expect((await admin<{ sysid: string }>('SELECT system_identifier::text sysid FROM pg_control_system()'))[0].sysid).toBe(systemIdentifier);
    for (const [name, sha256] of Object.entries(BASELINE_HASHES)) {
      const bytes = readFileSync(new URL(`../${name}.sql`, import.meta.url)); expect(hash(bytes)).toBe(sha256);
      await admin(bytes.toString('utf8'));
    }
    expect(await seal()).toEqual([]);
    await admin(readFileSync(new URL('../P3C2_annual_originals_NOT_APPLIED.sql', import.meta.url), 'utf8'));
    await admin(`INSERT INTO public.organizations(id,name,name_ar,code,organization_kind,institution_class,status) VALUES
      ($1,'C2 owner','مالك السنة','c2-owner','pharmacy_department_authority',NULL,'active'),
      ($2,'C2 other owner','مالك آخر','c2-other','pharmacy_department_authority',NULL,'active')`, [F.org, F.otherOrg]);
    for (const [id, owner, status] of [[F.actor, F.org, 'active'], [F.second, F.org, 'active'], [F.viewer, F.org, 'active'],
      [F.outsider, F.otherOrg, 'active'], [F.suspended, F.org, 'suspended']]) {
      await admin('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, `${id}@fixture.invalid`]);
      await admin("UPDATE public.profiles SET role='warehouse_officer',organization_id=$2,status=$3,full_name=$4 WHERE id=$1", [id, owner, status, F.actorName]);
      for (const permission of ['view', 'edit']) await admin(`INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed)
        VALUES($1,$2,$3) ON CONFLICT(profile_id,permission_key) DO UPDATE SET allowed=excluded.allowed`,
      [id, `central_needs.${permission}`, id !== F.viewer || permission === 'view']);
    }
    for (const year of [2026, 2027, 2030, 2031, 2032]) await open(year);
    await open(2026, F.otherOrg, F.outsider);
    forbiddenBefore = await forbiddenSnapshot();
    bridge.run = async (name, args) => {
      expect(name).toMatch(/^phoenix_central_needs_[a-z_]+$/);
      const names = Object.keys(args); expect(names.every(item => /^p_[a-z][a-z0-9_]*$/.test(item))).toBe(true);
      if (transportFault === 'read_error' && name.includes('list_')) throw new Error('Synthetic read transport failure');
      const cmd: Command = { statement: `SELECT public.${name}(${names.map((arg, i) => `${arg} => $${i + 1}`).join(',')}) r`,
        args: Object.values(args), actor: bridgeActor };
      try {
        const data = await invoke<unknown>(cmd);
        if (transportFault === 'drop_after_commit' && name.endsWith('store_annual_original')) {
          committedResponseDropped = true;
          throw new Error('Synthetic response lost after actual commit');
        }
        return { data, error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : String(error),
          code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined } };
      }
    };
  }, 900_000);
  afterAll(async () => { bridge.run = null; if (rig) await rig.end(); }, 30_000);

  it('C2-01/03/06 exposes a bounded capability under an actual restricted actor and closes the full seal', async () => {
    expect(await rig.asUser(F.actor, async (c: PoolClient) => (await c.query(`SELECT current_user role,auth.uid() actor,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0]))
      .toEqual({ role: 'authenticated', actor: F.actor, rolsuper: false, rolbypassrls: false });
    expect(await originalService.getAnnualOriginalsContract()).toEqual({ version: 1, scope: 'owner_year', maxFileBytes: MAX_BYTES,
      extensions: ['xls', 'xlsx', 'csv'], attestation: 'server_received_original', atomicReceipt: true, intentBoundReplay: true });
    expect(await seal()).toEqual([]);
    expect(await invoke(command('annual_needs_contract', []))).toMatchObject({ quantityBinding: true, annualEdits: true, actorSnapshots: true });
  });

  it('C2-01 stores exact opaque bytes and returns their trusted receipt, immutable metadata and equivalent download', async () => {
    const input = make(); const first = await store(input);
    expect(first).toMatchObject({ scope: input.scope, idempotencyKey: input.idempotencyKey, deduplicated: false, idempotentReplay: false,
      original: { sha256: input.sha256, byteSize: input.byteSize, firstFilename: input.filename, createdBy: F.actor,
        createdByName: F.actorName, createdByRole: 'warehouse_officer', attestation: 'server_received_original' },
      upload: { filename: input.filename, actorId: F.actor, actorName: F.actorName, actorRole: 'warehouse_officer' } });
    expect(first.original.originalId).toBe(first.upload.originalId); expect(first.original.createdAt).toBe(first.upload.createdAt);
    expect(Number.isFinite(Date.parse(first.original.createdAt))).toBe(true);
    const downloaded = await download(first.original.originalId); expect(downloaded.original).toEqual(first.original);
    expect(downloaded.base64).toBe(input.base64); expect(hash(Buffer.from(downloaded.base64, 'base64'))).toBe(input.sha256);
    expect((await readReceipt(input)).result).toEqual({ ...first, idempotentReplay: true });
  });

  it('C2-01 enforces the exact 3 MiB boundary and download integrity at the database', async () => {
    const bytes = Buffer.alloc(MAX_BYTES, 0xa5); const input = make({}, bytes); const first = await store(input);
    const downloaded = await download(first.original.originalId); expect(downloaded.base64).toBe(input.base64);
    const before = await effects(); await expect(store(make({}, Buffer.alloc(MAX_BYTES + 1, 0xa6)))).rejects.toThrow();
    expect(await effects()).toEqual(before);
  });

  it.each([
    ['empty bytes', { byteSize: 0, base64: '', sha256: hash(Buffer.alloc(0)) }],
    ['wrong digest', { sha256: '0'.repeat(64) }], ['wrong size', { byteSize: 1 }],
    ['invalid alphabet', { base64: '$$$$' }], ['noncanonical whitespace', { base64: 'dGVzdA==\n', byteSize: 4, sha256: hash(Buffer.from('test')) }],
    ['nonzero pad bits', { base64: 'dGVzdB==', byteSize: 4, sha256: hash(Buffer.from('test')) }],
    ['missing padding', { base64: 'dGVzdA', byteSize: 4, sha256: hash(Buffer.from('test')) }],
    ['url-safe alphabet', { base64: '_w==', byteSize: 1, sha256: hash(Buffer.from([255])) }],
    ['uppercase digest', { sha256: 'A'.repeat(64) }], ['oversized encoded input', { base64: 'A'.repeat((MAX_BYTES / 3) * 4 + 4) }],
  ] as [string, Partial<Input>][])('C2-01 rejects %s without a partial effect', async (_label, changed) => {
    const before = await effects(); await expect(store(make(changed))).rejects.toThrow(); expect(await effects()).toEqual(before);
  });

  it.each(['', 'source.pdf', 'source.zip', ' source.csv', 'source.csv ', '../source.xls', 'dir\\source.xlsx',
    'source\n.csv', 'source\u202e.csv', '~$source.xlsx', `${'x'.repeat(252)}.csv`, `${'😀'.repeat(126)}.csv`])
    ('C2-01 rejects filename %j without effects', async filename => {
      const before = await effects(); await expect(store(make({ filename }))).rejects.toThrow(); expect(await effects()).toEqual(before);
    });

  it('C2-02 exactly replays a committed key without new original/event/receipt/audit and rejects changed intent', async () => {
    const input = make(); const first = await store(input); const before = await effects();
    expect(await store(input)).toEqual({ ...first, idempotentReplay: true });
    for (const changed of [{ ...input, filename: 'renamed.csv' }, { ...input, scope: scope(2027) },
      make({ idempotencyKey: input.idempotencyKey }), make({ idempotencyKey: input.idempotencyKey }, Buffer.from('different size'))]) {
      await expect(store(changed)).rejects.toThrow(); await expect(readReceipt(changed)).rejects.toThrow();
    }
    await expect(store({ ...input, base64: Buffer.from('unmatched bytes').toString('base64') })).rejects.toThrow();
    expect(await effects()).toEqual(before);
  });

  it('C2-02 shares the existing annual key namespace and keeps actor keys distinct', async () => {
    const used = key(); await invoke(command('open_catalog_year', [F.org, 2026, used]));
    const blocked = make({ idempotencyKey: used }); const before = await effects();
    await expect(store(blocked)).rejects.toThrow(); await expect(readReceipt(blocked)).rejects.toThrow(); expect(await effects()).toEqual(before);
    const first = make(); const a = await store(first); const b = await store({ ...first, actorId: F.second });
    expect(b.deduplicated).toBe(true); expect(b.original).toEqual(a.original); expect(b.upload.actorId).toBe(F.second);
    expect(b.upload.uploadId).not.toBe(a.upload.uploadId);
  });

  it('C2-02/03 retains one original and distinct truthful filename/upload events; dedup never crosses owner or year', async () => {
    const input = make(); const first = await store(input); const alias = await store({ ...input, filename: 'second-name.XLSX', idempotencyKey: key() });
    expect(alias.original).toEqual(first.original); expect(alias.deduplicated).toBe(true); expect(alias.upload.filename).toBe('second-name.XLSX');
    expect(alias.upload.uploadId).not.toBe(first.upload.uploadId);
    const nextYear = await store({ ...input, scope: scope(2027), idempotencyKey: key() });
    const otherOwner = await store({ ...input, scope: scope(2026, F.otherOrg), actorId: F.outsider, idempotencyKey: key() });
    expect(nextYear.deduplicated).toBe(false); expect(otherOwner.deduplicated).toBe(false);
    expect(new Set([first.original.originalId, nextYear.original.originalId, otherOwner.original.originalId]).size).toBe(3);
    const before = await effects(); await expect(download(first.original.originalId, scope(2027))).rejects.toThrow();
    await expect(download(first.original.originalId, scope(2026, F.otherOrg), F.outsider)).rejects.toThrow(); expect(await effects()).toEqual(before);
  });

  it('C2-03 reads with view permission and refuses foreign/inactive/anonymous/service-role access without effects', async () => {
    const input = make(); const first = await store(input); const before = await effects();
    expect((await download(first.original.originalId, scope(), F.viewer)).base64).toBe(input.base64);
    for (const actor of [F.viewer, F.outsider, F.suspended, null, rig.superAdminId]) {
      await expect(invoke({ ...storeCommand(input), actor })).rejects.toThrow();
    }
    for (const actor of [F.outsider, F.suspended, null, rig.superAdminId]) {
      await expect(invoke({ ...command('download_annual_original', [F.org, 2026, first.original.originalId]), actor })).rejects.toThrow();
    }
    for (const role of ['anon', 'service_role']) {
      await expect(invoke(storeCommand(input), role)).rejects.toThrow(); await expect(invoke(receiptCommand(input), role)).rejects.toThrow();
      await expect(invoke(command('annual_originals_contract', []), role)).rejects.toThrow();
    }
    expect((await readReceipt({ ...input, actorId: F.second })).result).toBeNull(); expect(await effects()).toEqual(before);
  });

  it('C2-03 binds capture and reconciliation to the initiating actor before any effect or receipt replay', async () => {
    const input = make(); const before = await effects();
    for (const expectedActor of [F.second, null]) for (const build of [storeCommand, receiptCommand]) {
      const cmd = build(input); cmd.args[cmd.args.length - 1] = expectedActor;
      await expect(invoke(cmd)).rejects.toMatchObject({ code: '42501' });
    }
    // A real session switch is refused even though both employees may edit this owner/year.
    await expect(invoke({ ...storeCommand(input), actor: F.second })).rejects.toMatchObject({ code: '42501' });
    expect(await effects()).toEqual(before);
    const saved = await store(input); const committed = await effects();
    await expect(invoke({ ...receiptCommand(input), actor: F.second })).rejects.toMatchObject({ code: '42501' });
    expect((await readReceipt(input)).result).toEqual({ ...saved, idempotentReplay: true });
    expect(await effects()).toEqual(committed);
  });

  it('C2-02/05 refuses snapshot isolation for capture and reconciliation so receipt negatives use fresh committed state', async () => {
    const input = make(); const before = await effects();
    for (const cmd of [storeCommand(input), receiptCommand(input)]) {
      const client = await rig.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await client.query('SET LOCAL ROLE authenticated');
        await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [F.actor]);
        await expect(client.query(cmd.statement, cmd.args)).rejects.toMatchObject({ code: '25000' });
      } finally { await client.query('ROLLBACK'); client.release(); }
    }
    expect(await effects()).toEqual(before);
  });

  it('C2-03 requires an existing active year for new capture, while exact replay and receipt survive archival', async () => {
    const input = make({ scope: scope(2031) }); const first = await store(input);
    await admin("UPDATE public.central_needs_catalog_years SET status='archived' WHERE organization_id=$1 AND planning_year=2031", [F.org]);
    const before = await effects(); expect(await store(input)).toEqual({ ...first, idempotentReplay: true });
    expect((await readReceipt(input)).result).toEqual({ ...first, idempotentReplay: true });
    expect((await download(first.original.originalId, input.scope)).base64).toBe(input.base64);
    await expect(store({ ...input, idempotencyKey: key() })).rejects.toThrow();
    await expect(store(make({ scope: scope(2040) }))).rejects.toThrow(); expect(await effects()).toEqual(before);
  });

  it('C2-03 snapshots the employee name, refuses a missing new name and rechecks current authority before replay', async () => {
    const input = make(); const first = await store(input);
    try {
      await admin('UPDATE public.profiles SET full_name=$2 WHERE id=$1', [F.actor, F.renamed]);
      expect((await store(input)).upload.actorName).toBe(F.actorName);
      expect((await download(first.original.originalId)).original.createdByName).toBe(F.actorName);
      const alias = await store({ ...input, idempotencyKey: key() }); expect(alias.upload.actorName).toBe(F.renamed); expect(alias.original).toEqual(first.original);
      await admin("UPDATE public.profiles SET full_name='   ' WHERE id=$1", [F.actor]);
      const before = await effects(); await expect(store(make())).rejects.toThrow(); expect(await effects()).toEqual(before);
      await admin("UPDATE public.profiles SET status='suspended' WHERE id=$1", [F.actor]);
      await expect(store(input)).rejects.toThrow(); await expect(readReceipt(input)).rejects.toThrow(); expect(await effects()).toEqual(before);
    } finally { await admin("UPDATE public.profiles SET full_name=$2,status='active' WHERE id=$1", [F.actor, F.actorName]); }
  });

  it('C2-03/06 denies direct relation/column/helper access and guards privileged accidental history mutation', async () => {
    await store(make()); const before = await effects();
    for (const table of ORIGINAL_TABLES) {
      const rls = (await admin('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [`public.${table}`]))[0];
      expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      for (const role of ['anon', 'authenticated', 'service_role']) {
        for (const statement of [`SELECT * FROM public.${table}`, `SELECT id FROM public.${table}`, `DELETE FROM public.${table}`]) {
          await expect(rig.asUser(F.actor, (c: PoolClient) => c.query(statement), { role })).rejects.toThrow(/permission denied/);
        }
      }
      await expect(admin(`UPDATE public.${table} SET created_at=clock_timestamp()`)).rejects.toThrow();
      await expect(admin(`DELETE FROM public.${table}`)).rejects.toThrow(); await expect(admin(`TRUNCATE public.${table}`)).rejects.toThrow();
    }
    for (const statement of [
      'SELECT phoenix_private.annual_original_object_v1($1)', 'SELECT phoenix_private.annual_original_upload_object_v1($1)',
    ]) for (const role of ['anon', 'authenticated', 'service_role']) {
      await expect(rig.asUser(F.actor, (c: PoolClient) => c.query(statement, [randomUUID()]), { role })).rejects.toThrow(/permission denied/);
    }
    expect(await effects()).toEqual(before);
  });

  it('C2-03 lists uploads by immutable server time/UUID, binds cursors to scope and never reports read errors as empty', async () => {
    const target = scope(2030); const first = await store(make({ scope: target }));
    const second = await store(make({ scope: target })); const third = await store(make({ scope: target }));
    const rows: string[] = []; let after: string | null = null;
    do { const page = await list(target, 1, after); expect(page.scope).toEqual(target); expect(page.uploads).toHaveLength(1);
      rows.push(page.uploads[0].upload.uploadId); after = page.nextAfterUploadId; } while (after !== null && rows.length < 5);
    expect(rows).toEqual([first.upload.uploadId, second.upload.uploadId, third.upload.uploadId]);
    expect((await list(target, 50)).uploads).toHaveLength(3); await expect(list(target, 51)).rejects.toThrow();
    await expect(list(scope(), 1, first.upload.uploadId)).rejects.toThrow(); await expect(list(target, 1, randomUUID())).rejects.toThrow();
  });

  it('C2-05 carries real database JSON through preparation/capture/list/download and resolves a lost committed response without another write', async () => {
    const bytes = new Uint8Array([0, 255, 1, 2, 3, 128]);
    const input = await originalService.prepareAnnualOriginalFile({ scope: scope(), actorId: F.actor,
      file: { name: 'opaque.xls', size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer }, idempotencyKey: key() });
    const before = await effects(); committedResponseDropped = false; transportFault = 'drop_after_commit';
    try { await expect(originalService.storeAnnualOriginal(input)).rejects.toMatchObject({ outcomeUnknown: true }); }
    finally { transportFault = 'none'; }
    expect(committedResponseDropped).toBe(true);
    const committed = await effects(); expect(committed.central_needs_annual_originals).toBe(before.central_needs_annual_originals + 1);
    const receipt = await originalService.getAnnualOriginalReceipt(originalService.annualOriginalIntent(input)); expect(receipt.result).not.toBeNull();
    expect(receipt.result?.upload.actorId).toBe(F.actor);
    transportFault = 'read_error';
    try { await expect(originalService.listAnnualOriginalUploads(scope())).rejects.toThrow(); } finally { transportFault = 'none'; }
    expect(await effects()).toEqual(committed);
    const downloaded = await originalService.downloadAnnualOriginal(scope(), receipt.result!.original.originalId);
    expect(new Uint8Array(await downloaded.blob.arrayBuffer())).toEqual(bytes);
    expect(await originalService.storeAnnualOriginal(input)).toEqual(receipt.result);
    expect(await effects()).toEqual(committed);
    const alien = { ...originalService.annualOriginalIntent(input), actorId: F.second };
    bridgeActor = F.second;
    try { expect((await originalService.getAnnualOriginalReceipt(alien)).result).toBeNull(); } finally { bridgeActor = F.actor; }
  });

  it('C2-05 returns a truthful absent receipt and permits only intent-identical key reuse', async () => {
    const input = make(); const before = await effects(); expect((await readReceipt(input)).result).toBeNull(); expect(await effects()).toEqual(before);
    const first = await store(input); expect((await readReceipt(input)).result).toEqual({ ...first, idempotentReplay: true });
    await expect(readReceipt({ ...input, filename: 'other.csv' })).rejects.toThrow();
  });

  it('C2-01/06 rolls back original, upload and audit when the required shared receipt cannot be inserted', async () => {
    const input = make(); const before = await effects(); const client = await rig.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("ALTER TABLE public.central_needs_annual_receipts ADD CONSTRAINT c2_test_receipt_failure CHECK (action <> 'store_original_v1') NOT VALID");
      await client.query('SET LOCAL ROLE authenticated'); await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [F.actor]);
      const cmd = storeCommand(input); await expect(client.query(cmd.statement, cmd.args)).rejects.toThrow(/c2_test_receipt_failure/);
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect(await effects()).toEqual(before); expect((await readReceipt(input)).result).toBeNull(); expect(await seal()).toEqual([]);
  });

  it('C2-06 detects a deliberately broadened column grant and restores the closed seal on rollback', async () => {
    const client = await rig.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('GRANT SELECT (id) ON public.central_needs_annual_originals TO authenticated');
      expect((await client.query('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).rows.length).toBeGreaterThan(0);
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect(await seal()).toEqual([]);
  });

  it('C2-06 rejects an extra same-name RPC overload even when its direct grants are revoked', async () => {
    const client = await rig.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("CREATE FUNCTION public.phoenix_central_needs_store_annual_original(text) RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $$ SELECT '{}'::jsonb $$");
      await client.query('REVOKE ALL ON FUNCTION public.phoenix_central_needs_store_annual_original(text) FROM PUBLIC,anon,authenticated,service_role');
      expect((await client.query('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).rows.length).toBeGreaterThan(0);
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect(await seal()).toEqual([]);
  });

  async function begin(cmd: Command) {
    const c = await rig.pool.connect(); await c.query('BEGIN'); await c.query("SET LOCAL statement_timeout='12s'");
    if (!cmd.privileged) { await c.query('SET LOCAL ROLE authenticated'); await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [cmd.actor ?? F.actor]); }
    return c as PoolClient;
  }
  async function blocked(blocker: number, waiter: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await admin<{ blocked: boolean }>('SELECT $1::int=ANY(pg_blocking_pids($2::int)) blocked', [blocker, waiter]))[0].blocked) return true;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return false;
  }
  async function race(first: Command, second: Command, commit = true) {
    const a = await begin(first); const b = await begin(second); let pending: Promise<RaceResult> | undefined;
    try {
      const apid = (await a.query('SELECT pg_backend_pid() id')).rows[0].id; const bpid = (await b.query('SELECT pg_backend_pid() id')).rows[0].id;
      expect(apid).not.toBe(bpid); const initial = await a.query(first.statement, first.args);
      pending = b.query(second.statement, second.args).then(result => ({ rows: result.rows }), (error: Error) => ({ error }));
      expect(await blocked(apid, bpid), 'actual independent-session wait observed').toBe(true);
      await a.query(commit ? 'COMMIT' : 'ROLLBACK'); const result = await pending; await b.query(result.error ? 'ROLLBACK' : 'COMMIT');
      return { initial: initial.rows[0]?.r, ...result };
    } finally { await a.query('ROLLBACK'); if (pending) await pending; await b.query('ROLLBACK'); a.release(); b.release(); }
  }

  it.each([true, false])('C2-04 same-key contenders create exactly one committed effect after predecessor commit=%s', async commit => {
    const input = make(); const before = await effects(); const result = await race(storeCommand(input), storeCommand(input), commit);
    expect(result.error).toBeUndefined(); expect((result.rows?.[0].r as Write).idempotentReplay).toBe(commit);
    const after = await effects(); for (const table of Object.keys(after)) expect(after[table] - before[table], table).toBe(1);
    expect((await download((result.rows?.[0].r as Write).original.originalId)).base64).toBe(input.base64);
  });

  it.each([true, false])('C2-04 distinct-key aliases retain one original and ordered evidence after predecessor commit=%s', async commit => {
    const first = make(); const second = { ...first, filename: 'second.xlsx', idempotencyKey: key() }; const before = await effects();
    const result = await race(storeCommand(first), storeCommand(second), commit); expect(result.error).toBeUndefined();
    const saved = result.rows?.[0].r as Write; expect(saved.deduplicated).toBe(commit);
    expect(saved.original.firstFilename).toBe(commit ? first.filename : second.filename); expect(saved.upload.filename).toBe(second.filename);
    const after = await effects(); expect(after.central_needs_annual_originals - before.central_needs_annual_originals).toBe(1);
    for (const table of ['central_needs_annual_original_uploads', 'central_needs_annual_receipts', 'audit_logs']) expect(after[table] - before[table]).toBe(commit ? 2 : 1);
  });

  it.each([true, false])('C2-04/05 reconciliation waits for the exact in-flight key and sees its committed state=%s', async commit => {
    const input = make(); const result = await race(storeCommand(input), receiptCommand(input), commit); expect(result.error).toBeUndefined();
    const receipt = result.rows?.[0].r as { result: Write | null };
    if (commit) expect(receipt.result).toEqual({ ...(result.initial as Write), idempotentReplay: true }); else expect(receipt.result).toBeNull();
  });

  it.each([true, false])('C2-04 profile rename serializes the historical uploader snapshot (renameFirst=%s)', async renameFirst => {
    const input = make(); const rename: Command = { statement: 'UPDATE public.profiles SET full_name=$2 WHERE id=$1', args: [F.actor, F.renamed], privileged: true };
    try {
      const result = await race(renameFirst ? rename : storeCommand(input), renameFirst ? storeCommand(input) : rename); expect(result.error).toBeUndefined();
      const saved = (renameFirst ? result.rows?.[0].r : result.initial) as Write;
      expect(saved.upload.actorName).toBe(renameFirst ? F.renamed : F.actorName); expect(saved.original.createdByName).toBe(saved.upload.actorName);
    } finally { await admin('UPDATE public.profiles SET full_name=$2 WHERE id=$1', [F.actor, F.actorName]); }
  });

  it.each([true, false])('C2-04 profile suspension serializes capture and current authority (suspendFirst=%s)', async suspendFirst => {
    const input = make(); const suspend: Command = { statement: "UPDATE public.profiles SET status='suspended' WHERE id=$1", args: [F.actor], privileged: true };
    const before = await effects();
    try {
      const result = await race(suspendFirst ? suspend : storeCommand(input), suspendFirst ? storeCommand(input) : suspend);
      if (suspendFirst) { expect(result.error).toBeDefined(); expect(await effects()).toEqual(before); }
      else { expect(result.error).toBeUndefined(); await expect(readReceipt(input)).rejects.toThrow(); }
    } finally { await admin("UPDATE public.profiles SET status='active' WHERE id=$1", [F.actor]); }
  });

  it.each([true, false])('C2-04 year archival serializes new capture (archiveFirst=%s)', async archiveFirst => {
    const input = make({ scope: scope(2032) }); const archive: Command = { statement: "UPDATE public.central_needs_catalog_years SET status='archived' WHERE organization_id=$1 AND planning_year=2032", args: [F.org], privileged: true };
    const before = await effects();
    try {
      const result = await race(archiveFirst ? archive : storeCommand(input), archiveFirst ? storeCommand(input) : archive);
      if (archiveFirst) { expect(result.error).toBeDefined(); expect(await effects()).toEqual(before); }
      else { expect(result.error).toBeUndefined(); expect((await readReceipt(input)).result?.original).toEqual((result.initial as Write).original); }
    } finally { await admin("UPDATE public.central_needs_catalog_years SET status='active' WHERE organization_id=$1 AND planning_year=2032", [F.org]); }
  });

  it('C2-06 leaves canonical materials, annual memberships/witnesses, plans, needs and stock byte-equivalent to the pre-C2-use state', async () => {
    expect(await forbiddenSnapshot()).toEqual(forbiddenBefore); expect(await seal()).toEqual([]);
    for (const [name, sha256] of Object.entries(BASELINE_HASHES)) expect(hash(readFileSync(new URL(`../${name}.sql`, import.meta.url)))).toBe(sha256);
  });
});
