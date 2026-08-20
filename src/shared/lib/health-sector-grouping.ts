/**
 * HEALTH-SECTOR RESOURCE GROUPING — R1.1-P (P2-A), presentation only.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * A health sector is not a flat bag of outlets. Its canonical topology is:
 *
 *   Health Sector (the organization)
 *     ├─ Sector Main            — the supply root. ONE warehouse, NO outlets.
 *     ├─ Health Centre A        — its depot, its pharmacy, its crash cabinets
 *     └─ Health Centre B        — likewise, and strictly separate from A
 *
 * The institution screen rendered every distribution point in one undivided
 * `points.map(...)`, so a sector with four centres presented as an unstructured
 * list in which nothing said which centre a crash cabinet belonged to. That is
 * not merely untidy: the sector main and a centre depot are different KINDS of
 * thing — one may never hold an outlet — and a flat list makes that structural
 * rule invisible at exactly the screen where operators create topology.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * It is NOT a second outlet matrix. Which shapes are LEGAL remains
 * outlet-affordances.ts (mirroring Migration 183); this module only decides how
 * the rows that already exist are ARRANGED on screen. Nothing here authorizes,
 * validates, filters for safety, or writes.
 *
 * Three properties follow deliberately:
 *
 *   1. IT IS PURE. No React, no i18n, no service call — a total function of its
 *      arguments, so the topology can be tested exhaustively.
 *   2. IT GROUPS BY IDENTITY, NEVER BY NAME. Membership is decided by
 *      `warehouses.facility_id` and `distribution_points.warehouse_id` only.
 *      Matching on a name would silently regroup a renamed centre.
 *   3. IT NEVER MOVES A ROW TO MAKE THE PICTURE TIDY. An outlet illegally
 *      attached to the sector main is shown UNDER the sector main, where it
 *      actually is, and the group is marked as not permitting outlets. Hiding
 *      it, or relocating it to a centre, would misreport the database — the one
 *      thing a topology view must never do. Repair is a server-side operation
 *      with an audit trail, never a rendering decision.
 */

import type { WarehouseStructuralRole } from '@/shared/supabase/services/scope-topology.service';

/** The subset of a warehouse this module reads. */
export interface GroupableWarehouse {
  id: string;
  facilityId: string | null;
  warehouseKind: 'central' | 'institution' | string;
  status: string;
  /**
   * G4.2 — the structural role the DATABASE assigned (Migration 191), never
   * one this module worked out. Optional so the many presentation fixtures
   * that construct this shape stay valid; an absent role is treated exactly
   * like 'unclassified', i.e. it never produces a sector-main claim.
   */
  structuralRole?: WarehouseStructuralRole | null;
}

/** The subset of a distribution point this module reads. */
export interface GroupableOutlet {
  id: string;
  warehouseId: string | null;
}

/** The subset of an organization facility this module reads. */
export interface GroupableFacility {
  id: string;
  name: string;
  nameAr: string;
  status: string;
}

/**
 * Which structural role a group plays.
 *
 *   'sector_main'   — the supply root; holds the facility-less depot(s).
 *   'health_center' — one organization_facility and everything bound to it.
 *   'unassigned'    — rows the topology cannot place: an outlet with no owning
 *                     warehouse, or one owned by a warehouse this screen cannot
 *                     see. Surfaced rather than dropped.
 */
export type ResourceGroupKind = 'sector_main' | 'health_center' | 'unassigned';

export interface ResourceGroup<W extends GroupableWarehouse, P extends GroupableOutlet> {
  kind: ResourceGroupKind;
  /** Stable React key: the facility id, or the group kind for the singletons. */
  key: string;
  /** The facility this group represents; null for sector main and unassigned. */
  facility: GroupableFacility | null;
  warehouses: W[];
  outlets: P[];
  /**
   * Whether this group may hold outlets AT ALL under Migration 181/183.
   *
   * False for the sector main. Note this describes the STRUCTURE, not the
   * contents: a false value alongside a non-empty `outlets` array is precisely
   * how a pre-existing illegal row is reported honestly instead of hidden.
   */
  allowsOutlets: boolean;
}

/** True when this organization is presented as a health sector. */
export function isHealthSectorOwner(
  organizationKind: string | null | undefined,
  institutionClass: string | null | undefined,
): boolean {
  return organizationKind === 'care_institution' && institutionClass === 'health_sector';
}

/**
 * Arrange a health sector's warehouses and outlets into its canonical hierarchy.
 *
 * Returns `null` for any owner that is not a health sector, which is the
 * caller's signal to keep its existing flat presentation. A hospital's wards and
 * a specialized centre's rooms are not facilities and must not be forced into a
 * shape built for health centres.
 *
 * Ordering is deterministic: sector main first (it is the supply root), then
 * health centres in the order the facilities were supplied, then anything
 * unplaceable last so it reads as an exception rather than a peer.
 */
export function groupHealthSectorResources<
  W extends GroupableWarehouse,
  P extends GroupableOutlet,
