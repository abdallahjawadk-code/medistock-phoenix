/**
 * DIRECT-SUPPLY CORRIDORS — R1.1-P (P2-B), endpoint projection only.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE DATABASE ALREADY ALLOWS
 * ─────────────────────────────────────────────────────────────────────────────
 * Migration 165 widened `phoenix_assert_direct_supply_endpoints` to exactly TWO
 * legal branches — deliberately not a generic "institution → institution if the
 * organization matches" rule — and both commit through the SAME RPC,
 * `phoenix_create_direct_warehouse_transfer_request`:
 *
 *   BRANCH A  active CENTRAL warehouse → active INSTITUTION warehouse.
 *   BRANCH B  sector-level institution warehouse (facility_id IS NULL, inside a
 *             health_sector organization) → warehouse of an ACTIVE
 *             primary/subordinate health-centre facility (facility_id IS NOT
 *             NULL) in the SAME organization.
 *
 * The frontend only ever constructed Branch A, so the sector main could not
 * supply its own health centres from the interface even though the server had
 * accepted it since 165. This module states both corridors once, as a pure
 * projection, so the operator picks a corridor instead of hunting through one
 * undifferentiated warehouse list.
 *
 * R1.1-P adds NO RPC, NO migration and NO route table. The endpoints below are
 * a narrowing of what already exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * B1 — STRICTER THAN THE DATABASE, BY OWNER DECISION
 * OWNER_ACCEPTED_INTENTIONAL_BEHAVIOR_CHANGE (2026-08-15)
 * ─────────────────────────────────────────────────────────────────────────────
 * 165 Branch A accepts ANY active institution warehouse as a central
 * destination, INCLUDING a facility-bound health-centre depot. This projection
 * does not offer that pairing: Branch A destinations are restricted to
 * warehouses with `facility_id IS NULL`, i.e. a hospital, a specialized centre,
 * or a health-sector MAIN.
 *
 * This REMOVES a capability the frontend previously had — an adversarial review
 * correctly raised it as a blocker, and the owner accepted it as an intentional
 * product-workflow narrowing. The removed pairing is a legacy affordance that
 * conflicts with the canonical topology: a health centre is supplied by its own
 * sector main (Branch B), which is what makes the sector main a supply root and
 * what keeps the centre's receipts, returns (R1.3 provenance) and stock lineage
 * inside ONE corridor.
 *
 * State the limits plainly, so nobody later mistakes this for enforcement:
 *   · Migration 165 STILL PERMITS central → health-centre depot server-side.
 *   · This is NOT a security boundary and is not claimed to be one.
 *   · The canonical server-side prohibition is deferred to R1.3.
 *   · R1.1-P creates no Migration 184.
 */

/** The subset of a warehouse this module reads. */
export interface CorridorWarehouse {
  id: string;
  organizationId: string;
  warehouseKind: 'central' | 'institution' | string;
  status: string;
  facilityId: string | null;
}

/** The subset of an organization this module reads. */
export interface CorridorOrganization {
  id: string;
  institutionClass: string | null;
}

export type DirectSupplyBranch = 'central_to_institution' | 'sector_to_health_center';

export const DIRECT_SUPPLY_BRANCHES: readonly DirectSupplyBranch[] =
  Object.freeze(['central_to_institution', 'sector_to_health_center'] as const);

const isActive = (w: CorridorWarehouse) => w.status === 'active';

/**
 * The warehouses that may SOURCE this corridor.
 *
 * Branch A — active central warehouses, exactly as before.
 * Branch B — the sector MAIN: an active institution warehouse with no facility,
 *            inside an organization classified health_sector. A centre depot
 *            (facility_id IS NOT NULL) can therefore never appear as a Branch-B
 *            source, and a hospital or specialized-centre warehouse is excluded
 *            because its organization is not a health sector.
 */
export function directSupplySources<W extends CorridorWarehouse>(
  branch: DirectSupplyBranch,
  warehouses: readonly W[],
  organizations: readonly CorridorOrganization[],
): W[] {
  if (branch === 'central_to_institution') {
    return warehouses.filter(w => w.warehouseKind === 'central' && isActive(w));
  }
  const healthSectorOrgs = new Set(
    organizations.filter(o => o.institutionClass === 'health_sector').map(o => o.id),
  );
  return warehouses.filter(w =>
    w.warehouseKind === 'institution'
    && isActive(w)
    && w.facilityId === null
    && healthSectorOrgs.has(w.organizationId));
}

/**
 * The warehouses that may RECEIVE from the chosen source on this corridor.
 *
 * Branch A — active institution warehouses that are NOT facility-bound: a
 *            hospital, a specialized centre, or a health-sector main. See the
 *            note above on why centre depots are excluded here.
 *
 * Branch B — active facility-bound depots in the SAME organization as the
 *            source, whose facility is one the sector may supply. Requires a
 *            chosen source: without one there is no organization to scope to,
 *            and an unscoped list would offer a foreign sector's centre.
 *
 * `supplyableFacilityIds` carries the ACTIVE primary/subordinate health-centre
 * facilities of the source's organization. It is required for Branch B and
 * fails CLOSED when absent (still loading, or unreadable) rather than falling
 * back to every facility-bound warehouse — 165 refuses an inactive or
 * wrongly-classed facility, and offering one would be an action the database
 * always rejects.
 */
export function directSupplyDestinations<W extends CorridorWarehouse>(
  branch: DirectSupplyBranch,
  warehouses: readonly W[],
  source: CorridorWarehouse | null,
  supplyableFacilityIds?: ReadonlySet<string> | null,
): W[] {
  if (branch === 'central_to_institution') {
    return warehouses.filter(w =>
      w.warehouseKind === 'institution'
      && isActive(w)
      && w.facilityId === null);
  }

  if (!source || !supplyableFacilityIds) return [];
  return warehouses.filter(w =>
    w.warehouseKind === 'institution'
    && isActive(w)
    && w.facilityId !== null
    && supplyableFacilityIds.has(w.facilityId)
    // Same organization — a sector never supplies another sector's centre.
    && w.organizationId === source.organizationId
    // Redundant given facility_id IS NOT NULL above (the source has none), but
    // stated so "a source is never its own destination" is asserted, not
    // inferred from a neighbouring condition.
    && w.id !== source.id);
}
