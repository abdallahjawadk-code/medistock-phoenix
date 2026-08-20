/**
 * 182 · HEALTH-CENTER FACILITY-SCOPED RBAC (R1.1-U) — static proof.
 *
 * Source-level guards that need no database: registration, the exact object
 * inventory, and — heavily — the NON-GOALS. R1.1-U owns AUTHORIZATION and
 * nothing else, so the assertions here are weighted toward what must be ABSENT:
 * no third stock truth, no unit domain, no second assignment table, no
 * organization-wide grant to the new role, no edit of Migration 062/076/146/181.
 *
 * Behavioural proof (the access matrices, provisioning, isolation, RLS) lives in
 * the sibling *.dynamic.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { activeSql, executableSql, sqlFunctionSource } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '182_phoenix_health_center_facility_scoped_rbac.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'));

/** Statements that run at apply time (function bodies / DO blocks stripped). */
const applyTime = code.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, '\n/* body removed */\n');
/** Comments removed — absence claims must read code, not documentation. */
const bare = activeSql(code);
const applyBare = activeSql(applyTime);
/**
 * Comments removed AND string literals blanked. Required for NEGATIVE
 * assertions: this migration's own VERIFY block quotes the very text some of
 * those assertions forbid (e.g. it checks that revocation does not contain
 * 'DELETE FROM public.profile_scope_assignments'), so reading `bare` would make
 * the guard match itself.
 */
const executable = executableSql(code);

const fn = (name: string) => {
  const src = sqlFunctionSource(sql, name);
  expect(src, `function not found: ${name}`).toBeTruthy();
  return src!;
};

describe('182 registration and shape', () => {
  it('is registered exactly once, immediately after 181', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(f => f === NAME)).toEqual([NAME]);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(i).toBeGreaterThan(0);
    expect(REVIEWED_MIGRATION_FILES[i - 1])
      .toBe('181_phoenix_health_sector_topology_reconciliation.sql');
  });

  // R1.2C added 183, so 182 is no longer last. The guard is extended by EXACT
  // filename rather than relaxed: 183 is named outright and anything beyond it
  // still fails closed.
  it('is followed by exactly 183 through 191, and nothing beyond them', () => {
    // M191 (G4.2 canonical facility/scope topology read contract) is the new
    // ceiling.
    // The successor list stays EXACT and the nothing-beyond regex is narrowed by
    // exactly one number, so this guard still fails closed on any unreviewed
    // migration beyond 191.
    const SUCCESSORS = [
      '183_phoenix_emergency_outlet_integrity.sql',
      '184_phoenix_canonical_supply_cycle.sql',
      '185_phoenix_return_quarantine_recall_parity.sql',
      '186_phoenix_correction_reason_code_wrapper_parity.sql',
      '187_phoenix_delegated_operational_access.sql',
      '188_phoenix_public_qr_facility_context.sql',
      '189_phoenix_inter_org_alert_canonical_identity.sql',
      '190_phoenix_inter_org_alert_cqrs_boundary.sql',
      '191_phoenix_canonical_scope_topology_read_contract.sql',
    ];
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(REVIEWED_MIGRATION_FILES.slice(i + 1)).toEqual(SUCCESSORS);
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1])
      .toBe(SUCCESSORS[SUCCESSORS.length - 1]);
    expect(REVIEWED_MIGRATION_FILES.some(f => /^19[2-9]_|^[2-9]\d\d_/.test(f))).toBe(false);
  });

  it('is a single transaction, manual-apply only', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('\nCOMMIT;');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
    expect([...sql.matchAll(/^BEGIN;$/gm)].length).toBe(1);
    expect([...sql.matchAll(/^COMMIT;$/gm)].length).toBe(1);
  });

  it('fails closed on preconditions and verifies in-transaction', () => {
    expect(code).toContain('182_precondition_failed');
    expect(code).toContain('VERIFY FAILED (182)');
    // It refuses to run twice, and refuses on a chain without 181.
    expect(code).toContain('the 182 facility helper already exists');
    expect(code).toContain('Migration 181 is not applied');
  });

  it('carries no Production identity', () => {
    const uuids = bare.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/gi) ?? [];
    expect(uuids).toEqual([]);
    expect(bare).toContain("institution_class = 'health_sector'");
  });
});

describe('182 the role vocabulary gains exactly one member', () => {
  it('adds health_center_manager and keeps all five historical roles', () => {
    const check = bare.slice(bare.indexOf('ADD CONSTRAINT profiles_role_check'));
    for (const role of [
      'super_admin', 'central_warehouse_manager', 'institution_admin',
      'warehouse_officer', 'outlet_officer', 'health_center_manager',
    ]) expect(check, role).toContain(`'${role}'`);
  });

  it('remaps no legacy role and creates no alias', () => {
    expect(bare).not.toMatch(/UPDATE\s+public\.profiles\s+SET\s+role/i);
    expect(bare).not.toMatch(/hospital_admin/);
  });

  it('refuses to apply where the new role somehow already exists', () => {
    expect(code).toContain("a health_center_manager profile already exists");
  });
});

