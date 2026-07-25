/**
 * MOVEMENT-REASON-CODE-GROUP-G-QUARANTINE-132 — static contract.
 *
 * Seventh of eight domain slices. Covers quarantine release (dual-ledger)
 * and destroy (single-ledger) -- the two remaining free-text-to-ledger
 * gaps. Neither needs a new parameter: v_q.quarantine_reason (already
 * locked, already resident) becomes reason_code verbatim.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '132_phoenix_movement_reason_code_group_g_quarantine.sql'),
  'utf8',
);

describe('132 adds no new schema and changes no signature', () => {
  it('contains no ALTER TABLE', () => {
    expect(migration).not.toMatch(/ALTER TABLE/);
  });

  it('contains no DROP FUNCTION (both signatures unchanged)', () => {
    expect(migration).not.toMatch(/DROP FUNCTION/);
  });
});

describe('132 redefines exactly the two Group G functions, both SECURITY DEFINER with pinned search_path', () => {
  for (const fn of ['phoenix_release_quarantine_stock', 'phoenix_destroy_quarantine_stock']) {
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
    expect(names.sort()).toEqual(['phoenix_destroy_quarantine_stock', 'phoenix_release_quarantine_stock']);
  });
});

describe('132 G1 phoenix_release_quarantine_stock: reason_code=v_q.quarantine_reason on BOTH ledgers, cross-ledger causation chain', () => {
  it('inserts v_q.quarantine_reason into reason_code on the quarantine-side (debit) row', () => {
    expect(migration).toContain(
      "v_q.quantity, -p_quantity, v_q.quantity - p_quantity, v_reason, v_q.quarantine_reason,",
    );
  });

  it('inserts v_q.quarantine_reason into reason_code on the warehouse-side (credit) row too -- same value, not a different derivation', () => {
    expect(migration).toContain(
      "'quarantine_release: ' || v_reason, v_q.quarantine_reason,",
    );
  });

  it('looks up the most recent prior movement against this exact quarantine lot BEFORE either insert', () => {
    const g1Body = migration.split('-- ── G2.')[0];
    expect(g1Body).toMatch(
      /SELECT id, correlation_id INTO v_predecessor_id, v_correlation_id\s*\n\s*FROM public\.warehouse_quarantine_stock_movements\s*\n\s*WHERE quarantine_stock_id = v_q\.id\s*\n\s*ORDER BY created_at DESC\s*\n\s*LIMIT 1;/,
    );
    expect(g1Body).toMatch(/v_correlation_id := COALESCE\(v_correlation_id, gen_random_uuid\(\)\);/);
  });

  it('inserts the quarantine-side row FIRST and captures its own id as v_quarantine_movement_id', () => {
    const g1Body = migration.split('-- ── G2.')[0];
    const quarantineInsertIdx = g1Body.indexOf('INSERT INTO public.warehouse_quarantine_stock_movements');
    const warehouseInsertIdx = g1Body.indexOf('INSERT INTO public.warehouse_stock_movements');
    expect(quarantineInsertIdx).toBeGreaterThan(0);
    expect(warehouseInsertIdx).toBeGreaterThan(quarantineInsertIdx);
    expect(g1Body).toContain('RETURNING id INTO v_quarantine_movement_id;');
  });

  it('the warehouse-side credit row chains causation_id from the quarantine-side row this SAME call just inserted', () => {
    const g1Body = migration.split('-- ── G2.')[0];
    expect(g1Body).toContain('v_correlation_id, v_quarantine_movement_id\n  );');
  });

  it('the quarantine-side row chains causation_id from the looked-up predecessor', () => {
    const g1Body = migration.split('-- ── G2.')[0];
    expect(g1Body).toContain('v_correlation_id, v_predecessor_id\n  )\n  RETURNING id INTO v_quarantine_movement_id;');
  });
});

describe('132 G2 phoenix_destroy_quarantine_stock: reason_code=v_q.quarantine_reason, chains from the most recent prior movement', () => {
  it('inserts v_q.quarantine_reason into reason_code (not fresh client free text mapped 1:1)', () => {
    const g2Body = migration.split('-- ── G2.')[1] ?? '';
    expect(g2Body).toContain(
      "v_q.quantity, -p_quantity, v_q.quantity - p_quantity, v_reason, v_q.quarantine_reason,",
    );
  });

  it('looks up the most recent prior movement against this exact quarantine lot', () => {
    const g2Body = migration.split('-- ── G2.')[1] ?? '';
    expect(g2Body).toMatch(
      /SELECT id, correlation_id INTO v_predecessor_id, v_correlation_id\s*\n\s*FROM public\.warehouse_quarantine_stock_movements\s*\n\s*WHERE quarantine_stock_id = v_q\.id\s*\n\s*ORDER BY created_at DESC\s*\n\s*LIMIT 1;/,
    );
  });

  it('chains causation_id from the looked-up predecessor', () => {
    const g2Body = migration.split('-- ── G2.')[1] ?? '';
    expect(g2Body).toContain('v_correlation_id, v_predecessor_id\n  )\n  RETURNING id INTO v_existing;');
  });
});

describe('132 preserves invariants: no GRANT statements at all (neither signature changed), precondition guard, verify block', () => {
  it('does not issue any GRANT (no signature change means no re-grant is needed)', () => {
    expect(migration).not.toMatch(/GRANT /i);
  });

  it('fails closed if 131 (Group F slice) has not been applied', () => {
    expect(migration).toMatch(/132 PRECONDITION FAILED: 131 \(Group F slice\) missing/);
  });

  it('verifies exactly 2 redefined functions', () => {
    expect(migration).toMatch(/132 VERIFY FAILED: expected exactly 2 Group G functions/);
  });
});
