/**
 * E1.1 + E2-B + E2-C — the registered original source, and the mappings the
 * human builds on it: the Sheet Mapping Profile (National Code + Material
 * columns) and the institution mappings (name cell, Need source, beneficiary).
 *
 * Composition only. `StoredWorkbookPanel` is used unchanged; its existing
 * `onSelectionChange` bridge is the ONLY way E2-B and E2-C learn anything, and
 * it only ever reports selections whose source identity E2-A proved. One feed
 * reaches both drafts in the same call. No proven identity (refused, not yet
 * read, closed, another batch) → no selection → every mapping control stays
 * unavailable, while the source itself stays readable as E1.1 evidence.
 *
 * All mapping state lives in this component's memory. The workspace mounts it
 * with `key={revision.id}`, so a revision switch destroys both drafts together
 * with the source viewer; nothing is persisted.
 */
import type { ComponentProps } from 'react';
import { InstitutionMappingPanel, type BeneficiaryChoice } from '../mapping/InstitutionMappingPanel';
import { SheetMappingProfilePanel } from '../mapping/SheetMappingProfilePanel';
import { useWorkbookMapping } from '../mapping/useInstitutionMapping';
import { StoredWorkbookPanel } from './StoredWorkbookPanel';

/** The stored panel's own inputs; the selection bridge is wired here, not by the caller. */
type Props = Pick<ComponentProps<typeof StoredWorkbookPanel>, 'lang' | 'batches'> & {
  /**
   * E2-C: the active care institutions the screen already loaded — the ONLY
   * place a beneficiary id can come from. Optional for backwards-compatible
   * harnesses; with none, no institution mapping can be completed.
   */
  careInstitutions?: readonly BeneficiaryChoice[];
};

export function StoredWorkbookMapping({ lang, batches, careInstitutions = [] }: Props) {
  const mapping = useWorkbookMapping();
  return (
    <>
      <StoredWorkbookPanel lang={lang} batches={batches} onSelectionChange={mapping.observeSelection} />
      <SheetMappingProfilePanel
        lang={lang}
        state={mapping.sheet.state}
        onAssign={mapping.sheet.assign}
        onClear={mapping.sheet.clear}
      />
      <InstitutionMappingPanel
        lang={lang}
        controller={mapping.institutions}
        profile={mapping.sheet.state.profile}
        beneficiaries={careInstitutions}
      />
    </>
  );
}
