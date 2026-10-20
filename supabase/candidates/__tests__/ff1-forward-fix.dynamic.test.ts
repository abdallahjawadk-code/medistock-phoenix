/**
 * D18 - FF-01..FF-05 for the unnumbered, unapplied forward-fix candidate FF1_r1_forward_fix_NOT_APPLIED.sql (ADR 14.3).
 * Rig only (disposable PostgreSQL); nothing is applied anywhere else.
 *
 *  FF-01 dual base      applies cleanly on a 221-shaped history (001-221 + M223-M230, no M222) AND on the full chain (…+M222); a second apply is refused.
 *  FF-02 no regrant     actor_scope_org (final M228 body) is byte-identical before/after; the candidate has no super_admin branch; a foreign / organization-less
 *                       super_admin is still denied (AUTH-02 rerun).
 *  FF-03 lockout        with no staffed checker, staffing is recovered through the governed route public.assign_profile_permissions only; the candidate has no DML on profiles / overrides.
 *  FF-04 irreversibles  inventory, activation markers, manual events, withdrawals and attestations are digest-identical before/after; the candidate has no DML on them.
 *  FF-05 named-only     a named draft Excel revision of an activated organization admits intake rows again, every other revision stays frozen, a NEW Excel revision is still
 *                       refused, and my_capabilities(org, NULL).excel_import_open stays false (no Excel quantity entry outside the contract).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable, MIGRATIONS_DIR } from '../../../tools/pg-rig/rig.mjs';

const FF = readFileSync(join(__dirname, '..', 'FF1_r1_forward_fix_NOT_APPLIED.sql'), 'utf8').replace(/\r\n/g, '\n');
const code = FF.replace(/^\s*--.*$/gm, '');                                   // statements only
const R1_FILES = ['223_phoenix_central_needs_manual_source_schema_inert.sql', '224_phoenix_central_needs_authorization_closure.sql', '225_phoenix_central_needs_lifecycle_relations_and_sod.sql', '226_phoenix_central_needs_manual_routines_inert.sql',
  '227_phoenix_central_needs_blockers_digest_d27.sql', '228_phoenix_central_needs_material_registration_inert.sql', '229_phoenix_central_needs_manual_activation.sql', '230_phoenix_central_needs_material_registration_activation.sql'];

const ORG = '00000000-0000-0000-0000-0000000ff001', ORG2 = '00000000-0000-0000-0000-0000000ff002';
const U = { maker: '00000000-0000-0000-0000-0000000ff011', checker: '00000000-0000-0000-0000-0000000ff012', saOther: '00000000-0000-0000-0000-0000000ff013', saNone: '00000000-0000-0000-0000-0000000ff014', saHome: '00000000-0000-0000-0000-0000000ff015' };
const REV_NAMED = '00000000-0000-0000-0000-0000000ff021', REV_OTHER = '00000000-0000-0000-0000-0000000ff022';

describe('FF1 static (FF-02 / FF-03 / FF-04 source contract)', () => {
  it('has no super_admin branch, does not redefine actor_scope_org, and is not numbered', () => {
    expect(code).not.toMatch(/super_admin/i);
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+phoenix_cn_policy\.actor_scope_org/i);
    expect('FF1_r1_forward_fix_NOT_APPLIED.sql').not.toMatch(/^\d{3}_/);
  });
  it('contains no DML on staffing (profiles / profile_permission_overrides) - recovery is only through the governed route', () => {
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(public\.)?(profiles|profile_permission_overrides|role_permission_defaults)\b/i);
  });
  it('contains no DML on the irreversible records (inventory, events, withdrawals, acknowledgements, attestations)', () => {
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(public\.)?central_needs_(cutover_inventory|manual_need_events|revision_withdrawals|manual_coverage_acknowledgements)\b/i);
    expect(code).not.toMatch(/\bDROP\b/i);
  });
  it('is one transaction with an in-transaction VERIFY', () => {
    expect(code.match(/^\s*BEGIN\s*;/gm)).toHaveLength(1);
    expect(code.match(/^\s*COMMIT\s*;/gm)).toHaveLength(1);
    expect(FF.indexOf('VERIFY FAILED')).toBeGreaterThan(FF.indexOf('BEGIN;'));
  });
});

const run = rigAvailable() ? describe : describe.skip;
run('FF1 on the rig', { timeout: 900_000 }, () => {
  const rigs: any[] = [];
  afterEach(async () => { while (rigs.length) await rigs.pop().end().catch(() => undefined); });

  async function base(shape: '221-shaped' | 'full-chain') {
    const rig = shape === '221-shaped' ? await buildRig({ upTo: 221 }) : await buildRig();
    rigs.push(rig);
    if (shape === '221-shaped') {
      await rig.asAdmin(async (c: any) => { for (const f of R1_FILES) await c.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/\r\n/g, '\n')); });
    }
    return rig;
  }
  const applyFF = (rig: any) => rig.asAdmin((c: any) => c.query(FF));
  const stateOf = (rig: any) => rig.asAdmin(async (c: any) => (await c.query(`SELECT
      (SELECT md5(pg_get_functiondef('phoenix_cn_policy.actor_scope_org(text)'::regprocedure))) AS actor_scope,
      (SELECT count(*)::int FROM phoenix_private.central_needs_capability_breaches_v1()) AS breaches,
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
      await mk(U.saOther, 'ff-sa-other@rig', 'super_admin', ORG2, []);
      await mk(U.saNone, 'ff-sa-none@rig', 'super_admin', null, []);
      await mk(U.saHome, 'ff-sa-home@rig', 'super_admin', ORG, ['view', 'import']);
      if (activate) await c.query(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1::uuid)`, [ORG]);
    });
  }

  for (const shape of ['221-shaped', 'full-chain'] as const) {
    it(`FF-01 (${shape}): applies cleanly, the seal stays clean, the writers are owner-only again, and a second apply is refused`, async () => {
      const rig = await base(shape);
      const before = await stateOf(rig);
      expect(before.writers_exec).toBe(18);                                     // R1-b made them executable
      await applyFF(rig);
      const after = await stateOf(rig);
      expect(after.writers_exec).toBe(0); expect(after.breaches).toBe(0);
      await expect(applyFF(rig)).rejects.toThrow(/FF1_precondition_failed: already applied/);
    });
  }

  it('FF-02: actor_scope_org is byte-identical, and AUTH-02 still denies a foreign / organization-less super_admin', async () => {
    const rig = await base('full-chain'); await seed(rig, { activate: true });
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
    const rig = await base('full-chain'); await seed(rig, { activate: true });
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

  it('FF-04: activation markers, inventory, events, withdrawals and acknowledgements are digest-identical before and after', async () => {
    const rig = await base('full-chain'); await seed(rig, { activate: true });
    const before = await digests(rig);
    expect(before.markers).toBe(1);
    await applyFF(rig);
    expect(await digests(rig)).toEqual(before);
    // and the append-only attestation of the fix itself cannot be rewritten
    await rig.asAdmin(async (c: any) => {
      await c.query('BEGIN'); await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`INSERT INTO central_needs_plans (id, organization_id, plan_year) VALUES ('00000000-0000-0000-0000-0000000ff0a1', $1, 2091)`, [ORG]);
      await c.query(`INSERT INTO central_needs_plan_revisions (id, plan_id, organization_id, revision_number, status, source_mode) VALUES ($1,'00000000-0000-0000-0000-0000000ff0a1',$2,1,'draft','excel')`, [REV_NAMED, ORG]);
      await c.query('COMMIT');
      await c.query(`SELECT phoenix_private.central_needs_unfreeze_named_revision_v1($1::uuid, 'FF-04 append-only probe')`, [REV_NAMED]);
      await expect(c.query(`UPDATE phoenix_private.central_needs_excel_unfreeze_exceptions SET reason = 'rewritten rewritten'`)).rejects.toThrow(/append_only/);
      await expect(c.query(`DELETE FROM phoenix_private.central_needs_excel_unfreeze_exceptions`)).rejects.toThrow(/append_only/);
    });
  });

  it('FF-05: only the NAMED draft Excel revision admits intake rows again; every other revision, and any NEW Excel revision, stay frozen', async () => {
    const rig = await base('full-chain'); await seed(rig, { activate: true });
    await applyFF(rig);
    const PLAN = '00000000-0000-0000-0000-0000000ff0b1', PLAN2 = '00000000-0000-0000-0000-0000000ff0b2';
    await rig.asAdmin(async (c: any) => {                                          // rig-only: two Excel drafts that exist next to an activated organization
      await c.query('BEGIN'); await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`INSERT INTO central_needs_plans (id, organization_id, plan_year) VALUES ($1,$3,2092),($2,$3,2093)`, [PLAN, PLAN2, ORG]);
      await c.query(`INSERT INTO central_needs_plan_revisions (id, plan_id, organization_id, revision_number, status, source_mode) VALUES ($1,$3,$5,1,'draft','excel'),($2,$4,$5,1,'draft','excel')`, [REV_NAMED, REV_OTHER, PLAN, PLAN2, ORG]);
      await c.query('COMMIT');
    });
    const insertFile = (rev: string) => rig.asAdmin(async (c: any) => (await c.query(
      `INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash, byte_size) VALUES ($1,$2,'ff5.xls',$3,100) RETURNING id`, [rev, ORG, 'a'.repeat(64)])).rows[0].id);
    // before the exemption both are frozen
    await expect(insertFile(REV_NAMED)).rejects.toThrow(/excel_intake_closed_after_activation/);
    await expect(insertFile(REV_OTHER)).rejects.toThrow(/excel_intake_closed_after_activation/);
    const caps = (u: string, rev: string | null) => rig.asUser(u, async (c: any) => (await c.query(`SELECT excel_import_open FROM public.phoenix_central_needs_my_capabilities($1::uuid, $2::uuid)`, [ORG, rev])).rows[0].excel_import_open as boolean);
    expect(await caps(U.maker, REV_NAMED)).toBe(false);
    // owner-only exemption of ONE named revision (never reachable by an API role)
    await expect(rig.asUser(U.saHome, (c: any) => c.query(`SELECT phoenix_private.central_needs_unfreeze_named_revision_v1($1::uuid,'attempted by an API role')`, [REV_NAMED]))).rejects.toThrow(/permission denied/);
    await rig.asAdmin((c: any) => c.query(`SELECT phoenix_private.central_needs_unfreeze_named_revision_v1($1::uuid,'FF-05 named revision rehearsal')`, [REV_NAMED]));
    expect(await insertFile(REV_NAMED)).toBeTruthy();                              // the named revision admits intake rows again
    await expect(insertFile(REV_OTHER)).rejects.toThrow(/excel_intake_closed_after_activation/);   // every other revision stays frozen
    await expect(rig.asAdmin((c: any) => c.query(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode) VALUES ($1,$2,2,'draft','excel')`, [PLAN, ORG])))
      .rejects.toThrow(/excel_intake_closed_after_activation/);                    // a NEW Excel revision is never admitted
    // capabilities: only the named revision is open; organization-wide and other revisions stay closed
    expect(await caps(U.maker, REV_NAMED)).toBe(true);
    expect(await caps(U.maker, REV_OTHER)).toBe(false);
    expect(await caps(U.maker, null)).toBe(false);
    expect(await caps(U.saOther, REV_NAMED)).toBe(false);                          // a foreign super_admin learns nothing and gets nothing
    // refusals of the routine itself
    await expect(rig.asAdmin((c: any) => c.query(`SELECT phoenix_private.central_needs_unfreeze_named_revision_v1($1::uuid,'second exemption attempt')`, [REV_NAMED]))).rejects.toThrow();
    await expect(rig.asAdmin((c: any) => c.query(`SELECT phoenix_private.central_needs_unfreeze_named_revision_v1($1::uuid,'short')`, [REV_OTHER]))).rejects.toThrow();
    expect((await stateOf(rig)).breaches).toBe(0);
  });
});
