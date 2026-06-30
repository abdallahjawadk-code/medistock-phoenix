import { useState, useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { getScopedInterInstitutionAlerts } from './inter-institution-alerts.service';
import {
  sortByPriority,
  recommendationSummary,
  STATUS_PAIR_LABEL_KEY,
  type ScopedAlert,
  type StatusPair,
} from './inter-institution-alerts';
import { parseExpiryDate, expiryBucket, type ExpiryBucket } from './materialAlertEngine';

// ─── Types ────────────────────────────────────────────────────────────────────

type ChipFilter =
  | ''
  | 'high' | 'medium' | 'low'
  | 'surplus' | 'near_expiry'
  | 'missing' | 'scarce'
  | 'exp_expired' | 'exp_3months' | 'exp_6months' | 'exp_9months'
  | 'data_quality';

// ─── Severity rail colors ─────────────────────────────────────────────────────

const SEVERITY_BORDER: Record<string, string> = {
  high:   'var(--err)',
  medium: 'var(--warn)',
  low:    'var(--brd)',
};

// ─── Expiry bucket badge ──────────────────────────────────────────────────────

function ExpiryBucketBadge({ bucket, lang }: { bucket: string; lang: 'ar' | 'en' }) {
  let label = '';
  let color = '';
  let bg    = '';
  if      (bucket === 'expired')   { label = t('filter_expired',  lang); color = 'var(--err)';  bg = 'var(--err2)';  }
  else if (bucket === '3_months')  { label = t('filter_3_months', lang); color = '#dc2626';     bg = '#fef2f2';      }
  else if (bucket === '6_months')  { label = t('filter_6_months', lang); color = 'var(--warn)'; bg = 'var(--warn2)'; }
  else if (bucket === '9_months')  { label = t('filter_9_months', lang); color = '#b45309';     bg = '#fef3c7';      }
  else return null;
  return (
    <span style={{
      padding: '1px 7px', borderRadius: 'var(--rpill)',
      border: `1px solid ${color}`, background: bg, color,
      fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

// ─── Compute expiry bucket for a ScopedAlert (from its source expiryDate) ────

function alertExpBucket(expiryDate: string | null, today: Date): ExpiryBucket | null {
  if (!expiryDate) return null;
  const d = parseExpiryDate(expiryDate);
  return d ? expiryBucket(today, d) : null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fieldStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '12.5px',
} as const;

function alertItemName(a: ScopedAlert, lang: 'ar' | 'en'): string {
  if (lang === 'ar') return a.itemNameAr || a.itemName || '—';
  return a.itemName || a.itemNameAr || '—';
}
function orgName(name: string, nameAr: string, lang: 'ar' | 'en'): string {
  if (lang === 'ar') return nameAr || name || '—';
  return name || nameAr || '—';
}
function waDigits(phone: string | null): string {
  if (!phone) return '';
  return phone.replace(/[^\d]/g, '');
}

// ─── Chip button ──────────────────────────────────────────────────────────────

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 12px', borderRadius: 'var(--rpill)',
        border: `1px solid ${active ? 'var(--p)' : 'var(--brd)'}`,
        background: active ? 'var(--p2)' : 'var(--s)',
        color: active ? 'var(--p)' : 'var(--t2)',
        fontSize: '11.5px', fontWeight: active ? 700 : 400,
        cursor: 'pointer', whiteSpace: 'nowrap',
        transition: 'all 120ms',
      }}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export function InterInstitutionAlertsScreen() {
  const { lang, role, activeOrgId } = useApp();
  const isMobile = window.innerWidth < 768;
  const isSuper  = role === 'super_admin';
  const today    = useMemo(() => new Date(), []);

  const [filterChip, setFilterChip]   = useState<ChipFilter>('');
  const [filterPair, setFilterPair]   = useState<StatusPair | ''>('');
  const [filterInst, setFilterInst]   = useState<string>('');
  const [search, setSearch]           = useState('');
  const [toast, setToast]             = useState<string | null>(null);

  const result = useAsync(
    () => getScopedInterInstitutionAlerts({ isSuper, orgId: activeOrgId }),
    [isSuper, activeOrgId],
  );

  const allAlerts      = result.data?.alerts ?? [];
  const migrationMissing = result.data?.migrationMissing ?? false;

  // Summary counts derived from loaded alerts
  const summaryHighCount     = allAlerts.filter(a => a.priority === 'high').length;
  const summaryNearExpCount  = allAlerts.filter(a => a.sourceStatus === 'near_expiry').length;
  const summarySurplusCount  = allAlerts.filter(a => a.sourceStatus === 'surplus').length;

  // Institution filter options
  const instMap = new Map<string, string>();
  for (const a of allAlerts) {
    if (!instMap.has(a.sourceOrgId)) instMap.set(a.sourceOrgId, orgName(a.sourceOrgName, a.sourceOrgNameAr, lang));
    if (!instMap.has(a.targetOrgId)) instMap.set(a.targetOrgId, orgName(a.targetOrgName, a.targetOrgNameAr, lang));
  }

  // Active filter applied
  const filtered = sortByPriority(allAlerts.filter(a => {
    if (filterChip === 'high'        && a.priority !== 'high') return false;
    if (filterChip === 'medium'      && a.priority !== 'medium') return false;
    if (filterChip === 'low'         && a.priority !== 'low') return false;
    if (filterChip === 'surplus'     && a.sourceStatus !== 'surplus') return false;
    if (filterChip === 'near_expiry' && a.sourceStatus !== 'near_expiry') return false;
    if (filterChip === 'missing'     && a.targetStatus !== 'missing') return false;
    if (filterChip === 'scarce'      && a.targetStatus !== 'scarce') return false;
    if (filterChip === 'data_quality') return false; // IIA alerts are not data-quality items
    // Threshold filters: based on computed expiry bucket of the source
    if (filterChip === 'exp_expired'  && alertExpBucket(a.expiryDate ?? null, today) !== 'expired')   return false;
    if (filterChip === 'exp_3months'  && alertExpBucket(a.expiryDate ?? null, today) !== '3_months')  return false;
    if (filterChip === 'exp_6months'  && alertExpBucket(a.expiryDate ?? null, today) !== '6_months')  return false;
    if (filterChip === 'exp_9months'  && alertExpBucket(a.expiryDate ?? null, today) !== '9_months')  return false;
    if (filterPair && a.statusPair !== filterPair) return false;
    if (filterInst && a.sourceOrgId !== filterInst && a.targetOrgId !== filterInst) return false;
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
  }));

  function toggleChip(chip: ChipFilter) {
    setFilterChip(prev => prev === chip ? '' : chip);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('iia_copied', lang));
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div style={{ maxWidth: '1040px', animation: 'fs .3s ease' }}>
      {/* Header — Material Exchange Command Center */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 700, letterSpacing: '-.3px' }}>
            {t('material_exchange_command_center', lang)}
          </h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px', maxWidth: '640px' }} dir="auto">
            {t('exchange_command_subtitle', lang)}
          </p>
        </div>
        {isSuper && <PhoenixOrgScope />}
      </div>

      {/* No auto-transfer disclaimer */}
      <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: 'var(--info)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        ℹ️ {t('iia_no_transfer', lang)}
      </div>

      {/* Summary cards — visible only when data is loaded */}
      {!result.loading && !result.error && !migrationMissing && allAlerts.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: '10px', marginBottom: '16px' }}>
          <SummaryCard
            icon="🔄" count={allAlerts.length}
            label={t('d_exchange_total', lang)}
            active={filterChip === ''} onClick={() => setFilterChip('')}
            accent="var(--info)"
          />
          <SummaryCard
            icon="🔴" count={summaryHighCount}
            label={t('critical_need', lang)}
            active={filterChip === 'high'} onClick={() => toggleChip('high')}
            accent="var(--err)"
          />
          <SummaryCard
            icon="⏱️" count={summaryNearExpCount}
            label={t('expires_within_3_months', lang)}
            active={filterChip === 'near_expiry'} onClick={() => toggleChip('near_expiry')}
            accent="var(--warn)"
          />
          <SummaryCard
            icon="📦" count={summarySurplusCount}
            label={t('surplus_for_redistribution', lang)}
            active={filterChip === 'surplus'} onClick={() => toggleChip('surplus')}
            accent="var(--ok)"
          />
        </div>
      )}

      {/* Filter chips — priority */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '6px' }}>
        <Chip label={t('iia_all', lang)}             active={filterChip === ''}      onClick={() => setFilterChip('')} />
        <Chip label={t('iia_priority_high', lang)}   active={filterChip === 'high'}   onClick={() => toggleChip('high')} />
        <Chip label={t('iia_priority_medium', lang)} active={filterChip === 'medium'} onClick={() => toggleChip('medium')} />
        <Chip label={t('iia_priority_low', lang)}    active={filterChip === 'low'}    onClick={() => toggleChip('low')} />
      </div>

      {/* Filter chips — expiry thresholds (explicit 9/6/3/expired) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '6px' }}>
        <Chip label={t('filter_expired',  lang)} active={filterChip === 'exp_expired'} onClick={() => toggleChip('exp_expired')} />
        <Chip label={t('filter_3_months', lang)} active={filterChip === 'exp_3months'} onClick={() => toggleChip('exp_3months')} />
        <Chip label={t('filter_6_months', lang)} active={filterChip === 'exp_6months'} onClick={() => toggleChip('exp_6months')} />
        <Chip label={t('filter_9_months', lang)} active={filterChip === 'exp_9months'} onClick={() => toggleChip('exp_9months')} />
      </div>

      {/* Filter chips — condition */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
        <Chip label={t('iia_pair_surplus_missing', lang)} active={filterChip === 'surplus'}     onClick={() => toggleChip('surplus')} />
        <Chip label={t('filter_missing', lang)}            active={filterChip === 'missing'}     onClick={() => toggleChip('missing')} />
        <Chip label={t('d_scarce', lang)}                  active={filterChip === 'scarce'}      onClick={() => toggleChip('scarce')} />
        <Chip label={t('filter_data_quality', lang)}       active={filterChip === 'data_quality'} onClick={() => toggleChip('data_quality')} />
      </div>

      {/* Secondary filters: pair + institution + search */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
        <select value={filterPair} onChange={e => setFilterPair(e.target.value as StatusPair | '')}
          style={{ ...fieldStyle, width: 'auto', minWidth: '160px', appearance: 'none', cursor: 'pointer' }} aria-label={t('iia_filter_pair', lang)}>
          <option value="">{t('iia_filter_pair', lang)}: {t('iia_all', lang)}</option>
          {(Object.keys(STATUS_PAIR_LABEL_KEY) as StatusPair[]).map(p => (
            <option key={p} value={p}>{t(STATUS_PAIR_LABEL_KEY[p], lang)}</option>
          ))}
        </select>

        {instMap.size > 1 && (
          <select value={filterInst} onChange={e => setFilterInst(e.target.value)}
            style={{ ...fieldStyle, width: 'auto', minWidth: '160px', appearance: 'none', cursor: 'pointer' }} aria-label={t('iia_filter_inst', lang)}>
            <option value="">{t('iia_filter_inst', lang)}: {t('iia_all', lang)}</option>
            {[...instMap.entries()].map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        )}

        <div style={{ position: 'relative', flex: 1, minWidth: '150px' }}>
          <span style={{ position: 'absolute', insetInlineStart: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '14px', pointerEvents: 'none' }}>🔍</span>
          <input type="search" placeholder={t('iia_filter_item', lang)} value={search} onChange={e => setSearch(e.target.value)}
            style={{ ...fieldStyle, paddingInlineStart: '34px' }} aria-label={t('iia_filter_item', lang)} />
        </div>
      </div>

      {/* States */}
      {result.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!result.loading && result.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={result.error} onRetry={result.reload} />
      )}

      {!result.loading && !result.error && migrationMissing && (
        <PhoenixEmptyState icon="🗄️" title={t('iia_empty', lang)} description={t('iia_migration_note', lang)} />
      )}

      {!result.loading && !result.error && !migrationMissing && filtered.length === 0 && (
        <PhoenixEmptyState icon="🔄" title={t('no_exchange_opportunities', lang)} description={t('current_position_based', lang)} />
      )}

      {/* Alert cards */}
      {!result.loading && !result.error && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {filtered.map(a => (
            <AlertCard key={a.id} a={a} lang={lang} isMobile={isMobile} onCopy={copy} today={today} />
          ))}
        </div>
      )}

      {toast && <PhoenixToast message={toast} />}
    </div>
  );
}

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({ icon, count, label, active, onClick, accent }: {
  icon: string;
  count: number;
  label: string;
  active: boolean;
  onClick: () => void;
  accent: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? 'var(--s2)' : 'var(--s)', borderRadius: 'var(--r3)',
        border: `1px solid ${active ? accent : 'var(--brd)'}`,
        padding: '12px 14px', textAlign: 'start', cursor: 'pointer',
        transition: 'all 120ms', width: '100%',
      }}
      aria-pressed={active}
    >
      <div style={{ fontSize: '18px', marginBottom: '4px' }}>{icon}</div>
      <div style={{ fontSize: '20px', fontWeight: 700, color: accent }}>{count}</div>
      <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{label}</div>
    </button>
  );
}

