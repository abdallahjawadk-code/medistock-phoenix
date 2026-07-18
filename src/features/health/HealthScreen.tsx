import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixScreenHeader } from '@/shared/ui/PhoenixScreenHeader';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixNotice } from '@/shared/ui/PhoenixNotice';

const MODULES = [
  { id: 'h1', dot: 'ok',   statusKey: 'healthy',  labelKey: 'mod_avail_read', border: undefined, details: [{ l: 'Uptime', v: '99.8%', c: 'var(--ok)' }, { l: 'Latency', v: '42ms' }, { l: 'Last Upd', v: '14:32' }, { l: 'Bridge', v: 'Connected', c: 'var(--p)' }] },
  { id: 'h2', dot: 'warn', statusKey: 'safemode', labelKey: 'mod_editor',     border: 'var(--warn)', details: [{ l: 'Uptime', v: '96.2%', c: 'var(--warn)' }, { l: 'Pending', v: '0 actions' }] },
  { id: 'h3', dot: 'ok',   statusKey: 'healthy',  labelKey: 'mod_qr',         border: undefined, details: [{ l: 'QR Active', v: '4/4', c: 'var(--ok)' }, { l: 'Scans/day', v: '~127' }] },
  { id: 'h4', dot: 't3',   statusKey: 'frozen',   labelKey: 'mod_intake',     border: undefined, frozen: true, details: [] },
];

const EVENTS = [
  { time: '14:32', msgKey: 'ev1', where: 'marjan', color: undefined },
  { time: '13:15', msgKey: 'ev2', where: 'hilla',  color: 'var(--warn)' },
  { time: '11:04', msgKey: 'ev3', where: 'babil',  color: undefined },
  { time: '09:30', msgKey: 'ev4', where: 'system', color: undefined },
];

