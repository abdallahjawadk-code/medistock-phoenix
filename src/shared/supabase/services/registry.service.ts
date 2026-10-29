import { isMissingNationalCodeColumn } from '@/shared/materials/catalog-national-code';
import { supabase, supabaseConfigured } from '../client';

export interface CentralItem {
  id: string;
  name: string;
  name_ar: string;
  barcode?: string;
  national_code?: string | null;
  unit: string;
  category?: string;
  status: string;
  /** 114 — catalog identity detail. Nullable; super_admin-maintained. */
  trade_name?: string | null;
  concentration?: string | null;
  dosage_form?: string | null;
}

const CATALOG_COLUMNS = 'id, name, name_ar, barcode, unit, category, status, trade_name, concentration, dosage_form';
const CATALOG_CODE_COLUMNS = 'id, name, name_ar, barcode, unit, category, status, trade_name, concentration, dosage_form, national_code';

async function readCatalog(query?: string): Promise<CentralItem[]> {
  if (!supabaseConfigured) return [];
  const run = (modern: boolean) => {
    let builder = supabase.from('central_items').select(modern ? CATALOG_CODE_COLUMNS : CATALOG_COLUMNS).order('name_ar');
    if (query !== undefined) {
      const pattern = JSON.stringify('%' + query.replace(/[\\%_]/g, '\\$&') + '%');
      const columns = ['name', 'name_ar', 'barcode', ...(modern ? ['national_code'] : [])];
      builder = builder.eq('status','active').or(columns.map((c) => `${c}.ilike.${pattern}`).join(',')).limit(50);
    }
    return builder;
  };
  let response = await run(true);
  if (isMissingNationalCodeColumn(response.error)) response = await run(false);
  if (response.error) throw response.error;
  const rows: unknown = response.data ?? [];
  if (!Array.isArray(rows)) throw new Error('invalid_catalog_response');
  return rows.map((value: unknown): CentralItem => {
    if (!value || typeof value !== 'object') throw new Error('invalid_catalog_response');
    const r=value as Record<string, unknown>;
    if (typeof r.id!=='string' || typeof r.name!=='string' || typeof r.unit!=='string' || typeof r.status!=='string') throw new Error('invalid_catalog_response');
    const hasCode=Object.prototype.hasOwnProperty.call(r,'national_code');
    if(hasCode && r.national_code!==null && typeof r.national_code!=='string') throw new Error('invalid_catalog_response');
    return { id:r.id, name:r.name, name_ar:typeof r.name_ar==='string'?r.name_ar:r.name, unit:r.unit, status:r.status,
      barcode:typeof r.barcode==='string'?r.barcode:undefined, category:typeof r.category==='string'?r.category:undefined,
      trade_name:typeof r.trade_name==='string'?r.trade_name:null, concentration:typeof r.concentration==='string'?r.concentration:null,
      dosage_form:typeof r.dosage_form==='string'?r.dosage_form:null,
      ...(hasCode?{national_code:r.national_code as string|null}:{}),
    };
  });
}

export async function searchCentralItems(query: string): Promise<CentralItem[]> { return readCatalog(query); }
export async function getAllCentralItems(): Promise<CentralItem[]> { return readCatalog(); }

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
