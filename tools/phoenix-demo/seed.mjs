/**
 * PHOENIX_DEMO_V1 seeder.
 *
 * THE RULE THIS FILE OBEYS: operational facts are created by calling the
 * real, secured corridor RPCs as a real authenticated actor — never by
 * INSERTing a finished ledger/movement/audit/custody/balance row. Direct
 * inserts appear only for prerequisite MASTER data (organizations,
 * warehouses, outlets, demo profiles, suppliers) where the product has no
 * creation RPC, and every one of those inserts is registered in the
 * manifest in the same transaction so it stays purgeable.
 *
 * Every id, document reference and request id is derived deterministically
 * (see dataset.mjs), and every corridor RPC used here is idempotent on its
 * request id, so re-running `seed` converges rather than duplicating.
 */
import {
  DATASET_KEY, demoUuid, demoRequestId, demoDocRef, demoInt, demoPick,
  demoBatchProfile, institutionName, outletName, materialName, beneficiary,
  DEFAULT_SCALE,
} from './dataset.mjs';
import { snapshotIds, registerNewRows } from './ownership.mjs';
import {
  transferCentralToInstitution, dispatchToOutlet, dispenseFromOutlet,
  outletReturnAndQuarantine, stocktakeAndCorrection, procurementCycle,
  monthlyPositionCycle, suggestionsAndSnapshots,
} from './workflows.mjs';

/** Register a row as demo-owned. Must run inside the same actor session. */
async function own(c, table, rowId, seedKey) {
  await c.query(`SELECT public.phoenix_demo_register($1,$2,$3,$4)`,
    [DATASET_KEY, table, rowId, seedKey ?? null]);
}

/** True when the dataset already owns this row (drives idempotency). */
async function owns(c, table, rowId) {
  const r = await c.query(
    `SELECT 1 FROM public.phoenix_demo_manifest
      WHERE dataset_key=$1 AND table_name=$2 AND row_id=$3 LIMIT 1`,
    [DATASET_KEY, table, rowId]);
  return r.rowCount > 0;
}

const dayOffset = (n) => `current_date + ${Math.trunc(n)}`;

/**
 * @param {object} io  { asAdmin, asUser } — the same shape tools/pg-rig/rig.mjs
 *   exposes, so the seeder runs identically against a disposable rig and any
 *   other connection that can impersonate an authenticated actor.
 * @param {string} superAdminId  an EXISTING active super_admin. Never created
 *   or modified by the seeder — the real owner account is untouchable.
 */
