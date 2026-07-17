/**
 * INVENTORY-ONLY-AVAILABILITY-066-A
 *
 * Static SQL-source tests for migration 066 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of 052–065.
 *
 * 066 makes the unified inventory the ONLY source of availability. These tests
 * exist to prove the enforcement is real and, just as importantly, that it does
 * not overreach: no data is converted, no RLS is weakened, no role loses the
 * stock RPCs it legitimately needs.
 *
 * NOTE ON SCOPE: like 060–065, this file carries NO global ceiling assertion
 * (no `getMaximumReviewedMigrationNumber() === 66`, no guess at 067's filename).
 * Those belong to reviewed-migration-manifest.test.ts alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES, isReviewedMigrationFile } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M066_NAME = '066_phoenix_inventory_only_availability.sql';
const P066 = join(MIGRATIONS_DIR, M066_NAME);
const m066 = readFileSync(P066, 'utf8');

/** Active SQL only: strip `--` comments so prose can never satisfy a check. */
function activeSql(sql: string): string {
  return sql
    .split('\n')
    .map(l => l.replace(/--.*$/, ''))
    .join('\n');
}
const active066 = activeSql(m066);
const norm066 = active066.replace(/\s+/g, ' ').trim();

/** Apply-time SQL only: dollar-quoted bodies removed. */
const outside066 = active066.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, ' <BODY> ');

// ============================================================================
// File presence, uniqueness, registration
// ============================================================================

describe('Migration 066 exists exactly once and is registered', () => {
  it('066_phoenix_inventory_only_availability.sql exists', () => {
    expect(existsSync(P066)).toBe(true);
  });

  it('is the only file named 066_*', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('066_'))).toEqual([M066_NAME]);
  });

  it('is registered in the reviewed-migration registry by exact filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M066_NAME);
    expect(isReviewedMigrationFile(M066_NAME)).toBe(true);
  });
});

// ============================================================================
// The core property: availability is inventory-only
// ============================================================================

describe('availability becomes inventory-only', () => {
  it('forbids source_kind = manual with a CHECK constraint', () => {
    expect(norm066).toMatch(
      /ADD CONSTRAINT item_availability_source_kind_warehouse_only_chk CHECK \(source_kind = 'warehouse'\)/i,
    );
  });

  it('changes the default from manual to warehouse', () => {
    expect(norm066).toMatch(/ALTER COLUMN source_kind SET DEFAULT 'warehouse'/i);
  });

  it('keeps the source_kind column rather than dropping it', () => {
    // Dropping it is a later, separate step once no dependency remains.
    expect(active066).not.toMatch(/DROP\s+COLUMN\s+(IF\s+EXISTS\s+)?source_kind/i);
  });

  it('revokes the primary manual availability write path from every client role', () => {
    expect(norm066).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_upsert_availability\([^)]*\) FROM PUBLIC, anon, authenticated/i,
    );
  });

  it('revokes bulk availability clearing from every client role', () => {
    expect(norm066).toMatch(
      /REVOKE ALL ON FUNCTION public\.clear_port_availability\(uuid, text\) FROM PUBLIC, anon, authenticated/i,
    );
  });

  it('revokes the data-cleaning entry point from every client role', () => {
    expect(norm066).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_clean_availability_data\(boolean, text\) FROM PUBLIC, anon, authenticated/i,
    );
  });

  it('revokes direct projection writes from anon and authenticated', () => {
    expect(norm066).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.item_availability FROM anon, authenticated/i,
    );
  });

  it('revokes direct inventory writes from anon and authenticated', () => {
    expect(norm066).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.warehouse_stock FROM anon, authenticated/i,
    );
    expect(norm066).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.warehouse_stock_movements FROM anon, authenticated/i,
    );
  });

  it('never grants anything to anon', () => {
    const grantsToAnon = [...outside066.matchAll(/GRANT[^;]*TO[^;]*\banon\b[^;]*;/gi)];
    expect(grantsToAnon).toEqual([]);
  });
});

// ============================================================================
// Refusal to reinterpret real data
// ============================================================================

