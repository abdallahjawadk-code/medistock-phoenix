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

const FIXED_PASSWORD = 'E2eAcceptance!2026';

const USERS = {
  outletOfficerA: { email: 'e2e-outlet-officer-a@phoenix.local', role: 'outlet_officer', org: ORG_A, dp: DP_A },
  institutionAdminA: { email: 'e2e-institution-admin-a@phoenix.local', role: 'institution_admin', org: ORG_A, dp: null },
  outletOfficerB: { email: 'e2e-outlet-officer-b@phoenix.local', role: 'outlet_officer', org: ORG_B, dp: DP_B },
};

async function main() {
  const client = await pool.connect();
  try {
    console.log('Seeding organizations/warehouses/outlets...');
    await client.query(
      `INSERT INTO organizations (id, name, name_ar, code) VALUES
         ($1, 'E2E Hospital A', 'مستشفى أ للاختبار', 'e2e-org-a'),
         ($2, 'E2E Hospital B', 'مستشفى ب للاختبار', 'e2e-org-b')
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B],
    );
    await client.query(
      `INSERT INTO warehouses (id, organization_id, name, name_ar, status, warehouse_kind)
       VALUES ($1, $3, 'E2E Warehouse A', 'مخزن أ', 'active', 'institution'),
              ($2, $4, 'E2E Warehouse B', 'مخزن ب', 'active', 'institution')
       ON CONFLICT (id) DO NOTHING`,
      [WH_A, WH_B, ORG_A, ORG_B],
    );
    await client.query(
      `INSERT INTO distribution_points (id, warehouse_id, organization_id, name, name_ar, point_type, status)
       VALUES ($1, $3, $5, 'E2E Outlet A', 'منفذ أ', 'dispensing', 'active'),
              ($2, $4, $6, 'E2E Outlet B', 'منفذ ب', 'dispensing', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [DP_A, DP_B, WH_A, WH_B, ORG_A, ORG_B],
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

    const summary = {
      orgA: ORG_A, orgB: ORG_B, dpA: DP_A, dpB: DP_B,
      users: Object.fromEntries(Object.entries(USERS).map(([k, u]) => [k, { email: u.email, id: u.id, role: u.role }])),
      password: FIXED_PASSWORD,
      lots: lotIds,
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