>(
  owner: { organizationKind: string | null | undefined; institutionClass: string | null | undefined },
  warehouses: readonly W[],
  outlets: readonly P[],
  facilities: readonly GroupableFacility[],
): ResourceGroup<W, P>[] | null {
  if (!isHealthSectorOwner(owner.organizationKind, owner.institutionClass)) return null;

  // Only institution warehouses participate in sector topology. A central
  // warehouse belongs to the pharmacy department authority, not to this sector,
  // and must not become a phantom "centre".
  const institutionWarehouses = warehouses.filter(w => w.warehouseKind === 'institution');

  const outletsFor = (owned: readonly W[]): P[] => {
    const ids = new Set(owned.map(w => w.id));
    return outlets.filter(o => o.warehouseId !== null && ids.has(o.warehouseId));
  };

  const groups: ResourceGroup<W, P>[] = [];

  /**
   * SECTOR MAIN — G4.2: whatever the DATABASE calls the sector main.
   *
   * This used to be `facilityId === null`, and the comment here used to admit,
   * at length, that the test was insufficient: it also matches a DEACTIVATED
   * facility-less warehouse, so the group was really "facility-less institution
   * warehouses" wearing a structural name. Migration 181's actual rule needs
   * six conjuncts — care_institution, health_sector, institution kind, ACTIVE,
   * facility_id IS NULL, and is_main — and the last one never reached the
   * browser at all, because `warehouses.service.ts` did not select it.
   *
   * Migration 191 now states that rule once, in the database, and this module
   * merely READS the answer. A retired facility-less depot is no longer
   * labelled the supply root; it is still SHOWN (see `unplacedWarehouses`
   * below), because hiding a historical row would misreport the database — the
   * one thing a topology view must never do.
   *
   * The group is emitted even when it owns nothing, because its ABSENCE from
   * the view would read as "this sector has no supply root" — a structural
   * claim, not a blank.
   */
  const sectorMainWarehouses = institutionWarehouses.filter(w => w.structuralRole === 'sector_main');
  if (sectorMainWarehouses.length > 0) {
    groups.push({
      kind: 'sector_main',
      key: 'sector_main',
      facility: null,
      warehouses: sectorMainWarehouses,
      // Reported honestly: normally empty, and non-empty only for a pre-181
      // row that must stay visible and stay where it is.
      outlets: outletsFor(sectorMainWarehouses),
      allowsOutlets: false,
    });
  }

  // HEALTH CENTRES — one group per facility, keyed on facility_id.
  const placedWarehouses = new Set(sectorMainWarehouses.map(w => w.id));
  for (const facility of facilities) {
    const owned = institutionWarehouses.filter(w => w.facilityId === facility.id);
    for (const w of owned) placedWarehouses.add(w.id);
    groups.push({
      kind: 'health_center',
      key: facility.id,
      facility,
      warehouses: owned,
      outlets: outletsFor(owned),
      allowsOutlets: true,
    });
  }

  /**
   * A warehouse bound to a facility this screen did not receive — an archived
   * facility, or one filtered out upstream. Its depot and outlets still exist,
   * so they get their own centre group rather than disappearing. Keyed on the
   * facility id so two such warehouses under one unseen facility stay together.
   */
  const orphanedByFacility = new Map<string, W[]>();
  for (const w of institutionWarehouses) {
    if (placedWarehouses.has(w.id) || w.facilityId === null) continue;
    const bucket = orphanedByFacility.get(w.facilityId) ?? [];
    bucket.push(w);
    orphanedByFacility.set(w.facilityId, bucket);
  }
  for (const [facilityId, owned] of orphanedByFacility) {
    for (const w of owned) placedWarehouses.add(w.id);
    groups.push({
      kind: 'health_center',
      key: facilityId,
      facility: null,
      warehouses: owned,
      outlets: outletsFor(owned),
      allowsOutlets: true,
    });
  }

  /**
   * UNPLACEABLE — three honest exceptions, never a hiding place.
   *
   *   · an outlet with no owning warehouse (Migration 181 round 2's NULL
   *     warehouse_id case), or one owned by a warehouse outside this catalog;
   *   · G4.2: a facility-less institution warehouse the database did NOT
   *     classify as the sector main — a deactivated former main, or a row
   *     whose role this caller cannot establish. Before G4.2 such a row was
   *     silently absorbed into the sector-main group and thereby MIS-LABELLED
   *     as the supply root. It is shown here instead, under an exception
   *     heading, which is what it actually is.
   *
   * Emitted only when non-empty: an exception section that is always present
   * stops reading as an exception.
   */
  const unplacedWarehouses = institutionWarehouses.filter(w => !placedWarehouses.has(w.id));
  const placedOutlets = new Set(groups.flatMap(g => g.outlets).map(o => o.id));
  const unplaced = [...outletsFor(unplacedWarehouses), ...outlets.filter(o => !placedOutlets.has(o.id))]
    .filter((o, i, all) => all.findIndex(x => x.id === o.id) === i);
  if (unplaced.length > 0 || unplacedWarehouses.length > 0) {
    groups.push({
      kind: 'unassigned',
      key: 'unassigned',
      facility: null,
      warehouses: unplacedWarehouses,
      outlets: unplaced,
      allowsOutlets: false,
    });
  }

  return groups;
}
