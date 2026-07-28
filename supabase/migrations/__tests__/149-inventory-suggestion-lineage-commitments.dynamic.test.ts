import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

run('149 lineage commitments — live database contract', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 149 });
  }, 120000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  it('installs all three explicit line links and composite FKs', async () => {
    await rig.asAdmin(async (c: any) => {
      const columns = await c.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name='inventory_transfer_suggestions'
            AND column_name LIKE 'draft_%_line_id'
          ORDER BY column_name`,
      );
      expect(columns.rows.map((r: any) => r.column_name)).toEqual([
        'draft_outlet_return_request_line_id',
        'draft_warehouse_dispatch_line_id',
        'draft_warehouse_transfer_request_line_id',
      ]);
      const fks = await c.query(
        `SELECT count(*)::int AS n
           FROM pg_constraint
          WHERE conname IN (
            'inventory_suggestion_transfer_line_head_fk',
            'inventory_suggestion_dispatch_line_head_fk',
            'inventory_suggestion_return_line_head_fk')`,
      );
      expect(fks.rows[0].n).toBe(3);
    });
  });

  it('publishes the exact seven-column helper contract but no direct execution', async () => {
    await rig.asAdmin(async (c: any) => {
      const contract = await c.query(
        `SELECT pg_get_function_result(
                  'public.phoenix_inventory_suggestion_commitments(uuid)'::regprocedure
                ) AS result,
                has_function_privilege(
                  'authenticated',
                  'public.phoenix_inventory_suggestion_commitments(uuid)',
                  'EXECUTE') AS auth_exec,
                has_function_privilege(
                  'anon',
                  'public.phoenix_inventory_suggestion_commitments(uuid)',
                  'EXECUTE') AS anon_exec`,
      );
      for (const field of [
        'source_commitment integer',
        'target_commitment integer',
        'batch_commitment integer',
        'provenance_commitment integer',
        'commitment_state text',
        'truth_source text',
        'is_active boolean',
      ]) {
        expect(contract.rows[0].result).toContain(field);
      }
      expect(contract.rows[0].auth_exec).toBe(false);
      expect(contract.rows[0].anon_exec).toBe(false);
    });
  });

  it('uses a non-temporal partial unique index for the one-open-cycle rule', async () => {
    await rig.asAdmin(async (c: any) => {
      const index = await c.query(
        `SELECT pg_get_indexdef(indexrelid) AS def
           FROM pg_index
          WHERE indexrelid='public.inventory_suggestions_open_key_uniq'::regclass`,
      );
      expect(index.rows[0].def).toMatch(/UNIQUE INDEX/i);
      expect(index.rows[0].def).toMatch(/WHERE \(status = 'open'/i);
      expect(index.rows[0].def).not.toMatch(/now\(|current_/i);
    });
  });

  it('leaves no raw suggested_quantity sum in the four live commitment readers', async () => {
    await rig.asAdmin(async (c: any) => {
      const readers = await c.query(
        `SELECT p.proname, pg_get_functiondef(p.oid) AS def
           FROM pg_proc p
          WHERE p.oid = ANY(ARRAY[
            'public.phoenix_suggest_inventory_transfers(uuid)'::regprocedure,
            'public.phoenix_suggest_cross_org_inventory_transfer(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
            'public.phoenix_inventory_suggestion_guard()'::regprocedure,
            'public.phoenix_create_transfer_draft_from_suggestion(uuid,text)'::regprocedure
          ]::oid[])`,
      );
      expect(readers.rows).toHaveLength(4);
      for (const reader of readers.rows) {
        expect(reader.def).toContain('phoenix_inventory_suggestion_commitments');
        expect(reader.def).not.toMatch(/sum\s*\(\s*s\.suggested_quantity\s*\)/i);
      }
    });
  });

  it('keeps wrappers public-facing and delegates internal-only', async () => {
    await rig.asAdmin(async (c: any) => {
      const acl = await c.query(
        `SELECT
           has_function_privilege(
             'authenticated',
             'public.phoenix_send_direct_warehouse_transfer_line(uuid,uuid,uuid,integer,text,uuid,text,text)',
             'EXECUTE') AS wrapper_auth,
           has_function_privilege(
             'anon',
             'public.phoenix_send_direct_warehouse_transfer_line(uuid,uuid,uuid,integer,text,uuid,text,text)',
             'EXECUTE') AS wrapper_anon,
           has_function_privilege(
             'authenticated',
             'public._phoenix_149_delegate_send_direct_warehouse_transfer_line(uuid,uuid,uuid,integer,text,uuid,text,text)',
             'EXECUTE') AS delegate_auth`,
      );
      expect(acl.rows[0]).toEqual({
        wrapper_auth: true,
        wrapper_anon: false,
        delegate_auth: false,
      });
    });
  });

  it('does not widen direct suggestion-table writes', async () => {
    await rig.asAdmin(async (c: any) => {
      const acl = await c.query(
        `SELECT has_table_privilege(
                  'authenticated', 'public.inventory_transfer_suggestions', 'INSERT') AS ins,
                has_table_privilege(
                  'authenticated', 'public.inventory_transfer_suggestions', 'UPDATE') AS upd,
                has_table_privilege(
                  'authenticated', 'public.inventory_transfer_suggestions', 'DELETE') AS del`,
      );
      expect(acl.rows[0]).toEqual({ ins: false, upd: false, del: false });
    });
  });
});
