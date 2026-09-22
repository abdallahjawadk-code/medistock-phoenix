/**
 * C1 — Registry + Revision Context.
 *
 * The ONE place the Annual Needs screens derive, from the canonical registry
 * rows `listPlanRevisions` returns, which plan/revision is on screen and what
 * an explicit correction request would target. Advanced Mode, Simple Mode and
 * the service all read these functions, so no layer reconstructs its own
 * contradictory copy of a plan/revision fact.
 *
 * PURE: no Supabase, no React, no DOM, no network, no clock, no mutation.
 * Every input is an explicit argument; the same input always yields the same
 * output. The service type below is imported for its SHAPE only (`import
 * type`), which the compiler erases.
 *
 * WHAT THIS MODULE DOES NOT DECIDE
 *   * Lifecycle. Whether a correction may be opened, and what happens to the
 *     previous revision when it is, is the server's (M210 today; the governed
 *     correction lifecycle is C2). Nothing here marks a revision superseded,
 *     effective or current for operations.
 *   * Plan-level status. `central_needs_plans.status` is not established as
 *     operational truth (v32 AG-11) and is not read here.
 *
 * PD-1 — THE RULE THIS MODULE EXISTS FOR
 *   An explicit correction / open-next request targets the SELECTED revision's
 *   own plan year. The year is read from the revision and nowhere else: never
 *   the calendar year, never the new-draft year input, never another revision.
 *   A revision without a trustworthy plan year yields a refusal, not a guess.
 */
import type { PlanRevision, RevisionStatus } from './central-needs.service';

/** M209: `central_needs_plans.plan_year integer NOT NULL CHECK (plan_year BETWEEN 2000 AND 2100)`. */
export const PLAN_YEAR_MIN = 2000;
export const PLAN_YEAR_MAX = 2100;

/** A plan year the database could actually hold. Anything else is not trusted as a year. */
export function isTrustedPlanYear(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= PLAN_YEAR_MIN
    && value <= PLAN_YEAR_MAX;
}

/**
 * The canonical registry order: plan year DESC (a revision without a
 * trustworthy year last), then revision number DESC, then the revision id as a
 * deterministic final tie-break. Revision numbers restart per plan, so a number
 * is never compared across years before the year itself.
 */
export function compareRegistryRevisions(a: PlanRevision, b: PlanRevision): number {
  const ay = isTrustedPlanYear(a.planYear) ? a.planYear : null;
  const by = isTrustedPlanYear(b.planYear) ? b.planYear : null;
  if (ay !== by) {
    if (ay === null) return 1;
    if (by === null) return -1;
    return by - ay;
  }
  if (a.revisionNumber !== b.revisionNumber) return b.revisionNumber - a.revisionNumber;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** A sorted COPY in canonical registry order; the input is never mutated. */
export function sortRegistryRevisions(rows: readonly PlanRevision[]): PlanRevision[] {
  return [...rows].sort(compareRegistryRevisions);
}

/** Registry identity is the revision id — a revision number alone is not unique across years. */
export function findRegistryRevision(rows: readonly PlanRevision[], revisionId: string | null): PlanRevision | null {
  if (revisionId === null) return null;
  return rows.find((row) => row.id === revisionId) ?? null;
}

/**
 * C2 — the newest revision of the SELECTED revision's own plan, when it is
 * newer than the selection; null when the selection is itself the newest.
 *
 * The correction target never comes from here (it stays `deriveRevisionContext`
 * of the selection alone, and the server's stale fence checks the selected id).
 * This only tells the UI that a correction from an older revision would be
 * refused as stale, so it can say so instead of offering the action. Rows of
 * other plans (other years) are ignored: revision numbers restart per plan.
 */
export function newerRevisionOf(rows: readonly PlanRevision[], revision: PlanRevision | null): PlanRevision | null {
  if (revision === null) return null;
  let newest: PlanRevision | null = null;
  for (const row of rows) {
    if (row.planId !== revision.planId) continue;
    if (newest === null || row.revisionNumber > newest.revisionNumber) newest = row;
  }
  return newest !== null && newest.id !== revision.id && newest.revisionNumber > revision.revisionNumber ? newest : null;
}

/** Why no correction target can be named for the current selection. */
export type CorrectionRefusal = 'no_revision_selected' | 'revision_plan_year_unavailable';

/** The target of an explicit correction request, or the reason there is none. Never a guess. */
export type CorrectionTarget =
  | { ok: true; revisionId: string; planYear: number }
  | { ok: false; reason: CorrectionRefusal };

export interface RevisionContext {
  /** The selected registry row, or null when nothing is selected. */
  revision: PlanRevision | null;
  revisionId: string | null;
  /** The selected revision's own trustworthy plan year, or null. Never a fallback. */
  planYear: number | null;
  revisionNumber: number | null;
  status: RevisionStatus | null;
  isDraft: boolean;
  /** A selected revision that is no longer a draft. */
  isClosed: boolean;
  /**
   * The selected revision is approved or rejected — the only states after which
   * today's server (M210) accepts an explicit next-revision request. This
   * restates the existing server rule for the UI; it decides nothing.
   */
  acceptsNextRevisionRequest: boolean;
  /** What an explicit correction request would target, derived from the selection alone. */
  correction: CorrectionTarget;
}

/**
 * The context of the selected revision. Its only input is the revision itself,
 * so there is structurally no way for a draft-year input, the calendar or
 * another revision to leak into a correction target.
 */
export function deriveRevisionContext(revision: PlanRevision | null): RevisionContext {
  if (revision === null) {
    return {
      revision: null,
      revisionId: null,
      planYear: null,
      revisionNumber: null,
      status: null,
      isDraft: false,
      isClosed: false,
      acceptsNextRevisionRequest: false,
      correction: { ok: false, reason: 'no_revision_selected' },
    };
  }
  const planYear = isTrustedPlanYear(revision.planYear) ? revision.planYear : null;
  return {
    revision,
    revisionId: revision.id,
    planYear,
    revisionNumber: revision.revisionNumber,
    status: revision.status,
    isDraft: revision.status === 'draft',
    isClosed: revision.status !== 'draft',
    acceptsNextRevisionRequest: revision.status === 'approved' || revision.status === 'rejected',
    correction: planYear === null
      ? { ok: false, reason: 'revision_plan_year_unavailable' }
      : { ok: true, revisionId: revision.id, planYear },
  };
}
