import { supabase, supabaseConfigured } from '../client';

/**
 * CANONICAL FACILITY / SCOPE TOPOLOGY — G4.2 client contract.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACES
 * ─────────────────────────────────────────────────────────────────────────────
 * Before G4.2 four surfaces answered "is this warehouse the sector main?" from
 * `facility_id === null` alone, because `warehouses.is_main` was never selected
 * by `warehouses.service.ts` and so never reached the browser. Migration 181's
 * actual rule needs SIX conjuncts:
 *
 *   care_institution + health_sector + institution kind + ACTIVE
 *   + facility_id IS NULL + is_main IS TRUE
 *
 * A deactivated facility-less depot satisfies the NULL test and is NOT the
 * sector main — 181 explicitly declines to judge non-active rows. That gap is
 * why `structuralRole` is now computed once, in the database, and merely READ
 * here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * It is not a permission. `inEffectiveScope` answers WHERE — "is this resource
 * inside my primary operational scope" — and never WHAT. Every mutation still
 * goes through `phoenix_profile_has_scoped_permission` server-side, and the
 * organization-level permission question is still answered by migration 062
 * independently of this read.
 *
 * It is not the delegated-access catalog either. Cross-organization delegated
 * topology remains owned by Migration 187's
 * `phoenix_my_operational_resource_catalog()`, unchanged; this query answers
 * for ONE organization the caller can already read.
 */

/**
 * The structural role the DATABASE assigns a warehouse. Never derived here.
 *
 *   'central_warehouse'     — a pharmacy-department-authority central store.
 *   'sector_main'           — the health sector's supply root, and ONLY when
 *                             all six of Migration 181's conjuncts hold.
 *   'health_center_depot'   — a facility-bound depot inside a health sector.
 *   'institution_warehouse' — an institution warehouse that is none of the
 *                             above: a hospital's store, a specialized centre's
 *                             store, or a facility-less health-sector warehouse
 *                             that FAILS the sector-main rule (deactivated, or
 *                             not carrying is_main).
 *   'unclassified'          — the role cannot be established from what the
 *                             caller may read. Never treated as a positive
 *                             claim about anything.
 */
export type WarehouseStructuralRole =
  | 'central_warehouse'
  | 'sector_main'
  | 'health_center_depot'
  | 'institution_warehouse'
  | 'unclassified';

export type ScopeTopologyNodeKind = 'warehouse' | 'outlet';

export interface ScopeTopologyNode {
  nodeKind: ScopeTopologyNodeKind;
  organizationId: string;
  organizationKind: string | null;
  institutionClass: string | null;
  /** For an outlet this is its OWNING WAREHOUSE's facility — ancestry the
   *  database derived, not something the client rebuilt from a name. */
  facilityId: string | null;
  facilityClass: string | null;
  facilityStatus: string | null;
  facilityName: string | null;
  facilityNameAr: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseNameAr: string | null;
  warehouseKind: 'central' | 'institution' | null;
  warehouseStatus: string | null;
  warehouseIsMain: boolean | null;
  /** Authoritative. See {@link WarehouseStructuralRole}. */
  structuralRole: WarehouseStructuralRole;
  distributionPointId: string | null;
  distributionPointName: string | null;
  distributionPointNameAr: string | null;
  distributionPointType: string | null;
  distributionPointStatus: string | null;
  /** WHERE, never WHAT. Server-derived from the canonical 062/182 helpers. */
  inEffectiveScope: boolean;
}

const ROLES: ReadonlySet<string> = new Set<WarehouseStructuralRole>([
  'central_warehouse', 'sector_main', 'health_center_depot',
  'institution_warehouse', 'unclassified',
]);

/**
 * Fail CLOSED on an unrecognised role. A value this client does not know is
 * treated as 'unclassified' rather than passed through, so a future server-side
 * role can never be mistaken here for a positive structural claim.
 */
function toRole(raw: unknown): WarehouseStructuralRole {
  return typeof raw === 'string' && ROLES.has(raw)
    ? (raw as WarehouseStructuralRole)
    : 'unclassified';
}

export async function getOrganizationScopeTopology(
  organizationId: string,
): Promise<ScopeTopologyNode[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase.rpc(
    'phoenix_query_organization_scope_topology',
    { p_organization_id: organizationId },
  );
  if (error) throw error;

  return ((data ?? []) as Array<Record<string, unknown>>).map(r => ({
    nodeKind: r.node_kind as ScopeTopologyNodeKind,
    organizationId: r.organization_id as string,
    organizationKind: (r.organization_kind as string | null) ?? null,
    institutionClass: (r.institution_class as string | null) ?? null,
    facilityId: (r.facility_id as string | null) ?? null,
    facilityClass: (r.facility_class as string | null) ?? null,
    facilityStatus: (r.facility_status as string | null) ?? null,
    facilityName: (r.facility_name as string | null) ?? null,
    facilityNameAr: (r.facility_name_ar as string | null) ?? null,
    warehouseId: (r.warehouse_id as string | null) ?? null,
    warehouseName: (r.warehouse_name as string | null) ?? null,
    warehouseNameAr: (r.warehouse_name_ar as string | null) ?? null,
    warehouseKind: (r.warehouse_kind as 'central' | 'institution' | null) ?? null,
    warehouseStatus: (r.warehouse_status as string | null) ?? null,
    warehouseIsMain: (r.warehouse_is_main as boolean | null) ?? null,
    structuralRole: toRole(r.structural_role),
    distributionPointId: (r.distribution_point_id as string | null) ?? null,
    distributionPointName: (r.distribution_point_name as string | null) ?? null,
    distributionPointNameAr: (r.distribution_point_name_ar as string | null) ?? null,
    distributionPointType: (r.distribution_point_type as string | null) ?? null,
    distributionPointStatus: (r.distribution_point_status as string | null) ?? null,
    inEffectiveScope: Boolean(r.in_effective_scope),
  }));
}

/**
 * The structural role of every warehouse the caller can read in one
 * organization, keyed by warehouse id.
 *
 * Presentation surfaces (the institution screen's health-sector hierarchy, the
 * direct-supply corridor picker) need the ROLE but not the scope columns. They
 * take it from here rather than working it out, so there is exactly ONE source
 * of structural truth — Migration 191 — and no second topology engine.
 *
 * A warehouse absent from this map has no established role, which callers must
 * treat as 'unclassified': never as a positive claim.
 */
export async function getOrganizationWarehouseRoles(
  organizationId: string,
): Promise<Map<string, WarehouseStructuralRole>> {
  const nodes = await getOrganizationScopeTopology(organizationId);
  const roles = new Map<string, WarehouseStructuralRole>();
  for (const n of nodes) {
    if (n.nodeKind === 'warehouse' && n.warehouseId) roles.set(n.warehouseId, n.structuralRole);
  }
  return roles;
}
