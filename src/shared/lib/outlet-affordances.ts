/**
 * R1.2C — OUTLET AFFORDANCE MIRROR (presentation only).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * Migration 183 states the active-outlet topology matrix ONCE, server-side, in
 * phoenix_assert_active_outlet_topology_v1, and enforces it on the two paths an
 * outlet can become operational. That validator is the AUTHORITY. Nothing here
 * is.
 *
 * This module exists for one narrower reason: an interface that offers an
 * action the database will always refuse is a defect in its own right. It
 * wastes the operator's time, and it teaches them that failures are normal —
 * which is how a real refusal later gets clicked through. So the UI mirrors the
 * matrix, and this is the single place that mirror lives.
 *
 * Three properties follow deliberately from that framing:
 *
 *   1. IT IS PURE. No database access, no service call, no React, no i18n. It
 *      is a total function of its arguments, so it can be tested exhaustively
 *      and cannot drift per-screen.
 *   2. IT IS SHARED BY CREATE AND EDIT. A second copy inside the edit dialog is
 *      exactly the drift R1.2C exists to close, one layer up.
 *   3. IT FAILS CLOSED. An owner whose kind or class is unknown — still
 *      loading, or a class added later — offers nothing. Refusing to guess is
 *      the only safe reading for a screen that creates operational topology.
 *
 * It is NOT placed in institution-hierarchy.ts on purpose: that module is types
 * and vocabulary, and turning it into a decision module would make the
 * vocabulary look like an enforcement point.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MATRIX (mirrors Migration 183 exactly)
 * ─────────────────────────────────────────────────────────────────────────────
 *   OWNER                                    pharmacy  crash_cabinet  rescue_cart
 *   --------------------------------------------------------------------------
 *   hospital                                  yes      non_emergency  emergency
 *   specialized_center                        yes      non_emergency  FORBIDDEN
 *   health_sector (facility-bound depot only) yes      emergency      FORBIDDEN
 *   pharmacy_department_authority             FORBIDDEN — no outlets at all
 *
 * The crash-cabinet context INVERTS between a hospital and a health centre, and
 * that is not an inconsistency to normalise away: in a hospital the crash
 * cabinet is a ward cabinet and the rescue cart is the emergency-department
 * trolley, whereas a health centre has no emergency department, so its crash
 * cabinet IS its emergency location.
 */
import type {
  ClinicalLocationKind, InstitutionClass, OrganizationKind,
} from './institution-hierarchy';

/** The three outlet types this product operates. */
export type ApprovedOutletPointType = 'pharmacy' | 'crash_cabinet' | 'rescue_cart';

/** The two types that are EMERGENCY outlets and carry a context requirement. */
export const EMERGENCY_OUTLET_POINT_TYPES: readonly ApprovedOutletPointType[] =
  Object.freeze(['crash_cabinet', 'rescue_cart'] as const);

/**
 * Everything the matrix needs to know about the owning organization, and
 * nothing more. Both fields accept null/undefined so a still-loading screen is
 * a first-class, fail-closed input rather than a crash.
 */
export interface OutletOwner {
  organizationKind: OrganizationKind | null | undefined;
  institutionClass: InstitutionClass | null | undefined;
}

/** The subset of a warehouse this module reads. */
export interface OutletWarehouseShape {
  facilityId: string | null;
}

/**
 * The owner's effective classification, or null when it cannot be determined.
 * Every other function in this module routes through this one, so "unknown"
 * has exactly one definition.
 */
function classify(owner: OutletOwner): InstitutionClass | null {
  if (owner.organizationKind !== 'care_institution') return null;
  const c = owner.institutionClass;
  return c === 'hospital' || c === 'specialized_center' || c === 'health_sector' ? c : null;
}

/**
 * Whether an Add Outlet affordance may be offered at all.
 *
 * A pharmacy department authority is a supply and oversight body: dispensing is
 * what its member institutions do, and Migration 183 refuses its outlets with
 * or without an owning warehouse. An unclassified owner is refused for the same
 * reason the database refuses it — there is no proven-safe answer.
 */
export function canCreateOutlets(owner: OutletOwner): boolean {
  return classify(owner) !== null;
}

/**
 * The outlet types offered for this owner, in stable display order.
 *
 * A rescue cart is a hospital emergency-department concept: a specialized
 * centre runs no emergency department, and a health centre has none either.
 */
export function selectableOutletPointTypes(owner: OutletOwner): readonly ApprovedOutletPointType[] {
  switch (classify(owner)) {
    case 'hospital':           return Object.freeze(['pharmacy', 'crash_cabinet', 'rescue_cart'] as const);
    case 'specialized_center': return Object.freeze(['pharmacy', 'crash_cabinet'] as const);
    case 'health_sector':      return Object.freeze(['pharmacy', 'crash_cabinet'] as const);
    default:                   return Object.freeze([] as const);
  }
}

/** True when `type` is one of the two emergency outlet types. */
export function isEmergencyOutletPointType(type: string): boolean {
  return (EMERGENCY_OUTLET_POINT_TYPES as readonly string[]).includes(type);
}

/**
 * The clinical contexts that are LEGAL for this owner and type.
 *
 * For every legal emergency combination this has exactly ONE element — which is
 * what makes deterministic normalisation possible rather than asking the
 * operator to guess. An empty result means the combination has no legal context
 * at all, i.e. the type itself is forbidden for this owner.
 *
 * A pharmacy is not an emergency destination: it carries no requirement, so
 * BOTH contexts (and none) are acceptable and it is deliberately not
 * over-constrained — an ER pharmacy legitimately carries an emergency context
 * and is the SOURCE of rescue-cart replenishment.
 */
