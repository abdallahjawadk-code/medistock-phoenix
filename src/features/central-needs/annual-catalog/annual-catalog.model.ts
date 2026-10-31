import {
  ANNUAL_IDENTITY_FIELDS, SOURCE_IDENTITY_FIELDS,
  type AnnualCatalogScope, type AnnualCatalogMembership, type AnnualFieldVersion,
  type AnnualCatalogSelection, type AnnualSourceOccurrence, type AnnualFieldIssue,
  type AnnualIdentityField, type AnnualFieldState, type AnnualFieldOrigin,
  type AnnualEvidenceReview, type SourceIdentityField,
} from './annual-catalog.contract';

const nonempty = (value: string): boolean => typeof value === 'string' && value.trim().length > 0;

export function assertAnnualScope(scope: AnnualCatalogScope): void {
  if (!scope || !nonempty(scope.ownerOrgId) || scope.ownerOrgId !== scope.ownerOrgId.trim()
      || scope.ownerOrgId.length > 128 || !Number.isInteger(scope.planningYear)
      || scope.planningYear < 2000 || scope.planningYear > 2100) {
    throw new Error('annual_catalog_invalid_scope');
  }
}

export function annualScopeKey(scope: AnnualCatalogScope): string {
  assertAnnualScope(scope);
  return JSON.stringify([scope.ownerOrgId, scope.planningYear]);
}

export function assertSameAnnualScope(expected: AnnualCatalogScope, actual: AnnualCatalogScope): void {
  if (annualScopeKey(expected) !== annualScopeKey(actual)) throw new Error('annual_catalog_scope_mismatch');
}

/** Validates a supplied annual set; it does not search other years or create missing memberships. */
export function assertAnnualMembershipSet(scope: AnnualCatalogScope, memberships: readonly AnnualCatalogMembership[]): void {
  assertAnnualScope(scope);
  if (memberships.length > 10_000) throw new Error('annual_catalog_membership_limit');
  const annualIds = new Set<string>();
  const canonicalIds = new Set<string>();
  for (const membership of memberships) {
    assertSameAnnualScope(scope, membership.scope);
    if (!nonempty(membership.annualItemId) || annualIds.has(membership.annualItemId)) {
      throw new Error('annual_catalog_duplicate_annual_item');
    }
    annualIds.add(membership.annualItemId);
    if (membership.canonicalItemId !== null) {
      if (!nonempty(membership.canonicalItemId) || canonicalIds.has(membership.canonicalItemId)) {
        throw new Error('annual_catalog_duplicate_canonical_membership');
      }
      canonicalIds.add(membership.canonicalItemId);
    }
  }
}

/** No name/code matching: the caller supplies the group to review; identity remains unresolved. */
export function reviewAnnualSourceOccurrences(
  scope: AnnualCatalogScope, occurrences: readonly AnnualSourceOccurrence[],
): AnnualEvidenceReview {
  assertAnnualScope(scope);
  if (occurrences.length === 0 || occurrences.length > 10_000) throw new Error('annual_catalog_occurrence_limit');
  const seen = new Set<string>();
  for (const occurrence of occurrences) {
    assertSameAnnualScope(scope, occurrence.scope);
    if (!nonempty(occurrence.occurrenceKey) || seen.has(occurrence.occurrenceKey)) {
      throw new Error('annual_catalog_duplicate_occurrence');
    }
    seen.add(occurrence.occurrenceKey);
  }

  const fields = {} as Record<AnnualIdentityField, AnnualFieldState>;
  for (const field of ANNUAL_IDENTITY_FIELDS) {
    // Neither a previous national code nor a barcode may fill the current national-code field.
    const sourceFields: SourceIdentityField[] = field === 'nationalCode' ? ['nationalCode', 'currentNationalCode'] : [field];
    const byValue = new Map<string, { value: string; origins: AnnualFieldOrigin[] }>();
    for (const occurrence of occurrences) {
      for (const sourceField of sourceFields) {
        const observation = occurrence.fields[sourceField];
        if (observation.state !== 'value') continue;
        // Exact comparison on purpose: tab/tablet, case and whitespace differences require review.
        let alternative = byValue.get(observation.text);
        if (!alternative) {
          alternative = { value: observation.text, origins: [] };
          byValue.set(observation.text, alternative);
        }
        alternative.origins.push({ kind: 'source', occurrenceKey: occurrence.occurrenceKey, field: sourceField });
      }
    }
    const alternatives = [...byValue.values()];
    fields[field] = alternatives.length === 0 ? { state: 'missing', reason: 'no_usable_source_value' }
      : alternatives.length === 1 ? { state: 'known', ...alternatives[0] }
      : { state: 'conflict', alternatives };
  }
  return {
    scope: { ...scope }, occurrenceKeys: [...seen], fields, canonicalIdentity: 'unresolved',
    sourceIssues: occurrences.flatMap((occurrence) => SOURCE_IDENTITY_FIELDS.flatMap((field) => {
      const observation = occurrence.fields[field];
      return observation.state === 'invalid' || (observation.state === 'missing' && observation.reason !== 'unmapped')
        ? [{ occurrenceKey: occurrence.occurrenceKey, field, reason: observation.reason }]
        : [];
    })),
  };
}

