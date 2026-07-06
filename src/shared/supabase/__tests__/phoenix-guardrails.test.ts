/**
 * Phoenix V2 Guardrail Tests
 * Run: npm test -- --run
 *
 * These tests verify safety constraints without requiring a real DB connection.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// __dirname = phoenix/src/shared/supabase/__tests__
const SRC     = join(__dirname, '../../../');    // → phoenix/src/
const PHOENIX = join(__dirname, '../../../../'); // → phoenix/

// ─── helpers ────────────────────────────────────────────────────────────────

function readSrc(rel: string) {
  return readFileSync(join(SRC, rel), 'utf8');
}

function readPhoenix(rel: string) {
  return readFileSync(join(PHOENIX, rel), 'utf8');
}

function allTsxFiles(dir: string): string[] {
  const base = join(SRC, dir);
  return readdirSync(base, { recursive: true })
    .filter((f): f is string =>
      typeof f === 'string' &&
      (f.endsWith('.ts') || f.endsWith('.tsx')) &&
      !f.includes('__tests__') &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('.spec.ts')
    )
    .map(f => join(base, f));
}

function readFile(path: string) {
  return readFileSync(path, 'utf8');
}

// ─── SQL file helpers ────────────────────────────────────────────────────────

function readSql(rel: string) {
  return readPhoenix(join('supabase', rel));
}

// ============================================================================
// 1. WIPE TOOLING REMOVED (FINAL-HANDOVER-BLOCKER-A)
// ============================================================================
// The destructive full-wipe executor (phoenix-wipe-execute.cjs) and its SQL
// (supabase/full_wipe_tools/) were removed from the repo before handover.
// The production DB was already cleaned; no wipe tooling may return. These
// guards fail if anyone re-adds it.

describe('Wipe tooling stays removed from the repo', () => {
  it('phoenix-wipe-execute.cjs does not exist', () => {
    expect(existsSync(join(PHOENIX, 'phoenix-wipe-execute.cjs'))).toBe(false);
  });

  it('supabase/full_wipe_tools/ does not exist', () => {
    expect(existsSync(join(PHOENIX, 'supabase/full_wipe_tools'))).toBe(false);
  });

  it('no package.json script references wipe tooling', () => {
    const pkg = JSON.parse(readPhoenix('package.json'));
    const scripts = Object.values(pkg.scripts ?? {}).join(' ');
    expect(scripts).not.toMatch(/wipe|full_wipe|phoenix-wipe-execute/i);
  });

  it('.env.example no longer offers the wipe approval gate', () => {
    expect(readPhoenix('.env.example')).not.toContain('FULL_PUBLIC_APP_WIPE_APPROVED');
  });

  it('migration 004 (demo seed) still exists but nothing in the repo can execute it', () => {
    // The migration file itself is intentionally preserved (history/reference);
    // the executor that auto-ran it after a wipe is gone.
    expect(existsSync(join(PHOENIX, 'supabase/migrations/004_phoenix_seed_demo_data.sql'))).toBe(true);
    expect(existsSync(join(PHOENIX, 'phoenix-wipe-execute.cjs'))).toBe(false);
  });
});

// ============================================================================
// 2. MIGRATION: 10 PHOENIX TABLES
// ============================================================================

describe('Migration 001: core schema', () => {
  const sql = readSql('migrations/001_phoenix_core_schema.sql');

  const REQUIRED_TABLES = [
    'organizations', 'profiles', 'warehouses', 'distribution_points',
    'central_items', 'local_items', 'item_availability',
    'qr_targets', 'qr_tokens', 'audit_logs',
  ];

  REQUIRED_TABLES.forEach(table => {
    it(`creates table: ${table}`, () => {
      expect(sql).toMatch(new RegExp(`create table if not exists ${table}`, 'i'));
    });
  });

  it('has updated_at trigger function', () => {
    expect(sql).toContain('phoenix_set_updated_at');
  });

  it('has auto-profile trigger for new auth users', () => {
    expect(sql).toContain('phoenix_handle_new_user');
    expect(sql).toContain('on_auth_user_created');
  });
});

// ============================================================================
// 3. RLS ENABLED
// ============================================================================

describe('Migration 002: RLS policies', () => {
  const sql = readSql('migrations/002_phoenix_rls_policies.sql');

  const TABLES = [
    'organizations', 'profiles', 'warehouses', 'distribution_points',
    'central_items', 'local_items', 'item_availability',
    'qr_targets', 'qr_tokens', 'audit_logs',
  ];

  TABLES.forEach(table => {
    it(`enables RLS on: ${table}`, () => {
      expect(sql).toMatch(new RegExp(`alter table ${table}\\s+enable row level security`, 'i'));
    });
  });

  it('central_items: only super_admin can write', () => {
    expect(sql).toContain("ci_write_superadmin");
    expect(sql).toContain("phoenix_my_role() = 'super_admin'");
  });

  it('audit_logs: no UPDATE or DELETE policy', () => {
    expect(sql).not.toMatch(/create policy.*audit_logs.*for (update|delete)/i);
  });

  it('anon can read active qr_tokens by public_id', () => {
    expect(sql).toContain('qrtk_select_anon');
    expect(sql).toContain("to anon");
    expect(sql).toContain("status = 'active'");
  });
});

// ============================================================================
// 4. RPC LIFECYCLE: PURGE SAFETY
// ============================================================================

describe('Migration 003: RPC lifecycle purge safety', () => {
  const sql = readSql('migrations/003_phoenix_rpc_lifecycle.sql');

  it('purge allowlist: only warehouse, distribution_point, local_item', () => {
    expect(sql).toContain("array['warehouse', 'distribution_point', 'local_item']");
  });

  it('purge requires exact confirmation phrase', () => {
    expect(sql).toContain("'CONFIRM_PURGE_'");
    expect(sql).toContain('CONFIRMATION_MISMATCH');
  });

  it('purge is super_admin only', () => {
    expect(sql).toContain('SUPER_ADMIN_ONLY');
  });

  it('purge disables QR tokens BEFORE deleting parent (QR-first order)', () => {
    const purgeStart = sql.indexOf('purge_entity_with_all_data');
    const qrDisable  = sql.indexOf("status = 'disabled'", purgeStart);
    const deleteParent = sql.lastIndexOf('delete from warehouses');
    expect(qrDisable).toBeGreaterThan(purgeStart);
    expect(deleteParent).toBeGreaterThan(qrDisable);
  });

  it('purge deletes parent LAST (after QR and child rows)', () => {
    // For distribution_point purge: qr disable < item_availability delete < dp delete
    const dpPurgeBlock = sql.indexOf("when 'distribution_point'");
    const qrInBlock    = sql.indexOf("status = 'disabled'", dpPurgeBlock);
    const availDelete  = sql.indexOf('delete from item_availability where distribution_point_id', dpPurgeBlock);
    const dpDelete     = sql.indexOf('delete from distribution_points where id = p_entity_id', dpPurgeBlock);
    expect(qrInBlock).toBeGreaterThan(dpPurgeBlock);
    expect(availDelete).toBeGreaterThan(qrInBlock);
    expect(dpDelete).toBeGreaterThan(availDelete);
  });

  it('has MEDISTOCK_PHOENIX_PURGE_V1 marker', () => {
    expect(sql).toContain('MEDISTOCK_PHOENIX_PURGE_V1');
  });

  it('disable_qr_token never deletes parent entity', () => {
    const fnStart = sql.indexOf('function disable_qr_token');
    const fnEnd   = sql.indexOf('$$;', fnStart + 1);
    const body    = sql.slice(fnStart, fnEnd);
    expect(body).not.toMatch(/delete from (warehouses|distribution_points|local_items|organizations)/i);
  });

  it('archive_entity is allowlisted (no generic entity)', () => {
    expect(sql).toContain("array['warehouse', 'distribution_point', 'local_item']");
  });

  it('get_public_qr_payload is granted to anon', () => {
    expect(sql).toContain('grant execute on function get_public_qr_payload');
    expect(sql).toContain('to anon');
  });
});

// ============================================================================
// 5. FRONTEND: NO service_role IN BROWSER
// ============================================================================

describe('Frontend: no service_role in browser code', () => {
  const files = allTsxFiles('');

  files.forEach(path => {
    it(`${path.split('src/')[1]} does not reference service_role`, () => {
      const content = readFile(path);
      expect(content).not.toContain('service_role');
    });
  });
});

// ============================================================================
// 6. FRONTEND: NO .delete() ON PROTECTED TABLES
// ============================================================================

describe('Frontend: no raw .delete() calls', () => {
  const files = allTsxFiles('');

  files.forEach(path => {
    it(`${path.split('src/')[1]} does not use .delete() on tables`, () => {
      const content = readFile(path);
      // Allow .delete() only in lifecycle.service.ts comments, nowhere else
      const matches = content.match(/supabase\s*\.\s*from\s*\([^)]+\)\s*\.\s*delete\s*\(/g);
      expect(matches).toBeNull();
    });
  });
});

// ============================================================================
// 7. FRONTEND: NO OLD IMPORTS
// ============================================================================

describe('Frontend: no old project imports', () => {
  const OLD_PATTERNS = [
    /from ['"].*ادارة.*المستشفى/,
    /from ['"].*\/old\//,
    /import.*DataReset/i,
    /import.*OcrImport/i,
    /import.*DocIntel/i,
    /import.*ExcelImport/i,
    /import.*PharmaNetwork/i,
  ];

  const files = allTsxFiles('');
  files.forEach(path => {
    const content = readFile(path);
    OLD_PATTERNS.forEach(pattern => {
      it(`${path.split('src/')[1]} does not match ${pattern}`, () => {
        expect(content).not.toMatch(pattern);
      });
    });
  });
});

// ============================================================================
// 8. FRONTEND: NO DANGEROUS COMMANDS IN SCRIPTS
// ============================================================================

describe('Package.json: no dangerous scripts', () => {
  const pkg = JSON.parse(readPhoenix('package.json'));
  const scripts = Object.values(pkg.scripts ?? {}).join(' ');

  it('does not use: npx supabase db push', () => {
    expect(scripts).not.toContain('supabase db push');
  });

  it('does not use: npm audit fix --force', () => {
    expect(scripts).not.toContain('audit fix --force');
  });
});

// ============================================================================
// 9. SUPABASE CLIENT: lazy init, no throw at module level
// ============================================================================

describe('Supabase client: safe lazy init', () => {
  const client = readSrc('shared/supabase/client.ts');

  it('exports supabaseConfigured flag', () => {
    expect(client).toContain('supabaseConfigured');
  });

  it('does not throw at module import when env vars are missing', () => {
    expect(client).not.toContain('throw new Error');
  });

  it('reads only VITE_ prefixed vars (not service_role)', () => {
    expect(client).toContain('VITE_PHOENIX_SUPABASE_URL');
    expect(client).toContain('VITE_PHOENIX_SUPABASE_ANON_KEY');
    expect(client).not.toContain('service_role');
    expect(client).not.toContain('SERVICE_ROLE');
  });
});

// ============================================================================
// 10. RTL: html element has dir attribute managed
// ============================================================================

describe('AppContext: RTL/LTR direction management', () => {
  const ctx = readSrc('app/AppContext.tsx');

  it('sets dir attribute on document.documentElement', () => {
    expect(ctx).toContain('documentElement');
    expect(ctx).toContain('dir');
  });

  it('exports useApp hook', () => {
    expect(ctx).toContain('useApp');
  });
});

// ============================================================================
// 11. INTAKE FROZEN: no interactive elements exposed
// ============================================================================

describe('IntakeFrozenScreen: frozen state', () => {
  const frozen = readSrc('features/health/IntakeFrozenScreen.tsx');

  it('contains frozen/blocked messaging', () => {
    expect(frozen.toLowerCase()).toMatch(/frozen|مجمد|blocked|محظور/);
  });

  it('does not import ocr, excel, or docIntel services', () => {
    expect(frozen).not.toMatch(/import.*[Oo]cr/);
    expect(frozen).not.toMatch(/import.*[Ee]xcel/);
    expect(frozen).not.toMatch(/import.*[Dd]oc[Ii]ntel/);
  });
});

// ============================================================================
// 12. LIVE AUTH WIRING
// ============================================================================

describe('Live auth: client + auth service', () => {
  const auth   = readSrc('shared/supabase/services/auth.service.ts');
  const ctx    = readSrc('app/AppContext.tsx');
  const login  = readSrc('features/auth/LoginScreen.tsx');

  it('auth service uses signInWithPassword (no admin API)', () => {
    expect(auth).toContain('signInWithPassword');
    expect(auth).not.toContain('admin.');
    expect(auth).not.toContain('service_role');
  });

  it('auth service reads the profile from public.profiles', () => {
    expect(auth).toContain("from('profiles')");
  });

  it('AppContext exposes real session + authReady gating', () => {
    expect(ctx).toContain('authReady');
    expect(ctx).toContain('session');
    expect(ctx).toContain('getMyProfile');
  });

  it('LoginScreen performs real sign-in (no demo bypass)', () => {
    expect(login).toContain('signIn');
    expect(login).not.toContain('Demo Login');
    expect(login).not.toContain('onLogin');
  });
});

// ============================================================================
// 13. APP ROUTING: auth gate + anon public QR
// ============================================================================

describe('App routing: auth gate + public QR', () => {
  const app = readSrc('app/App.tsx');

  it('gates the app behind a session', () => {
    expect(app).toContain('session');
    expect(app).toContain('LoginScreen');
  });

  it('exposes an anon public QR route via ?qid=', () => {
    expect(app).toContain('qid');
    expect(app).toContain('PublicQrScreen');
  });
});

// ============================================================================
// 14. SERVICES: QR lifecycle uses RPCs, no raw deletes
// ============================================================================

describe('Services: QR lifecycle is RPC-only', () => {
  const qr = readSrc('shared/supabase/services/qr.service.ts');

  it('uses the three Phoenix QR RPCs', () => {
    expect(qr).toContain('get_public_qr_payload');
    expect(qr).toContain('create_qr_for_target');
    expect(qr).toContain('disable_qr_token');
  });

  it('never calls .delete() on a table', () => {
    expect(qr).not.toMatch(/\.from\([^)]+\)\s*\.\s*delete\s*\(/);
  });
});

// ============================================================================
// 15. PASSWORD RESET: dynamic redirect, no hardcoded legacy URL
// ============================================================================

describe('Password reset: dynamic redirect + no legacy URL', () => {
  const auth = readSrc('shared/supabase/services/auth.service.ts');

  it('uses Supabase resetPasswordForEmail + updateUser only', () => {
    expect(auth).toContain('resetPasswordForEmail');
    expect(auth).toContain('updateUser');
    expect(auth).not.toContain('service_role');
  });

  it('redirect target is built from the current origin', () => {
    expect(auth).toContain('window.location.origin');
    expect(auth).toContain('/auth/callback');
  });

  it('no src file hardcodes the legacy production URL', () => {
    const files = allTsxFiles('');
    files.forEach(path => {
      expect(readFile(path)).not.toContain('medistock-qr-network');
    });
  });
});

// ============================================================================
// 16. DEPLOYMENT READINESS: vercel config + docs
// ============================================================================

describe('Deployment readiness: vercel.json', () => {
  const vercel = JSON.parse(readPhoenix('vercel.json'));

  it('uses the Vite framework preset', () => {
    expect(vercel.framework).toBe('vite');
  });

  it('builds with npm run build into dist', () => {
    expect(vercel.buildCommand).toContain('npm run build');
    expect(vercel.outputDirectory).toBe('dist');
  });

  it('has an SPA rewrite so deep links / public QR refresh resolve', () => {
    const rewrites = vercel.rewrites ?? [];
    const spa = rewrites.find((r: { source: string }) => r.source === '/(.*)');
    expect(spa).toBeTruthy();
    expect(spa.destination).toMatch(/index\.html|\/$/);
  });
});

// ============================================================================
// 17. ACCOUNT LIFECYCLE POLICY: docs exist and contain required content
// ============================================================================

describe('Account lifecycle policy: docs/account-lifecycle-policy.md', () => {
  const policy = readPhoenix('docs/account-lifecycle-policy.md');

  it('documents all five lifecycle states', () => {
    expect(policy).toContain('active');
    expect(policy).toContain('suspended');
    expect(policy).toContain('corrected');
    expect(policy).toContain('recycled_candidate');
    expect(policy).toContain('recycled');
  });

  it('covers all official roles', () => {
    expect(policy).toContain('super_admin');
    expect(policy).toContain('institution_admin');
    expect(policy).toContain('warehouse_officer');
    expect(policy).toContain('port_officer');
    expect(policy).toContain('monthly_status_officer');
    expect(policy).toContain('viewer');
  });

  it('defines disable, correction, password reset, recycling, and hard delete', () => {
    expect(policy.toLowerCase()).toContain('disable');
    expect(policy.toLowerCase()).toContain('correction');
    expect(policy.toLowerCase()).toContain('password reset');
    expect(policy.toLowerCase()).toContain('recycl');
    expect(policy.toLowerCase()).toContain('hard delete');
  });

  it('explicitly states hard delete is not a normal operational action', () => {
    expect(policy).toContain('NOT a normal operational action');
  });

  it('explains why hard delete is avoided (attribution / FKs)', () => {
    expect(policy.toLowerCase()).toContain('profile_id');
    expect(policy.toLowerCase()).toContain('irreversible');
  });

  it('explains why normal account edit must not be used for recycling', () => {
    expect(policy.toLowerCase()).toContain('retroactive');
    expect(policy.toLowerCase()).toContain('identity substitution');
  });

  it('references the future identity snapshot plan', () => {
    expect(policy).toContain('user-identity-snapshot-plan.md');
    expect(policy).toContain('identity_version');
  });

  it('documents rollback options for each action', () => {
    expect(policy.toLowerCase()).toContain('rollback');
    expect(policy.toLowerCase()).toContain('re-enable');
  });

  it('prohibits auth.admin and service_role from frontend code', () => {
    expect(policy).toContain('auth.admin');
    expect(policy).toContain('service_role');
  });
});

describe('Identity snapshot plan: docs/user-identity-snapshot-plan.md', () => {
  const snapshot = readPhoenix('docs/user-identity-snapshot-plan.md');

  it('describes the user_identity_history table', () => {
    expect(snapshot).toContain('user_identity_history');
  });

  it('describes the identity_version column on profiles', () => {
    expect(snapshot).toContain('identity_version');
    expect(snapshot).toContain('profiles.identity_version');
  });

  it('documents all required actor snapshot fields', () => {
    expect(snapshot).toContain('actor_name_snapshot');
    expect(snapshot).toContain('actor_email_snapshot');
    expect(snapshot).toContain('actor_role_snapshot');
    expect(snapshot).toContain('actor_org_snapshot');
    expect(snapshot).toContain('actor_identity_version');
  });

  it('lists tables requiring review before implementation', () => {
    expect(snapshot).toContain('audit_logs');
    expect(snapshot).toContain('institution_item_status_reports');
  });

  it('explains how old operations stay attributed to the old identity', () => {
    expect(snapshot.toLowerCase()).toContain('historical');
    expect(snapshot.toLowerCase()).toContain('do not change');
  });

  it('states recycling must be an atomic server-side operation', () => {
    expect(snapshot.toLowerCase()).toContain('atomic');
    expect(snapshot.toLowerCase()).toContain('transaction');
  });

  it('warns against partial implementation', () => {
    expect(snapshot.toLowerCase()).toContain('partial implementation');
  });
});

// ============================================================================
// 18. RECYCLING + HARD DELETE: not yet in UI or services
// ============================================================================

describe('Account lifecycle guardrails: recycling properly guarded', () => {
  const screen  = readSrc('features/users/UserManagementScreen.tsx');
  const userSvc = readSrc('shared/supabase/services/users.service.ts');

  it('recycling is guarded by canRecycle permission check', () => {
    expect(screen).toContain('canRecycle');
    expect(screen).toContain("users.recycle");
  });

  it('recycling only shown for suspended users', () => {
    expect(screen).toContain("u.status === 'suspended'");
  });

  it('hard delete button is not rendered in the UI', () => {
    expect(screen).not.toContain('deleteTarget');
    expect(screen).not.toContain('um_delete_user_action');
  });

  it('deleteUserViaEdge exists in service but is not imported in the screen', () => {
    expect(userSvc).toContain('deleteUserViaEdge');
    expect(screen).not.toMatch(/import[^;]*deleteUserViaEdge/);
  });

  it('no raw .update() on profiles in frontend code (all changes via RPCs/Edge Functions)', () => {
    const files = allTsxFiles('');
    files.forEach(path => {
      const content = readFile(path);
      const dangerousUpdate = content.match(/from\(['"]profiles['"]\)\s*\.\s*update\s*\(/g);
      expect(dangerousUpdate).toBeNull();
    });
  });
});

// ============================================================================
// (16 continues below)
// ============================================================================

describe('Deployment readiness: documentation', () => {
  const doc = readPhoenix('docs/deployment-readiness.md');

  it('documents the actual frontend env var names (anon only)', () => {
    expect(doc).toContain('VITE_PHOENIX_SUPABASE_URL');
    expect(doc).toContain('VITE_PHOENIX_SUPABASE_ANON_KEY');
  });

  it('never documents service_role for the frontend', () => {
    // service_role may only appear as an explicit prohibition, never as a value.
    expect(doc).not.toMatch(/VITE_[A-Z_]*SERVICE_ROLE/);
    expect(doc.toLowerCase()).toContain('never');
    expect(doc).toContain('service_role'); // present only as a "never" warning
  });

  it('lists the three manual migrations 005/006/007', () => {
    expect(doc).toContain('005_phoenix_assign_profile_role.sql');
    expect(doc).toContain('006_phoenix_status_reports.sql');
    expect(doc).toContain('007_phoenix_clear_port_availability.sql');
  });

  it('forbids db push and audit fix --force', () => {
    expect(doc).toContain('supabase db push');
    expect(doc).toContain('audit fix --force');
  });

  it('documents the public QR route as public/unauthenticated', () => {
    expect(doc).toMatch(/public qr/i);
    expect(doc.toLowerCase()).toMatch(/no auth|unauthenticated|public \(no auth\)/);
  });

  it('documents protected routes as auth-gated', () => {
    expect(doc.toLowerCase()).toContain('auth-gated');
    expect(doc.toLowerCase()).toContain('dashboard');
  });

  it('includes post-deploy smoke tests and a rollback plan', () => {
    expect(doc.toLowerCase()).toContain('smoke test');
    expect(doc.toLowerCase()).toContain('rollback');
    expect(doc).toContain('git revert');
  });
});

// ============================================================================
// 19. MIGRATION 013: identity snapshot foundation
// ============================================================================

describe('Migration 013: user identity snapshot foundation', () => {
  const sql = readSql('migrations/013_phoenix_user_identity_snapshot_foundation.sql');

  it('file exists and is non-empty', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('is manual-apply-only (contains the DO NOT use supabase db push warning)', () => {
    expect(sql).toContain('DO NOT use');
    expect(sql).toContain('supabase db push');
  });

  it('has no DROP or TRUNCATE statements', () => {
    expect(sql).not.toMatch(/^\s*(drop table|drop function|truncate)\b/im);
  });

  it('adds profiles.identity_version with default 1', () => {
    expect(sql).toContain('identity_version');
    expect(sql).toContain('default 1');
  });

  it('adds a check constraint: identity_version >= 1', () => {
    expect(sql).toContain('identity_version >= 1');
  });

  it('creates the user_identity_history table', () => {
    expect(sql).toMatch(/create table if not exists.*user_identity_history/i);
  });

  it('user_identity_history has profile_id, identity_version, valid_from, valid_until, change_reason', () => {
    expect(sql).toContain('profile_id');
    expect(sql).toContain('identity_version');
    expect(sql).toContain('valid_from');
    expect(sql).toContain('valid_until');
    expect(sql).toContain('change_reason');
  });

  it('seeds initial identity history with ON CONFLICT DO NOTHING', () => {
    expect(sql).toContain('initial_snapshot');
    expect(sql).toContain('on conflict');
    expect(sql).toContain('do nothing');
  });

  it('adds actor snapshot columns to audit_logs (4 columns)', () => {
    const auditBlock = sql.indexOf('audit_logs');
    expect(auditBlock).toBeGreaterThan(-1);
    expect(sql).toContain('actor_name_snapshot');
    expect(sql).toContain('actor_email_snapshot');
    expect(sql).toContain('actor_org_snapshot');
    expect(sql).toContain('actor_identity_version');
  });

  it('adds actor snapshot columns to institution_item_status_reports', () => {
    expect(sql).toContain('institution_item_status_reports');
    expect(sql).toContain('actor_role_snapshot');
  });

  it('adds actor snapshot columns to item_availability', () => {
    expect(sql).toContain('item_availability');
  });

  it('adds actor snapshot columns to qr_tokens', () => {
    expect(sql).toContain('qr_tokens');
  });

  it('adds actor snapshot columns to organization_status_contacts', () => {
    expect(sql).toContain('organization_status_contacts');
  });

  it('adds actor snapshot columns to profile_permission_overrides', () => {
    expect(sql).toContain('profile_permission_overrides');
  });

  it('covers 6 operational tables with snapshot columns', () => {
    const tables = [
      'audit_logs',
      'institution_item_status_reports',
      'item_availability',
      'qr_tokens',
      'organization_status_contacts',
      'profile_permission_overrides',
    ];
    tables.forEach(t => expect(sql).toContain(t));
  });

  it('includes best-effort backfill for existing rows', () => {
    expect(sql).toContain('actor_name_snapshot is null');
  });

  it('creates the get_profile_identity_snapshot helper function', () => {
    expect(sql).toContain('get_profile_identity_snapshot');
    expect(sql).toContain('security definer');
  });

  it('grants helper function to authenticated users only', () => {
    expect(sql).toContain('grant execute on function');
    expect(sql).toContain('to authenticated');
    expect(sql).not.toContain('to anon');
  });

  it('includes a verification block', () => {
    expect(sql.toLowerCase()).toContain('verify');
    expect(sql).toContain('assert');
  });

  it('explicitly notes this migration does NOT implement recycling', () => {
    expect(sql.toLowerCase()).toContain('does not implement');
    expect(sql.toLowerCase()).toContain('recycl');
  });

  it('uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS patterns (idempotent)', () => {
    expect(sql).toContain('if not exists');
    expect(sql).toContain('add column if not exists');
  });

  it('does not reference service_role (must not leak to migration file)', () => {
    expect(sql).not.toContain('service_role');
  });

  it('joins auth.users safely for email backfill (not via service_role)', () => {
    expect(sql).toContain('auth.users');
    expect(sql).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});

describe('Identity snapshot plan: foundation status updated', () => {
  const snapshot = readPhoenix('docs/user-identity-snapshot-plan.md');

  it('marks the foundation as applied (migrations 013 + 014)', () => {
    expect(snapshot).toContain('013');
    expect(snapshot).toContain('014');
    expect(snapshot).toContain('Write paths wired');
  });

  it('identifies the next phase as ACTOR-SNAPSHOT-WRITE-PATHS-A', () => {
    expect(snapshot).toContain('ACTOR-SNAPSHOT-WRITE-PATHS-A');
  });

  it('documents which tables were covered and which were excluded', () => {
    expect(snapshot).toContain('audit_logs');
    expect(snapshot).toContain('NOT covered');
  });

  it('documents initial_snapshot seed behavior', () => {
    expect(snapshot).toContain('initial_snapshot');
  });
});

// ============================================================================
// 20. MIGRATION 014: actor snapshot write-path triggers
// ============================================================================

describe('Migration 014: actor snapshot write-path triggers', () => {
  const sql = readSql('migrations/014_phoenix_actor_snapshot_write_path_triggers.sql');

  it('file exists and is non-empty', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('is manual-apply-only', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('DO NOT use');
  });

  it('has no DROP TABLE or TRUNCATE statements', () => {
    expect(sql).not.toMatch(/^\s*(drop table|truncate)\b/im);
  });

  it('creates the phoenix_populate_actor_snapshot trigger function', () => {
    expect(sql).toContain('phoenix_populate_actor_snapshot');
    expect(sql).toContain('returns trigger');
    expect(sql).toContain('security definer');
  });

  it('trigger function resolves actor from the correct column per table', () => {
    expect(sql).toContain("when 'audit_logs'");
    expect(sql).toContain('new.actor_id');
    expect(sql).toContain("when 'institution_item_status_reports'");
    expect(sql).toContain('new.submitted_by');
    expect(sql).toContain("when 'item_availability'");
    expect(sql).toContain('new.last_updated_by');
    expect(sql).toContain("when 'qr_tokens'");
    expect(sql).toContain("when 'organization_status_contacts'");
    expect(sql).toContain("when 'profile_permission_overrides'");
    expect(sql).toContain('new.created_by');
  });

  it('falls back to auth.uid() when actor column is NULL', () => {
    expect(sql).toContain('coalesce(new.actor_id, auth.uid())');
    expect(sql).toContain('coalesce(new.submitted_by, auth.uid())');
    expect(sql).toContain('coalesce(new.last_updated_by, auth.uid())');
    expect(sql).toContain('coalesce(new.created_by, auth.uid())');
  });

  it('on INSERT always populates snapshot (prevents frontend spoofing)', () => {
    // The UPDATE guard skips re-snapshot, but INSERT always falls through
    expect(sql).toContain("tg_op = 'UPDATE'");
    expect(sql).toContain('new.actor_name_snapshot is not null');
  });

  it('on UPDATE preserves existing snapshots (except item_availability)', () => {
    expect(sql).toContain("tg_table_name <> 'item_availability'");
  });

  it('item_availability always re-snapshots on UPDATE (tracks current actor)', () => {
    expect(sql).toContain("tg_table_name <> 'item_availability'");
  });

  it('skips actor_role_snapshot for audit_logs (uses actor_role column)', () => {
    expect(sql).toContain("tg_table_name <> 'audit_logs'");
    expect(sql).toContain('new.actor_role_snapshot');
  });

  it('populates all required snapshot fields', () => {
    expect(sql).toContain('new.actor_identity_version');
    expect(sql).toContain('new.actor_name_snapshot');
    expect(sql).toContain('new.actor_email_snapshot');
    expect(sql).toContain('new.actor_org_snapshot');
    expect(sql).toContain('new.actor_role_snapshot');
  });

  const TABLES_WITH_TRIGGERS = [
    'audit_logs',
    'institution_item_status_reports',
    'item_availability',
    'qr_tokens',
    'organization_status_contacts',
    'profile_permission_overrides',
  ];

  TABLES_WITH_TRIGGERS.forEach(table => {
    it(`creates trg_actor_snapshot trigger on ${table}`, () => {
      const pattern = new RegExp(
        `create trigger trg_actor_snapshot\\s+before insert or update on public\\.${table}`,
        'i',
      );
      expect(sql).toMatch(pattern);
    });
  });

  it('uses DROP TRIGGER IF EXISTS for idempotent re-run', () => {
    const dropCount = (sql.match(/drop trigger if exists trg_actor_snapshot/gi) ?? []).length;
    expect(dropCount).toBe(6);
  });

  it('includes a verification block that checks all 6 triggers', () => {
    expect(sql).toContain('assert v_count = 6');
    expect(sql).toContain('trg_actor_snapshot');
  });

  it('does not implement recycling', () => {
    expect(sql.toLowerCase()).toContain('does not implement');
    expect(sql.toLowerCase()).toContain('recycl');
  });

  it('does not modify existing RPCs or applied migrations', () => {
    expect(sql).not.toContain('create_qr_for_target');
    expect(sql).not.toContain('disable_qr_token');
    expect(sql).not.toContain('archive_entity');
    expect(sql).not.toContain('purge_entity_with_all_data');
    expect(sql).not.toContain('assign_profile_role');
    expect(sql).not.toContain('clear_port_availability');
  });

  it('does not reference service_role', () => {
    expect(sql).not.toContain('service_role');
    expect(sql).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('does not modify auth.users', () => {
    expect(sql).not.toMatch(/\b(insert|update|delete)\b.*auth\.users/i);
  });
});

// ============================================================================
// 21. ACTOR SNAPSHOT WRITE PATHS: anti-spoofing
// ============================================================================

describe('Actor snapshot anti-spoofing: frontend services never pass snapshot fields', () => {
  const SNAPSHOT_FIELDS = [
    'actor_name_snapshot',
    'actor_email_snapshot',
    'actor_role_snapshot',
    'actor_org_snapshot',
    'actor_identity_version',
  ];

  const WRITE_SERVICES = [
    'shared/supabase/services/audit.service.ts',
    'shared/supabase/services/status-reports.service.ts',
  ];

  WRITE_SERVICES.forEach(svc => {
    const content = readSrc(svc);
    SNAPSHOT_FIELDS.forEach(field => {
      it(`${svc} does not pass ${field}`, () => {
        expect(content).not.toContain(field);
      });
    });
  });

  // AVAILABILITY-MOVEMENT-HISTORY-VIEW-A: availability.service.ts legitimately
  // READS actor_name_snapshot/actor_email_snapshot/actor_role_snapshot via
  // getAvailabilityMovementsByItem() — a plain SELECT against
  // item_availability_movements (migration 033), purely for read-only display
  // in the movement history view. This is NOT the anti-spoofing concern this
  // suite guards against (a client WRITING/spoofing these fields into an
  // insert/rpc payload to forge actor identity) — those write paths
  // (upsertAvailability, applyAvailabilityMovement) never reference these
  // fields at all. The check below asserts the snapshot fields appear only
  // inside the read-only SELECT/interface/mapping, never as an insert/rpc
  // parameter key (e.g. `p_actor_name_snapshot:` or `actor_name_snapshot:`
  // used as an outbound argument name).
  it('shared/supabase/services/availability.service.ts only READS snapshot fields (SELECT projection), never writes them', () => {
    const content = readSrc('shared/supabase/services/availability.service.ts');
    SNAPSHOT_FIELDS.slice(0, 3).forEach(field => {
      // present (read/display use), but never as an outbound rpc/insert argument
      expect(content).not.toMatch(new RegExp(`p_${field}\\s*:`));
    });
    expect(content).not.toMatch(/\.insert\([^)]*actor_(name|email|role)_snapshot/s);
    expect(content).not.toMatch(/\.rpc\([^)]*actor_(name|email|role)_snapshot/s);
    expect(content).not.toContain('actor_org_snapshot');
    expect(content).not.toContain('actor_identity_version');
  });

  // ALERT-LIFECYCLE-RPC-A: features/alerts/inter-org-alert-lifecycle.service.ts
  // legitimately READS actor_name_snapshot/actor_email_snapshot/
  // actor_role_snapshot via getInterOrgAlertEvents() — a supabase.rpc() call
  // to phoenix_get_inter_org_alert_events (migration 039), which itself reads
  // inter_org_alert_events (migration 038) and returns these fields purely
  // for read-only event-history display. Same carve-out reasoning as
  // availability.service.ts above: the anti-spoofing concern is a client
  // WRITING these fields into an insert/rpc payload to forge actor identity;
  // this service never does that — every RPC call it makes
  // (phoenix_get_live_inter_institution_alerts_with_state,
  // phoenix_update_inter_org_alert_state, phoenix_reopen_inter_org_alert,
  // phoenix_get_inter_org_alert_events) sends only alert_key/status/reason/
  // notes/limit as arguments, never any actor_*_snapshot field.
  it('features/alerts/inter-org-alert-lifecycle.service.ts only READS snapshot fields (RPC response mapping), never writes them', () => {
    const content = readSrc('features/alerts/inter-org-alert-lifecycle.service.ts');
    SNAPSHOT_FIELDS.slice(0, 3).forEach(field => {
      // present (read/display use), but never as an outbound rpc argument
      expect(content).not.toMatch(new RegExp(`p_${field}\\s*:`));
    });
    expect(content).not.toMatch(/\.rpc\('phoenix_update_inter_org_alert_state'[^)]*actor_(name|email|role)_snapshot/s);
    expect(content).not.toMatch(/\.rpc\('phoenix_reopen_inter_org_alert'[^)]*actor_(name|email|role)_snapshot/s);
    expect(content).not.toContain('actor_org_snapshot');
    expect(content).not.toContain('actor_identity_version');
  });

  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: StatusCenterScreen.tsx now reads
  // actor_name_snapshot (already selected read-only by availability.service.ts's
  // getAvailabilityByOrg, exempted above) purely to display a "Last Updated
  // By" name in its live table and Excel export — never as an outbound
  // rpc/insert argument. Same carve-out reasoning as the two dedicated tests
  // above.
  it('features/status/StatusCenterScreen.tsx only READS actor_name_snapshot (display use), never writes it', () => {
    const content = readSrc('features/status/StatusCenterScreen.tsx');
    expect(content).not.toMatch(/p_actor_name_snapshot\s*:/);
    expect(content).not.toMatch(/\.insert\([^)]*actor_name_snapshot/s);
    expect(content).not.toMatch(/\.rpc\([^)]*actor_name_snapshot/s);
    expect(content).not.toContain('actor_email_snapshot');
    expect(content).not.toContain('actor_role_snapshot');
    expect(content).not.toContain('actor_org_snapshot');
    expect(content).not.toContain('actor_identity_version');
  });

  it('no frontend .ts file outside __tests__ passes snapshot fields to supabase, except the documented read-only movement history / alert event history queries', () => {
    const files = allTsxFiles('')
      .filter(path => !path.endsWith(join('services', 'availability.service.ts')))
      .filter(path => !path.endsWith(join('alerts', 'inter-org-alert-lifecycle.service.ts')))
      .filter(path => !path.endsWith(join('status', 'StatusCenterScreen.tsx')))
      // PHASE2-STATUS-CENTER-OUTLET-REPORT-MODAL-A: the outlet report modal
      // reads r.actor_name_snapshot from the SAME already-fetched rows
      // StatusCenterScreen.tsx passes it (getAvailabilityByOrg's existing
      // read), purely to display "Last Updated By" in the export/print — it
      // never queries Supabase itself and never passes the field back to any
      // write call.
      .filter(path => !path.endsWith(join('status', 'OutletAvailabilityReportModal.tsx')));
    files.forEach(path => {
      const content = readFile(path);
      SNAPSHOT_FIELDS.forEach(field => {
        expect(content).not.toContain(field);
      });
    });
  });
});

// ============================================================================
// 22. ACTOR SNAPSHOT WRITE PATHS: coverage completeness
// ============================================================================

describe('Actor snapshot coverage: all operational tables have triggers', () => {
  const sql = readSql('migrations/014_phoenix_actor_snapshot_write_path_triggers.sql');

  const OPERATIONAL_TABLES = [
    'audit_logs',
    'institution_item_status_reports',
    'item_availability',
    'qr_tokens',
    'organization_status_contacts',
    'profile_permission_overrides',
  ];

  OPERATIONAL_TABLES.forEach(table => {
    it(`${table} has a BEFORE INSERT OR UPDATE trigger`, () => {
      expect(sql).toContain(`on public.${table}`);
    });
  });

  it('trigger function is SECURITY DEFINER (required for auth.users join)', () => {
    expect(sql).toContain('security definer');
  });

  it('trigger function sets search_path (prevents search_path injection)', () => {
    expect(sql).toContain('set search_path = public, pg_temp');
  });
});

// ============================================================================
// 23. RECYCLING, HARD DELETE, DATA RESET: still not implemented
// ============================================================================

describe('Post-014 guardrails: hard delete still absent, recycling properly guarded', () => {
  const screen  = readSrc('features/users/UserManagementScreen.tsx');
  const userSvc = readSrc('shared/supabase/services/users.service.ts');

  it('recycling is properly guarded by permission and suspension check', () => {
    expect(screen).toContain('canRecycle');
    expect(screen).toContain("u.status === 'suspended'");
  });

  it('hard delete button is not rendered', () => {
    expect(screen).not.toContain('deleteTarget');
    expect(screen).not.toContain('um_delete_user_action');
  });

  it('deleteUserViaEdge exists in service but is NOT imported in screen', () => {
    expect(userSvc).toContain('deleteUserViaEdge');
    expect(screen).not.toMatch(/import[^;]*deleteUserViaEdge/);
  });
});

describe('Post-014 guardrails: Data Reset and Intake still disabled', () => {
  const files = allTsxFiles('');

  it('no DataReset import anywhere in src', () => {
    files.forEach(path => {
      expect(readFile(path)).not.toMatch(/import.*DataReset/i);
    });
  });

  it('no OcrImport, ExcelImport, DocIntel import anywhere in src', () => {
    files.forEach(path => {
      const content = readFile(path);
      expect(content).not.toMatch(/import.*OcrImport/i);
      expect(content).not.toMatch(/import.*ExcelImport/i);
      expect(content).not.toMatch(/import.*DocIntel/i);
    });
  });
});

describe('Post-014 guardrails: service_role and auth.admin absent from frontend', () => {
  const files = allTsxFiles('');

  it('no service_role in any frontend .ts/.tsx file', () => {
    files.forEach(path => {
      expect(readFile(path)).not.toContain('service_role');
    });
  });

  it('no auth.admin in any frontend .ts/.tsx file', () => {
    files.forEach(path => {
      expect(readFile(path)).not.toMatch(/auth\.admin/);
    });
  });
});

// ============================================================================
// 24. RECYCLING AUDIT: snapshot plan documents recycling readiness
// ============================================================================

describe('Recycling audit: snapshot plan updated for recycling readiness', () => {
  const plan = readPhoenix('docs/user-identity-snapshot-plan.md');

  it('marks write paths as wired (migrations 013 + 014 applied)', () => {
    expect(plan).toContain('Write paths wired');
    expect(plan).toContain('migrations 013 + 014 applied');
  });

  it('documents ACTOR-SNAPSHOT-WRITE-PATHS-A as completed', () => {
    expect(plan).toContain('ACTOR-SNAPSHOT-WRITE-PATHS-A');
  });

  it('documents USER-ACCOUNT-RECYCLING-AUDIT-A as current phase', () => {
    expect(plan).toContain('USER-ACCOUNT-RECYCLING-AUDIT-A');
  });

  it('identifies USER-ACCOUNT-RECYCLING-A as next phase', () => {
    expect(plan).toContain('USER-ACCOUNT-RECYCLING-A');
  });

  it('documents the required Edge Function admin-recycle-user', () => {
    expect(plan).toContain('admin-recycle-user');
  });

  it('documents the required users.recycle permission key', () => {
    expect(plan).toContain('users.recycle');
  });

  it('documents required confirmation phrase format', () => {
    expect(plan).toContain('RECYCLE_USER_');
  });

  it('documents required audit log event: account_recycled', () => {
    expect(plan).toContain('account_recycled');
  });

  it('documents no self-recycling rule', () => {
    expect(plan.toLowerCase()).toContain('no self-recycling');
  });

  it('documents no recycling super_admin rule', () => {
    expect(plan.toLowerCase()).toContain('no recycling');
    expect(plan).toContain('super_admin');
  });

  it('documents target must be suspended before recycling', () => {
    expect(plan).toContain('suspended');
  });

  it('documents atomic transaction requirement', () => {
    expect(plan.toLowerCase()).toContain('transaction');
  });

  it('documents rollback on failure', () => {
    expect(plan.toLowerCase()).toContain('rollback');
  });

  it('documents UI label in Arabic and English', () => {
    expect(plan).toContain('تدوير الحساب');
    expect(plan).toContain('Recycle Account');
  });

  it('documents the old-operations warning in Arabic and English', () => {
    expect(plan).toContain('ستبقى العمليات القديمة');
    expect(plan).toContain('Old operations remain attributed');
  });
});

// ============================================================================
// 25. RECYCLING IMPLEMENTATION: users.recycle permission and service
// ============================================================================

describe('Recycling implementation: permission catalog and service', () => {
  it('users.recycle permission exists in the TypeScript catalog', () => {
    const perms = readSrc('shared/lib/permissions.ts');
    expect(perms).toContain("'users.recycle'");
    expect(perms).toContain('perm_users_recycle');
  });

  it('super_admin default includes users.recycle (ALL_KEYS)', () => {
    const perms = readSrc('shared/lib/permissions.ts');
    expect(perms).toContain("super_admin:            ALL_KEYS");
  });

  it('institution_admin default does NOT include users.recycle', () => {
    const perms = readSrc('shared/lib/permissions.ts');
    expect(perms).not.toMatch(/INSTITUTION_ADMIN_DEFAULTS[^]*users\.recycle/);
  });

  it('recycleUserViaEdge exists in users.service.ts', () => {
    const svc = readSrc('shared/supabase/services/users.service.ts');
    expect(svc).toContain('recycleUserViaEdge');
    expect(svc).toContain("'admin-recycle-user'");
  });

  it('recycleUserViaEdge input type does not include password field', () => {
    const svc = readSrc('shared/supabase/services/users.service.ts');
    const inputType = svc.slice(svc.indexOf('RecycleUserInput'), svc.indexOf('RecycleUserResult'));
    expect(inputType).not.toMatch(/\bpassword\b.*:/);
  });

  it('recycleUserViaEdge does not send actor snapshot fields', () => {
    const svc = readSrc('shared/supabase/services/users.service.ts');
    const recycleBlock = svc.slice(svc.indexOf('recycleUserViaEdge'));
    expect(recycleBlock).not.toContain('actor_name_snapshot');
    expect(recycleBlock).not.toContain('actor_email_snapshot');
  });

  it('recycleUserViaEdge does not call auth.admin', () => {
    const svc = readSrc('shared/supabase/services/users.service.ts');
    expect(svc).not.toContain('auth.admin');
  });

  it('recycleUserViaEdge does not update auth email directly', () => {
    const svc = readSrc('shared/supabase/services/users.service.ts');
    expect(svc).not.toContain('updateUserById');
  });
});

// ============================================================================
// 26. RECYCLING IMPLEMENTATION: Edge Function safety
// ============================================================================

describe('Recycling implementation: admin-recycle-user Edge Function', () => {
  const fn = readPhoenix('supabase/functions/admin-recycle-user/index.ts');

  it('Edge Function file exists', () => {
    expect(fn.length).toBeGreaterThan(500);
  });

  it('reads service key only from Deno.env', () => {
    expect(fn).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
  });

  it('service key value is never in a json response body', () => {
    const lines = fn.split('\n');
    const leaks = lines.filter(l => l.includes('json(') && l.includes('SUPABASE_SERVICE_ROLE_KEY'));
    expect(leaks.length).toBe(0);
  });

  it('validates caller authentication', () => {
    expect(fn).toContain('NOT_AUTHENTICATED');
  });

  it('checks users.recycle permission', () => {
    expect(fn).toContain("'users.recycle'");
    expect(fn).toContain('phoenix_profile_has_permission');
  });

  it('blocks self-recycling', () => {
    expect(fn).toContain('SELF_ACTION_FORBIDDEN');
  });

  it('blocks recycling super_admin', () => {
    expect(fn).toContain('CANNOT_RECYCLE_SUPER_ADMIN');
  });

  it('requires target to be suspended', () => {
    expect(fn).toContain('TARGET_NOT_SUSPENDED');
    expect(fn).toContain("'suspended'");
  });

  it('requires confirmation phrase RECYCLE_USER_<id>', () => {
    expect(fn).toContain('RECYCLE_USER_');
    expect(fn).toContain('INVALID_CONFIRMATION');
  });

  it('institution_admin cannot recycle outside own org', () => {
    expect(fn).toContain('CROSS_ORG_FORBIDDEN');
  });

  it('institution_admin cannot assign elevated roles', () => {
    expect(fn).toContain('CANNOT_ASSIGN_ELEVATED_ROLE');
  });

  it('increments identity_version', () => {
    expect(fn).toContain('identity_version');
    expect(fn).toContain('newVersion');
  });

  it('closes old identity in user_identity_history', () => {
    expect(fn).toContain('user_identity_history');
    expect(fn).toContain('valid_until');
  });

  it('inserts new identity history row with change_reason', () => {
    expect(fn).toContain("'account_recycled'");
    expect(fn).toContain('recycled_by');
  });

  it('updates auth email server-side only', () => {
    expect(fn).toContain('updateUserById');
    expect(fn).toContain('email_confirm');
  });

  it('unbans the auth user after DB changes', () => {
    expect(fn).toContain("ban_duration: 'none'");
  });

  it('generates recovery link (best-effort) and reports honest status', () => {
    expect(fn).toContain('generateLink');
    expect(fn).toContain('recovery');
    expect(fn).toContain('passwordSetupStatus');
    expect(fn).toContain("'link_generated'");
    expect(fn).toContain("'link_failed'");
  });

  it('does not claim email was sent (no password_setup_sent: true)', () => {
    expect(fn).not.toContain('password_setup_sent');
  });

  it('does not return the generated recovery link', () => {
    const returnBlock = fn.slice(fn.lastIndexOf('return json('));
    expect(returnBlock).not.toMatch(/action_link|link_url|recovery_link/);
  });

  it('does not log the generated recovery link', () => {
    expect(fn).not.toMatch(/console\.(log|info|warn).*link/i);
  });

  it('writes audit log with old and new identity', () => {
    expect(fn).toContain("'user.account_recycled'");
    expect(fn).toContain('old_full_name');
    expect(fn).toContain('new_full_name');
    expect(fn).toContain('old_identity_version');
    expect(fn).toContain('new_identity_version');
  });

  it('never accepts password in request', () => {
    expect(fn).not.toMatch(/body\.password|password.*body/);
  });

  it('never returns password', () => {
    const responses = fn.split('\n').filter(l => l.includes('json({') || l.includes('json('));
    responses.forEach(r => expect(r).not.toContain('password'));
  });

  it('documents partial-failure behavior', () => {
    expect(fn).toContain('PARTIAL FAILURE');
  });
});

// ============================================================================
// 27. RECYCLING IMPLEMENTATION: UI and i18n
// ============================================================================

describe('Recycling implementation: UI and i18n', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  const strings = readSrc('shared/i18n/strings.ts');

  it('recycle button exists for suspended users', () => {
    expect(screen).toContain('um_recycle_account');
    expect(screen).toContain('recycleTarget');
  });

  it('recycle button is gated by canRecycle permission', () => {
    expect(screen).toContain('canRecycle');
    expect(screen).toContain("users.recycle");
  });

  it('recycle button hidden for super_admin targets', () => {
    expect(screen).toContain("normalizeRole(u.role) !== 'super_admin'");
  });

  it('recycle modal requires confirmation phrase RECYCLE_USER_', () => {
    expect(screen).toContain('RECYCLE_USER_');
  });

  it('recycle modal calls recycleUserViaEdge', () => {
    expect(screen).toContain('recycleUserViaEdge');
  });

  it('i18n has Arabic recycle strings', () => {
    expect(strings).toContain('تدوير الحساب');
    expect(strings).toContain('الاسم الجديد');
    expect(strings).toContain('البريد الإلكتروني الجديد');
  });

  it('i18n has English recycle strings', () => {
    expect(strings).toContain('Recycle Account');
    expect(strings).toContain('New full name');
    expect(strings).toContain('New email');
  });

  it('i18n has recycle warning in Arabic and English', () => {
    expect(strings).toContain('ستبقى العمليات القديمة');
    expect(strings).toContain('Old operations remain attributed');
  });

  it('i18n has perm_users_recycle label', () => {
    expect(strings).toContain('perm_users_recycle');
    expect(strings).toContain('تدوير الحسابات');
  });

  it('UI never claims an email was sent for the (now local-only) recycle success message', () => {
    expect(screen).toContain('um_recycle_success_local');
    expect(screen).not.toContain('passwordSetupSent');
  });

  it('i18n success message does not claim email was sent', () => {
    expect(strings).not.toContain('um_recycle_password_sent');
    expect(strings).toContain('um_recycle_link_failed');
    expect(strings).toContain('إذا لم يصله بريد');
    expect(strings).toContain('If no email arrives');
  });

  it('service result type uses passwordSetupStatus not passwordSetupSent', () => {
    const svc = readSrc('shared/supabase/services/users.service.ts');
    expect(svc).toContain('passwordSetupStatus');
    expect(svc).not.toContain('passwordSetupSent');
  });
});

// ============================================================================
// 28. RECYCLING IMPLEMENTATION: migration 015
// ============================================================================

describe('Recycling implementation: migration 015', () => {
  const sql = readSql('migrations/015_phoenix_user_account_recycling.sql');

  it('file exists and is non-empty', () => {
    expect(sql.length).toBeGreaterThan(100);
  });

  it('is manual-apply-only', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('DO NOT use');
  });

  it('has no DROP or TRUNCATE', () => {
    expect(sql).not.toMatch(/^\s*(drop table|drop function|truncate)\b/im);
  });

  it('adds users.recycle permission key', () => {
    expect(sql).toContain("'users.recycle'");
    expect(sql).toContain('permission_keys');
  });

  it('seeds super_admin default as allowed', () => {
    expect(sql).toContain("'super_admin'");
    expect(sql).toContain('role_permission_defaults');
  });

  it('uses ON CONFLICT DO NOTHING for idempotency', () => {
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('DO NOTHING');
  });

  it('has a verification block', () => {
    expect(sql).toContain('assert');
    expect(sql).toContain("'users.recycle'");
  });

  it('does not implement recycling logic', () => {
    expect(sql.toLowerCase()).toContain('does not implement');
  });

  it('does not reference elevated service keys', () => {
    expect(sql).not.toContain('service_role');
    expect(sql).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});

// ============================================================================
// 29. POST-RECYCLING: hard delete still hidden, data reset absent
// ============================================================================

describe('Post-recycling guardrails', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');

  it('hard delete button still not rendered', () => {
    expect(screen).not.toContain('deleteTarget');
    expect(screen).not.toContain('um_delete_user_action');
  });

  it('deleteUserViaEdge is NOT imported in the screen', () => {
    expect(screen).not.toMatch(/import[^;]*deleteUserViaEdge/);
  });

  it('Data Reset absent', () => {
    const files = allTsxFiles('');
    files.forEach(path => {
      expect(readFile(path)).not.toMatch(/import.*DataReset/i);
    });
  });

  it('Intake disabled (OCR/Excel/DocIntel)', () => {
    const files = allTsxFiles('');
    files.forEach(path => {
      const content = readFile(path);
      expect(content).not.toMatch(/import.*OcrImport/i);
      expect(content).not.toMatch(/import.*ExcelImport/i);
      expect(content).not.toMatch(/import.*DocIntel/i);
    });
  });

  it('no service_role in any frontend file', () => {
    const files = allTsxFiles('');
    files.forEach(path => {
      expect(readFile(path)).not.toContain('service_role');
    });
  });

  it('no auth.admin in any frontend file', () => {
    const files = allTsxFiles('');
    files.forEach(path => {
      expect(readFile(path)).not.toMatch(/auth\.admin/);
    });
  });
});

// ============================================================================
// 30. MY ACCOUNT: route, labels, password management
// ============================================================================

describe('My Account: route and UI', () => {
  const app = readSrc('app/App.tsx');
  const shell = readSrc('shared/ui/PhoenixAppShell.tsx');
  const sidebar = readSrc('shared/ui/PhoenixSidebar.tsx');
  const strings = readSrc('shared/i18n/strings.ts');

  it('MyAccountScreen is imported and wired to screen 15', () => {
    expect(app).toContain('MyAccountScreen');
    expect(app).toContain('case 15');
  });

  it('screen 15 title key is registered in PhoenixAppShell', () => {
    expect(shell).toContain("15: 'nav_my_account'");
  });

  it('My Account appears in sidebar navigation', () => {
    expect(sidebar).toContain("screen: 15");
    expect(sidebar).toContain("'nav_my_account'");
  });

  it('i18n has Arabic and English labels for My Account', () => {
    expect(strings).toContain('حسابي');
    expect(strings).toContain('My Account');
    expect(strings).toContain('ma_title');
    expect(strings).toContain('ma_info');
  });
});

describe('My Account: password management safety', () => {
  const screen = readSrc('features/account/MyAccountScreen.tsx');
  const auth   = readSrc('shared/supabase/services/auth.service.ts');

  it('MyAccountScreen file exists', () => {
    expect(screen.length).toBeGreaterThan(200);
  });

  it('uses requestPasswordReset for email-based reset (anon key only)', () => {
    expect(auth).toContain('resetPasswordForEmail');
    expect(auth).not.toContain('admin.');
  });

  it('uses updateUser for direct password change (session key only)', () => {
    expect(auth).toContain("supabase.auth.updateUser({ password:");
  });

  it('reset uses current user email only — no email input field', () => {
    expect(screen).not.toMatch(/type="email"/);
    expect(screen).toContain("session?.user?.email");
  });

  it('password form validates minimum 8 characters', () => {
    expect(screen).toContain('newPw.length >= 8');
  });

  it('password form validates matching confirmation', () => {
    expect(screen).toContain('newPw === confirmPw');
  });

  it('no path to change another user password', () => {
    expect(screen).not.toContain('targetUserId');
    expect(screen).not.toContain('target_user_id');
  });

  it('does not use service_role or auth.admin', () => {
    expect(screen).not.toContain('service_role');
    expect(screen).not.toMatch(/auth\.admin/);
  });

  it('password is not stored in profiles', () => {
    expect(screen).not.toMatch(/from\(['"]profiles['"]\).*password/);
  });

  it('has bilingual password labels', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toContain('تغيير كلمة المرور');
    expect(strings).toContain('Change password');
    expect(strings).toContain('كلمة المرور الجديدة');
    expect(strings).toContain('New password');
  });

  it('reset success message is honest about email delivery', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toContain('إذا كانت إعدادات البريد مفعّلة');
    expect(strings).toContain('if email delivery is configured');
  });

  it('security note warns against changing other users passwords', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toContain('لا يمكن تغيير كلمة مرور مستخدم آخر');
    expect(strings).toContain("You cannot change another user\\'s password");
  });
});

// ============================================================================
// 31. PASSWORD RECOVERY: standalone session handling
// ============================================================================

describe('Password recovery hardening', () => {
  const ctx    = readSrc('app/AppContext.tsx');
  const reset  = readSrc('features/auth/ResetPasswordScreen.tsx');
  const auth   = readSrc('shared/supabase/services/auth.service.ts');
  const strings = readSrc('shared/i18n/strings.ts');

  it('ResetPasswordScreen is self-contained — does not use useApp for session/updatePassword', () => {
    expect(reset).not.toContain("useApp().session");
    expect(reset).not.toContain("useApp().updatePassword");
    expect(reset).toContain('authUpdatePassword');
    expect(reset).toContain('getSession');
  });

  it('ResetPasswordScreen explicitly calls exchangeCodeForSession for PKCE codes', () => {
    expect(reset).toContain('exchangeCodeForSession');
    expect(reset).toContain("params.get('code')");
  });

  it('ResetPasswordScreen handles hash-based implicit tokens', () => {
    expect(reset).toContain('setSessionFromTokens');
    expect(reset).toContain('access_token');
    expect(reset).toContain('refresh_token');
  });

  it('ResetPasswordScreen cleans URL after session exchange', () => {
    expect(reset).toContain("window.history.replaceState");
  });

  it('ResetPasswordScreen has loading/ready/no_session/done states', () => {
    expect(reset).toContain("'loading'");
    expect(reset).toContain("'ready'");
    expect(reset).toContain("'no_session'");
    expect(reset).toContain("'done'");
  });

  it('ResetPasswordScreen re-checks session right before updatePassword call', () => {
    expect(reset).toContain('await getSession()');
    expect(reset).toContain('recovery_no_session');
  });

  it('ResetPasswordScreen does not use generic load_error', () => {
    expect(reset).not.toContain('load_error');
  });

  it('ResetPasswordScreen uses specific recovery error messages', () => {
    expect(reset).toContain('recovery_failed');
    expect(reset).toContain('recovery_link_expired');
    expect(reset).toContain('recovery_no_session');
  });

  it('auth.service exports exchangeCodeForSession and setSessionFromTokens', () => {
    expect(auth).toContain('exchangeCodeForSession');
    expect(auth).toContain('setSessionFromTokens');
    expect(auth).toContain('supabase.auth.exchangeCodeForSession');
    expect(auth).toContain('supabase.auth.setSession');
  });

  it('AppContext skips profile loading during recovery', () => {
    expect(ctx).toContain('passwordRecoveryRef');
    expect(ctx).toContain('Skip profile loading during recovery');
  });

  it('AppContext seeds passwordRecovery from /auth/callback URL', () => {
    expect(ctx).toContain("'/auth/callback'");
    expect(ctx).toContain("type=recovery");
  });

  it('i18n has bilingual recovery messages', () => {
    expect(strings).toContain('recovery_verifying');
    expect(strings).toContain('recovery_no_session');
    expect(strings).toContain('recovery_link_expired');
    expect(strings).toContain('recovery_failed');
    expect(strings).toContain('تعذر تأكيد رابط إعادة التعيين');
    expect(strings).toContain('Could not verify the reset link');
  });

  it('ResetPasswordScreen does not log tokens or passwords', () => {
    expect(reset).not.toMatch(/console\.(log|info|warn)/);
  });

  it('no service_role in recovery flow', () => {
    expect(reset).not.toContain('service_role');
  });

  it('no auth.admin in recovery flow', () => {
    expect(reset).not.toMatch(/auth\.admin/);
  });

  it('no profile loading dependency in ResetPasswordScreen', () => {
    expect(reset).not.toContain('getMyProfile');
    expect(reset).not.toContain('loadProfile');
    expect(reset).not.toContain("from('profiles')");
  });
});

// ============================================================================
// 32. MIGRATION 027: PUBLIC AVAILABILITY PRIVACY HARDENING
// ============================================================================

describe('Migration 027: public availability privacy hardening', () => {
  const sql = readSql('migrations/027_phoenix_public_availability_privacy_hardening.sql');

  it('file exists and is non-empty', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('is manual-apply-only', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('DO NOT use');
    expect(sql).toContain('supabase db push');
  });

  it('has no DROP TABLE, TRUNCATE, or destructive operations', () => {
    expect(sql).not.toMatch(/^\s*(drop table|truncate)\b/im);
    expect(sql).not.toMatch(/delete from\s+(organizations|profiles|warehouses|distribution_points|qr_tokens|audit_logs)/im);
  });

  it('does not expose service_role', () => {
    expect(sql).not.toContain('service_role');
  });

  it('does not grant anon write access', () => {
    expect(sql).not.toMatch(/grant.*(insert|update|delete).*to anon/i);
  });

  it('does not weaken authenticated RLS policies', () => {
    expect(sql).not.toMatch(/drop policy.*avail_select_org/i);
    expect(sql).not.toMatch(/drop policy.*avail_write/i);
  });

  // D1: avail_select_anon restricted to using (false)
  it('D1: drops the old avail_select_anon policy', () => {
    expect(sql).toContain('drop policy if exists "avail_select_anon" on item_availability');
  });

  it('D1: re-creates avail_select_anon with using (false)', () => {
    expect(sql).toContain('create policy "avail_select_anon" on item_availability');
    expect(sql).toContain('for select to anon');
    expect(sql).toContain('using (false)');
  });

  it('D1: comment explains why anon must use the RPC not direct table access', () => {
    expect(sql).toMatch(/SECURITY DEFINER|security definer/);
    expect(sql).toContain('get_public_qr_payload');
  });

  // D2: null quantity for expired items in RPC
  it('D2: RPC nulls quantity for expired items', () => {
    expect(sql).toMatch(/condition = 'expired' then null/);
  });

  it('D2: D2 fix appears in all target-type branches (distribution_point + local_item)', () => {
    const dpIdx   = sql.indexOf("when 'distribution_point'");
    const liIdx   = sql.indexOf("when 'local_item'");
    const d2DP    = sql.indexOf("condition = 'expired' then null", dpIdx);
    const d2LI    = sql.indexOf("condition = 'expired' then null", liIdx);
    expect(d2DP).toBeGreaterThan(dpIdx);
    expect(d2LI).toBeGreaterThan(liIdx);
  });

  // D3: expiry_date only for near_expiry / expired
  it('D3: RPC guards expiry_date to near_expiry/expired conditions only', () => {
    expect(sql).toMatch(/condition in \('near_expiry', 'expired'\) then ia\.expiry_date/);
  });

  it('D3: D3 fix appears in distribution_point branch before local_item branch', () => {
    const dpIdx = sql.indexOf("when 'distribution_point'");
    const liIdx = sql.indexOf("when 'local_item'");
    const d3DP  = sql.indexOf("near_expiry', 'expired') then ia.expiry_date", dpIdx);
    const d3LI  = sql.indexOf("near_expiry', 'expired') then ia.expiry_date", liIdx);
    expect(d3DP).toBeGreaterThan(dpIdx);
    expect(d3LI).toBeGreaterThan(liIdx);
  });

  // D4: distribution_point status guard
  it('D4: RPC checks distribution point is active before serving payload', () => {
    expect(sql).toContain('DISTRIBUTION_POINT_NOT_ACTIVE');
  });

  it('D4: status check appears in distribution_point branch of RPC', () => {
    const dpBranchStart = sql.indexOf("when 'distribution_point'");
    const dpGuard       = sql.indexOf('DISTRIBUTION_POINT_NOT_ACTIVE', dpBranchStart);
    const whBranchStart = sql.indexOf("when 'warehouse'");
    expect(dpGuard).toBeGreaterThan(dpBranchStart);
    expect(dpGuard).toBeLessThan(whBranchStart);
  });

  // Grants: unchanged from migration 003
  it('grants get_public_qr_payload to anon and authenticated (unchanged)', () => {
    expect(sql).toContain('grant execute on function get_public_qr_payload');
    expect(sql).toContain('to anon, authenticated');
  });

  it('revokes from authenticated before re-granting (idempotent grant pattern)', () => {
    expect(sql).toContain('revoke all on function get_public_qr_payload(text) from authenticated');
  });

  // Verify block
  it('includes a VERIFY block with assert statements', () => {
    expect(sql).toContain('assert v_policy_qual');
    expect(sql).toContain('assert v_fn_exists');
    expect(sql).toContain('assert v_fn_def');
  });

  it('verify block checks for DISTRIBUTION_POINT_NOT_ACTIVE marker', () => {
    expect(sql).toContain("ilike '%DISTRIBUTION_POINT_NOT_ACTIVE%'");
  });

  it('verify block checks avail_select_anon qual = false', () => {
    expect(sql).toContain("v_policy_qual = 'false'");
  });

  it('has the MEDISTOCK_PHOENIX_PUBLIC_QR_PRIVACY_V1 marker', () => {
    expect(sql).toContain('MEDISTOCK_PHOENIX_PUBLIC_QR_PRIVACY_V1');
  });
});

describe('Migration 027: public QR service still uses only RPC (no raw table queries)', () => {
  const qr = readSrc('shared/supabase/services/qr.service.ts');

  it('getPublicQrPayload calls only the RPC, not .from(item_availability)', () => {
    expect(qr).toContain("rpc('get_public_qr_payload'");
    expect(qr).not.toMatch(/from\(['"]item_availability['"]\)/);
  });

  it('PublicQrScreen imports only getPublicQrPayload (no direct table access)', () => {
    const screen = readSrc('features/qr/PublicQrScreen.tsx');
    expect(screen).toContain('getPublicQrPayload');
    expect(screen).not.toMatch(/from\(['"]item_availability['"]\)/);
    expect(screen).not.toMatch(/from\(['"]qr_tokens['"]\)/);
  });
});

describe('Migration 027: privacy label is now DB-enforced, not just UI-only', () => {
  it('migration 027 restricts batch_number exposure at DB level (avail_select_anon false)', () => {
    const sql = readSql('migrations/027_phoenix_public_availability_privacy_hardening.sql');
    expect(sql).toContain('using (false)');
    // The privacy label "no batch data exposure" is now enforced: anon cannot
    // directly query item_availability, so batch_number, price, notes are
    // inaccessible without going through the curated RPC.
    expect(sql).toMatch(/batch_number|actor_name_snapshot|price/i);
  });

  it('RPC (migration 003) does not return batch_number, price, trade_name, notes', () => {
    const sql = readSql('migrations/003_phoenix_rpc_lifecycle.sql');
    // Within the distribution_point items aggregation, confirm sensitive fields absent
    const dpStart = sql.indexOf("when 'distribution_point'");
    const dpEnd   = sql.indexOf("when 'warehouse'", dpStart);
    const dpBlock = sql.slice(dpStart, dpEnd);
    expect(dpBlock).not.toContain("'batch_number'");
    expect(dpBlock).not.toContain("'price'");
    expect(dpBlock).not.toContain("'trade_name'");
    expect(dpBlock).not.toContain("'notes'");
    expect(dpBlock).not.toContain("'supply_type'");
  });

  it('migration 027 RPC also does not add batch_number, price, trade_name, notes', () => {
    const sql = readSql('migrations/027_phoenix_public_availability_privacy_hardening.sql');
    const dpStart = sql.indexOf("when 'distribution_point'");
    const dpEnd   = sql.indexOf("when 'warehouse'", dpStart);
    const dpBlock = sql.slice(dpStart, dpEnd);
    expect(dpBlock).not.toContain("'batch_number'");
    expect(dpBlock).not.toContain("'price'");
    expect(dpBlock).not.toContain("'trade_name'");
    expect(dpBlock).not.toContain("'notes'");
    expect(dpBlock).not.toContain("'supply_type'");
  });
});

// =============================================================================
// Migration 028 — Public QR D6/D7 expiry and scientific-name fix
// =============================================================================

function readMig028() {
  return readPhoenix('supabase/migrations/028_phoenix_public_qr_expiry_scientific_name_fix.sql');
}

describe('PUBLIC-QR-D6 [scientific-name-only items visible on QR]', () => {
  it('migration 028 exists', () => {
    expect(() => readMig028()).not.toThrow();
  });

  it('migration 028 uses LEFT JOIN on local_items (D6: include local_item_id = NULL rows)', () => {
    const sql = readMig028();
    expect(sql.toLowerCase()).toMatch(/left\s+join\s+local_items/);
  });

  it('migration 028 uses LEFT JOIN on central_items (D6: cascade of LEFT JOINs)', () => {
    const sql = readMig028();
    expect(sql.toLowerCase()).toMatch(/left\s+join\s+central_items/);
  });

  it('migration 028 includes scientific_name in COALESCE fallback chain', () => {
    const sql = readMig028();
    // must appear in the distribution_point branch name coalesce
    expect(sql).toContain('ia.scientific_name');
  });

  it('migration 028 provides an English fallback for nameless rows', () => {
    const sql = readMig028();
    expect(sql).toContain('Unnamed material');
  });

  it('migration 028 provides an Arabic fallback for nameless rows', () => {
    const sql = readMig028();
    expect(sql).toContain('مادة غير مسماة');
  });

  it('migration 028 does not expose scientific_name directly as a separate output field', () => {
    // scientific_name is only used as a COALESCE source for name/name_ar;
    // it must NOT be emitted as its own 'scientific_name' key in the JSON output
    const sql = readMig028();
    expect(sql).not.toContain("'scientific_name'");
  });

  it('migration 028 VERIFY block asserts LEFT JOIN on local_items', () => {
    const sql = readMig028();
    const verifyBlock = sql.slice(sql.indexOf('do $$'));
    expect(verifyBlock.toLowerCase()).toContain('left join local_items');
  });
});

describe('PUBLIC-QR-D7 [auto-compute expiry condition from expiry_date]', () => {
  it('migration 028 computes effective_condition from expiry_date (not raw ia.condition)', () => {
    const sql = readMig028();
    expect(sql).toContain('effective_condition');
  });

  it('migration 028 marks past-expiry-date rows as expired', () => {
    const sql = readMig028();
    expect(sql).toContain("expiry_date < current_date");
  });

  it('migration 028 applies 3-month threshold', () => {
    const sql = readMig028();
    expect(sql).toContain("interval '3 months'");
  });

  it('migration 028 applies 6-month threshold', () => {
    const sql = readMig028();
    expect(sql).toContain("interval '6 months'");
  });

  it('migration 028 applies 9-month threshold', () => {
    const sql = readMig028();
    expect(sql).toContain("interval '9 months'");
  });

  it('migration 028 emits expiry_bucket field in JSON output', () => {
    const sql = readMig028();
    expect(sql).toContain("'expiry_bucket'");
  });

  it('migration 028 expiry_bucket emits "3_months" value', () => {
    const sql = readMig028();
    expect(sql).toContain("'3_months'");
  });

  it('migration 028 expiry_bucket emits "6_months" value', () => {
    const sql = readMig028();
    expect(sql).toContain("'6_months'");
  });

  it('migration 028 expiry_bucket emits "9_months" value', () => {
    const sql = readMig028();
    expect(sql).toContain("'9_months'");
  });

  it('migration 028 uses effective_condition to null out expired quantity (D2 extended)', () => {
    const sql = readMig028();
    expect(sql).toContain("effective_condition = 'expired'");
  });

  it('migration 028 uses effective_condition to guard expiry_date return (D3 extended)', () => {
    const sql = readMig028();
    expect(sql).toContain("effective_condition in ('near_expiry', 'expired')");
  });

  it('migration 028 applies D7 fix to local_item branch as well', () => {
    const sql = readMig028();
    // both distribution_point and local_item branches must have effective_condition
    const firstOcc  = sql.indexOf('effective_condition');
    const secondOcc = sql.indexOf('effective_condition', firstOcc + 1);
    expect(secondOcc).toBeGreaterThan(firstOcc);
  });

  it('migration 028 VERIFY block asserts expiry_date < current_date', () => {
    const sql = readMig028();
    const verifyBlock = sql.slice(sql.indexOf('do $$'));
    expect(verifyBlock).toContain('expiry_date < current_date');
  });

  it('migration 028 VERIFY block asserts expiry_bucket field present', () => {
    const sql = readMig028();
    const verifyBlock = sql.slice(sql.indexOf('do $$'));
    expect(verifyBlock).toContain('expiry_bucket');
  });
});

describe('PUBLIC-QR-D6/D7 [security: privacy guardrails preserved in migration 028]', () => {
  // Scope privacy checks to the function body only (before the DO $$ VERIFY block).
  // The VERIFY block itself contains field names in ilike patterns like '%''batch_number''%'
  // to assert those fields are NOT in the function — those assertions are correct and expected.
  function mig028FnBody() {
    const sql = readMig028();
    const fnStart = sql.indexOf('create or replace function get_public_qr_payload');
    const verifyStart = sql.indexOf('\ndo $$');
    return sql.slice(fnStart, verifyStart);
  }

  it('migration 028 preserves D4 — DISTRIBUTION_POINT_NOT_ACTIVE guard', () => {
    expect(mig028FnBody()).toContain('DISTRIBUTION_POINT_NOT_ACTIVE');
  });

  it('migration 028 does not expose batch_number in JSON output', () => {
    expect(mig028FnBody()).not.toContain("'batch_number'");
  });

  it('migration 028 does not expose price in JSON output', () => {
    expect(mig028FnBody()).not.toContain("'price'");
  });

  it('migration 028 does not expose trade_name in JSON output', () => {
    expect(mig028FnBody()).not.toContain("'trade_name'");
  });

  it('migration 028 does not expose notes in JSON output', () => {
    expect(mig028FnBody()).not.toContain("'notes'");
  });

  it('migration 028 does not expose supply_type in JSON output', () => {
    expect(mig028FnBody()).not.toContain("'supply_type'");
  });

  it('migration 028 does not reference service_role in function body', () => {
    expect(mig028FnBody().toLowerCase()).not.toContain('service_role');
  });

  it('migration 028 does not expose actor_name_snapshot in function body', () => {
    expect(mig028FnBody()).not.toContain('actor_name_snapshot');
  });

  it('migration 028 does not expose actor_email_snapshot in function body', () => {
    expect(mig028FnBody()).not.toContain('actor_email_snapshot');
  });

  it('migration 028 does not expose token_hash in JSON output', () => {
    expect(mig028FnBody()).not.toContain("'token_hash'");
  });

  it('migration 028 preserves SECURITY DEFINER on get_public_qr_payload', () => {
    const sql = readMig028();
    expect(sql.toLowerCase()).toContain('security definer');
  });

  it('migration 028 grants execute to anon and authenticated (not broader)', () => {
    const sql = readMig028();
    expect(sql.toLowerCase()).toContain('grant execute on function get_public_qr_payload');
    expect(sql.toLowerCase()).toContain('to anon, authenticated');
  });

  it('migration 028 has MANUAL APPLY ONLY header', () => {
    const sql = readMig028();
    expect(sql.toUpperCase()).toContain('MANUAL APPLY ONLY');
  });

  it('migration 028 VERIFY block asserts avail_select_anon still false', () => {
    const sql = readMig028();
    const verifyBlock = sql.slice(sql.indexOf('do $$'));
    expect(verifyBlock).toContain('avail_select_anon');
    expect(verifyBlock).toContain("'false'");
  });
});

describe('PUBLIC-QR-D6/D7 [frontend: PublicQrScreen expiry_bucket support]', () => {
  it('PublicQrScreen.tsx defines expiry_bucket on PublicItem type', () => {
    const src = readSrc('features/qr/PublicQrScreen.tsx');
    expect(src).toContain('expiry_bucket');
  });

  it('PublicQrScreen.tsx has getExpBucketBadge helper', () => {
    const src = readSrc('features/qr/PublicQrScreen.tsx');
    expect(src).toContain('getExpBucketBadge');
  });

  it('PublicQrScreen.tsx getExpBucketBadge handles expired bucket', () => {
    const src = readSrc('features/qr/PublicQrScreen.tsx');
    expect(src).toContain("bucket === 'expired'");
  });

  it('PublicQrScreen.tsx getExpBucketBadge handles 3_months bucket', () => {
    const src = readSrc('features/qr/PublicQrScreen.tsx');
    expect(src).toContain("bucket === '3_months'");
  });

  it('PublicQrScreen.tsx getExpBucketBadge handles 6_months bucket', () => {
    const src = readSrc('features/qr/PublicQrScreen.tsx');
    expect(src).toContain("bucket === '6_months'");
  });

  it('PublicQrScreen.tsx getExpBucketBadge handles 9_months bucket', () => {
    const src = readSrc('features/qr/PublicQrScreen.tsx');
    expect(src).toContain("bucket === '9_months'");
  });

  it('PublicQrScreen.tsx uses existing i18n keys for threshold labels (no new keys added)', () => {
    const src = readSrc('features/qr/PublicQrScreen.tsx');
    // uses already-existing i18n keys from migration 021 / strings.ts
    expect(src).toContain('expired_material');
    expect(src).toContain('expires_within_3_months');
    expect(src).toContain('expires_within_6_months');
    expect(src).toContain('expires_within_9_months');
  });

  it('PublicQrScreen.tsx renders bucketBadge alongside condition badge', () => {
    const src = readSrc('features/qr/PublicQrScreen.tsx');
    expect(src).toContain('bucketBadge');
  });

  it('PublicQrScreen.tsx does not import from supabase client directly (uses service layer)', () => {
    const src = readSrc('features/qr/PublicQrScreen.tsx');
    expect(src).not.toContain("from '@/shared/supabase/client'");
  });

  it('PublicQrScreen.tsx does not expose expiry_bucket from type in unsafe field names', () => {
    // expiry_bucket is safe (threshold label, not internal identifier)
    // but confirm price/batch_number/trade_name are not referenced in the UI
    const src = readSrc('features/qr/PublicQrScreen.tsx');
    expect(src).not.toContain('batch_number');
    expect(src).not.toContain('trade_name');
    expect(src).not.toContain('price');
    expect(src).not.toContain('supply_type');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════
   QR-AUDIT-CENTER-POLISH-A — QrScreen.tsx guardrails
   ═══════════════════════════════════════════════════════════════════════════════ */

