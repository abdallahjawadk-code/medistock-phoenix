/**
 * CN-2B — Central Needs permission-catalog parity (corrective pass).
 *
 * Migration 209 seeded four permission keys (central_needs.view / import /
 * edit / approve) into the database's permission_keys catalog with ZERO role
 * defaults. Until this pass they were absent from the frontend PERMISSION_KEYS
 * catalog, so the permission-matrix screen could not render or manage them and
 * a UAT grant had to be made in the database by hand.
 *
 * WHY THIS FILE PARSES SQL RATHER THAN RE-STATING IT: the expected keys, module,
 * action, dangerous flag and both labels are derived from the committed
 * migration itself (the same method rbac-fallback-parity.test.ts uses for 062),
 * so a hand-copied expectation table cannot drift from the contract it exists
 * to pin.
 *
 * WHAT THIS PASS MUST NOT DO, each pinned below: create authority. The catalog
 * is a UI convenience layer (permissions.ts says so in its header); the server
 * is the boundary. No explicit frontend role fallback names a Central Needs
 * key, no central_needs.send exists anywhere, and 209/210/211 are read, never
 * re-stated, to prove the server contract is the one the UI now mirrors.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  PERMISSION_KEYS, PERMISSION_KEY_SET, isValidPermissionKey, isDangerousPermission,
  permissionsByModule, roleDefaults, effectivePermissions, canActorSetPermission,
  validateOverrides, type GrantContext,
} from '../permissions';
import { OFFICIAL_ROLES, LEGACY_AUTHORIZATION_ROLES } from '../roles';
import { T, t } from '@/shared/i18n/strings';
import { isScreenAuthorized, CENTRAL_NEEDS_SCREEN } from '@/shared/authz/screen-access';

const ROOT = join(__dirname, '../../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const M092 = read('supabase/migrations/092_phoenix_monthly_status_redesign.sql');
const M209 = read('supabase/migrations/209_phoenix_central_needs_registry.sql');
const M210 = read('supabase/migrations/210_phoenix_central_needs_workflow_rpcs.sql');
const M211 = read('supabase/migrations/211_phoenix_central_needs_batch_and_disposition.sql');

/** Source with comments removed, so prose can never satisfy — or break — a check. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** SQL with `--` comment lines removed, so header prose is never mistaken for a statement. */
const sqlCode = (src: string) => src.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

/**
 * The body of the LAST `CREATE [OR REPLACE] FUNCTION <name>` statement in a
 * migration (comment lines stripped first), up to its closing `$$;` — so a
 * check runs against the definition that is actually live after that file,
 * never against a header comment that merely mentions the function.
 */
