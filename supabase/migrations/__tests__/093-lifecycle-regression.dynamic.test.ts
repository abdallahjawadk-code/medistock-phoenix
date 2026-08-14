// =============================================================================
// Dynamic regression coverage for the migration-093 atomic account-lifecycle
// contract (phoenix_lifecycle_reserve/_commit/_compensate/_enable/
// _authorize_rotation/_note_delete/_recycle_apply), driven against a real
// disposable Postgres rig — not source-scan.
//
// admin-user-lifecycle and admin-recycle-user (the Edge Functions that call
// these RPCs) run in the Deno runtime and are covered by static contract
// tests (admin-user-lifecycle-secure-contract.test.ts). What genuinely needs
// a live database to prove — the atomic invariant, the persisted state
// transitions, and the compensation path — is exercised here.
//
// Out of scope for a pure-Postgres rig (no Supabase Auth/GoTrue running):
// actually banning/unbanning a session, verifying an old password stops
// working, and verifying a new password logs in. Those are Auth-service
// behaviors the Edge Function delegates to `admin.auth.admin.*` and are
// covered by the Edge Function's static contract tests instead.
// =============================================================================
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

const ORG_A = '09300000-0000-4000-8000-00000000000a';
const ORG_B = '09300000-0000-4000-8000-00000000000b';

const SECOND_SUPER = '09300000-0000-4000-8000-000000000002';
const INST_ADMIN = '09300000-0000-4000-8000-000000000003';

const TARGET_A = '09300000-0000-4000-8000-000000000010';
const TARGET_CROSS = '09300000-0000-4000-8000-000000000011';
const TARGET_FRESH_DELETE = '09300000-0000-4000-8000-000000000012';
const TARGET_FOR_RECYCLE = '09300000-0000-4000-8000-000000000013';

type Rig = Awaited<ReturnType<typeof buildRig>>;