describe('182 facility scope extends the ONE assignment ledger', () => {
  it('adds a nullable facility_id column rather than a second table', () => {
    expect(applyBare).toContain('ALTER TABLE public.profile_scope_assignments ADD COLUMN facility_id uuid');
    expect(applyBare).not.toMatch(/CREATE\s+TABLE/i);
  });

  it('extends BOTH historical scope_type checks — one alone would reject every row', () => {
    // 062 left two overlapping constraints on this column.
    expect(applyBare).toContain('DROP CONSTRAINT profile_scope_assignments_scope_type_check');
    expect(applyBare).toContain('DROP CONSTRAINT psa_scope_type_chk');
    const both = bare.match(/ADD CONSTRAINT (profile_scope_assignments_scope_type_check|psa_scope_type_chk)[\s\S]*?;/g) ?? [];
    expect(both).toHaveLength(2);
    for (const c of both) expect(c).toContain("'facility'");
  });

  it('the target-match check admits exactly one target column per scope type', () => {
    const chk = bare.slice(
      bare.indexOf('ADD CONSTRAINT psa_target_matches_scope_chk'),
      bare.indexOf('ADD CONSTRAINT psa_facility_org_fk'),
    );
    expect(chk).toMatch(/WHEN 'warehouse'::text\s+THEN warehouse_id IS NOT NULL AND distribution_point_id IS NULL AND facility_id IS NULL/);
    expect(chk).toMatch(/WHEN 'distribution_point'::text THEN distribution_point_id IS NOT NULL AND warehouse_id IS NULL AND facility_id IS NULL/);
    expect(chk).toMatch(/WHEN 'facility'::text\s+THEN facility_id IS NOT NULL AND warehouse_id IS NULL AND distribution_point_id IS NULL/);
    expect(chk).toContain('ELSE false');
  });

  it('proves ownership STRUCTURALLY, matching the warehouse/point idiom', () => {
    expect(bare).toMatch(
      /ADD CONSTRAINT psa_facility_org_fk\s*\n\s*FOREIGN KEY \(facility_id, organization_id\)\s*\n\s*REFERENCES public\.organization_facilities \(id, organization_id\)\s*\n\s*ON DELETE RESTRICT/,
    );
  });

  it('one ACTIVE assignment per (profile, facility), and revoked history never blocks reuse', () => {
    expect(bare).toMatch(
      /CREATE UNIQUE INDEX psa_active_facility_uniq\s*\n\s*ON public\.profile_scope_assignments \(profile_id, facility_id\)\s*\n\s*WHERE is_active = true AND scope_type = 'facility'/,
    );
    // Deliberately NOT unique on profile_id alone: one manager, many centres.
    expect(bare).not.toMatch(/UNIQUE INDEX[\s\S]{0,120}\(profile_id\)\s*\n?\s*WHERE[\s\S]{0,60}facility/);
  });

  it('adds no new unique index to organization_facilities — 164 already provides the FK target', () => {
    expect(code).toContain('organization_facilities(id, organization_id) UNIQUE is absent');
    expect(applyBare).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX[^;]*ON public\.organization_facilities/i);
  });
});

describe('182 write-time validation is the second cross-sector layer', () => {
  const guard = () => fn('phoenix_validate_profile_scope_assignment');

  it('preserves the warehouse and distribution_point branches verbatim', () => {
    expect(guard()).toContain('SCOPE_ASSIGNMENT_TARGET_NOT_FOUND: warehouse % not found in organization %');
    expect(guard()).toContain('SCOPE_ASSIGNMENT_TARGET_INACTIVE: distribution point % is %');
    expect(guard()).toContain('SCOPE_ASSIGNMENT_ORG_MISMATCH');
  });

  it('a facility assignment requires the health_center_manager role', () => {
    expect(guard()).toContain('SCOPE_ASSIGNMENT_ROLE_INELIGIBLE');
    expect(guard()).toMatch(/v_profile_role IS DISTINCT FROM 'health_center_manager'/);
  });

  it('a facility assignment requires an ACTIVE care_institution health sector', () => {
    expect(guard()).toContain('SCOPE_ASSIGNMENT_ORGANIZATION_NOT_HEALTH_SECTOR');
    expect(guard()).toMatch(/v_org_kind IS DISTINCT FROM 'care_institution'/);
    expect(guard()).toMatch(/v_org_class IS DISTINCT FROM 'health_sector'/);
  });

  it('the facility must be an ACTIVE health centre of the same organization', () => {
    for (const e of [
      'SCOPE_ASSIGNMENT_TARGET_NOT_FOUND: facility % not found',
      'SCOPE_ASSIGNMENT_FACILITY_ORGANIZATION_MISMATCH',
      'SCOPE_ASSIGNMENT_FACILITY_CLASS_INVALID',
      'SCOPE_ASSIGNMENT_TARGET_INACTIVE: facility % is %',
    ]) expect(guard(), e).toContain(e);
    expect(guard()).toContain("'primary_health_center', 'subordinate_health_center'");
  });

  it('revoked rows stay exempt, so history remains writable', () => {
    expect(guard()).toMatch(/IF NEW\.is_active THEN/);
  });

  it('fails closed on an unknown scope type', () => {
    expect(guard()).toContain('SCOPE_ASSIGNMENT_UNKNOWN_SCOPE_TYPE');
  });
});

describe('182 the profile role/organization invariant', () => {
  const guard = () => fn('_phoenix_profile_role_organization_guard_v1');

  it('an ACTIVE manager must sit in an active care_institution health sector', () => {
    expect(guard()).toContain('health_center_manager_requires_organization');
    expect(guard()).toContain('health_center_manager_requires_active_health_sector');
    expect(guard()).toMatch(/v_class IS DISTINCT FROM 'health_sector'/);
  });

  it('judges only ACTIVE rows, so history is preserved', () => {
    expect(guard()).toMatch(/IF NEW\.status IS DISTINCT FROM 'active' THEN\s*\n\s*RETURN NEW;/);
  });

  it('does NOT require a facility assignment to CREATE or keep the role', () => {
    // Requiring scope in a row-level BEFORE trigger would make correct
    // provisioning impossible — the profile must exist before its assignment set
    // is inserted in the same transaction. Safe because an unscoped manager
    // reaches nothing at all.
    //
    // The guard DOES read profile_scope_assignments, but only in the
    // role-change-AWAY branch. This proves that lookup is confined there: it
    // must appear after the TG_OP='UPDATE' role-change test and before the
    // "is this a valid manager" branch begins.
    const g = guard();
    const changeAway = g.indexOf("OLD.role = 'health_center_manager'");
    const lookup = g.indexOf('FROM public.profile_scope_assignments');
    const validity = g.indexOf("IF NEW.role IS DISTINCT FROM 'health_center_manager' THEN");
    expect(changeAway, 'the role-change-away branch must exist').toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(changeAway);
    expect(lookup).toBeLessThan(validity);
    // Exactly one lookup — the validity path never consults scope.
    expect([...g.matchAll(/FROM public\.profile_scope_assignments/g)]).toHaveLength(1);
    expect(g.slice(validity)).not.toContain('profile_scope_assignments');
  });

  it('refuses to leave the role while active facility scope remains', () => {
    expect(guard()).toContain('health_center_manager_role_change_blocked_by_active_facility_scope');
    expect(guard()).toMatch(/a\.scope_type = 'facility' AND a\.is_active/);
    // The remedy is an AUDITED revoke, never a silent delete of history.
    expect(guard()).toContain('phoenix_revoke_profile_scope');
    expect(guard()).not.toMatch(/DELETE\s+FROM\s+public\.profile_scope_assignments/i);
  });

  it('covers every mutation that can produce the shape', () => {
    expect(code).toMatch(
      /BEFORE INSERT OR UPDATE OF role, organization_id, status\s*\n\s*ON public\.profiles/,
    );
  });
});

