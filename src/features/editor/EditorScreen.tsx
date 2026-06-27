import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';

type InstCode = 'marjan' | 'hilla' | 'babil' | 'mahawil';
type TabType = 'single' | 'batch';

const INSTS: Array<{ id: InstCode; labelKey: string; icon: string }> = [
  { id: 'marjan',  labelKey: 'marjan',  icon: '🏥' },
  { id: 'hilla',   labelKey: 'hilla',   icon: '⚠️' },
  { id: 'babil',   labelKey: 'babil',   icon: '🏥' },
  { id: 'mahawil', labelKey: 'mahawil', icon: '🏥' },
];

const ITEMS = ['Amoxicillin 500mg Capsule', 'Paracetamol 500mg Tab', 'Metformin 850mg Tab', 'Omeprazole 20mg Cap', 'Ceftriaxone 1g Vial'];
const UNITS = ['Capsule / كبسولة', 'Tablet / قرص', 'Vial / أمبول', 'Bottle / زجاجة'];

interface BatchRow { name: string; qty: number; }

export function EditorScreen() {
  const { lang } = useApp();
  const [inst, setInst] = useState<InstCode>('marjan');
  const [tab, setTab] = useState<TabType>('single');
  const [showConfirm, setShowConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [qty, setQty] = useState(50);
  const [batchRows] = useState<BatchRow[]>([
    { name: 'Amoxicillin 500mg', qty: 120 },
    { name: 'Metformin 850mg',   qty: -5 },
    { name: 'Omeprazole 20mg',   qty: 80 },
  ]);

  const hasBlocker = batchRows.some(r => r.qty <= 0);
  const safeCount  = batchRows.filter(r => r.qty > 0).length;

  function doApply() {
    setShowConfirm(false);
    const msg = t('apply_success', lang);
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  const tabStyle = (active: boolean) => ({
    flex: 1, padding: '9px 12px', borderRadius: 'var(--r2)', border: 'none',
    background: active ? 'var(--p)' : 'transparent',
    color: active ? '#fff' : 'var(--t2)',
    fontSize: '13px', fontWeight: 600, cursor: 'pointer',
    transition: 'all 150ms',
    boxShadow: active ? 'var(--sh-sm)' : 'none',
  });

  return (
    <div style={{ maxWidth: '900px', animation: 'fs .3s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_editor', lang)}</h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('editor_sub', lang)}</p>
        </div>
        <span style={{ padding: '4px 10px', borderRadius: 'var(--rpill)', background: 'var(--p2)', color: 'var(--pd)', fontSize: '11px', fontWeight: 700 }}>
          🏥 {t('scope', lang)}
        </span>
      </div>

      {/* Institution selector */}
      <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
        <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 700, color: 'var(--t2)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '.5px' }}>
          {t('select_inst', lang)}
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
          {INSTS.map(i => (
            <button
              key={i.id}
              onClick={() => setInst(i.id)}
              style={{
                padding: '9px 12px', borderRadius: 'var(--r2)',
                border: `2px solid ${inst === i.id ? 'var(--p)' : 'var(--brd)'}`,
                background: inst === i.id ? 'var(--p2)' : 'var(--s2)',
                color: 'var(--t)', fontSize: '12px', fontWeight: 600,
                transition: 'all 120ms', textAlign: 'start', cursor: 'pointer',
              }}
            >
              {i.icon} {t(i.labelKey, lang)}
            </button>
          ))}
        </div>
      </PhoenixCard>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '16px', background: 'var(--s2)', borderRadius: 'var(--r3)', padding: '4px', border: '1px solid var(--brd)' }}>
        <button style={tabStyle(tab === 'single')} onClick={() => setTab('single')}>{t('single', lang)}</button>
        <button style={tabStyle(tab === 'batch')}  onClick={() => setTab('batch')}>{t('batch', lang)}</button>
      </div>

      {/* Single entry */}
      {tab === 'single' && (
        <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('item', lang)} *</label>
              <select style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px', appearance: 'none', cursor: 'pointer' }}>
                {ITEMS.map(item => <option key={item}>{item}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('qty', lang)} *</label>
              <input type="number" value={qty} onChange={e => setQty(Number(e.target.value))} style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)', border: `1px solid ${qty <= 0 ? 'var(--err)' : 'var(--brd)'}`, background: qty <= 0 ? 'var(--err2)' : 'var(--s)', color: 'var(--t)', fontSize: '13px' }} aria-label={t('qty', lang)} />
              {qty <= 0 && <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>⚠ {t('qty_err', lang)}</p>}
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('unit', lang)}</label>
              <select style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px', appearance: 'none', cursor: 'pointer' }}>
                {UNITS.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('batch_no', lang)} <span dir="ltr" style={{ fontFamily: 'monospace', fontSize: '10px', fontWeight: 400, color: 'var(--t3)' }}>(LTR ID)</span></label>
              <input type="text" placeholder="BCH-2024-001" dir="ltr" style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px', fontFamily: 'monospace' }} aria-label={t('batch_no', lang)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('expiry', lang)}</label>
              <input type="date" style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' }} aria-label={t('expiry', lang)} />
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('notes', lang)}</label>
              <textarea rows={2} placeholder={t('notes_ph', lang)} style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px', resize: 'vertical' }} aria-label={t('notes', lang)} />
            </div>
          </div>
        </PhoenixCard>
      )}

      {/* Batch entry */}
      {tab === 'batch' && (
        <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' }}>
            <p style={{ fontSize: '13px', fontWeight: 600 }}>{t('batch_items', lang)}</p>
            <button style={{ padding: '7px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--p)', background: 'var(--p2)', color: 'var(--pd)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
              + {t('add_row', lang)}
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {batchRows.map((row, i) => {
              const isErr = row.qty <= 0;
              return (
                <div key={i} style={{ background: 'var(--s2)', borderRadius: 'var(--r3)', padding: '13px', border: `1px solid ${isErr ? 'var(--err)' : 'var(--brd)'}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '12.5px', fontWeight: 600 }}>{row.name}</span>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '12px', color: 'var(--t2)' }}>Qty:</span>
                      <input type="number" defaultValue={row.qty} style={{ width: '70px', padding: '5px 8px', borderRadius: 'var(--r1)', border: `1px solid ${isErr ? 'var(--err)' : 'var(--brd)'}`, background: isErr ? 'var(--err2)' : 'var(--s)', fontSize: '12px', color: 'var(--t)' }} aria-label="Quantity" />
                      <span style={{ padding: '2px 7px', borderRadius: 'var(--rpill)', background: isErr ? 'var(--err2)' : 'var(--ok2)', color: isErr ? 'var(--err)' : 'var(--ok)', fontSize: '10px', fontWeight: 700 }}>
                        {isErr ? `✗ ${t('invalid', lang)}` : `✓ ${t('valid', lang)}`}
                      </span>
                    </div>
                  </div>
                  {isErr && <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '6px' }}>⚠ {t('qty_err', lang)}</p>}
                </div>
              );
            })}
          </div>
        </PhoenixCard>
      )}

      {/* Review summary */}
      <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
        <h3 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '12px' }}>{t('review', lang)}</h3>
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--ok)', display: 'inline-block' }} />
            <span style={{ fontSize: '12.5px' }}><strong>{safeCount}</strong> {t('safe_count', lang)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--err)', display: 'inline-block' }} />
            <span style={{ fontSize: '12.5px' }}><strong>{hasBlocker ? 1 : 0}</strong> {t('blocker', lang)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--warn)', display: 'inline-block' }} />
            <span style={{ fontSize: '12.5px' }}><strong>0</strong> {t('warnings', lang)}</span>
          </div>
        </div>
        {hasBlocker && (
          <div style={{ padding: '10px 12px', borderRadius: 'var(--r2)', background: 'var(--err2)', border: '1px solid var(--err)', fontSize: '12px', color: 'var(--err)' }}>
            {t('blocker_msg', lang)}
          </div>
        )}
      </PhoenixCard>

      <PhoenixButton
        variant="primary" size="lg" fullWidth
        disabled={hasBlocker}
        onClick={() => setShowConfirm(true)}
        style={{ boxShadow: '0 4px 16px rgba(13,148,136,.28)' }}
      >
        ✅ {t('apply', lang)}
      </PhoenixButton>
      <p style={{ textAlign: 'center', fontSize: '11px', color: 'var(--t3)', marginTop: '8px' }}>{t('apply_note', lang)}</p>

      {/* Confirm dialog */}
      <PhoenixDialog open={showConfirm} onClose={() => setShowConfirm(false)} title={t('confirm_apply', lang)}>
        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'var(--warn2)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: '26px' }}>⚠️</div>
          <p style={{ fontSize: '13px', color: 'var(--t2)', lineHeight: 1.65 }}>{t('confirm_msg', lang)}</p>
        </div>
        <div style={{ background: 'var(--s2)', borderRadius: 'var(--r3)', padding: '12px 14px', marginBottom: '20px', fontSize: '12px', color: 'var(--t2)', border: '1px solid var(--brd)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <span>{t('m_inst', lang)}:</span><strong>{t('marjan', lang)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <span>{t('mode', lang)}:</span><strong>{tab === 'single' ? t('single', lang) : t('batch', lang)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{t('safe_count', lang)}:</span><strong style={{ color: 'var(--ok)' }}>{safeCount}</strong>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} onClick={() => setShowConfirm(false)}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="primary" size="md" style={{ flex: 2 }} onClick={doApply}>✅ {t('confirm_btn', lang)}</PhoenixButton>
        </div>
      </PhoenixDialog>

      {toast && <PhoenixToast message={toast} />}
    </div>
  );
}
