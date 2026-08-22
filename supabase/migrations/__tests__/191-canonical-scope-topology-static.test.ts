/**
 * CANONICAL-SCOPE-TOPOLOGY-191 — STATIC proof.
 *
 * G4.2's claim is that structural topology and effective scope are no longer
 * decided in the browser. Two halves of that are provable without a database:
 *
 *   1. the migration states Migration 181's COMPLETE sector-main rule, and
 *   2. no first-party business logic still decides "sector main" from
 *      `facility_id IS NULL` alone, or from a name.
 *
 * The behavioural half — that the rule actually classifies a deactivated
 * facility-less depot as NOT the sector main, and that scope parity holds for a
 * facility-scoped manager — is proven in the dynamic suite against a real
 * database.
 *
 * The anti-regression scans below are deliberately narrow. They target the
 * files that CARRY AUTHORITY and permit ordinary presentation code elsewhere:
 * a screen may still say "show the facility-less ones under this heading", it
 * may not say "…and that makes them the sector main".
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const NAME = '191_phoenix_canonical_scope_topology_read_contract.sql';
const MIGRATIONS_DIR = join(__dirname, '..');
const SRC = join(__dirname, '..', '..', '..', 'src');

const sql = readFileSync(join(MIGRATIONS_DIR, NAME), 'utf8');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** Strip line and block comments so a scan judges CODE, never prose. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('--'))
    .join('\n');
}

/** The body of the one function this migration adds. */
const QUERY_BODY = (() => {
  const open = sql.indexOf('$scope_topology$');
  const close = sql.indexOf('$scope_topology$', open + 1);
  if (open === -1 || close === -1) throw new Error('191: could not isolate $scope_topology$');
  return sql.slice(open + '$scope_topology$'.length, close);
})();

// ============================================================================
// Registration and file hygiene
// ============================================================================
describe('191 · registration and file hygiene', () => {
  it('exists exactly once on disk under its exact filename', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('191_'))).toEqual([NAME]);
  });

  it('is registered in the reviewed-migration manifest by exact filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
  });

  it('is immediately followed by 192, 193 then 194, the new ceiling, and 195 stays absent', () => {
    const NEXT = '192_phoenix_anonymous_read_surface_convergence.sql';
    const NEXT_2 = '193_phoenix_inter_org_alert_command_surface_hardening.sql';
    const NEXT_3 = '194_phoenix_authorization_surface_reproducibility_convergence.sql';
    const numbers = REVIEWED_MIGRATION_FILES.map(f => Number(f.slice(0, 3))).filter(Number.isFinite);
    expect(Math.max(...numbers)).toBe(194);
    expect(REVIEWED_MIGRATION_FILES.slice(REVIEWED_MIGRATION_FILES.indexOf(NAME) + 1)).toEqual([NEXT, NEXT_2, NEXT_3]);
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1]).toBe(NEXT_3);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^192_/.test(f))).toEqual([NEXT]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^193_/.test(f))).toEqual([NEXT_2]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^194_/.test(f))).toEqual([NEXT_3]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^195_/.test(f))).toHaveLength(0);
  });

  it('carries no CR bytes', () => {
    expect(sql.includes('\r')).toBe(false);
  });

  it('is a single transaction, manual-apply only', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('\nCOMMIT;');
    expect(sql.match(/\nBEGIN;/g) ?? []).toHaveLength(1);
    expect(sql.match(/\nCOMMIT;/g) ?? []).toHaveLength(1);
    expect(sql).not.toMatch(/\bROLLBACK\b/);
    expect(sql).toContain('MANUAL APPLY ONLY');
  });

  it('edits no historical migration — it only CREATEs its own function', () => {
    // No DROP/ALTER of anything, and no CREATE OR REPLACE of an existing object:
    // a forward-only, additive delta.
    expect(code(sql)).not.toMatch(/\bDROP\s+(FUNCTION|TABLE|POLICY|TRIGGER|VIEW)\b/i);
    expect(code(sql)).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(code(sql)).not.toMatch(/CREATE\s+OR\s+REPLACE/i);
  });
});

