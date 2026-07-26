/**
 * MOVEMENT-REASON-CODE-GROUP-C-WAREHOUSE-RETURN-128 — static contract.
 *
 * Third of eight domain slices. Covers the warehouse return send/receive
 * pair (institution -> central) -- the cheapest fix in the audit: both
 * functions already had a real closed-vocabulary reason available one hop
 * upstream and simply never wired it into the ledger row.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '128_phoenix_movement_reason_code_group_c_warehouse_return.sql'),
  'utf8',
);

describe('128 adds a real link from a return shipment line to its send movement', () => {
  it('adds warehouse_return_shipment_lines.source_movement_id referencing warehouse_stock_movements, ON DELETE SET NULL', () => {
    expect(migration).toMatch(
      /ALTER TABLE public\.warehouse_return_shipment_lines\s*\n\s*ADD COLUMN IF NOT EXISTS source_movement_id uuid\s*\n\s*REFERENCES public\.warehouse_stock_movements\(id\) ON DELETE SET NULL;/,
    );
  });
});

describe('128 redefines exactly the two Group C functions, both SECURITY DEFINER with pinned search_path, no signature change', () => {
  for (const fn of ['phoenix_send_warehouse_return_shipment_line', 'phoenix_receive_warehouse_return_shipment_line']) {
    it(`redefines ${fn}() as SECURITY DEFINER with search_path pinned`, () => {
      const pattern = new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${fn}\\([\\s\\S]{0,2000}?SECURITY DEFINER[\\s\\S]{0,50}SET search_path = public, pg_temp`,
      );
      expect(migration).toMatch(pattern);
    });
  }

  it('touches no other function and never DROPs a function (both signatures unchanged)', () => {
    const matches = migration.match(/CREATE OR REPLACE FUNCTION public\.(\w+)/g) ?? [];
    const names = matches.map(m => m.replace('CREATE OR REPLACE FUNCTION public.', ''));
    expect(names.sort()).toEqual(['phoenix_receive_warehouse_return_shipment_line', 'phoenix_send_warehouse_return_shipment_line']);
    expect(migration).not.toMatch(/DROP FUNCTION/);
  });
});

describe('128 phoenix_send_warehouse_return_shipment_line: propagates v_reqline.reason_code verbatim', () => {
  it('inserts v_reqline.reason_code directly (no hardcoded literal, no free-text reason_code)', () => {
    expect(migration).toContain(
      "'warehouse_transfer_return', v_reqline.reason_code, 'warehouse_return_send', p_request_id, v_fingerprint,",
    );
  });

  it('generates a fresh correlation_id (request-line predecessor has no correlation_id of its own)', () => {
    const sendBody = migration
      .split('CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_return_shipment_line(')[1]
      .split('-- ── C2.')[0];
    expect(sendBody).toMatch(/v_correlation_id uuid := gen_random_uuid\(\);/);
  });

  it('never sets causation_id on the send-side INSERT column list', () => {
    const sendBody = migration
      .split('CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_return_shipment_line(')[1]
      .split('-- ── C2.')[0];
    const insertBlock = sendBody.match(/INSERT INTO public\.warehouse_stock_movements \([\s\S]{0,700}?\) VALUES/)?.[0] ?? '';
    expect(insertBlock).not.toContain('causation_id');
  });

  it('persists its own movement id onto the shipment line immediately after the movement INSERT', () => {
    expect(migration).toMatch(
      /UPDATE public\.warehouse_return_shipment_lines\s*\n\s*SET source_movement_id = v_movement_id\s*\n\s*WHERE id = v_line_id;/,
    );
  });
});

describe('128 phoenix_receive_warehouse_return_shipment_line: wires the already-computed v_reason_code onto BOTH branches', () => {
  it('the restockable branch inserts v_reason_code verbatim into reason_code', () => {
    expect(migration).toContain(
      "'warehouse_transfer_return', v_reason_code, 'warehouse_return_receive', p_request_id, v_fingerprint,",
    );
  });

  it('the quarantine branch inserts the same disposition-classified CASE expression into reason_code (not v_reason_code raw)', () => {
    const receiveBody = migration.split('-- ── C2.')[1] ?? '';
    const quarantineInsert = receiveBody.match(/INSERT INTO public\.warehouse_quarantine_stock_movements \([\s\S]{0,3000}?RETURNING id INTO v_movement_id;/)?.[0] ?? '';
    expect(quarantineInsert).toMatch(
      /'warehouse_transfer_return',\s*\n\s*CASE\s*\n\s*WHEN v_objectively_expired AND v_reason_code IS DISTINCT FROM 'expired' THEN 'expired'\s*\n\s*WHEN v_reason_code IN \('expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion', 'other'\)\s*\n\s*THEN v_reason_code\s*\n\s*ELSE 'other'\s*\n\s*END,/,
    );
  });

  it('chains correlation_id from source_movement_id, falling back to fresh only when unknown, computed ONCE before either branch', () => {
    const receiveBody = migration.split('-- ── C2.')[1] ?? '';
    expect(receiveBody).toMatch(/IF v_line\.source_movement_id IS NOT NULL THEN/);
    expect(receiveBody).toMatch(
      /SELECT correlation_id INTO v_correlation_id\s*\n\s*FROM public\.warehouse_stock_movements\s*\n\s*WHERE id = v_line\.source_movement_id;/,
    );
    expect(receiveBody).toMatch(/v_correlation_id := COALESCE\(v_correlation_id, gen_random_uuid\(\)\);/);
  });

  it('sets causation_id to v_line.source_movement_id on BOTH the restockable and quarantine branch inserts', () => {
    const receiveBody = migration.split('-- ── C2.')[1] ?? '';
    const occurrences = (receiveBody.match(/v_correlation_id, v_line\.source_movement_id/g) ?? []).length;
    expect(occurrences).toBe(2);
  });

  it('the rejected-line branch (received_quantity=0) writes no movement row on either ledger', () => {
    const receiveBody = migration.split('-- ── C2.')[1] ?? '';
    const rejectedBranch = receiveBody.split("'line_status', 'rejected',")[0];
    expect(rejectedBranch).not.toMatch(/INSERT INTO public\.warehouse_stock_movements/);
    expect(rejectedBranch).not.toMatch(/INSERT INTO public\.warehouse_quarantine_stock_movements/);
  });
});

describe('128 preserves invariants: no GRANT widening, precondition guard, verify block', () => {
  it('does not issue any GRANT to anon/PUBLIC', () => {
    expect(migration).not.toMatch(/GRANT .* TO (anon|PUBLIC)/i);
  });

  it('fails closed if 127 (Group B slice) has not been applied', () => {
    expect(migration).toMatch(/128 PRECONDITION FAILED: 127 \(Group B slice\) missing/);
  });

  it('verifies the new column and exactly 2 redefined functions', () => {
    expect(migration).toMatch(/128 VERIFY FAILED: warehouse_return_shipment_lines\.source_movement_id missing/);
    expect(migration).toMatch(/128 VERIFY FAILED: expected exactly 2 Group C functions/);
  });
});
