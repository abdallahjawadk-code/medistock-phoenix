import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const migration149 = readFileSync(
  join(__dirname, '../149_phoenix_inventory_suggestion_lineage_commitments.sql'),
  'utf8',
);

run('149 hardening — semantic lineage across the 148→149 boundary', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 148 });
  }, 120000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  it('links only identity-proven historical lines and leaves every ambiguity unresolved', async () => {
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `
        INSERT INTO organizations (id,name,name_ar,code) VALUES
          ('00000000-0000-0000-0000-000000149b01','Boundary Org','Boundary Org','p149-boundary');
        INSERT INTO warehouses
          (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
          ('00000000-0000-0000-0000-000000149b11',
           '00000000-0000-0000-0000-000000149b01','Source','Source','active','central','p149-bs'),
          ('00000000-0000-0000-0000-000000149b12',
           '00000000-0000-0000-0000-000000149b01','Target','Target','active','institution','p149-bt');
        INSERT INTO distribution_points
          (id,warehouse_id,organization_id,name,name_ar,point_type,status) VALUES
          ('00000000-0000-0000-0000-000000149b21',
           '00000000-0000-0000-0000-000000149b12',
           '00000000-0000-0000-0000-000000149b01',
           'Boundary Outlet','Boundary Outlet','pharmacy','active');

        INSERT INTO warehouse_stock (
          id,organization_id,warehouse_id,scientific_name,national_code,
          has_no_national_code,batch_number,has_no_batch_number,expiry_date,
          on_hand_quantity,reserved_quantity,movement_seq
        ) VALUES
          ('00000000-0000-0000-0000-000000149b31',
           '00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b11',
           'Boundary Central','NDC-C',false,'BC',false,current_date+365,100,0,1),
          ('00000000-0000-0000-0000-000000149b32',
           '00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b12',
           'Boundary Dispatch','NDC-D',false,'BD',false,current_date+365,100,0,1),
          ('00000000-0000-0000-0000-000000149b33',
           '00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b12',
           'Boundary Outlet A','NDC-OA',false,'BOA',false,current_date+365,100,0,1),
          ('00000000-0000-0000-0000-000000149b34',
           '00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b12',
           'Boundary Outlet B','NDC-OB',false,'BOB',false,current_date+365,100,0,1);

        INSERT INTO outlet_stock (
          id,organization_id,distribution_point_id,point_type,scientific_name,national_code,
          has_no_national_code,batch_number,has_no_batch_number,expiry_date,
          on_hand_quantity,reserved_quantity,movement_seq
        ) VALUES
          ('00000000-0000-0000-0000-000000149b35',
           '00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b21','pharmacy',
           'Boundary Outlet A','NDC-OA',false,'BOA',false,current_date+365,20,0,1),
          ('00000000-0000-0000-0000-000000149b36',
           '00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b21','pharmacy',
           'Boundary Outlet B','NDC-OB',false,'BOB',false,current_date+365,20,0,1);

        INSERT INTO warehouse_transfer_requests (
          id,source_warehouse_id,source_organization_id,
          destination_warehouse_id,destination_organization_id,request_number,status
        ) VALUES
          ('00000000-0000-0000-0000-000000149b41',
           '00000000-0000-0000-0000-000000149b11','00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b12','00000000-0000-0000-0000-000000149b01',
           'B149-C-OK','draft'),
          ('00000000-0000-0000-0000-000000149b42',
           '00000000-0000-0000-0000-000000149b11','00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b12','00000000-0000-0000-0000-000000149b01',
           'B149-C-WRONG','draft'),
          ('00000000-0000-0000-0000-000000149b43',
           '00000000-0000-0000-0000-000000149b11','00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b12','00000000-0000-0000-0000-000000149b01',
           'B149-C-MULTI','draft');
        INSERT INTO warehouse_transfer_request_lines (
          id,transfer_request_id,destination_organization_id,
          scientific_name,concentration,requested_quantity
        ) VALUES
          ('00000000-0000-0000-0000-000000149b51',
           '00000000-0000-0000-0000-000000149b41',
           '00000000-0000-0000-0000-000000149b01','Boundary Central',NULL,10),
          ('00000000-0000-0000-0000-000000149b52',
           '00000000-0000-0000-0000-000000149b42',
           '00000000-0000-0000-0000-000000149b01','Different Medicine',NULL,10),
          ('00000000-0000-0000-0000-000000149b53',
           '00000000-0000-0000-0000-000000149b43',
           '00000000-0000-0000-0000-000000149b01','Boundary Central',NULL,5),
          ('00000000-0000-0000-0000-000000149b54',
           '00000000-0000-0000-0000-000000149b43',
           '00000000-0000-0000-0000-000000149b01','Boundary Central','10mg',5);

        INSERT INTO warehouse_dispatches (
          id,organization_id,warehouse_id,destination_distribution_point_id,
          dispatch_number,status,sent_by,sent_at
        ) VALUES
          ('00000000-0000-0000-0000-000000149b44',
           '00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b12',
           '00000000-0000-0000-0000-000000149b21','B149-D-OK','draft',NULL,NULL),
          ('00000000-0000-0000-0000-000000149b45',
           '00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b12',
           '00000000-0000-0000-0000-000000149b21','B149-D-NOMAP','draft',NULL,NULL),
          ('00000000-0000-0000-0000-000000149b46',
           '00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b12',
           '00000000-0000-0000-0000-000000149b21','B149-PROV-A','sent','${rig.superAdminId}',now()),
          ('00000000-0000-0000-0000-000000149b47',
           '00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b12',
           '00000000-0000-0000-0000-000000149b21','B149-PROV-B','sent','${rig.superAdminId}',now());
        INSERT INTO warehouse_dispatch_lines (
          id,organization_id,dispatch_id,warehouse_stock_id,
          scientific_name,national_code,has_no_national_code,
          batch_number,has_no_batch_number,sent_quantity,status,
          received_quantity,accepted_by,accepted_at,resulting_outlet_stock_id
        ) VALUES
          ('00000000-0000-0000-0000-000000149b55',
           '00000000-0000-0000-0000-000000149b01','00000000-0000-0000-0000-000000149b44',
           '00000000-0000-0000-0000-000000149b32',
           'Boundary Dispatch','NDC-D',false,'BD',false,10,'pending',NULL,NULL,NULL,NULL),
          ('00000000-0000-0000-0000-000000149b56',
           '00000000-0000-0000-0000-000000149b01','00000000-0000-0000-0000-000000149b45',
           '00000000-0000-0000-0000-000000149b32',
           'Boundary Dispatch','NDC-D',false,'BD',false,10,'pending',NULL,NULL,NULL,NULL),
          ('00000000-0000-0000-0000-000000149b57',
           '00000000-0000-0000-0000-000000149b01','00000000-0000-0000-0000-000000149b46',
           '00000000-0000-0000-0000-000000149b33',
           'Boundary Outlet A','NDC-OA',false,'BOA',false,20,'accepted',20,'${rig.superAdminId}',now(),
           '00000000-0000-0000-0000-000000149b35'),
          ('00000000-0000-0000-0000-000000149b58',
           '00000000-0000-0000-0000-000000149b01','00000000-0000-0000-0000-000000149b47',
           '00000000-0000-0000-0000-000000149b34',
           'Boundary Outlet B','NDC-OB',false,'BOB',false,20,'accepted',20,'${rig.superAdminId}',now(),
           '00000000-0000-0000-0000-000000149b36');

        INSERT INTO outlet_stock_movements (
          id,outlet_stock_id,organization_id,distribution_point_id,movement_type,
          on_hand_before,on_hand_delta,on_hand_after,
          reserved_before,reserved_delta,reserved_after,
          dispatch_line_id,scientific_name_snapshot,reason_code
        ) VALUES
          ('00000000-0000-0000-0000-000000149b71',
           '00000000-0000-0000-0000-000000149b35',
           '00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b21','dispatch_receive',
           0,20,20,0,0,0,'00000000-0000-0000-0000-000000149b57',
           'Boundary Outlet A','received'),
          ('00000000-0000-0000-0000-000000149b72',
           '00000000-0000-0000-0000-000000149b36',
           '00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b21','dispatch_receive',
           0,20,20,0,0,0,'00000000-0000-0000-0000-000000149b58',
           'Boundary Outlet B','received');

        INSERT INTO outlet_return_requests (
          id,distribution_point_id,source_organization_id,
          destination_warehouse_id,destination_organization_id,
          return_number,status,requested_by_side
        ) VALUES
          ('00000000-0000-0000-0000-000000149b48',
           '00000000-0000-0000-0000-000000149b21','00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b12','00000000-0000-0000-0000-000000149b01',
           'B149-R-OK','draft','sender'),
          ('00000000-0000-0000-0000-000000149b49',
           '00000000-0000-0000-0000-000000149b21','00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b12','00000000-0000-0000-0000-000000149b01',
           'B149-R-WRONG','draft','sender');
        INSERT INTO outlet_return_request_lines (
          id,return_request_id,source_organization_id,
          original_dispatch_line_id,original_inbound_movement_id,source_outlet_stock_id,
          scientific_name,national_code,batch_number,reason_code,requested_quantity
        ) VALUES
          ('00000000-0000-0000-0000-000000149b59',
           '00000000-0000-0000-0000-000000149b48','00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b57','00000000-0000-0000-0000-000000149b71',
           '00000000-0000-0000-0000-000000149b35',
           'Boundary Outlet A','NDC-OA','BOA','excess',10),
          ('00000000-0000-0000-0000-000000149b5a',
           '00000000-0000-0000-0000-000000149b49','00000000-0000-0000-0000-000000149b01',
           '00000000-0000-0000-0000-000000149b58','00000000-0000-0000-0000-000000149b72',
           '00000000-0000-0000-0000-000000149b36',
           'Boundary Outlet B','NDC-OB','BOB','excess',10);

        ALTER TABLE inventory_transfer_suggestions DISABLE TRIGGER inventory_suggestion_guard;
        INSERT INTO inventory_transfer_suggestions (
          id,source_organization_id,target_organization_id,scientific_name,national_code,
          source_scope_kind,source_scope_id,target_scope_kind,target_scope_id,
          route_kind,source_stock_id,suggested_quantity,suggestion_key,status,
          accepted_at,accepted_by,draft_document_number,
          draft_warehouse_transfer_request_id,draft_warehouse_dispatch_id,
          draft_outlet_return_request_id,provenance_dispatch_line_id,
          provenance_inbound_movement_id
        ) VALUES
          ('00000000-0000-0000-0000-000000149b61',
           '00000000-0000-0000-0000-000000149b01','00000000-0000-0000-0000-000000149b01',
           'Boundary Central','NDC-C','warehouse','00000000-0000-0000-0000-000000149b11',
           'warehouse','00000000-0000-0000-0000-000000149b12','central_to_institution',
           '00000000-0000-0000-0000-000000149b31',10,'boundary-central-ok','accepted',
           now(),'${rig.superAdminId}','B149-C-OK','00000000-0000-0000-0000-000000149b41',NULL,NULL,NULL,NULL),
          ('00000000-0000-0000-0000-000000149b62',
           '00000000-0000-0000-0000-000000149b01','00000000-0000-0000-0000-000000149b01',
           'Boundary Central','NDC-C','warehouse','00000000-0000-0000-0000-000000149b11',
           'warehouse','00000000-0000-0000-0000-000000149b12','central_to_institution',
           '00000000-0000-0000-0000-000000149b31',10,'boundary-central-wrong','accepted',
           now(),'${rig.superAdminId}','B149-C-WRONG','00000000-0000-0000-0000-000000149b42',NULL,NULL,NULL,NULL),
          ('00000000-0000-0000-0000-000000149b63',
           '00000000-0000-0000-0000-000000149b01','00000000-0000-0000-0000-000000149b01',
           'Boundary Central','NDC-C','warehouse','00000000-0000-0000-0000-000000149b11',
           'warehouse','00000000-0000-0000-0000-000000149b12','central_to_institution',
           '00000000-0000-0000-0000-000000149b31',10,'boundary-central-multi','accepted',
           now(),'${rig.superAdminId}','B149-C-MULTI','00000000-0000-0000-0000-000000149b43',NULL,NULL,NULL,NULL),
          ('00000000-0000-0000-0000-000000149b64',
           '00000000-0000-0000-0000-000000149b01','00000000-0000-0000-0000-000000149b01',
           'Boundary Dispatch','NDC-D','warehouse','00000000-0000-0000-0000-000000149b12',
           'outlet','00000000-0000-0000-0000-000000149b21','warehouse_to_outlet',
           '00000000-0000-0000-0000-000000149b32',10,'boundary-dispatch-ok','accepted',
           now(),'${rig.superAdminId}','B149-D-OK',NULL,'00000000-0000-0000-0000-000000149b44',NULL,NULL,NULL),
          ('00000000-0000-0000-0000-000000149b65',
           '00000000-0000-0000-0000-000000149b01','00000000-0000-0000-0000-000000149b01',
           'Boundary Dispatch','NDC-D','warehouse','00000000-0000-0000-0000-000000149b12',
           'outlet','00000000-0000-0000-0000-000000149b21','warehouse_to_outlet',
           '00000000-0000-0000-0000-000000149b32',10,'boundary-dispatch-nomap','accepted',
           now(),'${rig.superAdminId}','B149-D-NOMAP',NULL,'00000000-0000-0000-0000-000000149b45',NULL,NULL,NULL),
          ('00000000-0000-0000-0000-000000149b66',
           '00000000-0000-0000-0000-000000149b01','00000000-0000-0000-0000-000000149b01',
           'Boundary Outlet A','NDC-OA','outlet','00000000-0000-0000-0000-000000149b21',
           'warehouse','00000000-0000-0000-0000-000000149b12','outlet_to_warehouse',
           '00000000-0000-0000-0000-000000149b35',10,'boundary-outlet-ok','accepted',
           now(),'${rig.superAdminId}','B149-R-OK',NULL,NULL,'00000000-0000-0000-0000-000000149b48',
           '00000000-0000-0000-0000-000000149b57','00000000-0000-0000-0000-000000149b71'),
          ('00000000-0000-0000-0000-000000149b67',
           '00000000-0000-0000-0000-000000149b01','00000000-0000-0000-0000-000000149b01',
           'Boundary Outlet A','NDC-OA','outlet','00000000-0000-0000-0000-000000149b21',
           'warehouse','00000000-0000-0000-0000-000000149b12','outlet_to_warehouse',
           '00000000-0000-0000-0000-000000149b35',10,'boundary-outlet-wrong','accepted',
           now(),'${rig.superAdminId}','B149-R-WRONG',NULL,NULL,'00000000-0000-0000-0000-000000149b49',
           '00000000-0000-0000-0000-000000149b57','00000000-0000-0000-0000-000000149b71');
        ALTER TABLE inventory_transfer_suggestions ENABLE TRIGGER inventory_suggestion_guard;

        INSERT INTO phoenix_dispatch_line_requests (
          request_id,organization_id,dispatch_id,payload_fingerprint,result,
          dispatch_line_id,actor_id
        ) VALUES (
          '00000000-0000-0000-0000-000000149b64',
          '00000000-0000-0000-0000-000000149b01',
          '00000000-0000-0000-0000-000000149b44',
          repeat('a',64),
          jsonb_build_object('dispatch_line_id','00000000-0000-0000-0000-000000149b55'),
          '00000000-0000-0000-0000-000000149b55','${rig.superAdminId}'
        );
        `,
      );

      await c.query(migration149);

      const result = await c.query(
        `SELECT id::text, lineage_state,
                draft_warehouse_transfer_request_line_id::text AS central_line,
                draft_warehouse_dispatch_line_id::text AS dispatch_line,
                draft_outlet_return_request_line_id::text AS return_line
           FROM inventory_transfer_suggestions
          WHERE id::text LIKE '00000000-0000-0000-0000-000000149b6%'
          ORDER BY id`,
      );
      const byId = Object.fromEntries(result.rows.map((row: any) => [row.id, row]));

      expect(byId['00000000-0000-0000-0000-000000149b61']).toMatchObject({
        lineage_state: 'linked',
        central_line: '00000000-0000-0000-0000-000000149b51',
      });
      expect(byId['00000000-0000-0000-0000-000000149b62'].lineage_state)
        .toBe('legacy_unresolved');
      expect(byId['00000000-0000-0000-0000-000000149b63'].lineage_state)
        .toBe('legacy_unresolved');
      expect(byId['00000000-0000-0000-0000-000000149b64']).toMatchObject({
        lineage_state: 'linked',
        dispatch_line: '00000000-0000-0000-0000-000000149b55',
      });
      expect(byId['00000000-0000-0000-0000-000000149b65'].lineage_state)
        .toBe('legacy_unresolved');
      expect(byId['00000000-0000-0000-0000-000000149b66']).toMatchObject({
        lineage_state: 'linked',
        return_line: '00000000-0000-0000-0000-000000149b59',
      });
      expect(byId['00000000-0000-0000-0000-000000149b67'].lineage_state)
        .toBe('legacy_unresolved');
    });
  }, 120000);
});
