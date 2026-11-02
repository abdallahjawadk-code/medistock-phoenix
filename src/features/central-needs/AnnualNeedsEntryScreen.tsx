import { lazy, Suspense, useEffect, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { useManualNeedsTabGate } from './manual/manual-needs-gate';
import { getAnnualNeedsContract } from './annual-catalog/annual-needs.service';
import { CentralNeedsScreen } from './CentralNeedsScreen';
import './annual-needs-entry.css';

const ManualNeedsTab = lazy(() => import('./manual/ManualNeedsTab').then(module => ({ default: module.ManualNeedsTab })));
type ContractState = { key: string; status: 'checking' | 'ready' | 'absent' | 'failed' };

/** The normal annual-needs route shares the existing server-authorized journey. */
export function AnnualNeedsEntryScreen() {
  const { lang, activeOrgId, profile } = useApp(), ar = lang === 'ar';
  const gate = useManualNeedsTabGate(), key = JSON.stringify([activeOrgId, profile?.id, gate]);
  const [state, setState] = useState<ContractState>({ key: '', status: 'checking' });
  const [attempt, setAttempt] = useState(0), [historyOpen, setHistoryOpen] = useState(false);
  const [historyVisited, setHistoryVisited] = useState(false);
  useEffect(() => {
    let current = true; setState({ key, status: 'checking' }); setHistoryOpen(false); setHistoryVisited(false);
    if (gate === 'on') void getAnnualNeedsContract()
      .then(contract => { if (current) setState({ key, status: contract ? 'ready' : 'absent' }); })
      .catch(() => { if (current) setState({ key, status: 'failed' }); });
    return () => { current = false; };
  }, [key, gate, attempt]);
  const loading = <p role="status" className="annual-entry-notice">{ar ? 'جارٍ التحقق من التخطيط السنوي…' : 'Checking annual planning…'}</p>;
  const legacy = <><p className="annual-entry-notice" role="note">{ar ? 'أنت تعرض واجهة الملفات والسجل السابق.' : 'Previous files and history view.'}</p><CentralNeedsScreen /></>;
  if (gate === 'off') return legacy;
  if (gate === 'checking' || state.key !== key || state.status === 'checking') return loading;
  if (state.status === 'absent') return <><p role="status" className="annual-entry-notice">{ar
    ? 'التخطيط السنوي الجديد بانتظار التفعيل في هذه البيئة. تبقى الملفات والسجلات السابقة متاحة.'
    : 'New annual planning is awaiting activation in this environment. Previous files and history remain available.'}</p>{legacy}</>;
  if (state.status === 'failed') return <section className="annual-entry-notice">
    <p role="alert">{ar ? 'تعذر التحقق من التخطيط السنوي. تحقق من صلاحية الوصول أو أعد المحاولة.' : 'Annual planning could not be verified. Check your access or retry.'}</p>
    <button type="button" onClick={() => setAttempt(value => value + 1)}>{ar ? 'إعادة التحقق من التخطيط السنوي' : 'Retry annual planning'}</button>
  </section>;
  return <section className="annual-entry" data-testid="annual-needs-entry" data-prism-surface="annual">
    {import.meta.env.VITE_PHOENIX_ISOLATED_PREVIEW === 'r18' && <p role="note" className="annual-entry-notice">{ar
      ? 'بيئة اختبار معزولة — بيانات تجريبية فقط.' : 'Isolated test environment — synthetic data only.'}</p>}
    <Suspense fallback={loading}><ManualNeedsTab /></Suspense>
    <section className="annual-entry-history">
      <button type="button" aria-expanded={historyOpen} aria-controls="annual-entry-previous" onClick={() => { setHistoryVisited(true); setHistoryOpen(value => !value); }}>{ar
        ? (historyOpen ? 'إخفاء الملفات والسجل السابق' : 'عرض الملفات والسجل السابق')
        : (historyOpen ? 'Hide previous files and history' : 'Show previous files and history')}</button>
      {historyVisited && <div id="annual-entry-previous" hidden={!historyOpen}>{legacy}</div>}
    </section>
  </section>;
}
