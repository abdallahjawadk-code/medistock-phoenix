/**
 * INSTITUTION-LOCAL-PROCUREMENT-087 — supplier registry panel.
 * Institution-scoped reference data; writes only through the audited RPC.
 */
import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { getSuppliers, saveSupplier, type SupplierRow } from './procurement.service';
import { dash, procurementErrorKey } from './procurement-ui';

interface Props {
  orgId: string;
  canManage: boolean;
  lang: Lang;
}

interface FormState {
  supplierId: string | null;
  name: string;
  nameAr: string;
  contactPerson: string;
  phone: string;
  address: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  supplierId: null, name: '', nameAr: '', contactPerson: '', phone: '', address: '', notes: '',
};

export function SupplierPanel({ orgId, canManage, lang }: Props) {
  const suppliers = useAsync(() => getSuppliers(orgId), [orgId]);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const openCreate = () => { setErrorKey(null); setForm(EMPTY_FORM); };
  const openEdit = (s: SupplierRow) => {
    setErrorKey(null);
    setForm({
      supplierId: s.id, name: s.name, nameAr: s.nameAr ?? '',
      contactPerson: s.contactPerson ?? '', phone: s.phone ?? '',
      address: s.address ?? '', notes: s.notes ?? '',
    });
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setErrorKey(null);
    const result = await saveSupplier({
      organizationId: orgId,
      supplierId: form.supplierId,
      name: form.name.trim() || null,
      nameAr: form.nameAr.trim() || null,
      contactPerson: form.contactPerson.trim() || null,
      phone: form.phone.trim() || null,
      address: form.address.trim() || null,
      notes: form.notes.trim() || null,
    });
    setBusy(false);
    if (!result.ok) {
      setErrorKey(procurementErrorKey(result.error));
      return;
    }
    setForm(null);
    suppliers.reload();
  };

  const setStatus = async (s: SupplierRow, status: 'active' | 'inactive') => {
    setBusy(true);
    const result = await saveSupplier({ organizationId: orgId, supplierId: s.id, status });
    setBusy(false);
    if (result.ok) suppliers.reload();
  };

  if (suppliers.loading && !suppliers.data) return <PhoenixLoadingState />;
  if (suppliers.error) return <PhoenixErrorState message={suppliers.error} onRetry={suppliers.reload} />;
  const rows = suppliers.data ?? [];

  return (
    <div data-testid="lp-suppliers">
      {canManage && (
        <div style={{ marginBottom: '12px' }}>
          <PhoenixButton onClick={openCreate}>{t('lp_supplier_add', lang)}</PhoenixButton>
        </div>
      )}

      {rows.length === 0 ? (
        <PhoenixEmptyState icon="package" title={t('lp_suppliers_none', lang)} description={canManage ? t('lp_suppliers_none_hint', lang) : undefined} />
      ) : (
        <div style={{ display: 'grid', gap: '10px' }}>
          {rows.map(s => (
            <PhoenixCard key={s.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '13px', fontWeight: 700 }}>
                    {lang === 'ar' ? (s.nameAr || s.name) : s.name}
                    {s.status === 'inactive' && (
                      <span style={{ marginInlineStart: '8px', fontSize: '10.5px', fontWeight: 600, color: 'var(--t2)', border: '1px solid var(--brd)', borderRadius: '999px', padding: '1px 8px' }}>
                        {t('lp_supplier_inactive', lang)}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
                    {dash(s.contactPerson)} · {dash(s.phone)} · {dash(s.address)}
                  </div>
                </div>
                {canManage && (
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <PhoenixButton variant="ghost" size="sm" onClick={() => openEdit(s)}>{t('lp_edit', lang)}</PhoenixButton>
                    <PhoenixButton
                      variant="ghost" size="sm" disabled={busy}
                      onClick={() => setStatus(s, s.status === 'active' ? 'inactive' : 'active')}
                    >
                      {s.status === 'active' ? t('lp_supplier_deactivate', lang) : t('lp_supplier_activate', lang)}
                    </PhoenixButton>
                  </div>
                )}
              </div>
            </PhoenixCard>
          ))}
        </div>
      )}

      <PhoenixDialog
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.supplierId ? t('lp_supplier_edit_title', lang) : t('lp_supplier_add', lang)}
      >
        {form && (
          <div style={{ display: 'grid', gap: '10px' }}>
            <PhoenixInput label={t('lp_supplier_name', lang)} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            <PhoenixInput label={t('lp_supplier_name_ar', lang)} value={form.nameAr} onChange={e => setForm({ ...form, nameAr: e.target.value })} />
            <PhoenixInput label={t('lp_supplier_contact', lang)} value={form.contactPerson} onChange={e => setForm({ ...form, contactPerson: e.target.value })} />
            <PhoenixInput label={t('lp_supplier_phone', lang)} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
            <PhoenixInput label={t('lp_supplier_address', lang)} value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
            <PhoenixInput label={t('lp_notes', lang)} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
            {errorKey && (
              <div role="alert" style={{ fontSize: '12px', color: 'var(--err)' }}>{t(errorKey, lang)}</div>
            )}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <PhoenixButton variant="ghost" onClick={() => setForm(null)}>{t('lp_cancel', lang)}</PhoenixButton>
              <PhoenixButton onClick={save} disabled={busy || form.name.trim() === ''}>
                {busy ? t('lp_saving', lang) : t('lp_save', lang)}
              </PhoenixButton>
            </div>
          </div>
        )}
      </PhoenixDialog>
    </div>
  );
}
