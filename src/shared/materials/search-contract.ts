/**
 * G3.2 — THE canonical search & material-selection contract.
 *
 * Every material discovery/selection surface in Phoenix answers in this shape.
 * The contract exists because the surfaces that preceded it each invented their
 * own result object, and every one of them blurred the same four things into a
 * flat bag of nullable fields:
 *
 *   IDENTITY     — what this material canonically IS.
 *   SCOPE        — WHERE it structurally lives (or that it lives nowhere yet).
 *   DISPLAY      — what an operator reads on screen.
 *   ELIGIBILITY  — whether it may be used right now, and if not, why.
 *
 * Blurring them is not a tidiness problem. A flat bag lets a caller reach for
 * `scientificName` when it needed `centralItemId`, and lets a surface present a
 * result as if it had a warehouse when it only ever had a catalog row. Both
 * mistakes are invisible at the call site and damaging downstream. Here the
 * four are separate objects and the compiler refuses the confusion.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE RULES THIS FILE ENFORCES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. DISPLAY IS NEVER IDENTITY.
 *    Nothing in `display` may be read back into `identity`. A scientific name,
 *    a localized label and a formatted code are things a human reads; they are
 *    not what the database means by "this material". There is deliberately no
 *    helper here that turns a label into an id, because the moment one exists
 *    some surface will use it.
 *
 * 2. `materialIdentityKey` IS DATABASE DATA, NEVER COMPUTED HERE.
 *    Migration 150 defines `_phoenix_material_identity_v1(central_item_id,
 *    scientific_name, national_code, concentration, dosage_form, unit)` and
 *    materializes it as a GENERATED ALWAYS STORED column on `warehouse_stock`,
 *    `outlet_stock` and `warehouse_quarantine_stock`. Reproducing that function
 *    in TypeScript would fork the canonical definition the instant 150's helper
 *    changes, and would then disagree with the server on exactly the rows where
 *    it matters. This module therefore only ever CARRIES the value the database
 *    produced — see `src/features/inventory/stock-identity.ts`, which made the
 *    same commitment for lot identity and states the reasoning at length.
 *
 * 3. SCOPE IS NEVER FABRICATED.
 *    A `central_items` row has no organization, no facility, no warehouse and
 *    no outlet — it is a catalog entry, not stock. Inventing `organizationId`
 *    or `facilityId` for it to satisfy a type would make a search result claim
 *    a structural position it does not occupy. `scope.kind = 'catalog'` says
 *    exactly that, and operational resource scope is attached later, when the
 *    material is actually used against an authorized warehouse/outlet context.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * It is not an authorization layer. Nothing here filters, grants or denies.
 * RLS, Migration 182's facility-scoped RBAC and Migration 187's delegated
 * operational access remain the only authorities on what a caller may read;
 * this contract only describes the shape of what they already returned. A
 * client-side field is never a security boundary and must never be treated as
 * one.
 *
 * It is also not a stock truth. `warehouse_stock` and `outlet_stock` remain the
 * two ordinary stock truths. Nothing here is persisted, cached or projected.
 */

/**
 * WHAT the material canonically is.
 *
 * Every field is nullable because different SOURCES can prove different
 * subsets, and a source that cannot prove a field must say so rather than
 * guess. What is NOT permitted is deriving any of these from `display`.
 */
export interface MaterialIdentity {
  /**
   * `central_items.id` — the registered catalog identity, where the source can
   * prove one. A stock lot carries it when `central_item_id` was recorded on
   * the row (Migration 150 added the column); rows predating that linkage
   * legitimately have none.
   */
  centralItemId: string | null;
  /**
   * Migration 150's GENERATED ALWAYS STORED `material_identity_key`, exactly as
   * the database produced it. NEVER computed, reconstructed or defaulted in
   * TypeScript. `null` means "this source did not read the generated column",
   * which is a reason to isolate the row — never a reason to fall back to a
   * name-derived key.
   */
  materialIdentityKey: string | null;
  /** `warehouse_stock.id` when the source is a warehouse lot. */
  warehouseStockId: string | null;
  /** `outlet_stock.id` when the source is an outlet lot. */
  outletStockId: string | null;
}

/**
 * A catalog hit occupies no operational position.
 *
 * DECISION E: no `organizationId`, no `facilityId`, no `warehouseId`, no
 * `distributionPointId` — not even as `null` placeholders, because an
 * optional-but-present field invites a caller to read it. The absence is
 * structural and the type states it by omission.
 */
export interface CatalogScope {
  kind: 'catalog';
}

/**
 * A warehouse lot's real structural position.
 *
 * `facilityId` is `warehouses.facility_id` verbatim.
 *
 * DECISION D — `facilityId === null` means NO FACILITY ASSOCIATION ON THIS ROW.
 * It does NOT by itself mean "Sector Main". Under Migration 181 an ACTIVE
 * facility-less warehouse in a `health_sector` organization is the sector main,
 * but all three of those conditions are load-bearing: the organization must be
 * a health sector, the warehouse must be its main institution warehouse, and
 * only then does the facility-less shape identify the sector root. A
 * facility-less warehouse in a hospital or a specialized centre is simply a
 * warehouse with no facility. See `sectorRole`, and never infer the role from
 * the null.
 */
