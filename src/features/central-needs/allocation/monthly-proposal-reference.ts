import { checkManualQuantityText } from '../manual/manual-quantity';
import { proposeEqualMonthlyQuantities } from './conservative-policy';

/** A read-only display contract. A shape/fingerprint never authorizes a write
 * or makes browser data an approved policy; the database must resolve/recheck
 * the current reference and journal the actual employee on any later save. */
export interface MonthlyProposalContext {
  readonly ownerOrgId: string; readonly planningYear: number; readonly annualItemId: string;
  readonly fieldVersionId: string; readonly canonicalItemId: string; readonly unit: string;
  readonly beneficiaryOrganizationId: string;
}
export interface MonthlyPolicyReference {
  readonly policyId: string; readonly version: number; readonly fingerprint: string; readonly status: 'approved';
  readonly context: Omit<MonthlyProposalContext, 'beneficiaryOrganizationId'> & { readonly beneficiaryOrganizationId: string | null };
  readonly unitStep: string; readonly eligibleMonths: readonly number[];
  readonly fixedMonths: ReadonlyArray<{ readonly month: number; readonly quantity: string;
    readonly status: 'approved' | 'locked'; readonly ledgerReference: string }>;
  readonly basis: { readonly documentReference: string; readonly documentSha256: string; readonly periodReference: string;
    readonly priorAllocationStatus: 'none_verified' | 'snapshot_verified'; readonly ledgerSnapshotSha256: string;
    readonly approvedById: string; readonly approvedByName: string; readonly approvedAt: string };
}
interface ProposalRow { readonly month: number; readonly quantity: string; readonly kind: 'fixed' | 'suggested' }
export type MonthlyProposal = { readonly status: 'enter_quantity' | 'awaiting_policy' }
  | { readonly status: 'held'; readonly reason: string }
  | { readonly status: 'ready'; readonly annualQuantity: string; readonly policyFingerprint: string;
    readonly fixedTotal: string; readonly remainingToPropose: string; readonly rows: readonly ProposalRow[]; readonly effectiveAllocation: false };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
function requireValue(value: unknown): asserts value { if (!value) throw new Error('monthly_policy_invalid'); }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  requireValue(Object.keys(row).length === fields.length && fields.every(key => Object.hasOwn(row, key))); return row;
}
function text(value: unknown, max = 2000): string {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= max && value.trim().length > 0 && !CONTROL.test(value)); return value;
}
function uuid(value: unknown): string { const result = text(value, 36); requireValue(UUID.test(result)); return result; }
function digest(value: unknown): string { const result = text(value, 64); requireValue(SHA.test(result)); return result; }
function quantity(value: unknown): string { const checked = checkManualQuantityText(value); requireValue(checked.ok); return checked.text; }
function month(value: unknown): number { requireValue(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 12); return value; }

/** Canonical decimal inputs have already been checked; derived intermediate
 * sums may exceed the input-text length and are never rounded or coerced. */
function exact(value: string) { const [whole, fraction = ''] = value.split('.'); return { coefficient: BigInt(whole + fraction), scale: fraction.length }; }
function scaled(value: ReturnType<typeof exact>, scale: number) { return value.coefficient * 10n ** BigInt(scale - value.scale); }
function formatted(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, '0'); if (!scale) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/, ''); return digits.slice(0, -scale) + (fraction ? `.${fraction}` : '');
}
function sum(values: readonly string[]): string {
  const parsed = values.map(exact), scale = Math.max(0, ...parsed.map(q => q.scale));
  return formatted(parsed.reduce((total, q) => total + scaled(q, scale), 0n), scale);
}
function multiple(value: string, step: string): boolean {
  const a = exact(value), b = exact(step), scale = Math.max(a.scale, b.scale); return scaled(a, scale) % scaled(b, scale) === 0n;
}
function sameQuantity(a: string, b: string): boolean {
  const left = exact(a), right = exact(b), scale = Math.max(left.scale, right.scale); return scaled(left, scale) === scaled(right, scale);
}