/** r5 §6.4: name, national code and unit are required; material-type policy can require more fields. */
export function assessAnnualFields(
  fields: Readonly<Record<AnnualIdentityField, AnnualFieldState>>,
  additionallyRequired: readonly AnnualIdentityField[] = [],
): AnnualFieldIssue[] {
  const required = new Set<AnnualIdentityField>(['scientificName', 'nationalCode', 'unit', ...additionallyRequired]);
  const issues: AnnualFieldIssue[] = [];
  for (const field of ANNUAL_IDENTITY_FIELDS) {
    const value = fields[field];
    if (!value || !['known', 'missing', 'not_applicable', 'conflict'].includes(value.state)) {
      issues.push({ field, code: 'invalid_field_state' });
    } else if (value.state === 'conflict') {
      issues.push({ field, code: 'conflicting_values' });
    } else if (value.state === 'missing' && required.has(field)) {
      issues.push({ field, code: 'missing_required' });
    } else if (value.state === 'not_applicable') {
      if (!nonempty(value.reason) || !nonempty(value.decisionReference)) issues.push({ field, code: 'invalid_field_state' });
      else if (required.has(field)) issues.push({ field, code: 'required_not_applicable' });
    } else if (value.state === 'known' && (!nonempty(value.value) || value.origins.length === 0
        || value.origins.some((origin) => origin.kind === 'source' ? !nonempty(origin.occurrenceKey)
          : !nonempty(origin.decisionReference) || (origin.kind === 'canonical' && !nonempty(origin.canonicalItemId))))) {
      issues.push({ field, code: 'invalid_field_state' });
    }
  }
  return issues;
}

/** Checks an explicit candidate selection, not a server authorization or a persisted draft. */
export function prepareAnnualSelection(
  scope: AnnualCatalogScope, membership: AnnualCatalogMembership, version: AnnualFieldVersion,
  additionallyRequired: readonly AnnualIdentityField[] = [],
): AnnualCatalogSelection {
  assertSameAnnualScope(scope, membership.scope);
  assertSameAnnualScope(scope, version.scope);
  if (!nonempty(membership.annualItemId) || membership.annualItemId !== version.annualItemId
      || membership.currentFieldVersionId !== version.fieldVersionId || !nonempty(version.fieldVersionId)
      || !Number.isInteger(version.versionNumber) || version.versionNumber < 1) {
    throw new Error('annual_catalog_version_mismatch');
  }
  if (membership.status !== 'active' || !membership.canonicalItemId || !nonempty(membership.canonicalItemId)) {
    throw new Error('annual_catalog_not_selectable');
  }
  if (assessAnnualFields(version.fields, additionallyRequired).length > 0) throw new Error('annual_catalog_fields_unresolved');
  for (const field of ANNUAL_IDENTITY_FIELDS) {
    const value = version.fields[field];
    if (value.state === 'known' && value.origins.some((origin) =>
      origin.kind === 'canonical' ? origin.canonicalItemId !== membership.canonicalItemId
        : origin.kind === 'source' && (!membership.occurrenceKeys.includes(origin.occurrenceKey)
          || (field === 'nationalCode' ? !['nationalCode', 'currentNationalCode'].includes(origin.field) : origin.field !== field)))) {
      throw new Error('annual_catalog_origin_mismatch');
    }
  }
  return { scope: { ...scope }, annualItemId: membership.annualItemId,
    fieldVersionId: version.fieldVersionId, canonicalItemId: membership.canonicalItemId };
}
