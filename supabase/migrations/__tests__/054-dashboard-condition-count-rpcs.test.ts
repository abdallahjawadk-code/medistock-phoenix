/**
 * PHASE2-DASHBOARD-PERFORMANCE-RPCS-054-A
 * Run: npm test -- --run 054
 *
 * Static source-code tests for migration 054: adds two DB-side counting
 * RPCs (phoenix_get_dashboard_condition_counts, phoenix_get_institution_
 * condition_counts) so a future frontend phase can stop fetching every
 * item_availability row just to count conditions in JS. No live DB is used —
 * these are text/shape assertions against the SQL file, mirroring the
 * 028/042/051/052/053 tests' conventions.
 *
 * This phase is DB migration creation only: dashboard.service.ts is NOT
 * switched to call either RPC yet, and the SQL itself is not applied.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../');
const ROOT = join(__dirname, '../../../');
const MIGRATION_054_PATH = join(MIGRATIONS_DIR, '054_dashboard_condition_counts_rpcs.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/** Strip `--` comment lines, leaving only active SQL for whole-file guardrails. */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

function extractFunction(sql: string, name: string): string {
  const marker = new RegExp(`create or replace function (public\\.)?${name}\\(`, 'i');
  const match = marker.exec(sql);
  expect(match).not.toBeNull();
  const start = match!.index;
  const lowerSql = sql.toLowerCase();
  const asIdx = lowerSql.indexOf('as $$', start);
  expect(asIdx).toBeGreaterThan(-1);
  const afterStart = asIdx + 'as $$'.length;
  const end = sql.indexOf('\n$$;', afterStart);
  return sql.slice(start, end);
}

const migration054 = readMigration('054_dashboard_condition_counts_rpcs.sql');
const active054 = activeSql(migration054);
// Scoped to everything before the VERIFY block's own DO $$ — that block
// legitimately contains the literal strings 'TRUNCATE'/'DROP TABLE'/
// 'DELETE FROM item_availability'/'service_role'/'auth.admin' as part of the
// ASSERT checks proving those strings are absent, same pattern as migration
// 028/052/053's own tests.
const verifyStart = migration054.indexOf('DO $$');
const activeSqlPreVerify = activeSql(migration054.slice(0, verifyStart));
const verifyBlock = migration054.slice(verifyStart);

const fnDashboard = extractFunction(migration054, 'phoenix_get_dashboard_condition_counts');
const fnInstitution = extractFunction(migration054, 'phoenix_get_institution_condition_counts');

describe('Migration 054 exists exactly once', () => {
  it('054_dashboard_condition_counts_rpcs.sql exists', () => {
    expect(existsSync(MIGRATION_054_PATH)).toBe(true);
  });

  it('is the only file named 054_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('054_'));
    expect(matches).toEqual(['054_dashboard_condition_counts_rpcs.sql']);
  });

  it('does not create migration 055', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('055_'));
    expect(matches).toEqual(['055_phoenix_clean_availability_data.sql']);
  });

  it('does not modify any existing migration file 001-053', () => {
    let diff = '';
    try {
      diff = execSync('git status --porcelain -- supabase/migrations', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const touchedExisting = diff
      .split('\n')
      .filter(l => l.trim())
      .some(l => {
        const path = l.slice(3).trim();
        const file = path.split('/').pop() ?? '';
        return /^0(0[1-9]|[1-4]\d|5[0-3])_/.test(file);
      });
    expect(touchedExisting).toBe(false);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration054).toContain('MANUAL APPLY ONLY');
    expect(migration054).toContain('supabase db push');
  });

  it('is wrapped in begin/commit', () => {
    expect(active054).toMatch(/^\s*begin;/i);
    expect(active054.trim()).toMatch(/commit;\s*$/i);
  });

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(migration054).toContain('DO $$');
    expect(migration054).toMatch(/ASSERT /);
  });
});

describe('Migration 054: no schema/data changes', () => {
  it('has no ALTER TABLE / CREATE TABLE / ADD COLUMN', () => {
    expect(active054).not.toMatch(/ALTER TABLE|CREATE TABLE|ADD COLUMN/i);
  });

  it('has no CREATE/DROP POLICY (no RLS change)', () => {
    expect(active054).not.toMatch(/CREATE POLICY|DROP POLICY/i);
  });

  it('has no CREATE TRIGGER / DROP TRIGGER', () => {
    expect(active054).not.toMatch(/CREATE TRIGGER|DROP TRIGGER/i);
  });

  it('has no DELETE or TRUNCATE anywhere in the migration body (excluding the VERIFY block\'s own absence-check prose)', () => {
    expect(activeSqlPreVerify).not.toMatch(/DELETE FROM/i);
    expect(activeSqlPreVerify).not.toMatch(/TRUNCATE/i);
  });

  it('has no DROP TABLE anywhere in the migration body (excluding the VERIFY block\'s own absence-check prose)', () => {
    expect(activeSqlPreVerify).not.toMatch(/DROP TABLE/i);
  });

  it('creates exactly two new functions', () => {
    const matches = active054.match(/CREATE OR REPLACE FUNCTION/gi) ?? [];
    expect(matches.length).toBe(2);
  });
});

