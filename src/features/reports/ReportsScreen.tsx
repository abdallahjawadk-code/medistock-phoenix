import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';

type ReportTab = 'summary' | 'low' | 'missing' | 'comparison' | 'audit';

const LOW_ITEMS = [
  { name: 'Amoxicillin 500mg', qty: '12 units', instKey: 'hilla',   code: 'BBL-001', warn: 'expires30' },
  { name: 'Metformin 850mg',   qty: '6 units',  instKey: 'mahawil', code: 'BBL-003', warn: undefined },
  { name: 'Ceftriaxone 1g',    qty: '9 vials',  instKey: 'marjan',  code: 'BBL-005', warn: undefined },
];

const MISSING_ITEMS = [
  { name: 'Insulin Glargine',    where: ['hilla', 'mahawil'] },
  { name: 'Epinephrine 1mg/mL',  where: ['babil'] },
];

const AUDIT_ROWS = [
  { ts: '2026-06-27 14:32', msgKey: 'ev1', where: 'marjan', actor: 'super_admin' },
  { ts: '2026-06-27 13:15', msgKey: 'ev2', where: 'hilla',  actor: 'system', warn: true },
  { ts: '2026-06-27 11:04', msgKey: 'ev3', where: 'babil',  actor: 'hospital_admin' },
  { ts: '2026-06-27 09:30', msgKey: 'ev4', where: 'system', actor: '' },
];

const COMPARISON = [
  { key: 'marjan',  pct: 94, c: 'var(--p)' },
  { key: 'babil',   pct: 97, c: 'var(--p)' },
  { key: 'mahawil', pct: 88, c: 'var(--ok)' },
  { key: 'hilla',   pct: 71, c: 'var(--warn)' },
];

export function ReportsScreen() {
  const { lang } = useApp();
  const [tab, setTab] = useState<ReportTab>('summary');
  const isMobile = window.innerWidth < 768;

  const tabStyle = (active: boolean) => ({
    flex: 1, minWidth: '80px', padding: '8px 10px', borderRadius: 'var(--r2)', border: 'none',
    background: active ? 'var(--p)' : 'transparent',
    color: active ? '#fff' : 'var(--t2)',
    fontSize: '12px', fontWeight: 600, cursor: 'pointer', transition: 'all 150ms', whiteSpace: 'nowrap' as const,
  });

  const TABS: Array<{ id: ReportTab; labelKey: string }> = [
    { id: 'summary',    labelKey: 'tab_summary' },
    { id: 'low',        labelKey: 'tab_low' },
    { id: 'missing',    labelKey: 'tab_miss' },
    { id: 'comparison', labelKey: 'tab_comp' },
    { id: 'audit',      labelKey: 'tab_audit' },
  ];

  return (
    <div style={{ maxWidth: '1100px', animation: 'fs .3s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_reports', lang)}</h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('reports_sub', lang)}</p>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button style={{ padding: '8px 14px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t2)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>🔍 {t('filter', lang)}</button>
          <button style={{ padding: '8px 14px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t2)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>📥 {t('export_csv', lang)}</button>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '20px', background: 'var(--s2)', borderRadius: 'var(--r3)', padding: '4px', border: '1px solid var(--brd)' }}>
        {TABS.map(tb => (
          <button key={tb.id} style={tabStyle(tab === tb.id)} onClick={() => setTab(tb.id)}>
            {t(tb.labelKey, lang)}
          </button>
        ))}
      </div>

      {/* Summary tab */}
      {tab === 'summary' && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: isMobile ? '10px' : '14px', animation: 'fs .25s ease' }}>
          {[
            { val: '1,248', k: 'm_avail', c: 'var(--ok)' },
            { val: 42,      k: 'm_low',   c: 'var(--warn)' },
            { val: 8,       k: 'm_miss',  c: 'var(--err)' },
            { val: 15,      k: 'm_exp',   c: 'var(--warn)' },
          ].map(item => (
            <PhoenixCard key={item.k} padding="18px">
              <div style={{ fontSize: '26px', fontWeight: 700, color: item.c }}>{item.val}</div>
              <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>{t(item.k, lang)}</div>
            </PhoenixCard>
          ))}
        </div>
      )}

      {/* Low stock tab */}
      {tab === 'low' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', animation: 'fs .25s ease' }}>
          {LOW_ITEMS.map(item => (
            <div key={item.name} style={{ background: 'var(--s)', borderRadius: 'var(--r3)', padding: '14px', boxShadow: 'var(--sh-xs)', border: '1px solid var(--brd)', borderInlineStart: '3px solid var(--warn)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '6px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600 }}>{item.name}</span>
                <span style={{ padding: '2px 8px', borderRadius: 'var(--rpill)', background: 'var(--warn2)', color: 'var(--warn)', fontSize: '10.5px', fontWeight: 700 }}>{item.qty}</span>
              </div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '11px', color: 'var(--t2)' }}>
                <span>🏥 {t(item.instKey, lang)}</span>
                <span dir="ltr">{item.code}</span>
                {item.warn && <span>{t(item.warn, lang)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Missing tab */}
      {tab === 'missing' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', animation: 'fs .25s ease' }}>
          {MISSING_ITEMS.map(item => (
            <div key={item.name} style={{ background: 'var(--s)', borderRadius: 'var(--r3)', padding: '14px', boxShadow: 'var(--sh-xs)', border: '1px solid var(--err)', borderInlineStart: '3px solid var(--err)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '6px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600 }}>{item.name}</span>
                <span style={{ padding: '2px 8px', borderRadius: 'var(--rpill)', background: 'var(--err2)', color: 'var(--err)', fontSize: '10.5px', fontWeight: 700 }}>{t('miss', lang)}</span>
              </div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '11px', color: 'var(--t2)' }}>
                {item.where.map(w => <span key={w}>🏥 {t(w, lang)}</span>)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Comparison tab */}
      {tab === 'comparison' && (
        <PhoenixCard padding="18px" style={{ animation: 'fs .25s ease' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {COMPARISON.map(c => (
              <div key={c.key} style={{ fontSize: '12.5px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}>
                  <span style={{ fontWeight: 600 }}>{t(c.key, lang)}</span>
                  <span style={{ fontSize: '11px', color: c.c }}>{c.pct}%</span>
                </div>
                <div style={{ height: '8px', background: 'var(--brd)', borderRadius: 'var(--rpill)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${c.pct}%`, background: c.c, borderRadius: 'var(--rpill)' }} />
                </div>
              </div>
            ))}
          </div>
        </PhoenixCard>
      )}

      {/* Audit tab */}
      {tab === 'audit' && (
        <PhoenixCard padding="16px" style={{ animation: 'fs .25s ease' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {AUDIT_ROWS.map((row, i) => (
              <div key={i} style={{ display: 'flex', gap: '12px', padding: '12px 0', borderBottom: i < AUDIT_ROWS.length - 1 ? '1px solid var(--brd)' : undefined }}>
                <div style={{ fontSize: '10px', color: 'var(--t3)', whiteSpace: 'nowrap', fontFamily: 'monospace', marginTop: '2px' }} dir="ltr">{row.ts}</div>
                <div>
                  <div style={{ fontSize: '12.5px', fontWeight: 600, color: row.warn ? 'var(--warn)' : undefined }}>{t(row.msgKey, lang)}</div>
                  <div style={{ fontSize: '11px', color: 'var(--t2)' }}>{t(row.where, lang)}{row.actor ? ` · ${row.actor}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
        </PhoenixCard>
      )}
    </div>
  );
}