function sqlFunctionBody(src: string, name: string): string {
  const sql = sqlCode(src);
  const re = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name.replace(/[.$]/g, '\\$&')}\\(`, 'g');
  let last = -1;
  for (const m of sql.matchAll(re)) last = m.index;
  expect(last, `${name} is defined`).toBeGreaterThan(-1);
  const end = sql.indexOf('$$;', last);
  expect(end, `${name} body terminates`).toBeGreaterThan(last);
  return sql.slice(last, end);
}

/** Every tracked migration numbered above `n`, read from disk. */
function laterMigrationsAfter(n: number): Array<{ file: string; text: string }> {
  const dir = join(ROOT, 'supabase/migrations');
  return readdirSync(dir)
    .filter(f => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) > n)
    .sort()
    .map(f => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));
}

interface SeededKey { key: string; module: string; action: string; labelEn: string; labelAr: string; dangerous: boolean }

/**
 * Every ('key','module','action','label_en','label_ar',bool) tuple migration
 * 209's permission_keys INSERT states, in statement order.
 */
function parse209SeededKeys(): SeededKey[] {
  const sql = sqlCode(M209);
  const start = sql.indexOf('INSERT INTO public.permission_keys');
  expect(start).toBeGreaterThan(-1);
  const stmt = sql.slice(start, sql.indexOf(';', start));
  const tuple = /\(\s*'([a-z_.]+)'\s*,\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(true|false)\s*\)/g;
  const out: SeededKey[] = [];
  for (const m of stmt.matchAll(tuple)) {
    out.push({ key: m[1], module: m[2], action: m[3], labelEn: m[4], labelAr: m[5], dangerous: m[6] === 'true' });
  }
  return out;
}

const SEEDED = parse209SeededKeys();
const SEEDED_KEYS = SEEDED.map(k => k.key);
const CATALOG_CN = PERMISSION_KEYS.filter(p => p.key.startsWith('central_needs.'));
const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;

// ============================================================================
// Guard against vacuous passes: the parser actually found migration 209's seed.
// ============================================================================
describe('0. migration 209 seed is parsed, not assumed', () => {
  it('states exactly four keys, all in module central_needs, and its VERIFY block pins that count', () => {
    expect(SEEDED).toHaveLength(4);
    for (const k of SEEDED) expect(k.module).toBe('central_needs');
    expect(SEEDED_KEYS).toEqual(['central_needs.view', 'central_needs.import', 'central_needs.edit', 'central_needs.approve']);
    expect(M209).toContain("WHERE module = 'central_needs') <> 4");
  });

  it('every seeded key is named key = module.action', () => {
    for (const k of SEEDED) expect(k.key).toBe(`${k.module}.${k.action}`);
  });
});

// ============================================================================
// A. The canonical frontend catalog contains all four M209 keys.
// ============================================================================
describe('A. the canonical frontend catalog contains all four migration-209 keys', () => {
  it('each seeded key is a valid catalog key', () => {
    for (const key of SEEDED_KEYS) {
      expect(isValidPermissionKey(key), key).toBe(true);
      expect(PERMISSION_KEY_SET.has(key), key).toBe(true);
    }
  });

  it('each catalog entry mirrors 209 field by field: module, action, dangerous', () => {
    for (const seeded of SEEDED) {
      const def = PERMISSION_KEYS.find(p => p.key === seeded.key);
      expect(def, seeded.key).toBeDefined();
      expect(def!.module).toBe(seeded.module);
      expect(def!.action).toBe(seeded.action);
      expect(def!.dangerous, `${seeded.key} dangerous`).toBe(seeded.dangerous);
      expect(isDangerousPermission(seeded.key)).toBe(seeded.dangerous);
    }
  });

  it('only approve is dangerous, exactly as permission_keys.is_dangerous says', () => {
    expect(SEEDED.filter(k => k.dangerous).map(k => k.key)).toEqual(['central_needs.approve']);
    expect(isDangerousPermission('central_needs.approve')).toBe(true);
    for (const key of ['central_needs.view', 'central_needs.import', 'central_needs.edit']) {
      expect(isDangerousPermission(key), key).toBe(false);
    }
  });

  it('the catalog is the whole prior catalog plus these four — 52 keys, nothing else moved', () => {
    expect(PERMISSION_KEYS).toHaveLength(52);
    expect(PERMISSION_KEY_SET.size).toBe(52);
    // The four are appended after the last pre-existing module, in 209 order.
    const keys = PERMISSION_KEYS.map(p => p.key);
    expect(keys.slice(-4)).toEqual(SEEDED_KEYS);
  });
});

// ============================================================================
// B. Exactly those four central_needs.* keys — no fifth.
// ============================================================================
describe('B. the Central Needs frontend permission set is exactly the four seeded keys', () => {
  it('the catalog holds no central_needs.* key that 209 did not seed', () => {
    expect(CATALOG_CN.map(p => p.key).sort()).toEqual([...SEEDED_KEYS].sort());
    expect(CATALOG_CN).toHaveLength(4);
  });

  it('permissionsByModule().central_needs is exactly the four, in 209 order', () => {
    const mods = permissionsByModule();
    expect(mods.central_needs.map(p => p.key)).toEqual(SEEDED_KEYS);
  });

  it('no key outside module central_needs carries the central_needs prefix, and vice versa', () => {
    for (const p of PERMISSION_KEYS) {
      expect(p.key.startsWith('central_needs.'), p.key).toBe(p.module === 'central_needs');
    }
  });
});

// ============================================================================
// C. central_needs.send is absent — everywhere.
// ============================================================================
describe('C. central_needs.send does not exist', () => {
  it('is not a catalog key and is rejected as unknown', () => {
    expect(PERMISSION_KEY_SET.has('central_needs.send')).toBe(false);
    expect(isValidPermissionKey('central_needs.send')).toBe(false);
    expect(canActorSetPermission(
      { actorRole: 'super_admin', isSelf: false, sameScope: true }, 'central_needs.send', true,
    )).toEqual({ ok: false, error: 'UNKNOWN_PERMISSION' });
  });

  it('is named nowhere in the catalog CODE, the dictionary, or Central Needs product code (prose may say it is absent)', () => {
    for (const rel of [
      'src/shared/lib/permissions.ts',
      'src/shared/i18n/strings.ts',
      'src/shared/authz/screen-access.ts',
      'src/features/central-needs/CentralNeedsScreen.tsx',
      'src/features/central-needs/CentralNeedsDispositionTable.tsx',
      'src/features/central-needs/central-needs.service.ts',
      'src/features/central-needs/useCentralNeedsPreview.ts',
      'src/features/qa/qaFixtures.ts',
      'src/app/AppContext.tsx',
    ]) {
      const body = code(read(rel));
      expect(body, rel).not.toContain('central_needs.send');
      expect(body, rel).not.toContain('perm_central_needs_send');
    }
  });

  it('209 never seeds it, and 210 and 211 both refuse to verify if it ever exists', () => {
    const seed = sqlCode(M209);
    const stmt = seed.slice(seed.indexOf('INSERT INTO public.permission_keys'));
    expect(stmt.slice(0, stmt.indexOf(';'))).not.toContain('central_needs.send');
    expect(M210).toContain("WHERE key = 'central_needs.send'");
    expect(M210).toContain('central_needs.send must never exist');
    expect(M211).toContain("WHERE key = 'central_needs.send'");
    expect(M211).toContain('central_needs.send must never exist');
  });
});

// ============================================================================
// D. Every new catalog entry has valid English and Arabic localization.
// ============================================================================
describe('D. bilingual labels exist and mirror permission_keys.label_en / label_ar', () => {
  it('each labelKey resolves in BOTH languages through the shared dictionary, never to the key itself', () => {
    for (const def of CATALOG_CN) {
      expect(T[def.labelKey], def.labelKey).toBeDefined();
      expect(t(def.labelKey, 'ar')).not.toBe(def.labelKey);
      expect(t(def.labelKey, 'en')).not.toBe(def.labelKey);
      expect(T[def.labelKey].ar.trim().length).toBeGreaterThan(0);
      expect(T[def.labelKey].en.trim().length).toBeGreaterThan(0);
    }
  });

  it('the Arabic label is actually Arabic and the English label is actually English', () => {
    for (const def of CATALOG_CN) {
      expect(ARABIC.test(T[def.labelKey].ar), `${def.labelKey}.ar`).toBe(true);
      expect(LATIN.test(T[def.labelKey].ar), `${def.labelKey}.ar contains Latin`).toBe(false);
      expect(LATIN.test(T[def.labelKey].en), `${def.labelKey}.en`).toBe(true);
      expect(ARABIC.test(T[def.labelKey].en), `${def.labelKey}.en contains Arabic`).toBe(false);
    }
  });

  /**
   * DISPLAY COPY INTENTIONALLY DIVERGES FROM MIGRATION 209 — and both sides are
   * pinned here so the divergence can only ever be deliberate.
   *
   * This assertion used to require `T[labelKey]` to be byte-identical to the
   * label migration 209 seeded. The product name is now "Annual Needs" /
   * "الاحتياج السنوي", while M209's seeded rows are APPLIED, IMMUTABLE database
   * evidence that is never rewritten. So equality is no longer the invariant:
   * the invariant is that the KEY is shared and each SIDE holds its own known
   * value. Replacing the equality with nothing would have left the renamed copy
   * unguarded, so both sides are asserted explicitly instead.
   */
  it('pins UI display copy and migration 209 evidence separately, sharing one key', () => {
    const EXPECTED_DISPLAY: Record<string, { en: string; ar: string }> = {
      'central_needs.view':    { en: 'View Annual Needs plans',           ar: 'عرض خطط الاحتياج السنوي' },
      'central_needs.import':  { en: 'Import Annual Needs data',          ar: 'استيراد بيانات الاحتياج السنوي' },
      'central_needs.edit':    { en: 'Edit Annual Needs data',            ar: 'تعديل بيانات الاحتياج السنوي' },
      'central_needs.approve': { en: 'Approve Annual Needs plan revision', ar: 'اعتماد مراجعة خطة الاحتياج السنوي' },
    };
    for (const seeded of SEEDED) {
      const def = PERMISSION_KEYS.find(p => p.key === seeded.key)!;
      // The permission key itself is untouched by the rename — the only thing
      // the database, RLS and every RPC actually use.
      expect(def.key, 'technical key').toBe(seeded.key);
      // UI side: the approved Annual Needs copy.
      expect(T[def.labelKey].en, `${seeded.key} display en`).toBe(EXPECTED_DISPLAY[seeded.key].en);
      expect(T[def.labelKey].ar, `${seeded.key} display ar`).toBe(EXPECTED_DISPLAY[seeded.key].ar);
      // Database side: M209's own historical wording, unchanged and unrewritten.
      expect(seeded.labelEn, `${seeded.key} seeded en`).toMatch(/Central Needs/);
      expect(seeded.labelAr, `${seeded.key} seeded ar`).toMatch(/الاحتياجات المركزية/);
    }
  });

  it('labelKey follows the catalog convention perm_<module>_<action>', () => {
    for (const def of CATALOG_CN) expect(def.labelKey).toBe(`perm_${def.module}_${def.action}`);
  });

  it('the module header the matrix renders (permmod_central_needs) exists bilingually and matches the nav entry', () => {
    expect(T.permmod_central_needs).toBeDefined();
    expect(ARABIC.test(T.permmod_central_needs.ar)).toBe(true);
    expect(LATIN.test(T.permmod_central_needs.en)).toBe(true);
    expect(T.permmod_central_needs.ar).toBe(T.cn2b_nav.ar);
    expect(T.permmod_central_needs.en).toBe(T.cn2b_nav.en);
  });

  it('the four labels are distinct from each other in both languages', () => {
    for (const lang of ['ar', 'en'] as const) {
      const labels = CATALOG_CN.map(def => T[def.labelKey][lang]);
      expect(new Set(labels).size).toBe(4);
    }
  });
});

// ============================================================================
// E. The permission-management UI represents the keys through the existing engine.
// ============================================================================
describe('E. the existing permission-matrix engine handles the four keys unchanged', () => {
  const um = read('src/features/users/UserManagementScreen.tsx');

  it('the matrix renders modules from permissionsByModule() and labels from each labelKey — no Central Needs special case', () => {
    expect(um).toContain('const modules = permissionsByModule();');
    expect(um).toContain('t(`permmod_${mod}`, lang)');
    expect(um).toContain('t(p.labelKey, lang)');
    expect(um).toContain('isDangerousPermission(p.key)');
    expect(code(um)).not.toContain('central_needs');
  });

  it('super_admin can grant each key to another profile in scope (not to itself)', () => {
    const ctx: GrantContext = { actorRole: 'super_admin', isSelf: false, sameScope: true };
    for (const key of SEEDED_KEYS) expect(canActorSetPermission(ctx, key, true), key).toEqual({ ok: true });
    const self: GrantContext = { actorRole: 'super_admin', isSelf: true, sameScope: true };
    for (const key of SEEDED_KEYS) {
      expect(canActorSetPermission(self, key, true), key).toEqual({ ok: false, error: 'SELF_ESCALATION' });
    }
  });

  it('an actor who does not hold a key cannot grant it; the dangerous one names the authority it lacks', () => {
    // institution_admin holds users.manage_permissions in the DB only by
    // override; its fallback carries no Central Needs key at all.
    const ctx: GrantContext = { actorRole: 'institution_admin', isSelf: false, sameScope: true };
    expect(canActorSetPermission(ctx, 'central_needs.view', true)).toEqual({ ok: false, error: 'CANNOT_GRANT_UNHELD' });
    expect(canActorSetPermission(ctx, 'central_needs.import', true)).toEqual({ ok: false, error: 'CANNOT_GRANT_UNHELD' });
    expect(canActorSetPermission(ctx, 'central_needs.edit', true)).toEqual({ ok: false, error: 'CANNOT_GRANT_UNHELD' });
    expect(canActorSetPermission(ctx, 'central_needs.approve', true)).toEqual({ ok: false, error: 'NEEDS_AUTHORITY_FOR_DANGEROUS' });
  });

  it('an actor granted a key by override can pass it on; denying or inheriting is always allowed in scope', () => {
    const ctx: GrantContext = {
      actorRole: 'institution_admin', isSelf: false, sameScope: true,
      actorOverrides: { 'central_needs.view': true },
    };
    expect(canActorSetPermission(ctx, 'central_needs.view', true)).toEqual({ ok: true });
    expect(canActorSetPermission(ctx, 'central_needs.import', true)).toEqual({ ok: false, error: 'CANNOT_GRANT_UNHELD' });
    for (const key of SEEDED_KEYS) {
      expect(canActorSetPermission(ctx, key, false), key).toEqual({ ok: true });
      expect(canActorSetPermission(ctx, key, null), key).toEqual({ ok: true });
    }
  });

  it('validateOverrides accepts a well-formed Central Needs grant and rejects the fifth key', () => {
    const ctx: GrantContext = { actorRole: 'super_admin', isSelf: false, sameScope: true };
    const res = validateOverrides(ctx, {
      'central_needs.view': true, 'central_needs.import': true,
      'central_needs.edit': null, 'central_needs.approve': false,
      'central_needs.send': true,
    });
    expect(res.ok).toBe(false);
    expect(res.accepted).toEqual({
      'central_needs.view': true, 'central_needs.import': true,
      'central_needs.edit': null, 'central_needs.approve': false,
    });
    expect(res.rejected).toEqual([{ key: 'central_needs.send', error: 'UNKNOWN_PERMISSION' }]);
  });

  it('the two-layer model resolves a per-profile grant on top of a zero default', () => {
    const eff = effectivePermissions('central_warehouse_manager', { 'central_needs.view': true, 'central_needs.import': true });
    expect(eff.has('central_needs.view')).toBe(true);
    expect(eff.has('central_needs.import')).toBe(true);
    expect(eff.has('central_needs.edit')).toBe(false);
    expect(eff.has('central_needs.approve')).toBe(false);
    // ...and the screen gate honours exactly that effective set.
    expect(isScreenAuthorized(CENTRAL_NEEDS_SCREEN, 'central_warehouse_manager', eff)).toBe(true);
    expect(isScreenAuthorized(CENTRAL_NEEDS_SCREEN, 'central_warehouse_manager', effectivePermissions('central_warehouse_manager'))).toBe(false);
  });
});

// ============================================================================
// F. No frontend role fallback implicitly grants a central_needs.* key.
// ============================================================================
describe('F. no explicit frontend role fallback grants any Central Needs key', () => {
  const NON_SUPER_OFFICIAL = OFFICIAL_ROLES.filter(r => r !== 'super_admin');

  it('every official role except super_admin resolves to zero Central Needs keys', () => {
    for (const role of NON_SUPER_OFFICIAL) {
      const held = [...roleDefaults(role)].filter(k => k.startsWith('central_needs.'));
      expect(held, role).toEqual([]);
    }
  });

  it('every legacy and removed role resolves to zero Central Needs keys', () => {
    for (const role of [...LEGACY_AUTHORIZATION_ROLES, 'hospital_admin', 'viewer', 'monthly_status_officer', '', 'not_a_role']) {
      const held = [...roleDefaults(role)].filter(k => k.startsWith('central_needs.'));
      expect(held, role || '(empty)').toEqual([]);
    }
  });

  it('the fallback lists in permissions.ts name no Central Needs key — only the catalog block does', () => {
    // Anchored on CODE tokens (the first fallback list and the catalog set),
    // not on a comment: comments are stripped before the search, so a prose
    // anchor would silently turn this into a check of the empty string.
    const src = code(read('src/shared/lib/permissions.ts'));
    const catalogEnd = src.indexOf('export const PERMISSION_KEY_SET');
    const firstList = src.indexOf('const WAREHOUSE_OFFICER_DEFAULTS');
    expect(catalogEnd).toBeGreaterThan(-1);
    expect(firstList).toBeGreaterThan(catalogEnd);
    const afterCatalog = src.slice(catalogEnd);
    expect(afterCatalog.length).toBeGreaterThan(1000);
    expect(afterCatalog).not.toContain('central_needs');
    // ...while the catalog block itself does name exactly the four.
    const catalog = src.slice(0, catalogEnd);
    expect(catalog.match(/'central_needs\.[a-z]+'/g)).toEqual(SEEDED_KEYS.map(k => `'${k}'`));
  });

  it('super_admin holds them only through the pre-existing catalog-wide derivation, which mirrors the server bypass', () => {
    // super_admin's fallback has always been the entire catalog (pinned by
    // user-permission-matrix.test.ts). That is not a grant made by this pass:
    // the server admits an active super_admin BEFORE any key is consulted.
    const d = roleDefaults('super_admin');
    for (const key of SEEDED_KEYS) expect(d.has(key), key).toBe(true);
    expect(d.size).toBe(PERMISSION_KEYS.length);

    const fn = sqlFunctionBody(M092, 'public.phoenix_status_center_authorized');
    expect(fn).toContain("IF v_role = 'super_admin' THEN RETURN true; END IF;");
    // ...and that check precedes the per-key permission lookup.
    expect(fn.indexOf("IF v_role = 'super_admin'")).toBeLessThan(fn.indexOf('phoenix_profile_has_permission'));
    // No later migration redefines the helper (grant/revoke statements only).
    for (const later of laterMigrationsAfter(92)) {
      expect(later.text, later.file).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\.phoenix_status_center_authorized/);
    }
    // 211's RESTRICTIVE eligibility class names super_admin explicitly — in
    // the function body, not merely in prose.
    const eligible = sqlFunctionBody(M211, 'public._phoenix_central_needs_role_eligible_v1');
    expect(eligible).toContain("IN ('super_admin', 'central_warehouse_manager')");
  });

  it('the QA harness overlays no Central Needs key on any persona', () => {
    expect(code(read('src/features/qa/qaFixtures.ts'))).not.toContain('central_needs.');
  });
});

// ============================================================================
// G. The server/database boundary remains authoritative; the client fails closed.
// ============================================================================
describe('G. the server stays the boundary and the client fails closed', () => {
  it('209 gates every Central Needs SELECT policy on the server-side capability helper', () => {
    const policies = [...sqlCode(M209).matchAll(/CREATE POLICY (central_needs_[a-z_]+_select_authorized)/g)].map(m => m[1]);
    expect(policies.length).toBeGreaterThanOrEqual(6);
    const usingCount = (sqlCode(M209).match(/USING \(public\.phoenix_status_center_authorized\(organization_id, 'central_needs\.view'\)\)/g) ?? []).length;
    expect(usingCount).toBe(policies.length);
  });

  it('209 writes no role_permission_defaults row and its VERIFY block refuses any', () => {
    const seed = sqlCode(M209);
    expect(seed).not.toMatch(/INSERT INTO public\.role_permission_defaults/);
    expect(M209).toContain("FROM public.role_permission_defaults WHERE permission_key LIKE 'central_needs.%'");
    expect(M209).toContain('must have zero default role grants');
  });

  it('210 and 211 guards re-derive the actor from auth.uid() and compose the same helper', () => {
    // 211 REDEFINES the guard, so the live body is 211's; both are pinned.
    for (const [label, sql] of [['210', M210], ['211', M211]] as const) {
      const guard = sqlFunctionBody(sql, 'public._phoenix_central_needs_guard_v1');
      expect(guard, label).toContain('auth.uid()');
      expect(guard, label).toContain('public.phoenix_status_center_authorized(p_organization_id, p_permission_key)');
      expect(guard, label).toContain("RAISE EXCEPTION 'forbidden_central_needs'");
    }
    // 211's guard additionally requires role eligibility, in code.
    const live = sqlFunctionBody(M211, 'public._phoenix_central_needs_guard_v1');
    expect(live).toContain('public._phoenix_central_needs_role_eligible_v1()');
    expect(sqlCode(M211)).toMatch(/CREATE OR REPLACE FUNCTION public\._phoenix_central_needs_role_eligible_v1\(\)/);
  });

  it('the client reads capabilities from EFFECTIVE permissions, never from a role name', () => {
    const screen = code(read('src/features/central-needs/CentralNeedsScreen.tsx'));
    expect(screen).toContain("myPermissions.has('central_needs.import')");
    expect(screen).toContain("myPermissions.has('central_needs.edit')");
    expect(screen).toContain("myPermissions.has('central_needs.approve')");
    expect(screen).not.toMatch(/role\s*===\s*'super_admin'\s*\|\|\s*myPermissions\.has\('central_needs/);
    const access = code(read('src/shared/authz/screen-access.ts'));
    const branch = access.slice(access.indexOf('if (screen === CENTRAL_NEEDS_SCREEN)'), access.indexOf('if (screen === CENTRAL_NEEDS_SCREEN)') + 120);
    expect(branch).toContain('permissions.has(CENTRAL_NEEDS_VIEW_PERMISSION)');
    expect(branch).not.toContain('super_admin');
  });

  it('AppContext fails closed: a silent RPC yields an EMPTY set; the role fallback runs only after the RPC ANSWERED without a permission map', () => {
    const ctx = code(read('src/app/AppContext.tsx'));
    const fn = ctx.slice(ctx.indexOf('const readPermissions = useCallback'), ctx.indexOf('const loadPermissions = useCallback'));
    // A deadline is not an answer: it returns an empty set and never reaches the fallback.
    const timeoutAt = fn.indexOf('if (isDeadlineExceeded(bounded)) {');
    expect(timeoutAt).toBeGreaterThan(-1);
    expect(fn.slice(timeoutAt, timeoutAt + 200)).toContain('return { perms: new Set<string>(), migrationMissing: false, timedOut: true };');
    // The fallback is reached only on the path where res.permissions is absent,
    // i.e. the RPC answered (migration missing, load error, or a refusal).
    const answeredAt = fn.indexOf('if (res.permissions) {');
    const fallbackAt = fn.indexOf('const fallback = roleDefaults(p.role);');
    expect(answeredAt).toBeGreaterThan(timeoutAt);
    expect(fallbackAt).toBeGreaterThan(answeredAt);
    expect(fn.slice(timeoutAt, answeredAt)).not.toContain('roleDefaults(');
    // And for every non-super_admin role that fallback carries no Central Needs key (F above).
  });

  it('an empty effective set is refused by the screen gate for every role, super_admin included', () => {
    for (const role of [...OFFICIAL_ROLES, ...LEGACY_AUTHORIZATION_ROLES, 'hospital_admin']) {
      expect(isScreenAuthorized(CENTRAL_NEEDS_SCREEN, role, new Set()), role).toBe(false);
    }
  });
});

// ============================================================================
// H. Migration 209 / 210 contracts are unchanged by this pass.
// ============================================================================
describe('H. the 209 / 210 contracts the catalog now mirrors are intact', () => {
  it('209 still seeds exactly these four keys with these labels and this single dangerous flag', () => {
    expect(SEEDED).toEqual([
      { key: 'central_needs.view',    module: 'central_needs', action: 'view',    labelEn: 'View Central Needs plans',           labelAr: 'عرض خطط الاحتياجات المركزية',           dangerous: false },
      { key: 'central_needs.import',  module: 'central_needs', action: 'import',  labelEn: 'Import Central Needs data',           labelAr: 'استيراد بيانات الاحتياجات المركزية',     dangerous: false },
      { key: 'central_needs.edit',    module: 'central_needs', action: 'edit',    labelEn: 'Edit Central Needs data',             labelAr: 'تعديل بيانات الاحتياجات المركزية',       dangerous: false },
      { key: 'central_needs.approve', module: 'central_needs', action: 'approve', labelEn: 'Approve Central Needs plan revision', labelAr: 'اعتماد مراجعة خطة الاحتياجات المركزية', dangerous: true  },
    ]);
    expect(M209).toContain('ON CONFLICT (key) DO NOTHING;');
  });

  it('209 still documents the zero-default policy it enforces', () => {
    expect(M209).toContain('Central Needs permission keys — declared, NO default role grants.');
  });

  it('210 still states there is deliberately no central_needs.send and still verifies it', () => {
    expect(M210).toContain('There is deliberately NO central_needs.send.');
    expect(M210).toContain("VERIFY FAILED (210): central_needs.send must never exist");
  });

  it('the frontend catalog carries nothing 209 does not: no extra field, no extra key, no extra module', () => {
    for (const def of CATALOG_CN) {
      expect(Object.keys(def).sort()).toEqual(['action', 'dangerous', 'key', 'labelKey', 'module']);
    }
    expect(Object.keys(permissionsByModule()).filter(m => m.startsWith('central'))).toEqual(['central_needs']);
  });
});
