/**
 * OUTLET-STOCK-CORRECTION-086 — static SQL contract tests.
 *
 * Dynamic proof (correction advances generation, 40001 on a stale generation,
 * idempotent replay, reservation-safe, forbidden scope) is in
 * 086-outlet-correction-generation.dynamic.test.ts. These pin: additive (adds a
 * generation column + trigger + ONE guarded wrapper, drops/revokes nothing),
 * the wrapper delegates the write to the unchanged phoenix_count_outlet_stock,
 * the generation is server-owned (trigger), and the wrapper is least-granted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { stripSqlComments, executableSql, sqlFunctionSource } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '086_phoenix_outlet_stock_correction_expected_generation.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const active = stripSqlComments(sql);
const exec = executableSql(sql);
const guarded = sqlFunctionSource(sql, 'phoenix_count_outlet_stock_guarded');
const bump = sqlFunctionSource(sql, 'phoenix_outlet_stock_bump_movement_seq');

describe('registration and apply discipline', () => {
  it('is registered', () => expect(REVIEWED_MIGRATION_FILES).toContain(NAME));
  it('is manual-apply only', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });
  it('is a single transaction', () => {
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
  it('aborts fail-closed if outlet_stock/movements or the count RPC is missing, or if already applied', () => {
    expect(active).toMatch(/to_regclass\('public\.outlet_stock'\) IS NULL/);
    expect(active).toMatch(/phoenix_count_outlet_stock\(uuid, uuid, integer, text, text\)'\) IS NULL/);
    expect(active).toMatch(/outlet_stock\.movement_seq already exists/);
  });
});

describe('additive — retires nothing', () => {
  it('drops no table and no function', () => {
    expect(exec).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(exec).not.toMatch(/\bDROP\s+FUNCTION\b/i);
  });
  it('revokes no existing writer (the legacy count RPC stays callable)', () => {
    expect(exec).not.toMatch(/REVOKE EXECUTE[\s\S]*phoenix_count_outlet_stock\(/i);
  });
});

describe('A. server-owned generation', () => {
  it('adds a NOT NULL default-0 movement_seq column to outlet_stock', () => {
    expect(active).toMatch(/ALTER TABLE public\.outlet_stock\s+ADD COLUMN movement_seq bigint NOT NULL DEFAULT 0/);
  });
  it('advances the generation only on an on_hand/reserved change, via a BEFORE UPDATE trigger', () => {
    expect(bump).not.toBeNull();
    expect(bump!).toMatch(/on_hand_quantity\s+IS DISTINCT FROM OLD\.on_hand_quantity/);
    expect(bump!).toMatch(/reserved_quantity\s+IS DISTINCT FROM OLD\.reserved_quantity/);
    expect(bump!).toMatch(/NEW\.movement_seq := OLD\.movement_seq \+ 1/);
    expect(active).toMatch(/CREATE TRIGGER outlet_stock_bump_movement_seq\s+BEFORE UPDATE ON public\.outlet_stock/);
  });
});

describe('B. the guarded wrapper delegates the write, adding only the generation check', () => {
  it('exists', () => expect(guarded).not.toBeNull());
  it('takes the SAME advisory-lock key as the legacy body (re-entrant no-op)', () => {
    expect(guarded!).toMatch(/pg_advisory_xact_lock\(hashtextextended\(p_request_id::text, 67067\)\)/);
  });
  it('short-circuits a replay by delegating immediately (idempotency before the generation check)', () => {
    // the replay branch delegates to the legacy count body
    expect(guarded!).toMatch(/reference_id\s+=\s+p_request_id[\s\S]*RETURN public\.phoenix_count_outlet_stock\(/);
  });
  it('raises 40001 outlet_stock_generation_conflict on a moved generation', () => {
    expect(guarded!).toMatch(/v_seq IS DISTINCT FROM p_expected_generation/);
    expect(guarded!).toMatch(/outlet_stock_generation_conflict/);
    expect(guarded!).toMatch(/ERRCODE = '40001'/);
  });
  it('performs the actual write ONLY by delegating to the unchanged phoenix_count_outlet_stock', () => {
    // no direct write to outlet_stock inside the wrapper — the count body owns it
    const g = executableSql(guarded!);
    expect(g).not.toMatch(/UPDATE public\.outlet_stock\b/i);
    expect(g).not.toMatch(/INSERT INTO public\.outlet_stock_movements/i);
    expect(guarded!).toMatch(/RETURN public\.phoenix_count_outlet_stock\(/);
  });
  it('is SECURITY DEFINER, pinned, and least-granted', () => {
    expect(guarded!).toMatch(/SECURITY DEFINER/);
    expect(guarded!).toMatch(/SET search_path = public, pg_temp/);
    expect(active).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_count_outlet_stock_guarded\([\s\S]*?\) FROM PUBLIC, anon/);
    expect(active).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_count_outlet_stock_guarded\([\s\S]*?\) TO authenticated/);
  });
});
