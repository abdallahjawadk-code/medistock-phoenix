/**
 * E1.1 + E2-B — the registered original source, and the Sheet Mapping Profile
 * the human builds on it.
 *
 * Composition only. `StoredWorkbookPanel` is used unchanged; its existing
 * `onSelectionChange` bridge is the ONLY way E2-B learns anything, and it only
 * ever reports selections whose source identity E2-A proved. No proven identity
 * (refused, not yet read, closed, another batch) → no selection → the mapping
 * controls stay unavailable, while the source itself stays readable as E1.1
 * evidence.
 *
 * All E2-B state lives in this component's memory. The workspace mounts it with
 * `key={revision.id}`, so a revision switch destroys the draft together with
 * the source viewer; nothing is persisted.
 */
import type { ComponentProps } from 'react';
import { SheetMappingProfilePanel } from '../mapping/SheetMappingProfilePanel';
import { useSheetMappingProfile } from '../mapping/useSheetMappingProfile';
import { StoredWorkbookPanel } from './StoredWorkbookPanel';

/** Exactly the stored panel's own inputs; the selection bridge is wired here, not by the caller. */
type Props = Pick<ComponentProps<typeof StoredWorkbookPanel>, 'lang' | 'batches'>;

export function StoredWorkbookMapping({ lang, batches }: Props) {
  const mapping = useSheetMappingProfile();
  return (
    <>
      <StoredWorkbookPanel lang={lang} batches={batches} onSelectionChange={mapping.observeSelection} />
      <SheetMappingProfilePanel lang={lang} state={mapping.state} onAssign={mapping.assign} onClear={mapping.clear} />
    </>
  );
}
