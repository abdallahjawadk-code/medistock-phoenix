/**
 * E1.1 + E2-B + E2-C + E2-D — the registered original source, the mappings the
 * human builds on it (the Sheet Mapping Profile: National Code + Material
 * columns; the institution mappings: name cell, Need source, beneficiary), and
 * the human's explicit LOCAL approval of that whole mapping.
 *
 * Composition only. `StoredWorkbookPanel` is used unchanged; its existing
 * `onSelectionChange` bridge is the ONLY way E2-B and E2-C learn anything, and
 * it only ever reports selections whose source identity E2-A proved. One feed
 * reaches both drafts in the same call. No proven identity (refused, not yet
 * read, closed, another batch) → no selection → every mapping control stays
 * unavailable, while the source itself stays readable as E1.1 evidence.
 *
 * E2-D reads the E2-B and E2-C state and the revision's id — identity only: it
 * never reads or changes the revision's status and never submits or approves it.
 *
 * All mapping and approval state lives in this component's memory. The
 * workspace mounts it with `key={revision.id}`, so a revision switch destroys
 * the drafts and any local approval together with the source viewer; nothing is
 * persisted.
 *
 * C4 — PERSISTED REGIONS. Next to those unsaved drafts, `BeneficiaryRegionLayer`
 * shows the server's ACTIVE beneficiary regions of the sheet on screen as a
 * separate layer and is the only place a draft becomes server truth — with a
 * reason, fenced, and only when `canWrite` (edit permission AND a draft
 * revision) and the G3 parser-identity check both hold. Its inputs come from
 * the workspace's region context, so this component's own props and the
 * selection bridge above are unchanged. Region truth always reloads from the
 * server; nothing here is kept across revisions or reloads.
 */
import { useMemo, type ComponentProps } from 'react';
import { InstitutionMappingPanel, type BeneficiaryChoice } from '../mapping/InstitutionMappingPanel';
import { MappingApprovalGatePanel } from '../mapping/MappingApprovalGatePanel';
import { SheetMappingProfilePanel } from '../mapping/SheetMappingProfilePanel';
import { useWorkbookMapping } from '../mapping/useInstitutionMapping';
import { useMappingApprovalGate } from '../mapping/useMappingApprovalGate';
import { StoredWorkbookPanel } from './StoredWorkbookPanel';
import { BeneficiaryRegionLayer } from '../regions/BeneficiaryRegionLayer';
import { useRegionWorkspace } from '../regions/RegionWorkspace';

/** The stored panel's own inputs; the selection bridge is wired here, not by the caller. */
type Props = Pick<ComponentProps<typeof StoredWorkbookPanel>, 'lang' | 'batches'> & {
  /**
   * E2-C: the active care institutions the screen already loaded — the ONLY
   * place a beneficiary id can come from. Optional for backwards-compatible
   * harnesses; with none, no institution mapping can be completed.
   */
  careInstitutions?: readonly BeneficiaryChoice[];
  /**
   * E2-D: the id of the Annual Needs revision this workbook belongs to, bound
   * into the approval evidence. Optional for backwards-compatible harnesses;
   * without it the mapping cannot be approved.
   */
  planRevisionId?: string | null;
};

export function StoredWorkbookMapping({ lang, batches, careInstitutions = [], planRevisionId = null }: Props) {
  const mapping = useWorkbookMapping();
  // C4: the workspace's region context (write gate, sessions, reload); absent in older harnesses.
  const regionWorkspace = useRegionWorkspace();
  const eligibleBeneficiaryIds = useMemo(() => careInstitutions.map((b) => b.id), [careInstitutions]);
  const approval = useMappingApprovalGate({
    planRevisionId,
    sheet: mapping.sheet.state,
    institutions: mapping.institutions.state,
    eligibleBeneficiaryIds,
  });
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
      {planRevisionId !== null && regionWorkspace !== null && (
        <BeneficiaryRegionLayer
          lang={lang}
          planRevisionId={planRevisionId}
          canWrite={regionWorkspace.canWrite}
          careInstitutions={careInstitutions}
          sessions={regionWorkspace.sessions}
          institutions={mapping.institutions}
          onChanged={regionWorkspace.onChanged}
          onUnsavedDraftsChange={regionWorkspace.setUnsavedDrafts}
        />
      )}
      <MappingApprovalGatePanel lang={lang} approval={approval} />
    </>
  );
}
