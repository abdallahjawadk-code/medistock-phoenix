/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SourceRecord } from '../../central-needs.service';

const setRecordDisposition = vi.fn();
const searchCentralItems = vi.fn();
vi.mock('../../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../../central-needs.service')>('../../central-needs.service');
  return {
    ...actual,
    setRecordDisposition: (...a: unknown[]) => setRecordDisposition(...a),
    searchCentralItems: (...a: unknown[]) => searchCentralItems(...a),
  };
});

const { SimpleMaterialCard } = await import('../SimpleMaterialCard');

afterEach(() => { cleanup(); setRecordDisposition.mockReset(); searchCentralItems.mockReset(); });

const rec = (over: Partial<SourceRecord>): SourceRecord => ({
  id: over.id ?? 'r1',
  importSessionId: 's1',
  recordOrdinal: 1,
  targetEntity: 'sheet:0:row:8',
  fieldName: 'col:1',
  sourceValues: { value: 'x' },
  sourceProvenance: { sheetIndex: 0, coordinate: { col: 1 } },
  ...over,
});

function renderCard(fields: SourceRecord[], editable = true) {
  return render(
    <SimpleMaterialCard
      lang="ar" importSessionId="s1" editable={editable} targetEntity="sheet:0:row:8" fields={fields} onResolved={() => {}}
    />,
  );
}

describe('SimpleMaterialCard — sections 13-14 (checklist items 7, 8, 9, 10, 11)', () => {
  it('never calls setRecordDisposition on mount — a suggestion is shown, never auto-persisted (checklist item 8)', async () => {
    searchCentralItems.mockResolvedValue([]);
    renderCard([rec({ id: 'r1', fieldName: 'ITEMS', sourceValues: { value: 'PARACETAMOL 500 MG' } })]);
    await waitFor(() => expect(searchCentralItems).toHaveBeenCalled());
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('shows every non-empty field of the row as evidence — never a single guessed "material name" (Advanced Mode’s own rule)', async () => {
    searchCentralItems.mockResolvedValue([]);
    renderCard([
      rec({ id: 'r1', fieldName: 'NATIONAL CODE', sourceValues: { value: '05-C00-036' } }),
      rec({ id: 'r2', fieldName: 'ITEMS', sourceValues: { value: 'PARACETAMOL 500 MG' } }),
    ]);
    const evidence = screen.getByTestId('cn2b-simple-material-evidence');
    expect(evidence).toHaveTextContent('05-C00-036');
    expect(evidence).toHaveTextContent('PARACETAMOL 500 MG');
  });

  it('shows the source unit ONLY from an exact unit-headed field, never from the material description (checklist items 9, 10)', async () => {
    searchCentralItems.mockResolvedValue([]);
    renderCard([
      rec({ id: 'r1', fieldName: 'ITEMS', sourceValues: { value: 'Bleomycin inj 15000 Units per vial' } }),
      rec({ id: 'r2', fieldName: 'UNIT', sourceValues: { value: 'Vial' } }),
    ]);
    expect(screen.getByTestId('cn2b-simple-material-unit-row')).toHaveTextContent('Vial');
    expect(screen.queryByTestId('cn2b-simple-unit-needs-review')).toBeNull();
  });

  it('when no field header is an exact unit match, the unit fails closed to "needs review" — never invented from free text (checklist items 10, 11)', async () => {
    searchCentralItems.mockResolvedValue([]);
    renderCard([
      rec({ id: 'r1', fieldName: 'ITEMS', sourceValues: { value: 'Bleomycin inj 15000 Units per vial' } }),
      rec({ id: 'r2', fieldName: 'col:2', sourceValues: { value: '750' } }),
    ]);
    expect(screen.getByTestId('cn2b-simple-unit-needs-review')).toBeInTheDocument();
  });

  it('a compound unit-labeled value ("Kit = 20 Tests") is shown verbatim, never parsed into a conversion factor', async () => {
    searchCentralItems.mockResolvedValue([]);
    renderCard([rec({ id: 'r1', fieldName: 'Unit', sourceValues: { value: 'Kit = 20 Tests' } })]);
    expect(screen.getByTestId('cn2b-simple-material-unit-row')).toHaveTextContent('Kit = 20 Tests');
  });

  it('an exact material-name match is offered as a suggestion; confirming it calls setRecordDisposition with decision=mapped (checklist item 7)', async () => {
    searchCentralItems.mockResolvedValue([{ id: 'item-1', name: 'Paracetamol 500 mg Tablet', unit: 'tablet' }]);
    renderCard([rec({ id: 'r1', fieldName: 'ITEMS', sourceValues: { value: 'Paracetamol 500 mg Tablet' } })]);
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-material-suggestion')).toHaveTextContent('Paracetamol 500 mg Tablet'));
    fireEvent.click(screen.getByText('صحيح'));
    await waitFor(() => expect(setRecordDisposition).toHaveBeenCalledTimes(1));
    expect(setRecordDisposition).toHaveBeenCalledWith({
      importSessionId: 's1', targetEntity: 'sheet:0:row:8', decision: 'mapped', centralItemId: 'item-1',
    });
  });

  it('the canonical unit is shown ALONGSIDE a suggestion, never written back as the source unit', async () => {
    searchCentralItems.mockResolvedValue([{ id: 'item-1', name: 'Paracetamol 500 mg Tablet', unit: 'tablet' }]);
    renderCard([rec({ id: 'r1', fieldName: 'ITEMS', sourceValues: { value: 'Paracetamol 500 mg Tablet' } })]);
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-material-suggestion')).toBeInTheDocument());
    expect(screen.getByTestId('cn2b-simple-unit-needs-review')).toBeInTheDocument();
  });

  it('no exact match: the primary action is search/pick, with no fabricated [صحيح] suggestion (mission section 3)', async () => {
    searchCentralItems.mockResolvedValue([{ id: 'item-9', name: 'Something Else Entirely', unit: 'box' }]);
    renderCard([rec({ id: 'r1', fieldName: 'ITEMS', sourceValues: { value: 'Unmatched Drug Name' } })]);
    await waitFor(() => expect(searchCentralItems).toHaveBeenCalled());
    expect(screen.queryByTestId('cn2b-simple-material-suggestion')).toBeNull();
    expect(screen.getByText('اختيار المادة')).toBeInTheDocument();
  });

  it('[ليست مادة] requires a typed reason before the confirm control is enabled', async () => {
    searchCentralItems.mockResolvedValue([]);
    renderCard([rec({ id: 'r1', fieldName: 'ITEMS', sourceValues: { value: 'Subtotal' } })]);
    fireEvent.click(screen.getByText('ليست مادة'));
    const confirmButton = screen.getByText('تأكيد: ليست مادة') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'سطر مجموع وليس مادة' } });
    fireEvent.click(screen.getByText('تأكيد: ليست مادة'));
    await waitFor(() => expect(setRecordDisposition).toHaveBeenCalledTimes(1));
    expect(setRecordDisposition).toHaveBeenCalledWith({
      importSessionId: 's1', targetEntity: 'sheet:0:row:8', decision: 'not_applicable', decisionReason: 'سطر مجموع وليس مادة',
    });
  });
});

