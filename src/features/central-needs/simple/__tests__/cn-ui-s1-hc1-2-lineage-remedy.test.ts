/**
 * CN-UI-S1 HC1.2 — LINEAGE REMEDY CLOSURE, at the derivation (H1_2_01 … H1_2_12,
 * H1_2_14/15/16, H1_2_19 … H1_2_24).
 *
 *   A. `source_quantity_override_binding_invalid` is CONDITION-AWARE. Simple can
 *      resolve it only by deleting the refused line and designating the exact cell
 *      again, pinning the cell's CURRENT numeric head — so it escapes unless that
 *      head is proven to exist and be numeric, in the complete override chain the
 *      screen already holds, read with the canonical `overrideHeads` /
 *      `isNumericOverride` / `sourceRecordOf` helpers.
 *   B. `source_cell_value_contract_invalid` (the blocker AND the lineage reason —
 *      ONE meaning) has NO in-app remedy: it is a DIAGNOSTIC escape to READINESS,
 *      never a route to SOURCE, and its copy promises no replacement, re-import or
 *      repair.
 *
 * The real-screen proof that the Simple remedy actually works (H1_2_13) and the
 * landing / presentation-only proofs (H1_2_17, H1_2_18) are in
 * `cn-ui-s1-hc1-2-screen.runtime.test.tsx`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { T } from '@/shared/i18n/strings';
import type { FieldOverride, ReviewReadiness } from '../../central-needs.service';
import {
  M217_LINEAGE_REASONS, bindingInvalidRemedyOf, deriveSimpleExpertEscape, deriveSimpleExpertEscapes,
  type SimpleOverrideContext,
} from '../simpleReadiness';

const ROOT = join(__dirname, '../../../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** The code of a source file: block and line comments removed, so a rule is judged on what runs, not on what is explained. */
const codeOf = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const LINEAGE = 'need_line_quantity_lineage_unsafe';
const BINDING = 'source_quantity_override_binding_invalid';
const bindingRow = (detail: string | null) => ({ blocker: LINEAGE, detail });
/** The server's own DETAIL format: `session=%s source_record=%s need_line=%s reason=%s`. */
const detailFor = (record: string | null, reason: string | null = BINDING) =>
  [`session=s1`, record === null ? null : `source_record=${record}`, 'need_line=nl-1', reason === null ? null : `reason=${reason}`].filter(Boolean).join(' ');
const readiness = (blockers: ReviewReadiness['blockers'], over: Partial<ReviewReadiness> = {}): ReviewReadiness => ({
  planRevisionId: 'rev-1', status: 'draft', ready: false, blockers, ...over,
});
let seq = 0;
const override = (sourceRecordId: string, finalValue: unknown, createdAt = '2026-09-26T10:00:00+00:00'): FieldOverride => ({
  id: `ov-${(seq += 1)}`, sourceRecordId, targetEntity: 'row-5', fieldName: 'qty', previousValue: null, finalValue,
  finalValueText: typeof finalValue === 'number' ? String(finalValue) : JSON.stringify(finalValue),
  overrideReason: 'reviewed', overrideNote: null, createdAt,
});
const chain = (...overrides: FieldOverride[]): SimpleOverrideContext => ({ overrides, overrideReadFailure: null });
const bindingFor = (record: string | null) => readiness([bindingRow(detailFor(record))]);

const SIMPLE: never[] = []; // "no escape"
const REVIEW = [{ stage: 'review', reason: 'numeric_override' }];
const UNPROVEN = [{ stage: 'readiness', reason: 'override_head_unproven' }];

