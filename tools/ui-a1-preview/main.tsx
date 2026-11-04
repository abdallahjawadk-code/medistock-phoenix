import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NeedsWorkspaceFrame } from '../../src/features/central-needs/ui/NeedsWorkspaceFrame';
import { MonthlyProposalPanel } from '../../src/features/central-needs/allocation/MonthlyProposalPanel';
import type { MonthlyPolicyReference } from '../../src/features/central-needs/allocation/monthly-proposal-reference';
import './preview.css';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const context = { ownerOrgId: id(1), planningYear: 2026, annualItemId: id(2), fieldVersionId: id(3), canonicalItemId: id(4), unit: 'box', beneficiaryOrganizationId: id(5) };
const reference: MonthlyPolicyReference = { policyId: id(6), version: 1, fingerprint: 'a'.repeat(64), status: 'approved', context,
  unitStep: '1', eligibleMonths: [1,2,3,4,5,6,7,8,9,10,11,12], fixedMonths: [],
  basis: { beneficiaryOrganizationId: id(5), documentReference: 'SYNTHETIC UI TEST — NOT A REAL POLICY', documentSha256: 'b'.repeat(64),
    periodReference: 'Synthetic periods', priorAllocationStatus: 'none_verified', ledgerSnapshotSha256: 'c'.repeat(64),
    approvedById: id(7), approvedByName: 'Synthetic reviewer', approvedAt: '2026-01-01T00:00:00Z' } };
const read = async () => reference;
const missing = async () => null;
function Fixture() {
  const [lang, setLang] = useState<'ar'|'en'>('en'), [quantity,setQuantity] = useState(''), [policy,setPolicy] = useState(false), [dark,setDark] = useState(false);
  return <div data-theme={dark ? 'dark' : 'light'} className="ui-a1-fixture">
    <aside role="note">SYNTHETIC COMPONENT FIXTURE · No hosted reads or writes · Not Staging acceptance</aside>
    <nav aria-label="Fixture controls"><button onClick={()=>setLang(lang==='en'?'ar':'en')}>العربية / English</button><button onClick={()=>setDark(!dark)}>Light / Dark</button></nav>
    <NeedsWorkspaceFrame lang={lang} title={lang==='ar'?'التحصيص الشهري':'Monthly allocation'} description={lang==='ar'?'معاينة تفاعلية للمكوّن الفعلي بمرجع اصطناعي معلن.':'Interactive actual component with an explicitly synthetic reference.'}>
      <label>{lang==='ar'?'الكمية السنوية اليدوية':'Manual annual quantity'}<input value={quantity} onChange={e=>setQuantity(e.target.value)} inputMode="decimal" dir="ltr" /></label>
      <label><input type="checkbox" checked={policy} onChange={e=>setPolicy(e.target.checked)} />{lang==='ar'?'مرجع سياسة اصطناعي للاختبار فقط':'Synthetic policy reference for testing only'}</label>
      <MonthlyProposalPanel lang={lang} context={context} annualQuantity={quantity} readReference={policy?read:missing} />
    </NeedsWorkspaceFrame>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
