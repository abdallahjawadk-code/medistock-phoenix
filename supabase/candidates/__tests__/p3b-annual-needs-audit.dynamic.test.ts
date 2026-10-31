import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — canonical disposable PostgreSQL harness is JavaScript.
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
// @ts-expect-error — existing executable acceptance, reused under the new seal.
import { annualDossierCases } from '../../../tools/pg-rig/annual-dossier-acceptance.mjs';
// @ts-expect-error — existing executable intake/reservation acceptance.
import { dossierMatrixCases } from '../../../tools/pg-rig/dossier-matrix-acceptance.mjs';
import { extractAnnualIdentityBlock } from '../../../src/features/central-needs/annual-catalog/annual-catalog-source';
import { simpleInput } from '../../../src/features/central-needs/annual-catalog/__tests__/fixture-helpers';
import { validateAnnualCatalogItem } from '../../../src/features/central-needs/annual-catalog/annual-catalog-server.contract';
import {
  editableAnnualFields, validateAnnualCatalogChange, validateAnnualCatalogEdit,
  validateAnnualNeedEvent, validateAnnualNeedsContract, validateAnnualNeedWrite,
  type AnnualCatalogEditResult, type AnnualEditableFields, type AnnualNeedEvent,
  type AnnualNeedWriteInput, type AnnualNeedWriteResult, type EditAnnualCatalogItemInput,
} from '../../../src/features/central-needs/annual-catalog/annual-needs.contract';
import type { AnnualCatalogItemResult } from '../../../src/features/central-needs/annual-catalog/annual-catalog-server.contract';
import * as annualNeedsService from '../../../src/features/central-needs/annual-catalog/annual-needs.service';
import { readAnnualNeeds } from '../../../src/features/central-needs/manual/dossier.service';

