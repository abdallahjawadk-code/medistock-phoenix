import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';

const PUBLIC_ITEMS = [
  { name: 'Amoxicillin 500mg',  statusKey: 'avail', variant: 'ok'   as const },
  { name: 'Paracetamol 500mg',  statusKey: 'avail', variant: 'ok'   as const },
  { name: 'Ceftriaxone 1g',     statusKey: 'low',   variant: 'warn' as const },
  { name: 'Insulin Glargine',   statusKey: 'miss',  variant: 'err'  as const },
];

export function QrScreen() {
  const { lang } = useApp();
  const isMobile = window.innerWidth < 768;

  return (
    <div style={{ maxWidth: '900px', animation: 'fs .3s ease' }}>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_qr', lang)}</h2>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('qr_sub', lang)}</p>
      </div>

      {/* Privacy notice */}
      <div style={{ background: 'var(--p2)', border: '1px solid var(--p)', borderRadius: 'var(--r3)', padding: '14px 16px', marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
        <span style={{ fontSize: '18px', flexShrink: 0, marginTop: '1px' }}>🔐</span>
        <div>
          <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--pd)', marginBottom: '3px' }}>{t('privacy_title', lang)}</div>
          <p style={{ fontSize: '12px', color: 'var(--pd)', lineHeight: 1.55 }}>{t('qr_privacy', lang)}</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '220px 1fr', gap: '20px', alignItems: 'start' }}>
        {/* QR preview */}
        <PhoenixCard shadow="md" padding="22px" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '4px' }}>{t('marjan', lang)}</div>
          <div style={{ fontSize: '11px', color: 'var(--t2)', marginBottom: '16px' }}>{t('qr_public_label', lang)}</div>
          <div style={{ display: 'inline-block', padding: '10px', background: '#fff', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', marginBottom: '14px' }}>
            <svg width="120" height="120" viewBox="0 0 25 25" style={{ display: 'block' }} aria-label="QR Code (demo)">
              <rect width="25" height="25" fill="white" />
              <rect x="1" y="1" width="7" height="7" rx="0.5" fill="#0D9488" opacity=".9" />
              <rect x="2" y="2" width="5" height="5" rx="0.3" fill="white" />
              <rect x="3" y="3" width="3" height="3" rx="0.2" fill="#0D9488" />
              <rect x="17" y="1" width="7" height="7" rx="0.5" fill="#0D9488" opacity=".9" />
              <rect x="18" y="2" width="5" height="5" rx="0.3" fill="white" />
              <rect x="19" y="3" width="3" height="3" rx="0.2" fill="#0D9488" />
              <rect x="1" y="17" width="7" height="7" rx="0.5" fill="#0D9488" opacity=".9" />
              <rect x="2" y="18" width="5" height="5" rx="0.3" fill="white" />
              <rect x="3" y="19" width="3" height="3" rx="0.2" fill="#0D9488" />
              <rect x="10" y="1" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="12" y="1" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="14" y="1" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="10" y="3" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="13" y="3" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="10" y="5" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="12" y="5" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="14" y="5" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="10" y="10" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="13" y="10" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="10" y="12" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="12" y="12" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="17" y="10" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="20" y="10" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="17" y="17" width="1.5" height="1.5" fill="#0F2B4F" />
              <rect x="20" y="20" width="1.5" height="1.5" fill="#0F2B4F" />
            </svg>
          </div>
          <div style={{ fontSize: '10px', color: 'var(--t3)', fontFamily: 'monospace', marginBottom: '10px' }} dir="ltr">QR-BBL-MRJ-2026</div>
          <PhoenixStatusBadge variant="ok" label={`● ${t('qr_active', lang)}`} dot={false} />
        </PhoenixCard>

        {/* Public availability list */}
        <div>
          <h3 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '12px' }}>{t('qr_public_avail', lang)}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
            {PUBLIC_ITEMS.map(item => (
              <div key={item.name} style={{ background: 'var(--s)', borderRadius: 'var(--r3)', padding: '12px 14px', boxShadow: 'var(--sh-xs)', border: '1px solid var(--brd)', opacity: item.variant === 'err' ? 0.6 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <span style={{ fontSize: '12.5px', fontWeight: 600 }}>{item.name}</span>
                  <PhoenixStatusBadge variant={item.variant} label={t(item.statusKey, lang)} />
                </div>
                {item.variant !== 'err' && (
                  <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '3px' }}>
                    {t('last_upd', lang)}: {t('today', lang)}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ padding: '10px 12px', borderRadius: 'var(--r2)', background: 'var(--s2)', border: '1px solid var(--brd)', fontSize: '11px', color: 'var(--t3)' }}>
            🔒 {t('qr_no_expose', lang)}
          </div>
        </div>
      </div>
    </div>
  );
}
