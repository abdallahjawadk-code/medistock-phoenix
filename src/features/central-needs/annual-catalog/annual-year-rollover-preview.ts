/**
 * R20 — read-only preparation for yearly catalog carry-over.
 * This is NEVER a writer, legal approval, current-role check or stock action.
 * A later server transaction MUST re-read current roles, approvals, canonical
 * records, ledger state, provenance and expected versions under locks.
 */
import type { AnnualCatalogScope, AnnualIdentityField, AnnualFieldState } from './annual-catalog.contract';
import type { AnnualCatalogItemResult, AnnualCanonicalPreview } from './annual-catalog-server.contract';
import { ANNUAL_IDENTITY_FIELDS } from './annual-catalog.contract';
import { assertAnnualScope, assertSameAnnualScope, prepareAnnualSelection } from './annual-catalog.model';

export interface RolloverSourceClassification {
  readonly label: string;
  readonly origin: 'source' | 'proposed';
  readonly reference: string;
}
export interface RolloverSourceMaterial {
  readonly item: AnnualCatalogItemResult;
  /** Fresh, server-obtained read for the NEW year; never a client-made fingerprint. */
  readonly targetCanonical: AnnualCanonicalPreview;
  readonly classifications: readonly RolloverSourceClassification[];
}
export interface RolloverPreviousYear {
  readonly scope: AnnualCatalogScope;
  /** Source approval must be proven on the server; catalog 'active' is NOT an approval. */
  readonly approval: { readonly status: 'approved'; readonly reference: string }
    | { readonly status: 'unapproved' };
  /** False means pagination/authorization did not establish complete evidence. */
  readonly itemsComplete: boolean;
  readonly materials: readonly RolloverSourceMaterial[];
}
export interface RolloverPreviewInput {
  readonly targetScope: AnnualCatalogScope;
  readonly targetYearStatus: 'active' | 'archived' | 'missing';
  readonly priorYearsComplete: boolean;
  readonly previousYears: readonly RolloverPreviousYear[];
  readonly targetMembershipsComplete: boolean;
  /** Full scoped set supplied by a server read; protects against accidental duplicate proposals only. */
  readonly existingTargetCanonicalIds: readonly string[];
}
export type RolloverHoldCode =
  | 'source_not_selectable' | 'source_version_stale' | 'source_field_unresolved'
  | 'canonical_missing_or_inactive' | 'canonical_fingerprint_drift'
  | 'source_classification_unreviewed' | 'target_already_contains_material'
  | 'duplicate_source_canonical' | 'duplicate_source_annual_item' | 'source_identity_invalid';
export type RolloverBlockCode =
  | 'target_year_not_active' | 'year_index_incomplete' | 'source_year_unapproved'
  | 'source_items_incomplete' | 'target_memberships_incomplete' | 'duplicate_year_evidence';
export interface RolloverCarryIdentity {
  readonly sourceAnnualItemId: string;
  readonly sourceFieldVersionId: string;
  readonly canonicalItemId: string;
  readonly sourceCanonicalFingerprint: string;
  /** Text codes are NEVER parsed to numbers; leading zeroes must survive. */
  readonly identity: Readonly<Record<AnnualIdentityField, string | null>>;
  readonly classifications: readonly {readonly label: string; readonly reference: string}[];
  /** Human review of this immutable source reference is distinct from approval of the new year. */
  readonly sourceApprovalReference: string;
}
export interface RolloverHeldMaterial {
  readonly sourceAnnualItemId: string;
  readonly canonicalItemId: string | null;
  readonly reasons: readonly RolloverHoldCode[];
}
export type RolloverPreview =
  | {readonly status: 'HOLD'; readonly targetScope: AnnualCatalogScope; readonly reason: RolloverBlockCode;
      readonly carry: readonly []; readonly held: readonly []}
  | {readonly status: 'PREVIEW_ONLY'; readonly targetScope: AnnualCatalogScope;
      readonly sourceScope: AnnualCatalogScope;
      readonly carry: readonly RolloverCarryIdentity[]; readonly held: readonly RolloverHeldMaterial[]};

const uuid = (s: unknown): s is string => typeof s === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const sha = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const text = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && s.trim() === s
  && s.length <= 2000 && !/[\u0000-\u001F\u007F]/.test(s);
const unique = (xs: readonly string[]) => new Set(xs).size === xs.length;
const hardLimit = (n: number, max: number) => {
  if (!Number.isSafeInteger(n) || n > max) throw new Error('annual_rollover_input_limit');
};

function hold(scope: AnnualCatalogScope, reason: RolloverBlockCode): RolloverPreview {
  return {status: 'HOLD', targetScope: {...scope}, reason, carry: [], held: []};
}
function extractIdentity(fields: Readonly<Record<AnnualIdentityField, AnnualFieldState>>):
  Readonly<Record<AnnualIdentityField, string | null>> {
  const identity = {} as Record<AnnualIdentityField, string | null>;
  for (const field of ANNUAL_IDENTITY_FIELDS) {
    const x = fields[field];
    identity[field] = x?.state === 'known' ? x.value : null;
  }
  return identity;
}

/**
 * Deterministic preview from EXPLICITLY verified, exhausted source/canonical reads.
 * No SQL, no RPC, no default catalog fallback, no annual or monthly quantity.
 * Status PREVIEW_ONLY must never authorize a client write or a release gate.
 */
