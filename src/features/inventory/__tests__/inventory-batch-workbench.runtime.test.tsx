/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  renderBatch={(batch, selection) => <button key={batch.id} onClick={event => selection.onSelect(event.currentTarget)} aria-pressed={selection.selected}>{batch.batchNumber}</button>} />;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('real batch selection and read-only detail projection', () => {
  it('shows the first visible batch and selects a different batch without combining their stock', () => {
    render(rows([first, second]));
    const detail = screen.getByRole('complementary', { name: 'Material details' });
    expect(within(detail).getByRole('heading', { name: 'Amoxicillin' })).toBeVisible();
    expect(within(detail).getByText('17')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'LOT-B' }));
    expect(screen.getByRole('button', { name: 'LOT-A' })).toHaveAttribute('aria-pressed', 'false');
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
  it('opens narrow-screen details with heading focus and restores the selected row when returning', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    render(rows([first, second]));
    const trigger = screen.getByRole('button', { name: 'LOT-B' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('heading', { name: 'Paracetamol' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Back to batches' }));
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Back to batches' })).not.toBeInTheDocument();
  });
  it('keeps desktop selection focus with the row and closes a removed narrow-screen selection', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const view = render(rows([first, second]));
    const trigger = screen.getByRole('button', { name: 'LOT-B' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger).toHaveFocus();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    view.rerender(rows([first]));
    expect(screen.queryByRole('heading', { name: 'Paracetamol' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to batches' })).not.toBeInTheDocument();
  });
  it('keeps keyboard focus visible when resizing a selected desktop row into a narrow detail view', () => {
    const media = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal('matchMedia', () => media);
    render(rows([first, second]));
    const trigger = screen.getByRole('button', { name: 'LOT-B' });
    trigger.focus(); fireEvent.click(trigger);
    act(() => { media.matches = true; media.dispatchEvent(new Event('change')); });
    expect(screen.getByRole('heading', { name: 'Paracetamol' })).toHaveFocus();
  });
  it('preserves another control owner when resizing an already selected workbench', () => {
    const media = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal('matchMedia', () => media);
    render(<><input aria-label="Outside search" />{rows([first, second])}</>);
    fireEvent.click(screen.getByRole('button', { name: 'LOT-B' }));
    const outside = screen.getByRole('textbox', { name: 'Outside search' }); outside.focus();
    act(() => { media.matches = true; media.dispatchEvent(new Event('change')); });
    expect(outside).toHaveFocus();
  });
  it('moves focus from a narrow-only Back action when returning to desktop layout', () => {
    const media = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal('matchMedia', () => media);
    render(rows([first, second]));
    fireEvent.click(screen.getByRole('button', { name: 'LOT-B' }));
    screen.getByRole('button', { name: 'Back to batches' }).focus();
    act(() => { media.matches = false; media.dispatchEvent(new Event('change')); });
    expect(screen.getByRole('heading', { name: 'Paracetamol' })).toHaveFocus();
  });
});