export function decodeMonthlyPolicyReference(value: unknown, expected: MonthlyProposalContext): MonthlyPolicyReference {
  const row = object(value, ['policyId','version','fingerprint','status','context','unitStep','eligibleMonths','fixedMonths','basis']);
  const context = object(row.context, ['ownerOrgId','planningYear','annualItemId','fieldVersionId','canonicalItemId','unit','beneficiaryOrganizationId']);
  for (const key of ['ownerOrgId','annualItemId','fieldVersionId','canonicalItemId'] as const) {
    requireValue(uuid(context[key]) === uuid(expected[key]));
  }
  requireValue(typeof context.planningYear === 'number' && Number.isInteger(context.planningYear)
    && context.planningYear >= 2000 && context.planningYear <= 2100 && context.planningYear === expected.planningYear);
  requireValue(text(context.unit, 128) === text(expected.unit, 128)); uuid(expected.beneficiaryOrganizationId);
  requireValue(context.beneficiaryOrganizationId === null || uuid(context.beneficiaryOrganizationId) === expected.beneficiaryOrganizationId);
  requireValue(row.status === 'approved' && typeof row.version === 'number' && Number.isSafeInteger(row.version) && row.version >= 1);
  const unitStep = quantity(row.unitStep); requireValue(exact(unitStep).coefficient > 0n);
  requireValue(Array.isArray(row.eligibleMonths) && row.eligibleMonths.length > 0 && row.eligibleMonths.length <= 12);
  const eligibleMonths = row.eligibleMonths.map(month).sort((a, b) => a - b);
  requireValue(new Set(eligibleMonths).size === eligibleMonths.length);
  requireValue(Array.isArray(row.fixedMonths) && row.fixedMonths.length <= 12);
  const fixedMonths = row.fixedMonths.map(value => {
    const fixed = object(value, ['month','quantity','status','ledgerReference']);
    requireValue(fixed.status === 'approved' || fixed.status === 'locked');
    return Object.freeze({ month: month(fixed.month), quantity: quantity(fixed.quantity), status: fixed.status,
      ledgerReference: text(fixed.ledgerReference) });
  }).sort((a, b) => a.month - b.month);
  requireValue(new Set(fixedMonths.map(row => row.month)).size === fixedMonths.length
    && fixedMonths.every(row => !eligibleMonths.includes(row.month)));
  const basis = object(row.basis, ['documentReference','documentSha256','periodReference','priorAllocationStatus',
    'ledgerSnapshotSha256','approvedById','approvedByName','approvedAt']);
  const priorAllocationStatus = fixedMonths.length ? 'snapshot_verified' : 'none_verified';
  requireValue(basis.priorAllocationStatus === priorAllocationStatus);
  const approvedAt = text(basis.approvedAt, 64); requireValue(Number.isFinite(Date.parse(approvedAt)) && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(approvedAt));
  return Object.freeze({ policyId: uuid(row.policyId), version: row.version, fingerprint: digest(row.fingerprint), status: 'approved',
    context: Object.freeze({ ...expected, beneficiaryOrganizationId: context.beneficiaryOrganizationId as string | null }),
    unitStep, eligibleMonths: Object.freeze(eligibleMonths), fixedMonths: Object.freeze(fixedMonths),
    basis: Object.freeze({ documentReference: text(basis.documentReference), documentSha256: digest(basis.documentSha256),
      periodReference: text(basis.periodReference), priorAllocationStatus,
      ledgerSnapshotSha256: digest(basis.ledgerSnapshotSha256), approvedById: uuid(basis.approvedById),
      approvedByName: text(basis.approvedByName, 4000), approvedAt }) });
}

export function proposeFromMonthlyPolicy(annual: string, context: MonthlyProposalContext, reference: unknown): MonthlyProposal {
  if (!checkManualQuantityText(annual).ok) return { status: 'enter_quantity' };
  if (reference === null) return { status: 'awaiting_policy' };
  let policy: MonthlyPolicyReference;
  try { policy = decodeMonthlyPolicyReference(reference, context); } catch { return { status: 'held', reason: 'invalid_policy' }; }
  const fixedTotal = sum(policy.fixedMonths.map(row => row.quantity));
  const a = exact(annual), fixed = exact(fixedTotal), scale = Math.max(a.scale, fixed.scale);
  const remaining = scaled(a, scale) - scaled(fixed, scale);
  if (remaining < 0n) return { status: 'held', reason: 'annual_below_fixed' };
  const remainingToPropose = formatted(remaining, scale);
  if (!checkManualQuantityText(remainingToPropose).ok) return { status: 'held', reason: 'arithmetic_limit' };
  const proposed = proposeEqualMonthlyQuantities(remainingToPropose, policy.unitStep, policy.eligibleMonths);
  if (proposed.status !== 'ready') return { status: 'held', reason: 'incompatible_step' };
  if (proposed.proposals.some(row => !checkManualQuantityText(row.quantity).ok)) return { status: 'held', reason: 'arithmetic_limit' };
  const rows: ProposalRow[] = [...policy.fixedMonths.map(row => ({ month: row.month, quantity: row.quantity, kind: 'fixed' as const })),
    ...proposed.proposals.map(row => ({ ...row, kind: 'suggested' as const }))].sort((a, b) => a.month - b.month);
  if (!sameQuantity(sum(rows.map(row => row.quantity)), annual)) return { status: 'held', reason: 'sum_mismatch' };
  return { status: 'ready', annualQuantity: annual, policyFingerprint: policy.fingerprint, fixedTotal, remainingToPropose, rows, effectiveAllocation: false };
}

export function reviewMonthlyDraft(annual: string, context: MonthlyProposalContext, reference: unknown,
  edits: readonly { month: number; quantity: string }[], reason: string) {
  const proposed = proposeFromMonthlyPolicy(annual, context, reference); if (proposed.status !== 'ready') return proposed;
  const policy = decodeMonthlyPolicyReference(reference, context);
  if (!Array.isArray(edits) || edits.length !== policy.eligibleMonths.length || new Set(edits.map(row => row.month)).size !== edits.length
    || edits.some(row => !policy.eligibleMonths.includes(row.month) || !checkManualQuantityText(row.quantity).ok || !multiple(row.quantity, policy.unitStep))) {
    return { status: 'held' as const, reason: 'invalid_edits' };
  }
  const total = sum([...policy.fixedMonths.map(row => row.quantity), ...edits.map(row => row.quantity)]);
  if (!sameQuantity(total, annual)) return { status: 'held' as const, reason: 'sum_mismatch' };
  const changed = edits.some(row => !sameQuantity(row.quantity, proposed.rows.find(previous => previous.month === row.month)!.quantity));
  if (changed && (!reason.trim() || reason.length > 2000 || CONTROL.test(reason))) return { status: 'held' as const, reason: 'reason_required' };
  return { status: 'ready' as const, annualQuantity: annual, policyFingerprint: policy.fingerprint, total, changed,
    requiresEmployeeJournal: true as const, effectiveAllocation: false as const,
    rows: [...proposed.rows.filter(row => row.kind === 'fixed'), ...edits.map(row => ({ ...row, kind: 'suggested' as const }))].sort((a, b) => a.month - b.month),
    reason: changed ? reason : null };
}
