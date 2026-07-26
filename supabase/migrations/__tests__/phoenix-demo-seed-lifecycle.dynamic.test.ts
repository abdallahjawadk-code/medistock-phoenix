/**
 * PHOENIX_DEMO_V1 — seed/verify/purge LIFECYCLE proof against a real
 * disposable Postgres with the full migration chain applied.
 *
 * This is the proof the mission requires before Production is ever touched:
 *   1. seed succeeds through the REAL corridor RPCs;
 *   2. a second seed is idempotent — no duplicate rows, balances unchanged;
 *   3. balances reconcile with the canonical ledger (before + delta = after,
 *      and the ledger's net delta equals the stock row's on-hand);
 *   4. no negative quantities, no orphan references;
 *   5. reporting reads (138's ledger report) actually return the seeded rows;
 *   6. purge --dry-run reports the exact impact it will have;
 *   7. purge --execute removes the demo dataset and NOTHING else;
 *   8. verification finds zero purgeable residue;
 *   9. a clean reseed after purge succeeds.
 *
 * Scale is deliberately small here (a complete scenario pack, not the full
 * production volume) so the lifecycle is proven fast and deterministically;
 * the same code path scales by parameter.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { seedDemoDataset } from '../../../tools/phoenix-demo/seed.mjs';
import { DATASET_KEY } from '../../../tools/phoenix-demo/dataset.mjs';

const run = rigAvailable() ? describe : describe.skip;

const REAL_ORG = '00000000-0000-0000-0000-0000000d0001';
const REAL_SA = '00000000-0000-0000-0000-0000000d0401';

/** The closed reason_code vocabulary from migration 125. */
const VOCAB = [
  'received', 'transferred', 'dispensed', 'counted', 'corrected', 'released',
  'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged', 'recalled',
  'quality_issue', 'temperature_excursion', 'other', 'legacy_unclassified',
];

const SCALE = { institutions: 2, outletsPerInstitution: 2, materials: 20, batchesPerWarehouse: 6 };

