/**
 * ACTOR-SNAPSHOT-TRIGGER-42703-FIX-A Guardrail Tests
 * Run: npm test -- --run
 *
 * Verifies migration 018 fixes the confirmed live 42703
 * (record "new" has no field "actor_id") error by resolving actor ids via
 * to_jsonb(new)->>'...' instead of directly referencing table-specific
 * NEW.<column> fields inside the shared phoenix_populate_actor_snapshot()
 * CASE expression — without weakening any permission rule, trigger, or
 * security check. No live Supabase connection is required — static SQL
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
// 1. Migration 018: exists, manual-only, non-destructive
// ============================================================================

describe('Migration 018: exists and is manual-only', () => {
  const sql = readPhoenix('supabase/migrations/018_phoenix_actor_snapshot_record_field_fix.sql');
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

  it('has no destructive DELETE or unsafe CASCADE statements', () => {
    expect(code).not.toMatch(/\bdelete from\b/i);
    expect(code).not.toMatch(/cascade/i);
  });

  it('does not touch auth.users, passwords, or service_role', () => {
    expect(code).not.toMatch(/\b(insert|update|delete)\b.*auth\.users/i);
    expect(code.toLowerCase()).not.toContain('password');
    expect(code).not.toContain('service_role');
  });

  it('replaces only phoenix_populate_actor_snapshot — no other function is created or replaced', () => {
    const replaceCount = (code.match(/create or replace function/gi) ?? []).length;
    expect(replaceCount).toBe(1);
    expect(code).toContain('create or replace function phoenix_populate_actor_snapshot()');
  });

  it('does not drop or recreate any trigger', () => {
    expect(code).not.toMatch(/drop trigger/i);
    expect(code).not.toMatch(/create trigger/i);
  });

  it('is idempotent (CREATE OR REPLACE FUNCTION, safe to re-run)', () => {
    expect(sql.toLowerCase()).toContain('idempotent');
  });

  it('includes a verification block', () => {
    expect(sql).toContain('do $$');
    expect(sql).toContain('assert');
  });

  it('includes post-apply verification SQL: function definition check, trigger dependency check, and a rollback-only reproduction', () => {
    expect(sql).toContain("pg_get_functiondef('public.phoenix_populate_actor_snapshot()'::regprocedure)");
    expect(sql).toContain('dep_trigger.tgname');
    expect(sql).toContain('dep_function.proname');
    expect(sql).toContain('begin;');
    expect(sql).toContain('rollback;');
    expect(sql).toContain("set_config('request.jwt.claim.sub'");
  });

  it('verification placeholders are documented in comments only, never executable values', () => {
    const verificationBlock = sql.slice(sql.indexOf('3. Rollback-only reproduction'));
    expect(verificationBlock).toContain('<SUPER_ADMIN_UUID>');
    expect(verificationBlock).toContain('<TARGET_USER_UUID>');
  });
});

// ============================================================================
// 2. Root cause documented exactly
// ============================================================================

describe('Migration 018: documents the exact confirmed error', () => {
  const sql = readPhoenix('supabase/migrations/018_phoenix_actor_snapshot_record_field_fix.sql');

  it('quotes the exact SQLSTATE and message from the live diagnostic', () => {
    expect(sql).toContain('42703');
    expect(sql).toContain('record "new" has no field "actor_id"');
  });

  it('names the exact function and the table where it fired', () => {
    expect(sql).toContain('phoenix_populate_actor_snapshot()');
    expect(sql).toContain('profile_permission_overrides');
  });

  it('explains why migration 017 could not have caught this (failure is earlier than the audit_logs insert)', () => {
    expect(sql.toLowerCase()).toContain("could not) catch this");
    expect(sql).toContain("Migration 017's audit_logs-insert exception handling");
  });
});

// ============================================================================
// 3. phoenix_populate_actor_snapshot: field-safe actor resolution
// ============================================================================

describe('Migration 018: phoenix_populate_actor_snapshot resolves actor ids field-safely', () => {
  const sql = readPhoenix('supabase/migrations/018_phoenix_actor_snapshot_record_field_fix.sql');
  const fnBlock = sql.slice(sql.indexOf('create or replace function phoenix_populate_actor_snapshot'), sql.indexOf('-- ============================================================================\n-- Verification'));

  it('converts NEW to jsonb once via to_jsonb(new)', () => {
    expect(fnBlock).toContain('v_row := to_jsonb(new);');
  });

  it('resolves all six table-specific actor columns via the ->> jsonb operator, never direct NEW.<column> access', () => {
    expect(fnBlock).toContain("v_row->>'actor_id'");
    expect(fnBlock).toContain("v_row->>'submitted_by'");
    expect(fnBlock).toContain("v_row->>'last_updated_by'");
    expect(fnBlock).toContain("v_row->>'created_by'");
    // \b avoids a false positive on new.actor_identity_version, which
    // legitimately starts with the substring "new.actor_id".
    expect(fnBlock).not.toMatch(/\bnew\.actor_id\b/);
    expect(fnBlock).not.toMatch(/\bnew\.submitted_by\b/);
    expect(fnBlock).not.toMatch(/\bnew\.last_updated_by\b/);
    expect(fnBlock).not.toMatch(/\bnew\.created_by\b/);
  });

  it('the actor-resolution CASE has no direct NEW field reference for any of the six branches', () => {
    const caseBlock = fnBlock.slice(fnBlock.indexOf('v_actor_id := case tg_table_name'), fnBlock.indexOf('v_actor_id := coalesce'));
    expect(caseBlock).not.toMatch(/new\.\w+/);
  });

  it('falls back to auth.uid() exactly as before', () => {
    expect(fnBlock).toContain('v_actor_id := coalesce(v_actor_id, auth.uid());');
  });

  it('still returns NEW unchanged when no actor can be resolved', () => {
    expect(fnBlock).toContain('if v_actor_id is null then');
    expect(fnBlock).toContain('return new;');
  });

  it('still preserves existing snapshots on UPDATE except for item_availability', () => {
    expect(fnBlock).toContain("tg_op = 'UPDATE'");
    expect(fnBlock).toContain('new.actor_name_snapshot is not null');
    expect(fnBlock).toContain("tg_table_name <> 'item_availability'");
  });

  it('still looks up the actor identity from profiles + auth.users + organizations', () => {
    expect(fnBlock).toContain('from public.profiles p');
    expect(fnBlock).toContain('left join auth.users u on u.id = p.id');
    expect(fnBlock).toContain('left join public.organizations o on o.id = p.organization_id');
  });

  it('still populates actor_identity_version, actor_name_snapshot, actor_email_snapshot, actor_org_snapshot', () => {
    expect(fnBlock).toContain('new.actor_identity_version := v_identity_version;');
    expect(fnBlock).toContain('new.actor_name_snapshot    := v_full_name;');
    expect(fnBlock).toContain('new.actor_email_snapshot   := v_email;');
    expect(fnBlock).toContain('new.actor_org_snapshot     := v_org_name;');
  });

  it('still guards actor_role_snapshot away from audit_logs', () => {
    expect(fnBlock).toContain("if tg_table_name <> 'audit_logs' then");
    expect(fnBlock).toContain('new.actor_role_snapshot := v_role;');
  });

  it('preserves SECURITY DEFINER and search_path', () => {
    const header = sql.slice(sql.indexOf('create or replace function phoenix_populate_actor_snapshot'), sql.indexOf('as $$'));
    expect(header).toContain('security definer');
    expect(header).toContain('set search_path = public, pg_temp');
  });
});

// ============================================================================
// 4. Security and permission rules unaffected
// ============================================================================

describe('Migration 018: permission security unchanged', () => {
  const migration010 = readPhoenix('supabase/migrations/010_phoenix_user_permission_matrix.sql');
  const migration017 = readPhoenix('supabase/migrations/017_phoenix_permission_rpc_42703_fix.sql');
  const migration018 = readPhoenix('supabase/migrations/018_phoenix_actor_snapshot_record_field_fix.sql');

  it('migration 018 does not modify assign_profile_permissions, reset_profile_permissions, phoenix_profile_has_permission, or get_effective_permissions', () => {
    expect(migration018).not.toContain('create or replace function assign_profile_permissions');
    expect(migration018).not.toContain('create or replace function reset_profile_permissions');
    expect(migration018).not.toContain('create or replace function phoenix_profile_has_permission');
    expect(migration018).not.toContain('create or replace function get_effective_permissions');
  });

  it('self-permission edits remain blocked in the still-authoritative assign_profile_permissions (010/017)', () => {
    expect(migration010).toContain('CANNOT_EDIT_OWN_PERMISSIONS');
    expect(migration017).toContain('CANNOT_EDIT_OWN_PERMISSIONS');
  });

  it('dangerous permission protection remains in the still-authoritative assign_profile_permissions (010/017)', () => {
    expect(migration010).toContain('NEEDS_AUTHORITY_FOR_DANGEROUS');
    expect(migration017).toContain('NEEDS_AUTHORITY_FOR_DANGEROUS');
  });

  it('does not grant anon access to the trigger function (no GRANT/REVOKE statements at all — trigger functions are invoked by the engine, not called directly)', () => {
    expect(migration018).not.toMatch(/grant execute|revoke all/i);
  });
});

// ============================================================================
// 5. Permission save through profile_permission_overrides no longer fails
//    with the confirmed "record NEW has no field actor_id" error
// ============================================================================

describe('Migration 018: permission save path is no longer exposed to the confirmed bug', () => {
  const sql = readPhoenix('supabase/migrations/018_phoenix_actor_snapshot_record_field_fix.sql');

  it('the profile_permission_overrides branch resolves created_by via jsonb, not a direct field reference', () => {
    const fnBlock = sql.slice(sql.indexOf('v_actor_id := case tg_table_name'), sql.indexOf('v_actor_id := coalesce'));
    expect(fnBlock).toContain("when 'profile_permission_overrides'     then nullif(v_row->>'created_by', '')::uuid");
  });

  it('a missing key in the jsonb row returns NULL via ->> instead of raising 42703 (documented behavior backing the fix)', () => {
    expect(sql.toLowerCase()).toContain('returns sql null');
  });
});

// ============================================================================
// 6. Global guardrails still hold
// ============================================================================

describe('Actor snapshot trigger fix: global guardrails still hold', () => {
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
});

// ============================================================================
// 7. Docs: manual-supabase-migrations.md registers migration 018
// ============================================================================

describe('Docs: manual-supabase-migrations.md registers migration 018', () => {
  const doc = readPhoenix('docs/manual-supabase-migrations.md');

  it('lists migration 018 in the apply table and apply order', () => {
    expect(doc).toContain('018_phoenix_actor_snapshot_record_field_fix.sql');
    expect(doc).toContain('Apply 018 manually');
  });
});
