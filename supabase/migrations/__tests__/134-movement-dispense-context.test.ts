/**
 * MOVEMENT-DISPENSE-CONTEXT-134 — static contract.
 *
 * Greenfield addition: a normalized, permission-gated table + 3 RPCs
 * recording WHO/WHAT a dispense movement was for (patient/crash_cart/
 * internal_order), immutably linked to the canonical outlet_stock_
 * movements row.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '134_phoenix_movement_dispense_context.sql'),
  'utf8',
);

describe('134 table shape and privacy posture', () => {
  it('creates exactly one new table', () => {
    const matches = migration.match(/CREATE TABLE public\.(\w+)/g) ?? [];
    expect(matches).toEqual(['CREATE TABLE public.phoenix_movement_dispense_context']);
  });

  it('movement_id is UNIQUE and FK to outlet_stock_movements — one row per movement, immutable linkage', () => {
    expect(migration).toMatch(/movement_id\s+uuid NOT NULL UNIQUE REFERENCES public\.outlet_stock_movements\(id\)/);
  });

  it('scopes to organization_id and distribution_point_id, both NOT NULL FKs', () => {
    expect(migration).toMatch(/organization_id\s+uuid NOT NULL REFERENCES public\.organizations\(id\)/);
    expect(migration).toMatch(/distribution_point_id\s+uuid NOT NULL REFERENCES public\.distribution_points\(id\)/);
  });

  it('beneficiary_type is a closed 3-value vocabulary', () => {
    expect(migration).toMatch(
      /beneficiary_type\s+text NOT NULL CHECK \(beneficiary_type IN \('patient', 'crash_cart', 'internal_order'\)\)/,
    );
  });

  it('enforces mutual exclusivity of type-specific fields via a CHECK constraint', () => {
    expect(migration).toContain('phoenix_movement_dispense_context_type_fields_chk');
    expect(migration).toContain("beneficiary_type = 'patient'");
    expect(migration).toContain("beneficiary_type = 'crash_cart'");
    expect(migration).toContain("beneficiary_type = 'internal_order'");
  });

  it('enables RLS with NO policies — no direct query path for authenticated at all', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).not.toMatch(/CREATE POLICY.*phoenix_movement_dispense_context/);
  });

  it('revokes ALL from PUBLIC, authenticated, and anon on the table', () => {
    expect(migration).toContain('REVOKE ALL ON TABLE public.phoenix_movement_dispense_context FROM PUBLIC, authenticated, anon;');
  });

  it('contains no GRANT of any privilege on the table itself (only on the RPCs)', () => {
    const tableSection = migration.split('-- ── B. Permission keys')[0];
    expect(tableSection).not.toMatch(/GRANT .* ON TABLE/i);
  });
});

describe('134 permission keys — strict, role-scoped, matching the existing permission_keys/role_permission_defaults pattern', () => {
  it('registers exactly the three movement_context keys', () => {
    expect(migration).toContain("('movement_context.record',");
    expect(migration).toContain("('movement_context.view_sensitive',");
    expect(migration).toContain("('movement_context.export_sensitive',");
  });

  it('grants movement_context.record ONLY to outlet_officer (and super_admin)', () => {
    expect(migration).toContain("('outlet_officer',           'movement_context.record',           true)");
    expect(migration).toContain("('institution_admin',        'movement_context.record',           false)");
    expect(migration).toContain("('central_warehouse_manager','movement_context.record',           false)");
    expect(migration).toContain("('warehouse_officer',        'movement_context.record',           false)");
  });

  it('grants movement_context.view_sensitive and .export_sensitive ONLY to institution_admin (and super_admin), never to the recording role', () => {
    expect(migration).toContain("('institution_admin',        'movement_context.view_sensitive',   true)");
    expect(migration).toContain("('institution_admin',        'movement_context.export_sensitive', true)");
    expect(migration).toContain("('outlet_officer',           'movement_context.view_sensitive',   false)");
    expect(migration).toContain("('outlet_officer',           'movement_context.export_sensitive', false)");
  });

  it('marks view_sensitive and export_sensitive as dangerous, record as not', () => {
    expect(migration).toMatch(/'movement_context\.record',\s*'movement_context', 'record',[^)]*false\)/);
    expect(migration).toMatch(/'movement_context\.view_sensitive',\s*'movement_context', 'view_sensitive',[^)]*true\)/);
    expect(migration).toMatch(/'movement_context\.export_sensitive',\s*'movement_context', 'export_sensitive',[^)]*true\)/);
  });
});

describe('134 phoenix_record_movement_dispense_context: SECURITY DEFINER, insert-only, idempotent, immutable', () => {
  const recordBody = migration.split('-- ── D. Get')[0];

  it('is SECURITY DEFINER with pinned search_path', () => {
    expect(recordBody).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_record_movement_dispense_context\([\s\S]*?SECURITY DEFINER[\s\S]{0,50}SET search_path = public, pg_temp/);
  });

  it('requires the movement to be reason_code=dispensed', () => {
    expect(recordBody).toContain("v_mv.reason_code <> 'dispensed'");
    expect(recordBody).toContain('movement_not_a_dispense');
  });

  it('gates on movement_context.record scoped to the movement organization and distribution point', () => {
    expect(recordBody).toContain(
      "phoenix_profile_has_scoped_permission(\n    v_actor, 'movement_context.record', v_mv.organization_id, NULL, v_mv.distribution_point_id\n  )",
    );
  });

  it('is idempotent on (movement_id, request_fingerprint) and refuses a conflicting replay', () => {
    expect(recordBody).toContain('idempotent_replay');
    expect(recordBody).toContain('movement_id_conflict');
  });

  it('never issues an UPDATE anywhere in the function (append-only)', () => {
    expect(recordBody).not.toMatch(/UPDATE public\.phoenix_movement_dispense_context/);
  });

  it('validates beneficiary-type-specific required fields server-side, not just via the CHECK constraint', () => {
    expect(recordBody).toContain('patient_identifier_or_name_required');
    expect(recordBody).toContain('crash_cart_reference_required');
    expect(recordBody).toContain('internal_order_reference_required');
  });
});

describe('134 phoenix_get_movement_dispense_context: masks sensitive fields unless view_sensitive', () => {
  const getBody = migration.split('-- ── D. Get')[1]?.split('-- ── E. Export')[0] ?? '';

  it('is SECURITY DEFINER with pinned search_path', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_get_movement_dispense_context\([\s\S]*?SECURITY DEFINER[\s\S]{0,50}SET search_path = public, pg_temp/);
  });

  it('denies cross-org access explicitly', () => {
    expect(getBody).toContain('forbidden_cross_org_access');
  });

  it('checks movement_context.view_sensitive before returning unmasked patient fields', () => {
    expect(getBody).toContain("phoenix_status_center_authorized(v_row.organization_id, 'movement_context.view_sensitive')");
  });

  it('masks patient_identifier and patient_name behind the view_sensitive gate', () => {
    expect(getBody).toMatch(/CASE WHEN v_can_view_sensitive THEN v_row\.patient_identifier ELSE NULL END/);
    expect(getBody).toMatch(/CASE WHEN v_can_view_sensitive THEN v_row\.patient_name ELSE NULL END/);
  });

  it('never masks crash_cart_reference or internal_order_reference (operational, not personal data)', () => {
    expect(getBody).toMatch(/'crash_cart_reference', v_row\.crash_cart_reference,/);
    expect(getBody).toMatch(/'internal_order_reference', v_row\.internal_order_reference,/);
    expect(getBody).not.toMatch(/CASE WHEN v_can_view_sensitive THEN v_row\.crash_cart_reference/);
    expect(getBody).not.toMatch(/CASE WHEN v_can_view_sensitive THEN v_row\.internal_order_reference/);
  });
});

describe('134 phoenix_export_movement_dispense_context: bulk, gated by the STRONGER export permission', () => {
  const exportBody = migration.split('-- ── E. Export')[1] ?? '';

  it('is SECURITY DEFINER with pinned search_path', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_export_movement_dispense_context\([\s\S]*?SECURITY DEFINER[\s\S]{0,50}SET search_path = public, pg_temp/);
  });

  it('gates on movement_context.export_sensitive, not view_sensitive', () => {
    expect(exportBody).toContain("phoenix_status_center_authorized(p_organization_id, 'movement_context.export_sensitive')");
  });

  it('scopes strictly by organization_id and a date range, never returning cross-org rows', () => {
    expect(exportBody).toContain('c.organization_id = p_organization_id');
    expect(exportBody).toContain('c.recorded_at >= p_from');
    expect(exportBody).toContain('c.recorded_at <= p_to');
  });

  it('rejects an invalid (reversed) date range', () => {
    expect(exportBody).toContain('invalid_date_range');
  });
});

describe('134 preserves invariants: EXECUTE grants scoped to authenticated only, precondition guard, verify block', () => {
  it('grants EXECUTE on all three RPCs to authenticated only, after an explicit REVOKE ALL FROM PUBLIC', () => {
    for (const fn of [
      'phoenix_record_movement_dispense_context(uuid, uuid, text, text, text, text, text, text)',
      'phoenix_get_movement_dispense_context(uuid)',
      'phoenix_export_movement_dispense_context(uuid, timestamptz, timestamptz)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`);
    }
  });

  it('fails closed if 133 (Group H slice) has not been applied', () => {
    expect(migration).toMatch(/134 PRECONDITION FAILED: 133 \(Group H slice\) missing/);
  });

  it('fails closed if outlet_stock_movements.reason_code (125) is missing', () => {
    expect(migration).toMatch(/134 PRECONDITION FAILED: outlet_stock_movements\.reason_code \(125\) missing/);
  });

  it('verifies the table and all 3 functions and all 3 permission keys exist', () => {
    expect(migration).toMatch(/134 VERIFY FAILED: phoenix_movement_dispense_context table missing/);
    expect(migration).toMatch(/134 VERIFY FAILED: expected exactly 3 dispense-context functions/);
    expect(migration).toMatch(/134 VERIFY FAILED: expected exactly 3 movement_context permission keys/);
  });
});
