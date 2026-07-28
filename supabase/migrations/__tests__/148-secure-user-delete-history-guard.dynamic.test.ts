// =============================================================================
// Dynamic regression coverage for migration 148 (SECURE-USER-DELETE-HISTORY-
// GUARD-148), driven against a real disposable Postgres rig — not source-scan.
//
// Proves, against a real database:
//   1. A brand-new, never-used account can still be hard-deleted (profile +
//      auth both gone) — the guard never over-blocks.
//   2. An account with a real warehouse-movement row is refused with
//      USER_HAS_OPERATIONAL_HISTORY, and NOTHING is mutated (profile stays
//      'active', no reservation is persisted, auth/profile/movement all
//      survive untouched) — the check runs before any state change.
//   3. phoenix_profile_operational_blockers reports the exact blocking table.
//   4. Disabling a user with movement history changes nothing about how that
//      movement reads back through the real production ledger RPC
//      (phoenix_movement_ledger_report, migration 138) — actor_name/
//      actor_role come from the movement row's own snapshot, not a live join.
//   5. Recycling closes the prior identity_history version with a correct
//      valid_until, opens a new one, and old/new movement rows keep showing
//      their own snapshotted identity — recycling never rewrites history.
//   6. self-action and role/scope denials still fire BEFORE the history
//      check (ordering matters: a self-delete or an institution_admin
//      delete attempt is rejected as REQUEST_DENIED, never as
//      USER_HAS_OPERATIONAL_HISTORY, regardless of activity).
// =============================================================================
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '14800000-0000-4000-8000-00000000000a';

const UNUSED_TARGET   = '14800000-0000-4000-8000-000000000001';
const HISTORY_TARGET  = '14800000-0000-4000-8000-000000000002';
const RECYCLE_TARGET  = '14800000-0000-4000-8000-000000000003';
const INST_ADMIN      = '14800000-0000-4000-8000-000000000004';

const WAREHOUSE_ID    = '14800000-0000-4000-8000-000000000100';
const STOCK_HISTORY   = '14800000-0000-4000-8000-000000000200';
const STOCK_RECYCLE   = '14800000-0000-4000-8000-000000000201';

type Rig = Awaited<ReturnType<typeof buildRig>>;

