import { supabase } from '@/shared/supabase/client';
import { centralNeedsErrorFromPostgrest } from '../central-needs.service';
import { isMissingNeedsContract } from '../manual/dossier.service';
import { decodeMonthlyPolicyReference, type MonthlyPolicyReference, type MonthlyProposalContext } from './monthly-proposal-reference';

const RPC = 'phoenix_monthly_policy_reference';
export async function getMonthlyPolicyReference(context: MonthlyProposalContext): Promise<MonthlyPolicyReference | null> {
  const { data, error } = await supabase.rpc(RPC, { p_organization_id: context.ownerOrgId, p_planning_year: context.planningYear,
    p_annual_item_id: context.annualItemId, p_field_version_id: context.fieldVersionId,
    p_canonical_id: context.canonicalItemId, p_beneficiary_id: context.beneficiaryOrganizationId });
  if (isMissingNeedsContract(error, RPC)) return null;
  if (error) throw centralNeedsErrorFromPostgrest(error);
  if (!data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 65536
    || !data.context || typeof data.context !== 'object' || Array.isArray(data.context)
    || Object.keys(data.context).length !== Object.keys(context).length
    || Object.entries(context).some(([key, value]) => data.context[key] !== value)) throw new Error('monthly_reference_invalid');
  if (data.status === 'awaiting_policy' && Object.keys(data).length === 3 && ['missing', 'ambiguous'].includes(data.reason)) return null;
  if (data.status !== 'ready' || Object.keys(data).length !== 5 || data.effectiveAllocation !== false || data.draftJournalImplemented !== false) {
    throw new Error('monthly_reference_invalid');
  }
  return decodeMonthlyPolicyReference(data.reference, context);
}