export interface WarehouseScope {
  kind: 'warehouse';
  organizationId: string;
  warehouseId: string;
  facilityId: string | null;
  /**
   * The structural role this warehouse plays, decided by
   * `classifyWarehouseSectorRole` from organization class + warehouse shape —
   * never from a name, and never from `facilityId` alone.
   */
  sectorRole: WarehouseSectorRole;
}

/**
 * An outlet lot's real structural position.
 *
 * `warehouseId` / `facilityId` are populated ONLY when the parent relationship
 * was actually read (`distribution_points.warehouse_id`, then that warehouse's
 * `facility_id`). An unresolved parent stays `null`: an outlet whose owning
 * warehouse this caller cannot see is reported as unplaced, exactly as
 * `health-sector-grouping.ts` reports it, rather than being relocated to make
 * the picture tidy.
 */
export interface OutletScope {
  kind: 'outlet';
  organizationId: string;
  distributionPointId: string;
  /** Parent `distribution_points.warehouse_id`, when structurally resolved. */
  warehouseId: string | null;
  /** The parent warehouse's `facility_id`, when structurally resolved. */
  facilityId: string | null;
}

export type MaterialScope = CatalogScope | WarehouseScope | OutletScope;

/**
 * The structural role of a warehouse inside a health sector's topology.
 *
 *   'sector_main'   — proven: health-sector organization + main institution
 *                     warehouse with no facility (Migration 181).
 *   'health_center' — bound to an `organization_facility` (a centre depot).
 *   'unclassified'  — everything else, INCLUDING any facility-less warehouse
 *                     whose organization is not a health sector. That is the
 *                     honest answer, not a defect.
 */
export type WarehouseSectorRole = 'sector_main' | 'health_center' | 'unclassified';

/**
 * Decide a warehouse's sector role from STRUCTURE ONLY.
 *
 * DECISION D in executable form. The inputs are the organization's class, the
 * warehouse's kind and main flag, and its facility binding. A name is never
 * consulted — a renamed centre must not change role, and a warehouse called
 * "Sector Main" inside a hospital must not acquire one.
 *
 * Mirrors `isHealthSectorOwner` plus the sector-main grouping rule in
 * `src/shared/lib/health-sector-grouping.ts`, and Migration 181's
 * `_phoenix_health_sector_warehouse_shape_guard_v1`, which raises
 * `health_sector_facility_less_warehouse_must_be_main` precisely to keep the
 * facility-less shape and the main flag in agreement server-side.
 *
 * Returns 'unclassified' whenever any input needed for a positive answer is
 * missing. Under-claiming a role is a display imprecision; over-claiming one
 * tells an operator a warehouse is the sector's supply root when it is not.
 */
export function classifyWarehouseSectorRole(input: {
  organizationKind: string | null | undefined;
  institutionClass: string | null | undefined;
  warehouseKind: string | null | undefined;
  facilityId: string | null | undefined;
  isMain: boolean | null | undefined;
}): WarehouseSectorRole {
  // A facility binding is decisive on its own: a warehouse attached to an
  // organization_facility is that facility's depot regardless of org class.
  if (input.facilityId) return 'health_center';

  const isHealthSector = input.organizationKind === 'care_institution'
    && input.institutionClass === 'health_sector';
  if (!isHealthSector) return 'unclassified';

  // Migration 181: a health sector holds institution warehouses only, and an
  // active facility-less one must carry is_main. Both must hold before this is
  // the sector main — the null alone proves nothing.
  if (input.warehouseKind !== 'institution') return 'unclassified';
  if (input.isMain !== true) return 'unclassified';

  return 'sector_main';
}

/**
 * What an operator reads. Never an input to identity or authorization.
 *
 * `nationalCode` carries the CATALOG-LEVEL national code semantic. For a stock
 * lot that is `national_code`. For a `central_items` row it is `barcode` —
 * Migration 114 states the contract explicitly: "`barcode` (already unique,
 * already indexed) continues to serve as the catalog's national-code identity
 * — no duplicate column", and the owner reaffirmed it for G3.2 (DECISION A).
 * The database column keeps its historical name; only this semantic field
 * unifies the two. Any future requirement for a GTIN *and* a separate national
 * registration code is new schema work and a separate owner decision.
 */
export interface MaterialDisplay {
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  /** Catalog-level national code semantic. See the note above. */
  nationalCode: string | null;
  /** Lot-level batch, where the source is a stock lot. Never material identity. */
  batchNumber: string | null;
  expiryDate: string | null;
}

/**
 * Whether this result may be used right now — and, when it may not, why.
 *
 * `blockedReasonKey` is an i18n key, never a rendered sentence: the reason must
 * survive both languages. `selectable === false` with a null reason is a defect,
 * not a state; an operator who cannot use a row is owed the explanation.
 */
export interface MaterialEligibility {
  selectable: boolean;
  /** Catalog `status === 'active'`, or lot-level usability. */
  active: boolean;
  availableQuantity: number | null;
  expired: boolean | null;
  blockedReasonKey: string | null;
}