run('migration 093 — account-lifecycle contract regression (SECURE-USER-LIFECYCLE-PRODUCTION-A)', () => {
  let rig: Rig;
  let ROOT: string;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 146 });
    ROOT = rig.superAdminId;

    await rig.asAdmin(async (c) => {
      await c.query(
        `insert into public.organizations (id, name, name_ar, code, status)
         values ($1, 'Lifecycle Org A', 'مؤسسة أ', 'life-093-a', 'active'),
                ($2, 'Lifecycle Org B', 'مؤسسة ب', 'life-093-b', 'active')
         on conflict (id) do nothing`,
        [ORG_A, ORG_B],
      );

      async function seedProfile(id: string, email: string, fullName: string, role: string, orgId: string) {
        await c.query(
          `insert into auth.users (id, email, raw_user_meta_data)
           values ($1, $2, jsonb_build_object('full_name', $3::text, 'role', $4::text))
           on conflict (id) do nothing`,
          [id, email, fullName, role],
        );
        await c.query(
          `update public.profiles
           set organization_id = $2, role = $3, status = 'active', full_name = $4
           where id = $1`,
          [id, orgId, role, fullName],
        );
      }

      await seedProfile(SECOND_SUPER, 'second-super-093@rig.local', 'Second Super', 'super_admin', ORG_A);
      await seedProfile(INST_ADMIN, 'inst-admin-093@rig.local', 'Institution Admin', 'institution_admin', ORG_A);
      await seedProfile(TARGET_A, 'target-a-093@rig.local', 'Target A', 'outlet_officer', ORG_A);
      await seedProfile(TARGET_CROSS, 'target-cross-093@rig.local', 'Target Cross', 'outlet_officer', ORG_B);
      await seedProfile(TARGET_FRESH_DELETE, 'target-fresh-093@rig.local', 'Target Fresh', 'outlet_officer', ORG_A);
      await seedProfile(TARGET_FOR_RECYCLE, 'target-recycle-093@rig.local', 'Target Recycle', 'outlet_officer', ORG_A);

      for (const key of ['users.disable', 'users.recycle']) {
        await c.query(
          `insert into public.profile_permission_overrides (profile_id, permission_key, allowed, created_by)
           values ($1, $2, true, $1)
           on conflict (profile_id, permission_key) do update set allowed = true`,
          [INST_ADMIN, key],
        );
      }
    });
  }, 300_000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  async function reserve(actorId: string, targetId: string, action: 'disable' | 'delete', commit = true) {
    return rig.asUser(
      actorId,
      async (c) => {
        const r = await c.query(
          `select public.phoenix_lifecycle_reserve($1,$2,$3) result`,
          [targetId, action, crypto.randomUUID()],
        );
        return r.rows[0].result;
      },
      { commit },
    );
  }

  async function commitLifecycle(actorId: string, targetId: string, commit = true) {
    return rig.asUser(
      actorId,
      async (c) => {
        const r = await c.query(
          `select public.phoenix_lifecycle_commit($1,$2) result`,
          [targetId, crypto.randomUUID()],
        );
        return r.rows[0].result;
      },
      { commit },
    );
  }

  async function compensate(actorId: string, targetId: string, commit = true) {
    return rig.asUser(
      actorId,
      async (c) => {
        const r = await c.query(
          `select public.phoenix_lifecycle_compensate($1,$2) result`,
          [targetId, crypto.randomUUID()],
        );
        return r.rows[0].result;
      },
      { commit },
    );
  }

  async function enable(actorId: string, targetId: string, commit = true) {
    return rig.asUser(
      actorId,
      async (c) => {
        const r = await c.query(
          `select public.phoenix_lifecycle_enable($1,$2) result`,
          [targetId, crypto.randomUUID()],
        );
        return r.rows[0].result;
      },
      { commit },
    );
  }

  async function authorizeRotation(actorId: string, targetId: string, commit = true) {
    return rig.asUser(
      actorId,
      async (c) => {
        const r = await c.query(
          `select public.phoenix_lifecycle_authorize_rotation($1,$2) result`,
          [targetId, crypto.randomUUID()],
        );
        return r.rows[0].result;
      },
      { commit },
    );
  }

  async function noteDelete(actorId: string, targetId: string, targetRole: string, commit = true) {
    return rig.asUser(
      actorId,
      async (c) => {
        const r = await c.query(
          `select public.phoenix_lifecycle_note_delete($1,$2,$3) result`,
          [targetId, targetRole, crypto.randomUUID()],
        );
        return r.rows[0].result;
      },
      { commit },
    );
  }

  async function profileRow(id: string) {
    return rig.asAdmin(async (c) => {
      const r = await c.query(
        `select status, disabled_at, disabled_by, must_change_password, role, organization_id
         from public.profiles where id = $1`,
        [id],
      );
      return r.rows[0] ?? null;
    });
  }

  // ── 1 + 3: create (fixture) → disable → re-enable ──────────────────────────
  it('an active user can be disabled (reserved + committed) then re-enabled', async () => {
    const rv = await reserve(ROOT, TARGET_A, 'disable');
    expect(rv.ok).toBe(true);

    let row = await profileRow(TARGET_A);
    expect(row.status).toBe('suspended');
    expect(row.disabled_at).not.toBeNull();
    expect(row.disabled_by).toBe(ROOT);

    const cm = await commitLifecycle(ROOT, TARGET_A);
    expect(cm.ok).toBe(true);
    expect(cm.action).toBe('disabled');

    row = await profileRow(TARGET_A);
    expect(row.status).toBe('suspended');

    const en = await enable(ROOT, TARGET_A);
    expect(en.ok).toBe(true);

    row = await profileRow(TARGET_A);
    expect(row.status).toBe('active');
    expect(row.disabled_at).toBeNull();
    expect(row.disabled_by).toBeNull();
  });

  // ── 4: password rotation forces must_change_password ────────────────────────
  it('authorizing a password rotation forces must_change_password on the target', async () => {
    const az = await authorizeRotation(ROOT, TARGET_A);
    expect(az.ok).toBe(true);

    const row = await profileRow(TARGET_A);
    expect(row.must_change_password).toBe(true);
  });

  // ── 5: disable then recycle, permissions/role stay within the granted contract ──
  it('recycling is rejected while active, then succeeds once suspended, and bumps identity_version', async () => {
    const rejectedWhileActive = await rig.asUser(ROOT, async (c) => {
      const r = await c.query(
        `select public.phoenix_recycle_apply(
           $1,'Recycled Name','warehouse_officer',$2,'local','recycled.user',null,
           'recycled@local.medistock.invalid',null,$3
         ) result`,
        [TARGET_FOR_RECYCLE, ORG_A, crypto.randomUUID()],
      );
      return r.rows[0].result;
    }, { commit: false });
    expect(rejectedWhileActive.ok).toBe(false);
    expect(rejectedWhileActive.error).toBe('TARGET_NOT_SUSPENDED');

    const rv = await reserve(ROOT, TARGET_FOR_RECYCLE, 'disable');
    expect(rv.ok).toBe(true);
    await commitLifecycle(ROOT, TARGET_FOR_RECYCLE);

    const applied = await rig.asUser(ROOT, async (c) => {
      const r = await c.query(
        `select public.phoenix_recycle_apply(
           $1,'Recycled Name','warehouse_officer',$2,'local','recycled.user',null,
           'recycled@local.medistock.invalid',null,$3
         ) result`,
        [TARGET_FOR_RECYCLE, ORG_A, crypto.randomUUID()],
      );
      return r.rows[0].result;
    }, { commit: true });
    expect(applied.ok).toBe(true);
    expect(applied.new_identity_version).toBe(2);

    const row = await profileRow(TARGET_FOR_RECYCLE);
    expect(row.status).toBe('active');
    expect(row.role).toBe('warehouse_officer');
  });

  // ── 6: delete a fresh, never-used account — gone from auth.users AND profiles ──
  it('deleting an account removes it from both auth.users and profiles, and note_delete audits it', async () => {
    const rv = await reserve(ROOT, TARGET_FRESH_DELETE, 'delete');
    expect(rv.ok).toBe(true);
    expect(rv.target_role).toBe('outlet_officer');

    let row = await profileRow(TARGET_FRESH_DELETE);
    expect(row.status).toBe('suspended');

    // The Edge Function's confirmation check + the actual Auth Admin delete
    // are its own layer (see admin-user-lifecycle-secure-contract.test.ts);
    // here we model exactly what that Auth Admin delete does at the DB level
    // — remove the auth.users row, which cascades to profiles.
    await rig.asAdmin((c) => c.query('delete from auth.users where id = $1', [TARGET_FRESH_DELETE]));

    row = await profileRow(TARGET_FRESH_DELETE);
    expect(row).toBeNull();

    const nd = await noteDelete(ROOT, TARGET_FRESH_DELETE, rv.target_role);
    expect(nd.ok).toBe(true);
    expect(nd.action).toBe('deleted');

    const audit = await rig.asAdmin(async (c) => {
      const r = await c.query(
        `select action, payload from public.audit_logs
         where entity_id = $1 and action = 'user.deleted'
         order by created_at desc limit 1`,
        [TARGET_FRESH_DELETE],
      );
      return r.rows[0];
    });
    expect(audit).toBeDefined();
    expect(audit.payload.target_role).toBe('outlet_officer');

    // The reservation row cascades away with the deleted profile — no
    // dangling in-flight lifecycle state survives a completed hard delete.
    const reservation = await rig.asAdmin(async (c) => {
      const r = await c.query(
        `select 1 from public.profile_lifecycle_reservations where profile_id = $1`,
        [TARGET_FRESH_DELETE],
      );
      return r.rows[0];
    });
    expect(reservation).toBeUndefined();
  });

  // ── 7: self-action is denied for every mutating lifecycle RPC ───────────────
  it('rejects self-action on disable, enable, delete, and rotate authorization', async () => {
    const selfDisable = await reserve(SECOND_SUPER, SECOND_SUPER, 'disable', false);
    expect(selfDisable.ok).toBe(false);
    expect(selfDisable.error).toBe('REQUEST_DENIED');

    const selfDelete = await reserve(SECOND_SUPER, SECOND_SUPER, 'delete', false);
    expect(selfDelete.ok).toBe(false);
    expect(selfDelete.error).toBe('REQUEST_DENIED');

    const selfEnable = await enable(SECOND_SUPER, SECOND_SUPER, false);
    expect(selfEnable.ok).toBe(false);
    expect(selfEnable.error).toBe('REQUEST_DENIED');

    const selfRotate = await authorizeRotation(SECOND_SUPER, SECOND_SUPER, false);
    expect(selfRotate.ok).toBe(false);
    expect(selfRotate.error).toBe('REQUEST_DENIED');
  });

  // ── 8: last-active-super_admin protection ────────────────────────────────────
  it('a super_admin acting on a different active super_admin is allowed while 2+ remain active (no over-blocking)', async () => {
    const rv = await reserve(ROOT, SECOND_SUPER, 'disable', false);
    expect(rv.ok).toBe(true);
  });

  it('the sole remaining active super_admin cannot remove their own account (self-protection holds)', async () => {
    // With SECOND_SUPER now the only other super_admin, disabling them for
    // real (commit) leaves ROOT as the sole active super_admin. ROOT can
    // never self-disable/self-delete — the platform can never be left with
    // zero managers via this account, whichever guard code fires.
    const rv = await reserve(ROOT, SECOND_SUPER, 'disable');
    expect(rv.ok).toBe(true);
    await commitLifecycle(ROOT, SECOND_SUPER);

    const selfOnLastSuper = await reserve(ROOT, ROOT, 'disable', false);
    expect(selfOnLastSuper.ok).toBe(false);
    expect(selfOnLastSuper.error).toBe('REQUEST_DENIED');
  });

  // ── 9: institution_admin can never hard-delete, even with users.disable/recycle ──
  it('institution_admin is rejected for delete at the contract level regardless of permissions held', async () => {
    const rv = await reserve(INST_ADMIN, TARGET_A, 'delete', false);
    expect(rv.ok).toBe(false);
    expect(rv.error).toBe('REQUEST_DENIED');
  });

  it('institution_admin is rejected for any action outside their own organization', async () => {
    const rv = await reserve(INST_ADMIN, TARGET_CROSS, 'disable', false);
    expect(rv.ok).toBe(false);
    expect(rv.error).toBe('REQUEST_DENIED');
  });

  // ── 10: compensation restores the exact prior state, no half-suspended profile ──
  it('compensate restores the target to its exact prior status after a simulated Auth Admin failure', async () => {
    const before = await profileRow(TARGET_A);
    expect(before.status).toBe('active');

    const rv = await reserve(ROOT, TARGET_A, 'disable');
    expect(rv.ok).toBe(true);

    let row = await profileRow(TARGET_A);
    expect(row.status).toBe('suspended');

    // Simulates the Edge Function's compensate-on-Auth-failure path (e.g. the
    // Auth Admin ban call failed after the DB reservation was persisted).
    const comp = await compensate(ROOT, TARGET_A);
    expect(comp.ok).toBe(true);
    expect(comp.restored_status).toBe('active');

    row = await profileRow(TARGET_A);
    expect(row.status).toBe('active');
    expect(row.disabled_at).toBeNull();
    expect(row.disabled_by).toBeNull();

    const reservation = await rig.asAdmin(async (c) => {
      const r = await c.query(
        `select 1 from public.profile_lifecycle_reservations where profile_id = $1`,
        [TARGET_A],
      );
      return r.rows[0];
    });
    expect(reservation).toBeUndefined();
  });

  // ── 11: no password/secret ever flows through these RPCs or their audit trail ──
  it('no lifecycle RPC accepts or stores a password; audit payloads never carry one', async () => {
    const audit = await rig.asAdmin(async (c) => {
      const r = await c.query(
        `select payload from public.audit_logs
         where action in ('user.lifecycle_reserved','user.disabled','user.enabled',
                          'user.deleted','user.lifecycle_compensated','user.password_rotated',
                          'user.account_recycled')
         order by created_at desc limit 50`,
      );
      return r.rows;
    });
    for (const { payload } of audit) {
      // Flag names like `forced_password_change` are safe (a boolean, not a
      // credential); only a password-shaped KEY mapped to a STRING value
      // would indicate an actual leaked credential.
      expect(JSON.stringify(payload)).not.toMatch(/"[a-z_]*password[a-z_]*"\s*:\s*"/i);
    }
  });
});
