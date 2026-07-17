/**
 * PUBLIC-QR-CONCENTRATION-059-A
 *
 * Static SQL-source tests for migration 059 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of every other
 * migration test here (052/053/054/056/057/058).
 *
 * Migration 059 additively adds 'concentration' (from item_availability.
 * concentration) to the two per-material objects returned by
 * get_public_qr_payload: the distribution_point branch's items[] and the
 * local_item branch's availability[]. Everything else must remain semantically
 * identical to migration 058.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { getMaximumReviewedMigrationNumber } from './helpers/reviewed-migrations';
import { stripSqlComments } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS = join(ROOT, 'supabase/migrations');

const P059 = join(MIGRATIONS, '059_phoenix_public_qr_concentration.sql');
const P058 = join(MIGRATIONS, '058_phoenix_public_qr_dosage_form.sql');

const m059 = readFileSync(P059, 'utf8');
const m058 = readFileSync(P058, 'utf8');

/**
 * The `create or replace function ... $$;` block only (excludes header/VERIFY).
 *
 * Anchored to a LINE-START match: both migrations' header prose legitimately
 * mentions `create or replace function get_public_qr_payload` inside a comment
 * (e.g. the rollback note), so a naive indexOf would capture the header too.
 */
function fnBlock(sql: string): string {
  const m = /^create or replace function get_public_qr_payload/m.exec(sql);
  expect(m).not.toBeNull();
  const start = m!.index;
  const end = sql.indexOf('\n$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + 4);
}

/**
 * Drop SQL line comments from a snippet (keeps code only).
 *
 * SQL-SOURCE-LEXER-A: delegates to the shared lexical stripper. The per-file
 * `/--.*$/` this replaced stripped nothing at all on a CRLF checkout.
 */
const stripComments = stripSqlComments;

/** Semantic code only: SQL line comments, blank lines and indentation removed. */
function semanticCode(sql: string): string[] {
  return stripSqlComments(fnBlock(sql))
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

const fn059 = fnBlock(m059);
const fn058 = fnBlock(m058);

// ============================================================================
// 1. Existence + migrations 001–058 untouched
// ============================================================================

describe('1. Migration 059 exists; migrations 001–058 remain untouched', () => {
  it('059_phoenix_public_qr_concentration.sql exists', () => {
    expect(existsSync(P059)).toBe(true);
    expect(m059.length).toBeGreaterThan(500);
  });

  it('is the highest migration number (no 060+ introduced)', () => {
    const files: string[] = execSync('git ls-files supabase/migrations', { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(f => /^supabase\/migrations\/\d{3}_/.test(f));
    const nums = files.map(f => parseInt(f.slice('supabase/migrations/'.length, 'supabase/migrations/'.length + 3), 10));
    // MIGRATION-GUARD-DERIVE-B: was a hard-coded `<= 59`, which would have
    // failed the moment migration 060 was committed. The ceiling now derives
    // from the canonical reviewed registry.
    expect(Math.max(...nums)).toBeLessThanOrEqual(getMaximumReviewedMigrationNumber());
  });

  it('no tracked migration SQL file 001–058 has a working-tree diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('migration 058 still exists unmodified on disk (059 replaces the function, not the file)', () => {
    expect(existsSync(P058)).toBe(true);
    expect(m058).toContain("'dosage_form',   derived.ia_dosage_form,");
  });
});

// ============================================================================
// 2. RPC contract: signature / return / security / search_path / grants
// ============================================================================

describe('2. RPC contract preserved exactly', () => {
  it('uses CREATE OR REPLACE with the identical name and parameter signature', () => {
    expect(fn059).toContain('create or replace function get_public_qr_payload(p_public_id text)');
    expect(fn059).not.toMatch(/drop\s+function/i);
  });

  it('RETURNS jsonb unchanged', () => {
    expect(fn059).toMatch(/create or replace function get_public_qr_payload\(p_public_id text\)\s*\nreturns jsonb/);
  });

  it('LANGUAGE plpgsql unchanged', () => {
    expect(fn059).toContain('language plpgsql');
  });

  it('SECURITY DEFINER retained', () => {
    expect(fn059).toContain('security definer');
  });

  it('SET search_path = public retained', () => {
    expect(fn059).toContain('set search_path = public');
  });

  it('grants retained exactly (anon + authenticated EXECUTE), no new public grant', () => {
    expect(m059).toContain('revoke all on function get_public_qr_payload(text) from authenticated;');
    expect(m059).toContain('grant execute on function get_public_qr_payload(text) to anon, authenticated;');
    // No direct table access handed to anon/public anywhere in this migration.
    expect(m059).not.toMatch(/grant\s+select\s+on\s+(table\s+)?item_availability/i);
    expect(m059).not.toMatch(/grant[^;]*\bto\s+public\b/i);
  });
});

// ============================================================================
// 3. The concentration addition itself
// ============================================================================

describe('3. concentration added to exactly the two material branches', () => {
  it("emits 'concentration' exactly twice (distribution_point items[] + local_item availability[])", () => {
    const hits = fn059.match(/'concentration', derived\.ia_concentration,/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it('sources it from item_availability.concentration exactly twice (one thread per branch)', () => {
    const hits = fn059.match(/ia\.concentration\s+as ia_concentration,/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it('never invents/derives/translates a value (no COALESCE or default on concentration)', () => {
    expect(fn059).not.toMatch(/coalesce\([^)]*concentration/i);
    expect(fn059).not.toMatch(/ia\.concentration\s*,\s*'/);
  });

  it('is not added to the warehouse branch (which has no per-material object)', () => {
    const whStart = fn059.indexOf("when 'warehouse' then");
    const whEnd = fn059.indexOf("when 'local_item' then");
    expect(whStart).toBeGreaterThan(-1);
    expect(whEnd).toBeGreaterThan(whStart);
    // Comments stripped: the branch's explanatory comment legitimately says
    // "no concentration ... is added here" — only executable code is checked.
    const whBranch = stripComments(fn059.slice(whStart, whEnd));
    expect(whBranch).not.toContain('concentration');
  });

  it('is not added to org/point/token metadata (only inside the two jsonb_agg material objects)', () => {
    // Every 'concentration' JSON key must sit inside a jsonb_agg(...) material list.
    const beforeFirstAgg = fn059.slice(0, fn059.indexOf('jsonb_agg'));
    expect(beforeFirstAgg).not.toContain("'concentration',");
  });
});

// ============================================================================
// 4. Migration 058 dosage_form preserved
// ============================================================================

describe('4. dosage_form (migration 058) fully preserved', () => {
  it("still emits 'dosage_form' exactly twice", () => {
    const hits = fn059.match(/'dosage_form',   derived\.ia_dosage_form,/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it('still sources ia.dosage_form exactly twice', () => {
    const hits = fn059.match(/ia\.dosage_form\s+as ia_dosage_form,/g) ?? [];
    expect(hits.length).toBe(2);
  });
});

// ============================================================================
// 5. Migration 058/052/027 behavior preserved
// ============================================================================

describe('5. existing QR behavior preserved', () => {
  it('token resolution + active-only lookup retained', () => {
    expect(fn059).toContain("where public_id = p_public_id and status = 'active'");
    expect(fn059).toContain("'error', 'QR_NOT_FOUND_OR_DISABLED'");
    expect(fn059).toContain("'error', 'TARGET_NOT_FOUND'");
    expect(fn059).toContain("'error', 'UNKNOWN_TARGET_TYPE'");
    expect(fn059).toContain("'error', 'PAYLOAD_BUILD_FAILED'");
  });

  it('D4 active distribution-point guard retained', () => {
    expect(fn059).toContain("'error', 'DISTRIBUTION_POINT_NOT_ACTIVE'");
  });

  it('organization scoping retained', () => {
    expect(fn059).toContain('select * into v_org from organizations where id = v_target.organization_id;');
  });

  it('D6 scientific_name fallback + LEFT JOIN retained', () => {
    expect(fn059).toContain('left join local_items li on li.id = ia.local_item_id');
    expect(fn059).toContain('ia.scientific_name');
  });

  it('052 quantity-zero → missing retained in both branches', () => {
    const hits = fn059.match(/when ia\.quantity <= 0/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it('expired-quantity privacy retained (quantity null when expired)', () => {
    const hits = fn059.match(/case when derived\.effective_condition = 'expired'\s*\n\s*then null/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it('expiry_date visibility rule retained (near_expiry/expired only)', () => {
    const hits = fn059.match(/derived\.effective_condition in \('near_expiry', 'expired'\)/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it('expiry_bucket retained', () => {
    expect(fn059).toContain("'expiry_bucket', derived.expiry_bucket");
  });

  it('material ordering retained', () => {
    expect(fn059).toContain('order by derived.row_name_ar');
    expect(fn059).toContain('order by dp.name_ar');
  });

  it('scan bookkeeping retained', () => {
    expect(fn059).toContain('set last_scanned_at = now(), scan_count = scan_count + 1');
  });
});

// ============================================================================
// 6. Privacy — no private field introduced
// ============================================================================

describe('6. public privacy limit — only concentration newly exposed', () => {
  const FORBIDDEN_KEYS = [
    'price', 'entered_price', 'unit_price', 'supply_type', 'supply_type_text',
    'national_code', 'batch_number', 'internal_batch_reference', 'trade_name',
    'notes', 'document_number', 'dispatch_id', 'dispatch_status',
    'actor_name_snapshot', 'actor_email_snapshot', 'actor_role_snapshot',
    'removed_by', 'last_updated_by',
  ];

  FORBIDDEN_KEYS.forEach(key => {
    it(`does not emit '${key}' as a JSON key in the RPC output`, () => {
      expect(fn059).not.toContain(`'${key}',`);
    });
  });

  it('the RPC itself never references service_role or auth.admin', () => {
    // Checked against the function block, not the whole file: the VERIFY block
    // legitimately contains `not ilike '%service_role%'` assertions (same as
    // migration 058), which are guards against exactly this, not usages of it.
    expect(fn059).not.toContain('service_role');
    expect(fn059).not.toMatch(/auth\.admin/);
  });

  it('does not touch RLS/policies', () => {
    expect(m059).not.toMatch(/create\s+policy|drop\s+policy|alter\s+policy|enable\s+row\s+level\s+security/i);
  });
});

// ============================================================================
// 7. No destructive / schema SQL
// ============================================================================

describe('7. no destructive or schema-changing SQL', () => {
  /** Strip line comments so descriptive header prose cannot trip keyword scans. */
  const code = stripSqlComments(m059);

  it('contains no DELETE', () => {
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
  });

  it('contains no TRUNCATE', () => {
    expect(code).not.toMatch(/\btruncate\b/i);
  });

  it('contains no DROP TABLE / DROP COLUMN', () => {
    expect(code).not.toMatch(/\bdrop\s+table\b/i);
    expect(code).not.toMatch(/\bdrop\s+column\b/i);
  });

  it('contains no ALTER TABLE', () => {
    expect(code).not.toMatch(/\balter\s+table\b/i);
  });

  it('contains no CREATE/DROP INDEX (051 batch identity untouched)', () => {
    expect(code).not.toMatch(/\b(create|drop)\s+(unique\s+)?index\b/i);
  });

  it('is manual-apply-only and does not invoke an automated runner', () => {
    expect(m059).toContain('MANUAL APPLY ONLY');
    expect(m059).toContain('supabase db push');
    expect(code).not.toMatch(/^\s*\\i\b/m);
  });
});

// ============================================================================
// 8. VERIFY block
// ============================================================================

describe('8. VERIFY block present and strict', () => {
  it('asserts function existence, signature, return type, SECURITY DEFINER, search_path', () => {
    expect(m059).toContain("routine_name   = 'get_public_qr_payload'");
    expect(m059).toContain("pg_get_function_identity_arguments(p.oid) = 'p_public_id text'");
    expect(m059).toContain("pg_get_function_result(p.oid) = 'jsonb'");
    expect(m059).toContain('p.prosecdef into v_fn_security');
    expect(m059).toContain("p.proconfig @> array['search_path=public']");
  });

  it('asserts anon has no direct item_availability access (avail_select_anon = false)', () => {
    expect(m059).toContain("policyname = 'avail_select_anon'");
    expect(m059).toContain("v_policy_qual = 'false'");
  });

  it('asserts grants for anon + authenticated survive', () => {
    expect(m059).toContain("grantee        = 'anon'");
    expect(m059).toContain("grantee        = 'authenticated'");
  });

  it('asserts concentration appears in exactly 2 branches, sourced from ia.concentration', () => {
    expect(m059).toContain("expected exactly 2 ''concentration'' JSON keys");
    expect(m059).toContain('expected exactly 2 ia.concentration source references');
  });

  it('asserts dosage_form (058) is still present in exactly 2 branches', () => {
    expect(m059).toContain('058 preserved');
  });

  it('scans the function BODY (prosrc), not the header comment, for destructive keywords', () => {
    expect(m059).toContain('select prosrc              into v_fn_body from pg_proc');
    expect(m059).toContain("v_fn_body !~* '\\mtruncate\\M'");
  });
});

// ============================================================================
// 9. SEMANTIC DIFF vs migration 058 — the core additive guarantee
// ============================================================================

describe('9. semantic diff vs migration 058 is exactly the concentration addition', () => {
  const code058 = semanticCode(m058);
  const code059 = semanticCode(m059);

  it('adds exactly 4 semantic lines and removes none', () => {
    const set058 = [...code058];
    const set059 = [...code059];

    // Every 058 semantic line still exists in 059 (nothing removed/changed).
    const removed = set058.filter(line => {
      const i = set059.indexOf(line);
      if (i === -1) return true;
      set059.splice(i, 1);
      return false;
    });
    expect(removed).toEqual([]);

    // Whatever remains in 059 is the additive delta.
    expect(set059.sort()).toEqual([
      "'concentration', derived.ia_concentration,",
      "'concentration', derived.ia_concentration,",
      'ia.concentration                                                     as ia_concentration,',
      'ia.concentration                                                              as ia_concentration,',
    ].sort());
  });

  it('the delta is only concentration threading + JSON emission (nothing else)', () => {
    const delta = code059.filter(l => !code058.includes(l));
    expect(delta.length).toBeGreaterThan(0);
    delta.forEach(line => expect(line.toLowerCase()).toContain('concentration'));
  });

  it('059 has strictly more semantic lines than 058 (purely additive)', () => {
    expect(code059.length).toBe(code058.length + 4);
  });
});

// ============================================================================
// 10. Apply-time atomicity — explicit transaction wrapper (parity with 058)
// ============================================================================

/**
 * PUBLIC-QR-CONCENTRATION-059-TRANSACTION-FIX-A
 *
 * Migration 059 replaces a public SECURITY DEFINER RPC, re-applies its grants,
 * and then VERIFY-asserts the result. Those three steps must be one atomic unit:
 * without an explicit wrapper each statement autocommits, so a failing VERIFY
 * would leave the new anon-executable RPC committed but unverified, needing
 * manual repair. Migration 058 wraps the identical sequence in `begin; ...
 * commit;` and 059 must keep that parity.
 *
 * Matching rule: a TOP-LEVEL transaction statement is the bare keyword at
 * column 0 followed by a semicolon (`begin;` / `commit;`). The PL/pgSQL block
 * openers inside the function body and inside the DO block are the bare keyword
 * with NO semicolon (`begin`), so the trailing `;` is what distinguishes them.
 * Comments are stripped first so no prose mention of "begin"/"commit" can be
 * miscounted.
 */
describe('10. explicit transaction wrapper (apply-time atomicity, parity with 058)', () => {
  const TX_BEGIN = /^begin\s*;\s*$/;
  const TX_COMMIT = /^commit\s*;\s*$/;

  const lines = (sql: string): string[] => stripComments(sql).split('\n');
  const findIdx = (sql: string, re: RegExp): number => lines(sql).findIndex(l => re.test(l));
  const countMatches = (sql: string, re: RegExp): number => lines(sql).filter(l => re.test(l)).length;

  // Anchors for the three statements that must share one transaction.
  const CREATE_FN = /^create or replace function get_public_qr_payload/;
  const REVOKE = /^revoke all on function get_public_qr_payload/;
  const GRANT = /^grant execute on function get_public_qr_payload/;
  const DO_OPEN = /^do \$\$/;
  const DO_CLOSE = /^end \$\$;\s*$/;

  it('1. has an explicit top-level `begin;`', () => {
    expect(findIdx(m059, TX_BEGIN)).toBeGreaterThan(-1);
  });

  it('2. has an explicit top-level `commit;`', () => {
    expect(findIdx(m059, TX_COMMIT)).toBeGreaterThan(-1);
  });

  it('3. `begin;` precedes the CREATE OR REPLACE FUNCTION', () => {
    const begin = findIdx(m059, TX_BEGIN);
    const create = findIdx(m059, CREATE_FN);
    expect(begin).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(create);
  });

  it('4. `commit;` follows the VERIFY `do $$ ... end $$;` block', () => {
    const commit = findIdx(m059, TX_COMMIT);
    const doClose = findIdx(m059, DO_CLOSE);
    expect(doClose).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(doClose);
  });

  it('5. has exactly one top-level BEGIN and exactly one top-level COMMIT', () => {
    expect(countMatches(m059, TX_BEGIN)).toBe(1);
    expect(countMatches(m059, TX_COMMIT)).toBe(1);
  });

  it('5b. uses no SAVEPOINT, ROLLBACK, or nested transaction control', () => {
    const code = stripComments(m059);
    expect(code).not.toMatch(/^\s*savepoint\b/im);
    expect(code).not.toMatch(/^\s*rollback\b/im);
    expect(code).not.toMatch(/^\s*(begin|start)\s+transaction\b/im);
  });

  it('6. function replacement, revoke/grant and VERIFY all execute inside the transaction', () => {
    const begin = findIdx(m059, TX_BEGIN);
    const commit = findIdx(m059, TX_COMMIT);
    for (const [name, re] of [
      ['create or replace function', CREATE_FN],
      ['revoke', REVOKE],
      ['grant', GRANT],
      ['do $$ (VERIFY)', DO_OPEN],
      ['end $$; (VERIFY close)', DO_CLOSE],
    ] as const) {
      const at = findIdx(m059, re);
      expect(at, `${name} must exist`).toBeGreaterThan(-1);
      expect(at, `${name} must be after begin;`).toBeGreaterThan(begin);
      expect(at, `${name} must be before commit;`).toBeLessThan(commit);
    }
  });

  it('7. a removed `begin;` or `commit;` is detectable (guard actually bites)', () => {
    // Proves the matcher keys on the real statements rather than on prose: with
    // either wrapper stripped, the corresponding count drops to zero.
    const withoutBegin = m059.split('\n').filter(l => !TX_BEGIN.test(l)).join('\n');
    const withoutCommit = m059.split('\n').filter(l => !TX_COMMIT.test(l)).join('\n');
    expect(countMatches(withoutBegin, TX_BEGIN)).toBe(0);
    expect(countMatches(withoutCommit, TX_COMMIT)).toBe(0);
  });

  it('8. PL/pgSQL block openers are not miscounted as transaction control', () => {
    // The function body and the DO block each open with a bare `begin` (no
    // semicolon); neither may be mistaken for the single top-level `begin;`.
    const bareBegins = lines(m059).filter(l => /^begin\s*$/.test(l)).length;
    expect(bareBegins).toBe(2);
    expect(countMatches(m059, TX_BEGIN)).toBe(1);
  });

  it('9. matches migration 058\'s wrapper structure exactly', () => {
    expect(countMatches(m058, TX_BEGIN)).toBe(1);
    expect(countMatches(m058, TX_COMMIT)).toBe(1);
    expect(findIdx(m058, TX_BEGIN)).toBeLessThan(findIdx(m058, CREATE_FN));
    expect(findIdx(m058, TX_COMMIT)).toBeGreaterThan(findIdx(m058, DO_CLOSE));
  });
});