describe('QR-AUDIT-CENTER [QrScreen.tsx: title, subtitle, i18n]', () => {
  const src = readSrc('features/qr/QrScreen.tsx');

  it('uses nav_qr_audit for the screen title', () => {
    expect(src).toContain('nav_qr_audit');
  });

  it('uses qr_audit_center_subtitle for the subtitle', () => {
    expect(src).toContain('qr_audit_center_subtitle');
  });

  it('shows qr_linked_inactive_port risk label', () => {
    expect(src).toContain('qr_linked_inactive_port');
  });

  it('shows qr_ports_no_qr label for ports without QR', () => {
    expect(src).toContain('qr_ports_no_qr');
  });

  it('shows qr_total_scans metric label', () => {
    expect(src).toContain('qr_total_scans');
  });

  it('shows qr_recently_scanned filter chip label', () => {
    expect(src).toContain('qr_recently_scanned');
  });

  it('uses qr_no_registered for empty state', () => {
    expect(src).toContain('qr_no_registered');
  });

  it('uses qr_no_critical_issues for health banner', () => {
    expect(src).toContain('qr_no_critical_issues');
  });

  it('uses qr_copy_link for copy action', () => {
    expect(src).toContain('qr_copy_link');
  });

  it('uses qr_open_public for open action', () => {
    expect(src).toContain('qr_open_public');
  });

  it('uses qr_print for print action', () => {
    expect(src).toContain('qr_print');
  });

  it('uses qr_inactive_target for target status indicator', () => {
    expect(src).toContain('qr_inactive_target');
  });

  it('uses qr_review_or_disable advisory text', () => {
    expect(src).toContain('qr_review_or_disable');
  });

  it('uses qr_create_from_port for ports-without-QR CTA', () => {
    expect(src).toContain('qr_create_from_port');
  });
});

