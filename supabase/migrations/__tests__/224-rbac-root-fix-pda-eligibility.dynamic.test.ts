/**
 * M224-RBAC-ROOT-FIX — DYNAMIC proof (real disposable PostgreSQL) on the NUMBERED chain that Production follows.
 *
 * Owner decision: Central Needs eligibility is (1) an ACTIVE profile whose home organization is a live
 * pharmacy_department_authority, (2) the explicit key from the permission matrix, (3) the home-organization scope of the
 * operation, (4) never approving one's own work. No role class.
 *
 * Order: canonical 001..223 -> seed (SYNTHETIC data only, never Production's) -> the v1 M224 bytes are refused on two
 * shapes (negative controls: the root cause) -> numbered 224..230 (revised) apply.
 *
 * The two refused shapes, and what each one is:
 *   - ORG: a plan-owning PDA staffed by ORDINARY roles holding the keys. This is NOT Production's recorded shape; it is
 *     the general case the role-class v1 precondition could never admit (no super_admin/central_warehouse_manager maker
 *     and checker), which is the root cause the revision removes.
 *   - ORG_SA_ONLY: a synthetic replica of the shape ERRATA-2 DOCUMENTS for the Production refusal of 2026-10-21 — a live
 *     PDA whose ONLY member is a super_admin profile holding neither central_needs.view nor central_needs.edit. It is
 *     modelled from that written description; no Production row, identity or export is used.
 * Both fail the same v1 precondition ("lacks a staffed maker and a different checker"); the revised chain records both as
 * not ready and defers the lockout guard to the per-organization activation.
 * Gated on PHOENIX_RIG_PG.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;
const lf = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const migration = (f: string) => lf(join(__dirname, '..', f));
const candidate = (f: string) => lf(join(__dirname, '..', '..', 'candidates', f));

const NUMBERED = [
  '224_phoenix_central_needs_authorization_closure.sql',
  '225_phoenix_central_needs_lifecycle_relations_and_sod.sql',
  '226_phoenix_central_needs_manual_routines_inert.sql',
  '227_phoenix_central_needs_blockers_digest_d27.sql',
  '228_phoenix_central_needs_material_registration_inert.sql',
  '229_phoenix_central_needs_manual_activation.sql',
  '230_phoenix_central_needs_material_registration_activation.sql',
];

const ORG = '00000000-0000-0000-0000-0000000d4001';        // owner PDA staffed by ordinary roles (synthetic)
const ORG_OTHER = '00000000-0000-0000-0000-0000000d4002';  // another PDA
const ORG_CARE = '00000000-0000-0000-0000-0000000d4003';   // care institution (not a PDA)
const ORG_BENE = '00000000-0000-0000-0000-0000000d4004';   // beneficiary hospital
const ORG_SOLO = '00000000-0000-0000-0000-0000000d4005';   // a PDA staffed by ONE person only
const ORG_SA_ONLY = '00000000-0000-0000-0000-0000000d4006'; // ERRATA-2's documented shape, synthetic: ONE super_admin, no view/edit

const W = {
  entrant: '00000000-0000-0000-0000-0000000d4401',   // warehouse_officer, ORG: view, edit (+ manual_need.set after M224)
  approver: '00000000-0000-0000-0000-0000000d4402',  // warehouse_officer, ORG: view, approve
  approver2: '00000000-0000-0000-0000-0000000d4403', // institution_admin, ORG: view, approve (+ material_review)
  noKeys: '00000000-0000-0000-0000-0000000d4404',    // warehouse_officer, ORG: no key at all
  viewOnly: '00000000-0000-0000-0000-0000000d4405',  // warehouse_officer, ORG: view
  otherOrg: '00000000-0000-0000-0000-0000000d4406',  // warehouse_officer, ORG_OTHER: every key (one person, maker AND checker)
  care: '00000000-0000-0000-0000-0000000d4407',      // warehouse_officer, ORG_CARE: every key
  saOther: '00000000-0000-0000-0000-0000000d4408',   // super_admin, ORG_OTHER: every key
  saNull: '00000000-0000-0000-0000-0000000d4409',    // super_admin, no home: every key
  susp: '00000000-0000-0000-0000-0000000d440a',      // warehouse_officer, ORG, suspended: every key
  solo: '00000000-0000-0000-0000-0000000d440b',      // warehouse_officer, ORG_SOLO: every key (the only member)
  saOnly: '00000000-0000-0000-0000-0000000d440c',    // super_admin, ORG_SA_ONLY: no central_needs key (the only member)
} as const;
const ALL = ['view', 'import', 'edit', 'approve'];

interface Refusal { code: string; message: string; detail?: string }
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try { await p; } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string };
    return { code: String(err.code), message: String(err.message), detail: err.detail };
  }
  throw new Error('expected the database to refuse this call, but it succeeded');
}

run('M224-RBAC-ROOT-FIX — PDA membership + explicit key + scope + SoD, no role class (dynamic, PostgreSQL)', { timeout: 300_000 }, () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let item = '';
  let year = 2040;
  const notices: string[] = [];
  let v1Refusal: Refusal | null = null;
  let v1SaOnlyRefusal: Refusal | null = null;

  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));
  const as = (userId: string | null, sql: string, params: unknown[] = []) =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows), { role: 'authenticated', commit: true });
  const one = async (user: string | null, sql: string, args: unknown[] = []) => (await as(user, sql, args))[0];
  const rpc = async (user: string | null, fn: string, args: unknown[]) =>
    (await one(user, `SELECT public.phoenix_central_needs_${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS r`, args)).r;
  const scope = async (user: string | null, key: string) =>
    (await one(user, `SELECT phoenix_cn_policy.actor_scope_org($1) AS o`, [key])).o as string | null;
  const grant = (user: string, key: string, allowed = true) =>
    admin(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,$3)
           ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=$3`, [user, key, allowed]);
  const readiness = async (org: string) =>
    (await admin(`SELECT phoenix_private.central_needs_staffing_readiness_v1($1) AS r`, [org]))[0].r;
  const status = async (rev: string) => (await admin(`SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [rev]))[0].status as string;
  const openWithLine = async () => {
    year += 1;
    const r = await rpc(W.entrant, 'open_manual_plan_revision', [ORG, year]);
    const rev = r.plan_revision_id as string;
    await rpc(W.entrant, 'add_manual_need_line', [rev, ORG_BENE, item, null, '12.5', 'planned need', randomUUID(), null, null]);
    return rev;
  };

  beforeAll(async () => {
    rig = await buildRig({ upTo: 223 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
        ($1,'RBAC Pharmacy Dept','دائرة','rbac-owner','pharmacy_department_authority',NULL),
        ($2,'RBAC Other PDA','دائرة أخرى','rbac-other','pharmacy_department_authority',NULL),
        ($3,'RBAC Care Home','مؤسسة','rbac-care','care_institution','hospital'),
        ($4,'RBAC Hospital','مستشفى','rbac-bene','care_institution','hospital'),
        ($5,'RBAC Solo PDA','دائرة فرد','rbac-solo','pharmacy_department_authority',NULL),
        ($6,'RBAC SA-only PDA','دائرة مدير','rbac-sa-only','pharmacy_department_authority',NULL)`,
        [ORG, ORG_OTHER, ORG_CARE, ORG_BENE, ORG_SOLO, ORG_SA_ONLY]);
      await c.query(`INSERT INTO auth.users (id, email) SELECT x, 'rbac-'||substr(x::text,35)||'@rig' FROM unnest($1::uuid[]) x`, [Object.values(W)]);
      const set = (u: string, role: string, org: string | null, st = 'active') =>
        c.query(`UPDATE profiles SET role=$2, status=$3, organization_id=$4 WHERE id=$1`, [u, role, st, org]);
      for (const u of [W.entrant, W.approver, W.noKeys, W.viewOnly]) await set(u, 'warehouse_officer', ORG);
      await set(W.approver2, 'institution_admin', ORG);
      await set(W.otherOrg, 'warehouse_officer', ORG_OTHER); await set(W.care, 'warehouse_officer', ORG_CARE);
      await set(W.saOther, 'super_admin', ORG_OTHER); await set(W.saNull, 'super_admin', null);
      await set(W.susp, 'warehouse_officer', ORG, 'suspended'); await set(W.solo, 'warehouse_officer', ORG_SOLO);
      await set(W.saOnly, 'super_admin', ORG_SA_ONLY);   // deliberately granted NO central_needs key below
      const grants: Array<[string, string[]]> = [
        [W.entrant, ['view', 'edit']], [W.approver, ['view', 'approve']], [W.approver2, ['view', 'approve']], [W.viewOnly, ['view']],
        [W.otherOrg, ALL], [W.care, ALL], [W.saOther, ALL], [W.saNull, ALL], [W.susp, ALL], [W.solo, ALL],
      ];
      for (const [u, keys] of grants) for (const k of keys) {
        await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
          ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [u, `central_needs.${k}`]);
      }
    });

    // Plans are seeded under replica only so their owning organization is what the v1 prelude inspects.
    const plan = (sql: string, args: unknown[]) => rig.asAdmin(async (c: any) => {
      await c.query(`BEGIN`);
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(sql, args);
      await c.query(`COMMIT`);
    });
    const v1Attempt = async (): Promise<Refusal | null> => {
      try {
        await rig.asAdmin((c: any) => c.query(candidate('R1a_02_authorization_closure.sql')));
        return null;
      } catch (e) {
        const err = e as { code?: string; message?: string };
        await rig.asAdmin((c: any) => c.query('ROLLBACK')).catch(() => undefined);
        return { code: String(err.code), message: String(err.message) };
      }
    };

    // Negative control 1 — the synthetic replica of ERRATA-2's documented shape, alone, so the v1 refusal can only
    // name it. Its plan is removed afterwards: the revised chain inspects ORG's plan exactly as before.
    await plan(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1, 2030)`, [ORG_SA_ONLY]);
    v1SaOnlyRefusal = await v1Attempt();
    await plan(`DELETE FROM central_needs_plans WHERE organization_id = $1`, [ORG_SA_ONLY]);

    // Negative control 2 — ORG owns a plan, so the M224 prelude inspects it (no revision: nothing blocks the later
    // activation); the v1 bytes (the version Production refused on 2026-10-21) still refuse this synthetic data.
    await plan(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1, 2030)`, [ORG]);
    v1Refusal = await v1Attempt();

    await rig.asAdmin(async (c: any) => {
      const onNotice = (n: { message?: string }) => notices.push(String(n.message));
      c.on('notice', onNotice);
      try {
        for (const f of NUMBERED) await c.query(migration(f));
      } finally {
        c.removeListener('notice', onNotice);
      }
    });
    const [{ id }] = await admin(`INSERT INTO central_items (id, name, name_ar, unit, status) VALUES ($1,$2,$2,'box','active') RETURNING id`,
      [randomUUID(), `RBAC item ${Date.now()}`]);
    item = id;
  }, 900_000);
  afterAll(async () => { await rig?.end(); });

  describe('root cause and the migration-time behaviour', () => {
    it('NEGATIVE CONTROL: the v1 M224 refuses a PDA staffed only by ordinary roles (synthetic; the root cause, not Production\'s recorded shape)', () => {
      expect(v1Refusal, 'the v1 bytes must refuse this data').not.toBeNull();
      expect(v1Refusal!.message).toMatch(/R1a02_precondition_failed: organization .* lacks a staffed maker and a different checker/);
      expect(v1Refusal!.message).toContain(ORG);
    });

    it('NEGATIVE CONTROL: the v1 M224 refuses ERRATA-2\'s documented shape too — a PDA whose only member is a super_admin without view/edit (synthetic replica)', () => {
      expect(v1SaOnlyRefusal, 'the v1 bytes must refuse this data').not.toBeNull();
      expect(v1SaOnlyRefusal!.message)
        .toBe(`R1a02_precondition_failed: organization ${ORG_SA_ONLY} lacks a staffed maker and a different checker (lockout risk)`);
    });

    it('the revised M224..M230 applied on the same data; M224 recorded the readiness (counts only) instead of refusing', async () => {
      expect((await admin(`SELECT to_regnamespace('phoenix_cn_policy') IS NOT NULL AS ok`))[0].ok).toBe(true);
      const note = notices.find((n) => n.startsWith('R1a02 staffing readiness:'));
      expect(note, 'readiness notice').toBeDefined();
      expect(note).toContain(ORG);
      expect(note).toContain('"ready": false');          // the entry key did not exist yet
      expect(note).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/); // only the organization id, no person
    });

    it('a plan owned by a non-PDA organization is still refused by the structural prelude (negative control kept)', async () => {
      // Exercise the v2 prelude in isolation on a scratch transaction: it must reject a care-institution owner.
      const prelude = candidate('R1a_02_authorization_closure_v2.sql');
      const start = prelude.indexOf('DO $pre$');
      const end = prelude.indexOf('$pre$;', start) + '$pre$;'.length;
      const block = prelude.slice(start, end)
        .replace("IF to_regnamespace('phoenix_cn_policy') IS NOT NULL", 'IF false')
        .replace("OR EXISTS (SELECT 1 FROM public.permission_keys WHERE key = 'central_needs.manual_need.set')", '');
      const e = await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        try {
          await c.query(`SET LOCAL session_replication_role = replica`);
          await c.query(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1, 2031)`, [ORG_CARE]);
          await c.query(`SET LOCAL session_replication_role = origin`);
          await c.query(block);
          return null;
        } catch (err) {
          return err as { message?: string };
        } finally {
          await c.query('ROLLBACK');
        }
      });
      expect(String(e?.message)).toMatch(/plan-owning organization .* is not a live pharmacy_department_authority/);
    });

    it('no eligibility routine names a role; the membership predicate is strictly boolean', async () => {
      const rows = await admin(`SELECT p.oid::regprocedure::text AS sig, p.prosrc FROM pg_proc p
        WHERE p.oid IN ('phoenix_cn_policy.actor_scope_org(text)'::regprocedure, 'phoenix_cn_policy.material_reviewer_org()'::regprocedure,
                        'public._phoenix_central_needs_role_eligible_v1()'::regprocedure,
                        'phoenix_private.central_needs_staffing_readiness_v1(uuid)'::regprocedure)`);
      expect(rows).toHaveLength(4);
      for (const r of rows) {
        expect(r.prosrc, r.sig).not.toMatch(/super_admin|central_warehouse_manager|institution_admin|warehouse_officer|outlet_officer|health_center_manager/);
        expect(r.prosrc, r.sig).not.toMatch(/\.role\b/);
      }
      expect((await one(null, `SELECT public._phoenix_central_needs_role_eligible_v1() AS e`)).e).toBe(false);
    });

    it('the readiness helper is owner-only (no EXECUTE for anon, authenticated, service_role)', async () => {
      for (const who of ['anon', 'authenticated', 'service_role']) {
        const [{ x }] = await admin(`SELECT has_function_privilege($1, 'phoenix_private.central_needs_staffing_readiness_v1(uuid)', 'EXECUTE') AS x`, [who]);
        expect(x, who).toBe(false);
      }
      expect((await refusal(as(W.entrant, `SELECT phoenix_private.central_needs_staffing_readiness_v1($1)`, [ORG]))).code).toBe('42501');
    });

    it('the capability seal of the last relation set reports nothing on the revised chain', async () => {
      expect(await admin(`SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()`)).toEqual([]);
    });
  });

  describe('lockout guard moved to the per-organization activation', () => {
    it('activation REFUSES while the organization has no maker + different checker; succeeds once staffed by ordinary roles', async () => {
      expect(await readiness(ORG)).toMatchObject({ ready: false, checkers: 2, makers: 0 });
      const e = await refusal(admin(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1)`, [ORG]));
      expect(e.message).toBe('activation_blocked_lockout_risk');
      expect(e.detail).toContain('makers=0');
      await grant(W.entrant, 'central_needs.manual_need.set');
      expect(await readiness(ORG)).toMatchObject({ ready: true, makers: 1, checkers: 2 });
      const [{ r }] = await admin(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1) AS r`, [ORG]);
      expect(r).toMatchObject({ ok: true, idempotent_replay: false, staffing: { ready: true, makers: 1, checkers: 2 } });
    });

    it('ONE person holding both maker and checker keys is NOT ready (SoD could never be met) and activation refuses', async () => {
      await grant(W.solo, 'central_needs.manual_need.set');
      expect(await readiness(ORG_SOLO)).toMatchObject({ ready: false, active_members: 1, makers: 1, checkers: 1 });
      expect((await refusal(admin(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1)`, [ORG_SOLO]))).message)
        .toBe('activation_blocked_lockout_risk');
      // ...and a second, DIFFERENT checker makes it ready (one maker + one other checker in another PDA: ORG_OTHER).
      await grant(W.otherOrg, 'central_needs.manual_need.set');
      expect(await readiness(ORG_OTHER)).toMatchObject({ ready: true, makers: 1, checkers: 2 });   // otherOrg + saOther
    });

    it('ERRATA-2\'s documented shape (synthetic replica: one super_admin, no view/edit) is not ready, and activation refuses — no role shortcut', async () => {
      expect(await readiness(ORG_SA_ONLY)).toMatchObject({ ready: false, active_members: 1, makers: 0, checkers: 0 });
      const e = await refusal(admin(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1)`, [ORG_SA_ONLY]));
      expect(e.message).toBe('activation_blocked_lockout_risk');
      expect(e.detail).toContain('makers=0');
    });

    it('a suspended member is never counted', async () => {
      const r = await readiness(ORG);
      expect(r.active_members).toBe(5);   // entrant, approver, approver2, noKeys, viewOnly - not the suspended one
    });
  });

  describe('the single predicate: membership + explicit key + scope, whatever the role', () => {
    it('ordinary roles of the home PDA get their organization for exactly the keys they hold', async () => {
      expect(await scope(W.entrant, 'central_needs.view')).toBe(ORG);
      expect(await scope(W.entrant, 'central_needs.edit')).toBe(ORG);
      expect(await scope(W.entrant, 'central_needs.manual_need.set')).toBe(ORG);
      expect(await scope(W.entrant, 'central_needs.approve')).toBeNull();
      expect(await scope(W.approver, 'central_needs.approve')).toBe(ORG);
      expect(await scope(W.approver2, 'central_needs.approve')).toBe(ORG);   // institution_admin is no longer excluded
    });

    it('NULL without the key, for a care-institution home, a null home, a suspended member, and never another organization', async () => {
      for (const k of ['central_needs.view', 'central_needs.edit', 'central_needs.approve']) expect(await scope(W.noKeys, k), k).toBeNull();
      expect(await scope(W.viewOnly, 'central_needs.edit')).toBeNull();
      expect(await scope(W.care, 'central_needs.view')).toBeNull();
      expect(await scope(W.saNull, 'central_needs.view')).toBeNull();
      expect(await scope(W.susp, 'central_needs.view')).toBeNull();
      expect(await scope(W.otherOrg, 'central_needs.view')).toBe(ORG_OTHER);
      expect(await scope(W.saOther, 'central_needs.view')).toBe(ORG_OTHER);
      for (const u of [W.otherOrg, W.saOther, W.saNull, W.care]) {
        expect((await one(u, `SELECT public.phoenix_central_needs_actor_authorized($1,'central_needs.view') AS a`, [ORG])).a, u).toBe(false);
      }
    });

    it('the membership boundary (M211 predicate, re-based) admits PDA members of any role and nobody else', async () => {
      const elig = async (u: string | null) => (await one(u, `SELECT public._phoenix_central_needs_role_eligible_v1() AS e`)).e;
      for (const u of [W.entrant, W.approver2, W.noKeys, W.otherOrg, W.saOther]) expect(await elig(u), u).toBe(true);
      for (const u of [W.care, W.saNull, W.susp, null]) expect(await elig(u), String(u)).toBe(false);
    });

    it('RLS: the home PDA members holding view read their rows; no key, other organization, care home and super_admin elsewhere read none', async () => {
      const n = async (u: string) => (await one(u, `SELECT count(*)::int AS n FROM central_needs_plans WHERE organization_id=$1`, [ORG])).n;
      expect(await n(W.entrant)).toBeGreaterThan(0);
      expect(await n(W.approver2)).toBeGreaterThan(0);
      for (const u of [W.noKeys, W.otherOrg, W.care, W.saOther, W.saNull, W.susp]) expect(await n(u), u).toBe(0);
    });

    it('the material reviewer predicate: an ordinary member with the explicit reviewer key (+ view), never a role shortcut', async () => {
      const rev = async (u: string) => (await one(u, `SELECT phoenix_cn_policy.material_reviewer_org() AS o`)).o;
      expect(await rev(W.approver2)).toBeNull();                       // no reviewer key yet
      await grant(W.approver2, 'central_needs.material_review');
      expect(await rev(W.approver2)).toBe(ORG);                        // institution_admin + key + view
      await grant(W.saOther, 'central_needs.material_review');
      expect(await rev(W.saOther)).toBe(ORG_OTHER);                    // a super_admin only for its own home PDA
      await grant(W.care, 'central_needs.material_review');
      expect(await rev(W.care)).toBeNull();                            // a care-institution home never qualifies
    });
  });

  describe('the workflow through the real RPCs (ordinary staff, SoD)', () => {
    it('an ordinary entrant opens, enters and submits; an ordinary independent approver approves', async () => {
      const rev = await openWithLine();
      await rpc(W.entrant, 'submit_revision', [rev]);
      expect(await status(rev)).toBe('submitted');
      await rpc(W.approver, 'approve_revision', [rev]);
      expect(await status(rev)).toBe('approved');
      expect((await admin(`SELECT approved_by FROM central_needs_plan_revisions WHERE id=$1`, [rev]))[0].approved_by).toBe(W.approver);
    });

    it('SELF-APPROVAL is refused even when the entrant also holds the approve key; a different member then approves', async () => {
      const rev = await openWithLine();
      await rpc(W.entrant, 'submit_revision', [rev]);
      await grant(W.entrant, 'central_needs.approve');
      try {
        expect((await refusal(rpc(W.entrant, 'approve_revision', [rev]))).message).toMatch(/separation_of_duties/);
        expect(await status(rev)).toBe('submitted');
      } finally {
        await grant(W.entrant, 'central_needs.approve', false);
      }
      await rpc(W.approver2, 'approve_revision', [rev]);
      expect(await status(rev)).toBe('approved');
    });

    it('no key, view only, another organization, a care home, a super_admin elsewhere: every step is refused', async () => {
      const rev = await openWithLine();
      for (const u of [W.noKeys, W.viewOnly, W.otherOrg, W.care, W.saOther, W.saNull, W.susp]) {
        expect((await refusal(rpc(u, 'submit_revision', [rev]))).message, u).toMatch(/forbidden_central_needs|not_found|forbidden/);
        expect((await refusal(rpc(u, 'open_manual_plan_revision', [ORG, year + 50]))).message, u).toMatch(/forbidden_central_needs/);
      }
      await rpc(W.entrant, 'submit_revision', [rev]);
      for (const u of [W.noKeys, W.viewOnly, W.otherOrg, W.care, W.saOther]) {
        expect((await refusal(rpc(u, 'approve_revision', [rev]))).message, u).toMatch(/forbidden_central_needs|not_found|forbidden/);
      }
      expect(await status(rev)).toBe('submitted');
    });

    it('a non-member is refused with the membership code first; an unauthenticated caller with 28000', async () => {
      const e = await refusal(rpc(W.care, 'open_manual_plan_revision', [ORG, year + 60]));
      expect(e.message).toBe('forbidden_central_needs_role');
      expect(e.detail).toContain('not an active member of a live pharmacy_department_authority');
      expect((await refusal(rpc(null, 'open_manual_plan_revision', [ORG, year + 61]))).code).toBe('28000');
    });
  });
});