/** One canonical search result: the four concerns, kept apart. */
export interface CanonicalMaterialResult {
  identity: MaterialIdentity;
  scope: MaterialScope;
  display: MaterialDisplay;
  eligibility: MaterialEligibility;
}

/**
 * A stable grouping key for aggregating stock rows BY MATERIAL.
 *
 * DECISION C. Returns the database's `material_identity_key` when the row
 * carries one. When it does not, the row is ISOLATED under a key derived from
 * its own source row id — never from its name, national code or any display
 * label. Two rows can then never merge on the strength of looking alike; the
 * worst outcome is that one physically identical material appears twice, which
 * an operator can see and reconcile. The opposite failure — silently summing
 * two different materials into one total — is invisible and unrecoverable.
 *
 * This mirrors `isExactReleaseCandidate`'s fail-safe in stock-identity.ts:
 * a missing canonical key yields "no match", never a partial-field guess.
 *
 * Returns `null` when neither a key nor a source row id is available, which the
 * caller must treat as "cannot be grouped" rather than "group with anything".
 */
export function materialGroupingKey(row: {
  materialIdentityKey: string | null | undefined;
  sourceRowId: string | null | undefined;
}): string | null {
  const key = row.materialIdentityKey?.trim();
  if (key) return `identity:${key}`;
  const rowId = row.sourceRowId?.trim();
  if (rowId) return `isolated-row:${rowId}`;
  return null;
}

/**
 * The canonical identity of an `inventory_alerts` row, or `null` when it has
 * none.
 *
 * CORRECTED DECISION C. An earlier reading of this rule isolated EVERY alert,
 * on the premise that `inventory_alerts` carries no structural material
 * identifier and that only its text columns could ever link it to stock. That
 * premise was false. Migration 150 adds `central_item_id`, `source_stock_id`,
 * `material_identity_version`, `material_identity_key` and
 * `material_identity_state` to the table, and constrains the last three
 * together:
 *
 *   inventory_alerts_material_state_chk CHECK (
 *     (material_identity_state = 'resolved'
 *      AND material_identity_version = 1 AND material_identity_key IS NOT NULL)
 *     OR
 *     (material_identity_state = 'legacy_unresolved'
 *      AND material_identity_version IS NULL AND material_identity_key IS NULL))
 *
 * A 'resolved' alert's key is therefore not a lookalike of the stock row's key
 * — it is the SAME generated value. 150's backfill sets it only where exactly
 * one live material in the alert's own scope matched (`HAVING count(DISTINCT
 * x.material_identity_key) = 1`), and `phoenix_recompute_inventory_alerts`
 * copies it straight off the stock rows it aggregated. Structural scope plus
 * that key is proof, and proof is what DECISION C always asked for.
 *
 * 'legacy_unresolved' still means NOTHING WAS PROVED, and such a row keeps
 * `null` here so `materialGroupingKey` isolates it. There is deliberately no
 * fallback to `scientific_name`, `national_code`, concentration, dosage form or
 * any normalized label — that is the label-identity defect this contract exists
 * to refuse. The case is not hypothetical: 150's threshold-expectation branch
 * emits a live `missing` alert for a material with no stock at all, and such a
 * row is *only* a name and a code.
 *
 * The CHECK constraint makes all three fields consistent server-side, but this
 * reads defensively rather than trusting a shape it did not construct, and
 * mirrors the constraint in full: 'resolved' plus version 1 plus a non-blank
 * key, or nothing. A row arriving as 'resolved' with a blank key, or without
 * version 1, is treated as unresolved. Under-claiming identity isolates a row
 * an operator can see and reconcile; over-claiming it merges materials that
 * were never proved to be the same.
 *
 * `central_items.id` is deliberately NOT part of this decision, and that is not
 * an oversight. 150 populates `inventory_alerts.central_item_id` from
 * `max(central_item_id)` over the stock rows it aggregated, which is NULL when
 * those rows predate the catalog linkage even though their generated
 * `material_identity_key` is perfectly valid. Requiring it would isolate real,
 * fully-resolved alerts. It is read as context, never as a gate.
 *
 * This answers only WHICH MATERIAL an alert is about. It says nothing about
 * quantity: an alert's observed snapshot is never a stock truth. See the
 * G32-B01 note in `global-material-search.service.ts`.
 */
export function alertCanonicalIdentityKey(alert: {
  materialIdentityState: string | null | undefined;
  materialIdentityKey: string | null | undefined;
  materialIdentityVersion: number | null | undefined;
}): string | null {
  if (alert.materialIdentityState !== 'resolved') return null;
  if (alert.materialIdentityVersion !== 1) return null;
  const key = alert.materialIdentityKey?.trim();
  return key ? key : null;
}

/**
 * True when this key came from an isolated row rather than a canonical
 * identity — i.e. the row could not be grouped with anything and stands alone.
 * Surfaced so a report can explain why a material appears unaggregated instead
 * of leaving the operator to wonder.
 */
export function isIsolatedGroupingKey(key: string): boolean {
  return key.startsWith('isolated-row:');
}
