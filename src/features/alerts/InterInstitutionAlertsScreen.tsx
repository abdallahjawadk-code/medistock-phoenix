import { useState } from 'react';
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
  type AlertPriority,
  type StatusPair,
} from './inter-institution-alerts';

const PRIORITY_VARIANT: Record<AlertPriority, 'err' | 'warn' | 'neutral'> = {
  high: 'err', medium: 'warn', low: 'neutral',
};
const PRIORITY_LABEL_KEY: Record<AlertPriority, string> = {
  high: 'iia_priority_high', medium: 'iia_priority_medium', low: 'iia_priority_low',
};

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
/** wa.me requires bare digits — strip everything else. Empty = no link. */
function waDigits(phone: string | null): string {
  if (!phone) return '';
  return phone.replace(/[^\d]/g, '');
}

export function InterInstitutionAlertsScreen() {
  const { lang, role, activeOrgId } = useApp();
  const isMobile = window.innerWidth < 768;
  const isSuper = role === 'super_admin';

  const [filterPriority, setFilterPriority] = useState<AlertPriority | ''>('');
  const [filterPair, setFilterPair] = useState<StatusPair | ''>('');
  const [filterInst, setFilterInst] = useState<string>('');
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const result = useAsync(
    () => getScopedInterInstitutionAlerts({ isSuper, orgId: activeOrgId }),
    [isSuper, activeOrgId],
  );

  const allAlerts = result.data?.alerts ?? [];
  const migrationMissing = result.data?.migrationMissing ?? false;

  // Institution filter options (unique source + target across visible alerts).
  const instMap = new Map<string, string>();
  for (const a of allAlerts) {
    if (!instMap.has(a.sourceOrgId)) instMap.set(a.sourceOrgId, orgName(a.sourceOrgName, a.sourceOrgNameAr, lang));
    if (!instMap.has(a.targetOrgId)) instMap.set(a.targetOrgId, orgName(a.targetOrgName, a.targetOrgNameAr, lang));
  }

  const filtered = sortByPriority(allAlerts.filter(a => {
    if (filterPriority && a.priority !== filterPriority) return false;
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
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 700, letterSpacing: '-.3px' }}>
            {t('iia_title', lang)}
          </h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px', maxWidth: '640px' }} dir="auto">
            {t('iia_sub', lang)}
          </p>
        </div>
        {isSuper && <PhoenixOrgScope />}
      </div>

      {/* No auto-transfer disclaimer */}
      <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: 'var(--info)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        ℹ️ {t('iia_no_transfer', lang)}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
        <select value={filterPriority} onChange={e => setFilterPriority(e.target.value as AlertPriority | '')}
          style={{ ...fieldStyle, width: 'auto', minWidth: '150px', appearance: 'none', cursor: 'pointer' }} aria-label={t('iia_filter_priority', lang)}>
          <option value="">{t('iia_filter_priority', lang)}: {t('iia_all', lang)}</option>
          <option value="high">{t('iia_priority_high', lang)}</option>
          <option value="medium">{t('iia_priority_medium', lang)}</option>
          <option value="low">{t('iia_priority_low', lang)}</option>
        </select>

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
        <PhoenixEmptyState icon="🔄" title={t('iia_empty', lang)} description={t('iia_sub', lang)} />
      )}

      {/* Alert cards (high priority first via sortByPriority) */}
      {!result.loading && !result.error && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {filtered.map(a => (
            <AlertCard key={a.id} a={a} lang={lang} isMobile={isMobile} onCopy={copy} />
          ))}
        </div>
      )}

      {toast && <PhoenixToast message={toast} />}
    </div>
  );
}

function AlertCard({ a, lang, isMobile, onCopy }: {
  a: ScopedAlert;
  lang: 'ar' | 'en';
  isMobile: boolean;
  onCopy: (text: string) => void;
}) {
  return (
    <PhoenixCard padding="16px" style={{ borderInlineStart: `3px solid ${a.priority === 'high' ? 'var(--err)' : a.priority === 'medium' ? 'var(--warn)' : 'var(--brd)'}` }}>
      {/* Title + priority */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '10.5px', color: 'var(--t2)', fontWeight: 600 }}>{t('iia_item', lang)}</div>
          <div style={{ fontSize: '14px', fontWeight: 700 }} dir="auto">{alertItemName(a, lang)}</div>
        </div>
        <PhoenixStatusBadge variant={PRIORITY_VARIANT[a.priority]} label={t(PRIORITY_LABEL_KEY[a.priority], lang)} />
      </div>

      {/* Source / Target */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
        <PartyBlock
          roleLabel={t('iia_source', lang)} statusLabelKey={a.sourceStatus === 'surplus' ? 'st_surplus' : 'st_near_expiry'}
          statusVariant={a.sourceStatus === 'surplus' ? 'ok' : 'warn'}
          name={orgName(a.sourceOrgName, a.sourceOrgNameAr, lang)}
          contactName={a.sourceContactName} contactPhone={a.sourceContactPhone}
          lang={lang} onCopy={onCopy}
        />
        <PartyBlock
          roleLabel={t('iia_target', lang)} statusLabelKey={a.targetStatus === 'missing' ? 'st_missing' : 'st_scarce'}
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

      {/* Monthly Status Officer contact */}
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