describe('QR-AUDIT-CENTER [QrScreen.tsx: metrics computation]', () => {
  const src = readSrc('features/qr/QrScreen.tsx');

  it('computes activeRows from status === active', () => {
    expect(src).toContain("status === 'active'");
  });

  it('computes disabledRows as rows where status is not active', () => {
    expect(src).toContain('disabledRows');
  });

  it('computes riskRows as active QR pointing to inactive target', () => {
    expect(src).toContain('riskRows');
    expect(src).toContain("tg.status !== 'active'");
  });

  it('computes totalScans as sum of scan_count', () => {
    expect(src).toContain('scan_count');
    expect(src).toContain('totalScans');
  });

  it('builds activeDpTargetIds Set for ports-without-QR computation', () => {
    expect(src).toContain('activeDpTargetIds');
    expect(src).toContain("target_type === 'distribution_point'");
  });

  it('computes portsWithoutQr by comparing points against activeDpTargetIds', () => {
    expect(src).toContain('portsWithoutQr');
    expect(src).toContain('activeDpTargetIds.has');
  });

  it('loads QR tokens via getQrTokensByOrg', () => {
    expect(src).toContain('getQrTokensByOrg');
  });

  it('loads distribution points via getPointsByOrg', () => {
    expect(src).toContain('getPointsByOrg');
  });

  it('uses filter state for audit filtering', () => {
    expect(src).toContain("FilterType");
    expect(src).toContain("'all'");
    expect(src).toContain("'active'");
    expect(src).toContain("'disabled'");
    expect(src).toContain("'risk'");
    expect(src).toContain("'no_qr'");
    expect(src).toContain("'recent'");
  });
});

