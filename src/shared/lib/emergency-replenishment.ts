/**
 * STAGE-E-1 — the emergency-replenishment corridor vocabulary, shared and closed.
 *
 * TYPES AND VOCABULARY ONLY. No database access, no service function, no
 * movement is initiated from this module, and no eligibility or routing rule is
 * implemented here. The corridor itself, its route authority and its reversal
 * cap are enforced SERVER-SIDE in later Stage-E slices.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE CORRIDOR IS
 * ─────────────────────────────────────────────────────────────────────────────
 * Routine emergency replenishment moves stock from a PHARMACY outlet to an
 * emergency outlet (rescue cart or crash cabinet) as ONE atomic, causally
 * linked movement pair inside the canonical outlet ledger:
 *
 *   pharmacy  --replenish_send-->  (debit)
 *   emergency outlet  --replenish_receive-->  (credit)
 *
 * Both legs land in `outlet_stock_movements`, sharing one reference id and one
 * request fingerprint. There is no second inventory ledger and no
 * "dispense + manual add" pattern — those would break causality.
 *
 * `outlet_stock` and `warehouse_stock` remain the only balance truths.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE MOVEMENT TOKENS ARE DECLARED BUT NOT LABELLED
 * ─────────────────────────────────────────────────────────────────────────────
 * The two movement types below cannot yet be produced: no database vocabulary
 * accepts them at this stage. They are declared here so every later slice and
 * every UI surface spells them identically, but they are deliberately NOT wired
 * into `movement-labels.ts` — adding a label for a movement that cannot exist
 * would be reporting work for an unreachable state, and belongs with the rest
 * of the reporting slice.
 */

/** The only legal SOURCE outlet type for a replenishment route. */
export type ReplenishmentSourcePointType = 'pharmacy';

/** The only legal DESTINATION outlet types for a replenishment route. */
export type ReplenishmentDestinationPointType = 'rescue_cart' | 'crash_cabinet';

/**
 * The two movement types the corridor appends to the canonical outlet ledger.
 *
 *   replenish_send    — an outlet LOSING stock inside a replenishment corridor
 *   replenish_receive — an outlet GAINING stock inside a replenishment corridor
 *
 * Direction of the OPERATION (forward vs reversal) is carried by the reference
 * type, not by a third and fourth movement type.
 */
export type ReplenishmentMovementType = 'replenish_send' | 'replenish_receive';

/**
 * The two reference-type namespaces that distinguish a forward replenishment
 * from its reversal. Both legs of one operation share a namespace AND a
 * reference id; the movement type separates the legs.
 */
export type ReplenishmentReferenceType =
  | 'outlet_replenishment'
  | 'outlet_replenishment_reversal';

export const REPLENISHMENT_SOURCE_POINT_TYPES: readonly ReplenishmentSourcePointType[] =
  Object.freeze(['pharmacy'] as const);

export const REPLENISHMENT_DESTINATION_POINT_TYPES: readonly ReplenishmentDestinationPointType[] =
  Object.freeze(['rescue_cart', 'crash_cabinet'] as const);

export const REPLENISHMENT_MOVEMENT_TYPES: readonly ReplenishmentMovementType[] =
  Object.freeze(['replenish_send', 'replenish_receive'] as const);

export const REPLENISHMENT_REFERENCE_TYPES: readonly ReplenishmentReferenceType[] =
  Object.freeze(['outlet_replenishment', 'outlet_replenishment_reversal'] as const);

/**
 * Narrowing guards. FAIL-CLOSED: null, undefined, empty string and every
 * unrecognised token return false.
 */
export function isReplenishmentSourcePointType(
  value: unknown,
): value is ReplenishmentSourcePointType {
  return typeof value === 'string'
    && (REPLENISHMENT_SOURCE_POINT_TYPES as readonly string[]).includes(value);
}

export function isReplenishmentDestinationPointType(
  value: unknown,
): value is ReplenishmentDestinationPointType {
  return typeof value === 'string'
    && (REPLENISHMENT_DESTINATION_POINT_TYPES as readonly string[]).includes(value);
}

export function isReplenishmentMovementType(
  value: unknown,
): value is ReplenishmentMovementType {
  return typeof value === 'string'
    && (REPLENISHMENT_MOVEMENT_TYPES as readonly string[]).includes(value);
}

export function isReplenishmentReferenceType(
  value: unknown,
): value is ReplenishmentReferenceType {
  return typeof value === 'string'
    && (REPLENISHMENT_REFERENCE_TYPES as readonly string[]).includes(value);
}
