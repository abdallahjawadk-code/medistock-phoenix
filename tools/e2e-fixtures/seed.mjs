#!/usr/bin/env node
/**
 * E2E-AUTHENTICATED-ACCEPTANCE — disposable fixture seed.
 *
 * Seeds a fresh LOCAL Supabase instance (never Production — see the hard
 * guard below) with exactly what the Phase 2 authenticated browser
 * acceptance run needs: two organizations (for cross-org denial), one
 * warehouse + outlet per org, three real Supabase Auth users (real
 * passwords, so Playwright can log in through the actual UI form — not
 * synthetic RPC-level test users like tools/pg-rig/rig.mjs uses), their
 * profile/role/scope rows, and enough outlet_stock lots at org A's outlet
 * to drive one dispense per beneficiary type plus an insufficient-stock
 * case.
 *
 * Reuses the exact organizations/warehouses/distribution_points/profiles/
 * profile_scope_assignments/outlet_stock shape already proven correct by
 * supabase/migrations/__tests__/136-dispense-with-context-atomic.dynamic.test.ts
 * — this is not a new schema guess.
 *
 * Usage: node tools/e2e-fixtures/seed.mjs
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
 * (all must point at a local instance — see the guard below).
 */
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !DATABASE_URL) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DATABASE_URL');
  process.exit(1);
}