describe('QR-AUDIT-CENTER [QrScreen.tsx: permissions]', () => {
  const src = readSrc('features/qr/QrScreen.tsx');

  it('uses myPermissions.has for qr.revoke gating (not hardcoded role check)', () => {
    expect(src).toContain("myPermissions.has('qr.revoke')");
  });

  it('uses myPermissions.has for qr.generate gating', () => {
    expect(src).toContain("myPermissions.has('qr.generate')");
  });

  it('canRevoke gates the revoke button', () => {
    expect(src).toContain('canRevoke');
  });

  it('canGenerate gates the ports-without-QR CTA', () => {
    expect(src).toContain('canGenerate');
  });

  it('revoke uses disableQrToken service (existing safe flow)', () => {
    expect(src).toContain('disableQrToken');
  });
});

describe('QR-AUDIT-CENTER [QrScreen.tsx: security — no unsafe fields]', () => {
  const src = readSrc('features/qr/QrScreen.tsx');

  it('does not expose token_hash', () => {
    expect(src).not.toContain('token_hash');
  });

  it('does not expose actor_name_snapshot', () => {
    expect(src).not.toContain('actor_name_snapshot');
  });

  it('does not expose actor_email_snapshot', () => {
    expect(src).not.toContain('actor_email_snapshot');
  });

  it('does not expose batch_number', () => {
    expect(src).not.toContain('batch_number');
  });

  it('does not expose price field', () => {
    expect(src).not.toContain("'price'");
  });

  it('does not use service_role in frontend', () => {
    expect(src).not.toContain('service_role');
  });

  it('does not use auth.admin in frontend', () => {
    expect(src).not.toContain('auth.admin');
  });

  it('print output does not include token_hash', () => {
    // print window renders label, url, date, brand — not token_hash or secrets
    expect(src).not.toContain('token_hash');
    expect(src).toContain('MediStock-Babil / MASAR Health Network');
  });

  it('public URL uses only public_id (no secret token in URL)', () => {
    expect(src).toContain('makePublicUrl');
    expect(src).toContain('public_id');
    expect(src).not.toContain('token_hash');
  });

  it('copy action copies public URL not secret token', () => {
    expect(src).toContain('makePublicUrl(pid)');
    expect(src).toContain('clipboard.writeText');
  });
});

