/**
 * 184 · CANONICAL SUPPLY CYCLE (R1.3) — static proof.
 *
 * Source-level guards that need no database. The dynamic sibling proves that
 * `central -> health-centre depot` is refused TODAY; this file proves the
 * STRUCTURAL properties that keep that refusal correct after the next
 * migration, which no behavioural suite can assert:
 *
 *   * ONE AUTHOR. The facility-bound / care-institution / institution_class
 *     rule is stated in exactly one function. Supply Branch A and return
 *     Branch A both DELEGATE to it rather than carrying a second copy that
 *     could drift — the failure mode R1.2C found when a preflight re-implemented
 *     a validator by hand.
 *   * THE CAPSULES ARE INTERNAL. Neither is reachable by anon, authenticated or
 *     service_role, so the narrowing cannot be probed or satisfied piecemeal.
 *   * BRANCH B IS UNTOUCHED. Every 165 same-sector identifier survives in both
 *     validators.
 *   * HISTORY IS NOT REWRITTEN. The migration contains no data DML at all.
 *
 * Behavioural proof lives in 184-canonical-supply-cycle.dynamic.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { activeSql, executableSql, sqlFunctionSource } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '184_phoenix_canonical_supply_cycle.sql';
const raw = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8');
const sql = raw.replace(/\r\n?/g, '\n');
const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'));

/** Statements that run at apply time (function bodies / DO blocks stripped). */
const applyTime = code.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, '\n/* body removed */\n');
const bare = activeSql(code);
const applyBare = activeSql(applyTime);
/** Comments removed AND literals blanked — required for NEGATIVE claims. */
const executable = executableSql(code);

const CAPSULE = '_phoenix_assert_external_corridor_institution_root_v1';
const PROC_CAPSULE = '_phoenix_assert_local_procurement_root_v1';
const SUPPLY = 'phoenix_assert_direct_supply_endpoints';
const RETURN_FN = 'phoenix_assert_direct_return_endpoints';
const PROCUREMENT = 'phoenix_procurement_create_order';
const ROUTE_ASSERT = 'phoenix_supply_route_assert_endpoints';
const PROC_GUARD = '_phoenix_procurement_order_root_guard_v1';
const ROUTE_GUARD = '_phoenix_supply_route_topology_guard_v1';
const ROUTED_XFER_GUARD = '_phoenix_routed_forward_topology_guard_v1';
const ROUTED_RET_GUARD = '_phoenix_routed_return_topology_guard_v1';
/** Every function 184 defines that must be unreachable by any external role. */
const INTERNAL_ONLY = [
  CAPSULE, PROC_CAPSULE, PROC_GUARD, ROUTE_GUARD,
  ROUTED_XFER_GUARD, ROUTED_RET_GUARD, ROUTE_ASSERT,
];

const fn = (name: string): string => {
  const src = sqlFunctionSource(code, name);
  expect(src, `${name} must be defined in ${NAME}`).toBeTruthy();
  return src as string;
};

