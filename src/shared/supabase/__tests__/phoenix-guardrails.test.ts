/**
 * Phoenix V2 Guardrail Tests
 * Run: npm test -- --run
 *
 * These tests verify safety constraints without requiring a real DB connection.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
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
// 1. FULL WIPE SQL SAFETY
// ============================================================================

describe('Full wipe SQL: 000_full_public_app_wipe.sql', () => {
  const sql = readSql('full_wipe_tools/000_full_public_app_wipe.sql');

  it('drops only public schema (not auth)', () => {
    expect(sql).toContain('drop schema if exists public cascade');
    expect(sql).not.toMatch(/drop schema.*(auth|storage|realtime|extensions|vault|graphql)/i);
  });

  it('recreates public schema', () => {
    expect(sql).toContain('create schema public');
  });

  it('restores required grants', () => {
    expect(sql).toContain('grant usage on schema public');
    expect(sql).toContain('anon');
    expect(sql).toContain('authenticated');
  });

  it('has safety checks that abort on wrong database', () => {
    expect(sql).toContain('SAFETY_ABORT');
  });

  it('verifies auth, storage, extensions survive', () => {
    expect(sql).toContain("array['auth', 'storage', 'extensions']");
  });

  it('confirms wipe completion before proceeding', () => {
    expect(sql).toContain('WIPE_COMPLETE');
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

describe('Account lifecycle guardrails: recycling not implemented', () => {
  const screen  = readSrc('features/users/UserManagementScreen.tsx');
  const userSvc = readSrc('shared/supabase/services/users.service.ts');

  it('no recycling UI element in UserManagementScreen', () => {
    expect(screen).not.toContain('recycle');
    expect(screen).not.toContain('recycled_candidate');
  });

  it('no recycling service function in users.service.ts', () => {
    expect(userSvc).not.toContain('recycleUser');
    expect(userSvc).not.toContain('recycleuserviaedge');
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
      // Direct profile updates from frontend are prohibited; all lifecycle goes through Edge Functions
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