describe('QR-AUDIT-CENTER [QrScreen.tsx: UX behavior]', () => {
  const src = readSrc('features/qr/QrScreen.tsx');

  it('uses PhoenixMetricCard for summary metrics', () => {
    expect(src).toContain('PhoenixMetricCard');
  });

  it('print action uses QRCode library (no raw URL in print window)', () => {
    expect(src).toContain("import QRCode from 'qrcode'");
    expect(src).toContain('QRCode.toDataURL');
  });

  it('print output includes brand label', () => {
    expect(src).toContain('MediStock-Babil / MASAR Health Network');
  });

  it('revoke shows confirmation dialog before acting', () => {
    expect(src).toContain('confirmRevokeId');
    expect(src).toContain('PhoenixDialog');
  });

  it('copy action shows toast notification', () => {
    expect(src).toContain('showToast');
    expect(src).toContain("qr_copied");
  });

  it('risk cards have visual border indicator', () => {
    expect(src).toContain('#dc2626');
  });

  it('uses dir="ltr" for public URL (RTL-safe)', () => {
    expect(src).toContain('dir="ltr"');
  });

  it('empty state shown when no QR tokens', () => {
    expect(src).toContain('qr_no_registered');
    expect(src).toContain('PhoenixEmptyState');
  });

  it('print action only shown for active QR tokens', () => {
    // print button is rendered inside `isActive &&` block
    expect(src).toContain('isActive');
    expect(src).toContain('qr_print');
  });
});