describe('182 read-time helpers are the third cross-sector layer', () => {
  const facility = () => fn('phoenix_profile_has_facility_assignment');
  const warehouse = () => fn('phoenix_profile_has_warehouse_assignment');
  const point = () => fn('phoenix_profile_has_point_assignment');

  it('the facility helper re-proves every condition rather than trusting the write', () => {
    const f = facility();
    expect(f).toContain("a.scope_type  = 'facility'");
    expect(f).toContain('a.is_active   = true');
    expect(f).toContain("p.status = 'active'");
    expect(f).toContain("p.role   = 'health_center_manager'");
    expect(f).toContain("f.status = 'active'");
    expect(f).toContain("f.facility_class IN ('primary_health_center', 'subordinate_health_center')");
    // Three-way organization agreement.
    expect(f).toContain('a.organization_id = p.organization_id');
    expect(f).toContain('a.organization_id = f.organization_id');
    expect(f).toContain("o.institution_class = 'health_sector'");
  });

  // The slice starts at the branch's own SELECT, not at the top of the body:
  // 9g's subject-confidentiality guard now precedes it. The claim these two
  // assertions make is about the direct branch's PREDICATE being 062/076
  // verbatim — that the new role gets no bespoke reach here — and that claim is
  // unchanged. The guard itself is asserted separately, above.
  /**
   * The direct branch now carries exactly ONE mention of the new role, and it is
   * an EXCLUSION (`<>`), never a grant.
   *
   * U-C corrective — THE DIRECT-SCOPE INVARIANT. This role's warehouse and
   * outlet authority is DERIVED from its facility assignments by the second
   * EXISTS. The writer refuses to create a direct row for it at all; refusing to
   * HONOUR one here is what makes the invariant structural instead of
   * procedural, so a row arriving by any other route (a service_role writer, a
   * restore) still grants nothing. Proven on the rig: with an illegal direct
   * sector-main row present, has_warehouse_assignment stays false.
   *
   * The original claim — 062/076's predicate is otherwise verbatim, and the new
   * role gains no bespoke REACH here — is asserted below unchanged.
   */
  it('DIRECT warehouse assignment keeps its exact 062/076 semantics', () => {
    const w = warehouse();
    const direct = w.slice(w.indexOf('SELECT 1'), w.indexOf('OR EXISTS'));
    expect(direct).toContain("a.scope_type   = 'warehouse'");
    expect(direct).toContain('a.organization_id = w.organization_id');
    expect(direct).toContain("p.role <> 'health_center_manager'");
    // An exclusion only — never a grant, and never a second mention.
    expect(direct).not.toMatch(/p\.role\s*=\s*'health_center_manager'/);
    expect(direct.split('health_center_manager').length - 1).toBe(1);
  });

  it('DIRECT point assignment keeps its exact 062/076 semantics', () => {
    const p = point();
    const direct = p.slice(p.indexOf('SELECT 1'), p.indexOf('OR EXISTS'));
    expect(direct).toContain("a.scope_type            = 'distribution_point'");
    expect(direct).toContain("p.role <> 'health_center_manager'");
    expect(direct).not.toMatch(/p\.role\s*=\s*'health_center_manager'/);
    expect(direct.split('health_center_manager').length - 1).toBe(1);
  });

  it('the assignment WRITER refuses any direct warehouse/point scope for the role', () => {
    // The read-side exclusion above is defence in depth; this is the primary
    // control. Before it, an institution_admin holding users.edit_scope could
    // grant a direct sector-main warehouse scope and the manager then read
    // sector-main stock — reproduced end to end.
    const start = bare.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_assign_profile_scope');
    expect(start).toBeGreaterThan(-1);
    const fn = bare.slice(start, bare.indexOf('$function$;', start));
    expect(fn).toContain('SCOPE_ASSIGN_ROLE_REQUIRES_FACILITY_SCOPE');
    expect(fn).toMatch(/v_profile_role = 'health_center_manager'\s*AND p_scope_type <> 'facility'/);
    // It must precede the per-scope-type branches, or it governs only the path
    // it was never needed on.
    expect(fn.indexOf('SCOPE_ASSIGN_ROLE_REQUIRES_FACILITY_SCOPE'))
      .toBeLessThan(fn.indexOf("IF p_scope_type = 'facility' THEN"));
    // Keyed on the ROLE, never on the sector main's id — a blocklist would let
    // any other direct warehouse through.
    expect(fn).not.toMatch(/is_main/);
  });

  it('the facility-derived branch is reachable ONLY by health_center_manager', () => {
    for (const src of [warehouse(), point()]) {
      const derived = src.slice(src.indexOf('OR EXISTS'));
      expect(derived).toContain("p.role   = 'health_center_manager'");
      expect(derived).toContain("a.scope_type = 'facility'");
    }
  });

  it('SECTOR-MAIN EXCLUSION: both helpers demand a non-null warehouse facility', () => {
    for (const src of [warehouse(), point()]) {
      const derived = src.slice(src.indexOf('OR EXISTS'));
      expect(derived).toContain('w.facility_id IS NOT NULL');
      expect(derived).toContain('a.facility_id = w.facility_id');
    }
  });

  it('the outlet path resolves through its OWNING warehouse, never the outlet alone', () => {
    const derived = point().slice(point().indexOf('OR EXISTS'));
    expect(derived).toContain('JOIN public.warehouses              w ON w.id = d.warehouse_id');
    expect(derived).toContain("d.status = 'active'");
  });

  it('the scoped-permission resolver keeps its REACH contract; 9g adds only a denial', () => {
    // Until 9g this asserted the resolver was not redefined at all, which was
    // correct while the new role had no business in it: any redefinition would
    // have meant reach was being special-cased instead of derived from the
    // assignment helpers. 9g redefines it for ONE reason — a self-only
    // confidentiality denial that strictly narrows — so the guard is narrowed to
    // the reach contract rather than dropped.
    const start = bare.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_profile_has_scoped_permission');
    expect(start, '9g must forward-replace the resolver').toBeGreaterThan(-1);
    const fn = bare.slice(start, bare.indexOf('$function$;', start));

    // Reach is unchanged: same org-wide set, same delegation to both helpers.
    expect(fn).toContain("v_org_wide_roles text[] := ARRAY['institution_admin']");
    expect(fn).toContain('phoenix_profile_has_warehouse_assignment(p_profile_id, p_warehouse_id)');
    expect(fn).toContain('phoenix_profile_has_point_assignment(p_profile_id, p_distribution_point_id)');

    // The role appears exactly once, and only as the denial.
    expect(fn.split('health_center_manager').length - 1).toBe(1);
    expect(fn).toMatch(/phoenix_my_role\(\) = 'health_center_manager'\s*\n?\s*AND p_profile_id IS DISTINCT FROM auth\.uid\(\) THEN\s*\n?\s*RETURN false/);

    // And it precedes the super_admin branch, which is otherwise a role oracle.
    expect(fn.indexOf('health_center_manager')).toBeLessThan(fn.indexOf("v_role = 'super_admin'"));

    expect(code).toContain('health_center_manager leaked into the scoped-permission resolver');
    // The VERIFY block quotes this inside a SQL literal, so the quotes are doubled.
    expect(code).toContain("v_org_wide_roles text[] := ARRAY[''institution_admin'']");
  });

  it('9g guards the resolver\'s DELEGATES, not only the resolver', () => {
    // The resolver's last two statements delegate to these, and all three are
    // SECURITY DEFINER + granted to authenticated + take a caller-supplied
    // p_profile_id, so they are independently reachable. Guarding the wrapper
    // alone left the subject's scope, status and role answerable directly.
    for (const helper of [
      'phoenix_profile_has_facility_assignment',
      'phoenix_profile_has_warehouse_assignment',
      'phoenix_profile_has_point_assignment',
    ]) {
      const start = bare.indexOf(`FUNCTION public.${helper}(`);
      expect(start, helper).toBeGreaterThan(-1);
      const fn = bare.slice(start, bare.indexOf('$$;', start));
      expect(fn, helper).toContain("phoenix_my_role() = 'health_center_manager'");
      expect(fn, helper).toContain('p_profile_id IS DISTINCT FROM auth.uid()');
      // The guard must DENY, and must come before the body it protects.
      expect(fn.indexOf('THEN false'), helper).toBeGreaterThan(-1);
      expect(fn.indexOf("phoenix_my_role() = 'health_center_manager'"), helper)
        .toBeLessThan(fn.indexOf('SELECT 1'));
      // The sector-main exclusion the helpers already carried is untouched.
      if (helper !== 'phoenix_profile_has_facility_assignment') {
        expect(fn, helper).toContain('w.facility_id IS NOT NULL');
      }
    }
    expect(code).toContain('a subject-taking primitive lost its cross-profile denial');
  });

  it('9g takes the subject from auth.uid(), never from the caller argument', () => {
    const start = bare.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_profile_has_permission(');
    expect(start, '9g must forward-replace the primitive').toBeGreaterThan(-1);
    const fn = bare.slice(start, bare.indexOf('$function$;', start));
    expect(fn).toContain("phoenix_my_role() = 'health_center_manager'");
    expect(fn).toContain('p_profile_id is distinct from auth.uid()');
    // Hardening preserved from 017.
    expect(fn).toContain('SECURITY DEFINER');
    expect(fn).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    // No caller-controlled escape hatch on either primitive. Scoped to the two
    // bodies deliberately: the VERIFY block names these same tokens in the
    // assertion that forbids them, so a whole-file scan matches itself.
    const sibStart = bare.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_profile_has_scoped_permission');
    const sib = bare.slice(sibStart, bare.indexOf('$function$;', sibStart));
    for (const body of [fn, sib]) {
      expect(body).not.toMatch(/allow_cross_profile|p_bypass|p_as_profile|p_override_scope/i);
    }
    // VERIFY covers both primitives as a set.
    expect(code).toContain('VERIFY FAILED (182/9g)');
  });
});

describe('182 the assignment RPC is extended, not forked', () => {
  const rpc = () => fn('phoenix_assign_profile_scope');

  it('keeps its exact historical signature', () => {
    expect(bare).toContain('phoenix_assign_profile_scope(\n  p_profile_id uuid, p_scope_type text, p_target_id uuid\n)');
  });

  it('admits facility alongside the two historical scope types', () => {
    expect(rpc()).toContain("p_scope_type NOT IN ('warehouse', 'distribution_point', 'facility')");
  });

  it('preserves the historical authority, IDOR guard, idempotency and audit', () => {
    expect(rpc()).toContain('NOT_AUTHORIZED_SCOPE_ASSIGN');
    expect(rpc()).toContain('NOT_AUTHORIZED_SCOPE_ASSIGN_CROSS_ORG');
    expect(rpc()).toContain('pg_advisory_xact_lock');
    expect(rpc()).toContain("'scope_assigned'");
    expect(rpc()).toContain('idempotent_replay');
  });

  it('a FACILITY assignment additionally requires the sector institution_admin', () => {
    expect(rpc()).toContain('SCOPE_ASSIGN_ROLE_INELIGIBLE');
    expect(rpc()).toContain('SCOPE_ASSIGN_ORGANIZATION_NOT_HEALTH_SECTOR');
    expect(rpc()).toContain('NOT_AUTHORIZED_FACILITY_SCOPE_ASSIGN');
  });

  it('the audit payload names the facility explicitly', () => {
    expect(rpc()).toContain("'facility_id', CASE WHEN p_scope_type = 'facility' THEN p_target_id ELSE NULL END");
  });

  it('phoenix_revoke_profile_scope is left ALONE — it is already generic', () => {
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_revoke_profile_scope/);
    expect(code).toContain('scope revocation now deletes history');
  });
});