describe('H1_2_01 … H1_2_12 — binding_invalid is decided from the cell\'s CURRENT head', () => {
  it('H1_2_01 — complete chain + the exact record\'s current head is numeric → NO expert escape (Simple\'s panel resolves it)', () => {
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), chain(override('rec-5', 12)))).toEqual(SIMPLE);
    expect(deriveSimpleExpertEscape(bindingFor('rec-5'), chain(override('rec-5', 0)))).toBeNull(); // zero is a valid non-negative number
    expect(bindingInvalidRemedyOf(detailFor('rec-5'), chain(override('rec-5', 12)))).toEqual({ route: 'simple' });
  });

  it('H1_2_02 — the head is `overrideHeads()` of the chain AS IT ARRIVED: the first row of the exact record in server order, never a re-sort by time', () => {
    // Server order is "created_at DESC, id DESC": the FIRST row is the head, whatever its timestamp says here.
    const firstIsNumericButOlder = chain(override('rec-5', 12, '2026-01-01T00:00:00+00:00'), override('rec-5', 'newer text', '2026-09-30T00:00:00+00:00'));
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), firstIsNumericButOlder)).toEqual(SIMPLE);
    const firstIsTextButOlder = chain(override('rec-5', 'text', '2026-01-01T00:00:00+00:00'), override('rec-5', 12, '2026-09-30T00:00:00+00:00'));
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), firstIsTextButOlder)).toEqual(REVIEW);
    // …and the implementation is the canonical helper, with no ordering of its own.
    const src = codeOf('src/features/central-needs/simple/simpleReadiness.ts');
    // (HC1.4: the numeric test is the canonical PINNABILITY helper `numericOverrideLexeme`, no longer the bare `isNumericOverride`.)
    expect(src).toContain("import { numericOverrideLexeme, overrideHeads } from '../central-needs.lineage';");
    expect(src).toContain('const head = overrideHeads(context.overrides).get(record);');
    expect(src).not.toMatch(/\.sort\(|\.toSorted\(|\.reverse\(|createdAt|localeCompare|Date\.parse|new Date/);
    // No second head rule and no second numeric rule are written here.
    expect(src).not.toMatch(/typeof [a-z.]*finalValue|Number\.isFinite|>= 0|new Map\(\)/);
  });

  it('H1_2_03 — a numeric head belonging to ANOTHER sourceRecordId does not satisfy the condition', () => {
    const otherRecordOnly = chain(override('rec-OTHER', 12), override('rec-6', 7));
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), otherRecordOnly)).toEqual(REVIEW);
    // Near-misses of the exact id are other records too.
    for (const near of ['rec-50', 'rec-', 'REC-5', ' rec-5']) {
      expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), chain(override(near, 12))), near).toEqual(REVIEW);
    }
    // And the exact record, among others, is found.
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), chain(override('rec-OTHER', 'x'), override('rec-5', 12)))).toEqual(SIMPLE);
  });

  it('H1_2_04 — no current head at all (an empty chain) → the DATA REVIEW stage', () => {
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), chain())).toEqual(REVIEW);
    expect(bindingInvalidRemedyOf(detailFor('rec-5'), chain())).toEqual({ route: 'expert', reason: 'numeric_override' });
  });

  it('H1_2_05 — the current head is a TEXT override → the DATA REVIEW stage', () => {
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), chain(override('rec-5', 'twelve')))).toEqual(REVIEW);
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), chain(override('rec-5', '12')))).toEqual(REVIEW); // numeric TEXT is still text
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), chain(override('rec-5', true)))).toEqual(REVIEW);
  });

  it('H1_2_06 — the current head is null / blank → the DATA REVIEW stage', () => {
    for (const blank of [null, '', '   ']) {
      expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), chain(override('rec-5', blank))), JSON.stringify(blank)).toEqual(REVIEW);
    }
  });

  it('H1_2_07 — the current head is negative or otherwise non-numeric → the DATA REVIEW stage', () => {
    for (const bad of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, { value: 12 }, [12]]) {
      expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), chain(override('rec-5', bad))), String(bad)).toEqual(REVIEW);
    }
  });

  it('H1_2_08 — binding_invalid with NO `source_record=` token → a READINESS diagnostic (the head is unproven; nothing is guessed)', () => {
    // (A row with no `reason=` either is simply an unknown lineage reason — proven in H1_2_21.)
    for (const detail of [detailFor(null), 'need_line=nl-1 reason=' + BINDING, 'session=s1 reason=' + BINDING]) {
      expect(deriveSimpleExpertEscapes(readiness([bindingRow(detail as string | null)]), chain(override('rec-5', 12))), String(detail)).toEqual(UNPROVEN);
    }
    // Not even when a numeric head exists for every record in the chain: no record is named, so none is assumed.
    expect(bindingInvalidRemedyOf(detailFor(null), chain(override('rec-5', 12), override('rec-6', 9)))).toEqual({ route: 'diagnostic', reason: 'override_head_unproven' });
  });

  it('H1_2_09 — a malformed / non-whole-token `source_record` → a READINESS diagnostic; nothing is searched by row, field, header or entity', () => {
    const numericEverywhere = chain(override('rec-5', 12), override('r1', 12), override('', 12));
    for (const detail of [
      'session=s1 xsource_record=rec-5 need_line=nl-1 reason=' + BINDING,        // a longer key
      'session=s1 note=source_record=rec-5 need_line=nl-1 reason=' + BINDING,     // inside another value
      'session=s1 source_record= need_line=nl-1 reason=' + BINDING,               // empty token
      'rec-5 reason=' + BINDING,                                                  // bare text, no key
      'session=s1 SOURCE_RECORD=rec-5 need_line=nl-1 reason=' + BINDING,          // case differs
    ]) {
      expect(deriveSimpleExpertEscapes(readiness([bindingRow(detail)]), numericEverywhere), detail).toEqual(UNPROVEN);
    }
    // Words that look like the record elsewhere in the row change nothing: only the whole `source_record=` token decides.
    const decoy = 'session=rec-5 target_entity=rec-5 field=rec-5 need_line=rec-5 reason=' + BINDING;
    expect(deriveSimpleExpertEscapes(readiness([bindingRow(decoy)]), chain(override('rec-5', 12)))).toEqual(UNPROVEN);
  });

  it('H1_2_10 — the override chain is unavailable → a READINESS diagnostic, even though an array of overrides came with it', () => {
    for (const failure of ['field_overrides_not_loaded', 'field_overrides_read_inconsistent', 'central_needs_request_failed', 'x']) {
      expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), { overrides: [override('rec-5', 12)], overrideReadFailure: failure }), failure).toEqual(UNPROVEN);
    }
    // No context at all (an older harness) is the same: the head cannot be proven, so it is not assumed.
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'))).toEqual(UNPROVEN);
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), undefined)).toEqual(UNPROVEN);
  });

  it('H1_2_11 — an older NUMERIC override behind a NEWER non-numeric head → the DATA REVIEW stage (the client never picks the convenient older one)', () => {
    const newestIsText = chain(override('rec-5', 'newest text', '2026-09-30T00:00:00+00:00'), override('rec-5', 12, '2026-09-01T00:00:00+00:00'));
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), newestIsText)).toEqual(REVIEW);
    const newestIsNull = chain(override('rec-5', null, '2026-09-30T00:00:00+00:00'), override('rec-5', 5, '2026-09-01T00:00:00+00:00'), override('rec-5', 6, '2026-08-01T00:00:00+00:00'));
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), newestIsNull)).toEqual(REVIEW);
  });

  it('H1_2_12 — the NEWEST head is numeric and an older one is not → resolvable in Simple (no escape)', () => {
    const newestIsNumeric = chain(override('rec-5', 12, '2026-09-30T00:00:00+00:00'), override('rec-5', 'old text', '2026-09-01T00:00:00+00:00'), override('rec-5', null, '2026-08-01T00:00:00+00:00'));
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), newestIsNumeric)).toEqual(SIMPLE);
  });

  it('several binding rows: each is judged on ITS OWN record — one unproven / non-numeric head is enough to escape, and the escapes are deduplicated', () => {
    const rows = readiness([bindingRow(detailFor('rec-5')), bindingRow(detailFor('rec-6')), bindingRow(detailFor(null))]);
    expect(deriveSimpleExpertEscapes(rows, chain(override('rec-5', 12), override('rec-6', 'text')))).toEqual([
      { stage: 'review', reason: 'numeric_override' },
      { stage: 'readiness', reason: 'override_head_unproven' },
    ]);
    expect(deriveSimpleExpertEscapes(readiness([bindingRow(detailFor('rec-5')), bindingRow(detailFor('rec-6'))]), chain(override('rec-5', 12), override('rec-6', 3)))).toEqual(SIMPLE);
  });

  it('it reads only the context it is handed: the chain is never mutated, and the answer is the same every time', () => {
    const ctx = chain(override('rec-5', 'text'), override('rec-5', 12));
    const before = JSON.stringify(ctx);
    const first = deriveSimpleExpertEscapes(bindingFor('rec-5'), ctx);
    expect(deriveSimpleExpertEscapes(bindingFor('rec-5'), ctx)).toEqual(first);
    expect(JSON.stringify(ctx)).toBe(before);
  });
});