describe('184 · registration and file hygiene', () => {
  it('is registered in the reviewed-migration manifest', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
  });

  // M191 (G4.2 canonical facility/scope topology read contract) is the new single highest
  // reviewed migration. The guard is not weakened — it is re-pointed by EXACT
  // filename at the new ceiling, and 192 takes over the fail-closed role 191
  // used to play.
  it('is followed by exactly 185 through 201, with 201 highest reviewed', () => {
    const NEXT = '185_phoenix_return_quarantine_recall_parity.sql';
    const NEXT_2 = '186_phoenix_correction_reason_code_wrapper_parity.sql';
    const NEXT_3 = '187_phoenix_delegated_operational_access.sql';
    const NEXT_4 = '188_phoenix_public_qr_facility_context.sql';
    const NEXT_5 = '189_phoenix_inter_org_alert_canonical_identity.sql';
    const NEXT_6 = '190_phoenix_inter_org_alert_cqrs_boundary.sql';
    const NEXT_7 = '191_phoenix_canonical_scope_topology_read_contract.sql';
    const NEXT_8 = '192_phoenix_anonymous_read_surface_convergence.sql';
    const NEXT_9 = '193_phoenix_inter_org_alert_command_surface_hardening.sql';
    const NEXT_10 = '194_phoenix_authorization_surface_reproducibility_convergence.sql';
    const NEXT_11 = '195_phoenix_auth_helper_profile_schema_qualification.sql';
    const NEXT_12 = '196_phoenix_secdef_relation_schema_qualification.sql';
    const NEXT_13 = '197_phoenix_public_execute_convergence.sql';
    const NEXT_14 = '198_phoenix_secdef_search_path_convergence.sql';
    const NEXT_15 = '199_phoenix_command_center_read_contract.sql';
    const NEXT_16 = '200_phoenix_demo_purge_auth_boundary_correction.sql';
    const NEXT_17 = '201_phoenix_organization_archive_dependency_guard.sql';
    const numbers = REVIEWED_MIGRATION_FILES
      .map(f => Number(f.slice(0, 3)))
      .filter(n => Number.isFinite(n));
    expect(Math.max(...numbers)).toBe(201);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('184_'))).toHaveLength(1);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('185_'))).toEqual([NEXT]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('186_'))).toEqual([NEXT_2]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('187_'))).toEqual([NEXT_3]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('188_'))).toEqual([NEXT_4]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('189_'))).toEqual([NEXT_5]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('190_'))).toEqual([NEXT_6]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('191_'))).toEqual([NEXT_7]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('192_'))).toEqual([NEXT_8]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('193_'))).toEqual([NEXT_9]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('194_'))).toEqual([NEXT_10]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('195_'))).toEqual([NEXT_11]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('196_'))).toEqual([NEXT_12]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('197_'))).toEqual([NEXT_13]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('198_'))).toEqual([NEXT_14]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('199_'))).toEqual([NEXT_15]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('200_'))).toEqual([NEXT_16]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('201_'))).toEqual([NEXT_17]);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(REVIEWED_MIGRATION_FILES.slice(i + 1)).toEqual([NEXT, NEXT_2, NEXT_3, NEXT_4, NEXT_5, NEXT_6, NEXT_7, NEXT_8, NEXT_9, NEXT_10, NEXT_11, NEXT_12, NEXT_13, NEXT_14, NEXT_15, NEXT_16, NEXT_17]);
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1]).toBe(NEXT_17);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^202_/.test(f))).toHaveLength(0);
  });

  it('carries no CR bytes', () => {
    expect(raw.includes('\r')).toBe(false);
  });

  it('is one transaction', () => {
    expect(sql.includes('BEGIN;')).toBe(true);
    expect(sql.includes('\nCOMMIT;')).toBe(true);
    expect(bare).not.toMatch(/\bROLLBACK\b/);
  });
});

