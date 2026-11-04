import { useEffect, useId, useState } from 'react';
import { getMonthlyPolicyReference } from './monthly-policy.service';
import { proposeFromMonthlyPolicy, type MonthlyPolicyReference, type MonthlyProposalContext } from './monthly-proposal-reference';
import '../ui/needs-workspace.css';

interface Props {
  lang: 'ar' | 'en'; context: MonthlyProposalContext; annualQuantity: string;
  readReference?: typeof getMonthlyPolicyReference;
}
type ReadState = { key: string; status: 'loading' | 'failed' } | { key: string; status: 'loaded'; reference: MonthlyPolicyReference | null };
export function MonthlyProposalPanel({ lang, context, annualQuantity, readReference = getMonthlyPolicyReference }: Props) {
  const titleId = useId(), ar = lang === 'ar';
  const [view, setView] = useState<'calendar' | 'table'>('calendar');
  // A changed context hides the old reference immediately, before effects run.
  const key = JSON.stringify([context.ownerOrgId, context.planningYear, context.annualItemId, context.fieldVersionId,
    context.canonicalItemId, context.unit, context.beneficiaryOrganizationId]);
  const [attempt, setAttempt] = useState(0), [state, setState] = useState<ReadState>({ key: '', status: 'loading' });
  useEffect(() => {
    let current = true; setState({ key, status: 'loading' });
    const [ownerOrgId, planningYear, annualItemId, fieldVersionId, canonicalItemId, unit, beneficiaryOrganizationId] = JSON.parse(key);
    void readReference({ ownerOrgId, planningYear, annualItemId, fieldVersionId, canonicalItemId, unit, beneficiaryOrganizationId })
      .then(reference => { if (current) setState({ key, status: 'loaded', reference }); })
      .catch(() => { if (current) setState({ key, status: 'failed' }); });
    return () => { current = false; };
  }, [key, attempt, readReference]);
  const loaded = state.key === key && state.status === 'loaded';
  const failed = state.key === key && state.status === 'failed';
  const reference = loaded ? state.reference : null;
  const proposal = loaded && reference ? proposeFromMonthlyPolicy(annualQuantity, context, reference) : null;
  const heldText = proposal?.status === 'held' && proposal.reason === 'annual_below_fixed'
    ? (ar ? 'الكمية السنوية أقل من التحصيص المعتمد الثابت.' : 'The annual quantity is below fixed approved allocations.')
    : (ar ? 'تعذر اقتراح توزيع يطابق الكمية السنوية وخطوة الكمية المعتمدة. راجع الكمية والسياسة.' : 'No distribution matches the annual quantity and approved quantity step. Review the quantity and policy.');
  const month = (n: number) => new Intl.DateTimeFormat(ar ? 'ar' : 'en', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, n - 1, 1)));
  return <section className="prism-monthly-proposal needs-monthly" aria-labelledby={titleId} data-testid="monthly-proposal" lang={lang} dir={ar ? 'rtl' : 'ltr'}>
    <header className="needs-monthly__header"><h4 id={titleId}>{ar ? 'اقتراح التحصيص الشهري' : 'Monthly distribution proposal'}</h4>
      <span className="needs-monthly__badge">{ar ? 'غير نافذ' : 'Nonbinding'}</span></header>
    <p className="prism-field-hint">{ar ? 'اقتراح غير نافذ. حفظ الاحتياج السنوي لا يعتمد حصصًا شهرية.' : 'Nonbinding proposal. Saving the annual need does not approve monthly allocations.'}</p>
    <div role="status" aria-live="polite">
      {!loaded && !failed && <p>{ar ? 'جارٍ قراءة سياسة التوزيع…' : 'Reading distribution policy…'}</p>}
      {loaded && !reference && <p className="prism-notice prism-notice--warning">{ar ? 'بانتظار تحديد سياسة التوزيع' : 'Awaiting distribution policy'}</p>}
      {proposal?.status === 'enter_quantity' && <p>{ar ? 'أدخل الكمية السنوية لعرض الاقتراح.' : 'Enter the annual quantity to see the proposal.'}</p>}
      {proposal?.status === 'ready' && <p>{ar ? 'مجموع الأشهر يطابق الكمية السنوية بدقة.' : 'The monthly total matches the annual quantity exactly.'}</p>}
    </div>
    {failed && <p role="alert" className="prism-notice prism-notice--error">{ar ? 'تعذرت قراءة سياسة التوزيع. تحقق من صلاحية الوصول أو أعد المحاولة.' : 'The distribution policy could not be read. Check your access or retry.'}</p>}
    {proposal?.status === 'held' && <p role="alert" className="prism-notice prism-notice--warning">{heldText}</p>}
    {proposal?.status === 'ready' && reference && <>
      <dl className="prism-monthly-proposal__basis">
        <div><dt>{ar ? 'خطوة الكمية' : 'Quantity step'}</dt><dd><bdi>{reference.unitStep}</bdi> <bdi>{context.unit}</bdi></dd></div>
        <div><dt>{ar ? 'مرجع السياسة' : 'Policy reference'}</dt><dd>{reference.basis.documentReference}</dd></div>
        <div><dt>{ar ? 'الإصدار' : 'Version'}</dt><dd><bdi>{reference.version}</bdi></dd></div>
      </dl>
      <div className="needs-monthly__views" role="group" aria-label={ar ? 'طريقة عرض الاقتراح' : 'Proposal view'}>
        <button type="button" aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}>{ar ? 'تقويم الأشهر' : 'Month calendar'}</button>
        <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>{ar ? 'جدول تفصيلي' : 'Detailed table'}</button>
      </div>
      {view === 'calendar' && <><ol className="needs-monthly__calendar" aria-label={ar ? 'تقويم الاقتراح غير النافذ' : 'Nonbinding proposal calendar'}>
        {proposal.rows.map(row => <li key={row.month} data-month={row.month}><span>{month(row.month)}</span><strong><bdi>{row.quantity}</bdi></strong><small>{row.kind === 'fixed' ? (ar ? 'تحصيص معتمد ثابت' : 'Fixed approved allocation') : (ar ? 'مقترح' : 'Suggested')}</small></li>)}
      </ol><p className="needs-monthly__total"><span>{ar ? 'المجموع' : 'Total'}</span><strong><bdi>{proposal.annualQuantity}</bdi> <bdi>{context.unit}</bdi></strong></p></>}
      {view === 'table' && <div className="prism-table-scroll" role="region" aria-labelledby={titleId} tabIndex={0}>
        <table><caption>{ar ? 'اقتراح التحصيص الشهري' : 'Monthly distribution proposal'}</caption>
          <thead><tr><th scope="col">{ar ? 'الشهر' : 'Month'}</th><th scope="col">{ar ? 'الكمية' : 'Quantity'}</th><th scope="col">{ar ? 'الحالة' : 'Status'}</th></tr></thead>
          <tbody>{proposal.rows.map(row => <tr key={row.month} data-month={row.month}>
            <th scope="row">{month(row.month)}</th><td><bdi>{row.quantity}</bdi></td>
            <td>{row.kind === 'fixed' ? (ar ? 'تحصيص معتمد ثابت' : 'Fixed approved allocation') : (ar ? 'مقترح' : 'Suggested')}</td>
          </tr>)}</tbody>
          <tfoot><tr><th scope="row">{ar ? 'المجموع' : 'Total'}</th><td><bdi>{proposal.annualQuantity}</bdi></td><td>{ar ? 'غير نافذ' : 'Nonbinding'}</td></tr></tfoot>
        </table>
      </div>}
    </>}
    {(loaded || failed) && <button type="button" onClick={() => { setState({ key, status: 'loading' }); setAttempt(n => n + 1); }}>
      {ar ? 'إعادة قراءة سياسة التوزيع' : 'Reload distribution policy'}
    </button>}
  </section>;
}
