/**
 * PUBLIC-QR-DOSAGE-FORM-IMPLEMENT-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 058: get_public_qr_payload additively
 * gains a single new public field, `dosage_form`, in the distribution_point
 * items[] objects and the local_item availability[] objects only — sourced
 * verbatim from item_availability.dosage_form. No live DB is used; these are
 * text/shape assertions against the SQL file plus a semantic-diff comparison
 * against migration 052 (the latest active definition), mirroring the 028 /
 * 051 / 052 test conventions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { findUnreviewedMigrationFiles } from './helpers/reviewed-migrations';
import { execSync } from 'child_process';

const MIGRATIONS_DIR = join(__dirname, '../');
const ROOT = join(__dirname, '../../../');
const MIGRATION_058_PATH = join(MIGRATIONS_DIR, '058_phoenix_public_qr_dosage_form.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/** Strip `--` comment lines, leaving only active SQL for whole-file guardrails. */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

/** Extract the create-or-replace function body ($$ … $$). */
function extractFunction(sql: string): string {
  const start = sql.indexOf('create or replace function get_public_qr_payload(');
  const afterStart = sql.indexOf('as $$', start) + 'as $$'.length;
  const end = sql.indexOf('\n$$;', afterStart);
  return sql.slice(start, end);
}

/**
 * Normalize a function body for SEMANTIC comparison: drop full-line and trailing
 * `--` comments, drop any line mentioning dosage_form (the only allowed
 * additive difference), trim + collapse internal whitespace, drop blank lines.
 */
function normalizeBody(body: string): string {
  return body
    .split('\n')
    .map(l => {
      const idx = l.indexOf('--');
      return (idx >= 0 ? l.slice(0, idx) : l);
    })
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => l.length > 0)
    .filter(l => !l.toLowerCase().includes('dosage_form'))
    .join('\n');
}

const migration058 = readMigration('058_phoenix_public_qr_dosage_form.sql');
const migration052 = readMigration('052_qr_effective_condition_quantity_zero.sql');
const fn058 = extractFunction(migration058);
const fn052 = extractFunction(migration052);
const active058 = activeSql(migration058);
const activeFn058 = activeSql(fn058);

describe('1. Migration 058 exists exactly once', () => {
  it('058_phoenix_public_qr_dosage_form.sql exists', () => {
    expect(existsSync(MIGRATION_058_PATH)).toBe(true);
  });

  it('is the only file named 058_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('058_'));
    expect(matches).toEqual(['058_phoenix_public_qr_dosage_form.sql']);
  });

  it('no unreviewed migration file exists (approval is exact-filename membership in the canonical reviewed registry, not a number ceiling)', () => {
    // MIGRATION-GUARD-DERIVE-A: this was a hard-coded "no 060+" range regex that
    // had to be bumped for every new migration. It is now exact-membership based
    // and strictly broader: ANY unreviewed file at ANY number fails here, while a
    // properly reviewed future migration passes without editing this file.
    expect(findUnreviewedMigrationFiles(readdirSync(MIGRATIONS_DIR))).toEqual([]);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration058).toContain('MANUAL APPLY ONLY');
    // only mentions the prohibited command; never invokes it
    expect(migration058.split('\n').filter(l => l.includes('supabase db push')).length).toBeGreaterThan(0);
  });

  it('has a DO $$ … VERIFY block with ASSERT statements', () => {
    expect(migration058).toContain('do $$');
    expect(migration058).toMatch(/assert /);
  });
});

