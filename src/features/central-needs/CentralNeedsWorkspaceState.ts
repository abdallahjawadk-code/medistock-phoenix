import type { ReviewReadiness, RevisionStatus } from './central-needs.service';
import type { CentralNeedsStageId } from './CentralNeedsWorkflowNav';

export type CentralNeedsStageProgress =
  | 'context'
  | 'complete'
  | 'needs-action'
  | 'waiting'
  | 'unknown'
  | 'refreshing'
  | 'not-ready'
  | 'ready'
  | 'submitted'
  | 'approved';

export type CentralNeedsStageProgressMap =
  Readonly<Record<CentralNeedsStageId, CentralNeedsStageProgress>>;

export const WORKFLOW_STAGES = ['source', 'review', 'beneficiaries', 'need-lines'] as const;

/**
 * Exported so a second presentation (e.g. Simple Mode's plain-language
 * readiness summary) can categorize the SAME known blocker codes without a
 * second, silently-divergent copy of this vocabulary. Any code absent from
 * this map must still be treated as unknown/fail-closed by every consumer —
 * see `KNOWN_BLOCKERS` below — never assumed complete.
 */
export const BLOCKERS_BY_STAGE: Readonly<Record<(typeof WORKFLOW_STAGES)[number], ReadonlySet<string>>> = {
  source: new Set([
    'no_finalized_import',
    'import_session_still_open',
    'completed_session_not_in_trusted_batch',
    'incomplete_trusted_batch',
  ]),
  review: new Set([
    'target_entity_without_disposition',
  ]),
  beneficiaries: new Set([
    'beneficiary_column_review_required',
  ]),
  'need-lines': new Set([
    'mapped_target_entity_without_need_line',
    'beneficiary_column_cell_without_need_line',
    'need_line_material_mapping_divergent',
    'need_line_unit_conversion_required',
    'need_line_warehouse_org_mismatch',
    'need_line_target_warehouse_not_active',
    'need_line_beneficiary_ineligible',
  ]),
};

export const KNOWN_BLOCKERS = new Set(
  WORKFLOW_STAGES.flatMap((stage) => [...BLOCKERS_BY_STAGE[stage]]),
);

export interface DeriveStageProgressInput {
  hasRevision: boolean;
  revisionStatus: RevisionStatus | null;
  revisionDataReady: boolean;
  refreshing: boolean;
  readiness: ReviewReadiness | null;
}

/**
 * UX-3R Package B presentation projection.
 *
 * This does NOT decide readiness. It projects the single server readiness
 * object into stage labels. Unknown blocker codes fail closed rather than
 * producing a synthetic completed stage.
 */
export function deriveCentralNeedsStageProgress({
  hasRevision,
  revisionStatus,
  revisionDataReady,
  refreshing,
  readiness,
}: DeriveStageProgressInput): CentralNeedsStageProgressMap {
  const progress: Record<CentralNeedsStageId, CentralNeedsStageProgress> = {
    plan: 'context',
    source: 'waiting',
    review: 'waiting',
    beneficiaries: 'waiting',
    'need-lines': 'waiting',
    readiness: 'unknown',
  };

  if (!hasRevision) return progress;

  if (!revisionDataReady || !readiness) {
    for (const stage of WORKFLOW_STAGES) progress[stage] = refreshing ? 'refreshing' : 'unknown';
    progress.readiness = refreshing ? 'refreshing' : 'unknown';
    return progress;
  }

  if (refreshing) {
    for (const stage of WORKFLOW_STAGES) progress[stage] = 'refreshing';
    progress.readiness = 'refreshing';
    return progress;
  }

  const blockers = readiness.blockers.map((b) => b.blocker);
  const hasUnknownBlocker = blockers.some((b) => !KNOWN_BLOCKERS.has(b));

  // §6.3 rules 3–5 first, with the dependency chain driven ONLY by MAPPED
  // blockers: a stage carrying its own blocker is actionable, every stage
  // behind it waits on a real prerequisite, and anything else would complete.
  let priorIncomplete = false;
  for (const stage of WORKFLOW_STAGES) {
    if (blockers.some((b) => BLOCKERS_BY_STAGE[stage].has(b))) {
      progress[stage] = 'needs-action';
      priorIncomplete = true;
      continue;
    }
    progress[stage] = priorIncomplete ? 'waiting' : 'complete';
  }

  // §6.3 rule 2 on top: a stage with a known own blocker may still show
  // NEEDS_ACTION, and every OTHER stage that would otherwise be complete
  // becomes UNKNOWN. An unmapped code may belong to any stage, so none may
  // claim a completion while one exists.
  //
  // Deriving the dependency chain from the unknown state itself (the earlier
  // reading) repainted the stages behind it as WAITING — a state that reads as
  // a benign prerequisite while the server is in fact reporting a blocker this
  // build cannot interpret. WAITING must never conceal UNKNOWN.
  if (hasUnknownBlocker) {
    for (const stage of WORKFLOW_STAGES) {
      if (progress[stage] === 'complete') progress[stage] = 'unknown';
    }
  }

  if (revisionStatus === 'approved') progress.readiness = 'approved';
  else if (revisionStatus === 'submitted') progress.readiness = 'submitted';
  else if (readiness.ready) progress.readiness = 'ready';
  else progress.readiness = 'not-ready';

  return progress;
}

export function recommendedCentralNeedsStage(
  hasRevision: boolean,
  progress: CentralNeedsStageProgressMap,
): CentralNeedsStageId {
  if (!hasRevision) return 'plan';
  for (const stage of WORKFLOW_STAGES) {
    if (progress[stage] === 'needs-action') return stage;
  }
  if (WORKFLOW_STAGES.some((stage) => progress[stage] === 'unknown')) return 'readiness';
  if (progress.readiness === 'not-ready'
    || progress.readiness === 'ready'
    || progress.readiness === 'submitted'
    || progress.readiness === 'approved') {
    return 'readiness';
  }
  return 'plan';
}

export function stageProgressLabelKey(progress: CentralNeedsStageProgress): string {
  return `cn2b_stage_state_${progress.replace('-', '_')}`;
}

const SESSION_ATTRIBUTABLE_BLOCKERS = new Set([
  'import_session_still_open',
  'completed_session_not_in_trusted_batch',
  'target_entity_without_disposition',
  'beneficiary_column_review_required',
  'mapped_target_entity_without_need_line',
  'beneficiary_column_cell_without_need_line',
]);

export interface SessionBlockerSummary {
  readonly bySession: ReadonlyMap<string, number>;
  readonly unattributed: number;
}

/**
 * Presentation-only attribution. It parses identifiers the server already
 * emitted; it never recomputes a blocker predicate.
 */
export function summarizeSessionBlockers(readiness: ReviewReadiness | null): SessionBlockerSummary {
  const bySession = new Map<string, number>();
  let unattributed = 0;
  if (!readiness) return { bySession, unattributed };

  for (const row of readiness.blockers) {
    if (!SESSION_ATTRIBUTABLE_BLOCKERS.has(row.blocker)) continue;
    const match = row.detail?.match(/(?:^|[\s,;])session=([^\s,;]+)/i);
    if (!match) {
      unattributed += 1;
      continue;
    }
    bySession.set(match[1], (bySession.get(match[1]) ?? 0) + 1);
  }
  return { bySession, unattributed };
}
