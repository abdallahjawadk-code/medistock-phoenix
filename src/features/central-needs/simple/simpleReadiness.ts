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
 *
 * C5 §7 — the two M217 blockers get their OWN plain sentences instead of the
 * category's generic one: invalid immutable source evidence (§7.1) says it
 * needs a controlled replacement, and each unsafe-lineage reason (§7.2) — read
 * from the server's `reason=` token, never from copy — says what resolves it.
 * A lineage row whose reason this build does not know fails closed to the
 * advanced-review sentence.
 */
import { BLOCKERS_BY_STAGE, KNOWN_BLOCKERS } from '../CentralNeedsWorkspaceState';
import { reasonOf } from '../central-needs.service';
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

/** C5 §7.1 — invalid immutable source evidence (stage SOURCE). */
const SOURCE_EVIDENCE_INVALID = 'source_cell_value_contract_invalid';
/** C5 §7.2 — unsafe quantity lineage (stage NEED-LINES). */
const QUANTITY_LINEAGE_UNSAFE = 'need_line_quantity_lineage_unsafe';

/** C5 §7.2 — the exact reason vocabulary, in the shared helper's first-failure order, each with its own sentence. */
const LINEAGE_MESSAGE_KEY_BY_REASON: ReadonlyArray<readonly [string, string]> = [
  ['source_cell_value_contract_invalid', 'cn2b_simple_blocker_lineage_source_cell_value_contract_invalid'],
  ['source_quantity_requires_explicit_numeric_override', 'cn2b_simple_blocker_lineage_source_quantity_requires_explicit_numeric_override'],
  ['source_quantity_override_binding_invalid', 'cn2b_simple_blocker_lineage_source_quantity_override_binding_invalid'],
  ['source_quantity_override_value_invalid', 'cn2b_simple_blocker_lineage_source_quantity_override_value_invalid'],
  ['source_quantity_override_mismatch', 'cn2b_simple_blocker_lineage_source_quantity_override_mismatch'],
];
const SOURCE_EVIDENCE_INVALID_MESSAGE_KEY = 'cn2b_simple_blocker_source_evidence_invalid';
const LINEAGE_REASON_UNRECOGNIZED_MESSAGE_KEY = 'cn2b_simple_blocker_lineage_reason_unrecognized';

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
  // How many rows of each category the category's GENERIC sentence covers;
  // the two C5 blockers are described by their own sentences instead.
  const genericByCategory: Record<SimpleBlockerCategory, number> = {
    source: 0, beneficiary: 0, material: 0, need_line: 0, unknown: 0,
  };
  let sourceEvidenceInvalid = false;
  const lineageReasons = new Set<string>();
  let hasUnknownBlocker = false;
  for (const b of readiness.blockers) {
    const category = categoryOf(b.blocker);
    countsByCategory[category] += 1;
    if (category === 'unknown') hasUnknownBlocker = true;
    if (b.blocker === SOURCE_EVIDENCE_INVALID) sourceEvidenceInvalid = true;
    else if (b.blocker === QUANTITY_LINEAGE_UNSAFE) lineageReasons.add(reasonOf(b.detail) ?? '');
    else genericByCategory[category] += 1;
  }
  const specificKeys = (category: SimpleBlockerCategory): string[] => {
    if (category === 'source' && sourceEvidenceInvalid) return [SOURCE_EVIDENCE_INVALID_MESSAGE_KEY];
    if (category !== 'need_line' || lineageReasons.size === 0) return [];
    const known = LINEAGE_MESSAGE_KEY_BY_REASON.filter(([reason]) => lineageReasons.has(reason)).map(([, key]) => key);
    const unrecognized = [...lineageReasons].some((reason) => !LINEAGE_MESSAGE_KEY_BY_REASON.some(([r]) => r === reason));
    return unrecognized ? [...known, LINEAGE_REASON_UNRECOGNIZED_MESSAGE_KEY] : known;
  };
  const messageKeys = CATEGORY_ORDER.flatMap((category) => [
    ...(genericByCategory[category] > 0 ? [MESSAGE_KEY_BY_CATEGORY[category]] : []),
    ...specificKeys(category),
  ]);
  return {
    ready: readiness.ready,
    status: readiness.status,
    countsByCategory,
    messageKeys,
    hasUnknownBlocker,
  };
}
