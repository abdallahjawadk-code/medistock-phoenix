/**
 * CROSS-ORG-IDOR-148-FIX — DYNAMIC regression coverage against a real
 * disposable Postgres with 001->148 applied in order.
 *
 * phoenix_upsert_inventory_suggestion_policy previously authorized on the
 * UNSCOPED phoenix_profile_has_permission(v_actor, 'inventory.manage_thresholds')
 * check alone — any actor holding that permission key anywhere could rewrite
 * ANY organization's staleness policy by supplying an arbitrary
 * p_organization_id (cross-organization IDOR). The fix routes authorization
 * through phoenix_profile_has_scoped_permission (091), which enforces active
 * status, a super_admin bypass, and p_organization_id matching the actor's
 * OWN organization — plus the same central_warehouse_manager org-default
 * carve-out 092's phoenix_upsert_inventory_threshold already uses, since
 * phoenix_profile_has_scoped_permission's v_org_wide_roles is
 * ['institution_admin'] only and 092 narrowed inventory.manage_thresholds to
 * central_warehouse_manager alone.
 *
 * Proves, against a real database:
 *   1. An active, authorized central_warehouse_manager can update its OWN
 *      organization's policy.
 *   2. The SAME actor is refused when targeting a DIFFERENT organization,
 *      and that other organization's existing row is left byte-for-byte
 *      unchanged.
 *   3. A suspended account is refused even though its role/permission would
 *      otherwise qualify, and nothing is written.
 *   4. A role without inventory.manage_thresholds is refused.
 *   5. An active super_admin works per current policy (any organization).
 *   6. Both anon (no EXECUTE grant) and an authenticated call with no
 *      resolvable actor (auth.uid() null) are refused.
 *   7. A syntactically valid but non-existent organization UUID is refused.
 *   8. Every rejection above leaves the target row's state exactly as it was
 *      (no row created for a nonexistent org, no row weakened for an actor's
 *      un-owned org).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database) — mirrors every other
 * *.dynamic.test.ts in this directory.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

// PRE-EXISTING INFRASTRUCTURE FIX (surfaced by the R1.2C run, not caused by it).
// This suite REPLAYS THE MIGRATION CHAIN inside a beforeAll. vitest applies a
// separate 10s budget to HOOKS, which no testTimeout covers, so as the chain has
// grown the hook has crept toward that ceiling; past it, the hook is killed
// mid-replay and surfaces as ECONNRESET rather than as any assertion. An explicit
// hook budget removes that false signal. No assertion is changed or relaxed.
vi.setConfig({ hookTimeout: 240000 });

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-000000148501'; // CWM_A's own organization
const ORG_B = '00000000-0000-0000-0000-000000148502'; // a different organization
const ORG_NONEXISTENT = '00000000-0000-0000-0000-000000148eee'; // valid uuid, no row

const CWM_A = '00000000-0000-0000-0000-000000148601'; // central_warehouse_manager, ORG_A, active
const CWM_A_SUSPENDED = '00000000-0000-0000-0000-000000148602'; // same role/org, suspended
const NO_PERM = '00000000-0000-0000-0000-000000148603'; // outlet_officer, ORG_A, active, no permission

type Rig = Awaited<ReturnType<typeof buildRig>>;

run('CROSS-ORG-IDOR-148-FIX — phoenix_upsert_inventory_suggestion_policy is organization-scoped', () => {
  let rig: Rig;
  let ROOT: string;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 149 });
    ROOT = rig.superAdminId;

    await rig.asAdmin(async (c) => {
      await c.query(
        `insert into public.organizations (id, name, name_ar, code, status) values
           ($1, 'Policy Org A', 'مؤسسة أ', 'pol-148-a', 'active'),
           ($2, 'Policy Org B', 'مؤسسة ب', 'pol-148-b', 'active')
         on conflict (id) do nothing`,
        [ORG_A, ORG_B],
      );

      async function seedProfile(id: string, email: string, fullName: string, role: string, orgId: string, status: string) {
        await c.query(
          `insert into auth.users (id, email, raw_user_meta_data)
           values ($1, $2, jsonb_build_object('full_name', $3::text, 'role', $4::text))
           on conflict (id) do nothing`,
          [id, email, fullName, role],
        );
        await c.query(
          `update public.profiles
           set organization_id = $2, role = $3, status = $4, full_name = $5
           where id = $1`,
          [id, orgId, role, status, fullName],
        );
      }

      await seedProfile(CWM_A, 'cwm-a-148@rig.local', 'CWM Org A', 'central_warehouse_manager', ORG_A, 'active');
      await seedProfile(CWM_A_SUSPENDED, 'cwm-a-susp-148@rig.local', 'Suspended CWM', 'central_warehouse_manager', ORG_A, 'suspended');
      await seedProfile(NO_PERM, 'no-perm-148@rig.local', 'No Perm Officer', 'outlet_officer', ORG_A, 'active');

      // Belt-and-suspenders: force the no-permission actor's key false
      // regardless of role_permission_defaults drift elsewhere.
      await c.query(
        `insert into public.profile_permission_overrides (profile_id, permission_key, allowed)
         values ($1, 'inventory.manage_thresholds', false)
         on conflict (profile_id, permission_key) do update set allowed = excluded.allowed`,
        [NO_PERM],
      );

      // A pre-existing baseline row for ORG_B, so the cross-org attempt (test
      // 2) has real state to prove untouched, not merely "no row".
      await c.query(
        `insert into public.inventory_suggestion_policy (organization_id, staleness_minutes, updated_by, updated_at)
         values ($1, 45, $2, now())
         on conflict (organization_id) do nothing`,
        [ORG_B, ROOT],
      );
    });
  }, 300_000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  async function upsertPolicy(actorId: string | null, orgId: string, minutes: number, opts: { role?: 'authenticated' | 'anon'; commit?: boolean } = {}) {
    return rig.asUser(actorId, async (c) => {
      const r = await c.query(
        `select public.phoenix_upsert_inventory_suggestion_policy($1, $2) result`,
        [orgId, minutes],
      );
      return r.rows[0].result;
    }, { role: opts.role ?? 'authenticated', commit: opts.commit ?? true });
  }

  async function policyRow(orgId: string) {
    return rig.asAdmin(async (c) => {
      const r = await c.query(
        `select staleness_minutes, updated_by from public.inventory_suggestion_policy where organization_id = $1`,
        [orgId],
      );
      return r.rows[0] ?? null;
    });
  }

  it('1. an active, authorized central_warehouse_manager can update its OWN organization policy', async () => {
    const result = await upsertPolicy(CWM_A, ORG_A, 60);
    expect(result.ok).toBe(true);
    expect(result.organization_id).toBe(ORG_A);
    expect(result.staleness_minutes).toBe(60);

    const row = await policyRow(ORG_A);
    expect(row.staleness_minutes).toBe(60);
    expect(row.updated_by).toBe(CWM_A);
  });

  it('2. the SAME actor is refused when targeting a DIFFERENT organization, and ORG_B is left untouched', async () => {
    await expect(
      upsertPolicy(CWM_A, ORG_B, 99, { commit: true }),
    ).rejects.toThrow(/not_authorized_inventory_manage_thresholds/);

    const row = await policyRow(ORG_B);
    expect(row.staleness_minutes).toBe(45); // the seeded baseline, unchanged
    expect(row.updated_by).toBe(ROOT);
  });

  it('3. a suspended account is refused even though role + permission would otherwise qualify', async () => {
    await expect(
      upsertPolicy(CWM_A_SUSPENDED, ORG_A, 77, { commit: true }),
    ).rejects.toThrow(/not_authorized_inventory_manage_thresholds/);

    // ORG_A must still show test 1's value, not 77.
    const row = await policyRow(ORG_A);
    expect(row.staleness_minutes).toBe(60);
  });

  it('4. a role without inventory.manage_thresholds is refused', async () => {
    await expect(
      upsertPolicy(NO_PERM, ORG_A, 88, { commit: true }),
    ).rejects.toThrow(/not_authorized_inventory_manage_thresholds/);

    const row = await policyRow(ORG_A);
    expect(row.staleness_minutes).toBe(60);
  });

  it('5. an active super_admin works per current policy, for any organization', async () => {
    const result = await upsertPolicy(ROOT, ORG_A, 120);
    expect(result.ok).toBe(true);
    expect(result.staleness_minutes).toBe(120);

    const row = await policyRow(ORG_A);
    expect(row.staleness_minutes).toBe(120);
    expect(row.updated_by).toBe(ROOT);
  });

  it('6a. anon (no EXECUTE grant) is refused', async () => {
    await expect(
      upsertPolicy(null, ORG_A, 15, { role: 'anon', commit: true }),
    ).rejects.toThrow();

    const row = await policyRow(ORG_A);
    expect(row.staleness_minutes).toBe(120); // unchanged from test 5
  });

  it('6b. an authenticated call with no resolvable actor (auth.uid() null) is refused', async () => {
    await expect(
      upsertPolicy(null, ORG_A, 16, { role: 'authenticated', commit: true }),
    ).rejects.toThrow(/not_authenticated/);

    const row = await policyRow(ORG_A);
    expect(row.staleness_minutes).toBe(120);
  });

  it('7. a syntactically valid but non-existent organization uuid is refused, and creates no row', async () => {
    await expect(
      upsertPolicy(ROOT, ORG_NONEXISTENT, 30, { commit: true }),
    ).rejects.toThrow(/organization_not_found/);

    const row = await policyRow(ORG_NONEXISTENT);
    expect(row).toBeNull();
  });

  it('8. final state across every rejection case is exactly what the authorized writes left behind', async () => {
    const a = await policyRow(ORG_A);
    expect(a).toEqual({ staleness_minutes: 120, updated_by: ROOT });

    const b = await policyRow(ORG_B);
    expect(b).toEqual({ staleness_minutes: 45, updated_by: ROOT });

    const none = await policyRow(ORG_NONEXISTENT);
    expect(none).toBeNull();
  });
});