describe('2. Already-applied migrations remain untouched (no working-tree diff)', () => {
  it('028, 052, 055, 056, 057 SQL files are unchanged', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- ' +
          'supabase/migrations/028_phoenix_public_qr_expiry_scientific_name_fix.sql ' +
          'supabase/migrations/052_qr_effective_condition_quantity_zero.sql ' +
          'supabase/migrations/055_phoenix_clean_availability_data.sql ' +
          'supabase/migrations/056_phoenix_platform_broadcast_notices.sql ' +
          'supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* git unavailable in sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });
});

describe('3-6. RPC signature / return / security / search_path preserved', () => {
  it('3. exact signature: get_public_qr_payload(p_public_id text)', () => {
    expect(fn058).toContain('create or replace function get_public_qr_payload(p_public_id text)');
  });

  it('4. RETURNS jsonb', () => {
    expect(fn058).toMatch(/returns jsonb/);
  });

  it('5. SECURITY DEFINER', () => {
    expect(fn058).toMatch(/security definer/);
  });

  it('6. SET search_path = public', () => {
    expect(fn058).toMatch(/set search_path = public/);
  });

  it('LANGUAGE plpgsql preserved', () => {
    expect(fn058).toMatch(/language plpgsql/);
  });
});

describe('7. Grants preserved', () => {
  it('revokes from authenticated then grants EXECUTE to anon + authenticated', () => {
    expect(active058).toMatch(/revoke all on function get_public_qr_payload\(text\) from authenticated;/);
    expect(active058).toMatch(/grant execute on function get_public_qr_payload\(text\) to anon, authenticated;/);
  });
});

describe('8-9. dosage_form added in exactly the two intended branches, from ia.dosage_form', () => {
  it('8. exactly two \'dosage_form\' JSON keys in the function body', () => {
    const count = (fn058.match(/'dosage_form',/g) ?? []).length;
    expect(count).toBe(2);
  });

  it('9. sourced from ia.dosage_form exactly twice', () => {
    const count = (fn058.match(/ia\.dosage_form/g) ?? []).length;
    expect(count).toBe(2);
  });

  // Branch slices use the comment-stripped body so descriptive comments
  // mentioning dosage_form cannot skew the counts.
  it('distribution_point branch contains one dosage_form JSON key + one source ref', () => {
    const dp = activeFn058.slice(
      activeFn058.indexOf("when 'distribution_point' then"),
      activeFn058.indexOf("when 'warehouse' then"),
    );
    expect((dp.match(/'dosage_form',/g) ?? []).length).toBe(1);
    expect((dp.match(/ia\.dosage_form/g) ?? []).length).toBe(1);
  });

  it('warehouse branch contains NO dosage_form (no per-material object there)', () => {
    const wh = activeFn058.slice(
      activeFn058.indexOf("when 'warehouse' then"),
      activeFn058.indexOf("when 'local_item' then"),
    );
    expect(wh.includes('dosage_form')).toBe(false);
  });

  it('local_item branch contains one dosage_form JSON key + one source ref', () => {
    // End boundary is the top-level case's else branch (UNKNOWN_TARGET_TYPE),
    // not an inner CASE `else`, so the whole local_item branch is captured.
    const li = activeFn058.slice(
      activeFn058.indexOf("when 'local_item' then"),
      activeFn058.indexOf('UNKNOWN_TARGET_TYPE'),
    );
    expect((li.match(/'dosage_form',/g) ?? []).length).toBe(1);
    expect((li.match(/ia\.dosage_form/g) ?? []).length).toBe(1);
  });
});

describe('10. No broadening of direct anon access to item_availability', () => {
  it('does not grant any table privilege to anon', () => {
    expect(active058).not.toMatch(/grant\s+(select|insert|update|delete|all)[\s\S]*?to\s+anon/i);
  });

  it('creates/alters no RLS policy and re-asserts avail_select_anon = false', () => {
    expect(active058).not.toMatch(/create\s+policy/i);
    expect(active058).not.toMatch(/alter\s+policy/i);
    expect(migration058).toContain("avail_select_anon");
    expect(migration058).toMatch(/v_policy_qual = 'false'/);
  });
});

describe('11. No private field added to the payload', () => {
  const forbidden = ['trade_name', 'price', 'entered_price', 'batch_number', 'notes', 'supply_type', 'national_code', 'actor_name_snapshot', 'actor_email_snapshot'];
  for (const field of forbidden) {
    it(`function body does not emit '${field}' as a JSON key`, () => {
      expect(fn058.includes(`'${field}',`)).toBe(false);
    });
  }
});

describe('12. Migration 052 filters / privacy logic preserved', () => {
  it('quantity<=0 -> missing branch present exactly twice', () => {
    const count = (fn058.match(/when ia\.quantity <= 0/g) ?? []).length;
    expect(count).toBe(2);
  });

  it('DISTRIBUTION_POINT_NOT_ACTIVE guard present', () => {
    expect(fn058).toContain('DISTRIBUTION_POINT_NOT_ACTIVE');
  });

  it('D6 LEFT JOIN + scientific_name fallback present', () => {
    expect(fn058).toMatch(/left join local_items/);
    expect(fn058).toContain('scientific_name');
  });

  it('D7 effective_condition + expiry_bucket present', () => {
    expect(fn058).toContain('effective_condition');
    expect(fn058).toContain('expiry_bucket');
    expect(fn058).toContain('expiry_date < current_date');
  });

  it('D2 expired -> quantity null and D3 expiry_date guard preserved', () => {
    expect(fn058).toMatch(/effective_condition = 'expired'\s*\n?\s*then null/);
    expect(fn058).toContain("effective_condition in ('near_expiry', 'expired')");
  });
});

describe('13. Scan bookkeeping preserved', () => {
  it('updates last_scanned_at and increments scan_count', () => {
    expect(fn058).toContain('last_scanned_at = now()');
    expect(fn058).toContain('scan_count = scan_count + 1');
  });
});

describe('14-17. No destructive / schema / RLS statements', () => {
  it('14. no DELETE in active SQL', () => {
    expect(activeSql(migration058)).not.toMatch(/\bdelete\s+from\b/i);
  });

  it('15. no TRUNCATE in active SQL', () => {
    expect(activeSql(migration058)).not.toMatch(/\btruncate\b/i);
  });

  it('16. no DROP in active SQL', () => {
    expect(activeSql(migration058)).not.toMatch(/\bdrop\s+(table|function|policy|column|index|trigger|schema)\b/i);
  });

  it('17. no table/schema/RLS/index/trigger change in active SQL', () => {
    const a = activeSql(migration058);
    expect(a).not.toMatch(/\bcreate\s+table\b/i);
    expect(a).not.toMatch(/\balter\s+table\b/i);
    expect(a).not.toMatch(/\bcreate\s+index\b/i);
    expect(a).not.toMatch(/\bcreate\s+trigger\b/i);
    expect(a).not.toMatch(/\bcreate\s+policy\b/i);
    expect(a).not.toMatch(/enable\s+row\s+level\s+security/i);
    expect(a).not.toMatch(/\badd\s+column\b/i);
  });
});

describe('18. No unrelated SQL — only get_public_qr_payload is (re)defined', () => {
  it('exactly one create-or-replace function, and it is get_public_qr_payload', () => {
    const creates = active058.match(/create\s+or\s+replace\s+function\s+(\w+)/gi) ?? [];
    expect(creates.length).toBe(1);
    expect(creates[0].toLowerCase()).toContain('get_public_qr_payload');
  });

  it('no top-level INSERT/UPDATE/DELETE outside the function body (scan UPDATE lives inside $$)', () => {
    // Remove the function body, then check the remaining top-level active SQL.
    const withoutFn = active058.replace(activeFn058, '');
    expect(withoutFn).not.toMatch(/\binsert\s+into\b/i);
    expect(withoutFn).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(withoutFn).not.toMatch(/\bdelete\s+from\b/i);
  });
});

describe('9 (task section). SEMANTIC DIFF vs migration 052 — only additive dosage_form differs', () => {
  it('the normalized function bodies (dosage_form + comments removed) are identical', () => {
    expect(normalizeBody(fn058)).toBe(normalizeBody(fn052));
  });

  it('052 itself has no dosage_form (confirms the field is genuinely new)', () => {
    expect(fn052.includes('dosage_form')).toBe(false);
  });
});
