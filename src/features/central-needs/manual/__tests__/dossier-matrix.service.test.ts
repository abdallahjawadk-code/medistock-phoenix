import {PostgrestError} from '@supabase/postgrest-js';
import {beforeEach, describe, expect, it, vi} from 'vitest';
const {mockRpc}=vi.hoisted(()=>({mockRpc:vi.fn()}));
vi.mock('@/shared/supabase/client',()=>({supabase:{rpc:mockRpc}}));
vi.mock('../dossier-workbook',()=>({listDossierSources:vi.fn()}));
import {supabase} from '@/shared/supabase/client';
import {listDossierSources} from '../dossier-workbook';
import {captureDossierWorkbook, resumeDossierWorkbook, IntakeInterrupted, type CaptureInput} from '../dossier-matrix.service';
const ok=(data:Record<string,unknown>)=>({data,error:null,count:null,status:200,statusText:'OK',success:true as const});
const fail=(code:string,message:string)=>({data:null,error:new PostgrestError({code,message,details:'',hint:''}),count:null,status:503,statusText:'Error',success:false as const});
const source=(applied=0)=>({id:'capture',filename:'needs.xls',file_hash:'hash',revision_id:'rev',operation_id:'op',rows:105,applied_rows:applied,can_resume:true});
const input:CaptureInput={planId:'plan',revisionId:'rev',filename:'needs.xls',bytes:new Uint8Array([1,2,3]),operationId:'op',year:2026,
 rows:Array.from({length:105},(_,i)=>({sheet:0,row:i+2,quantity_column:9,name_column:1,code_column:0,unit_column:2,source_name:'Reagent',source_code:'43-'+i,quantity_text:'11520',unit:'test',item_id:'item-'+i,beneficiary_id:'hospital'})),exclusions:[],regions:[]};
