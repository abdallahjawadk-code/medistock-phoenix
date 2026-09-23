/**
 * M214 static guard — Central Needs readiness RPC transaction-mode correction.
 * The production defect was caused by a STABLE RPC calling the canonical
 * Central Needs guard, which takes SELECT ... FOR KEY SHARE. M214 must remain
 * a surgical volatility-only correction.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { activeSql, executableSql } from './helpers/sql-source';
import {
  REVIEWED_MIGRATION_FILES,
  getMaximumReviewedMigrationNumber,
  getNextUnreviewedMigrationNumber,
  isReviewedMigrationFile,
} from './helpers/reviewed-migrations';

const MIGRATIONS = join(__dirname, '..');
const FILENAME = '214_phoenix_central_needs_review_readiness_volatility.sql';
const SQL = readFileSync(join(MIGRATIONS, FILENAME), 'utf8');
const CODE = activeSql(SQL);
const EXEC = executableSql(SQL);

const TARGET =
  'ALTER FUNCTION public.phoenix_central_needs_review_readiness(uuid) VOLATILE;';

describe('M214 static — registration and exact scope', () => {
  it('is registered at 214, immediately below C2/M215 which is now the ceiling', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files).toContain(FILENAME);
    expect(isReviewedMigrationFile(FILENAME)).toBe(true);
    expect(REVIEWED_MIGRATION_FILES).toContain(FILENAME);
    // C2/M215 (the governed correction lifecycle) sits directly after 214; its
    // own static suite owns the ceiling assertions from here on. The 214 -> 215
    // relationship is HISTORICAL and never moves; only the ceiling below
    // advances, now to C4/M216 (Central Needs region persistence).
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.indexOf(FILENAME) + 1]).toBe('215_phoenix_central_needs_governed_correction_lifecycle.sql');
    expect(getMaximumReviewedMigrationNumber()).toBe(216);
    expect(getNextUnreviewedMigrationNumber()).toBe(217);
  });

  it('changes exactly the readiness RPC volatility to VOLATILE', () => {
    expect(CODE.trim()).toBe(TARGET);
    expect(EXEC).toContain(TARGET);
    expect(EXEC).not.toMatch(/\bSTABLE\b/i);
  });

  it('does not replace the function body or alter security/auth contracts', () => {
    for (const forbidden of [
      'CREATE OR REPLACE FUNCTION',
      'CREATE FUNCTION',
      'DROP FUNCTION',
      'SECURITY DEFINER',
      'SECURITY INVOKER',
      'SET search_path',
      'GRANT ',
      'REVOKE ',
      '_phoenix_central_needs_guard_v1',
    ]) {
      expect(EXEC.toUpperCase()).not.toContain(forbidden.toUpperCase());
    }
  });

  it('contains no table, policy, DML or data mutation', () => {
    for (const forbidden of [
      'ALTER TABLE', 'CREATE TABLE', 'DROP TABLE', 'CREATE POLICY', 'DROP POLICY',
      'INSERT INTO', 'UPDATE ', 'DELETE FROM', 'TRUNCATE ',
    ]) {
      expect(EXEC.toUpperCase()).not.toContain(forbidden.toUpperCase());
    }
  });
});
