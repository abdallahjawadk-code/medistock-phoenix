/**
 * MOVEMENT-EVENT-CAPTURE-082 — DYNAMIC integration proof.
 *
 * Drives the REAL lifecycle RPCs against a disposable Postgres with 001→082
 * applied, then reads phoenix_movement_timeline and proves the ledger events
 * that 082's triggers captured actually appear — with the authenticated actor,
 * the right provenance, idempotency, and organization scope.
 *
 * Gated on PHOENIX_RIG_PG (a superuser maintenance connection string). Skipped
 * in CI where no database is present, exactly like the 081 dynamic proof, whose
 * results live in docs/. Run locally with:
 *   PHOENIX_RIG_PG=postgres://postgres@localhost:55432/postgres \
 *     npx vitest run supabase/migrations/__tests__/082-event-capture.dynamic.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

// Fixed fixture UUIDs so assertions can name them.
const ORG_CENTRAL = '00000000-0000-0000-0000-00000000c001';
const ORG_INST = '00000000-0000-0000-0000-00000000c002';
const ORG_OTHER = '00000000-0000-0000-0000-00000000c003';
const WH_CENTRAL = '00000000-0000-0000-0000-00000000d001';
const WH_INST = '00000000-0000-0000-0000-00000000d002';
const ROUTE = '00000000-0000-0000-0000-00000000e001';
const USER_INST = '00000000-0000-0000-0000-00000000f002'; // institution_admin @ ORG_INST
const USER_OTHER = '00000000-0000-0000-0000-00000000f003'; // viewer @ ORG_OTHER

run('082 movement-event capture — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (client: any, fn: string, args: any[]) =>
    client.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 82 });
    // Committed fixtures shared by every test transaction.
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations (id, name, name_ar, code) VALUES
          ('${ORG_CENTRAL}','Central','مركزي','rig-central'),
          ('${ORG_INST}','Institution','مؤسسة','rig-inst'),
          ('${ORG_OTHER}','Other','اخرى','rig-other')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`
        INSERT INTO warehouses (id, organization_id, name, name_ar, status, warehouse_kind, code) VALUES
          ('${WH_CENTRAL}','${ORG_CENTRAL}','Central WH','مخزن مركزي','active','central','rig-wh-c'),
          ('${WH_INST}','${ORG_INST}','Inst WH','مخزن مؤسسة','active','institution','rig-wh-i')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`
        INSERT INTO warehouse_supply_routes
          (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution', true)
        ON CONFLICT (id) DO NOTHING;`);
      // Two non-super principals for the scope test.
      await c.query(`
        INSERT INTO auth.users (id, email) VALUES
          ('${USER_INST}','inst@rig.local'), ('${USER_OTHER}','other@rig.local')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active', organization_id='${ORG_INST}' WHERE id='${USER_INST}';`);
      await c.query(`UPDATE profiles SET role='viewer', status='active', organization_id='${ORG_OTHER}' WHERE id='${USER_OTHER}';`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  // Runs a fresh request through create → add line → submit inside ONE txn,
  // returns the trace id and the open client so the caller can continue.
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

  it('captures create + submit + review as ledger events surfaced by the timeline', async () => {
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const traceId = await draftAndSubmit(c, 'RIG-REQ-1');
      // Approve the single line in full → header goes 'approved'.
      const lineRow = await c.query(
        `SELECT id FROM warehouse_transfer_request_lines WHERE transfer_request_id=$1`, [traceId]);
      const decisions = JSON.stringify([{ line_id: lineRow.rows[0].id, approved_quantity: 100 }]);
      const reviewed = await call(c, 'phoenix_review_warehouse_transfer_request', [traceId, decisions]);
      expect(reviewed.ok).toBe(true);

      // Ledger, written entirely by the triggers, within this same txn.
      const events = await c.query(
        `SELECT status_after, actor_id, organization_id FROM phoenix_movement_events
          WHERE trace_id=$1 ORDER BY occurred_at, status_after`, [traceId]);
      const statuses = events.rows.map((r: any) => r.status_after);
      expect(statuses).toEqual(expect.arrayContaining(['draft', 'submitted', 'approved']));
      // Actor is the authenticated caller; owner org is the initiating institution.
      for (const r of events.rows) {
        expect(r.actor_id).toBe(rig.superAdminId);
        expect(r.organization_id).toBe(ORG_INST);
      }

      // The timeline RPC surfaces them with provenance 'event_ledger'.
      const tl = await call(c, 'phoenix_movement_timeline', [traceId, 50, null, null]);
      expect(tl.ok).toBe(true);
      expect(tl.complete).toBe(false); // never claims completeness it can't support
      const ledgerEvents = tl.events.filter((e: any) => e.provenance === 'event_ledger');
      const tlStatuses = ledgerEvents.map((e: any) => e.status);
      expect(tlStatuses).toEqual(expect.arrayContaining(['draft', 'submitted', 'approved']));
      expect(ledgerEvents.every((e: any) => e.actor_id === rig.superAdminId)).toBe(true);
    });
  });

  it('captures cancellation through the real cancel RPC', async () => {
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const traceId = await draftAndSubmit(c, 'RIG-REQ-2');
      const cancelled = await call(c, 'phoenix_cancel_warehouse_transfer_request', [traceId, 'no longer needed']);
      expect(cancelled.status).toBe('cancelled');
      const events = await c.query(
        `SELECT status_after FROM phoenix_movement_events WHERE trace_id=$1`, [traceId]);
      expect(events.rows.map((r: any) => r.status_after)).toEqual(
        expect.arrayContaining(['draft', 'submitted', 'cancelled']));
    });
  });

  it('is idempotent: a retried RPC and metadata/same-status writes create no duplicate events', async () => {
    // Persist a real submitted request.
    let traceId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      traceId = await draftAndSubmit(c, 'RIG-REQ-3');
    }, { commit: true });

    const count = () => rig.asAdmin((c: any) =>
      c.query(`SELECT count(*)::int n FROM phoenix_movement_events WHERE trace_id=$1`, [traceId])
        .then((r: any) => r.rows[0].n));
    const before = await count();

    // 1. A lost-response retry: calling submit again re-runs the same transition.
    //    The RPC itself rejects it (already submitted) — no second event.
    await rig.asUser(rig.superAdminId, (c: any) =>
      call(c, 'phoenix_submit_warehouse_transfer_request', [traceId])).catch(() => {});
    expect(await count()).toBe(before);

    // 2. Same-value status write + metadata-only write fire the trigger but are
    //    not transitions — the IS DISTINCT guard suppresses both.
    await rig.asAdmin(async (c: any) => {
      await c.query(`UPDATE warehouse_transfer_requests SET status=status WHERE id=$1`, [traceId]);
      await c.query(`UPDATE warehouse_transfer_requests SET notes='edited' WHERE id=$1`, [traceId]);
    });
    expect(await count()).toBe(before);

    await rig.asAdmin((c: any) => c.query(`DELETE FROM warehouse_transfer_requests WHERE id=$1`, [traceId]));
  });

  it('the dedupe_key unique index rejects a duplicate transition record', async () => {
    await rig.asAdmin(async (c: any) => {
      const key = 'dup-' + Date.now();
      await c.query(
        `INSERT INTO phoenix_movement_events (organization_id, trace_id, event_type, dedupe_key)
         VALUES ($1, gen_random_uuid(), 't.x', $2)`, [ORG_INST, key]);
      await expect(
        c.query(`INSERT INTO phoenix_movement_events (organization_id, trace_id, event_type, dedupe_key)
                 VALUES ($1, gen_random_uuid(), 't.x', $2)`, [ORG_INST, key])
      ).rejects.toThrow(/duplicate key|unique/i);
    });
  });

  it('scopes to the initiating org: same-org sees events, a foreign org sees nothing', async () => {
    // Persist a real submitted request so cross-connection reads can see it.
    let traceId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      traceId = await draftAndSubmit(c, 'RIG-REQ-4');
    }, { commit: true });

    // Institution-org user: sees the ledger lifecycle.
    const seen = await rig.asUser(USER_INST, (c: any) =>
      call(c, 'phoenix_movement_timeline', [traceId, 50, null, null]));
    expect(seen.events.some((e: any) => e.provenance === 'event_ledger')).toBe(true);

    // Foreign-org user: forbidden and nonexistent are indistinguishable — empty.
    const hidden = await rig.asUser(USER_OTHER, (c: any) =>
      call(c, 'phoenix_movement_timeline', [traceId, 50, null, null]));
    expect(hidden.events).toEqual([]);

    // cleanup the committed row set
    await rig.asAdmin((c: any) => c.query(`DELETE FROM warehouse_transfer_requests WHERE id=$1`, [traceId]));
  });
});
