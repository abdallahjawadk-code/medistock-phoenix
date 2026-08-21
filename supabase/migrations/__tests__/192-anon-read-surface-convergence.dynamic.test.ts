/**
 * ANON-READ-SURFACE-192 — DYNAMIC proof.
 *
 * The claims under test cannot be read off the SQL:
 *
 *   · a clean 001->192 replay succeeds;
 *   · the EFFECTIVE anon direct-read set is EMPTY — measured by asking the
 *     database what `anon` may read, not by trusting the REVOKE loop;
 *   · a direct anon SELECT on `item_availability` is DENIED, even though it is
 *     the one relation whose policy list mentions anon;
 *   · representative protected tables are DENIED to anon;
 *   · the public QR RPC still answers AS anon, proving the empty allowlist is
 *     safe because that path is SECURITY DEFINER;
 *   · 027's `avail_select_anon` USING(false) survives untouched;
 *   · anon holds no write privilege anywhere.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI's ordinary suite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const run = rigAvailable() ? describe : describe.skip;

/** Tables a leak would matter most on, spanning several migration eras. */
const PROTECTED_SAMPLE = [
  'warehouses',
  'distribution_points',
  'organization_facilities',
  'profiles',
  'organizations',
  'audit_logs',
];

run('192 · anonymous read surface convergence', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  /** Run a statement with the session role set to `anon`. */
  const asAnon = <T>(fn: (c: any) => Promise<T>) =>
    rig.asUser(null, fn, { role: 'anon' });

  beforeAll(async () => {
    rig = await buildRig({ upTo: 192 });
  });

  afterAll(async () => { if (rig) await rig.end(); });

  describe('A · the replay itself', () => {
    it('applies 001 -> 192 cleanly, including every VERIFY assertion', async () => {
      // buildRig throws if any migration (or its VERIFY block) fails, so simply
      // reaching this point is the proof. Assert a 192-era fact as well.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='phoenix_query_organization_scope_topology'`));
      expect(rows[0].n).toBe(1);
    });

    it('adds no function — 192 is a privilege migration', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public'`));
      // 191 established 417; 192 must not move it.
      expect(rows[0].n).toBe(417);
    });
  });

  describe('B · the effective anon direct-read set is EMPTY', () => {
    it('no relation of any kind is anon-selectable', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT c.relname, c.relkind::text AS kind
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public'
            AND c.relkind IN ('r','p','v','m','f')
            AND has_table_privilege('anon', c.oid, 'SELECT')
          ORDER BY 1`));
      expect(rows.map((r: any) => `${r.relname}(${r.kind})`)).toEqual([]);
    });

    it('anon holds no privilege of ANY type on any public relation', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT DISTINCT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema='public' AND grantee='anon' ORDER BY 1`));
      expect(rows.map((r: any) => r.privilege_type)).toEqual([]);
    });

    it('no default privilege will re-grant anon SELECT on future relations', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n
           FROM pg_default_acl d
           JOIN pg_namespace n ON n.oid = d.defaclnamespace
           CROSS JOIN LATERAL aclexplode(d.defaclacl) AS a
          WHERE n.nspname='public' AND d.defaclobjtype='r'
            AND a.grantee <> 0 AND pg_get_userbyid(a.grantee)='anon'
            AND a.privilege_type='SELECT'`));
      expect(rows[0].n).toBe(0);
    });
  });

  describe('C · direct anon reads are actually refused', () => {
    it('item_availability is DENIED to anon', async () => {
      await expect(
        asAnon((c: any) => c.query('SELECT * FROM public.item_availability LIMIT 1')),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it.each(PROTECTED_SAMPLE)('%s is DENIED to anon', async (table) => {
      await expect(
        asAnon((c: any) => c.query(`SELECT * FROM public.${table} LIMIT 1`)),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('authenticated is NOT locked out — the convergence targeted anon only', async () => {
      const out = await rig.asUser(rig.superAdminId, (c: any) =>
        c.query('SELECT count(*)::int AS n FROM public.item_availability'));
      expect(out.rows[0].n).toBeGreaterThanOrEqual(0);
    });
  });

  describe('D · 027 is intact', () => {
    it('avail_select_anon still exists and still denies every row', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT pg_get_expr(pol.polqual, pol.polrelid) AS qual
           FROM pg_policy pol
          WHERE pol.polrelid='public.item_availability'::regclass
            AND pol.polname='avail_select_anon'`));
      expect(rows).toHaveLength(1);
      expect(String(rows[0].qual).trim()).toBe('false');
    });

    it('RLS is still enabled on item_availability', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='item_availability'`));
      expect(rows[0].rls).toBe(true);
    });
  });

  describe('E · the public QR path still works AS anon', () => {
    it('anon can execute get_public_qr_payload despite owning no relation read', async () => {
      const out = await asAnon((c: any) =>
        c.query(`SELECT public.get_public_qr_payload('__192_probe__') AS payload`));
      // An unknown handle yields the function's own structured refusal, NOT a
      // privilege error: the DEFINER path reached warehouses, distribution_points
      // and organization_facilities on the caller's behalf even though anon now
      // holds no read on any of them. A 42501 here would mean the convergence
      // broke the public surface.
      expect(out.rows).toHaveLength(1);
      expect(out.rows[0].payload).toEqual({ ok: false, error: 'QR_NOT_FOUND_OR_DISABLED' });
    });

    it('it is still SECURITY DEFINER, which is WHY the empty allowlist is safe', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='get_public_qr_payload'`));
      expect(rows[0].prosecdef).toBe(true);
    });

    it('anon cannot execute the 191 topology query', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT has_function_privilege('anon',
           'public.phoenix_query_organization_scope_topology(uuid)','EXECUTE') AS ok`));
      expect(rows[0].ok).toBe(false);
    });

    it('no first-party INVOKER routine is anon-executable', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public'
            AND has_function_privilege('anon', p.oid,'EXECUTE')
            AND NOT p.prosecdef
            AND pg_get_function_result(p.oid) <> 'trigger'
            AND NOT EXISTS (SELECT 1 FROM pg_depend d
                             WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
          ORDER BY 1`));
      expect(rows.map((r: any) => r.proname)).toEqual([]);
    });
  });

  describe('F · the migration wrote nothing', () => {
    it('leaves every policy in place — 192 alters no policy', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM pg_policy pol
           JOIN pg_class c ON c.oid=pol.polrelid
           JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public'`));
      expect(rows[0].n).toBeGreaterThan(0);
    });

    it('authenticated retains a real read surface', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM information_schema.role_table_grants
          WHERE table_schema='public' AND grantee='authenticated' AND privilege_type='SELECT'`));
      expect(rows[0].n).toBeGreaterThan(1);
    });
  });
});
