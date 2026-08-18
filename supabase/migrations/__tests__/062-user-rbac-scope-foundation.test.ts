/**
 * USER-RBAC-U1-SCOPE-062-IMPLEMENT-A
 *
 * Static SQL-source tests for migration 062 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of every other
 * migration test here (052–061).
 *
 * Migration 062 creates profile_scope_assignments (durable warehouse/outlet
 * assignments), adds the scope-aware permission helper WITHOUT touching the
 * global one, replaces 060's warehouse/stock/movement SELECT policies and 061's
 * dispatch SELECT policies with assignment-scoped versions, adds precise stock /
 * reporting / audit / user-scope permission keys, strips warehouses.manage from
 * warehouse_officer, and protects the last active super_admin in the database.
 *
 * It must NOT create user-administration or dispatch RPCs, must not apply 061 or
 * 062, and must not touch public QR, Deep Clean (055) or the exchange domain.
 *
 * NOTE ON SCOPE: like 061's test, this file deliberately contains NO global
 * ceiling assertion (no `getMaximumReviewedMigrationNumber() === 62`, no
 * hard-coded guess at 063's filename). Those belong to
 * reviewed-migration-manifest.test.ts alone — that is the single file the
 * registry was designed to concentrate that churn into.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import {
  REVIEWED_MIGRATION_FILES,
  findUnreviewedMigrationFiles,
  isReviewedMigrationFile,
} from './helpers/reviewed-migrations';
// SQL-SOURCE-LEXER-A: comment stripping is lexical and shared. The per-file
// `/--.*$/` this replaced stripped nothing at all on a CRLF checkout, which made
// every prose-based guard below silently inert on Windows.
import { activeSql } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M062_NAME = '062_phoenix_user_rbac_scope_foundation.sql';
const P062 = join(MIGRATIONS_DIR, M062_NAME);
const m062 = readFileSync(P062, 'utf8');

const active062 = activeSql(m062);
const rawLines = active062.split('\n');
const activeLines = rawLines.map(l => l.trim()).filter(l => l.length > 0);

/**
 * The VERIFY section is the two trailing `DO $$` blocks (parts 1/2 and 2/2),
 * which are the only ones declaring `v_cnt`. The earlier `DO $$` blocks are the
 * idempotent ADD CONSTRAINT / CREATE TRIGGER wrappers and the G1–G3 prechecks.
 */
const VERIFY_DECL = 'DO $$\nDECLARE\n  v_cnt      int;';
const verifyStart = active062.indexOf(VERIFY_DECL);
const commitIdx = active062.search(/^commit;/m);
const verifyBlock = active062.slice(verifyStart, commitIdx);

/**
 * Executable DDL only — between `begin;` and the VERIFY section.
 *
 * Negative scans MUST use this slice: the VERIFY block legitimately contains the
 * strings we forbid (e.g. `NOT LIKE '%revoked_by IS NOT NULL%'`) inside
 * assertions whose whole purpose is to reject them. Scanning the whole file
 * would flag the guard as the violation it prevents.
 */
const ddlSection = active062.slice(active062.search(/^begin;/m), verifyStart);

const TX_BEGIN = /^begin\s*;\s*$/;
const TX_COMMIT = /^commit\s*;\s*$/;
const countOf = (re: RegExp): number => rawLines.filter(l => re.test(l)).length;
const idxOf = (re: RegExp): number => rawLines.findIndex(l => re.test(l));

/** Collapse whitespace so structural assertions survive reformatting. */
const norm = (s: string): string => s.replace(/\s+/g, ' ');
const ddlNorm = norm(ddlSection);

/** The body of a named CREATE POLICY statement, from its name to the next `CREATE `/`DROP `. */
function policyBody(name: string): string {
  const start = ddlSection.indexOf(`CREATE POLICY "${name}"`);
  expect(start, `policy ${name} must exist`).toBeGreaterThan(-1);
  const rest = ddlSection.slice(start + 10);
  const end = rest.search(/\n(CREATE|DROP|ALTER|REVOKE|GRANT|COMMENT|INSERT|UPDATE)\s/);
  return norm(end === -1 ? rest : rest.slice(0, end));
}

/** The body of a named CONSTRAINT in the CREATE TABLE, up to the next constraint. */
function constraintBody(name: string): string {
  const start = ddlSection.indexOf(`CONSTRAINT ${name}`);
  expect(start, `constraint ${name} must exist`).toBeGreaterThan(-1);
  const rest = ddlSection.slice(start);
  const end = rest.slice(1).search(/\n\s*(CONSTRAINT|\);)/);
  return norm(end === -1 ? rest : rest.slice(0, end + 1));
}

/** The source of a named CREATE [OR REPLACE] FUNCTION, up to its `$$;` terminator. */
function functionBody(name: string): string {
  const start = ddlSection.indexOf(`FUNCTION public.${name}(`);
  expect(start, `function ${name} must exist`).toBeGreaterThan(-1);
  const rest = ddlSection.slice(start);
  const end = rest.indexOf('\n$$;');
  return end === -1 ? rest : rest.slice(0, end);
}

// ============================================================================
// 1. Existence + registry
// ============================================================================

describe('1. migration 062 exists and is registered by exact filename', () => {
  it('062_phoenix_user_rbac_scope_foundation.sql exists', () => {
    expect(existsSync(P062)).toBe(true);
    expect(m062.length).toBeGreaterThan(3000);
  });

  it('is the only file named 062_*', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('062_'))).toEqual([M062_NAME]);
  });

  it('the canonical registry contains its exact filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M062_NAME);
    expect(isReviewedMigrationFile(M062_NAME)).toBe(true);
  });

  it('no unreviewed migration file exists on disk', () => {
    expect(findUnreviewedMigrationFiles(readdirSync(MIGRATIONS_DIR))).toEqual([]);
  });

  it('a synthetic unregistered migration 063 is still rejected', () => {
    expect(isReviewedMigrationFile('063_unreviewed_test_migration.sql')).toBe(false);
    expect(
      findUnreviewedMigrationFiles([...readdirSync(MIGRATIONS_DIR), '063_unreviewed.sql']),
    ).toEqual(['063_unreviewed.sql']);
  });

  // DELIBERATELY ABSENT: any `no 063_*/064_* file exists on disk` assertion.
  //
  // Migration 061's test carried exactly that guard against 062, and it failed
  // permanently the moment 062 was legitimately reviewed — a historical phase
  // test must never break merely because a later reviewed migration now exists.
  // That guard was removed rather than repeated here.
  //
  // The property it was reaching for is fully covered without a future ceiling:
  // the synthetic-063 rejection test above proves an unregistered 063 filename is
  // refused, and reviewed-migration-manifest.test.ts owns the maximum (62), the
  // next unreviewed number (63), and registry/disk agreement. When 063 is
  // genuinely authored, ONLY the registry and that manifest advance.

  it('is manual-apply-only (mentions the prohibition, never invokes it)', () => {
    expect(m062).toContain('MANUAL APPLY ONLY');
    expect(activeLines.some(l => l.includes('supabase db push'))).toBe(false);
  });

  it('performs no migration application of its own (061 is applied by the operator)', () => {
    // 062 must reference 061 as a PREREQUISITE, never execute it.
    expect(m062).toContain('Migration 061');
    expect(activeLines.some(l => /\\i |\bpsql\b|\bsupabase\s+db\b/i.test(l))).toBe(false);
  });
});

// ============================================================================
// 2. Transaction wrapper + VERIFY placement
// ============================================================================

