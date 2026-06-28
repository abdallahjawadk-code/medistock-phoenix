import { supabase, supabaseConfigured } from '../client';

export type StatusType = 'scarce' | 'surplus' | 'near_expiry' | 'missing';

export interface StatusReport {
  id: string;
  organization_id: string;
  item_id: string | null;
  item_name: string | null;
  item_name_ar: string | null;
  status_type: StatusType;
  quantity: number | null;
  unit: string | null;
  expiry_date: string | null;
  notes: string | null;
  submitted_by: string | null;
  submitted_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  is_active: boolean;
  created_at: string;
  organizations?: { name: string; name_ar: string } | null;
}

export async function getStatusReports(opts: {
  orgId?: string;
  statusType?: StatusType;
  activeOnly?: boolean;
}): Promise<StatusReport[]> {
  if (!supabaseConfigured) return [];

  let query = supabase
    .from('institution_item_status_reports')
    .select('*, organizations ( name, name_ar )')
    .order('submitted_at', { ascending: false });

  if (opts.orgId) query = query.eq('organization_id', opts.orgId);
  if (opts.statusType) query = query.eq('status_type', opts.statusType);
  if (opts.activeOnly) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as StatusReport[];
}

export async function createStatusReport(input: {
  organizationId: string;
  itemId?: string;
  itemName?: string;
  itemNameAr?: string;
  statusType: StatusType;
  quantity?: number;
  unit?: string;
  expiryDate?: string;
  notes?: string;
}): Promise<StatusReport> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase
    .from('institution_item_status_reports')
    .insert({
      organization_id: input.organizationId,
      item_id:         input.itemId ?? null,
      item_name:       input.itemName ?? null,
      item_name_ar:    input.itemNameAr ?? null,
      status_type:     input.statusType,
      quantity:        input.quantity ?? null,
      unit:            input.unit ?? null,
      expiry_date:     input.expiryDate ?? null,
      notes:           input.notes ?? null,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data as StatusReport;
}

export async function updateStatusReport(
  id: string,
  input: {
    itemName?: string;
    itemNameAr?: string;
    statusType?: StatusType;
    quantity?: number | null;
    unit?: string;
    expiryDate?: string | null;
    notes?: string | null;
  },
): Promise<void> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const update: Record<string, unknown> = {};
  if (input.itemName !== undefined) update.item_name = input.itemName;
  if (input.itemNameAr !== undefined) update.item_name_ar = input.itemNameAr;
  if (input.statusType !== undefined) update.status_type = input.statusType;
  if (input.quantity !== undefined) update.quantity = input.quantity;
  if (input.unit !== undefined) update.unit = input.unit;
  if (input.expiryDate !== undefined) update.expiry_date = input.expiryDate;
  if (input.notes !== undefined) update.notes = input.notes;

  const { error } = await supabase
    .from('institution_item_status_reports')
    .update(update)
    .eq('id', id);

  if (error) throw error;
}

export async function resolveStatusReport(id: string): Promise<void> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { error } = await supabase
    .from('institution_item_status_reports')
    .update({ is_active: false, resolved_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;
}
