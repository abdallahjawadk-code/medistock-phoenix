import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(__dirname, '../150_phoenix_material_identity_fefo_provenance_hardening.sql'),
  'utf8',
);

describe('150 exact-material FEFO debit hardening — static contract', () => {
  it('keeps the ceiling at 150 and installs one exact internal candidate reader', () => {
    expect(sql).toContain(
      'CREATE FUNCTION public._phoenix_inventory_fefo_batches_exact_v1(',
    );
    expect(sql).toContain('ws.material_identity_key=p_material_identity_key');
    expect(sql).toContain('os.material_identity_key=p_material_identity_key');
    expect(sql).toContain(
      'ORDER BY ws.expiry_date ASC NULLS LAST,ws.id ASC',
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\._phoenix_inventory_fefo_batches_exact_v1\([\s\S]*?FROM PUBLIC,anon,authenticated;/,
    );
  });

  it('makes legacy FEFO identity resolution fail closed on ambiguity', () => {
    expect(sql).toContain("RAISE EXCEPTION 'material_identity_ambiguous'");
    expect(sql).toContain(
      'ws.national_code IS NOT DISTINCT FROM p_national_code',
    );
    expect(sql).toContain(
      'os.national_code IS NOT DISTINCT FROM p_national_code',
    );
  });

  it('turns every raw warehouse supply surface into a guarded wrapper', () => {
    for (const token of [
      '_phoenix_150_delegate_send_warehouse_transfer_line',
      '_phoenix_150_send_routed_v1',
      '_phoenix_150_send_direct_v1',
      '_phoenix_150_delegate_add_dispatch_line',
      '_phoenix_150_add_dispatch_line_v1',
      'CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_dispatch',
      'phoenix_send_direct_warehouse_transfer_line_fefo_guarded',
    ]) {
      expect(sql).toContain(token);
    }
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\._phoenix_150_delegate_send_warehouse_transfer_line\([\s\S]*?FROM PUBLIC,anon,authenticated;/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\._phoenix_150_delegate_add_dispatch_line\([\s\S]*?FROM PUBLIC,anon,authenticated;/,
    );
  });

  it('orders replay before FEFO and binds dispatch override to a candidate fingerprint', () => {
    const routed = sql.slice(
      sql.indexOf('CREATE FUNCTION public._phoenix_150_send_routed_v1'),
      sql.indexOf('CREATE FUNCTION public.phoenix_send_warehouse_transfer_line('),
    );
    expect(routed.indexOf("m.reference_type='warehouse_transfer_send'")).toBeLessThan(
      routed.indexOf('_phoenix_inventory_fefo_batches_exact_v1'),
    );
    const dispatch = sql.slice(
      sql.indexOf(
        'CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_dispatch',
      ),
      sql.indexOf('-- Public signatures remain stable.'),
    );
    expect(dispatch.indexOf("a.action='warehouse_dispatch.sent'")).toBeLessThan(
      dispatch.indexOf('_phoenix_inventory_fefo_batches_exact_v1'),
    );
    expect(dispatch).toContain(
      'v_line.fefo_candidate_fingerprint IS DISTINCT FROM v_candidate_fp',
    );
    expect(dispatch).toContain("RAISE EXCEPTION 'fefo_revalidation_required'");
    expect(dispatch).toContain("RAISE EXCEPTION 'forbidden_fefo_override'");
  });

  it('keeps the 6B-2 capsule free of permissions, ledgers, reservations, reports and return-cap logic', () => {
    const stage = sql.slice(
      sql.indexOf('-- 6B-2: exact-material FEFO'),
      sql.indexOf('-- 6B-3. Aggregate outlet-return approval cap.'),
    );
    expect(stage).not.toMatch(/INSERT INTO public\.permission_keys/i);
    expect(stage).not.toMatch(/CREATE TABLE .*ledger/i);
    expect(stage).not.toMatch(/CREATE TABLE .*reservation/i);
    expect(stage).not.toContain('outlet_return_aggregate_cap');
    expect(stage).toContain("'inventory.fefo_override'");
  });
});
