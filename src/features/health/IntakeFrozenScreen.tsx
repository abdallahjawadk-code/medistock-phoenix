import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon, type PhoenixIconName } from '@/shared/ui/PhoenixIcon';
import { PhoenixScreenHeader } from '@/shared/ui/PhoenixScreenHeader';
import { PhoenixNotice } from '@/shared/ui/PhoenixNotice';

const BLOCKED: Array<{ icon: PhoenixIconName; label: string }> = [
  { icon: 'reports', label: 'Excel Import' },
  { icon: 'camera', label: 'OCR Scan' },
  { icon: 'file', label: 'CSV Upload' },
  { icon: 'spark', label: 'Doc Intelligence' },
  { icon: 'activity', label: 'Smart Intake' },
  { icon: 'editor', label: 'Smart Manual' },
];

interface Props { onNavigate: (screen: number) => void; }

export function IntakeFrozenScreen({ onNavigate: _onNavigate }: Props) {
  const { lang } = useApp();

  return (
    <div className="premium-page nexus-intake-page" style={{ maxWidth: '800px', animation: 'fs .3s ease' }}>
      <PhoenixScreenHeader
        icon="lock"
        eyebrow={lang === 'ar' ? 'PHOENIX CONTROL · وحدة محمية' : 'PHOENIX CONTROL · PROTECTED MODULE'}
        title={t('nav_intake', lang)}
        description={t('intake_sub', lang)}
      />

      {/* Frozen capsule visual */}
      <div style={{ background: 'var(--s2)', border: '2px dashed var(--t3)', borderRadius: 'var(--r5)', padding: '32px 24px', textAlign: 'center', marginBottom: '20px', position: 'relative', overflow: 'hidden' }}>
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(-45deg, transparent, transparent 8px, rgba(143,165,188,.06) 8px, rgba(143,165,188,.06) 9px)' }} />
        <div style={{ position: 'relative' }}>
          <div style={{ width: '80px', height: '80px', borderRadius: 'var(--r4)', background: 'var(--skel)', border: '2px solid var(--brd)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', color: 'var(--t2)', opacity: .8 }}><PhoenixIcon name="lock" size={36} /></div>
          <h3 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--t2)', marginBottom: '6px' }}>{t('intake_frozen', lang)}</h3>
          <span style={{ display: 'inline-block', padding: '4px 14px', borderRadius: 'var(--rpill)', background: 'var(--skel)', color: 'var(--t2)', fontSize: '11px', fontWeight: 700, marginBottom: '16px', border: '1px solid var(--brd)' }}>
            <PhoenixIcon name="lock" size={13} style={{ verticalAlign: 'middle', marginInlineEnd: '5px' }} /> {t('safe_frozen', lang)}
          </span>
          <p style={{ fontSize: '13px', color: 'var(--t2)', maxWidth: '500px', margin: '0 auto', lineHeight: 1.65 }}>
            {t('intake_disabled_msg', lang)}
          </p>
        </div>
      </div>

      {/* Blocked workflows */}
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('blocked_workflows', lang)}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))', gap: '10px', marginBottom: '20px' }}>
        {BLOCKED.map(item => (
          <div key={item.label} style={{ background: 'var(--s)', borderRadius: 'var(--r3)', padding: '14px', border: '1px solid var(--brd)', opacity: .55, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ flexShrink: 0, color: 'var(--t2)' }}><PhoenixIcon name={item.icon} size={21} /></span>
            <div>
              <div style={{ fontSize: '12.5px', fontWeight: 600 }}>{item.label}</div>
              <div style={{ fontSize: '10.5px', color: 'var(--t2)' }}>{t('blocked', lang)}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Safety notice bilingual */}
      <div className="nexus-intake-page__bilingual-warning" style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r3)', padding: '16px 18px', marginBottom: '16px' }}>
        <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--warn)', marginBottom: '6px' }} dir="rtl">
          هذه الوحدة معطلة عمدًا ولا يجوز إعادة تفعيلها دون تصميم مضبوط جديد.
        </div>
        <div style={{ fontSize: '12px', color: 'var(--warn)', marginTop: '6px', borderTop: '1px solid rgba(217,119,6,.2)', paddingTop: '10px' }} dir="ltr">
          This module is intentionally disabled and must not be reactivated without a new controlled design.
        </div>
      </div>

      {/* AVAILABILITY-EDITOR-VISIBLE-ENTRYPOINTS-HIDE-B: the redirect button to
          the Availability Editor (screen 3, nav_editor) was removed — no
          visible entry point to manual input remains on this screen. Kept as
          a neutral notice that Intake is frozen; no navigation offered. */}
      <PhoenixNotice tone="neutral" icon="lock">{t('intake_frozen', lang)}</PhoenixNotice>
    </div>
  );
}
