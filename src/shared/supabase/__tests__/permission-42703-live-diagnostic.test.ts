/**
 * SUPABASE-LIVE-PERMISSION-42703-DIAG-C Guardrail Tests
 * Run: npm test -- --run
 *
 * Verifies the live diagnostic SQL script is read-only/rollback-only and
 * never commits, and re-confirms the security guardrails this phase must
 * not weaken while preparing diagnostics. No live Supabase connection is
 * required — static file/source checks only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PHOENIX = join(__dirname, '../../../../');
const SRC     = join(__dirname, '../../../');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

// ============================================================================
// 1. Diagnostic SQL: exists, rollback-only, never commits
// ============================================================================

describe('docs/permission-42703-live-diagnostic.sql: rollback-only reproduction', () => {
  const sql = readPhoenix('docs/permission-42703-live-diagnostic.sql');

  it('file exists and is non-empty', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('the reproduction section is wrapped in begin ... rollback', () => {
    expect(sql).toContain('begin;');
    expect(sql).toContain('rollback;');
  });

  it('never contains a commit statement', () => {
    expect(sql.toLowerCase()).not.toMatch(/^\s*commit\s*;/m);
  });

  it('the rollback appears after the begin and after the RPC call (correct ordering)', () => {
    const beginIdx = sql.indexOf('\nbegin;');
    const callIdx = sql.indexOf('select public.assign_profile_permissions(', beginIdx);
    const rollbackIdx = sql.indexOf('rollback;', callIdx);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(beginIdx);
    expect(rollbackIdx).toBeGreaterThan(callIdx);
  });

  it('has no DROP TABLE, TRUNCATE, or other destructive statements', () => {
    const code = sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
    expect(code).not.toMatch(/drop table/i);
    expect(code).not.toMatch(/truncate/i);
    expect(code).not.toMatch(/\bdelete from\b/i);
  });

  it('schema/function inspection sections are pure SELECT (read-only), no DML', () => {
    const section1and2 = sql.slice(sql.indexOf('SECTION 1'), sql.indexOf('SECTION 3'));
    expect(section1and2).not.toMatch(/\b(insert into|update |delete from|drop |alter table)\b/i);
  });

  it('never instructs the operator to use a real service_role/secret value (only warns against it)', () => {
    expect(sql).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    // "service_role key" appears only inside the safety warning telling the
    // operator never to paste one — never as a value the script itself uses.
    expect(sql.toLowerCase()).toContain('never paste your database password, service_role key');
  });

  it('explicitly warns against pasting secrets back, and against using COMMIT', () => {
    expect(sql.toLowerCase()).toContain('never paste your database password');
    expect(sql.toLowerCase()).toContain('never replace rollback with');
  });

  it('requires ACTOR and TARGET to be different profiles (so self-edit is not mistaken for the real bug)', () => {
    expect(sql).toContain('ACTOR_SUPER_ADMIN_UUID');
    expect(sql).toContain('TARGET_USER_UUID');
    expect(sql.toLowerCase()).toContain('must not equal');
  });

  it('uses set_config to simulate auth.uid() instead of a real JWT/session token', () => {
    expect(sql).toContain("set_config('request.jwt.claim.sub'");
    expect(sql).toContain("set_config('request.jwt.claim.role'");
  });

  it('inspects audit_logs and profile_permission_overrides triggers (the two tables with actor-snapshot triggers)', () => {
    expect(sql).toContain("'public.audit_logs'::regclass");
    expect(sql).toContain("'public.profile_permission_overrides'::regclass");
  });

  it('checks for duplicate/ambiguous function overloads across all five relevant functions', () => {
    expect(sql).toContain('phoenix_profile_has_permission');
    expect(sql).toContain('phoenix_populate_actor_snapshot');
    expect(sql).toContain('assign_profile_permissions');
    expect(sql).toContain('reset_profile_permissions');
    expect(sql).toContain('get_effective_permissions');
    expect(sql.toLowerCase()).toContain('more than once');
  });

  it('asks the operator to capture the CONTEXT line, which names the exact failing function/line', () => {
    expect(sql).toContain('CONTEXT');
  });
});

// ============================================================================
// 2. Security guardrails unchanged by this diagnostic-only phase
// ============================================================================

describe('Permission 42703 diagnostics: security guardrails unchanged', () => {
  const migration010 = readPhoenix('supabase/migrations/010_phoenix_user_permission_matrix.sql');
  const migration017 = readPhoenix('supabase/migrations/017_phoenix_permission_rpc_42703_fix.sql');
  const svc = readSrc('shared/supabase/services/users.service.ts');
  const screen = readSrc('features/users/UserManagementScreen.tsx');

  it('self-permission edits remain blocked in both migration 010 and 017', () => {
    expect(migration010).toContain('CANNOT_EDIT_OWN_PERMISSIONS');
    expect(migration017).toContain('CANNOT_EDIT_OWN_PERMISSIONS');
  });

  it('dangerous permission protection remains in migration 017', () => {
    expect(migration017).toContain('NEEDS_AUTHORITY_FOR_DANGEROUS');
    expect(migration017).toContain('is_dangerous');
  });

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
