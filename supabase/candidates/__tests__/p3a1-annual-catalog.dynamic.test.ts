import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — the shared canonical disposable rig is JavaScript.
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
// @ts-expect-error — shared executable legacy-writer acceptance cases.
import { annualDossierCases } from '../../../tools/pg-rig/annual-dossier-acceptance.mjs';
// @ts-expect-error — shared executable matrix intake acceptance cases.
import { dossierMatrixCases } from '../../../tools/pg-rig/dossier-matrix-acceptance.mjs';
import { extractAnnualIdentityBlock } from '../../../src/features/central-needs/annual-catalog/annual-catalog-source';
import { cell, simpleInput } from '../../../src/features/central-needs/annual-catalog/__tests__/fixture-helpers';
import { validateAnnualCatalogItem, validateCanonicalPreview } from '../../../src/features/central-needs/annual-catalog/annual-catalog-server.contract';
import type { AnnualCatalogMembership, AnnualFieldVersion, AnnualSourceOccurrence } from '../../../src/features/central-needs/annual-catalog/annual-catalog.contract';

const run = rigAvailable() ? describe.sequential : describe.skip;
const F = {
  org: 'a1000000-0000-4000-8000-000000000001', otherOrg: 'a1000000-0000-4000-8000-000000000002',
  actor: 'a1000000-0000-4000-8000-000000000011', viewer: 'a1000000-0000-4000-8000-000000000012',
  outsider: 'a1000000-0000-4000-8000-000000000013', inactive: 'a1000000-0000-4000-8000-000000000014',
  noView: 'a1000000-0000-4000-8000-000000000015',
};
const TABLES = ['central_needs_catalog_years', 'central_needs_annual_items', 'central_needs_annual_versions',
  'central_needs_annual_sources', 'central_needs_annual_occurrences', 'central_needs_annual_request_contexts',
  'central_needs_annual_request_resolutions', 'central_needs_annual_receipts'];
const BUSINESS_TABLES = ['central_needs_plans', 'central_needs_plan_revisions', 'central_needs_need_lines',
  'central_needs_manual_need_events', 'warehouse_stock', 'warehouse_stock_movements', 'outlet_stock',
  'outlet_stock_movements', 'phoenix_movement_events'];
type Row = Record<string, unknown>;
type Result = {
  scope: { ownerOrgId: string; planningYear: number }; membership: AnnualCatalogMembership;
  fieldVersion: AnnualFieldVersion; canonicalFingerprint: string; canonicalDrift: boolean;
  selectable: boolean; selectionBlockers: string[]; sourceOccurrenceCount: number;
  sourceAttestation: string; idempotentReplay: boolean; requestId?: string;
};
type Preview = { canonicalItemId: string; canonicalFingerprint: string; canonicalSnapshot: Row; eligible: boolean; missingRequired: string[] };
type Request = { requestId: string; status: string; version: number; idempotentReplay: boolean };
type Pending = Promise<{ rows?: { r: Result }[]; error?: Error }>;

/** No buildRig/drop is reachable before this local-target proof. The CI service is
 * addressed through its loopback published port; its server-side address can be
 * a Docker bridge. Local runs additionally pin the already-observed cluster ID. */
