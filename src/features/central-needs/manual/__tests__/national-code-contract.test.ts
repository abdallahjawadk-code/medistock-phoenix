import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc=vi.fn();
vi.mock('@/shared/supabase/client',()=>({supabase:{rpc:(...args:unknown[])=>rpc(...args)}}));
import { getNeedsFeatures, listNeedsDossiers } from '../dossier.service';
import { createMaterialRequestDraft, resolveMaterialExisting } from '../material-registration.service';
import { importDossierWorkbook } from '../dossier-workbook';
import { CentralNeedsError } from '../../central-needs.service';
beforeEach(()=>rpc.mockReset());
describe('additive backend contract and explicit national-code assignment',()=>{
  it('uses legacy mode only when this exact feature RPC is absent',async()=>{
    rpc.mockResolvedValue({data:null,error:{code:'PGRST202',message:'Could not find public.phoenix_central_needs_feature_contract'}});
    expect(await getNeedsFeatures()).toEqual({nationalCode:false,sameActorManual:false,dossiers:false,workbookIntake:false});
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([{code:'42501',message:'permission denied'},{code:'PGRST202',message:'another function is absent'}])('does not turn an authorization/unrelated failure into legacy availability',async(error)=>{
    rpc.mockResolvedValue({data:null,error});await expect(getNeedsFeatures()).rejects.toThrow();
  });
  it('rejects an invalid feature response and a denied dossier read',async()=>{
    rpc.mockResolvedValueOnce({data:{},error:null});await expect(getNeedsFeatures()).rejects.toThrow('invalid_needs_feature_contract');
    rpc.mockResolvedValueOnce({data:null,error:{code:'42501',message:'denied'}});await expect(listNeedsDossiers('org',2028)).rejects.toThrow();
  });
  it('sends national code and barcode as separate fields without numeric conversion',async()=>{
    rpc.mockResolvedValueOnce({data:{national_code:true,same_actor_manual:true,dossiers:true,workbook_intake:true},error:null})
      .mockResolvedValueOnce({data:{request_id:'request',status:'draft',version:1},error:null});
    await createMaterialRequestDraft('org',{scientificName:'Reagent',nameAr:null,tradeName:null,strength:null,dosageForm:null,unit:'test',barcode:'840001',nationalCode:'00043-A00-001',note:null},'request-key-0001',{kind:'manual_typed'});
    expect(rpc.mock.calls[1]).toEqual(['phoenix_central_needs_create_material_request_with_code',expect.objectContaining({p_national_code:'00043-A00-001',p_barcode:'840001'})]);
  });
  it('assigns a code to an existing item only through the explicit guarded RPC',async()=>{
    rpc.mockResolvedValue({data:{request_id:'r',status:'resolved_existing',version:4},error:null});
    await resolveMaterialExisting('r',3,'item','Reviewed code assignment',{expected:null});
    expect(rpc).toHaveBeenCalledWith('phoenix_central_needs_resolve_material_existing_with_code',{
      p_request_id:'r',p_expected_version:3,p_item_id:'item',p_note:'Reviewed code assignment',p_expected_code:null,p_confirm_code:true,
    });
  });
  it('treats a transport error returned by the SDK as an unknown outcome',async()=>{
    rpc.mockResolvedValue({data:null,error:{code:'',message:'TypeError: Failed to fetch'}});
    await expect(importDossierWorkbook('r','file.csv',new Uint8Array([1]),[])).rejects.toThrow('dossier_intake_outcome_unknown');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('keeps a server permission refusal distinct from an unknown network outcome',async()=>{
    rpc.mockResolvedValue({data:null,error:{code:'42501',message:'forbidden_central_needs'}});
    await expect(importDossierWorkbook('r','file.csv',new Uint8Array([1]),[])).rejects.toBeInstanceOf(CentralNeedsError);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
