/* ─── MEDISTOCK PHOENIX — Canonical Status Foundation ─────────────────────────
 *
 * STATUS-CANONICAL-TYPES-AND-HELPERS-A
 *
 * Pure, dependency-free foundation that unifies the two disconnected status
 * vocabularies found in the STATUS-LOGIC-CANONICALIZATION-A audit:
 *
 *   1. item_availability.condition
 *        available | low_stock | missing | surplus | near_expiry | expired
 *   2. institution_item_status_reports.status_type  (manual report layer)
 *        scarce | surplus | near_expiry | missing
 *
 * Canonical domain vocabulary = the item_availability set. `scarce` is treated
 * as a LEGACY STORAGE ALIAS for `low_stock` (the DB CHECK still stores
 * 'scarce'; we never rename it — we map it here at the boundary).
 *
 * This module is intentionally additive and side-effect free:
 *   - No Supabase / network / browser globals.
 *   - No behavior routing yet — later phases wire UI/reports/alerts through it.
 *   - Date logic mirrors materialAlertEngine.addMonths / expiryBucket and the
 *     get_public_qr_payload RPC (migration 028) so JS and Postgres agree.
 *
 * Quantity thresholds do NOT exist yet, so low_stock and surplus remain MANUAL
 * (never auto-derived from quantity in this phase).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** The 6 values accepted by item_availability.condition (migration 001). */
export type RawAvailabilityCondition =
  | 'available'
  | 'low_stock'
  | 'missing'
  | 'surplus'
  | 'near_expiry'
  | 'expired';

/** The 4 values accepted by institution_item_status_reports.status_type (migration 006). */
export type LegacyStatusReportType =
  | 'scarce'
  | 'surplus'
  | 'near_expiry'
  | 'missing';

/**
 * Two extra stored conditions accepted by item_availability.condition after
 * migration 066 (mirrored by AvailabilityCondition in lib/types.ts):
 *
 *   - `not_stocked` — an authoritative catalog claim that this outlet/scope does
 *     NOT stock the material. It is NOT the same as `missing`.
 *   - `unknown`     — the stock state is genuinely unknown (not yet reported).
 *
 * They are epistemic/catalog states, not quantity states, so they are kept
 * OUTSIDE CanonicalStatus (whose six values all imply a known, stocked item)
 * and handled explicitly in computeEffectiveStatus.
 */
export type ExtendedAvailabilityCondition =
  | RawAvailabilityCondition
  | 'unknown'
  | 'not_stocked';

/** Canonical domain status — identical shape to RawAvailabilityCondition. */
export type CanonicalStatus = RawAvailabilityCondition;

/**
 * The final status surfaced to UI/reports/alerts. Adds the two non-quantity
 * states so `not_stocked`/`unknown` are never silently collapsed into
 * `available` or `missing` (STATUS-CANONICAL-UNKNOWN-NOT-STOCKED-A).
 */
export type EffectiveStatus = CanonicalStatus | 'unknown' | 'not_stocked';

/** Expiry-derived state, independent of quantity/manual condition. */
export type DerivedExpiryStatus = 'normal' | 'near_expiry' | 'expired';

/** Fine-grained expiry bucket; null when beyond the 9-month watch horizon. */
export type ExpiryBucket = 'expired' | '3_months' | '6_months' | '9_months' | null;

/** Baseline severity scale (alert engines may specialize later). */
export type EffectiveSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Result of computeEffectiveStatus — carries enough for later UI/reporting use. */
export interface EffectiveStatusResult {
  rawCondition: ExtendedAvailabilityCondition;
  normalizedCondition: EffectiveStatus;
  expiryBucket: ExpiryBucket;
  derivedExpiryStatus: DerivedExpiryStatus;
  effectiveStatus: EffectiveStatus;
  severity: EffectiveSeverity;
}

