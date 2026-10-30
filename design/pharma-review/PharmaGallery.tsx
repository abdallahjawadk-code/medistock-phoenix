/** DEV-only visual review; reachable only through the existing production-stripped QA harness. */
import { Component, Suspense, lazy, useState, type ReactNode } from 'react';
import { useApp } from '@/app/AppContext';
import { PhoenixAppShell } from '@/shared/ui/PhoenixAppShell';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { ForbiddenScreen } from '@/shared/ui/ForbiddenScreen';
import { AuthRecoveryState } from '@/shared/ui/AuthRecoveryState';
import { ManualGallery } from './PharmaManualFixture';
const InventoryCenterScreen = lazy(() => import('@/features/inventory/InventoryCenterScreen').then(m => ({ default: m.InventoryCenterScreen })));
const RegistryScreen = lazy(() => import('@/features/registry/RegistryScreen').then(m => ({ default: m.RegistryScreen })));
const MeshScreen = lazy(() => import('@/features/mesh/MeshScreen').then(m => ({ default: m.MeshScreen })));
const QrScreen = lazy(() => import('@/features/qr/QrScreen').then(m => ({ default: m.QrScreen })));
const HealthScreen = lazy(() => import('@/features/health/HealthScreen').then(m => ({ default: m.HealthScreen })));
const IntakeFrozenScreen = lazy(() => import('@/features/health/IntakeFrozenScreen').then(m => ({ default: m.IntakeFrozenScreen })));
const ReportsScreen = lazy(() => import('@/features/reports/ReportsScreen').then(m => ({ default: m.ReportsScreen })));
const MobileCommandScreen = lazy(() => import('@/features/mesh/MobileCommandScreen').then(m => ({ default: m.MobileCommandScreen })));
const InstitutionScreen = lazy(() => import('@/features/institutions/InstitutionScreen').then(m => ({ default: m.InstitutionScreen })));
const StatusCenterScreen = lazy(() => import('@/features/status/StatusCenterScreen').then(m => ({ default: m.StatusCenterScreen })));
const InterInstitutionAlertsScreen = lazy(() => import('@/features/alerts/InterInstitutionAlertsScreen').then(m => ({ default: m.InterInstitutionAlertsScreen })));
const UserManagementScreen = lazy(() => import('@/features/users/UserManagementScreen').then(m => ({ default: m.UserManagementScreen })));
const MyAccountScreen = lazy(() => import('@/features/account/MyAccountScreen').then(m => ({ default: m.MyAccountScreen })));
const StatusEditorScreen = lazy(() => import('@/features/status/StatusEditorScreen').then(m => ({ default: m.StatusEditorScreen })));
const NetworkManagementScreen = lazy(() => import('@/features/network/NetworkManagementScreen').then(m => ({ default: m.NetworkManagementScreen })));
const OutletOperationsScreen = lazy(() => import('@/features/outlet/OutletOperationsScreen').then(m => ({ default: m.OutletOperationsScreen })));
const LocalProcurementScreen = lazy(() => import('@/features/procurement/LocalProcurementScreen').then(m => ({ default: m.LocalProcurementScreen })));
const MonthlyStatusScreen = lazy(() => import('@/features/status/MonthlyStatusScreen').then(m => ({ default: m.MonthlyStatusScreen })));
const DecisionIntelligenceReportsScreen = lazy(() => import('@/features/reports/DecisionIntelligenceReportsScreen').then(m => ({ default: m.DecisionIntelligenceReportsScreen })));
const CommandCenterScreen = lazy(() => import('@/features/command-center/CommandCenterScreen').then(m => ({ default: m.CommandCenterScreen })));
const CentralNeedsScreen = lazy(() => import('@/features/central-needs/CentralNeedsScreen').then(m => ({ default: m.CentralNeedsScreen })));
const DashboardScreen = lazy(() => import('@/features/dashboard/DashboardScreen').then(m => ({ default: m.DashboardScreen })));
const LoginScreen = lazy(() => import('@/features/auth/LoginScreen').then(m => ({ default: m.LoginScreen })));
const ResetPasswordScreen = lazy(() => import('@/features/auth/ResetPasswordScreen').then(m => ({ default: m.ResetPasswordScreen })));
const PublicQrScreen = lazy(() => import('@/features/qr/PublicQrScreen').then(m => ({ default: m.PublicQrScreen })));

