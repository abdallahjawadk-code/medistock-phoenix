import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';

const ITEMS = [
  { id: '1', nameEn: 'Amoxicillin',       nameAr: 'أموكسيسيلين',   code: 'BBL-001', unit: 'Capsule', mfr: 'Alkan Pharma',  cat: 'Antibiotics',   status: 'active', warn: false },
  { id: '2', nameEn: 'Paracetamol',        nameAr: 'باراسيتامول',   code: 'BBL-002', unit: 'Tablet',  mfr: 'SDI Pharma',    cat: 'Analgesics',    status: 'active', warn: false },
  { id: '3', nameEn: 'Metformin',          nameAr: 'ميتفورمين',     code: 'BBL-003', unit: 'Tablet',  mfr: 'Julphar',       cat: 'Antidiabetics', status: 'active', warn: false },
  { id: '4', nameEn: 'Insulin Glargine',   nameAr: 'إنسولين جلارجين', code: 'BBL-010', unit: 'Vial', mfr: 'Sanofi',        cat: 'Insulins',      status: 'inactive', warn: false },
  { id: '5', nameEn: 'Omeprazole',         nameAr: 'أوميبرازول',    code: 'BBL-004', unit: 'Capsule', mfr: 'AstraZeneca',   cat: 'Gastro',        status: 'active', warn: false },
  { id: '6', nameEn: 'Ceftriaxone 1g',     nameAr: 'سيفترياكسون',   code: 'BBL-005', unit: 'Vial',    mfr: 'Roche',         cat: 'Antibiotics',   status: 'active', warn: true },
];

export function RegistryScreen() {
  const { lang } = useApp();
  const [search, setSearch] = useState('');

  const filtered = ITEMS.filter(item =>
    item.nameEn.toLowerCase().includes(search.toLowerCase()) ||
    item.nameAr.includes(search) ||
    item.code.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ maxWidth: '1000px', animation: 'fs .3s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_reg', lang)}</h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('reg_sub', lang)}</p>
        </div>
        <button style={{ padding: '10px 16px', borderRadius: 'var(--r3)', border: 'none', background: 'var(--p)', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
          + {t('add_item', lang)}
        </button>
      </div>

      {/* Scope notice */}
      <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r3)', padding: '12px 14px', marginBottom: '16px', fontSize: '12.5px', color: 'var(--info)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        ℹ️ {t('scope_note', lang)}
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: '18px' }}>
        <span style={{ position: 'absolute', insetInlineStart: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '15px', pointerEvents: 'none' }}>🔍</span>
        <input
          type="search"
          placeholder={t('search', lang)}
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', paddingInlineStart: '38px', borderRadius: 'var(--r3)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' }}
          aria-label={t('search', lang)}
        />
      </div>

      {/* Items grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: '12px' }}>
        {filtered.map(item => (
          <PhoenixCard key={item.id} hover padding="16px" border={item.warn ? '1px solid var(--warn)' : undefined} style={{ opacity: item.status === 'inactive' ? 0.65 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginBottom: '10px' }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 700 }}>{item.nameEn}</div>
                <div style={{ fontSize: '11px', color: 'var(--t2)' }}>{item.nameAr}</div>
              </div>
              <PhoenixStatusBadge
                variant={item.status === 'active' ? 'ok' : 'neutral'}
                label={t(item.status === 'active' ? 'active' : 'inactive', lang)}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '11.5px' }}>
              <div><span style={{ color: 'var(--t2)' }}>{t('lcode', lang)}:</span> <span dir="ltr" style={{ fontFamily: 'monospace', fontWeight: 600 }}>{item.code}</span></div>
              <div><span style={{ color: 'var(--t2)' }}>{t('unit', lang)}:</span> {item.unit}</div>
              <div style={{ gridColumn: '1/-1' }}><span style={{ color: 'var(--t2)' }}>{t('mfr', lang)}:</span> {item.mfr}</div>
              <div style={{ gridColumn: '1/-1' }}><span style={{ color: 'var(--t2)' }}>{t('cat', lang)}:</span> {item.cat}</div>
            </div>
            {item.warn && (
              <div style={{ marginTop: '8px', padding: '6px 9px', borderRadius: 'var(--r1)', background: 'var(--warn2)', fontSize: '10.5px', color: 'var(--warn)', fontWeight: 600 }}>
                ⚠ {t('similar_warn', lang)}
              </div>
            )}
          </PhoenixCard>
        ))}
      </div>
    </div>
  );
}