describe('2. explicit transaction wrapper with VERIFY inside it', () => {
  it('has exactly one top-level begin; and one top-level commit;', () => {
    expect(countOf(TX_BEGIN)).toBe(1);
    expect(countOf(TX_COMMIT)).toBe(1);
  });

  it('begin; precedes the first DDL statement', () => {
    const begin = idxOf(TX_BEGIN);
    const firstDdl = rawLines.findIndex(l =>
      /^CREATE TABLE IF NOT EXISTS public\.profile_scope_assignments \($/.test(l));
    expect(begin).toBeGreaterThan(-1);
    expect(firstDdl).toBeGreaterThan(begin);
  });

  it('commit; follows the VERIFY section', () => {
    expect(verifyStart).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(verifyStart);
  });

  it('the VERIFY section executes inside the transaction', () => {
    const beginIdx = active062.search(/^begin;/m);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(verifyStart).toBeGreaterThan(beginIdx);
    expect(verifyStart).toBeLessThan(commitIdx);
  });

  it('uses no SAVEPOINT, ROLLBACK or nested transaction control', () => {
    expect(active062).not.toMatch(/\bSAVEPOINT\b/i);
    expect(active062).not.toMatch(/\bROLLBACK\b/i);
    expect(active062).not.toMatch(/\bSET\s+TRANSACTION\b/i);
  });

  it('MUTATION: removing begin; or commit; is detectable (the guard bites)', () => {
    const noBegin = rawLines.filter(l => !TX_BEGIN.test(l));
    const noCommit = rawLines.filter(l => !TX_COMMIT.test(l));
    expect(noBegin.filter(l => TX_BEGIN.test(l)).length).toBe(0);
    expect(noCommit.filter(l => TX_COMMIT.test(l)).length).toBe(0);
    // ...and the real file still has exactly one of each.
    expect(countOf(TX_BEGIN)).toBe(1);
    expect(countOf(TX_COMMIT)).toBe(1);
  });

  it('MUTATION: a VERIFY block moved after commit; would be detectable', () => {
    const broken = active062.slice(commitIdx) + active062.slice(verifyStart, commitIdx);
    expect(broken.indexOf('commit;')).toBeLessThan(broken.indexOf(VERIFY_DECL));
    // The real file has the opposite ordering.
    expect(verifyStart).toBeLessThan(commitIdx);
  });

  /**
   * An EXCEPTION *clause* starts its own line. The VERIFY block legitimately
   * contains the STRING 'EXCEPTION WHEN OTHERS' inside assertions whose whole
   * purpose is to reject a handler in the functions under test — matching that
   * would flag the guard as the violation it prevents.
   */
  const EXCEPTION_CLAUSE = /^\s*EXCEPTION\b/m;

  it('VERIFY contains no swallowing exception handler', () => {
    expect(verifyBlock).not.toMatch(EXCEPTION_CLAUSE);
    expect(verifyBlock).not.toMatch(/^\s*CONTINUE\b/m);
  });

  it('MUTATION: a swallowed VERIFY failure would be detectable', () => {
    const broken = verifyBlock.replace('END $$;', '\nEXCEPTION WHEN OTHERS THEN NULL;\nEND $$;');
    expect(broken).toMatch(EXCEPTION_CLAUSE);
    expect(verifyBlock).not.toMatch(EXCEPTION_CLAUSE);
  });

  it('VERIFY does assert against swallowed handlers in the functions it checks', () => {
    // The strings above are only safe to skip because they appear inside these
    // guards — confirm the guards are genuinely there.
    expect(verifyBlock).toContain("v_src NOT ILIKE '%EXCEPTION WHEN OTHERS%'");
  });

  it('VERIFY uses ASSERT, not RAISE NOTICE, to enforce', () => {
    expect((verifyBlock.match(/ASSERT /g) ?? []).length).toBeGreaterThan(60);
  });
});

// ============================================================================
// 3. profile_scope_assignments — schema
// ============================================================================

describe('3. profile_scope_assignments schema', () => {
  it('creates the table', () => {
    expect(ddlSection).toContain('CREATE TABLE IF NOT EXISTS public.profile_scope_assignments (');
  });

  it('declares every required column with the required type', () => {
    for (const [col, type] of [
      ['id', 'uuid PRIMARY KEY DEFAULT gen_random_uuid()'],
      ['profile_id', 'uuid NOT NULL'],
      ['organization_id', 'uuid NOT NULL'],
      ['scope_type', 'text NOT NULL'],
      ['is_active', 'boolean NOT NULL DEFAULT true'],
      ['assigned_at', 'timestamptz NOT NULL DEFAULT now()'],
      ['created_at', 'timestamptz NOT NULL DEFAULT now()'],
      ['updated_at', 'timestamptz NOT NULL DEFAULT now()'],
    ] as const) {
      expect(ddlNorm, `${col} ${type}`).toContain(`${col} ${type}`);
    }
  });

  it('declares the nullable columns nullable (no NOT NULL)', () => {
    for (const col of ['warehouse_id', 'distribution_point_id', 'revoked_at', 'revoke_reason']) {
      const m = new RegExp(`\\n  ${col}\\s+\\w+[^,\\n]*`).exec(ddlSection);
      expect(m, `${col} must be declared`).not.toBeNull();
      expect(m![0], `${col} must stay nullable`).not.toContain('NOT NULL');
    }
  });

  it('uses text + CHECK for scope_type, never a Postgres enum', () => {
    expect(ddlNorm).toContain('scope_type text NOT NULL');
    expect(ddlSection).not.toMatch(/CREATE\s+TYPE/i);
    expect(constraintBody('psa_scope_type_chk')).toContain(
      "CHECK (scope_type IN ('warehouse', 'distribution_point'))",
    );
  });

  it('the two scope values are exactly warehouse and distribution_point', () => {
    const body = constraintBody('psa_scope_type_chk');
    expect(body).toContain("'warehouse'");
    expect(body).toContain("'distribution_point'");
    expect(body).not.toContain("'outlet'");
    expect(body).not.toContain("'port'");
  });

  it('has an updated_at trigger, per repository convention', () => {
    expect(ddlSection).toContain(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.profile_scope_assignments',
    );
  });
});

// ============================================================================
// 4. Assignment invariants
// ============================================================================

describe('4. warehouse/outlet assignment invariants', () => {
  const target = constraintBody('psa_target_matches_scope_chk');

  it('a warehouse assignment names a warehouse and no outlet', () => {
    expect(target).toContain("WHEN 'warehouse' THEN warehouse_id IS NOT NULL AND distribution_point_id IS NULL");
  });

  it('an outlet assignment names an outlet and no warehouse', () => {
    expect(target).toContain(
      "WHEN 'distribution_point' THEN distribution_point_id IS NOT NULL AND warehouse_id IS NULL",
    );
  });

  it('an unknown scope_type is rejected (ELSE false, never ELSE true)', () => {
    expect(target).toContain('ELSE false');
    expect(target).not.toContain('ELSE true');
  });

  it('MUTATION: dropping the warehouse-excludes-outlet rule would be caught', () => {
    const broken = target.replace(
      "WHEN 'warehouse' THEN warehouse_id IS NOT NULL AND distribution_point_id IS NULL",
      "WHEN 'warehouse' THEN warehouse_id IS NOT NULL",
    );
    expect(broken).not.toContain("WHEN 'warehouse' THEN warehouse_id IS NOT NULL AND distribution_point_id IS NULL");
    expect(target).toContain("WHEN 'warehouse' THEN warehouse_id IS NOT NULL AND distribution_point_id IS NULL");
  });
});

describe('4b. revocation invariants and retention', () => {
  const status = constraintBody('psa_status_chk');

  it('an active assignment carries no revocation metadata', () => {
    expect(status).toContain('WHEN is_active THEN revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL');
  });

  it('a revoked assignment requires revoked_at and a trimmed non-empty reason', () => {
    expect(status).toContain('ELSE revoked_at IS NOT NULL');
    expect(status).toContain('revoke_reason IS NOT NULL');
    expect(status).toContain("btrim(revoke_reason) <> ''");
  });

  it('revoked_by is NOT required to stay non-null (ON DELETE SET NULL retention)', () => {
    expect(status).not.toContain('revoked_by IS NOT NULL');
  });

  it('revoked_by is ON DELETE SET NULL, so a revoker stays deletable', () => {
    expect(ddlSection).toMatch(/revoked_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
    expect(ddlSection).toMatch(/assigned_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
  });

  it('MUTATION: requiring revoked_by non-null would be caught', () => {
    const broken = status.replace('ELSE revoked_at IS NOT NULL', 'ELSE revoked_by IS NOT NULL AND revoked_at IS NOT NULL');
    expect(broken).toContain('revoked_by IS NOT NULL');
    expect(status).not.toContain('revoked_by IS NOT NULL');
  });

  it('the VERIFY block enforces the same retention rule in-database', () => {
    expect(verifyBlock).toContain("v_txt NOT LIKE '%revoked_by IS NOT NULL%'");
    expect(verifyBlock).toContain('undeletable');
  });
});

// ============================================================================
// 5. Active-assignment uniqueness and history
// ============================================================================

describe('5. active-assignment uniqueness', () => {
  it('one active warehouse assignment per (profile, warehouse)', () => {
    expect(ddlNorm).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS psa_active_warehouse_uniq ON public.profile_scope_assignments (profile_id, warehouse_id) ' +
      "WHERE is_active = true AND scope_type = 'warehouse'",
    );
  });

  it('one active outlet assignment per (profile, distribution_point)', () => {
    expect(ddlNorm).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS psa_active_point_uniq ON public.profile_scope_assignments (profile_id, distribution_point_id) ' +
      "WHERE is_active = true AND scope_type = 'distribution_point'",
    );
  });

  it('multiple DISTINCT active assignments stay legal (the target is in the key)', () => {
    // If the key were (profile_id) alone, one officer could hold only ONE
    // warehouse — the product requires several.
    expect(ddlNorm).toContain('psa_active_warehouse_uniq ON public.profile_scope_assignments (profile_id, warehouse_id)');
    expect(ddlNorm).toContain('psa_active_point_uniq ON public.profile_scope_assignments (profile_id, distribution_point_id)');
  });

  it('revoked history is preserved (both indexes are PARTIAL on is_active)', () => {
    expect(ddlNorm).toContain('psa_active_warehouse_uniq ON public.profile_scope_assignments (profile_id, warehouse_id) WHERE is_active = true');
    expect(ddlNorm).toContain('psa_active_point_uniq ON public.profile_scope_assignments (profile_id, distribution_point_id) WHERE is_active = true');
  });

  it('MUTATION: a total (non-partial) unique index would be caught', () => {
    const broken = ddlNorm.replace(
      "psa_active_warehouse_uniq ON public.profile_scope_assignments (profile_id, warehouse_id) WHERE is_active = true AND scope_type = 'warehouse'",
      'psa_active_warehouse_uniq ON public.profile_scope_assignments (profile_id, warehouse_id)',
    );
    expect(broken).not.toContain('psa_active_warehouse_uniq ON public.profile_scope_assignments (profile_id, warehouse_id) WHERE is_active');
    expect(ddlNorm).toContain('psa_active_warehouse_uniq ON public.profile_scope_assignments (profile_id, warehouse_id) WHERE is_active');
  });

  it('the VERIFY block proves both indexes are unique AND partial', () => {
    expect(verifyBlock).toContain("v_txt ILIKE '%WHERE%is_active%'");
    expect(verifyBlock).toContain('must be PARTIAL on is_active');
  });
});

// ============================================================================
// 6. Organization and target validation
// ============================================================================

describe('6. organization + target validation', () => {
  it('the warehouse target is pinned to the organization by a COMPOSITE FK', () => {
    expect(ddlNorm).toContain(
      'CONSTRAINT psa_warehouse_org_fk FOREIGN KEY (warehouse_id, organization_id) ' +
      'REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT',
    );
  });

  it('the outlet target is pinned to the organization by a COMPOSITE FK', () => {
    expect(ddlNorm).toContain(
      'CONSTRAINT psa_point_org_fk FOREIGN KEY (distribution_point_id, organization_id) ' +
      'REFERENCES public.distribution_points (id, organization_id) ON DELETE RESTRICT',
    );
  });

  it('profile_id cascades; organization_id is retention-safe (RESTRICT, not CASCADE)', () => {
    expect(ddlNorm).toContain('profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE');
    expect(ddlNorm).toContain('organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT');
  });

  it('a fail-closed trigger enforces the profile-organization match', () => {
    const fn = functionBody('phoenix_validate_profile_scope_assignment');
    expect(fn).toContain('SCOPE_ASSIGNMENT_ORG_MISMATCH');
    expect(fn).toContain('v_profile_org IS DISTINCT FROM NEW.organization_id');
    // A profile with no organization can never be assigned a scope.
    expect(fn).toContain('IF v_profile_org IS NULL THEN');
  });

  it('the trigger denies an active assignment to an archived/inactive warehouse', () => {
    const fn = functionBody('phoenix_validate_profile_scope_assignment');
    expect(fn).toContain('SCOPE_ASSIGNMENT_TARGET_INACTIVE');
    expect(fn).toContain("IF v_target_status <> 'active' THEN");
    expect(fn).toContain('an active assignment requires an active warehouse');
  });

  it('the trigger denies an active assignment to an inactive/archived outlet', () => {
    const fn = functionBody('phoenix_validate_profile_scope_assignment');
    expect(fn).toContain('an active assignment requires an active outlet');
  });

  it('the trigger is BEFORE INSERT OR UPDATE, per row', () => {
    expect(ddlNorm).toContain(
      'CREATE TRIGGER trg_validate_profile_scope_assignment BEFORE INSERT OR UPDATE ON public.profile_scope_assignments ' +
      'FOR EACH ROW EXECUTE FUNCTION public.phoenix_validate_profile_scope_assignment()',
    );
  });

  it('the trigger is fail-closed: it raises, and swallows nothing', () => {
    const fn = functionBody('phoenix_validate_profile_scope_assignment');
    expect(fn).not.toMatch(/EXCEPTION\s+WHEN\s+OTHERS/i);
    expect((fn.match(/RAISE EXCEPTION/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('MUTATION: removing the organization validation would be caught', () => {
    const fn = functionBody('phoenix_validate_profile_scope_assignment');
    const broken = fn.split('SCOPE_ASSIGNMENT_ORG_MISMATCH').join('X');
    expect(broken).not.toContain('SCOPE_ASSIGNMENT_ORG_MISMATCH');
    expect(fn).toContain('SCOPE_ASSIGNMENT_ORG_MISMATCH');
    // ...and the VERIFY block would independently catch it in-database.
    expect(verifyBlock).toContain('assignment trigger lost its profile-organization enforcement');
  });

  it('MUTATION: removing the archived-target denial would be caught', () => {
    expect(verifyBlock).toContain('assignment trigger lost its archived/inactive target denial');
  });

  it('MUTATION: a single-column FK would not pin the organization', () => {
    const broken = ddlNorm.replace(
      'CONSTRAINT psa_warehouse_org_fk FOREIGN KEY (warehouse_id, organization_id) REFERENCES public.warehouses (id, organization_id)',
      'CONSTRAINT psa_warehouse_org_fk FOREIGN KEY (warehouse_id) REFERENCES public.warehouses (id)',
    );
    expect(broken).not.toContain('FOREIGN KEY (warehouse_id, organization_id)');
    expect(ddlNorm).toContain('FOREIGN KEY (warehouse_id, organization_id)');
    expect(verifyBlock).toContain('must be composite on organization_id');
  });
});

// ============================================================================
// 7. New permission keys
// ============================================================================

const NEW_KEYS = [
  'users.edit_scope',
  'users.reset_permissions',
  'warehouse_stock.view',
  'warehouse_stock.adjust',
  'warehouse_stock.correct',
  'warehouse_stock.movements_view',
  'reports.view',
  'reports.financial',
  'reports.export',
  'audit.view',
] as const;

describe('7. exact new permission keys', () => {
  it('adds all ten keys, using the migration-010 permission_keys contract', () => {
    expect(ddlSection).toContain(
      'INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES',
    );
    for (const key of NEW_KEYS) {
      expect(ddlSection, `permission key ${key}`).toContain(`('${key}'`);
    }
  });

  it('every new key carries an English and an Arabic label', () => {
    for (const key of NEW_KEYS) {
      const line = ddlSection.split('\n').find(l => l.trim().startsWith(`('${key}'`));
      expect(line, `${key} must be seeded on one line`).toBeDefined();
      const parts = line!.split(',');
      expect(parts.length, `${key} needs 6 columns`).toBeGreaterThanOrEqual(6);
      // label_ar is the 5th column and must contain Arabic script.
      expect(parts[4], `${key} needs an Arabic label`).toMatch(/[؀-ۿ]/);
    }
  });

  it('marks the dangerous keys dangerous and the read keys not', () => {
    const dangerous = ['users.edit_scope', 'users.reset_permissions', 'warehouse_stock.adjust',
      'warehouse_stock.correct', 'reports.financial', 'reports.export'];
    const safe = ['warehouse_stock.view', 'warehouse_stock.movements_view', 'reports.view', 'audit.view'];
    for (const key of dangerous) {
      const line = ddlSection.split('\n').find(l => l.trim().startsWith(`('${key}'`))!;
      expect(line, `${key} should be is_dangerous = true`).toMatch(/,true\),?$/);
    }
    for (const key of safe) {
      const line = ddlSection.split('\n').find(l => l.trim().startsWith(`('${key}'`))!;
      expect(line, `${key} should be is_dangerous = false`).toMatch(/,false\),?$/);
    }
  });

  it('is idempotent and duplicates no existing key', () => {
    expect(ddlSection).toContain('ON CONFLICT (key) DO NOTHING;');
  });

  it('duplicates none of the keys migrations 010-061 already own', () => {
    const existing = [
      'dashboard.view', 'users.view', 'users.create', 'users.assign_role',
      'users.manage_permissions', 'users.disable', 'users.delete', 'users.recycle',
      'warehouses.view', 'warehouses.manage', 'availability.create', 'availability.update',
      'warehouse_dispatch.view', 'warehouse_dispatch.accept',
    ];
    const seeded = ddlSection.slice(
      ddlSection.indexOf('INSERT INTO public.permission_keys'),
      ddlSection.indexOf('ON CONFLICT (key) DO NOTHING;'),
    );
    for (const key of existing) {
      expect(seeded, `${key} must not be re-seeded by 062`).not.toContain(`('${key}',`);
    }
  });

  it('the VERIFY block proves exactly ten new keys exist', () => {
    expect(verifyBlock).toContain('expected exactly 10 new permission keys, found');
    for (const key of NEW_KEYS) {
      expect(verifyBlock, `VERIFY must assert ${key}`).toContain(`'${key}'`);
    }
  });
});

// ============================================================================
// 8. Role default corrections
// ============================================================================

/** The role-defaults INSERT block only. */
const defaultsBlock = ddlSection.slice(
  ddlSection.indexOf('INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES'),
  ddlSection.indexOf('ON CONFLICT (role, permission_key) DO UPDATE SET allowed = excluded.allowed;'),
);
const hasDefault = (role: string, key: string, allowed: boolean): boolean =>
  defaultsBlock.includes(`('${role}','${key}',${allowed})`);

describe('8. warehouse_officer default correction', () => {
  it('warehouses.manage is actively revoked from warehouse_officer', () => {
    expect(norm(ddlSection)).toContain(
      "UPDATE public.role_permission_defaults SET allowed = false WHERE role = 'warehouse_officer' AND permission_key = 'warehouses.manage';",
    );
  });

  it('and is also seeded as an explicit deny (survives a re-run of 010)', () => {
    expect(hasDefault('warehouse_officer', 'warehouses.manage', false)).toBe(true);
    expect(hasDefault('warehouse_officer', 'warehouses.manage', true)).toBe(false);
  });

  it('uses UPDATE, never DELETE, to remove the grant', () => {
    expect(active062).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('warehouse_officer keeps warehouses.view (it must still see its warehouses)', () => {
    // Not re-seeded here: migration 010 already grants it, and 062 does not revoke it.
    expect(defaultsBlock).not.toContain("('warehouse_officer','warehouses.view',false)");
    expect(verifyBlock).toContain('warehouse_officer lost warehouses.view');
  });

  it('grants the precise stock keys instead', () => {
    for (const key of ['warehouse_stock.view', 'warehouse_stock.adjust',
      'warehouse_stock.correct', 'warehouse_stock.movements_view']) {
      expect(hasDefault('warehouse_officer', key, true), `warehouse_officer needs ${key}`).toBe(true);
    }
  });

  it('grants reports.view and audit.view', () => {
    expect(hasDefault('warehouse_officer', 'reports.view', true)).toBe(true);
    expect(hasDefault('warehouse_officer', 'audit.view', true)).toBe(true);
  });

  it('denies reports.financial, reports.export and every users.* key', () => {
    for (const key of ['reports.financial', 'reports.export', 'users.edit_scope', 'users.reset_permissions']) {
      expect(hasDefault('warehouse_officer', key, false), `warehouse_officer must be denied ${key}`).toBe(true);
      expect(hasDefault('warehouse_officer', key, true)).toBe(false);
    }
  });

  it('cannot accept or reject a dispatch (separation of duty)', () => {
    expect(hasDefault('warehouse_officer', 'warehouse_dispatch.accept', false)).toBe(true);
    expect(hasDefault('warehouse_officer', 'warehouse_dispatch.reject', false)).toBe(true);
    expect(hasDefault('warehouse_officer', 'warehouse_dispatch.accept', true)).toBe(false);
    expect(hasDefault('warehouse_officer', 'warehouse_dispatch.reject', true)).toBe(false);
  });

  it('MUTATION: restoring warehouses.manage to warehouse_officer would be caught', () => {
    const broken = defaultsBlock.replace(
      "('warehouse_officer','warehouses.manage',false)",
      "('warehouse_officer','warehouses.manage',true)",
    );
    expect(broken).toContain("('warehouse_officer','warehouses.manage',true)");
    expect(defaultsBlock).not.toContain("('warehouse_officer','warehouses.manage',true)");
    // ...and VERIFY would fail in-database too.
    expect(verifyBlock).toContain('warehouse_officer still holds warehouses.manage by default');
  });

  it('MUTATION: granting accept to warehouse_officer would be caught', () => {
    expect(verifyBlock).toContain('warehouse_officer must never hold ');
    expect(verifyBlock).toContain('a sender that can self-accept');
  });
});

describe('8b. port_officer default package', () => {
  it('has no warehouse-stock permission of any kind', () => {
    for (const key of ['warehouse_stock.view', 'warehouse_stock.adjust',
      'warehouse_stock.correct', 'warehouse_stock.movements_view']) {
      expect(hasDefault('port_officer', key, false), `port_officer must be denied ${key}`).toBe(true);
      expect(hasDefault('port_officer', key, true)).toBe(false);
    }
  });

  it('cannot manage warehouses', () => {
    expect(hasDefault('port_officer', 'warehouses.manage', false)).toBe(true);
  });

  it('cannot create, edit_draft, send or cancel a dispatch', () => {
    for (const key of ['warehouse_dispatch.create', 'warehouse_dispatch.edit_draft',
      'warehouse_dispatch.send', 'warehouse_dispatch.cancel']) {
      expect(hasDefault('port_officer', key, false), `port_officer must be denied ${key}`).toBe(true);
      expect(hasDefault('port_officer', key, true)).toBe(false);
    }
  });

  it('keeps the accept/reject/view/audit package migration 061 granted', () => {
    // 062 must not re-seed or revoke these - 061 owns them.
    for (const key of ['warehouse_dispatch.view', 'warehouse_dispatch.accept',
      'warehouse_dispatch.reject', 'warehouse_dispatch.audit']) {
      expect(hasDefault('port_officer', key, false), `062 must not deny ${key}`).toBe(false);
      expect(verifyBlock).toContain(`'${key}'`);
    }
    expect(verifyBlock).toContain('port_officer must hold ');
  });

  it('keeps the availability permissions its outlet workflow needs', () => {
    expect(defaultsBlock).not.toContain("('port_officer','availability.update',false)");
    expect(verifyBlock).toContain('port_officer lost availability.update');
  });

  it('gets reports.view and audit.view, but not financial/export or users.*', () => {
    expect(hasDefault('port_officer', 'reports.view', true)).toBe(true);
    expect(hasDefault('port_officer', 'audit.view', true)).toBe(true);
    for (const key of ['reports.financial', 'reports.export', 'users.edit_scope', 'users.reset_permissions']) {
      expect(hasDefault('port_officer', key, false), `port_officer must be denied ${key}`).toBe(true);
    }
  });
});

describe('8c. oversight, viewer, super_admin and legacy roles', () => {
  it('institution_admin gets organization-wide oversight of the new keys', () => {
    for (const key of ['warehouse_stock.view', 'warehouse_stock.movements_view',
      'reports.view', 'reports.financial', 'reports.export', 'audit.view',
      'users.edit_scope', 'users.reset_permissions']) {
      expect(hasDefault('institution_admin', key, true), `institution_admin needs ${key}`).toBe(true);
    }
  });

  it('institution_admin gets no stock-write authority (oversight, not data entry)', () => {
    expect(hasDefault('institution_admin', 'warehouse_stock.adjust', false)).toBe(true);
    expect(hasDefault('institution_admin', 'warehouse_stock.correct', false)).toBe(true);
    expect(hasDefault('institution_admin', 'warehouse_stock.adjust', true)).toBe(false);
  });

  it('institution_admin gets no platform-wide bypass', () => {
    expect(defaultsBlock).not.toContain("('institution_admin','organizations.create',true)");
    expect(defaultsBlock).not.toContain("('institution_admin','organizations.archive',true)");
    expect(verifyBlock).toContain('institution_admin gained the platform-level permission');
  });

  it('hospital_admin (legacy oversight) matches institution_admin on the new keys', () => {
    for (const key of ['warehouse_stock.view', 'warehouse_stock.movements_view', 'reports.view', 'audit.view']) {
      expect(hasDefault('hospital_admin', key, true), `hospital_admin needs ${key}`).toBe(true);
    }
    expect(hasDefault('hospital_admin', 'warehouse_stock.adjust', false)).toBe(true);
  });

  it('viewer is read-only: read keys granted, every write/decision key denied', () => {
    for (const key of ['warehouse_stock.view', 'warehouse_stock.movements_view', 'reports.view', 'audit.view']) {
      expect(hasDefault('viewer', key, true), `viewer needs the read key ${key}`).toBe(true);
    }
    for (const key of ['warehouse_stock.adjust', 'warehouse_stock.correct', 'reports.financial',
      'reports.export', 'users.edit_scope', 'users.reset_permissions']) {
      expect(hasDefault('viewer', key, true), `viewer must never hold ${key}`).toBe(false);
      expect(hasDefault('viewer', key, false), `viewer must explicitly deny ${key}`).toBe(true);
    }
  });

  it('viewer receives no dispatch decision or stock-adjustment permission at all', () => {
    expect(verifyBlock).toContain('viewer must never hold the write/decision permission');
  });

  it('super_admin keeps the all-keys seeding convention (010/061 precedent)', () => {
    expect(norm(ddlSection)).toContain(
      "INSERT INTO public.role_permission_defaults (role, permission_key, allowed) SELECT 'super_admin', key, true FROM public.permission_keys ON CONFLICT (role, permission_key) DO NOTHING;",
    );
  });

  it('legacy roles are retained, not removed or renamed', () => {
    // 062 touches no role CHECK at all.
    expect(ddlSection).not.toMatch(/profiles_role_check/);
    expect(active062).not.toMatch(/DROP\s+CONSTRAINT/i);
    // ...and VERIFY proves every role still passes the live CHECK.
    for (const role of ['super_admin', 'institution_admin', 'warehouse_officer', 'port_officer',
      'monthly_status_officer', 'viewer', 'hospital_admin', 'warehouse_manager',
      'point_operator', 'transfer_manager']) {
      expect(verifyBlock, `VERIFY must assert the ${role} role survives`).toContain(`'${role}'`);
    }
    expect(verifyBlock).toContain('062 must not remove or rename any legacy role');
  });

  it('the role-defaults DO UPDATE is confined to the keys 062 owns', () => {
    // DO UPDATE is only safe because every row in this block is one 062 states
    // explicitly; nothing outside the block is touched.
    expect((ddlSection.match(/ON CONFLICT \(role, permission_key\) DO UPDATE/g) ?? []).length).toBe(1);
  });
});

// ============================================================================
// 9. The existing global helper is untouched
// ============================================================================

describe('9. phoenix_profile_has_permission is preserved exactly', () => {
  it('062 never redefines it', () => {
    expect(ddlSection).not.toMatch(/(CREATE|REPLACE)\s+FUNCTION\s+(public\.)?phoenix_profile_has_permission/i);
    expect(ddlSection).not.toMatch(/DROP\s+FUNCTION[^;]*phoenix_profile_has_permission/i);
    expect(ddlSection).not.toMatch(/ALTER\s+FUNCTION[^;]*phoenix_profile_has_permission/i);
  });

  it('062 only CALLS it', () => {
    expect(ddlSection).toContain('phoenix_profile_has_permission(p_profile_id, p_permission_key)');
    expect(ddlSection).toContain("phoenix_profile_has_permission(auth.uid(), 'warehouses.view')");
  });

  it('migration 017 — its authoritative definition — is unmodified on disk', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- supabase/migrations/017_phoenix_permission_rpc_42703_fix.sql', {
        cwd: ROOT, encoding: 'utf8',
      });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('VERIFY proves the live source is normalized-identical to migration 017', () => {
    // The expected string in VERIFY must be migration 017's actual body, so this
    // test derives it from 017 rather than trusting 062's copy of it.
    const m017 = readFileSync(join(MIGRATIONS_DIR, '017_phoenix_permission_rpc_42703_fix.sql'), 'utf8');
    const bodyStart = m017.indexOf('as $$', m017.indexOf('create or replace function phoenix_profile_has_permission'));
    const bodyEnd = m017.indexOf('$$;', bodyStart);
    const body017 = norm(m017.slice(bodyStart + 5, bodyEnd)).trim();

    // Reconstruct the concatenated SQL string literal VERIFY compares against.
    // The literal ends at the first `';` — it cannot stop at the first `;`,
    // because the expected body itself contains `);` near its end.
    const vStart = verifyBlock.indexOf('v_expected :=');
    const vEnd = verifyBlock.indexOf("';", vStart) + 1;
    const expectedLiteral = verifyBlock
      .slice(vStart, vEnd)
      .split("'")
      .filter((_, i) => i % 2 === 1)
      .join('')
      .replace(/''/g, "'");

    expect(expectedLiteral).toBe(body017);
  });

  it('VERIFY also pins its signature, volatility, security and search_path', () => {
    expect(verifyBlock).toContain("v_txt = 'p_profile_id uuid, p_key text'");
    expect(verifyBlock).toContain("p.provolatile = 's'");
    expect(verifyBlock).toContain('p.prosecdef');
    expect(verifyBlock).toContain("proconfig @> ARRAY['search_path=public, pg_temp']");
    expect(verifyBlock).toContain('lost its 017 volatility/security/language/search_path contract');
  });

  it('VERIFY forbids a second overload sneaking in under the same name', () => {
    expect(verifyBlock).toContain('must have exactly one overload, found');
  });

  it('MUTATION: modifying the old helper would be caught', () => {
    const broken = ddlSection + '\ncreate or replace function phoenix_profile_has_permission(p_profile_id uuid, p_key text)\nreturns boolean as $$ select true; $$ language sql;';
    expect(broken).toMatch(/create or replace function phoenix_profile_has_permission/i);
    expect(ddlSection).not.toMatch(/(CREATE|REPLACE)\s+FUNCTION\s+(public\.)?phoenix_profile_has_permission/i);
  });
});

// ============================================================================
// 10. The new scoped helper
// ============================================================================

describe('10. phoenix_profile_has_scoped_permission contract', () => {
  const fn = functionBody('phoenix_profile_has_scoped_permission');

  it('is added with the exact required signature and defaults', () => {
    expect(norm(fn)).toContain(
      'FUNCTION public.phoenix_profile_has_scoped_permission( p_profile_id uuid, p_permission_key text, ' +
      'p_organization_id uuid DEFAULT NULL, p_warehouse_id uuid DEFAULT NULL, p_distribution_point_id uuid DEFAULT NULL )',
    );
    expect(norm(fn)).toContain('RETURNS boolean');
  });

  it('uses the repository secure-function conventions', () => {
    expect(fn).toContain('LANGUAGE plpgsql');
    expect(fn).toContain('STABLE');
    expect(fn).toContain('SECURITY DEFINER');
    expect(fn).toContain('SET search_path = public, pg_temp');
  });

  it('revokes default execution and grants authenticated only — never anon', () => {
    expect(ddlNorm).toContain(
      'REVOKE ALL ON FUNCTION public.phoenix_profile_has_scoped_permission(uuid, text, uuid, uuid, uuid) FROM PUBLIC, anon;',
    );
    expect(ddlNorm).toContain(
      'GRANT EXECUTE ON FUNCTION public.phoenix_profile_has_scoped_permission(uuid, text, uuid, uuid, uuid) TO authenticated;',
    );
    expect(ddlSection).not.toMatch(/GRANT[^;]*phoenix_profile_has_scoped_permission[^;]*TO[^;]*anon/i);
  });

  it('rule 1: returns false for a missing profile or absent key', () => {
    expect(fn).toContain('IF p_profile_id IS NULL OR p_permission_key IS NULL OR btrim(p_permission_key) = \'\' THEN');
    expect(fn).toContain('IF NOT FOUND THEN');
  });

  it('rule 2: returns false for a non-active profile, BEFORE the super_admin branch', () => {
    expect(fn).toContain("IF v_status IS DISTINCT FROM 'active' THEN");
    expect(fn.indexOf("v_status IS DISTINCT FROM 'active'"))
      .toBeLessThan(fn.indexOf("IF v_role = 'super_admin' THEN"));
  });

  it('rule 3: an active super_admin bypasses assignments and overrides', () => {
    expect(fn).toContain("IF v_role = 'super_admin' THEN\n    RETURN true;");
    // It returns before the override/permission evaluation is ever reached.
    expect(fn.indexOf("IF v_role = 'super_admin' THEN"))
      .toBeLessThan(fn.indexOf('phoenix_profile_has_permission(p_profile_id, p_permission_key)'));
  });

  it('rule 4: the requested organization must equal profiles.organization_id', () => {
    expect(fn).toContain('IF p_organization_id IS NULL OR p_organization_id IS DISTINCT FROM v_org THEN');
    expect(fn).toContain('IF v_org IS NULL THEN');
  });

  it('rule 4: the org check precedes the permission check (no override escapes the org)', () => {
    expect(fn.indexOf('p_organization_id IS DISTINCT FROM v_org'))
      .toBeLessThan(fn.indexOf('IF NOT phoenix_profile_has_permission(p_profile_id, p_permission_key) THEN'));
  });

  it('rule 4: the global permission must be true, via the untouched 017 helper', () => {
    expect(fn).toContain('IF NOT phoenix_profile_has_permission(p_profile_id, p_permission_key) THEN\n    RETURN false;');
  });

  it('rule 5: a warehouse target must belong to the org, be active, and be assigned', () => {
    expect(fn).toContain('WHERE w.id = p_warehouse_id');
    expect(fn).toContain('AND w.organization_id = p_organization_id');
    expect(fn).toContain("AND w.status = 'active'");
    expect(fn).toContain('RETURN phoenix_profile_has_warehouse_assignment(p_profile_id, p_warehouse_id);');
  });

  it('rule 6: an outlet target must belong to the org, be active, and be assigned', () => {
    expect(fn).toContain('WHERE d.id = p_distribution_point_id');
    expect(fn).toContain('AND d.organization_id = p_organization_id');
    expect(fn).toContain("AND d.status = 'active'");
    expect(fn).toContain('RETURN phoenix_profile_has_point_assignment(p_profile_id, p_distribution_point_id);');
  });

  it('rule 7: supplying BOTH resource targets fails closed', () => {
    expect(fn).toContain('IF p_warehouse_id IS NOT NULL AND p_distribution_point_id IS NOT NULL THEN\n    RETURN false;');
  });

  it('rule 7: the both-targets check runs before either grant path', () => {
    expect(fn.indexOf('p_warehouse_id IS NOT NULL AND p_distribution_point_id IS NOT NULL'))
      .toBeLessThan(fn.indexOf('RETURN phoenix_profile_has_warehouse_assignment'));
  });

  it('rule 7: the two targets are never OR-ed into a broader grant', () => {
    expect(fn).not.toContain('p_warehouse_id IS NOT NULL OR p_distribution_point_id IS NOT NULL');
  });

  it('rule 8: a NULL target is not global access — operational roles fail closed', () => {
    expect(fn).toContain('RETURN v_role = ANY (v_org_wide_roles);');
    const orgWide = fn.slice(fn.indexOf('v_org_wide_roles text[] :='), fn.indexOf('BEGIN'));
    expect(orgWide).toContain("'institution_admin'");
    expect(orgWide).toContain("'hospital_admin'");
    expect(orgWide).toContain("'monthly_status_officer'");
    expect(orgWide).toContain("'viewer'");
    // The operational roles are deliberately absent from the org-wide list.
    expect(orgWide).not.toContain("'warehouse_officer'");
    expect(orgWide).not.toContain("'port_officer'");
    expect(orgWide).not.toContain("'point_operator'");
    expect(orgWide).not.toContain("'warehouse_manager'");
    expect(orgWide).not.toContain("'transfer_manager'");
    expect(orgWide).not.toContain("'super_admin'");
  });

  it('never swallows an error', () => {
    expect(fn).not.toMatch(/EXCEPTION\s+WHEN\s+OTHERS/i);
  });

  it('VERIFY proves it fails closed, by calling it for real', () => {
    expect(verifyBlock).toContain("phoenix_profile_has_scoped_permission(NULL, 'warehouse_stock.view') = false");
    expect(verifyBlock).toContain('must return false for a non-existent profile');
    expect(verifyBlock).toContain('must return false for a NULL permission key');
    expect(verifyBlock).toContain('must return false for an empty permission key');
  });

  it('VERIFY proves active-profile, super-admin, org-isolation and assignment rules against real rows', () => {
    // NOTE: these messages are split across concatenated SQL string literals in
    // the migration, so each assertion matches one contiguous fragment.
    expect(verifyBlock).toContain('pair(s) cross the organization ');
    expect(verifyBlock).toContain('operational-role profile(s) were authorized with no ');
    expect(verifyBlock).toContain('is not delegating to phoenix_profile_has_permission');
    expect(verifyBlock).toContain("p.role IN ('warehouse_officer','port_officer')");
  });

  it('VERIFY proves no non-super-admin override crosses the org', () => {
    expect(verifyBlock).toContain("override(s) cross profiles.organization_id");
  });

  it('MUTATION: removing the warehouse assignment requirement would be caught', () => {
    const broken = fn.replace(
      'RETURN phoenix_profile_has_warehouse_assignment(p_profile_id, p_warehouse_id);',
      'RETURN true;',
    );
    expect(broken).not.toContain('RETURN phoenix_profile_has_warehouse_assignment(p_profile_id, p_warehouse_id);');
    expect(fn).toContain('RETURN phoenix_profile_has_warehouse_assignment(p_profile_id, p_warehouse_id);');
    expect(verifyBlock).toContain('scoped helper lost its assignment requirement');
  });

  it('MUTATION: removing the outlet assignment requirement would be caught', () => {
    const broken = fn.replace(
      'RETURN phoenix_profile_has_point_assignment(p_profile_id, p_distribution_point_id);',
      'RETURN true;',
    );
    expect(broken).not.toContain('RETURN phoenix_profile_has_point_assignment(p_profile_id, p_distribution_point_id);');
    expect(fn).toContain('RETURN phoenix_profile_has_point_assignment(p_profile_id, p_distribution_point_id);');
  });

  it('MUTATION: turning the both-targets rule into an OR would be caught', () => {
    const broken = fn.replace(
      'IF p_warehouse_id IS NOT NULL AND p_distribution_point_id IS NOT NULL THEN',
      'IF p_warehouse_id IS NOT NULL OR p_distribution_point_id IS NOT NULL THEN',
    );
    expect(broken).toContain('p_warehouse_id IS NOT NULL OR p_distribution_point_id IS NOT NULL');
    expect(fn).not.toContain('p_warehouse_id IS NOT NULL OR p_distribution_point_id IS NOT NULL');
    expect(verifyBlock).toContain('scoped helper lost its both-targets fail-closed rule');
  });

  it('MUTATION: dropping the active-profile requirement would be caught', () => {
    expect(verifyBlock).toContain('scoped helper lost its active-profile requirement');
  });
});

describe('10b. the assignment predicates', () => {
  for (const name of ['phoenix_profile_has_warehouse_assignment', 'phoenix_profile_has_point_assignment']) {
    it(`${name}: requires an ACTIVE assignment, active profile, active target and org ownership`, () => {
      const fn = norm(functionBody(name));
      const scope = name.includes('point') ? 'distribution_point' : 'warehouse';
      expect(fn).toContain('a.is_active = true');
      expect(fn).toContain(`a.scope_type = '${scope}'`);
      // the profile must be active...
      expect(fn).toContain("p.status = 'active'");
      // ...and so must the target row.
      expect(fn).toContain('a.organization_id = p.organization_id');
    });

    it(`${name}: is STABLE, SECURITY DEFINER, with a pinned search_path`, () => {
      const fn = functionBody(name);
      expect(fn).toContain('LANGUAGE sql');
      expect(fn).toContain('STABLE');
      expect(fn).toContain('SECURITY DEFINER');
      expect(fn).toContain('SET search_path = public, pg_temp');
    });

    it(`${name}: returns a boolean only (exposes no cross-organization identifier)`, () => {
      const fn = functionBody(name);
      expect(fn).toContain('RETURNS boolean');
      expect(fn).toContain('SELECT EXISTS (');
    });

    it(`${name}: grants authenticated only, never anon`, () => {
      expect(ddlSection).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(uuid, uuid\\)\\s+FROM PUBLIC, anon;`));
      expect(ddlSection).not.toMatch(new RegExp(`GRANT[^;]*${name}[^;]*TO[^;]*anon`, 'i'));
    });
  }

  it('a warehouse assignment can never satisfy the outlet predicate, and vice versa', () => {
    expect(norm(functionBody('phoenix_profile_has_warehouse_assignment')))
      .toContain("a.scope_type = 'warehouse'");
    expect(norm(functionBody('phoenix_profile_has_point_assignment')))
      .toContain("a.scope_type = 'distribution_point'");
  });

  it('VERIFY proves both fail closed on NULL', () => {
    expect(verifyBlock).toContain('phoenix_profile_has_warehouse_assignment(NULL, NULL) = false');
    expect(verifyBlock).toContain('phoenix_profile_has_point_assignment(NULL, NULL) = false');
  });

  it('VERIFY proves anon holds EXECUTE on none of the three new functions', () => {
    expect(verifyBlock).toContain("anon holds EXECUTE on ");
  });
});

// ============================================================================
// 11. Policy replacements
// ============================================================================

const ORG_WIDE = "phoenix_my_role() IN ('institution_admin','hospital_admin','monthly_status_officer','viewer')";

describe('11. warehouse / stock / movement policies are scope-aware', () => {
  it('replaces exactly the three 060 SELECT policies', () => {
    for (const p of ['wh_select_perm', 'warehouse_stock_select_perm', 'warehouse_stock_mov_select_perm']) {
      expect(ddlSection, `${p} must be dropped`).toContain(`DROP POLICY IF EXISTS "${p}"`);
    }
  });

  it('leaves 060 write policies alone (SELECT-only replacement)', () => {
    expect(ddlSection).not.toContain('wh_insert_perm');
    expect(ddlSection).not.toContain('wh_update_perm');
    expect(verifyBlock).toContain('062 replaces SELECT only');
  });

  it('warehouses: super_admin sees all; officers see only assigned warehouses', () => {
    const p = policyBody('wh_select_scoped');
    expect(p).toContain("phoenix_my_role() = 'super_admin'");
    expect(p).toContain('organization_id = phoenix_my_org()');
    expect(p).toContain("phoenix_profile_has_permission(auth.uid(), 'warehouses.view')");
    expect(p).toContain('phoenix_profile_has_warehouse_assignment(auth.uid(), id)');
    expect(p).toContain(ORG_WIDE);
  });

  it('warehouses: port_officer only via a named dispatch context, never org-wide', () => {
    const p = policyBody('wh_select_scoped');
    expect(p).toContain("phoenix_my_role() = 'port_officer'");
    expect(p).toContain('FROM public.warehouse_dispatches d');
    expect(p).toContain('phoenix_profile_has_point_assignment(auth.uid(), d.destination_distribution_point_id)');
    // port_officer is NOT in the org-wide compatibility list.
    expect(ORG_WIDE).not.toContain('port_officer');
  });

  it('warehouse_stock: gated on its own new key, scoped by assignment', () => {
    const p = policyBody('warehouse_stock_select_scoped');
    expect(p).toContain("phoenix_profile_has_permission(auth.uid(), 'warehouse_stock.view')");
    expect(p).toContain('phoenix_profile_has_warehouse_assignment(auth.uid(), warehouse_id)');
    expect(p).toContain('organization_id = phoenix_my_org()');
  });

  it('warehouse_stock_movements: gated on warehouse_stock.movements_view, scoped by assignment', () => {
    const p = policyBody('warehouse_stock_mov_select_scoped');
    expect(p).toContain("phoenix_profile_has_permission(auth.uid(), 'warehouse_stock.movements_view')");
    expect(p).toContain('phoenix_profile_has_warehouse_assignment(auth.uid(), warehouse_id)');
  });

  it('port_officer gets no warehouse-stock or movement visibility (denied twice)', () => {
    // 1. no key...
    expect(hasDefault('port_officer', 'warehouse_stock.view', false)).toBe(true);
    expect(hasDefault('port_officer', 'warehouse_stock.movements_view', false)).toBe(true);
    // 2. ...and no branch that could match it.
    for (const name of ['warehouse_stock_select_scoped', 'warehouse_stock_mov_select_scoped']) {
      expect(policyBody(name)).not.toContain('port_officer');
    }
  });

  it('keeps direct warehouse-stock writes denied', () => {
    expect(ddlSection).not.toMatch(/CREATE POLICY[^;]*ON public\.warehouse_stock\b[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/i);
    expect(verifyBlock).toContain('authenticated holds a direct write grant on ');
    expect(verifyBlock).toContain('a direct write policy exists on ');
  });

  it('documents that future stock RPCs must call the scoped helper', () => {
    expect(m062).toContain('phoenix_profile_has_scoped_permission(..., p_warehouse_id => <the warehouse>)');
  });

  it('MUTATION: dropping the assignment test from a stock policy would be caught', () => {
    const p = policyBody('warehouse_stock_select_scoped');
    const broken = p.replace('OR phoenix_profile_has_warehouse_assignment(auth.uid(), warehouse_id)', '');
    expect(broken).not.toContain('phoenix_profile_has_warehouse_assignment');
    expect(p).toContain('phoenix_profile_has_warehouse_assignment');
    expect(verifyBlock).toContain('warehouse_stock_select_scoped is not assignment-scoped');
  });
});

describe('12. dispatch policies are scope-aware', () => {
  it('replaces exactly the two 061 SELECT policies', () => {
    for (const p of ['warehouse_dispatches_select_perm', 'warehouse_dispatch_lines_select_perm']) {
      expect(ddlSection, `${p} must be dropped`).toContain(`DROP POLICY IF EXISTS "${p}"`);
    }
  });

  it('header: warehouse_officer scoped to its assigned source warehouse', () => {
    const p = policyBody('warehouse_dispatches_select_scoped');
    expect(p).toContain("phoenix_my_role() = 'warehouse_officer' AND phoenix_profile_has_warehouse_assignment(auth.uid(), warehouse_id)");
    expect(p).toContain("phoenix_profile_has_permission(auth.uid(), 'warehouse_dispatch.view')");
    expect(p).toContain('organization_id = phoenix_my_org()');
  });

  it('header: port_officer scoped to its assigned destination outlet', () => {
    const p = policyBody('warehouse_dispatches_select_scoped');
    expect(p).toContain("phoenix_my_role() = 'port_officer' AND phoenix_profile_has_point_assignment(auth.uid(), destination_distribution_point_id)");
  });

  it('header: super_admin all; oversight and viewer organization-wide; anon nothing', () => {
    const p = policyBody('warehouse_dispatches_select_scoped');
    expect(p).toContain("phoenix_my_role() = 'super_admin'");
    expect(p).toContain(ORG_WIDE);
    expect(p).toContain('TO authenticated');
    expect(p).not.toContain('anon');
  });

  it('lines: visibility derives through the dispatch header', () => {
    const p = policyBody('warehouse_dispatch_lines_select_scoped');
    expect(p).toContain('EXISTS ( SELECT 1 FROM public.warehouse_dispatches d WHERE d.id = warehouse_dispatch_lines.dispatch_id');
  });

  it('lines: repeat the header predicate exactly, on the HEADER columns', () => {
    const p = policyBody('warehouse_dispatch_lines_select_scoped');
    expect(p).toContain('d.organization_id = phoenix_my_org()');
    expect(p).toContain('phoenix_profile_has_warehouse_assignment(auth.uid(), d.warehouse_id)');
    expect(p).toContain('phoenix_profile_has_point_assignment(auth.uid(), d.destination_distribution_point_id)');
    expect(p).toContain(ORG_WIDE);
  });

  it('lines: never trust warehouse_dispatch_lines.organization_id alone', () => {
    const p = policyBody('warehouse_dispatch_lines_select_scoped');
    // Every org test in this policy is on the header alias `d`, never bare.
    expect(p).not.toMatch(/\(organization_id = phoenix_my_org\(\)\)/);
    expect(p).not.toMatch(/[^.]\borganization_id = phoenix_my_org\(\)/);
    expect(verifyBlock).toContain('visibility must derive through the dispatch header');
  });

  it('keeps direct dispatch writes denied', () => {
    expect(ddlSection).not.toMatch(/CREATE POLICY[^;]*ON public\.warehouse_dispatch(es|_lines)\b[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/i);
  });

  it('MUTATION: a line policy trusting its own organization_id would be caught', () => {
    const p = policyBody('warehouse_dispatch_lines_select_scoped');
    const broken = p.replace('d.organization_id = phoenix_my_org()', 'organization_id = phoenix_my_org()');
    expect(broken).toMatch(/[^.]\borganization_id = phoenix_my_org\(\)/);
    expect(p).not.toMatch(/[^.]\borganization_id = phoenix_my_org\(\)/);
  });

  it('MUTATION: a line policy that stops deriving through the header would be caught', () => {
    const p = policyBody('warehouse_dispatch_lines_select_scoped');
    const broken = p.replace(/EXISTS \( SELECT 1 FROM public\.warehouse_dispatches d/, 'true AND (');
    expect(broken).not.toContain('FROM public.warehouse_dispatches d');
    expect(p).toContain('FROM public.warehouse_dispatches d');
    expect(verifyBlock).toContain('dispatch line policy does not reference the header table');
    expect(verifyBlock).toContain('must derive visibility via EXISTS on the header');
  });
});

describe('13. assignment-table RLS', () => {
  it('RLS is enabled', () => {
    expect(ddlSection).toContain('ALTER TABLE public.profile_scope_assignments ENABLE ROW LEVEL SECURITY;');
  });

  it('super_admin reads all', () => {
    expect(policyBody('psa_select_scoped')).toContain("phoenix_my_role() = 'super_admin'");
  });

  it('an ordinary officer reads only its OWN ACTIVE assignments', () => {
    expect(policyBody('psa_select_scoped')).toContain('(profile_id = auth.uid() AND is_active = true)');
  });

  it('org user-managers read their own organization only, gated on users.view', () => {
    const p = policyBody('psa_select_scoped');
    expect(p).toContain('organization_id = phoenix_my_org()');
    expect(p).toContain("phoenix_my_role() IN ('institution_admin', 'hospital_admin')");
    expect(p).toContain("phoenix_profile_has_permission(auth.uid(), 'users.view')");
  });

  it('an ordinary officer cannot enumerate other users assignments', () => {
    const p = policyBody('psa_select_scoped');
    // The only unqualified branch is the own-row one.
    expect(p).not.toMatch(/USING \( true \)/);
    expect(p).toContain('profile_id = auth.uid()');
  });

  it('no direct authenticated write: no write policy, no write grant', () => {
    expect(ddlSection).not.toMatch(/CREATE POLICY[^;]*ON public\.profile_scope_assignments[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/i);
    expect(ddlSection).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.profile_scope_assignments FROM authenticated;');
  });

  it('revokes all from PUBLIC and anon; no anonymous policy or grant', () => {
    expect(ddlSection).toContain('REVOKE ALL ON TABLE public.profile_scope_assignments FROM PUBLIC, anon;');
    expect(ddlSection).toContain('GRANT SELECT ON TABLE public.profile_scope_assignments TO authenticated;');
    expect(policyBody('psa_select_scoped')).toContain('TO authenticated');
    expect(policyBody('psa_select_scoped')).not.toContain('anon');
  });

  it('MUTATION: adding anon access would be caught', () => {
    const broken = ddlSection.replace(
      'GRANT SELECT ON TABLE public.profile_scope_assignments TO authenticated;',
      'GRANT SELECT ON TABLE public.profile_scope_assignments TO authenticated, anon;',
    );
    expect(broken).toContain('TO authenticated, anon;');
    expect(ddlSection).not.toContain('TO authenticated, anon;');
    expect(verifyBlock).toContain('anon holds a privilege on ');
    expect(verifyBlock).toContain('policy/policies grant the anon role access');
  });

  it('VERIFY proves no anon privilege on any table in the domain', () => {
    expect(verifyBlock).toContain("AND grantee = 'anon'");
    expect(verifyBlock).toContain("'anon' = ANY (roles)");
  });
});

// ============================================================================
// 14. Last super-admin protection
// ============================================================================

describe('14. last-super-admin trigger', () => {
  const fn = functionBody('phoenix_protect_last_super_admin');

  it('is named trg_protect_last_super_admin and runs BEFORE UPDATE OR DELETE on profiles', () => {
    expect(ddlNorm).toContain(
      'CREATE TRIGGER trg_protect_last_super_admin BEFORE UPDATE OR DELETE ON public.profiles ' +
      'FOR EACH ROW EXECUTE FUNCTION public.phoenix_protect_last_super_admin()',
    );
  });

  it('acquires a transaction-scoped advisory lock before evaluating', () => {
    expect(fn).toContain('PERFORM pg_advisory_xact_lock(778062062);');
    expect(fn).not.toContain('pg_advisory_lock(');
    // The lock must precede both counts.
    expect(fn.indexOf('pg_advisory_xact_lock')).toBeLessThan(fn.indexOf('SELECT count(*) INTO v_other_admins'));
  });

  it('uses a stable application-specific key, documented as such', () => {
    expect(m062).toContain('stable application-specific constant');
    expect(m062).toContain('778062062');
  });

  it('protects DELETION of the last active super_admin', () => {
    expect(norm(fn)).toContain("v_is_delete boolean := (TG_OP = 'DELETE')");
    expect(fn).toContain('v_loses_admin := v_is_delete');
  });

  it('protects DEMOTION (role away from super_admin)', () => {
    expect(fn).toContain("OR NEW.role   IS DISTINCT FROM 'super_admin'");
  });

  it('protects DISABLING (status away from active)', () => {
    expect(fn).toContain("OR NEW.status IS DISTINCT FROM 'active'");
  });

  it('protects ORGANIZATION SCOPING of the last platform-global admin', () => {
    expect(fn).toContain('v_scopes_admin := (NOT v_is_delete)');
    expect(fn).toContain('AND OLD.organization_id IS NULL');
    expect(fn).toContain('AND NEW.organization_id IS NOT NULL');
    expect(fn).toContain('AND p.organization_id IS NULL');
  });

  it('raises the stable machine-readable token', () => {
    expect((fn.match(/LAST_SUPER_ADMIN_PROTECTED/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(fn).toContain("USING ERRCODE = '42501'");
  });

  it('exactly one active super_admin remains a valid, protected state', () => {
    expect(fn).toContain('IF v_other_admins < 1 THEN');
    expect(fn).toContain('IF v_other_global < 1 THEN');
    // `< 1`, never `< 2`: the trigger protects the last admin, it does not demand a second.
    expect(fn).not.toContain('v_other_admins < 2');
    expect(verifyBlock).toContain('no active super_admin exists');
  });

  it('two concurrent administrators cannot leave zero (the count excludes self, under the lock)', () => {
    expect(fn).toContain('WHERE p.id <> OLD.id');
    expect(fn).toContain("AND p.role   = 'super_admin'");
    expect(fn).toContain("AND p.status = 'active'");
    expect(m062).toContain('would each COUNT the other');
  });

  it('normal non-super-admin updates are unaffected and take no lock', () => {
    expect(fn).toContain("IF OLD.role IS DISTINCT FROM 'super_admin' OR OLD.status IS DISTINCT FROM 'active' THEN");
    // The early return precedes the lock.
    expect(fn.indexOf("IF OLD.role IS DISTINCT FROM 'super_admin'"))
      .toBeLessThan(fn.indexOf('pg_advisory_xact_lock'));
    // An ordinary edit to a super_admin row also returns before the lock.
    expect(fn).toContain('IF NOT v_loses_admin AND NOT v_scopes_admin THEN\n    RETURN NEW;');
  });

  it('service_role cannot bypass it, and the Edge check is not relied upon', () => {
    expect(m062).toContain('including service_role');
    expect(m062).toContain('service_role is not one');
    // The migration states explicitly why the Edge check alone is insufficient.
    expect(m062).toContain('demonstrably not sufficient');
    expect(m062).toContain('It does not cover DEMOTION at all');
    expect(ddlSection).not.toMatch(/DISABLE\s+TRIGGER/i);
    expect(verifyBlock).toContain('is not enabled (tgenabled = ');
  });

  it('the Edge Function is left unchanged by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff --name-only -- supabase/functions', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('actor deletion retention is not broken (profiles cascade from auth.users still works)', () => {
    // The trigger fires ON the cascade, but only for an active super_admin — every
    // other user deletion passes straight through.
    expect(m062).toContain('ON DELETE CASCADE (001)');
    expect(fn).toContain('IF v_is_delete THEN RETURN OLD; END IF;');
  });

  it('never swallows an error', () => {
    expect(fn).not.toMatch(/EXCEPTION\s+WHEN\s+OTHERS/i);
  });

  it('MUTATION: losing the advisory lock would be caught', () => {
    const broken = fn.replace('PERFORM pg_advisory_xact_lock(778062062);', '');
    expect(broken).not.toContain('pg_advisory_xact_lock');
    expect(fn).toContain('pg_advisory_xact_lock(778062062)');
    expect(verifyBlock).toContain('the trigger must take pg_advisory_xact_lock(778062062) before counting');
  });

  it('MUTATION: omitting demotion would be caught', () => {
    const broken = fn.replace("OR NEW.role   IS DISTINCT FROM 'super_admin'\n", '');
    expect(broken).not.toContain("OR NEW.role   IS DISTINCT FROM 'super_admin'");
    expect(fn).toContain("OR NEW.role   IS DISTINCT FROM 'super_admin'");
    expect(verifyBlock).toContain('the trigger does not cover DEMOTION');
  });

  it('MUTATION: an AFTER trigger (observing instead of preventing) would be caught', () => {
    expect(verifyBlock).toContain('must be BEFORE');
    expect(verifyBlock).toContain('an AFTER trigger observes ');
  });

  it('VERIFY checks the trigger timing/events via pg_trigger.tgtype bits', () => {
    expect(verifyBlock).toContain('(v_cnt & 1) = 1');
    expect(verifyBlock).toContain('(v_cnt & 16) = 16');
    expect(verifyBlock).toContain('(v_cnt & 8) = 8');
  });

  it('VERIFY proves the stable token exists', () => {
    expect(verifyBlock).toContain("v_src LIKE '%LAST_SUPER_ADMIN_PROTECTED%'");
    expect(verifyBlock).toContain('the stable error token LAST_SUPER_ADMIN_PROTECTED is missing');
  });
});

// ============================================================================
// 15. profile_permission_overrides safety
// ============================================================================

describe('15. profile_permission_overrides', () => {
  it('the PRIMARY KEY is not changed', () => {
    expect(ddlSection).not.toMatch(/ALTER TABLE[^;]*profile_permission_overrides[^;]*(DROP|ADD)\s+CONSTRAINT[^;]*PRIMARY KEY/i);
    expect(ddlSection).not.toMatch(/PRIMARY KEY \(profile_id, permission_key, /i);
    expect(verifyBlock).toContain("v_txt = 'PRIMARY KEY (profile_id, permission_key)'");
    expect(verifyBlock).toContain('profile_permission_overrides PRIMARY KEY changed');
  });

  it('the three-state model is preserved (allowed stays nullable)', () => {
    expect(ddlSection).not.toMatch(/ALTER TABLE[^;]*profile_permission_overrides[^;]*allowed[^;]*SET NOT NULL/i);
    expect(verifyBlock).toContain('profile_permission_overrides.allowed must stay nullable');
    expect(verifyBlock).toContain('"inherit the role default" state of the three-state model');
  });

  it('role defaults are never copied into override rows', () => {
    expect(ddlSection).not.toMatch(/INSERT INTO public\.profile_permission_overrides/i);
    expect(m062).toContain('Role defaults are never copied');
  });

  it('override scope columns are not used as assignment rows', () => {
    expect(m062).toContain('This table is NOT an assignment ledger');
  });

  it('adds at-most-one-resource-scope, backed by a precheck', () => {
    expect(ddlNorm).toContain(
      'ADD CONSTRAINT ppo_single_resource_scope_chk CHECK (num_nonnulls(scope_warehouse_id, scope_point_id) <= 1)',
    );
    expect(ddlSection).toContain('both a warehouse and a distribution point');
  });

  it('pins a scoped resource to scope_organization_id with composite FKs', () => {
    expect(ddlNorm).toContain(
      'ADD CONSTRAINT ppo_scope_warehouse_org_fk FOREIGN KEY (scope_warehouse_id, scope_organization_id) ' +
      'REFERENCES public.warehouses (id, organization_id)',
    );
    expect(ddlNorm).toContain(
      'ADD CONSTRAINT ppo_scope_point_org_fk FOREIGN KEY (scope_point_id, scope_organization_id) ' +
      'REFERENCES public.distribution_points (id, organization_id)',
    );
  });

  it('blocks a non-super-admin override from crossing profiles.organization_id', () => {
    const fn = functionBody('phoenix_validate_ppo_scope');
    expect(fn).toContain('PPO_SCOPE_ORG_MISMATCH');
    expect(fn).toContain('IF NEW.scope_organization_id IS DISTINCT FROM v_org THEN');
    expect(fn).toContain("IF v_role = 'super_admin' THEN");
    // Unscoped overrides (everything 017 writes) are untouched.
    expect(fn).toContain('IF NEW.scope_organization_id IS NULL THEN\n    RETURN NEW;');
  });

  it('uses a precheck/VERIFY strategy for apply-time readiness (no DB connection allowed)', () => {
    expect((ddlSection.match(/VERIFY FAILED \(062 precheck\)/g) ?? []).length).toBe(3);
    expect(ddlSection).toContain('Migration 062 has rolled back');
    expect(m062).toContain('APPLY-TIME READINESS');
  });

  it('every precheck is fail-closed (ASSERT, no handler)', () => {
    // Anchored on executable SQL, not comment text — activeSql strips comments.
    const g = ddlSection.slice(
      ddlSection.indexOf('v_bad int;'),
      ddlSection.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_validate_ppo_scope'),
    );
    expect(g).not.toMatch(/EXCEPTION\s+WHEN\s+OTHERS/i);
    expect((g.match(/ASSERT v_bad = 0/g) ?? []).length).toBe(3);
    expect((ddlSection.match(/VERIFY FAILED \(062 precheck\)/g) ?? []).length).toBe(3);
  });

  it('017 permission RPCs keep working (VERIFY asserts they still exist)', () => {
    for (const f of ['assign_profile_permissions', 'reset_profile_permissions', 'get_effective_permissions']) {
      expect(verifyBlock).toContain(`'${f}'`);
    }
  });
});

// ============================================================================
// 16. Isolation + safety
// ============================================================================

describe('16. isolation: untouched domains', () => {
  it('migration 061 is unmodified on disk', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- supabase/migrations/061_phoenix_warehouse_dispatch_schema.sql', {
        cwd: ROOT, encoding: 'utf8',
      });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('migration 060 is unmodified on disk', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- supabase/migrations/060_phoenix_warehouse_foundation.sql', {
        cwd: ROOT, encoding: 'utf8',
      });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('migrations 001-061 are all unmodified on disk', () => {
    let diff = '';
    try {
      // Scoped to the SQL files themselves: the reviewed-migration registry under
      // __tests__/ IS legitimately modified by this phase (it registers 062).
      diff = execSync('git diff --name-only -- supabase/migrations/*.sql', {
        cwd: ROOT, encoding: 'utf8',
      });
    } catch { /* ignore */ }
    // 062 is new/untracked, so it never appears in a tracked-file diff.
    expect(diff.trim()).toBe('');
  });

  it('no product, runtime or UI code is modified', () => {
    let diff = '';
    try {
      // PROFILE-IDENTITY-SNAPSHOT-RETURN-TYPE-064-A: scoped to product code.
      // Test-maintenance files are excluded because they are not product,
      // runtime, or UI code — this guard's stated subject. supabase/functions
      // and package.json stay fully covered, as does every shippable file under
      // src/ (components, hooks, stores, services, pages, lib).
      // PHASE-A-A5-INSTITUTIONS-OUTLETS-A: a later, separately-reviewed phase
      // applies presentation-only className/data-attribute hooks (Phase A
      // design layer, no business-logic change) across the Institution and
      // Outlet Operations surfaces plus the shared entry point — excluded here.
      // PHASE-A-CLAUDE-A6: a still later, separately-reviewed phase applies
      // the same kind of presentation-only className/data-attribute hooks
      // (phase-a-alerts-admin-qr.css) to Status Center / User Administration /
      // Platform Broadcast / Availability Cleanup / Public QR — excluded here.
      // PHASE-A-CLAUDE-A7: a still later, separately-reviewed phase (Phoenix
      // Daylight visual convergence) applies the same kind of presentation-
      // only token/data-attribute recolouring — never a prop, handler, or RPC
      // change — to PhoenixSidebar/PhoenixMobileDrawer (nav active state moved
      // from an inline style to a CSS data-active selector), ResetPassword
      // Screen (primary-button recolour), and PhoenixButton/PhoenixMobile
      // BottomNav/PhoenixStatusBadge (gold primary, teal secondary, dedicated
      // info-blue) — excluded here.
      diff = execSync(
        // R1.1-P: a still later, separately-reviewed phase (health-sector facility
        // parity) routes every navigation surface through ONE shared projection,
        // pins initial provisioning to the selected outlet's paired owning
        // warehouse, and adds the grouping/corridor UI strings. Presentation and
        // projection only — no schema, RLS, RPC or workflow change — excluded
        // here BY EXACT NAME; every other product path stays watched.
        'git diff --name-only -- src supabase/functions package.json ":(exclude)src/**/__tests__/**" '
        + '":(exclude)src/shared/ui/CommandPalette.tsx" ":(exclude)src/features/outlet/EmergencyReplenishmentTab.tsx" ":(exclude)src/features/outlet/InitialProvisioningLauncher.tsx" ":(exclude)src/shared/i18n/strings.ts" ' +
        '":(exclude)src/features/institutions/InstitutionScreen.tsx" ' +
        '":(exclude)src/features/institutions/AvailabilityItemDetailsModal.tsx" ' +
        '":(exclude)src/features/outlet/OutletOperationsScreen.tsx" ' +
        '":(exclude)src/features/outlet/OutletIncomingSupplies.tsx" ' +
        '":(exclude)src/features/outlet/OutletReturnComposer.tsx" ' +
        '":(exclude)src/features/outlet/OutletStockCorrectionModal.tsx" ' +
        '":(exclude)src/features/outlet/DispenseComposerDialog.tsx" ' +
        '":(exclude)src/features/outlet/DispenseContextDialog.tsx" ' +
        // STAGE-F-PATIENT-DISPENSING-172: the Stage-F card/chart type and
        // submit payload live beside the dialog already excluded above.
        // Named exactly — this guard still catches any OTHER product file.
        '":(exclude)src/features/outlet/dispense-context.service.ts" ' +
        '":(exclude)src/features/outlet/DispenseContextViewer.tsx" ' +
        '":(exclude)src/features/outlet/CurrentMovementStatus.tsx" ' +
        '":(exclude)src/features/status/StatusCenterScreen.tsx" ' +
        '":(exclude)src/features/status/InternalAlertsSection.tsx" ' +
        '":(exclude)src/features/status/OutletMaterialGroups.tsx" ' +
        '":(exclude)src/features/users/UserManagementScreen.tsx" ' +
        '":(exclude)src/features/platform-broadcast/PlatformBroadcastAdminPanel.tsx" ' +
        '":(exclude)src/features/platform-broadcast/PlatformBroadcastGate.tsx" ' +
        '":(exclude)src/features/admin/AvailabilityCleanupWizard.tsx" ' +
        '":(exclude)src/features/qr/PublicQrScreen.tsx" ' +
        '":(exclude)src/main.tsx" ' +
        '":(exclude)src/shared/ui/PhoenixSidebar.tsx" ' +
        '":(exclude)src/shared/ui/PhoenixMobileDrawer.tsx" ' +
        '":(exclude)src/shared/ui/PhoenixButton.tsx" ' +
        '":(exclude)src/shared/ui/PhoenixMobileBottomNav.tsx" ' +
        '":(exclude)src/shared/ui/PhoenixStatusBadge.tsx" ' +
        '":(exclude)src/features/auth/ResetPasswordScreen.tsx" ' +
        // PHASE-A-CLAUDE-A7.1: a still later, separately-reviewed phase (A7.1
        // visual acceptance closure) finishes converting the last hardcoded
        // hex literals it found repo-wide to Phoenix tokens — never a prop,
        // handler, or RPC change — see hardcoded-colour-allowlist.md.
        '":(exclude)src/features/alerts/materialAlertEngine.ts" ' +
        '":(exclude)src/shared/ui/NotificationBell.tsx" ' +
        '":(exclude)src/shared/ui/WhatsAppContactButton.tsx" ' +
        '":(exclude)src/features/network/NetworkManagementScreen.tsx" ' +
        '":(exclude)src/features/network/DirectSupplyOperations.tsx" ' +
        '":(exclude)src/features/outlet/OutletDispatchOperations.tsx" ' +
        '":(exclude)src/features/procurement/DirectEntryPanel.tsx" ' +
        '":(exclude)src/features/reports/ReportsScreen.tsx" ' +
        '":(exclude)src/shared/lib/phase-a-visual-convergence.css" ' +
        '":(exclude)src/shared/lib/phoenix-nexus.css" ' +
        '":(exclude)src/shared/lib/tokens.css" ' +
        // PHASE-A-CLAUDE-A7.2: a still later, separately-reviewed phase
        // (Premium Living Auth & Welcome) retires the photographic Phoenix-
        // bird hero on both auth screens for an original inline-SVG supply-
        // network illustration — never a handler, session, or RPC change —
        // and flips AppContext's in-memory theme default to light-first
        // (no persistence key exists or is added; same structure, same
        // toggle) — excluded here.
        '":(exclude)src/features/auth/LoginScreen.tsx" ' +
        '":(exclude)src/features/auth/PhoenixWelcomeExperience.tsx" ' +
        '":(exclude)src/app/AppContext.tsx" ' +
        // PHASE-A-CLAUDE-A7.2.1: a still later, separately-reviewed phase
        // (Luxury Visual Fidelity Correction) reworks the illustration
        // component and its CSS layer for closer reference-board fidelity —
        // never a handler, session, or RPC change — excluded here.
        '":(exclude)src/shared/ui/InstitutionalSupplyMotif.tsx" ' +
        '":(exclude)src/shared/lib/phase-a-auth-welcome-signature.css" ' +
        // PHASE-C2-ORG-SCOPE: a still later, separately-reviewed phase scopes
        // Custody Chain and Corrections History (Screen 21 reports tabs) to
        // the selected organization — never a schema, RLS, or workflow
        // change — in custody-chain.service.ts / differences-corrections.
        // service.ts (new orgId param), dispatch.service.ts / outlet-return.
        // service.ts (additive optional organizationId narrowing filter,
        // backward-compatible), and DecisionIntelligenceReportsScreen.tsx
        // (threads activeOrgId into the two tabs) — all excluded here.
        '":(exclude)src/features/reports/custody-chain.service.ts" ' +
        '":(exclude)src/features/reports/differences-corrections.service.ts" ' +
        '":(exclude)src/features/reports/DecisionIntelligenceReportsScreen.tsx" ' +
        '":(exclude)src/features/outlet/dispatch.service.ts" ' +
        '":(exclude)src/features/outlet/outlet-return.service.ts" ' +
        '":(exclude)src/features/movement/DirectReturnComposer.tsx" ' +
        '":(exclude)src/features/network/network.service.ts" ' +
        '":(exclude)src/features/movement/movement-timeline.service.ts" ' +
        // PHASE-C1-REPORT-INTEGRITY: a still later, separately-reviewed phase
        // fixes Monthly Position's error-swallowing and replaces
        // isDemoOrganization's lossy boolean with a real demo/official/
        // unverified tri-state — never a schema, RLS, or workflow change —
        // in decision-intelligence.service.ts (new type/function, new i18n
        // keys in strings.ts) — excluded here.
        '":(exclude)src/features/reports/decision-intelligence.service.ts" ' +
        // STAGE-E-E7-1-171: a still later, separately-reviewed phase
        // (Migration 171, organization_kind discriminator) adds a new
        // exported type/vocabulary and doc comment to
        // src/shared/lib/institution-hierarchy.ts — a pure types/vocabulary
        // module with no database access, no service function, and no
        // eligibility rule (per its own header) — never a schema, RLS, or
        // workflow change — excluded here.
        '":(exclude)src/shared/lib/institution-hierarchy.ts" ' +
        // STAGE-E-E7-2: the Stage-E application-wiring phase. It adds no
        // migration and no RBAC/RLS change; it wires already-reviewed RPCs
        // into services and UI using only Migration 164's existing permission
        // keys. organizations.service.ts now sends the Migration-164/171
        // classification pair it previously omitted, and warehouses.service.ts
        // now carries Migration 164's clinical_location_kind. Excluded by
        // exact name; every other product path stays watched.
        '":(exclude)src/shared/supabase/services/organizations.service.ts" ' +
        '":(exclude)src/shared/supabase/services/warehouses.service.ts" ":(exclude)src/features/outlet/EmergencyReplenishmentTab.tsx" ":(exclude)src/features/outlet/InitialProvisioningLauncher.tsx" ":(exclude)src/features/institutions/FacilityManagementPanel.tsx" ":(exclude)src/features/institutions/ReplenishmentRouteManagementPanel.tsx" ":(exclude)src/features/institutions/WarehouseFacilityAssignmentPanel.tsx" ' +
        // R1.3: a still later, separately-reviewed stage (canonical supply
        // cycle) makes screen 17's navigation gate capability-correct so a
        // warehouse_transfer.send holder can reach the Supply surface without
        // users.edit_scope. ONE predicate in the canonical screen-authorization
        // module — no schema, RLS, RPC or workflow change, and scope management
        // stays gated on users.edit_scope — excluded here BY EXACT NAME; every
        // other product path stays watched.
        '":(exclude)src/shared/authz/screen-access.ts" ' +
        '":(exclude)src/shared/i18n/strings.ts"',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    // M187 authorizes exactly these three delegated-access integration files.
    // SUBSET, not equality: this diffs the WORKING TREE, which is empty once
    // committed and on every CI checkout. Anything outside the list still
    // fails closed exactly as the pre-187 `toBe('')` assertion did.
    const DELEGATED_AUTHORIZED = [
      'src/features/inventory/useInventoryScopes.ts',
      'src/features/inventory/useOutletRecallPermission.ts',
      'src/shared/ui/PhoenixOrgScope.tsx',
    ];
    // G3.2 — CANONICAL SEARCH & MATERIAL SELECTION CONVERGENCE authorizes
    // exactly these six files. Same SUBSET mechanism M187 established, and
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
    const STAGE_AUTHORIZED = [...DELEGATED_AUTHORIZED, ...G3_2_AUTHORIZED];
    const changed = diff.trim().split('\n').filter(Boolean).sort();
    expect(changed.filter(f => !STAGE_AUTHORIZED.includes(f))).toEqual([]);
  });

  it('public QR is untouched', () => {
    expect(ddlSection).not.toMatch(/get_public_qr_payload/);
    expect(verifyBlock).toContain('062 must not touch public QR');
    expect(verifyBlock).toContain('public QR payload leaked a scope/warehouse/internal field');
  });

  it('Deep Clean (055) is untouched', () => {
    expect(ddlSection).not.toMatch(/phoenix_clean_availability_data/);
    expect(verifyBlock).toContain('062 must not touch Deep Clean (055)');
  });

  it('the exchange domain is untouched', () => {
    expect(ddlSection).not.toMatch(/inter_org_exchange/);
    expect(ddlSection).not.toMatch(/inter_org_alert/);
    expect(verifyBlock).toContain('062 must not touch the exchange domain');
  });

  it('the outlet editor is untouched', () => {
    expect(ddlSection).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_upsert_availability/i);
    expect(verifyBlock).toContain('062 must not touch the outlet editor');
  });

  it('item_availability is untouched', () => {
    expect(ddlSection).not.toMatch(/ALTER TABLE public\.item_availability\b/);
  });

  it('creates no user-administration or dispatch RPC (063 scope)', () => {
    for (const f of ['phoenix_assign_profile_scope', 'phoenix_revoke_profile_scope',
      'phoenix_create_dispatch', 'phoenix_send_dispatch', 'phoenix_accept_dispatch_line']) {
      expect(ddlSection, `${f} belongs to 063`).not.toContain(`FUNCTION public.${f}(`);
      expect(verifyBlock).toContain(`'${f}'`);
    }
    expect(verifyBlock).toContain('062 must create no user-administration or ');
  });

  it('creates no assignment row', () => {
    expect(ddlSection).not.toMatch(/INSERT INTO public\.profile_scope_assignments/i);
    expect(verifyBlock).toContain('062 must create none');
  });

  it('creates no new audit table; documents the 063 audit_logs action contract', () => {
    expect(ddlSection).not.toMatch(/CREATE TABLE[^;]*audit/i);
    for (const action of ['scope_assigned', 'scope_revoked', 'permission_granted', 'permission_denied',
      'override_removed', 'permissions_reset', 'role_changed', 'organization_changed',
      'last_super_admin_protected']) {
      expect(m062, `the 063 audit contract must name ${action}`).toContain(action);
    }
  });
});

describe('17. no destructive SQL', () => {
  it('contains no DELETE or TRUNCATE', () => {
    expect(active062).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(active062).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('drops no table, column, constraint, function or index', () => {
    expect(active062).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(active062).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(active062).not.toMatch(/\bDROP\s+CONSTRAINT\b/i);
    expect(active062).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    expect(active062).not.toMatch(/\bDROP\s+INDEX\b/i);
    expect(active062).not.toMatch(/\bDROP\s+SCHEMA\b/i);
    // No unsafe DROP ... CASCADE. (ON DELETE CASCADE on an FK is a different
    // thing entirely and is used deliberately — see the drops list below.)
    expect(active062).not.toMatch(/\bDROP\b[^;]*\bCASCADE\b/i);
  });

  it('the only DROPs are the five superseded policies plus its own idempotent triggers', () => {
    const drops = activeLines.filter(l => /^DROP /i.test(l));
    expect(drops).toEqual([
      'DROP TRIGGER IF EXISTS trg_validate_profile_scope_assignment ON public.profile_scope_assignments;',
      'DROP POLICY IF EXISTS "psa_select_scoped" ON public.profile_scope_assignments;',
      'DROP POLICY IF EXISTS "wh_select_perm" ON public.warehouses;',
      'DROP POLICY IF EXISTS "warehouse_stock_select_perm" ON public.warehouse_stock;',
      'DROP POLICY IF EXISTS "warehouse_stock_mov_select_perm" ON public.warehouse_stock_movements;',
      'DROP POLICY IF EXISTS "warehouse_dispatches_select_perm" ON public.warehouse_dispatches;',
      'DROP POLICY IF EXISTS "warehouse_dispatch_lines_select_perm" ON public.warehouse_dispatch_lines;',
      'DROP TRIGGER IF EXISTS trg_protect_last_super_admin ON public.profiles;',
      'DROP TRIGGER IF EXISTS trg_validate_ppo_scope ON public.profile_permission_overrides;',
    ]);
  });

  it('grants anon nothing, anywhere', () => {
    expect(ddlSection).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\banon\b/i);
    expect(ddlSection).not.toMatch(/CREATE POLICY[^;]*TO\s+anon/i);
  });
});

describe('18. apply contract for 061/062', () => {
  it('documents the manual apply order', () => {
    expect(m062).toContain('Apply committed migration 061');
    expect(m062).toContain('IMMEDIATELY apply this migration (062)');
    expect(m062).toContain('Keep dispatch functionality unexposed');
  });

  it('documents what happens if 062 fails', () => {
    expect(m062).toContain('its transaction rolls back completely');
    expect(m062).toContain('061 remains applied');
    // (the header wraps this sentence across two comment lines)
    expect(m062).toContain('tables should still be empty');
    expect(m062).toContain('Fix forward promptly');
  });

  it('ships pre-apply readiness checks and post-apply verification', () => {
    expect(m062).toContain('PRE-APPLY READINESS CHECKS');
    expect(m062).toContain('POST-APPLY VERIFICATION');
  });

  it('VERIFY asserts 061 tables and contracts exist before replacing their policies', () => {
    expect(verifyBlock).toContain("'warehouse_dispatches','warehouse_dispatch_lines'");
    expect(verifyBlock).toContain('migration 061 must be applied before 062');
    expect(verifyBlock).toContain("'distribution_points_id_org_uniq'");
    expect(verifyBlock).toContain('061 retention contract broken');
    expect(verifyBlock).toContain('061 acceptance idempotency index missing');
  });

  it('VERIFY asserts the 060 warehouse foundation exists', () => {
    expect(verifyBlock).toContain("'warehouses_id_org_uniq'");
    expect(verifyBlock).toContain('060 warehouse stock identity index missing');
  });

  it('VERIFY asserts the expected 061/060 policy names are replaced safely', () => {
    for (const p of ['wh_select_perm', 'warehouse_stock_select_perm', 'warehouse_stock_mov_select_perm',
      'warehouse_dispatches_select_perm', 'warehouse_dispatch_lines_select_perm']) {
      expect(verifyBlock).toContain(`'${p}'`);
    }
    expect(verifyBlock).toContain('superseded policy still present');
  });
});
