/** UI refusal hints matching accepted C4 comparisons. The server still owns
 * legal matching, current authority, re-extraction and the atomic commit. */
import { SOURCE_IDENTITY_FIELDS, type AnnualSourceOccurrence } from './annual-catalog.contract';
import type { AnnualCanonicalSnapshot } from './annual-catalog-server.contract';
import type { VerifiedSourcePage } from './verified-source.contract';
export function canReviewSourceRow(row: AnnualSourceOccurrence, classifications: NonNullable<VerifiedSourcePage['classifications']>): boolean {
  if (SOURCE_IDENTITY_FIELDS.some(field => row.fields[field].state === 'invalid')
    || (['scientificName','nationalCode','unit'] as const).some(field => row.fields[field].state !== 'value')) return false;
  if (!row.classification) return true;
  return row.classification.origin === 'source' && classifications.filter(anchor => anchor.blockId === row.source.blockId
    && anchor.sheetIndex === row.source.sheetIndex && anchor.cell.presence === 'value' && anchor.cell.valueType === 'string'
    && !anchor.cell.isFormula && anchor.cell.rawValue === row.classification?.label).length === 1;
}
export function sourceRowsMatchCanonical(rows: readonly AnnualSourceOccurrence[], canonical: AnnualCanonicalSnapshot): boolean {
  if (!rows.length || canonical.status !== 'active') return false;
  return rows.every(row => SOURCE_IDENTITY_FIELDS.every(field => {
    const observation = row.fields[field];
    const mapped = field === 'currentNationalCode' ? 'nationalCode' : field;
    const expected = mapped === 'previousNationalCode' ? null : canonical[mapped];
    const required = ['scientificName','nationalCode','unit'].includes(field)
      || (['dosageForm','concentration'].includes(field) && typeof expected === 'string' && expected.trim().length > 0);
    if (observation.state !== 'value') return !required && observation.state === 'missing';
    // A1's accepted annual_catalog_trim_v1 is exactly ECMAScript trim.
    return field === 'previousNationalCode' || (typeof expected === 'string' && observation.text.trim() === expected.trim());
  }));
}
