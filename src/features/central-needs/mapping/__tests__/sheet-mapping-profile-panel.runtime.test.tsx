/** @vitest-environment jsdom */
/**
 * E2-B.6 — the Sheet Mapping Profile panel, in isolation.
 *
 * REAL: the panel, `useSheetMappingProfile` and the pure reducer. The trusted
 * selections are produced by E2-A's own builders — exactly the objects the
 * stored source viewer reports. The full stored-source path (real panel,
 * worker, parser, bridge, grid) is in simple/__tests__/e2b-stored-mapping.
 */
import '@testing-library/jest-dom/vitest';
import { useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  buildCellSelection,
  buildColumnSelection,
  buildRangeSelection,
  type WorkbookSelection,
  type WorkbookSourceIdentity,
} from '../../excel-first/workbookSelection';
import { SheetMappingProfilePanel } from '../SheetMappingProfilePanel';
import { useSheetMappingProfile } from '../useSheetMappingProfile';

const SOURCE: WorkbookSourceIdentity = {
  batchId: 'batch-1', entryId: 'entry-1', entryOrdinal: 1, entrySha256: 'c'.repeat(64),
  importSessionId: 'session-1', workbookIndex: 0,
};
const SHEET = { sheetIndex: 0, sheetName: 'National Code' };
const column = (col: number, sheet = SHEET) => buildColumnSelection(SOURCE, sheet, col) as WorkbookSelection;

/** Feeds a selection exactly as StoredWorkbookPanel's onSelectionChange would. */
function Host({ lang, selection }: { lang: 'ar' | 'en'; selection: WorkbookSelection | null }) {
  const mapping = useSheetMappingProfile();
  const { observeSelection } = mapping;
  useEffect(() => { observeSelection(selection); }, [observeSelection, selection]);
  return <SheetMappingProfilePanel lang={lang} state={mapping.state} onAssign={mapping.assign} onClear={mapping.clear} />;
}

afterEach(cleanup);

const panel = () => screen.getByTestId('cn2b-map-panel');
const assignButton = (role: 'national_code' | 'material') => screen.getByTestId(`cn2b-map-assign-${role}`);
const roleRow = (role: 'national_code' | 'material') => screen.getByTestId(`cn2b-map-role-${role}`);

describe('E2-B.6 — without a trusted selection the panel is unavailable', () => {
  it('both role buttons are disabled, both roles unassigned, and the human is told how to proceed', () => {
    render(<Host lang="en" selection={null} />);
    expect(panel()).toHaveAttribute('data-mapping-state', 'unavailable');
    expect(assignButton('national_code')).toBeDisabled();
    expect(assignButton('material')).toBeDisabled();
    expect(roleRow('national_code')).toHaveTextContent('Not assigned');
    expect(roleRow('material')).toHaveTextContent('Not assigned');
    expect(screen.getByTestId('cn2b-map-unavailable')).toHaveTextContent(/source identity is proven/);
    expect(screen.queryByTestId('cn2b-map-clear-national_code')).toBeNull();
  });
});

