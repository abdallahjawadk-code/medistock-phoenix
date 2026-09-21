/**
 * E2-B — React memory for ONE Sheet Mapping Profile draft.
 *
 * A thin `useReducer` over the pure transition contract in
 * `sheetMappingProfile.ts`. `observeSelection` is meant to be passed as-is to
 * the trusted source viewer's `onSelectionChange`, so every E2-A report is
 * applied synchronously as it happens. The draft lives only as long as the
 * component that calls this hook: nothing is persisted anywhere.
 */
import { useCallback, useReducer } from 'react';
import {
  INITIAL_SHEET_MAPPING_STATE,
  sheetMappingReducer,
  type MappingRole,
  type SheetMappingState,
} from './sheetMappingProfile';
import type { WorkbookSelection } from '../excel-first/workbookSelection';

export interface SheetMappingController {
  state: SheetMappingState;
  /** Feed E2-A's physical selection (or null) — the only way a context is established. */
  observeSelection: (selection: WorkbookSelection | null) => void;
  /** Declare `role` for the currently selected whole column. Takes no coordinates. */
  assign: (role: MappingRole) => void;
  clear: (role: MappingRole) => void;
}

export function useSheetMappingProfile(): SheetMappingController {
  const [state, dispatch] = useReducer(sheetMappingReducer, INITIAL_SHEET_MAPPING_STATE);
  const observeSelection = useCallback(
    (selection: WorkbookSelection | null) => dispatch({ type: 'selection_changed', selection }),
    [],
  );
  const assign = useCallback((role: MappingRole) => dispatch({ type: 'assign', role }), []);
  const clear = useCallback((role: MappingRole) => dispatch({ type: 'clear', role }), []);
  return { state, observeSelection, assign, clear };
}
