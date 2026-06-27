import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getPublicQrPayload } from '@/shared/supabase/services/qr.service';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';

interface Props { publicId: string; }

type PublicItem = {
  name?: string;
  name_ar?: string;
  point_name?: string;
  point_name_ar?: string;
  condition?: string;
  quantity?: number;
  unit?: string;
};

const CONDITION_VARIANT: Record<string, 'ok' | 'warn' | 'err' | 'neutral'> = {
  available: 'ok',
  surplus: 'ok',
  low_stock: 'warn',
  near_expiry: 'warn',
  missing: 'err',
  expired: 'err',
};

export function PublicQrScreen({ publicId }: Props) {
  const { lang, toggleLang } = useApp();
  const { data, loading, error, reload } = useAsync(
    () => getPublicQrPayload(publicId),
    [publicId],
  );

  const payload = (data ?? null) as Record<string, unknown> | null;
  const ok = payload?.ok === true;
  const orgName = lang === 'ar'
    ? (payload?.org_name_ar as string) ?? (payload?.org_name as string)
    : (payload?.org_name as string) ?? (payload?.org_name_ar as string);

  // Normalise the various payload shapes into one item list.
  const rawItems =
    (payload?.items as PublicItem[] | undefined) ??
    (payload?.availability as PublicItem[] | undefined) ??
    (payload?.points as PublicItem[] | undefined) ??
    [];

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
            {orgName && (
              <div style={{ background: 'var(--p2)', borderRadius: 'var(--r3)', padding: '14px 16px', marginBottom: '16px' }}>
                <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--pd)' }}>{orgName}</div>
                {typeof payload?.point_label === 'string' && (
                  <div style={{ fontSize: '12px', color: 'var(--pd)', marginTop: '2px' }}>{payload.point_label as string}</div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {rawItems.length === 0 && (
                <div style={{ textAlign: 'center', padding: '32px', color: 'var(--t2)', fontSize: '12.5px' }}>{t('empty_avail', lang)}</div>
              )}
              {rawItems.map((item, i) => {
                const label = lang === 'ar'
                  ? item.name_ar ?? item.name ?? item.point_name_ar ?? item.point_name
                  : item.name ?? item.name_ar ?? item.point_name ?? item.point_name_ar;
                const variant = item.condition ? CONDITION_VARIANT[item.condition] ?? 'neutral' : 'neutral';
                return (
                  <div key={i} style={{ background: 'var(--s)', borderRadius: 'var(--r3)', padding: '12px 14px', border: '1px solid var(--brd)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ fontSize: '12.5px', fontWeight: 600 }}>{label}</span>
                      {item.condition && (
                        <PhoenixStatusBadge variant={variant} label={item.condition} />
                      )}
                    </div>
                    {typeof item.quantity === 'number' && variant !== 'err' && (
                      <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '4px' }}>
                        {item.quantity}{item.unit ? ` ${item.unit}` : ''}
                      </div>
                    )}
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
