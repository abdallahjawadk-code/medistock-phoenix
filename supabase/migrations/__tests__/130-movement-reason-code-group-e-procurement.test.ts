/**
 * MOVEMENT-REASON-CODE-GROUP-E-PROCUREMENT-130 — static contract.
 *
 * Fifth of eight domain slices. Covers procurement receipt (root) and
 * return-to-supplier (chained, but uniquely needs NO new schema -- the
 * receipt line's own movement_id already existed).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '130_phoenix_movement_reason_code_group_e_procurement.sql'),
  'utf8',
);

describe('130 adds no new schema (procurement_receipt_lines.movement_id already existed)', () => {
  it('contains no ALTER TABLE', () => {
    expect(migration).not.toMatch(/ALTER TABLE/);
  });
});

describe('130 redefines exactly the two Group E functions, both SECURITY DEFINER with pinned search_path', () => {
  for (const fn of ['_phoenix_procurement_post_receipt_line', 'phoenix_procurement_return_to_supplier']) {
    it(`redefines ${fn}() as SECURITY DEFINER with search_path pinned`, () => {
      const pattern = new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${fn}\\([\\s\\S]{0,2000}?SECURITY DEFINER[\\s\\S]{0,50}SET search_path = public, pg_temp`,
      );
      expect(migration).toMatch(pattern);
    });
  }

  it('touches no other function', () => {
    const matches = migration.match(/CREATE OR REPLACE FUNCTION public\.(\w+)/g) ?? [];
    const names = matches.map(m => m.replace('CREATE OR REPLACE FUNCTION public.', ''));
    expect(names.sort()).toEqual(['_phoenix_procurement_post_receipt_line', 'phoenix_procurement_return_to_supplier']);
  });
});

describe('130 E1 _phoenix_procurement_post_receipt_line: root, reason_code=received, fresh correlation_id, no causation, no signature change', () => {
  it('keeps the exact same OUT-param signature (no p_reason_code -- this helper never had a reason parameter)', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\._phoenix_procurement_post_receipt_line\(\s*\n\s*p_receipt_line public\.procurement_receipt_lines,/,
    );
  });

  it("inserts the hardcoded literal reason_code='received'", () => {
    expect(migration).toContain(
      "'local_procurement_receipt', 'received', 'procurement_receipt_line', p_receipt_line.id,",
    );
  });

  it('generates a fresh correlation_id and never sets causation_id (true root)', () => {
    const e1Body = migration.split('-- ── E2.')[0];
    expect(e1Body).toMatch(/v_correlation_id uuid := gen_random_uuid\(\);/);
    const insertBlock = e1Body.match(/INSERT INTO public\.warehouse_stock_movements \([\s\S]{0,700}?\) VALUES/)?.[0] ?? '';
    expect(insertBlock).not.toContain('causation_id');
  });

  it('never issues its own DROP FUNCTION (signature unchanged)', () => {
    const e1Body = migration.split('-- ── E2.')[0];
    expect(e1Body).not.toMatch(/DROP FUNCTION/);
  });
});

describe('130 E2 phoenix_procurement_return_to_supplier: closed reason_code, chains from the ALREADY-EXISTING receipt_line.movement_id', () => {
  it('drops the old 6-argument overload before creating the 7-argument version', () => {
    expect(migration).toMatch(
      /DROP FUNCTION IF EXISTS public\.phoenix_procurement_return_to_supplier\(\s*\n\s*uuid, uuid, integer, text, text, bigint\s*\n\);/,
    );
  });

  it('adds p_reason_code as the LAST parameter, DEFAULT NULL', () => {
    expect(migration).toMatch(
      /p_expected_generation bigint DEFAULT NULL,\s*\n\s*p_reason_code\s+text DEFAULT NULL\s*\n\)/,
    );
  });

  it('validates p_reason_code against the original 9-value quality/loss vocabulary only (no corrected/received/transferred/etc.)', () => {
    expect(migration).toMatch(
      /v_reason_code NOT IN \(\s*\n\s*'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',\s*\n\s*'recalled', 'quality_issue', 'temperature_excursion', 'other'\s*\n\s*\)/,
    );
    const e2Body = migration.split('-- ── E2.')[1] ?? '';
    for (const excluded of ['received', 'transferred', 'dispensed', 'counted', 'released', 'corrected']) {
      const validationBlock = e2Body.match(/v_reason_code NOT IN \(([\s\S]{0,300}?)\)/)?.[1] ?? '';
      expect(validationBlock).not.toContain(`'${excluded}'`);
    }
  });

  it('reason_code is mandatory (no default fallback) -- unlike Group A\'s optional add/subtract default', () => {
    expect(migration).toContain('return_reason_code_required');
    expect(migration).not.toMatch(/v_reason_code := 'corrected';/);
  });

  it('re-establishes the internal ACL (REVOKE ALL FROM PUBLIC,anon then GRANT EXECUTE TO authenticated) on the new 7-argument overload', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_procurement_return_to_supplier\(\s*\n\s*uuid, uuid, integer, text, text, bigint, text\s*\n\) FROM PUBLIC, anon;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_procurement_return_to_supplier\(\s*\n\s*uuid, uuid, integer, text, text, bigint, text\s*\n\) TO authenticated;/,
    );
  });

  it('chains correlation_id/causation_id from v_receipt_line.movement_id -- a column that already existed before this migration (no ALTER TABLE anywhere in this file)', () => {
    const e2Body = migration.split('-- ── E2.')[1] ?? '';
    expect(e2Body).toMatch(/IF v_receipt_line\.movement_id IS NOT NULL THEN/);
    expect(e2Body).toMatch(
      /SELECT correlation_id INTO v_correlation_id\s*\n\s*FROM public\.warehouse_stock_movements\s*\n\s*WHERE id = v_receipt_line\.movement_id;/,
    );
    expect(e2Body).toContain('v_correlation_id, v_receipt_line.movement_id');
  });
});

describe('130 preserves invariants: no GRANT widening beyond the intended re-grant, precondition guard, verify block', () => {
  it('does not GRANT to anon or PUBLIC anywhere', () => {
    expect(migration).not.toMatch(/GRANT .* TO (anon|PUBLIC)/i);
  });

  it('fails closed if 129 (Group D slice) has not been applied', () => {
    expect(migration).toMatch(/130 PRECONDITION FAILED: 129 \(Group D slice\) missing/);
  });

  it('verifies the new p_reason_code parameter is present', () => {
    expect(migration).toMatch(/130 VERIFY FAILED: phoenix_procurement_return_to_supplier missing the new p_reason_code parameter/);
  });
});