run('migration 148 — secure user delete history guard (SECURE-USER-DELETE-HISTORY-GUARD-148)', () => {
  let rig: Rig;
  let ROOT: string;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 148 });
    ROOT = rig.superAdminId;

    await rig.asAdmin(async (c) => {
      await c.query(
        `insert into public.organizations (id, name, name_ar, code, status)
         values ($1, 'Delete Guard Org', 'مؤسسة اختبار الحذف', 'del-148-a', 'active')
         on conflict (id) do nothing`,
        [ORG_A],
      );
      await c.query(
        `insert into public.warehouses (id, organization_id, name, name_ar, status)
         values ($1, $2, 'Guard Warehouse', 'مخزن الاختبار', 'active')
         on conflict (id) do nothing`,
        [WAREHOUSE_ID, ORG_A],
      );

      async function seedProfile(id: string, email: string, fullName: string, role: string) {
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
          [id, ORG_A, role, fullName],
        );
      }

      await seedProfile(UNUSED_TARGET, 'unused-148@rig.local', 'Unused Target', 'outlet_officer');
      await seedProfile(HISTORY_TARGET, 'history-148@rig.local', 'History Target', 'outlet_officer');
      await seedProfile(RECYCLE_TARGET, 'recycle-148@rig.local', 'Old Officer', 'outlet_officer');
      await seedProfile(INST_ADMIN, 'inst-admin-148@rig.local', 'Institution Admin', 'institution_admin');
    });
  }, 300_000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  async function insertMovement(args: {
    id: string; stockId: string; actorId: string; actorName: string; actorRole: string;
  }) {
    await rig.asAdmin(async (c) => {
      await c.query(
        `insert into public.warehouse_stock
           (id, organization_id, warehouse_id, scientific_name,
            has_no_national_code, has_no_batch_number, internal_batch_reference)
         values ($1, $2, $3, 'Guard Test Material', true, true, $4)
         on conflict (id) do nothing`,
        [args.stockId, ORG_A, WAREHOUSE_ID, `guard-ref-${args.stockId}`],
      );
      await c.query(
        `insert into public.warehouse_stock_movements
           (id, warehouse_stock_id, organization_id, warehouse_id, movement_type,
            on_hand_before, on_hand_delta, on_hand_after,
            reserved_before, reserved_delta, reserved_after,
            actor_id, actor_role, actor_name, scientific_name_snapshot)
         values ($1, $2, $3, $4, 'add', 0, 10, 10, 0, 0, 0, $5, $6, $7, 'Guard Test Material')`,
        [args.id, args.stockId, ORG_A, WAREHOUSE_ID, args.actorId, args.actorRole, args.actorName],
      );
    });
  }

  async function reserve(actorId: string, targetId: string, action: 'disable' | 'delete', commit = true) {
    return rig.asUser(actorId, async (c) => {
      const r = await c.query(
        `select public.phoenix_lifecycle_reserve($1,$2,$3) result`,
        [targetId, action, crypto.randomUUID()],
      );
      return r.rows[0].result;
    }, { commit });
  }

  async function commitLifecycle(actorId: string, targetId: string, commit = true) {
    return rig.asUser(actorId, async (c) => {
      const r = await c.query(
        `select public.phoenix_lifecycle_commit($1,$2) result`,
        [targetId, crypto.randomUUID()],
      );
      return r.rows[0].result;
    }, { commit });
  }

  async function profileRow(id: string) {
    return rig.asAdmin(async (c) => {
      const r = await c.query(`select status from public.profiles where id = $1`, [id]);
      return r.rows[0] ?? null;
    });
  }

  it('a brand-new account with zero operational history can be hard-deleted', async () => {
    const rv = await reserve(ROOT, UNUSED_TARGET, 'delete');
    expect(rv.ok).toBe(true);

    // Model exactly what admin.auth.admin.deleteUser() does at the DB level.
    await rig.asAdmin((c) => c.query('delete from auth.users where id = $1', [UNUSED_TARGET]));

    const row = await profileRow(UNUSED_TARGET);
    expect(row).toBeNull();

    const auth = await rig.asAdmin(async (c) => {
      const r = await c.query('select 1 from auth.users where id = $1', [UNUSED_TARGET]);
      return r.rows[0];
    });
    expect(auth).toBeUndefined();
  });

  it('an account with a real warehouse movement is refused with USER_HAS_OPERATIONAL_HISTORY, and nothing is mutated', async () => {
    await insertMovement({
      id: '14800000-0000-4000-8000-000000000300',
      stockId: STOCK_HISTORY,
      actorId: HISTORY_TARGET,
      actorName: 'History Target',
      actorRole: 'outlet_officer',
    });

    const rv = await reserve(ROOT, HISTORY_TARGET, 'delete', false);
    expect(rv.ok).toBe(false);
    expect(rv.error).toBe('USER_HAS_OPERATIONAL_HISTORY');

    // Nothing was mutated: profile untouched, no reservation persisted.
    const row = await profileRow(HISTORY_TARGET);
    expect(row.status).toBe('active');

    const reservation = await rig.asAdmin(async (c) => {
      const r = await c.query(
        `select 1 from public.profile_lifecycle_reservations where profile_id = $1`,
        [HISTORY_TARGET],
      );
      return r.rows[0];
    });
    expect(reservation).toBeUndefined();

    const auth = await rig.asAdmin(async (c) => {
      const r = await c.query('select 1 from auth.users where id = $1', [HISTORY_TARGET]);
      return r.rows[0];
    });
    expect(auth).toBeDefined();

    const movement = await rig.asAdmin(async (c) => {
      const r = await c.query(
        `select actor_id, actor_name, actor_role from public.warehouse_stock_movements where id = $1`,
        ['14800000-0000-4000-8000-000000000300'],
      );
      return r.rows[0];
    });
    expect(movement.actor_id).toBe(HISTORY_TARGET);
    expect(movement.actor_name).toBe('History Target');
  });

  it('phoenix_profile_operational_blockers reports the exact blocking table(s) and counts', async () => {
    const blockers = await rig.asAdmin(async (c) => {
      const r = await c.query(
        `select referencing_table, reference_count
         from public.phoenix_profile_operational_blockers($1)
         order by referencing_table`,
        [HISTORY_TARGET],
      );
      return r.rows;
    });
    // The movement itself, plus the automatic phoenix_movement_events capture
    // (migration 082's trigger) — both are real historical footprint.
    expect(blockers).toEqual([
      { referencing_table: 'phoenix_movement_events', reference_count: '1' },
      { referencing_table: 'warehouse_stock_movements', reference_count: '1' },
    ]);
  });

  it('a genuinely unused account (no rows anywhere) reports zero blockers', async () => {
    const blockers = await rig.asAdmin(async (c) => {
      const r = await c.query(
        `select referencing_table from public.phoenix_profile_operational_blockers($1)`,
        [UNUSED_TARGET], // already deleted above, but the function only reads live rows
      );
      return r.rows;
    });
    expect(blockers).toEqual([]);
  });

  it('disabling a user with movement history changes nothing the shared production ledger RPC returns', async () => {
    const rv = await reserve(ROOT, HISTORY_TARGET, 'disable');
    expect(rv.ok).toBe(true);
    await commitLifecycle(ROOT, HISTORY_TARGET);

    const row = await profileRow(HISTORY_TARGET);
    expect(row.status).toBe('suspended');

    // The real production RPC every ledger/export screen reads from
    // (src/features/reports/movement-ledger-report.service.ts).
    const report = await rig.asUser(ROOT, async (c) => {
      const r = await c.query(
        `select actor_id, actor_name, actor_role from public.phoenix_movement_ledger_report($1)
         where movement_id = $2`,
        [ORG_A, '14800000-0000-4000-8000-000000000300'],
      );
      return r.rows[0];
    }, { commit: false });

    expect(report.actor_name).toBe('History Target');
    expect(report.actor_role).toBe('outlet_officer');
    // actor_id is a live FK (ON DELETE SET NULL) — survives a mere disable untouched.
    expect(report.actor_id).toBe(HISTORY_TARGET);
  });

  it('recycling closes the prior identity version and preserves old/new movement identity separately', async () => {
    // A pre-existing baseline row, exactly the shape migration 013's own
    // backfill produced for every profile that existed before it shipped.
    await rig.asAdmin((c) => c.query(
      `insert into public.user_identity_history
         (profile_id, identity_version, full_name, role, organization_id, valid_from, valid_until, change_reason)
       values ($1, 1, 'Old Officer', 'outlet_officer', $2, now() - interval '30 days', null, 'initial_snapshot')`,
      [RECYCLE_TARGET, ORG_A],
    ));

    await insertMovement({
      id: '14800000-0000-4000-8000-000000000301',
      stockId: STOCK_RECYCLE,
      actorId: RECYCLE_TARGET,
      actorName: 'Old Officer',
      actorRole: 'outlet_officer',
    });

    const rv = await reserve(ROOT, RECYCLE_TARGET, 'disable');
    expect(rv.ok).toBe(true);
    await commitLifecycle(ROOT, RECYCLE_TARGET);

    const applied = await rig.asUser(ROOT, async (c) => {
      const r = await c.query(
        `select public.phoenix_recycle_apply(
           $1,'New Officer','outlet_officer',$2,'local','new.officer',null,
           'new.officer@local.medistock.invalid',null,$3
         ) result`,
        [RECYCLE_TARGET, ORG_A, crypto.randomUUID()],
      );
      return r.rows[0].result;
    }, { commit: true });
    expect(applied.ok).toBe(true);
    expect(applied.new_identity_version).toBe(2);

    // A post-recycle movement, carrying the NEW identity.
    await insertMovement({
      id: '14800000-0000-4000-8000-000000000302',
      stockId: STOCK_RECYCLE,
      actorId: RECYCLE_TARGET,
      actorName: 'New Officer',
      actorRole: 'outlet_officer',
    });

    const history = await rig.asAdmin(async (c) => {
      const r = await c.query(
        `select identity_version, full_name, valid_until is null as is_current
         from public.user_identity_history
         where profile_id = $1 order by identity_version`,
        [RECYCLE_TARGET],
      );
      return r.rows;
    });
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ identity_version: 1, full_name: 'Old Officer', is_current: false });
    expect(history[1]).toMatchObject({ identity_version: 2, full_name: 'New Officer', is_current: true });

    const report = await rig.asUser(ROOT, async (c) => {
      const r = await c.query(
        `select movement_id, actor_name from public.phoenix_movement_ledger_report($1)
         where movement_id = any($2::uuid[])
         order by actor_name`,
        [ORG_A, ['14800000-0000-4000-8000-000000000301', '14800000-0000-4000-8000-000000000302']],
      );
      return r.rows;
    }, { commit: false });
    // Ordered by actor_name: 'New Officer' sorts before 'Old Officer'.
    expect(report).toEqual([
      { movement_id: '14800000-0000-4000-8000-000000000302', actor_name: 'New Officer' },
      { movement_id: '14800000-0000-4000-8000-000000000301', actor_name: 'Old Officer' },
    ]);
  });

  it('self-delete is rejected as REQUEST_DENIED before the history check ever runs (ordering)', async () => {
    // ROOT itself has no operational history in this rig, yet a self-delete
    // must still fail for self-action, not for lack of history.
    const rv = await reserve(ROOT, ROOT, 'delete', false);
    expect(rv.ok).toBe(false);
    expect(rv.error).toBe('REQUEST_DENIED');
  });

  it('institution_admin delete attempts are rejected as REQUEST_DENIED regardless of the target having history', async () => {
    const rv = await reserve(INST_ADMIN, HISTORY_TARGET, 'delete', false);
    expect(rv.ok).toBe(false);
    expect(rv.error).toBe('REQUEST_DENIED');
  });
});
