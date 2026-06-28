import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { isAdminRole } from '@/shared/lib/types';
import {
  getStatusReports,
  createStatusReport,
  updateStatusReport,
  resolveStatusReport,
  type StatusReport,
  type StatusType,
} from '@/shared/supabase/services/status-reports.service';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import { generateExchangeAlerts, type ExchangeAlert, type AlertPriority } from './exchange-alerts';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';

const STATUS_TYPES: { value: StatusType; labelKey: string }[] = [
  { value: 'scarce',      labelKey: 'st_scarce' },
  { value: 'surplus',     labelKey: 'st_surplus' },
  { value: 'near_expiry', labelKey: 'st_near_expiry' },
  { value: 'missing',     labelKey: 'st_missing' },
];

const STATUS_VARIANT: Record<StatusType, 'warn' | 'ok' | 'err'> = {
  scarce: 'warn', surplus: 'ok', near_expiry: 'warn', missing: 'err',
};

function reportItemName(r: StatusReport, lang: 'ar' | 'en'): string {
  if (lang === 'ar') return r.item_name_ar ?? r.item_name ?? '—';
  return r.item_name ?? r.item_name_ar ?? '—';
}

function reportOrgName(r: StatusReport, lang: 'ar' | 'en'): string {
  const o = r.organizations;
  if (!o) return '—';
  if (lang === 'ar') return o.name_ar ?? o.name ?? '—';
  return o.name ?? o.name_ar ?? '—';
}

const fieldStyle = {
  width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '13px',
} as const;

