/**
 * MOVEMENT-REASON-CODE-GROUP-F-OUTLET-131 — static contract.
 *
 * Sixth of eight domain slices. Covers outlet dispatch-receive (chained,
 * no new schema -- shares dispatch_line_id with the send-side movement),
 * dispense (root, clearest non-fit for the quality/loss vocabulary),
 * count (root, mandatory reason_code), and return-send (chained, no new
 * schema -- outlet_return_request_lines already had original_inbound_movement_id).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '131_phoenix_movement_reason_code_group_f_outlet.sql'),
  'utf8',
);

describe('131 adds no new schema (dispatch_line_id and original_inbound_movement_id already existed)', () => {
  it('contains no ALTER TABLE', () => {
    expect(migration).not.toMatch(/ALTER TABLE/);
  });
});

describe('131 redefines exactly the five Group F functions, all SECURITY DEFINER with pinned search_path', () => {
  for (const fn of [
    'phoenix_receive_outlet_dispatch_line', 'phoenix_dispense_outlet_stock',
    'phoenix_count_outlet_stock', 'phoenix_send_outlet_return_shipment_line',
    'phoenix_send_warehouse_dispatch',
  ]) {
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
    expect(names.sort()).toEqual([
      'phoenix_count_outlet_stock', 'phoenix_dispense_outlet_stock',
      'phoenix_receive_outlet_dispatch_line', 'phoenix_send_outlet_return_shipment_line',
      'phoenix_send_warehouse_dispatch',
    ]);
  });
});

describe('131 F5 phoenix_send_warehouse_dispatch: a genuine gap found while verifying this slice, not one of the 20 originally audited writers', () => {
  it("inserts the hardcoded literal reason_code='transferred'", () => {
    expect(migration).toContain(
      "'warehouse_dispatch_send', 'transferred', 'warehouse_dispatch_send', v_line.id, v_fingerprint,",
    );
  });

  it('generates a fresh correlation_id PER LINE inside the loop (not one shared across every line of one dispatch call) and never sets causation_id', () => {
    const f5Body = migration.split('-- ── F5.')[1] ?? '';
    expect(f5Body).toMatch(/gen_random_uuid\(\)\s*\n\s*\)\s*\n\s*RETURNING id INTO v_movement_id;/);
    const insertBlock = f5Body.match(/INSERT INTO public\.warehouse_stock_movements \([\s\S]{0,700}?\) VALUES/)?.[0] ?? '';
    expect(insertBlock).not.toContain('causation_id');
  });

  it('never issues its own DROP FUNCTION (signature unchanged)', () => {
    const f5Body = migration.split('-- ── F5.')[1] ?? '';
    expect(f5Body).not.toMatch(/DROP FUNCTION/);
  });
});

describe('131 F1 phoenix_receive_outlet_dispatch_line: validated reason_code, chains from the shared dispatch_line_id join', () => {
  it('drops the old 5-argument overload before creating the 6-argument version', () => {
    expect(migration).toMatch(
      /DROP FUNCTION IF EXISTS public\.phoenix_receive_outlet_dispatch_line\(\s*\n\s*uuid, uuid, integer, text, text\s*\n\);/,
    );
  });

  it('adds p_reason_code as the LAST parameter, DEFAULT NULL', () => {
    expect(migration).toMatch(
      /p_notes\s+text DEFAULT NULL,\s*\n\s*p_reason_code\s+text DEFAULT NULL\s*\n\)/,
    );
  });

  it('requires reason_code only when a difference exists, defaulting to received on an exact match', () => {
    expect(migration).toContain('difference_reason_code_required');
    expect(migration).toMatch(/v_reason_code := 'received';/);
  });

  it('looks up the send-side movement via reference_type=warehouse_dispatch_send / reference_id=p_dispatch_line_id (no new column)', () => {
    expect(migration).toMatch(
      /SELECT id, correlation_id INTO v_send_movement_id, v_correlation_id\s*\n\s*FROM public\.warehouse_stock_movements\s*\n\s*WHERE reference_type = 'warehouse_dispatch_send' AND reference_id = p_dispatch_line_id;/,
    );
  });

  it('sets causation_id to v_send_movement_id on the INSERT', () => {
    expect(migration).toContain('v_correlation_id, v_send_movement_id');
  });

  it('re-establishes the ACL on the new 6-argument overload', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_receive_outlet_dispatch_line\(uuid, uuid, integer, text, text, text\)\s*\n\s*FROM PUBLIC, anon;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_receive_outlet_dispatch_line\(uuid, uuid, integer, text, text, text\)\s*\n\s*TO authenticated;/,
    );
  });
});

describe('131 F2 phoenix_dispense_outlet_stock: reason_code=dispensed, fresh correlation_id, no causation, no signature change', () => {
  it("inserts the hardcoded literal reason_code='dispensed'", () => {
    expect(migration).toContain(
      "v_reason, 'dispensed', 'outlet_request', p_request_id, v_fingerprint,",
    );
  });

  it('generates a fresh correlation_id and never sets causation_id (terminal consumption event)', () => {
    const f2Body = migration.split('-- ── F3.')[0].split("-- ── F2.")[1] ?? '';
    expect(f2Body).toMatch(/v_correlation_id uuid := gen_random_uuid\(\);/);
    const insertBlock = f2Body.match(/INSERT INTO public\.outlet_stock_movements \([\s\S]{0,700}?\) VALUES/)?.[0] ?? '';
    expect(insertBlock).not.toContain('causation_id');
  });

  it('never issues its own DROP FUNCTION (signature unchanged)', () => {
    const f2Body = migration.split('-- ── F3.')[0].split("-- ── F2.")[1] ?? '';
    expect(f2Body).not.toMatch(/DROP FUNCTION/);
  });
});

describe('131 F3 phoenix_count_outlet_stock: mandatory validated reason_code, fresh correlation_id, no causation', () => {
  it('drops the old 5-argument overload before creating the 6-argument version', () => {
    expect(migration).toMatch(
      /DROP FUNCTION IF EXISTS public\.phoenix_count_outlet_stock\(\s*\n\s*uuid, uuid, integer, text, text\s*\n\);/,
    );
  });

  it('validates reason_code against the 10-value set (9 quality/loss values + corrected), and requires it unconditionally (no default fallback)', () => {
    expect(migration).toMatch(
      /'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',\s*\n\s*'recalled', 'quality_issue', 'temperature_excursion', 'corrected', 'other'/,
    );
    expect(migration).toContain('outlet_count_reason_code_required');
  });

  it('generates a fresh correlation_id and never sets causation_id (a physical count has no upstream document)', () => {
    const f3Body = migration.split('-- ── F4.')[0].split('-- ── F3.')[1] ?? '';
    expect(f3Body).toMatch(/v_correlation_id uuid := gen_random_uuid\(\);/);
    const insertBlock = f3Body.match(/INSERT INTO public\.outlet_stock_movements \([\s\S]{0,700}?\) VALUES/)?.[0] ?? '';
    expect(insertBlock).not.toContain('causation_id');
  });

  it('re-establishes the ACL on the new 6-argument overload', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_count_outlet_stock\(uuid, uuid, integer, text, text, text\)\s*\n\s*FROM PUBLIC, anon;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_count_outlet_stock\(uuid, uuid, integer, text, text, text\)\s*\n\s*TO authenticated;/,
    );
  });
});

describe('131 F4 phoenix_send_outlet_return_shipment_line: propagates v_line.reason_code, chains from original_inbound_movement_id', () => {
  it('inserts v_line.reason_code directly (no hardcoded literal)', () => {
    expect(migration).toContain(
      "'outlet_return', v_line.reason_code, 'outlet_return_send', p_request_id, v_fingerprint,",
    );
  });

  it('chains correlation_id from original_inbound_movement_id, falling back to fresh only when unknown', () => {
    const f4Body = migration.split('-- ── F4.')[1] ?? '';
    expect(f4Body).toMatch(/IF v_line\.original_inbound_movement_id IS NOT NULL THEN/);
    expect(f4Body).toMatch(
      /SELECT correlation_id INTO v_correlation_id\s*\n\s*FROM public\.outlet_stock_movements\s*\n\s*WHERE id = v_line\.original_inbound_movement_id;/,
    );
  });

  it('sets causation_id to v_line.original_inbound_movement_id verbatim', () => {
    const f4Body = migration.split('-- ── F4.')[1] ?? '';
    expect(f4Body).toContain('v_correlation_id, v_line.original_inbound_movement_id');
  });

  it('never issues its own DROP FUNCTION (signature unchanged)', () => {
    const f4Body = migration.split('-- ── F4.')[1] ?? '';
    expect(f4Body).not.toMatch(/DROP FUNCTION/);
  });
});

describe('131 preserves invariants: no GRANT widening beyond the intended re-grants, precondition guard, verify block', () => {
  it('does not GRANT to anon or PUBLIC anywhere', () => {
    expect(migration).not.toMatch(/GRANT .* TO (anon|PUBLIC)/i);
  });

  it('fails closed if 130 (Group E slice) has not been applied', () => {
    expect(migration).toMatch(/131 PRECONDITION FAILED: 130 \(Group E slice\) missing/);
  });

  it('verifies exactly 4 redefined functions', () => {
    expect(migration).toMatch(/131 VERIFY FAILED: expected exactly 5 Group F functions/);
  });
});
