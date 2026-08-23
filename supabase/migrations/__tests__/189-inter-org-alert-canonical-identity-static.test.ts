import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REVIEWED_MIGRATION_FILES, findUnreviewedMigrationFiles } from './helpers/reviewed-migrations';

const MIGRATIONS_DIR = join(__dirname, '..');
const NAME = '189_phoenix_inter_org_alert_canonical_identity.sql';
const sql = readFileSync(join(MIGRATIONS_DIR, NAME), 'utf8');

/**
 * The migration's own VERIFY block legitimately contains every forbidden
 * expression as a rejection pattern, so a whole-file `not.toContain` would
 * assert the opposite of what it reads. Each executable body is isolated by its
 * own dollar-quote tag instead — same isolation rationale as the 188 and 177
 * static suites.
 */
const between = (openTag: string, closeTag: string): string => {
  const open = sql.indexOf(openTag);
  const close = sql.indexOf(closeTag, open + openTag.length);
  if (open === -1 || close === -1) throw new Error(`189: could not isolate ${openTag}`);
  return sql.slice(open + openTag.length, close);
};

const bridgeBody = between('AS $bridge$', '$bridge$;');
const preflightBlock = sql.slice(sql.indexOf('DO $preflight$'), sql.indexOf('$preflight$;'));
const verifyBlock = sql.slice(sql.indexOf('DO $verify$'), sql.indexOf('$verify$;'));
const baseBody = between('AS $fn_base$', '$fn_base$;');
const stateBody = between('AS $fn_state$', '$fn_state$;');
const bodies: readonly [string, string][] = [['base', baseBody], ['with_state', stateBody]];

/** Literal occurrence count — the only way to tell 'JOIN x' from 'LEFT JOIN x'. */
const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** Everything except the two RPC bodies and the bridge — headers + DO blocks. */
const scaffolding = sql
  .replace(bridgeBody, '')
  .replace(baseBody, '')
  .replace(stateBody, '');

describe('189 · registration and file hygiene', () => {
  it('exists exactly once, is registered, and is manual-apply-only', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('189_'))).toEqual([NAME]);
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
    expect(findUnreviewedMigrationFiles(readdirSync(MIGRATIONS_DIR))).toEqual([]);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('supabase db push');
  });

  it('is LF-only (162 portability contract)', () => {
    expect(sql.includes('\r')).toBe(false);
  });

  it('is exactly one transaction with no rollback path', () => {
    expect(sql).toContain('\nBEGIN;');
    expect(sql).toContain('\nCOMMIT;');
    expect(sql.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(sql.match(/\nCOMMIT;/g)).toHaveLength(1);
    for (const body of [bridgeBody, baseBody, stateBody]) {
      expect(body).not.toMatch(/\bROLLBACK\b/);
    }
  });

  // G4.2 / M191 (canonical facility/scope topology) is now the single highest
  // reviewed migration. 189 is no longer the ceiling, so this guard is
  // re-pointed by EXACT filename rather than weakened: 190 then 191 are the
  // only successors, and 192 takes over the fail-closed role.
  it('is followed by exactly 190 through 198, the new ceiling, and 199 stays absent', () => {
    const NEXT = '190_phoenix_inter_org_alert_cqrs_boundary.sql';
    const NEXT_2 = '191_phoenix_canonical_scope_topology_read_contract.sql';
    const NEXT_3 = '192_phoenix_anonymous_read_surface_convergence.sql';
    const NEXT_4 = '193_phoenix_inter_org_alert_command_surface_hardening.sql';
    const NEXT_5 = '194_phoenix_authorization_surface_reproducibility_convergence.sql';
    const NEXT_6 = '195_phoenix_auth_helper_profile_schema_qualification.sql';
    const NEXT_7 = '196_phoenix_secdef_relation_schema_qualification.sql';
    const NEXT_8 = '197_phoenix_public_execute_convergence.sql';
    const NEXT_9 = '198_phoenix_secdef_search_path_convergence.sql';
    const numbers = REVIEWED_MIGRATION_FILES.map(f => Number(f.slice(0, 3))).filter(Number.isFinite);
    expect(Math.max(...numbers)).toBe(198);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(REVIEWED_MIGRATION_FILES.slice(i + 1)).toEqual([NEXT, NEXT_2, NEXT_3, NEXT_4, NEXT_5, NEXT_6, NEXT_7, NEXT_8, NEXT_9]);
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1]).toBe(NEXT_9);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^190_/.test(f))).toEqual([NEXT]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^191_/.test(f))).toEqual([NEXT_2]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^192_/.test(f))).toEqual([NEXT_3]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^193_/.test(f))).toEqual([NEXT_4]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^194_/.test(f))).toEqual([NEXT_5]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^195_/.test(f))).toEqual([NEXT_6]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^196_/.test(f))).toEqual([NEXT_7]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^199_/.test(f))).toHaveLength(0);
  });
});