export function StatusCenterScreen() {
  const { lang, role, activeOrgId } = useApp();
  const isMobile = window.innerWidth < 768;
  const isSuper = role === 'super_admin';
  const canMutate = isAdminRole(role) || role === 'warehouse_manager';

  const [filterType, setFilterType] = useState<StatusType | ''>('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const effectiveOrgId = isSuper ? (activeOrgId ?? undefined) : (activeOrgId ?? undefined);

  const reports = useAsync(
    () => getStatusReports({
      orgId: effectiveOrgId,
      statusType: filterType || undefined,
      activeOnly: activeOnly,
    }),
    [effectiveOrgId, filterType, activeOnly],
  );

  const rows = (reports.data ?? []).filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (r.item_name ?? '').toLowerCase().includes(q) ||
           (r.item_name_ar ?? '').includes(search);
  });

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function onResolve(id: string) {
    try {
      await resolveStatusReport(id);
      showToast(t('sc_resolved_msg', lang));
      reports.reload();
    } catch {
      showToast(t('load_error', lang));
    }
  }

  return (
    <div style={{ maxWidth: '1000px', animation: 'fs .3s ease' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 700, letterSpacing: '-.3px' }}>
            {t('nav_status_center', lang)}
          </h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('sc_sub', lang)}</p>
        </div>
        <PhoenixOrgScope />
      </div>

      {/* Notice: reporting only */}
      <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: 'var(--info)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        ℹ️ {t('sc_no_exchange', lang)}
      </div>

      {/* Filters + Add */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
        <select
          value={filterType}
          onChange={e => setFilterType(e.target.value as StatusType | '')}
          style={{ ...fieldStyle, width: 'auto', minWidth: '140px', appearance: 'none', cursor: 'pointer' }}
          aria-label={t('sc_filter_type', lang)}
        >
          <option value="">{t('sc_filter_type', lang)}: {t('sc_all', lang)}</option>
          {STATUS_TYPES.map(st => (
            <option key={st.value} value={st.value}>{t(st.labelKey, lang)}</option>
          ))}
        </select>

        <button
          onClick={() => setActiveOnly(!activeOnly)}
          style={{
            padding: '8px 14px', borderRadius: 'var(--r2)',
            border: '1px solid var(--brd)', background: activeOnly ? 'var(--p2)' : 'var(--s)',
            color: activeOnly ? 'var(--pd)' : 'var(--t)', fontSize: '12px', fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {activeOnly ? t('sc_active_only', lang) : t('sc_all', lang)}
        </button>

        <div style={{ position: 'relative', flex: 1, minWidth: '150px' }}>
          <span style={{ position: 'absolute', insetInlineStart: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '14px', pointerEvents: 'none' }}>🔍</span>
          <input
            type="search"
            placeholder={t('search', lang)}
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...fieldStyle, paddingInlineStart: '34px' }}
            aria-label={t('search', lang)}
          />
        </div>

        {canMutate && (
          <PhoenixButton variant="primary" size="md" onClick={() => { setShowAdd(true); setEditId(null); }}>
            + {t('sc_add', lang)}
          </PhoenixButton>
        )}
      </div>

      {/* Add / Edit form */}
      {showAdd && (
        <ReportForm
          lang={lang}
          orgId={effectiveOrgId}
          isSuper={isSuper}
          editReport={editId ? rows.find(r => r.id === editId) ?? null : null}
          onSaved={(isEdit) => {
            setShowAdd(false);
            setEditId(null);
            showToast(isEdit ? t('sc_updated', lang) : t('sc_created', lang));
            reports.reload();
          }}
          onCancel={() => { setShowAdd(false); setEditId(null); }}
        />
      )}

      {/* Report list */}
      {reports.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!reports.loading && reports.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={reports.error} onRetry={reports.reload} />
      )}
      {!reports.loading && !reports.error && rows.length === 0 && !showAdd && (
        <PhoenixEmptyState icon="📋" title={t('sc_empty', lang)} description={t('sc_empty_hint', lang)} />
      )}

      {!reports.loading && !reports.error && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {rows.map(r => {
            const variant = STATUS_VARIANT[r.status_type as StatusType] ?? 'neutral';
            const stKey = STATUS_TYPES.find(s => s.value === r.status_type)?.labelKey;
            return (
              <PhoenixCard key={r.id} padding="14px 16px" style={{ opacity: r.is_active ? 1 : 0.65 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700 }} dir="auto">
                        {reportItemName(r, lang)}
                      </span>
                      <PhoenixStatusBadge variant={variant} label={stKey ? t(stKey, lang) : r.status_type} />
                      {!r.is_active && <PhoenixStatusBadge variant="neutral" label={t('sc_resolved', lang)} />}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--t2)', display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '2px' }}>
                      {isSuper && <span>🏥 {reportOrgName(r, lang)}</span>}
                      {r.quantity != null && <span>{r.quantity}{r.unit ? ` ${r.unit}` : ''}</span>}
                      {r.expiry_date && <span dir="ltr">⏱ {r.expiry_date}</span>}
                      <span dir="ltr">{new Date(r.submitted_at).toLocaleDateString(lang === 'ar' ? 'ar' : 'en')}</span>
                    </div>
                    {r.notes && (
                      <div style={{ fontSize: '11px', color: 'var(--t3)', marginTop: '4px', fontStyle: 'italic' }} dir="auto">
                        {r.notes}
                      </div>
                    )}
                  </div>

                  {canMutate && r.is_active && (
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                      <PhoenixButton variant="ghost" size="sm" onClick={() => { setEditId(r.id); setShowAdd(true); }}>
                        {t('sc_edit', lang)}
                      </PhoenixButton>
                      <PhoenixButton variant="primary" size="sm" onClick={() => onResolve(r.id)}>
                        ✅ {t('sc_resolve', lang)}
                      </PhoenixButton>
                    </div>
                  )}
                </div>
              </PhoenixCard>
            );
          })}
        </div>
      )}

      {/* Exchange Alerts Section */}
      {!reports.loading && !reports.error && (reports.data ?? []).length > 0 && (
        <ExchangeAlertsSection
          reports={reports.data ?? []}
          lang={lang}
          isMobile={isMobile}
        />
      )}

      {toast && <PhoenixToast message={toast} />}
    </div>
  );
}

/* ── Report Form (Add / Edit) ── */