run('PHOENIX_DEMO_V1 seed/verify/purge lifecycle (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let io: { asAdmin: any; asUser: any };

  const summary = async () => {
    let rows: any[] = [];
    await rig.asUser(REAL_SA, async (c: any) => {
      rows = await c.query(`SELECT * FROM public.phoenix_demo_manifest_summary($1)`, [DATASET_KEY])
        .then((r: any) => r.rows);
    });
    return rows;
  };
  const countOf = (rows: any[], table: string) =>
    Number(rows.find(r => r.table_name === table)?.row_count ?? 0);

  const purge = async (dryRun: boolean) => {
    let rows: any[] = [];
    await rig.asUser(REAL_SA, async (c: any) => {
      rows = await c.query(`SELECT * FROM public.phoenix_demo_purge($1,$2)`, [DATASET_KEY, dryRun])
        .then((r: any) => r.rows);
    }, { commit: true });
    return rows;
  };

  beforeAll(async () => {
    rig = await buildRig({});
    io = { asAdmin: rig.asAdmin, asUser: rig.asUser };
    await rig.asAdmin(async (c: any) => {
      // A REAL organization and a REAL super_admin that the demo lifecycle
      // must never touch. This is the stand-in for the production owner.
      await c.query(`INSERT INTO organizations (id,name,name_ar,code)
        VALUES ('${REAL_ORG}','Real Production Org','مؤسسة حقيقية','real-prod-org')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${REAL_SA}','real-owner@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='super_admin',status='active',
        organization_id='${REAL_ORG}', full_name='Real Owner' WHERE id='${REAL_SA}';`);
    });
  }, 180000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('1. seed succeeds through the real corridor RPCs and creates a connected dataset', async () => {
    const out = await seedDemoDataset(io, REAL_SA, SCALE);
    expect(out.counts.organizations).toBe(SCALE.institutions);
    expect(out.counts.warehouses).toBe(SCALE.institutions);
    expect(out.counts.distribution_points).toBe(SCALE.institutions * SCALE.outletsPerInstitution);
    // Only the central warehouse (org 0) may receive direct intake (migration 103).
    expect(out.stockRows.length).toBe(SCALE.batchesPerWarehouse);

    const s = await summary();
    expect(countOf(s, 'organizations')).toBe(SCALE.institutions);
    expect(countOf(s, 'warehouse_stock')).toBeGreaterThan(0);
    expect(countOf(s, 'warehouse_stock_movements')).toBeGreaterThan(0);

    // Surface what each workflow group actually produced, so a silently
    // skipped corridor is visible rather than passing as a green no-op.
    // eslint-disable-next-line no-console
    console.log('WORKFLOW GROUPS:', JSON.stringify(out.workflow, null, 1));
  }, 300000);

  it('2. the movements were POSTED by the RPC, not inserted — each carries a real actor, reason_code and reconciling quantities', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT m.reason_code, m.on_hand_before, m.on_hand_delta, m.on_hand_after,
                m.actor_id, m.actor_role, m.source_document_number
           FROM warehouse_stock_movements m
           JOIN phoenix_demo_manifest d
             ON d.row_id = m.id AND d.table_name='warehouse_stock_movements' AND d.dataset_key=$1`,
        [DATASET_KEY]);
      expect(r.rows.length).toBeGreaterThan(0);
      for (const row of r.rows) {
        expect(row.on_hand_before + row.on_hand_delta).toBe(row.on_hand_after);
        expect(row.actor_id).not.toBeNull();          // a real authenticated actor
        expect(row.actor_role).not.toBeNull();
        // Set by the corridor RPC, never by the seeder. Several workflow
        // groups now post movements, so the assertion is that every code is
        // inside the closed 125 vocabulary — not that they are all intake.
        expect(VOCAB).toContain(row.reason_code);
      }
    });
  });

  it('3. balances reconcile: each stock row on-hand equals the net delta of its own ledger rows', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT s.id, s.on_hand_quantity,
                COALESCE((SELECT sum(m.on_hand_delta) FROM warehouse_stock_movements m
                           WHERE m.warehouse_stock_id = s.id), 0) AS net
           FROM warehouse_stock s
           JOIN phoenix_demo_manifest d
             ON d.row_id = s.id AND d.table_name='warehouse_stock' AND d.dataset_key=$1`,
        [DATASET_KEY]);
      expect(r.rows.length).toBeGreaterThan(0);
      for (const row of r.rows) {
        expect(Number(row.on_hand_quantity)).toBe(Number(row.net));
      }
    });
  });

  it('4. no negative quantities and no orphan references anywhere in the demo dataset', async () => {
    await rig.asAdmin(async (c: any) => {
      const neg = await c.query(
        `SELECT count(*)::int AS n FROM warehouse_stock s
           JOIN phoenix_demo_manifest d ON d.row_id=s.id AND d.table_name='warehouse_stock' AND d.dataset_key=$1
          WHERE s.on_hand_quantity < 0 OR s.reserved_quantity < 0`, [DATASET_KEY]);
      expect(neg.rows[0].n).toBe(0);

      const orphanStock = await c.query(
        `SELECT count(*)::int AS n FROM warehouse_stock s
           JOIN phoenix_demo_manifest d ON d.row_id=s.id AND d.table_name='warehouse_stock' AND d.dataset_key=$1
      LEFT JOIN warehouses w ON w.id = s.warehouse_id
          WHERE w.id IS NULL`, [DATASET_KEY]);
      expect(orphanStock.rows[0].n).toBe(0);

      const orphanMv = await c.query(
        `SELECT count(*)::int AS n FROM warehouse_stock_movements m
           JOIN phoenix_demo_manifest d ON d.row_id=m.id AND d.table_name='warehouse_stock_movements' AND d.dataset_key=$1
      LEFT JOIN warehouse_stock s ON s.id = m.warehouse_stock_id
          WHERE s.id IS NULL`, [DATASET_KEY]);
      expect(orphanMv.rows[0].n).toBe(0);
    });
  });

  it('5. the canonical reporting RPC actually returns the seeded rows (reports are populated, not empty)', async () => {
    let orgId = '';
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT row_id FROM phoenix_demo_manifest WHERE dataset_key=$1 AND table_name='organizations'
          ORDER BY seed_key LIMIT 1`, [DATASET_KEY]);
      orgId = r.rows[0].row_id;
    });
    // super_admin can read any org's report.
    await rig.asUser(REAL_SA, async (c: any) => {
      const r = await c.query(
        `SELECT * FROM public.phoenix_movement_ledger_report(
           $1, NULL, NULL, 'warehouse', NULL, NULL, NULL, NULL, 200, 0)`, [orgId]);
      expect(r.rows.length).toBeGreaterThan(0);
      expect(Number(r.rows[0].total_count)).toBeGreaterThan(0);
      for (const row of r.rows) {
        expect(VOCAB).toContain(row.reason_code);
        expect(row.quantity_before + row.quantity_delta).toBe(row.quantity_after);
      }
    });
  });

  it('6. a SECOND seed is idempotent — no duplicate rows and balances are unchanged', async () => {
    const before = await summary();
    let balancesBefore: any[] = [];
    await rig.asAdmin(async (c: any) => {
      balancesBefore = await c.query(
        `SELECT s.id, s.on_hand_quantity FROM warehouse_stock s
           JOIN phoenix_demo_manifest d ON d.row_id=s.id AND d.table_name='warehouse_stock' AND d.dataset_key=$1
          ORDER BY s.id`, [DATASET_KEY]).then((r: any) => r.rows);
    });

    await seedDemoDataset(io, REAL_SA, SCALE);

    const after = await summary();
    for (const table of ['organizations', 'warehouses', 'distribution_points',
                         'warehouse_stock', 'warehouse_stock_movements']) {
      expect(countOf(after, table)).toBe(countOf(before, table));
    }
    let balancesAfter: any[] = [];
    await rig.asAdmin(async (c: any) => {
      balancesAfter = await c.query(
        `SELECT s.id, s.on_hand_quantity FROM warehouse_stock s
           JOIN phoenix_demo_manifest d ON d.row_id=s.id AND d.table_name='warehouse_stock' AND d.dataset_key=$1
          ORDER BY s.id`, [DATASET_KEY]).then((r: any) => r.rows);
    });
    expect(balancesAfter).toEqual(balancesBefore);
  }, 180000);

  it('7. purge --dry-run reports the exact impact and changes nothing', async () => {
    const before = await summary();
    const dry = await purge(true);
    expect(dry.length).toBeGreaterThan(0);
    expect(dry.every(r => r.executed === false)).toBe(true);
    // Every purgeable table's dry-run count equals what the manifest owns.
    for (const row of dry) {
      if (row.table_name === 'profiles') continue;  // not purgeable
      expect(Number(row.affected)).toBe(countOf(before, row.table_name));
    }
    const after = await summary();
    expect(after).toEqual(before);
  });

  it('8. purge --execute removes the demo dataset and leaves the real org and owner untouched', async () => {
    const exec = await purge(false);
    expect(exec.some(r => r.executed === true)).toBe(true);

    await rig.asAdmin(async (c: any) => {
      const org = await c.query(`SELECT count(*)::int AS n FROM organizations WHERE id=$1`, [REAL_ORG]);
      expect(org.rows[0].n).toBe(1);                      // real org survives
      const sa = await c.query(
        `SELECT role, status FROM profiles WHERE id=$1`, [REAL_SA]);
      expect(sa.rows[0].role).toBe('super_admin');        // owner untouched
      expect(sa.rows[0].status).toBe('active');

      const demoOrgs = await c.query(
        `SELECT count(*)::int AS n FROM organizations WHERE code LIKE 'demo-org-%'`);
      expect(demoOrgs.rows[0].n).toBe(0);                 // demo orgs gone
      const demoStock = await c.query(
        `SELECT count(*)::int AS n FROM warehouse_stock WHERE batch_number LIKE 'DEMO-B-%'`);
      expect(demoStock.rows[0].n).toBe(0);                // demo stock gone
    });
  }, 120000);

  it('9. verification finds zero purgeable residue, and a clean reseed afterwards succeeds', async () => {
    const s = await summary();
    expect(s.filter(r => r.purgeable === true)).toEqual([]);

    const out = await seedDemoDataset(io, REAL_SA, SCALE);
    // Only the central warehouse (org 0) may receive direct intake (migration 103).
    expect(out.stockRows.length).toBe(SCALE.batchesPerWarehouse);
    const after = await summary();
    expect(countOf(after, 'organizations')).toBe(SCALE.institutions);
    expect(countOf(after, 'warehouse_stock')).toBeGreaterThan(0);
  }, 180000);
});
