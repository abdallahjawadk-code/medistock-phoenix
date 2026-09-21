/**
 * E2-C — React memory for the institution mappings of ONE trusted sheet, and
 * the single selection feed shared with E2-B.
 *
 * `useInstitutionMapping` is a thin `useReducer` over the pure transition
 * contract in `institutionMapping.ts`. `useWorkbookMapping` composes it with
 * E2-B's unchanged `useSheetMappingProfile`: its `observeSelection` is meant to
 * be passed as-is to the trusted source viewer's `onSelectionChange`, and hands
 * every E2-A report to BOTH reducers in the same call, so the two drafts can
 * never disagree about which source and sheet they belong to. Nothing is
 * persisted anywhere; the drafts live only as long as the calling component.
 */
import { useCallback, useReducer } from 'react';
import {
  INITIAL_INSTITUTION_MAPPING_STATE,
  institutionMappingReducer,
  type InstitutionMappingState,
} from './institutionMapping';
import type { SheetMappingProfile } from './sheetMappingProfile';
import { useSheetMappingProfile, type SheetMappingController } from './useSheetMappingProfile';
import type { WorkbookSelection } from '../excel-first/workbookSelection';

export interface InstitutionMappingController {
  state: InstitutionMappingState;
  /** Feed E2-A's physical selection (or null) — the only way a context is established. */
  observeSelection: (selection: WorkbookSelection | null) => void;
  /** Take the current selection as the institution's name cell. Takes no coordinates. */
  captureAnchor: () => void;
  /** Take the current selection as the institution's Need source. Takes no coordinates. */
  captureNeed: () => void;
  /** The id of the option the human chose in the trusted institution list, or null for none. */
  chooseBeneficiary: (beneficiaryOrganizationId: string | null) => void;
  commit: (checks: { profile: SheetMappingProfile | null; eligibleBeneficiaryIds: readonly string[] }) => void;
  edit: (id: string) => void;
  cancelEdit: () => void;
  remove: (id: string) => void;
  requestReset: () => void;
  confirmReset: () => void;
  cancelReset: () => void;
}

export function useInstitutionMapping(): InstitutionMappingController {
  const [state, dispatch] = useReducer(institutionMappingReducer, INITIAL_INSTITUTION_MAPPING_STATE);
  const observeSelection = useCallback(
    (selection: WorkbookSelection | null) => dispatch({ type: 'selection_changed', selection }),
    [],
  );
  const captureAnchor = useCallback(() => dispatch({ type: 'capture_anchor' }), []);
  const captureNeed = useCallback(() => dispatch({ type: 'capture_need' }), []);
  const chooseBeneficiary = useCallback(
    (beneficiaryOrganizationId: string | null) => dispatch({ type: 'choose_beneficiary', beneficiaryOrganizationId }),
    [],
  );
  const commit = useCallback(
    ({ profile, eligibleBeneficiaryIds }: { profile: SheetMappingProfile | null; eligibleBeneficiaryIds: readonly string[] }) =>
      dispatch({ type: 'commit', profile, eligibleBeneficiaryIds }),
    [],
  );
  const edit = useCallback((id: string) => dispatch({ type: 'edit', id }), []);
  const cancelEdit = useCallback(() => dispatch({ type: 'cancel_edit' }), []);
  const remove = useCallback((id: string) => dispatch({ type: 'remove', id }), []);
  const requestReset = useCallback(() => dispatch({ type: 'request_reset' }), []);
  const confirmReset = useCallback(() => dispatch({ type: 'confirm_reset' }), []);
  const cancelReset = useCallback(() => dispatch({ type: 'cancel_reset' }), []);
  return {
    state, observeSelection, captureAnchor, captureNeed, chooseBeneficiary, commit,
    edit, cancelEdit, remove, requestReset, confirmReset, cancelReset,
  };
}

export interface WorkbookMappingController {
  /** E2-B: National Code and Material columns. */
  sheet: SheetMappingController;
  /** E2-C: institution name cells, Need sources and beneficiaries. */
  institutions: InstitutionMappingController;
  /** The one selection feed for both drafts. */
  observeSelection: (selection: WorkbookSelection | null) => void;
}

export function useWorkbookMapping(): WorkbookMappingController {
  const sheet = useSheetMappingProfile();
  const institutions = useInstitutionMapping();
  const observeSheet = sheet.observeSelection;
  const observeInstitutions = institutions.observeSelection;
  const observeSelection = useCallback((selection: WorkbookSelection | null) => {
    observeSheet(selection);
    observeInstitutions(selection);
  }, [observeSheet, observeInstitutions]);
  return { sheet, institutions, observeSelection };
}
