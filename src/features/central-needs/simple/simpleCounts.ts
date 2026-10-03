/**
 * Annual Needs — Simple Mode context counts.
 *
 * Pure, presentation-only aggregation over props the parent screen has
 * ALREADY loaded via the existing service reads (`listBeneficiaryColumns`,
 * `listDispositions`, `listSourceRecords`). No new server call, no new
 * business rule: `reviewRequired`, `decision` and the beneficiary/material
 * mapping are the server's own answers, only counted here.
 *
 * CN-UI-S1 — there is deliberately NO quantity figure. The old one re-derived
 * "which cells count" from the M213 column grain alone, a second copy of a
 * resolver the need-line panel now owns (CN-UI-R1: regions first, then M213).
 * That copy could disagree with the panel the person is working in, so it was
 * removed rather than extended; the panel shows its own counts. What remains
 * keeps its scope: institutions come from the revision-wide column list,
 * materials only from the ACTIVE import session's rows.
 */
import type { BeneficiaryColumnSummary, RecordDisposition, SourceRecord } from '../central-needs.service';

export interface SimpleCounts {
  institutionsConfirmed: number;
  institutionsUnresolved: number;
  materialsMapped: number;
  materialsUndispositioned: number;
  /** institutionsUnresolved + materialsUndispositioned — "N items need review". */
  reviewItemCount: number;
}

export function computeSimpleCounts(
  beneficiaryColumns: readonly BeneficiaryColumnSummary[],
  records: readonly SourceRecord[],
  dispositions: readonly RecordDisposition[],
): SimpleCounts {
  const institutionsConfirmed = new Set(
    beneficiaryColumns.filter((c) => c.decision === 'beneficiary' && c.beneficiaryOrganizationId)
      .map((c) => c.beneficiaryOrganizationId as string),
  ).size;
  const institutionsUnresolved = beneficiaryColumns.filter((c) => c.decision === null && c.reviewRequired).length;

  const mappedItemByEntity = new Map<string, string>();
  for (const d of dispositions) {
    if (d.decision === 'mapped' && d.centralItemId) mappedItemByEntity.set(d.targetEntity, d.centralItemId);
  }
  const dispositionedEntities = new Set(dispositions.map((d) => d.targetEntity));
  const allEntities = new Set(records.map((r) => r.targetEntity));
  const materialsMapped = new Set(mappedItemByEntity.values()).size;
  let materialsUndispositioned = 0;
  for (const entity of allEntities) if (!dispositionedEntities.has(entity)) materialsUndispositioned += 1;

  return {
    institutionsConfirmed,
    institutionsUnresolved,
    materialsMapped,
    materialsUndispositioned,
    reviewItemCount: institutionsUnresolved + materialsUndispositioned,
  };
}