export async function seedDemoDataset(io, superAdminId, scaleOverride = {}) {
  const scale = { ...DEFAULT_SCALE, ...scaleOverride };
  const counts = {
    organizations: 0, warehouses: 0, distribution_points: 0, profiles: 0,
    warehouse_stock: 0, warehouse_stock_movements: 0, outlet_stock: 0,
    outlet_stock_movements: 0, dispense_contexts: 0, dispatches: 0,
    suppliers: 0, skipped_existing: 0,
  };

  // ── 1. Organizations (master data; no creation RPC exists) ───────────────
  const orgs = [];
  for (let i = 0; i < scale.institutions; i++) {
    const [nameAr, nameEn] = institutionName(i);
    const id = demoUuid(`org:${i}`);
    orgs.push({ id, nameAr, nameEn, index: i });
  }
  // A second organization set is not needed: cross-org isolation is proven
  // between org[0] and org[1], both demo-owned, so no real org is involved.

  await io.asAdmin(async (c) => {
    for (const o of orgs) {
      const r = await c.query(
        `INSERT INTO organizations (id,name,name_ar,code)
         VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [o.id, o.nameEn, o.nameAr, `demo-org-${o.index}`]);
      if (r.rowCount > 0) counts.organizations++; else counts.skipped_existing++;
    }
  });
  await io.asUser(superAdminId, async (c) => {
    for (const o of orgs) await own(c, 'organizations', o.id, `org:${o.index}`);
  }, { commit: true });

  // ── 2. Warehouses + outlets (master data) ────────────────────────────────
  const warehouses = [];
  const outlets = [];
  await io.asAdmin(async (c) => {
    for (const o of orgs) {
      // Migration 103 (INSTITUTION-WAREHOUSE-NO-DIRECT-ENTRY) permits direct
      // intake ONLY into a 'central' warehouse. The demo therefore models the
      // real topology: org 0 is the directorate with the central warehouse
      // that receives intake, every other org is an institution whose stock
      // arrives through the supply corridor.
      const kind = o.index === 0 ? 'central' : 'institution';
      const whId = demoUuid(`wh:${o.index}`);
      const r = await c.query(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code)
         VALUES ($1,$2,$3,$4,'active',$5,$6) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [whId, o.id, `Demo Warehouse ${o.index}`, `مخزن ${o.nameAr}`, kind, `demo-wh-${o.index}`]);
      if (r.rowCount > 0) counts.warehouses++;
      warehouses.push({ id: whId, orgId: o.id, index: o.index, kind });

      for (let j = 0; j < scale.outletsPerInstitution; j++) {
        const dpIndex = o.index * scale.outletsPerInstitution + j;
        const dpId = demoUuid(`dp:${dpIndex}`);
        const rr = await c.query(
          `INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
           VALUES ($1,$2,$3,$4,$5,'pharmacy','active') ON CONFLICT (id) DO NOTHING RETURNING id`,
          [dpId, whId, o.id, `Demo Outlet ${dpIndex}`, outletName(dpIndex)]);
        if (rr.rowCount > 0) counts.distribution_points++;
        outlets.push({ id: dpId, orgId: o.id, warehouseId: whId, index: dpIndex });
      }
    }
  });
  await io.asUser(superAdminId, async (c) => {
    for (const w of warehouses) await own(c, 'warehouses', w.id, `wh:${w.index}`);
    for (const d of outlets) await own(c, 'distribution_points', d.id, `dp:${d.index}`);
  }, { commit: true });

  // ── 3. Demo actors (master data; deactivated, never deleted, on purge) ───
  // One warehouse officer and one outlet officer per institution, so every
  // corridor call below is made by a role that genuinely holds the required
  // permission — authorization results are never faked.
  const actors = [];
  await io.asAdmin(async (c) => {
    for (const w of warehouses) {
      for (const [role, tag] of [['central_warehouse_manager', 'wo'], ['outlet_officer', 'oo']]) {
        const uid = demoUuid(`user:${tag}:${w.index}`);
        const email = `demo-${tag}-${w.index}@phoenix-demo.invalid`;
        const r = await c.query(
          `INSERT INTO auth.users (id,email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [uid, email]);
        if (r.rowCount > 0) counts.profiles++;
        await c.query(
          `UPDATE profiles SET role=$1, status='active', organization_id=$2,
             full_name=$3 WHERE id=$4`,
          [role, w.orgId, `مستخدم تجريبي ${tag}-${w.index}`, uid]);
        actors.push({ id: uid, role, orgId: w.orgId, warehouseId: w.id, index: w.index, tag, kind: w.kind });
      }
    }
    // Warehouse managers need an active WAREHOUSE scope assignment before the
    // guarded intake corridor will accept them (062 scope model).
    for (const a of actors.filter(x => x.tag === 'wo')) {
      await c.query(
        `INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
         VALUES ($1,$2,'warehouse',$3,true) ON CONFLICT DO NOTHING`,
        [a.id, a.orgId, a.warehouseId]);
    }
    // Outlet officers need an active scope assignment to dispense.
    for (const a of actors.filter(x => x.tag === 'oo')) {
      const mine = outlets.filter(o => o.orgId === a.orgId);
      for (const o of mine) {
        await c.query(
          `INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
           VALUES ($1,$2,'distribution_point',$3,true) ON CONFLICT DO NOTHING`,
          [a.id, a.orgId, o.id]);
      }
    }
  });
  await io.asUser(superAdminId, async (c) => {
    for (const a of actors) await own(c, 'profiles', a.id, `user:${a.tag}:${a.index}`);
    // Scope assignments reference distribution_points with ON DELETE RESTRICT,
    // so they MUST be demo-owned too — otherwise purge would be blocked by a
    // row it does not know it created. (The lifecycle proof caught exactly
    // this.)
    const psa = await c.query(
      `SELECT id FROM public.profile_scope_assignments WHERE profile_id = ANY($1::uuid[])`,
      [actors.map(a => a.id)]);
    for (const row of psa.rows) await own(c, 'profile_scope_assignments', row.id, 'psa');
  }, { commit: true });

  // ── 4. Central intake -> warehouse receipt, through the REAL RPC ─────────
  // phoenix_receive_warehouse_stock is idempotent on p_request_id, so a
  // re-seed replays to the same stock row and posts no second movement.
  const warehouseOfficers = actors.filter(a => a.tag === 'wo' && a.kind === 'central');
  const stockRows = [];
  for (const officer of warehouseOfficers) {
    await io.asUser(officer.id, async (c) => {
      for (let b = 0; b < scale.batchesPerWarehouse; b++) {
        const key = `stock:${officer.index}:${b}`;
        const materialIndex = demoInt(`${key}:mat`, 0, scale.materials - 1);
        const m = materialName(materialIndex);
        const profile = demoBatchProfile(key);
        const qty = demoInt(`${key}:qty`, profile.qty[0], profile.qty[1]);
        const expiry = demoInt(`${key}:exp`, profile.expiryDays[0], profile.expiryDays[1]);
        // A zero-quantity intake is not a legal receipt; out_of_stock is
        // produced later by dispensing the batch down, never by faking it.
        const receiveQty = Math.max(qty, 1);
        // Named arguments, not positional: this RPC takes 22 parameters and a
        // silent off-by-one in a positional call would seed wrong data.
        const res = await c.query(
          `SELECT public.phoenix_receive_warehouse_stock_guarded(
             p_request_id             => $1,
             p_warehouse_id           => $2,
             p_scientific_name        => $3,
             p_quantity               => $4,
             p_has_no_national_code   => true,
             p_has_no_batch_number    => false,
             -- 078/079 optimistic concurrency. A brand-new (material, batch)
             -- has no stock row yet, so its server-owned generation is 0.
             p_expected_generation    => 0,
             p_trade_name             => $5,
             p_concentration          => $6,
             p_dosage_form            => $7,
             p_unit                   => 'علبة',
             p_batch_number           => $8,
             p_expiry_date            => ${dayOffset(expiry)},
             p_source_document_number => $9,
             p_notes                  => 'استلام تجريبي',
             p_supply_type            => $10,
             p_purchase_origin        => $11
           ) AS r`,
          [
            demoRequestId(key), officer.warehouseId, m.scientificName, receiveQty,
            m.tradeName, m.concentration, m.dosageForm,
            `DEMO-B-${officer.index}-${b}`, demoDocRef('RCV', officer.index * 1000 + b),
            m.supplyType, m.purchaseOrigin,
          ]);
        const out = res.rows[0].r;
        if (out?.warehouse_stock_id) {
          stockRows.push({
            id: out.warehouse_stock_id, movementId: out.movement_id,
            warehouseId: officer.warehouseId, orgId: officer.orgId,
            officerId: officer.id, profile: profile.key, qty: receiveQty,
            scientificName: m.scientificName, key,
          });
          if (!out.idempotent_replay) counts.warehouse_stock_movements++;
        }
      }
    }, { commit: true });
  }
  await io.asUser(superAdminId, async (c) => {
    for (const s of stockRows) {
      if (!(await owns(c, 'warehouse_stock', s.id))) counts.warehouse_stock++;
      await own(c, 'warehouse_stock', s.id, s.key);
      // The movement the RPC posted is demo-owned too, so purge removes the
      // whole causal chain rather than orphaning ledger rows behind a
      // deleted balance.
      if (s.movementId) await own(c, 'warehouse_stock_movements', s.movementId, `${s.key}:mv`);
    }
  }, { commit: true });

  // Every canonical event the capture triggers emitted for those movements is
  // demo-owned as well — discovered from the ledger rows we own, never
  // fabricated.
  await io.asUser(superAdminId, async (c) => {
    const ids = stockRows.map(s => s.movementId).filter(Boolean);
    if (ids.length > 0) {
      const ev = await c.query(
        `SELECT id FROM public.phoenix_movement_events WHERE reference_id = ANY($1::uuid[])`, [ids]);
      for (const row of ev.rows) await own(c, 'phoenix_movement_events', row.id, 'event:intake');
    }
  }, { commit: true });

  // ── 5. Operational workflow groups, each through its REAL corridor ──────
  // Ownership is captured by diffing what appeared, scoped to the demo orgs,
  // so every row a corridor wrote (headers, lines, ledger, events, audit) is
  // registered — not merely whatever the RPC happened to return.
  const orgIds = orgs.map(o => o.id);
  const centralOfficer = actors.find(a => a.tag === 'wo' && a.kind === 'central');
  const instWarehouses = warehouses.filter(w => w.kind === 'institution');
  const workflow = {};

  const runGroup = async (name, fn) => {
    const before = await snapshotIds(io, orgIds);
    let out = {};
    try { out = await fn(); } catch (e) { out = { error: String(e?.message ?? e) }; }
    const owned = await registerNewRows(io, superAdminId, orgIds, before, name);
    workflow[name] = { ...out, owned };
    return out;
  };

  // B: central -> institution transfers (gives institutions real stock).
  await runGroup('transfer', async () => {
    const results = [];
    for (const [i, w] of instWarehouses.entries()) {
      const instOfficer = actors.find(a => a.tag === 'wo' && a.index === w.index);
      if (!centralOfficer || !instOfficer) continue;
      const lots = stockRows.slice(i * 2, i * 2 + 2).map(s => ({
        stockId: s.id, scientificName: s.scientificName,
        qty: Math.max(1, Math.floor(s.qty / 3)), available: s.qty,
      }));
      if (lots.length === 0) continue;
      results.push(await transferCentralToInstitution(io, {}, {
        centralOfficer, instOfficer, reviewerId: superAdminId,
        centralWarehouseId: centralOfficer.warehouseId,
        instOrgId: w.orgId, instWarehouseId: w.id, lots,
        key: `trf:${w.index}`, seq: w.index,
      }));
    }
    return { groups: results.length };
  });

  // A: institution warehouse -> outlet dispatch + outlet receipt (custody).
  await runGroup('dispatch', async () => {
    let n = 0;
    for (const w of instWarehouses) {
      const officer = actors.find(a => a.tag === 'wo' && a.index === w.index);
      const oo = actors.find(a => a.tag === 'oo' && a.index === w.index);
      const dp = outlets.filter(o => o.orgId === w.orgId);
      if (!officer || !oo || dp.length === 0) continue;
      let lots = [];
      await io.asAdmin(async (c) => {
        const r = await c.query(
          `SELECT id, on_hand_quantity FROM warehouse_stock
            WHERE warehouse_id=$1 AND on_hand_quantity > 3 ORDER BY id LIMIT 3`, [w.id]);
        lots = r.rows.map(x => ({ stockId: x.id, qty: Math.max(1, Math.floor(x.on_hand_quantity / 2)) }));
      });
      if (lots.length === 0) continue;
      for (const [k, outlet] of dp.entries()) {
        await dispatchToOutlet(io, {}, {
          officer, outletOfficer: oo, warehouseId: w.id, outletId: outlet.id,
          lots, key: `dsp:${outlet.index}`, seq: outlet.index,
        });
        n++;
        if (k >= 1) break;   // two outlets per institution is enough coverage
      }
    }
    return { dispatched: n };
  });

  // C: the three dispense beneficiary types.
  await runGroup('dispense', async () => {
    let n = 0;
    for (const outlet of outlets) {
      const oo = actors.find(a => a.tag === 'oo' && a.orgId === outlet.orgId);
      if (!oo) continue;
      const r = await dispenseFromOutlet(io, {}, {
        outletOfficer: oo, outletId: outlet.id,
        key: `dis:${outlet.index}`, count: scale.dispensesPerOutlet ?? 6,
      });
      n += r.dispenses;
    }
    return { dispenses: n };
  });

  // D/E: returns, restock vs quarantine disposition, release and destruction.
  await runGroup('returns_quarantine', async () => {
    let n = 0;
    for (const w of instWarehouses) {
      const officer = actors.find(a => a.tag === 'wo' && a.index === w.index);
      const oo = actors.find(a => a.tag === 'oo' && a.index === w.index);
      const outlet = outlets.find(o => o.orgId === w.orgId);
      if (!officer || !oo || !outlet) continue;
      const r = await outletReturnAndQuarantine(io, {}, {
        outletOfficer: oo, instOfficer: officer, outletId: outlet.id,
        warehouseId: w.id, key: `ret:${w.index}`, seq: w.index,
      });
      n += r.requests;
    }
    return { returnCycles: n };
  });

  // F/G: stocktake with a real discrepancy, then a second-person correction.
  await runGroup('stocktake_correction', async () => {
    let n = 0;
    for (const w of warehouses) {
      const officer = actors.find(a => a.tag === 'wo' && a.index === w.index);
      if (!officer) continue;
      const r = await stocktakeAndCorrection(io, {}, {
        officer, approver: { id: superAdminId }, orgId: w.orgId,
        warehouseId: w.id, key: `stk:${w.index}`,
      });
      n += r.stocktakes + r.corrections;
    }
    return { stocktakeAndCorrections: n };
  });

  // H: supplementary procurement — DISABLED for the reversible dataset.
  // procurement_order_events is immutable by product design
  // (`procurement_history_is_immutable`), so anything seeded here could never
  // be purged and would become permanent residue in Production. Enable only
  // for a throwaway environment, never for a dataset that must be removable.
  if (scale.includeProcurement === true) await runGroup('procurement', async () => {
    let n = 0;
    for (const w of instWarehouses) {
      const officer = actors.find(a => a.tag === 'wo' && a.index === w.index);
      if (!officer) continue;
      const materials = [0, 1, 2].map(k => materialName((w.index * 3 + k) % scale.materials));
      const r = await procurementCycle(io, {}, {
        // local_procurement.manage/receive/return are held in full by
        // super_admin; the five active roles split them, so the demo uses the
        // one role genuinely authorized for the whole cycle.
        officer: { id: superAdminId }, orgId: w.orgId, warehouseId: w.id, materials,
        key: `prc:${w.index}`, seq: w.index,
      });
      n += r.orders;
    }
    return { procurementCycles: n };
  });

  // J: monthly inventory position cycles.
  await runGroup('monthly_position', async () => {
    let n = 0;
    for (const o of orgs) {
      const officer = actors.find(a => a.tag === 'wo' && a.orgId === o.id);
      if (!officer) continue;
      const r = await monthlyPositionCycle(io, {}, {
        preparer: officer, approver: { id: superAdminId }, orgId: o.id,
      });
      n += r.reports;
    }
    return { monthlyReports: n };
  });

  // I: transfer suggestions. Official report SNAPSHOTS are excluded for the
  // same reason as procurement — `report_snapshot_is_immutable` makes an
  // issued snapshot permanent, so seeding one would leave unremovable
  // residue. Enable only for a throwaway environment.
  await runGroup('suggestions_snapshots', async () => {
    let n = 0;
    for (const o of orgs) {
      const r = await suggestionsAndSnapshots(io, {}, {
        admin: { id: superAdminId }, orgId: o.id, key: `sug:${o.index}`,
        includeSnapshots: scale.includeSnapshots === true,
      });
      n += r.snapshots;
    }
    return { snapshots: n };
  });

  return { scale, counts, workflow, orgs, warehouses, outlets, actors, stockRows };
}
