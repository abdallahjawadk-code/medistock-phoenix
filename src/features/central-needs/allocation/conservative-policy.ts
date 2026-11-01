import { checkManualQuantityText } from '../manual/manual-quantity';

/** R2 arithmetic only. The caller owns authoritative scope, event and version
 * selection. These functions never authorize, approve, persist or move stock. */
export interface R2CapacityInput {
  readonly annual: string | null;
  readonly allocated: string | null;
  readonly executed: string | null;
}

export type R2CapacityResult = {
  readonly status: 'ready';
  readonly remainingToAllocate: string;
  readonly remainingToFulfill: string;
  readonly overAllocated: boolean;
  readonly overExecuted: boolean;
} | {
  readonly status: 'unavailable';
  readonly reason: 'missing_quantity' | 'invalid_quantity';
};

export type R2MonthlyProposalResult = {
  readonly status: 'ready';
  readonly proposals: ReadonlyArray<{ readonly month: number; readonly quantity: string }>;
} | {
  readonly status: 'unavailable';
  readonly reason: 'invalid_quantity' | 'invalid_step' | 'invalid_periods' | 'not_multiple_of_step';
};

interface ExactQuantity { readonly coefficient: bigint; readonly scale: number }

/** Reuse R1's public input grammar without changing its raw quantity contract. */
function readQuantity(text: unknown): ExactQuantity | null {
  const checked = checkManualQuantityText(text);
  if (!checked.ok) return null;
  const [whole, fraction = ''] = checked.text.split('.');
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}

function atScale(value: ExactQuantity, scale: number): bigint {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}

/** Derived values use canonical text; source quantity strings remain untouched. */
function formatQuantity(value: bigint, scale: number): string {
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, '0');
  if (scale === 0) return sign + digits;
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return sign + digits.slice(0, -scale) + (fraction ? `.${fraction}` : '');
}

/** Calculate A-C and C-D from one caller-validated accounting scope.
 * Missing/invalid input stays unavailable; a negative remainder stays visible. */
export function calculateR2Capacity(input: R2CapacityInput): R2CapacityResult {
  if (input.annual === null || input.allocated === null || input.executed === null) {
    return { status: 'unavailable', reason: 'missing_quantity' };
  }
  const annual = readQuantity(input.annual);
  const allocated = readQuantity(input.allocated);
  const executed = readQuantity(input.executed);
  if (!annual || !allocated || !executed) return { status: 'unavailable', reason: 'invalid_quantity' };
  const scale = Math.max(annual.scale, allocated.scale, executed.scale);
  const a = atScale(annual, scale), c = atScale(allocated, scale), d = atScale(executed, scale);
  return {
    status: 'ready',
    remainingToAllocate: formatQuantity(a - c, scale),
    remainingToFulfill: formatQuantity(c - d, scale),
    overAllocated: c > a,
    overExecuted: d > c,
  };
}

/** Propose an exact quantity over explicitly selected UNAPPROVED months.
 * The caller must supply the lawful unit step and exclude locked/approved
 * periods. This calculation cannot select a year, rewrite a saved period,
 * adopt a forecast, or approve its result. Remainders follow calendar order. */
export function proposeEqualMonthlyQuantities(
  quantity: string, unitStep: string, unapprovedMonths: readonly number[],
): R2MonthlyProposalResult {
  const total = readQuantity(quantity);
  if (!total) return { status: 'unavailable', reason: 'invalid_quantity' };
  const step = readQuantity(unitStep);
  if (!step || step.coefficient === 0n) return { status: 'unavailable', reason: 'invalid_step' };
  if (!Array.isArray(unapprovedMonths) || unapprovedMonths.length < 1 || unapprovedMonths.length > 12
    || !unapprovedMonths.every(month => Number.isInteger(month) && month >= 1 && month <= 12)
    || new Set(unapprovedMonths).size !== unapprovedMonths.length) {
    return { status: 'unavailable', reason: 'invalid_periods' };
  }
  const scale = Math.max(total.scale, step.scale);
  const target = atScale(total, scale), increment = atScale(step, scale);
  if (target % increment !== 0n) return { status: 'unavailable', reason: 'not_multiple_of_step' };
  const units = target / increment, count = BigInt(unapprovedMonths.length);
  const each = units / count, remainder = units % count;
  return {
    status: 'ready',
    proposals: [...unapprovedMonths].sort((a, b) => a - b).map((month, index) => ({
      month,
      quantity: formatQuantity((each + (BigInt(index) < remainder ? 1n : 0n)) * increment, scale),
    })),
  };
}
