/**
 * MOVEMENT-REASON-CODE-GROUP-B-WAREHOUSE-TRANSFER-127 — static contract.
 *
 * Second of eight domain slices. Covers the send/receive pair for
 * warehouse-to-warehouse transfers -- the first genuinely CHAINED pair in
 * the audit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '127_phoenix_movement_reason_code_group_b_warehouse_transfer.sql'),
  'utf8',
);

describe('127 adds a real link from a transfer line to its send movement', () => {
  it('adds warehouse_transfer_lines.source_movement_id referencing warehouse_stock_movements, ON DELETE SET NULL', () => {
    expect(migration).toMatch(
      /ALTER TABLE public\.warehouse_transfer_lines\s*\n\s*ADD COLUMN IF NOT EXISTS source_movement_id uuid\s*\n\s*REFERENCES public\.warehouse_stock_movements\(id\) ON DELETE SET NULL;/,
    );
  });
});

describe('127 redefines exactly the two Group B functions, both SECURITY DEFINER with pinned search_path', () => {
  for (const fn of ['phoenix_send_warehouse_transfer_line', 'phoenix_receive_warehouse_transfer_line']) {
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
    expect(names.sort()).toEqual(['phoenix_receive_warehouse_transfer_line', 'phoenix_send_warehouse_transfer_line']);
  });

  it('neither function signature changed (both are unmodified argument type lists, so CREATE OR REPLACE genuinely replaces rather than overloading)', () => {
    expect(migration).not.toMatch(/DROP FUNCTION/);
  });
});

describe('127 phoenix_send_warehouse_transfer_line: reason_code=transferred, fresh correlation_id, no causation', () => {
  it("inserts the hardcoded literal reason_code='transferred'", () => {
    expect(migration).toContain(
      "'warehouse_transfer_send', 'transferred', 'warehouse_transfer_send', p_request_id, v_fingerprint,",
    );
  });

  it('generates a fresh correlation_id (no predecessor movement exists to inherit from, even when answering a request line)', () => {
    const sendBody = migration
      .split('CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_transfer_line(')[1]
      .split('-- ── B2.')[0];
    expect(sendBody).toMatch(/v_correlation_id uuid := gen_random_uuid\(\);/);
  });

  it('never sets causation_id on the send-side INSERT column list (true root from a correlation-chain perspective; a comment nearby may mention the word, but no column list does)', () => {
    const sendBody = migration
      .split('CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_transfer_line(')[1]
      .split('-- ── B2.')[0];
    const insertBlock = sendBody.match(/INSERT INTO public\.warehouse_stock_movements \([\s\S]{0,600}?\) VALUES/)?.[0] ?? '';
    expect(insertBlock).not.toContain('causation_id');
  });

  it('persists its own movement id onto the transfer line immediately after the movement INSERT, so the receive side can chain from it', () => {
    expect(migration).toMatch(
      /UPDATE public\.warehouse_transfer_lines\s*\n\s*SET source_movement_id = v_movement_id\s*\n\s*WHERE id = v_line_id;/,
    );
  });
});

describe('127 phoenix_receive_warehouse_transfer_line: reason_code=received, chains correlation/causation from source_movement_id', () => {
  it("inserts the hardcoded literal reason_code='received'", () => {
    expect(migration).toContain(
      "'warehouse_transfer_receive', 'received', 'warehouse_transfer_receive', p_request_id, v_fingerprint,",
    );
  });

  it('looks up the send-side correlation_id via source_movement_id, falling back to a fresh id only when no predecessor is known', () => {
    const receiveBody = migration.split('-- ── B2.')[1] ?? '';
    expect(receiveBody).toMatch(/IF v_line\.source_movement_id IS NOT NULL THEN/);
    expect(receiveBody).toMatch(
      /SELECT correlation_id INTO v_correlation_id\s*\n\s*FROM public\.warehouse_stock_movements\s*\n\s*WHERE id = v_line\.source_movement_id;/,
    );
    expect(receiveBody).toMatch(/v_correlation_id := COALESCE\(v_correlation_id, gen_random_uuid\(\)\);/);
  });

  it('sets causation_id to the real, already-locked source_movement_id (never a client-supplied or guessed value)', () => {
    const receiveBody = migration.split('-- ── B2.')[1] ?? '';
    expect(receiveBody).toMatch(/correlation_id, causation_id\s*\n\s*\) VALUES \(/);
    expect(receiveBody).toContain('v_correlation_id, v_line.source_movement_id');
  });

  it('the rejected-line branch (received_quantity=0) is untouched -- writes no movement row, so nothing to tag', () => {
    const receiveBody = migration.split('-- ── B2.')[1] ?? '';
    const rejectedBranch = receiveBody.split("'ok', true, 'idempotent_replay', false, 'line_status', 'rejected'")[0];
    expect(rejectedBranch).not.toMatch(/INSERT INTO public\.warehouse_stock_movements/);
  });
});

describe('127 preserves invariants: no GRANT widening, precondition guard, verify block', () => {
  it('does not issue any GRANT to anon/PUBLIC', () => {
    expect(migration).not.toMatch(/GRANT .* TO (anon|PUBLIC)/i);
  });

  it('fails closed if 126 (Group A slice) has not been applied', () => {
    expect(migration).toMatch(/127 PRECONDITION FAILED: 126 \(Group A slice\) missing/);
  });

  it('verifies the new column and exactly 2 redefined functions', () => {
    expect(migration).toMatch(/127 VERIFY FAILED: warehouse_transfer_lines\.source_movement_id missing/);
    expect(migration).toMatch(/127 VERIFY FAILED: expected exactly 2 Group B functions/);
  });
});
