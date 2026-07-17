/**
 * RBAC-SECURITY-HARDENING-CHECKPOINT-063-A
 *
 * Static SQL-source tests for migration 063 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of every other
 * migration test here (052–062).
 *
 * Migration 063 is a PRIVILEGE-ONLY hardening checkpoint. It records two
 * already-approved production corrections applied by hand after migration 062:
 *   1. REVOKE ALL EXECUTE (PUBLIC/anon/authenticated) from the three trigger-only
 *      functions 062 left at PostgreSQL's default PUBLIC EXECUTE.
 *   2. REVOKE SELECT on profile_permission_overrides from anon.
 * It must create nothing, drop nothing, alter no table/function/trigger/policy,
 * and grant nothing back.
 *
 * NOTE ON SCOPE: like the 060–062 tests, this file contains NO global ceiling
 * assertion (no `getMaximumReviewedMigrationNumber() === 63`, no hard-coded guess
 * at 064's filename). Those belong to reviewed-migration-manifest.test.ts alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES, isReviewedMigrationFile } from './helpers/reviewed-migrations';
// SQL-SOURCE-LEXER-A: comment stripping is lexical and shared. The per-file
// `/--.*$/` this replaced stripped nothing at all on a CRLF checkout, which made
// every prose-based guard below silently inert on Windows.
import { activeSql } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M063_NAME = '063_phoenix_rbac_security_hardening.sql';
const P063 = join(MIGRATIONS_DIR, M063_NAME);
const m063 = readFileSync(P063, 'utf8');

const active063 = activeSql(m063);
/** Whitespace-normalized active SQL: multi-line statements collapse to one line. */
const norm063 = active063.replace(/\s+/g, ' ').trim();

/** The three trigger-only functions hardened here (exact zero-arg signatures). */
const TRIGGER_FUNCTIONS = [
  'public.phoenix_protect_last_super_admin()',
  'public.phoenix_validate_ppo_scope()',
  'public.phoenix_validate_profile_scope_assignment()',
] as const;

/** The three application helpers 062 granted authenticated EXECUTE — untouched. */
const APPLICATION_HELPERS = [
  'phoenix_profile_has_scoped_permission',
  'phoenix_profile_has_warehouse_assignment',
  'phoenix_profile_has_point_assignment',
] as const;

// ============================================================================
// File presence, uniqueness, registration
// ============================================================================

describe('Migration 063 exists exactly once and is registered', () => {
  it('063_phoenix_rbac_security_hardening.sql exists', () => {
    expect(existsSync(P063)).toBe(true);
  });

  it('is the only file named 063_*', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('063_'))).toEqual([M063_NAME]);
  });

  // PROFILE-IDENTITY-SNAPSHOT-RETURN-TYPE-064-A: the former
  // `does not create migration 064` disk assertion is DELIBERATELY ABSENT, for
  // the same reason 062's test never carried one (see its "DELIBERATELY ABSENT"
  // note). A `readdirSync(...startsWith('064_')) === []` check is not a property
  // of migration 063 at all — it is a ceiling on the NEXT phase, and it forces an
  // unrelated historical guard to be edited the moment a legitimate 064 lands.
  // That churn is precisely the hazard the canonical registry exists to remove:
  // whether 064 is approved is decided by exact-filename membership in
  // REVIEWED_MIGRATION_FILES and asserted in reviewed-migration-manifest.test.ts
  // alone. 063's own scope stays fully covered by the assertions below, which
  // verify what 063's SQL does and does not contain.

  it('is registered in the reviewed-migration registry by exact filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M063_NAME);
    expect(isReviewedMigrationFile(M063_NAME)).toBe(true);
  });
});

// ============================================================================
// Transaction wrapping + manual-apply discipline
// ============================================================================

describe('Migration 063 apply discipline', () => {
  it('is wrapped in a single begin/commit transaction', () => {
    expect(active063).toMatch(/^\s*begin;/i);
    expect(active063.trim()).toMatch(/commit;\s*$/i);
    expect((norm063.match(/\bBEGIN;/gi) ?? []).length).toBe(1);
    expect((norm063.match(/\bCOMMIT;/gi) ?? []).length).toBe(1);
  });

  it('is manual-apply-only (documents no supabase db push)', () => {
    expect(m063).toContain('MANUAL APPLY ONLY');
    expect(m063).toContain('supabase db push');
  });
});

// ============================================================================
// The exact four REVOKEs, with exact function identities
// ============================================================================

