import { useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getPublicQrPayload } from '@/shared/supabase/services/qr.service';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { getExpiryBucketStyle } from '@/features/alerts/materialAlertEngine';

/**
 * AVAILABILITY-ALERTS-QR-POLISH-D
 *
 * Status-summary chips near the top of the page: counts per `item.condition`
 * value, computed entirely from the already-loaded `rawItems` (the same data
 * the item list below renders) — no new fetch, no new field. Only conditions
 * already present in `CONDITION_LABEL`/`CONDITION_VARIANT` (the same set the
 * per-item badges already use) are ever shown, and only when at least one
 * loaded item actually has that condition.
 */

interface Props { publicId: string; }

type PublicItem = {
  name?: string;
  name_ar?: string;
  point_name?: string;
  point_name_ar?: string;
  condition?: string;
  quantity?: number;
  unit?: string;
  expiry_date?: string;
  expiry_bucket?: string; // D7: 'expired'|'3_months'|'6_months'|'9_months'|null
};

const CONDITION_VARIANT: Record<string, 'ok' | 'warn' | 'err' | 'neutral'> = {
  available: 'ok', surplus: 'ok', low_stock: 'warn', near_expiry: 'warn', missing: 'err', expired: 'err',
};

const CONDITION_LABEL: Record<string, { ar: string; en: string }> = {
  available:   { ar: 'متوفر',             en: 'Available' },
  surplus:     { ar: 'فائض',              en: 'Surplus' },
  low_stock:   { ar: 'مخزون منخفض',      en: 'Low Stock' },
  near_expiry: { ar: 'قريب الانتهاء',    en: 'Near Expiry' },
  missing:     { ar: 'مفقود',             en: 'Missing' },
  expired:     { ar: 'منتهي الصلاحية',   en: 'Expired' },
};

function conditionLabel(cond: string, lang: 'ar' | 'en'): string {
  return CONDITION_LABEL[cond]?.[lang] ?? cond;
}

// Display order for the summary chips — mirrors the existing condition set
// (CONDITION_VARIANT/CONDITION_LABEL) already used for per-item badges below.
const SUMMARY_CONDITIONS = ['available', 'surplus', 'low_stock', 'near_expiry', 'missing', 'expired'] as const;

const VARIANT_COLOR: Record<'ok' | 'warn' | 'err' | 'neutral', { color: string; bg: string }> = {
  ok:      { color: 'var(--ok)',   bg: 'var(--ok2)' },
  warn:    { color: 'var(--warn)', bg: 'var(--warn2)' },
  err:     { color: 'var(--err)',  bg: 'var(--err2)' },
  neutral: { color: 'var(--t2)',   bg: 'var(--s2)' },
};

function getExpBucketBadge(bucket: string | undefined, lang: 'ar' | 'en'): { label: string; color: string; bg: string } | null {
  if (!bucket) return null;
  const style = getExpiryBucketStyle(bucket);
  if (!style) return null;
  let label = '';
  if      (bucket === 'expired')  label = t('expired_material',        lang);
  else if (bucket === '3_months') label = t('expires_within_3_months', lang);
  else if (bucket === '6_months') label = t('expires_within_6_months', lang);
  else if (bucket === '9_months') label = t('expires_within_9_months', lang);
  else return null;
  return { label, color: style.color, bg: style.bg };
}

function itemLabel(item: PublicItem, lang: 'ar' | 'en'): string {
  if (lang === 'ar') return item.name_ar ?? item.name ?? item.point_name_ar ?? item.point_name ?? '—';
  return item.name ?? item.name_ar ?? item.point_name ?? item.point_name_ar ?? '—';
}

