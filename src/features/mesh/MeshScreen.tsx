import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';

type MeshNode = 'marjan' | 'hilla' | 'babil' | 'mahawil';

const MESH_DATA: Record<MeshNode, { dot: string; statusKey: string; avail: number; low: number; miss: number; bridge: string; statusVariant: 'ok' | 'warn'; pct: number; borderColor?: string }> = {
  marjan:  { dot: 'var(--ok)',   statusKey: 'healthy',  avail: 342, low: 8,  miss: 1, bridge: '98%',  statusVariant: 'ok',   pct: 94 },
  hilla:   { dot: 'var(--warn)', statusKey: 'safemode', avail: 291, low: 18, miss: 4, bridge: '74%',  statusVariant: 'warn', pct: 71, borderColor: 'var(--warn)' },
  babil:   { dot: 'var(--ok)',   statusKey: 'healthy',  avail: 412, low: 7,  miss: 2, bridge: '100%', statusVariant: 'ok',   pct: 97 },
  mahawil: { dot: 'var(--ok)',   statusKey: 'healthy',  avail: 203, low: 9,  miss: 1, bridge: '88%',  statusVariant: 'ok',   pct: 88 },
};

interface Props { onNavigate: (screen: number) => void; }

export function MeshScreen({ onNavigate }: Props) {
  const { lang } = useApp();
  const [selected, setSelected] = useState<MeshNode | null>(null);
  const isMobile = window.innerWidth < 768;

  const toggle = (n: MeshNode) => setSelected(s => s === n ? null : n);
  const md = selected ? MESH_DATA[selected] : null;

  const NodeCard = ({ code }: { code: MeshNode }) => {
    const d = MESH_DATA[code];
    const isSelected = selected === code;
    return (
      <PhoenixCard
        onClick={() => toggle(code)}
        hover
        padding="14px"
        border={isSelected ? `2px solid ${d.dot}` : `1px solid ${d.borderColor ?? 'var(--brd)'}`}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '8px' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: d.dot, flexShrink: 0 }} />
          <span style={{ fontSize: '12px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{t(code, lang)}</span>
          {code === 'hilla' && <PhoenixStatusBadge variant="warn" label={t('safemode', lang)} />}
        </div>
        <div style={{ fontSize: '10.5px', color: 'var(--t2)' }}>{d.avail} {t('avail', lang)} · {d.low} {t('low', lang)}</div>
        <div style={{ marginTop: '7px', height: '3px', background: 'var(--brd)', borderRadius: 'var(--rpill)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${d.pct}%`, background: d.dot, borderRadius: 'var(--rpill)' }} />
        </div>
      </PhoenixCard>
    );
  };

  return (
    <div style={{ maxWidth: '1100px', animation: 'fs .3s ease' }}>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_mesh', lang)}</h2>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('mesh_sub', lang)}</p>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '20px' }}>
        {[
          { c: 'ok',   k: 'healthy' },
          { c: 'warn', k: 'safemode' },
          { c: 'err',  k: 'quarantine' },
          { c: 't3',   k: 'frozen' },
        ].map(item => (
          <span key={item.k} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11.5px' }}>
            <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: `var(--${item.c})`, display: 'inline-block' }} />
            {t(item.k, lang)}
          </span>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : (selected ? '1fr 280px' : '1fr'), gap: '16px', alignItems: 'start' }}>
        {/* Mesh canvas */}
        <div>
          {/* Row 1 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
            <NodeCard code="marjan" />
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <div style={{ height: '2px', width: '40px', background: 'linear-gradient(to right, var(--p), var(--p2), var(--p))', borderRadius: 'var(--rpill)', animation: 'bp 3s ease-in-out infinite' }} />
              <span style={{ fontSize: '9px', color: 'var(--t3)', whiteSpace: 'nowrap' }}>bridge</span>
            </div>
            <NodeCard code="hilla" />
          </div>
          {/* Vertical connectors */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', marginBottom: '8px', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}><div style={{ width: '2px', height: '28px', background: 'linear-gradient(to bottom, var(--p), var(--p2))', borderRadius: 'var(--rpill)', animation: 'bp 4.5s ease-in-out infinite' }} /></div>
            <div />
            <div style={{ display: 'flex', justifyContent: 'center' }}><div style={{ width: '2px', height: '28px', background: 'linear-gradient(to bottom, var(--warn), var(--warn2))', borderRadius: 'var(--rpill)', animation: 'bp 4.5s ease-in-out infinite 1s' }} /></div>
          </div>
          {/* Row 2 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '8px', alignItems: 'center' }}>
            <NodeCard code="babil" />
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <div style={{ height: '2px', width: '40px', background: 'linear-gradient(to right, var(--p), var(--p2), var(--p))', borderRadius: 'var(--rpill)', animation: 'bp 3.5s ease-in-out infinite .7s' }} />
              <span style={{ fontSize: '9px', color: 'var(--t3)', whiteSpace: 'nowrap' }}>bridge</span>
            </div>
            <NodeCard code="mahawil" />
          </div>
        </div>

        {/* Detail panel */}
        {selected && md && (
          <PhoenixCard shadow="md" padding="18px" style={{ animation: 'fs .25s ease' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: md.dot, flexShrink: 0 }} />
              <h3 style={{ fontSize: '14px', fontWeight: 700, flex: 1 }}>{t(selected, lang)}</h3>
              <PhoenixStatusBadge variant={md.statusVariant} label={t(md.statusKey, lang)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12.5px' }}>
              {[
                { label: 'avail', val: md.avail, color: undefined },
                { label: 'low',   val: md.low,   color: 'var(--warn)' },
                { label: 'miss',  val: md.miss,  color: 'var(--err)' },
                { label: 'm_bridge', val: md.bridge, color: 'var(--p)' },
              ].map(row => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: row.label !== 'm_bridge' ? '1px solid var(--brd)' : undefined }}>
                  <span style={{ color: 'var(--t2)' }}>{t(row.label, lang)}</span>
                  <strong style={{ color: row.color }}>{row.val}</strong>
                </div>
              ))}
            </div>
            <PhoenixButton variant="primary" size="md" fullWidth style={{ marginTop: '14px' }} onClick={() => onNavigate(3)}>
              ✏️ {t('nav_editor', lang)}
            </PhoenixButton>
          </PhoenixCard>
        )}
      </div>
    </div>
  );
}
