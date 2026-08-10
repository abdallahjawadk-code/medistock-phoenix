import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const run = rigAvailable() ? describe : describe.skip;
const TARGETS = [
  'public.phoenix_profile_has_permission(uuid,text)',
  'public.phoenix_provenance_reconciliation()',
  'public.phoenix_warehouse_source_balances(uuid)',
] as const;

run('175 · read-helper anonymous surface hardening (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const canExecute = async (role: string, fn: string): Promise<boolean> => {
    const r = await rig.asAdmin((c: any) => c.query(
      `SELECT has_function_privilege($1, to_regprocedure($2), 'EXECUTE') AS ok`, [role, fn]));
    return r.rows[0].ok === true;
  };

  beforeAll(async () => { rig = await buildRig(); });
  afterAll(async () => { await rig?.end?.(); });

  it('closes anonymous execution on the exact three targets', async () => {
    for (const fn of TARGETS) expect(await canExecute('anon', fn), fn).toBe(false);
  });

  it('preserves authenticated and service_role execution on all targets', async () => {
    for (const fn of TARGETS) {
      expect(await canExecute('authenticated', fn), `${fn} authenticated`).toBe(true);
      expect(await canExecute('service_role', fn), `${fn} service_role`).toBe(true);
    }
  });

  it('preserves intended SECURITY DEFINER / INVOKER modes', async () => {
    const r = await rig.asAdmin((c: any) => c.query(`
      SELECT p.proname, p.prosecdef
      FROM pg_proc p
      WHERE p.oid IN (
        to_regprocedure('public.phoenix_profile_has_permission(uuid,text)'),
        to_regprocedure('public.phoenix_provenance_reconciliation()'),
        to_regprocedure('public.phoenix_warehouse_source_balances(uuid)')
      ) ORDER BY p.proname`));
    expect(r.rows).toEqual([
      { proname: 'phoenix_profile_has_permission', prosecdef: true },
      { proname: 'phoenix_provenance_reconciliation', prosecdef: false },
      { proname: 'phoenix_warehouse_source_balances', prosecdef: false },
    ]);
  });

  it('executes the permission helper as a real authenticated user', async () => {
    const r = await rig.asUser(rig.superAdminId, (c: any) => c.query(
      `SELECT public.phoenix_profile_has_permission($1,'users.view') AS allowed`,
      [rig.superAdminId]));
    expect(typeof r.rows[0].allowed).toBe('boolean');
  });

  it('executes the two read helpers as an authenticated super admin', async () => {
    const balances = await rig.asUser(rig.superAdminId, (c: any) => c.query(
      `SELECT * FROM public.phoenix_warehouse_source_balances($1::uuid)`,
      ['00000000-0000-0000-0000-000000000001']));
    expect(Array.isArray(balances.rows)).toBe(true);

    const reconciliation = await rig.asUser(rig.superAdminId, (c: any) => c.query(
      `SELECT * FROM public.phoenix_provenance_reconciliation()`));
    expect(Array.isArray(reconciliation.rows)).toBe(true);
  });

  it('preserves anonymous public QR', async () => {
    expect(await canExecute('anon', 'public.get_public_qr_payload(text)')).toBe(true);
    expect(await canExecute('authenticated', 'public.get_public_qr_payload(text)')).toBe(true);
  });

  it('leaves identity helpers and trigger functions out of this wave', async () => {
    for (const fn of [
      'public.phoenix_my_role()',
      'public.phoenix_my_org()',
      'public.phoenix_guard_dp_archive_update()',
      'public.phoenix_handle_new_user()',
      'public.phoenix_populate_actor_snapshot()',
      'public.phoenix_set_updated_at()',
    ]) expect(await canExecute('anon', fn), fn).toBe(true);
  });
});