describe('066 refuses to silently convert manual data', () => {
  it('aborts when any manual availability row exists', () => {
    expect(norm066).toMatch(/source_kind = 'manual'/i);
    expect(norm066).toMatch(/ABORT 066: % manual availability row\(s\) exist/i);
  });

  it('aborts on any unrecognised source_kind rather than guessing', () => {
    expect(norm066).toMatch(/unrecognised source_kind/i);
  });

  it('requires the 065 contract to be present before tightening it', () => {
    expect(norm066).toMatch(/ABORT 066: migration 065 stock RPCs are absent/i);
  });

  it('deletes nothing and truncates nothing', () => {
    for (const forbidden of [
      /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i,
      /\bDROP\s+TABLE\b/i,
      /\bDROP\s+FUNCTION\b/i,
      /\bDROP\s+POLICY\b/i,
    ]) {
      expect(active066, `${forbidden} must not appear`).not.toMatch(forbidden);
    }
  });

  it('its only UPDATE pins source_kind and touches no quantity', () => {
    const updates = [...outside066.matchAll(/UPDATE\s+public\.\w+[\s\S]*?;/gi)].map(m =>
      m[0].replace(/\s+/g, ' '),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/UPDATE public\.item_availability SET source_kind = 'warehouse'/i);
    expect(updates[0]).not.toMatch(/quantity|condition|removed_at/i);
  });

  it('never touches the migration history table', () => {
    expect(active066).not.toMatch(/supabase_migrations/i);
  });
});

// ============================================================================
// It must not overreach
// ============================================================================

describe('066 does not weaken or overreach', () => {
  it('does not disable or force RLS', () => {
    expect(active066).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(active066).not.toMatch(/NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
  });

  it('creates and drops no policy', () => {
    expect(active066).not.toMatch(/\bCREATE\s+POLICY\b/i);
    expect(active066).not.toMatch(/\bDROP\s+POLICY\b/i);
  });

  it('asserts RLS is still enabled on all three tables', () => {
    expect(norm066).toMatch(/ABORT 066: row level security was weakened/i);
  });

  it('keeps the receive and movement RPCs callable by authenticated', () => {
    expect(norm066).toMatch(/ABORT 066: the receive\/movement RPCs are no longer callable/i);
  });

  it('does not enable RBAC enforcement', () => {
    // Checked against executable SQL with string literals stripped: 066
    // legitimately says "Review before enforcing warehouse-only" inside a RAISE
    // message, and a bare /enforc/ scan would flag that prose as a violation.
    const exec = active066.replace(/'(?:[^']|'')*'/g, "''");
    expect(exec).not.toMatch(/rbac/i);
    expect(exec).not.toMatch(/\benforce(ment)?\b/i);
  });

  it('does not alter role permission defaults', () => {
    expect(active066).not.toMatch(/role_permission_defaults|permission_keys/i);
  });

  it('touches no Auth user data', () => {
    expect(active066).not.toMatch(/\bauth\.users\b/i);
  });
});

// ============================================================================
// search_path hardening
// ============================================================================

describe('internal function search_path hardening', () => {
  it('pins the internal function to public, pg_temp', () => {
    expect(norm066).toMatch(
      /ALTER FUNCTION public\.phoenix_apply_manual_availability_movement_internal\( uuid, text, integer, text, text \) SET search_path = public, pg_temp/i,
    );
  });

  it('verifies the hardening took effect', () => {
    expect(norm066).toMatch(/ABORT 066: internal function search_path hardening did not take/i);
  });

  it('does not redefine the internal function body', () => {
    // ALTER ... SET search_path only. Rewriting the body here would be an
    // unrequested behavioural change hidden inside a privilege migration.
    expect(active066).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
  });
});

// ============================================================================
// Post-conditions prove the migration's own effect
// ============================================================================

describe('066 proves its own effect', () => {
  it('asserts no client-callable manual write path survives', () => {
    expect(norm066).toMatch(/manual availability write path\(s\) are still client-callable/i);
  });

  it('asserts no client role can write the inventory or its projection', () => {
    expect(norm066).toMatch(/a client role can still write the inventory or its projection/i);
  });

  it('asserts the warehouse-only CHECK exists after apply', () => {
    expect(norm066).toMatch(/ABORT 066: warehouse-only CHECK constraint is missing/i);
  });

  it('asserts the default is warehouse after apply', () => {
    expect(norm066).toMatch(/ABORT 066: source_kind default is not/i);
  });
});

// ============================================================================
// Mutation proof — the assertions are load-bearing
// ============================================================================

describe('the enforcement assertions are load-bearing (mutation proof)', () => {
  it('removing the CHECK would fail the constraint assertion', () => {
    const mutated = norm066.replace(
      /ADD CONSTRAINT item_availability_source_kind_warehouse_only_chk CHECK \(source_kind = 'warehouse'\)/i,
      '',
    );
    expect(mutated).not.toBe(norm066);
    expect(mutated).not.toMatch(
      /ADD CONSTRAINT item_availability_source_kind_warehouse_only_chk CHECK \(source_kind = 'warehouse'\)/i,
    );
  });

  it('restoring the manual RPC grant would be detectable', () => {
    const mutated = norm066.replace(
      /REVOKE ALL ON FUNCTION public\.phoenix_upsert_availability/i,
      'GRANT EXECUTE ON FUNCTION public.phoenix_upsert_availability',
    );
    expect(mutated).not.toBe(norm066);
    expect(mutated).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_upsert_availability/i);
  });
});
