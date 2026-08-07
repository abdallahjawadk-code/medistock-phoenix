/**
 * STAGE-E-1 — the institutional hierarchy vocabulary, shared and closed.
 *
 * This module is TYPES AND VOCABULARY ONLY. It performs no database access,
 * declares no service function, and encodes no eligibility rule. The placement
 * and routing rules that consume these tokens are enforced SERVER-SIDE in a
 * later Stage-E slice; duplicating them here would create a second, drifting
 * source of truth for a security-relevant decision.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HIERARCHY, STATED ONCE
 * ─────────────────────────────────────────────────────────────────────────────
 *   organizations                 top-level institution  (institution_class)
 *     └── organization_facilities subordinate facility   (facility_class)
 *           └── warehouses        inventory node
 *                 └── distribution_points  outlets (pharmacy | crash_cabinet | rescue_cart)
 *
 * Three things this vocabulary exists to keep straight, each of which was got
 * wrong at least once during planning:
 *
 *   1. A health centre is NOT a top-level institution class. `institution_class`
 *      has exactly three values; a health centre is a FACILITY belonging to a
 *      `health_sector` organization. Putting `primary_health_center` into
 *      `institution_class` flattens the hierarchy.
 *
 *   2. A health centre is NOT its warehouse. A facility is an administrative /
 *      clinical entity with its own identity and lifecycle; a warehouse is an
 *      inventory node. A facility may have zero, one, or several warehouses,
 *      and deactivating a warehouse must not destroy facility identity.
 *
 *   3. Administrative identity and clinical context are SEPARATE axes.
 *      `clinical_location_kind` records the clinical context CATEGORY of an
 *      outlet — it is not a ward master record and never identifies which ward
 *      an outlet belongs to. Facility membership is carried by the outlet's
 *      warehouse, never by this field.
 */

/** The three TOP-LEVEL institution classes. A health centre is never one of these. */
export type InstitutionClass = 'hospital' | 'specialized_center' | 'health_sector';

/**
 * Subordinate facility classes. Both belong to a `health_sector` organization;
 * neither is an institution class and neither is an organization of its own.
 */
export type FacilityClass = 'primary_health_center' | 'subordinate_health_center';

/**
 * The clinical context CATEGORY of an outlet's location. Deliberately a
 * category, not a ward identity: Stage E needs to tell an emergency location
 * from a non-emergency one, and nothing finer.
 */
export type ClinicalLocationKind = 'emergency' | 'non_emergency';

export const INSTITUTION_CLASSES: readonly InstitutionClass[] = Object.freeze([
  'hospital',
  'specialized_center',
  'health_sector',
] as const);

export const FACILITY_CLASSES: readonly FacilityClass[] = Object.freeze([
  'primary_health_center',
  'subordinate_health_center',
] as const);

export const CLINICAL_LOCATION_KINDS: readonly ClinicalLocationKind[] = Object.freeze([
  'emergency',
  'non_emergency',
] as const);

/**
 * Narrowing guards. Each is FAIL-CLOSED: null, undefined, an empty string and
 * any unrecognised token all return false, so an unclassified row can never be
 * mistaken for a classified one.
 */
export function isInstitutionClass(value: unknown): value is InstitutionClass {
  return typeof value === 'string'
    && (INSTITUTION_CLASSES as readonly string[]).includes(value);
}

export function isFacilityClass(value: unknown): value is FacilityClass {
  return typeof value === 'string'
    && (FACILITY_CLASSES as readonly string[]).includes(value);
}

export function isClinicalLocationKind(value: unknown): value is ClinicalLocationKind {
  return typeof value === 'string'
    && (CLINICAL_LOCATION_KINDS as readonly string[]).includes(value);
}

/**
 * True when this organization class may own subordinate facilities. Only a
 * health sector can: a hospital or specialized centre has no facility layer.
 * This mirrors the database rule that a facility's parent organization must be
 * a `health_sector`; it is a display/branching convenience, NOT the enforcement
 * point.
 */
export function institutionClassOwnsFacilities(value: unknown): boolean {
  return value === 'health_sector';
}