beforeEach(()=>vi.resetAllMocks());
describe('captured batches: confirmed, partial and unknown are distinct',()=>{
 it('captures once then applies exactly offsets 0 and 100, with original bytes/hash and year context',async()=>{
  vi.mocked(listDossierSources).mockResolvedValue([source()]);
  vi.mocked(supabase.rpc).mockResolvedValueOnce(ok({ok:true,intake_id:'capture',rows:105}))
   .mockResolvedValueOnce(ok({ok:true,intake_id:'capture',offset:0,rows:100}))
   .mockResolvedValueOnce(ok({ok:true,intake_id:'capture',offset:100,rows:5}));
  expect(await captureDossierWorkbook(input)).toMatchObject({id:'capture',rows:105});
  expect(supabase.rpc).toHaveBeenCalledTimes(3);
  expect(vi.mocked(supabase.rpc).mock.calls[0]).toEqual(['phoenix_central_needs_begin_dossier_workbook',expect.objectContaining({p_operation_id:'op',p_original_base64:'AQID',p_file_hash:expect.stringMatching(/^[a-f0-9]{64}$/),p_confirmation:{format:'matrix-v2',plan_year:2026,year_confirmed:true,regions:[]}})]);
  expect(vi.mocked(supabase.rpc).mock.calls.slice(1)).toEqual([['phoenix_central_needs_apply_dossier_workbook_batch',{p_intake_id:'capture',p_offset:0}],['phoenix_central_needs_apply_dossier_workbook_batch',{p_intake_id:'capture',p_offset:100}]]);
 });
 it('never retries an ambiguous capture',async()=>{
  vi.mocked(supabase.rpc).mockResolvedValue(fail('','Failed to fetch'));
  await expect(captureDossierWorkbook(input)).rejects.toMatchObject({outcomeUnknown:true,intakeId:null,operationId:'op'});
  expect(supabase.rpc).toHaveBeenCalledTimes(1);expect(listDossierSources).not.toHaveBeenCalled();
 });
 it('stops after the first ambiguous batch while retaining the confirmed 100-row prefix',async()=>{
  vi.mocked(listDossierSources).mockResolvedValue([source()]);
  vi.mocked(supabase.rpc).mockResolvedValueOnce(ok({ok:true,intake_id:'capture',offset:0,rows:100})).mockResolvedValueOnce(fail('40003','unknown commit'));
  await expect(resumeDossierWorkbook('plan','rev','capture')).rejects.toMatchObject({confirmedRows:100,outcomeUnknown:true,intakeId:'capture'});
  expect(supabase.rpc).toHaveBeenCalledTimes(2);
 });
 it('resumes only after a fresh progress read, skipping the confirmed prefix',async()=>{
  vi.mocked(listDossierSources).mockResolvedValue([source(100)]);
  vi.mocked(supabase.rpc).mockResolvedValue(ok({ok:true,intake_id:'capture',offset:100,rows:5}));
  await resumeDossierWorkbook('plan','rev','capture');expect(supabase.rpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_apply_dossier_workbook_batch',{p_intake_id:'capture',p_offset:100});
 });
 it('does not write when a receipt read already proves completion',async()=>{
  vi.mocked(listDossierSources).mockResolvedValue([source(105)]);
  expect(await resumeDossierWorkbook('plan','rev','capture')).toMatchObject({rows:105,replay:true});expect(supabase.rpc).not.toHaveBeenCalled();
 });
 it.each([{...source(),can_resume:false},{...source(),revision_id:'other'},{...source(),applied_rows:99}])('rejects unsafe progress before any mutation',async(s)=>{
  vi.mocked(listDossierSources).mockResolvedValue([s]);await expect(resumeDossierWorkbook('plan','rev','capture')).rejects.toThrow('dossier_progress_invalid');expect(supabase.rpc).not.toHaveBeenCalled();
 });
 it('does not accept a mismatched receipt as success',async()=>{
  vi.mocked(listDossierSources).mockResolvedValue([source()]);vi.mocked(supabase.rpc).mockResolvedValue(ok({ok:true,intake_id:'different',offset:0,rows:100}));
  await expect(resumeDossierWorkbook('plan','rev','capture')).rejects.toBeInstanceOf(IntakeInterrupted);expect(supabase.rpc).toHaveBeenCalledTimes(1);
 });
 it('does not start a capture after the context was already abandoned',async()=>{
  const c=new AbortController();c.abort();await expect(captureDossierWorkbook({...input,signal:c.signal})).rejects.toMatchObject({businessCode:'dossier_context_changed',confirmedRows:0});expect(supabase.rpc).not.toHaveBeenCalled();
 });
 it('does not start a capture when the context is abandoned during hashing',async()=>{
  let finishDigest!:(value:ArrayBuffer)=>void;
  const digest=new Promise<ArrayBuffer>((resolve)=>{finishDigest=resolve;});
  const digestSpy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(()=>digest);
  try {
   const c=new AbortController();const pending=captureDossierWorkbook({...input,signal:c.signal});
   expect(digestSpy).toHaveBeenCalledTimes(1);expect(supabase.rpc).not.toHaveBeenCalled();
   c.abort();finishDigest(new ArrayBuffer(32));
   await expect(pending).rejects.toMatchObject({businessCode:'dossier_context_changed',confirmedRows:0,outcomeUnknown:false,intakeId:null});
   expect(supabase.rpc).not.toHaveBeenCalled();expect(listDossierSources).not.toHaveBeenCalled();
  } finally {digestSpy.mockRestore();}
 });
 it('a context change stops future batches while preserving the confirmed prefix',async()=>{
  const c=new AbortController();vi.mocked(listDossierSources).mockResolvedValue([source()]);
  mockRpc.mockImplementation(()=>{c.abort();return Promise.resolve(ok({ok:true,intake_id:'capture',offset:0,rows:100}));});
  await expect(resumeDossierWorkbook('plan','rev','capture',c.signal)).rejects.toMatchObject({businessCode:'dossier_context_changed',confirmedRows:100,outcomeUnknown:false});expect(supabase.rpc).toHaveBeenCalledTimes(1);
 });

});
