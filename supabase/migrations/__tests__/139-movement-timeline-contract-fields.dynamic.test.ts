/**
 * MOVEMENT-TIMELINE-CONTRACT-FIELDS-139 — DYNAMIC operational acceptance
 * against a real disposable Postgres with 001->139 applied in order.
 *
 * 139 makes phoenix_movement_timeline (the per-document Custody Chain
 * drill-down) emit the Unified Movements contract fields it predated.
 * These are the proofs that matter, driven through the real RPC exactly as
 * CustodyChainTab calls it:
 *   * a real warehouse movement's event carries reason_code,
 *     quantity_before/after and correlation/causation — not just delta;
 *   * an outlet dispense event reports has_dispense_context = true, and the
 *     beneficiary detail itself is NEVER in the payload (masking stays in
 *     phoenix_get_movement_dispense_context);
 *   * every ORIGINAL key still present with identical semantics (additive
 *     change, no consumer breakage);
 *   * scope: another org's trace returns the SAME empty shape as a
 *     nonexistent one — still not an existence oracle;
 *   * anon holds zero EXECUTE grant.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-000000139001';
const ORG_B = '00000000-0000-0000-0000-000000139002';
const WH_A = '00000000-0000-0000-0000-000000139101';
const WH_B = '00000000-0000-0000-0000-000000139102';
const DP_A = '00000000-0000-0000-0000-000000139301';

const OO_A = '00000000-0000-0000-0000-000000139401'; // outlet_officer, org A — dispenses
const IA_A = '00000000-0000-0000-0000-000000139402'; // institution_admin, org A
const IA_B = '00000000-0000-0000-0000-000000139403'; // institution_admin, org B — cross-org

run('139 movement timeline contract fields — operational acceptance (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const timeline = (c: any, traceId: string) =>
    c.query(`SELECT public.phoenix_movement_timeline($1, 50, NULL, NULL) AS r`, [traceId])
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 139 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_A}','A','أ','p139-a'),('${ORG_B}','B','ب','p139-b') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_A}','${ORG_A}','WA','مخزن أ','active','institution','p139-wa'),
        ('${WH_B}','${ORG_B}','WB','مخزن ب','active','institution','p139-wb')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_A}','${WH_A}','${ORG_A}','OA','منفذ أ','pharmacy','active')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OO_A}','p139-ooa@rig'),('${IA_A}','p139-iaa@rig'),('${IA_B}','p139-iab@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_A}' WHERE id='${OO_A}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_A}' WHERE id='${IA_A}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_B}' WHERE id='${IA_B}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${OO_A}','${ORG_A}','distribution_point','${DP_A}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('a warehouse movement event carries reason_code, quantity_before/after and correlation/causation — not just the delta', async () => {
    const stockId = randomUUID();
    const moveId = randomUUID();
    const correlationId = randomUUID();
    const causationId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code,
           has_no_batch_number, batch_number, expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'Timeline139',true,false,$4,current_date+365,100,0,1)`,
        [stockId, ORG_A, WH_A, `B139-${Date.now()}`],
      );
      await c.query(
        `INSERT INTO warehouse_stock_movements (
           id, warehouse_stock_id, organization_id, warehouse_id, movement_type,
           on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after,
           reason_code, correlation_id, causation_id,
           scientific_name_snapshot, batch_number_snapshot, actor_id, actor_role, actor_name,
           source_document_number)
         VALUES ($1,$2,$3,$4,'add',5,10,15,0,0,0,'received',$5,$6,'Timeline139','B139',$7,'institution_admin','Tester A','DOC-139-1')`,
        [moveId, stockId, ORG_A, WH_A, correlationId, causationId, IA_A],
      );
    });

    await rig.asUser(IA_A, async (c: any) => {
      const res = await timeline(c, moveId);
      expect(res.ok).toBe(true);
      const ev = res.events.find((e: any) => e.event_id === moveId);
      expect(ev).toBeDefined();
      // The 139 additive fields.
      expect(ev.reason_code).toBe('received');
      expect(ev.quantity_before).toBe(5);
      expect(ev.quantity_after).toBe(15);
      expect(ev.correlation_id).toBe(correlationId);
      expect(ev.causation_id).toBe(causationId);
      expect(ev.has_dispense_context).toBe(false);
      // before + delta = after must reconcile from the payload alone.
      expect(ev.quantity_before + ev.quantity_delta).toBe(ev.quantity_after);
    });
  });

  it('every ORIGINAL timeline key survives with identical semantics (additive change, no consumer breakage)', async () => {
    const stockId = randomUUID();
    const moveId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code,
           has_no_batch_number, batch_number, expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'OriginalKeys139',true,false,$4,current_date+365,50,0,1)`,
        [stockId, ORG_A, WH_A, `B139K-${Date.now()}`],
      );
      await c.query(
        `INSERT INTO warehouse_stock_movements (
           id, warehouse_stock_id, organization_id, warehouse_id, movement_type,
           on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after,
           reason_code, scientific_name_snapshot, batch_number_snapshot, actor_id, actor_role, actor_name,
           source_document_number, reference_type)
         VALUES ($1,$2,$3,$4,'subtract',20,-4,16,0,0,0,'dispensed','OriginalKeys139','BK139',$5,'institution_admin','Tester A','DOC-139-2','warehouse_dispatch')`,
        [moveId, stockId, ORG_A, WH_A, IA_A],
      );
    });

    await rig.asUser(IA_A, async (c: any) => {
      const res = await timeline(c, moveId);
      const ev = res.events.find((e: any) => e.event_id === moveId);
      for (const key of [
        'event_id', 'event_type', 'occurred_at', 'actor_id', 'actor_role', 'actor_name',
        'status', 'material', 'batch', 'quantity_delta', 'reference_type', 'reference_id',
        'reference', 'provenance',
      ]) {
        expect(Object.keys(ev)).toContain(key);
      }
      expect(ev.provenance).toBe('movement_row');
      expect(ev.event_type).toBe('warehouse_stock_movement');
      expect(ev.status).toBe('subtract');
      expect(ev.material).toBe('OriginalKeys139');
      expect(ev.quantity_delta).toBe(-4);
      expect(ev.reference).toBe('DOC-139-2');
      // The whole-response contract is unchanged too.
      expect(res.complete).toBe(false);
      expect(typeof res.completeness_note).toBe('string');
      expect(res.completeness_note.length).toBeGreaterThan(0);
    });
  });

  it('an outlet dispense event reports has_dispense_context=true and NEVER carries the beneficiary detail itself', async () => {
    const lotId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type,
           scientific_name, has_no_national_code, has_no_batch_number, batch_number,
           expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'pharmacy','Dispense139',true,false,$4,current_date+365,40,0,1)`,
        [lotId, ORG_A, DP_A, `B139D-${Date.now()}`],
      );
    });
    let result: any;
    await rig.asUser(OO_A, async (c: any) => {
      result = await c.query(
        `SELECT public.phoenix_dispense_outlet_stock_with_context($1,$2,$3,'patient','MRN-139-SECRET','مريض تجريبي','chart',null,null,null,null,null) AS r`,
        [randomUUID(), lotId, 6],
      ).then((r: any) => r.rows[0].r);
      expect(result.ok).toBe(true);
    }, { commit: true });

    await rig.asUser(IA_A, async (c: any) => {
      const res = await timeline(c, result.movement_id);
      const ev = res.events.find((e: any) => e.event_id === result.movement_id);
      expect(ev).toBeDefined();
      expect(ev.has_dispense_context).toBe(true);
      expect(ev.reason_code).toBe('dispensed');
      expect(ev.quantity_before + ev.quantity_delta).toBe(ev.quantity_after);

      // The beneficiary detail must be absent from the payload entirely —
      // masking lives in phoenix_get_movement_dispense_context, not here.
      const asText = JSON.stringify(res);
      expect(asText).not.toContain('MRN-139-SECRET');
      expect(asText).not.toContain('مريض تجريبي');
      expect(Object.keys(ev)).not.toContain('patient_identifier');
      expect(Object.keys(ev)).not.toContain('beneficiary_type');
    });
  });

  it('SCOPE: another org\'s real trace is indistinguishable from a nonexistent one (still not an existence oracle)', async () => {
    const stockId = randomUUID();
    const moveId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code,
           has_no_batch_number, batch_number, expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'OrgAOnly139',true,false,$4,current_date+365,30,0,1)`,
        [stockId, ORG_A, WH_A, `B139X-${Date.now()}`],
      );
      await c.query(
        `INSERT INTO warehouse_stock_movements (
           id, warehouse_stock_id, organization_id, warehouse_id, movement_type,
           on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after,
           reason_code, scientific_name_snapshot, actor_id, actor_role, actor_name)
         VALUES ($1,$2,$3,$4,'add',0,7,7,0,0,0,'received','OrgAOnly139',$5,'institution_admin','Tester A')`,
        [moveId, stockId, ORG_A, WH_A, IA_A],
      );
    });

    await rig.asUser(IA_B, async (c: any) => {
      const forbidden = await timeline(c, moveId);          // real, but org A's
      const nonexistent = await timeline(c, randomUUID());  // does not exist at all
      expect(forbidden.events).toEqual([]);
      expect(nonexistent.events).toEqual([]);
      // Byte-identical shape: the caller cannot tell which is which.
      expect(JSON.stringify(forbidden)).toBe(JSON.stringify(nonexistent));
    });
  });

  it('GRANTS: anon holds zero EXECUTE grant on the timeline RPC', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM information_schema.role_routine_grants
          WHERE routine_schema='public' AND routine_name='phoenix_movement_timeline' AND grantee='anon'`,
      );
      expect(r.rows[0].n).toBe(0);
    });
  });
});