// ============================================================================
// §9 QUERY PURITY — the migration adds a read, and only a read
// ============================================================================
describe('191 · the query writes nothing', () => {
  it.each(['INSERT', 'UPDATE', 'DELETE', 'MERGE'])('contains no %s', (verb) => {
    expect(QUERY_BODY).not.toMatch(new RegExp(`\\b${verb}\\b`, 'i'));
  });

  it('contains no ON CONFLICT and no nextval', () => {
    expect(QUERY_BODY).not.toMatch(/on\s+conflict/i);
    expect(QUERY_BODY).not.toMatch(/nextval/i);
  });

  it('calls no known writer or refresh command', () => {
    for (const writer of [
      'phoenix_refresh_inter_org_alert_lifecycle',
      'phoenix_apply_warehouse_stock_movement',
      'phoenix_assign_profile_scope',
      'phoenix_assign_warehouse_facility',
      'phoenix_upsert_organization_facility',
    ]) {
      expect(QUERY_BODY).not.toContain(writer);
    }
  });

  it('is declared STABLE and SECURITY INVOKER with a pinned search_path', () => {
    expect(sql).toMatch(/LANGUAGE sql\s*\nSTABLE\s*\nSECURITY INVOKER\s*\nSET search_path = public, pg_temp/);
    expect(sql).not.toMatch(/phoenix_query_organization_scope_topology[\s\S]{0,400}SECURITY DEFINER/);
  });

  it('creates no table, view, materialized view or sequence — no new truth', () => {
    expect(code(sql)).not.toMatch(/CREATE\s+(TABLE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE)/i);
  });
});

// ============================================================================
// §6 THE SECTOR-MAIN RULE IS COMPLETE
// ============================================================================
describe('191 · sector_main is structural, never facility_id IS NULL alone', () => {
  it('conditions sector_main on all six of Migration 181\'s conjuncts', () => {
    // The CASE arm that produces 'sector_main'.
    const arm = QUERY_BODY.slice(
      QUERY_BODY.indexOf("WHEN org.organization_kind = 'care_institution'"),
      QUERY_BODY.indexOf("'sector_main'") + "'sector_main'".length,
    );
    expect(arm).toContain("org.organization_kind = 'care_institution'");
    expect(arm).toContain("org.institution_class = 'health_sector'");
    expect(arm).toContain("wh.warehouse_kind     = 'institution'");
    expect(arm).toContain("wh.status             = 'active'");
    expect(arm).toContain('wh.facility_id IS NULL');
    expect(arm).toContain('wh.is_main IS TRUE');
  });

  it('the migration\'s own VERIFY block re-asserts every conjunct', () => {
    // A later hand-edit that deletes `is_main` and keeps the NULL test must
    // fail at APPLY time, not merely fail this file.
    expect(sql).toContain('is_main\\s+IS\\s+TRUE');
    expect(sql).toContain('sector_main is not conditioned on is_main IS TRUE');
    expect(sql).toContain('sector_main is not conditioned on an ACTIVE warehouse');
  });

  it('never matches topology on a name, label or code', () => {
    expect(QUERY_BODY).not.toMatch(/\.name\s*(=|~|ILIKE|LIKE)/i);
    expect(QUERY_BODY).not.toMatch(/name_ar\s*(=|~|ILIKE|LIKE)/i);
    expect(QUERY_BODY).not.toMatch(/\bcode\s*=/i);
  });

  it('derives outlet ancestry through warehouse_id, not through a label', () => {
    expect(QUERY_BODY).toContain('pw.id = dp.warehouse_id');
    expect(QUERY_BODY).toContain('pf.id = pw.facility_id');
  });
});

