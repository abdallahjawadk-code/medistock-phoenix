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
 * cannot be repaired in this workflow and points at the readiness details for
 * diagnosis (no repair, replacement or re-import is promised: none exists in the
 * app), and each unsafe-lineage reason (§7.2) — read from the server's `reason=`
 * token, never from copy — says what resolves it. A lineage row whose reason
 * this build does not know fails closed to the advanced-review sentence.
 */
import { BLOCKERS_BY_STAGE, KNOWN_BLOCKERS } from '../CentralNeedsWorkspaceState';
import { numericOverrideLexeme, overrideHeads } from '../central-needs.lineage';
import { reasonOf, sourceRecordOf } from '../central-needs.service';
import type { FieldOverride, ReviewReadiness } from '../central-needs.service';

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
 * CN-UI-S1 HC1 / HC1.1 / HC1.2 / HC1.3 — CONTEXTUAL EXPERT ESCAPE (presentation-only).
 *
 * Simple is the complete NORMAL workflow — for valid, contract-conforming source
 * evidence — and offers no generic way into the Advanced workspace. But some
 * conditions the SERVER reports have no resolving control in Simple, and without
 * a way out the person would be stuck on a blocker they can read but not act on:
 *
 *   * `import_session_still_open`: an open import attempt is abandoned in the
 *     Advanced SOURCE stage — Simple has no abandon control;
 *   * a numeric correction the cell still needs (reason
 *     `source_quantity_override_value_invalid`, and the two HEAD-DEPENDENT reasons
 *     `source_quantity_requires_explicit_numeric_override` and `…_binding_invalid`
 *     when the cell's current head is absent or cannot be pinned — see
 *     `currentNumericHeadRemedyOf`): recorded in the Advanced DATA REVIEW stage —
 *     Simple has no override editor;
 *   * structurally invalid IMMUTABLE source evidence (C5 §7.1 — the blocker
 *     `source_cell_value_contract_invalid` and the lineage reason of the same
 *     name, ONE meaning): there is NO in-app control that replaces the evidence of
 *     a completed import, and the Source stage has none either. The escape opens
 *     the READINESS stage for diagnosis and controlled escalation ONLY — it claims
 *     nothing is repaired, replaced or re-imported anywhere;
 *   * a blocker code or lineage reason this build does not know, and a
 *     head-dependent reason whose current head cannot be PROVEN (the server's
 *     detail does not name the record, or the override chain was not read
 *     completely): fail closed to the READINESS stage for expert/diagnostic
 *     reading. That is NOT a claim the condition can be resolved there.
 *
 * C5 §7.2 / HC1.1 / HC1.2 — EVERY reason of `need_line_quantity_lineage_unsafe`
 * is classified by the table below, one entry per reason of M217's frozen
 * vocabulary. There is no default branch that treats an unlisted reason as
 * Simple-resolvable: a missing, malformed or future reason is UNKNOWN and fails
 * closed to the readiness stage. The table is keyed by the vocabulary's union
 * type, so a reason added to `M217_LINEAGE_REASONS` without a class does not
 * compile; a reason added only on the SERVER is unknown here and fails closed at
 * runtime (and a test reads the migration's own helper to catch that drift).
 *
 * Two reasons are CONDITION-AWARE (HEAD-DEPENDENT): `…_binding_invalid` and
 * `source_quantity_requires_explicit_numeric_override`. For both, the canonical
 * need-line panel can fix the refused link only by deleting the refused line and
 * designating the exact cell again, pinning the cell's CURRENT numeric head — so
 * Simple can resolve either only when that head exists AND can really be pinned. (The
 * server keeps reporting the second one until the link is rebuilt that way, even after
 * a numeric correction has been recorded; the route here changes the NEXT ACTION, not
 * the server's verdict.) ONE function, `currentNumericHeadRemedyOf`, decides it for
 * both: the head is read from the SAME already-loaded, complete override chain the
 * panel uses, through the SAME helpers (`overrideHeads`: the first row of the exact
 * `sourceRecordId` in server order, never a re-sort) and the SAME DETAIL parser
 * (`sourceRecordOf`). Nothing is searched by row, field, header or entity label, and
 * nothing is read from the server.
 *
 * "Can really be pinned" is the canonical `numericOverrideLexeme`, NOT merely
 * "is a number" (CN-UI-S1 HC1.4): a JSON-number override can be a finite, non-negative
 * number whose exact PostgreSQL text is still not a legal designated quantity — it must
 * be a plain decimal (no exponent, sign, leading zeros or whitespace; trailing fractional
 * zeros are fine) of at most 256 characters, sent untrimmed. The panel then has no exact
 * quantity to suggest for such a head, so the contribution starts blank (the server stays
 * the guard if a value is typed by hand); such a head needs a NEW, usable correction, which
 * only the Advanced DATA REVIEW stage records. No quantity grammar is written here: the
 * helper is the one authority for it.
 *
 * The inputs are the `ReviewReadiness` and the override chain the screen already
 * owns. It decides nothing about readiness: `ready` is read verbatim, a closed
 * revision never escapes (its blockers are informational), and ANY other blocker
 * — everything Simple does resolve, and merely `ready === false` — returns
 * nothing. Never inferred from a filename, header, entity name, UI state or
 * material text; never a new server read.
 *
 * When several apply they are returned in Advanced workflow order (source, then
 * review, then readiness). `deriveSimpleExpertEscape` is the first of them; the
 * list exists so the caller, which knows the person's permissions, can offer the
 * first one they can ACT on instead of a stage they cannot — the next one then
 * appears once the earlier one is resolved and the server re-reads.
 */
export type SimpleExpertStage = 'source' | 'review' | 'readiness';
export type SimpleExpertReason =
  | 'open_import'
  | 'numeric_override'
  | 'source_evidence_invalid'
  | 'override_head_unproven'
  | 'unknown_blocker'
  | 'unknown_lineage_reason';

export interface SimpleExpertEscape {
  readonly stage: SimpleExpertStage;
  readonly reason: SimpleExpertReason;
}

/** The ONE place that says which Advanced stage each escape reason opens. */
const ESCAPE_STAGE: Readonly<Record<SimpleExpertReason, SimpleExpertStage>> = {
  open_import: 'source',
  numeric_override: 'review',
  source_evidence_invalid: 'readiness',
  override_head_unproven: 'readiness',
  unknown_blocker: 'readiness',
  unknown_lineage_reason: 'readiness',
};

/** Advanced workflow order — stage by stage (source, review, readiness); within readiness, the most specific diagnosis first. */
const ESCAPE_ORDER: readonly SimpleExpertReason[] = [
  'open_import',
  'numeric_override',
  'source_evidence_invalid',
  'override_head_unproven',
  'unknown_blocker',
  'unknown_lineage_reason',
];

const OPEN_IMPORT_BLOCKER = 'import_session_still_open';

/** M217's frozen quantity-lineage reason vocabulary (migration 217 `_phoenix_central_needs_quantity_lineage_violation_v1`). */
export const M217_LINEAGE_REASONS = [
  'source_cell_value_contract_invalid',
  'source_quantity_requires_explicit_numeric_override',
  'source_quantity_override_binding_invalid',
  'source_quantity_override_value_invalid',
  'source_quantity_override_mismatch',
] as const;
export type M217LineageReason = (typeof M217_LINEAGE_REASONS)[number];

/**
 * Where a lineage reason is resolved.
 *   `simple`      — the canonical need-line panel Simple already mounts. It has no
 *                   in-place edit of a saved link, so the remedy is to DELETE the
 *                   line and designate its cells again (pinning the cell's current
 *                   numeric head, with an equal contribution);
 *   `expert`      — only in Advanced: a numeric correction recorded in DATA REVIEW;
 *   `diagnostic`  — no in-app remedy is claimed; the readiness stage shows what the
 *                   server returned;
 *   `head_dependent` — `…_binding_invalid` and `…_requires_explicit_numeric_override`:
 *                   decided from the cell's current head (see
 *                   `currentNumericHeadRemedyOf`); never one fixed answer.
 */
export type LineageRemedy =
  | { readonly route: 'simple' }
  | { readonly route: 'expert'; readonly reason: 'numeric_override' }
  | { readonly route: 'diagnostic'; readonly reason: 'source_evidence_invalid' | 'override_head_unproven' }
  | { readonly route: 'head_dependent' };

const LINEAGE_REMEDY_BY_REASON: Readonly<Record<M217LineageReason, LineageRemedy>> = {
  // The immutable evidence itself is invalid and no in-app control replaces it: diagnose, claim nothing.
  source_cell_value_contract_invalid: { route: 'diagnostic', reason: 'source_evidence_invalid' },
  // The link pins no override. Simple can rebuild it (delete + designate again, pinning the current head) only while a PINNABLE numeric head exists;
  // until one is recorded (with the canonical Advanced override editor) it cannot — the same condition as the stale pin below.
  source_quantity_requires_explicit_numeric_override: { route: 'head_dependent' },
  // The pin is not the cell's current head: only resolvable in Simple while that head exists and can be pinned (`numericOverrideLexeme`).
  source_quantity_override_binding_invalid: { route: 'head_dependent' },
  // The pinned head is null / not a number / negative: Simple never creates a numeric override, so only Advanced can record a valid one.
  source_quantity_override_value_invalid: { route: 'expert', reason: 'numeric_override' },
  // The designated contribution differs from the pinned override: delete the line in the panel and designate again with an EQUAL contribution.
  source_quantity_override_mismatch: { route: 'simple' },
};

/** A Map, never an object lookup: a reason token such as `constructor` or `__proto__` must stay unknown. */
const LINEAGE_REMEDY_LOOKUP: ReadonlyMap<string, LineageRemedy> = new Map(Object.entries(LINEAGE_REMEDY_BY_REASON));

/**
 * The remedy of ONE lineage reason token, or `null` when the token is missing,
 * malformed or not in M217's vocabulary (a future reason) — which is never
 * Simple-resolvable by assumption.
 */
export function lineageRemedyOf(reason: string | null): LineageRemedy | null {
  return reason === null ? null : LINEAGE_REMEDY_LOOKUP.get(reason) ?? null;
}

/**
 * The override chain the screen ALREADY holds, handed to the derivation as-is.
 * `overrideReadFailure` is `null` only when the revision's COMPLETE chain was
 * read (C5 §13); any other value means the chain cannot be trusted.
 */
export interface SimpleOverrideContext {
  readonly overrides: readonly FieldOverride[];
  readonly overrideReadFailure: string | null;
}

/** A remedy that is already decided — never `head_dependent`, so resolving one can never recurse. */
export type ResolvedLineageRemedy = Exclude<LineageRemedy, { readonly route: 'head_dependent' }>;

/** The three answers a HEAD-DEPENDENT lineage row can get. */
const SIMPLE_REMEDY: ResolvedLineageRemedy = { route: 'simple' };
const NEEDS_NUMERIC_CORRECTION: ResolvedLineageRemedy = { route: 'expert', reason: 'numeric_override' };
const HEAD_UNPROVEN: ResolvedLineageRemedy = { route: 'diagnostic', reason: 'override_head_unproven' };

/**
 * The CONDITION-AWARE answer for the two HEAD-DEPENDENT reasons
 * (`source_quantity_override_binding_invalid` and
 * `source_quantity_requires_explicit_numeric_override`) — the ONLY place that
 * reads the override head.
 *
 *   exact record unknown, or no trustworthy chain  → diagnostic (the head is unproven)
 *   chain complete, the record has NO current head → expert (a numeric correction is needed)
 *   chain complete, the current head cannot be pinned (text, blank, negative, or a number
 *     whose exact text is not a canonical quantity — exponent form, longer than 256
 *     characters, …)                                 → expert (a new, usable correction is needed)
 *   chain complete, the current head CAN be pinned   → simple (delete + designate again, pinning it)
 *
 * The record is the exact whole `source_record=` token of the server's own
 * DETAIL (`sourceRecordOf`); the head is `overrideHeads(...).get(record)` — the
 * first row of that exact record in the chain's server order. A pinnable override
 * of ANOTHER record, or an older pinnable override behind a newer head that cannot
 * be pinned, never makes the answer `simple`.
 */
export function currentNumericHeadRemedyOf(
  detail: string | null | undefined,
  context: SimpleOverrideContext | undefined,
): ResolvedLineageRemedy {
  const record = sourceRecordOf(detail);
  if (record === null || context === undefined || context.overrideReadFailure !== null) return HEAD_UNPROVEN;
  const head = overrideHeads(context.overrides).get(record);
  return head !== undefined && numericOverrideLexeme(head) !== null ? SIMPLE_REMEDY : NEEDS_NUMERIC_CORRECTION;
}

/** HC1.2's name for the same decision, kept for its callers: `…_binding_invalid` consumes the shared head logic, it has none of its own. */
export function bindingInvalidRemedyOf(
  detail: string | null | undefined,
  context: SimpleOverrideContext | undefined,
): ResolvedLineageRemedy {
  return currentNumericHeadRemedyOf(detail, context);
}

/** Compile-time proof that every route is handled; at runtime an unhandled one fails closed (diagnostic). */
function failClosed(unhandled: never): SimpleExpertReason {
  void unhandled;
  return 'unknown_lineage_reason';
}

function noteRemedy(found: Set<SimpleExpertReason>, remedy: LineageRemedy, detail: string | null | undefined, context: SimpleOverrideContext | undefined): void {
  switch (remedy.route) {
    case 'simple':
      return; // the canonical need-line panel Simple already mounts resolves it — no escape
    case 'expert':
    case 'diagnostic':
      found.add(remedy.reason);
      return;
    case 'head_dependent':
      noteRemedy(found, currentNumericHeadRemedyOf(detail, context), detail, context);
      return;
    default:
      found.add(failClosed(remedy));
  }
}

export function deriveSimpleExpertEscapes(
  readiness: ReviewReadiness | null,
  context?: SimpleOverrideContext,
): readonly SimpleExpertEscape[] {
  if (!readiness || readiness.ready || readiness.status !== 'draft') return [];
  const found = new Set<SimpleExpertReason>();
  for (const b of readiness.blockers) {
    if (!KNOWN_BLOCKERS.has(b.blocker)) {
      found.add('unknown_blocker');
    } else if (b.blocker === OPEN_IMPORT_BLOCKER) {
      found.add('open_import');
    } else if (b.blocker === SOURCE_EVIDENCE_INVALID) {
      found.add('source_evidence_invalid');
    } else if (b.blocker === QUANTITY_LINEAGE_UNSAFE) {
      const remedy = lineageRemedyOf(reasonOf(b.detail));
      if (remedy === null) found.add('unknown_lineage_reason');
      else noteRemedy(found, remedy, b.detail, context);
    }
  }
  return ESCAPE_ORDER.filter((reason) => found.has(reason)).map((reason) => ({ stage: ESCAPE_STAGE[reason], reason }));
}

/** The first escape in workflow order, or null — see `deriveSimpleExpertEscapes`. */
export function deriveSimpleExpertEscape(readiness: ReviewReadiness | null, context?: SimpleOverrideContext): SimpleExpertEscape | null {
  return deriveSimpleExpertEscapes(readiness, context)[0] ?? null;
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