const rpcBridge = vi.hoisted(() => ({
  run: null as null | ((name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>),
}));
vi.mock('@/shared/supabase/client', () => ({ supabase: {
  rpc: (name: string, args: Record<string, unknown> = {}) => {
    if (!rpcBridge.run) throw new Error('Native SQL bridge has not been initialized');
    return rpcBridge.run(name, args);
  },
} }));

const run = rigAvailable() ? describe.sequential : describe.skip;
const F = {
  org: 'b3000000-0000-4000-8000-000000000001', otherOrg: 'b3000000-0000-4000-8000-000000000002',
  hospital: 'b3000000-0000-4000-8000-000000000003', hospital2: 'b3000000-0000-4000-8000-000000000004',
  actor: 'b3000000-0000-4000-8000-000000000011', viewer: 'b3000000-0000-4000-8000-000000000012',
  outsider: 'b3000000-0000-4000-8000-000000000013', inactive: 'b3000000-0000-4000-8000-000000000014',
  actorName: 'موظف التحقق السنوي', renamed: 'اسم الموظف بعد التغيير',
};
const ANNUAL_TABLES = ['central_needs_annual_items', 'central_needs_annual_versions',
  'central_needs_annual_catalog_changes', 'central_needs_annual_need_bindings',
  'central_needs_annual_receipts', 'central_needs_manual_need_events', 'central_needs_need_lines', 'audit_logs'];
const STOCK_TABLES = ['warehouse_stock', 'warehouse_stock_movements', 'outlet_stock', 'outlet_stock_movements', 'phoenix_movement_events'];
type Row = Record<string, unknown>;
type Args = Record<string, unknown>;
type Command = { statement: string; args: unknown[]; authenticated: boolean };
type RaceResult = { rows?: { r: unknown }[]; error?: Error };
type Item = AnnualCatalogItemResult & { idempotentReplay?: boolean };

/** buildRig destroys its named database. No call to it precedes this proof. */
async function targetGuard(): Promise<string> {
  const url = new URL(process.env.PHOENIX_RIG_PG ?? '');
  expect(['postgres:', 'postgresql:']).toContain(url.protocol);
  expect(['localhost', '127.0.0.1']).toContain(url.hostname);
  expect(url.username).toBe('postgres'); expect(url.pathname).toBe('/postgres');
  expect(url.search).toBe(''); expect(url.hash).toBe('');
  expect(process.env.PHOENIX_RIG_CANDIDATES || '').toBe('');
  const database = process.env.PHOENIX_RIG_DB || 'phoenix_rig';
  const pinned = process.env.PHOENIX_P3B_NATIVE_SYSTEM_IDENTIFIER;
  if (pinned) {
    expect(url.hostname).toBe('127.0.0.1'); expect(url.port).toBe('55435');
    expect(database).toBe('phoenix_p3b_20261031');
    expect(process.env.PHOENIX_P3B_NATIVE_DATA_DIRECTORY).toBe('/tmp/medistock-p3b-pg17-20261031/data');
    expect(process.env.PHOENIX_P3B_NATIVE_CLUSTER).toBe('medistock_p3b_20261031');
  } else {
    expect(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true').toBe(true);
    expect(url.port).toBe('55432'); expect(database).toBe('phoenix_rig');
  }
  const c = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  await c.connect();
  try {
    const { rows: [identity] } = await c.query(`SELECT current_database() db,current_user actor,
      host(inet_server_addr()) address,inet_server_port() port,current_setting('data_directory') directory,
      current_setting('cluster_name') cluster,current_setting('server_version_num')::int version,
      (SELECT system_identifier::text FROM pg_control_system()) sysid`);
    expect(identity.db).toBe('postgres'); expect(identity.actor).toBe('postgres');
    expect([17, 18]).toContain(Math.trunc(identity.version / 10000));
    if (pinned) {
      expect(identity.sysid).toBe(pinned); expect(identity.address).toBe('127.0.0.1'); expect(identity.port).toBe(55435);
      expect(identity.directory).toBe(process.env.PHOENIX_P3B_NATIVE_DATA_DIRECTORY);
      expect(identity.cluster).toBe(process.env.PHOENIX_P3B_NATIVE_CLUSTER);
    }
    const { rows } = await c.query('SELECT datname,pg_get_userbyid(datdba) owner FROM pg_database WHERE NOT datistemplate');
    expect(rows.every(row => ['postgres', database].includes(row.datname) && row.owner === 'postgres')).toBe(true);
    return identity.sysid as string;
  } finally { await c.end(); }
}

run('P3-B annual needs / reasoned edits / native PostgreSQL', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let stockBefore: Record<string, number>;
  let historical: { item: Item; revision: string; eventId: string };
  const key = () => `p3b-${randomUUID()}`;
  const scope = (year = 2026, owner = F.org) => ({ ownerOrgId: owner, planningYear: year });
  const sql = (suffix: string, args: unknown[]) => `SELECT public.phoenix_central_needs_${suffix}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`;
  const named = (suffix: string, args: Args): Command => {
    const names = Object.keys(args); expect(names.every(name => /^p_[a-z_]+$/.test(name))).toBe(true);
    return { statement: `SELECT public.phoenix_central_needs_${suffix}(${names.map((name, i) => `${name} => $${i + 1}`).join(',')}) r`, args: Object.values(args), authenticated: true };
  };
  const admin = async <T extends Row = Row>(statement: string, args: unknown[] = []): Promise<T[]> =>
    rig.asAdmin(async (c: PoolClient) => (await c.query(statement, args)).rows);
  const call = async <T = Item>(suffix: string, args: unknown[], actor: string | null = F.actor, role = 'authenticated'): Promise<T> =>
    rig.asUser(actor, async (c: PoolClient) => (await c.query(sql(suffix, args), args)).rows[0].r, { role, commit: true });
  const invoke = async <T>(command: Command, actor: string | null = F.actor): Promise<T> =>
    rig.asUser(actor, async (c: PoolClient) => (await c.query(command.statement, command.args)).rows[0].r, { commit: true });
  const counts = async (tables = ANNUAL_TABLES): Promise<Record<string, number>> => Object.fromEntries(await Promise.all(tables.map(async table =>
    [table, (await admin<{ n: number }>(`SELECT count(*)::int n FROM public.${table}`))[0].n])));
  const open = (year = 2026, owner = F.org, actor = F.actor) => call('open_catalog_year', [owner, year, key()], actor);
  const preview = async (item: string, year = 2026) => call<{ canonicalFingerprint: string; canonicalSnapshot: AnnualEditableFields }>('preview_annual_canonical', [F.org, year, item]);
  const get = (item: Item, version: string | null = null) => call('get_annual_catalog_item', [item.scope.ownerOrgId, item.scope.planningYear, item.membership.annualItemId, version]);
  const seedItem = async () => (await admin<{ id: string }>(`INSERT INTO public.central_items
    (name,name_ar,national_code,barcode,dosage_form,concentration,unit,status)
    VALUES($1,'الاسم السنوي الأصلي',$2,$3,'Capsules','500 mg','box','active') RETURNING id`,
  [`P3-B material ${key()}`, `000-${randomUUID()}`, `BAR-${randomUUID()}`]))[0].id;
  const member = async (year = 2026, canonical?: string, withSource = false): Promise<Item> => {
    const id = canonical ?? await seedItem(); const p = await preview(id, year);
    const input = simpleInput(); input.scope = scope(year); input.sourceScope = scope(year); input.sourceId = key();
    input.parsed.input.sha256 = randomUUID().replaceAll('-', '').padEnd(64, 'a');
    return call('add_annual_catalog_item', [F.org, year, id, p.canonicalFingerprint,
      JSON.stringify(withSource ? extractAnnualIdentityBlock(input) : []), 'Explicit annual member', key()]);
  };
  const refresh = async (item: Item, operation = key()) => call('refresh_annual_catalog_item', [F.org, item.scope.planningYear,
    item.membership.annualItemId, item.fieldVersion.fieldVersionId, (await preview(item.membership.canonicalItemId!, item.scope.planningYear)).canonicalFingerprint,
    '[]', 'Explicit canonical refresh', operation]);
  const editInput = (item: Item, change: Partial<AnnualEditableFields>, operation = key(), reason = 'تصحيح موثق لبيانات السنة'): EditAnnualCatalogItemInput => ({
    scope: item.scope, annualItemId: item.membership.annualItemId, expectedFieldVersionId: item.fieldVersion.fieldVersionId,
    expectedCanonicalFingerprint: item.canonicalFingerprint, fields: { ...editableAnnualFields(item.fieldVersion.fields), ...change }, reason, idempotencyKey: operation,
  });
  const editCommand = (input: EditAnnualCatalogItemInput) => named('edit_annual_catalog_item', {
    p_organization_id: input.scope.ownerOrgId, p_planning_year: input.scope.planningYear,
    p_annual_item_id: input.annualItemId, p_expected_field_version_id: input.expectedFieldVersionId,
    p_expected_canonical_fingerprint: input.expectedCanonicalFingerprint, p_fields: JSON.stringify(input.fields),
    p_reason: input.reason, p_idempotency_key: input.idempotencyKey,
  });
  const edit = async (input: EditAnnualCatalogItemInput) => invoke<AnnualCatalogEditResult>(editCommand(input));
  const changes = async (item: Item, limit = 50, after: string | null = null) => call<{ changes: unknown[]; nextAfterChangeId: string | null }>('list_annual_catalog_changes',
    [F.org, item.scope.planningYear, item.membership.annualItemId, limit, after]);
  const dossier = async (year = 2026) => {
    const label = key();
    return (await call<{ plan_revision_id: string }>('open_dossier', [F.org, year, label, `ملف اختبار ${label}`])).plan_revision_id;
  };
  const needInput = (item: Item, revision: string, overrides: Partial<AnnualNeedWriteInput> = {}): AnnualNeedWriteInput => ({
    scope: item.scope, manualScope: { planRevisionId: revision, beneficiaryOrganizationId: F.hospital,
      centralItemId: item.membership.canonicalItemId!, targetWarehouseId: null },
    annualItemId: item.membership.annualItemId, fieldVersionId: item.fieldVersion.fieldVersionId,
    quantityText: '11520', reason: 'احتياج سنوي موثق', idempotencyKey: key(), expectedLastEventId: null, reference: null, ...overrides,
  });
  const needCommand = (kind: 'add' | 'correct' | 'void', input: AnnualNeedWriteInput) => named(`${kind}_annual_need_line`, {
    p_organization_id: input.scope.ownerOrgId, p_planning_year: input.scope.planningYear,
    p_plan_revision_id: input.manualScope.planRevisionId, p_beneficiary_organization_id: input.manualScope.beneficiaryOrganizationId,
    p_central_item_id: input.manualScope.centralItemId, p_target_warehouse_id: input.manualScope.targetWarehouseId,
    ...(kind === 'void' ? {} : { p_quantity_text: input.quantityText }), p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey, p_expected_last_event_id: input.expectedLastEventId, p_reference: input.reference,
    p_annual_item_id: input.annualItemId, p_field_version_id: input.fieldVersionId,
  });
  const need = (kind: 'add' | 'correct' | 'void', input: AnnualNeedWriteInput) => invoke<AnnualNeedWriteResult>(needCommand(kind, input));
  const events = (revision: string, year = 2026, limit = 50, after: string | null = null) =>
    call<{ events: AnnualNeedEvent[]; nextAfterEventId: string | null }>('list_annual_need_events', [F.org, year, revision, limit, after]);
  const legacyArgs = (input: AnnualNeedWriteInput, kind: 'add' | 'correct' | 'void') => [input.manualScope.planRevisionId,
    input.manualScope.beneficiaryOrganizationId, input.manualScope.centralItemId, input.manualScope.targetWarehouseId,
    ...(kind === 'void' ? [] : [input.quantityText]), input.reason, input.idempotencyKey, input.expectedLastEventId, input.reference];
  const approve = async (revision: string) => { await call('submit_revision', [revision]); await call('approve_revision', [revision]); };
  const apply = async (filename: string) => rig.asAdmin(async (c: PoolClient) => {
    try { await c.query(readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8')); }
    catch (error) { await c.query('ROLLBACK'); throw error; }
  });

  beforeAll(async () => {
    const sysid = await targetGuard(); rig = await buildRig({ upTo: 235 });
    rpcBridge.run = async (name, args) => {
      expect(name).toMatch(/^phoenix_central_needs_[a-z_]+$/);
      const command = named(name.slice('phoenix_central_needs_'.length), Object.fromEntries(Object.entries(args)
        .map(([k, value]) => [k, value !== null && typeof value === 'object' ? JSON.stringify(value) : value])));
      try {
        const data = name === 'phoenix_central_needs_annual_summary'
          ? await rig.asUser(F.actor, async (c: PoolClient) => (await c.query(command.statement, command.args)).rows.map(row => row.r))
          : await invoke(command);
        return { data, error: null };
      }
      catch (error) { return { data: null, error: { message: error instanceof Error ? error.message : String(error),
        code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined } }; }
    };
    expect((await admin<{ sysid: string }>('SELECT system_identifier::text sysid FROM pg_control_system()'))[0].sysid).toBe(sysid);
    await apply('P1_dossier_workbook_reservation_NOT_APPLIED.sql'); await apply('P3A1_annual_catalog_NOT_APPLIED.sql');
    await admin(`INSERT INTO public.organizations(id,name,name_ar,code,organization_kind,institution_class,status) VALUES
      ($1,'P3B PDA','جهة الاختبار','p3b-pda','pharmacy_department_authority',NULL,'active'),
      ($2,'Other P3B PDA','جهة أخرى','p3b-other','pharmacy_department_authority',NULL,'active'),
      ($3,'P3B hospital','مستشفى الاختبار','p3b-hospital','care_institution','hospital','active'),
      ($4,'P3B second hospital','المستشفى الثاني','p3b-hospital2','care_institution','hospital','active')`, [F.org, F.otherOrg, F.hospital, F.hospital2]);
    for (const [id, owner, status] of [[F.actor, F.org, 'active'], [F.viewer, F.org, 'active'], [F.outsider, F.otherOrg, 'active'], [F.inactive, F.org, 'suspended']]) {
      await admin('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, `${id}@fixture.invalid`]);
      await admin("UPDATE public.profiles SET role='warehouse_officer',organization_id=$2,status=$3,full_name=$4 WHERE id=$1", [id, owner, status, F.actorName]);
      for (const permission of ['view', 'edit', 'manual_need.set', 'approve', 'material_review']) await admin(`INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed)
        VALUES($1,$2,$3) ON CONFLICT(profile_id,permission_key) DO UPDATE SET allowed=excluded.allowed`, [id, `central_needs.${permission}`, id !== F.viewer || permission === 'view']);
    }
    await admin('SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1)', [F.org]);
    await open(2026); await open(2027);
    const oldMember = await refresh(await member()); const revision = await dossier();
    const input = needInput(oldMember, revision);
    const oldEvent = await call<{ event_id: string }>('add_manual_need_line', legacyArgs(input, 'add'));
    historical = { item: oldMember, revision, eventId: oldEvent.event_id };
    await apply('P3B_annual_needs_audit_NOT_APPLIED.sql');
    stockBefore = await counts(STOCK_TABLES);
  }, 900000);
  afterAll(async () => { if (rig) await rig.end(); }, 30000);

  it('uses actual restricted callers and exposes a truthful bounded capability', async () => {
    const identity = await rig.asUser(F.actor, async (c: PoolClient) => (await c.query(`SELECT current_user role,auth.uid() actor,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0]);
    expect(identity).toEqual({ role: 'authenticated', actor: F.actor, rolsuper: false, rolbypassrls: false });
    expect(validateAnnualNeedsContract(await call('annual_needs_contract', []))).toMatchObject({ quantityBinding: true, annualEdits: true, actorSnapshots: true });
    expect(await admin('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).toEqual([]);
  });

  it('leaves historical employee names and legacy event bindings explicitly unknown, including same-field A1 refresh', async () => {
    const history = await changes(historical.item);
    expect(history.changes).toHaveLength(1);
    expect(history.changes[0]).toMatchObject({ actorId: F.actor, actorName: null, fromTrustedProfile: false });
    expect(() => validateAnnualCatalogChange(history.changes[0])).not.toThrow();
    const e = (await events(historical.revision)).events;
    expect(e).toHaveLength(1); expect(e[0]).toMatchObject({ id: historical.eventId, actorName: null, fromTrustedProfile: false, annualBinding: null });
    expect(validateAnnualNeedEvent(e[0], scope(), historical.revision)).toEqual(e[0]);
  });

  it('records a selectable annual name correction with immutable before/after and no canonical, source or other-year mutation', async () => {
    const item = await member(2026, undefined, true); const nextYear = await member(2027, item.membership.canonicalItemId!);
    const canonicalBefore = await admin('SELECT to_jsonb(c) data FROM public.central_items c WHERE id=$1', [item.membership.canonicalItemId]);
    const sourcesBefore = await admin('SELECT to_jsonb(o) data FROM public.central_needs_annual_occurrences o WHERE annual_item_id=$1 ORDER BY id', [item.membership.annualItemId]);
    expect(sourcesBefore.length).toBeGreaterThan(0);
    const input = editInput(item, { nameAr: 'الاسم العربي المصحح لهذه السنة' }); const result = await edit(input);
    expect(validateAnnualCatalogEdit(result, input)).toEqual(result); expect(result.selectable).toBe(true);
    expect(result.change).toMatchObject({ actorId: F.actor, actorName: F.actorName, fromTrustedProfile: true,
      beforeFields: { nameAr: 'الاسم السنوي الأصلي' }, afterFields: { nameAr: input.fields.nameAr }, requiresLegalReview: [] });
    expect(result.change.changeId).toBe(result.fieldVersion.fieldVersionId);
    expect((await get(item, item.fieldVersion.fieldVersionId)).fieldVersion).toEqual(item.fieldVersion);
    expect((await get(nextYear)).fieldVersion).toEqual(nextYear.fieldVersion);
    expect(await admin('SELECT to_jsonb(c) data FROM public.central_items c WHERE id=$1', [item.membership.canonicalItemId])).toEqual(canonicalBefore);
    expect(await admin('SELECT to_jsonb(o) data FROM public.central_needs_annual_occurrences o WHERE annual_item_id=$1 ORDER BY id', [item.membership.annualItemId])).toEqual(sourcesBefore);
    const fresh = await get(result); expect(validateAnnualCatalogItem(fresh, scope(), { current: true, allowAnnualEdits: true })).toEqual(fresh);
    // Clearing an optional annual label is a distinct wire shape, not an empty string.
    const cleared = await annualNeedsService.editAnnualCatalogItem(editInput(result, { nameAr: null }));
    expect(cleared.selectable).toBe(true);
    expect(cleared.fieldVersion.fields.nameAr).toEqual({ state: 'missing', reason: 'annual_correction_missing' });
    expect(cleared.change.afterFields.nameAr).toBeNull();
    expect((await get(item, result.fieldVersion.fieldVersionId)).fieldVersion).toEqual(result.fieldVersion);
  });

  it.each([
    ['scientificName', 'A proposed different identity'], ['nationalCode', '00000-PROPOSED'], ['barcode', 'PROPOSED-BARCODE'],
    ['dosageForm', 'Tablets'], ['concentration', '1 g'], ['unit', 'tablet'],
  ] as const)('stores proposed %s as preparing, never as a lawful selectable material', async (field, value) => {
    const item = await member(); const input = editInput(item, { [field]: value }); let result = await edit(input);
    expect(validateAnnualCatalogEdit(result, input)).toEqual(result);
    if (field === 'unit') {
      const missingUnit = editInput(result, { unit: null }); result = await edit(missingUnit);
      expect(validateAnnualCatalogEdit(result, missingUnit)).toEqual(result);
      expect(result.fieldVersion.fields.unit).toEqual({ state: 'missing', reason: 'annual_correction_missing' });
    }
    expect(result.membership.status).toBe('preparing'); expect(result.selectable).toBe(false);
    expect(result.change.requiresLegalReview).toContain(field);
    const revision = await dossier(); const before = await counts();
    await expect(need('add', needInput(result, revision))).rejects.toThrow(); expect(await counts()).toEqual(before);
    expect((await preview(item.membership.canonicalItemId!)).canonicalFingerprint).toBe(item.canonicalFingerprint);
  });

  it('allows explicit reversion of a proposal without erasing either earlier version', async () => {
    const item = await member(); const proposed = await edit(editInput(item, { scientificName: 'Pending proposed identity' }));
    const reverted = await edit(editInput(proposed, { scientificName: editableAnnualFields(item.fieldVersion.fields).scientificName }));
    expect(reverted.selectable).toBe(true); expect(reverted.membership.status).toBe('active');
    expect((await changes(item)).changes).toHaveLength(2);
    expect((await get(item, proposed.fieldVersion.fieldVersionId)).fieldVersion).toEqual(proposed.fieldVersion);
  });

  it.each(['', ' \t ', '\u00a0', '\ufeff', '\u2003\u202f'])('rejects an empty or Unicode-blank reason (%j) atomically', async reason => {
    const item = await member(); const before = await counts();
    await expect(edit(editInput(item, { nameAr: 'سبب مطلوب' }, key(), reason))).rejects.toThrow();
    expect(await counts()).toEqual(before);
  });

  it('rejects no-op, unsupported units, empty fields and actor spoof keys without creating versions or audit', async () => {
    const item = await member(); const before = await counts();
    for (const fields of [{}, { unit: 'tab' }, { nameAr: '\u00a0' }, { nameAr: 'New label', actorName: 'Forged employee' }]) {
      await expect(edit(editInput(item, fields as Partial<AnnualEditableFields>))).rejects.toThrow();
      expect(await counts()).toEqual(before);
    }
  });

  it('uses the locked profile name, ignores forged metadata and preserves the original name after rename and replay', async () => {
    const item = await member(); const input = editInput(item, { nameAr: 'تعديل أول' }); const command = editCommand(input);
    const first = await rig.asUser(F.actor, async (c: PoolClient) => {
      await c.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: F.actor, full_name: 'Forged JWT name', user_metadata: { full_name: 'Forged metadata' } })]);
      return (await c.query(command.statement, command.args)).rows[0].r as AnnualCatalogEditResult;
    }, { commit: true });
    expect(first.change.actorName).toBe(F.actorName);
    try {
      await admin('UPDATE public.profiles SET full_name=$2 WHERE id=$1', [F.actor, F.renamed]);
      const second = await edit(editInput(first, { nameAr: 'تعديل ثان' })); expect(second.change.actorName).toBe(F.renamed);
      const replay = await edit(input); expect(replay.idempotentReplay).toBe(true); expect(replay.change).toEqual(first.change);
      expect(replay.selectable).toBe(false); expect(validateAnnualCatalogEdit(replay, input)).toEqual(replay);
      const history = (await changes(item)).changes.map(validateAnnualCatalogChange);
      expect(history.find(row => row.changeId === first.change.changeId)?.actorName).toBe(F.actorName);
      await expect(edit({ ...input, reason: 'Changed intent under the same key' })).rejects.toThrow(/idempotency/);
    } finally { await admin('UPDATE public.profiles SET full_name=$2 WHERE id=$1', [F.actor, F.actorName]); }
  });

  it('refuses a missing current employee name and validates CAS against annual and legal versions', async () => {
    const item = await member(); const input = editInput(item, { nameAr: 'CAS correction' });
    await admin("UPDATE public.profiles SET full_name=' ' WHERE id=$1", [F.actor]);
    try { const before = await counts(); await expect(edit(input)).rejects.toThrow(); expect(await counts()).toEqual(before); }
    finally { await admin('UPDATE public.profiles SET full_name=$2 WHERE id=$1', [F.actor, F.actorName]); }
    await edit(input); const before = await counts();
    await expect(edit(editInput(item, { nameAr: 'Stale field version' }))).rejects.toThrow(); expect(await counts()).toEqual(before);
    const fresh = await member(); await admin("UPDATE public.central_items SET name=name||' legal change' WHERE id=$1", [fresh.membership.canonicalItemId]);
    const afterCanonicalChange = await counts(); await expect(edit(editInput(fresh, { nameAr: 'Stale canonical fingerprint' }))).rejects.toThrow();
    expect(await counts()).toEqual(afterCanonicalChange);
  });

  it('captures later A1 refreshes while retaining lawful same-value history', async () => {
    const item = await member(); const updated = await refresh(item); const rows = (await changes(updated)).changes;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ actorName: F.actorName, fromTrustedProfile: true });
    expect(() => validateAnnualCatalogChange(rows[0])).not.toThrow();
  });

  it('writes quantity, annual reference and employee event atomically and keeps duplicate intent singular', async () => {
    const item = await member(); const revision = await dossier(); const input = needInput(item, revision);
    const result = await need('add', input); expect(validateAnnualNeedWrite(result, input)).toEqual(result);
    const replay = await need('add', input); expect(replay).toEqual({ ...result, idempotentReplay: true });
    const rows = (await events(revision)).events; expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: result.eventId, actorId: F.actor, actorName: F.actorName, fromTrustedProfile: true,
      quantityText: '11520', approvedUnit: 'box', annualBinding: { annualItemId: input.annualItemId, fieldVersionId: input.fieldVersionId } });
    expect(validateAnnualNeedEvent(rows[0], scope(), revision)).toEqual(rows[0]);
    expect((await admin<{ n: number }>('SELECT count(*)::int n FROM public.central_needs_annual_need_bindings WHERE event_id=$1', [result.eventId]))[0].n).toBe(1);
    for (const delta of [{ quantityText: '9600' }, { fieldVersionId: randomUUID() }, { annualItemId: randomUUID() }, { scope: scope(2027) }]) {
      const before = await counts(); await expect(need('add', { ...input, ...delta })).rejects.toThrow(/idempotency|scope|year/); expect(await counts()).toEqual(before);
    }
  });

  it('never partitions annual membership by beneficiary and never substitutes another beneficiary scope', async () => {
    const item = await member(); const revision = await dossier(); const a = needInput(item, revision);
    const b = needInput(item, revision, { manualScope: { ...a.manualScope, beneficiaryOrganizationId: F.hospital2 }, quantityText: '400' });
    await need('add', a); await need('add', b); const rows = (await events(revision)).events;
    expect(new Set(rows.map(row => row.beneficiaryOrganizationId))).toEqual(new Set([F.hospital, F.hospital2]));
    expect(rows.every(row => row.annualBinding?.annualItemId === item.membership.annualItemId)).toBe(true);
  });

  it('rejects forged owner/year/item/version/beneficiary/revision and malformed quantities with no partial effect', async () => {
    const item = await member(); const wrongYear = await member(2027, item.membership.canonicalItemId!); const other = await member();
    const revision = await dossier(); const revision2027 = await dossier(2027); const input = needInput(item, revision);
    const invalid: AnnualNeedWriteInput[] = [
      { ...input, scope: scope(2026, F.otherOrg) }, { ...input, scope: scope(2027) },
      { ...input, annualItemId: wrongYear.membership.annualItemId, fieldVersionId: wrongYear.fieldVersion.fieldVersionId },
      { ...input, fieldVersionId: other.fieldVersion.fieldVersionId },
      { ...input, manualScope: { ...input.manualScope, centralItemId: other.membership.canonicalItemId! } },
      { ...input, manualScope: { ...input.manualScope, beneficiaryOrganizationId: randomUUID() } },
      { ...input, manualScope: { ...input.manualScope, planRevisionId: revision2027 } },
      { ...input, quantityText: '-1' }, { ...input, quantityText: '1e3' },
    ];
    for (const attempt of invalid) { const before = await counts(); await expect(need('add', { ...attempt, idempotencyKey: key() })).rejects.toThrow(); expect(await counts()).toEqual(before); }
  });

  it('requires a current selectable version for add/correct, but void retains the prior frozen binding despite a proposal', async () => {
    const item = await member(); const revision = await dossier(); const original = needInput(item, revision); const first = await need('add', original);
    const label = await edit(editInput(item, { nameAr: 'Current label' }));
    await expect(need('correct', { ...original, idempotencyKey: key(), expectedLastEventId: first.eventId, quantityText: '9600' })).rejects.toThrow();
    const correctedInput = needInput(label, revision, { quantityText: '9600', expectedLastEventId: first.eventId });
    const corrected = await need('correct', correctedInput);
    await edit(editInput(label, { scientificName: 'Proposed clinical identity' }));
    const voidInput = { ...correctedInput, expectedLastEventId: corrected.eventId, idempotencyKey: key(), reason: 'إلغاء بند موثق' };
    const voided = await need('void', voidInput); expect(voided.annualBinding.fieldVersionId).toBe(label.fieldVersion.fieldVersionId);
    expect((await events(revision)).events.find(row => row.id === voided.eventId)).toMatchObject({ eventKind: 'void', annualBinding: voided.annualBinding });
    expect((await events(revision)).events.find(row => row.id === first.eventId)?.annualBinding?.fieldVersionId).toBe(item.fieldVersion.fieldVersionId);
  });

  it.each(['correct', 'void'] as const)('legacy %s cannot omit an existing annual binding, including with forged client GUC context', async kind => {
    const item = await member(); const revision = await dossier(); const first = await need('add', needInput(item, revision));
    const input = needInput(item, revision, { quantityText: '3', expectedLastEventId: first.eventId }); const args = legacyArgs(input, kind); const before = await counts();
    await expect(rig.asUser(F.actor, async (c: PoolClient) => {
      await c.query("SELECT set_config('phoenix.annual_need_bound','true',true),set_config('phoenix.annual_need_wrapper','true',true)");
      await c.query(sql(`${kind}_manual_need_line`, args), args);
    }, { commit: true })).rejects.toThrow();
    expect(await counts()).toEqual(before); expect((await events(revision)).events).toHaveLength(1);
  });

  it('keeps a lawful legacy unbound add/void usable without fabricating an annual membership or binding', async () => {
    const canonical = await seedItem(); const revision = await dossier();
    const first = await call<{ event_id: string }>('add_manual_need_line', [revision, F.hospital, canonical, null,
      '5', 'Explicit legacy need', key(), null, null]);
    await call('void_manual_need_line', [revision, F.hospital, canonical, null, 'Explicit legacy cancellation', key(), first.event_id, null]);
    const rows = (await events(revision)).events; expect(rows).toHaveLength(2);
    expect(rows.some(row => row.eventKind === 'void')).toBe(true);
    expect(rows.every(row => row.annualBinding === null && row.actorName === null && row.fromTrustedProfile === false)).toBe(true);
    expect((await admin<{ n: number }>('SELECT count(*)::int n FROM public.central_needs_annual_items WHERE central_item_id=$1', [canonical]))[0].n).toBe(0);
    expect((await admin<{ n: number }>(`SELECT count(*)::int n FROM public.central_needs_annual_need_bindings b
      JOIN public.central_needs_manual_need_events e ON e.id=b.event_id WHERE e.plan_revision_id=$1`, [revision]))[0].n).toBe(0);
  });

  it.each(['display', 'proposal'] as const)('readiness and carry-forward preserve a lawful older binding after an annual %s change', async kind => {
    const item = await member(); const revision = await dossier(); const first = await need('add', needInput(item, revision));
    await edit(editInput(item, kind === 'display' ? { nameAr: 'Later display name' } : { scientificName: 'Pending proposed legal name' }));
    await approve(revision);
    try {
      await admin('UPDATE public.profiles SET full_name=$2 WHERE id=$1', [F.actor, F.renamed]);
      const corrected = await call<{ plan_revision_id: string }>('open_dossier_correction', [F.org, 2026, revision, 'Annual correction with preserved version']);
      const carried = (await events(corrected.plan_revision_id)).events;
      expect(carried).toHaveLength(1); expect(carried[0]).toMatchObject({ eventKind: 'carried_forward', actorName: F.renamed,
        annualBinding: { annualItemId: item.membership.annualItemId, fieldVersionId: item.fieldVersion.fieldVersionId } });
      expect(carried[0].annualBinding).toEqual(first.annualBinding);
      expect((await events(revision)).events[0]).toMatchObject({ actorName: F.actorName, annualBinding: first.annualBinding });
    } finally { await admin('UPDATE public.profiles SET full_name=$2 WHERE id=$1', [F.actor, F.actorName]); }
  });

  it('readiness refuses genuine canonical drift without rewriting the bound historical event', async () => {
    const item = await member(); const revision = await dossier(); const first = await need('add', needInput(item, revision));
    const old = (await events(revision)).events[0];
    await admin("UPDATE public.central_items SET name=name||' changed' WHERE id=$1", [item.membership.canonicalItemId]);
    await expect(approve(revision)).rejects.toThrow();
    expect((await events(revision)).events.find(row => row.id === first.eventId)).toEqual(old);
  });

  it('denies ineligible actors before replay and preserves no direct API access to the two audit tables', async () => {
    const item = await member(); const input = editInput(item, { nameAr: 'Authorized edit' }); await edit(input);
    for (const actor of [F.viewer, F.outsider, F.inactive, null, rig.superAdminId]) {
      const before = await counts(); await expect(invoke(editCommand(input), actor)).rejects.toThrow(); expect(await counts()).toEqual(before);
    }
    for (const table of ['central_needs_annual_catalog_changes', 'central_needs_annual_need_bindings']) {
      for (const role of ['anon', 'authenticated', 'service_role']) await expect(rig.asUser(F.actor,
        (c: PoolClient) => c.query(`SELECT * FROM public.${table}`), { role })).rejects.toThrow(/permission denied/);
      const rls = (await admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [`public.${table}`]))[0];
      expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it('keeps new audit/reference rows immutable even to privileged accidental UPDATE or DELETE', async () => {
    const item = await member(); const changed = await edit(editInput(item, { nameAr: 'Immutable evidence' }));
    const first = await need('add', needInput(changed, await dossier()));
    for (const [statement, args] of [
      ['UPDATE public.central_needs_annual_catalog_changes SET actor_name=$2 WHERE id=$1', [changed.change.changeId, 'Forged']],
      ['DELETE FROM public.central_needs_annual_catalog_changes WHERE id=$1', [changed.change.changeId]],
      ['UPDATE public.central_needs_annual_need_bindings SET field_version_id=$2 WHERE event_id=$1', [first.eventId, item.fieldVersion.fieldVersionId]],
      ['DELETE FROM public.central_needs_annual_need_bindings WHERE event_id=$1', [first.eventId]],
    ] as [string, unknown[]][]) { const before = await counts(); await expect(admin(statement, args)).rejects.toThrow(); expect(await counts()).toEqual(before); }
  });

  it('paginates yearly change history in timestamp/UUID descending order and rejects a foreign cursor', async () => {
    let item = await member(); const original = item; const ids: string[] = [];
    await rig.asUser(F.actor, async (c: PoolClient) => {
      for (let i = 0; i < 3; i += 1) {
        const command = editCommand(editInput(item, { nameAr: `Audit page ${i}` }));
        const changed = (await c.query(command.statement, command.args)).rows[0].r as AnnualCatalogEditResult;
        item = changed; ids.push(changed.change.changeId);
      }
    }, { commit: true });
    const all = (await changes(original)).changes.map(validateAnnualCatalogChange);
    const orderedIds = (await admin<{ id: string }>(`SELECT id FROM public.central_needs_annual_catalog_changes
      WHERE annual_item_id=$1 ORDER BY created_at DESC,id DESC`, [original.membership.annualItemId])).map(row => row.id);
    expect(new Set(orderedIds)).toEqual(new Set(ids));
    expect(all.map(row => row.changeId)).toEqual(orderedIds);
    expect((await annualNeedsService.listAnnualCatalogChanges(scope(), original.membership.annualItemId)).changes.map(row => row.changeId)).toEqual(orderedIds);
    const visited: string[] = []; let cursor: string | null = null;
    do { const page = await changes(original, 1, cursor); const rows = page.changes.map(validateAnnualCatalogChange); visited.push(...rows.map(row => row.changeId)); cursor = page.nextAfterChangeId; } while (cursor !== null && visited.length < 5);
    expect(visited).toEqual(all.map(row => row.changeId)); expect(cursor).toBeNull();
    const other = await edit(editInput(await member(), { nameAr: 'Foreign cursor' }));
    await expect(changes(original, 1, other.change.changeId)).rejects.toThrow();
  });

  it('lists registration requests only through their explicit owner/year context', async () => {
    const descriptor = JSON.stringify({ scientificName: 'Annual draft request', nameAr: null, tradeName: null, strength: null, dosageForm: null, unit: 'box', barcode: null, nationalCode: null, note: null });
    const a = await call<{ requestId: string }>('create_annual_material_request', [F.org, 2026, descriptor, key()]);
    const b = await call<{ requestId: string }>('create_annual_material_request', [F.org, 2027, descriptor, key()]);
    const page = await call<{ requests: { id: string; organizationId: string }[] }>('list_annual_material_requests', [F.org, 2026, 50, null]);
    expect(page.requests.some(row => row.id === a.requestId && row.organizationId === F.org)).toBe(true);
    expect(page.requests.some(row => row.id === b.requestId)).toBe(false);
    await expect(call('list_annual_material_requests', [F.org, 2026, 50, b.requestId])).rejects.toThrow();
  });

  it('passes actual native RPC JSON through the complete service validators, including historical null names', async () => {
    // The bridge replaces HTTP only. Every RPC is executed as authenticated in PostgreSQL.
    // This is native contract proof, not hosted JWT/PostgREST acceptance.
    expect(await annualNeedsService.getAnnualNeedsContract()).toMatchObject({ quantityBinding: true });
    const item = await member(); const input = editInput(item, { nameAr: 'اسم جسر التحقق' });
    const updated = await annualNeedsService.editAnnualCatalogItem(input);
    expect(updated.change.actorName).toBe(F.actorName);
    const history = await annualNeedsService.listAnnualCatalogChanges(scope(), historical.item.membership.annualItemId);
    expect(history.changes[0]).toMatchObject({ actorName: null, fromTrustedProfile: false });
    const old = await annualNeedsService.getAnnualCatalogItemForNeeds(scope(), item.membership.annualItemId, item.fieldVersion.fieldVersionId);
    expect(old.fieldVersion).toEqual(item.fieldVersion);
    expect((await annualNeedsService.searchAnnualCatalogForNeeds(scope(), 'اسم جسر التحقق')).items.some(row => row.membership.annualItemId === item.membership.annualItemId)).toBe(true);
    const revision = await dossier(); const writeInput = needInput(updated, revision);
    const written = await annualNeedsService.addAnnualNeedLine(writeInput);
    const page = await annualNeedsService.listAnnualNeedEventsPage(scope(), revision, 1);
    expect(page.events[0]).toMatchObject({ id: written.eventId, actorName: F.actorName, annualBinding: written.annualBinding });
    const requests = await annualNeedsService.listAnnualMaterialRequestsPage(scope(), 1);
    expect(requests.requests).toHaveLength(1);
  });

  it('searches saved annual fields, ranks a proposed exact code first and validates both pages through the service', async () => {
    const token = `000-${randomUUID()}`;
    const proposed = await edit(editInput(await member(), { nationalCode: token }));
    const canonical = await seedItem(); await admin('UPDATE public.central_items SET name=$2 WHERE id=$1', [canonical, `Related material ${token}`]);
    const related = await member(2026, canonical);
    const first = await annualNeedsService.searchAnnualCatalogForNeeds(scope(), token, 1);
    expect(first.items).toHaveLength(1); expect(first.items[0]).toMatchObject({ selectable: false,
      membership: { annualItemId: proposed.membership.annualItemId, status: 'preparing' } });
    expect(first.nextCursor).not.toBeNull();
    const second = await annualNeedsService.searchAnnualCatalogForNeeds(scope(), token, 1, first.nextCursor);
    expect(second.items.map(item => item.membership.annualItemId)).toEqual([related.membership.annualItemId]);
  });

  it('annual summary displays the bound version through the service after a later annual or global display rename', async () => {
    const item = await member(); const saved = await edit(editInput(item, { nameAr: 'الاسم المثبت عند اعتماد الاحتياج' }));
    const revision = await dossier(); const first = await need('add', needInput(saved, revision));
    await edit(editInput(saved, { nameAr: 'اسم أحدث غير مستخدم في البند' })); await approve(revision);
    await admin('UPDATE public.central_items SET name_ar=$2 WHERE id=$1', [item.membership.canonicalItemId, 'اسم قانوني عام لاحق']);
    const summary = (await readAnnualNeeds(F.org, 2026)).find(row => row.revisionId === revision && row.itemId === item.membership.canonicalItemId);
    expect(summary).toMatchObject({ nameAr: 'الاسم المثبت عند اعتماد الاحتياج', quantityText: '11520', unit: 'box',
      identitySource: 'annual_version', annualBinding: first.annualBinding });
  });

  async function begin(authenticated: boolean) {
    const c = await rig.pool.connect(); await c.query('BEGIN'); await c.query("SET LOCAL statement_timeout='12s'");
    if (authenticated) { await c.query('SET LOCAL ROLE authenticated'); await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [F.actor]); }
    return c as PoolClient;
  }
  async function isBlocked(blocker: number, waiter: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await admin<{ blocked: boolean }>('SELECT $1::int=ANY(pg_blocking_pids($2::int)) blocked', [blocker, waiter]))[0].blocked) return true;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return false;
  }
  async function race(first: Command, second: Command, commit = true) {
    const a = await begin(first.authenticated); const b = await begin(second.authenticated); let pending: Promise<RaceResult> | undefined;
    try {
      const apid = (await a.query('SELECT pg_backend_pid() id')).rows[0].id; const bpid = (await b.query('SELECT pg_backend_pid() id')).rows[0].id; expect(apid).not.toBe(bpid);
      const initial = await a.query(first.statement, first.args);
      pending = b.query(second.statement, second.args).then(result => ({ rows: result.rows }), (error: Error) => ({ error }));
      expect(await isBlocked(apid, bpid), 'independent contender was actually blocked').toBe(true);
      await a.query(commit ? 'COMMIT' : 'ROLLBACK'); const result = await pending;
      await b.query(result.error ? 'ROLLBACK' : 'COMMIT'); return { initial: initial.rows[0]?.r, ...result };
    } finally { await a.query('ROLLBACK'); if (pending) await pending; await b.query('ROLLBACK'); a.release(); b.release(); }
  }

  it.each([true, false])('duplicate annual edit is one version/audit outcome after first commit=%s', async commit => {
    const item = await member(); const input = editInput(item, { nameAr: 'Concurrent same intent' }); const command = editCommand(input);
    const result = await race(command, command, commit); expect(result.error).toBeUndefined();
    expect((result.rows?.[0].r as AnnualCatalogEditResult).idempotentReplay).toBe(commit);
    expect((await changes(item)).changes).toHaveLength(1); expect((await get(item)).fieldVersion.versionNumber).toBe(2);
  });

  it.each([true, false])('competing annual CAS rejects only a committed predecessor (commit=%s)', async commit => {
    const item = await member(); const result = await race(editCommand(editInput(item, { nameAr: 'First' })), editCommand(editInput(item, { nameAr: 'Second' })), commit);
    if (commit) expect(result.error).toBeDefined(); else expect(result.error).toBeUndefined();
    expect(editableAnnualFields((await get(item)).fieldVersion.fields).nameAr).toBe(commit ? 'First' : 'Second');
    expect((await changes(item)).changes).toHaveLength(1);
  });

  it.each([true, false])('profile rename and edit serialize with an immutable event-time employee name (renameFirst=%s)', async renameFirst => {
    const item = await member(); const command = editCommand(editInput(item, { nameAr: 'Name race' }));
    const rename = { statement: 'UPDATE public.profiles SET full_name=$2 WHERE id=$1', args: [F.actor, F.renamed], authenticated: false };
    try {
      const result = await race(renameFirst ? rename : command, renameFirst ? command : rename);
      expect(result.error).toBeUndefined(); const edited = (renameFirst ? result.rows?.[0].r : result.initial) as AnnualCatalogEditResult;
      expect(edited.change.actorName).toBe(renameFirst ? F.renamed : F.actorName);
      expect((await changes(item)).changes[0]).toMatchObject({ actorName: edited.change.actorName });
    } finally { await admin('UPDATE public.profiles SET full_name=$2 WHERE id=$1', [F.actor, F.actorName]); }
  });

  it.each([true, false])('identity proposal and bound add respect both lock orders (editFirst=%s)', async editFirst => {
    const item = await member(); const revision = await dossier(); const write = needCommand('add', needInput(item, revision));
    const change = editCommand(editInput(item, { scientificName: 'Proposed identity during add' }));
    const result = await race(editFirst ? change : write, editFirst ? write : change);
    if (editFirst) { expect(result.error).toBeDefined(); expect((await events(revision)).events).toHaveLength(0); }
    else { expect(result.error).toBeUndefined(); expect((await events(revision)).events[0].annualBinding?.fieldVersionId).toBe(item.fieldVersion.fieldVersionId); }
    expect((await get(item)).selectable).toBe(false);
  });

  it.each([true, false])('legal canonical mutation and bound write respect both lock orders (canonicalFirst=%s)', async canonicalFirst => {
    const item = await member(); const revision = await dossier(); const write = needCommand('add', needInput(item, revision));
    const change = { statement: "UPDATE public.central_items SET name=name||' concurrent canonical' WHERE id=$1", args: [item.membership.canonicalItemId], authenticated: false };
    const result = await race(canonicalFirst ? change : write, canonicalFirst ? write : change);
    if (canonicalFirst) { expect(result.error).toBeDefined(); expect((await events(revision)).events).toHaveLength(0); }
    else { expect(result.error).toBeUndefined(); expect((await events(revision)).events).toHaveLength(1); await expect(approve(revision)).rejects.toThrow(); }
  });

  it.each([true, false])('need correction CAS remains atomic after first commit=%s', async commit => {
    const item = await member(); const revision = await dossier(); const first = await need('add', needInput(item, revision));
    const a = needInput(item, revision, { quantityText: '9600', expectedLastEventId: first.eventId });
    const b = needInput(item, revision, { quantityText: '8000', expectedLastEventId: first.eventId });
    const result = await race(needCommand('correct', a), needCommand('correct', b), commit);
    if (commit) expect(result.error).toBeDefined(); else expect(result.error).toBeUndefined();
    const rows = (await events(revision)).events; expect(rows).toHaveLength(2);
    expect(rows.find(row => row.eventKind === 'correct')?.quantityText).toBe(commit ? '9600' : '8000');
    expect(rows.every(row => row.annualBinding?.fieldVersionId === item.fieldVersion.fieldVersionId)).toBe(true);
  });

  it.each([
    ['beneficiary', true], ['beneficiary', false], ['warehouse', true], ['warehouse', false],
  ] as const)('live %s eligibility serializes with annual writes (disableFirst=%s)', async (target, disableFirst) => {
    const beneficiary = randomUUID(); const warehouse = randomUUID();
    await admin(`INSERT INTO public.organizations(id,name,name_ar,code,organization_kind,institution_class,status)
      VALUES($1,'Race beneficiary','مستفيد السباق',$2,'care_institution','hospital','active')`, [beneficiary, key()]);
    if (target === 'warehouse') await admin(`INSERT INTO public.warehouses(id,organization_id,name,name_ar,status)
      VALUES($1,$2,'Race warehouse','مخزن السباق','active')`, [warehouse, beneficiary]);
    const item = await member(); const revision = await dossier(); const input = needInput(item, revision);
    input.manualScope.beneficiaryOrganizationId = beneficiary;
    input.manualScope.targetWarehouseId = target === 'warehouse' ? warehouse : null;
    const command = needCommand('add', input);
    const disable = { statement: target === 'warehouse'
      ? "UPDATE public.warehouses SET status='inactive' WHERE id=$1"
      : "UPDATE public.organizations SET status='inactive' WHERE id=$1",
    args: [target === 'warehouse' ? warehouse : beneficiary], authenticated: false };
    const result = await race(disableFirst ? disable : command, disableFirst ? command : disable);
    if (disableFirst) { expect(result.error).toBeDefined(); expect((await events(revision)).events).toHaveLength(0); }
    else { expect(result.error).toBeUndefined(); expect((await events(revision)).events).toHaveLength(1); }
    const row = (await admin<{ status: string }>(`SELECT status FROM public.${target === 'warehouse' ? 'warehouses' : 'organizations'} WHERE id=$1`, disable.args))[0];
    expect(row.status).toBe('inactive');
  });

  it('does not create stock or movement effects from yearly catalog edits and needs', async () => {
    expect(await counts(STOCK_TABLES)).toEqual(stockBefore);
  });

  const driver = {
    admin: (statement: string, args: unknown[] = []) => admin(statement, args),
    as: (actor: string | null, statement: string, args: unknown[] = []) => rig.asUser(actor, async (c: PoolClient) => (await c.query(statement, args)).rows, { commit: true }),
    asRole: (role: string, actor: string | null, statement: string, args: unknown[] = []) => rig.asUser(actor, async (c: PoolClient) => (await c.query(statement, args)).rows, { role, commit: true }),
  };
  for (const scenario of [...annualDossierCases(driver), ...dossierMatrixCases(driver)]) {
    it(`existing writer under P3-B: ${scenario.name}`, async () => scenario.run(), 60000);
  }
});
