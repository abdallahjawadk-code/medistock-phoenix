import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getQrTokensByOrg, disableQrToken } from '@/shared/supabase/services/qr.service';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';

interface TargetRef { target_type: string; target_id: string; label: string | null; status: string; }
interface TokenRow {
  id: string;
  public_id: string;
  status: string;
  last_scanned_at: string | null;
  scan_count: number;
  created_at: string;
  qr_targets: TargetRef | TargetRef[] | null;
}

function target(row: TokenRow): TargetRef | null {
  const tg = row.qr_targets;
  if (!tg) return null;
  return Array.isArray(tg) ? tg[0] ?? null : tg;
}

export function QrScreen() {
  const { lang, activeOrgId, role } = useApp();
  const canManage = role === 'super_admin' || role === 'hospital_admin' || role === 'warehouse_manager';
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync(
    () => activeOrgId ? getQrTokensByOrg(activeOrgId) : Promise.resolve([]),
    [activeOrgId],
  );
  const rows = (data ?? []) as unknown as TokenRow[];

  async function onDisable(id: string) {
    setBusyId(id);
    try {
      await disableQrToken(id);
      reload();
    } catch (e) {
      console.error('[phoenix] disable QR failed:', e);
    } finally {
      setBusyId(null);
    }
  }

  const publicUrl = (publicId: string) => `${window.location.origin}/?qid=${publicId}`;

  return (
    <div style={{ maxWidth: '900px', animation: 'fs .3s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_qr', lang)}</h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('qr_sub', lang)}</p>
        </div>
        <PhoenixOrgScope />
      </div>

      {/* Privacy notice */}
      <div style={{ background: 'var(--p2)', border: '1px solid var(--p)', borderRadius: 'var(--r3)', padding: '14px 16px', marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
        <span style={{ fontSize: '18px', flexShrink: 0, marginTop: '1px' }}>🔐</span>
        <div>
          <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--pd)', marginBottom: '3px' }}>{t('privacy_title', lang)}</div>
          <p style={{ fontSize: '12px', color: 'var(--pd)', lineHeight: 1.55 }}>{t('qr_privacy', lang)}</p>
        </div>
      </div>

      {!activeOrgId && (
        <PhoenixEmptyState icon="📱" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} />
      )}
      {activeOrgId && loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {activeOrgId && !loading && error && (
        <PhoenixErrorState title={t('load_error', lang)} message={error} onRetry={reload} />
      )}
      {activeOrgId && !loading && !error && rows.length === 0 && (
        <PhoenixEmptyState icon="📱" title={t('empty_qr', lang)} description={t('empty_hint', lang)} />
      )}

      {activeOrgId && !loading && !error && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {rows.map(row => {
            const tg = target(row);
            const active = row.status === 'active';
            return (
              <PhoenixCard key={row.id} padding="14px 16px">
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700 }}>{tg?.label ?? tg?.target_type ?? '—'}</span>
                      <PhoenixStatusBadge variant={active ? 'ok' : 'neutral'} label={active ? t('qr_active', lang) : t('inactive', lang)} />
                    </div>
                    <div style={{ fontSize: '10.5px', color: 'var(--t3)', fontFamily: 'monospace' }} dir="ltr">{publicUrl(row.public_id)}</div>
                    <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '3px' }}>
                      {tg?.target_type} · {t('last_upd', lang)}: {row.last_scanned_at ? new Date(row.last_scanned_at).toLocaleString(lang === 'ar' ? 'ar' : 'en') : '—'} · {row.scan_count} scans
                    </div>
                  </div>
                  {canManage && active && (
                    <PhoenixButton variant="warn" size="sm" loading={busyId === row.id} onClick={() => onDisable(row.id)}>
                      🚫 {t('blocked', lang)}
                    </PhoenixButton>
                  )}
                </div>
              </PhoenixCard>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: '16px', padding: '10px 12px', borderRadius: 'var(--r2)', background: 'var(--s2)', border: '1px solid var(--brd)', fontSize: '11px', color: 'var(--t3)' }}>
        🔒 {t('qr_no_expose', lang)}
      </div>
    </div>
  );
}