function ReportForm({ lang, orgId, isSuper, editReport, onSaved, onCancel }: {
  lang: 'ar' | 'en';
  orgId?: string;
  isSuper: boolean;
  editReport: StatusReport | null;
  onSaved: (isEdit: boolean) => void;
  onCancel: () => void;
}) {
  const isEdit = !!editReport;
  const orgs = useAsync(() => isSuper ? getOrganizations() : Promise.resolve([]), [isSuper]);

  const [selOrgId, setSelOrgId] = useState(editReport?.organization_id ?? orgId ?? '');
  const [itemName, setItemName] = useState(editReport?.item_name ?? '');
  const [itemNameAr, setItemNameAr] = useState(editReport?.item_name_ar ?? '');
  const [statusType, setStatusType] = useState<StatusType>(editReport?.status_type as StatusType ?? 'scarce');
  const [qty, setQty] = useState<string>(editReport?.quantity?.toString() ?? '');
  const [unit, setUnit] = useState(editReport?.unit ?? '');
  const [expiryDate, setExpiryDate] = useState(editReport?.expiry_date ?? '');
  const [notes, setNotes] = useState(editReport?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveOrg = isSuper ? selOrgId : (orgId ?? '');
  const canSubmit = effectiveOrg && (itemName.trim() || itemNameAr.trim());

  async function onSubmit() {
    if (!canSubmit) { setError(t('inst_required', lang)); return; }
    setBusy(true);
    setError(null);
    try {
      if (isEdit && editReport) {
        await updateStatusReport(editReport.id, {
          itemName: itemName.trim() || undefined,
          itemNameAr: itemNameAr.trim() || undefined,
          statusType,
          quantity: qty ? Number(qty) : null,
          unit: unit.trim() || undefined,
          expiryDate: expiryDate || null,
          notes: notes.trim() || null,
        });
      } else {
        await createStatusReport({
          organizationId: effectiveOrg,
          itemName: itemName.trim() || undefined,
          itemNameAr: itemNameAr.trim() || undefined,
          statusType,
          quantity: qty ? Number(qty) : undefined,
          unit: unit.trim() || undefined,
          expiryDate: expiryDate || undefined,
          notes: notes.trim() || undefined,
        });
      }
      onSaved(isEdit);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('load_error', lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '14px' }}>
        {isEdit ? t('sc_edit', lang) : t('sc_add', lang)}
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {/* Org selector for super_admin */}
        {isSuper && !isEdit && (
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('select_org', lang)} *</label>
            <select value={selOrgId} onChange={e => setSelOrgId(e.target.value)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
              <option value="">{t('select_org', lang)}</option>
              {(orgs.data ?? []).map(o => (
                <option key={o.id} value={o.id}>{lang === 'ar' ? o.name_ar : o.name}</option>
              ))}
            </select>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('sc_item_name_en', lang)}</label>
            <input type="text" value={itemName} onChange={e => setItemName(e.target.value)} style={fieldStyle} dir="ltr" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('sc_item_name_ar', lang)}</label>
            <input type="text" value={itemNameAr} onChange={e => setItemNameAr(e.target.value)} style={fieldStyle} dir="rtl" />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('sc_status_type', lang)} *</label>
            <select value={statusType} onChange={e => setStatusType(e.target.value as StatusType)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
              {STATUS_TYPES.map(st => <option key={st.value} value={st.value}>{t(st.labelKey, lang)}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('qty', lang)}</label>
            <input type="number" min={0} value={qty} onChange={e => setQty(e.target.value)} style={fieldStyle} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('unit', lang)}</label>
            <input type="text" value={unit} onChange={e => setUnit(e.target.value)} style={fieldStyle} dir="auto" />
          </div>
        </div>

        {(statusType === 'near_expiry') && (
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('expiry', lang)}</label>
            <input type="date" value={expiryDate} onChange={e => setExpiryDate(e.target.value)} style={fieldStyle} />
          </div>
        )}

        <div>
          <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('sc_notes', lang)}</label>
          <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} style={{ ...fieldStyle, resize: 'vertical' }} dir="auto" />
        </div>

        {error && <p style={{ fontSize: '12px', color: 'var(--err)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <PhoenixButton variant="ghost" size="md" onClick={onCancel}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="primary" size="md" loading={busy} disabled={!canSubmit} onClick={onSubmit}>
            {t('inst_save', lang)}
          </PhoenixButton>
        </div>
      </div>
    </PhoenixCard>
  );
}

/* ── Exchange Alerts Section ── */

const PRIORITY_VARIANT: Record<AlertPriority, 'err' | 'warn' | 'neutral'> = {
  high: 'err', medium: 'warn', low: 'neutral',
};
const PRIORITY_LABEL_KEY: Record<AlertPriority, string> = {
  high: 'ea_priority_high', medium: 'ea_priority_medium', low: 'ea_priority_low',
};

function alertItemName(a: ExchangeAlert, lang: 'ar' | 'en'): string {
  if (lang === 'ar') return a.itemNameAr || a.itemName || '—';
  return a.itemName || a.itemNameAr || '—';
}
function alertOrgName(name: string, nameAr: string, lang: 'ar' | 'en'): string {
  if (lang === 'ar') return nameAr || name || '—';
  return name || nameAr || '—';
}

function ExchangeAlertsSection({ reports, lang, isMobile }: {
  reports: StatusReport[];
  lang: 'ar' | 'en';
  isMobile: boolean;
}) {
  const alerts = generateExchangeAlerts(reports);
  const [filterPriority, setFilterPriority] = useState<AlertPriority | ''>('');
  const [search, setSearch] = useState('');

  const filtered = alerts.filter(a => {
    if (filterPriority && a.priority !== filterPriority) return false;
    if (search) {
      const q = search.toLowerCase();
      return (a.itemName ?? '').toLowerCase().includes(q) ||
             (a.itemNameAr ?? '').includes(search) ||
             (a.sourceOrgName ?? '').toLowerCase().includes(q) ||
             (a.sourceOrgNameAr ?? '').includes(search) ||
             (a.targetOrgName ?? '').toLowerCase().includes(q) ||
             (a.targetOrgNameAr ?? '').includes(search);
    }
    return true;
  });

  return (
    <div style={{ marginTop: '28px' }}>
      <h3 style={{ fontSize: isMobile ? '16px' : '18px', fontWeight: 700, marginBottom: '6px' }}>
        {t('ea_title', lang)}
      </h3>
      <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '14px' }}>{t('ea_sub', lang)}</p>

      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
        <select
          value={filterPriority}
          onChange={e => setFilterPriority(e.target.value as AlertPriority | '')}
          style={{ ...fieldStyle, width: 'auto', minWidth: '140px', appearance: 'none' as const, cursor: 'pointer' }}
          aria-label={t('ea_filter_priority', lang)}
        >
          <option value="">{t('ea_all_priorities', lang)}</option>
          <option value="high">{t('ea_priority_high', lang)}</option>
          <option value="medium">{t('ea_priority_medium', lang)}</option>
          <option value="low">{t('ea_priority_low', lang)}</option>
        </select>
        <div style={{ position: 'relative', flex: 1, minWidth: '150px' }}>
          <span style={{ position: 'absolute', insetInlineStart: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '14px', pointerEvents: 'none' }}>🔍</span>
          <input
            type="search"
            placeholder={t('search', lang)}
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...fieldStyle, paddingInlineStart: '34px' }}
            aria-label={t('search', lang)}
          />
        </div>
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <PhoenixEmptyState icon="🔄" title={t('ea_empty', lang)} description={t('ea_surplus_match', lang)} />
      )}

      {/* Alert cards */}
      {filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {filtered.map(a => (
            <PhoenixCard key={a.id} padding="14px 16px">
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' }}>
                <span style={{ fontSize: '13px', fontWeight: 700 }} dir="auto">
                  {alertItemName(a, lang)}
                </span>
                <PhoenixStatusBadge
                  variant={PRIORITY_VARIANT[a.priority]}
                  label={t(PRIORITY_LABEL_KEY[a.priority], lang)}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '8px', fontSize: '12px', marginBottom: '8px' }}>
                <div>
                  <span style={{ color: 'var(--t2)', fontWeight: 600 }}>{t('ea_source', lang)}: </span>
                  <span>{alertOrgName(a.sourceOrgName, a.sourceOrgNameAr, lang)}</span>
                  <span style={{ marginInlineStart: '6px', fontSize: '11px' }}>
                    <PhoenixStatusBadge variant={a.sourceStatus === 'surplus' ? 'ok' : 'warn'} label={t(a.sourceStatus === 'surplus' ? 'st_surplus' : 'st_near_expiry', lang)} />
                  </span>
                </div>
                <div>
                  <span style={{ color: 'var(--t2)', fontWeight: 600 }}>{t('ea_target', lang)}: </span>
                  <span>{alertOrgName(a.targetOrgName, a.targetOrgNameAr, lang)}</span>
                  <span style={{ marginInlineStart: '6px', fontSize: '11px' }}>
                    <PhoenixStatusBadge variant={a.targetStatus === 'missing' ? 'err' : 'warn'} label={t(a.targetStatus === 'missing' ? 'st_missing' : 'st_scarce', lang)} />
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '11px', color: 'var(--t2)' }}>
                {a.quantity != null && <span>{a.quantity}{a.unit ? ` ${a.unit}` : ''}</span>}
                {a.expiryDate && <span dir="ltr">⏱ {a.expiryDate}</span>}
              </div>

              <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--warn)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                ⚠ {t('ea_manual', lang)}
              </div>

              <div style={{ marginTop: '4px', fontSize: '10.5px', color: 'var(--t3)', fontStyle: 'italic' }}>
                {a.sourceStatus === 'near_expiry' ? t('ea_expiry_match', lang) : t('ea_surplus_match', lang)}
              </div>
            </PhoenixCard>
          ))}
        </div>
      )}
    </div>
  );
}
