/**
 * R1-A4 — the data boundary of the journey: only reads governed by RLS and canonical RPCs. No direct write to any table.
 */
import { supabase } from '@/shared/supabase/client';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import { resolveMaterials } from '@/shared/materials/material-resolver.service';
import {
  approveRevision, rejectRevision, submitRevision, fetchReviewReadiness, centralNeedsErrorFromPostgrest,
  type ReviewReadiness,
} from '../central-needs.service';
import {
  getManualCapabilities, openManualCorrectionRevision, openManualPlanRevision, type ManualCapabilities,
} from './manual-needs.service';
import type { ResolverHit } from '../excel-identity';
import { getNeedsFeatures, listNeedsDossiers, openNeedsDossier, openNeedsDossierCorrection, readAnnualNeeds } from './dossier.service';
import { getManualCatalogLabels } from './manual-catalog.service';
import { getAnnualNeedsContract } from '../annual-catalog/annual-needs.service';
import { listAnnualBeneficiaries } from './annual-beneficiaries.service';

export interface YearRevision {
  id: string;
  revisionNumber: number;
  status: string;
  sourceMode: 'manual' | 'excel';
  createdBy: string | null;
}
export interface BeneficiaryOption { id: string; name: string; nameAr: string }
export interface CatalogOption { id: string; name: string; nameAr: string | null; concentration: string | null; dosageForm: string | null; unit: string; nationalCode?: string | null }

export interface JourneyApi {
  annualNeedsContract?: typeof getAnnualNeedsContract;
  readCatalogItems?: typeof getManualCatalogLabels;
  features?: typeof getNeedsFeatures;
  listDossiers?: typeof listNeedsDossiers;
  openDossier?: typeof openNeedsDossier;
  openDossierCorrection?: typeof openNeedsDossierCorrection;
  annualSummary?: typeof readAnnualNeeds;
  listDossierRevisions?: (planId: string) => Promise<YearRevision[]>;
  listYearRevisions(organizationId: string, year: number): Promise<YearRevision[]>;
  listBeneficiaries(): Promise<BeneficiaryOption[]>;
  listAnnualBeneficiaries?: typeof listAnnualBeneficiaries;
  searchCatalog(query: string): Promise<CatalogOption[]>;
  resolveForIdentity(query: string): Promise<ResolverHit[]>;
  getCaps(organizationId: string, planRevisionId: string | null): Promise<ManualCapabilities>;
  openPlan(organizationId: string, year: number): Promise<{ planRevisionId: string }>;
  openCorrection(organizationId: string, year: number, expectedLatestRevisionId: string, reason: string): Promise<{ planRevisionId: string }>;
  readiness(planRevisionId: string): Promise<ReviewReadiness>;
  submit(planRevisionId: string): Promise<void>;
  approve(planRevisionId: string): Promise<void>;
  reject(planRevisionId: string, reason: string): Promise<void>;
}

async function listYearRevisions(organizationId: string, year: number): Promise<YearRevision[]> {
  const plan = await supabase.from('central_needs_plans').select('id').eq('organization_id', organizationId).eq('plan_year', year).maybeSingle();
  if (plan.error) throw centralNeedsErrorFromPostgrest(plan.error);
  if (!plan.data) return [];
  return listPlanRevisions((plan.data as { id: string }).id);
}

async function listPlanRevisions(planId: string): Promise<YearRevision[]> {
  const revs = await supabase.from('central_needs_plan_revisions')
    .select('id, revision_number, status, source_mode, created_by').eq('plan_id', planId).order('revision_number', { ascending: false });
  if (revs.error) throw centralNeedsErrorFromPostgrest(revs.error);
  return ((revs.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string, revisionNumber: r.revision_number as number, status: r.status as string,
    sourceMode: (r.source_mode as 'manual' | 'excel') ?? 'excel', createdBy: (r.created_by as string | null) ?? null,
  }));
}

async function listDossierRevisions(planId: string): Promise<YearRevision[]> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_dossier_revisions', { p_plan_id: planId });
  if (error) throw centralNeedsErrorFromPostgrest(error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({ id:r.id as string, revisionNumber:r.revision_number as number,
    status:r.status as string, sourceMode:r.source_mode as 'manual'|'excel', createdBy:r.created_by as string|null }));
}

export const realJourneyApi: JourneyApi = {
  annualNeedsContract: getAnnualNeedsContract,
  listAnnualBeneficiaries,
  readCatalogItems: getManualCatalogLabels,
  features: getNeedsFeatures,
  listDossiers: listNeedsDossiers,
  openDossier: openNeedsDossier,
  openDossierCorrection: openNeedsDossierCorrection,
  annualSummary: readAnnualNeeds,
  listDossierRevisions,
  listYearRevisions,
  async listBeneficiaries() {
    const rows = await getOrganizations();
    return rows.filter((o) => o.organizationKind === 'care_institution' && o.status === 'active').map((o) => ({ id: o.id, name: o.name, nameAr: o.name_ar }));
  },
  async searchCatalog(query) {
    const hits = await resolveMaterials(query, { audience: 'internal', limit: 20 });
    const seen = new Set<string>();
    const out: CatalogOption[] = [];
    for (const h of hits) {
      if (h.source !== 'catalog' || !h.centralItemId || seen.has(h.centralItemId) || !h.unit) continue;
      seen.add(h.centralItemId);
      out.push({ id: h.centralItemId, name: h.scientificName, nameAr: h.nameAr ?? null, concentration: h.concentration, dosageForm: h.dosageForm, unit: h.unit, nationalCode: h.nationalCode });
    }
    return out;
  },
  async resolveForIdentity(query) {
    // the EXISTING shared resolver (PRE3-A) - no second resolver. Only identity fields are mapped; stock fields are dropped here.
    const hits = await resolveMaterials(query, { audience: 'internal', limit: 10 });
    return hits.map((h) => ({
      source: h.source, centralItemId: h.centralItemId, scientificName: h.scientificName, nameAr: h.nameAr ?? null, tradeName: h.tradeName,
      concentration: h.concentration, dosageForm: h.dosageForm, unit: h.unit, nationalCode: h.nationalCode, grade: h.grade,
    }));
  },
  getCaps: getManualCapabilities,
  async openPlan(organizationId, year) {
    const r = await openManualPlanRevision(organizationId, year);
    return { planRevisionId: r.planRevisionId };
  },
  async openCorrection(organizationId, year, expectedLatestRevisionId, reason) {
    const r = await openManualCorrectionRevision(organizationId, year, expectedLatestRevisionId, reason);
    return { planRevisionId: r.planRevisionId };
  },
  readiness: fetchReviewReadiness,
  submit: submitRevision,
  approve: approveRevision,
  reject: rejectRevision,
};
