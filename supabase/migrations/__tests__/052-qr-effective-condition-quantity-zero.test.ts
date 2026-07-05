/**
 * QR-EFFECTIVE-CONDITION-QUANTITY-ZERO-052-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 052: get_public_qr_payload's
 * effective_condition CASE gains a `quantity <= 0 -> 'missing'` branch in
 * both the distribution_point and local_item branches, so a row whose
 * quantity was zeroed by the ordinary quantity-movement flow (without a
 * matching condition change) no longer shows as "Available: 0 units" on the
 * public QR page. No live DB is used — these are text/shape assertions
 * against the SQL file, mirroring the 028, 042, and 051 tests' conventions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../');
const MIGRATION_052_PATH = join(MIGRATIONS_DIR, '052_qr_effective_condition_quantity_zero.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/** Strip `--` comment lines, leaving only active SQL for whole-file guardrails. */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

function extractFunction(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function get_public_qr_payload(`);
  const afterStart = sql.indexOf('as $$', start) + 'as $$'.length;
  const end = sql.indexOf('\n$$;', afterStart);
  return sql.slice(start, end);
}

const migration052 = readMigration('052_qr_effective_condition_quantity_zero.sql');
const fnBody = extractFunction(migration052, 'get_public_qr_payload');
const migration028 = readMigration('028_phoenix_public_qr_expiry_scientific_name_fix.sql');

describe('Migration 052 exists exactly once', () => {
  it('052_qr_effective_condition_quantity_zero.sql exists', () => {
    expect(existsSync(MIGRATION_052_PATH)).toBe(true);
  });

  it('is the only file named 052_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('052_'));
    expect(matches).toEqual(['052_qr_effective_condition_quantity_zero.sql']);
  });

  // DB-REMOVED-OUTLET-MATERIAL-MARKER-053-A: migration 053 is a later,
  // separately-reviewed phase (removed_at/removed_by/removal_reason marker)
  // — this migration's own scope is unaffected by its existence.
  it('does not create migration 055 (053/054 are later, separately-reviewed DB-REMOVED-OUTLET-MATERIAL-MARKER-053-A / PHASE2-DASHBOARD-PERFORMANCE-RPCS-054-A additions)', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('055_'));
    expect(matches).toEqual([]);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration052).toContain('MANUAL APPLY ONLY');
    expect(migration052).toContain('supabase db push');
  });

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(migration052).toContain('do $$');
    expect(migration052).toMatch(/assert /);
  });

  it('does not run supabase db push directly (only mentions it as prohibited)', () => {
    const lines = migration052.split('\n').filter(l => l.includes('supabase db push'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toMatch(/DO NOT|manual|Manual/i);
    }
  });
});

describe('Migration 052: redefines get_public_qr_payload with the same signature', () => {
  it('uses CREATE OR REPLACE FUNCTION get_public_qr_payload(p_public_id text)', () => {
    expect(migration052).toMatch(/create or replace function get_public_qr_payload\(p_public_id text\)/);
  });

  it('returns jsonb, same as the original', () => {
    expect(migration052).toMatch(/returns jsonb/);
  });

  it('preserves SECURITY DEFINER and SET search_path', () => {
    expect(fnBody.length).toBeGreaterThan(0);
    const header = migration052.slice(migration052.indexOf('create or replace function get_public_qr_payload'));
    expect(header).toMatch(/security definer/);
    expect(header).toMatch(/set search_path = public/);
  });

  it('matches the exact signature used by migration 028 (the prior live definition)', () => {
    const sig052 = migration052.match(/create or replace function get_public_qr_payload\([^)]*\)\s*\nreturns\s+\w+/i)?.[0];
    const sig028 = migration028.match(/create or replace function get_public_qr_payload\([^)]*\)\s*\nreturns\s+\w+/i)?.[0];
    expect(sig052).toBeTruthy();
    expect(sig052).toEqual(sig028);
  });
});

describe('Migration 052: adds the quantity<=0 -> missing branch', () => {
  it('function body contains the ia.quantity <= 0 condition', () => {
    expect(fnBody).toContain('ia.quantity <= 0');
  });

  it('maps quantity <= 0 to \'missing\'', () => {
    expect(fnBody).toMatch(/when ia\.quantity <= 0\s*\n\s*then 'missing'/);
  });

  it('the new branch appears in exactly two effective_condition CASE blocks (distribution_point + local_item)', () => {
    const occurrences = fnBody.split('when ia.quantity <= 0').length - 1;
    expect(occurrences).toBe(2);
  });

  it('appears inside the distribution_point branch (before the "when \'warehouse\'" marker)', () => {
    const dpEnd = fnBody.indexOf("when 'warehouse'");
    expect(dpEnd).toBeGreaterThan(-1);
    const dpBranch = fnBody.slice(0, dpEnd);
    expect(dpBranch).toContain('ia.quantity <= 0');
  });

  it('appears inside the local_item branch (after the "when \'warehouse\'" marker)', () => {
    const localStart = fnBody.indexOf("when 'local_item'");
    expect(localStart).toBeGreaterThan(-1);
    const localBranch = fnBody.slice(localStart);
    expect(localBranch).toContain('ia.quantity <= 0');
  });

  it('the warehouse branch (item_count only) does not gain an effective_condition or a quantity<=0 branch', () => {
    const whStart = fnBody.indexOf("when 'warehouse'");
    const whEnd = fnBody.indexOf("when 'local_item'");
    const whBranch = activeSql(fnBody.slice(whStart, whEnd));
    expect(whBranch).not.toContain('effective_condition');
    expect(whBranch).not.toContain('ia.quantity <= 0');
  });

  it('precedence: expired-by-expiry-date check still comes before the new quantity<=0 check in both branches', () => {
    const dpStart = fnBody.indexOf("when 'distribution_point'");
    const whStart = fnBody.indexOf("when 'warehouse'");
    const localStart = fnBody.indexOf("when 'local_item'");
    const unknownIdx = fnBody.indexOf('UNKNOWN_TARGET_TYPE');

    const dpBranch = fnBody.slice(dpStart, whStart);
    const localBranch = fnBody.slice(localStart, unknownIdx);

    for (const branch of [dpBranch, localBranch]) {
      const expiredIdx = branch.indexOf('expiry_date < current_date');
      const quantityIdx = branch.indexOf('ia.quantity <= 0');
      expect(expiredIdx).toBeGreaterThan(-1);
      expect(quantityIdx).toBeGreaterThan(-1);
      expect(expiredIdx).toBeLessThan(quantityIdx);
    }
  });

  it('expiry_bucket computation is untouched (no quantity reference inside expiry_bucket CASE blocks)', () => {
    const bucketBlocks = fnBody.match(/as expiry_bucket/g);
    expect(bucketBlocks?.length).toBe(2);
    // Each "end\n            ) derived" / "as expiry_bucket" preceding CASE should not mention quantity.
    const idx1 = fnBody.indexOf('as expiry_bucket');
    const caseStart1 = fnBody.lastIndexOf('case', idx1);
    expect(fnBody.slice(caseStart1, idx1)).not.toContain('quantity');
  });
});

describe('Migration 052: D2/D3 guards still key off effective_condition (unchanged)', () => {
  it('D2: quantity nulled only for effective_condition = \'expired\'', () => {
    expect(fnBody).toMatch(/effective_condition = 'expired'/);
  });

  it('D3: expiry_date returned only for near_expiry/expired', () => {
    expect(fnBody).toMatch(/effective_condition in \('near_expiry', 'expired'\)/);
  });
});

describe('Migration 052: does not modify migrations 001-051', () => {
  it('028_phoenix_public_qr_expiry_scientific_name_fix.sql is untouched (still the pre-052 definition, no quantity<=0 branch)', () => {
    const sql028 = readMigration('028_phoenix_public_qr_expiry_scientific_name_fix.sql');
    expect(sql028).not.toContain('ia.quantity <= 0');
  });

  it('042/051 filenames are unchanged (no duplicate numbering introduced)', () => {
    for (const [prefix, name] of [
      ['042_', '042_phoenix_clear_port_availability_movement_safe.sql'],
      ['051_', '051_material_batch_identity_option_a.sql'],
    ] as const) {
      expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith(prefix))).toEqual([name]);
    }
  });

  it('all prior migration files (001-051) still exist', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0[0-4][0-9]_|^05[01]_/.test(f));
    expect(matches.length).toBeGreaterThanOrEqual(51);
  });
});

describe('Migration 052: does not touch QR token/target tables or unrelated schema', () => {
  it('does not CREATE/ALTER/DROP TABLE anywhere', () => {
    expect(activeSql(migration052)).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE/i);
  });

  it('does not CREATE/ALTER/DROP any qr_tokens or qr_targets table definition', () => {
    expect(activeSql(migration052)).not.toMatch(/CREATE TABLE[^;]*qr_(tokens|targets)/i);
    expect(activeSql(migration052)).not.toMatch(/ALTER TABLE[^;]*qr_(tokens|targets)/i);
  });

  it('does not CREATE/DROP POLICY anywhere', () => {
    expect(activeSql(migration052)).not.toMatch(/CREATE POLICY|DROP POLICY/i);
  });

  it('still resolves tokens/targets via qr_tokens / qr_targets (read-only, as before)', () => {
    expect(fnBody).toContain('qr_tokens');
    expect(fnBody).toContain('qr_targets');
  });

  it('does not redefine any other RPC (clear_port_availability, phoenix_apply_availability_movement, phoenix_upsert_availability)', () => {
    expect(migration052).not.toMatch(/create or replace function (public\.)?clear_port_availability/i);
    expect(migration052).not.toMatch(/create or replace function (public\.)?phoenix_apply_availability_movement/i);
    expect(migration052).not.toMatch(/create or replace function (public\.)?phoenix_upsert_availability/i);
  });

  it('does not touch inter_org_exchange_* or inter_org_alert_* objects', () => {
    const active = activeSql(migration052);
    expect(active).not.toMatch(/CREATE (OR REPLACE FUNCTION|TABLE|POLICY)[^;]*inter_org_(exchange|alert)/i);
    expect(active).not.toMatch(/ALTER TABLE[^;]*inter_org_(exchange|alert)/i);
    expect(active).not.toMatch(/DROP[^;]*inter_org_(exchange|alert)/i);
  });
});

describe('Migration 052: grants unchanged (anon + authenticated EXECUTE)', () => {
  it('REVOKEs from authenticated then GRANTs EXECUTE to anon, authenticated (same as migration 028)', () => {
    expect(migration052).toContain('revoke all on function get_public_qr_payload(text) from authenticated;');
    expect(migration052).toContain('grant execute on function get_public_qr_payload(text) to anon, authenticated;');
  });

  it('does not grant to service_role or PUBLIC', () => {
    expect(activeSql(migration052)).not.toMatch(/grant[^;]*to\s+(service_role|public)\b/i);
  });
});

describe('Migration 052: security guardrails', () => {
  // Scoped to the function body itself (fnBody), not the whole migration
  // file: the VERIFY block below legitimately contains the literal strings
  // 'service_role' / 'auth.admin' / 'whatsapp' / 'bearer' as part of the
  // ASSERT checks that prove those strings are absent from the function
  // body — exactly the same pattern migration 028 uses.
  it('no service_role reference in the function body', () => {
    expect(activeSql(fnBody)).not.toMatch(/service_role/i);
  });

  it('no auth.admin reference in the function body', () => {
    expect(activeSql(fnBody)).not.toMatch(/auth\.admin/i);
  });

  it('no WhatsApp / Graph API / Bearer token reference in the function body', () => {
    expect(activeSql(fnBody)).not.toMatch(/whatsapp|graph\.facebook|bearer/i);
  });

  it('the VERIFY block itself asserts absence of service_role/auth.admin/whatsapp/bearer', () => {
    expect(migration052).toMatch(/not ilike '%service_role%'/);
    expect(migration052).toMatch(/not ilike '%auth\.admin%'/);
    expect(migration052).toMatch(/not ilike '%whatsapp%'/);
  });

  it('no React/TSX component syntax (SQL-only file)', () => {
    expect(migration052).not.toMatch(/import React|useState|useEffect|<div/);
  });

  it('privacy-sensitive fields still absent from output (batch_number, price, trade_name, notes, supply_type)', () => {
    for (const field of ['batch_number', 'price', 'trade_name', 'notes', 'supply_type']) {
      expect(fnBody).not.toContain(`'${field}'`);
    }
  });

  it('no TRUNCATE or destructive DELETE anywhere', () => {
    expect(activeSql(migration052)).not.toMatch(/TRUNCATE/i);
    expect(activeSql(migration052)).not.toMatch(/DELETE FROM/i);
  });
});

describe('Migration 052: repo safety guards (untouched by this task)', () => {
  it('does not touch package.json or lockfiles', () => {
    expect(migration052).not.toMatch(/package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock/);
  });

  it('this migration file is not premium-preview.html or supabase/.temp', () => {
    expect(MIGRATION_052_PATH).not.toMatch(/premium-preview\.html/);
    expect(MIGRATION_052_PATH).not.toMatch(/supabase[\\/]\.temp/);
  });
});