describe('H1_2_14 / H1_2_15 / H1_2_16 — invalid IMMUTABLE evidence: a diagnosis, not a remedy', () => {
  const standalone = { blocker: 'source_cell_value_contract_invalid', detail: 'session=s1 source_record=rec-5 reason=invalid_evidence' };
  const asLineage = bindingRow(detailFor('rec-5', 'source_cell_value_contract_invalid'));
  const DIAGNOSTIC = [{ stage: 'readiness', reason: 'source_evidence_invalid' }];

  it('H1_2_14 — the standalone blocker → READINESS diagnostic, and NEVER the source stage', () => {
    const escapes = deriveSimpleExpertEscapes(readiness([standalone]));
    expect(escapes).toEqual(DIAGNOSTIC);
    expect(escapes.some((e) => e.stage === 'source')).toBe(false);
  });

  it('H1_2_15 — the lineage reason → the SAME READINESS diagnostic, and NEVER the source stage; one meaning, even when both rows are present', () => {
    const escapes = deriveSimpleExpertEscapes(readiness([asLineage]));
    expect(escapes).toEqual(DIAGNOSTIC);
    expect(escapes.some((e) => e.stage === 'source')).toBe(false);
    expect(deriveSimpleExpertEscapes(readiness([standalone, asLineage]))).toEqual(DIAGNOSTIC);
    expect(deriveSimpleExpertEscapes(readiness([asLineage, standalone]))).toEqual(deriveSimpleExpertEscapes(readiness([standalone, asLineage])));
  });

  it('only an open import attempt still opens the SOURCE stage — nothing about invalid evidence does', () => {
    const all = readiness([standalone, asLineage, { blocker: 'import_session_still_open', detail: 'session=s9 status=pending' }]);
    expect(deriveSimpleExpertEscapes(all).filter((e) => e.stage === 'source')).toEqual([{ stage: 'source', reason: 'open_import' }]);
  });

  it('H1_2_16 (superseded by HC1.3 — the copy is now the truthful diagnosis) — the copy promises no replacement, re-import, repair or automatic fix, in either language', () => {
    const body = T.cn2b_simple_expert_body_source_evidence_invalid;
    // HC1.3 removed the "controlled source-replacement action" HC1.2 had used verbatim: the Readiness stage offers no such action.
    expect(body.en).toBe('The immutable source evidence is invalid under the safety contract. It cannot be repaired in this workflow. The “__STAGE__” stage provides diagnostic details for controlled escalation; opening it does not itself resolve the evidence problem.');
    expect(body.ar).toBe('بيانات المصدر الأصلية غير صالحة وفق عقد السلامة. لا يمكن إصلاح هذا الدليل داخل دورة العمل الحالية. تعرض مرحلة «__STAGE__» تفاصيل تشخيصية للتصعيد المضبوط، لكن فتحها لا يحل مشكلة الدليل بحد ذاته.');
    // It does NOT say a stage replaces it, that re-import fixes it, that Advanced resolves it, or that anything is repaired automatically.
    // (HC1.2's own denylist, kept whole: "resolves" / «يحلّ» do not occur in the truthful HC1.3 sentence, which says it "does not itself resolve".)
    expect(body.en).not.toMatch(/re-import|reimport|automatic|replacement|will be (repaired|fixed|replaced)|will (replace|fix|repair)|Source stage|source stage|stage (will|can|replaces)|resolves/i);
    expect(body.ar).not.toMatch(/إعادة استيراد|استبدال|تلقائي|سيُصلَح|سيتم (إصلاح|استبدال)|مرحلة المصدر|يحلّ|تحلّ/);
    // The title is the diagnostic one, not the remedy-implying one.
    expect(T.cn2b_simple_expert_title_unknown.en).toBe('Expert diagnostic review');
    // The copy that used to name a replacement stage is gone, so nothing can still show it.
    expect((T as Record<string, unknown>).cn2b_simple_expert_body_source_replacement).toBeUndefined();
  });

  it('the unproven-head copy says what it could not prove, does not guess, and promises nothing', () => {
    const body = T.cn2b_simple_expert_body_override_head_unproven;
    expect(body.en).toMatch(/could not prove which correction is current/);
    expect(body.en).toMatch(/does not guess/);
    expect(body.en).toMatch(/does not guarantee/);
    expect(body.ar).toMatch(/لم تستطع إثبات/);
    expect(body.ar).toMatch(/لا تخمّن/);
    expect(body.ar).toMatch(/لا يضمن/);
    expect(body.en).not.toMatch(/resolves the problem|will be (resolved|fixed|repaired)|will resolve|automatically/i);
    expect(body.ar).not.toMatch(/سيُحلّ|تلقائي|سيتم (حل|إصلاح)/);
    for (const lang of ['en', 'ar'] as const) expect(body[lang]).toContain('__STAGE__');
  });

  it('the numeric escape names the follow-up step (the correction is recorded in Review, then PINNED in Simple), and the binding_invalid summary stays true when the cell has no current numeric correction yet', () => {
    expect(T.cn2b_simple_expert_body_numeric_override.en).toMatch(/Once it is recorded, come back and pin it: delete the need line and designate its cell again\./);
    expect(T.cn2b_simple_expert_body_numeric_override.ar).toMatch(/وبعد تسجيله عُد إلى هنا وثبّته: احذف سطر الاحتياج ثم عيّن خليته من جديد/);
    const summary = T.cn2b_simple_blocker_lineage_source_quantity_override_binding_invalid;
    expect(summary.en).toMatch(/re-pin the current numeric correction, or delete and re-designate that source of the need line\. If the cell has no current usable numeric correction yet, record one first\./); // HC1.4: "usable"
    expect(summary.ar).toMatch(/فسجّل واحدًا أولًا/);
  });
});

