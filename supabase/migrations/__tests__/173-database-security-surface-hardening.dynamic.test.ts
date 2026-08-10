/**
 * 173 · DATABASE SECURITY SURFACE HARDENING — dynamic proof.
 *
 * Replays the full effective migration chain onto a disposable Postgres and
 * then asks the database itself the only questions that matter: who can still
 * execute the identity snapshot, is the function otherwise untouched, and is
 * public QR still anonymous.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const run = rigAvailable() ? describe : describe.skip;

const TARGET = 'public.get_profile_identity_snapshot(uuid)';
const QR = 'public.get_public_qr_payload(text)';

run('173 · database security surface hardening (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const canExecute = async (role: string, fn: string): Promise<boolean> => {
    const r = await rig.asAdmin((c: any) => c.query(
      `SELECT has_function_privilege($1, to_regprocedure($2), 'EXECUTE') AS ok`, [role, fn]));
    return r.rows[0].ok === true;
  };

  beforeAll(async () => { rig = await buildRig(); });
  afterAll(async () => { await rig?.end?.(); });

  describe('C1 is closed', () => {
    it('anon can NO LONGER execute the identity snapshot', async () => {
      expect(await canExecute('anon', TARGET)).toBe(false);
    });

    it('authenticated can NO LONGER execute the identity snapshot', async () => {
      // anon inherits PUBLIC, so the assertion above already proves the
      // PUBLIC grant is gone; this proves 013's explicit grant is gone too.
      expect(await canExecute('authenticated', TARGET)).toBe(false);
    });

    it('a real authenticated caller is refused at runtime, not merely un-granted', async () => {
      // The privilege check is the contract, but prove the door is actually
      // shut: an authenticated session calling it must raise, including for
      // its OWN profile — the function has no legitimate caller at all.
      let message = '';
      try {
        await rig.asUser(rig.superAdminId, (c: any) => c.query(
          `SELECT * FROM public.get_profile_identity_snapshot($1)`, [rig.superAdminId]));
      } catch (e: any) {
        message = String(e?.message ?? e);
      }
      expect(message).toMatch(/permission denied|has no privileges|not exist/i);
    });
  });

  describe('the function object itself is untouched', () => {
    it('still exists, still SECURITY DEFINER, still on its hardened search_path', async () => {
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT p.prosecdef, p.proconfig, pg_get_function_result(p.oid) AS ret,
                pg_get_function_identity_arguments(p.oid) AS args
           FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [TARGET]));
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].prosecdef).toBe(true);
      expect(r.rows[0].proconfig).toContain('search_path=public, pg_temp');
      // pg_get_function_identity_arguments renders NAME + TYPE, so this pins
      // 013/064's exact parameter as well as its type.
      expect(r.rows[0].args).toBe('p_profile_id uuid');
      // 013/064's return contract, unchanged.
      for (const col of ['identity_version', 'full_name', 'email', 'role', 'organization_id']) {
        expect(r.rows[0].ret).toContain(col);
      }
    });

    it('the definer role can still execute it — only client reach was removed', async () => {
      // Hardening must not orphan the object. The owner/definer path is
      // intact, so a future authorized caller (or a service-role task) is
      // still possible without recreating the function.
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM public.get_profile_identity_snapshot($1)`,
        [rig.superAdminId]));
      expect(r.rows[0].n).toBeGreaterThanOrEqual(0);
    });
  });

  describe('public QR remains anonymous', () => {
    it('anon still executes the public QR payload', async () => {
      expect(await canExecute('anon', QR)).toBe(true);
    });

    it('authenticated still executes the public QR payload', async () => {
      expect(await canExecute('authenticated', QR)).toBe(true);
    });
  });

  describe('no collateral ACL damage', () => {
    it('the authorization helpers the platform depends on are still reachable', async () => {
      // 173 named exactly one overload. These are the neighbours whose loss
      // would break RLS and every RPC, so prove they were not caught by it.
      for (const fn of ['public.phoenix_my_role()', 'public.phoenix_my_org()']) {
        const exists = await rig.asAdmin((c: any) => c.query(
          `SELECT to_regprocedure($1) IS NOT NULL AS ok`, [fn]));
        if (exists.rows[0].ok) {
          expect(await canExecute('authenticated', fn)).toBe(true);
        }
      }
    });
  });
});
