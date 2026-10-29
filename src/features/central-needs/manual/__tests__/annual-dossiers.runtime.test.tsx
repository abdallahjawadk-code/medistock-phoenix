/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../../CentralNeedsRevisionHistory', () => ({ CentralNeedsRevisionHistory: ({ planId }: {planId?:string}) => <div data-testid="history-plan">{planId}</div> }));
vi.mock('../MaterialPicker', () => ({ MaterialPicker: () => null }));
vi.mock('../IdentityAssistPanel', () => ({ IdentityAssistPanel: () => null }));
vi.mock('../DossierWorkbookIntake', () => ({ DossierWorkbookIntake: () => null }));
vi.mock('../ManualNeedsWorkspace', () => ({ ManualNeedsWorkspace: ({planRevisionId}: {planRevisionId:string}) => <p data-testid="revision-workspace">{planRevisionId}</p> }));
import { ManualNeedsJourney } from '../ManualNeedsJourney';
import type { JourneyApi } from '../manual-journey.service';
import type { NeedsDossier } from '../dossier.service';

afterEach(cleanup);
function fixture() {
  const dossiers: NeedsDossier[] = [
    {id:'a',key:'med',name:'Medicines',latestRevisionId:'ar',latestStatus:'approved',latestNumber:1,approvedRevisionId:'ar',approvedNumber:1},
    {id:'b',key:'lab',name:'Laboratory',latestRevisionId:'br',latestStatus:'draft',latestNumber:1,approvedRevisionId:null,approvedNumber:null},
  ];
  const api: JourneyApi = {
    features:vi.fn(async()=>({nationalCode:true,sameActorManual:true,dossiers:true,workbookIntake:false})),
    listDossiers:vi.fn(async()=>[...dossiers]),
    annualSummary:vi.fn(async()=>[{dossierId:'a',dossierName:'Medicines',revisionId:'ar',beneficiaryId:'hospital',itemId:'item',name:'Reagent',nameAr:null,nationalCode:'00043-A00-001',quantityText:'11520',unit:'test',warehouseId:null}]),
    listDossierRevisions:vi.fn(async(id: string)=>{const d=dossiers.find((v)=>v.id===id)!;return [{id:d.latestRevisionId!,revisionNumber:d.latestNumber!,status:d.latestStatus!,sourceMode:'manual' as const,createdBy:'maker'}];}),
    listYearRevisions:vi.fn(async()=>[]),
    listBeneficiaries:vi.fn(async()=>[{id:'hospital',name:'Hospital',nameAr:'مستشفى'}]),
    getCaps:vi.fn(async()=>({view:true,edit:true,approve:true,manualSet:true,excelImportOpen:false,approveExcludedForRevision:false})),
    searchCatalog:vi.fn(async()=>[]),resolveForIdentity:vi.fn(async()=>[]),
    openPlan:vi.fn(),openCorrection:vi.fn(),readiness:vi.fn(),submit:vi.fn(),approve:vi.fn(),reject:vi.fn(),
    openDossier:vi.fn(async()=>{dossiers.push({id:'c',key:'new',name:'Supplies',latestRevisionId:'cr',latestStatus:'draft',latestNumber:1,approvedRevisionId:null,approvedNumber:null});return {planId:'c',planRevisionId:'cr'};}),
    openDossierCorrection:vi.fn(async()=>{dossiers[0]={...dossiers[0],latestRevisionId:'a-correction',latestStatus:'draft',latestNumber:2};return {planRevisionId:'a-correction'};}),
  };
  render(<ManualNeedsJourney lang="en" organizationId="org" actorId="maker" initialYear={2028} api={api}
    preview={{state:{phase:'idle'},parse:vi.fn(),reset:vi.fn()} as never} />);
  return {api,dossiers};
}
const open=async()=>{fireEvent.click(screen.getByRole('button',{name:'Open year'}));await screen.findByLabelText('Dossier / classification');};

describe('annual workspace retains independent dossiers',()=>{
  it('switches from an approved dossier to another editable dossier in the same year, with scoped history',async()=>{
    const {api}=fixture();await open();
    expect(await screen.findByTestId('revision-workspace')).toHaveTextContent('ar');
    fireEvent.change(screen.getByLabelText('Dossier / classification'),{target:{value:'b'}});
    await waitFor(()=>expect(screen.getByTestId('revision-workspace')).toHaveTextContent('br'));
    expect(screen.getByTestId('history-plan')).toHaveTextContent('b');
    expect(api.listYearRevisions).not.toHaveBeenCalled();
    expect(api.openCorrection).not.toHaveBeenCalled();
  });
  it('creates and opens another classification without replacing an approved dossier',async()=>{
    const {api,dossiers}=fixture();await open();
    fireEvent.change(screen.getByLabelText('New dossier / classification name'),{target:{value:'Supplies'}});
    fireEvent.click(screen.getByRole('button',{name:'Add needs dossier'}));
    await waitFor(()=>expect(screen.getByTestId('revision-workspace')).toHaveTextContent('cr'));
    expect(api.openDossier).toHaveBeenCalledWith('org',2028,expect.any(String),'Supplies');
    expect(dossiers[0].approvedRevisionId).toBe('ar');expect(api.approve).not.toHaveBeenCalled();
  });
  it('shows only server-approved annual rows with national code and exact quantity',async()=>{
    fixture();await open();
    expect(await screen.findByText('00043-A00-001')).toBeInTheDocument();
    expect(screen.getByText('11520')).toBeInTheDocument();
    expect(screen.getByText('Reagent')).toBeInTheDocument();
  });
  it('opens an explicit correction that copies approved lines, retaining the approved annual summary meanwhile',async()=>{
    const {api}=fixture();await open();
    fireEvent.change(screen.getByLabelText('Reason for the correction'),{target:{value:'Add another workbook'}});
    fireEvent.click(screen.getByRole('button',{name:'Open correction and copy approved lines'}));
    await waitFor(()=>expect(screen.getByTestId('revision-workspace')).toHaveTextContent('a-correction'));
    expect(api.openDossierCorrection).toHaveBeenCalledWith('org',2028,'ar','Add another workbook');
    expect(api.openCorrection).not.toHaveBeenCalled();expect(screen.getByText('11520')).toBeInTheDocument();
  });
  it('does not turn a failed dossier read into an empty list or a new general-plan creation',async()=>{
    const {api}=fixture();vi.mocked(api.listDossiers!).mockRejectedValue(new Error('denied'));
    fireEvent.click(screen.getByRole('button',{name:'Open year'}));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button',{name:'Start a new plan'})).toBeNull();
    expect(api.listYearRevisions).not.toHaveBeenCalled();
  });
});
