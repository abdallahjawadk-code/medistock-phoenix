/** DEV-only read fixtures for the real manual journey. Every write refuses.
 * Matches master's manual API only; no PR #256 features. Not a server/RLS proof. */
import { useApp } from '@/app/AppContext';
import { ManualNeedsJourney } from '@/features/central-needs/manual/ManualNeedsJourney';
import type { JourneyApi } from '@/features/central-needs/manual/manual-journey.service';
import type { ManualNeedsApi } from '@/features/central-needs/manual/ManualNeedsWorkspace';

const caps={view:true,edit:true,approve:true,manualSet:true,excelImportOpen:false,approveExcludedForRevision:false};
const refuse=async ():Promise<never>=>{throw new Error('QA_READONLY: display fixture; no write permitted');};
const labels=[
  {id:'qa-pharma-item1',name:'Laboratory reagent',nameAr:'كاشف مختبري — عينة تصميم',unit:'test',concentration:null,dosageForm:null,status:'active'},
  {id:'qa-pharma-item2',name:'Paracetamol 500 mg',nameAr:'باراسيتامول 500 ملغم — عينة تصميم',unit:'tablet',concentration:'500 mg',dosageForm:'Tablet',status:'active'},
  {id:'qa-pharma-item3',name:'Sodium chloride 0.9%',nameAr:'كلوريد الصوديوم 0.9% — عينة تصميم',unit:'bottle',concentration:'0.9%',dosageForm:'Solution',status:'active'},
];
const revision={id:'qa-pharma-revision',revisionNumber:1,status:'draft',sourceMode:'manual' as const,createdBy:'qa-maker'};
const api:JourneyApi={
  listYearRevisions:async()=>[revision],
  listBeneficiaries:async()=>[{id:'qa-pharma-hospital',name:'Sample teaching hospital',nameAr:'مستشفى تعليمي — بيانات تجريبية'}],
  searchCatalog:async(query)=>labels.filter(i=>`${i.name} ${i.nameAr}`.toLowerCase().includes(query.toLowerCase())),
  resolveForIdentity:async()=>[],getCaps:async()=>caps,
  openPlan:refuse,openCorrection:refuse,
  readiness:async()=>({planRevisionId:revision.id,status:'draft',ready:false,blockers:[]}),submit:refuse,approve:refuse,reject:refuse,
};
const workspaceApi:ManualNeedsApi={getManualCapabilities:async()=>caps,
  listManualNeedEvents:async()=>labels.map((item,i)=>({id:`qa-event-${i}`,planRevisionId:revision.id,beneficiaryOrganizationId:'qa-pharma-hospital',centralItemId:item.id,targetWarehouseId:null,eventSeq:1,eventKind:'add' as const,quantityText:['11520','8000','2400'][i],approvedUnit:item.unit,reason:'Synthetic display fixture',reference:null,actorId:'qa-maker'})),
  addManualNeedLine:refuse,correctManualNeedLine:refuse,voidManualNeedLine:refuse,newManualIdempotencyKey:()=>crypto.randomUUID()};
export function ManualGallery(){const {lang}=useApp();return <ManualNeedsJourney lang={lang} organizationId="qa-org-a1" actorId="qa-maker" api={api} workspaceApi={workspaceApi} initialYear={2026}/>;}