describe('184 · object inventory', () => {
  it('creates or replaces exactly the ten canonical functions', () => {
    const created = [...bare.matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([A-Za-z0-9_]+)\s*\(/g,
    )].map(m => m[1]).sort();

    expect(created).toEqual([
      PROC_CAPSULE,
      CAPSULE,
      SUPPLY,
      RETURN_FN,
      PROCUREMENT,
      ROUTE_ASSERT,
      PROC_GUARD,
      ROUTE_GUARD,
      ROUTED_XFER_GUARD,
      ROUTED_RET_GUARD,
    ].sort());
  });

  it('drops no function, table, policy or type, and creates no table or index', () => {
    // The only DROPs are the two idempotent `DROP TRIGGER IF EXISTS` that
    // precede this migration's own CREATE TRIGGER statements.
    expect(executable).not.toMatch(/\bDROP\s+(FUNCTION|TABLE|POLICY|TYPE|INDEX|CONSTRAINT)\b/i);
    expect(executable).not.toMatch(/\bCREATE\s+(TABLE|POLICY|TYPE|INDEX)\b/i);
    expect(executable).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it('installs EXACTLY six write boundaries across six tables', () => {
    // R1.3 asks for ONE capsule per question, not a parallel enforcement mesh.
    // The ROUTED corridor needs BOTH its request table and its movement table:
    // 127's routed send writes the transfer header with transfer_request_id
    // NULL, so a request-only boundary would never fire for the path that
    // actually moves stock. Same shape on the return half.
    const triggers = [...applyBare.matchAll(
      /CREATE\s+TRIGGER\s+([A-Za-z0-9_]+)\s+BEFORE\s+([A-Z\s]+?)\s+ON\s+public\.([A-Za-z0-9_]+)/g,
    )].map(m => ({ name: m[1], when: m[2].trim(), table: m[3] }));

    expect(triggers).toEqual([
      { name: 'phoenix_procurement_order_root_guard', when: 'INSERT OR UPDATE', table: 'procurement_orders' },
      { name: 'phoenix_supply_route_topology_guard',  when: 'INSERT OR UPDATE', table: 'warehouse_supply_routes' },
      { name: 'phoenix_routed_forward_topology_guard', when: 'INSERT OR UPDATE', table: 'warehouse_transfer_requests' },
      { name: 'phoenix_routed_forward_topology_guard', when: 'INSERT OR UPDATE', table: 'warehouse_transfers' },
      { name: 'phoenix_routed_return_topology_guard',  when: 'INSERT OR UPDATE', table: 'warehouse_return_requests' },
      { name: 'phoenix_routed_return_topology_guard',  when: 'INSERT OR UPDATE', table: 'warehouse_return_shipments' },
    ]);

    // Six DISTINCT tables — no table carries two of this migration's triggers.
    expect(new Set(triggers.map(t => t.table)).size).toBe(6);

    // Each DROP TRIGGER must target only a trigger this migration creates, on
    // the same table it then creates it on.
    const drops = [...applyBare.matchAll(/DROP\s+TRIGGER\s+IF\s+EXISTS\s+([A-Za-z0-9_]+)\s+ON\s+public\.([A-Za-z0-9_]+)/g)]
      .map(m => ({ name: m[1], table: m[2] }));
    expect(drops).toEqual(triggers.map(t => ({ name: t.name, table: t.table })));
  });

  it('the routed corridor is guarded on BOTH its request and its movement table', () => {
    // The defect this closes: guarding only the request table left the routed
    // send — which writes warehouse_transfers with transfer_request_id NULL —
    // completely unguarded.
    const tablesFor = (trigger: string) => [...applyBare.matchAll(
      new RegExp(
        `CREATE\\s+TRIGGER\\s+${trigger}\\s+BEFORE\\s+INSERT\\s+OR\\s+UPDATE\\s+ON\\s+public\\.([A-Za-z0-9_]+)`,
        'g',
      ),
    )].map(m => m[1]);

    expect(tablesFor('phoenix_routed_forward_topology_guard'))
      .toEqual(['warehouse_transfer_requests', 'warehouse_transfers']);
    expect(tablesFor('phoenix_routed_return_topology_guard'))
      .toEqual(['warehouse_return_requests', 'warehouse_return_shipments']);
  });

  it('the procurement boundary judges a RETARGET, not only an INSERT', () => {
    // An order is a standing authorization to post stock into its warehouse
    // (phoenix_procurement_receive_order), and service_role holds UPDATE, so
    // INSERT-only would let a retarget walk a legal order into a depot.
    expect(fn(PROC_GUARD)).toMatch(/TG_OP = 'UPDATE' AND OLD\.warehouse_id = NEW\.warehouse_id/);
  });

  it('the route boundary short-circuit compares BOTH endpoints', () => {
    // Keying on the target alone would let a source-only swap install an
    // INACTIVE central behind an already-active route.
    const guard = fn(ROUTE_GUARD);
    expect(guard).toMatch(/OLD\.target_warehouse_id = NEW\.target_warehouse_id/);
    expect(guard).toMatch(/OLD\.source_warehouse_id = NEW\.source_warehouse_id/);
  });

  it('the corridor boundaries judge the ROUTED path with the capsule', () => {
    // The forward boundary judges the DESTINATION; the return boundary judges
    // the SOURCE, because 069 reads the route in reverse.
    expect(fn(ROUTED_XFER_GUARD)).toMatch(/NEW\.destination_warehouse_id, 'supply_destination'/);
    expect(fn(ROUTED_RET_GUARD)).toMatch(/NEW\.source_warehouse_id, 'return_source'/);
  });

  it('the corridor boundaries ALSO judge the DIRECT path, via the direct validator', () => {
    // THE bypass this section exists to close. phoenix_assert_direct_supply_
    // endpoints is reached only from inside RPC bodies —
    // _phoenix_authorize_transfer_request_write is a plain function five RPCs
    // PERFORM, not a trigger — and 001-183 put no authorization trigger on these
    // tables at all. A boundary that returned early on `route_id IS NULL` would
    // therefore leave a raw direct `central -> facility-bound depot` INSERT
    // unjudged on the very table that carries the stock.
    //
    // Delegating to the DIRECT validator (never the external-corridor capsule)
    // is simultaneously what keeps Branch B legal: Branch B is one of that
    // validator's two branches.
    for (const guard of [ROUTED_XFER_GUARD, ROUTED_RET_GUARD]) {
      expect(fn(guard)).toMatch(/IF NEW\.route_id IS NULL THEN/);
      expect(fn(guard)).not.toMatch(/IF NEW\.route_id IS NULL THEN\s*\n\s*RETURN NEW;/);
    }
    expect(fn(ROUTED_XFER_GUARD)).toMatch(
      /PERFORM public\.phoenix_assert_direct_supply_endpoints\(\s*\n?\s*NEW\.source_warehouse_id, NEW\.destination_warehouse_id, NULL/);
    expect(fn(ROUTED_RET_GUARD)).toMatch(
      /PERFORM public\.phoenix_assert_direct_return_endpoints\(\s*\n?\s*NEW\.source_warehouse_id, NEW\.destination_warehouse_id/);
  });

  it('every boundary leaves genuine history alone via an explicit short-circuit', () => {
    // None of the four guards re-judges a row whose guarded endpoint did not
    // change, so an ordinary status transition on a legacy row never fails.
    expect(fn(PROC_GUARD)).toMatch(/TG_OP = 'UPDATE'/);
    expect(fn(ROUTE_GUARD)).toMatch(/TG_OP = 'UPDATE'/);
    expect(fn(ROUTED_XFER_GUARD)).toMatch(/TG_OP = 'UPDATE'/);
    expect(fn(ROUTED_RET_GUARD)).toMatch(/TG_OP = 'UPDATE'/);
  });

  it('the corridor short-circuit is route-agnostic and compares BOTH endpoints', () => {
    // A LEGACY direct `central -> depot` row must keep its complete lifecycle:
    // 184 rewrites no history and must refuse no transition on stored state.
    // Keying the exemption on `OLD.route_id IS NOT NULL` would have re-judged
    // every ordinary status UPDATE on such a row and refused it. Comparing both
    // endpoints (and route_id) is what still makes a RETARGET a new
    // authorization.
    for (const guard of [ROUTED_XFER_GUARD, ROUTED_RET_GUARD]) {
      const body = fn(guard);
      expect(body).toMatch(/OLD\.route_id IS NOT DISTINCT FROM NEW\.route_id/);
      expect(body).toMatch(/OLD\.source_warehouse_id IS NOT DISTINCT FROM NEW\.source_warehouse_id/);
      expect(body).toMatch(/OLD\.destination_warehouse_id IS NOT DISTINCT FROM NEW\.destination_warehouse_id/);
      expect(body).not.toMatch(/OLD\.route_id IS NOT NULL/);
    }
  });

  it('the route boundary judges only rows that ARE or BECOME active', () => {
    const guard = fn(ROUTE_GUARD);
    expect(guard).toMatch(/IF NOT NEW\.is_active THEN\s*\n\s*RETURN NEW;/);
    expect(guard).toMatch(/TG_OP = 'UPDATE'\s*\n\s*AND OLD\.is_active/);
  });

  it('both write boundaries DELEGATE rather than restate the rule', () => {
    expect(fn(PROC_GUARD)).toMatch(new RegExp(`PERFORM\\s+public\\.${PROC_CAPSULE}\\(NEW\\.warehouse_id\\)`));
    expect(fn(ROUTE_GUARD)).toMatch(new RegExp(`PERFORM\\s+public\\.${CAPSULE}`));
    for (const guard of [PROC_GUARD, ROUTE_GUARD]) {
      expect(fn(guard)).not.toMatch(/institution_class = 'health_sector'/);
      expect(fn(guard)).not.toMatch(/facility_id IS NOT NULL/);
    }
  });

  it('the routed corridor delegates to the SAME capsule as the direct one', () => {
    const route = fn(ROUTE_ASSERT);
    expect(route).toMatch(
      new RegExp(`PERFORM\\s+public\\.${CAPSULE}\\s*\\(\\s*p_target_warehouse_id,\\s*'supply_destination'`),
    );
    // 075's own identifiers must survive verbatim.
    for (const id of [
      'SUPPLY_ROUTE_SELF', 'SUPPLY_ROUTE_SOURCE_NOT_FOUND', 'SUPPLY_ROUTE_TARGET_NOT_FOUND',
      'SUPPLY_ROUTE_SOURCE_NOT_CENTRAL', 'SUPPLY_ROUTE_TARGET_NOT_INSTITUTION',
      'SUPPLY_ROUTE_ENDPOINT_INACTIVE',
    ]) {
      expect(route, `075 identifier ${id} must survive`).toContain(id);
    }
  });
});

describe('184 · history is preserved — no data DML', () => {
  const HISTORICAL = [
    'warehouse_transfers',
    'warehouse_transfer_requests',
    'warehouse_transfer_lines',
    'warehouse_stock',
    'outlet_stock',
    'item_availability',
    'procurement_orders',
    'inter_org_exchange_requests',
  ];

  for (const table of HISTORICAL) {
    it(`never UPDATEs, DELETEs from or INSERTs into ${table} at apply time`, () => {
      // Read the APPLY-TIME slice: the replaced function BODIES legitimately
      // contain INSERTs (087's order creation is reproduced verbatim), and
      // those run per-call, never at migration time.
      const applyExecutable = executableSql(applyTime);
      expect(applyExecutable).not.toMatch(new RegExp(`UPDATE\\s+(public\\.)?${table}\\b`, 'i'));
      expect(applyExecutable).not.toMatch(new RegExp(`DELETE\\s+FROM\\s+(public\\.)?${table}\\b`, 'i'));
      expect(applyExecutable).not.toMatch(new RegExp(`INSERT\\s+INTO\\s+(public\\.)?${table}\\b`, 'i'));
    });
  }

  it('the preflight only COUNTS legacy shapes and never aborts on them', () => {
    // R1.2C's lesson: a canonical pre-existing-row scan that ABORTS makes the
    // whole chain unappliable against any environment carrying a legacy row.
    // 184 reports and continues.
    expect(bare).toMatch(/SELECT count\(\*\) INTO v_legacy_forward/);
    expect(bare).toMatch(/SELECT count\(\*\) INTO v_legacy_return/);
    expect(bare).toMatch(/RAISE NOTICE\s*\n?\s*'184 preflight: legacy central->facility/);
    // The legacy counters must never feed a RAISE EXCEPTION.
    expect(bare).not.toMatch(/IF\s+v_legacy_(forward|return)\s*(<>|>|!=)/);
  });
});

describe('184 · ONE author for the external-corridor rule', () => {
  const capsuleSrc = fn(CAPSULE);
  const supplySrc = fn(SUPPLY);
  const returnSrc = fn(RETURN_FN);

  it('supply Branch A delegates to the capsule as supply_destination', () => {
    expect(supplySrc).toMatch(
      new RegExp(`PERFORM\\s+public\\.${CAPSULE}\\s*\\(\\s*p_destination_warehouse_id,\\s*'supply_destination'`),
    );
  });

  it('return Branch A delegates to the same capsule as return_source', () => {
    expect(returnSrc).toMatch(
      new RegExp(`PERFORM\\s+public\\.${CAPSULE}\\s*\\(\\s*p_institution_warehouse_id,\\s*'return_source'`),
    );
  });

  it('neither validator carries its own copy of the R1.3 narrowing', () => {
    // The facility-bound rule must exist in the capsule ONLY. A second copy is
    // how a forward corridor and its reverse silently drift apart.
    for (const [label, src] of [['supply', supplySrc], ['return', returnSrc]] as const) {
      expect(src, `${label} must not restate the care-institution rule`)
        .not.toMatch(/organization_kind\s*<>\s*'care_institution'/);
      expect(src, `${label} must not restate the institution_class allow-list`)
        .not.toMatch(/NOT IN \('hospital', 'specialized_center', 'health_sector'\)/);
    }
  });

  it('the capsule states every R1.3 conjunct exactly once', () => {
    expect(capsuleSrc).toMatch(/v_wh\.warehouse_kind <> 'institution' OR v_wh\.status <> 'active'/);
    expect(capsuleSrc).toMatch(/v_wh\.facility_id IS NOT NULL/);
    expect(capsuleSrc).toMatch(/v_org\.organization_kind <> 'care_institution'/);
    expect(capsuleSrc).toMatch(/v_org\.institution_class IS NULL/);
    expect(capsuleSrc).toMatch(
      /v_org\.institution_class NOT IN \('hospital', 'specialized_center', 'health_sector'\)/,
    );
  });

  it('the capsule locks both rows FOR SHARE, as 165 did', () => {
    expect(capsuleSrc).toMatch(/FROM public\.warehouses WHERE id = p_warehouse_id FOR SHARE/);
    expect(capsuleSrc).toMatch(/FROM public\.organizations WHERE id = v_wh\.organization_id FOR SHARE/);
  });

  it('the capsule refuses an unknown endpoint role rather than defaulting open', () => {
    expect(capsuleSrc).toMatch(/invalid_external_corridor_endpoint_role/);
    // The role dispatch must be a closed IF/ELSIF/ELSE, never a fallthrough.
    expect(capsuleSrc).toMatch(/ELSE\s+RAISE EXCEPTION 'invalid_external_corridor_endpoint_role'/);
  });
});

describe('184 · original error identifiers survive', () => {
  const capsuleSrc = fn(CAPSULE);
  const supplySrc = fn(SUPPLY);
  const returnSrc = fn(RETURN_FN);

  it('Branch A supply identifiers are unchanged', () => {
    expect(supplySrc).toMatch(/source_must_be_active_central_warehouse/);
    expect(supplySrc).toMatch(/destination_warehouse_not_in_named_organization/);
    expect(capsuleSrc).toMatch(/destination_must_be_active_institution_warehouse/);
  });

  it('Branch A return identifiers are unchanged', () => {
    expect(returnSrc).toMatch(/destination_must_be_active_central_warehouse/);
    expect(returnSrc).toMatch(/no_direct_forward_provenance_between_warehouses/);
    expect(capsuleSrc).toMatch(/source_must_be_active_institution_warehouse/);
  });

  it('the R1.3 refusals carry their own distinct identifiers', () => {
    expect(capsuleSrc).toMatch(/central_supply_destination_must_not_be_facility_bound/);
    expect(capsuleSrc).toMatch(/central_return_source_must_not_be_facility_bound/);
    expect(capsuleSrc).toMatch(/external_corridor_requires_care_institution/);
    expect(capsuleSrc).toMatch(/external_corridor_institution_class_not_permitted/);
  });
});

describe('184 · Branch B (same-sector) is preserved verbatim in behaviour', () => {
  const supplySrc = fn(SUPPLY);
  const returnSrc = fn(RETURN_FN);

  const SUPPLY_B = [
    'sector_source_warehouse_not_active',
    'health_center_warehouse_not_active',
    'organization_institution_class_required',
    'sector_supply_requires_health_sector',
    'destination_facility_not_found',
    'facility_not_in_source_organization',
    'invalid_facility_class_for_sector_supply',
    'health_center_facility_not_active',
  ];
  const RETURN_B = [
    'health_center_warehouse_not_active',
    'sector_destination_warehouse_not_active',
    'organization_institution_class_required',
    'sector_return_requires_health_sector',
    'source_facility_not_found',
    'facility_not_in_source_organization',
    'invalid_facility_class_for_sector_return',
    'health_center_facility_not_active',
  ];

  for (const id of SUPPLY_B) {
    it(`supply Branch B keeps ${id}`, () => expect(supplySrc).toContain(id));
  }
  for (const id of RETURN_B) {
    it(`return Branch B keeps ${id}`, () => expect(returnSrc).toContain(id));
  }

  it('supply Branch B still selects on a facility-less institution source', () => {
    expect(supplySrc).toMatch(/v_src\.facility_id IS NULL/);
    expect(supplySrc).toMatch(/v_dst\.facility_id IS NOT NULL/);
  });

  it('return Branch B still selects on a facility-less sector destination', () => {
    expect(returnSrc).toMatch(/v_inst\.facility_id IS NOT NULL/);
    expect(returnSrc).toMatch(/v_cent\.facility_id IS NULL/);
  });

  it('BOTH return branches still demand direct forward provenance', () => {
    const provenance = returnSrc.match(/no_direct_forward_provenance_between_warehouses/g) ?? [];
    expect(provenance.length).toBe(2);
  });
});

describe('184 · the procurement root', () => {
  const procCapsuleSrc = fn(PROC_CAPSULE);
  const procurementSrc = fn(PROCUREMENT);

  it('phoenix_procurement_create_order delegates to the procurement capsule', () => {
    expect(procurementSrc).toMatch(
      new RegExp(`PERFORM\\s+public\\.${PROC_CAPSULE}\\s*\\(p_warehouse_id\\)`),
    );
  });

  it('the guard runs AFTER the IDOR gate but before any write', () => {
    // Ordering is deliberate. Refusing on topology BEFORE proving scope would
    // let an actor with no authority over the warehouse read its
    // facility-boundness and organization class out of the error. Running after
    // the IDOR gate costs no enforcement, because the procurement_orders write
    // boundary applies the same rule to every writer including one that never
    // calls this RPC.
    const guardAt = procurementSrc.indexOf(PROC_CAPSULE);
    const idorAt = procurementSrc.indexOf('forbidden_local_procurement_manage');
    const insertAt = procurementSrc.indexOf('INSERT INTO public.procurement_orders');
    expect(guardAt).toBeGreaterThan(-1);
    expect(idorAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(-1);
    expect(idorAt).toBeLessThan(guardAt);
    expect(guardAt).toBeLessThan(insertAt);
  });

  it('restricts ONLY health_sector, leaving hospitals and specialized centers alone', () => {
    expect(procCapsuleSrc).toMatch(
      /v_org\.institution_class = 'health_sector' AND v_wh\.facility_id IS NOT NULL/,
    );
    expect(procCapsuleSrc).toMatch(/local_procurement_root_must_be_sector_main/);
    // No blanket facility prohibition — that would change 087 for classes the
    // brief explicitly leaves unchanged.
    expect(procCapsuleSrc).not.toMatch(/IF v_wh\.facility_id IS NOT NULL THEN/);
  });

  it('preserves 087s original identifiers and its whole write path', () => {
    for (const id of [
      'not_authenticated', 'warehouse_and_supplier_required', 'order_number_required',
      'warehouse_not_found', 'destination_must_be_active_institution_warehouse',
      'forbidden_local_procurement_manage', 'supplier_not_found', 'supplier_inactive',
      'order_number_exists',
    ]) {
      expect(procurementSrc, `087 identifier ${id} must survive`).toContain(id);
    }
    expect(procurementSrc).toContain('_phoenix_procurement_log_event');
    expect(procurementSrc).toContain('local_procurement.order_created');
    expect(procurementSrc).toContain('phoenix_profile_has_scoped_permission');
  });

  it('grants no new permission to anyone', () => {
    // The permission tables are never touched, so no default can move. The
    // reproduced 087 body still CHECKS 'local_procurement.manage' via
    // phoenix_profile_has_scoped_permission — reading a permission key is not
    // granting one, which is why this asserts on the write surface instead of
    // banning the string.
    expect(executable).not.toMatch(/role_permission_defaults/i);
    expect(executable).not.toMatch(/permission_keys/i);
    expect(bare).not.toMatch(/health_center_manager/);
    expect(bare).toContain("'local_procurement.manage'");
  });
});

describe('184 · privilege posture', () => {
  it('every capsule, guard AND the route endpoint validator is INTERNAL', () => {
    // ROUTE_ASSERT belongs in THIS list, not the granted one: 075 established
    // it as an internal helper with "no direct client execution at all". It is
    // SECURITY DEFINER and reads public.warehouses past RLS, so granting it to
    // `authenticated` would create a cross-tenant oracle for warehouse
    // existence, kind, status, facility-boundness and organization class.
    for (const capsule of INTERNAL_ONLY) {
      expect(applyBare).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${capsule}\\([^)]*\\)\\s*\\n?\\s*FROM PUBLIC, anon, authenticated, service_role`,
        ),
      );
      expect(applyBare, `${capsule} must never be granted to an external role`)
        .not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${capsule}`));
    }
  });

  it('the two endpoint validators keep authenticated EXECUTE and stay closed to anon', () => {
    for (const v of [SUPPLY, RETURN_FN]) {
      expect(applyBare).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${v}\\([^)]*\\)\\s*\\n?\\s*FROM PUBLIC, anon`));
      expect(applyBare).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${v}\\([^)]*\\)\\s*\\n?\\s*TO authenticated`));
    }
  });

  it('re-asserts the 153 revoke on the retired exchange completion writer', () => {
    expect(applyBare).toMatch(
      /REVOKE ALL PRIVILEGES ON FUNCTION public\.phoenix_update_inter_org_exchange_status\([^)]*\)\s*\n?\s*FROM PUBLIC, anon, authenticated, service_role/,
    );
  });

  it('never resurrects the retired exchange writer', () => {
    expect(executable).not.toMatch(/GRANT[^;]*phoenix_update_inter_org_exchange_status/i);
    expect(executable).not.toMatch(
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.phoenix_update_inter_org_exchange_status/i,
    );
  });

  it('every function it defines is SECURITY DEFINER with a pinned search_path', () => {
    for (const name of [
      CAPSULE, PROC_CAPSULE, SUPPLY, RETURN_FN, PROCUREMENT,
      ROUTE_ASSERT, PROC_GUARD, ROUTE_GUARD, ROUTED_XFER_GUARD, ROUTED_RET_GUARD,
    ]) {
      const src = fn(name);
      expect(src, `${name} must be SECURITY DEFINER`).toMatch(/SECURITY DEFINER/);
      expect(src, `${name} must pin search_path`).toMatch(/SET search_path = public, pg_temp/);
    }
  });
});