describe('E2-B.7 — explicit human assignment from a whole column', () => {
  it('select column → assign National Code; select another → assign Material', () => {
    const view = render(<Host lang="en" selection={column(0)} />);
    expect(panel()).toHaveAttribute('data-mapping-state', 'ready');
    expect(screen.getByTestId('cn2b-map-selected')).toHaveTextContent('Column A');
    expect(assignButton('national_code')).toBeEnabled();
    expect(assignButton('national_code')).toHaveAccessibleName('Use column A as National Code');
    fireEvent.click(assignButton('national_code'));
    expect(roleRow('national_code')).toHaveAttribute('data-column-index', '0');
    expect(roleRow('national_code')).toHaveTextContent('Column A');
    expect(screen.getByTestId('cn2b-map-status')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('cn2b-map-status')).toHaveTextContent('Column A is now the National Code column.');

    view.rerender(<Host lang="en" selection={column(2)} />);
    expect(assignButton('material')).toHaveAccessibleName('Use column C as Material');
    fireEvent.click(assignButton('material'));
    expect(roleRow('material')).toHaveAttribute('data-column-index', '2');
    expect(roleRow('national_code')).toHaveAttribute('data-column-index', '0');
  });

  it('the same column cannot hold both roles: the conflict is announced and nothing changes', () => {
    render(<Host lang="en" selection={column(1)} />);
    fireEvent.click(assignButton('national_code'));
    fireEvent.click(assignButton('material'));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-testid', 'cn2b-map-alert');
    expect(alert).toHaveTextContent('Column B is already the National Code column.');
    expect(roleRow('national_code')).toHaveAttribute('data-column-index', '1');
    expect(roleRow('material')).toHaveAttribute('data-column-index', '');
  });

  it('clear and reassign; focus stays on a live control after clearing', () => {
    const view = render(<Host lang="en" selection={column(1)} />);
    fireEvent.click(assignButton('national_code'));
    const clear = screen.getByTestId('cn2b-map-clear-national_code');
    expect(clear).toHaveAccessibleName('Clear the National Code column (column B)');
    clear.focus();
    fireEvent.click(clear);
    expect(roleRow('national_code')).toHaveTextContent('Not assigned');
    expect(screen.getByTestId('cn2b-map-status')).toHaveTextContent('The National Code column is no longer assigned.');
    expect(document.activeElement).toBe(assignButton('national_code'));
    // Reassign the freed column to the other role.
    fireEvent.click(assignButton('material'));
    expect(roleRow('material')).toHaveAttribute('data-column-index', '1');
    view.rerender(<Host lang="en" selection={column(4)} />);
    fireEvent.click(assignButton('national_code'));
    expect(roleRow('national_code')).toHaveAttribute('data-column-index', '4');
  });

  it.each([
    ['a cell', buildCellSelection(SOURCE, SHEET, 3, 1) as WorkbookSelection, 'Cell B4'],
    ['a range', buildRangeSelection(SOURCE, SHEET, { row: 0, col: 0 }, { row: 2, col: 1 }) as WorkbookSelection, 'Range A1:B3'],
  ])('%s selection cannot assign a role', (_label, selection, shown) => {
    render(<Host lang="en" selection={selection} />);
    expect(panel()).toHaveAttribute('data-mapping-state', 'ready');
    expect(screen.getByTestId('cn2b-map-selected')).toHaveTextContent(shown);
    expect(assignButton('national_code')).toBeDisabled();
    expect(assignButton('material')).toBeDisabled();
    expect(screen.getByTestId('cn2b-map-column-required')).toHaveTextContent('select a whole column');
  });

  it('changing sheet (the viewer reports null, then the new sheet) starts an empty profile', () => {
    const view = render(<Host lang="en" selection={column(0)} />);
    fireEvent.click(assignButton('national_code'));
    view.rerender(<Host lang="en" selection={null} />);
    expect(panel()).toHaveAttribute('data-mapping-state', 'unavailable');
    view.rerender(<Host lang="en" selection={column(0, { sheetIndex: 1, sheetName: 'Other' })} />);
    expect(roleRow('national_code')).toHaveTextContent('Not assigned');
    // Returning to the first sheet does not resurrect its old draft.
    view.rerender(<Host lang="en" selection={null} />);
    view.rerender(<Host lang="en" selection={column(0)} />);
    expect(roleRow('national_code')).toHaveTextContent('Not assigned');
  });

  it('a role name comes from the button the human pressed, never from the sheet or header text', () => {
    // The sheet is literally named "National Code"; nothing is pre-assigned because of it.
    render(<Host lang="en" selection={column(0)} />);
    expect(screen.getByTestId('cn2b-map-sheet')).toHaveTextContent('National Code');
    expect(roleRow('national_code')).toHaveTextContent('Not assigned');
    expect(roleRow('material')).toHaveTextContent('Not assigned');
  });
});

describe('E2-B.8 — language, direction and keyboard', () => {
  it('Arabic renders right-to-left with Arabic copy', () => {
    render(<Host lang="ar" selection={column(1)} />);
    expect(panel()).toHaveAttribute('dir', 'rtl');
    expect(panel()).toHaveAttribute('lang', 'ar');
    expect(screen.getByRole('heading', { name: 'تعيين أدوار أعمدة الورقة' })).toBeInTheDocument();
    expect(assignButton('national_code')).toHaveAccessibleName('استخدام العمود B للرمز الوطني');
    fireEvent.click(assignButton('national_code'));
    expect(within(roleRow('national_code')).getByText('الرمز الوطني')).toBeInTheDocument();
    expect(roleRow('national_code')).toHaveTextContent('العمود B');
  });

  it('English renders left-to-right with English copy', () => {
    render(<Host lang="en" selection={column(1)} />);
    expect(panel()).toHaveAttribute('dir', 'ltr');
    expect(panel()).toHaveAttribute('lang', 'en');
    expect(screen.getByRole('heading', { name: 'Sheet mapping profile' })).toBeInTheDocument();
  });

  it('every control is a native, focusable button in document order; the panel is labelled by its heading', () => {
    render(<Host lang="en" selection={column(1)} />);
    fireEvent.click(assignButton('national_code'));
    expect(panel()).toHaveAccessibleName('Sheet mapping profile');
    const buttons = within(panel()).getAllByRole('button');
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button).toHaveAttribute('type', 'button');
      expect(Number(button.getAttribute('tabindex') ?? '0')).toBeLessThanOrEqual(0);
    }
    expect(screen.getByRole('group', { name: 'Assign the selected column' })).toBeInTheDocument();
    assignButton('material').focus();
    expect(document.activeElement).toBe(assignButton('material'));
  });
});
