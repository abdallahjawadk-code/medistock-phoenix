import { supabase } from '@/shared/supabase/client';
import { catalogNationalCode } from '@/shared/materials/catalog-national-code';
import { centralNeedsErrorFromPostgrest } from '../central-needs.service';

export interface CatalogLabel { id: string; name: string; nameAr: string | null; unit: string; nationalCode: string | null; concentration: string | null; dosageForm: string | null; status: string }
/** Persisted line labels are loaded by their canonical IDs, independently of the temporary picker. */
export async function getManualCatalogLabels(ids: string[]): Promise<CatalogLabel[]> {
  const unique = [...new Set(ids)];
  const out: CatalogLabel[] = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const { data, error } = await supabase.from('central_items').select('*').in('id', unique.slice(offset, offset + 100));
    if (error) throw centralNeedsErrorFromPostgrest(error);
    for (const r of data ?? []) out.push({ id: r.id, name: r.name, nameAr: r.name_ar ?? null, unit: r.unit, nationalCode: catalogNationalCode(r), concentration: r.concentration ?? null, dosageForm: r.dosage_form ?? null, status: r.status });
  }
  return out;
}
