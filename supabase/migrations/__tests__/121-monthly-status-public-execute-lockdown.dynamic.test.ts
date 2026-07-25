/**
 * MONTHLY-STATUS-PUBLIC-EXECUTE-LOCKDOWN — DYNAMIC proof for migration 121,
 * against a real disposable Postgres with 001->121 applied in order.
 *
 * 113 intended to revoke PUBLIC/anon EXECUTE on the eleven monthly-status
 * RPCs but never carried it out live (its own precondition guard was a false
 * positive — see 121's header comment). 121 closes that gap additively.
 * Proves: anon has no EXECUTE on any of the eleven; authenticated keeps it.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const PROTECTED_FUNCTIONS = [
  'phoenix_status_center_authorized(uuid,text)',
  'phoenix_set_inventory_threshold_planning(uuid,integer,integer)',
  'phoenix_status_record_stocktake(uuid,text,uuid,text,jsonb)',
  'phoenix_status_prepare_report(uuid)',
  'phoenix_status_classify_lines(uuid,jsonb)',
  'phoenix_status_confirm_missing(uuid)',
  'phoenix_status_submit_report(uuid)',
  'phoenix_status_return_for_clarification(uuid,text)',
  'phoenix_status_approve_lock_report(uuid)',
  'phoenix_status_create_amendment(uuid,text)',
  'phoenix_status_get_outlet_contribution(uuid,uuid)',
];

run('121 monthly-status PUBLIC/anon EXECUTE lockdown — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 121 });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it.each(PROTECTED_FUNCTIONS)('anon has NO execute on %s', async (sig) => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS ok`,
        [`public.${sig}`],
      );
      expect(r.rows[0].ok).toBe(false);
    });
  });

  it.each(PROTECTED_FUNCTIONS)('authenticated KEEPS execute on %s', async (sig) => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS ok`,
        [`public.${sig}`],
      );
      expect(r.rows[0].ok).toBe(true);
    });
  });

  // service_role is NOT asserted here: none of these migrations ever GRANT to
  // it explicitly (verified by source search — 092 only grants to
  // authenticated), and real Supabase provisions service_role's broad access
  // at the platform level, outside user migrations. The disposable rig's
  // bootstrap does not replicate that platform default, so it cannot validly
  // test this. Verified directly instead against the live remote schema dump
  // before and after applying 121: service_role held `GRANT ALL` on all
  // eleven functions beforehand, and 121 never touches service_role, so it
  // is provably unchanged.
});