const noop = () => undefined;
// DEV-only catalogue: real components, synthetic fixture transport, never Auth.
export const PHARMA_SURFACES = [
  {key:"inventory",screen:3,ar:"المخزون",en:"Inventory",render:()=> <InventoryCenterScreen />},
  {key:"registry",screen:4,ar:"سجل المواد",en:"Registry",render:()=> <RegistryScreen />},
  {key:"mesh",screen:5,ar:"شبكة الإمداد",en:"Supply mesh",render:()=> <MeshScreen onNavigate={noop} />},
  {key:"qr",screen:6,ar:"الرموز",en:"QR",render:()=> <QrScreen />},
  {key:"health",screen:7,ar:"صحة المنظومة",en:"System health",render:()=> <HealthScreen />},
  {key:"frozen",screen:8,ar:"الإدخال المجمّد",en:"Frozen intake",render:()=> <IntakeFrozenScreen onNavigate={noop} />},
  {key:"legacy-reports",screen:9,ar:"التقارير السابقة",en:"Legacy reports",render:()=> <ReportsScreen />},
  {key:"mobile-command",screen:10,ar:"القيادة المتنقلة",en:"Mobile command",render:()=> <MobileCommandScreen onNavigate={noop} />},
  {key:"institutions",screen:11,ar:"المؤسسات",en:"Institutions",render:()=> <InstitutionScreen />},
  {key:"legacy-status",screen:12,ar:"المواقف السابقة",en:"Legacy status",render:()=> <StatusCenterScreen onNavigate={noop} />},
  {key:"alerts",screen:13,ar:"المناقلات والتنبيهات",en:"Transfers and alerts",render:()=> <InterInstitutionAlertsScreen />},
  {key:"users",screen:14,ar:"الأعضاء والصلاحيات",en:"Members and permissions",render:()=> <UserManagementScreen />},
  {key:"account",screen:15,ar:"حسابي",en:"My account",render:()=> <MyAccountScreen />},
  {key:"status-editor",screen:16,ar:"محرّر الموقف",en:"Status editor",render:()=> <StatusEditorScreen />},
  {key:"network",screen:17,ar:"إدارة الشبكة",en:"Network management",render:()=> <NetworkManagementScreen />},
  {key:"outlet",screen:18,ar:"عمليات المنفذ",en:"Outlet operations",render:()=> <OutletOperationsScreen />},
  {key:"procurement",screen:19,ar:"المشتريات الفرعية",en:"Local procurement",render:()=> <LocalProcurementScreen />},
  {key:"monthly",screen:20,ar:"الموقف الشهري",en:"Monthly status",render:()=> <MonthlyStatusScreen />},
  {key:"reports",screen:21,ar:"مركز التقارير والمواقف",en:"Reports and status",render:()=> <DecisionIntelligenceReportsScreen onNavigate={noop} />},
  {key:"statistics",screen:22,ar:"الإحصائيات",en:"Statistics",render:()=> <CommandCenterScreen onNavigate={noop} />},
  {key:"annual",screen:23,ar:"الاحتياج السنوي السابق",en:"Legacy annual needs",render:()=> <CentralNeedsScreen />},
  {key:"dashboard",screen:2,ar:"لوحة المتابعة السابقة",en:"Legacy dashboard",render:()=> <DashboardScreen onNavigate={noop} />},
  {key:"login",screen:0,ar:"تسجيل الدخول",en:"Sign in",render:()=> <LoginScreen />},
  {key:"reset",screen:0,ar:"استعادة كلمة المرور",en:"Password recovery",render:()=> <ResetPasswordScreen />},
  {key:"public-qr",screen:0,ar:"التحقق العام",en:"Public verification",render:()=> <PublicQrScreen publicId="qa-nonexistent-public-handle" />},
  {key:'manual',screen:3,ar:'الاحتياجات والتحصيص',en:'Needs and allocations',render:()=> <ManualGallery />},
  {key:'denied',screen:3,ar:'رفض الصلاحية',en:'Access denied',render:()=> <ForbiddenScreen />},
  {key:'recovery',screen:0,ar:'تعذر الدخول',en:'Authentication recovery',render:()=> <AuthRecoveryState title="تعذر إكمال الدخول / Sign-in unavailable" message="حالة تجريبية / Synthetic state" onRetry={noop} />},
  {key:'states',screen:3,ar:'حالات الواجهة والنوافذ',en:'States and dialogs',render:()=> <StateSamples />}
];
class SurfaceBoundary extends Component<{children:ReactNode},{error:string|null}> {
  state:{error:string|null}={error:null};
  static getDerivedStateFromError(error:Error){return {error:error.message};}
  render(){return this.state.error ? <p role="alert" data-pharma-fixture-blocked>{`Fixture limitation: ${this.state.error}`}</p> : this.props.children;}
}
function StateSamples(){
  const {lang}=useApp(); const [open,setOpen]=useState(false);const [value,setValue]=useState('');
  return <div className="pharma-state-gallery">
    <PhoenixEmptyState title={lang==='ar'?'لا توجد بيانات بعد':'No records yet'} description={lang==='ar'?'عينة للعرض فقط':'Display fixture only'} />
    <PhoenixLoadingState label={lang==='ar'?'جارٍ تحميل البيانات':'Loading records'} />
    <PhoenixErrorState title={lang==='ar'?'تعذر تحميل البيانات':'Could not load records'} message={lang==='ar'?'حالة تجريبية، لا اتصال بخادم':'Synthetic state; no server connection'} onRetry={noop}/>
    <PhoenixInput label={lang==='ar'?'بحث تجريبي':'Fixture search'} value={value} onChange={e=>setValue(e.target.value)} />
    <PhoenixButton onClick={()=>setOpen(true)}>{lang==='ar'?'فتح نافذة تجريبية':'Open fixture dialog'}</PhoenixButton>
    <PhoenixDialog open={open} onClose={()=>setOpen(false)} title={lang==='ar'?'تفاصيل المادة — عرض فقط':'Material details — display only'}>
      <p>{lang==='ar'?'الرمز الوطني والباركود هويتان منفصلتان':'National code and barcode remain separate fields'}</p>
      <PhoenixInput label={lang==='ar'?'الرمز الوطني':'National code'} value="QA-NAT-001" readOnly />
      <PhoenixInput label={lang==='ar'?'الباركود':'Barcode'} value="QA-BAR-001" readOnly />
      <PhoenixButton onClick={()=>setOpen(false)}>{lang==='ar'?'إغلاق':'Close'}</PhoenixButton>
    </PhoenixDialog>
  </div>;
}
export function PharmaGallery(){
  const {lang}=useApp();
  const q=new URLSearchParams(location.search);const key=q.get('surface')??'statistics';
  const surface=PHARMA_SURFACES.find(s=>s.key===key)??PHARMA_SURFACES[0];
  const [current,setCurrent]=useState(surface);
  const navigate=(screen:number)=>{const next=PHARMA_SURFACES.find(s=>s.screen===screen);if(next)setCurrent(next);};
  const content=<SurfaceBoundary key={current.key}><Suspense fallback={<PhoenixLoadingState/>}>{current.render()}</Suspense></SurfaceBoundary>;
  return <>
    <details className="pharma-qa-controls" data-pharma-qa-controls>
      <summary>{lang==='ar'?'معرض الواجهات · بيانات تجريبية':'Interface gallery · synthetic data'}</summary>
      <label>{lang==='ar'?'الواجهة':'Surface'}<select value={current.key} onChange={e=>setCurrent(PHARMA_SURFACES.find(s=>s.key===e.target.value)!)}>{PHARMA_SURFACES.map(s=><option key={s.key} value={s.key}>{lang==='ar'?s.ar:s.en}</option>)}</select></label>
    </details>
    {current.screen===0 ? content : <PhoenixAppShell currentScreen={current.screen} onNavigate={navigate} onLogout={noop}>{content}</PhoenixAppShell>}
  </>;
}
