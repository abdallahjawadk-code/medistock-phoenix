/**
 * MOVEMENT-REASON-CODE-GROUP-I-OUTLET-RETURN-RECEIVE-135 — static contract.
 *
 * Group I is not a planned slice: it is the writer the completeness guard
 * introduced in this same milestone DISCOVERED. These assertions pin the fix
 * so it cannot silently regress.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '135_phoenix_movement_reason_code_group_i_outlet_return_receive.sql'),
  'utf8',
);

describe('135 adds exactly the missing chain anchor and changes no signature', () => {
  it('adds outlet_return_shipment_lines.source_movement_id, idempotently, as a nullable FK', () => {
    expect(migration).toMatch(
      /ALTER TABLE public\.outlet_return_shipment_lines\s*\n\s*ADD COLUMN IF NOT EXISTS source_movement_id uuid\s*\n\s*REFERENCES public\.outlet_stock_movements\(id\) ON DELETE SET NULL;/,
    );
  });

  it('adds no other column and drops nothing', () => {
    const alters = migration.match(/ALTER TABLE[\s\S]*?;/g) ?? [];
    expect(alters.length).toBe(1);
    expect(migration).not.toMatch(/DROP (TABLE|COLUMN|FUNCTION)/);
  });

  it('documents the new column', () => {
    expect(migration).toContain('COMMENT ON COLUMN public.outlet_return_shipment_lines.source_movement_id');
  });

  it('issues no GRANT (neither function signature changed)', () => {
    expect(migration).not.toMatch(/GRANT /i);
  });
});

describe('135 redefines exactly the two Group I functions, both SECURITY DEFINER with pinned search_path', () => {
  for (const fn of [
    'phoenix_send_outlet_return_shipment_line',
    'phoenix_receive_outlet_return_shipment_line',
  ]) {
    it(`redefines ${fn}() as SECURITY DEFINER with search_path pinned`, () => {
      const pattern = new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${fn}\\([\\s\\S]{0,2500}?SECURITY DEFINER[\\s\\S]{0,80}SET search_path = public, pg_temp`,
      );
      expect(migration).toMatch(pattern);
    });
  }

  it('touches no other function', () => {
    const names = (migration.match(/CREATE OR REPLACE FUNCTION public\.(\w+)/g) ?? [])
      .map(m => m.replace('CREATE OR REPLACE FUNCTION public.', ''))
      .sort();
    expect(names).toEqual([
      'phoenix_receive_outlet_return_shipment_line',
      'phoenix_send_outlet_return_shipment_line',
    ]);
  });
});

describe('135 I1 SEND — populates the anchor with its own movement id', () => {
  const send = migration.split('-- ── I2.')[0];

  it('names source_movement_id in the shipment-line INSERT column list', () => {
    expect(send).toContain('original_dispatch_line_id, original_inbound_movement_id,\n    source_movement_id,');
  });

  it('supplies v_movement_id — the row it just inserted — as that column value', () => {
    expect(send).toContain('v_line.original_dispatch_line_id, v_line.original_inbound_movement_id,\n    v_movement_id,');
  });

  it('still inserts its own ledger row BEFORE the shipment line, so the id exists', () => {
    const movementIdx = send.indexOf('INSERT INTO public.outlet_stock_movements');
    const lineIdx = send.indexOf('INSERT INTO public.outlet_return_shipment_lines');
    expect(movementIdx).toBeGreaterThan(0);
    expect(lineIdx).toBeGreaterThan(movementIdx);
  });
});

describe('135 I2 RECEIVE — reason_code on BOTH ledger branches + the chain', () => {
  const recv = migration.split('-- ── I2.')[1] ?? '';

  it('resolves the predecessor from source_movement_id BEFORE any insert', () => {
    expect(recv).toContain('v_predecessor_id := v_line.source_movement_id;');
    const anchorIdx = recv.indexOf('v_predecessor_id := v_line.source_movement_id;');
    const firstInsert = recv.indexOf('INSERT INTO public.warehouse_stock_movements');
    expect(anchorIdx).toBeGreaterThan(0);
    expect(firstInsert).toBeGreaterThan(anchorIdx);
  });

  it('falls back to a fresh correlation_id when the line predates 135 (no guess)', () => {
    expect(recv).toMatch(/v_correlation_id := COALESCE\(v_correlation_id, gen_random_uuid\(\)\);/);
  });

  it('RESTOCKABLE branch writes reason_code = the return line\'s own closed value', () => {
    expect(recv).toContain("'outlet_return', v_reason_code, 'outlet_return_receive', p_request_id, v_fingerprint,");
  });

  it('QUARANTINE branch writes reason_code = the lot\'s own disposition-classified quarantine_reason', () => {
    expect(recv).toContain("'outlet_return', v_quarantine.quarantine_reason, 'outlet_return_quarantine_receive', p_request_id, v_fingerprint,");
  });

  it('BOTH branches chain correlation_id/causation_id from the resolved predecessor', () => {
    expect((recv.match(/v_correlation_id, v_predecessor_id/g) ?? []).length).toBe(2);
  });

  it('both ledger INSERTs now name reason_code, correlation_id and causation_id', () => {
    expect((recv.match(/reason, reason_code, reference_type/g) ?? []).length).toBe(2);
    expect((recv.match(/correlation_id, causation_id\n    \) VALUES/g) ?? []).length).toBe(2);
  });

  it('preserves the pre-existing idempotency and disposition guards', () => {
    expect(recv).toContain('request_id_conflict');
    expect(recv).toContain('return_receive_requires_explicit_disposition_decision');
    expect(recv).toContain('return_receive_unclassified_reason_code');
    expect(recv).toContain('pg_advisory_xact_lock');
  });
});

describe('135 preserves invariants: precondition guard, verify block', () => {
  it('fails closed if 134 has not been applied', () => {
    expect(migration).toMatch(/135 PRECONDITION FAILED: 134 \(dispense context\) missing/);
  });

  it('verifies the new column exists', () => {
    expect(migration).toMatch(/135 VERIFY FAILED: outlet_return_shipment_lines\.source_movement_id missing/);
  });

  it('verifies exactly 2 Group I functions', () => {
    expect(migration).toMatch(/135 VERIFY FAILED: expected exactly 2 Group I functions/);
  });

  it('asserts the receive function references every contract field IN THE STORED BODY, not a comment', () => {
    expect(migration).toContain("p.prosrc LIKE '%reason_code%'");
    expect(migration).toContain("p.prosrc LIKE '%correlation_id%'");
    expect(migration).toContain("p.prosrc LIKE '%causation_id%'");
    expect(migration).toMatch(/135 VERIFY FAILED: receive function still missing a contract field/);
  });
});