// ============================================================================
// §10 SECURITY — no widening of any kind
// ============================================================================
describe('191 · no permission or grant widening', () => {
  it('denies anon and PUBLIC, grants only authenticated', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.phoenix_query_organization_scope_topology(uuid)\n  FROM PUBLIC, anon;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_query_organization_scope_topology(uuid)\n  TO authenticated;');
  });

  it('grants nothing directly on any topology or scope table', () => {
    expect(code(sql)).not.toMatch(/GRANT[\s\S]{0,80}\bON\s+TABLE\b/i);
    for (const t of [
      'organization_facilities', 'warehouses', 'distribution_points',
      'profile_scope_assignments', 'profile_delegated_scope_assignments',
    ]) {
      expect(code(sql)).not.toMatch(new RegExp(`GRANT[^;]{0,120}\\bpublic\\.${t}\\b`, 'i'));
    }
  });

  it('creates no permission key and no role', () => {
    expect(code(sql)).not.toMatch(/INSERT\s+INTO\s+public\.permissions/i);
    expect(code(sql)).not.toMatch(/CREATE\s+ROLE/i);
  });

  it('re-uses the existing scope helpers instead of restating their predicates', () => {
    expect(QUERY_BODY).toContain('phoenix_profile_has_warehouse_assignment');
    expect(QUERY_BODY).toContain('phoenix_profile_has_point_assignment');
    // It must NOT reach into the assignment tables itself — that would be a
    // second implementation of the rule those helpers own.
    expect(QUERY_BODY).not.toContain('profile_scope_assignments');
    expect(QUERY_BODY).not.toContain('profile_delegated_scope_assignments');
  });

  it('leaves Migration 187 the sole owner of delegated topology', () => {
    expect(QUERY_BODY).not.toContain('phoenix_my_operational_resource_catalog');
    expect(sql).toContain("187''s delegated catalog disappeared");
  });
});