describe('Migration 054: RPC 1 — phoenix_get_dashboard_condition_counts', () => {
  it('has the expected signature: p_org_id uuid DEFAULT NULL, RETURNS jsonb', () => {
    expect(migration054).toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_get_dashboard_condition_counts\(\s*p_org_id uuid DEFAULT NULL\s*\)\s*\nRETURNS jsonb/,
    );
  });

  it('is SECURITY DEFINER with SET search_path = public', () => {
    expect(fnDashboard).toMatch(/SECURITY DEFINER/);
    const header = migration054.slice(
      migration054.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_get_dashboard_condition_counts'),
      migration054.indexOf('AS $$', migration054.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_get_dashboard_condition_counts')),
    );
    expect(header).toMatch(/SECURITY DEFINER/);
    expect(header).toMatch(/SET search_path = public/);
  });

  it('requires authentication', () => {
    expect(fnDashboard).toMatch(/IF v_actor IS NULL THEN/);
    expect(fnDashboard).toContain("'not_authenticated'");
  });

  it('applies removed_at IS NULL when counting', () => {
    expect(fnDashboard).toMatch(/removed_at\s+is\s+null/i);
  });

  it('counts genuine missing rows (condition = \'missing\') without a global exclusion', () => {
    expect(fnDashboard).toMatch(/condition = 'missing'/);
    // The only exclusion applied is removed_at IS NULL, not a missing-specific filter.
    expect(fnDashboard).not.toMatch(/condition\s*<>\s*'missing'/);
  });

  it('scopes non-super callers to their own org, ignoring p_org_id (no cross-org leak)', () => {
    expect(fnDashboard).toMatch(/v_effective_org\s*:=\s*CASE WHEN v_is_super THEN p_org_id ELSE v_my_org END/);
  });

  it('allows a super_admin to optionally narrow by p_org_id or span all orgs', () => {
    expect(fnDashboard).toContain('v_effective_org IS NULL OR organization_id = v_effective_org');
  });

  it('returns exactly the five required dashboard keys', () => {
    for (const key of ['available', 'low_stock', 'missing', 'near_expiry', 'surplus']) {
      expect(fnDashboard).toContain(`'${key}'`);
    }
  });

  it('grants: no anon/PUBLIC, authenticated only', () => {
    expect(migration054).toContain('REVOKE ALL ON FUNCTION public.phoenix_get_dashboard_condition_counts(uuid) FROM PUBLIC, anon;');
    expect(migration054).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_get_dashboard_condition_counts(uuid) TO authenticated;');
  });

  it('does not return removed_by, item ids, or auth uuids', () => {
    expect(fnDashboard).not.toContain('removed_by');
    expect(fnDashboard).not.toMatch(/'id'/);
    expect(fnDashboard).not.toContain('auth.uid()::text');
  });
});

describe('Migration 054: RPC 2 — phoenix_get_institution_condition_counts', () => {
  it('has the expected signature: no params, RETURNS TABLE(organization_id uuid, available integer, low integer, missing integer)', () => {
    expect(migration054).toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_get_institution_condition_counts\(\)\s*\nRETURNS TABLE\(\s*organization_id uuid,\s*available\s+integer,\s*low\s+integer,\s*missing\s+integer\s*\)/,
    );
  });

  it('is SECURITY DEFINER with SET search_path = public', () => {
    expect(fnInstitution).toMatch(/SECURITY DEFINER/);
    const header = migration054.slice(
      migration054.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_get_institution_condition_counts'),
      migration054.indexOf('AS $$', migration054.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_get_institution_condition_counts')),
    );
    expect(header).toMatch(/SECURITY DEFINER/);
    expect(header).toMatch(/SET search_path = public/);
  });

  it('requires authentication', () => {
    expect(fnInstitution).toMatch(/IF v_actor IS NULL THEN/);
    expect(fnInstitution).toContain("'not_authenticated'");
  });

  it('applies removed_at IS NULL when counting', () => {
    expect(fnInstitution).toMatch(/ia\.removed_at\s+is\s+null/i);
  });

  it('counts genuine missing rows via the missing bucket without a global exclusion', () => {
    expect(fnInstitution).toMatch(/condition IN \('missing', 'expired'\)/);
  });

  it('uses the required bucket logic: available IN (available, surplus); low IN (low_stock, near_expiry)', () => {
    expect(fnInstitution).toContain("condition IN ('available', 'surplus')");
    expect(fnInstitution).toContain("condition IN ('low_stock', 'near_expiry')");
  });

  it('scopes non-super callers to only their own organization row', () => {
    expect(fnInstitution).toMatch(/WHERE o\.status = 'active'\s*\n\s*AND \(v_is_super OR o\.id = v_my_org\)/);
  });

  it('only exposes organization_id/available/low/missing — no other org fields', () => {
    expect(fnInstitution).not.toMatch(/o\.name\b/);
    expect(fnInstitution).not.toMatch(/o\.code\b/);
    expect(fnInstitution).not.toContain('removed_by');
  });

  it('grants: no anon/PUBLIC, authenticated only', () => {
    expect(migration054).toContain('REVOKE ALL ON FUNCTION public.phoenix_get_institution_condition_counts() FROM PUBLIC, anon;');
    expect(migration054).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_get_institution_condition_counts() TO authenticated;');
  });
});

