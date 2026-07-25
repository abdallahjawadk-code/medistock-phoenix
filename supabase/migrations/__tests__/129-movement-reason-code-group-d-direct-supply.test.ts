/**
 * MOVEMENT-REASON-CODE-GROUP-D-DIRECT-SUPPLY-129 — static contract.
 *
 * Fourth of eight domain slices. Covers the direct (route-free)
 * central<->institution transfer/return send functions -- structural twins
 * of Groups B and C's send functions. The corresponding receive functions
 * are shared with the routed corridor and were already fixed in 127/128.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '129_phoenix_movement_reason_code_group_d_direct_supply.sql'),
  'utf8',
);

describe('129 adds no new schema (reuses source_movement_id from 127/128)', () => {
  it('contains no ALTER TABLE (both link columns already exist)', () => {
    expect(migration).not.toMatch(/ALTER TABLE/);
  });
});

describe('129 redefines exactly the two Group D functions, both SECURITY DEFINER with pinned search_path, no signature change', () => {
  for (const fn of ['phoenix_send_direct_warehouse_transfer_line', 'phoenix_send_direct_warehouse_return_shipment_line']) {
    it(`redefines ${fn}() as SECURITY DEFINER with search_path pinned`, () => {
      const pattern = new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${fn}\\([\\s\\S]{0,2000}?SECURITY DEFINER[\\s\\S]{0,50}SET search_path = public, pg_temp`,
      );
      expect(migration).toMatch(pattern);
    });
  }

  it('touches no other function and never DROPs a function', () => {
    const matches = migration.match(/CREATE OR REPLACE FUNCTION public\.(\w+)/g) ?? [];
    const names = matches.map(m => m.replace('CREATE OR REPLACE FUNCTION public.', ''));
    expect(names.sort()).toEqual(['phoenix_send_direct_warehouse_return_shipment_line', 'phoenix_send_direct_warehouse_transfer_line']);
    expect(migration).not.toMatch(/DROP FUNCTION/);
  });
});

describe('129 phoenix_send_direct_warehouse_transfer_line: identical fix to 127\'s routed send', () => {
  it("inserts the hardcoded literal reason_code='transferred'", () => {
    expect(migration).toContain(
      "'warehouse_transfer_send', 'transferred', 'warehouse_transfer_send', p_request_id, v_fingerprint,",
    );
  });

  it('generates a fresh correlation_id and never sets causation_id on the INSERT column list', () => {
    const d1Body = migration
      .split('CREATE OR REPLACE FUNCTION public.phoenix_send_direct_warehouse_transfer_line(')[1]
      .split('-- ── D2.')[0];
    expect(d1Body).toMatch(/v_correlation_id uuid := gen_random_uuid\(\);/);
    const insertBlock = d1Body.match(/INSERT INTO public\.warehouse_stock_movements \([\s\S]{0,700}?\) VALUES/)?.[0] ?? '';
    expect(insertBlock).not.toContain('causation_id');
  });

  it('populates warehouse_transfer_lines.source_movement_id, the SAME column 127 established for the routed corridor', () => {
    const d1Body = migration
      .split('CREATE OR REPLACE FUNCTION public.phoenix_send_direct_warehouse_transfer_line(')[1]
      .split('-- ── D2.')[0];
    expect(d1Body).toMatch(
      /UPDATE public\.warehouse_transfer_lines\s*\n\s*SET source_movement_id = v_movement_id\s*\n\s*WHERE id = v_line_id;/,
    );
  });
});

describe('129 phoenix_send_direct_warehouse_return_shipment_line: identical fix to 128\'s routed send', () => {
  it('inserts v_reqline.reason_code verbatim (same closed vocabulary as the routed corridor)', () => {
    expect(migration).toContain(
      "'warehouse_transfer_return', v_reqline.reason_code, 'warehouse_return_send', p_request_id, v_fingerprint,",
    );
  });

  it('generates a fresh correlation_id and never sets causation_id on the INSERT column list', () => {
    const d2Body = migration.split('-- ── D2.')[1] ?? '';
    expect(d2Body).toMatch(/v_correlation_id uuid := gen_random_uuid\(\);/);
    const insertBlock = d2Body.match(/INSERT INTO public\.warehouse_stock_movements \([\s\S]{0,700}?\) VALUES/)?.[0] ?? '';
    expect(insertBlock).not.toContain('causation_id');
  });

  it('populates warehouse_return_shipment_lines.source_movement_id, the SAME column 128 established for the routed corridor', () => {
    const d2Body = migration.split('-- ── D2.')[1] ?? '';
    expect(d2Body).toMatch(
      /UPDATE public\.warehouse_return_shipment_lines\s*\n\s*SET source_movement_id = v_movement_id\s*\n\s*WHERE id = v_line_id;/,
    );
  });
});

describe('129 preserves invariants: no GRANT widening, precondition guard, verify block', () => {
  it('does not issue any GRANT to anon/PUBLIC', () => {
    expect(migration).not.toMatch(/GRANT .* TO (anon|PUBLIC)/i);
  });

  it('fails closed if 128 (Group C slice) has not been applied', () => {
    expect(migration).toMatch(/129 PRECONDITION FAILED: 128 \(Group C slice\) missing/);
  });

  it('verifies exactly 2 redefined functions', () => {
    expect(migration).toMatch(/129 VERIFY FAILED: expected exactly 2 Group D functions/);
  });
});