async function nativeTargetGuard() {
  const raw = process.env.PHOENIX_RIG_PG ?? '';
  const url = new URL(raw);
  expect(['postgres:', 'postgresql:']).toContain(url.protocol);
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect(url.pathname).toBe('/postgres');
  expect(url.search).toBe('');
  expect(url.hash).toBe('');
  const ci = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true';
  const database = process.env.PHOENIX_RIG_DB || 'phoenix_rig';
  const pinned = process.env.PHOENIX_A1_NATIVE_SYSTEM_IDENTIFIER;
  if (pinned) {
    expect(url.hostname).toBe('127.0.0.1'); expect(url.port).toBe('55434');
    expect(url.username).toBe('postgres'); expect(database).toBe('phoenix_p3a1_20261031');
    expect(process.env.PHOENIX_A1_NATIVE_DATA_DIRECTORY).toBe('/tmp/medistock-p3a1-pg17-20261031/data');
    expect(process.env.PHOENIX_A1_NATIVE_CLUSTER).toBe('medistock_p3a1_20261031');
  } else {
    expect(ci, 'unattested non-CI native target refused').toBe(true);
    expect(url.port).toBe('55432'); expect(url.username).toBe('postgres');
    expect(['phoenix_rig', 'phoenix_p3a1_ci']).toContain(database);
  }
  expect(process.env.PHOENIX_RIG_CANDIDATES || '').toBe('');
  const client = new pg.Client({ connectionString: raw, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const { rows: [identity] } = await client.query(`SELECT current_database() db, current_user actor,
      host(inet_server_addr()) address, inet_server_port() port,
      current_setting('data_directory') directory, current_setting('cluster_name') cluster,
      current_setting('server_version_num')::int version,
      (SELECT system_identifier::text FROM pg_control_system()) sysid`);
    expect(identity.db).toBe('postgres'); expect(identity.actor).toBe(url.username);
    expect([17, 18]).toContain(Math.trunc(identity.version / 10000));
    if (pinned) {
      expect(identity.sysid).toBe(pinned); expect(identity.address).toBe('127.0.0.1'); expect(identity.port).toBe(55434);
      expect(identity.directory).toBe(process.env.PHOENIX_A1_NATIVE_DATA_DIRECTORY);
      expect(identity.cluster).toBe(process.env.PHOENIX_A1_NATIVE_CLUSTER);
    }
    const { rows } = await client.query('SELECT datname FROM pg_database WHERE NOT datistemplate');
    expect(rows.every(({ datname }) => ['postgres', database].includes(datname))).toBe(true);
    return identity.sysid as string;
  } finally { await client.end(); }
}

run('P3-A1 annual catalog / native PostgreSQL', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let businessBefore: Record<string, number>;
  const candidate = readFileSync(new URL('../P3A1_annual_catalog_NOT_APPLIED.sql', import.meta.url), 'utf8');
  const key = () => `a1-${randomUUID()}`;
  const scope = (year: number, owner = F.org) => ({ ownerOrgId: owner, planningYear: year });
  const receipt = (result: Result) => ({ ...result, idempotentReplay: true, selectable: false,
    selectionBlockers: [...result.selectionBlockers, 'receipt_replay_requires_refresh'] });
  const sql = (name: string, args: unknown[]) => `SELECT public.phoenix_central_needs_${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`;
  const admin = async <T extends Row = Row>(query: string, args: unknown[] = []): Promise<T[]> =>
    rig.asAdmin(async (c: PoolClient) => (await c.query(query, args)).rows);
  const call = async <T = Result>(name: string, args: unknown[], actor: string | null = F.actor, role = 'authenticated'): Promise<T> =>
    rig.asUser(actor, async (c: PoolClient) => (await c.query(sql(name, args), args)).rows[0].r, { role, commit: true });
  const open = (year: number, op = key(), owner = F.org) => call<{ idempotentReplay: boolean }>('open_catalog_year', [owner, year, op]);
  const preview = (year: number, item: string) => call<Preview>('preview_annual_canonical', [F.org, year, item]);
  const get = (year: number, id: string, version: string | null = null, owner = F.org) => call('get_annual_catalog_item', [owner, year, id, version]);
  const search = (year: number, query = '', limit = 50, cursor: unknown = null, owner = F.org) =>
    call<{ items: Result[]; nextCursor: Record<string, unknown> | null }>('search_annual_catalog', [owner, year, query, limit, cursor === null ? null : JSON.stringify(cursor)]);
  const counts = async (tables = TABLES) => Object.fromEntries(await Promise.all(tables.map(async t => [t, (await admin<{ n: number }>(`SELECT count(*)::int n FROM public.${t}`))[0].n]))) as Record<string, number>;
  const witness = (year: number, label = key()) => {
    const input = simpleInput(); input.scope = scope(year); input.sourceScope = scope(year); input.sourceId = label;
    input.parsed.input.sha256 = label.replaceAll('-', '').padEnd(64, 'a').slice(0, 64).replace(/[^0-9a-f]/g, 'a');
    return extractAnnualIdentityBlock(input);
  };
  const seedItem = async (label = key(), options: { unit?: string; code?: string | null; status?: string } = {}) =>
    (await admin<{ id: string }>(`INSERT INTO public.central_items(name,name_ar,unit,status,national_code)
      VALUES($1,'مادة اختبار الفهرس',$2,$3,$4) RETURNING id`, [label, options.unit ?? 'box', options.status ?? 'active',
      options.code === undefined ? `A1-${randomUUID()}` : options.code]))[0].id;
  const addArgs = async (year: number, item: string, occurrences: AnnualSourceOccurrence[] = [], op = key()) =>
    [F.org, year, item, (await preview(year, item)).canonicalFingerprint, JSON.stringify(occurrences), 'Explicit canonical selection', op];
  const add = async (year: number, item: string, occurrences: AnnualSourceOccurrence[] = [], op = key()) =>
    call('add_annual_catalog_item', await addArgs(year, item, occurrences, op));
  const refreshArgs = async (year: number, result: Result, op = key()) => [F.org, year, result.membership.annualItemId,
    result.fieldVersion.fieldVersionId, (await preview(year, result.membership.canonicalItemId!)).canonicalFingerprint, '[]', 'Explicit canonical refresh', op];

  beforeAll(async () => {
    const sysid = await nativeTargetGuard();
    rig = await buildRig({ upTo: 235 });
    expect((await admin<{ sysid: string }>('SELECT system_identifier::text sysid FROM pg_control_system()'))[0].sysid).toBe(sysid);
    for (const source of [readFileSync(new URL('../P1_dossier_workbook_reservation_NOT_APPLIED.sql', import.meta.url), 'utf8'), candidate]) {
      await rig.asAdmin(async (c: PoolClient) => { try { await c.query(source); } catch (error) { await c.query('ROLLBACK'); throw error; } });
    }
    await admin(`INSERT INTO public.organizations(id,name,name_ar,code,organization_kind,status) VALUES
      ($1,'A1 PDA','دائرة الفهرس','a1-pda','pharmacy_department_authority','active'),
      ($2,'Other A1 PDA','دائرة أخرى','a1-other','pharmacy_department_authority','active')`, [F.org, F.otherOrg]);
    for (const [id, owner, status] of [[F.actor,F.org,'active'],[F.viewer,F.org,'active'],[F.outsider,F.otherOrg,'active'],[F.inactive,F.org,'suspended'],[F.noView,F.org,'active']]) {
      await admin('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, `${id}@fixture.invalid`]);
      await admin("UPDATE public.profiles SET role='warehouse_officer',organization_id=$2,status=$3 WHERE id=$1", [id, owner, status]);
      for (const permission of ['view','edit','manual_need.set','approve','material_review']) {
        const allowed = id === F.viewer ? permission === 'view' : id === F.noView ? permission !== 'view' : true;
        await admin(`INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed) VALUES($1,$2,$3)
          ON CONFLICT(profile_id,permission_key) DO UPDATE SET allowed=excluded.allowed`, [id, `central_needs.${permission}`, allowed]);
      }
    }
    businessBefore = await counts(BUSINESS_TABLES);
  }, 900000);
  afterAll(async () => { if (rig) await rig.end(); }, 30000);

  it('uses a real restricted authenticated role and exposes the bounded server contract', async () => {
    const identity = await rig.asUser(F.actor, async (c: PoolClient) => (await c.query(`SELECT current_user role,
      auth.uid() actor, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0]);
    expect(identity).toEqual({ role: 'authenticated', actor: F.actor, rolsuper: false, rolbypassrls: false });
    expect(await call('annual_catalog_contract', [])).toEqual({ version: 1, scope: 'owner_year', canonicalSnapshots: true,
      sourceAttestation: 'client_attested', quantityBinding: false });
  });

  it('opens empty independent years before quantity activation and never infers membership from the global catalog', async () => {
    await seedItem('A1 globally present but not a yearly member');
    await open(2026); await open(2027);
    expect((await search(2026)).items).toEqual([]); expect((await search(2027)).items).toEqual([]);
    expect(await counts(BUSINESS_TABLES)).toEqual(businessBefore);
  });

  it('requires explicit annual membership, keeps the two year identities separate, and builds fields only from canonical data', async () => {
    const item = await seedItem('A1 canonical source', { code: '000123-A1' });
    const livePreview=await preview(2026,item);
    expect(validateCanonicalPreview(livePreview,scope(2026),item)).toEqual(livePreview);
    const source = witness(2026); const observation = source[0].fields.scientificName;
    if(observation.state !== 'value') throw new Error('synthetic source must have a name');
    observation.text = 'Conflicting source name'; observation.witness.cell.rawValue = 'Conflicting source name';
    const a = await add(2026, item, source); const b = await add(2027, item);
    expect(a.scope).toEqual(scope(2026)); expect(a.membership.scope).toEqual(scope(2026)); expect(a.fieldVersion.scope).toEqual(scope(2026));
    expect(a.membership.annualItemId).not.toBe(b.membership.annualItemId);
    expect(a.fieldVersion.fieldVersionId).not.toBe(b.fieldVersion.fieldVersionId);
    expect(a.fieldVersion.fields.scientificName).toMatchObject({ state: 'known', value: 'A1 canonical source' });
    expect(a.fieldVersion.fields.nationalCode).toMatchObject({ state: 'known', value: '000123-A1' });
    expect(a.fieldVersion.fields.dosageForm.state).toBe('missing');
    expect(a.selectable).toBe(true); expect(a.sourceAttestation).toBe('client_attested'); expect(a.sourceOccurrenceCount).toBe(1);
    expect(validateAnnualCatalogItem(a,scope(2026),{canonicalItemId:item,current:true,write:true})).toEqual(a);
    const occurrences = await call<{ occurrences: AnnualSourceOccurrence[]; attestation: string }>('list_annual_catalog_occurrences', [F.org, 2026, a.membership.annualItemId, 50, null]);
    expect(occurrences.attestation).toBe('client_attested');
    expect(occurrences.occurrences[0].fields.scientificName).toMatchObject({ state: 'value', text: 'Conflicting source name' });
    await expect(get(2027, a.membership.annualItemId)).rejects.toThrow(/scope|not_found|missing/);
    await expect(get(2026, a.membership.annualItemId, b.fieldVersion.fieldVersionId)).rejects.toThrow(/scope|version|not_found/);
  });

  it('keeps old fields immutable after canonical drift and explicit CAS refresh; another year retains its old version', async () => {
    const item = await seedItem('A1 original immutable name'); const a = await add(2026, item); const b = await add(2027, item);
    await admin('UPDATE public.central_items SET name=$2 WHERE id=$1', [item, 'A1 changed canonical name']);
    const stale = await get(2026, a.membership.annualItemId);
    expect(stale.canonicalDrift).toBe(true); expect(stale.selectable).toBe(false); expect(stale.fieldVersion).toEqual(a.fieldVersion);
    const refreshed = await call('refresh_annual_catalog_item', await refreshArgs(2026, a));
    expect(refreshed.fieldVersion.versionNumber).toBe(2); expect(refreshed.selectable).toBe(true);
    expect(refreshed.fieldVersion.fields.scientificName).toMatchObject({ state: 'known', value: 'A1 changed canonical name' });
    const historical=await get(2026,a.membership.annualItemId,a.fieldVersion.fieldVersionId);
    expect(historical.fieldVersion).toEqual(a.fieldVersion);
    expect(validateAnnualCatalogItem(historical,scope(2026),{annualItemId:a.membership.annualItemId,fieldVersionId:a.fieldVersion.fieldVersionId})).toEqual(historical);
    expect((await get(2027, b.membership.annualItemId)).fieldVersion).toEqual(b.fieldVersion);
    await expect(call('refresh_annual_catalog_item', await refreshArgs(2026, a))).rejects.toThrow(/stale|version/);
  });

  it('keeps missing code unselectable and preserves a raw source unit discrepancy without a guessed synonym', async () => {
    const missing = await seedItem('A1 missing code', { code: null });
    const a = await add(2026, missing);
    expect(a.membership.status).toBe('preparing'); expect(a.selectable).toBe(false);
    expect(a.fieldVersion.fields.nationalCode.state).toBe('missing');
    const canonical = await seedItem('A1 legal unit with raw source discrepancy', { unit: 'tablet' });
    const source=witness(2026);const observation=source[0].fields.unit;
    if(observation.state!=='value')throw new Error('synthetic source must have a unit');
    observation.text='tab';observation.witness.cell.rawValue='tab';
    const b = await add(2026, canonical,source);
    expect(b.selectable).toBe(true); expect(b.fieldVersion.fields.unit).toMatchObject({ state: 'known', value: 'tablet' });
    expect(validateAnnualCatalogItem(b,scope(2026),{write:true,current:true})).toEqual(b);
    const raw=await call<{occurrences:AnnualSourceOccurrence[]}>('list_annual_catalog_occurrences',[F.org,2026,b.membership.annualItemId,50,null]);
    expect(raw.occurrences[0].fields.unit).toMatchObject({state:'value',text:'tab'});
    await expect(seedItem('A1 unlawful canonical unit',{unit:'tab'})).rejects.toThrow(/central_items_unit_check/);
  });

  it('literal search, exact-code ranking and bound cursors cannot cross owner/year or change the query', async () => {
    await open(2029);
    const exact = await seedItem('A1 search exact', { code: '0009-A1' });
    for (const item of [exact, await seedItem('A1 other 0009-A1 name'), await seedItem('A1 literal % tablet'), await seedItem('A1 ordinary tablet')]) await add(2029, item);
    const page = await search(2029, '0009-A1', 1); expect(page.items[0].membership.canonicalItemId).toBe(exact);
    expect(page.nextCursor).not.toBeNull();
    const next = await search(2029, '0009-A1', 1, page.nextCursor);
    expect(next.items).toHaveLength(1); expect(next.items[0].membership.annualItemId).not.toBe(page.items[0].membership.annualItemId);
    expect((await search(2029, '%')).items).toHaveLength(1);
    await expect(search(2027, '0009-A1', 1, page.nextCursor)).rejects.toThrow(/cursor|scope/);
    await expect(search(2029, 'changed', 1, page.nextCursor)).rejects.toThrow(/cursor|scope/);
    await expect(search(2029, '0009-A1', 1, { ...page.nextCursor, ownerOrgId: F.otherOrg })).rejects.toThrow(/cursor|scope/);
  });

  it('paginates explicit years without copying their data', async () => {
    const first = await call<{ years: { planningYear: number }[]; nextAfterYear: number | null }>('list_catalog_years', [F.org, 2, null]);
    expect(first.years.map(y => y.planningYear)).toEqual([2029, 2027]); expect(first.nextAfterYear).toBe(2027);
    const rest = await call<{ years: { planningYear: number }[] }>('list_catalog_years', [F.org, 2, first.nextAfterYear]);
    expect(rest.years.map(y => y.planningYear)).toEqual([2026]);
  });

  it('records exact replay once, rejects changed action/year/payload, and rechecks live authority before replay', async () => {
    const item = await seedItem('A1 idempotency'); const op = key(); const args = await addArgs(2026, item, [], op);
    const first = await call('add_annual_catalog_item', args); const before = await counts();
    const repeat = await call('add_annual_catalog_item', args);
    expect(repeat).toEqual(receipt(first)); expect(await counts()).toEqual(before);
    expect(validateAnnualCatalogItem(repeat,scope(2026),{canonicalItemId:item,write:true})).toEqual(repeat);
    await expect(call('add_annual_catalog_item', args.map((v, i) => i === 5 ? 'Changed reason' : v))).rejects.toThrow(/idempotency_conflict/);
    await expect(call('add_annual_catalog_item', args.map((v, i) => i === 1 ? 2027 : v))).rejects.toThrow(/idempotency_conflict/);
    await expect(open(2026, op)).rejects.toThrow(/idempotency_conflict/);
    await admin("UPDATE public.central_items SET status='inactive' WHERE id=$1", [item]);
    expect(await call('add_annual_catalog_item', args)).toEqual(receipt(first));
    expect((await get(2026, first.membership.annualItemId)).selectable).toBe(false);
    try {
      await admin("UPDATE public.profiles SET status='suspended' WHERE id=$1", [F.actor]);
      await expect(call('add_annual_catalog_item', args)).rejects.toThrow(/forbidden|inactive/);
    } finally { await admin("UPDATE public.profiles SET status='active' WHERE id=$1", [F.actor]); }
    expect(await counts()).toEqual(before);
  });

  it('rejects contaminated or forged evidence atomically without retaining its first source, member, receipt or audit', async () => {
    const item = await seedItem('A1 atomic source refusal'); const good = witness(2026); const invalid = witness(2026);
    const before = await counts(); const audits = (await admin<{ n: number }>('SELECT count(*)::int n FROM public.audit_logs'))[0].n;
    const contaminated = { ...invalid[0], quantity: '11520' };
    await expect(call('add_annual_catalog_item', [F.org, 2026, item, (await preview(2026,item)).canonicalFingerprint,
      JSON.stringify([good[0], contaminated]), 'Confirmed source selection', key()])).rejects.toThrow(/source|occurrence|unknown|invalid/);
    const forged = structuredClone(good); forged[0].scope = scope(2027);
    await expect(add(2026, item, forged)).rejects.toThrow(/scope/);
    for(const reason of ['', '   ', '\u00a0', '\ufeff', '\u2003\u202f'])await expect(call('add_annual_catalog_item', [F.org,2026,item,(await preview(2026,item)).canonicalFingerprint,'[]',reason,key()])).rejects.toThrow(/reason/);
    await expect(add(2026,item,Array.from({length:101},()=>structuredClone(good[0])))).rejects.toThrow(/source_limit/);
    expect(await counts()).toEqual(before);
    expect((await admin<{ n: number }>('SELECT count(*)::int n FROM public.audit_logs'))[0].n).toBe(audits);
  });

  it('preserves UTF-16 overlength source evidence without adopting the astral text as a canonical name',async()=>{
    const lengths=await admin<{n:number}>('SELECT phoenix_private.annual_catalog_utf16_length_v1(value) n FROM unnest($1::text[]) WITH ORDINALITY AS t(value,ord) ORDER BY ord',[['','a','أ','🧪','a🧪','🧪'.repeat(3000)]]);
    expect(lengths.map(row=>row.n)).toEqual([0,1,1,2,3,6000]);
    const item=await seedItem('A1 canonical astral witness');const input=simpleInput();input.scope=scope(2026);input.sourceScope=scope(2026);
    input.parsed.input.sha256='f'.repeat(64);const raw='🧪'.repeat(3000);
    const sourceCell=input.parsed.workbook!.sheets[0].cells.find(c=>c.coordinate.row===1&&c.coordinate.col===0)!;
    sourceCell.rawValue=raw;const source=extractAnnualIdentityBlock(input);
    expect(raw.length).toBe(6000);expect(source[0].fields.scientificName).toMatchObject({state:'invalid',reason:'text_too_long'});
    const result=await add(2026,item,source);expect(result.fieldVersion.fields.scientificName).toMatchObject({state:'known',value:'A1 canonical astral witness'});
    const saved=await call<{occurrences:AnnualSourceOccurrence[]}>('list_annual_catalog_occurrences',[F.org,2026,result.membership.annualItemId,50,null]);
    expect(saved.occurrences[0].fields.scientificName).toMatchObject({state:'invalid',reason:'text_too_long',witness:{cell:{rawValue:raw}}});
  });

  it('pages immutable source occurrences by persisted UUID and keeps the 50-row bound',async()=>{
    const item=await seedItem('A1 multiple source rows');const input=simpleInput();input.scope=scope(2026);input.sourceScope=scope(2026);
    input.parsed.input.sha256='e'.repeat(64);input.block.lastRow=51;
    input.parsed.workbook!.sheets[0].cells=input.parsed.workbook!.sheets[0].cells.filter(c=>c.coordinate.row===0);
    for(let row=1;row<=51;row++)input.parsed.workbook!.sheets[0].cells.push(cell(row,0,`Source label ${row}`),cell(row,1,'000123-04'),cell(row,2,'box'));
    const occurrences=extractAnnualIdentityBlock(input);expect(occurrences).toHaveLength(51);
    const result=await add(2026,item,occurrences);expect(result.sourceOccurrenceCount).toBe(51);
    type Page={occurrences:AnnualSourceOccurrence[];nextAfterOccurrenceId:string|null};
    const first=await call<Page>('list_annual_catalog_occurrences',[F.org,2026,result.membership.annualItemId,50,null]);
    const second=await call<Page>('list_annual_catalog_occurrences',[F.org,2026,result.membership.annualItemId,50,first.nextAfterOccurrenceId]);
    expect(first.occurrences).toHaveLength(50);expect(first.nextAfterOccurrenceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.occurrences).toHaveLength(1);expect(second.nextAfterOccurrenceId).toBeNull();
    expect(new Set([...first.occurrences,...second.occurrences].map(o=>o.occurrenceKey)).size).toBe(51);
    await expect(call('list_annual_catalog_occurrences',[F.org,2026,result.membership.annualItemId,51,null])).rejects.toThrow(/page/);
  });

  it('preserves A0 missing-text evidence for Unicode whitespace without inventing an identity',async()=>{
    for(const raw of ['\u00a0','\ufeff','\u2003\u202f']){
      const item=await seedItem();const input=simpleInput();input.scope=scope(2026);input.sourceScope=scope(2026);
      input.parsed.input.sha256=createHash('sha256').update(`A1 whitespace fixture ${raw}`).digest('hex');
      input.parsed.workbook!.sheets[0].cells.find(c=>c.coordinate.row===1&&c.coordinate.col===0)!.rawValue=raw;
      const source=extractAnnualIdentityBlock(input);
      expect(source[0].fields.scientificName).toMatchObject({state:'missing',reason:'empty_text'});
      const member=await add(2026,item,source);
      const saved=await call<{occurrences:AnnualSourceOccurrence[]}>('list_annual_catalog_occurrences',[F.org,2026,member.membership.annualItemId,50,null]);
      expect(saved.occurrences[0].fields.scientificName).toMatchObject({state:'missing',reason:'empty_text',witness:{cell:{rawValue:raw}}});
    }
  });

  it('view-only, missing-view, suspended, foreign-owner, anonymous and nominal super-admin callers do not gain write authority', async () => {
    expect(await call('search_annual_catalog', [F.org,2026,'',50,null], F.viewer)).toHaveProperty('items');
    for (const actor of [F.viewer,F.noView,F.inactive,F.outsider,null,rig.superAdminId]) {
      await expect(call('open_catalog_year',[F.org,2031,key()],actor)).rejects.toThrow(/forbidden|not_authenticated|inactive/);
    }
    await expect(call('search_annual_catalog', [F.org,2026,'',50,null], F.outsider)).rejects.toThrow(/forbidden/);
    await expect(call('open_catalog_year', [F.otherOrg,2031,key()])).rejects.toThrow(/forbidden/);
    for (const role of ['anon','service_role']) await expect(call('open_catalog_year',[F.org,2031,key()],F.actor,role)).rejects.toThrow(/permission denied/);
  });

  it('refuses repeatable-read writes rather than claiming Read Committed race guarantees', async () => {
    const c = await rig.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await c.query('SET LOCAL ROLE authenticated');
      await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [F.actor]);
      const args = [F.org,2032,key()];
      await expect(c.query(sql('open_catalog_year',args),args)).rejects.toThrow(/read_committed/);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('enforces forced RLS and denies actual SELECT/DML/private-helper calls from every API role', async () => {
    const relations = await admin<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      'SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=ANY($1::regclass[])', [TABLES.map(t => `public.${t}`)]);
    expect(relations).toHaveLength(8); expect(relations.every(r => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
    for (const table of TABLES) for (const role of ['anon','authenticated','service_role']) {
      for (const statement of [`SELECT * FROM public.${table} LIMIT 1`, `DELETE FROM public.${table} WHERE false`]) {
        await expect(rig.asUser(F.actor, (c: PoolClient) => c.query(statement), {role})).rejects.toThrow(/permission denied/);
      }
    }
    const helpers = await admin<{ name: string; types: string }>(`SELECT p.proname name,oidvectortypes(p.proargtypes) types
      FROM pg_proc p WHERE p.pronamespace='phoenix_private'::regnamespace AND p.proname LIKE 'annual_catalog_%'`);
    expect(helpers.length).toBeGreaterThan(5);
    for (const helper of helpers) {
      const args = helper.types ? helper.types.split(',').map(t => `NULL::${t.trim()}`).join(',') : '';
      for (const role of ['anon','authenticated','service_role']) await expect(rig.asUser(F.actor,
        (c: PoolClient) => c.query(`SELECT phoenix_private.${helper.name}(${args})`), {role})).rejects.toThrow(/permission denied/);
    }
  });

  it('protects immutable versions, witnesses, receipt history and member identity even against accidental owner SQL', async () => {
    const item = await seedItem('A1 immutable row guards'); const a = await add(2026,item,witness(2026));
    const before = await counts();
    for (const statement of [
      'UPDATE public.central_needs_annual_versions SET reason=reason WHERE annual_item_id=$1',
      'DELETE FROM public.central_needs_annual_versions WHERE annual_item_id=$1',
      'UPDATE public.central_needs_annual_occurrences SET fields=fields WHERE annual_item_id=$1',
      'DELETE FROM public.central_needs_annual_occurrences WHERE annual_item_id=$1',
      'UPDATE public.central_needs_annual_items SET planning_year=2027 WHERE id=$1',
      'UPDATE public.central_needs_annual_items SET central_item_id=gen_random_uuid() WHERE id=$1',
      'DELETE FROM public.central_needs_annual_items WHERE id=$1',
    ]) await expect(admin(statement,[a.membership.annualItemId])).rejects.toThrow(/append|immutable|history/);
    await expect(admin('UPDATE public.central_needs_annual_sources SET filename=filename')).rejects.toThrow(/append/);
    await expect(admin('UPDATE public.central_needs_annual_receipts SET result=result')).rejects.toThrow(/append/);
    await expect(admin('TRUNCATE public.central_needs_annual_receipts')).rejects.toThrow(/append/);
    expect(await counts()).toEqual(before); expect((await get(2026,a.membership.annualItemId)).fieldVersion).toEqual(a.fieldVersion);
  });

  it('does not allow a physical source witness to be rebound to another member or edited under a different preparation key', async () => {
    const item = await seedItem('A1 source ownership'); const source = witness(2026); const a = await add(2026,item,source);
    const before = await counts(); const other = await seedItem('A1 source rebound');
    const sameCell = structuredClone(source); sameCell[0].occurrenceKey = 'different-client-preparation-key'; sameCell[0].source.sourceId = 'different-client-source-id';
    await expect(add(2026,other,sameCell)).rejects.toThrow(/occurrence|source|conflict|bound/);
    expect(await counts()).toEqual(before);
    const refresh = await refreshArgs(2026,a); refresh[5] = JSON.stringify(sameCell);
    const replayedWitness = await call('refresh_annual_catalog_item',refresh);
    expect(replayedWitness.sourceOccurrenceCount).toBe(1);
  });

  it('detects deliberate direct-grant and unlisted-RPC controls and returns to a clean capability seal', async () => {
    const seal = () => admin('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()');
    expect(await seal()).toEqual([]);
    for(const mutation of ['GRANT SELECT ON public.central_needs_annual_items TO authenticated',
      'GRANT SELECT ON public.central_needs_annual_items TO service_role',
      'GRANT SELECT(id) ON public.central_needs_annual_items TO authenticated',
      `CREATE FUNCTION public.phoenix_central_needs_a1_unlisted_probe() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN IF false THEN UPDATE public.central_needs_annual_items SET status=status; END IF; END $$`]){
      await rig.asAdmin(async(c:PoolClient)=>{await c.query('BEGIN');try{await c.query(mutation);
        expect((await c.query('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).rows.length).toBeGreaterThan(0);
      }finally{await c.query('ROLLBACK');}});
      expect(await seal()).toEqual([]);
    }
    expect(await seal()).toEqual([]);
  });

  it('keeps manual registration under the existing activation guard, then completes the legal review into one explicit year', async () => {
    await open(2034); await open(2035);
    const descriptor = {scientificName:`Annual manual ${randomUUID()}`,nameAr:'مادة يدوية',unit:'test',nationalCode:`A1-REG-${randomUUID()}`};
    const operation = key(); const before = await counts();
    await expect(call('create_annual_material_request',[F.org,2034,JSON.stringify(descriptor),operation])).rejects.toThrow(/manual|activat/);
    expect(await counts()).toEqual(before);
    await admin('SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1)',[F.org]);
    const request = await call<Request>('create_annual_material_request',[F.org,2034,JSON.stringify(descriptor),operation]);
    expect(request.status).toBe('draft'); expect(request.version).toBe(1);
    expect(await call('create_annual_material_request',[F.org,2034,JSON.stringify(descriptor),operation])).toEqual({...request,idempotentReplay:true});
    await expect(call('create_annual_material_request',[F.org,2035,JSON.stringify(descriptor),operation])).rejects.toThrow(/idempotency_conflict/);
    await expect(call('complete_annual_material_request',[F.org,2034,request.requestId,1,'0'.repeat(64),'Explicit completion',key()])).rejects.toThrow(/request|resolved|approved/);
    await call('submit_material_request',[request.requestId,1]); await call('start_material_review',[request.requestId,2]);
    const approved = await call<{central_item_id:string}>('approve_material_with_code',[request.requestId,3,[],null,descriptor.nationalCode]);
    expect((await search(2034)).items).toEqual([]); expect((await search(2035)).items).toEqual([]);
    const fingerprint = (await preview(2034,approved.central_item_id)).canonicalFingerprint;
    await expect(call('complete_annual_material_request',[F.org,2035,request.requestId,4,fingerprint,'Explicit completion',key()])).rejects.toThrow(/scope|request|context/);
    await expect(call('complete_annual_material_request',[F.org,2034,request.requestId,3,fingerprint,'Explicit completion',key()])).rejects.toThrow('annual_catalog_request_not_resolved');
    const args=[F.org,2034,request.requestId,4,fingerprint,'Explicit completion',key()];
    const completed=await call('complete_annual_material_request',args);
    expect(completed.membership.canonicalItemId).toBe(approved.central_item_id); expect(completed.requestId).toBe(request.requestId);
    expect(completed.selectable).toBe(true); expect((await search(2034)).items).toHaveLength(1); expect((await search(2035)).items).toEqual([]);
    expect(await call('complete_annual_material_request',args)).toEqual(receipt(completed));
    const context=(await admin('SELECT organization_id,planning_year FROM public.central_needs_annual_request_contexts WHERE request_id=$1',[request.requestId]))[0];
    expect(context).toEqual({organization_id:F.org,planning_year:2034});
    await expect(admin('UPDATE public.central_needs_annual_request_contexts SET planning_year=2035 WHERE request_id=$1',[request.requestId])).rejects.toThrow(/append/);
    await expect(admin('UPDATE public.central_needs_annual_request_resolutions SET request_version=request_version WHERE request_id=$1',[request.requestId])).rejects.toThrow(/append/);
  });

  it('resolves an existing legal material through its existing review and reuses the matching annual membership', async () => {
    const item=await seedItem('A1 existing legal registration material',{unit:'test'}); const member=await add(2034,item);
    const canonical=(await preview(2034,item)).canonicalSnapshot;
    const descriptor={scientificName:canonical.scientificName,unit:'test',nationalCode:canonical.nationalCode};
    const r=await call<Request>('create_annual_material_request',[F.org,2034,JSON.stringify(descriptor),key()]);
    await call('submit_material_request',[r.requestId,1]); await call('start_material_review',[r.requestId,2]);
    await call('resolve_material_existing_with_code',[r.requestId,3,item,'Confirmed existing material',canonical.nationalCode,true]);
    const before=await counts(); const completed=await call('complete_annual_material_request',
      [F.org,2034,r.requestId,4,(await preview(2034,item)).canonicalFingerprint,'Link to existing annual membership',key()]);
    expect(completed.membership.annualItemId).toBe(member.membership.annualItemId);
    expect((await counts()).central_needs_annual_items).toBe(before.central_needs_annual_items);
  });

  async function begin(authenticated: boolean) {
    const c = await rig.pool.connect(); await c.query('BEGIN'); await c.query("SET LOCAL statement_timeout='12s'");
    if(authenticated){await c.query('SET LOCAL ROLE authenticated');await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[F.actor]);}
    return c as PoolClient;
  }
  async function blocked(blocker:number,waiter:number) {
    const until=Date.now()+5000;
    while(Date.now()<until){
      if((await admin<{blocked:boolean}>('SELECT $1::int=ANY(pg_blocking_pids($2::int)) blocked',[blocker,waiter]))[0].blocked)return true;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    return false;
  }
  async function race(first:{statement:string;args:unknown[];auth:boolean},second:{statement:string;args:unknown[];auth:boolean},commit=true){
    const a=await begin(first.auth);const b=await begin(second.auth);let pending:Pending|undefined;
    try{
      const aid=(await a.query('SELECT pg_backend_pid() id')).rows[0].id;const bid=(await b.query('SELECT pg_backend_pid() id')).rows[0].id;
      expect(aid).not.toBe(bid);
      const initial=await a.query(first.statement,first.args);
      pending=b.query(second.statement,second.args).then(result=>({rows:result.rows}),(error:Error)=>({error}));
      expect(await blocked(aid,bid),'second independent backend actually waited for first').toBe(true);
      await a.query(commit?'COMMIT':'ROLLBACK');const result=await pending;
      await b.query(result.error?'ROLLBACK':'COMMIT');
      return {initial:initial.rows[0]?.r as Result|undefined,...result};
    }finally{await a.query('ROLLBACK');if(pending)await pending;await b.query('ROLLBACK');a.release();b.release();}
  }
  const command=(name:string,args:unknown[])=>({statement:sql(name,args),args,auth:true});
  const yearlyCount=async(year:number)=>(await admin<{n:number}>('SELECT count(*)::int n FROM public.central_needs_annual_items WHERE organization_id=$1 AND planning_year=$2',[F.org,year]))[0].n;

  it.each([true,false])('native duplicate command waits and creates one immutable outcome (first commit=%s)',async(commit)=>{
    const year=commit?2040:2041;await open(year);const item=await seedItem();const args=await addArgs(year,item);
    const result=await race(command('add_annual_catalog_item',args),command('add_annual_catalog_item',args),commit);
    expect(result.error).toBeUndefined();expect(result.rows?.[0].r.idempotentReplay).toBe(commit);expect(await yearlyCount(year)).toBe(1);
    expect((await admin<{n:number}>('SELECT count(*)::int n FROM public.central_needs_annual_versions WHERE organization_id=$1 AND planning_year=$2',[F.org,year]))[0].n).toBe(1);
    expect((await admin<{n:number}>('SELECT count(*)::int n FROM public.central_needs_annual_receipts WHERE organization_id=$1 AND idempotency_key=$2',[F.org,args[6]]))[0].n).toBe(1);
  },30000);

  it.each([true,false])('native different operation keys cannot create two memberships for one annual material (first commit=%s)',async(commit)=>{
    const year=commit?2044:2045;await open(year);const item=await seedItem();const a=await addArgs(year,item);const b=await addArgs(year,item);
    const result=await race(command('add_annual_catalog_item',a),command('add_annual_catalog_item',b),commit);
    if(commit)expect(result.error?.message).toBe('annual_catalog_membership_exists');else expect(result.error).toBeUndefined();
    expect(await yearlyCount(year)).toBe(1);
    expect((await admin<{n:number}>('SELECT count(*)::int n FROM public.central_needs_annual_versions WHERE organization_id=$1 AND planning_year=$2',[F.org,year]))[0].n).toBe(1);
  },30000);

  it.each([true,false])('native compare-and-swap refresh has one winner and no lost head (first commit=%s)',async(commit)=>{
    const year=commit?2042:2043;await open(year);const item=await seedItem();const member=await add(year,item);
    const a=await refreshArgs(year,member);const b=await refreshArgs(year,member);
    const result=await race(command('refresh_annual_catalog_item',a),command('refresh_annual_catalog_item',b),commit);
    if(commit)expect(result.error?.message).toMatch(/stale|version/);else expect(result.error).toBeUndefined();
    const current=await get(year,member.membership.annualItemId);expect(current.fieldVersion.versionNumber).toBe(2);
    expect((await get(year,member.membership.annualItemId,member.fieldVersion.fieldVersionId)).fieldVersion).toEqual(member.fieldVersion);
    expect((await admin<{n:number}>('SELECT count(*)::int n FROM public.central_needs_annual_versions WHERE annual_item_id=$1',[member.membership.annualItemId]))[0].n).toBe(2);
  },30000);

  const canonicalCases=[true,false].flatMap(commit=>['canonical','annual'].flatMap(first=>['name','status'].map(field=>({commit,first,field}))));
  it.each(canonicalCases)('native canonical $field change / $first first / commit=$commit preserves the locked snapshot',async({commit,first,field})=>{
    const year=2050+canonicalCases.findIndex(c=>c.commit===commit&&c.first===first&&c.field===field);
    await open(year);const item=await seedItem();const args=await addArgs(year,item);
    const mutation={statement:`UPDATE public.central_items SET ${field}=$2 WHERE id=$1`,args:[item,field==='status'?'inactive':'A1 changed while waiting'],auth:false};
    const creation=command('add_annual_catalog_item',args);
    const result=await race(first==='canonical'?mutation:creation,first==='canonical'?creation:mutation,commit);
    if(first==='canonical'){
      if(commit){expect(result.error?.message).toMatch(/canonical|stale|inactive/);expect(await yearlyCount(year)).toBe(0);}
      else{expect(result.error).toBeUndefined();expect(await yearlyCount(year)).toBe(1);}
    }else{
      expect(result.error).toBeUndefined();expect(await yearlyCount(year)).toBe(commit?1:0);
      if(commit){const now=await get(year,result.initial!.membership.annualItemId);expect(now.canonicalDrift).toBe(true);expect(now.selectable).toBe(false);}
    }
  },30000);

  const eligibilityCases=[true,false].flatMap(commit=>['eligibility','annual'].flatMap(first=>['profile','owner'].map(target=>({commit,first,target}))));
  it.each(eligibilityCases)('native $target eligibility / $first first / commit=$commit stabilizes authority through the write',async({commit,first,target})=>{
    const year=2070+eligibilityCases.findIndex(c=>c.commit===commit&&c.first===first&&c.target===target);
    await open(year);const item=await seedItem();const creation=command('add_annual_catalog_item',await addArgs(year,item));
    const mutation={statement:target==='profile'?"UPDATE public.profiles SET status='suspended' WHERE id=$1":"UPDATE public.organizations SET status='inactive' WHERE id=$1",args:[target==='profile'?F.actor:F.org],auth:false};
    try{
      const result=await race(first==='eligibility'?mutation:creation,first==='eligibility'?creation:mutation,commit);
      if(first==='eligibility'&&commit){expect(result.error?.message).toMatch(/forbidden|inactive|archived/);expect(await yearlyCount(year)).toBe(0);}
      else{expect(result.error).toBeUndefined();expect(await yearlyCount(year)).toBe(first==='annual'&&!commit?0:1);}
      if(target==='owner')expect((await admin<{archived:boolean}>('SELECT archived_at IS NOT NULL archived FROM public.organizations WHERE id=$1',[F.org]))[0].archived).toBe(first==='annual'||commit);
    }finally{
      await admin("UPDATE public.profiles SET status='active' WHERE id=$1",[F.actor]);
      await admin("UPDATE public.organizations SET status='active' WHERE id=$1",[F.org]);
    }
  },30000);

  it('retains all quantity, need, allocation and stock behavior and refuses candidate reapplication',async()=>{
    expect(await counts(BUSINESS_TABLES)).toEqual(businessBefore);
    expect(await admin('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).toEqual([]);
    await expect(rig.asAdmin(async(c:PoolClient)=>{try{await c.query(candidate);}catch(error){await c.query('ROLLBACK');throw error;}})).rejects.toThrow(/annual catalog already exists/);
    expect(await admin('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).toEqual([]);
  });

  // These existing scenarios execute against A1's added relations and seal.
  // They intentionally create their own needs after the catalog-only no-effect
  // assertion above. FF2 emergency containment is not applied to this new census.
  const existingWriterDriver={
    admin,
    script:async(statement:string)=>rig.asAdmin(async(c:PoolClient)=>{try{return await c.query(statement);}catch(error){await c.query('ROLLBACK');throw error;}}),
    as:async(actor:string|null,statement:string,args:unknown[]=[])=>rig.asUser(actor,async(c:PoolClient)=>(await c.query(statement,args)).rows,{commit:true}),
    asRole:async(role:string,actor:string|null,statement:string,args:unknown[]=[])=>rig.asUser(actor,async(c:PoolClient)=>(await c.query(statement,args)).rows,{role,commit:true}),
  };
  for(const test of [...annualDossierCases(existingWriterDriver),...dossierMatrixCases(existingWriterDriver)]){
    it(`existing P1 writer after A1: ${test.name}`,test.run,120000);
  }
});
