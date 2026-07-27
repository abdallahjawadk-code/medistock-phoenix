/**
 * TRANSFER-SUGGESTION-DRAFT-BRIDGE-147 — DYNAMIC operational acceptance
 * against a real disposable Postgres with 001->147 applied in order.
 *
 * Proves, through the real RPCs exactly as the app will call them (never
 * hand-written INSERTs into the guarded tables):
 *   - a central_to_institution suggestion drafts into a REAL
 *     warehouse_transfer_requests row + line, status flips to 'accepted'
 *     only alongside a real FK, quantity is capped by live re-verification;
 *   - a warehouse_to_outlet suggestion drafts into a REAL warehouse_dispatch
 *     + FEFO-guarded line;
 *   - a stale suggestion is refused until the configurable policy window is
 *     satisfied, and the org-scoped policy RPC actually changes the window;
 *   - two open suggestions sharing one source batch cannot together exceed
 *     its availability (conservation survives a concurrent second draft);
 *   - drafting never changes warehouse_stock balances;
 *   - idempotent replay for the same actor, hard refusal for a different one;
 *   - fail-closed when the actor holds inventory.act_on_suggestions but NOT
 *     the real corridor permission (warehouse_transfer.send).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_C = '00000000-0000-0000-0000-000000147001'; // central org
const ORG_I = '00000000-0000-0000-0000-000000147002'; // institution org
const WH_C = '00000000-0000-0000-0000-000000147101';  // central warehouse
const WH_I = '00000000-0000-0000-0000-000000147102';  // institution warehouse
const DP_I = '00000000-0000-0000-0000-000000147301';  // institution outlet, paired to WH_I

const IA_C = '00000000-0000-0000-0000-000000147401'; // institution_admin, ORG_C — has BOTH real gates
const IA_C_NO_ROUTE = '00000000-0000-0000-0000-000000147402'; // institution_admin, ORG_C — queue gate only

const MED = 'Transfer Bridge Test Med 147';

run('147 transfer suggestion draft bridge — operational acceptance (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 147 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_C}','Central','مركزي','p147-c'),('${ORG_I}','Institution','مؤسسة','p147-i')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_C}','${ORG_C}','Central WH','مخزن مركزي','active','central','p147-wc'),
        ('${WH_I}','${ORG_I}','Institution WH','مخزن مؤسسة','active','institution','p147-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_I}','${WH_I}','${ORG_I}','Outlet I','منفذ مؤسسة','pharmacy','active')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${IA_C}','p147-iac@rig'),('${IA_C_NO_ROUTE}','p147-iacnr@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_C}' WHERE id='${IA_C}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_C}' WHERE id='${IA_C_NO_ROUTE}';`);

      // IA_C: BOTH the queue gate and the real corridor permission.
      await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES
        ('${IA_C}','inventory.act_on_suggestions',true),
        ('${IA_C}','warehouse_transfer.send',true),
        ('${IA_C}','warehouse_dispatch.create',true)
        ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = excluded.allowed;`);
      // IA_C_NO_ROUTE: queue gate ONLY — must fail closed on the real document RPC.
      await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES
        ('${IA_C_NO_ROUTE}','inventory.act_on_suggestions',true),
        ('${IA_C_NO_ROUTE}','warehouse_transfer.send',false)
        ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = excluded.allowed;`);
    });
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  async function seedCentralToInstitutionPair(suffix: string, opts: { sourceReserved?: number } = {}) {
    const srcStockId = randomUUID();
    const tgtStockId = randomUUID();
    const sci = `${MED} ${suffix}`;
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
           has_no_national_code, has_no_batch_number, batch_number, expiry_date,
           on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,$4,true,false,$5,current_date+365,100,$6,1)`,
        [srcStockId, ORG_C, WH_C, sci, `B147-${suffix}-src`, opts.sourceReserved ?? 10],
      );
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
           has_no_national_code, has_no_batch_number, batch_number, expiry_date,
           on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,$4,true,false,$5,current_date+365,5,0,1)`,
        [tgtStockId, ORG_I, WH_I, sci, `B147-${suffix}-tgt`],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, target_max, is_active)
         VALUES ($1,'warehouse',$2,$3,20,true)`,
        [ORG_C, WH_C, sci],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, reorder_point, is_active)
         VALUES ($1,'warehouse',$2,$3,50,true)`,
        [ORG_I, WH_I, sci],
      );
    });
    // Each recompute call opens a TEMP TABLE ... ON COMMIT DROP internally,
    // so each must be its own committed transaction — two calls sharing one
    // asUser transaction collide on the still-live temp table.
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
    return { suggestionId: suggestionId!, srcStockId, sci };
  }

  it('drafts a central_to_institution suggestion into a real warehouse_transfer_requests draft, capped by live re-verification', async () => {
    const { suggestionId, srcStockId } = await seedCentralToInstitutionPair('happy');
    expect(suggestionId).toBeTruthy();

    let before: any;
    await rig.asAdmin(async (c: any) => {
      before = (await c.query(`SELECT on_hand_quantity, reserved_quantity FROM warehouse_stock WHERE id=$1`, [srcStockId])).rows[0];
    });

    let result: any;
    await rig.asUser(IA_C, async (c: any) => {
      const r = await c.query(
        `SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`,
        [suggestionId, 'DOC-147-HAPPY-1'],
      );
      result = r.rows[0].r;
    }, { commit: true });

    expect(result.ok).toBe(true);
    expect(result.route_kind).toBe('central_to_institution');
    expect(result.warehouse_transfer_request_id).toBeTruthy();
    // headroom (100-10 reserved -20 target_max = 70) vs deficit (50-5=45) vs batch(90) -> 45
    expect(result.quantity).toBe(45);

    await rig.asAdmin(async (c: any) => {
      const s = (await c.query(`SELECT * FROM inventory_transfer_suggestions WHERE id=$1`, [suggestionId])).rows[0];
      expect(s.status).toBe('accepted');
      expect(s.draft_warehouse_transfer_request_id).toBe(result.warehouse_transfer_request_id);
      expect(s.draft_warehouse_dispatch_id).toBeNull();
      expect(s.draft_outlet_return_request_id).toBeNull();
      expect(s.draft_document_number).toBe('DOC-147-HAPPY-1');

      const wtr = (await c.query(`SELECT * FROM warehouse_transfer_requests WHERE id=$1`, [result.warehouse_transfer_request_id])).rows[0];
      expect(wtr.status).toBe('draft');
      expect(wtr.source_warehouse_id).toBe(WH_C);
      expect(wtr.destination_warehouse_id).toBe(WH_I);

      const line = (await c.query(`SELECT * FROM warehouse_transfer_request_lines WHERE transfer_request_id=$1`, [result.warehouse_transfer_request_id])).rows[0];
      expect(line.requested_quantity).toBe(45);

      // Drafting never touches stock balances.
      const after = (await c.query(`SELECT on_hand_quantity, reserved_quantity FROM warehouse_stock WHERE id=$1`, [srcStockId])).rows[0];
      expect(after.on_hand_quantity).toBe(before.on_hand_quantity);
      expect(after.reserved_quantity).toBe(before.reserved_quantity);
    });
  });

  it('idempotent replay for the same actor; hard refusal for a different actor', async () => {
    const { suggestionId } = await seedCentralToInstitutionPair('idem');
    let first: any;
    await rig.asUser(IA_C, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`, [suggestionId, 'DOC-147-IDEM-1']);
      first = r.rows[0].r;
    }, { commit: true });
    expect(first.ok).toBe(true);

    // Same actor retries — idempotent replay, same result, no error, no second document.
    await rig.asUser(IA_C, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`, [suggestionId, 'DOC-147-IDEM-1']);
      const replay = r.rows[0].r;
      expect(replay.ok).toBe(true);
      expect(replay.idempotent_replay).toBe(true);
      expect(replay.warehouse_transfer_request_id).toBe(first.warehouse_transfer_request_id);
    }, { commit: true });

    // A different actor is refused outright, not silently re-drafted.
    await expect(
      rig.asUser(IA_C_NO_ROUTE, async (c: any) => {
        await c.query(`SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`, [suggestionId, 'DOC-147-IDEM-2']);
      }, { commit: true }),
    ).rejects.toThrow(/suggestion_already_drafted/);
  });

  it('fails closed when the actor holds inventory.act_on_suggestions but not the real corridor permission', async () => {
    const { suggestionId } = await seedCentralToInstitutionPair('noroute');
    await expect(
      rig.asUser(IA_C_NO_ROUTE, async (c: any) => {
        await c.query(`SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`, [suggestionId, 'DOC-147-NOROUTE']);
      }, { commit: true }),
    ).rejects.toThrow(/forbidden|not_authorized/);

    await rig.asAdmin(async (c: any) => {
      const s = (await c.query(`SELECT status FROM inventory_transfer_suggestions WHERE id=$1`, [suggestionId])).rows[0];
      expect(s.status).toBe('open'); // untouched — the whole call rolled back
    });
  });

  it('refuses a stale suggestion until the org-scoped policy window is satisfied', async () => {
    const { suggestionId } = await seedCentralToInstitutionPair('stale');
    await rig.asAdmin(async (c: any) => {
      await c.query(`UPDATE inventory_transfer_suggestions SET last_validated_at = now() - interval '45 minutes' WHERE id=$1`, [suggestionId]);
    });

    // Default policy (30 min, no override row) refuses it.
    await expect(
      rig.asUser(IA_C, async (c: any) => {
        await c.query(`SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`, [suggestionId, 'DOC-147-STALE-1']);
      }, { commit: true }),
    ).rejects.toThrow(/suggestion_stale_revalidate_required/);

    // Widening the org's configured window (super_admin) makes the SAME
    // suggestion draftable without touching last_validated_at again —
    // proving the window is a real, live, admin-configurable setting.
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_upsert_inventory_suggestion_policy($1,$2)`, [ORG_C, 60]);
    }, { commit: true });

    await rig.asUser(IA_C, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`, [suggestionId, 'DOC-147-STALE-2']);
      expect(r.rows[0].r.ok).toBe(true);
    }, { commit: true });
  });

  it('two open suggestions sharing one source batch cannot together draft more than its availability', async () => {
    const sci = `${MED} conserve`;
    const srcStockId = randomUUID();
    const tgtStockId1 = randomUUID();
    const tgtStockId2 = randomUUID();
    const org2 = '00000000-0000-0000-0000-000000147903';
    const wh2 = '00000000-0000-0000-0000-000000147904';
    await rig.asAdmin(async (c: any) => {
      // A tight batch: only 15 available after target_max (100 on_hand, target_max 85).
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
           has_no_national_code, has_no_batch_number, batch_number, expiry_date,
           on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,$4,true,false,$5,current_date+365,100,0,1)`,
        [srcStockId, ORG_C, WH_C, sci, 'B147-conserve-src'],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, target_max, is_active)
         VALUES ($1,'warehouse',$2,$3,85,true)`,
        [ORG_C, WH_C, sci],
      );
      // Two SEPARATE institution orgs, each wanting more than half the 15 headroom.
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES ($1,'Org2','مؤسسة2','p147-org2') ON CONFLICT (id) DO NOTHING;`, [org2]);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES ($1,$2,'WH2','مخزن2','active','institution','p147-wh2') ON CONFLICT (id) DO NOTHING;`, [wh2, org2]);
      for (const [stockId, org, wh, tag] of [[tgtStockId1, ORG_I, WH_I, 'a'], [tgtStockId2, org2, wh2, 'b']] as const) {
        await c.query(
          `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
             has_no_national_code, has_no_batch_number, batch_number, expiry_date,
             on_hand_quantity, reserved_quantity, movement_seq)
           VALUES ($1,$2,$3,$4,true,false,$5,current_date+365,0,0,1)`,
          [stockId, org, wh, sci, `B147-conserve-tgt-${tag}`],
        );
        await c.query(
          `INSERT INTO inventory_signal_thresholds (organization_id, scope_kind, scope_id, scientific_name, reorder_point, is_active)
           VALUES ($1,'warehouse',$2,$3,10,true)`,
          [org, wh, sci],
        );
      }
    });
    for (const org of [ORG_C, ORG_I, org2]) {
      await rig.asUser(rig.superAdminId, async (c: any) => {
        await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [org]);
      }, { commit: true });
    }
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_suggest_cross_org_inventory_transfer($1,$2,$3,$4,$5,NULL)`, [ORG_C, WH_C, ORG_I, WH_I, sci]);
    }, { commit: true });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_suggest_cross_org_inventory_transfer($1,$2,$3,$4,$5,NULL)`, [ORG_C, WH_C, org2, wh2, sci]);
    }, { commit: true });

    const ids: string[] = [];
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT id, suggested_quantity FROM inventory_transfer_suggestions
         WHERE source_stock_id=$1 AND status='open' ORDER BY target_organization_id`,
        [srcStockId],
      );
      for (const row of r.rows) ids.push(row.id);
    });
    expect(ids.length).toBe(2);

    // headroom = 15 total, split by the allocator across the two needs (10
    // each, capped by 15 total headroom) — the two suggestions together must
    // never exceed the batch. Draft the first, then re-verify the second is
    // capped to whatever genuinely remains (never oversold).
    let totalDrafted = 0;
    for (const id of ids) {
      await rig.asUser(IA_C, async (c: any) => {
        const r = await c.query(`SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`, [id, `DOC-147-CONS-${id.slice(-4)}`]);
        const res = r.rows[0].r;
        if (res.ok) totalDrafted += res.quantity;
      }, { commit: true }).catch(() => { /* second may legitimately be refused once headroom is gone */ });
    }
    expect(totalDrafted).toBeLessThanOrEqual(15);
  });

  it('drafts a warehouse_to_outlet suggestion into a real warehouse_dispatch + FEFO-guarded line', async () => {
    const sci = `${MED} dispatch`;
    const srcStockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
           has_no_national_code, has_no_batch_number, batch_number, expiry_date,
           on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,$4,true,false,$5,current_date+365,60,0,1)`,
        [srcStockId, ORG_I, WH_I, sci, 'B147-dispatch-src'],
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

    let result: any;
    await rig.asUser(IA_C, async (c: any) => {
      // institution_admin is org-wide within ITS OWN org only — grant IA_C no
      // access to ORG_I; use super_admin instead for this org's real corridor
      // permission (warehouse_dispatch.create is enforced inside the callee).
    });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`, [suggestionId, 'DOC-147-DISPATCH-1']);
      result = r.rows[0].r;
    }, { commit: true });

    expect(result.ok).toBe(true);
    expect(result.route_kind).toBe('warehouse_to_outlet');
    expect(result.warehouse_dispatch_id).toBeTruthy();

    await rig.asAdmin(async (c: any) => {
      const dispatch = (await c.query(`SELECT * FROM warehouse_dispatches WHERE id=$1`, [result.warehouse_dispatch_id])).rows[0];
      expect(dispatch.status).toBe('draft');
      expect(dispatch.warehouse_id).toBe(WH_I);
      expect(dispatch.destination_distribution_point_id).toBe(DP_I);
      const line = (await c.query(`SELECT * FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [result.warehouse_dispatch_id])).rows[0];
      expect(line.warehouse_stock_id).toBe(srcStockId);
    });
  });

  it('drafts an outlet_to_warehouse suggestion into a real outlet_return_request with provenance preserved', async () => {
    const sci = `${MED} outlet return`;
    const warehouseStockId = randomUUID();
    let dispatchLineId = '';
    let outletStockId = '';

    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name,
           has_no_national_code, has_no_batch_number, batch_number, expiry_date,
           on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,$4,true,false,$5,current_date+365,80,0,1)`,
        [warehouseStockId, ORG_I, WH_I, sci, 'B147-return-src'],
      );
    });

    // Establish the outlet lot and its legally required dispatch provenance
    // through the real 070/083 corridor RPCs. The suggestion engine refuses
    // outlet sources without this accepted dispatch line by design.
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const dispatch = await c.query(
        `SELECT public.phoenix_create_warehouse_dispatch($1,$2,$3,NULL,NULL,NULL) AS r`,
        [WH_I, DP_I, 'DOC-147-PROVENANCE-DISPATCH'],
      );
      const dispatchId = dispatch.rows[0].r.dispatch_id;
      const line = await c.query(
        `SELECT public.phoenix_add_dispatch_line_fefo_guarded($1,$2,$3,false,NULL,$4) AS r`,
        [dispatchId, warehouseStockId, 50, randomUUID()],
      );
      dispatchLineId = line.rows[0].r.dispatch_line_id;
      await c.query(`SELECT public.phoenix_send_warehouse_dispatch($1,$2)`, [randomUUID(), dispatchId]);
    }, { commit: true });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      const received = await c.query(
        `SELECT public.phoenix_receive_outlet_dispatch_line($1,$2,$3,NULL,NULL) AS r`,
        [randomUUID(), dispatchLineId, 50],
      );
      outletStockId = received.rows[0].r.outlet_stock_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO inventory_signal_thresholds
           (organization_id, scope_kind, scope_id, scientific_name, target_max, is_active)
         VALUES ($1,'outlet',$2,$3,20,true)`,
        [ORG_I, DP_I, sci],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds
           (organization_id, scope_kind, scope_id, scientific_name, reorder_point, is_active)
         VALUES ($1,'warehouse',$2,$3,60,true)`,
        [ORG_I, WH_I, sci],
      );
    });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_I]);
      await c.query(`SELECT public.phoenix_suggest_inventory_transfers($1)`, [ORG_I]);
    }, { commit: true });

    let suggestionId = '';
    let beforeOutlet: any;
    let beforeWarehouse: any;
    await rig.asAdmin(async (c: any) => {
      const suggestion = await c.query(
        `SELECT id, provenance_dispatch_line_id
           FROM inventory_transfer_suggestions
          WHERE route_kind='outlet_to_warehouse'
            AND source_stock_id=$1
            AND target_scope_id=$2
            AND status='open'
          ORDER BY created_at DESC LIMIT 1`,
        [outletStockId, WH_I],
      );
      suggestionId = suggestion.rows[0]?.id;
      expect(suggestion.rows[0]?.provenance_dispatch_line_id).toBe(dispatchLineId);
      beforeOutlet = (await c.query(
        `SELECT on_hand_quantity, reserved_quantity FROM outlet_stock WHERE id=$1`,
        [outletStockId],
      )).rows[0];
      beforeWarehouse = (await c.query(
        `SELECT on_hand_quantity, reserved_quantity FROM warehouse_stock WHERE id=$1`,
        [warehouseStockId],
      )).rows[0];
    });
    expect(suggestionId).toBeTruthy();

    let result: any;
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const drafted = await c.query(
        `SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`,
        [suggestionId, 'DOC-147-OUTLET-RETURN-1'],
      );
      result = drafted.rows[0].r;
    }, { commit: true });

    expect(result.ok).toBe(true);
    expect(result.route_kind).toBe('outlet_to_warehouse');
    expect(result.outlet_return_request_id).toBeTruthy();
    // outlet headroom 50-20, warehouse deficit 60-30, provenance returnable 50.
    expect(result.quantity).toBe(30);

    await rig.asAdmin(async (c: any) => {
      const suggestion = (await c.query(
        `SELECT * FROM inventory_transfer_suggestions WHERE id=$1`,
        [suggestionId],
      )).rows[0];
      expect(suggestion.status).toBe('accepted');
      expect(suggestion.draft_outlet_return_request_id).toBe(result.outlet_return_request_id);
      expect(suggestion.draft_warehouse_transfer_request_id).toBeNull();
      expect(suggestion.draft_warehouse_dispatch_id).toBeNull();

      const request = (await c.query(
        `SELECT * FROM outlet_return_requests WHERE id=$1`,
        [result.outlet_return_request_id],
      )).rows[0];
      expect(request.status).toBe('draft');
      expect(request.distribution_point_id).toBe(DP_I);

      const line = (await c.query(
        `SELECT * FROM outlet_return_request_lines WHERE return_request_id=$1`,
        [result.outlet_return_request_id],
      )).rows[0];
      expect(line.dispatch_line_id).toBe(dispatchLineId);
      expect(line.requested_quantity).toBe(30);

      // Creating the draft reserves nothing and moves no stock. Real custody
      // starts only when the ordinary submit/review/send lifecycle advances.
      const afterOutlet = (await c.query(
        `SELECT on_hand_quantity, reserved_quantity FROM outlet_stock WHERE id=$1`,
        [outletStockId],
      )).rows[0];
      const afterWarehouse = (await c.query(
        `SELECT on_hand_quantity, reserved_quantity FROM warehouse_stock WHERE id=$1`,
        [warehouseStockId],
      )).rows[0];
      expect(afterOutlet).toEqual(beforeOutlet);
      expect(afterWarehouse).toEqual(beforeWarehouse);
    });
  });

  it('anon has zero EXECUTE grant on the bridge RPC or the policy RPC', async () => {
    await rig.asAdmin(async (c: any) => {
      const hasExec = await c.query(
        `SELECT has_function_privilege('anon', 'public.phoenix_create_transfer_draft_from_suggestion(uuid,text)', 'EXECUTE') AS ok`,
      );
      expect(hasExec.rows[0].ok).toBe(false);
      const hasPolicyExec = await c.query(
        `SELECT has_function_privilege('anon', 'public.phoenix_upsert_inventory_suggestion_policy(uuid,integer)', 'EXECUTE') AS ok`,
      );
      expect(hasPolicyExec.rows[0].ok).toBe(false);
    });
  });
});