describe('QR-AUDIT-CENTER [i18n: new keys exist in strings.ts]', () => {
  const strings = readSrc('shared/i18n/strings.ts');

  it('nav_qr_audit key exists with AR + EN', () => {
    expect(strings).toContain('nav_qr_audit');
    expect(strings).toContain('مركز تدقيق QR');
    expect(strings).toContain('QR Audit Center');
  });

  it('qr_audit_center_subtitle includes port linkage mention', () => {
    expect(strings).toContain('qr_audit_center_subtitle');
    expect(strings).toContain('port linkage');
    expect(strings).toContain('بالمنافذ');
  });

  it('qr_ports_no_qr key exists in AR + EN', () => {
    expect(strings).toContain('qr_ports_no_qr');
    expect(strings).toContain('منافذ بدون QR نشط');
    expect(strings).toContain('Ports without active QR');
  });

  it('qr_linked_inactive_port key exists in AR + EN', () => {
    expect(strings).toContain('qr_linked_inactive_port');
    expect(strings).toContain('QR مرتبط بمنفذ غير نشط');
    expect(strings).toContain('QR linked to inactive port');
  });

  it('qr_total_scans key exists', () => {
    expect(strings).toContain('qr_total_scans');
    expect(strings).toContain('إجمالي عمليات المسح');
    expect(strings).toContain('Total QR Scans');
  });

  it('qr_recently_scanned key exists', () => {
    expect(strings).toContain('qr_recently_scanned');
    expect(strings).toContain('ممسوح حديثاً');
    expect(strings).toContain('Recently Scanned');
  });

  it('qr_no_registered key exists', () => {
    expect(strings).toContain('qr_no_registered');
    expect(strings).toContain('لا توجد رموز QR مسجلة حالياً');
    expect(strings).toContain('No QR codes are registered yet');
  });

  it('qr_no_critical_issues key exists', () => {
    expect(strings).toContain('qr_no_critical_issues');
    expect(strings).toContain('لا توجد مشاكل QR حرجة حالياً');
    expect(strings).toContain('No critical QR issues right now');
  });

  it('qr_open_public key exists', () => {
    expect(strings).toContain('qr_open_public');
    expect(strings).toContain('فتح صفحة QR العامة');
    expect(strings).toContain('Open public QR page');
  });

  it('qr_copy_link key exists', () => {
    expect(strings).toContain('qr_copy_link');
    expect(strings).toContain('نسخ رابط QR');
    expect(strings).toContain('Copy QR link');
  });

  it('qr_inactive_target key exists', () => {
    expect(strings).toContain('qr_inactive_target');
    expect(strings).toContain('هدف غير نشط');
    expect(strings).toContain('Inactive target');
  });

  it('qr_review_or_disable key exists', () => {
    expect(strings).toContain('qr_review_or_disable');
    expect(strings).toContain('راجع المنفذ أو عطّل الرمز');
    expect(strings).toContain('Review the port or disable the QR');
  });

  it('qr_create_from_port key exists', () => {
    expect(strings).toContain('qr_create_from_port');
    expect(strings).toContain('إنشاء QR من كرت المنفذ');
    expect(strings).toContain('Create QR from the port card');
  });
});

describe('QR-AUDIT-CENTER [no migration created, no SQL, no RLS changes]', () => {
  const src = readSrc('features/qr/QrScreen.tsx');

  it('QrScreen.tsx does not reference any migration SQL', () => {
    expect(src).not.toContain('create or replace function');
    expect(src).not.toContain('create policy');
    expect(src).not.toContain('alter table');
  });

  it('QrScreen.tsx does not call supabase client directly (uses service layer)', () => {
    expect(src).not.toContain("from '@/shared/supabase/client'");
  });

  it('QrScreen.tsx imports only from safe service layer', () => {
    expect(src).toContain("from '@/shared/supabase/services/qr.service'");
    expect(src).toContain("from '@/shared/supabase/services/warehouses.service'");
  });

  it('Data Reset is absent from QrScreen', () => {
    expect(src).not.toContain('DataReset');
    expect(src).not.toContain('data_reset');
  });

  it('Intake/OCR/Excel/DocIntel absent from QrScreen', () => {
    expect(src).not.toContain('Intake');
    expect(src).not.toContain('DocIntel');
    expect(src).not.toContain('Excel');
  });
});
