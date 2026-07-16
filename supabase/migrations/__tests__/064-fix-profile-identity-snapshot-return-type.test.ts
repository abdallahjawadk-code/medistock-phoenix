/**
 * PROFILE-IDENTITY-SNAPSHOT-RETURN-TYPE-064-A
 *
 * Static SQL-source tests for migration 064 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of every other
 * migration test here (052–063).
 *
 * Migration 064 fixes SQLSTATE 42804 in public.get_profile_identity_snapshot.
 * Migration 013 declared the third OUT column as `email text` while the body
 * returns auth.users.email, which Supabase declares `character varying(255)`.
 * plpgsql validates query structure against the declared result type, so every
 * call failed at RETURN QUERY.
 *
 * The fix is one cast — `u.email::text`. This file exists to prove the fix is
 * present AND that nothing else moved: the signature, security attributes,
 * search_path and privileges must all be byte-for-byte what 013 established.
 *
 * NOTE ON SCOPE: like the 060–063 tests, this file contains NO global ceiling
 * assertion (no `getMaximumReviewedMigrationNumber() === 64`, no hard-coded guess
 * at 065's filename). Those belong to reviewed-migration-manifest.test.ts alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES, isReviewedMigrationFile } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M064_NAME = '064_fix_profile_identity_snapshot_return_type.sql';
const P064 = join(MIGRATIONS_DIR, M064_NAME);
const m064 = readFileSync(P064, 'utf8');

const M013_NAME = '013_phoenix_user_identity_snapshot_foundation.sql';
const m013 = readFileSync(join(MIGRATIONS_DIR, M013_NAME), 'utf8');

/** Active SQL only: strip `--` line comments so prose can never satisfy a check. */
function activeSql(sql: string): string {
  return sql
    .split('\n')
    .map(l => l.replace(/--.*$/, ''))
    .join('\n');
}
const active064 = activeSql(m064);
/** Whitespace-normalized active SQL: multi-line statements collapse to one line. */
const norm064 = active064.replace(/\s+/g, ' ').trim();

/** The single function this migration is allowed to touch. */
const FUNCTION_NAME = 'get_profile_identity_snapshot';

// ============================================================================
// File presence, uniqueness, registration
// ============================================================================

describe('Migration 064 exists exactly once and is registered', () => {
  it('064_fix_profile_identity_snapshot_return_type.sql exists', () => {
    expect(existsSync(P064)).toBe(true);
  });

  it('is the only file named 064_*', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('064_'))).toEqual([M064_NAME]);
  });

  it('is registered in the reviewed-migration registry by exact filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M064_NAME);
    expect(isReviewedMigrationFile(M064_NAME)).toBe(true);
  });
});

// ============================================================================
// The fix itself — column 3 is cast to text
// ============================================================================

describe('the 42804 fix is present and targets column 3 only', () => {
  it('casts the email expression to text', () => {
    expect(norm064).toContain('u.email::text');
  });

  it('returns email from the auth.users join, still as the third column', () => {
    // Column order is load-bearing: RETURNS TABLE binds by position, so a
    // reordered select would silently change what each OUT column means.
    const select = /select (.+?) from public\.profiles p/.exec(norm064);
    expect(select).not.toBeNull();
    const columns = select![1].split(',').map(c => c.trim());
    expect(columns).toEqual([
      'p.identity_version',
      'p.full_name',
      'u.email::text',
      'p.role',
      'p.organization_id',
    ]);
  });

  it('does not cast the four columns that already match their declared types', () => {
    // 013 declares identity_version integer / full_name text / role text /
    // organization_id uuid, and the underlying columns are exactly those types.
    // Casting them would be unrequested churn, not a fix.
    for (const untouched of ['p.identity_version', 'p.full_name', 'p.role', 'p.organization_id']) {
      expect(norm064).toContain(untouched);
      expect(norm064).not.toContain(`${untouched}::`);
    }
  });

  it('leaves the raw uncast u.email nowhere in the migration', () => {
    // The bug was precisely `u.email` with no cast. If it survives anywhere in
    // active SQL, the migration has not actually fixed 42804.
    expect(norm064).not.toMatch(/u\.email(?!::text)/);
  });
});

// ============================================================================
// Signature preservation — 064 must not redefine the contract
// ============================================================================

