/**
 * MOVEMENT-REASON-CODE-GROUP-A-WAREHOUSE-INTAKE-126 — static contract.
 *
 * First of eight domain slices wiring reason_code + correlation_id into the
 * 20 audited ledger-writer RPCs. This slice covers the two TRUE ROOT
 * warehouse-intake functions only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '126_phoenix_movement_reason_code_group_a_warehouse_intake.sql'),
  'utf8',
);

describe('126 redefines exactly the two Group A functions, both SECURITY DEFINER with pinned search_path', () => {
  for (const fn of ['phoenix_receive_warehouse_stock', 'phoenix_apply_warehouse_stock_movement']) {
    it(`redefines ${fn}() as SECURITY DEFINER with search_path pinned`, () => {
      const pattern = new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${fn}\\([\\s\\S]{0,2000}?SECURITY DEFINER[\\s\\S]{0,50}SET search_path = public, pg_temp`,
      );
      expect(migration).toMatch(pattern);
    });
  }

  it('touches no other function (no CREATE OR REPLACE FUNCTION beyond the two Group A writers)', () => {
    const matches = migration.match(/CREATE OR REPLACE FUNCTION public\.(\w+)/g) ?? [];
    const names = matches.map(m => m.replace('CREATE OR REPLACE FUNCTION public.', ''));
    expect(names.sort()).toEqual(['phoenix_apply_warehouse_stock_movement', 'phoenix_receive_warehouse_stock']);
  });
});

describe('126 phoenix_receive_warehouse_stock: root, reason_code=received, fresh correlation_id, no causation', () => {
  it('keeps the exact same parameter list (no signature change for this pure-root function)', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_receive_warehouse_stock\(\s*\n\s*p_request_id\s+uuid,/,
    );
    expect(migration).not.toMatch(/phoenix_receive_warehouse_stock\([\s\S]{0,3000}?p_reason_code/);
  });

  it('inserts the hardcoded literal reason_code=\'received\' (never client input)', () => {
    expect(migration).toContain(
      "'warehouse_receipt', 'received', 'warehouse_request', p_request_id, v_request_fingerprint,",
    );
  });

  it('generates a fresh correlation_id via gen_random_uuid() (this is a root event)', () => {
    expect(migration).toMatch(/v_correlation_id uuid := gen_random_uuid\(\);/);
  });

  it('inserts correlation_id into the movement row and never sets causation_id (true root, no predecessor)', () => {
    const fnBody = migration.split('CREATE OR REPLACE FUNCTION public.phoenix_receive_warehouse_stock(')[1]
      .split('-- ── A2.')[0];
    expect(fnBody).toMatch(/reason, reason_code, reference_type, reference_id, request_fingerprint,[\s\S]{0,500}correlation_id/);
    expect(fnBody).not.toMatch(/causation_id/);
  });
});

describe('126 phoenix_apply_warehouse_stock_movement: adds ONE optional trailing p_reason_code parameter', () => {
  it('adds p_reason_code as the LAST parameter, DEFAULT NULL (fully backward-compatible)', () => {
    expect(migration).toMatch(
      /p_notes\s+text DEFAULT NULL,\s*\n\s*p_reason_code\s+text DEFAULT NULL\s*\n\)/,
    );
  });

  it('validates p_reason_code against a closed subset excluding routine-operation codes (received/transferred/dispensed/counted/released are not manual-adjustment reasons)', () => {
    expect(migration).toMatch(
      /v_reason_code NOT IN \(\s*\n\s*'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',\s*\n\s*'recalled', 'quality_issue', 'temperature_excursion', 'corrected', 'other'\s*\n\s*\)/,
    );
    for (const excluded of ['received', 'transferred', 'dispensed', 'counted', 'released']) {
      const fnBody = migration.split('-- ── A2.')[1] ?? '';
      const validationBlock = fnBody.match(/v_reason_code NOT IN \(([\s\S]{0,300}?)\)/)?.[1] ?? '';
      expect(validationBlock).not.toContain(`'${excluded}'`);
    }
  });

  it('requires reason_code whenever movement_type is set_exact/correction, mirroring the existing free-text reason requirement', () => {
    expect(migration).toContain('warehouse_correction_reason_code_required');
    expect(migration).toMatch(
      /IF p_movement_type IN \('set_exact', 'correction'\) AND v_reason_code IS NULL THEN\s*\n\s*RAISE EXCEPTION 'warehouse_correction_reason_code_required'/,
    );
  });

  it("defaults reason_code to 'corrected' when the operator omits it for add/subtract", () => {
    expect(migration).toMatch(/IF v_reason_code IS NULL THEN\s*\n\s*v_reason_code := 'corrected';\s*\n\s*END IF;/);
  });

  it('generates a fresh correlation_id and never sets causation_id (confirmed root: 101 does not delegate to this function)', () => {
    const fnBody = migration.split('-- ── A2.')[1] ?? '';
    expect(fnBody).toMatch(/v_correlation_id uuid := gen_random_uuid\(\);/);
    expect(fnBody).not.toMatch(/causation_id/);
  });

  it('preserves the existing free-text reason column untouched alongside the new reason_code', () => {
    const fnBody = migration.split('-- ── A2.')[1] ?? '';
    expect(fnBody).toMatch(/v_reason, v_reason_code, 'warehouse_request', p_request_id, v_request_fingerprint,/);
  });
});

describe('126 preserves grants: no re-GRANT that could widen access', () => {
  it('does not issue any GRANT to anon/PUBLIC', () => {
    expect(migration).not.toMatch(/GRANT .* TO (anon|PUBLIC)/i);
  });

  it('documents (does not re-issue) the EXECUTE-revoked-from-authenticated ACL on the internal receive function (unchanged signature)', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION preserves existing GRANT\/REVOKE state/);
  });

  it('drops the old 7-argument phoenix_apply_warehouse_stock_movement overload before creating the 8-argument version (CREATE OR REPLACE cannot change the argument type list — it would silently create a second overload instead of replacing it)', () => {
    expect(migration).toMatch(
      /DROP FUNCTION IF EXISTS public\.phoenix_apply_warehouse_stock_movement\(\s*\n\s*uuid, uuid, text, integer, text, text, text\s*\n\);/,
    );
  });

  it('re-establishes internal-only ACL (REVOKE ALL FROM PUBLIC, anon, authenticated) on the new 8-argument overload, since DROP FUNCTION erases prior grants', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_apply_warehouse_stock_movement\(\s*\n\s*uuid, uuid, text, integer, text, text, text, text\s*\n\) FROM PUBLIC, anon, authenticated;/,
    );
  });
});

describe('126 has a precondition guard and a post-apply verify block', () => {
  it('fails closed if 125 reason_code column is not already present', () => {
    expect(migration).toMatch(/126 PRECONDITION FAILED: 125 \(reason_code column\) missing/);
  });

  it('verifies the receive function stays EXECUTE-revoked from authenticated and the apply function gained p_reason_code', () => {
    expect(migration).toMatch(/126 VERIFY FAILED: phoenix_receive_warehouse_stock must stay EXECUTE-revoked/);
    expect(migration).toMatch(/126 VERIFY FAILED: phoenix_apply_warehouse_stock_movement missing the new optional p_reason_code parameter/);
  });
});