describe('182 the service-only provisioning companion', () => {
  const rpc = () => fn('phoenix_admin_assign_facility_scopes');

  it('re-verifies the actor rather than trusting the caller', () => {
    expect(rpc()).toContain('FACILITY_SCOPE_ACTOR_INELIGIBLE');
    expect(rpc()).toContain('NOT_AUTHORIZED_FACILITY_SCOPE_CROSS_ORG');
    expect(rpc()).toContain("public.phoenix_profile_has_permission(p_actor_id, 'users.edit_scope')");
  });

  it('re-verifies the target role and the organization class', () => {
    expect(rpc()).toContain('FACILITY_SCOPE_ROLE_INELIGIBLE');
    expect(rpc()).toContain('FACILITY_SCOPE_ORGANIZATION_NOT_HEALTH_SECTOR');
  });

  it('rejects an empty set and bounds the size', () => {
    expect(rpc()).toContain('FACILITY_SCOPE_SET_EMPTY');
    expect(rpc()).toContain('FACILITY_SCOPE_SET_TOO_LARGE');
    expect(rpc()).toContain('SELECT array_agg(DISTINCT x)');
  });

  it('validates EVERY facility BEFORE writing ANY assignment', () => {
    // sqlFunctionSource strips comments, so this anchors on CODE, not prose.
    const body = rpc();
    const firstInsert = body.indexOf('INSERT INTO public.profile_scope_assignments');
    expect(firstInsert, 'the writer must insert somewhere').toBeGreaterThan(-1);
    // EVERY validation refusal is lexically BEFORE the first write. That
    // ordering is what makes a partial facility set impossible to commit.
    for (const e of [
      'FACILITY_SCOPE_FACILITY_NOT_FOUND',
      'FACILITY_SCOPE_FACILITY_FOREIGN',
      'FACILITY_SCOPE_FACILITY_INACTIVE',
      'FACILITY_SCOPE_FACILITY_CLASS_INVALID',
    ]) {
      expect(body, e).toContain(e);
      expect(body.indexOf(e), `${e} must precede the first INSERT`).toBeLessThan(firstInsert);
    }
  });

  it('audits every assignment it writes', () => {
    expect(rpc()).toContain("'scope_assigned'");
    expect(rpc()).toContain("'provisioning', true");
  });

  it('is service_role ONLY', () => {
    expect(code).toContain('REVOKE ALL ON FUNCTION public.phoenix_admin_assign_facility_scopes(uuid, uuid, uuid[])\n  FROM PUBLIC, anon, authenticated;');
    expect(code).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_admin_assign_facility_scopes(uuid, uuid, uuid[])\n  TO service_role;');
    expect(code).toContain('the service-only facility writer is reachable by a client role');
  });
});