// ============================================================================
// §14 CLIENT AUTHORITY IS GONE
// ============================================================================
describe('G4.2 · no client-side sector-main authority remains', () => {
  const AUTHORITY_FILES = [
    'features/inventory/useInventoryScopes.ts',
    'shared/lib/health-sector-grouping.ts',
    'shared/lib/direct-supply-corridors.ts',
    // A HEADING is a structural claim too: this screen labelled a group "the
    // sector's main warehouse" from the NULL test alone, so a retired
    // facility-less depot was presented, under that heading, as the supply root.
    'features/network/NetworkManagementScreen.tsx',
  ];

  it('the network screen groups by the DB role, not by a facility-null test', () => {
    const c = code(readSrc('features/network/NetworkManagementScreen.tsx'));
    expect(c).toContain('getOrganizationWarehouseRoles');
    expect(c).toContain("roleOf(w.id) === 'sector_main'");
    expect(c).not.toMatch(/institution.filter(w => w.facilityId === null)/);
    expect(c).not.toMatch(/institution.filter(w => w.facilityId !== null)/);
  });

  it('useInventoryScopes decides no scope from a facility-null test', () => {
    const c = code(readSrc('features/inventory/useInventoryScopes.ts'));
    expect(c).not.toMatch(/facilityId\s*!==\s*null/);
    expect(c).not.toMatch(/facilityId\s*===\s*null/);
    expect(c).not.toContain('assignedFacilities');
    expect(c).not.toContain('facilityDerivedWarehouses');
    expect(c).not.toContain('reachableWarehouse');
  });

  it('useInventoryScopes reads the canonical query for its primary organization', () => {
    const src = readSrc('features/inventory/useInventoryScopes.ts');
    expect(src).toContain('getOrganizationScopeTopology');
    expect(src).toContain('inEffectiveScope');
    // It must not go back to the raw tables for the primary path.
    expect(code(src)).not.toContain('getWarehouses(');
    expect(code(src)).not.toContain('getPointsByOrg(');
  });

  it('no authority file classifies a structural role from its own fields', () => {
    for (const f of AUTHORITY_FILES) {
      const c = code(readSrc(f));
      // A literal 'sector_main' may only ever be COMPARED against the value the
      // database supplied, never constructed from local column tests. The
      // marker is the DB-sourced role reaching this file, under either of the
      // two names it travels by — the row field or the roles accessor.
      if (c.includes("'sector_main'")) {
        expect(c, f).toMatch(/structuralRole|getOrganizationWarehouseRoles|WarehouseStructuralRole/);
      }
    }
  });

  it('no first-party topology decision matches on a display name', () => {
    for (const f of AUTHORITY_FILES) {
      const c = code(readSrc(f));
      expect(c, f).not.toMatch(/name\s*===\s*['"]/);
      expect(c, f).not.toMatch(/nameAr\s*===\s*['"]/);
      expect(c, f).not.toMatch(/\.includes\(['"](sector|main|centre|center)/i);
    }
  });

  /**
   * THE REINTRODUCTION GUARD.
   *
   * The review found current behaviour correct but this file's scans too weak:
   * they would not have caught null-only sector-main authority coming back to
   * `health-sector-grouping.ts` or `direct-supply-corridors.ts`, because those
   * files legitimately contain `facilityId` null handling elsewhere —
   * facility-bucket placement, positive facility-bound checks, and R1.1-P's
   * owner-accepted B1 destination narrowing.
   *
   * So the assertions below are scoped to the EXACT construct that decides the
   * role, never to the whole file. Everything outside that construct stays free
   * to test `facilityId` for any legitimate reason.
   */
  describe('the sector-main decision cannot regress to a facility-null test', () => {
    /** The body of a named function declaration, brace-matched. */
    const fnBody = (src: string, name: string): string => {
      const at = src.indexOf('export function ' + name);
      expect(at, name + ' not found').toBeGreaterThan(-1);
      const open = src.indexOf('{', at);
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
      }
      throw new Error('unbalanced body for ' + name);
    };

    /** The single statement that assigns a named const, up to its semicolon. */
    const stmt = (src: string, decl: string): string => {
      const at = src.indexOf(decl);
      expect(at, decl + ' not found').toBeGreaterThan(-1);
      return src.slice(at, src.indexOf(';', at) + 1);
    };

    const NULL_TEST = /facilityId\s*(===|!==)\s*null|facility_id\s+IS\s+(NOT\s+)?NULL/i;

    it('health-sector-grouping decides the sector-main group from the DB role only', () => {
      const src = code(readSrc('shared/lib/health-sector-grouping.ts'));
      const decision = stmt(src, 'const sectorMainWarehouses');
      expect(decision).toContain("structuralRole === 'sector_main'");
      expect(decision).not.toMatch(NULL_TEST);
    });

    it('direct-supply-corridors picks its Branch-B source from the DB role only', () => {
      const src = code(readSrc('shared/lib/direct-supply-corridors.ts'));
      const body = fnBody(src, 'directSupplySources');
      expect(body).toContain("structuralRole === 'sector_main'");
      expect(body).not.toMatch(NULL_TEST);
    });

    it('no statement in either helper produces sector_main beside a null test', () => {
      // Catches the compact regression shapes a per-construct scan could miss,
      // e.g. `facilityId === null ? 'sector_main' : …` or a filter-then-label
      // chain written on one statement.
      for (const f of ['shared/lib/health-sector-grouping.ts',
                       'shared/lib/direct-supply-corridors.ts',
                       'features/network/NetworkManagementScreen.tsx',
                       'features/inventory/useInventoryScopes.ts']) {
        const src = code(readSrc(f));
        for (const s of src.split(';')) {
          if (!s.includes("'sector_main'")) continue;
          expect(s.replace(/\s+/g, ' ').trim(), f).not.toMatch(NULL_TEST);
        }
      }
    });

    it('the legitimate null handling those helpers still need is NOT rejected', () => {
      // Proof the guard above is narrow rather than a blanket ban: these exact
      // legitimate uses survive, and must keep surviving.
      const grouping = code(readSrc('shared/lib/health-sector-grouping.ts'));
      expect(grouping).toMatch(/w\.facilityId === null/);        // facility-bucket placement
      const corridors = code(readSrc('shared/lib/direct-supply-corridors.ts'));
      expect(corridors).toMatch(/w\.facilityId === null/);       // B1 destination narrowing
      expect(corridors).toMatch(/w\.facilityId !== null/);       // positive facility-bound test
    });
  });

  it('the topology service fails CLOSED on an unknown structural role', () => {
    const svc = readSrc('shared/supabase/services/scope-topology.service.ts');
    expect(svc).toContain("'unclassified'");
    expect(svc).toMatch(/ROLES\.has\(raw\)/);
  });
});