describe('184 · the preflight fails closed', () => {
  it('requires every function it is about to replace', () => {
    for (const sig of [
      'phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)',
      'phoenix_assert_direct_return_endpoints(uuid,uuid)',
      'phoenix_procurement_create_order(uuid,uuid,text,text,date,text,text,text,boolean)',
      'phoenix_update_inter_org_exchange_status(uuid,text,integer,integer,text,text)',
    ]) {
      expect(bare).toContain(sig);
    }
    expect(bare).toMatch(/184_precondition_failed/);
  });

  it('pins BOTH class vocabularies so a widened CHECK cannot widen the corridor', () => {
    expect(bare).toMatch(/organizations_institution_class_chk/);
    expect(bare).toMatch(/organizations_organization_kind_chk/);
    expect(bare).toMatch(/184_precondition_failed: institution_class vocabulary drift/);
    expect(bare).toMatch(/184_precondition_failed: organization_kind vocabulary drift/);
  });

  it('DERIVES each vocabulary from the live constraint instead of string-matching it', () => {
    // A pretty-printed constraint definition's parenthesisation is a formatting
    // detail, not a contract. Comparing the derived value SET is both stricter
    // about meaning and immune to pg_get_constraintdef formatting changes.
    const derivations = bare.match(/regexp_matches\(\s*pg_get_constraintdef\(c\.oid, true\), '''\(\[\^''\]\+\)''', 'g'\s*\)/g) ?? [];
    expect(derivations.length).toBe(2);
    expect(bare).toContain("ARRAY['health_sector', 'hospital', 'specialized_center']::text[]");
    expect(bare).toContain("ARRAY['care_institution', 'pharmacy_department_authority']::text[]");
  });

  it('verifies the delegation, the privileges and the exchange closure', () => {
    for (const claim of [
      'supply Branch A does not delegate to the canonical capsule',
      'return Branch A does not delegate to the canonical capsule',
      'procurement does not delegate to the canonical capsule',
      'an external principal can call the external-corridor capsule',
      'an external principal can call the procurement capsule',
      'an external principal still reaches the retired exchange completion writer',
      'the client-reachable item_availability.quantity writers changed',
    ]) {
      expect(bare, `VERIFY must assert: ${claim}`).toContain(claim);
    }
  });

  it('scopes Verify-K to CLIENT principals while Verify-J stays strict about service_role', () => {
    // R1.3 corrective. The first Production apply aborted at Verify-K: real
    // Supabase grants service_role EXECUTE on a preserved owner/internal legacy
    // helper (109 keeps broad service_role function access on purpose, and the
    // prepared-only 085 deliberately preserves service_role on the manual
    // availability writers), which the disposable rig does not model. Verify-K
    // is a REGRESSION PIN on the projection's write surface, and the surface it
    // was always about is the browser/PostgREST one.
    //
    // The two checks are asserted TOGETHER and by POLARITY, so this can only
    // pass if the relaxation is confined to the pin: narrowing Verify-J to
    // client principals, or re-adding service_role to Verify-K, fails here.
    const section = (from: string, to: string): string => {
      const start = bare.indexOf(from);
      const end = bare.indexOf(to, start + from.length);
      expect(start, `${from} must exist`).toBeGreaterThanOrEqual(0);
      expect(end, `${to} must exist after ${from}`).toBeGreaterThan(start);
      return bare.slice(start, end);
    };
    // Anchored on statements that occur ONCE each, in source order:
    //   J starts where the exchange writer's oid is resolved;
    //   K starts at its own census SELECT (the preflight's vocabulary
    //   derivation uses array_agg(DISTINCT captures[1]), never p.proname);
    //   L starts at the route endpoint validator check.
    const verifyJ = section('v_exchange_oid := to_regprocedure', 'SELECT array_agg(DISTINCT p.proname');
    const verifyK = section('SELECT array_agg(DISTINCT p.proname', 'the route endpoint validator is missing');

    // Verify-K: client principals only.
    expect(verifyK).toMatch(/r\.rolname IN \('anon', 'authenticated'\)/);
    expect(verifyK).not.toMatch(/r\.rolname IN \([^)]*service_role[^)]*\)/);
    expect(verifyK).toContain("ARRAY['clear_port_availability']::text[]");

    // Verify-J: the retired exchange completion writer stays closed to
    // service_role too. This is a real BOUNDARY, not a pin, and is untouched.
    expect(verifyJ).toMatch(/r\.rolname IN \('anon', 'authenticated', 'service_role'\)/);
  });
});