describe('H1_2_19 (extended by HC1.3) — ONE explicit table: every M217 reason, and every branch of BOTH head-dependent reasons', () => {
  type Row = { name: string; blockers: ReviewReadiness['blockers']; context?: SimpleOverrideContext; escapes: ReadonlyArray<{ stage: string; reason: string }> };
  const row = (reason: string | null, record: string | null = 'rec-5') => bindingRow(detailFor(record, reason));
  const NUMERIC_REQUIRED = 'source_quantity_requires_explicit_numeric_override';

  const TABLE: ReadonlyArray<Row> = [
    { name: '1  source_cell_value_contract_invalid (lineage reason)', blockers: [row('source_cell_value_contract_invalid')], escapes: [{ stage: 'readiness', reason: 'source_evidence_invalid' }] },
    { name: '1b source_cell_value_contract_invalid (standalone blocker)', blockers: [{ blocker: 'source_cell_value_contract_invalid', detail: detailFor('rec-5', 'invalid_evidence') }], escapes: [{ stage: 'readiness', reason: 'source_evidence_invalid' }] },
    // HC1.3: source_quantity_requires_explicit_numeric_override is HEAD-DEPENDENT, exactly like binding_invalid (rows 2a–2e mirror 3a–3e).
    { name: '2a source_quantity_requires_explicit_numeric_override — current numeric head proven', blockers: [row(NUMERIC_REQUIRED)], context: chain(override('rec-5', 12)), escapes: [] },
    { name: '2b source_quantity_requires_explicit_numeric_override — no current head', blockers: [row(NUMERIC_REQUIRED)], context: chain(override('rec-6', 12)), escapes: [{ stage: 'review', reason: 'numeric_override' }] },
    { name: '2c source_quantity_requires_explicit_numeric_override — current head non-numeric', blockers: [row(NUMERIC_REQUIRED)], context: chain(override('rec-5', 'text')), escapes: [{ stage: 'review', reason: 'numeric_override' }] },
    { name: '2d source_quantity_requires_explicit_numeric_override — source_record token missing', blockers: [row(NUMERIC_REQUIRED, null)], context: chain(override('rec-5', 12)), escapes: [{ stage: 'readiness', reason: 'override_head_unproven' }] },
    { name: '2e source_quantity_requires_explicit_numeric_override — override layer unavailable', blockers: [row(NUMERIC_REQUIRED)], context: { overrides: [override('rec-5', 12)], overrideReadFailure: 'field_overrides_not_loaded' }, escapes: [{ stage: 'readiness', reason: 'override_head_unproven' }] },
    { name: '3a binding_invalid — current numeric head proven', blockers: [row(BINDING)], context: chain(override('rec-5', 12)), escapes: [] },
    { name: '3b binding_invalid — no current head', blockers: [row(BINDING)], context: chain(override('rec-6', 12)), escapes: [{ stage: 'review', reason: 'numeric_override' }] },
    { name: '3c binding_invalid — current head non-numeric', blockers: [row(BINDING)], context: chain(override('rec-5', 'text')), escapes: [{ stage: 'review', reason: 'numeric_override' }] },
    { name: '3d binding_invalid — source_record token missing', blockers: [row(BINDING, null)], context: chain(override('rec-5', 12)), escapes: [{ stage: 'readiness', reason: 'override_head_unproven' }] },
    { name: '3e binding_invalid — override layer unavailable', blockers: [row(BINDING)], context: { overrides: [override('rec-5', 12)], overrideReadFailure: 'field_overrides_not_loaded' }, escapes: [{ stage: 'readiness', reason: 'override_head_unproven' }] },
    { name: '4  source_quantity_override_value_invalid', blockers: [row('source_quantity_override_value_invalid')], escapes: [{ stage: 'review', reason: 'numeric_override' }] },
    { name: '5  source_quantity_override_mismatch', blockers: [row('source_quantity_override_mismatch')], escapes: [] },
    { name: '6  unknown future reason', blockers: [row('a_future_reason_this_build_has_never_seen')], escapes: [{ stage: 'readiness', reason: 'unknown_lineage_reason' }] },
    { name: '6b missing reason', blockers: [row(null)], escapes: [{ stage: 'readiness', reason: 'unknown_lineage_reason' }] },
  ];

  it('every row of the table holds', () => {
    for (const r of TABLE) {
      expect(deriveSimpleExpertEscapes(readiness(r.blockers), r.context), r.name).toEqual(r.escapes);
    }
  });

  it('the table covers EVERY M217 reason (read from the SQL), so a reason that disappears or is added unclassified fails here', () => {
    const sql = read('supabase/migrations/217_phoenix_central_needs_c5_safety_convergence.sql');
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public._phoenix_central_needs_quantity_lineage_violation_v1(');
    const serverReasons = [...sql.slice(start, sql.indexOf('$$;', start)).matchAll(/THEN '([a-z_]+)'/g)].map((m) => m[1]);
    expect([...serverReasons].sort()).toEqual([...M217_LINEAGE_REASONS].sort());
    const covered = new Set(TABLE.flatMap((r) => r.blockers.map((b) => (b.blocker === 'source_cell_value_contract_invalid' ? 'source_cell_value_contract_invalid' : /reason=([^\s]+)/.exec(b.detail ?? '')?.[1] ?? null))));
    for (const reason of serverReasons) expect(covered.has(reason), `the table has no row for ${reason}`).toBe(true);
  });

  it('binding_invalid can never collapse to ONE answer: its branches produce all three outcomes (resolvable in Simple, DATA REVIEW, READINESS diagnostic)', () => {
    const outcomes = new Set(TABLE.filter((r) => r.name.startsWith('3')).map((r) => JSON.stringify(r.escapes)));
    expect(outcomes.size).toBe(3);
    expect(outcomes.has('[]')).toBe(true);
    expect(outcomes.has(JSON.stringify([{ stage: 'review', reason: 'numeric_override' }]))).toBe(true);
    expect(outcomes.has(JSON.stringify([{ stage: 'readiness', reason: 'override_head_unproven' }]))).toBe(true);
  });

  it('exactly THREE rows of the table are ever Simple — mismatch, and the two head-dependent reasons with a proven numeric head — nothing else', () => {
    const simpleRows = TABLE.filter((r) => r.escapes.length === 0).map((r) => r.name.slice(0, 2).trim());
    expect(simpleRows).toEqual(['2a', '3a', '5']);
  });

  it('a NEW known reason can never be silently Simple: an unlisted token is unknown, with or without a proven numeric head', () => {
    const fresh = readiness([row('source_quantity_override_some_new_reason')]);
    for (const ctx of [undefined, chain(override('rec-5', 12))]) {
      expect(deriveSimpleExpertEscapes(fresh, ctx)).toEqual([{ stage: 'readiness', reason: 'unknown_lineage_reason' }]);
    }
  });
});

describe('H1_2_20 … H1_2_24 — fail closed, and never beyond what the server said', () => {
  const NUMERIC_CHAIN = chain(override('rec-5', 12));

  it('H1_2_20 — an unknown lineage reason → READINESS diagnostic', () => {
    expect(deriveSimpleExpertEscapes(readiness([bindingRow(detailFor('rec-5', 'a_reason_from_the_future'))]), NUMERIC_CHAIN))
      .toEqual([{ stage: 'readiness', reason: 'unknown_lineage_reason' }]);
  });

  it('H1_2_21 — a missing reason → READINESS diagnostic', () => {
    for (const detail of [detailFor('rec-5', null), null, '']) {
      expect(deriveSimpleExpertEscapes(readiness([bindingRow(detail)]), NUMERIC_CHAIN), String(detail))
        .toEqual([{ stage: 'readiness', reason: 'unknown_lineage_reason' }]);
    }
  });

  it('H1_2_22 — an unknown blocker code → READINESS diagnostic', () => {
    expect(deriveSimpleExpertEscapes(readiness([{ blocker: 'a_blocker_this_build_has_never_seen', detail: null }]), NUMERIC_CHAIN))
      .toEqual([{ stage: 'readiness', reason: 'unknown_blocker' }]);
  });

  it('H1_2_23 — `ready === true` → NO escape, whatever stale blocker rows came with it (not even invalid evidence, an unproven head or an open import)', () => {
    const stale = [
      bindingRow(detailFor('rec-5', 'source_cell_value_contract_invalid')), bindingRow(detailFor(null)), bindingRow(detailFor('rec-6')),
      { blocker: 'import_session_still_open', detail: 'session=s9 status=pending' }, { blocker: 'unknown_code', detail: null },
    ];
    expect(deriveSimpleExpertEscapes(readiness(stale, { ready: true }), NUMERIC_CHAIN)).toEqual([]);
    expect(deriveSimpleExpertEscapes(readiness(stale, { ready: true }))).toEqual([]);
  });

  it('H1_2_24 — a revision that is not a draft → NO HC1.2 escape, in any status', () => {
    const blockers = [bindingRow(detailFor('rec-5', 'source_cell_value_contract_invalid')), bindingRow(detailFor('rec-6')), bindingRow(detailFor(null))];
    for (const status of ['submitted', 'approved', 'rejected', 'superseded'] as const) {
      expect(deriveSimpleExpertEscapes(readiness(blockers, { status }), chain()), status).toEqual([]);
    }
    expect(deriveSimpleExpertEscapes(null, NUMERIC_CHAIN)).toEqual([]);
  });
});

describe('HC1.2 — it stays presentation-only and reuses the canonical helpers', () => {
  const src = codeOf('src/features/central-needs/simple/simpleReadiness.ts');

  it('ESCAPE_ORDER names EVERY reason exactly once: a reason added to the type and to ESCAPE_STAGE but forgotten in ESCAPE_ORDER would be silently dropped (no escape), so the three lists are held equal here', () => {
    const union = [...(src.match(/export type SimpleExpertReason =[\s\S]*?;/) as RegExpMatchArray)[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const stageKeys = [...(src.match(/const ESCAPE_STAGE[\s\S]*?\n\};/) as RegExpMatchArray)[0].matchAll(/^\s{2}([a-z_]+): '[a-z]+',$/gm)].map((m) => m[1]);
    const order = [...(src.match(/const ESCAPE_ORDER[\s\S]*?\];/) as RegExpMatchArray)[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(order).size).toBe(order.length); // no duplicate
    expect([...order].sort()).toEqual([...union].sort());
    expect([...order].sort()).toEqual([...stageKeys].sort());
  });

  it('no read, no write, no second head rule, no second numeric rule, no DETAIL parser of its own', () => {
    expect(src).not.toMatch(/supabase|\.rpc\(|fetch\(|window|document|localStorage|await |async /);
    expect(src).toContain("import { reasonOf, sourceRecordOf } from '../central-needs.service';");
    expect(src).toContain('const record = sourceRecordOf(detail);');
    expect(src).toContain('numericOverrideLexeme(head) !== null'); // HC1.4: was `isNumericOverride(head)`
    // The DETAIL tokens are parsed by the service helpers only.
    expect(src).not.toMatch(/source_record=|\.match\(|\.exec\(|new RegExp|RegExp\(/);
  });

  it('the context it is handed is the screen\'s existing override state and nothing broader', () => {
    expect(src).toMatch(/export interface SimpleOverrideContext \{\s*readonly overrides: readonly FieldOverride\[\];\s*readonly overrideReadFailure: string \| null;\s*\}/);
  });
});