export function PublicQrScreen({ publicId }: Props) {
  const { lang, toggleLang } = useApp();
  const [search, setSearch] = useState('');
  const { data, loading, error, reload } = useAsync(
    () => getPublicQrPayload(publicId),
    [publicId],
  );

  const payload = (data ?? null) as Record<string, unknown> | null;
  const ok = payload?.ok === true;
  const orgName = lang === 'ar'
    ? (payload?.org_name_ar as string) ?? (payload?.org_name as string)
    : (payload?.org_name as string) ?? (payload?.org_name_ar as string);

  const rawItems =
    (payload?.items as PublicItem[] | undefined) ??
    (payload?.availability as PublicItem[] | undefined) ??
    (payload?.points as PublicItem[] | undefined) ??
    [];

  // Status-summary counts derived entirely from the already-loaded rawItems
  // — no new fetch, only conditions already present in the loaded items.
  const summaryCounts = useMemo(() => {
    const counts: Partial<Record<string, number>> = {};
    for (const item of rawItems) {
      if (!item.condition) continue;
      counts[item.condition] = (counts[item.condition] ?? 0) + 1;
    }
    return SUMMARY_CONDITIONS
      .filter(c => (counts[c] ?? 0) > 0)
      .map(c => ({ condition: c, count: counts[c]! }));
  }, [rawItems]);

  const filteredItems = search
    ? rawItems.filter(item => {
        const q = search.toLowerCase();
        return (item.name ?? '').toLowerCase().includes(q) ||
               (item.name_ar ?? '').includes(search) ||
               (item.point_name ?? '').toLowerCase().includes(q) ||
               (item.point_name_ar ?? '').includes(search);
      })
    : rawItems;

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 16px' }}>
      <div style={{ width: '100%', maxWidth: '480px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: 'var(--r3)', background: 'var(--p)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px' }}>⚕</div>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 700 }}>{t('public_title', lang)}</div>
              <div style={{ fontSize: '11px', color: 'var(--t2)' }}>{t('public_sub', lang)}</div>
            </div>
          </div>
          <button onClick={toggleLang} style={{ padding: '5px 12px', borderRadius: 'var(--rpill)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
            {lang === 'ar' ? 'EN' : 'عربي'}
          </button>
        </div>

        {loading && <PhoenixLoadingState label={t('loading', lang)} />}

        {!loading && error && (
          <PhoenixErrorState title={t('load_error', lang)} message={error} onRetry={reload} />
        )}

        {!loading && !error && !ok && (
          <div style={{ textAlign: 'center', padding: '48px 24px' }}>
            <div style={{ fontSize: '40px', marginBottom: '12px' }}>🚫</div>
            <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '6px' }}>{t('qr_invalid', lang)}</div>
            <p style={{ fontSize: '12.5px', color: 'var(--t2)' }}>{t('qr_scan_again', lang)}</p>
          </div>
        )}

        {!loading && !error && ok && (
          <>
            {/* Org/point header */}
            {orgName && (
              <div style={{ background: 'var(--p2)', borderRadius: 'var(--r3)', padding: '14px 16px', marginBottom: '16px', boxShadow: 'var(--sh-sm)' }}>
                <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--pd)' }}>{orgName}</div>
                {typeof payload?.point_label === 'string' && (
                  <div style={{ fontSize: '12px', color: 'var(--pd)', marginTop: '2px' }}>{payload.point_label as string}</div>
                )}
                {rawItems.length > 0 && (
                  <div style={{ fontSize: '11px', color: 'var(--pd)', marginTop: '6px', opacity: 0.8 }}>
                    {t('public_items_count', lang)}: {rawItems.length}
                  </div>
                )}
              </div>
            )}

            {/* Status summary — counts computed from the already-loaded rawItems only */}
            {summaryCounts.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
                {summaryCounts.map(({ condition, count }) => {
                  const variant = CONDITION_VARIANT[condition] ?? 'neutral';
                  const { color, bg } = VARIANT_COLOR[variant];
                  return (
                    <span
                      key={condition}
                      style={{ fontSize: '10.5px', fontWeight: 700, color, background: bg, border: `1px solid ${color}`, borderRadius: 'var(--rpill)', padding: '3px 10px' }}
                    >
                      {conditionLabel(condition, lang)}: {count}
                    </span>
                  );
                })}
              </div>
            )}

            {/* Search */}
            {rawItems.length > 3 && (
              <div style={{ position: 'relative', marginBottom: '12px' }}>
                <span style={{ position: 'absolute', insetInlineStart: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '14px', pointerEvents: 'none' }}>🔍</span>
                <input
                  type="search"
                  placeholder={t('public_search', lang)}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ width: '100%', padding: '9px 10px', paddingInlineStart: '34px', borderRadius: 'var(--r3)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '12.5px' }}
                  aria-label={t('public_search', lang)}
                />
              </div>
            )}

            {/* Items */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {rawItems.length === 0 && (
                <div style={{ textAlign: 'center', padding: '32px', color: 'var(--t2)', fontSize: '12.5px' }}>
                  {t('public_empty_port', lang)}
                </div>
              )}
              {filteredItems.length === 0 && rawItems.length > 0 && search && (
                <div style={{ textAlign: 'center', padding: '20px', color: 'var(--t2)', fontSize: '12.5px' }}>
                  {t('empty_items', lang)}
                </div>
              )}
              {filteredItems.map((item, i) => {
                const label = itemLabel(item, lang);
                const variant = item.condition ? CONDITION_VARIANT[item.condition] ?? 'neutral' : 'neutral';
                const condLabel = item.condition ? conditionLabel(item.condition, lang) : '';
                const isNearExpiry = item.condition === 'near_expiry' || item.condition === 'expired';
                const bucketBadge = getExpBucketBadge(item.expiry_bucket, lang);
                return (
                  <div key={i} style={{ background: 'var(--s)', borderRadius: 'var(--r3)', padding: '12px 14px', border: `1px solid ${bucketBadge ? bucketBadge.color : 'var(--brd)'}`, boxShadow: 'var(--sh-xs)', transition: 'box-shadow 150ms' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ fontSize: '12.5px', fontWeight: 600 }} dir="auto">{label}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0 }}>
                        {bucketBadge && (
                          <span style={{ padding: '1px 7px', borderRadius: 'var(--rpill)', border: `1px solid ${bucketBadge.color}`, background: bucketBadge.bg, color: bucketBadge.color, fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap' }}>
                            {bucketBadge.label}
                          </span>
                        )}
                        {condLabel && (
                          <PhoenixStatusBadge variant={variant} label={condLabel} />
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '5px', fontSize: '11px', color: 'var(--t2)' }}>
                      {typeof item.quantity === 'number' && variant !== 'err' && (
                        <span>{item.quantity}{item.unit ? ` ${item.unit}` : ''}</span>
                      )}
                      {item.expiry_date && isNearExpiry && (
                        <span style={{ color: bucketBadge ? bucketBadge.color : 'var(--warn)' }} dir="ltr">
                          ⏱ {t('public_expiry_warn', lang)} {item.expiry_date}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: '16px', padding: '10px 12px', borderRadius: 'var(--r2)', background: 'var(--s2)', border: '1px solid var(--brd)', fontSize: '11px', color: 'var(--t3)', textAlign: 'center' }}>
              🔒 {t('qr_no_expose', lang)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