export function HealthScreen() {
  const { lang } = useApp();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isMobile = window.innerWidth < 768;

  const toggle = (id: string) => setExpanded(e => ({ ...e, [id]: !e[id] }));

  return (
    <div className="premium-page nexus-health-page" style={{ maxWidth: '1000px', animation: 'fs .3s ease' }}>
      <PhoenixScreenHeader
        icon="health"
        eyebrow={lang === 'ar' ? 'PHOENIX HEALTH · مراقبة تشغيلية' : 'PHOENIX HEALTH · OPERATIONS WATCH'}
        title={t('nav_health', lang)}
        description={t('health_sub', lang)}
        actions={<PhoenixStatusBadge variant="ok" label={`● ${t('operational', lang)}`} />}
      />

      {/* Global status bar */}
      <PhoenixCard padding="16px 20px" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: '160px' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '50%', border: '2px solid var(--ok)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ok)' }}><PhoenixIcon name="health" size={20} /></div>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 700 }}>{t('global_status', lang)}</div>
              <div style={{ fontSize: '11.5px', color: 'var(--ok)' }}>{t('operational', lang)}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            {[{ n: 12, k: 'modules' }, { n: 9, k: 'healthy', c: 'ok' }, { n: 2, k: 'safemode', c: 'warn' }, { n: 1, k: 'frozen', c: 't3' }].map(item => (
              <div key={item.k} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '18px', fontWeight: 700, color: item.c ? `var(--${item.c})` : 'var(--p)' }}>{item.n}</div>
                <div style={{ fontSize: '10.5px', color: 'var(--t2)' }}>{t(item.k, lang)}</div>
              </div>
            ))}
          </div>
        </div>
      </PhoenixCard>

      {/* Module health */}
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('module_health', lang)}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
        {MODULES.map(mod => (
          <div key={mod.id} style={{ background: 'var(--s)', borderRadius: 'var(--r3)', boxShadow: 'var(--sh-xs)', border: `1px solid ${mod.border ?? 'var(--brd)'}`, overflow: 'hidden', opacity: mod.frozen ? 0.7 : 1 }}>
            <button
              onClick={() => toggle(mod.id)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px', border: 'none', background: 'transparent', color: 'var(--t)', textAlign: 'start', cursor: 'pointer', transition: 'all 120ms' }}
              aria-expanded={expanded[mod.id]}
            >
              <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: `var(--${mod.dot})`, flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: '13px', fontWeight: 600 }}>{t(mod.labelKey, lang)}</span>
              <PhoenixStatusBadge variant={mod.frozen ? 'neutral' : mod.dot === 'ok' ? 'ok' : 'warn'} label={t(mod.statusKey, lang)} />
              <span style={{ fontSize: '14px', color: 'var(--t2)', transition: 'transform 200ms', transform: expanded[mod.id] ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
            </button>
            {expanded[mod.id] && (
              <div style={{ padding: '0 16px 14px', borderTop: '1px solid var(--brd)', animation: 'fs .2s ease' }}>
                {mod.frozen ? (
                  <PhoenixNotice tone="neutral" icon="lock" className="nexus-notice--nested">{t('intake_frozen_note', lang)}</PhoenixNotice>
                ) : mod.id === 'h2' ? (
                  <>
                    <PhoenixNotice tone="warning" icon="shield" className="nexus-notice--nested">{t('safemode_desc', lang)} · {t('hilla', lang)}</PhoenixNotice>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginTop: '10px', fontSize: '12px' }}>
                      {mod.details.map(d => (
                        <div key={d.l} style={{ padding: '10px', borderRadius: 'var(--r2)', background: 'var(--s2)' }}>
                          <div style={{ color: 'var(--t2)', marginBottom: '4px' }}>{d.l}</div>
                          <div style={{ fontWeight: 700, color: d.c }}>{d.v}</div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginTop: '12px', fontSize: '12px' }}>
                    {mod.details.map(d => (
                      <div key={d.l} style={{ padding: '10px', borderRadius: 'var(--r2)', background: 'var(--s2)' }}>
                        <div style={{ color: 'var(--t2)', marginBottom: '4px' }}>{d.l}</div>
                        <div style={{ fontWeight: 700, color: d.c }}>{d.v}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Bridge governance + Recovery queue */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '16px' }}>
        <div>
          <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('bridge_gov', lang)}</h3>
          <PhoenixCard padding="16px">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12.5px' }}>
              {[{ from: 'marjan', to: 'babil', pct: '98%', c: 'ok' }, { from: 'hilla', to: 'mahawil', pct: '74%', c: 'warn' }, { from: 'babil', to: 'mahawil', pct: '100%', c: 'ok' }].map(b => (
                <div key={b.from + b.to} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0', borderBottom: b.from + b.to !== 'babilmahawil' ? '1px solid var(--brd)' : undefined }}>
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: `var(--${b.c})`, flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{t(b.from, lang)} → {t(b.to, lang)}</span>
                  <span style={{ color: `var(--${b.c})`, fontWeight: 600 }}>{b.pct}</span>
                </div>
              ))}
            </div>
          </PhoenixCard>
        </div>
        <div>
          <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('recovery_q', lang)}</h3>
          <PhoenixCard padding="16px">
            <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--t2)' }}>
              <div style={{ display: 'grid', placeItems: 'center', width: '42px', height: '42px', margin: '0 auto 8px', color: 'var(--ok)', background: 'var(--ok2)', borderRadius: '50%' }}><PhoenixIcon name="check" size={23} /></div>
              <div style={{ fontSize: '12.5px', fontWeight: 600 }}>{t('recovery_clear', lang)}</div>
              <div style={{ fontSize: '11px', color: 'var(--t3)', marginTop: '4px' }}>{t('demoData', lang)}</div>
            </div>
          </PhoenixCard>
        </div>
      </div>

      {/* Event log */}
      <h3 style={{ fontSize: '14px', fontWeight: 700, margin: '20px 0 12px' }}>{t('event_log', lang)}</h3>
      <PhoenixCard padding="16px">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {EVENTS.map((ev, i) => (
            <div key={i} style={{ display: 'flex', gap: '12px', padding: '10px 0', borderBottom: i < EVENTS.length - 1 ? '1px solid var(--brd)' : undefined }}>
              <div style={{ fontSize: '10px', color: 'var(--t3)', whiteSpace: 'nowrap', fontFamily: 'monospace' }} dir="ltr">{ev.time}</div>
              <div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: ev.color }}>{t(ev.msgKey, lang)}</div>
                <div style={{ fontSize: '11px', color: 'var(--t2)' }}>{t(ev.where, lang)}</div>
              </div>
            </div>
          ))}
        </div>
      </PhoenixCard>
    </div>
  );
}