export function prepareAnnualYearRollover(input: RolloverPreviewInput): RolloverPreview {
  assertAnnualScope(input.targetScope);
  const target = {...input.targetScope};
  if (input.targetYearStatus !== 'active') return hold(target, 'target_year_not_active');
  if (input.priorYearsComplete !== true) return hold(target, 'year_index_incomplete');
  if (input.targetMembershipsComplete !== true) return hold(target, 'target_memberships_incomplete');
  hardLimit(input.previousYears.length, 101);
  hardLimit(input.existingTargetCanonicalIds.length, 10_000);
  if (!input.existingTargetCanonicalIds.every(uuid) || !unique(input.existingTargetCanonicalIds)) {
    throw new Error('annual_rollover_target_memberships_invalid');
  }

  const knownYears = new Set<number>();
  for (const prior of input.previousYears) {
    assertAnnualScope(prior.scope);
    if (prior.scope.ownerOrgId !== target.ownerOrgId || prior.scope.planningYear >= target.planningYear) {
      throw new Error('annual_rollover_source_scope_invalid');
    }
    if (knownYears.has(prior.scope.planningYear)) return hold(target, 'duplicate_year_evidence');
    knownYears.add(prior.scope.planningYear);
  }
  // Latest legally approved preceding year, not simply the latest 'active' catalog.
  const sources = input.previousYears.filter((x) => x.approval.status === 'approved')
    .sort((a,b) => b.scope.planningYear - a.scope.planningYear);
  const source = sources[0];
  if (!source || source.approval.status !== 'approved' || !text(source.approval.reference)) {
    return hold(target, 'source_year_unapproved');
  }
  if (source.itemsComplete !== true) return hold(target, 'source_items_incomplete');
  hardLimit(source.materials.length, 10_000);
  const existing = new Set(input.existingTargetCanonicalIds);
  const canonicalCount = new Map<string,number>();
  const annualCount = new Map<string,number>();
  for (const entry of source.materials) {
    const id=entry.item?.membership?.canonicalItemId;
    const annualId=entry.item?.membership?.annualItemId;
    if (uuid(annualId)) annualCount.set(annualId,(annualCount.get(annualId)??0)+1);
    if (id !== null && uuid(id)) canonicalCount.set(id,(canonicalCount.get(id)??0)+1);
  }
  const carry: RolloverCarryIdentity[]=[];
  const held: RolloverHeldMaterial[]=[];
  for (const material of source.materials) {
    const item=material.item;
    if (!item || !item.scope || !item.membership || !item.fieldVersion) {
      throw new Error('annual_rollover_source_item_invalid');
    }
    assertSameAnnualScope(source.scope,item.scope);
    assertSameAnnualScope(source.scope,item.membership.scope);
    assertSameAnnualScope(source.scope,item.fieldVersion.scope);
    const id=item.membership.canonicalItemId;
    const reasons:RolloverHoldCode[]=[];
    if (!uuid(item.membership.annualItemId) || !uuid(item.fieldVersion.fieldVersionId) ||
        !uuid(item.membership.currentFieldVersionId) || (id !== null && !uuid(id))) {
      reasons.push('source_identity_invalid');
    }
    if (item.membership.currentFieldVersionId !== item.fieldVersion.fieldVersionId ||
        item.membership.annualItemId !== item.fieldVersion.annualItemId) {
      reasons.push('source_version_stale');
    }
    if (item.membership.status !== 'active' || !item.selectable || item.selectionBlockers.length > 0 || !id) {
      reasons.push('source_not_selectable');
    }
    if (id && canonicalCount.get(id)! > 1) reasons.push('duplicate_source_canonical');
    if (annualCount.get(item.membership.annualItemId)! > 1) reasons.push('duplicate_source_annual_item');
    if (id && existing.has(id)) reasons.push('target_already_contains_material');
    const preview=material.targetCanonical;
    if (!preview || !preview.scope || !preview.canonicalSnapshot) {
      reasons.push('canonical_missing_or_inactive');
    } else {
      assertSameAnnualScope(target,preview.scope);
      if (!id || preview.canonicalItemId !== id || preview.canonicalSnapshot.canonicalItemId !== id ||
          preview.canonicalSnapshot.status !== 'active' || !preview.eligible || preview.missingRequired.length > 0) {
        reasons.push('canonical_missing_or_inactive');
      }
      if (!sha(item.canonicalFingerprint) || !sha(preview.canonicalFingerprint) ||
          item.canonicalFingerprint !== preview.canonicalFingerprint || item.canonicalDrift) {
        reasons.push('canonical_fingerprint_drift');
      }
    }
    if (reasons.length === 0) {
      try { prepareAnnualSelection(source.scope,item.membership,item.fieldVersion); }
      catch { reasons.push('source_field_unresolved'); }
    }
    const classes=material.classifications;
    if (!Array.isArray(classes) || classes.length === 0 ||
        classes.some(c=>!c || c.origin!=='source' || !text(c.label) || !text(c.reference))) {
      reasons.push('source_classification_unreviewed');
    }
    if (reasons.length) {
      held.push({sourceAnnualItemId:item.membership.annualItemId,canonicalItemId:id,reasons:[...new Set(reasons)]});
    } else if (id) {
      carry.push({sourceAnnualItemId:item.membership.annualItemId,
        sourceFieldVersionId:item.fieldVersion.fieldVersionId,
        canonicalItemId:id,sourceCanonicalFingerprint:item.canonicalFingerprint,
        identity:extractIdentity(item.fieldVersion.fields),
        classifications:classes.map(c=>({label:c.label,reference:c.reference})),
        sourceApprovalReference:source.approval.reference});
    }
  }
  // Stable order across pagination/retries; duplicate annual ids remain held by downstream server checks.
  carry.sort((a,b)=>a.canonicalItemId.localeCompare(b.canonicalItemId,'en'));
  held.sort((a,b)=>a.sourceAnnualItemId.localeCompare(b.sourceAnnualItemId,'en'));
  return {status:'PREVIEW_ONLY',targetScope:target,sourceScope:{...source.scope},carry,held};
}