export interface ComputeEffectiveStatusInput {
  rawCondition: ExtendedAvailabilityCondition;
  quantity: number | null | undefined;
  expiryDate: string | Date | null | undefined;
  today?: Date;
  /**
   * Reserved for a later phase. Quantity thresholds do not exist yet, so this
   * is accepted but NOT used to derive low_stock/surplus in this phase.
   */
  thresholds?: { minQuantity?: number | null; maxQuantity?: number | null };
}

export interface DeriveExpiryOptions {
  /** Months within which an item counts as the actionable `near_expiry` status. */
  nearExpiryWindowMonths?: number;
}

// ─── normalizeStatusType ──────────────────────────────────────────────────────

/**
 * Map a legacy/report or raw value into canonical status vocabulary.
 *   scarce -> low_stock ; everything else maps to itself.
 * Returns null for unknown input (callers decide how to handle).
 */
export function normalizeStatusType(
  value: LegacyStatusReportType | RawAvailabilityCondition | string | null | undefined,
): CanonicalStatus | null {
  switch (value) {
    case 'scarce':
    case 'low_stock':
      return 'low_stock';
    case 'available':
      return 'available';
    case 'missing':
      return 'missing';
    case 'surplus':
      return 'surplus';
    case 'near_expiry':
      return 'near_expiry';
    case 'expired':
      return 'expired';
    default:
      return null;
  }
}

// ─── Date helpers (date-only; mirror materialAlertEngine + Postgres) ──────────

/** Strip a Date down to local Y/M/D midnight for date-only comparison. */
function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Add `months` to `baseDate`, clamping to the target month's last day —
 * matches Postgres `(date + interval 'N months')::date` and the existing
 * materialAlertEngine.addMonths semantics (e.g. Jan 31 + 1 month => Feb 28/29).
 */
export function addMonthsClamped(baseDate: Date, months: number): Date {
  const rawMonth = baseDate.getMonth() + months;
  const y = baseDate.getFullYear() + Math.floor(rawMonth / 12);
  const m = ((rawMonth % 12) + 12) % 12;
  const lastDay = new Date(y, m + 1, 0).getDate(); // day 0 of next month = last day of m
  return new Date(y, m, Math.min(baseDate.getDate(), lastDay));
}

