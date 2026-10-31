/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
vi.mock('@/shared/supabase/client', () => ({supabase: {rpc: vi.fn(), from: vi.fn()}}));
import {DossierWorkbookIntake, type WorkbookIntakeApi} from '../DossierWorkbookIntake';
import type {FileParseResult} from '../../import/contract';
import {CentralNeedsError} from '../../central-needs.service';
import type {DossierSource} from '../dossier-workbook';
afterEach(cleanup);
const parsed = {outcome: 'accepted', workbook: {sheets: [{index: 0, name: 'Needs', cells: [
  {coordinate: {row: 1, col: 0}, presence: 'value', valueType: 'string', rawValue: 'Reagent', isFormula: false},
  {coordinate: {row: 1, col: 1}, presence: 'value', valueType: 'number', rawValue: 11520, isFormula: false},
  {coordinate: {row: 1, col: 2}, presence: 'value', valueType: 'string', rawValue: 'test', isFormula: false},
  {coordinate: {row: 1, col: 3}, presence: 'value', valueType: 'number', rawValue: 240, isFormula: false},
]}]}} as FileParseResult;
function fixture(value = parsed) {
  const api: WorkbookIntakeApi = {parse: vi.fn(async () => ({parsed: value, bytes: new Uint8Array([1,2,3])})),
    save: vi.fn(async () => ({id: 'receipt', rows: 1, replay: false})), resume: vi.fn(async () => ({id: 'receipt', rows: 1, replay: false})),
    sources: vi.fn(async (): Promise<DossierSource[]> => []), download: vi.fn()};
  const onSaved = vi.fn();
  const search = vi.fn(async () => [{id: 'item', name: 'Reagent', nameAr: null, unit: 'test', concentration: null, dosageForm: null, nationalCode: '00043-A'}]);
  render(<DossierWorkbookIntake lang="en" year={2026} planId="plan" revisionId="rev" editable beneficiaries={[{id: 'hospital', name: 'Hospital', nameAr: 'مستشفى'}, {id: 'hospital2', name: 'Second hospital', nameAr: 'مستشفى ثان'}]} search={search} onSaved={onSaved} api={api} />);
  return {api, onSaved, search};
}
async function open(files = [new File(['fixture'], 'first.csv')]) {
  fireEvent.change(screen.getByLabelText('Choose needs files'), {target: {files}});
  fireEvent.click(screen.getByRole('button', {name: 'Preview next file'}));
  await screen.findByLabelText('Beneficiary for this column and region');
  fireEvent.change(screen.getByLabelText('Beneficiary for this column and region'), {target: {value: 'hospital'}});
}
async function prepare(files?: File[]) {
  await open(files);
  fireEvent.click(screen.getByRole('button', {name: 'Add region for review'}));
  fireEvent.click(screen.getByRole('button', {name: 'Find material'}));
  await screen.findByRole('option', {name: /00043-A/});
  fireEvent.change(screen.getByLabelText('Material for cell 0:2:1'), {target: {value: 'item'}});
  fireEvent.click(screen.getByLabelText('I confirmed the year, beneficiaries, codes, units, quantities and exclusions for this captured plan.'));
}
describe('matrix capture and truthful write outcomes', () => {
  it('captures explicit scope and year, saves only the current file and leaves the second queued', async () => {
    const {api, onSaved} = fixture(); await prepare([new File(['a'], 'first.csv'), new File(['b'], 'second.csv')]);
    expect(api.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: 'Capture plan and apply batches'}));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.save).mock.calls[0][0]).toMatchObject({planId: 'plan', revisionId: 'rev', filename: 'first.csv', year: 2026,
      rows: [{sheet: 0, row: 2, quantity_column: 1, source_name: 'Reagent', source_code: null, source_unit: 'test', quantity_text: '11520', unit: 'test', item_id: 'item', beneficiary_id: 'hospital'}], exclusions: []});
    expect(screen.getByText('second.csv')).toBeInTheDocument();
  });
  it('pauses unknown outcomes, reconciles by operation ID and needs separate consent before resume', async () => {
    const {api} = fixture(); vi.mocked(api.save).mockRejectedValue(new Error('connection lost'));
    await prepare(); fireEvent.click(screen.getByRole('button', {name: 'Capture plan and apply batches'}));
    await screen.findByText(/Saving is paused/);
    expect(screen.getByLabelText('Choose needs files')).toBeDisabled(); expect(api.save).toHaveBeenCalledTimes(1);
    const operation = vi.mocked(api.save).mock.calls[0][0].operationId;
    vi.mocked(api.sources).mockResolvedValue([{id: 'receipt', filename: 'first.csv', rows: 1, applied_rows: 0, can_resume: true, operation_id: operation, revision_id: 'rev', file_hash: 'hash'}]);
    fireEvent.click(screen.getByRole('button', {name: 'Refresh source history (read only)'}));
    await screen.findByText(/Readback confirmed/);
    expect(api.resume).not.toHaveBeenCalled(); expect(screen.getByRole('button', {name: 'Resume captured plan'})).toBeDisabled();
    fireEvent.click(screen.getByLabelText('I reviewed saved progress and confirm only the remaining captured batches.'));
    fireEvent.click(screen.getByRole('button', {name: 'Resume captured plan'}));
    await screen.findByText('Confirmed 1 saved rows.');
    expect(api.resume).toHaveBeenCalledWith('plan', 'rev', 'receipt', expect.objectContaining({aborted:false})); expect(api.save).toHaveBeenCalledTimes(1);
  });
  it('does not relabel a confirmed save when the subsequent source-history read fails', async () => {
    const {api, onSaved} = fixture(); vi.mocked(api.sources).mockRejectedValueOnce(new Error('read failed'));
    await prepare(); fireEvent.click(screen.getByRole('button', {name: 'Capture plan and apply batches'}));
    await screen.findByText('Save confirmed; source history refresh failed.');
    expect(screen.getByText('Confirmed 1 saved rows.')).toBeInTheDocument(); expect(onSaved).toHaveBeenCalledTimes(1);
  });
  it('captures two beneficiary columns from one physical row without importing their total', async () => {
    const {api} = fixture(); await open(); fireEvent.click(screen.getByRole('button', {name: 'Add region for review'}));
    fireEvent.change(screen.getByLabelText('Beneficiary for this column and region'), {target: {value: 'hospital2'}});
    fireEvent.change(screen.getByLabelText('Quantity column'), {target: {value: '4'}});
    fireEvent.click(screen.getByRole('button', {name: 'Add region for review'}));
    fireEvent.click(screen.getByRole('button', {name: 'Suggest matches for next 100 cells'}));
    await waitFor(() => expect(screen.getAllByRole('option', {name: /00043-A/})).toHaveLength(2));
    for (const key of ['0:2:1','0:2:3']) fireEvent.change(screen.getByLabelText(`Material for cell ${key}`), {target: {value: 'item'}});
    fireEvent.click(screen.getByLabelText('I confirmed the year, beneficiaries, codes, units, quantities and exclusions for this captured plan.'));
    fireEvent.click(screen.getByRole('button', {name: 'Capture plan and apply batches'}));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.save).mock.calls[0][0].rows.map((r) => [r.row,r.quantity_column,r.beneficiary_id,r.quantity_text])).toEqual([[2,1,'hospital','11520'],[2,3,'hospital2','240']]);
  });
  it('excludes Office lock files before parsing', async () => {
    const {api} = fixture(); const file = new File(['a'], 'real.xls');
    await open([new File(['owner metadata'], '~$lock.xlsx'), file]);
    expect(api.parse).toHaveBeenCalledTimes(1); expect(api.parse).toHaveBeenCalledWith(file);
    expect(screen.getByText('Office lock files were excluded before parsing.')).toBeInTheDocument();
  });
  it('reports an existing scope as a correction decision without leaving an uncertain capture', async () => {
    const {api} = fixture(); vi.mocked(api.save).mockRejectedValue(new CentralNeedsError('dossier_existing_manual_scope'));
    await prepare(); fireEvent.click(screen.getByRole('button', {name: 'Capture plan and apply batches'}));
    await screen.findByText(/A material\/beneficiary scope already exists/);
    expect(screen.getByRole('button', {name: 'Clear preview plan only'})).toBeEnabled(); expect(api.save).toHaveBeenCalledTimes(1);
  });

  it('can skip an unconfirmed preview and clear only the unsaved queue without a server mutation', async () => {
    const {api} = fixture(); await open([new File(['a'], 'first.csv'), new File(['b'], 'second.csv')]);
    fireEvent.click(screen.getByRole('button', {name: 'Skip unconfirmed file'}));
    expect(screen.queryByText('first.csv')).toBeNull(); expect(screen.getByText('second.csv')).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Preview next file'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button', {name: 'Clear unprocessed file queue'}));
    expect(screen.queryByText('second.csv')).toBeNull(); expect(api.save).not.toHaveBeenCalled(); expect(api.resume).not.toHaveBeenCalled();
  });

});
