/**
 * C4 — which revision the screen opens, and the DISPLAY-ONLY "effective" label.
 *
 * REOPEN BY IDENTITY, NEVER BY POSITION. The screen used to open `rows[0]` of
 * the registry list — whatever the list handed over first. It now opens a
 * revision chosen by its lifecycle identity within the newest plan year:
 *   1. the plan's one open DRAFT — the only revision anything can be written to;
 *   2. otherwise the plan's LATEST revision by revision number — the lifecycle
 *      anchor every correction is fenced on (M215's expected latest revision),
 *      whatever its status, so Simple Mode can always follow it.
 * An ambiguous lifecycle — two open drafts, or two approved revisions in one
 * plan — opens nothing: the choice is never guessed. An id the person already
 * chose always wins. The effective (approved) revision is marked separately,
 * as a display label only.
 *
 * THE EFFECTIVE LABEL IS DISPLAY ONLY. `revision_lifecycle.effective_revision_id`
 * is a newest-first single-row pick, so the label is taken from it only when the
 * plan's revision list holds exactly one approved revision; more than one is
 * shown as "ambiguous" and marks nothing effective. No authority reads it.
 *
 * Pure: no React, no service, no network, no storage.
 */
import { sortRegistryRevisions } from './central-needs.revision-context';
import type { PlanRevision, RevisionLifecycle } from './central-needs.service';

export function revisionToOpen(rows: readonly PlanRevision[], chosenId: string | null): string | null {
  if (chosenId !== null && rows.some((r) => r.id === chosenId)) return chosenId;
  const ordered = sortRegistryRevisions(rows);
  if (ordered.length === 0) return null;
  const plan = ordered[0].planId;
  const ofPlan = ordered.filter((r) => r.planId === plan);
  if (ofPlan.filter((r) => r.status === 'approved').length > 1) return null;
  const drafts = ofPlan.filter((r) => r.status === 'draft');
  if (drafts.length > 1) return null;
  if (drafts.length === 1) return drafts[0].id;
  let latest = ofPlan[0];
  for (const r of ofPlan) if (r.revisionNumber > latest.revisionNumber) latest = r;
  return ofPlan.filter((r) => r.revisionNumber === latest.revisionNumber).length === 1 ? latest.id : null;
}

export type EffectiveLabel =
  | { kind: 'none' }
  | { kind: 'effective'; revisionId: string; revisionNumber: number }
  | { kind: 'ambiguous' };

/** The effective mark of one plan year, from the lifecycle read — or "ambiguous", fail closed. */
export function effectiveLabelOf(lifecycle: RevisionLifecycle): EffectiveLabel {
  const approved = lifecycle.revisions.filter((r) => r.status === 'approved' || r.effective);
  if (approved.length > 1) return { kind: 'ambiguous' };
  if (approved.length === 0) return { kind: 'none' };
  const only = approved[0];
  if (lifecycle.effectiveRevisionId !== only.id) return { kind: 'ambiguous' };
  return { kind: 'effective', revisionId: only.id, revisionNumber: only.revisionNumber };
}
