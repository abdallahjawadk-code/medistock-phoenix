import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getPointsByOrg } from '@/shared/supabase/services/warehouses.service';
import { getLocalItems } from '@/shared/supabase/services/registry.service';
import { upsertAvailability } from '@/shared/supabase/services/availability.service';
import type { AvailabilityCondition } from '@/shared/lib/types';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';

interface CentralRef { name: string; name_ar: string; unit: string; }
interface LocalRow { id: string; local_code: string | null; local_name: string | null; central_items: CentralRef | CentralRef[] | null; }
interface PointRow { id: string; name: string; name_ar: string; }

function centralOf(row: LocalRow): CentralRef | null {
  const c = row.central_items;
  if (!c) return null;
  return Array.isArray(c) ? c[0] ?? null : c;
}

const CONDITIONS: AvailabilityCondition[] = ['available', 'low_stock', 'surplus', 'near_expiry', 'missing', 'expired'];

export function EditorScreen() {
  const { lang, activeOrgId } = useApp();

  const points = useAsync<PointRow[]>(() => activeOrgId ? getPointsByOrg(activeOrgId) : Promise.resolve([]), [activeOrgId]);
  const items  = useAsync(() => activeOrgId ? getLocalItems(activeOrgId) : Promise.resolve([]), [activeOrgId]);
  const itemRows = (items.data ?? []) as unknown as LocalRow[];

  const [pointId, setPointId]   = useState('');
  const [itemId, setItemId]     = useState('');
  const [qty, setQty]           = useState(0);
  const [condition, setCondition] = useState<AvailabilityCondition>('available');
  const [batch, setBatch]       = useState('');
  const [expiry, setExpiry]     = useState('');
  const [notes, setNotes]       = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [toast, setToast]       = useState<string | null>(null);

  const qtyInvalid = qty < 0;
  const canSubmit = !!activeOrgId && !!pointId && !!itemId && !qtyInvalid;

  async function doApply() {
    if (!activeOrgId) return;
    setBusy(true);
    try {
      await upsertAvailability({
        localItemId: itemId,
        distributionPointId: pointId,
        organizationId: activeOrgId,
        quantity: qty,
        condition,
        batchNumber: batch || undefined,
        expiryDate: expiry || undefined,
        notes: notes || undefined,
      });
      setShowConfirm(false);
      setToast(t('apply_success', lang));
      setTimeout(() => setToast(null), 3000);
      setBatch(''); setNotes('');
    } catch (e) {
      console.error('[phoenix] availability upsert failed:', e);
      setShowConfirm(false);
      setToast(t('load_error', lang));
      setTimeout(() => setToast(null), 3000);
    } finally {
      setBusy(false);
    }
  }

  const fieldStyle = { width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' } as const;

  return (
    <div style={{ maxWidth: '900px', animation: 'fs .3s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_editor', lang)}</h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('editor_sub', lang)}</p>
        </div>
        <PhoenixOrgScope />
      </div>

      {!activeOrgId && <PhoenixEmptyState icon="🏥" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} />}

      {activeOrgId && (
        <>
          <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
              {/* Distribution point */}
              <div style={{ gridColumn: '1/-1' }}>
                <label htmlFor="ed-point" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('select_inst', lang)} *</label>
                <select id="ed-point" value={pointId} onChange={e => setPointId(e.target.value)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
                  <option value="">— {points.loading ? t('loading', lang) : t('select_inst', lang)} —</option>
                  {(points.data ?? []).map(p => <option key={p.id} value={p.id}>{lang === 'ar' ? p.name_ar : p.name}</option>)}
                </select>
              </div>

              {/* Item */}
              <div style={{ gridColumn: '1/-1' }}>
                <label htmlFor="ed-item" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('item', lang)} *</label>
                <select id="ed-item" value={itemId} onChange={e => setItemId(e.target.value)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
                  <option value="">— {items.loading ? t('loading', lang) : t('item', lang)} —</option>
                  {itemRows.map(row => {
                    const c = centralOf(row);
                    return <option key={row.id} value={row.id}>{(lang === 'ar' ? c?.name_ar : c?.name) ?? row.local_name ?? row.local_code}</option>;
                  })}
                </select>
              </div>

              {/* Quantity */}
              <div>
                <label htmlFor="ed-qty" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('qty', lang)} *</label>
                <input id="ed-qty" type="number" min={0} value={qty} onChange={e => setQty(Number(e.target.value))} style={{ ...fieldStyle, border: `1px solid ${qtyInvalid ? 'var(--err)' : 'var(--brd)'}`, background: qtyInvalid ? 'var(--err2)' : 'var(--s)' }} />
                {qtyInvalid && <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>⚠ {t('qty_err', lang)}</p>}
              </div>

              {/* Condition */}
              <div>
                <label htmlFor="ed-cond" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('m_avail', lang)}</label>
                <select id="ed-cond" value={condition} onChange={e => setCondition(e.target.value as AvailabilityCondition)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
                  {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              {/* Batch */}
              <div>
                <label htmlFor="ed-batch" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('batch_no', lang)}</label>
                <input id="ed-batch" type="text" dir="ltr" value={batch} onChange={e => setBatch(e.target.value)} placeholder="BCH-2026-001" style={{ ...fieldStyle, fontFamily: 'monospace' }} />
              </div>

              {/* Expiry */}
              <div>
                <label htmlFor="ed-exp" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('expiry', lang)}</label>
                <input id="ed-exp" type="date" value={expiry} onChange={e => setExpiry(e.target.value)} style={fieldStyle} />
              </div>

              {/* Notes */}
              <div style={{ gridColumn: '1/-1' }}>
                <label htmlFor="ed-notes" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('notes', lang)}</label>
                <textarea id="ed-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('notes_ph', lang)} style={{ ...fieldStyle, resize: 'vertical' }} />
              </div>
            </div>
          </PhoenixCard>

          <PhoenixButton variant="primary" size="lg" fullWidth disabled={!canSubmit} onClick={() => setShowConfirm(true)}>
            ✅ {t('apply', lang)}
          </PhoenixButton>
          <p style={{ textAlign: 'center', fontSize: '11px', color: 'var(--t3)', marginTop: '8px' }}>{t('apply_note', lang)}</p>
        </>
      )}

      {/* Confirm dialog */}
      <PhoenixDialog open={showConfirm} onClose={() => setShowConfirm(false)} title={t('confirm_apply', lang)}>
        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'var(--warn2)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: '26px' }}>⚠️</div>
          <p style={{ fontSize: '13px', color: 'var(--t2)', lineHeight: 1.65 }}>{t('confirm_msg', lang)}</p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} onClick={() => setShowConfirm(false)}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="primary" size="md" style={{ flex: 2 }} loading={busy} onClick={doApply}>✅ {t('confirm_btn', lang)}</PhoenixButton>
        </div>
      </PhoenixDialog>

      {toast && <PhoenixToast message={toast} />}
    </div>
  );
}
