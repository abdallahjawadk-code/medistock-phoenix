import { supabase, supabaseConfigured } from '../client';

export interface OrgRow {
  id:      string;
  name:    string;
  name_ar: string;
  code:    string;
  status:  string;
  city:    string;
}

export async function getOrganizations(): Promise<OrgRow[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('organizations')
    .select('id, name, name_ar, code, status, city')
    .order('name_ar');

  if (error) throw error;
  return (data ?? []).map(r => ({
    id:      r.id,
    name:    r.name,
    name_ar: r.name_ar,
    code:    r.code,
    status:  r.status,
    city:    r.city ?? '',
  }));
}

export async function getOrganization(id: string): Promise<OrgRow | null> {
  if (!supabaseConfigured) return null;

  const { data, error } = await supabase
    .from('organizations')
    .select('id, name, name_ar, code, status, city')
    .eq('id', id)
    .single();

  if (error) return null;
  return {
    id:      data.id,
    name:    data.name,
    name_ar: data.name_ar,
    code:    data.code,
    status:  data.status,
    city:    data.city ?? '',
  };
}
