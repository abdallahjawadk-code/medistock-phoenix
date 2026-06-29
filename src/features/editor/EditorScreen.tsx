import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getPointsByOrg } from '@/shared/supabase/services/warehouses.service';
import { upsertAvailability } from '@/shared/supabase/services/availability.service';
import { getOrganizations, getOrganization } from '@/shared/supabase/services/organizations.service';
import type { AvailabilityCondition } from '@/shared/lib/types';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';

interface PointRow { id: string; name: string; name_ar: string; }

/**
 * Material status options (AVAILABILITY-EDITOR-INSTITUTION-UX-A, Part D).
 * 'surplus' and 'near_expiry' are intentionally merged into a single
 * selectable option here — both i18n keys now carry the same combined
 * "Surplus - Near expiry" wording (see strings.ts), so existing legacy rows
 * stored as either value display identically everywhere. No new DB enum
 * value was introduced; new submissions from this merged option are stored
 * as 'surplus'. 'expired' is intentionally not offered as a selectable
 * status here per the simplified 4-option spec — historical 'expired' rows
 * are unaffected and still display correctly in other screens.
 */
const CONDITION_OPTIONS: { value: AvailabilityCondition; labelKey: string }[] = [
  { value: 'available', labelKey: 'cond_available' },
  { value: 'low_stock',  labelKey: 'cond_low_stock' },
  { value: 'missing',    labelKey: 'cond_missing' },
  { value: 'surplus',    labelKey: 'cond_surplus' },
];

export function EditorScreen() {
  const { lang, role, activeOrgId, setActiveOrgId } = useApp();
  const isSuper = role === 'super_admin';

  const points = useAsync<PointRow[]>(() => activeOrgId ? getPointsByOrg(activeOrgId) : Promise.resolve([]), [activeOrgId]);
  // Institution field data: super_admin gets the full org list (for the
  // dropdown they're allowed to switch between); everyone else only needs
  // their own org's name to render the locked display.
  const orgs  = useAsync(() => isSuper ? getOrganizations() : Promise.resolve([]), [isSuper]);
  const myOrg = useAsync(() => (!isSuper && activeOrgId) ? getOrganization(activeOrgId) : Promise.resolve(null), [isSuper, activeOrgId]);

  const [pointId, setPointId]   = useState('');
  const [portName, setPortName] = useState('');
  const [qty, setQty]           = useState(0);
  const [condition, setCondition] = useState<AvailabilityCondition>('available');
  const [batch, setBatch]       = useState('');
  const [expiry, setExpiry]     = useState('');
  const [notes, setNotes]       = useState('');
  const [supplyType, setSupplyType] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [toast, setToast]       = useState<string | null>(null);

  const qtyInvalid = qty < 0;
  const canSubmit = !!activeOrgId && !!pointId && !!portName.trim() && !qtyInvalid;

  async function doApply() {
    if (!activeOrgId) return;
    setBusy(true);
    try {
      await upsertAvailability({
        portName: portName.trim(),
        distributionPointId: pointId,
        organizationId: activeOrgId,
        quantity: qty,
        condition,
        batchNumber: batch || undefined,
        expiryDate: expiry || undefined,
        notes: notes || undefined,
        supplyType: supplyType || undefined,
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
  const lockedFieldStyle = { ...fieldStyle, background: 'var(--s2)', color: 'var(--t2)', cursor: 'default' } as const;

  const myOrgName = myOrg.data ? (lang === 'ar' ? myOrg.data.name_ar : myOrg.data.name) : '';

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
              {/* Institution — locked display for institution-scoped users,
                  dropdown only for super_admin (AVAILABILITY-EDITOR-INSTITUTION-UX-A, Part A) */}
              <div style={{ gridColumn: '1/-1' }}>
                <label htmlFor="ed-inst" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_inst_label', lang)} *</label>
                {isSuper ? (
                  <select id="ed-inst" value={activeOrgId ?? ''} onChange={e => setActiveOrgId(e.target.value || null)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
                    <option value="">— {t('select_inst', lang)} —</option>
                    {(orgs.data ?? []).map(o => <option key={o.id} value={o.id}>{lang === 'ar' ? o.name_ar : o.name}</option>)}
                  </select>
                ) : (
                  <>
                    <div id="ed-inst" style={lockedFieldStyle} dir="auto">
                      🏥 {myOrg.loading ? t('loading', lang) : (myOrgName || '—')}
                    </div>
                    <p style={{ fontSize: '10.5px', color: 'var(--t3)', marginTop: '4px' }} dir="auto">
                      {t('avail_inst_locked_note', lang)}
                    </p>
                  </>
                )}
              </div>

              {/* Distribution point */}
              <div style={{ gridColumn: '1/-1' }}>
                <label htmlFor="ed-point" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_point_select', lang)} *</label>
                <select id="ed-point" value={pointId} onChange={e => setPointId(e.target.value)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
                  <option value="">— {points.loading ? t('loading', lang) : t('avail_point_select', lang)} —</option>
                  {(points.data ?? []).map(p => <option key={p.id} value={p.id}>{lang === 'ar' ? p.name_ar : p.name}</option>)}
                </select>
              </div>

              {/* Port / Access point (free text — replaces the item dropdown, Part B) */}
              <div style={{ gridColumn: '1/-1' }}>
                <label htmlFor="ed-port" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_port_field', lang)} *</label>
                <input id="ed-port" type="text" dir="auto" value={portName} onChange={e => setPortName(e.target.value)}
                  placeholder={t('avail_port_ph', lang)} style={fieldStyle} />
              </div>

              {/* Quantity */}
              <div>
                <label htmlFor="ed-qty" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('qty', lang)} *</label>
                <input id="ed-qty" type="number" min={0} value={qty} onChange={e => setQty(Number(e.target.value))} style={{ ...fieldStyle, border: `1px solid ${qtyInvalid ? 'var(--err)' : 'var(--brd)'}`, background: qtyInvalid ? 'var(--err2)' : 'var(--s)' }} />
                {qtyInvalid && <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>⚠ {t('qty_err', lang)}</p>}
              </div>

              {/* Material status (localized — Part D) */}
              <div>
                <label htmlFor="ed-cond" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_material_status', lang)}</label>
                <select id="ed-cond" value={condition} onChange={e => setCondition(e.target.value as AvailabilityCondition)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
                  {CONDITION_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{t(opt.labelKey, lang)}</option>)}
                </select>
              </div>

              {/* National code (renamed from Batch No. — Part C; storage unchanged: batch_number column) */}
              <div>
                <label htmlFor="ed-batch" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_national_code', lang)}</label>
                <input id="ed-batch" type="text" dir="ltr" value={batch} onChange={e => setBatch(e.target.value)} placeholder={t('avail_national_code_ph', lang)} style={{ ...fieldStyle, fontFamily: 'monospace' }} />
              </div>

              {/* Expiry */}
              <div>
                <label htmlFor="ed-exp" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('expiry', lang)}</label>
                <input id="ed-exp" type="date" value={expiry} onChange={e => setExpiry(e.target.value)} style={fieldStyle} />
              </div>

              {/* Supply type — institution-private (Part E) */}
              <div>
                <label htmlFor="ed-supply" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_supply_type', lang)}</label>
                <input id="ed-supply" type="text" dir="auto" value={supplyType} onChange={e => setSupplyType(e.target.value)}
                  placeholder={t('avail_supply_type_ph', lang)} style={fieldStyle} />
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
