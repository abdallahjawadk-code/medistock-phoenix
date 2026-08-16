import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = '186_phoenix_correction_reason_code_wrapper_parity.sql';
const PATH = join(__dirname, '..', NAME);
const sql = () => readFileSync(PATH, 'utf8');

describe('Migration 186 · correction reason-code wrapper parity (static)', () => {
  it('exists under the one authorized exact filename', () => {
    expect(existsSync(PATH)).toBe(true);
  });

  it('replaces only the two existing guarded wrapper signatures', () => {
    const text = sql();
    expect(text.match(/CREATE OR REPLACE FUNCTION public\.phoenix_count_outlet_stock_guarded\s*\(/g)).toHaveLength(1);
    expect(text.match(/CREATE OR REPLACE FUNCTION public\.phoenix_apply_warehouse_stock_movement_guarded\s*\(/g)).toHaveLength(1);
    expect(text).not.toMatch(/CREATE\s+(?:UNLOGGED\s+)?TABLE|ALTER\s+TABLE|CREATE\s+TRIGGER|CREATE\s+POLICY/i);
  });

  it('passes server-owned corrected to outlet replay and fresh delegates', () => {
    const text = sql();
    const calls = [...text.matchAll(/RETURN public\.phoenix_count_outlet_stock\s*\([\s\S]*?\);/g)];
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call[0]).toMatch(/p_notes\s*,\s*'corrected'/);
  });

  it('derives warehouse reason-code narrowly on replay and fresh delegates', () => {
    const text = sql();
    const calls = [...text.matchAll(/RETURN public\.phoenix_apply_warehouse_stock_movement\s*\([\s\S]*?\);/g)];
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[0]).toMatch(/CASE\s+WHEN p_movement_type IN \('correction', 'set_exact'\)\s+THEN 'corrected'\s+ELSE NULL\s+END/);
    }
  });

  it('pins SECURITY DEFINER, search_path, ACLs, and a fail-closed verify block', () => {
    const text = sql();
    expect(text.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(text.match(/SET search_path = public, pg_temp/g)).toHaveLength(2);
    expect(text).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_count_outlet_stock_guarded[\s\S]*TO authenticated/);
    expect(text).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_apply_warehouse_stock_movement_guarded[\s\S]*TO authenticated/);
    expect(text).toMatch(/FROM PUBLIC, anon/);
    expect(text).toContain('186 VERIFY FAILED');
  });
});