describe('182 forward-replaces the 146 provisioning contract without editing 146', () => {
  const rpc = () => fn('phoenix_admin_provision_profile');

  it('146 itself is untouched on disk', () => {
    const m146 = readFileSync(
      join(ROOT, 'supabase/migrations/146_phoenix_secure_user_provisioning.sql'), 'utf8');
    expect(m146).not.toContain('health_center_manager');
  });

  it('the new role joins 146s OWN whitelist — otherwise it is unprovisionable', () => {
    expect(rpc()).toMatch(/'outlet_officer',\s*\n\s*'health_center_manager'\s*\n\s*\) then/);
  });

  it('the new role additionally requires an active health sector, for EVERY caller', () => {
    expect(rpc()).toContain('health_center_manager_requires_health_sector');
    expect(rpc()).toMatch(/o\.organization_kind = 'care_institution'\s*\n\s*and o\.institution_class = 'health_sector'/);
  });

  it('every 146 guarantee survives byte-for-byte', () => {
    for (const invariant of [
      'phoenix-user-provision:',              // the advisory lock
      'phoenix_provisioning_nonce',           // the Auth app-metadata nonce
      'phoenix_provisioning_actor_id',
      'target_not_fresh_placeholder',         // the placeholder inspection
      'auth_identity_mismatch',
      'cannot_create_privileged_role',        // the privilege ceiling
      'cross_org',
      'actor_missing_permission',
      'service_only_v146',                    // the audit marker
    ]) expect(rpc(), invariant).toContain(invariant);
    // Still UPDATE-only and one-shot: no UPSERT path was introduced.
    expect(rpc()).not.toMatch(/ON CONFLICT/i);
    expect(rpc()).toContain('update public.profiles');
  });

  it('does not touch the other historical migrations it depends on', () => {
    // phoenix_profile_has_permission was on this list until 9g. It is now
    // forward-replaced ON PURPOSE — 017 shipped it with no caller authorization
    // at all, which let this role reconstruct any profile's permission map — so
    // the guard moves from "never redefined" to "redefined only to ADD the
    // denial, with 017's resolution logic preserved verbatim". The other two
    // remain untouchable.
    for (const forbidden of [
      'phoenix_my_role',
      'phoenix_my_org',
    ]) expect(bare, forbidden).not.toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${forbidden}\\b`));

    const start = bare.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_profile_has_permission(');
    const fn = bare.slice(start, bare.indexOf('$function$;', start));
    // 017's two-tier resolution — override first, then role default — survives
    // byte-for-byte inside the else branch; only the guard is new.
    expect(fn).toContain('from profile_permission_overrides o');
    expect(fn).toContain('where o.profile_id = p_profile_id and o.permission_key = p_key');
    expect(fn).toContain('from role_permission_defaults d');
    expect(fn).toContain('join profiles pr on pr.id = p_profile_id');
    expect(fn).toContain('where d.role = pr.role and d.permission_key = p_key');
  });
});

describe('182 role permission defaults are the audited minimum', () => {
  const defaults = () => bare.slice(
    bare.indexOf('INSERT INTO public.role_permission_defaults'),
    bare.indexOf('-- 9a.') > -1 ? bare.indexOf('-- 9a.') : bare.length,
  );

  it('grants exactly the six proven scope-aware read keys', () => {
    const block = bare.slice(
      bare.indexOf('INSERT INTO public.role_permission_defaults'),
      bare.indexOf('DROP POLICY organization_facilities_select_scoped'),
    );
    const keys = [...block.matchAll(/'health_center_manager', '([a-z_.]+)'/g)].map(m => m[1]).sort();
    expect(keys).toEqual([
      'outlet_stock.view',
      'ports.view',
      'warehouse_dispatch.view',
      'warehouse_stock.movements_view',
      'warehouse_stock.view',
      'warehouses.view',
    ]);
    expect(code).toContain('expected 6 health_center_manager defaults');
  });

  it('grants NO administrative, lifecycle or organization-wide key', () => {
    const block = defaults();
    for (const forbidden of [
      'users.create', 'users.assign_role', 'users.edit_scope', 'users.disable',
      'users.reset_permissions', 'users.view', 'organization_facilities.manage',
      'warehouses.manage', 'central_warehouse.manage', 'inventory.purge',
      'reports.view', 'availability.view',
    ]) expect(block, forbidden).not.toContain(`'health_center_manager', '${forbidden}'`);
    // And the VERIFY block proves it at apply time too.
    expect(code).toContain('administrative permission(s)');
  });

  it('changes no historical role default', () => {
    expect(bare).not.toMatch(/DELETE FROM public\.role_permission_defaults/);
    expect(bare).not.toMatch(/UPDATE public\.role_permission_defaults/);
    expect(code).toContain("a historical role''s permission defaults changed");
  });
});

describe('182 RLS narrowing is non-regressive BY CONSTRUCTION', () => {
  const policy = (name: string) => bare.slice(
    bare.indexOf(`CREATE POLICY ${name}`),
    bare.indexOf(';', bare.indexOf(`CREATE POLICY ${name}`)) + 1,
  );

  // U-A narrowed the two surfaces the granted permission keys reach. U-B added
  // fourteen more, because a large part of this schema authorizes reads on
  // ORGANIZATION MEMBERSHIP ALONE — which is exactly the boundary a
  // facility-scoped role must not inherit. The corrective pass (9e) added the
  // final seven, after an independent audit found that closing a FAMILY by
  // member rather than by predicate leaves siblings open. The list stays
  // EXHAUSTIVE: every narrowed policy is named, each is dropped and recreated
  // exactly once, and any further policy fails this guard.
  it('narrows exactly the twenty-three audited policies and creates no others', () => {
    const NARROWED = [
      // ── U-A: the two surfaces the granted permission keys reach ──────────
      'dp_read_perm',
      'organization_facilities_select_scoped',
      // ── U-B / 9c: org-only AND facility-resolvable, so narrowed ──────────
      'avail_select_org',                                          // highest-severity leak
      'outlet_replenishment_routes_select_scoped',                 // id oracle
      'qrt_select_org',                                            // QR enumeration
      'qrtk_select_org',                                           // QR enumeration
      'stocktake_count_lines_select_scoped',                       // counted quantities
      'stocktakes_select_scoped',                                  // counted quantities
      'warehouse_supply_routes_select_scoped',                     // id oracle
      'phoenix_stock_correction_requests_select_scoped',           // via outlet_stock_id
      // ── U-B / 9d: org-only and NOT facility-resolvable, so DENIED ────────
      // Each carries organization_id alone — no warehouse, outlet or facility
      // column — so scope cannot be expressed and the role gets nothing.
      'phoenix_movement_events_select_scoped',
      'phoenix_notifications_select_scoped',
      'phoenix_warehouse_correction_requests_select_scoped',
      'phoenix_dispatch_line_requests_select_scoped',
      'phoenix_outlet_return_line_requests_select_scoped',
      'phoenix_outlet_return_exception_resolutions_select_scoped',
      // ── U-B / 9e CORRECTIVE: cross-centre metadata confidentiality ────────
      // Narrowed to the caller's own row rather than denied outright, because
      // each of these carries exactly one row the role legitimately owns.
      'profiles_select_own_org',                                   // sector roster
      'ppo_select_scoped',                                         // measured: leaked a centre-B outlet id
      'pba_select_superadmin_or_own_org',                          // who acknowledged for the org
      // ── U-B / 9e CORRECTIVE: denied — no facility dimension exists ───────
      'phoenix_paper_references_select_scoped',                    // index of other centres' documents
      'isr2_select_scoped',                                        // whole-sector monthly position
      'isr2_lines_select_scoped',                                  // ...per material
      'isr2_amendments_select_scoped',
    ].sort();
    const created = [...bare.matchAll(/CREATE POLICY ([a-z0-9_]+)/g)].map(m => m[1]).sort();
    expect(created).toEqual(NARROWED);
    const dropped = [...bare.matchAll(/DROP POLICY ([a-z0-9_]+)/g)].map(m => m[1]).sort();
    expect(dropped).toEqual(NARROWED);
    // Each exactly once — a policy dropped twice would leave the second
    // CREATE as the live definition and silently discard the first narrowing.
    for (const p of NARROWED) {
      expect([...bare.matchAll(new RegExp(`DROP POLICY ${p}\\b`, 'g'))], p).toHaveLength(1);
      expect([...bare.matchAll(new RegExp(`CREATE POLICY ${p}\\b`, 'g'))], p).toHaveLength(1);
    }
  });

  it('the DENIED group has no scope escape hatch, and the narrowed group does', () => {
    // A denied policy ends in `AND phoenix_my_role() <> 'health_center_manager'`
    // with no OR — there is deliberately no scope test it could satisfy,
    // because none is expressible on an organization-id-only table.
    for (const denied of [
      'phoenix_movement_events_select_scoped',
      'phoenix_notifications_select_scoped',
      'phoenix_warehouse_correction_requests_select_scoped',
      'phoenix_dispatch_line_requests_select_scoped',
      'phoenix_outlet_return_line_requests_select_scoped',
      'phoenix_outlet_return_exception_resolutions_select_scoped',
    ]) {
      const body = bare.slice(bare.indexOf(`CREATE POLICY ${denied}`));
      const policy = body.slice(0, body.indexOf(';') + 1);
      expect(policy, denied).toContain("AND phoenix_my_role() <> 'health_center_manager'");
      expect(policy, denied).not.toContain('phoenix_profile_has_point_assignment');
      expect(policy, denied).not.toContain('phoenix_profile_has_warehouse_assignment');
      expect(policy, denied).not.toContain('phoenix_profile_has_facility_assignment');
    }
    // ...and every NARROWED policy does name a scope test, so the two groups
    // cannot be confused with one another.
    for (const [narrowed, test] of [
      ['avail_select_org', 'phoenix_profile_has_point_assignment'],
      ['outlet_replenishment_routes_select_scoped', 'phoenix_profile_has_point_assignment'],
      ['stocktakes_select_scoped', 'phoenix_profile_has_warehouse_assignment'],
      ['warehouse_supply_routes_select_scoped', 'phoenix_profile_has_warehouse_assignment'],
      ['organization_facilities_select_scoped', 'phoenix_profile_has_facility_assignment'],
      ['phoenix_stock_correction_requests_select_scoped', 'phoenix_profile_has_point_assignment'],
    ] as const) {
      const body = bare.slice(bare.indexOf(`CREATE POLICY ${narrowed}`));
      expect(body.slice(0, body.indexOf(';') + 1), narrowed).toContain(test);
    }
  });

  it('each added conjunct is TRUE for every pre-182 role', () => {
    // `role <> 'health_center_manager' OR <scoped test>` — no existing profile
    // can hold that role, so their predicate is unchanged. That is what makes
    // this provably non-regressive rather than merely asserted.
    for (const p of ['organization_facilities_select_scoped', 'dp_read_perm']) {
      expect(policy(p), p).toContain("phoenix_my_role() <> 'health_center_manager'");
    }
  });

  it('a manager sees only its ASSIGNED facilities', () => {
    expect(policy('organization_facilities_select_scoped'))
      .toContain('phoenix_profile_has_facility_assignment(auth.uid(), id)');
  });

  it('dp_read_perm keeps ports.view and adds per-outlet authorization', () => {
    const p = policy('dp_read_perm');
    expect(p).toContain("phoenix_profile_has_permission(auth.uid(), 'ports.view')");
    expect(p).toContain('organization_id = phoenix_my_org()');
    expect(p).toContain('phoenix_profile_has_point_assignment(auth.uid(), id)');
    expect(p).toContain("phoenix_my_role() = 'super_admin'");
  });

  it('leaves every other policy alone', () => {
    for (const untouched of [
      // Already scope-aware, so they inherit facility scope through the two
      // assignment helpers and need no narrowing of their own.
      'wh_select_scoped', 'warehouse_stock_select_scoped',
      'warehouse_stock_mov_select_scoped', 'outlet_stock_select_scoped',
      // Write paths and the scope ledger itself are untouched by U-B.
      'psa_select_scoped', 'dp_insert_perm', 'dp_update_perm',
      'avail_insert_perm', 'avail_update_perm',
    ]) expect(bare, untouched).not.toContain(`DROP POLICY ${untouched}`);
  });

  it('the two SECURITY DEFINER read models are forward-replaced, not left org-only', () => {
    // Being SECURITY DEFINER they bypass RLS entirely, so narrowing policies
    // proves nothing about them: without these the role reads any outlet in the
    // sector and every policy above is security theatre.
    for (const fnName of ['phoenix_outlet_availability_read_model', 'phoenix_available_stock']) {
      const src = sqlFunctionSource(sql, fnName);
      expect(src, fnName).toBeTruthy();
      expect(src!, fnName).toContain("v_role = 'health_center_manager'");
      expect(src!, fnName).toContain('phoenix_profile_has_point_assignment');
      // The refusal returns the SAME empty result as a nonexistent point, so it
      // never discloses that an off-facility outlet exists.
      expect(src!, fnName).toContain('RETURN v_empty;');
    }
    // Migrations 179 and 083 themselves are NOT edited.
    for (const [file, name] of [
      ['179_phoenix_canonical_authenticated_availability_hardening.sql', '179'],
      ['083_phoenix_inventory_derived_availability.sql', '083'],
    ]) {
      const historical = readFileSync(join(ROOT, 'supabase/migrations', file), 'utf8');
      expect(historical, name).not.toContain('health_center_manager');
    }
  });
});

describe('182 direct client DML on the ledger remains impossible', () => {
  it('grants authenticated no INSERT/UPDATE/DELETE', () => {
    // No TABLE-level grant on the ledger is issued at all, to any role.
    expect(executable).not.toMatch(/GRANT[\s\S]{0,200}?ON\s+(TABLE\s+)?public\.profile_scope_assignments/i);
    expect(code).toContain('authenticated gained direct DML on profile_scope_assignments');
  });

  it('every new internal function is search_path-pinned and SECURITY DEFINER', () => {
    expect(code).toContain('not SECURITY DEFINER, or not search_path-pinned');
    for (const f of [
      'phoenix_profile_has_facility_assignment',
      'phoenix_admin_assign_facility_scopes',
      '_phoenix_profile_role_organization_guard_v1',
    ]) expect(fn(f)).toContain('SET search_path = public, pg_temp');
  });

  it('the internal profile guard is revoked from every client role', () => {
    expect(code).toContain(
      'REVOKE ALL ON FUNCTION public._phoenix_profile_role_organization_guard_v1()\n  FROM PUBLIC, anon, authenticated, service_role;');
  });
});

describe('182 NON-GOALS', () => {
  it('creates no third stock truth', () => {
    for (const forbidden of ['facility_stock', 'health_center_stock', 'manager_stock']) {
      expect(applyBare, forbidden).not.toContain(forbidden);
    }
    expect(code).toContain('a third stock truth was created');
    expect(code).toContain('the two stock truths were disturbed');
  });

  it('creates no unit domain', () => {
    for (const forbidden of ['health_center_unit', 'unit_stock', 'unit_routes', 'unit_scopes']) {
      expect(applyBare, forbidden).not.toContain(forbidden);
    }
    expect(code).toContain('a unit domain was created');
  });

  it('creates no second assignment table and no new table at all', () => {
    expect(applyBare).not.toMatch(/\bCREATE\s+(TABLE|SEQUENCE|TYPE|VIEW|MATERIALIZED)\b/i);
  });

  it('does not touch Migration 181 topology or Migration 180 supply semantics', () => {
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\._phoenix_health_sector/);
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_replenish_emergency_outlet/);
    expect(code).toContain("Migration 181''s outlet topology guard was disturbed");
    expect(code).toContain("Migration 180''s replenishment gate was disturbed");
  });

  it('encodes no reset, purge or truncation', () => {
    expect(executable).not.toMatch(/TRUNCATE/i);
    expect(executable).not.toMatch(/DELETE FROM public\.profiles/i);
    expect(executable).not.toMatch(/DELETE FROM public\.profile_scope_assignments/i);
  });

  it('drops no historical index, constraint or function beyond the two it re-adds', () => {
    const dropped = [...bare.matchAll(/DROP CONSTRAINT ([a-z_]+)/g)].map(m => m[1]).sort();
    expect(dropped).toEqual([
      'profile_scope_assignments_scope_type_check',
      'profiles_role_check',
      'psa_scope_type_chk',
      'psa_target_matches_scope_chk',
    ]);
    expect(bare).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION|TRIGGER)\b/i);
  });
});

describe('182/9f status-contribution closure', () => {
  /** The 9f forward replacement, isolated from the rest of the migration. */
  const fn = () => {
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_status_get_outlet_contribution');
    expect(start, 'the 9f forward replacement is missing').toBeGreaterThan(-1);
    return sql.slice(start, sql.indexOf('$function$;', start));
  };

  it('forward-replaces the reader instead of editing migration 092', () => {
    const body = fn();
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    // Signature preserved, so 092/113/121's existing grants keep applying.
    expect(body).toContain('(p_report_id uuid, p_distribution_point_id uuid)');
    // That 092 itself is untouched is proved by byte-identity against master,
    // not by anything readable from inside this file.
  });

  it('denies the role BEFORE the report row is read, closing the existence oracle', () => {
    const body = fn();
    const denial = body.indexOf("phoenix_my_role() = 'health_center_manager'");
    const lookup = body.indexOf('FROM public.inventory_status_reports');
    expect(denial, 'the facility-scoped denial is absent').toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(-1);
    // Position is the whole point: after the lookup, report_not_found leaks.
    expect(denial).toBeLessThan(lookup);
  });

  it('keeps every historical branch of the original gate intact', () => {
    const body = fn();
    for (const branch of [
      "phoenix_my_role() = 'super_admin'",
      "phoenix_my_role() IN ('institution_admin', 'central_warehouse_manager')",
      'phoenix_profile_has_point_assignment(v_actor, p_distribution_point_id)',
      'report_not_found',
    ]) expect(body, branch).toContain(branch);
  });

  it('denies outright rather than serving a filtered sector aggregate', () => {
    // The projection is deliberately UNCHANGED — the role is refused, not handed
    // a narrowed slice of sector-derived classification/expiry values.
    expect(fn()).toContain('l.classification, l.nearest_expiry_date');
  });

  it('VERIFY asserts both the denial position and the systemic family rule', () => {
    expect(sql).toContain('VERIFY FAILED (182/9f)');
    expect(sql).toContain("permission_key LIKE 'status_center.%'");
  });
});

describe('182 manual rollback documentation', () => {
  it('lists every object the migration creates', () => {
    const rollback = sql.slice(sql.indexOf('-- ROLLBACK (manual):'));
    for (const object of [
      'dp_read_perm',
      'organization_facilities_select_scoped',
      'role_permission_defaults',
      'profiles_health_center_manager_org_guard_trg',
      '_phoenix_profile_role_organization_guard_v1',
      'phoenix_admin_assign_facility_scopes',
      'phoenix_profile_has_facility_assignment',
      'psa_active_facility_uniq',
      'psa_facility_idx',
      'psa_facility_org_fk',
      'facility_id',
    ]) expect(rollback, object).toContain(object);
  });

  it('warns that dropping the column destroys assignment history', () => {
    const rollback = sql.slice(sql.indexOf('-- ROLLBACK (manual):'));
    expect(rollback).toMatch(/destroys facility assignment HISTORY/i);
  });
});
