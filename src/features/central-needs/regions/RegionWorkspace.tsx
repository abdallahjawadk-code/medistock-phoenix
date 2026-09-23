/**
 * C4 — what the Simple workspace shares with the surfaces it mounts about
 * PERSISTED beneficiary regions, without widening their audited mount props:
 *
 *   * the revision's ACTIVE regions as the screen read them (or why it could
 *     not), which decide which columns are REGION-GOVERNED;
 *   * the write gate (`canWrite` = edit permission AND a draft revision), the
 *     revision's import sessions (their parser identities back G3) and the
 *     reload callback after a confirmed region write;
 *   * the unsaved E2-C Need sources of the sheet on the workbook view, so the
 *     Simple institution card can withhold its one-click confirm.
 *
 * Presentation plumbing only: the server stays the authority for every write.
 * Absent a provider (older harnesses), `useRegionWorkspace()` is null and every
 * consumer behaves exactly as before C4.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ImportSession } from '../central-needs.service';
import type { RegionReadState, UnsavedDraftSources } from './beneficiaryRegions';

export interface RegionWorkspace {
  regions: RegionReadState;
  canWrite: boolean;
  sessions: readonly ImportSession[];
  onChanged: () => void;
  unsavedDrafts: UnsavedDraftSources | null;
  setUnsavedDrafts: (drafts: UnsavedDraftSources | null) => void;
}

const RegionWorkspaceContext = createContext<RegionWorkspace | null>(null);

export function useRegionWorkspace(): RegionWorkspace | null {
  return useContext(RegionWorkspaceContext);
}

/**
 * `regions` undefined means the host supplied no region state (an older
 * harness): nothing is provided and every consumer behaves as before C4.
 */
export function RegionWorkspaceProvider({
  regions, canWrite, sessions, onChanged, children,
}: Omit<RegionWorkspace, 'unsavedDrafts' | 'setUnsavedDrafts' | 'regions'> & {
  regions: RegionReadState | undefined;
  children: ReactNode;
}) {
  const [unsavedDrafts, setUnsavedDrafts] = useState<UnsavedDraftSources | null>(null);
  const value = useMemo<RegionWorkspace | null>(
    () => (regions === undefined ? null : { regions, canWrite, sessions, onChanged, unsavedDrafts, setUnsavedDrafts }),
    [regions, canWrite, sessions, onChanged, unsavedDrafts],
  );
  return <RegionWorkspaceContext.Provider value={value}>{children}</RegionWorkspaceContext.Provider>;
}