// PRODUCTION-SAFETY GUARD: this script writes disposable fixture data
// (organizations, users, stock) and must never be pointed at the real
// Production Supabase project (ref eyrzxgfkvqybjdgyphap) or its database.
// Local Supabase always serves on 127.0.0.1/localhost; Production never does.
for (const [name, value] of [['SUPABASE_URL', SUPABASE_URL], ['DATABASE_URL', DATABASE_URL]]) {
  const isLocal = /127\.0\.0\.1|localhost/.test(value);
  const mentionsProdRef = /eyrzxgfkvqybjdgyphap/.test(value);
  if (!isLocal || mentionsProdRef) {
    console.error(`REFUSING TO SEED: ${name}="${value}" is not a recognized local address, or references the Production project ref. This script only ever writes disposable local fixtures.`);
    process.exit(1);
  }
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const pool = new pg.Pool({ connectionString: DATABASE_URL });

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const WH_A = randomUUID();
const WH_B = randomUUID();
const DP_A = randomUUID();
const DP_B = randomUUID();

// STAGE-E-E7-2: fixtures for the facility/route/initial-provisioning/
// replenishment/reversal lifecycle. ORG_A (hospital) already exists above —
// Shape I of Migrations 164/168 applies: rescue_cart requires a hospital and
// an emergency clinical context, with NO facility layer. CART_A is a second,
// dedicated emergency outlet under WH_A so the replenishment/reversal cycle
// never touches DP_A's own dispense-flow stock from section 1 above.
const CART_A = randomUUID();
const IP_MATERIAL_STOCK_ID = randomUUID();

// A pharmacy_department_authority organization + its central warehouse
// (Migration 171) — seeded directly to validate the organization model
// exists and is queryable; the E7-2 acceptance run additionally creates a
// SECOND authority organization live through the real AddOrgForm (proving
// the createOrganization() regression fix), so this one is a stable fixture
// the acceptance script can read back without depending on that live step.
const ORG_C_AUTHORITY = randomUUID();
const WH_C_CENTRAL = randomUUID();

const FIXED_PASSWORD = 'E2eAcceptance!2026';

const USERS = {
  outletOfficerA: { email: 'e2e-outlet-officer-a@phoenix.local', role: 'outlet_officer', org: ORG_A, dp: DP_A },
  institutionAdminA: { email: 'e2e-institution-admin-a@phoenix.local', role: 'institution_admin', org: ORG_A, dp: null },
  outletOfficerB: { email: 'e2e-outlet-officer-b@phoenix.local', role: 'outlet_officer', org: ORG_B, dp: DP_B },
  fixtureAdmin: { email: 'e2e-fixture-admin@phoenix.local', role: 'super_admin', org: ORG_A, dp: null },
};

async function asAuthenticated(userId, fn) {
  const actor = await pool.connect();
  try {
    await actor.query('BEGIN');
    await actor.query('SET LOCAL ROLE authenticated');
    await actor.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    const result = await fn(actor);
    await actor.query('COMMIT');
    return result;
  } catch (error) {
    await actor.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    actor.release();
  }
}

async function main() {
  const client = await pool.connect();
  try {
    console.log('Seeding organizations/warehouses/outlets...');
    // STAGE-E-E7-2: organization_kind is written explicitly (Migration 171) —
    // 'care_institution' here, matching what the real AddOrgForm now always
    // sends. institution_class is unchanged from before.
    await client.query(
      `INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
         ($1, 'E2E Hospital A', 'مستشفى أ للاختبار', 'e2e-org-a', 'care_institution', 'hospital'),
         ($2, 'E2E Hospital B', 'مستشفى ب للاختبار', 'e2e-org-b', 'care_institution', 'hospital'),
         ($3, 'E2E Pharmacy Department', 'قسم الصيدلة للاختبار', 'e2e-org-c-authority', 'pharmacy_department_authority', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B, ORG_C_AUTHORITY],
    );
    await client.query(
      `INSERT INTO warehouses (id, organization_id, name, name_ar, status, warehouse_kind)
       VALUES ($1, $3, 'E2E Warehouse A', 'مخزن أ', 'active', 'institution'),
              ($2, $4, 'E2E Warehouse B', 'مخزن ب', 'active', 'institution'),
              ($5, $6, 'E2E Central Pharmacy Warehouse', 'مخزن الصيدلة المركزي', 'active', 'central')
       ON CONFLICT (id) DO NOTHING`,
      [WH_A, WH_B, ORG_A, ORG_B, WH_C_CENTRAL, ORG_C_AUTHORITY],
    );
    await client.query(
      // point_type must be 'pharmacy' here, matching the outlet_stock rows
      // seeded below: outlet_stock_dp_type_fk is a composite FK on
      // (distribution_point_id, point_type) referencing
      // distribution_points(id, point_type) — both sides must agree, exactly
      // as 136-dispense-with-context-atomic.dynamic.test.ts's own seedLot()
      // helper already does.
      //
      // STAGE-E-E7-2: DP_A carries clinical_location_kind='non_emergency' (a
      // pharmacy is never itself an emergency location) and CART_A is a
      // SEPARATE rescue_cart outlet under the same hospital warehouse —
      // Shape I (Migrations 164/168): hospital + rescue_cart requires
      // clinical_location_kind='emergency', no facility layer at all. Kept
      // apart from DP_A so the replenishment/reversal cycle below never
      // touches DP_A's own dispense-flow stock from section 1.
      `INSERT INTO distribution_points (id, warehouse_id, organization_id, name, name_ar, point_type, status, clinical_location_kind)
       VALUES ($1, $3, $5, 'E2E Outlet A', 'منفذ أ', 'pharmacy', 'active', 'non_emergency'),
              ($2, $4, $6, 'E2E Outlet B', 'منفذ ب', 'pharmacy', 'active', 'non_emergency'),
              ($7, $3, $5, 'E2E Rescue Cart A', 'عربة إنقاذ أ', 'rescue_cart', 'active', 'emergency')
       ON CONFLICT (id) DO NOTHING`,
      [DP_A, DP_B, WH_A, WH_B, ORG_A, ORG_B, CART_A],
    );
    // STAGE-E-E7-2: a warehouse_stock lot at WH_A for the initial-provisioning
    // dispatch composer's FEFO material picker — a real, selectable batch,
    // not a synthetic placeholder.
    await client.query(
      `INSERT INTO warehouse_stock(
         id, organization_id, warehouse_id, scientific_name, concentration, dosage_form, unit,
         has_no_national_code, batch_number, has_no_batch_number, expiry_date,
         on_hand_quantity, reserved_quantity, movement_seq
       ) VALUES ($1, $2, $3, 'E2E Initial Provisioning Material', '5 mg', 'ampoule', 'box',
                 true, 'E2E-IP-001', false, current_date + 365, 20, 0, 1)
       ON CONFLICT (id) DO NOTHING`,
      [IP_MATERIAL_STOCK_ID, ORG_A, WH_A],
    );

    console.log('Creating real Supabase Auth users (real passwords, real UI login)...');
    for (const [key, u] of Object.entries(USERS)) {
      const { data, error } = await admin.auth.admin.createUser({
        email: u.email,
        password: FIXED_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: u.email, role: u.role },
      });
      if (error && !/already been registered/i.test(error.message)) throw error;
      let userId = data?.user?.id;
      if (!userId) {
        const { data: list } = await admin.auth.admin.listUsers();
        userId = list.users.find(x => x.email === u.email)?.id;
      }
      if (!userId) throw new Error(`could not resolve user id for ${u.email}`);
      USERS[key].id = userId;

      await client.query(
        `UPDATE profiles SET role = $2, status = 'active', organization_id = $3 WHERE id = $1`,
        [userId, u.role, u.org],
      );
      if (u.dp) {
        await client.query(
          `INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
           VALUES ($1, $2, 'distribution_point', $3, true)
           ON CONFLICT DO NOTHING`,
          [userId, u.org, u.dp],
        );
      }
      console.log(`  ${key}: ${u.email} / role=${u.role} / id=${userId}`);
    }

    console.log('Seeding outlet_stock lots at org A\'s outlet (patient / crash_cart / internal_order / insufficient-stock)...');
    const lots = [
      { scientific_name: 'E2E Paracetamol 500mg', qty: 50 },
      { scientific_name: 'E2E Amoxicillin 250mg', qty: 40 },
      { scientific_name: 'E2E Ibuprofen 400mg', qty: 30 },
      { scientific_name: 'E2E Insulin (low stock)', qty: 2 },
    ];
    const lotIds = {};
    for (const lot of lots) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type,
           scientific_name, has_no_national_code, has_no_batch_number, batch_number,
           expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1, $2, $3, 'pharmacy', $4, true, false, $5, current_date + 365, $6, 0, 1)`,
        [id, ORG_A, DP_A, lot.scientific_name, `E2E-${id.slice(0, 8)}`, lot.qty],
      );
      lotIds[lot.scientific_name] = id;
      console.log(`  lot: ${lot.scientific_name} qty=${lot.qty} id=${id}`);
    }

    console.log('Seeding a real outlet-return suggestion with dispatch provenance...');
    const suggestionWarehouseStockId = randomUUID();
    const suggestionMaterial = 'E2E Phase 8 Return Material';
    const suggestionNationalCode = 'E2E-PHASE8-RETURN';
    await client.query(
      `INSERT INTO warehouse_stock(
         id,organization_id,warehouse_id,scientific_name,concentration,dosage_form,unit,
         national_code,has_no_national_code,batch_number,has_no_batch_number,expiry_date,
         on_hand_quantity,reserved_quantity,movement_seq
       ) VALUES($1,$2,$3,$4,'10 mg','tablet','box',$5,false,'E2E-P8-SRC',false,current_date+365,80,0,1)`,
      [suggestionWarehouseStockId, ORG_A, WH_A, suggestionMaterial, suggestionNationalCode],
    );

    let dispatchLineId;
    let suggestionOutletStockId;
    await asAuthenticated(USERS.fixtureAdmin.id, async actor => {
      const dispatch = (await actor.query(
        `SELECT public.phoenix_create_warehouse_dispatch($1,$2,$3,NULL,NULL,NULL) AS r`,
        [WH_A, DP_A, 'E2E-PHASE8-PROVENANCE'],
      )).rows[0].r;
      dispatchLineId = (await actor.query(
        `SELECT public.phoenix_add_dispatch_line_fefo_guarded($1,$2,50,false,NULL,$3) AS r`,
        [dispatch.dispatch_id, suggestionWarehouseStockId, randomUUID()],
      )).rows[0].r.dispatch_line_id;
      await actor.query(`SELECT public.phoenix_send_warehouse_dispatch($1,$2)`, [
        randomUUID(), dispatch.dispatch_id,
      ]);
    });
    await asAuthenticated(USERS.fixtureAdmin.id, async actor => {
      suggestionOutletStockId = (await actor.query(
        `SELECT public.phoenix_receive_outlet_dispatch_line($1,$2,50,NULL,NULL) AS r`,
        [randomUUID(), dispatchLineId],
      )).rows[0].r.outlet_stock_id;
    });
    await client.query(
      `INSERT INTO inventory_signal_thresholds(
         organization_id,scope_kind,scope_id,scientific_name,national_code,
         reorder_point,target_max,is_active
       ) VALUES
         ($1,'outlet',$2,$3,$4,NULL,20,true),
         ($1,'warehouse',$5,$3,$4,60,NULL,true)`,
      [ORG_A, DP_A, suggestionMaterial, suggestionNationalCode, WH_A],
    );
    let suggestionId;
    await asAuthenticated(USERS.fixtureAdmin.id, async actor => {
      await actor.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_A]);
      await actor.query(`SELECT public.phoenix_suggest_inventory_transfers($1)`, [ORG_A]);
      suggestionId = (await actor.query(
        `SELECT id FROM inventory_transfer_suggestions
          WHERE source_stock_id=$1 AND route_kind='outlet_to_warehouse' AND status='open'`,
        [suggestionOutletStockId],
      )).rows[0]?.id;
    });
    if (!suggestionId) throw new Error('could not create Phase 8 outlet-return suggestion');
    console.log(`  Phase 8 suggestion: ${suggestionId}`);

    const summary = {
      orgA: ORG_A, orgB: ORG_B, dpA: DP_A, dpB: DP_B,
      users: Object.fromEntries(Object.entries(USERS).map(([k, u]) => [k, { email: u.email, id: u.id, role: u.role }])),
      password: FIXED_PASSWORD,
      lots: lotIds,
      phase8: {
        suggestionId,
        material: suggestionMaterial,
        sourceStockId: suggestionOutletStockId,
      },
      stageE: {
        cartA: CART_A,
        whA: WH_A,
        ipMaterial: 'E2E Initial Provisioning Material',
        orgCAuthority: ORG_C_AUTHORITY,
        whCCentral: WH_C_CENTRAL,
        replenishSourceLot: 'E2E Ibuprofen 400mg',
      },
    };

    // The fixture password (a fixed, hardcoded, disposable synthetic test
    // credential — not a real secret) still must not appear verbatim in CI
    // job logs. It goes ONLY into the output file the acceptance script
    // reads (never uploaded as an artifact); stdout gets a redacted echo.
    const OUTPUT_PATH = process.env.E2E_SEED_OUTPUT_PATH || 'e2e-seed.json';
    writeFileSync(OUTPUT_PATH, JSON.stringify(summary, null, 2));
    console.log(`\nSeed complete. Fixture summary (password redacted) written to ${OUTPUT_PATH}:`);
    console.log(JSON.stringify({ ...summary, password: '***REDACTED***' }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error('SEED FAILED:', e); process.exit(1); });