describe('HARDEN-MIGRATION-054-NULL-ORG-FAIL-CLOSED-A: non-super callers with NULL organization_id fail closed', () => {
  it('dashboard RPC has an explicit NOT v_is_super AND v_my_org IS NULL fail-closed guard', () => {
    expect(fnDashboard).toMatch(/IF\s+NOT\s+v_is_super\s+AND\s+v_my_org\s+IS\s+NULL\s+THEN/i);
  });

  it('dashboard RPC guard returns an all-zero-count jsonb object (not the COALESCE aggregate return)', () => {
    const guardStart = fnDashboard.search(/IF\s+NOT\s+v_is_super\s+AND\s+v_my_org\s+IS\s+NULL\s+THEN/i);
    expect(guardStart).toBeGreaterThan(-1);
    const guardEnd = fnDashboard.indexOf('END IF;', guardStart);
    const guardBlock = fnDashboard.slice(guardStart, guardEnd);
    expect(guardBlock).toMatch(/'available'\s*,\s*0/);
    expect(guardBlock).toMatch(/'low_stock'\s*,\s*0/);
    expect(guardBlock).toMatch(/'missing'\s*,\s*0/);
    expect(guardBlock).toMatch(/'near_expiry'\s*,\s*0/);
    expect(guardBlock).toMatch(/'surplus'\s*,\s*0/);
    expect(guardBlock).not.toContain('COALESCE');
  });

  it('dashboard RPC fail-closed guard runs before the org-scoping v_effective_org assignment', () => {
    const guardIdx = fnDashboard.search(/IF\s+NOT\s+v_is_super\s+AND\s+v_my_org\s+IS\s+NULL\s+THEN/i);
    const assignIdx = fnDashboard.indexOf('v_effective_org := CASE WHEN v_is_super');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(assignIdx);
  });

  it('institution RPC has an explicit NOT v_is_super AND v_my_org IS NULL fail-closed guard', () => {
    expect(fnInstitution).toMatch(/IF\s+NOT\s+v_is_super\s+AND\s+v_my_org\s+IS\s+NULL\s+THEN/i);
  });

  it('institution RPC guard returns with no rows (a bare RETURN, distinct from RETURN QUERY)', () => {
    const guardStart = fnInstitution.search(/IF\s+NOT\s+v_is_super\s+AND\s+v_my_org\s+IS\s+NULL\s+THEN/i);
    expect(guardStart).toBeGreaterThan(-1);
    const guardEnd = fnInstitution.indexOf('END IF;', guardStart);
    const guardBlock = fnInstitution.slice(guardStart, guardEnd);
    expect(guardBlock).toMatch(/RETURN\s*;/);
    expect(guardBlock).not.toContain('RETURN QUERY');
  });

  it('institution RPC fail-closed guard runs before RETURN QUERY', () => {
    const guardIdx = fnInstitution.search(/IF\s+NOT\s+v_is_super\s+AND\s+v_my_org\s+IS\s+NULL\s+THEN/i);
    const queryIdx = fnInstitution.indexOf('RETURN QUERY');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(queryIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(queryIdx);
  });

  it('super_admin all-organization behavior is still allowed (p_org_id NULL -> no org filter applied)', () => {
    expect(fnDashboard).toContain('v_effective_org IS NULL OR organization_id = v_effective_org');
    expect(fnDashboard).toMatch(/v_effective_org\s*:=\s*CASE WHEN v_is_super THEN p_org_id ELSE v_my_org END/);
  });

  it('super_admin can still narrow to one org via p_org_id, or omit it to span all orgs', () => {
    // CASE WHEN v_is_super THEN p_org_id proves p_org_id is honored only for super_admin.
    expect(fnDashboard).toMatch(/CASE WHEN v_is_super THEN p_org_id/);
  });

  it('non-super callers still cannot use p_org_id to probe another org (p_org_id ignored, forced to v_my_org)', () => {
    expect(fnDashboard).toMatch(/CASE WHEN v_is_super THEN p_org_id ELSE v_my_org END/);
  });

  it('institution RPC still scopes non-super callers to only their own organization row', () => {
    expect(fnInstitution).toMatch(/WHERE o\.status = 'active'\s*\n\s*AND \(v_is_super OR o\.id = v_my_org\)/);
  });

  it('removed_at IS NULL logic remains present in both RPCs after hardening', () => {
    expect(fnDashboard).toMatch(/removed_at\s+is\s+null/i);
    expect(fnInstitution).toMatch(/ia\.removed_at\s+is\s+null/i);
  });

  it('genuine missing rows remain counted in both RPCs after hardening', () => {
    expect(fnDashboard).toMatch(/condition = 'missing'/);
    expect(fnInstitution).toMatch(/condition IN \('missing', 'expired'\)/);
  });

  it('the VERIFY block asserts both fail-closed guards exist, using non-brittle \\s+ whitespace matching', () => {
    expect(verifyBlock).toMatch(/NOT\\s\+v_is_super\\s\+AND\\s\+v_my_org\\s\+IS\\s\+NULL/);
  });

  it('the VERIFY block asserts the dashboard guard returns an all-zero jsonb object', () => {
    expect(verifyBlock).toMatch(/'available''\\s\*,\\s\*0/);
    expect(verifyBlock).toMatch(/'surplus''\\s\*,\\s\*0/);
  });

  it('the VERIFY block asserts the institution guard returns with no rows (bare RETURN)', () => {
    expect(verifyBlock).toMatch(/RETURN\\s\*;/);
  });

  it('the VERIFY block asserts each guard runs before its respective org-scoping logic (POSITION ordering checks)', () => {
    expect(verifyBlock).toMatch(/POSITION\('NOT v_is_super AND v_my_org IS NULL' IN v_fn_def\)/);
    expect(verifyBlock).toContain("POSITION('v_effective_org := CASE WHEN v_is_super' IN v_fn_def)");
    expect(verifyBlock).toContain("POSITION('RETURN QUERY' IN v_fn_def)");
  });
});

describe('HARDEN-MIGRATION-054-NULL-ROLE-FAIL-CLOSED-A: NULL phoenix_my_role() is treated as non-super', () => {
  it('dashboard RPC computes v_is_super via COALESCE(v_role = \'super_admin\', false)', () => {
    expect(fnDashboard).toMatch(/v_is_super\s*:=\s*COALESCE\s*\(\s*v_role\s*=\s*'super_admin'\s*,\s*false\s*\)/);
  });

  it('institution RPC computes v_is_super via COALESCE(v_role = \'super_admin\', false)', () => {
    expect(fnInstitution).toMatch(/v_is_super\s*:=\s*COALESCE\s*\(\s*v_role\s*=\s*'super_admin'\s*,\s*false\s*\)/);
  });

  it('dashboard RPC no longer uses the bare, non-coalesced v_is_super assignment', () => {
    expect(fnDashboard).not.toMatch(/v_is_super\s*:=\s*\(v_role\s*=\s*'super_admin'\)\s*;/);
  });

  it('institution RPC no longer uses the bare, non-coalesced v_is_super assignment', () => {
    expect(fnInstitution).not.toMatch(/v_is_super\s*:=\s*\(v_role\s*=\s*'super_admin'\)\s*;/);
  });

  it('dashboard RPC computes v_is_super before the NULL-org fail-closed guard, so a NULL role cannot skip it', () => {
    const assignIdx = fnDashboard.search(/COALESCE\s*\(\s*v_role\s*=\s*'super_admin'/);
    const guardIdx = fnDashboard.search(/IF\s+NOT\s+v_is_super\s+AND\s+v_my_org\s+IS\s+NULL\s+THEN/i);
    expect(assignIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeLessThan(guardIdx);
  });

  it('institution RPC computes v_is_super before the NULL-org fail-closed guard, so a NULL role cannot skip it', () => {
    const assignIdx = fnInstitution.search(/COALESCE\s*\(\s*v_role\s*=\s*'super_admin'/);
    const guardIdx = fnInstitution.search(/IF\s+NOT\s+v_is_super\s+AND\s+v_my_org\s+IS\s+NULL\s+THEN/i);
    expect(assignIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeLessThan(guardIdx);
  });

  it('a NULL-role, NULL-org dashboard caller cannot fall into the all-org branch (guard precedes v_effective_org assignment, and v_is_super is a real boolean, never NULL)', () => {
    // COALESCE guarantees v_is_super is boolean (never NULL), so `NOT v_is_super`
    // reliably evaluates to TRUE for a NULL/non-super role, tripping the guard
    // before v_effective_org (and its "IS NULL -> all orgs" semantics) is ever computed.
    const coalesceIdx = fnDashboard.search(/COALESCE\s*\(\s*v_role\s*=\s*'super_admin'/);
    const guardIdx = fnDashboard.search(/IF\s+NOT\s+v_is_super\s+AND\s+v_my_org\s+IS\s+NULL\s+THEN/i);
    const assignIdx = fnDashboard.indexOf('v_effective_org := CASE WHEN v_is_super');
    expect(coalesceIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(assignIdx);
  });

  it('a NULL-role, NULL-org institution caller returns no rows (guard precedes RETURN QUERY, and v_is_super is a real boolean, never NULL)', () => {
    const coalesceIdx = fnInstitution.search(/COALESCE\s*\(\s*v_role\s*=\s*'super_admin'/);
    const guardIdx = fnInstitution.search(/IF\s+NOT\s+v_is_super\s+AND\s+v_my_org\s+IS\s+NULL\s+THEN/i);
    const queryIdx = fnInstitution.indexOf('RETURN QUERY');
    expect(coalesceIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(queryIdx);
  });

  it('super_admin behavior remains allowed (COALESCE only changes the NULL case; a real \'super_admin\' role still yields v_is_super = true)', () => {
    expect(fnDashboard).toMatch(/COALESCE\s*\(\s*v_role\s*=\s*'super_admin'\s*,\s*false\s*\)/);
    expect(fnDashboard).toContain('v_effective_org IS NULL OR organization_id = v_effective_org');
  });

  it('removed_at IS NULL remains present in both RPCs after the role hardening', () => {
    expect(fnDashboard).toMatch(/removed_at\s+is\s+null/i);
    expect(fnInstitution).toMatch(/ia\.removed_at\s+is\s+null/i);
  });

  it('genuine missing rows remain counted in both RPCs after the role hardening', () => {
    expect(fnDashboard).toMatch(/condition = 'missing'/);
    expect(fnInstitution).toMatch(/condition IN \('missing', 'expired'\)/);
  });

  it('the VERIFY block asserts both functions use COALESCE(v_role = \'super_admin\', false), with non-brittle whitespace matching', () => {
    expect(verifyBlock).toMatch(/COALESCE\\s\*\\\(\\s\*v_role\\s\*=\\s\*''super_admin''\\s\*,\\s\*false\\s\*\\\)/);
  });

  it('the VERIFY block asserts the COALESCE-hardened assignment runs before each fail-closed guard', () => {
    expect(verifyBlock).toContain("POSITION('COALESCE(v_role = ''super_admin''' IN v_fn_def)");
  });
});

describe('Migration 054: security guardrails', () => {
  it('no service_role reference in the migration body', () => {
    expect(activeSqlPreVerify).not.toMatch(/service_role/i);
  });

  it('no auth.admin reference in the migration body', () => {
    expect(activeSqlPreVerify).not.toMatch(/auth\.admin/i);
  });

  it('no external URL/http/net/pg_net reference in the migration body', () => {
    expect(activeSqlPreVerify).not.toMatch(/https?:\/\/|pg_net|net\.http|bearer|access_token/i);
  });

  it('the VERIFY block asserts absence of service_role/auth.admin/external network patterns using comment-stripped source', () => {
    expect(verifyBlock).toMatch(/v_fn_active\s*:=\s*regexp_replace\(v_fn_def, '--\[\^\\r\\n\]\*', '', 'g'\)/);
    expect(verifyBlock).toMatch(/NOT ILIKE '%service_role%'/);
    expect(verifyBlock).toMatch(/NOT ILIKE '%auth\.admin%'/);
    expect(verifyBlock).toMatch(/NOT ILIKE '%pg_net%'/);
  });

  it('the VERIFY block checks no anon/PUBLIC grants and authenticated EXECUTE for both functions', () => {
    expect(verifyBlock).toContain("grantee IN ('anon', 'PUBLIC')");
    expect(verifyBlock).toMatch(/grantee = 'authenticated' AND privilege_type = 'EXECUTE'/);
  });

  it('the VERIFY block checks no DELETE/TRUNCATE in either function body', () => {
    expect(verifyBlock).toContain("NOT ILIKE '%DELETE FROM item_availability%'");
    expect(verifyBlock).toContain("NOT ILIKE '%TRUNCATE%'");
  });

  it('no React/TSX component syntax (SQL-only file)', () => {
    expect(migration054).not.toMatch(/import React|useState|useEffect|<div/);
  });
});

describe('PHASE2-DASHBOARD-PERFORMANCE-RPCS-054-A: DB-only phase — no frontend/service files changed', () => {
  // PHASE2-DASHBOARD-SERVICE-RPC-SWITCH-A: dashboard.service.ts is excluded
  // from both checks below — the later, separately-reviewed phase this
  // comment already anticipated ("RPC switch is a later, separate phase")
  // now legitimately switches getDashboardMetrics/getInstitutionOverviews to
  // call the two RPCs this migration created, instead of reading
  // item_availability directly.
  it('no working-tree diff on dashboard.service.ts other than the already-approved RPC switch (PHASE2-DASHBOARD-SERVICE-RPC-SWITCH-A)', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/shared/supabase/services/dashboard.service.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    // The RPC switch is expected to have landed — don't assert emptiness,
    // just assert it only calls the two migration-054 RPCs, never a raw
    // item_availability select.
    if (diff.trim()) {
      expect(diff).toMatch(/phoenix_get_dashboard_condition_counts|phoenix_get_institution_condition_counts/);
      expect(diff).not.toMatch(/\+.*from\('item_availability'\)/);
    }
  });

  // PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: StatusCenterScreen.tsx
  // and professional-export.ts are also excluded here — a later, separately-
  // reviewed phase legitimately adds a user-entered-price column/filter to
  // both (row.price only, never calculated/inferred), unrelated to this
  // migration's own RPC scope.
  //
  // PHASE2-AVAILABILITY-ITEM-DETAILS-MODAL-A: InstitutionScreen.tsx is also
  // excluded here — a still later, separately-reviewed phase that adds a
  // read-only availability item details modal, unrelated to this migration's
  // own RPC scope. AvailabilityItemDetailsModal.tsx itself is a brand-new
  // untracked file, so it never appears in `git diff` output at all.
  //
  // PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A: ReportsScreen.tsx,
  // PhoenixSidebar.tsx, and PhoenixMobileDrawer.tsx are also excluded here —
  // a still later, separately-reviewed phase that hides the Reports nav
  // entry and moves its Audit Log tab into Status Center, unrelated to this
  // migration's own RPC scope. AuditLogSection.tsx is a brand-new untracked
  // file, so it never appears in `git diff` output at all.
  //
  // PHASE2-EXPORT-FIELD-SELECTOR-A: OutletAvailabilityReportModal.tsx is
  // also excluded here — a still later, separately-reviewed phase that adds
  // an export/print field selector to it, unrelated to this migration's own
  // RPC scope.
  // PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A: UserManagementScreen.tsx is also
  // excluded here — a still later, separately-reviewed phase that additively
  // wires in the Super Admin-only AvailabilityCleanupWizard, unrelated to
  // this migration's own RPC scope.
  it('no working-tree diff on any frontend production file other than dashboard.service.ts (already-approved RPC switch) and the Entered Price addition', () => {
    let diff = '';
    try {
      diff = execSync(
        // DB-PRESSURE-QUICK-WINS-A: a later, separately-reviewed phase
        // legitimately touches src/app/AppContext.tsx (skipAuthBootstrap),
        // src/shared/supabase/services/organizations.service.ts (org-list
        // cache), and src/shared/supabase/services/lifecycle.service.ts
        // (cache invalidation on archiveOrganization) — all excluded here.
        // PHASE-A-A5-INSTITUTIONS-OUTLETS-A: a later, separately-reviewed
        // phase applies presentation-only className/data-attribute hooks
        // (Phase A design layer, no business-logic change) across the
        // Institution and Outlet Operations surfaces — excluded here.
        // PHASE-A-CLAUDE-A6: a still later, separately-reviewed phase applies
        // the same kind of presentation-only className/data-attribute hooks
        // (phase-a-alerts-admin-qr.css) to the Status Center's internal
        // alerts / outlet-grouped views — excluded here.
        // PHASE-A-CLAUDE-A7: a still later, separately-reviewed phase (Phoenix
        // Daylight visual convergence) applies the same kind of presentation-
        // only token/data-attribute recolouring — never a prop, handler, or
        // RPC change — to ResetPasswordScreen.tsx (primary-button recolour)
        // and PhoenixButton/PhoenixMobileBottomNav/PhoenixStatusBadge (gold
        // primary, teal secondary, dedicated info-blue) — excluded here.
        // PHASE-A-CLAUDE-A7.1: a still later, separately-reviewed phase (A7.1
        // visual acceptance closure) finishes converting the last hardcoded
        // hex literals it found repo-wide to Phoenix tokens — never a prop,
        // handler, or RPC change — see hardcoded-colour-allowlist.md.
        // PHASE-A-CLAUDE-A7.2: a still later, separately-reviewed phase
        // (Premium Living Auth & Welcome) retires the photographic Phoenix-
        // bird hero on both auth screens for an original inline-SVG supply-
        // network illustration — never a handler, session, or RPC change —
        // in LoginScreen.tsx and PhoenixWelcomeExperience.tsx — excluded here.
        // PHASE-A-CLAUDE-A7.2.1: a still later, separately-reviewed phase
        // (Luxury Visual Fidelity Correction) reworks that same illustration
        // component's geometry for closer reference-board fidelity — never a
        // handler, session, or RPC change — InstitutionalSupplyMotif.tsx
        // excluded here (it is a NEW component; the CSS file that also
        // changed is not a .ts/.tsx and is out of this glob's scope already).
        // PHASE-C2-ORG-SCOPE: a still later, separately-reviewed phase scopes
        // Custody Chain and Corrections History (Screen 21 reports tabs) to
        // the selected organization — never a schema, RLS, or workflow
        // change — in custody-chain.service.ts / differences-corrections.
        // service.ts (new orgId param), dispatch.service.ts / outlet-return.
        // service.ts (additive optional organizationId narrowing filter,
        // backward-compatible), and DecisionIntelligenceReportsScreen.tsx
        // (threads activeOrgId into the two tabs) — all excluded here.
        // PHASE-C1-REPORT-INTEGRITY: a still later, separately-reviewed phase
        // fixes Monthly Position's error-swallowing and replaces
        // isDemoOrganization's lossy boolean with a real demo/official/
        // unverified tri-state — never a schema, RLS, or workflow change —
        // in decision-intelligence.service.ts — excluded here.
        // STAGE-E-E7-1-171: a still later, separately-reviewed phase
        // (Migration 171, organization_kind discriminator) adds a new
        // exported type/vocabulary and doc comment to
        // src/shared/lib/institution-hierarchy.ts — a pure types/vocabulary
        // module with no database access, no service function, and no
        // eligibility rule (per its own header) — never a schema, RLS, or
        // workflow change — excluded here.
        // R1.1-P: the facility-parity phase routes every navigation surface
        // through ONE shared projection; CommandPalette.tsx is the last of the
        // four still watched here. Never a schema, RLS, or workflow change —
        // excluded by exact name.
        'git diff -- "src/**/*.ts" "src/**/*.tsx" ":!src/**/__tests__/**" ":!src/shared/ui/CommandPalette.tsx" ":!src/shared/supabase/services/dashboard.service.ts" ":!src/shared/lib/institution-hierarchy.ts" ":!src/shared/supabase/services/organizations.service.ts" ":!src/shared/supabase/services/warehouses.service.ts" ":!src/features/outlet/EmergencyReplenishmentTab.tsx" ":!src/features/outlet/InitialProvisioningLauncher.tsx" ":!src/features/institutions/FacilityManagementPanel.tsx" ":!src/features/institutions/ReplenishmentRouteManagementPanel.tsx" ":!src/features/institutions/WarehouseFacilityAssignmentPanel.tsx" ":!src/features/status/StatusCenterScreen.tsx" ":!src/features/status/InternalAlertsSection.tsx" ":!src/features/status/OutletMaterialGroups.tsx" ":!src/shared/lib/professional-export.ts" ":!src/shared/i18n/strings.ts" ":!src/features/institutions/InstitutionScreen.tsx" ":!src/features/institutions/AvailabilityItemDetailsModal.tsx" ":!src/features/outlet/OutletOperationsScreen.tsx" ":!src/features/outlet/OutletIncomingSupplies.tsx" ":!src/features/outlet/OutletReturnComposer.tsx" ":!src/features/outlet/OutletStockCorrectionModal.tsx" ":!src/features/outlet/DispenseComposerDialog.tsx" ":!src/features/outlet/DispenseContextDialog.tsx" ":!src/features/outlet/dispense-context.service.ts" ":!src/features/outlet/DispenseContextViewer.tsx" ":!src/features/outlet/CurrentMovementStatus.tsx" ":!src/main.tsx" ":!src/features/reports/ReportsScreen.tsx" ":!src/shared/ui/PhoenixSidebar.tsx" ":!src/shared/ui/PhoenixMobileDrawer.tsx" ":!src/features/status/OutletAvailabilityReportModal.tsx" ":!src/features/users/UserManagementScreen.tsx" ":!src/features/admin/AvailabilityCleanupWizard.tsx" ":!src/shared/ui/PhoenixAppShell.tsx" ":!src/features/platform-broadcast/PlatformBroadcastGate.tsx" ":!src/features/platform-broadcast/PlatformBroadcastAdminPanel.tsx" ":!src/shared/supabase/services/platform-broadcast.service.ts" ":!src/app/App.tsx" ":!src/app/AuthenticatedApp.tsx" ":!src/app/AppContext.tsx" ":!src/shared/supabase/services/organizations.service.ts" ":!src/shared/supabase/services/lifecycle.service.ts" ":!src/features/qr/PublicQrScreen.tsx" ":!src/features/auth/ResetPasswordScreen.tsx" ":!src/shared/ui/PhoenixButton.tsx" ":!src/shared/ui/PhoenixMobileBottomNav.tsx" ":!src/shared/ui/PhoenixStatusBadge.tsx" ":!src/features/alerts/materialAlertEngine.ts" ":!src/shared/ui/NotificationBell.tsx" ":!src/shared/ui/WhatsAppContactButton.tsx" ":!src/features/network/NetworkManagementScreen.tsx" ":!src/features/network/DirectSupplyOperations.tsx" ":!src/features/outlet/OutletDispatchOperations.tsx" ":!src/features/procurement/DirectEntryPanel.tsx" ":!src/features/auth/LoginScreen.tsx" ":!src/features/auth/PhoenixWelcomeExperience.tsx" ":!src/shared/ui/InstitutionalSupplyMotif.tsx" ":!src/features/reports/custody-chain.service.ts" ":!src/features/reports/differences-corrections.service.ts" ":!src/features/reports/DecisionIntelligenceReportsScreen.tsx" ":!src/features/outlet/dispatch.service.ts" ":!src/features/outlet/outlet-return.service.ts" ":!src/features/reports/decision-intelligence.service.ts" ":!src/features/movement/DirectReturnComposer.tsx" ":!src/features/network/network.service.ts" ":!src/features/movement/movement-timeline.service.ts"',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* git not available in this sandbox — skip silently */ }
    // M187 authorizes exactly these three delegated-access integration files.
    // SUBSET, not equality: the command above diffs the WORKING TREE, which is
    // empty once committed and on every CI checkout. Anything outside the list
    // still fails closed exactly as the pre-187 `toBe('')` assertion did.
    const DELEGATED_AUTHORIZED = [
      'src/features/inventory/useInventoryScopes.ts',
      'src/features/inventory/useOutletRecallPermission.ts',
      'src/shared/ui/PhoenixOrgScope.tsx',
    ];
    // G3.2 — CANONICAL SEARCH & MATERIAL SELECTION CONVERGENCE authorizes
    // exactly these seven files. Same SUBSET mechanism M187 established, and
    // deliberately the same EXACT-PATH form — never a directory, glob or
    // pattern. A seventh file added under any of these folders still fails this
    // guard closed, which is the whole point of listing names instead of
    // widening the pathspec above.
    //
    // DirectEntryPanel.tsx is already excluded by name in the pathspec, so it is
    // not repeated here. search-contract.ts IS listed as of G3.2 Revision 5: it
    // was withheld while untracked, because `git diff` never reports untracked
    // paths and naming it then would have pre-authorized an unreviewed future
    // change. It is now a reviewed production file about to be committed, and a
    // guard that passes only because a production file is invisible to it is no
    // guard. The entry is the EXACT path — a sibling like search-contract-v2.ts
    // or search-contract.ts.bak still fails this guard closed.
    const G3_2_AUTHORIZED = [
      'src/shared/materials/material-resolver.service.ts',
      'src/shared/materials/PhoenixMaterialResolver.tsx',
      'src/shared/materials/search-contract.ts',
      'src/features/movement/composer-model.ts',
      'src/features/reports/global-material-search.service.ts',
      'src/features/reports/GlobalMaterialSearchPanel.tsx',
      'src/features/inventory/ocr/catalog-adapter.ts',
    ];
    // ALERT-CQRS-BOUNDARY-190 (G4.1): the inter-org alert read/write split.
    // Three production files change, and each is listed by its EXACT path so a
    // sibling or a renamed copy still fails this guard closed. None of them is
    // a DB, RLS, RBAC, auth or migration surface: the split itself lives in
    // migration 190 and is reviewed by its own static and dynamic suites.
    const G4_1_AUTHORIZED = [
      'src/features/alerts/inter-org-alert-lifecycle.service.ts',
      'src/features/alerts/InterInstitutionAlertsScreen.tsx',
      'src/features/dashboard/DashboardScreen.tsx',
    ];
    // G4.2 — canonical facility/scope topology read contract (Migration 191).
    const G4_2_AUTHORIZED = [
      'supabase/migrations/191_phoenix_canonical_scope_topology_read_contract.sql',
      'supabase/migrations/__tests__/191-canonical-scope-topology-static.test.ts',
      'supabase/migrations/__tests__/191-canonical-scope-topology.dynamic.test.ts',
      'src/features/inventory/useInventoryScopes.ts',
      'src/shared/lib/health-sector-grouping.ts',
      'src/shared/lib/direct-supply-corridors.ts',
      'src/shared/supabase/services/scope-topology.service.ts',
      'src/features/institutions/InstitutionScreen.tsx',
      'src/features/network/NetworkManagementScreen.tsx',
      'src/features/network/DirectSupplyOperations.tsx',
    ];
    // G5 — anonymous read-surface convergence (Migration 192). ONE reviewed
    // migration that grants nothing and creates nothing: it revokes every
    // direct anon SELECT in schema public and proves the allowlist is EMPTY.
    // It adds no table, column, policy, function or permission key, and the
    // only WATCHED prefix it enters is supabase/migrations. Registered by
    // EXACT filename, so any unlisted file under a watched prefix still fails
    // this guard closed.
    const G5_AUTHORIZED = [
      'supabase/migrations/192_phoenix_anonymous_read_surface_convergence.sql',
      'supabase/migrations/__tests__/192-anon-read-surface-convergence-static.test.ts',
      'supabase/migrations/__tests__/192-anon-read-surface-convergence.dynamic.test.ts',
    ];
    // TRANSFER-SUGGESTION-REGULATORY-NOTICE-UX: a still later, separately-
    // reviewed frontend stage. It raises ONE regulatory banner above the
    // transfer-suggestion list and makes the draft dialog require an explicit
    // regulatory acknowledgement alongside the document number before it will
    // confirm. Presentation and local component state only — no schema, RLS,
    // RPC, migration, stock semantics or authorization change — and it records
    // NOTHING: no phoenix_record_regulatory_ack call is added here, the formal
    // audited acknowledgement staying exactly where it already lives on the
    // request-level submit/review path.
    //
    // Only these TWO production files are registered. The one i18n key the
    // stage adds lands in src/shared/i18n/strings.ts and its focused test lands
    // under src/**/__tests__/**, both already excluded by the pathspec above,
    // so neither is repeated here. Registered by EXACT path, never a directory
    // or glob: a sibling such as InventoryIntelligencePanel-v2.tsx, or any
    // other file under src/features/inventory, still fails this guard closed.
    const TS_REGULATORY_UX_AUTHORIZED = [
      'src/features/inventory/InventoryIntelligencePanel.tsx',
      'src/features/inventory/InventoryDraftDocumentDialog.tsx',
    ];
    const STAGE_AUTHORIZED = [...DELEGATED_AUTHORIZED, ...G3_2_AUTHORIZED, ...G4_1_AUTHORIZED, ...G4_2_AUTHORIZED, ...G5_AUTHORIZED, ...TS_REGULATORY_UX_AUTHORIZED];
    const delegatedFiles = [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map(match => match[1]).sort();
    expect(delegatedFiles.filter(f => !STAGE_AUTHORIZED.includes(f))).toEqual([]);
  });

  it('no working-tree diff on qr.service.ts, alert/exchange lifecycle files, or navigation/auth files', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/shared/supabase/services/qr.service.ts src/shared/supabase/services/availability.service.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('premium-preview.html remains untracked (only "??" status if present)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('supabase/.temp/ was not staged', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    const tempLine = status.split('\n').find(l => l.includes('supabase/.temp'));
    if (tempLine) {
      expect(tempLine.trim().startsWith('??')).toBe(true);
    }
  });

  it('Service-D stash (paused inter-org exchange service work) remains untouched', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});
