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
import { getAvailabilityByOrg } from '@/shared/supabase/services/availability.service';
import type { CanonicalStatus } from '@/shared/lib/status/canonical';
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

/** The 6 canonical statuses summarized in the live availability matrix. */
const CANONICAL_STATUSES: CanonicalStatus[] = [
  'available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired',
];

/** Badge variant per canonical effective status (UI only). */
const CANON_VARIANT: Record<CanonicalStatus, 'ok' | 'warn' | 'err' | 'neutral'> = {
  available: 'ok', surplus: 'ok', low_stock: 'warn', near_expiry: 'warn', missing: 'err', expired: 'err',
};

/** A live item_availability row enriched with derived fields by the service layer. */
interface LiveAvailRow {
  id: string;
  scientific_name: string | null;
  trade_name: string | null;
  dosage_form: string | null;
  concentration: string | null;
  quantity: number;
  condition: string | null;
  expiry_date: string | null;
  raw_condition?: string;
  effective_status?: CanonicalStatus;
  expiry_bucket?: string | null;
  distribution_points: { id: string; name: string; name_ar: string } | null;
}

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

export function StatusCenterScreen({ onNavigate }: { onNavigate: (screen: number) => void }) {
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

  // Live availability matrix — reads item_availability (the live inventory
  // source of truth) for the active org. Independent of the manual reports
  // workflow above; visibility only, no alerts generated here.
  const liveAvailability = useAsync(
    () => effectiveOrgId ? getAvailabilityByOrg(effectiveOrgId) : Promise.resolve([]),
    [effectiveOrgId],
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

      {/* Live availability matrix — real item_availability, separate from manual reports */}
      <LiveAvailabilityMatrix
        lang={lang}
        loading={liveAvailability.loading}
        error={liveAvailability.error}
        rows={(liveAvailability.data ?? []) as unknown as LiveAvailRow[]}
        onRetry={liveAvailability.reload}
      />

      {/* Manual status reports section header */}
      <h3 style={{ fontSize: isMobile ? '15px' : '17px', fontWeight: 700, margin: '28px 0 6px' }}>
        {t('sc_manual_reports', lang)}
      </h3>

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

      {/* Material Exchange Command Center CTA */}
      <div style={{ marginTop: '28px', background: 'var(--p2)', border: '1px solid var(--p)', borderRadius: 'var(--r3)', padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--pd)' }}>🔄 {t('material_exchange_center', lang)}</div>
          <div style={{ fontSize: '12px', color: 'var(--pd)', marginTop: '3px', opacity: 0.85 }}>{t('duplicate_exchange_moved_notice', lang)}</div>
        </div>
        <button
          onClick={() => onNavigate(13)}
          style={{ padding: '8px 16px', borderRadius: 'var(--r2)', border: 'none', background: 'var(--p)', color: 'white', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          {t('open_exchange_center', lang)} →
        </button>
      </div>

      {toast && <PhoenixToast message={toast} />}
    </div>
  );
}

/* ── Live Availability Matrix (read-only, item_availability) ── */

function LiveAvailabilityMatrix({ lang, loading, error, rows, onRetry }: {
  lang: 'ar' | 'en';
  loading: boolean;
  error: string | null;
  rows: LiveAvailRow[];
  onRetry: () => void;
}) {
  // Count by effective_status; fall back to raw condition if derived field absent.
  const counts: Record<string, number> = {};
  for (const s of CANONICAL_STATUSES) counts[s] = 0;
  for (const r of rows) {
    const s = (r.effective_status ?? r.condition ?? 'available') as string;
    counts[s] = (counts[s] ?? 0) + 1;
  }

  const matName = (r: LiveAvailRow): string =>
    (lang === 'ar'
      ? (r.scientific_name || r.trade_name)
      : (r.scientific_name || r.trade_name)) || '—';

  const dpName = (r: LiveAvailRow): string => {
    const dp = r.distribution_points;
    if (!dp) return '—';
    return lang === 'ar' ? (dp.name_ar || dp.name) : dp.name;
  };

  const th = { textAlign: 'start' as const, padding: '6px 8px', fontSize: '11px', fontWeight: 700, color: 'var(--t2)', whiteSpace: 'nowrap' as const };
  const td = { padding: '6px 8px', fontSize: '11.5px', borderTop: '1px solid var(--brd)', whiteSpace: 'nowrap' as const };

  return (
    <PhoenixCard padding="16px" style={{ marginBottom: '8px' }}>
      <div style={{ marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '15px', fontWeight: 700 }}>📊 {t('sc_live_matrix', lang)}</span>
          <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--ok)', background: 'var(--ok2)', border: '1px solid var(--ok)', borderRadius: 'var(--rpill)', padding: '1px 8px' }}>LIVE</span>
        </div>
        <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('sc_live_matrix_sub', lang)}</div>
      </div>

      {/* Summary counts — all 6 canonical statuses */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
        {CANONICAL_STATUSES.map(s => (
          <div key={s} style={{ flex: '1 1 90px', minWidth: '90px', background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '8px 10px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, lineHeight: 1 }}>{counts[s]}</div>
            <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('cond_' + s, lang)}</div>
          </div>
        ))}
      </div>

      {loading && <div style={{ fontSize: '12px', color: 'var(--t2)', padding: '8px 0' }}>{t('loading', lang)}</div>}
      {!loading && error && (
        <div style={{ fontSize: '12px', color: 'var(--err)', display: 'flex', gap: '8px', alignItems: 'center' }}>
          {t('load_error', lang)}
          <button onClick={onRetry} style={{ fontSize: '11px', padding: '3px 10px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', cursor: 'pointer' }}>↻</button>
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '24px', color: 'var(--t2)', fontSize: '12.5px' }}>
          {t('sc_live_empty', lang)}
        </div>
      )}

      {!loading && !error && rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>{t('sc_lm_port', lang)}</th>
                <th style={th}>{t('sc_lm_material', lang)}</th>
                <th style={th}>{t('avail_concentration', lang)}</th>
                <th style={th}>{t('avail_dosage_form', lang)}</th>
                <th style={th}>{t('qty', lang)}</th>
                <th style={th}>{t('sc_raw_condition', lang)}</th>
                <th style={th}>{t('sc_effective_status', lang)}</th>
                <th style={th}>{t('expiry', lang)}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const eff = (r.effective_status ?? r.condition ?? 'available') as CanonicalStatus;
                const variant = CANON_VARIANT[eff] ?? 'neutral';
                return (
                  <tr key={r.id}>
                    <td style={td} dir="auto">{dpName(r)}</td>
                    <td style={td} dir="auto">{matName(r)}</td>
                    <td style={td} dir="auto">{r.concentration || '—'}</td>
                    <td style={td} dir="auto">{r.dosage_form || '—'}</td>
                    <td style={td}>{r.quantity}</td>
                    <td style={td}>{r.condition ? t('cond_' + r.condition, lang) : '—'}</td>
                    <td style={td}><PhoenixStatusBadge variant={variant} label={t('cond_' + eff, lang)} /></td>
                    <td style={td} dir="ltr">{r.expiry_date || (r.expiry_bucket ? t('cond_' + (r.expiry_bucket === 'expired' ? 'expired' : 'near_expiry'), lang) : '—')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </PhoenixCard>
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

