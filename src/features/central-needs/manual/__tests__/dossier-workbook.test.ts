import { describe, expect, it } from 'vitest';
import { previewWorkbookRows, quantityCellText } from '../dossier-workbook';
import type { CellEvidence, SheetEvidence } from '../../import/contract';
import { catalogNationalCode, isMissingNationalCodeColumn } from '@/shared/materials/catalog-national-code';
const cell=(row:number,col:number,value:string|number,isFormula=false):CellEvidence=>({coordinate:{row,col,a1:`${col}:${row}`},presence:'value',valueType:typeof value==='number'?'number':'string',rawValue:value,isFormula,hasComment:false});
const sheet=(cells:CellEvidence[])=>({index:0,name:'Needs',cells} as SheetEvidence);
describe('workbook intake respects source values and explicit mapping',()=>{
  it('keeps leading-zero national code and exact decimal TEXT, with physical coordinates',()=>{
    const rows=previewWorkbookRows(sheet([cell(1,0,'Reagent'),cell(1,1,'00043-A00-001'),cell(1,2,'11520.25'),cell(1,3,'test')]),{headerRow:0,name:0,code:1,quantity:2,unit:3});
    expect(rows).toEqual([{sheet:0,row:2,quantityColumn:2,name:'Reagent',code:'00043-A00-001',quantityText:'11520.25',unit:'test',error:null}]);
  });
  it.each([0,11520,Number.MAX_SAFE_INTEGER])('preserves safe numeric integer %s',value=>expect(quantityCellText(cell(1,1,value))).toBe(String(value)));
  it.each([1.25,Number.MAX_SAFE_INTEGER+1,-1])('refuses unsafe or noncanonical numeric quantity %s',value=>expect(quantityCellText(cell(1,1,value))).toBeNull());
  it.each(['','01','١٢','1,200','1e3','1.0'])('does not silently normalize %s',value=>expect(quantityCellText(cell(1,1,value))).toBeNull());
  it('refuses formula cells, retaining zero as a value and blank as missing',()=>{
    expect(quantityCellText(cell(1,1,10,true))).toBeNull();expect(quantityCellText(undefined)).toBeNull();expect(quantityCellText(cell(1,1,'0'))).toBe('0');
  });
  it('does not coerce a numeric national code into text',()=>{
    const [r]=previewWorkbookRows(sheet([cell(1,0,'Reagent'),cell(1,1,123),cell(1,2,11520),cell(1,3,'test')]),{headerRow:0,name:0,code:1,quantity:2,unit:3});
    expect(r.error).toBe('national_code_requires_text');
  });
  it('refuses reused columns and excessive row counts',()=>{
    expect(()=>previewWorkbookRows(sheet([]),{headerRow:0,name:0,code:null,quantity:0,unit:1})).toThrow('workbook_columns_invalid');
    const cells=Array.from({length:101},(_,i)=>[cell(i+1,0,'Item'),cell(i+1,1,1),cell(i+1,2,'box')]).flat();
    expect(()=>previewWorkbookRows(sheet(cells),{headerRow:0,name:0,code:null,quantity:1,unit:2})).toThrow('workbook_row_limit_100');
  });
});
describe('national code is separate and compatible with old databases',()=>{
  it('uses a legacy barcode only when the national-code column is absent',()=>{
    expect(catalogNationalCode({barcode:'00012-A'})).toBe('00012-A');
    expect(catalogNationalCode({national_code:null,barcode:'840001'})).toBeNull();
    expect(catalogNationalCode({national_code:'00012-A',barcode:'840001'})).toBe('00012-A');
  });
  it('falls back only for the specific absent column, never authorization or network errors',()=>{
    expect(isMissingNationalCodeColumn({code:'42703',message:'column central_items.national_code does not exist'})).toBe(true);
    expect(isMissingNationalCodeColumn({code:'42501',message:'national_code permission denied'})).toBe(false);
    expect(isMissingNationalCodeColumn({code:'42703',message:'column other does not exist'})).toBe(false);
  });
});
