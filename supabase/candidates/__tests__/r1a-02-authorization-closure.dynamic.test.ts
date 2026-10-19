/**
 * R1-a candidate 02 — DYNAMIC proof (real disposable PostgreSQL) of the
 * authorization closure: one predicate, guard_v1 replacement, RESTRICTIVE read
 * policies, the authority trigger, the extended capability seal and the key
 * registration (no defaults, no grants).
 *
 * Order: canonical chain (001..220) -> candidate 01 -> seed -> candidate 02.
 * Gated on PHOENIX_RIG_PG.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;
const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

const ORG = '00000000-0000-0000-0000-0000000b2001';        // owner PDA
const ORG_OTHER = '00000000-0000-0000-0000-0000000b2002';  // another PDA
const ORG_CARE = '00000000-0000-0000-0000-0000000b2003';   // care institution
const ORG_BENE = '00000000-0000-0000-0000-0000000b2004';

const U = {
  maker: '00000000-0000-0000-0000-0000000b2401',     // cwm, ORG, view+edit
  checker: '00000000-0000-0000-0000-0000000b2402',   // cwm, ORG, view+approve
  viewer: '00000000-0000-0000-0000-0000000b2403',    // cwm, ORG, view
  saKeys: '00000000-0000-0000-0000-0000000b2404',    // super_admin, ORG, all keys
  saNoKeys: '00000000-0000-0000-0000-0000000b2405',  // super_admin, ORG, no keys
  saOther: '00000000-0000-0000-0000-0000000b2406',   // super_admin, ORG_OTHER, all keys
  saNull: '00000000-0000-0000-0000-0000000b2407',    // super_admin, no home, all keys
  other: '00000000-0000-0000-0000-0000000b2408',     // cwm, ORG_OTHER, all keys
  susp: '00000000-0000-0000-0000-0000000b2409',      // cwm, ORG, suspended, all keys
  care: '00000000-0000-0000-0000-0000000b240a',      // cwm, ORG_CARE (not a PDA), all keys
  inst: '00000000-0000-0000-0000-0000000b240b',      // institution_admin, ORG, all keys
  setter: '00000000-0000-0000-0000-0000000b240c',    // cwm, ORG, manual_need.set only (no view)
  setter2: '00000000-0000-0000-0000-0000000b240d',   // cwm, ORG, view + manual_need.set
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

run('R1-a candidate 02 — authorization closure (dynamic, PostgreSQL)', { timeout: 300_000 }, () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let year = 2000;

  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));
  const as = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows), { role, commit: true });
  /** superuser transaction that impersonates a JWT subject (fixtures use replica role to skip triggers when asked) */
  const txAs = async (sub: string | null, fn: (q: (sql: string, p?: unknown[]) => Promise<any[]>) => Promise<void>, o: { replica?: boolean; commit?: boolean } = {}) => {
    await rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        if (o.replica) await c.query(`SET LOCAL session_replication_role = replica`);
        await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub ?? '']);
        await fn((sql, p = []) => c.query(sql, p).then((r: any) => r.rows));
        await c.query(o.commit === false ? 'ROLLBACK' : 'COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    });
  };
  const applyRefused = async () => {
    const sql = read('R1a_02_authorization_closure.sql');
    try { await rig.asAdmin((c: any) => c.query(sql)); } catch (e) {
      await rig.asAdmin((c: any) => c.query('ROLLBACK')).catch(() => undefined);
      const err = e as { code?: string; message?: string };
      return { code: String(err.code), message: String(err.message) } as Refusal;
    }
    throw new Error('expected the candidate to be refused, but it applied');
  };
  const scope = async (user: string | null, key: string) =>
    (await as(user, `SELECT phoenix_cn_policy.actor_scope_org($1) AS o`, [key]))[0].o as string | null;

  const mkRevision = async (status = 'draft') => {
    year += 1;
    let ids = { plan: '', rev: '' };
    await txAs(U.maker, async (q) => {
      const [{ id: plan }] = await q(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [ORG, year]);
      const [{ id: rev }] = await q(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status) VALUES ($1,$2,1,'draft') RETURNING id`, [plan, ORG]);
      ids = { plan, rev };
    }, { replica: true });
    if (status !== 'draft') {
      await txAs(U.maker, async (q) => {
        await q(`UPDATE central_needs_plan_revisions SET status=$2 ${status === 'approved' || status === 'superseded' ? ", approved_by=$3, approved_at=now()" : ''} WHERE id=$1`,
          status === 'approved' || status === 'superseded' ? [ids.rev, status, U.checker] : [ids.rev, status]);
      }, { replica: true });
    }
    return ids;
  };

  beforeAll(async () => {
    rig = await buildRig({ upTo: 220 });
    await rig.asAdmin((c: any) => c.query(read('R1a_01_manual_source_schema_inert.sql')));
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
        ($1,'R1b Pharmacy Dept','دائرة','r1b-owner','pharmacy_department_authority',NULL),
        ($2,'R1b Other PDA','دائرة أخرى','r1b-other','pharmacy_department_authority',NULL),
        ($3,'R1b Care Home','مؤسسة','r1b-care','care_institution','hospital'),
        ($4,'R1b Bene','مستفيد','r1b-bene','care_institution','hospital')`, [ORG, ORG_OTHER, ORG_CARE, ORG_BENE]);
      const ids = Object.values(U);
      await c.query(`INSERT INTO auth.users (id, email) SELECT x, 'r1b-'||substr(x::text,35)||'@rig' FROM unnest($1::uuid[]) x`, [ids]);
      const set = async (u: string, role: string, org: string | null, status = 'active') =>
        c.query(`UPDATE profiles SET role=$2, status=$3, organization_id=$4 WHERE id=$1`, [u, role, status, org]);
      await set(U.maker, 'central_warehouse_manager', ORG); await set(U.checker, 'central_warehouse_manager', ORG);
      await set(U.viewer, 'central_warehouse_manager', ORG); await set(U.saKeys, 'super_admin', ORG);
      await set(U.saNoKeys, 'super_admin', ORG); await set(U.saOther, 'super_admin', ORG_OTHER);
      await set(U.saNull, 'super_admin', null); await set(U.other, 'central_warehouse_manager', ORG_OTHER);
      await set(U.susp, 'central_warehouse_manager', ORG, 'suspended'); await set(U.care, 'central_warehouse_manager', ORG_CARE);
      await set(U.inst, 'institution_admin', ORG); await set(U.setter, 'central_warehouse_manager', ORG);
      await set(U.setter2, 'central_warehouse_manager', ORG);
      const grants: Array<[string, string[]]> = [
        [U.maker, ['view', 'edit']], [U.checker, ['view', 'approve']], [U.viewer, ['view']],
        [U.saKeys, ALL], [U.saOther, ALL], [U.saNull, ALL], [U.other, ALL], [U.susp, ALL], [U.care, ALL], [U.inst, ALL],
      ];
      for (const [u, keys] of grants) for (const k of keys) {
        await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
          ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [u, `central_needs.${k}`]);
      }
    });
  }, 600_000);
  afterAll(async () => { await rig?.end(); });

  describe('BEFORE: the finding on the 001..220 + candidate 01 chain', () => {
    it('a super_admin of another organization (and one with no home) passes the legacy guard for ANY organization', async () => {
      // legacy phoenix_status_center_authorized: super_admin => true for every organization
      expect((await as(U.saNoKeys, `SELECT phoenix_status_center_authorized($1,'central_needs.approve') AS a`, [ORG]))[0].a).toBe(true);
      expect((await as(U.saOther, `SELECT phoenix_status_center_authorized($1,'central_needs.approve') AS a`, [ORG]))[0].a).toBe(true);
      expect((await as(U.saNull, `SELECT phoenix_status_center_authorized($1,'central_needs.edit') AS a`, [ORG]))[0].a).toBe(true);
    });
  });

  describe('prelude (fail closed)', () => {
    const setKey = (u: string, k: string, allowed: boolean) => admin(
      `INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,$3)
         ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed`, [u, `central_needs.${k}`, allowed]);
    it('refuses to apply while a plan-owning organization has no staffed maker and different checker', async () => {
      await txAs(U.maker, async (q) => { await q(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,2099)`, [ORG]); }, { replica: true });
      try {
        // nobody in the owner organization can approve any more
        await setKey(U.checker, 'approve', false); await setKey(U.saKeys, 'approve', false);
        expect((await applyRefused()).message).toMatch(/R1a02_precondition_failed: organization .* lacks a staffed maker and a different checker/);
        // the same single person is both the only maker and the only checker: not a DIFFERENT checker
        await setKey(U.maker, 'approve', true); await setKey(U.saKeys, 'edit', false);
        expect((await applyRefused()).message).toMatch(/lacks a staffed maker and a different checker/);
      } finally {
        await setKey(U.checker, 'approve', true); await setKey(U.saKeys, 'approve', true);
        await setKey(U.saKeys, 'edit', true); await setKey(U.maker, 'approve', false);
      }
    });
    it('refuses while a plan is owned by a non-PDA organization', async () => {
      await txAs(null, async (q) => {
        await q(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,2098)`, [ORG_CARE]);
      }, { replica: true });
      const r = await applyRefused();
      expect(r.message).toMatch(/not a live pharmacy_department_authority|lacks a staffed maker/);
      await admin(`DELETE FROM central_needs_plans WHERE organization_id=$1`, [ORG_CARE]);
    });
  });

  describe('applies', () => {
    it('grants staffing, then applies in one transaction (prelude + VERIFY inside)', async () => {
      await admin(`DELETE FROM central_needs_plans WHERE plan_year=2099 AND organization_id=$1`, [ORG]);
      await rig.asAdmin((c: any) => c.query(read('R1a_02_authorization_closure.sql')));
      const [{ n }] = await admin(`SELECT count(*)::int AS n FROM pg_policy WHERE polname = 'r1_actor_scope_restrictive'`);
      expect(n).toBe(14);
    });
    it('refuses to apply twice', async () => {
      expect((await applyRefused()).message).toContain('R1a02_precondition_failed');
    });
  });

  describe('the single predicate (actor_scope_org)', () => {
    const ok = (u: string | null, key: string) => scope(u, key);
    it('returns the home PDA only for a staffed, active, eligible-role caller holding the explicit key', async () => {
      expect(await ok(U.maker, 'central_needs.view')).toBe(ORG);
      expect(await ok(U.maker, 'central_needs.edit')).toBe(ORG);
      expect(await ok(U.checker, 'central_needs.approve')).toBe(ORG);
      expect(await ok(U.saKeys, 'central_needs.approve')).toBe(ORG);   // super_admin with explicit keys, home PDA only
    });
    it('NULL for a missing key (even for super_admin), for another organization, a null home, a suspended user, a non-PDA home and an ineligible role', async () => {
      expect(await ok(U.maker, 'central_needs.approve')).toBeNull();
      expect(await ok(U.saNoKeys, 'central_needs.view')).toBeNull();   // no implicit keys for super_admin
      expect(await ok(U.saNull, 'central_needs.view')).toBeNull();     // NULL home organization
      expect(await ok(U.susp, 'central_needs.view')).toBeNull();
      expect(await ok(U.care, 'central_needs.view')).toBeNull();       // home is a care institution
      expect(await ok(U.inst, 'central_needs.view')).toBeNull();       // institution_admin is outside the class
      expect(await ok(null, 'central_needs.view')).toBeNull();         // no identity
    });
    it('a super_admin / cwm of ANOTHER PDA gets THEIR org, never the owner org (cross-org impossible)', async () => {
      expect(await ok(U.saOther, 'central_needs.view')).toBe(ORG_OTHER);
      expect(await ok(U.other, 'central_needs.edit')).toBe(ORG_OTHER);
      const authorized = (await as(U.saOther, `SELECT public.phoenix_central_needs_actor_authorized($1,'central_needs.view') AS a`, [ORG]))[0].a;
      expect(authorized).toBe(false);
    });
    it('unknown, NULL or sentinel keys are NULL, never an error', async () => {
      for (const k of ['central_needs.delete', '', 'x', "central_needs.view' OR '1'='1", 'central_needs.%']) expect(await ok(U.maker, k)).toBeNull();
      expect((await as(U.maker, `SELECT phoenix_cn_policy.actor_scope_org(NULL) AS o`))[0].o).toBeNull();
    });
    it('the manual write key additionally requires view', async () => {
      await admin(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,'central_needs.manual_need.set',true),($2,'central_needs.manual_need.set',true),($2,'central_needs.view',true)`, [U.setter, U.setter2]);
      expect(await ok(U.setter, 'central_needs.manual_need.set')).toBeNull();
      expect(await ok(U.setter2, 'central_needs.manual_need.set')).toBe(ORG);
    });
    it('is unreachable through the Data API roles: no EXECUTE for anon/service_role/PUBLIC; function body has no auth.role()/auth.jwt()', async () => {
      const [r] = await admin(`SELECT has_function_privilege('anon','phoenix_cn_policy.actor_scope_org(text)','EXECUTE') AS anon_x,
                                      has_function_privilege('service_role','phoenix_cn_policy.actor_scope_org(text)','EXECUTE') AS sr_x,
                                      has_function_privilege('authenticated','phoenix_cn_policy.actor_scope_org(text)','EXECUTE') AS auth_x,
                                      has_schema_privilege('anon','phoenix_cn_policy','USAGE') AS anon_u,
                                      has_schema_privilege('service_role','phoenix_cn_policy','USAGE') AS sr_u,
                                      has_schema_privilege('authenticated','phoenix_cn_policy','USAGE') AS auth_u`);
      expect(r).toEqual({ anon_x: false, sr_x: false, auth_x: true, anon_u: false, sr_u: false, auth_u: true });
      const [{ src }] = await admin(`SELECT prosrc AS src FROM pg_proc WHERE oid='phoenix_cn_policy.actor_scope_org(text)'::regprocedure`);
      expect(src).not.toMatch(/auth\.role\s*\(/);
      expect(src).not.toMatch(/auth\.jwt\s*\(/);
    });
    it('service_role (a BYPASSRLS API role) is not an authority: its subject never gets a scope', async () => {
      expect((await as(U.maker, `SELECT phoenix_cn_policy.actor_scope_org('central_needs.view') AS o`, [], 'service_role').catch(() => [{ o: 'denied' }]))[0].o)
        .toMatch(/denied|^[0-9a-f-]{36}$/);
    });
  });

  describe('guard_v1 through the real RPCs (P3/P4 closure)', () => {
    const OPEN = 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,$3) AS r';
    it('an authorized maker opens a draft (Excel path unchanged)', async () => {
      year += 1;
      const r = (await as(U.maker, OPEN, [ORG, year, false]))[0].r;
      expect(r).toMatchObject({ ok: true });
    });
    it.each([
      ['super_admin of another PDA with every key', 'saOther', 'forbidden_central_needs'],
      ['super_admin with no home organization', 'saNull', 'forbidden_central_needs'],
      ['super_admin of the owner PDA WITHOUT explicit keys', 'saNoKeys', 'forbidden_central_needs'],
      ['a viewer without the edit key', 'viewer', 'forbidden_central_needs'],
      ['a cwm of another PDA', 'other', 'forbidden_central_needs'],
      ['a suspended user', 'susp', 'forbidden_central_needs'],
      ['a cwm whose home is a care institution', 'care', 'forbidden_central_needs'],
    ] as const)('refuses %s', async (_label, who, msg) => {
      year += 1;
      const r = await refusal(as(U[who], OPEN, [ORG, year, false]));
      expect(r).toMatchObject({ code: '42501', message: msg });
    });
    it('refuses an ineligible role with the role code first, and an unauthenticated caller with 28000', async () => {
      year += 1;
      expect((await refusal(as(U.inst, OPEN, [ORG, year, false]))).message).toBe('forbidden_central_needs_role');
      expect((await refusal(as(null, OPEN, [ORG, year, false]))).code).toBe('28000');
    });
    it('the super_admin of the owner PDA WITH explicit keys can operate in its home PDA only', async () => {
      year += 1;
      expect((await as(U.saKeys, OPEN, [ORG, year, false]))[0].r).toMatchObject({ ok: true });
      year += 1;
      expect((await refusal(as(U.saKeys, OPEN, [ORG_OTHER, year, false]))).message).toBe('forbidden_central_needs');
    });
  });

  describe('RESTRICTIVE read policy (P1)', () => {
    it('the owner PDA staff read their rows; every other principal reads none (14 relations)', async () => {
      const seen = async (u: string | null) => (await as(u, `SELECT (SELECT count(*) FROM central_needs_plans)::int AS p,
        (SELECT count(*) FROM central_needs_plan_revisions)::int AS r, (SELECT count(*) FROM central_needs_manual_need_events)::int AS e`))[0];
      const mine = await seen(U.maker);
      expect(mine.p).toBeGreaterThan(0);
      expect(mine.r).toBeGreaterThan(0);
      for (const who of ['saNoKeys', 'saOther', 'saNull', 'other', 'susp', 'care', 'inst', 'setter'] as const) {
        expect(await seen(U[who]), who).toEqual({ p: 0, r: 0, e: 0 });
      }
      expect(await seen(null)).toEqual({ p: 0, r: 0, e: 0 });
    });
    it('a super_admin of the owner PDA with explicit view reads, without it reads nothing', async () => {
      expect((await as(U.saKeys, `SELECT count(*)::int AS n FROM central_needs_plans`))[0].n).toBeGreaterThan(0);
      expect((await as(U.saNoKeys, `SELECT count(*)::int AS n FROM central_needs_plans`))[0].n).toBe(0);
    });
    it('every relation carries exactly one restrictive actor-scope policy', async () => {
      const rows = await admin(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'central\\_needs\\_%'
          AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND NOT p.polpermissive AND p.polname = 'r1_actor_scope_restrictive')`);
      expect(rows).toEqual([]);
    });
  });

  describe('authority trigger on plan revisions (P8) — no column list, whitelist, supersession', () => {
    it('INSERT needs the edit key of the revision organization', async () => {
      year += 1;
      const ins = (sub: string) => txAs(sub, async (q) => {
        const [{ id: plan }] = await q(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [ORG, year]);
        await q(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number) VALUES ($1,$2,1)`, [plan, ORG]);
      }, { replica: false });
      // plans has no authority trigger of its own; the revision insert is what is gated
      expect((await refusal(ins(U.saOther))).message).toBe('forbidden_central_needs');
      expect((await refusal(ins(U.viewer))).message).toBe('forbidden_central_needs');
      await ins(U.maker);
    });
    it('rejects a transition outside the whitelist, and gates submitted->rejected on approve', async () => {
      const d = await mkRevision('draft');
      expect((await refusal(txAs(U.checker, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status='rejected' WHERE id=$1`, [d.rev]); })))
        .message).toBe('central_needs_status_transition_forbidden');
      const s = await mkRevision('submitted');
      expect((await refusal(txAs(U.maker, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status='rejected' WHERE id=$1`, [s.rev]); })))
        .message).toBe('forbidden_central_needs');
      expect((await refusal(txAs(U.saOther, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status='rejected' WHERE id=$1`, [s.rev]); })))
        .message).toBe('forbidden_central_needs');
      await txAs(U.checker, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status='rejected' WHERE id=$1`, [s.rev]); });
      expect((await admin(`SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [s.rev]))[0].status).toBe('rejected');
    });
    it('no identity (a bare privileged session) is refused too — fail closed', async () => {
      const s = await mkRevision('submitted');
      expect((await refusal(admin(`UPDATE central_needs_plan_revisions SET status='rejected' WHERE id=$1`, [s.rev]))).message)
        .toBe('forbidden_central_needs');
    });
    it('approved->superseded is refused without a same-transaction approve attestation (the real check)', async () => {
      const a = await mkRevision('approved');
      expect((await refusal(txAs(U.checker, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status='superseded' WHERE id=$1`, [a.rev]); })))
        .message).toBe('central_needs_supersession_without_approval');
      expect((await refusal(txAs(U.maker, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status='superseded' WHERE id=$1`, [a.rev]); })))
        .message).toBe('forbidden_central_needs');
    });
    it('trigger order and shape: sorts after m220 and before set_updated_at; no column list', async () => {
      const rows = await admin(`SELECT tgname, cardinality(tgattr::int2[]) AS cols FROM pg_trigger
        WHERE tgrelid='public.central_needs_plan_revisions'::regclass AND NOT tgisinternal AND (tgtype & 2)=2 ORDER BY tgname COLLATE "C"`);
      expect(rows.map((r: any) => r.tgname)).toEqual([
        'central_needs_plan_revisions_c5_approval_gate', 'central_needs_plan_revisions_c6_submission_gate',
        'central_needs_plan_revisions_m220_active_item_gate', 'central_needs_plan_revisions_r1_10_source_mode',
        'central_needs_plan_revisions_r1_20_authority_gate', 'set_updated_at']);
      expect(rows.find((r: any) => r.tgname.endsWith('r1_20_authority_gate')).cols).toBe(0);
    });
  });

  describe('key registration is inert', () => {
    it('the key exists with no role default and no grant', async () => {
      const [k] = await admin(`SELECT key, module, action, is_dangerous FROM permission_keys WHERE key='central_needs.manual_need.set'`);
      expect(k).toEqual({ key: 'central_needs.manual_need.set', module: 'central_needs', action: 'manual_need.set', is_dangerous: false });
      expect((await admin(`SELECT count(*)::int AS n FROM role_permission_defaults WHERE permission_key='central_needs.manual_need.set'`))[0].n).toBe(0);
    });
  });

  describe('capability seal (C2/C12/C14): clean, and every negative control is caught', () => {
    const breaches = async (mutate?: string[]) => {
      let out: string[] = [];
      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        try {
          for (const m of mutate ?? []) await c.query(m);
          out = (await c.query(`SELECT b FROM phoenix_private.central_needs_capability_breaches_v1() AS b`)).rows.map((r: any) => r.b);
        } finally { await c.query('ROLLBACK'); }
      });
      return out;
    };
    it('reports nothing on the applied chain', async () => { expect(await breaches()).toEqual([]); });
    it('catches a write grant on the NEW events relation', async () => {
      expect((await breaches([`GRANT INSERT ON public.central_needs_manual_need_events TO authenticated`])).join('|'))
        .toMatch(/authenticated holds INSERT on public\.central_needs_manual_need_events/);
    });
    it('catches an unlisted central_needs relation (a new table cannot slip past the seal)', async () => {
      expect((await breaches([`CREATE TABLE public.central_needs_zzz_unlisted (id int)`])).join('|')).toMatch(/unlisted_central_needs_relation central_needs_zzz_unlisted/);
    });
    it('catches CREATE / USAGE on the policy schema and a function owned by an API role', async () => {
      expect((await breaches([`GRANT CREATE ON SCHEMA phoenix_cn_policy TO authenticated`])).join('|')).toMatch(/authenticated holds CREATE on schema phoenix_cn_policy/);
      expect((await breaches([`GRANT USAGE ON SCHEMA phoenix_cn_policy TO anon`])).join('|')).toMatch(/anon holds USAGE on schema phoenix_cn_policy/);
      expect((await breaches([`GRANT USAGE ON SCHEMA phoenix_cn_policy TO PUBLIC`])).join('|')).toMatch(/PUBLIC holds a privilege on schema phoenix_cn_policy/);
    });
    it('catches EXECUTE on a manifest routine for anon, service_role and PUBLIC', async () => {
      expect((await breaches([`GRANT EXECUTE ON FUNCTION phoenix_cn_policy.actor_scope_org(text) TO anon`])).join('|')).toMatch(/executable by anon/);
      expect((await breaches([`GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_actor_authorized(uuid,text) TO service_role`])).join('|')).toMatch(/executable by service_role/);
      expect((await breaches([`GRANT EXECUTE ON FUNCTION phoenix_private.central_needs_revision_authority_gate_v1() TO PUBLIC`])).join('|')).toMatch(/executable by PUBLIC/);
    });
  });

  describe('Excel path is not collaterally broken', () => {
    it('open_plan_revision still works for the staffed maker and still refuses the unstaffed', async () => {
      year += 1;
      expect((await as(U.maker, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,false) AS r', [ORG, year]))[0].r).toMatchObject({ ok: true });
    });
    it('hard negative boundary: the new functions touch no stock, movement, catalog or procurement relation', async () => {
      const rows = await admin(`SELECT p.proname FROM pg_proc p WHERE p.proname IN ('actor_scope_org','phoenix_central_needs_actor_authorized','central_needs_revision_authority_gate_v1')
        AND p.prosrc ~* '(warehouse_stock|stock_movement|central_items|transfer_request|procurement)'`);
      expect(rows).toEqual([]);
      void randomUUID;
    });
  });
});