export function legalClinicalContexts(
  owner: OutletOwner, pointType: string,
): readonly ClinicalLocationKind[] {
  if (!selectableOutletPointTypes(owner).includes(pointType as ApprovedOutletPointType)) {
    return Object.freeze([] as const);
  }
  if (pointType === 'pharmacy') return Object.freeze(['emergency', 'non_emergency'] as const);

  switch (classify(owner)) {
    case 'hospital':
      return pointType === 'rescue_cart'
        ? Object.freeze(['emergency'] as const)
        : Object.freeze(['non_emergency'] as const);
    case 'specialized_center':
      // rescue_cart is already excluded by selectableOutletPointTypes above.
      return Object.freeze(['non_emergency'] as const);
    case 'health_sector':
      // A health centre has no emergency department, so its crash cabinet IS
      // the emergency location — the inversion relative to a hospital.
      return Object.freeze(['emergency'] as const);
    default:
      return Object.freeze([] as const);
  }
}

/**
 * The single context an emergency outlet MUST carry, or null when the caller
 * has a genuine choice (a pharmacy) or no legal option at all.
 */
export function requiredClinicalContext(
  owner: OutletOwner, pointType: string,
): ClinicalLocationKind | null {
  if (!isEmergencyOutletPointType(pointType)) return null;
  const legal = legalClinicalContexts(owner, pointType);
  return legal.length === 1 ? legal[0] : null;
}

/** Whether the clinical-context field is REQUIRED before submit. */
export function isClinicalContextRequired(pointType: string): boolean {
  return isEmergencyOutletPointType(pointType);
}

/**
 * The context a form should hold after the point type or the owning
 * institution changes.
 *
 * Stale illegal state is the bug this closes: switching a form from a rescue
 * cart to a crash cabinet must not leave 'emergency' sitting in the field,
 * where it would be submitted and refused by the database. Because every legal
 * emergency combination has exactly one context, the honest resolution is to
 * normalise rather than to blank and re-ask.
 *
 * Returns '' (the empty selection) when there is no single answer — a pharmacy
 * keeps whatever legal value it had, and an illegal one is cleared.
 */
export function normalizeClinicalContext(
  owner: OutletOwner, pointType: string, current: ClinicalLocationKind | '' | null | undefined,
): ClinicalLocationKind | '' {
  const required = requiredClinicalContext(owner, pointType);
  if (required !== null) return required;
  const legal = legalClinicalContexts(owner, pointType);
  return current && (legal as readonly string[]).includes(current) ? current : '';
}

/**
 * Whether a warehouse may own an outlet for this institution class.
 *
 * Inside a health sector an active outlet must hang off a facility-bound CENTRE
 * depot: the sector main is a supply root, not a dispensing location, and
 * Migration 181/183 refuse an outlet on it. Every other class keeps its
 * warehouses unfiltered.
 */
export function isSelectableOutletWarehouse(
  owner: OutletOwner, warehouse: OutletWarehouseShape,
): boolean {
  if (!canCreateOutlets(owner)) return false;
  if (classify(owner) === 'health_sector') return warehouse.facilityId !== null;
  return true;
}

/** `warehouses` narrowed to those that may own an outlet for this owner. */
export function selectableOutletWarehouses<T extends OutletWarehouseShape>(
  owner: OutletOwner, warehouses: readonly T[],
): T[] {
  return warehouses.filter(w => isSelectableOutletWarehouse(owner, w));
}

/**
 * THE FORM-VALIDITY QUESTION, in one place.
 *
 * The bug this replaces: the create form rendered a required "*" beside the
 * clinical context for the emergency types, while canSubmit ignored the field
 * entirely — so a blank, illegal combination reached the database and came back
 * as an opaque failure.
 *
 * A warehouse is required for the two emergency types because an emergency
 * outlet cannot become operational without initial provisioning, which
 * dispatches FROM a warehouse. A pharmacy keeps Migration 021's freedom.
 */
export function isOutletShapeSubmittable(
  owner: OutletOwner,
  pointType: string,
  clinicalContext: ClinicalLocationKind | '' | null | undefined,
  warehouseId?: string | null,
): boolean {
  if (!selectableOutletPointTypes(owner).includes(pointType as ApprovedOutletPointType)) return false;

  if (isEmergencyOutletPointType(pointType)) {
    if (!warehouseId) return false;
    const legal = legalClinicalContexts(owner, pointType);
    return Boolean(clinicalContext) && (legal as readonly string[]).includes(clinicalContext as string);
  }

  // A pharmacy: no context requirement, but a stated context must still be one
  // the vocabulary recognises.
  if (!clinicalContext) return true;
  return (legalClinicalContexts(owner, pointType) as readonly string[]).includes(clinicalContext);
}

/**
 * Whether an EXISTING stored value is still legal for this owner.
 *
 * Used by the edit dialog to render history honestly: a legacy row created
 * before this matrix existed keeps its values and is displayed as it is, but
 * the legal replacements offered are still constrained. Opening the dialog
 * never mutates anything.
 */
export function isStoredOutletShapeLegal(
  owner: OutletOwner,
  pointType: string,
  clinicalContext: ClinicalLocationKind | '' | null | undefined,
  warehouseId?: string | null,
): boolean {
  return isOutletShapeSubmittable(owner, pointType, clinicalContext, warehouseId);
}
