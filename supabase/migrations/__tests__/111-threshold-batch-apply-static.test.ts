/**
 * THRESHOLD-BATCH-APPLY-STATIC — registration + discipline contract tests for
 * 111. The behavioral proof is 111-threshold-batch-apply.dynamic.test.ts
 * (real Postgres, 001->111 replay).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '111_phoenix_threshold_batch_apply.sql';

const load = (name: string) => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8').replace(/\r\n?/g, '\n');
  const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;')).replace(/^[ \t]*--.*$/gm, '');
  return { sql, code };
};

describe('registration and manual-apply discipline', () => {
  it('111 is registered and manual-apply-only', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
    const { sql } = load(NAME);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
});

describe('111 — threshold batch apply (extends 092, no parallel system)', () => {
  const { code } = load(NAME);

  it('adds exactly ONE function and NO new table or column — pure extension of 092', () => {
    expect(code).not.toMatch(/CREATE TABLE/);
    expect(code).not.toMatch(/ALTER TABLE/);
    const fns = code.match(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g) ?? [];
    expect(fns).toEqual(['CREATE OR REPLACE FUNCTION public.phoenix_batch_upsert_inventory_threshold(']);
  });

  it('delegates every batch element to 092\'s UNCHANGED phoenix_upsert_inventory_threshold', () => {
    expect(code).toMatch(/public\.phoenix_upsert_inventory_threshold\(/);
    // No independent authorization/validation logic duplicated here — the
    // batch function itself performs no phoenix_profile_has_scoped_permission
    // or phoenix_my_role() check; that all lives in 092's function.
    expect(code).not.toMatch(/phoenix_profile_has_scoped_permission/);
    expect(code).not.toMatch(/RAISE EXCEPTION 'not_authorized/);
  });

  it('is capped to bound batch size (not an unbounded bulk-import path)', () => {
    expect(code).toMatch(/jsonb_array_length\(p_items\) > 200/);
    expect(code).toMatch(/batch_too_large/);
  });

  it('is SECURITY DEFINER with a pinned search_path, fail-closed grants', () => {
    const fnIdx = code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_batch_upsert_inventory_threshold');
    const fnBlock = code.slice(fnIdx, code.indexOf('$$;', fnIdx) + 3);
    expect(fnBlock).toMatch(/SECURITY DEFINER/);
    expect(fnBlock).toMatch(/SET search_path = public, pg_temp/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_batch_upsert_inventory_threshold\([^)]*\) FROM PUBLIC, anon/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_batch_upsert_inventory_threshold\([^)]*\) TO authenticated/);
  });

  it('the whole batch is one transaction (no per-element SAVEPOINT) — atomic all-or-nothing', () => {
    expect(code).not.toMatch(/SAVEPOINT/i);
    expect(code).not.toMatch(/EXCEPTION\s+WHEN/i); // no per-item exception swallowing
  });
});