// ─── Alert card ───────────────────────────────────────────────────────────────

function AlertCard({ a, lang, isMobile, onCopy, today }: {
  a: ScopedAlert;
  lang: 'ar' | 'en';
  isMobile: boolean;
  onCopy: (text: string) => void;
  today: Date;
}) {
  const borderColor      = SEVERITY_BORDER[a.priority] ?? 'var(--brd)';
  const priorityVariant  = a.priority === 'high' ? 'err' as const : a.priority === 'medium' ? 'warn' as const : 'neutral' as const;
  const priorityLabelKey = a.priority === 'high' ? 'iia_priority_high' : a.priority === 'medium' ? 'iia_priority_medium' : 'iia_priority_low';
  const expBucket        = alertExpBucket(a.expiryDate ?? null, today);

  return (
    <PhoenixCard padding="16px" style={{ borderInlineStart: `3px solid ${borderColor}` }}>
      {/* Title + priority + threshold badge */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '10.5px', color: 'var(--t2)', fontWeight: 600 }}>{t('iia_item', lang)}</div>
          <div style={{ fontSize: '14px', fontWeight: 700 }} dir="auto">{alertItemName(a, lang)}</div>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          {expBucket && <ExpiryBucketBadge bucket={expBucket} lang={lang} />}
          <PhoenixStatusBadge variant={priorityVariant} label={t(priorityLabelKey, lang)} />
        </div>
      </div>

      {/* Source / Target */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
        <PartyBlock
          roleLabel={t('source_institution', lang)}
          statusLabelKey={a.sourceStatus === 'surplus' ? 'st_surplus' : 'st_near_expiry'}
          statusVariant={a.sourceStatus === 'surplus' ? 'ok' : 'warn'}
          name={orgName(a.sourceOrgName, a.sourceOrgNameAr, lang)}
          contactName={a.sourceContactName} contactPhone={a.sourceContactPhone}
          lang={lang} onCopy={onCopy}
        />
        <PartyBlock
          roleLabel={t('destination_institution', lang)}
          statusLabelKey={a.targetStatus === 'missing' ? 'st_missing' : 'st_scarce'}
          statusVariant={a.targetStatus === 'missing' ? 'err' : 'warn'}
          name={orgName(a.targetOrgName, a.targetOrgNameAr, lang)}
          contactName={a.targetContactName} contactPhone={a.targetContactPhone}
          lang={lang} onCopy={onCopy}
        />
      </div>

      {/* Quantity / expiry / pair */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '11.5px', color: 'var(--t2)', marginBottom: '10px', alignItems: 'center' }}>
        <PhoenixStatusBadge variant="neutral" label={t(STATUS_PAIR_LABEL_KEY[a.statusPair], lang)} />
        {a.quantity != null && <span>{t('iia_quantity', lang)}: {a.quantity}{a.unit ? ` ${a.unit}` : ''}</span>}
        {a.expiryDate && <span dir="ltr">⏱ {t('iia_expiry', lang)}: {a.expiryDate}</span>}
      </div>

      {/* Footer: manual action + copy recommendation */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', borderTop: '1px solid var(--brd)', paddingTop: '10px' }}>
        <span style={{ fontSize: '11px', color: 'var(--warn)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
          ⚠ {t('iia_manual', lang)}
        </span>
        <PhoenixButton variant="ghost" size="sm" onClick={() => onCopy(recommendationSummary(a, lang))}>
          📋 {t('iia_copy_reco', lang)}
        </PhoenixButton>
      </div>
    </PhoenixCard>
  );
}

// ─── Party block ──────────────────────────────────────────────────────────────

function PartyBlock({ roleLabel, statusLabelKey, statusVariant, name, contactName, contactPhone, lang, onCopy }: {
  roleLabel: string;
  statusLabelKey: string;
  statusVariant: 'ok' | 'warn' | 'err';
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  lang: 'ar' | 'en';
  onCopy: (text: string) => void;
}) {
  const wa = waDigits(contactPhone);
  return (
    <div style={{ background: 'var(--s2)', borderRadius: 'var(--r2)', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', marginBottom: '4px' }}>
        <span style={{ fontSize: '10.5px', color: 'var(--t2)', fontWeight: 600 }}>{roleLabel}</span>
        <PhoenixStatusBadge variant={statusVariant} label={t(statusLabelKey, lang)} />
      </div>
      <div style={{ fontSize: '12.5px', fontWeight: 600 }} dir="auto">{name}</div>

      <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--t2)' }}>
        <div>{t('iia_officer', lang)}: <span dir="auto">{contactName ?? '—'}</span></div>
        {contactPhone ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
            <a href={`tel:${contactPhone}`} style={{ fontSize: '12px', fontWeight: 700, color: 'var(--pd)' }} dir="ltr">📞 {contactPhone}</a>
            <button onClick={() => onCopy(contactPhone)} title={t('iia_copy_phone', lang)} aria-label={t('iia_copy_phone', lang)}
              style={{ padding: '2px 8px', borderRadius: 'var(--r1)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t2)', fontSize: '10.5px', cursor: 'pointer' }}>
              📋 {t('iia_copy_phone', lang)}
            </button>
            {wa && (
              <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer"
                style={{ padding: '2px 8px', borderRadius: 'var(--r1)', border: '1px solid var(--ok)', background: 'var(--ok2)', color: 'var(--ok)', fontSize: '10.5px', fontWeight: 600 }}>
                🟢 {t('iia_whatsapp', lang)}
              </a>
            )}
          </div>
        ) : (
          <div style={{ marginTop: '2px', fontStyle: 'italic', color: 'var(--t3)' }}>{t('iia_phone_na', lang)}</div>
        )}
      </div>
    </div>
  );
}
