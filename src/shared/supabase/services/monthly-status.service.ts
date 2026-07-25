/* ─── MONTHLY-STATUS-REDESIGN-092 — service layer ──────────────────────────
   Thin wrappers over the migration-092 RPCs. Every write goes through a
   SECURITY DEFINER RPC — this module never writes to
   inventory_status_reports/_lines/_amendments or stocktakes/
   stocktake_count_lines directly. The RPCs are the real authorization
   boundary; this file only shapes requests/responses for the UI.
   ──────────────────────────────────────────────────────────────────────── */
import { supabase, supabaseConfigured } from '../client';

export type StatusReportStatus = 'draft' | 'submitted' | 'returned' | 'locked';
/**
 * STATUS-CLASSIFICATION-BOUNDARY-CORRECTION-112: 'unavailable' is a
 * distinct, always-computed classification for available=0 (on_hand -
 * reserved), separate from and never conflated with 'suspected_missing'
 * (which only ever originates from the stocktake-variance evidence flow —
 * see phoenix_status_confirm_missing).
 */
export type MaterialClassification = 'available' | 'unavailable' | 'scarce' | 'surplus' | 'suspected_missing';

export interface MonthlyStatusReport {
  id: string;
  organization_id: string;
  status: StatusReportStatus;
  version: number;
  amendment_of: string | null;
  prepared_by: string | null;
  prepared_at: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  locked_at: string | null;
  returned_by: string | null;
  returned_at: string | null;
  return_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface MonthlyStatusLine {
  id: string;
  report_id: string;
  scientific_name: string;
  national_code: string | null;
  on_hand_qty: number;
  reserved_qty: number;
  in_transit_qty: number;
  quarantine_qty: number;
  central_qty: number;
  supplementary_qty: number;
  nearest_expiry_date: string | null;
  suggested_classification: 'available' | 'unavailable' | 'scarce' | 'surplus';
  classification: MaterialClassification | null;
  classification_reason: string | null;
  classification_overridden: boolean;
  stocktake_count_line_id: string | null;
  confirmed_missing: boolean;
  confirmed_by: string | null;
  confirmed_at: string | null;
}

function requireConfigured(): void {
  if (!supabaseConfigured) throw new Error('Supabase not configured');
}

export async function getOpenMonthlyStatusReport(organizationId: string): Promise<MonthlyStatusReport | null> {
  if (!supabaseConfigured) return null;
  const { data, error } = await supabase
    .from('inventory_status_reports')
    .select('*')
    .eq('organization_id', organizationId)
    .neq('status', 'locked')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as MonthlyStatusReport | null;
}

export async function getLatestLockedMonthlyStatusReport(organizationId: string): Promise<MonthlyStatusReport | null> {
  if (!supabaseConfigured) return null;
  const { data, error } = await supabase
    .from('inventory_status_reports')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('status', 'locked')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as MonthlyStatusReport | null;
}

export async function getMonthlyStatusLines(reportId: string): Promise<MonthlyStatusLine[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('inventory_status_report_lines')
    .select('*')
    .eq('report_id', reportId)
    .order('scientific_name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as MonthlyStatusLine[];
}

export async function prepareMonthlyStatusReport(organizationId: string): Promise<{ ok: boolean; report_id: string }> {
  requireConfigured();
  const { data, error } = await supabase.rpc('phoenix_status_prepare_report', { p_organization_id: organizationId });
  if (error) throw error;
  return data;
}

export interface ClassifyLineInput {
  line_id: string;
  classification: MaterialClassification;
  reason?: string | null;
  stocktake_count_line_id?: string | null;
}

export async function classifyMonthlyStatusLines(
  reportId: string,
  lines: ClassifyLineInput[],
): Promise<{ ok: boolean; classified: number }> {
  requireConfigured();
  const { data, error } = await supabase.rpc('phoenix_status_classify_lines', {
    p_report_id: reportId,
    p_lines: lines,
  });
  if (error) throw error;
  return data;
}

export async function confirmSuspectedMissing(lineId: string): Promise<{ ok: boolean; confirmed: boolean; reason?: string }> {
  requireConfigured();
  const { data, error } = await supabase.rpc('phoenix_status_confirm_missing', { p_line_id: lineId });
  if (error) throw error;
  return data;
}

export async function submitMonthlyStatusReport(reportId: string): Promise<{ ok: boolean }> {
  requireConfigured();
  const { data, error } = await supabase.rpc('phoenix_status_submit_report', { p_report_id: reportId });
  if (error) throw error;
  return data;
}

export async function returnMonthlyStatusReportForClarification(reportId: string, reason: string): Promise<{ ok: boolean }> {
  requireConfigured();
  const { data, error } = await supabase.rpc('phoenix_status_return_for_clarification', {
    p_report_id: reportId, p_reason: reason,
  });
  if (error) throw error;
  return data;
}

export async function approveLockMonthlyStatusReport(reportId: string): Promise<{ ok: boolean }> {
  requireConfigured();
  const { data, error } = await supabase.rpc('phoenix_status_approve_lock_report', { p_report_id: reportId });
  if (error) throw error;
  return data;
}

export async function createMonthlyStatusAmendment(reportId: string, reason: string): Promise<{ ok: boolean; amendment_report_id: string }> {
  requireConfigured();
  const { data, error } = await supabase.rpc('phoenix_status_create_amendment', {
    p_report_id: reportId, p_reason: reason,
  });
  if (error) throw error;
  return data;
}

export interface StocktakeCountLineInput {
  scientific_name: string;
  national_code: string | null;
  counted_qty: number;
}

export async function recordStocktake(input: {
  organizationId: string;
  scopeKind: 'warehouse' | 'outlet';
  scopeId: string;
  notes?: string | null;
  lines: StocktakeCountLineInput[];
}): Promise<{ ok: boolean; stocktake_id: string }> {
  requireConfigured();
  const { data, error } = await supabase.rpc('phoenix_status_record_stocktake', {
    p_organization_id: input.organizationId,
    p_scope_kind: input.scopeKind,
    p_scope_id: input.scopeId,
    p_notes: input.notes ?? null,
    p_lines: input.lines,
  });
  if (error) throw error;
  return data;
}

export interface StocktakeCountLine {
  id: string;
  scientific_name: string;
  national_code: string | null;
  expected_qty: number;
  counted_qty: number;
  variance: number;
}

export async function getStocktakeCountLines(stocktakeId: string): Promise<StocktakeCountLine[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('stocktake_count_lines')
    .select('*')
    .eq('stocktake_id', stocktakeId)
    .order('scientific_name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as StocktakeCountLine[];
}

export async function getOrgStocktakes(organizationId: string): Promise<{ id: string; scope_kind: string; scope_id: string; notes: string | null; performed_at: string }[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('stocktakes')
    .select('id, scope_kind, scope_id, notes, performed_at')
    .eq('organization_id', organizationId)
    .order('performed_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return data ?? [];
}