// ============================================================================
// No table schema expansion — G3.3 is a function-only delta.
// ============================================================================
describe('189 · no table DDL, no historical edit', () => {
  it('creates, alters and drops no table, column, constraint, index or policy', () => {
    for (const forbidden of [
      /\bCREATE\s+TABLE\b/i,
      /\bALTER\s+TABLE\b/i,
      /\bDROP\s+TABLE\b/i,
      /\bADD\s+COLUMN\b/i,
      /\bDROP\s+COLUMN\b/i,
      /\bADD\s+CONSTRAINT\b/i,
      /\bDROP\s+CONSTRAINT\b/i,
      /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i,
      /\bCREATE\s+POLICY\b/i,
      /\bDROP\s+POLICY\b/i,
      /\bCREATE\s+TRIGGER\b/i,
    ]) {
      expect(sql, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('does not touch the intra-sector facility topology that was cancelled', () => {
    for (const cancelled of [
      'topology_kind',
      'source_facility_id',
      'target_facility_id',
      'facility_peer_transfer',
      'facility_contact',
      'profile_delegated_scope_assignments',
    ]) {
      expect(sql, cancelled).not.toContain(cancelled);
    }
  });

  it('touches neither Transfer Suggestions nor the RBAC scope tables', () => {
    // Asserted against the EXECUTABLE bodies only: the header prose legitimately
    // names warehouse_stock / outlet_stock while explaining that this migration
    // leaves them as the only ordinary stock truths.
    for (const body of [bridgeBody, baseBody, stateBody]) {
      for (const untouched of [
        'inventory_transfer_suggestions',
        'inventory_suggestion_policy',
        'profile_scope_assignments',
        'warehouse_stock',
        'outlet_stock',
      ]) {
        expect(body, untouched).not.toContain(untouched);
      }
    }
  });
});

// ============================================================================
// CHANGE 1 — the shared canonical identity bridge.
// ============================================================================
describe('189 · shared canonical material-identity bridge', () => {
  it('is created exactly once as the single shared object', () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION public\._phoenix_availability_material_identity_v1\(\n/g))
      .toHaveLength(1);
    // …and the retired set-returning form is explicitly dropped, so no overload
    // of the old shape can survive a re-apply.
    expect(sql).toContain('DROP FUNCTION IF EXISTS public._phoenix_availability_material_identity_v1();');
    expect(sql).not.toMatch(/RETURNS TABLE \(availability_id uuid/);
  });

  it('is a TOTAL SCALAR resolver anchored on one row', () => {
    // The anchor is the load-bearing part. Without it, a port-name-only row
    // (019 made local_item_id nullable) matches no local_items row, the SELECT
    // returns no row at all, and the function yields NULL — B1 in a new costume.
    expect(bridgeBody).toContain('FROM (SELECT 1) AS anchor');
    expect(bridgeBody).not.toMatch(/FROM\s+public\.local_items/i);
    expect(bridgeBody).not.toMatch(/FROM\s+public\.item_availability/i);
    // Scalar, not set-returning: identity is computed per surviving row.
    const decl = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public._phoenix_availability_material_identity_v1('),
      sql.indexOf('AS $bridge$'),
    );
    expect(decl).toContain('RETURNS text');
    expect(decl).not.toContain('RETURNS TABLE');
    for (const arg of ['p_local_item_id   uuid', 'p_scientific_name text',
      'p_national_code   text', 'p_concentration   text', 'p_dosage_form     text']) {
      expect(decl, arg).toContain(arg);
    }
  });

  it('LEFT JOINs both catalog hops, so a port-name-only row is never dropped', () => {
    expect(bridgeBody).toContain('public._phoenix_material_identity_v1(');
    expect(bridgeBody).toContain('li.central_item_id');
    expect(bridgeBody).toContain('ci.unit');

    // 019 dropped NOT NULL from item_availability.local_item_id, so BOTH hops
    // must be LEFT. COUNTED, never substring-matched: 'JOIN public.local_items'
    // is itself a substring of 'LEFT JOIN public.local_items', so a bare
    // toContain('JOIN public.local_items') is satisfied by an INNER JOIN too —
    // which is exactly how the previous revision of this suite pinned the bug
    // it was supposed to catch. Equal counts prove every join is the LEFT form.
    for (const table of ['public.local_items', 'public.central_items']) {
      expect(occurrences(bridgeBody, `JOIN ${table}`), table).toBe(1);
      expect(occurrences(bridgeBody, `LEFT JOIN ${table}`), table).toBe(1);
    }
    // No other join flavour may reach those hops either.
    expect(bridgeBody).not.toMatch(/(INNER|RIGHT|FULL|CROSS)\s+JOIN/i);

    // All six canonical inputs, in the order 150 defines them.
    const args = bridgeBody.slice(
      bridgeBody.indexOf('_phoenix_material_identity_v1('),
      bridgeBody.indexOf(')', bridgeBody.indexOf('ci.unit')),
    );
    for (const arg of ['li.central_item_id', 'p_scientific_name', 'p_national_code',
      'p_concentration', 'p_dosage_form', 'ci.unit']) {
      expect(args, arg).toContain(arg);
    }
  });

  it('the LEFT-JOIN pin genuinely rejects an INNER JOIN bridge', () => {
    // A guard that cannot fail proves nothing. Re-run the same predicate over a
    // deliberately regressed copy of the bridge and require it to reject.
    const leftJoined = (body: string): boolean =>
      ['public.local_items', 'public.central_items'].every(
        t => occurrences(body, `JOIN ${t}`) === 1 && occurrences(body, `LEFT JOIN ${t}`) === 1,
      );
    expect(leftJoined(bridgeBody)).toBe(true);
    expect(leftJoined(bridgeBody.replace(/LEFT JOIN/g, 'JOIN'))).toBe(false);
  });

  it('is TOTAL over item_availability — it filters and fabricates nothing', () => {
    // Row preservation is the whole contract: exactly one bridge row per
    // availability row. A WHERE clause, a fabricated local_item_id or a
    // display-label substitute would each break it.
    expect(bridgeBody).not.toMatch(/\bWHERE\b/i);
    expect(bridgeBody).not.toMatch(/\bCOALESCE\b/i);
    expect(bridgeBody).not.toMatch(/\bgen_random_uuid\b/i);
    expect(bridgeBody).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    expect(bridgeBody).not.toMatch(/\b(LIMIT|DISTINCT|GROUP\s+BY|HAVING|UNION)\b/i);
  });

  it('never reconstructs the identity function in the bridge itself', () => {
    // The bridge must DELEGATE to 150's function, never reimplement its tuple.
    expect(bridgeBody).not.toMatch(/lower\s*\(\s*btrim/i);
    expect(bridgeBody).not.toContain('||');
  });

  it('is SECURITY DEFINER with an explicit search_path', () => {
    const decl = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public._phoenix_availability_material_identity_v1'),
      sql.indexOf('AS $bridge$'),
    );
    expect(decl).toContain('SECURITY DEFINER');
    expect(decl).toContain('SET search_path = public, pg_temp');
    expect(decl).toContain('STABLE');
  });

  it('is revoked from PUBLIC, anon and authenticated, and granted to nobody', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public._phoenix_availability_material_identity_v1(uuid,text,text,text,text)\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(sql).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\._phoenix_availability_material_identity_v1/i,
    );
  });
});

// ============================================================================
// CHANGE 2 + 3 — both callable RPCs, hardened IDENTICALLY.
// A single hardened RPC beside a legacy one is the bypass this migration exists
// to close, so every rule below is asserted against BOTH bodies.
// ============================================================================
describe('189 · dual RPC replacement in one transaction', () => {
  it('replaces both independently-callable RPCs, each exactly once', () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION public\.phoenix_get_live_inter_institution_alerts\(/g))
      .toHaveLength(1);
    expect(sql.match(/CREATE OR REPLACE FUNCTION public\.phoenix_get_live_inter_institution_alerts_with_state\(/g))
      .toHaveLength(1);
    // Both replacements sit between the single BEGIN and the single COMMIT.
    const begin = sql.indexOf('\nBEGIN;');
    const commit = sql.indexOf('\nCOMMIT;');
    expect(sql.indexOf('AS $fn_base$')).toBeGreaterThan(begin);
    expect(sql.indexOf('AS $fn_state$')).toBeGreaterThan(begin);
    expect(sql.indexOf('$fn_base$;')).toBeLessThan(commit);
    expect(sql.indexOf('$fn_state$;')).toBeLessThan(commit);
  });

  it('does NOT redefine the paged wrapper, which inherits at runtime', () => {
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_get_live_inter_institution_alerts_with_state_page/,
    );
    // …and the migration proves the delegation still holds.
    expect(scaffolding).toContain('phoenix_get_live_inter_institution_alerts_with_state(500)');
  });

  it.each(bodies)('%s — matches on canonical identity, never on labels', (_n, body) => {
    expect(body).toContain('s.material_identity_key = d.material_identity_key');
    expect(body).not.toContain('norm_sci');
    expect(body).not.toContain('norm_conc');
    expect(body).not.toContain('norm_dosage');
    // No display label may appear in a join predicate.
    const join = body.slice(body.indexOf('FROM supply s'), body.indexOf('scoped AS'));
    expect(join).not.toMatch(/s\.scientific_name\s*=\s*d\./);
    expect(join).not.toMatch(/s\.concentration\s*=\s*d\./);
    expect(join).not.toMatch(/s\.dosage_form\s*=\s*d\./);
    expect(join).not.toMatch(/s\.trade_name\s*=\s*d\./);
    expect(join).not.toMatch(/s\.national_code\s*=\s*d\./);
  });

  it.each(bodies)('%s — keeps the residual unresolved-identity filter', (_n, body) => {
    // Under the SCALAR design this predicate is genuinely load-bearing: a
    // resolver that lost its one-row anchor returns NULL, and these two filters
    // are what turns that into "no alert" rather than "everything matches".
    expect(body).toContain("effective_status IN ('surplus', 'near_expiry') AND material_identity_key IS NOT NULL");
    expect(body).toContain("effective_status IN ('missing', 'low_stock') AND material_identity_key IS NOT NULL");
    expect(body).not.toMatch(/COALESCE\s*\(\s*material_identity_key/i);
  });

  it.each(bodies)('%s — resolves identity PER ROW, never over the whole table', (_n, body) => {
    // The retired set-returning bridge had to be joined on availability_id,
    // which made it an opaque whole-table Function Scan whose cost was
    // independent of how few rows could participate.
    expect(body).not.toContain('_phoenix_availability_material_identity_v1()');
    expect(body).not.toMatch(/JOIN\s+public\._phoenix_availability_material_identity_v1/i);
    expect(body).toContain('public._phoenix_availability_material_identity_v1(');
    expect(body).toContain('ia.local_item_id, ia.scientific_name, ia.national_code');
    // Exactly one invocation per body — a second call would double the work.
    expect(body.match(/_phoenix_availability_material_identity_v1\(/g)).toHaveLength(1);
  });

  it.each(bodies)('%s — applies the participation pre-filter INSIDE candidates', (_n, body) => {
    const candidates = body.slice(body.indexOf('WITH candidates AS'), body.indexOf('supply AS'));
    expect(candidates).toContain('ia.quantity <= 0');
    expect(candidates).toContain("ia.condition IN ('missing', 'low_stock', 'surplus', 'near_expiry')");
    expect(candidates).toContain("ia.expiry_date <= (current_date + interval '9 months')::date");
    // …and the identity call sits in the SAME block, so the filter precedes it.
    expect(candidates).toContain('public._phoenix_availability_material_identity_v1(');
    // The downstream predicates are KEPT: the pre-filter is a performance
    // superset, never the place where eligibility is defined.
    expect(body).toContain("WHERE effective_status IN ('surplus', 'near_expiry')");
    expect(body).toContain("WHERE effective_status IN ('missing', 'low_stock')");
  });

  it.each(bodies)('%s — preserves the distinct-organization invariant verbatim', (_n, body) => {
    expect(body).toContain('s.organization_id <> d.organization_id');
    expect(body).not.toContain('s.organization_id = d.organization_id');
  });

  it.each(bodies)('%s — filters BOTH endpoints by a POSITIVE class allowlist', (_n, body) => {
    expect(body).toContain("o.organization_kind = 'care_institution'");
    expect(body).toContain(
      "o.institution_class IN ('health_sector', 'hospital', 'specialized_center')",
    );
    // The filter sits on the shared `candidates` set, which is the only source of
    // both `supply` and `demand` — so neither endpoint can escape it.
    const candidates = body.slice(body.indexOf('WITH candidates AS'), body.indexOf('supply AS'));
    expect(candidates).toContain("o.organization_kind = 'care_institution'");
    expect(candidates).toContain('JOIN public.organizations o');
    expect(body).toContain('SELECT * FROM candidates WHERE effective_status');
  });

  it.each(bodies)('%s — never uses a NULL-unsafe negated class predicate', (_n, body) => {
    expect(body).not.toMatch(/institution_class\s+NOT\s+IN/i);
    expect(body).not.toMatch(/organization_kind\s*<>/);
    expect(body).not.toMatch(/organization_kind\s+NOT\s+IN/i);
    expect(body).not.toContain('pharmacy_department_authority');
  });

  it.each(bodies)('%s — excludes removed availability rows', (_n, body) => {
    expect(body).toContain('ia.removed_at IS NULL');
  });

  it.each(bodies)('%s — uses the converged 9-month near-expiry window', (_n, body) => {
    expect(body).toContain("interval '9 months'");
    expect(body).not.toContain("<= (current_date + interval '3 months')::date THEN 'near_expiry'");
  });

  it.each(bodies)('%s — is SECURITY DEFINER with an explicit search_path', (_n, _b) => {
    const tag = _n === 'base' ? 'AS $fn_base$' : 'AS $fn_state$';
    const fn = _n === 'base'
      ? 'CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts('
      : 'CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(';
    const decl = sql.slice(sql.indexOf(fn), sql.indexOf(tag));
    expect(decl).toContain('SECURITY DEFINER');
    expect(decl).toContain('SET search_path = public, pg_temp');
  });

  it.each(bodies)('%s — keeps supply/demand, severity and ordering semantics', (_n, body) => {
    expect(body).toContain("WHERE effective_status IN ('surplus', 'near_expiry')");
    expect(body).toContain("WHERE effective_status IN ('missing', 'low_stock')");
    expect(body).toContain("THEN 'near_expiry_to_shortage' ELSE 'surplus_to_shortage'");
    expect(body).toContain("THEN 'high' ELSE 'medium'");
    expect(body).toContain('LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)');
    expect(body).toContain('WHERE v_is_super OR m.src_org = v_org OR m.tgt_org = v_org');
  });

  it.each(bodies)('%s — keeps the authentication and permission gate', (_n, body) => {
    expect(body).toContain("'NOT_AUTHENTICATED'");
    expect(body).toContain("'ACTOR_PROFILE_NOT_FOUND'");
    expect(body).toContain("'FORBIDDEN'");
    expect(body).toContain("phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.view')");
    expect(body).toContain("phoenix_profile_has_permission(v_actor, 'exchange_alerts.view')");
    // No new permission key is introduced by this migration.
    expect(body).not.toContain('alerts.canonical');
  });

  // The two RPCs must ask the SAME eligibility question. Comment lines are
  // stripped so the guard pins the PREDICATES rather than the prose around
  // them — a comment may legitimately differ, a predicate may not.
  const code = (s: string): string =>
    s.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');

  it('applies identical candidate predicates to both RPCs', () => {
    const slice = (body: string): string =>
      code(body.slice(body.indexOf('WITH candidates AS'), body.indexOf('supply AS')));
    expect(slice(baseBody)).toBe(slice(stateBody));
  });

  it('applies an identical match predicate to both RPCs', () => {
    const slice = (body: string): string =>
      code(body.slice(body.indexOf('FROM supply s'), body.indexOf('scoped AS')));
    expect(slice(baseBody)).toBe(slice(stateBody));
  });
});

// ============================================================================
// Contract compatibility — eligibility converges, payloads deliberately do not.
// ============================================================================
describe('189 · payload contracts unchanged', () => {
  it('base RPC payload is NOT widened with with_state-only fields', () => {
    for (const stateOnly of [
      'source_contact_phone',
      'target_contact_phone',
      'source_expiry_risk_tier',
      'source_expiry_days_remaining',
      'lifecycle_status',
      'alert_key',
      'inter_org_alert_states',
      'inter_org_alert_events',
    ]) {
      expect(baseBody, stateOnly).not.toContain(stateOnly);
    }
  });

  it('base RPC keeps every field its consumers already read', () => {
    for (const field of [
      'alert_type', 'severity',
      'source_item_availability_id', 'target_item_availability_id',
      'source_organization_id', 'source_organization_name', 'source_organization_name_ar',
      'source_distribution_point_id', 'source_distribution_point_name',
      'source_distribution_point_name_ar',
      'target_organization_id', 'target_organization_name', 'target_organization_name_ar',
      'target_distribution_point_id', 'target_distribution_point_name',
      'target_distribution_point_name_ar',
      'scientific_name', 'concentration', 'dosage_form',
      'source_trade_name', 'target_trade_name',
      'source_status', 'target_status',
      'source_quantity', 'target_quantity',
      'source_expiry_date', 'computed_at',
    ]) {
      expect(baseBody, field).toContain(`'${field}',`);
    }
  });

  it('with_state RPC keeps its full existing contract', () => {
    for (const field of [
      'source_expiry_risk_tier', 'source_expiry_days_remaining',
      'source_contact_phone', 'target_contact_phone',
      'alert_key', 'lifecycle_status', 'first_seen_at', 'last_seen_at',
      'acknowledged_at', 'acknowledged_by', 'in_progress_at', 'in_progress_by',
      'resolved_at', 'resolved_by', 'dismissed_at', 'dismissed_by',
      'lifecycle_reason', 'lifecycle_notes',
    ]) {
      expect(stateBody, field).toContain(`'${field}',`);
    }
  });

  it('with_state keeps the lifecycle upsert and the opened event', () => {
    expect(stateBody).toContain('INSERT INTO public.inter_org_alert_states');
    expect(stateBody).toContain('ON CONFLICT (alert_key) DO UPDATE SET');
    expect(stateBody).toContain('INSERT INTO public.inter_org_alert_events');
    expect(stateBody).toContain("SELECT id, 'opened'");
    expect(stateBody).toContain('WHERE was_inserted');
    // Lifecycle columns are still never overwritten by a recompute.
    const conflict = stateBody.slice(
      stateBody.indexOf('ON CONFLICT (alert_key) DO UPDATE SET'),
      stateBody.indexOf('RETURNING'),
    );
    for (const preserved of ['status', 'reason', 'notes', 'acknowledged_at', 'resolved_at', 'dismissed_at']) {
      expect(conflict, preserved).not.toContain(`${preserved} =`);
    }
  });

  it('with_state keeps organization-level contact resolution unchanged', () => {
    expect(stateBody).toContain('FROM public.organization_status_contacts osc');
    expect(stateBody).toContain('ORDER BY osc.is_primary DESC');
    expect(stateBody).toContain('osc.is_active = true');
    expect(stateBody.match(/FROM public\.organization_status_contacts osc/g)).toHaveLength(2);
  });

  it('keeps the historical alert_key shape, so historical rows stay valid', () => {
    expect(stateBody).toContain(
      "(m.src_availability_id::text || ':' || m.tgt_availability_id::text || ':' || m.alert_type) AS alert_key",
    );
  });
});

// ============================================================================
// Security posture.
// ============================================================================
// ============================================================================
// The migration must describe the schema it actually runs against. The first
// revision asserted a NOT NULL chain that 019 had already dismantled.
// ============================================================================
describe('189 · preflight tells the truth about its schema lineage', () => {
  it('makes no claim that item_availability.local_item_id is NOT NULL', () => {
    expect(sql).not.toMatch(/item_availability\.local_item_id\s*->/);
    expect(sql).not.toContain('a nullable hop would silently');
    expect(sql).not.toContain('already NOT NULL:');
  });

  it('records the real 019 lineage in prose', () => {
    expect(sql).toContain('019 DROPPED that NOT NULL');
    expect(sql).toContain('CHECK (local_item_id IS NOT NULL OR port_name IS NOT NULL)');
    expect(sql).toContain('THE CATALOG HOP IS OPTIONAL, SO THE RESOLVER MUST BE TOTAL.');
  });

  it('asserts the nullable hop and its CHECK constraint at apply time', () => {
    expect(preflightBlock).toContain("table_name='item_availability'");
    expect(preflightBlock).toContain("column_name='local_item_id' AND is_nullable='YES'");
    expect(preflightBlock).toContain("LIKE '%local_item_id IS NOT NULL%'");
    expect(preflightBlock).toContain("LIKE '%port_name IS NOT NULL%'");
  });

  it('still asserts the hops that genuinely ARE NOT NULL', () => {
    expect(preflightBlock).toContain("column_name='central_item_id' AND is_nullable='NO'");
    expect(preflightBlock).toContain("column_name='unit' AND is_nullable='NO'");
  });
});

// ============================================================================
// Migration replay + a text-only verify were both green while the bridge was
// silently dropping rows. The verify block must now prove BEHAVIOUR.
// ============================================================================
describe('189 · verify proves behaviour, not only text', () => {
  it('proves TOTALITY data-independently, with no reliance on seeded rows', () => {
    // The retired cardinality proof went silent on any database that happened
    // to hold no port-name-only row — which is every clean 001->189 replay.
    expect(verifyBlock).toContain("public._phoenix_availability_material_identity_v1(\n    NULL, 'verify probe 189', NULL, '500 mg', 'tablet')");
    expect(verifyBlock).toContain('IF v_unresolved_key IS NULL THEN');
    expect(verifyBlock).toContain('the identity resolver is NOT TOTAL');
    // …and it no longer counts rows it cannot rely on existing.
    expect(verifyBlock).not.toContain('v_bridge_rows');
    expect(verifyBlock).not.toContain('is not row-preserving');
  });

  it('pins the one-row anchor and both LEFT hops on the resolver', () => {
    expect(verifyBlock).toContain("v_resolver_def NOT LIKE '%FROM (SELECT 1) AS anchor%'");
    expect(verifyBlock).toContain('lost its one-row anchor');
    for (const t of ['public.local_items', 'public.central_items']) {
      expect(verifyBlock, t).toContain(`string_to_array(v_resolver_def, 'JOIN ${t}')`);
      expect(verifyBlock, t).toContain(`string_to_array(v_resolver_def, 'LEFT JOIN ${t}')`);
    }
    expect(verifyBlock).toContain('INNER JOINs local_items');
    expect(verifyBlock).toContain('INNER JOINs central_items');
    expect(verifyBlock).toContain("v_resolver_def NOT LIKE '%SET search_path%'");
  });

  it('rejects the retired set-returning bridge in either RPC', () => {
    expect(verifyBlock).toContain('the retired set-returning bridge still exists');
    expect(verifyBlock).toContain('the retired set-returning bridge is still referenced');
  });

  it('requires the participation pre-filter in BOTH bodies', () => {
    expect(verifyBlock).toContain('participation pre-filter absent from candidates');
    expect(verifyBlock).toContain('participation pre-filter lost its zero-quantity arm');
  });

  it('proves deterministic encoding of every missing component', () => {
    expect(verifyBlock).toContain("'%|central=N|%'");
    expect(verifyBlock).toContain("'%|unit=N'");
    expect(verifyBlock).toContain("'%|national=N|%'");
    expect(verifyBlock).toContain('not encoded as the explicit N marker');
    // …and that a RESOLVABLE hop is actually honoured, guarded on one existing.
    expect(verifyBlock).toContain('resolver ignored a resolvable catalog hop');
    expect(verifyBlock).toContain('catalogued and port-name-only identities collide');
  });

  it('pins owner decision M5 — full canonical identity, no label fallback', () => {
    expect(verifyBlock).toContain('collides with a catalogued one');
    expect(verifyBlock).toContain('national_code is not a canonical identity component');
    expect(verifyBlock).toContain('unit is not a canonical identity component');
  });
});

describe('189 · ACL documentation matches the catalog', () => {
  it('states the bridge contract per role, not as "every client role"', () => {
    expect(sql).not.toContain('It is itself revoked from every client role');
    expect(sql).toContain('PUBLIC        — no direct execute');
    expect(sql).toContain('anon          — no direct execute');
    expect(sql).toContain('authenticated — no direct execute');
  });

  it('does not misclassify service_role as an anonymous or client surface', () => {
    expect(sql).toContain('service_role is deliberately absent from that list');
    expect(sql).toContain('never an anonymous or client surface');
    expect(verifyBlock).toContain("rolname = 'service_role'");
    expect(verifyBlock).toContain('decided by 109 default privileges, not by 189');
  });

  it('asserts PUBLIC explicitly, not only through anon and authenticated', () => {
    expect(verifyBlock).toContain('aclexplode');
    expect(verifyBlock).toContain('a.grantee = 0');
    expect(verifyBlock).toContain('executable by PUBLIC, anon or authenticated');
    expect(verifyBlock).toContain('default function ACL');
  });
});

describe('189 · security posture', () => {
  it('keeps both RPCs authenticated-only', () => {
    for (const fn of [
      'public.phoenix_get_live_inter_institution_alerts(integer)',
      'public.phoenix_get_live_inter_institution_alerts_with_state(integer)',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${fn}\n  FROM PUBLIC, anon;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${fn}\n  TO authenticated;`);
    }
  });

  it('grants nothing to anon, service_role or PUBLIC', () => {
    expect(sql).not.toMatch(/GRANT[^;]*TO[^;]*\banon\b/i);
    expect(sql).not.toMatch(/GRANT[^;]*TO[^;]*\bservice_role\b/i);
    expect(sql).not.toMatch(/GRANT[^;]*TO\s+PUBLIC/i);
  });

  it('never widens authorization or bypasses RLS beyond the existing gate', () => {
    for (const body of [baseBody, stateBody]) {
      expect(body).not.toMatch(/SET\s+ROLE/i);
      expect(body).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
      expect(body).not.toMatch(/BYPASSRLS/i);
      expect(body).not.toContain('service_role');
    }
  });

  it('runs a preflight and a verify block, both fail-closed', () => {
    expect(sql).toContain('DO $preflight$');
    expect(sql).toContain('DO $verify$');
    expect(scaffolding).toContain('189_precondition_failed');
    expect(scaffolding).toContain('189 verify failed');
  });

  it('verify proves BOTH RPCs, not just one', () => {
    const verify = sql.slice(sql.indexOf('DO $verify$'), sql.indexOf('$verify$;'));
    expect(verify).toContain("ARRAY['base', 'with_state']");
    expect(verify).toContain('pg_get_functiondef');
    expect(verify).toContain('has_function_privilege');
    // The bridge must be proven un-callable by clients at apply time.
    expect(verify).toContain('identity bridge is executable by a client role');
  });
});
