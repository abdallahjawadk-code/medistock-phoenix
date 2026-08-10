import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const run = rigAvailable() ? describe : describe.skip;
const QR = 'public.get_public_qr_payload(text)';
const TARGETS = [
  'public.archive_entity(text,uuid,text)',
  'public.assign_profile_permissions(uuid,jsonb)',
  'public.assign_profile_role(uuid,text)',
  'public.get_effective_permissions(uuid)',
  'public.get_entity_purge_impact(text,uuid)',
  'public.get_scoped_inter_institution_alerts()',
  'public.phoenix_mark_password_changed()',
  'public.purge_entity_with_all_data(text,uuid,text)',
  'public.reset_profile_permissions(uuid)',
] as const;

run('174 · authenticated RPC surface hardening (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const canExecute = async (role: string, fn: string): Promise<boolean> => {
    const r = await rig.asAdmin((c: any) => c.query(
      `SELECT has_function_privilege($1, to_regprocedure($2), 'EXECUTE') AS ok`, [role, fn]));
    return r.rows[0].ok === true;
  };

  beforeAll(async () => { rig = await buildRig(); });
  afterAll(async () => { await rig?.end?.(); });

  it('closes anonymous execution on all nine exact overloads', async () => {
    for (const fn of TARGETS) expect(await canExecute('anon', fn), fn).toBe(false);
  });

  it('preserves authenticated execution on all nine exact overloads', async () => {
    for (const fn of TARGETS) expect(await canExecute('authenticated', fn), fn).toBe(true);
  });

  it('preserves service_role execution on all nine exact overloads', async () => {
    for (const fn of TARGETS) expect(await canExecute('service_role', fn), fn).toBe(true);
  });

  it('keeps every target SECURITY DEFINER with a stable definition object', async () => {
    for (const fn of TARGETS) {
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT p.prosecdef, pg_get_function_identity_arguments(p.oid) AS args,
                pg_get_function_result(p.oid) AS result, pg_get_functiondef(p.oid) AS def
           FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [fn]));
      expect(r.rows, fn).toHaveLength(1);
      expect(r.rows[0].prosecdef, fn).toBe(true);
      expect(typeof r.rows[0].def, fn).toBe('string');
      expect(r.rows[0].def.length, fn).toBeGreaterThan(20);
    }
  });

  it('executes representative read-only authenticated APIs at runtime', async () => {
    const permissions = await rig.asUser(rig.superAdminId, (c: any) => c.query(
      `SELECT public.get_effective_permissions($1) AS payload`, [rig.superAdminId]));
    expect(permissions.rows[0].payload?.ok).toBe(true);

    const alerts = await rig.asUser(rig.superAdminId, (c: any) => c.query(
      `SELECT count(*)::int AS n FROM public.get_scoped_inter_institution_alerts()`));
    expect(alerts.rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it('public QR remains anonymous and authenticated', async () => {
    expect(await canExecute('anon', QR)).toBe(true);
    expect(await canExecute('authenticated', QR)).toBe(true);
  });

  it('core authorization helpers remain authenticated and out of scope', async () => {
    for (const fn of [
      'public.phoenix_my_role()',
      'public.phoenix_my_org()',
      'public.phoenix_profile_has_permission(uuid,text)',
    ]) {
      expect(await canExecute('authenticated', fn), fn).toBe(true);
    }
  });
});
