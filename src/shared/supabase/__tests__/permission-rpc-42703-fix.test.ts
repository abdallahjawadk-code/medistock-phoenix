/**
 * PERMISSION-RPC-42703-FIX-B Guardrail Tests
 * Run: npm test -- --run
 *
 * Verifies migration 017 fixes the 42703 (undefined_column) failure mode
 * without weakening any authority check, and that no destructive SQL was
 * introduced. No live Supabase connection is required — static SQL/source
 * checks only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PHOENIX = join(__dirname, '../../../../');
const SRC     = join(__dirname, '../../../');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

// ============================================================================
// 1. Migration 017: exists, manual-only, non-destructive
// ============================================================================

describe('Migration 017: exists and is manual-only', () => {
  const sql = readPhoenix('supabase/migrations/017_phoenix_permission_rpc_42703_fix.sql');
  // Strip `--` line comments so structural checks only see actual executable
  // SQL — the header/footer prose intentionally documents the ABSENCE of
  // DROP/TRUNCATE/CASCADE/passwords ("no DROP TABLE", "does NOT touch
  // passwords"), which would otherwise produce false positives.
  const code = sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');

  it('file exists and is non-empty', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('is manual-apply-only', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('DO NOT use');
    expect(sql).toContain('supabase db push');
  });

  it('has no DROP TABLE, TRUNCATE, or DROP FUNCTION statements', () => {
    expect(code).not.toMatch(/drop table/i);
    expect(code).not.toMatch(/truncate/i);
    expect(code).not.toMatch(/drop function/i);
  });

  it('has no unsafe CASCADE statements', () => {
    expect(code).not.toMatch(/cascade/i);
  });

  it('does not touch auth.users', () => {
    expect(code).not.toMatch(/\b(insert|update|delete)\b.*auth\.users/i);
  });

  it('does not reference service_role or the service-role key', () => {
    expect(code).not.toContain('service_role');
    expect(code).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('only documents (never executes) anything related to passwords', () => {
    expect(code.toLowerCase()).not.toContain('password');
  });

  it('the migration body itself contains no DML against the permission tables (function bodies still legitimately insert/delete profile_permission_overrides rows when called later, and insert audit_logs rows — that is the existing, unchanged behavior, not new migration-time DML)', () => {
    expect(code).not.toMatch(/^\s*(insert into|update )\s+(permission_keys|role_permission_defaults)/im);
  });

  it('does not modify permission_keys, role_permission_defaults, or profile_permission_overrides schema', () => {
    expect(sql).not.toMatch(/alter table (permission_keys|role_permission_defaults|profile_permission_overrides)/i);
  });

  it('does not modify audit_logs schema (that remains migration 013\'s responsibility)', () => {
    expect(sql).not.toMatch(/alter table (public\.)?audit_logs/i);
  });

  it('includes a verification block', () => {
    expect(sql.toLowerCase()).toContain('verification');
    expect(sql).toContain('assert');
  });

  it('includes post-apply verification SQL for permission table columns, the helper definition, function overloads, super_admin defaults, and a no-data-loss check', () => {
    expect(sql).toContain('information_schema.columns');
    expect(sql).toContain('pg_get_functiondef');
    expect(sql).toContain("regprocedure");
    expect(sql).toContain("role = 'super_admin'");
    expect(sql).toContain('permission_key like \'users.%\'');
    expect(sql.toLowerCase()).toContain('no data was deleted');
  });

  it('notes that get_effective_permissions depends on auth.uid() and cannot be fully exercised from the SQL Editor', () => {
    expect(sql).toContain('get_effective_permissions');
    expect(sql).toContain('auth.uid()');
    expect(sql.toLowerCase()).toContain('sql editor');
  });

  it('explicitly does not modify get_effective_permissions (no evidence of an issue in it)', () => {
    expect(sql.toLowerCase()).toContain('does not modify get_effective_permissions');
  });
});

// ============================================================================
// 2. Root cause: documented exactly (audit_logs trigger vs. missing snapshot columns)
// ============================================================================

describe('Migration 017: documents the exact 42703 root cause', () => {
  const sql = readPhoenix('supabase/migrations/017_phoenix_permission_rpc_42703_fix.sql');

  it('names the trigger and the four audit_logs snapshot columns it writes', () => {
    expect(sql).toContain('trg_actor_snapshot');
    expect(sql).toContain('actor_name_snapshot');
    expect(sql).toContain('actor_email_snapshot');
    expect(sql).toContain('actor_org_snapshot');
    expect(sql).toContain('actor_identity_version');
  });

  it('names migration 013 as the source of those columns and 014 as the trigger owner', () => {
    expect(sql.toLowerCase()).toContain('migration 013');
    expect(sql.toLowerCase()).toContain('migration 014');
  });

  it('explains that an aborted audit insert rolls back the whole calling function, including the already-written override', () => {
    expect(sql.toLowerCase()).toContain('rolling back the permission override');
  });
});

// ============================================================================
// 3. phoenix_profile_has_permission: correct columns, override-before-default
// ============================================================================

describe('Migration 017: phoenix_profile_has_permission uses the correct columns', () => {
  const sql = readPhoenix('supabase/migrations/017_phoenix_permission_rpc_42703_fix.sql');
  const fnBlock = sql.slice(sql.indexOf('create or replace function phoenix_profile_has_permission'), sql.indexOf('create or replace function assign_profile_permissions'));

  it('uses .allowed, never is_allowed, on both role_permission_defaults and profile_permission_overrides', () => {
    expect(fnBlock).toContain('o.allowed');
    expect(fnBlock).toContain('d.allowed');
    expect(fnBlock).not.toContain('is_allowed');
  });

  it('uses .permission_key on both tables (not permission_keys.key, which this function never queries)', () => {
    expect(fnBlock).toContain('o.permission_key = p_key');
    expect(fnBlock).toContain('d.permission_key = p_key');
  });

  it('resolves the profile override BEFORE the role default (coalesce order)', () => {
    const overrideIdx = fnBlock.indexOf('profile_permission_overrides');
    const defaultIdx = fnBlock.indexOf('role_permission_defaults');
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(defaultIdx).toBeGreaterThan(overrideIdx);
  });

  it('falls back to false when neither an override nor a role default exists (never grants a missing key by default)', () => {
    expect(fnBlock).toMatch(/false\s*\n\s*\);?\s*\$\$;/);
  });

  it('does not depend on auth.uid() — it is a generic helper, not an authentication check', () => {
    expect(fnBlock).not.toContain('auth.uid()');
  });

  it('does not expose secrets and returns a plain boolean', () => {
    expect(sql.slice(sql.indexOf('create or replace function phoenix_profile_has_permission'), sql.indexOf('create or replace function phoenix_profile_has_permission') + 120))
      .toContain('returns boolean');
  });
});

// ============================================================================
// 4. assign_profile_permissions: all authority checks preserved, audit-safe
// ============================================================================

describe('Migration 017: assign_profile_permissions preserves every authority check', () => {
  const sql = readPhoenix('supabase/migrations/017_phoenix_permission_rpc_42703_fix.sql');
  const fnBlock = sql.slice(sql.indexOf('create or replace function assign_profile_permissions'), sql.indexOf('create or replace function reset_profile_permissions'));

  it('blocks unauthenticated callers', () => {
    expect(fnBlock).toContain("'NOT_AUTHENTICATED'");
  });

  it('rejects a target profile that does not exist', () => {
    expect(fnBlock).toContain("'TARGET_NOT_FOUND'");
  });

  it('blocks self-permission edits unconditionally', () => {
    expect(fnBlock).toContain('p_profile_id = v_actor');
    expect(fnBlock).toContain("'CANNOT_EDIT_OWN_PERMISSIONS'");
  });

  it('requires users.manage_permissions for non-super_admin actors', () => {
    expect(fnBlock).toContain("phoenix_profile_has_permission(v_actor, 'users.manage_permissions')");
    expect(fnBlock).toContain("'INSUFFICIENT_PERMISSION'");
  });

  it('scopes non-super_admin actors to their own organization', () => {
    expect(fnBlock).toContain('v_target_org is distinct from v_org');
    expect(fnBlock).toContain("'OUT_OF_SCOPE'");
  });

  it('rejects unknown permission keys', () => {
    expect(fnBlock).toContain('not exists (select 1 from permission_keys where key = v_key)');
    expect(fnBlock).toContain("'UNKNOWN_PERMISSION'");
  });

  it('requires the actor to already hold a permission before granting it, with a dedicated dangerous-permission code', () => {
    expect(fnBlock).toContain('v_bool is true and v_role <> \'super_admin\'');
    expect(fnBlock).toContain('is_dangerous');
    expect(fnBlock).toContain("'NEEDS_AUTHORITY_FOR_DANGEROUS'");
    expect(fnBlock).toContain("'CANNOT_GRANT_UNHELD'");
  });

  it('super_admin skips the per-key hold/dangerous check entirely (can grant any key to a different user)', () => {
    // The gating condition explicitly excludes super_admin, so the check
    // never fires for v_role = 'super_admin' — granting always proceeds.
    expect(fnBlock).toContain("v_role <> 'super_admin'");
  });

  it('still accepts the flat jsonb payload shape via jsonb_each and null-vs-boolean via jsonb_typeof', () => {
    expect(fnBlock).toContain('select * from jsonb_each(p_permissions)');
    expect(fnBlock).toContain("jsonb_typeof(v_val) = 'null'");
  });

  it('upserts true/false overrides into profile_permission_overrides on conflict', () => {
    expect(fnBlock).toContain('on conflict (profile_id, permission_key)');
    expect(fnBlock).toContain('do update set allowed = excluded.allowed');
  });

  it('wraps the audit_logs insert in its own BEGIN/EXCEPTION block, never failing the already-applied permission write', () => {
    const auditBlock = fnBlock.slice(fnBlock.indexOf('begin\n    insert into audit_logs'));
    expect(auditBlock).toContain('exception when others then');
    expect(auditBlock).toContain('v_audit_logged := false');
  });

  it('returns ok:true with a safe JSON shape including the new audit_logged flag', () => {
    expect(fnBlock).toContain("jsonb_build_object('ok', true, 'applied', v_applied, 'rejected', v_rejected, 'audit_logged', v_audit_logged)");
  });
});

// ============================================================================
// 5. reset_profile_permissions: authority preserved, audit-safe
// ============================================================================

describe('Migration 017: reset_profile_permissions preserves authority checks and is audit-safe', () => {
  const sql = readPhoenix('supabase/migrations/017_phoenix_permission_rpc_42703_fix.sql');
  const fnBlock = sql.slice(sql.indexOf('create or replace function reset_profile_permissions'));

  it('blocks unauthenticated callers and missing targets', () => {
    expect(fnBlock).toContain("'NOT_AUTHENTICATED'");
    expect(fnBlock).toContain("'TARGET_NOT_FOUND'");
  });

  it('requires users.manage_permissions + own-org scope for non-super_admin', () => {
    expect(fnBlock).toContain("'INSUFFICIENT_PERMISSION'");
    expect(fnBlock).toContain("'OUT_OF_SCOPE'");
  });

  it('only deletes the target profile\'s own override rows', () => {
    expect(fnBlock).toContain('delete from profile_permission_overrides where profile_id = p_profile_id');
  });

  it('wraps its audit_logs insert in BEGIN/EXCEPTION too', () => {
    const auditBlock = fnBlock.slice(fnBlock.indexOf('begin\n    insert into audit_logs'));
    expect(auditBlock).toContain('exception when others then');
    expect(auditBlock).toContain('v_audit_logged := false');
  });
});

// ============================================================================
// 6. Grants: unchanged contract (authenticated only, never anon)
// ============================================================================

describe('Migration 017: grants are re-asserted, authenticated only', () => {
  const sql = readPhoenix('supabase/migrations/017_phoenix_permission_rpc_42703_fix.sql');

  it('revokes from anon and grants to authenticated for all three redefined functions', () => {
    expect(sql).toContain('revoke all on function phoenix_profile_has_permission(uuid, text) from anon');
    expect(sql).toContain('grant execute on function phoenix_profile_has_permission(uuid, text) to authenticated');
    expect(sql).toContain('revoke all on function assign_profile_permissions(uuid, jsonb) from anon');
    expect(sql).toContain('grant execute on function assign_profile_permissions(uuid, jsonb) to authenticated');
    expect(sql).toContain('revoke all on function reset_profile_permissions(uuid) from anon');
    expect(sql).toContain('grant execute on function reset_profile_permissions(uuid) to authenticated');
  });
});

// ============================================================================
// 7. Docs: manual-supabase-migrations.md registers migration 017
// ============================================================================

describe('Docs: manual-supabase-migrations.md registers migration 017', () => {
  const doc = readPhoenix('docs/manual-supabase-migrations.md');

  it('lists migration 017 in the apply table and apply order', () => {
    expect(doc).toContain('017_phoenix_permission_rpc_42703_fix.sql');
    expect(doc).toContain('Apply 017 manually');
  });
});

// ============================================================================
// 8. Security/safety guardrails still hold for the frontend
// ============================================================================

describe('Permission RPC 42703 fix: frontend guardrails still hold', () => {
  const svc = readSrc('shared/supabase/services/users.service.ts');
  const screen = readSrc('features/users/UserManagementScreen.tsx');

  it('no service_role in frontend', () => {
    expect(svc).not.toContain('service_role');
    expect(screen).not.toContain('service_role');
  });

  it('no auth.admin in frontend', () => {
    expect(svc).not.toMatch(/auth\.admin/);
    expect(screen).not.toMatch(/auth\.admin/);
  });

  it('Data Reset still absent', () => {
    expect(screen).not.toMatch(/import.*DataReset/i);
  });

  it('Intake/OCR/Excel/DocIntel remain disabled', () => {
    expect(screen).not.toMatch(/import.*OcrImport/i);
    expect(screen).not.toMatch(/import.*ExcelImport/i);
    expect(screen).not.toMatch(/import.*DocIntel/i);
  });

  it('frontend payload/contract is unaffected by this migration (no service code changes needed)', () => {
    expect(svc).toContain("p_profile_id: profileId");
    expect(svc).toContain("p_permissions: overrides");
  });
});
