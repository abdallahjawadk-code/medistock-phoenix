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
 *   organizations                 organization_kind: care_institution | pharmacy_department_authority
 *     ├── (care_institution)      institution_class: hospital | specialized_center | health_sector
 *     │     └── organization_facilities subordinate facility   (facility_class)
 *     │           └── warehouses        inventory node
 *     │                 └── distribution_points  outlets (pharmacy | crash_cabinet | rescue_cart)
 *     └── (pharmacy_department_authority)  institution_class is always NULL — not a
 *           care-delivery institution; owns only `central`-kind warehouses,
 *           never a facility, never a distribution_point (STAGE-E-E7-1-171).
 *
 * Four things this vocabulary exists to keep straight, each of which was got
 * wrong at least once during planning:
 *
 *   1. `institution_class` classifies a CARE-DELIVERY institution — it is
 *      meaningful only when `organization_kind === 'care_institution'`. A
 *      Pharmacy Department central supply authority is a distinct
 *      organizational actor (STAGE-E-E7-1-171): it owns central-supply
 *      warehouses and participates in the central->institution corridor, but
 *      it delivers no care itself, so it is never hospital, specialized_center,
 *      or health_sector — its `institution_class` is always NULL, by design,
 *      never a sentinel and never a fourth institution class.
 *
 *   2. A health centre is NOT a top-level institution class. `institution_class`
 *      has exactly three values; a health centre is a FACILITY belonging to a
 *      `health_sector` organization. Putting `primary_health_center` into
 *      `institution_class` flattens the hierarchy.
 *
 *   3. A health centre is NOT its warehouse. A facility is an administrative /
 *      clinical entity with its own identity and lifecycle; a warehouse is an
 *      inventory node. A facility may have zero, one, or several warehouses,
 *      and deactivating a warehouse must not destroy facility identity.
 *
 *   4. Administrative identity and clinical context are SEPARATE axes.
 *      `clinical_location_kind` records the clinical context CATEGORY of an
 *      outlet — it is not a ward master record and never identifies which ward
 *      an outlet belongs to. Facility membership is carried by the outlet's
 *      warehouse, never by this field.
 */

/**
 * The top-level organizational-actor discriminator (STAGE-E-E7-1-171).
 * Orthogonal to `InstitutionClass`, which is meaningful only for
 * `care_institution` rows — a `pharmacy_department_authority` row's
 * `institution_class` is always NULL.
 */
export type OrganizationKind = 'care_institution' | 'pharmacy_department_authority';

/** The three TOP-LEVEL institution classes. A health centre is never one of these.
 * Meaningful only when the owning organization's kind is `care_institution`. */
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

export const ORGANIZATION_KINDS: readonly OrganizationKind[] = Object.freeze([
  'care_institution',
  'pharmacy_department_authority',
] as const);

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
export function isOrganizationKind(value: unknown): value is OrganizationKind {
  return typeof value === 'string'
    && (ORGANIZATION_KINDS as readonly string[]).includes(value);
}

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