describe('SimpleMaterialCard — permission parity (Director finding 2)', () => {
  const ROW = [rec({ id: 'r1', fieldName: 'ITEMS', sourceValues: { value: 'Paracetamol 500 mg Tablet' } })];

  it('editable=false renders NO mapping control and NO not-a-material control', async () => {
    searchCentralItems.mockResolvedValue([{ id: 'item-1', name: 'Paracetamol 500 mg Tablet', unit: 'tablet' }]);
    renderCard(ROW, false);
    await waitFor(() => expect(searchCentralItems).toHaveBeenCalled());
    expect(screen.queryByText('صحيح')).toBeNull();
    expect(screen.queryByText('اختيار مادة أخرى')).toBeNull();
    expect(screen.queryByText('اختيار المادة')).toBeNull();
    expect(screen.queryByText('ليست مادة')).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-material-picker')).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-material-not-applicable-reason')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('editable=false blocks the mapped write: setRecordDisposition is never called', async () => {
    searchCentralItems.mockResolvedValue([{ id: 'item-1', name: 'Paracetamol 500 mg Tablet', unit: 'tablet' }]);
    renderCard(ROW, false);
    await waitFor(() => expect(searchCentralItems).toHaveBeenCalled());
    for (const el of screen.queryAllByRole('button')) fireEvent.click(el);
    await Promise.resolve();
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('editable=false blocks the not_applicable write too', async () => {
    searchCentralItems.mockResolvedValue([]);
    renderCard([rec({ id: 'r1', fieldName: 'ITEMS', sourceValues: { value: 'Subtotal' } })], false);
    await waitFor(() => expect(searchCentralItems).toHaveBeenCalled());
    expect(screen.queryByText('ليست مادة')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    for (const el of screen.queryAllByRole('button')) fireEvent.click(el);
    await Promise.resolve();
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('editable=false still shows the row evidence, the unit state and the read-only reason', async () => {
    searchCentralItems.mockResolvedValue([]);
    renderCard(ROW, false);
    expect(screen.getByTestId('cn2b-simple-material-evidence')).toHaveTextContent('Paracetamol 500 mg Tablet');
    expect(screen.getByTestId('cn2b-simple-unit-needs-review')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-material-read-only')).toBeInTheDocument();
  });

  it('editable=true keeps the existing mapped write path working', async () => {
    searchCentralItems.mockResolvedValue([{ id: 'item-1', name: 'Paracetamol 500 mg Tablet', unit: 'tablet' }]);
    renderCard(ROW, true);
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-material-suggestion')).toBeInTheDocument());
    fireEvent.click(screen.getByText('صحيح'));
    await waitFor(() => expect(setRecordDisposition).toHaveBeenCalledTimes(1));
    expect(setRecordDisposition).toHaveBeenCalledWith({
      importSessionId: 's1', targetEntity: 'sheet:0:row:8', decision: 'mapped', centralItemId: 'item-1',
    });
  });
});
