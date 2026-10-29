/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@/shared/supabase/client',()=>({supabase:{rpc:vi.fn(),from:vi.fn()}}));
import { DossierWorkbookIntake, type WorkbookIntakeApi } from '../DossierWorkbookIntake';
import type { FileParseResult } from '../../import/contract';
afterEach(cleanup);
const parsed={outcome:'accepted',workbook:{sheets:[{index:0,name:'Needs',cells:[
  {coordinate:{row:1,col:0},presence:'value',valueType:'string',rawValue:'Reagent',isFormula:false},
  {coordinate:{row:1,col:1},presence:'value',valueType:'number',rawValue:11520,isFormula:false},
  {coordinate:{row:1,col:2},presence:'value',valueType:'string',rawValue:'test',isFormula:false},
]}]}} as FileParseResult;
function fixture() {
 const api:WorkbookIntakeApi={parse:vi.fn(async()=>({parsed,bytes:new Uint8Array([1,2,3])})),
  save:vi.fn(async()=>({id:'receipt',rows:1,replay:false})),sources:vi.fn(async()=>[]),download:vi.fn()};
 const onSaved=vi.fn();
 const search=vi.fn(async()=>[{id:'item',name:'Reagent',nameAr:null,unit:'test',concentration:null,dosageForm:null,nationalCode:'00043-A'}]);
 render(<DossierWorkbookIntake lang="en" planId="plan" revisionId="rev" editable beneficiaries={[{id:'hospital',name:'Hospital',nameAr:'مستشفى'}]} search={search} onSaved={onSaved} api={api} />);
 return {api,onSaved,search};
}
async function prepare(files=[new File(['fixture'],'first.csv')]){
 fireEvent.change(screen.getByLabelText('Choose needs files'),{target:{files}});
 fireEvent.click(screen.getByRole('button',{name:'Preview next file'}));
 await screen.findByLabelText('Beneficiary for all rows in this file');
 fireEvent.change(screen.getByLabelText('Beneficiary for all rows in this file'),{target:{value:'hospital'}});
 fireEvent.click(screen.getByRole('button',{name:'Review rows'}));
 fireEvent.click(screen.getByRole('button',{name:'Find material'}));
 await waitFor(()=>expect(screen.getByRole('option',{name:/00043-A/})).toBeInTheDocument());
 fireEvent.change(screen.getByLabelText('Material for row 2'),{target:{value:'item'}});
 fireEvent.click(screen.getByLabelText('I checked the beneficiary, materials, units and quantities for every row.'));
}
describe('captured file confirmation and truthful write outcomes',()=>{
 it('requires explicit mapping and confirmation, saves only the current file and leaves the second queued',async()=>{
  const {api,onSaved}=fixture();
  await prepare([new File(['a'],'first.csv'),new File(['b'],'second.csv')]);
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Save this file’s rows'}));
  await waitFor(()=>expect(onSaved).toHaveBeenCalledTimes(1));
  expect(api.save).toHaveBeenCalledWith('rev','first.csv',new Uint8Array([1,2,3]),[
   {sheet:0,row:2,quantity_column:1,name_column:0,code_column:null,unit_column:2,source_name:'Reagent',source_code:null,quantity_text:'11520',unit:'test',item_id:'item',beneficiary_id:'hospital'},
  ]);
  expect(api.save).toHaveBeenCalledTimes(1);expect(screen.getByText('second.csv')).toBeInTheDocument();
 });
 it('locks writes after an unknown outcome instead of blindly retrying',async()=>{
  const {api}=fixture();vi.mocked(api.save).mockRejectedValue(new Error('connection lost'));
  await prepare();fireEvent.click(screen.getByRole('button',{name:'Save this file’s rows'}));
  await screen.findByText(/Save outcome is unknown/);
  expect(screen.getByLabelText('Choose needs files')).toBeDisabled();
  expect(screen.getByRole('button',{name:'Save this file’s rows'})).toBeDisabled();
  expect(api.save).toHaveBeenCalledTimes(1);
 });
 it('does not report a confirmed save as failed merely because its source-history refresh failed',async()=>{
  const {api,onSaved}=fixture();vi.mocked(api.sources).mockRejectedValueOnce(new Error('read failed'));
  await prepare();fireEvent.click(screen.getByRole('button',{name:'Save this file’s rows'}));
  await screen.findByText('Save confirmed; source history refresh failed.');
  expect(screen.getByText('Saved 1 rows from first.csv.')).toBeInTheDocument();
  expect(onSaved).toHaveBeenCalledTimes(1);expect(api.save).toHaveBeenCalledTimes(1);
 });
});
