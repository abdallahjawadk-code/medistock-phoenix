/**
 * DISPENSE-WITH-CONTEXT-ATOMIC-136 — static contract.
 *
 * 136 makes 134's dispense-context operationally creatable from the real
 * dispense workflow, atomically, and adds the patient_reference_type the
 * operational contract needs (which document the reference number came from).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '136_phoenix_dispense_with_context_atomic.sql'),
  'utf8',
);

describe('136 patient_reference_type: closed vocabulary, non-sensitive, type-scoped', () => {
  it('adds the column idempotently', () => {
    expect(migration).toMatch(
      /ALTER TABLE public\.phoenix_movement_dispense_context\s*\n\s*ADD COLUMN IF NOT EXISTS patient_reference_type text;/,
    );
  });

  it('constrains it to chart/card/pass and forbids it on non-patient rows', () => {
    expect(migration).toContain("patient_reference_type IN ('chart', 'card', 'pass')");
    expect(migration).toContain("beneficiary_type <> 'patient' AND patient_reference_type IS NULL");
  });

  it('adds the constraint idempotently (re-application safe)', () => {
    expect(migration).toContain("WHERE conname = 'phoenix_movement_dispense_context_patient_ref_type_chk'");
  });

  it('documents that it is a document KIND and deliberately NOT masked', () => {
    expect(migration).toContain('COMMENT ON COLUMN public.phoenix_movement_dispense_context.patient_reference_type');
    expect(migration).toMatch(/deliberately NOT masked/);
  });
});

describe('136 record RPC: signature change handled correctly, server-side validation', () => {
  it('DROPS the old 8-arg overload before redefining (the migration-126 lesson)', () => {
    expect(migration).toMatch(
      /DROP FUNCTION IF EXISTS public\.phoenix_record_movement_dispense_context\(\s*\n\s*uuid, uuid, text, text, text, text, text, text\s*\n\s*\);/,
    );
  });

  it('re-establishes the ACL on the NEW 9-arg signature only', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.phoenix_record_movement_dispense_context(uuid, uuid, text, text, text, text, text, text, text) FROM PUBLIC;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.phoenix_record_movement_dispense_context(uuid, uuid, text, text, text, text, text, text, text) TO authenticated;',
    );
  });

  it('requires reference type and number together, or neither', () => {
    expect(migration).toContain('patient_reference_type_required');
    expect(migration).toContain('patient_identifier_required_for_reference_type');
  });

  it('rejects an out-of-vocabulary reference type and one on a non-patient row', () => {
    expect(migration).toContain('invalid_patient_reference_type');
    expect(migration).toContain('patient_reference_type_not_applicable');
  });

  it('keeps the movement-must-be-a-dispense and permission gates', () => {
    expect(migration).toContain('movement_not_a_dispense');
    expect(migration).toContain("'movement_context.record', v_mv.organization_id, NULL, v_mv.distribution_point_id");
  });

  it('keeps idempotency on movement_id and still refuses a conflicting payload', () => {
    expect(migration).toContain('idempotent_replay');
    expect(migration).toContain('movement_id_conflict');
  });

  it('has no UPDATE or DELETE path on the context table anywhere in the migration', () => {
    expect(migration).not.toMatch(/UPDATE public\.phoenix_movement_dispense_context/);
    expect(migration).not.toMatch(/DELETE FROM public\.phoenix_movement_dispense_context/);
  });
});

describe('136 get/export: the new field is exposed but the masking rules are unchanged', () => {
  const get = migration.split('-- ── C. Get')[1]?.split('-- ── D. Export')[0] ?? '';
  const exp = migration.split('-- ── D. Export')[1]?.split('-- ── E.')[0] ?? '';

  it('get still masks identifier and name behind view_sensitive', () => {
    expect(get).toMatch(/CASE WHEN v_can_view_sensitive THEN v_row\.patient_identifier ELSE NULL END/);
    expect(get).toMatch(/CASE WHEN v_can_view_sensitive THEN v_row\.patient_name ELSE NULL END/);
  });

  it('get NEVER masks patient_reference_type (a document kind is not identity)', () => {
    expect(get).toContain("'patient_reference_type', v_row.patient_reference_type,");
    expect(get).not.toMatch(/CASE WHEN v_can_view_sensitive THEN v_row\.patient_reference_type/);
  });

  it('get still denies cross-org access explicitly', () => {
    expect(get).toContain('forbidden_cross_org_access');
  });

  it('export is still gated on the STRONGER export_sensitive permission and org-scoped', () => {
    expect(exp).toContain("'movement_context.export_sensitive'");
    expect(exp).toContain('c.organization_id = p_organization_id');
  });
});

describe('136 the atomic composition', () => {
  const compose = migration.split('-- ── E. The atomic composition')[1] ?? '';

  it('is SECURITY DEFINER with a pinned search_path', () => {
    expect(compose).toMatch(/SECURITY DEFINER[\s\S]{0,80}SET search_path = public, pg_temp/);
  });

  it('composes the two REVIEWED writers rather than reimplementing either', () => {
    expect(compose).toContain('public.phoenix_dispense_outlet_stock(');
    expect(compose).toContain('public.phoenix_record_movement_dispense_context(');
    // No direct ledger or context INSERT of its own.
    expect(compose).not.toMatch(/INSERT\s+INTO\s+public\.(outlet_stock_movements|phoenix_movement_dispense_context)/);
  });

  it('never touches quantities itself (no UPDATE of outlet_stock)', () => {
    expect(compose).not.toMatch(/UPDATE public\.outlet_stock\b/);
  });

  it('validates the beneficiary type BEFORE moving any quantity', () => {
    const validateIdx = compose.indexOf('invalid_beneficiary_type');
    const dispenseIdx = compose.indexOf('public.phoenix_dispense_outlet_stock(');
    expect(validateIdx).toBeGreaterThan(0);
    expect(dispenseIdx).toBeGreaterThan(validateIdx);
  });

  it('fails closed if the dispense returns no movement id', () => {
    expect(compose).toContain('dispense_returned_no_movement');
  });

  it('passes ONE request id to both halves (retry safety across the pair)', () => {
    expect(compose).toMatch(/phoenix_dispense_outlet_stock\(\s*\n\s*p_request_id,/);
    expect(compose).toMatch(/phoenix_record_movement_dispense_context\(\s*\n\s*p_request_id, v_movement_id,/);
  });

  it('is granted to authenticated only, after an explicit REVOKE from PUBLIC and anon', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_dispense_outlet_stock_with_context\([\s\S]{0,200}?\) FROM PUBLIC, anon;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_dispense_outlet_stock_with_context\([\s\S]{0,200}?\) TO authenticated;/);
  });

  it('documents that it adds no authority', () => {
    expect(migration).toMatch(/adds no authority/);
  });
});

describe('136 preserves invariants: precondition guard, verify block', () => {
  it('fails closed if 135 has not been applied', () => {
    expect(migration).toMatch(/136 PRECONDITION FAILED: 135 \(Group I\) missing/);
  });

  it('verifies the new column, the single record overload, and the composition function', () => {
    expect(migration).toMatch(/136 VERIFY FAILED: patient_reference_type missing/);
    expect(migration).toMatch(/136 VERIFY FAILED: expected exactly 1 record overload/);
    expect(migration).toMatch(/136 VERIFY FAILED: atomic composition function missing/);
  });
});
