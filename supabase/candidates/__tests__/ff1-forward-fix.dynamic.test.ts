/**
 * D18 - FF1 forward-fix candidate (KILL-SWITCH ONLY), FF-01..FF-04 plus a normal-sequence regression for FF-05. Rig only; nothing is applied elsewhere.
 *
 *  FF-01 dual base      applies cleanly on a 221-shaped TEST SHAPE (001-221 + M223-M230, no M222) and on the historical full chain through M230. FF2 covers the current dossier chain. The 221 shape is a rig shape,
 *                       never approval to skip M222 in Production. A second apply is refused.
 *  FF-02 no regrant     actor_scope_org (final M228 body) byte-identical; no administrator branch; foreign / organization-less super_admin still denied (AUTH-02).
 *  FF-03 lockout        recovery only through public.assign_profile_permissions; the fix grants nothing and has no DML on staffing.
 *  FF-04 irreversibles  markers / inventory / events / withdrawals / acknowledgements digest-identical; no DML on them; the Excel freeze and activation guards remain.
 *  FF-05 (REVISED)      the historical "named draft Excel exception" is OWNER DECISION / NOT APPLICABLE TO STRICT CUTOVER: M229 refuses activation while an Excel
 *                       draft/submitted revision exists, so an activated organization cannot retain one. What is proven here is the REAL sequence, with no trigger
 *                       bypass: an existing Excel draft blocks activation; after governed withdrawal activation succeeds; afterwards Excel draft creation and
 *                       intake rows are refused, and FF1 does not change that. FF1 never restores Excel ingestion.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable, MIGRATIONS_DIR } from '../../../tools/pg-rig/rig.mjs';

const FF = readFileSync(join(__dirname, '..', 'FF1_r1_forward_fix_NOT_APPLIED.sql'), 'utf8').replace(/\r\n/g, '\n');
const PLAN = readFileSync(join(__dirname, '..', 'FF1-PLAN.md'), 'utf8').replace(/\r\n/g, '\n');
const code = FF.replace(/^\s*--.*$/gm, '');                                   // statements only
const R1_FILES = ['223_phoenix_central_needs_manual_source_schema_inert.sql', '224_phoenix_central_needs_authorization_closure.sql', '225_phoenix_central_needs_lifecycle_relations_and_sod.sql', '226_phoenix_central_needs_manual_routines_inert.sql',
  '227_phoenix_central_needs_blockers_digest_d27.sql', '228_phoenix_central_needs_material_registration_inert.sql', '229_phoenix_central_needs_manual_activation.sql', '230_phoenix_central_needs_material_registration_activation.sql'];

const ORG = '00000000-0000-0000-0000-0000000ff001', ORG2 = '00000000-0000-0000-0000-0000000ff002';
const U = { maker: '00000000-0000-0000-0000-0000000ff011', checker: '00000000-0000-0000-0000-0000000ff012', saOther: '00000000-0000-0000-0000-0000000ff013', saNone: '00000000-0000-0000-0000-0000000ff014', saHome: '00000000-0000-0000-0000-0000000ff015', importer: '00000000-0000-0000-0000-0000000ff016' };

describe('FF1 static contract', () => {
  it('is kill-switch only: no new objects, no Excel re-enablement, no administrator branch, no actor_scope_org redefinition, not numbered', () => {
    expect(code).not.toMatch(/super_admin/i);
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TABLE|TRIGGER|POLICY)\b/i);
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/unfreeze|excel_import_open/i);
    expect('FF1_r1_forward_fix_NOT_APPLIED.sql').not.toMatch(/^\d{3}_/);
  });
  it('has no DML on staffing or on the irreversible records, and never drops anything', () => {
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(public\.)?(profiles|profile_permission_overrides|role_permission_defaults)\b/i);
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(public\.)?central_needs_(cutover_inventory|manual_need_events|revision_withdrawals|manual_coverage_acknowledgements)\b/i);
    expect(code).not.toMatch(/\bDROP\b/i);
  });
  it('is one transaction with an in-transaction VERIFY', () => {
    expect(code.match(/^\s*BEGIN\s*;/gm)).toHaveLength(1);
    expect(code.match(/^\s*COMMIT\s*;/gm)).toHaveLength(1);
    expect(FF.indexOf('VERIFY FAILED')).toBeGreaterThan(FF.indexOf('BEGIN;'));
  });
  it('the plan records historical FF-05 as an OWNER DECISION, not an operational PASS, and the synthetic exception path is withdrawn', () => {
    expect(PLAN).toMatch(/FF-05[^\n]*OWNER DECISION \/ NOT APPLICABLE TO STRICT CUTOVER/);
    expect(PLAN).not.toMatch(/FF-05[^\n]*\bPASS\b/);
  });
});

const run = rigAvailable() ? describe : describe.skip;
run('FF1 on the rig', { timeout: 900_000 }, () => {
  const rigs: any[] = [];
  afterEach(async () => { while (rigs.length) await rigs.pop().end().catch(() => undefined); });

  async function base(shape: '221-shaped test shape' | 'historical full chain through M230') {
    const rig = shape === 'historical full chain through M230' ? await buildRig({ upTo: 230 }) : await buildRig({ upTo: 221 });
    rigs.push(rig);
    if (shape !== 'historical full chain through M230') {
      await rig.asAdmin(async (c: any) => { for (const f of R1_FILES) await c.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/\r\n/g, '\n')); });
    }
    return rig;
  }
  const applyFF = (rig: any) => rig.asAdmin((c: any) => c.query(FF));
  const stateOf = (rig: any) => rig.asAdmin(async (c: any) => (await c.query(`SELECT
      (SELECT md5(pg_get_functiondef('phoenix_cn_policy.actor_scope_org(text)'::regprocedure))) AS actor_scope,
      (SELECT count(*)::int FROM phoenix_private.central_needs_capability_breaches_v1()) AS breaches,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE '%\\_r1\\_05\\_excel\\_freeze') AS freeze_triggers,
      (SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname ~ '^phoenix_central_needs_(open_manual|carry_forward|add_manual|correct_manual|void_manual|withdraw_draft|acknowledge_manual|create_material|update_material|submit_material|start_material|request_material|resolve_material|approve_new|reject_material|cancel_material|link_material)' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS writers_exec`)).rows[0]);
  const digests = (rig: any) => rig.asAdmin(async (c: any) => (await c.query(`SELECT
      (SELECT md5(coalesce(string_agg(i::text, '|' ORDER BY i::text), '')) FROM central_needs_cutover_inventory i) AS inventory,
      (SELECT md5(coalesce(string_agg(e::text, '|' ORDER BY e::text), '')) FROM central_needs_manual_need_events e) AS events,
      (SELECT md5(coalesce(string_agg(w::text, '|' ORDER BY w::text), '')) FROM central_needs_revision_withdrawals w) AS withdrawals,
      (SELECT md5(coalesce(string_agg(a::text, '|' ORDER BY a::text), '')) FROM central_needs_manual_coverage_acknowledgements a) AS acks,
      (SELECT count(*)::int FROM central_needs_cutover_inventory WHERE entry_kind='activation_marker') AS markers`)).rows[0]);

  async function seed(rig: any, { activate }: { activate: boolean }) {
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind) VALUES ($1,'FF PDA','ف','ff-a','pharmacy_department_authority'),($2,'FF PDA 2','ف2','ff-b','pharmacy_department_authority')`, [ORG, ORG2]);
      const mk = async (id: string, email: string, role: string, org: string | null, keys: string[]) => {
        await c.query(`INSERT INTO auth.users (id,email) VALUES ($1,$2)`, [id, email]);
        await c.query(`UPDATE profiles SET role=$2, status='active', organization_id=$3 WHERE id=$1`, [id, role, org]);
        for (const k of keys) await c.query(`INSERT INTO profile_permission_overrides (profile_id,permission_key,allowed) VALUES ($1,$2,true) ON CONFLICT (profile_id,permission_key) DO UPDATE SET allowed=true`, [id, `central_needs.${k}`]);
      };
      await mk(U.maker, 'ff-maker@rig', 'central_warehouse_manager', ORG, ['view', 'edit', 'manual_need.set']);
      await mk(U.checker, 'ff-checker@rig', 'central_warehouse_manager', ORG, ['view', 'approve']);
      await mk(U.importer, 'ff-importer@rig', 'central_warehouse_manager', ORG, ['view', 'import', 'edit']);
      await mk(U.saOther, 'ff-sa-other@rig', 'super_admin', ORG2, []);
      await mk(U.saNone, 'ff-sa-none@rig', 'super_admin', null, []);
      await mk(U.saHome, 'ff-sa-home@rig', 'super_admin', ORG, ['view', 'import']);
      if (activate) await c.query(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1::uuid)`, [ORG]);
    });
  }

  for (const shape of ['221-shaped test shape', 'historical full chain through M230'] as const) {
    it(`FF-01 (${shape}): applies cleanly, the seal stays clean, the writers are owner-only again, the Excel freeze remains, a second apply is refused`, async () => {
      const rig = await base(shape);
      const before = await stateOf(rig);
      expect(before.writers_exec).toBe(18);                                     // R1-b made them executable
      await applyFF(rig);
      const after = await stateOf(rig);
      expect(after.writers_exec).toBe(0); expect(after.breaches).toBe(0); expect(after.freeze_triggers).toBe(4);
      await expect(applyFF(rig)).rejects.toThrow(/FF1_precondition_failed/);
    });
  }

  it('FF-02: actor_scope_org is byte-identical, and AUTH-02 still denies a foreign / organization-less super_admin', async () => {
    const rig = await base('historical full chain through M230'); await seed(rig, { activate: true });
    const before = await stateOf(rig);
    await applyFF(rig);
    expect((await stateOf(rig)).actor_scope).toBe(before.actor_scope);
    const auth = (u: string, key: string) => rig.asUser(u, async (c: any) => (await c.query(`SELECT public.phoenix_central_needs_actor_authorized($1::uuid,$2) AS ok`, [ORG, key])).rows[0].ok as boolean);
    for (const key of ['central_needs.view', 'central_needs.import', 'central_needs.edit', 'central_needs.approve']) {
      expect(await auth(U.saOther, key), `saOther ${key}`).toBe(false);
      expect(await auth(U.saNone, key), `saNone ${key}`).toBe(false);
    }
    expect(await auth(U.saHome, 'central_needs.import')).toBe(true);            // explicit key at its own home organization, as before
  });

  it('FF-03: with no staffed checker the recovery is the governed assign_profile_permissions route (no SQL shortcut in the fix)', async () => {
    const rig = await base('historical full chain through M230'); await seed(rig, { activate: true });
    await rig.asAdmin((c: any) => c.query(`DELETE FROM profile_permission_overrides WHERE profile_id = $1`, [U.checker]));      // lockout: nobody can approve
    const approvers = () => rig.asAdmin(async (c: any) => (await c.query(`SELECT count(*)::int n FROM profile_permission_overrides WHERE permission_key='central_needs.approve' AND allowed`)).rows[0].n);
    expect(await approvers()).toBe(0);
    await applyFF(rig);
    expect(await approvers()).toBe(0);                                             // the fix itself grants nothing
    const res = await rig.asUser(U.saHome, async (c: any) => (await c.query(`SELECT public.assign_profile_permissions($1::uuid, $2::jsonb) AS r`, [U.checker, JSON.stringify({ 'central_needs.view': true, 'central_needs.approve': true })])).rows[0].r, { commit: true });
    expect(res).toBeTruthy();
    expect(await approvers()).toBe(1);
    const caps = await rig.asUser(U.checker, async (c: any) => (await c.query(`SELECT * FROM public.phoenix_central_needs_my_capabilities($1::uuid, NULL)`, [ORG])).rows[0]);
    expect(caps.approve).toBe(true);
  });

  it('FF-04: activation markers, inventory, events, withdrawals and acknowledgements are digest-identical before and after; the activation guards remain', async () => {
    const rig = await base('historical full chain through M230'); await seed(rig, { activate: true });
    const before = await digests(rig);
    expect(before.markers).toBe(1);
    await applyFF(rig);
    expect(await digests(rig)).toEqual(before);
    const guards = await rig.asAdmin(async (c: any) => (await c.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE '%\\_r1\\_06\\_manual\\_activation%'`)).rows[0].n);
    expect(guards).toBeGreaterThanOrEqual(5);
  });

  it('FF-05 (revised, normal sequence, NO trigger bypass): an existing Excel draft blocks activation; after governed withdrawal activation succeeds; Excel intake stays refused, with and without FF1', async () => {
    const rig = await base('historical full chain through M230'); await seed(rig, { activate: false });
    const as = (u: string, fn: (c: any) => Promise<any>) => rig.asUser(u, fn, { commit: true });
    // 1. a legitimate legacy Excel draft exists (opened through the real RPC as an authorized importer)
    const opened = await as(U.importer, async (c) => (await c.query(`SELECT public.phoenix_central_needs_open_plan_revision($1::uuid, 2094, false) AS r`, [ORG])).rows[0].r);
    const revId: string = opened?.plan_revision_id ?? opened?.planRevisionId;
    expect(revId, JSON.stringify(opened)).toBeTruthy();
    // 2. the real M229 gate refuses activation while it is pending
    await expect(rig.asAdmin((c: any) => c.query(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1::uuid)`, [ORG]))).rejects.toThrow(/activation_blocked_pending_excel_revisions/);
    // 3. governed resolution: the withdrawal writer is gated by the approve key (held by the checker), then activation succeeds
    await as(U.checker, (c) => c.query(`SELECT public.phoenix_central_needs_withdraw_draft_revision($1::uuid, $1::uuid, 'FF-05 normal-sequence rehearsal', NULL)`, [revId]));
    await rig.asAdmin((c: any) => c.query(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1::uuid)`, [ORG]));
    // 4. afterwards a new Excel draft and Excel intake rows are refused - before and after FF1
    const newDraft = () => as(U.importer, (c) => c.query(`SELECT public.phoenix_central_needs_open_plan_revision($1::uuid, 2095, false)`, [ORG]));
    const intake = () => rig.asAdmin((c: any) => c.query(`INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash, byte_size) VALUES ($1,$2,'ff5.xls',$3,100)`, [revId, ORG, 'a'.repeat(64)]));
    await expect(newDraft()).rejects.toThrow();
    await expect(intake()).rejects.toThrow();
    const open = (rev: string | null) => as(U.importer, async (c) => (await c.query(`SELECT excel_import_open FROM public.phoenix_central_needs_my_capabilities($1::uuid, $2::uuid)`, [ORG, rev])).rows[0].excel_import_open as boolean);
    expect(await open(revId)).toBe(false); expect(await open(null)).toBe(false);
    await applyFF(rig);
    await expect(newDraft()).rejects.toThrow();
    await expect(intake()).rejects.toThrow();
    expect(await open(revId)).toBe(false); expect(await open(null)).toBe(false);
    expect((await stateOf(rig)).breaches).toBe(0);
  });
});
