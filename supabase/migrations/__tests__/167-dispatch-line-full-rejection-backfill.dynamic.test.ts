/**
 * 167 · DISPATCH-LINE FULL-REJECTION RECONCILIATION — backfill/upgrade proof.
 *
 * The sibling *.dynamic.test.ts proves the reconciled constraint works on a
 * database built WITH 167. This file proves the other half, which is the half
 * that carries actual data risk: applying 167 to a database that already holds
 * a LEGACY rejected line.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS NEEDS ITS OWN RIG
 * ─────────────────────────────────────────────────────────────────────────────
 * 167 tightens the 'rejected' branch from `received_quantity IS NULL` to
 * `received_quantity IS NOT NULL AND received_quantity = 0`. Those two rules are
 * DISJOINT, which cuts both ways and is why the migration's section order is
 * DROP -> BACKFILL -> ADD rather than the instinctive BACKFILL -> DROP -> ADD:
 *
 *   • a pre-existing NULL-quantity rejected row would violate the NEW rule, so
 *     it must be normalised before the ADD; and
 *   • writing 0 to that row while the OLD rule is still installed violates the
 *     OLD one, so the normalisation cannot happen before the DROP.
 *
 * This file is what establishes that. An earlier draft of 167 backfilled first
 * and aborted here with the very error it exists to remove — invisibly on a
 * fresh database, where the UPDATE matches no rows and nothing is checked.
 *
 * The row cannot be created on a 167 database, by construction: the new
 * constraint forbids it. So the rig is built to 165 — canonical master, the OLD
 * constraint in force — the legacy row is planted there, and 167 is then applied
 * by hand from its own file, exactly as a real upgrade would.
 *
 * The legacy row is planted with a direct UPDATE rather than through the RPC on
 * purpose: the RPC could never produce it (it stores 0 and therefore always
 * aborted pre-167). A NULL-quantity rejected line is precisely the shape that
 * 061's constraint permitted but no writer ever wrote, which is why the backfill
 * exists for completeness rather than for a known population.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 120000 });

const run = rigAvailable() ? describe : describe.skip;

const MIGRATION = '167_phoenix_dispatch_line_full_rejection_reconciliation.sql';
const migrationSql = readFileSync(
  join(__dirname, '..', MIGRATION),
  'utf8',
);

const ORG_CENTRAL = '00000000-0000-0000-0000-000000167a01';
const ORG_INST = '00000000-0000-0000-0000-000000167a02';
const WH_CENTRAL = '00000000-0000-0000-0000-000000167a11';
const WH_INST = '00000000-0000-0000-0000-000000167a12';
const ROUTE = '00000000-0000-0000-0000-000000167a51';
const DP_LEGACY = '00000000-0000-0000-0000-000000167a31';
const DP_UNTOUCHED = '00000000-0000-0000-0000-000000167a32';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

run('167 · applying the reconciliation over a legacy rejected line (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let legacyLineId: string;
  let untouchedLineId: string;
  let legacyDispatchId: string;

  const call = (c: any, fn: string, args: any[]) =>
    c
      .query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  /**
   * Apply the migration file verbatim, as a real upgrade would.
   *
   * The explicit ROLLBACK on failure matters: the file carries its own
   * BEGIN;/COMMIT;, so a raise inside it leaves the pooled connection in an
   * aborted transaction, and rig.asAdmin() releases the client WITHOUT rolling
   * back. Without this, one genuine failure here cascades into
   * "current transaction is aborted" on every later test and hides the real
   * error behind five fake ones.
   */
  const applyMigration = () =>
    rig.asAdmin(async (c: any) => {
      try {
        await c.query(migrationSql);
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch { /* already unwound */ }
        throw e;
      }
    });

  const lineRow = (id: string) =>
    rig
      .asAdmin((c: any) =>
        c.query(
          `SELECT status, sent_quantity, received_quantity, rejection_reason,
                  rejected_at, updated_at
             FROM warehouse_dispatch_lines WHERE id=$1`,
          [id],
        ),
      )
      .then((r: any) => r.rows[0]);

  /** A sent dispatch line, built through the real corridor on the 165 rig. */
  async function sentLine(dp: string, tag: string, qty: number) {
    const stockId = await rig.asUser(
      rig.superAdminId,
      async (c: any) => {
        const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
          randomUUID(), WH_CENTRAL, `P167A-${tag}`, qty, true, true, 0,
          null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
        ]);
        const sent = await call(c, 'phoenix_send_warehouse_transfer_line', [
          randomUUID(), ROUTE, rc.warehouse_stock_id, qty, uniq('WT'), null, null, null,
        ]);
        const got = await call(c, 'phoenix_receive_warehouse_transfer_line', [
          randomUUID(), sent.transfer_line_id, qty, null, null,
        ]);
        return got.warehouse_stock_id as string;
      },
      { commit: true },
    );

    return rig.asUser(
      rig.superAdminId,
      async (c: any) => {
        const created = await call(c, 'phoenix_create_warehouse_dispatch', [
          WH_INST, dp, uniq(tag), null, null, null,
        ]);
        await call(c, 'phoenix_add_dispatch_line', [created.dispatch_id, stockId, qty]);
        await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), created.dispatch_id]);
        const r = await c.query(
          `SELECT id FROM warehouse_dispatch_lines WHERE dispatch_id=$1`,
          [created.dispatch_id],
        );
        return { dispatchId: created.dispatch_id as string, lineId: r.rows[0].id as string };
      },
      { commit: true },
    );
  }

  beforeAll(async () => {
    // Canonical master: 001->165, with 167 NOT applied.
    rig = await buildRig({ upTo: 165 });

    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_CENTRAL}','C167A','مركز','p167a-c'),('${ORG_INST}','I167A','مؤسسة','p167a-i')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH167A','مخزنC','active','central','p167a-wc'),
        ('${WH_INST}','${ORG_INST}','IWH167A','مخزنI','active','institution','p167a-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points
        (id,warehouse_id,organization_id,name,name_ar,point_type,status) VALUES
        ('${DP_LEGACY}','${WH_INST}','${ORG_INST}','Outlet Legacy','منفذ','crash_cabinet','active'),
        ('${DP_UNTOUCHED}','${WH_INST}','${ORG_INST}','Outlet Pending','منفذ','crash_cabinet','active')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution', true)
        ON CONFLICT (id) DO NOTHING;`);
    });

    const legacy = await sentLine(DP_LEGACY, 'LEGACY', 6);
    legacyLineId = legacy.lineId;
    legacyDispatchId = legacy.dispatchId;

    // A second line left PENDING, to prove the backfill's WHERE clause is narrow.
    const untouched = await sentLine(DP_UNTOUCHED, 'PENDING', 5);
    untouchedLineId = untouched.lineId;
  }, 300000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. The baseline really is broken, and really does permit the legacy shape
  // ══════════════════════════════════════════════════════════════════════════

  describe('1. canonical master, before 167', () => {
    it('the RPC cannot reject a line at all — the defect, reproduced', async () => {
      let message = '';
      try {
        await rig.asUser(
          rig.superAdminId,
          (c: any) =>
            call(c, 'phoenix_receive_outlet_dispatch_line', [
              randomUUID(), legacyLineId, 0, '167 baseline probe', null, 'damaged',
            ]),
          { commit: true },
        );
        throw new Error('expected the pre-167 rejection to fail, but it succeeded');
      } catch (e: any) {
        message = String(e?.message ?? e);
      }
      expect(message).toMatch(/warehouse_dispatch_lines_decision_chk/);

      // The failed call left the line untouched.
      expect((await lineRow(legacyLineId)).status).toBe('pending');
    });

    it('but the OLD constraint does permit a NULL-quantity rejected row', async () => {
      // Legal under 061:770-776 — which is exactly why the backfill has to exist.
      await rig.asAdmin((c: any) =>
        c.query(
          `UPDATE warehouse_dispatch_lines
              SET status='rejected', received_quantity=NULL,
                  rejection_reason='167 legacy row planted pre-167', rejected_at=now()
            WHERE id=$1`,
          [legacyLineId],
        ),
      );

      const l = await lineRow(legacyLineId);
      expect(l.status).toBe('rejected');
      expect(l.received_quantity).toBeNull();
      expect(l.rejection_reason).toBe('167 legacy row planted pre-167');
    });

    it('the old constraint is the one 167 will replace', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conname='warehouse_dispatch_lines_decision_chk'`,
        );
        // Three branches require IS NULL pre-167: pending, rejected, cancelled.
        expect(r.rows[0].def.match(/received_quantity IS NULL/g) ?? []).toHaveLength(3);
        expect(r.rows[0].def).not.toContain('(received_quantity = 0)');
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Applying 167 over that data
  // ══════════════════════════════════════════════════════════════════════════

  describe('2. applying 167 to a database holding a legacy rejected line', () => {
    it('applies cleanly — the backfill runs before the ALTER, so nothing aborts', async () => {
      // Its own PREFLIGHT/BACKFILL/VERIFY blocks would raise inside this call if
      // anything were wrong, so "this resolves" is itself part of the assertion.
      await applyMigration();
    });

    it('normalised the legacy row to 0 without changing anything else about it', async () => {
      const l = await lineRow(legacyLineId);
      expect(l.received_quantity).toBe(0); // was NULL
      // Still the same rejection, with its recorded history intact.
      expect(l.status).toBe('rejected');
      expect(l.rejection_reason).toBe('167 legacy row planted pre-167');
      expect(l.rejected_at).not.toBeNull();
      expect(l.sent_quantity).toBe(6);
    });

    it('left the untouched pending line exactly as it was', async () => {
      // The backfill's WHERE clause is status='rejected' AND received_quantity IS
      // NULL. A pending line matches the second half but not the first, so it
      // must not have been rewritten.
      const l = await lineRow(untouchedLineId);
      expect(l.status).toBe('pending');
      expect(l.received_quantity).toBeNull();
      expect(l.rejection_reason).toBeNull();
    });

    it('installed the reconciled constraint', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conname='warehouse_dispatch_lines_decision_chk'`,
        );
        const def: string = r.rows[0].def;
        expect(def).toContain('(received_quantity IS NOT NULL) AND (received_quantity = 0)');
        // Down from three to two: pending and cancelled only.
        expect(def.match(/received_quantity IS NULL/g) ?? []).toHaveLength(2);
      });
    });

    it('is idempotent enough to be re-run on an already-reconciled database', async () => {
      // A second apply finds nothing to backfill and replaces the constraint with
      // an identical definition. It must still succeed — an operator re-running a
      // manual migration must not get a broken database.
      await applyMigration();

      const l = await lineRow(legacyLineId);
      expect(l.received_quantity).toBe(0);
      expect(l.status).toBe('rejected');

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int AS n FROM pg_constraint
            WHERE conname='warehouse_dispatch_lines_decision_chk'`,
        );
        expect(r.rows[0].n).toBe(1); // exactly one, not two
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. And the corridor works afterwards
  // ══════════════════════════════════════════════════════════════════════════

  describe('3. after the upgrade, the corridor rejects properly', () => {
    it('the RPC call that failed in section 1 now completes on the SAME database', async () => {
      // The narrowest possible statement of what 167 changed: same rig, same
      // fixture, same call — refused before the migration, accepted after.
      const fresh = await sentLine(DP_UNTOUCHED, 'AFTER', 4);

      const res: any = await rig.asUser(
        rig.superAdminId,
        (c: any) =>
          call(c, 'phoenix_receive_outlet_dispatch_line', [
            randomUUID(), fresh.lineId, 0, '167 post-upgrade rejection', null, 'damaged',
          ]),
        { commit: true },
      );

      expect(res.ok).toBe(true);
      expect(res.line_status).toBe('rejected');

      const l = await lineRow(fresh.lineId);
      expect(l.status).toBe('rejected');
      expect(l.received_quantity).toBe(0);

      await rig.asAdmin(async (c: any) => {
        const h = await c.query(`SELECT status FROM warehouse_dispatches WHERE id=$1`, [
          fresh.dispatchId,
        ]);
        expect(h.rows[0].status).toBe('rejected');
      });
    });

    it('the legacy dispatch header is still whatever it was — 167 recomputed nothing', async () => {
      // The backfill wrote received_quantity only, never status, so 070:1253's
      // AFTER UPDATE OF status trigger never fired and no header was touched.
      // The legacy line was planted by direct UPDATE (which DID fire the trigger
      // then), so the header reflects that plant, not the migration.
      await rig.asAdmin(async (c: any) => {
        const h = await c.query(`SELECT status FROM warehouse_dispatches WHERE id=$1`, [
          legacyDispatchId,
        ]);
        expect(h.rows[0].status).toBe('rejected');
      });
    });
  });
});
