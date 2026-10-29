/** Additive contract discovery; no permission or transport failure becomes legacy mode. */
import { supabase } from '@/shared/supabase/client';
import { centralNeedsErrorFromPostgrest } from '../central-needs.service';

export interface NeedsFeatures { nationalCode: boolean; sameActorManual: boolean; dossiers: boolean; workbookIntake: boolean }
export interface NeedsDossier {
  id: string; key: string; name: string; latestRevisionId: string | null;
  latestStatus: string | null; latestNumber: number | null;
  approvedRevisionId: string | null; approvedNumber: number | null;
}
export interface AnnualNeedRow {
  dossierId: string; dossierName: string; revisionId: string; beneficiaryId: string;
  itemId: string; name: string; nameAr: string | null; nationalCode: string | null;
  quantityText: string; unit: string; warehouseId: string | null;
}

export function isMissingNeedsContract(error: { code?: string; message?: string } | null, name: string): boolean {
  return error?.code === 'PGRST202' && (error.message ?? '').includes(name);
}

export async function getNeedsFeatures(): Promise<NeedsFeatures> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_feature_contract');
  if (isMissingNeedsContract(error, 'phoenix_central_needs_feature_contract')) {
    return { nationalCode: false, sameActorManual: false, dossiers: false, workbookIntake: false };
  }
  if (error) throw centralNeedsErrorFromPostgrest(error);
  if (!data || typeof data !== 'object' || typeof data.national_code !== 'boolean' || typeof data.dossiers !== 'boolean') {
    throw new Error('invalid_needs_feature_contract');
  }
  return { nationalCode: data.national_code === true, sameActorManual: data.same_actor_manual === true,
    dossiers: data.dossiers === true, workbookIntake: data.workbook_intake === true && data.workbook_matrix_v2 === true };
}

export async function listNeedsDossiers(organizationId: string, year: number): Promise<NeedsDossier[]> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_list_dossiers', { p_organization_id: organizationId, p_plan_year: year });
  if (error) throw centralNeedsErrorFromPostgrest(error);
  return (data ?? []).map((r: Record<string, unknown>) => ({ id: r.id as string, key: r.key as string, name: r.name as string,
    latestRevisionId: r.latest_revision_id as string | null, latestStatus: r.latest_status as string | null,
    latestNumber: r.latest_number as number | null, approvedRevisionId: r.approved_revision_id as string | null,
    approvedNumber: r.approved_number as number | null }));
}

export async function openNeedsDossier(organizationId: string, year: number, key: string, name: string) {
  const { data, error } = await supabase.rpc('phoenix_central_needs_open_dossier', {
    p_organization_id: organizationId, p_plan_year: year, p_dossier_key: key, p_dossier_name: name,
  });
  if (error) throw centralNeedsErrorFromPostgrest(error);
  return { planId: data.plan_id as string, planRevisionId: data.plan_revision_id as string };
}

export async function openNeedsDossierCorrection(organizationId: string, year: number, latestRevisionId: string, reason: string) {
  const {data,error}=await supabase.rpc('phoenix_central_needs_open_dossier_correction',{
    p_organization_id:organizationId,p_plan_year:year,p_expected_latest_revision_id:latestRevisionId,p_reason:reason,
  });
  if(error) throw centralNeedsErrorFromPostgrest(error);
  return {planRevisionId:data.plan_revision_id as string};
}

export async function readAnnualNeeds(organizationId: string, year: number): Promise<AnnualNeedRow[]> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_annual_summary', { p_organization_id: organizationId, p_plan_year: year });
  if (error) throw centralNeedsErrorFromPostgrest(error);
  return (data ?? []).map((r: Record<string, unknown>) => ({ dossierId: r.dossier_id as string, dossierName: r.dossier_name as string,
    revisionId: r.revision_id as string, beneficiaryId: r.beneficiary_id as string, itemId: r.item_id as string,
    name: r.name as string, nameAr: r.name_ar as string | null, nationalCode: r.national_code as string | null,
    quantityText: r.quantity_text as string, unit: r.unit as string, warehouseId: r.warehouse_id as string | null }));
}
