/**
 * MOVEMENT-REASON-CODE-GROUP-H-CORRECTION-APPROVAL-133 — static contract.
 *
 * Eighth and FINAL domain slice. Covers phoenix_approve_outlet_stock_
 * correction and phoenix_approve_warehouse_stock_correction -- neither
 * needs a new parameter: reason_code is a fixed 'corrected' constant, and
 * correlation_id/causation_id chain from the most recent prior movement on
 * the exact stock row.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '133_phoenix_movement_reason_code_group_h_correction_approval.sql'),
  'utf8',
);

describe('133 adds no new schema and changes no signature', () => {
  it('contains no ALTER TABLE', () => {
    expect(migration).not.toMatch(/ALTER TABLE/);
  });

  it('contains no DROP FUNCTION (both signatures unchanged)', () => {
    expect(migration).not.toMatch(/DROP FUNCTION/);
  });

  it('issues no GRANT (neither signature changed)', () => {
    expect(migration).not.toMatch(/GRANT /i);
  });
});

describe('133 redefines exactly the two Group H functions, both SECURITY DEFINER with pinned search_path', () => {
  for (const fn of ['phoenix_approve_outlet_stock_correction', 'phoenix_approve_warehouse_stock_correction']) {
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
    expect(names.sort()).toEqual(['phoenix_approve_outlet_stock_correction', 'phoenix_approve_warehouse_stock_correction']);
  });
});

describe('133 H1 phoenix_approve_outlet_stock_correction: reason_code=corrected, chains from most recent prior movement', () => {
  const h1Body = migration.split('-- ── H2.')[0];

  it('inserts the fixed reason_code literal corrected (not client-derived)', () => {
    expect(h1Body).toContain(
      "v_req.reason, 'corrected', 'outlet_request', v_req.underlying_request_id, v_fp,",
    );
  });

  it('preserves the non-self-approval gate', () => {
    expect(h1Body).toContain('proposer_cannot_approve_own_correction');
  });

  it('preserves the independent approval-permission gate (not delegated to the counting RPC)', () => {
    expect(h1Body).toContain("phoenix_status_center_authorized(v_req.organization_id, 'outlet_stock.approve_correction')");
  });

  it('looks up the most recent prior movement against this exact outlet stock row BEFORE the insert', () => {
    expect(h1Body).toMatch(
      /SELECT id, correlation_id INTO v_predecessor_id, v_correlation_id\s*\n\s*FROM public\.outlet_stock_movements\s*\n\s*WHERE outlet_stock_id = v_stock\.id\s*\n\s*ORDER BY created_at DESC\s*\n\s*LIMIT 1;/,
    );
    expect(h1Body).toMatch(/v_correlation_id := COALESCE\(v_correlation_id, gen_random_uuid\(\)\);/);
  });

  it('chains correlation_id/causation_id from the looked-up predecessor on the INSERT', () => {
    expect(h1Body).toContain('v_correlation_id, v_predecessor_id\n    )\n    RETURNING id INTO v_movement_id;');
  });

  it('preserves the generation guard and reserved-quantity floor', () => {
    expect(h1Body).toContain('outlet_stock_generation_conflict');
    expect(h1Body).toContain('outlet_quantity_below_reserved');
  });
});

describe('133 H2 phoenix_approve_warehouse_stock_correction: reason_code=corrected, chains from most recent prior movement', () => {
  const h2Body = migration.split('-- ── H2.')[1] ?? '';

  it('inserts the fixed reason_code literal corrected (not client-derived)', () => {
    expect(h2Body).toContain(
      "v_req.reason, 'corrected', 'warehouse_request', v_req.underlying_request_id, v_fp,",
    );
  });

  it('preserves the non-self-approval gate', () => {
    expect(h2Body).toContain('proposer_cannot_approve_own_correction');
  });

  it('preserves the independent approval-permission gate', () => {
    expect(h2Body).toContain("phoenix_status_center_authorized(v_req.organization_id, 'warehouse_stock.approve_correction')");
  });

  it('looks up the most recent prior movement against this exact warehouse stock row BEFORE the insert', () => {
    expect(h2Body).toMatch(
      /SELECT id, correlation_id INTO v_predecessor_id, v_correlation_id\s*\n\s*FROM public\.warehouse_stock_movements\s*\n\s*WHERE warehouse_stock_id = v_stock\.id\s*\n\s*ORDER BY created_at DESC\s*\n\s*LIMIT 1;/,
    );
    expect(h2Body).toMatch(/v_correlation_id := COALESCE\(v_correlation_id, gen_random_uuid\(\)\);/);
  });

  it('chains correlation_id/causation_id from the looked-up predecessor on the INSERT', () => {
    expect(h2Body).toContain('v_correlation_id, v_predecessor_id\n  )\n  RETURNING id INTO v_movement_id;');
  });

  it('preserves the negative-quantity and reserved-quantity floors', () => {
    expect(h2Body).toContain('warehouse_quantity_cannot_go_negative');
    expect(h2Body).toContain('warehouse_quantity_below_reserved');
  });
});

describe('133 preserves invariants: precondition guard, verify block', () => {
  it('fails closed if 132 (Group G slice) has not been applied', () => {
    expect(migration).toMatch(/133 PRECONDITION FAILED: 132 \(Group G slice\) missing/);
  });

  it('verifies exactly 2 redefined functions', () => {
    expect(migration).toMatch(/133 VERIFY FAILED: expected exactly 2 Group H functions/);
  });

  it('announces completion of all 8 groups', () => {
    expect(migration).toMatch(/All 8 groups complete/);
  });
});
