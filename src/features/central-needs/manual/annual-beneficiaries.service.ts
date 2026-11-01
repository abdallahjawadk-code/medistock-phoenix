import { supabase } from '@/shared/supabase/client';
import { CentralNeedsError, centralNeedsErrorFromPostgrest } from '../central-needs.service';
import { catalogUuid } from '../annual-catalog/annual-catalog-server.contract';

const invalid = (): never => { throw new CentralNeedsError('manual_beneficiaries_invalid_response'); };
const record = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) return invalid();
  return value as Record<string, unknown>;
};
/** Current caller authority, bounded keyset pages, no general-directory fallback or cache. */
export async function listAnnualBeneficiaries(ownerId: string): Promise<Array<{ id: string; name: string; nameAr: string }>> {
  const owner = catalogUuid(ownerId, 'ownerOrgId');
  const result: Array<{ id: string; name: string; nameAr: string }> = [];
  let after: string | null = null;
  for (let page = 0; page < 200; page += 1) {
    const { data, error } = await supabase.rpc('phoenix_manual_beneficiaries_v1', { p_organization_id: owner, p_after_id: after, p_limit: 50 });
    if (error) throw centralNeedsErrorFromPostgrest(error);
    const envelope = record(data, ['version','ownerOrgId','rows','nextAfterId']);
    if (envelope.version !== 1 || envelope.ownerOrgId !== owner || !Array.isArray(envelope.rows) || envelope.rows.length > 50) return invalid();
    let previous: string | null = after;
    for (const value of envelope.rows) {
      const row = record(value, ['id','name','nameAr']), id = catalogUuid(row.id, 'beneficiaryId');
      if (previous !== null && id <= previous || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 4000
        || typeof row.nameAr !== 'string' || !row.nameAr.trim() || row.nameAr.length > 4000) return invalid();
      result.push({ id, name: row.name, nameAr: row.nameAr }); previous = id;
    }
    if (envelope.nextAfterId === null) return result;
    const next = catalogUuid(envelope.nextAfterId, 'nextAfterId');
    if (envelope.rows.length !== 50 || next !== previous || next === after) return invalid();
    after = next;
  }
  // Never present a truncated directory as the complete beneficiary set.
  return invalid();
}