describe('Migration 063 records exactly the four approved REVOKEs', () => {
  it('contains exactly four REVOKE statements', () => {
    expect((norm063.match(/\bREVOKE\b/g) ?? []).length).toBe(4);
  });

  it('revokes ALL from PUBLIC, anon, authenticated on each trigger-only function (exact zero-arg signature)', () => {
    for (const fn of TRIGGER_FUNCTIONS) {
      expect(norm063).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated;`);
    }
  });

  it('uses exact zero-argument identity signatures (no argument-typed overload form)', () => {
    for (const fn of TRIGGER_FUNCTIONS) {
      const base = fn.slice(0, fn.indexOf('('));
      // The only occurrence of each function name is the exact `name()` form.
      expect(norm063).toContain(`${base}()`);
      expect(norm063).not.toMatch(new RegExp(base.replace(/\./g, '\\.') + '\\(\\s*\\w'));
    }
  });

  it('revokes SELECT on profile_permission_overrides from anon — exactly once', () => {
    expect(norm063).toContain('REVOKE SELECT ON TABLE public.profile_permission_overrides FROM anon;');
    expect((norm063.match(/REVOKE SELECT/g) ?? []).length).toBe(1);
  });

  it('the only table-level REVOKE targets profile_permission_overrides (no other table)', () => {
    const tableRevokes = [...norm063.matchAll(/REVOKE\s+[A-Z, ]*\s+ON\s+TABLE\s+(\S+)/g)].map(m => m[1]);
    expect(tableRevokes).toEqual(['public.profile_permission_overrides']);
  });
});

// ============================================================================
// The three application helpers keep their authenticated EXECUTE grant
// ============================================================================

describe('Migration 063 does not touch the application scope helpers', () => {
  it('never references any of the three application helper functions', () => {
    for (const helper of APPLICATION_HELPERS) {
      expect(norm063).not.toContain(helper);
    }
  });

  it('grants nothing (no replacement privilege is issued)', () => {
    expect(norm063).not.toMatch(/\bGRANT\b/i);
  });
});

// ============================================================================
// warehouses historical anon SELECT is not changed
// ============================================================================

describe('Migration 063 leaves public.warehouses anon SELECT unchanged', () => {
  it('does not reference warehouses in any executable statement', () => {
    expect(norm063).not.toMatch(/\bwarehouses?\b/i);
  });

  it('revokes anon only from profile_permission_overrides, never from warehouses', () => {
    expect(norm063).not.toMatch(/warehouses\s+FROM\s+anon/i);
  });
});

// ============================================================================
// No schema / policy / trigger / function-body change; no destructive DDL
// ============================================================================

describe('Migration 063 changes privileges only', () => {
  it('modifies no RLS policy', () => {
    expect(norm063).not.toMatch(/\b(CREATE|DROP|ALTER)\s+POLICY\b/i);
  });

  it('modifies no trigger definition', () => {
    expect(norm063).not.toMatch(/\b(CREATE|DROP|ALTER)\s+TRIGGER\b/i);
  });

  it('modifies no function definition', () => {
    expect(norm063).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i);
    expect(norm063).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    expect(norm063).not.toMatch(/\bALTER\s+FUNCTION\b/i);
  });

  it('contains no schema DDL (no CREATE/ALTER TABLE, no ADD/DROP COLUMN, no index)', () => {
    expect(norm063).not.toMatch(/\b(CREATE|ALTER)\s+TABLE\b/i);
    expect(norm063).not.toMatch(/\b(ADD|DROP)\s+COLUMN\b/i);
    expect(norm063).not.toMatch(/\b(CREATE|DROP)\s+(UNIQUE\s+)?INDEX\b/i);
  });

  it('contains no destructive DDL/DML (no DROP TABLE, TRUNCATE, DELETE, INSERT, UPDATE)', () => {
    expect(norm063).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(norm063).not.toMatch(/\bTRUNCATE\b/i);
    expect(norm063).not.toMatch(/\bDELETE\b/i);
    expect(norm063).not.toMatch(/\bINSERT\b/i);
    expect(norm063).not.toMatch(/\bUPDATE\b/i);
  });

  it('every executable statement is a REVOKE (plus the transaction wrappers)', () => {
    const statements = norm063
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    for (const s of statements) {
      expect(s, `unexpected statement: ${s}`).toMatch(/^(BEGIN|COMMIT|REVOKE\b)/i);
    }
  });
});

// ============================================================================
// Immutability of prior migrations (git-scoped)
// ============================================================================

describe('Migration 063 does not modify any existing migration 001–062', () => {
  it('touches no migration SQL file numbered 001–062', () => {
    let diff = '';
    try {
      diff = execSync('git status --porcelain -- supabase/migrations', { cwd: ROOT, encoding: 'utf8' });
    } catch {
      /* ignore — absence of git is not a semantic failure here */
    }
    const touchedExisting = diff
      .split('\n')
      .filter(l => l.trim())
      .some(l => {
        const path = l.slice(3).trim();
        const file = path.split('/').pop() ?? '';
        return /^0(0[1-9]|[1-5]\d|6[0-2])_.*\.sql$/.test(file);
      });
    expect(touchedExisting).toBe(false);
  });
});
