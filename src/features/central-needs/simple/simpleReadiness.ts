/**
 * Annual Needs — Simple Mode readiness summarizer.
 *
 * `fetchReviewReadiness()` remains the sole business-readiness authority
 * (CentralNeedsWorkspaceState.ts's own header note). This module does the
 * SAME kind of projection `deriveCentralNeedsStageProgress` already does —
 * reading the server's own blocker codes and categorizing them — just into
 * plainer, Simple-Mode-facing language. It reuses the SAME known-blocker
 * vocabulary (`BLOCKERS_BY_STAGE`, `KNOWN_BLOCKERS`) so there is exactly one
 * place in the codebase that knows which blocker codes exist, never a
 * second, silently-divergent copy.
 *
 * FAIL-CLOSED: any blocker code this module does not recognize is reported
 * as the generic "needs advanced review" message, and `ready` is NEVER
 * synthesized here — it is read verbatim from `readiness.ready`.
 */
import { BLOCKERS_BY_STAGE, KNOWN_BLOCKERS } from '../CentralNeedsWorkspaceState';
import type { ReviewReadiness } from '../central-needs.service';

export type SimpleBlockerCategory = 'source' | 'beneficiary' | 'material' | 'need_line' | 'unknown';

export interface SimpleReadinessSummary {
  /** Verbatim from the server — never recomputed. */
  ready: boolean;
  /** Verbatim from the server. */
  status: ReviewReadiness['status'];
  /** How many of the server's own blocker rows fall in each plain category. */
  countsByCategory: Readonly<Record<SimpleBlockerCategory, number>>;
  /** i18n keys for the plain-language lines to show, one per category present, in a stable order. */
  messageKeys: readonly string[];
  /** True when at least one blocker code is outside the known vocabulary. */
  hasUnknownBlocker: boolean;
}

const CATEGORY_ORDER: readonly SimpleBlockerCategory[] = ['source', 'beneficiary', 'material', 'need_line', 'unknown'];

const MESSAGE_KEY_BY_CATEGORY: Readonly<Record<SimpleBlockerCategory, string>> = {
  source: 'cn2b_simple_blocker_source',
  beneficiary: 'cn2b_simple_blocker_beneficiary',
  material: 'cn2b_simple_blocker_material',
  need_line: 'cn2b_simple_blocker_need_line',
  unknown: 'cn2b_simple_blocker_unknown',
};

function categoryOf(blocker: string): SimpleBlockerCategory {
  if (!KNOWN_BLOCKERS.has(blocker)) return 'unknown';
  if (BLOCKERS_BY_STAGE.source.has(blocker)) return 'source';
  if (BLOCKERS_BY_STAGE.beneficiaries.has(blocker)) return 'beneficiary';
  if (BLOCKERS_BY_STAGE.review.has(blocker)) return 'material';
  if (BLOCKERS_BY_STAGE['need-lines'].has(blocker)) return 'need_line';
  // A code present in KNOWN_BLOCKERS but not found in any category set above
  // cannot occur given how KNOWN_BLOCKERS is built, but the fallback keeps
  // this function total and still fails closed rather than throwing.
  return 'unknown';
}

/**
 * Summarizes a server `ReviewReadiness` object into Simple Mode's plain
 * categories. Returns `null` when there is nothing to summarize yet (no
 * readiness loaded) — the caller must show a loading/unknown state, never
 * assume readiness.
 */
export function summarizeSimpleReadiness(readiness: ReviewReadiness | null): SimpleReadinessSummary | null {
  if (!readiness) return null;
  const countsByCategory: Record<SimpleBlockerCategory, number> = {
    source: 0, beneficiary: 0, material: 0, need_line: 0, unknown: 0,
  };
  let hasUnknownBlocker = false;
  for (const b of readiness.blockers) {
    const category = categoryOf(b.blocker);
    countsByCategory[category] += 1;
    if (category === 'unknown') hasUnknownBlocker = true;
  }
  const messageKeys = CATEGORY_ORDER
    .filter((category) => countsByCategory[category] > 0)
    .map((category) => MESSAGE_KEY_BY_CATEGORY[category]);
  return {
    ready: readiness.ready,
    status: readiness.status,
    countsByCategory,
    messageKeys,
    hasUnknownBlocker,
  };
}
