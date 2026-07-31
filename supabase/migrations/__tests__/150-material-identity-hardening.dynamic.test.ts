import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;
const migration150 = readFileSync(
  join(__dirname, '../150_phoenix_material_identity_fefo_provenance_hardening.sql'),
  'utf8',
);

run('150 canonical material identity — live database contract', () => {
  it('collision preflight aborts the whole migration without merging or deleting', async () => {
    const rig = await buildRig({ upTo: 149 });
    try {
      await rig.asAdmin(async (c: any) => {
        await c.query(`
          INSERT INTO organizations(id,name,name_ar,code)
          VALUES('00000000-0000-0000-0000-000000150001','Collision','Collision','p150-c');
          INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
          VALUES('00000000-0000-0000-0000-000000150011',
                 '00000000-0000-0000-0000-000000150001',
                 'Collision W','Collision W','active','central','p150-cw');
          INSERT INTO warehouse_stock(
            id,organization_id,warehouse_id,scientific_name,concentration,dosage_form,unit,
            national_code,has_no_national_code,batch_number,has_no_batch_number,
            expiry_date,on_hand_quantity,reserved_quantity
          ) VALUES
            ('00000000-0000-0000-0000-000000150021',
             '00000000-0000-0000-0000-000000150001',
             '00000000-0000-0000-0000-000000150011',
             'Case Drug','10 MG','Tablet','Box','NC-150',false,'B-150',false,
             current_date+365,1,0),
            ('00000000-0000-0000-0000-000000150022',
             '00000000-0000-0000-0000-000000150001',
             '00000000-0000-0000-0000-000000150011',
             'case drug','10 mg','tablet','box','NC-150',false,'B-150',false,
             current_date+365,1,0);
        `);
        await expect(c.query(migration150)).rejects.toThrow(
          /150_material_identity_collision: warehouse_stock/,
        );
        await c.query('ROLLBACK');
        const proof = await c.query(`
          SELECT
            (SELECT count(*)::int FROM warehouse_stock
              WHERE warehouse_id='00000000-0000-0000-0000-000000150011') AS rows,
            (SELECT count(*)::int FROM information_schema.columns
              WHERE table_schema='public' AND table_name='warehouse_stock'
                AND column_name='material_identity_key') AS columns
        `);
        expect(proof.rows[0]).toEqual({ rows: 2, columns: 0 });
      });
    } finally {
      await rig.end();
    }
  }, 180000);

  it('separates variants through alerts, suggestions, commitments and Draft lines', async () => {
    const rig = await buildRig({ upTo: 150 });
    try {
      await rig.asAdmin(async (c: any) => {
        await c.query(`
          INSERT INTO organizations(id,name,name_ar,code)
          VALUES('00000000-0000-0000-0000-000000150101','Identity','Identity','p150-i');
          INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
          VALUES
            ('00000000-0000-0000-0000-000000150111',
             '00000000-0000-0000-0000-000000150101',
             'Source','Source','active','central','p150-src'),
            ('00000000-0000-0000-0000-000000150112',
             '00000000-0000-0000-0000-000000150101',
             'Target','Target','active','institution','p150-tgt');

          INSERT INTO warehouse_stock(
            id,organization_id,warehouse_id,scientific_name,concentration,dosage_form,unit,
            national_code,has_no_national_code,batch_number,has_no_batch_number,
            expiry_date,on_hand_quantity,reserved_quantity
          ) VALUES
            ('00000000-0000-0000-0000-000000150121',
             '00000000-0000-0000-0000-000000150101',
             '00000000-0000-0000-0000-000000150111',
             'Variant Drug','10 mg','tablet','box','NC-V',false,'SRC-A',false,
             current_date+365,30,0),
            ('00000000-0000-0000-0000-000000150122',
             '00000000-0000-0000-0000-000000150101',
             '00000000-0000-0000-0000-000000150111',
             'variant DRUG','20 MG','capsule','ampoule','NC-V',false,'SRC-A',false,
             current_date+365,30,0),
            ('00000000-0000-0000-0000-000000150123',
             '00000000-0000-0000-0000-000000150101',
             '00000000-0000-0000-0000-000000150112',
             'Variant Drug','10 mg','tablet','box','NC-V',false,'TGT-A',false,
             current_date+365,0,0),
            ('00000000-0000-0000-0000-000000150124',
             '00000000-0000-0000-0000-000000150101',
             '00000000-0000-0000-0000-000000150112',
             'VARIANT DRUG','20 mg','capsule','ampoule','NC-V',false,'TGT-A',false,
             current_date+365,0,0);

          INSERT INTO inventory_signal_thresholds(
            organization_id,scope_kind,scope_id,scientific_name,national_code,
            reorder_point,target_max,is_active
          ) VALUES
            ('00000000-0000-0000-0000-000000150101','warehouse',
             '00000000-0000-0000-0000-000000150111','Variant Drug',NULL,0,10,true),
            ('00000000-0000-0000-0000-000000150101','warehouse',
             '00000000-0000-0000-0000-000000150112','Variant Drug',NULL,20,100,true);
        `);
      });

      let suggestionIds: string[] = [];
      await rig.asUser(rig.superAdminId, async (c: any) => {
        await c.query(
          `SELECT public.phoenix_recompute_inventory_alerts(
             '00000000-0000-0000-0000-000000150101',NULL,NULL)`,
        );
      }, { commit: true });

      await rig.asAdmin(async (c: any) => {
        const alerts = await c.query(`
          SELECT signal_type,concentration,dosage_form,unit,
                 observed_available,material_identity_state,material_identity_key
          FROM inventory_alerts
          WHERE organization_id='00000000-0000-0000-0000-000000150101'
            AND signal_type IN ('surplus','missing')
          ORDER BY signal_type,concentration
        `);
        expect(alerts.rows).toHaveLength(4);
        expect(new Set(alerts.rows.map((r: any) =>
          r.material_identity_key)).size).toBe(2);
        expect(alerts.rows.every((r: any) => r.material_identity_state === 'resolved')).toBe(true);
      });

      await rig.asUser(rig.superAdminId, async (c: any) => {
        const generated = await c.query(
          `SELECT public.phoenix_suggest_inventory_transfers(
             '00000000-0000-0000-0000-000000150101') AS r`,
        );
        expect(generated.rows[0].r.suggestions).toBe(2);

        const suggestions = await c.query(`
          SELECT id,source_stock_id,concentration,dosage_form,unit,
                 material_identity_key,suggested_quantity
          FROM inventory_transfer_suggestions
          WHERE source_organization_id='00000000-0000-0000-0000-000000150101'
            AND status='open'
          ORDER BY concentration
        `);
        expect(suggestions.rows).toHaveLength(2);
        expect(new Set(suggestions.rows.map((r: any) => r.material_identity_key)).size).toBe(2);
        expect(suggestions.rows.map((r: any) => r.source_stock_id)).toEqual([
          '00000000-0000-0000-0000-000000150121',
          '00000000-0000-0000-0000-000000150122',
        ]);

        suggestionIds = suggestions.rows.map((r: any) => r.id);
      }, { commit: true });

      await rig.asAdmin(async (c: any) => {
        const commitments = await c.query(`
          SELECT s.material_identity_key,c.source_commitment,c.target_commitment,c.batch_commitment
          FROM inventory_transfer_suggestions s
          CROSS JOIN LATERAL phoenix_inventory_suggestion_commitments(s.id)c
          WHERE s.id=ANY($1::uuid[])
          ORDER BY s.material_identity_key
        `, [suggestionIds]);
        expect(commitments.rows).toHaveLength(2);
        expect(commitments.rows.every((r: any) =>
          r.source_commitment === 20 && r.target_commitment === 20 && r.batch_commitment === 20,
        )).toBe(true);
      });

      await rig.asUser(rig.superAdminId, async (c: any) => {
        const movementsBefore = await c.query(`
          SELECT (SELECT count(*) FROM warehouse_stock_movements)
               + (SELECT count(*) FROM outlet_stock_movements)
               + (SELECT count(*) FROM warehouse_quarantine_stock_movements) AS n
        `);
        const drafted = await c.query(
          `SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`,
          [suggestionIds[0], 'P150-DRAFT-1'],
        );
        expect(drafted.rows[0].r.status).toBe('accepted');
        const line = await c.query(`
          SELECT l.concentration,l.dosage_form,l.unit,
                 s.concentration AS suggestion_concentration,
                 s.dosage_form AS suggestion_dosage_form,
                 s.unit AS suggestion_unit,
                 s.material_identity_key
          FROM warehouse_transfer_request_lines l
          JOIN inventory_transfer_suggestions s
            ON s.draft_warehouse_transfer_request_line_id=l.id
          WHERE s.id=$1
        `, [suggestionIds[0]]);
        expect(line.rows[0].concentration).toBe(
          line.rows[0].suggestion_concentration,
        );
        expect(line.rows[0].dosage_form).toBe(
          line.rows[0].suggestion_dosage_form,
        );
        expect(line.rows[0].unit).toBe(line.rows[0].suggestion_unit);

        const movementsAfter = await c.query(`
          SELECT (SELECT count(*) FROM warehouse_stock_movements)
               + (SELECT count(*) FROM outlet_stock_movements)
               + (SELECT count(*) FROM warehouse_quarantine_stock_movements) AS n
        `);
        expect(movementsAfter.rows[0].n).toBe(movementsBefore.rows[0].n);
      });
    } finally {
      await rig.end();
    }
  }, 240000);
});
