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
