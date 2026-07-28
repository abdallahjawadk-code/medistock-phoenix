/**
 * LIVE-BALANCE-FIX-148 — DYNAMIC acceptance against a real disposable
 * Postgres with 001->148 applied in order.
 *
 * Proves, against a real database, that phoenix_create_transfer_draft_from_
 * suggestion's headroom/deficit are re-derived LIVE from warehouse_stock/
 * outlet_stock + inventory_signal_thresholds (via the new internal helper
 * _phoenix_live_suggestion_scope_position) rather than from
 * inventory_alerts.observed_available/threshold_* — a table only ever
 * refreshed by a MANUAL phoenix_recompute_inventory_alerts call, with no
 * lock of its own and no trigger tying it to a live stock change.
 *
 * The companion STATIC guard (148-transfer-suggestion-live-balance-guard.
 * test.ts) pins the source-code shape (item 12 of the phase's required
 * proofs); this file proves the runtime behavior (items 1-11).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database) — mirrors every other
 * *.dynamic.test.ts in this directory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_C = '00000000-0000-0000-0000-000000148701'; // central org
const ORG_I = '00000000-0000-0000-0000-000000148702'; // institution org
const ORG_I2 = '00000000-0000-0000-0000-000000148703'; // a second institution org
const WH_C = '00000000-0000-0000-0000-000000148711'; // central warehouse
const WH_I = '00000000-0000-0000-0000-000000148712'; // institution warehouse
const WH_I2 = '00000000-0000-0000-0000-000000148713'; // second institution warehouse
const DP_I = '00000000-0000-0000-0000-000000148714'; // institution outlet, paired to WH_I

const IA_C = '00000000-0000-0000-0000-000000148721'; // institution_admin, ORG_C — both real gates

type Rig = Awaited<ReturnType<typeof buildRig>>;

run('LIVE-BALANCE-FIX-148 — draft creation re-verifies against live stock/thresholds', () => {
  let rig: Rig;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 149 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_C}','Central','مركزي','p148lb-c'),
        ('${ORG_I}','Institution','مؤسسة','p148lb-i'),
        ('${ORG_I2}','Institution2','مؤسسة2','p148lb-i2')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_C}','${ORG_C}','Central WH','مخزن مركزي','active','central','p148lb-wc'),
        ('${WH_I}','${ORG_I}','Institution WH','مخزن مؤسسة','active','institution','p148lb-wi'),
        ('${WH_I2}','${ORG_I2}','Institution WH2','مخزن مؤسسة2','active','institution','p148lb-wi2')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_I}','${WH_I}','${ORG_I}','Outlet I','منفذ مؤسسة','pharmacy','active')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${IA_C}','p148lb-iac@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_C}' WHERE id='${IA_C}';`);
      await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES
        ('${IA_C}','inventory.act_on_suggestions',true),
        ('${IA_C}','warehouse_transfer.send',true)
        ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = excluded.allowed;`);
    });
  }, 300_000);

  afterAll(async () => { if (rig) await rig.end(); });

  /** Seeds one source batch (WH_C) + one target row (WH_I) + thresholds, generates
   *  a REAL central_to_institution suggestion through the real recompute/suggest
   *  engine, and returns its id + the source stock id. */
  async function seedPair(sci: string, opts: {
    sourceOnHand: number; sourceReserved?: number; sourceTargetMax: number;
    targetOnHand: number; targetReorderPoint: number;
    batchNumber?: string; expiryDaysFromNow?: number;
  }) {
    const srcStockId = randomUUID();
    const tgtStockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
           has_no_national_code, has_no_batch_number, batch_number, expiry_date,
           on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,$4,true,false,$5,current_date+($6)::int,$7,$8,1)`,
        [srcStockId, ORG_C, WH_C, sci, opts.batchNumber ?? `B148LB-${sci}-src`,
         opts.expiryDaysFromNow ?? 365, opts.sourceOnHand, opts.sourceReserved ?? 0],
      );
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
           has_no_national_code, has_no_batch_number, batch_number, expiry_date,
           on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,$4,true,false,$5,current_date+365,$6,0,1)`,
        [tgtStockId, ORG_I, WH_I, sci, `B148LB-${sci}-tgt`, opts.targetOnHand],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, target_max, is_active)
         VALUES ($1,'warehouse',$2,$3,$4,true)`,
        [ORG_C, WH_C, sci, opts.sourceTargetMax],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, reorder_point, is_active)
         VALUES ($1,'warehouse',$2,$3,$4,true)`,
        [ORG_I, WH_I, sci, opts.targetReorderPoint],
      );
    });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_C]);
    }, { commit: true });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_I]);
    }, { commit: true });
    let suggestionId: string;
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(
        `SELECT public.phoenix_suggest_cross_org_inventory_transfer($1,$2,$3,$4,$5,NULL)`,
        [ORG_C, WH_C, ORG_I, WH_I, sci],
      );
      const r = await c.query(
        `SELECT id FROM inventory_transfer_suggestions
         WHERE source_organization_id=$1 AND target_organization_id=$2
           AND route_kind='central_to_institution' AND scientific_name=$3 AND status='open'
         ORDER BY created_at DESC LIMIT 1`,
        [ORG_C, ORG_I, sci],
      );
      suggestionId = r.rows[0]?.id;
    }, { commit: true });
    return { suggestionId: suggestionId!, srcStockId, tgtStockId };
  }

  async function draft(actorId: string, suggestionId: string, doc: string) {
    return rig.asUser(actorId, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`, [suggestionId, doc]);
      return r.rows[0].r;
    }, { commit: true });
  }

  it('1. a real withdrawal at the source after suggestion-generation shrinks the drafted quantity', async () => {
    const sci = `LB Med withdrawal`;
    const { suggestionId, srcStockId } = await seedPair(sci, {
      sourceOnHand: 100, sourceTargetMax: 20, targetOnHand: 5, targetReorderPoint: 50,
    });
    // Generation-time snapshot would have suggested min(headroom=80, deficit=45) = 45.
    // A REAL withdrawal happens after generation, before drafting.
    await rig.asAdmin((c: any) => c.query(
      `UPDATE warehouse_stock SET on_hand_quantity = 30 WHERE id = $1`, [srcStockId],
    ));
    const result = await draft(IA_C, suggestionId, 'DOC-148LB-1');
    expect(result.ok).toBe(true);
    // live headroom = 30 - 20 = 10, live deficit = 45, batch = 30 -> eligible = 10
    expect(result.quantity).toBe(10);
  });

  it('2. a real receipt at the target after suggestion-generation shrinks/recomputes the deficit', async () => {
    const sci = `LB Med receipt`;
    const { suggestionId, tgtStockId } = await seedPair(sci, {
      sourceOnHand: 100, sourceTargetMax: 20, targetOnHand: 5, targetReorderPoint: 50,
    });
    await rig.asAdmin((c: any) => c.query(
      `UPDATE warehouse_stock SET on_hand_quantity = 48 WHERE id = $1`, [tgtStockId],
    ));
    const result = await draft(IA_C, suggestionId, 'DOC-148LB-2');
    expect(result.ok).toBe(true);
    // live deficit = 50 - 48 = 2, live headroom = 80, batch = 100 -> eligible = 2
    expect(result.quantity).toBe(2);
  });

  it('3. a threshold change after suggestion-generation is re-read live, not from the stale snapshot', async () => {
    const sci = `LB Med threshold`;
    const { suggestionId } = await seedPair(sci, {
      sourceOnHand: 100, sourceTargetMax: 20, targetOnHand: 5, targetReorderPoint: 50,
    });
    // Someone raises the source's target_max after generation (real admin action).
    await rig.asAdmin((c: any) => c.query(
      `UPDATE inventory_signal_thresholds SET target_max = 70
       WHERE organization_id = $1 AND scope_kind='warehouse' AND scope_id = $2 AND lower(scientific_name) = lower($3)`,
      [ORG_C, WH_C, sci],
    ));
    const result = await draft(IA_C, suggestionId, 'DOC-148LB-3');
    expect(result.ok).toBe(true);
    // live headroom = 100 - 70 = 30 (was 80 at generation time) -> eligible = min(30, deficit 45) = 30
    expect(result.quantity).toBe(30);
  });

  it('4a. source surplus vanishing entirely is refused, never floored to quantity 1', async () => {
    const sci = `LB Med surplus gone`;
    const { suggestionId, srcStockId } = await seedPair(sci, {
      sourceOnHand: 100, sourceTargetMax: 20, targetOnHand: 5, targetReorderPoint: 50,
    });
    // Withdraw down to exactly the target_max — live headroom becomes exactly 0.
    await rig.asAdmin((c: any) => c.query(
      `UPDATE warehouse_stock SET on_hand_quantity = 20 WHERE id = $1`, [srcStockId],
    ));
    await expect(draft(IA_C, suggestionId, 'DOC-148LB-4A')).rejects.toThrow(/no_source_surplus/);
    await rig.asAdmin(async (c: any) => {
      const s = (await c.query(`SELECT status FROM inventory_transfer_suggestions WHERE id=$1`, [suggestionId])).rows[0];
      expect(s.status).toBe('open');
    });
  });

  it('4b. target deficit vanishing entirely (already restocked) is refused, never floored to quantity 1', async () => {
    const sci = `LB Med deficit gone`;
    const { suggestionId, tgtStockId } = await seedPair(sci, {
      sourceOnHand: 100, sourceTargetMax: 20, targetOnHand: 5, targetReorderPoint: 50,
    });
    // Fully restocked elsewhere after generation — live deficit becomes exactly 0.
    await rig.asAdmin((c: any) => c.query(
      `UPDATE warehouse_stock SET on_hand_quantity = 50 WHERE id = $1`, [tgtStockId],
    ));
    await expect(draft(IA_C, suggestionId, 'DOC-148LB-4B')).rejects.toThrow(/no_target_shortfall/);
    await rig.asAdmin(async (c: any) => {
      const s = (await c.query(`SELECT status FROM inventory_transfer_suggestions WHERE id=$1`, [suggestionId])).rows[0];
      expect(s.status).toBe('open');
    });
  });

  it('5. surplus distributed across two batches is aggregated correctly', async () => {
    const sci = `LB Med multi batch aggregate`;
    const batch1 = randomUUID();
    const batch2 = randomUUID();
    const tgtStockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      // Two separate batch rows for the SAME material at the SAME warehouse.
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
           has_no_national_code, has_no_batch_number, batch_number, expiry_date,
           on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,$4,true,false,'B148LB-agg-1',current_date+200,40,0,1),
                ($5,$2,$3,$4,true,false,'B148LB-agg-2',current_date+400,40,0,1)`,
        [batch1, ORG_C, WH_C, sci, batch2],
      );
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
           has_no_national_code, has_no_batch_number, batch_number, expiry_date,
           on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,$4,true,false,'B148LB-agg-tgt',current_date+365,0,0,1)`,
        [tgtStockId, ORG_I, WH_I, sci],
      );
      // target_max=50 -> aggregate headroom = 80 - 50 = 30.
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, target_max, is_active)
         VALUES ($1,'warehouse',$2,$3,50,true)`,
        [ORG_C, WH_C, sci],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, reorder_point, is_active)
         VALUES ($1,'warehouse',$2,$3,60,true)`,
        [ORG_I, WH_I, sci],
      );
    });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_C]);
    }, { commit: true });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_I]);
    }, { commit: true });
    let suggestionId: string;
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_suggest_cross_org_inventory_transfer($1,$2,$3,$4,$5,NULL)`, [ORG_C, WH_C, ORG_I, WH_I, sci]);
      const r = await c.query(
        `SELECT id FROM inventory_transfer_suggestions
         WHERE source_organization_id=$1 AND target_organization_id=$2 AND scientific_name=$3 AND status='open'
         ORDER BY created_at DESC LIMIT 1`,
        [ORG_C, ORG_I, sci],
      );
      suggestionId = r.rows[0]?.id;
    }, { commit: true });
    expect(suggestionId!).toBeTruthy();

    const result = await draft(IA_C, suggestionId!, 'DOC-148LB-5');
    expect(result.ok).toBe(true);
    // Aggregate headroom (30, both batches summed) binds — neither single
    // batch (40 each) is the constraint, and deficit (60) is not either.
    expect(result.quantity).toBe(30);
  });

  it('6. the actual withdrawal capacity stays bounded by the SPECIFIC batch chosen, even when the AGGREGATE surplus is still ample', async () => {
    const sci = `LB Med batch cap`;
    const chosenBatch = randomUUID();
    const otherBatch = randomUUID();
    await rig.asAdmin(async (c: any) => {
      // Two batches. FEFO (earliest expiry) picks chosenBatch for the
      // suggestion; otherBatch is untouched by generation (the shortfall is
      // small enough to be satisfied by chosenBatch alone).
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
           has_no_national_code, has_no_batch_number, batch_number, expiry_date,
           on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,$4,true,false,'B148LB-cap-chosen',current_date+30,50,0,1),
                ($5,$2,$3,$4,true,false,'B148LB-cap-other',current_date+400,100,0,1)`,
        [chosenBatch, ORG_C, WH_C, sci, otherBatch],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, target_max, is_active)
         VALUES ($1,'warehouse',$2,$3,0,true)`,
        [ORG_C, WH_C, sci],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, reorder_point, is_active)
         VALUES ($1,'warehouse',$2,$3,40,true)`,
        [ORG_I, WH_I, sci],
      );
    });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_C]);
    }, { commit: true });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_I]);
    }, { commit: true });
    let suggestionId: string;
    let chosenSourceStockId: string;
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_suggest_cross_org_inventory_transfer($1,$2,$3,$4,$5,NULL)`, [ORG_C, WH_C, ORG_I, WH_I, sci]);
      const r = await c.query(
        `SELECT id, source_stock_id FROM inventory_transfer_suggestions
         WHERE source_organization_id=$1 AND target_organization_id=$2 AND scientific_name=$3 AND status='open'
         ORDER BY created_at DESC LIMIT 1`,
        [ORG_C, ORG_I, sci],
      );
      suggestionId = r.rows[0]?.id;
      chosenSourceStockId = r.rows[0]?.source_stock_id;
    }, { commit: true });
    expect(suggestionId!).toBeTruthy();
    expect(chosenSourceStockId!).toBe(chosenBatch); // FEFO: earliest expiry chosen
    // Generation-time: suggested_quantity = min(headroom 150, shortfall 40, chosenBatch 50) = 40.

    // A REAL withdrawal against the CHOSEN batch specifically, after
    // generation, before drafting — otherBatch is untouched.
    await rig.asAdmin((c: any) => c.query(
      `UPDATE warehouse_stock SET on_hand_quantity = 15 WHERE id = $1`, [chosenBatch],
    ));

    const result = await draft(IA_C, suggestionId!, 'DOC-148LB-6');
    expect(result.ok).toBe(true);
    // live aggregate headroom = (15 + 100) - 0 = 115 (still huge); live
    // deficit = 40 (unchanged) — neither binds. The chosen batch's own
    // shrunken remaining capacity (15) is the true binding constraint.
    expect(result.quantity).toBe(15);
  });

  it('7. no target stock row at all is treated as zero, safely (no crash, deficit = full reorder_point)', async () => {
    const sci = `LB Med no target row`;
    const srcStockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
           has_no_national_code, has_no_batch_number, batch_number, expiry_date,
           on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,$4,true,false,'B148LB-notgt-src',current_date+365,100,0,1)`,
        [srcStockId, ORG_C, WH_C, sci],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, target_max, is_active)
         VALUES ($1,'warehouse',$2,$3,10,true)`,
        [ORG_C, WH_C, sci],
      );
      // Target threshold exists, but NO warehouse_stock row for it at all.
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, reorder_point, is_active)
         VALUES ($1,'warehouse',$2,$3,30,true)`,
        [ORG_I, WH_I, sci],
      );
    });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_C]);
    }, { commit: true });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_I]);
    }, { commit: true });
    let suggestionId: string;
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_suggest_cross_org_inventory_transfer($1,$2,$3,$4,$5,NULL)`, [ORG_C, WH_C, ORG_I, WH_I, sci]);
      const r = await c.query(
        `SELECT id FROM inventory_transfer_suggestions
         WHERE source_organization_id=$1 AND target_organization_id=$2 AND scientific_name=$3 AND status='open'
         ORDER BY created_at DESC LIMIT 1`,
        [ORG_C, ORG_I, sci],
      );
      suggestionId = r.rows[0]?.id;
    }, { commit: true });
    expect(suggestionId!).toBeTruthy();

    const result = await draft(IA_C, suggestionId!, 'DOC-148LB-7');
    expect(result.ok).toBe(true);
    // live target available = 0 (no rows) -> deficit = 30 - 0 = 30;
    // headroom = 100 - 10 = 90; batch = 100 -> eligible = 30.
    expect(result.quantity).toBe(30);
  });

  it('8. a scope that does not belong to the claimed organization is refused by the live-position helper', async () => {
    await expect(
      rig.asAdmin((c: any) => c.query(
        `SELECT public._phoenix_live_suggestion_scope_position($1,'warehouse',$2,$3,NULL)`,
        [ORG_I, WH_C, 'LB Med scope mismatch'], // WH_C belongs to ORG_C, not ORG_I
      )),
    ).rejects.toThrow(/scope_not_in_organization/);
  });

  it('9. two Drafts for the same material on two DIFFERENT batches never jointly exceed the live aggregated surplus', async () => {
    const sci = `LB Med two suggestions`;
    const batch1 = randomUUID();
    const batch2 = randomUUID();
    await rig.asAdmin(async (c: any) => {
      // Two EQUAL, fully-committable batches (15 each), target_max=0 ->
      // aggregate headroom = 30 at generation time. Two separate targets,
      // each needing exactly 15 — batch1 (earlier expiry) fully covers
      // ORG_I's suggestion, which leaves batch1 with zero remaining, so
      // ORG_I2's suggestion is forced onto batch2 (the ONLY generation
      // engine rule exercised here is its own existing FEFO/remaining-
      // capacity logic, unchanged and untouched by this migration).
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
           has_no_national_code, has_no_batch_number, batch_number, expiry_date,
           on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,$4,true,false,'B148LB-two-1',current_date+200,15,0,1),
                ($5,$2,$3,$4,true,false,'B148LB-two-2',current_date+400,15,0,1)`,
        [batch1, ORG_C, WH_C, sci, batch2],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, target_max, is_active)
         VALUES ($1,'warehouse',$2,$3,0,true)`,
        [ORG_C, WH_C, sci],
      );
      for (const [org, wh] of [[ORG_I, WH_I], [ORG_I2, WH_I2]] as const) {
        await c.query(
          `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, reorder_point, is_active)
           VALUES ($1,'warehouse',$2,$3,15,true)`,
          [org, wh, sci],
        );
      }
    });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_C]);
    }, { commit: true });
    for (const org of [ORG_I, ORG_I2]) {
      await rig.asUser(rig.superAdminId, async (c: any) => {
        await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [org]);
      }, { commit: true });
    }
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_suggest_cross_org_inventory_transfer($1,$2,$3,$4,$5,NULL)`, [ORG_C, WH_C, ORG_I, WH_I, sci]);
    }, { commit: true });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_suggest_cross_org_inventory_transfer($1,$2,$3,$4,$5,NULL)`, [ORG_C, WH_C, ORG_I2, WH_I2, sci]);
    }, { commit: true });

    const suggestions: { id: string; source_stock_id: string; target_organization_id: string }[] = [];
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT id, source_stock_id, target_organization_id FROM inventory_transfer_suggestions
         WHERE source_organization_id=$1 AND scientific_name=$2 AND status='open'
         ORDER BY target_organization_id`,
        [ORG_C, sci],
      );
      expect(r.rows.length).toBe(2);
      expect(new Set(r.rows.map((x: any) => x.source_stock_id)).size).toBe(2); // two DIFFERENT batches
      suggestions.push(...r.rows);
    });
    const first = suggestions.find((s) => s.target_organization_id === ORG_I)!;
    const second = suggestions.find((s) => s.target_organization_id === ORG_I2)!;
    expect(first.source_stock_id).toBe(batch1);
    expect(second.source_stock_id).toBe(batch2);

    // Draft the first fully (headroom=30, deficit=15, batch1=15 -> eligible=15).
    const r1 = await draft(IA_C, first.id, 'DOC-148LB-9-A');
    expect(r1.ok).toBe(true);
    expect(r1.quantity).toBe(15);

    // Real policy tightening BEFORE the second draft: target_max raised from
    // 0 to 10, shrinking the live aggregate headroom from 30 to 20 — of
    // which 15 is already committed by the first (now 'accepted')
    // suggestion, leaving only 5.
    await rig.asAdmin((c: any) => c.query(
      `UPDATE inventory_signal_thresholds SET target_max = 10
       WHERE organization_id = $1 AND scope_kind='warehouse' AND scope_id = $2 AND lower(scientific_name) = lower($3)`,
      [ORG_C, WH_C, sci],
    ));

    const r2 = await draft(IA_C, second.id, 'DOC-148LB-9-B');
    expect(r2.ok).toBe(true);
    // Capped to 5, NOT the nominal 15 generation minted — the live aggregate
    // check (subtracting the first, now-accepted suggestion) binds.
    expect(r2.quantity).toBe(5);

    expect(r1.quantity + r2.quantity).toBeLessThanOrEqual(20); // the NEW live aggregate headroom
  });

  it('10. FEFO / idempotency / provenance mechanics are unchanged: the FEFO-guarded add-line RPC still records the suggestion id as its request_id', async () => {
    const sci = `LB Med fefo unchanged`;
    const srcStockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
           has_no_national_code, has_no_batch_number, batch_number, expiry_date,
           on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,$4,true,false,'B148LB-fefo-src',current_date+365,60,0,1)`,
        [srcStockId, ORG_I, WH_I, sci],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, target_max, is_active)
         VALUES ($1,'warehouse',$2,$3,10,true)`,
        [ORG_I, WH_I, sci],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, reorder_point, is_active)
         VALUES ($1,'outlet',$2,$3,20,true)`,
        [ORG_I, DP_I, sci],
      );
    });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_I]);
      await c.query(`SELECT public.phoenix_suggest_inventory_transfers($1)`, [ORG_I]);
    }, { commit: true });
    let suggestionId: string;
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT id FROM inventory_transfer_suggestions
         WHERE route_kind='warehouse_to_outlet' AND source_stock_id=$1 AND status='open'
         ORDER BY created_at DESC LIMIT 1`,
        [srcStockId],
      );
      suggestionId = r.rows[0]?.id;
    });
    expect(suggestionId!).toBeTruthy();

    const result = await draft(rig.superAdminId, suggestionId!, 'DOC-148LB-10');
    expect(result.ok).toBe(true);
    expect(result.warehouse_dispatch_id).toBeTruthy();

    await rig.asAdmin(async (c: any) => {
      const dedup = (await c.query(
        `SELECT request_id, dispatch_id FROM phoenix_dispatch_line_requests WHERE request_id = $1`,
        [suggestionId],
      )).rows[0];
      expect(dedup).toBeTruthy();
      expect(dedup.dispatch_id).toBe(result.warehouse_dispatch_id);
    });
  });

  it('11. drafting never mutates any stock, movement, or custody table', async () => {
    const sci = `LB Med no side effects`;
    const { suggestionId, srcStockId, tgtStockId } = await seedPair(sci, {
      sourceOnHand: 100, sourceTargetMax: 20, targetOnHand: 5, targetReorderPoint: 50,
    });
    let before: any;
    await rig.asAdmin(async (c: any) => {
      const src = (await c.query(`SELECT on_hand_quantity, reserved_quantity FROM warehouse_stock WHERE id=$1`, [srcStockId])).rows[0];
      const tgt = (await c.query(`SELECT on_hand_quantity, reserved_quantity FROM warehouse_stock WHERE id=$1`, [tgtStockId])).rows[0];
      const movementCount = (await c.query(`SELECT count(*)::int AS n FROM warehouse_stock_movements WHERE warehouse_stock_id IN ($1,$2)`, [srcStockId, tgtStockId])).rows[0].n;
      before = { src, tgt, movementCount };
    });

    const result = await draft(IA_C, suggestionId, 'DOC-148LB-11');
    expect(result.ok).toBe(true);

    await rig.asAdmin(async (c: any) => {
      const src = (await c.query(`SELECT on_hand_quantity, reserved_quantity FROM warehouse_stock WHERE id=$1`, [srcStockId])).rows[0];
      const tgt = (await c.query(`SELECT on_hand_quantity, reserved_quantity FROM warehouse_stock WHERE id=$1`, [tgtStockId])).rows[0];
      const movementCount = (await c.query(`SELECT count(*)::int AS n FROM warehouse_stock_movements WHERE warehouse_stock_id IN ($1,$2)`, [srcStockId, tgtStockId])).rows[0].n;
      expect(src).toEqual(before.src);
      expect(tgt).toEqual(before.tgt);
      // warehouse_stock_movements is the actual quantity ledger — drafting
      // must add zero rows there for these specific stock rows.
      // (phoenix_movement_events, by contrast, is a document-LIFECYCLE
      // timeline (081) that legitimately records "draft created" for every
      // successful draft in this file — it is not itself a stock-movement
      // table, so asserting it stays empty here would be testing the wrong
      // invariant.)
      expect(movementCount).toBe(before.movementCount);
    });
  });
});
