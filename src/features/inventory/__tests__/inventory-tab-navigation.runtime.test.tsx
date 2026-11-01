/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleInventoryTabKeyDown } from '../inventory-tab-navigation';

afterEach(cleanup);
function fixture(dir: 'rtl' | 'ltr' = 'ltr') {
  const select = vi.fn();
  render(<div dir={dir}><div role="tablist" onKeyDown={handleInventoryTabKeyDown}>
    <button role="tab" aria-selected="true" tabIndex={0} onClick={select}>Stock</button>
    <button role="tab" aria-selected="false" tabIndex={-1} disabled>Not permitted</button>
    <button role="tab" aria-selected="false" tabIndex={-1} onClick={select}>Ledger</button>
    <button role="tab" aria-selected="false" tabIndex={-1} onClick={select}>Corrections</button>
  </div></div>);
  const stock = screen.getByRole('tab', { name: 'Stock' }); stock.focus();
  return { stock, ledger: screen.getByRole('tab', { name: 'Ledger' }),
    last: screen.getByRole('tab', { name: 'Corrections' }), select };
}
describe('manual inventory tab keyboard navigation', () => {
  it.each([['ltr', 'ArrowRight', 'ArrowLeft'], ['rtl', 'ArrowLeft', 'ArrowRight']] as const)(
    '%s arrows follow visual order, skip disabled tabs and wrap without activating a form', (dir, forward, backward) => {
      const f = fixture(dir);
      fireEvent.keyDown(f.stock, { key: forward }); expect(f.ledger).toHaveFocus();
      fireEvent.keyDown(f.ledger, { key: backward }); expect(f.stock).toHaveFocus();
      fireEvent.keyDown(f.stock, { key: backward }); expect(f.last).toHaveFocus();
      fireEvent.keyDown(f.last, { key: forward }); expect(f.stock).toHaveFocus();
      expect(f.select).not.toHaveBeenCalled(); expect(f.stock).toHaveAttribute('aria-selected', 'true');
    });
  it('Home and End move focus only; normal activation remains on the button', () => {
    const f = fixture(); fireEvent.keyDown(f.stock, { key: 'End' }); expect(f.last).toHaveFocus();
    fireEvent.click(f.last); expect(f.select).toHaveBeenCalledOnce();
    fireEvent.keyDown(f.last, { key: 'Home' }); expect(f.stock).toHaveFocus();
  });
  it('leaves vertical scrolling, Tab and modified browser shortcuts untouched', () => {
    const f = fixture();
    for (const key of ['ArrowDown', 'ArrowUp', 'Tab']) expect(fireEvent.keyDown(f.stock, { key })).toBe(true);
    expect(fireEvent.keyDown(f.stock, { key: 'ArrowRight', ctrlKey: true })).toBe(true);
    expect(f.stock).toHaveFocus(); expect(f.select).not.toHaveBeenCalled();
  });
});
