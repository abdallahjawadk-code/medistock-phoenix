/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WarehouseStockBatch } from '@/features/network/network.service';
import { InventoryBatchWorkbench } from '../InventoryBatchWorkbench';

const first: WarehouseStockBatch = {
  id: 'lot-a', warehouseId: 'warehouse-a', scientificName: 'Amoxicillin', nationalCode: 'N-A',
  batchNumber: 'LOT-A', expiryDate: '2027-09-30', concentration: '500 mg', dosageForm: 'Capsules', unit: 'Box',
  onHandQuantity: 20, reservedQuantity: 3, availableQuantity: 17,
  centralItemId: null, materialIdentityKey: null, internalBatchReference: null, supplyType: null, purchaseOrigin: null,
};
const second: WarehouseStockBatch = { ...first, id: 'lot-b', scientificName: 'Paracetamol', batchNumber: 'LOT-B', nationalCode: null,
  concentration: null, dosageForm: null, unit: null, expiryDate: null, onHandQuantity: 0, reservedQuantity: 0, availableQuantity: 0 };
const rows = (batches: WarehouseStockBatch[], lang: 'ar' | 'en' = 'en') => <InventoryBatchWorkbench batches={batches} lang={lang}
  renderBatch={(batch, selection) => <button key={batch.id} onClick={selection.onSelect} aria-pressed={selection.selected}>{batch.batchNumber}</button>} />;
afterEach(cleanup);

describe('real batch selection and read-only detail projection', () => {
  it('shows the first visible batch and selects a different batch without combining their stock', () => {
    render(rows([first, second]));
    const detail = screen.getByRole('complementary', { name: 'Material details' });
    expect(within(detail).getByRole('heading', { name: 'Amoxicillin' })).toBeVisible();
    expect(within(detail).getByText('17')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'LOT-B' }));
    expect(within(detail).getByRole('heading', { name: 'Paracetamol' })).toBeVisible();
    expect(within(detail).queryByText('17')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'LOT-B' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('never retains details from a removed or differently scoped result set', () => {
    const view = render(rows([first, second]));
    fireEvent.click(screen.getByRole('button', { name: 'LOT-B' }));
    view.rerender(rows([first]));
    expect(screen.getByRole('heading', { name: 'Amoxicillin' })).toBeVisible();
    view.rerender(rows([]));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByText('Amoxicillin')).not.toBeInTheDocument();
  });
  it('preserves missing identity as unknown and zero quantities as zero in Arabic', () => {
    render(rows([second], 'ar'));
    const detail = screen.getByRole('complementary', { name: 'ملف المادة' });
    expect(detail).toHaveAttribute('dir', 'rtl');
    expect(within(detail).getAllByText('غير مسجل').length).toBe(5);
    expect(within(detail).getAllByText('0').length).toBe(3);
    expect(within(detail).queryByRole('button')).not.toBeInTheDocument();
  });
});
