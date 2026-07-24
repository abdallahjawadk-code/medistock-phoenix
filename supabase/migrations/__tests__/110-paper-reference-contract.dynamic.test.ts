/**
 * PAPER-REFERENCE-CONTRACT — DYNAMIC proof for migration 110, against a real
 * disposable Postgres with 001->110 applied in order.
 *
 * Proves:
 *   - replay 001->110 succeeds.
 *   - a warehouse_officer can set a paper reference on their OWN org's draft
 *     dispatch, and it is editable while draft (upsert re-runs cleanly).
 *   - once the dispatch is sent (no longer draft), phoenix_set_paper_reference
 *     is rejected server-side — proving immutability is NOT merely UI-side.
 *   - duplicate detection is a WARN: a second, different document with the
 *     same (issuing_authority, year, document_type, normalized number) in the
 *     SAME org still succeeds, but reports possible_duplicate=true with the
 *     matching document id.
 *   - cross-org non-oracle: an org B actor searching for org A's paper
 *     reference number gets zero rows — identical to a number that does not
 *     exist anywhere.
 *   - has_table_privilege proves authenticated has no direct INSERT/UPDATE/
 *     DELETE on phoenix_paper_references — a direct table write attempt as
 *     `authenticated` is denied.
 *
 * Gated on PHOENIX_RIG_PG; skipped when no disposable Postgres is available
 * (e.g. this sandboxed environment has no local Postgres binaries — CI runs
 * this for real).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-0000000e0001';
const ORG_B = '00000000-0000-0000-0000-0000000e0002';
const WH_A = '00000000-0000-0000-0000-0000000e0101';
const WH_B = '00000000-0000-0000-0000-0000000e0102';
const DP_A = '00000000-0000-0000-0000-0000000e0301';
const DP_B = '00000000-0000-0000-0000-0000000e0302';

const WO_A = '00000000-0000-0000-0000-0000000e0401'; // warehouse_officer, org A
const WO_B = '00000000-0000-0000-0000-0000000e0402'; // warehouse_officer, org B

run('110 paper-reference contract — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 110 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_A}','Inst A','مؤسسة أ','p110-org-a'),
        ('${ORG_B}','Inst B','مؤسسة ب','p110-org-b')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_A}','${ORG_A}','WH A','مخزن أ','active','institution','p110-wh-a'),
        ('${WH_B}','${ORG_B}','WH B','مخزن ب','active','institution','p110-wh-b')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status) VALUES
        ('${DP_A}','${WH_A}','${ORG_A}','Outlet A','منفذ أ','pharmacy','active'),
        ('${DP_B}','${WH_B}','${ORG_B}','Outlet B','منفذ ب','pharmacy','active')
        ON CONFLICT DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${WO_A}','p110-wo-a@rig'), ('${WO_B}','p110-wo-b@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG_A}' WHERE id='${WO_A}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG_B}' WHERE id='${WO_B}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${WO_A}','${ORG_A}','warehouse','${WH_A}',true), ('${WO_B}','${ORG_B}','warehouse','${WH_B}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  async function seedDraftDispatch(org: string, wh: string, dp: string, actor: string, tag: string) {
    const id = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_dispatches (id, organization_id, warehouse_id, destination_distribution_point_id, dispatch_number, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'draft',$6)`,
        [id, org, wh, dp, `P110-DSP-${tag}`, actor],
      );
    });
    return id;
  }

  it('replay 001->110 succeeded (rig built) and phoenix_paper_references exists with fail-closed grants', async () => {
    await rig.asAdmin(async (c: any) => {
      const t = await c.query(`SELECT to_regclass('public.phoenix_paper_references') AS r`);
      expect(t.rows[0].r).toBe('phoenix_paper_references');

      const priv = await c.query(
        `SELECT privilege_type FROM information_schema.table_privileges
          WHERE table_name = 'phoenix_paper_references' AND grantee = 'authenticated'`,
      );
      const kinds = priv.rows.map((r: any) => r.privilege_type).sort();
      expect(kinds).toEqual(['SELECT']);
    });
  });

  it('warehouse_officer sets a paper reference on their own org draft dispatch (editable while draft)', async () => {
    const dispatchId = await seedDraftDispatch(ORG_A, WH_A, DP_A, WO_A, 'A1');
    const result = await rig.asUser(WO_A, async (c: any) => {
      const r = await c.query(
        `SELECT public.phoenix_set_paper_reference($1,$2,$3,$4,$5,$6) AS r`,
        ['warehouse_dispatch', dispatchId, 'PR/2026/001', '2026-01-15', 'وزارة الصحة', 'first set'],
      );
      return r.rows[0].r;
    }, { commit: true });
    expect(result.ok).toBe(true);
    expect(result.possible_duplicate).toBe(false);

    // Editable while still draft: a second set (still draft) succeeds and updates.
    const result2 = await rig.asUser(WO_A, async (c: any) => {
      const r = await c.query(
        `SELECT public.phoenix_set_paper_reference($1,$2,$3,$4,$5,$6) AS r`,
        ['warehouse_dispatch', dispatchId, 'PR/2026/001-REV', '2026-01-16', 'وزارة الصحة', 'revised while draft'],
      );
      return r.rows[0].r;
    }, { commit: true });
    expect(result2.ok).toBe(true);
  });

  it('is immutable once the dispatch leaves draft — enforced server-side, not merely UI-disabled', async () => {
    const dispatchId = await seedDraftDispatch(ORG_A, WH_A, DP_A, WO_A, 'A2');
    await rig.asUser(WO_A, async (c: any) => {
      await c.query(`SELECT public.phoenix_set_paper_reference($1,$2,$3,$4,$5,$6)`,
        ['warehouse_dispatch', dispatchId, 'PR/2026/002', '2026-02-01', 'وزارة الصحة', null]);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      await c.query(`UPDATE warehouse_dispatches SET status = 'sent', sent_by = $1 WHERE id = $2`, [WO_A, dispatchId]);
    });

    await expect(
      rig.asUser(WO_A, async (c: any) => {
        await c.query(`SELECT public.phoenix_set_paper_reference($1,$2,$3,$4,$5,$6)`,
          ['warehouse_dispatch', dispatchId, 'PR/2026/002-CHANGED', '2026-02-02', 'وزارة الصحة', null]);
      }, { commit: true }),
    ).rejects.toThrow(/paper_reference_locked_document_not_editable/);
  });

  it('duplicate detection WARNS (does not block) — a second document with the same normalized number in the same org', async () => {
    const d1 = await seedDraftDispatch(ORG_A, WH_A, DP_A, WO_A, 'A3');
    const d2 = await seedDraftDispatch(ORG_A, WH_A, DP_A, WO_A, 'A4');

    await rig.asUser(WO_A, async (c: any) => {
      await c.query(`SELECT public.phoenix_set_paper_reference($1,$2,$3,$4,$5,$6)`,
        ['warehouse_dispatch', d1, 'PR-2026-777', '2026-03-01', 'الجهة X', null]);
    }, { commit: true });

    const dupResult = await rig.asUser(WO_A, async (c: any) => {
      // Same number, different separators/case — normalization should still match.
      const r = await c.query(`SELECT public.phoenix_set_paper_reference($1,$2,$3,$4,$5,$6) AS r`,
        ['warehouse_dispatch', d2, 'pr 2026 777', '2026-03-15', 'الجهة X', null]);
      return r.rows[0].r;
    }, { commit: true });

    expect(dupResult.ok).toBe(true); // NOT blocked
    expect(dupResult.possible_duplicate).toBe(true);
    expect(dupResult.duplicate_matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ document_id: d1 })]),
    );
  });

  it('cross-org non-oracle: org B cannot discover org A paper reference numbers via search', async () => {
    const dA = await seedDraftDispatch(ORG_A, WH_A, DP_A, WO_A, 'A5');
    await rig.asUser(WO_A, async (c: any) => {
      await c.query(`SELECT public.phoenix_set_paper_reference($1,$2,$3,$4,$5,$6)`,
        ['warehouse_dispatch', dA, 'SECRET-ORG-A-999', '2026-04-01', 'جهة سرية', null]);
    }, { commit: true });

    // Org A can find its own.
    const foundOwn = await rig.asUser(WO_A, async (c: any) => {
      const r = await c.query(`SELECT * FROM public.phoenix_search_paper_reference($1)`, ['SECRET-ORG-A-999']);
      return r.rows;
    });
    expect(foundOwn.length).toBe(1);

    // Org B gets exactly the same empty result as searching for a number that
    // does not exist anywhere — no existence signal leaks.
    const foundOther = await rig.asUser(WO_B, async (c: any) => {
      const r = await c.query(`SELECT * FROM public.phoenix_search_paper_reference($1)`, ['SECRET-ORG-A-999']);
      return r.rows;
    });
    expect(foundOther.length).toBe(0);

    const foundNonexistent = await rig.asUser(WO_B, async (c: any) => {
      const r = await c.query(`SELECT * FROM public.phoenix_search_paper_reference($1)`, ['TOTALLY-MADE-UP-000']);
      return r.rows;
    });
    expect(foundNonexistent.length).toBe(0);
  });

  it('direct table write as authenticated is denied — RPC is the only writer', async () => {
    const dispatchId = await seedDraftDispatch(ORG_A, WH_A, DP_A, WO_A, 'A6');
    await expect(
      rig.asUser(WO_A, async (c: any) => {
        await c.query(
          `INSERT INTO public.phoenix_paper_references (organization_id, document_type, document_id, paper_reference_number)
           VALUES ($1,'warehouse_dispatch',$2,'BYPASS-ATTEMPT')`,
          [ORG_A, dispatchId],
        );
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('warehouse_stock_movement paper reference is settable exactly once (no draft state on that table)', async () => {
    const stockId = randomUUID();
    const movementId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, expiry_date, movement_seq)
         VALUES ($1,$2,$3,'P110-Movement-Mat',true,false,'B-110',10,0,current_date + 30,0)`,
        [stockId, ORG_A, WH_A],
      );
      await c.query(
        `INSERT INTO warehouse_stock_movements (
           id, warehouse_stock_id, organization_id, warehouse_id, movement_type,
           on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after,
           scientific_name_snapshot
         ) VALUES ($1,$2,$3,$4,'add',0,10,10,0,0,0,'P110-Movement-Mat')`,
        [movementId, stockId, ORG_A, WH_A],
      );
    });

    const first = await rig.asUser(WO_A, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_set_paper_reference($1,$2,$3,$4,$5,$6) AS r`,
        ['warehouse_stock_movement', movementId, 'WM-REF-001', '2026-05-01', 'الجهة Y', null]);
      return r.rows[0].r;
    }, { commit: true });
    expect(first.ok).toBe(true);

    await expect(
      rig.asUser(WO_A, async (c: any) => {
        await c.query(`SELECT public.phoenix_set_paper_reference($1,$2,$3,$4,$5,$6)`,
          ['warehouse_stock_movement', movementId, 'WM-REF-001-CHANGED', '2026-05-02', 'الجهة Y', null]);
      }, { commit: true }),
    ).rejects.toThrow(/paper_reference_locked_document_not_editable/);
  });
});
