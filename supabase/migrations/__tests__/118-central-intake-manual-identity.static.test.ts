/**
 * CENTRAL-INTAKE-MANUAL-IDENTITY-118 — static contract.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const sql = readFileSync(
  join(__dirname, '../118_phoenix_central_intake_manual_identity.sql'),
  'utf8',
);

describe('118 — manual Pharmacy Department intake contract', () => {
  it('forbids catalog selection and uses operator-entered identity', () => {
    expect(sql).toContain("IF p_central_item_id IS NOT NULL THEN");
    expect(sql).toContain("central_catalog_selection_forbidden");
    expect(sql).toContain("v_scientific     text := NULLIF(btrim(p_scientific_name), '')");
    expect(sql).not.toContain('FROM public.central_items');
  });

  it('keeps central and supplementary purchase balances separated', () => {
    expect(sql).toContain("v_origin := 'central'");
    expect(sql).toContain('central_intake_supplementary_origin_forbidden');
    expect(sql).toContain("'supply_type', v_supply_type");
    expect(sql).toContain("'purchase_origin', v_origin");
  });

  it('keeps institution warehouses receive-only and the raw writer sealed', () => {
    expect(sql).toContain("IF v_warehouse_kind <> 'central' THEN");
    expect(sql).toContain('institution_warehouse_direct_receipt_forbidden');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('guarded intake writer unavailable');
  });
});