/** Parse a 'YYYY-MM-DD' (or ISO-prefixed) string to a Date, or null if invalid. */
export function parseExpiryDate(s: string | Date | null | undefined): Date | null {
  if (s instanceof Date) return isNaN(s.getTime()) ? null : s;
  if (!s || typeof s !== 'string') return null;
  const dateStr = s.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const d = new Date(dateStr + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Return the expiry bucket for `expiryDate` relative to `today`:
 *   expired  if expiryDate < today
 *   3_months if expiryDate <= today + 3 months
 *   6_months if expiryDate <= today + 6 months
 *   9_months if expiryDate <= today + 9 months
 *   null     otherwise (beyond 9 months, or unparseable date)
 * Mirrors materialAlertEngine.expiryBucket and RPC 028.
 */
export function getExpiryBucket(today: Date, expiryDate: string | Date | null | undefined): ExpiryBucket {
  const exp = parseExpiryDate(expiryDate);
  if (!exp) return null;
  const base = dateOnly(today);
  const e = dateOnly(exp);
  if (e < base) return 'expired';
  if (e <= addMonthsClamped(base, 3)) return '3_months';
  if (e <= addMonthsClamped(base, 6)) return '6_months';
  if (e <= addMonthsClamped(base, 9)) return '9_months';
  return null;
}

/**
 * Collapse the expiry bucket into a coarse expiry status, using a conservative
 * default near-expiry window of 3 months. 6/9-month buckets stay `normal` here
 * (they remain useful as watch badges via getExpiryBucket separately).
 */
export function deriveExpiryStatus(
  today: Date,
  expiryDate: string | Date | null | undefined,
  options?: DeriveExpiryOptions,
): DerivedExpiryStatus {
  const exp = parseExpiryDate(expiryDate);
  if (!exp) return 'normal';
  const base = dateOnly(today);
  const e = dateOnly(exp);
  if (e < base) return 'expired';
  const windowMonths = options?.nearExpiryWindowMonths ?? 3;
  if (e <= addMonthsClamped(base, windowMonths)) return 'near_expiry';
  return 'normal';
}

// ─── Severity ─────────────────────────────────────────────────────────────────

/** Baseline severity mapping for an effective status. */
export function getStatusSeverity(
  status: EffectiveStatus,
  _expiryBucket?: ExpiryBucket,
): EffectiveSeverity {
  switch (status) {
    case 'expired':     return 'critical';
    case 'missing':     return 'critical';
    case 'near_expiry': return 'high';
    case 'low_stock':   return 'medium';
    case 'surplus':     return 'low';
    case 'available':   return 'info';
    // Non-quantity states: informational, never critical. `not_stocked` is a
    // deliberate catalog choice and `unknown` is simply unreported — neither is
    // an actionable shortage.
    case 'not_stocked': return 'info';
    case 'unknown':     return 'info';
  }
}

// ─── computeEffectiveStatus ───────────────────────────────────────────────────

/**
 * Compute the effective canonical status from raw condition + quantity + expiry.
 *
 * Precedence (no quantity thresholds active in this phase):
 *   1. expired      — expiryDate < today
 *   2. missing      — quantity <= 0 OR rawCondition === 'missing'
 *   3. near_expiry  — expiry within 3-month window OR rawCondition === 'near_expiry'
 *   4. low_stock    — rawCondition === 'low_stock'      (MANUAL ONLY)
 *   5. surplus      — rawCondition === 'surplus'        (MANUAL ONLY)
 *   6. available    — fallback
 *
 * Notes:
 *   - low_stock / surplus are NEVER auto-derived from quantity (no thresholds).
 *   - rawCondition === 'expired' yields effectiveStatus 'expired', but the
 *     editor should not normally set 'expired' manually — it is expiry-derived.
 */
export function computeEffectiveStatus(input: ComputeEffectiveStatusInput): EffectiveStatusResult {
  const today = input.today ?? new Date();
  const rawCondition = input.rawCondition;
  const expiryBucket = getExpiryBucket(today, input.expiryDate);
  const derivedExpiryStatus = deriveExpiryStatus(today, input.expiryDate);

  // ── Highest precedence: the two non-quantity states (migration 066) ──────────
  // `not_stocked` and `unknown` are authoritative claims about whether the item
  // is stocked/known at all. They MUST short-circuit before the quantity and
  // expiry rules below, so a zero-quantity `not_stocked`/`unknown` row is never
  // relabelled as `missing`, and a positive-quantity one is never `available`.
  // `missing` stays reserved for an EXPECTED material whose on_hand is 0.
  if (rawCondition === 'not_stocked' || rawCondition === 'unknown') {
    return {
      rawCondition,
      normalizedCondition: rawCondition,
      expiryBucket,
      derivedExpiryStatus,
      effectiveStatus: rawCondition,
      severity: getStatusSeverity(rawCondition, expiryBucket),
    };
  }

  const normalizedCondition = normalizeStatusType(rawCondition) ?? 'available';

  const qty = input.quantity;
  const hasQty = typeof qty === 'number' && !Number.isNaN(qty);

  let effectiveStatus: CanonicalStatus;
  if (derivedExpiryStatus === 'expired' || normalizedCondition === 'expired') {
    effectiveStatus = 'expired';
  } else if ((hasQty && qty! <= 0) || normalizedCondition === 'missing') {
    effectiveStatus = 'missing';
  } else if (derivedExpiryStatus === 'near_expiry' || normalizedCondition === 'near_expiry') {
    effectiveStatus = 'near_expiry';
  } else if (normalizedCondition === 'low_stock') {
    effectiveStatus = 'low_stock';
  } else if (normalizedCondition === 'surplus') {
    effectiveStatus = 'surplus';
  } else {
    effectiveStatus = 'available';
  }

  return {
    rawCondition,
    normalizedCondition,
    expiryBucket,
    derivedExpiryStatus,
    effectiveStatus,
    severity: getStatusSeverity(effectiveStatus, expiryBucket),
  };
}
