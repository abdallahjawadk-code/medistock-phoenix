/**
 * CUSTODY-CHAIN-NOTIFICATIONS-094 — DYNAMIC integration proof.
 *
 * Drives a REAL lifecycle RPC (warehouse transfer request create→submit→
 * review) against a disposable Postgres with 001→094 applied, then proves the
 * notification feed the extended trigger populates: org scoping, unread
 * count, mark-read (own profile only), mark-all-read, and dedup on retry.
 *
 * Gated on PHOENIX_RIG_PG. Skipped in CI where no database is present. Run
 * locally with:
 *   PHOENIX_RIG_PG=postgres://postgres@127.0.0.1:55432/postgres \
 *     PHOENIX_RIG_DB=phoenix_rig_custody_094 \
 *     npx vitest run supabase/migrations/__tests__/094-custody-chain-notifications.dynamic.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-00000000c101';
const ORG_INST = '00000000-0000-0000-0000-00000000c102';
const ORG_OTHER = '00000000-0000-0000-0000-00000000c103';
const WH_CENTRAL = '00000000-0000-0000-0000-00000000d101';
const WH_INST = '00000000-0000-0000-0000-00000000d102';
const ROUTE = '00000000-0000-0000-0000-00000000e101';
const USER_INST_A = '00000000-0000-0000-0000-00000000f102'; // institution_admin @ ORG_INST
const USER_INST_B = '00000000-0000-0000-0000-00000000f103'; // second institution_admin @ ORG_INST
const USER_OTHER = '00000000-0000-0000-0000-00000000f104'; // institution_admin @ ORG_OTHER (five-role cutover: no viewer role exists)

run('094 custody-chain notifications — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (client: any, fn: string, args: any[]) =>
    client.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 94 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations (id, name, name_ar, code) VALUES
          ('${ORG_CENTRAL}','Central','مركزي','rig-central-094'),
          ('${ORG_INST}','Institution','مؤسسة','rig-inst-094'),
          ('${ORG_OTHER}','Other','اخرى','rig-other-094')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`
        INSERT INTO warehouses (id, organization_id, name, name_ar, status, warehouse_kind, code) VALUES
          ('${WH_CENTRAL}','${ORG_CENTRAL}','Central WH','مخزن مركزي','active','central','rig-wh-c-094'),
          ('${WH_INST}','${ORG_INST}','Inst WH','مخزن مؤسسة','active','institution','rig-wh-i-094')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`
        INSERT INTO warehouse_supply_routes
          (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution', true)
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`
        INSERT INTO auth.users (id, email) VALUES
          ('${USER_INST_A}','inst-a@rig.local'),
          ('${USER_INST_B}','inst-b@rig.local'),
          ('${USER_OTHER}','other@rig.local')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active', organization_id='${ORG_INST}' WHERE id='${USER_INST_A}';`);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active', organization_id='${ORG_INST}' WHERE id='${USER_INST_B}';`);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active', organization_id='${ORG_OTHER}' WHERE id='${USER_OTHER}';`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  async function draftAndSubmit(client: any, reqNo: string): Promise<string> {
    const created = await call(client, 'phoenix_create_warehouse_transfer_request',
      [ROUTE, WH_INST, reqNo, null]);
    expect(created.ok).toBe(true);
    const traceId = created.transfer_request_id;
    const line = await call(client, 'phoenix_add_warehouse_transfer_request_line',
      [traceId, 'Paracetamol', 100, null, null, null, null, null]);
    expect(line.ok).toBe(true);
    const submitted = await call(client, 'phoenix_submit_warehouse_transfer_request', [traceId]);
    expect(submitted.status).toBe('submitted');
    return traceId;
  }

  it('a real transition (submit) creates an org-scoped notification, unread by default', async () => {
    let traceId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      traceId = await draftAndSubmit(c, 'RIG-NOTIF-1');
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const rows = await c.query(
        `SELECT organization_id, event_type, status_after, reference_id
           FROM phoenix_notifications WHERE reference_id = $1 ORDER BY status_after`, [traceId]);
      const statuses = rows.rows.map((r: any) => r.status_after);
      expect(statuses).toEqual(expect.arrayContaining(['draft', 'submitted']));
      for (const r of rows.rows) expect(r.organization_id).toBe(ORG_INST);
    });

    // Visible and unread to an institution_admin IN the same org.
    await rig.asUser(USER_INST_A, async (c: any) => {
      const list = await call(c, 'phoenix_notifications_list', [30, null, null, false]);
      expect(list.ok).toBe(true);
      const mine = list.notifications.filter((n: any) => n.reference_id === traceId);
      expect(mine.length).toBeGreaterThanOrEqual(2);
      expect(mine.every((n: any) => n.is_read === false)).toBe(true);

      const count = await call(c, 'phoenix_notifications_unread_count', []);
      expect(count).toBeGreaterThanOrEqual(2);
    });

    // Invisible to a profile in a DIFFERENT organization.
    await rig.asUser(USER_OTHER, async (c: any) => {
      const list = await call(c, 'phoenix_notifications_list', [30, null, null, false]);
      const mine = list.notifications.filter((n: any) => n.reference_id === traceId);
      expect(mine.length).toBe(0);
    });
  });

  it('mark_read is per-viewer: reading it as A never marks it read for B in the same org', async () => {
    let traceId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      traceId = await draftAndSubmit(c, 'RIG-NOTIF-2');
    }, { commit: true });

    let notifId = '';
    await rig.asAdmin(async (c: any) => {
      const row = await c.query(
        `SELECT id FROM phoenix_notifications WHERE reference_id=$1 AND status_after='submitted'`, [traceId]);
      notifId = row.rows[0].id;
    });

    await rig.asUser(USER_INST_A, async (c: any) => {
      const marked = await call(c, 'phoenix_notifications_mark_read', [notifId]);
      expect(marked.ok).toBe(true);
      const list = await call(c, 'phoenix_notifications_list', [30, null, null, false]);
      const mine = list.notifications.find((n: any) => n.id === notifId);
      expect(mine.is_read).toBe(true);
    });

    await rig.asUser(USER_INST_B, async (c: any) => {
      const list = await call(c, 'phoenix_notifications_list', [30, null, null, false]);
      const mine = list.notifications.find((n: any) => n.id === notifId);
      expect(mine.is_read).toBe(false); // B's own read state is independent of A's
    });
  });

  it('mark_read on an id outside the caller\'s org is a silent no-op, not an error', async () => {
    let traceId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      traceId = await draftAndSubmit(c, 'RIG-NOTIF-3');
    }, { commit: true });

    let notifId = '';
    await rig.asAdmin(async (c: any) => {
      const row = await c.query(
        `SELECT id FROM phoenix_notifications WHERE reference_id=$1 AND status_after='submitted'`, [traceId]);
      notifId = row.rows[0].id;
    });

    await rig.asUser(USER_OTHER, async (c: any) => {
      await expect(call(c, 'phoenix_notifications_mark_read', [notifId])).resolves.toEqual({ ok: true });
    });

    // Never actually inserted for the wrong org.
    await rig.asAdmin(async (c: any) => {
      const rows = await c.query(
        `SELECT 1 FROM phoenix_notification_reads WHERE notification_id=$1 AND profile_id=$2`,
        [notifId, USER_OTHER]);
      expect(rows.rows.length).toBe(0);
    });

    // A nonexistent id behaves identically.
    await rig.asUser(USER_INST_A, async (c: any) => {
      await expect(call(c, 'phoenix_notifications_mark_read', ['00000000-0000-0000-0000-0000000000ff']))
        .resolves.toEqual({ ok: true });
    });
  });

  it('mark_all_read marks every currently-unread notification in scope, and is itself idempotent', async () => {
    let traceId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      traceId = await draftAndSubmit(c, 'RIG-NOTIF-4');
    }, { commit: true });

    await rig.asUser(USER_INST_B, async (c: any) => {
      const before = await call(c, 'phoenix_notifications_unread_count', []);
      expect(before).toBeGreaterThan(0);

      const first = await call(c, 'phoenix_notifications_mark_all_read', []);
      expect(first.ok).toBe(true);
      expect(first.marked).toBeGreaterThan(0);

      const after = await call(c, 'phoenix_notifications_unread_count', []);
      expect(after).toBe(0);

      // Idempotent: nothing left to mark on a second call.
      const second = await call(c, 'phoenix_notifications_mark_all_read', []);
      expect(second.marked).toBe(0);
    });
  });

  it('is dedup-safe: a lost-response retry of the same submit cannot double-notify', async () => {
    let traceId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      traceId = await draftAndSubmit(c, 'RIG-NOTIF-5');
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const before = await c.query(
        `SELECT count(*)::int n FROM phoenix_notifications WHERE reference_id=$1 AND status_after='submitted'`,
        [traceId]);
      expect(before.rows[0].n).toBe(1);
    });

    // Re-submitting an already-submitted request must not change status, so
    // the trigger's own "real transition" guard suppresses it — and the RPC
    // itself rejects the retry before the trigger ever fires a second time.
    // Runs in its OWN transaction (a rejected RPC aborts the current one).
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_submit_warehouse_transfer_request', [traceId]))
        .rejects.toThrow();
    });

    await rig.asAdmin(async (c: any) => {
      const after = await c.query(
        `SELECT count(*)::int n FROM phoenix_notifications WHERE reference_id=$1 AND status_after='submitted'`,
        [traceId]);
      expect(after.rows[0].n).toBe(1);
    });
  });
});
