import {describe, expect, it} from 'vitest';
import type {CellEvidence, SheetEvidence} from '../../import/contract';
import {appendMatrixRegion, capturedMatrix, matrixRows, sameWorkbookUnit, type MatrixRegion} from '../dossier-workbook-matrix';
const c = (row: number, col: number, rawValue: string | number): CellEvidence => ({coordinate: {row,col,a1: ''},presence: 'value',valueType: typeof rawValue === 'string' ? 'string' : 'number',rawValue,isFormula: false,hasComment: false});
const sheet = {index: 0, name: 'Real-shaped matrix', cells: [c(1,0,'Reagent'),c(1,1,'00043-A00-001'),c(1,2,'test'),c(1,3,11520),c(1,4,240),c(1,5,11760)]} as SheetEvidence;
const region: MatrixRegion = {sheet: 0,headerRow: 0,firstRow: 2,lastRow: 2,name: 0,code: 1,unit: 2,quantity: 3,beneficiaryId: 'a'};
const option = {id: 'item',name: 'Reagent',nameAr: null,unit: 'test',concentration: null,dosageForm: null,nationalCode: '00043-A00-001'};
describe('physical quantity cells and captured human decisions', () => {
  it('preserves two institutions on one row, exact code and amount; never pulls in the total automatically', () => {
    const a = matrixRows(sheet, region); const b = matrixRows(sheet, {...region,quantity: 4,beneficiaryId: 'b'});
    const rows = appendMatrixRegion(a,b).map((r) => ({...r,matches: [option],selected: 'item'}));
    const plan = capturedMatrix(rows);
    expect(plan.selections.map((r) => [r.quantity_column,r.beneficiary_id,r.quantity_text,r.source_code])).toEqual([[3,'a','11520','00043-A00-001'],[4,'b','240','00043-A00-001']]);
  });
  it('rejects the same physical cell even with a different claimed beneficiary', () => {
    expect(() => appendMatrixRegion(matrixRows(sheet,region),matrixRows(sheet,{...region,beneficiaryId:'b'}))).toThrow('workbook_duplicate_or_excessive_region');
  });
  it('does not silently sum the same beneficiary/material from two columns', () => {
    const rows = [...matrixRows(sheet,region),...matrixRows(sheet,{...region,quantity:4})].map((r) => ({...r,matches:[option],selected:'item'}));
    expect(() => capturedMatrix(rows)).toThrow('workbook_duplicate_scope');
  });
  it('requires a reason for exclusion and retains its coordinates', () => {
    const rows = [...matrixRows(sheet,region),...matrixRows(sheet,{...region,quantity:4,beneficiaryId:'b'})].map((r) => ({...r,matches:[option],selected:'item'}));
    rows[1].excluded=true; expect(() => capturedMatrix(rows)).toThrow('workbook_exclusion_reason_required');
    rows[1].exclusionReason='Reviewed comparison column'; expect(capturedMatrix(rows).exclusions).toEqual([{sheet:0,row:2,quantity_column:4,reason:'Reviewed comparison column'}]);
  });
  it('supports the 727-row source shape without loosening canonical quantity validation', () => {
    const cells = Array.from({length:727},(_,i) => [c(i+1,0,'Reagent'),c(i+1,1,`00043-${i}`),c(i+1,2,'test'),c(i+1,3,11520)]).flat();
    expect(matrixRows({...sheet,cells},{...region,lastRow:728})).toHaveLength(727);
  });
  it('permits only typographic unit equivalence, never a pack/concentration conversion', () => {
    expect(sameWorkbookUnit(' TEST ','test')).toBe(true); expect(sameWorkbookUnit('kit','test')).toBe(false); expect(sameWorkbookUnit('pcs','piece')).toBe(false); expect(sameWorkbookUnit('(1ml vial)concentrated','vial')).toBe(false);
  });
});
