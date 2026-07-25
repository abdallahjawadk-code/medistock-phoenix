import { supabase, supabaseConfigured } from '../client';

export interface CentralItem {
  id: string;
  name: string;
  name_ar: string;
  barcode?: string;
  unit: string;
  category?: string;
  status: string;
  /** 114 — catalog identity detail. Nullable; super_admin-maintained. */
  trade_name?: string | null;
  concentration?: string | null;
  dosage_form?: string | null;
}

export async function searchCentralItems(query: string): Promise<CentralItem[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('central_items')
    .select('id, name, name_ar, barcode, unit, category, status, trade_name, concentration, dosage_form')
    .eq('status', 'active')
    .or(`name.ilike.%${query}%,name_ar.ilike.%${query}%,barcode.ilike.%${query}%`)
    .order('name_ar')
    .limit(50);

  if (error) throw error;
  return data ?? [];
}

export async function getAllCentralItems(): Promise<CentralItem[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('central_items')
    .select('id, name, name_ar, barcode, unit, category, status, trade_name, concentration, dosage_form')
    .order('name_ar');

  if (error) throw error;
  return data ?? [];
}

export async function getLocalItems(orgId: string) {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('local_items')
    .select(`
      id, local_code, local_name, status,
      central_items ( id, name, name_ar, unit, barcode, category )
    `)
    .eq('organization_id', orgId)
    .neq('status', 'archived')
    .order('central_items(name_ar)');

  if (error) throw error;
  return data ?? [];
}