describe('the function contract is preserved exactly as 013 declared it', () => {
  it('uses CREATE OR REPLACE FUNCTION (never DROP + CREATE)', () => {
    // DROP would discard the ACL 013 granted and reset the function to
    // PostgreSQL's default PUBLIC EXECUTE — a silent privilege widening.
    expect(norm064).toMatch(
      new RegExp(`create or replace function public\\.${FUNCTION_NAME}\\(p_profile_id uuid\\)`),
    );
    expect(active064).not.toMatch(/drop\s+function/i);
  });

  it('keeps the same uuid parameter name and type', () => {
    expect(norm064).toContain(`${FUNCTION_NAME}(p_profile_id uuid)`);
  });

  it('keeps the identical RETURNS TABLE signature', () => {
    const declared = /returns table \((.+?)\) security definer/.exec(norm064);
    expect(declared).not.toBeNull();
    const cols = declared![1].split(',').map(c => c.trim().replace(/\s+/g, ' '));
    expect(cols).toEqual([
      'identity_version integer',
      'full_name text',
      'email text',
      'role text',
      'organization_id uuid',
    ]);
  });

  it('declares email as text — the signature is fixed by casting, not by widening', () => {
    // The alternative "fix" (declaring email varchar(255)) would push the
    // platform's storage type into every caller. 064 must not take it.
    expect(norm064).toContain('email text');
    expect(norm064).not.toMatch(/email\s+(character varying|varchar)/i);
  });

  it('preserves the RETURNS TABLE signature byte-for-byte against migration 013', () => {
    const sig = (sql: string): string | undefined =>
      /returns table \((.+?)\) security definer/
        .exec(activeSql(sql).replace(/\s+/g, ' '))?.[1]
        .trim();
    expect(sig(m064)).toBeDefined();
    expect(sig(m064)).toBe(sig(m013));
  });
});

// ============================================================================
// Security attributes — unchanged, never widened
// ============================================================================

describe('security attributes are unchanged', () => {
  it('remains SECURITY DEFINER', () => {
    expect(norm064).toContain('security definer');
    expect(norm064).not.toContain('security invoker');
  });

  it('keeps the identical search_path pin', () => {
    expect(norm064).toContain('set search_path = public, pg_temp');
  });

  it('keeps search_path identical to migration 013', () => {
    const sp = (sql: string): string | undefined =>
      /set search_path = ([^\n]+?) language/.exec(activeSql(sql).replace(/\s+/g, ' '))?.[1].trim();
    expect(sp(m064)).toBeDefined();
    expect(sp(m064)).toBe(sp(m013));
  });

  it('remains language plpgsql', () => {
    expect(norm064).toContain('language plpgsql');
  });

  it('issues no GRANT — 013\'s ACL is inherited via CREATE OR REPLACE', () => {
    expect(active064).not.toMatch(/\bgrant\b/i);
  });

  it('issues no REVOKE — it must not silently undo 063\'s hardening either', () => {
    expect(active064).not.toMatch(/\brevoke\b/i);
  });
});

// ============================================================================
// Blast radius — this migration changes one function and nothing else
// ============================================================================

describe('migration 064 has no side effects beyond the one function', () => {
  it('contains no destructive or data statement', () => {
    for (const forbidden of [
      /\bdrop\s+table\b/i,
      /\bdrop\s+function\b/i,
      /\bdrop\s+policy\b/i,
      /\btruncate\b/i,
      /\bdelete\s+from\b/i,
      /\bupdate\s+\w+\s+set\b/i,
      /\binsert\s+into\b/i,
    ]) {
      expect(active064, `${forbidden} must not appear`).not.toMatch(forbidden);
    }
  });

  it('alters or creates no table, policy, trigger or type', () => {
    for (const forbidden of [
      /\balter\s+table\b/i,
      /\bcreate\s+table\b/i,
      /\bcreate\s+policy\b/i,
      /\bcreate\s+trigger\b/i,
      /\bcreate\s+type\b/i,
      /\bcreate\s+index\b/i,
      /\balter\s+column\b/i,
    ]) {
      expect(active064, `${forbidden} must not appear`).not.toMatch(forbidden);
    }
  });

  it('never touches the supabase_migrations bookkeeping schema', () => {
    expect(active064).not.toMatch(/supabase_migrations/i);
  });

  it('does not enable, disable or alter RLS', () => {
    expect(active064).not.toMatch(/row\s+level\s+security/i);
  });

  it('defines exactly one function', () => {
    expect([...active064.matchAll(/create\s+or\s+replace\s+function/gi)]).toHaveLength(1);
  });

  it('names no function other than get_profile_identity_snapshot', () => {
    const named = [...active064.matchAll(/function\s+public\.(\w+)/gi)].map(m => m[1]);
    expect([...new Set(named)]).toEqual([FUNCTION_NAME]);
  });

  it('reads only profiles and auth.users, the same sources 013 read', () => {
    expect(norm064).toContain('from public.profiles p');
    expect(norm064).toContain('left join auth.users u on u.id = p.id');
    // The predicate must stay scoped to the requested profile.
    expect(norm064).toContain('where p.id = p_profile_id');
  });
});

// ============================================================================
// Mutation proof — removing the cast must fail the targeted assertions
// ============================================================================

describe('the fix assertions are load-bearing (mutation proof)', () => {
  /** The migration as it would read if the ::text cast were reverted. */
  const mutated = norm064.replace(/u\.email::text/g, 'u.email');

  it('a reverted cast no longer satisfies the fix assertion', () => {
    expect(mutated).not.toContain('u.email::text');
    expect(mutated).toMatch(/u\.email(?!::text)/);
  });

  it('the real migration and the mutant genuinely differ', () => {
    // Guards against a vacuous mutation test: if the replace were a no-op, both
    // sides would be identical and every assertion above would prove nothing.
    expect(mutated).not.toBe(norm064);
  });
});
