/**
 * CN-UI-S1 HC1.3 — FINAL LINEAGE UX CONSISTENCY, at the derivation and the copy
 * (H1_3_01 … H1_3_09, H1_3_11 … H1_3_17).
 *
 *   A. `source_quantity_requires_explicit_numeric_override` is CURRENT-HEAD-AWARE,
 *      exactly like `…_binding_invalid`, and through the SAME function
 *      (`currentNumericHeadRemedyOf`): the server keeps reporting it until the
 *      need-line link is rebuilt pinning the cell's current numeric head, so once
 *      that head exists the next action is Simple's (delete + designate again +
 *      pin), and before it exists it is Advanced's (record the correction).
 *   B. No visible copy says or implies that invalid IMMUTABLE evidence can be
 *      repaired by re-import, replacement or by deleting a need-line source —
 *      there is no such in-app remedy.
 *
 * The real-screen proof that the Simple remedy works (H1_3_10) and the
 * presentation-only / permissions / no-Advanced-entry proofs (H1_3_01, H1_3_05 …
 * H1_3_09, H1_3_18) are in `cn-ui-s1-hc1-3-screen.runtime.test.tsx`.
 *
 * CN-UI-S1 HC1.4 (H1_4_01 … H1_4_09, at the bottom of this file): "the current head is
 * numeric" became "the current head can really be PINNED" — the canonical
 * `numericOverrideLexeme`. A JSON-number override can be a finite, non-negative number whose
 * exact PostgreSQL text is still not a legal designated quantity (a plain decimal of at most
 * 256 characters). The real-panel proofs (H1_4_10, H1_4_11) are in
 * `cn-ui-s1-hc1-4-screen.runtime.test.tsx`.
 */
import { describe, expect, it } from 'vitest';
import { T } from '@/shared/i18n/strings';
import { isNumericOverride, numericOverrideLexeme } from '../../central-needs.lineage';
import type { FieldOverride, ReviewReadiness } from '../../central-needs.service';
import {
  M217_LINEAGE_REASONS, bindingInvalidRemedyOf, currentNumericHeadRemedyOf, deriveSimpleExpertEscape, deriveSimpleExpertEscapes,
  lineageRemedyOf, type SimpleOverrideContext,
} from '../simpleReadiness';

const LINEAGE = 'need_line_quantity_lineage_unsafe';
const NUMERIC_REQUIRED = 'source_quantity_requires_explicit_numeric_override';
const BINDING = 'source_quantity_override_binding_invalid';
const VALUE_INVALID = 'source_quantity_override_value_invalid';
const MISMATCH = 'source_quantity_override_mismatch';
const EVIDENCE = 'source_cell_value_contract_invalid';

/** The server's own DETAIL format: `session=%s source_record=%s need_line=%s reason=%s`. */
const detailFor = (record: string | null, reason: string | null) =>
  ['session=s1', record === null ? null : `source_record=${record}`, 'need_line=nl-1', reason === null ? null : `reason=${reason}`].filter(Boolean).join(' ');
const rowFor = (reason: string | null, record: string | null = 'rec-5') => ({ blocker: LINEAGE, detail: detailFor(record, reason) });
const readiness = (blockers: ReviewReadiness['blockers'], over: Partial<ReviewReadiness> = {}): ReviewReadiness => ({
  planRevisionId: 'rev-1', status: 'draft', ready: false, blockers, ...over,
});
let seq = 0;
const override = (sourceRecordId: string, finalValue: unknown): FieldOverride => ({
  id: `ov-${(seq += 1)}`, sourceRecordId, targetEntity: 'row-5', fieldName: 'qty', previousValue: null, finalValue,
  finalValueText: typeof finalValue === 'number' ? String(finalValue) : JSON.stringify(finalValue),
  overrideReason: 'reviewed', overrideNote: null, createdAt: '2026-09-26T10:00:00+00:00',
});
const chain = (...overrides: FieldOverride[]): SimpleOverrideContext => ({ overrides, overrideReadFailure: null });
const numericRequiredFor = (record: string | null) => readiness([rowFor(NUMERIC_REQUIRED, record)]);

// ---- HC1.4 fixtures: overrides shaped EXACTLY as `listOverrides` returns them ------------------------------------
// `finalValue` is the JSON.parse of the jsonb value, `finalValueText` is `final_value::text` verbatim — which, for a jsonb number, is a
// plain decimal (PostgreSQL never prints an exponent), so a long number is a long text next to a (rounded) finite JS number.
/** `len` characters of plain integer: '1' followed by zeros. JSON.parse of it is a finite number up to 309 digits. */
const intText = (len: number) => `1${'0'.repeat(len - 1)}`;
/** `len` characters of plain decimal fraction: '0.' followed by ones. */
const fracText = (len: number) => `0.${'1'.repeat(len - 2)}`;
/** A numeric override as the service returns it: the parsed value and PostgreSQL's own text of it. */
const pgOverride = (sourceRecordId: string, text: string): FieldOverride => ({ ...override(sourceRecordId, JSON.parse(text)), finalValueText: text });

const SIMPLE: never[] = []; // "no escape"
const REVIEW = [{ stage: 'review', reason: 'numeric_override' }];
const UNPROVEN = [{ stage: 'readiness', reason: 'override_head_unproven' }];

describe('H1_3_01 / H1_3_02 — numeric-required + a PROVEN current numeric head → NO expert escape, from the exact record and its current head only', () => {
  it('H1_3_01 — complete chain, the exact record\'s current head is numeric → no escape', () => {
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(override('rec-5', 12)))).toEqual(SIMPLE);
    expect(deriveSimpleExpertEscape(numericRequiredFor('rec-5'), chain(override('rec-5', 12)))).toBeNull();
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(override('rec-5', 0)))).toEqual(SIMPLE); // zero is a valid non-negative number
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(override('rec-5', 12.5)))).toEqual(SIMPLE);
    expect(currentNumericHeadRemedyOf(detailFor('rec-5', NUMERIC_REQUIRED), chain(override('rec-5', 12)))).toEqual({ route: 'simple' });
  });

  it('H1_3_01 — the table says the reason is head-dependent, and a lineage row alone (no other blocker) is the whole case', () => {
    expect(lineageRemedyOf(NUMERIC_REQUIRED)).toEqual({ route: 'head_dependent' });
    expect(lineageRemedyOf(BINDING)).toEqual({ route: 'head_dependent' });
    // Beside anything Simple resolves, the case is still Simple's.
    expect(deriveSimpleExpertEscapes(readiness([
      { blocker: 'mapped_target_entity_without_need_line', detail: 'session=s1 target_entity=row-5' }, rowFor(NUMERIC_REQUIRED), rowFor(MISMATCH),
    ]), chain(override('rec-5', 12)))).toEqual(SIMPLE);
  });

  it('H1_3_02 — only the EXACT record and its CURRENT head decide: noise around them changes nothing, and the record\'s own head flips the answer', () => {
    const noise = [override('rec-OTHER', 'text'), override('rec-50', 7), override('rec-', 7), override('REC-5', 7), override('rec-6', 'x')];
    const numericHead = override('rec-5', 12);
    const textHead = override('rec-5', 'twelve');
    // Same noise either side; the record's OWN head is the only thing that differs.
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(...noise, numericHead))).toEqual(SIMPLE);
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(...noise, textHead))).toEqual(REVIEW);
    // And the other way round: changing ONLY another record's override never flips this record's answer.
    for (const other of [override('rec-OTHER', 12), override('rec-OTHER', 'text'), override('rec-OTHER', null)]) {
      expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(other, numericHead))).toEqual(SIMPLE);
      expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(other, textHead))).toEqual(REVIEW);
    }
    // Several rows: each is judged on ITS OWN record.
    const rows = readiness([rowFor(NUMERIC_REQUIRED, 'rec-5'), rowFor(NUMERIC_REQUIRED, 'rec-6')]);
    expect(deriveSimpleExpertEscapes(rows, chain(override('rec-5', 12), override('rec-6', 3)))).toEqual(SIMPLE);
    expect(deriveSimpleExpertEscapes(rows, chain(override('rec-5', 12), override('rec-6', 'text')))).toEqual(REVIEW);
    expect(deriveSimpleExpertEscapes(rows, chain(override('rec-5', 12)))).toEqual(REVIEW);
  });
});

describe('H1_3_03 / H1_3_04 — the CURRENT head is the first row of the exact record in server order; the client never re-sorts or picks a convenient older one', () => {
  it('H1_3_03 — an older NUMERIC override behind a NEWER non-numeric head → the DATA REVIEW stage', () => {
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(override('rec-5', 'newest text'), override('rec-5', 12)))).toEqual(REVIEW);
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(override('rec-5', null), override('rec-5', 5), override('rec-5', 6)))).toEqual(REVIEW);
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(override('rec-5', -1), override('rec-5', 5)))).toEqual(REVIEW);
  });

  it('H1_3_04 — the NEWEST head is numeric and an older one is not → no escape', () => {
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(override('rec-5', 12), override('rec-5', 'old text'), override('rec-5', null)))).toEqual(SIMPLE);
  });

  it('the order is the SERVER\'s: the timestamps never reorder the chain (no sort, no date parsing, in the code)', () => {
    const olderFirst: FieldOverride[] = [
      { ...override('rec-5', 12), createdAt: '2026-01-01T00:00:00+00:00' },
      { ...override('rec-5', 'newer text'), createdAt: '2026-09-30T00:00:00+00:00' },
    ];
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(...olderFirst))).toEqual(SIMPLE); // the first row wins, whatever its timestamp says
    const textFirst: FieldOverride[] = [
      { ...override('rec-5', 'newer text'), createdAt: '2026-01-01T00:00:00+00:00' },
      { ...override('rec-5', 12), createdAt: '2026-09-30T00:00:00+00:00' },
    ];
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(...textFirst))).toEqual(REVIEW); // …and the later-stamped numeric one behind it never wins
    // (the source-level rule — no sort, no date parsing — is pinned in cn-ui-s1-hc1-3-static-contract.test.ts)
  });
});

describe('H1_3_05 / H1_3_06 / H1_3_09 — no usable numeric head → DATA REVIEW', () => {
  it('H1_3_05 — no head at all for the named record → the DATA REVIEW stage', () => {
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain())).toEqual(REVIEW);
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(override('rec-6', 12), override('rec-7', 'x')))).toEqual(REVIEW);
    expect(currentNumericHeadRemedyOf(detailFor('rec-5', NUMERIC_REQUIRED), chain())).toEqual({ route: 'expert', reason: 'numeric_override' });
  });

  it('H1_3_06 — the current head is text / blank / negative / non-numeric → the DATA REVIEW stage', () => {
    const nonNumeric: unknown[] = ['twelve', '12', '', '   ', null, true, false, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, { value: 12 }, [12]];
    for (const value of nonNumeric) {
      expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(override('rec-5', value))), String(JSON.stringify(value) ?? value)).toEqual(REVIEW);
    }
  });

  it('H1_3_09 — a numeric head belonging to ANOTHER source record does NOT make this record Simple-resolvable', () => {
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(override('rec-OTHER', 12)))).toEqual(REVIEW);
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(override('rec-OTHER', 12), override('rec-6', 7)))).toEqual(REVIEW);
    for (const near of ['rec-50', 'rec-', 'REC-5', ' rec-5', 'rec-5 ']) {
      expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), chain(override(near, 12))), near).toEqual(REVIEW);
    }
    // Words in the row that merely LOOK like the record change nothing: only the whole `source_record=` token decides.
    const decoy = readiness([{ blocker: LINEAGE, detail: `session=rec-5 target_entity=rec-5 need_line=rec-5 reason=${NUMERIC_REQUIRED}` }]);
    expect(deriveSimpleExpertEscapes(decoy, chain(override('rec-5', 12)))).toEqual(UNPROVEN);
  });
});

describe('H1_3_07 / H1_3_08 — the head cannot be PROVEN → a READINESS diagnostic (never an assumption, never Simple)', () => {
  it('H1_3_07 — no `source_record=` token (or a malformed / non-whole one) → READINESS diagnostic; nothing is guessed from row / header / entity / material text', () => {
    const numericEverywhere = chain(override('rec-5', 12), override('r1', 12), override('', 12));
    for (const detail of [
      detailFor(null, NUMERIC_REQUIRED),
      'need_line=nl-1 reason=' + NUMERIC_REQUIRED,
      'session=s1 reason=' + NUMERIC_REQUIRED,
      'session=s1 xsource_record=rec-5 need_line=nl-1 reason=' + NUMERIC_REQUIRED, // a longer key
      'session=s1 note=source_record=rec-5 need_line=nl-1 reason=' + NUMERIC_REQUIRED, // inside another value
      'session=s1 source_record= need_line=nl-1 reason=' + NUMERIC_REQUIRED, // empty token
      'session=s1 SOURCE_RECORD=rec-5 need_line=nl-1 reason=' + NUMERIC_REQUIRED, // case differs
    ]) {
      expect(deriveSimpleExpertEscapes(readiness([{ blocker: LINEAGE, detail }]), numericEverywhere), detail).toEqual(UNPROVEN);
    }
    expect(currentNumericHeadRemedyOf(detailFor(null, NUMERIC_REQUIRED), numericEverywhere)).toEqual({ route: 'diagnostic', reason: 'override_head_unproven' });
  });

  it('H1_3_08 — the override chain is unavailable (any read failure, or no context at all) → READINESS diagnostic, even with a numeric head in the array', () => {
    for (const failure of ['field_overrides_not_loaded', 'field_overrides_read_inconsistent', 'central_needs_request_failed', 'x']) {
      expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), { overrides: [override('rec-5', 12)], overrideReadFailure: failure }), failure).toEqual(UNPROVEN);
    }
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'))).toEqual(UNPROVEN);
    expect(deriveSimpleExpertEscapes(numericRequiredFor('rec-5'), undefined)).toEqual(UNPROVEN);
  });

  it('the unproven answer reuses the HC1.2 diagnostic (the same escape reason as binding_invalid\'s) — one meaning, one copy', () => {
    expect(deriveSimpleExpertEscapes(numericRequiredFor(null))).toEqual(deriveSimpleExpertEscapes(readiness([rowFor(BINDING, null)])));
  });
});

describe('H1_3_11 — binding_invalid is unchanged from HC1.2 and consumes the SAME head logic (no second implementation)', () => {
  const CHAINS: ReadonlyArray<[string, SimpleOverrideContext | undefined]> = [
    ['numeric head', chain(override('rec-5', 12))],
    ['zero head', chain(override('rec-5', 0))],
    ['text head', chain(override('rec-5', 'text'))],
    ['no head', chain()],
    ['other record only', chain(override('rec-OTHER', 12))],
    ['older numeric behind newer text', chain(override('rec-5', 'text'), override('rec-5', 12))],
    ['newer numeric over older text', chain(override('rec-5', 12), override('rec-5', 'text'))],
    ['chain unavailable', { overrides: [override('rec-5', 12)], overrideReadFailure: 'field_overrides_not_loaded' }],
    ['no context', undefined],
  ];
  /** HC1.2's literal answers for binding_invalid, written out independently of the implementation. */
  const HC12_BINDING: Record<string, ReadonlyArray<{ stage: string; reason: string }>> = {
    'numeric head': SIMPLE, 'zero head': SIMPLE, 'text head': REVIEW, 'no head': REVIEW, 'other record only': REVIEW,
    'older numeric behind newer text': REVIEW, 'newer numeric over older text': SIMPLE, 'chain unavailable': UNPROVEN, 'no context': UNPROVEN,
  };

  it('binding_invalid answers exactly as HC1.2 did, in every head condition', () => {
    for (const [name, ctx] of CHAINS) {
      expect(deriveSimpleExpertEscapes(readiness([rowFor(BINDING)]), ctx), name).toEqual(HC12_BINDING[name]);
    }
    expect(deriveSimpleExpertEscapes(readiness([rowFor(BINDING, null)]), chain(override('rec-5', 12)))).toEqual(UNPROVEN);
  });

  it('numeric-required answers EXACTLY like binding_invalid in every head condition (the two head-dependent reasons are one decision)', () => {
    for (const [name, ctx] of CHAINS) {
      expect(deriveSimpleExpertEscapes(readiness([rowFor(NUMERIC_REQUIRED)]), ctx), name).toEqual(HC12_BINDING[name]);
      expect(deriveSimpleExpertEscapes(readiness([rowFor(NUMERIC_REQUIRED)]), ctx), name).toEqual(deriveSimpleExpertEscapes(readiness([rowFor(BINDING)]), ctx));
    }
  });

  it('the exported HC1.2 helper is the shared decision, not a copy of it', () => {
    for (const [name, ctx] of CHAINS) {
      for (const record of ['rec-5', null]) {
        expect(bindingInvalidRemedyOf(detailFor(record, BINDING), ctx), `${name}/${record}`).toEqual(currentNumericHeadRemedyOf(detailFor(record, NUMERIC_REQUIRED), ctx));
      }
    }
    // (the source-level rule — one implementation, no copy of the head logic — is pinned in cn-ui-s1-hc1-3-static-contract.test.ts)
  });
});

describe('H1_3_12 … H1_3_15 — the other reasons are untouched, whatever the override context says', () => {
  const CONTEXTS: ReadonlyArray<SimpleOverrideContext | undefined> = [
    undefined, chain(), chain(override('rec-5', 12)), chain(override('rec-5', 'text')),
    { overrides: [override('rec-5', 12)], overrideReadFailure: 'field_overrides_not_loaded' },
  ];

  it('H1_3_12 — value_invalid stays DATA REVIEW (Simple never creates a numeric override), even beside a numeric head', () => {
    for (const ctx of CONTEXTS) expect(deriveSimpleExpertEscapes(readiness([rowFor(VALUE_INVALID)]), ctx)).toEqual(REVIEW);
  });

  it('H1_3_13 — mismatch stays SIMPLE', () => {
    for (const ctx of CONTEXTS) expect(deriveSimpleExpertEscapes(readiness([rowFor(MISMATCH)]), ctx)).toEqual(SIMPLE);
  });

  it('H1_3_14 — invalid immutable evidence (the lineage reason AND the standalone blocker) stays a READINESS diagnostic, even beside a numeric head', () => {
    const standalone = { blocker: EVIDENCE, detail: 'session=s1 source_record=rec-5 reason=invalid_evidence' };
    const diagnostic = [{ stage: 'readiness', reason: 'source_evidence_invalid' }];
    for (const ctx of CONTEXTS) {
      expect(deriveSimpleExpertEscapes(readiness([rowFor(EVIDENCE)]), ctx)).toEqual(diagnostic);
      expect(deriveSimpleExpertEscapes(readiness([standalone]), ctx)).toEqual(diagnostic);
      expect(deriveSimpleExpertEscapes(readiness([standalone, rowFor(EVIDENCE)]), ctx)).toEqual(diagnostic);
    }
  });

  it('H1_3_15 — an unknown or missing lineage reason stays a READINESS diagnostic, and an unknown blocker too', () => {
    const unknownLineage = [{ stage: 'readiness', reason: 'unknown_lineage_reason' }];
    for (const ctx of CONTEXTS) {
      for (const reason of ['a_future_reason_this_build_has_never_seen', `${NUMERIC_REQUIRED}_v2`, 'SOURCE_QUANTITY_REQUIRES_EXPLICIT_NUMERIC_OVERRIDE', 'constructor', '__proto__', null]) {
        expect(deriveSimpleExpertEscapes(readiness([rowFor(reason)]), ctx), String(reason)).toEqual(unknownLineage);
      }
      expect(deriveSimpleExpertEscapes(readiness([{ blocker: LINEAGE, detail: null }]), ctx)).toEqual(unknownLineage);
      expect(deriveSimpleExpertEscapes(readiness([{ blocker: 'a_blocker_this_build_has_never_seen', detail: null }]), ctx)).toEqual([{ stage: 'readiness', reason: 'unknown_blocker' }]);
    }
  });

  it('the server\'s verdict is never suppressed: a ready answer, or a closed revision, never escapes — and nothing here changes `ready`', () => {
    const rows = [rowFor(NUMERIC_REQUIRED), rowFor(BINDING), rowFor(EVIDENCE)];
    expect(deriveSimpleExpertEscapes(readiness(rows, { ready: true }), chain())).toEqual([]);
    for (const status of ['submitted', 'approved', 'rejected', 'superseded'] as const) {
      expect(deriveSimpleExpertEscapes(readiness(rows, { status }), chain()), status).toEqual([]);
    }
    const input = readiness(rows);
    const before = JSON.stringify(input);
    deriveSimpleExpertEscapes(input, chain(override('rec-5', 12)));
    expect(JSON.stringify(input)).toBe(before);
    expect(input.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// A DIFFERENTIAL grid: the implementation against an oracle written here, from the owner's rules, which uses none
// of the helpers under test. Every reason × every record form × every chain shape × every verdict.
// ---------------------------------------------------------------------------------------------------
describe('H1_3 (grid) — every M217 reason × record form × chain shape × read verdict agrees with an independent oracle', () => {
  type Verdict = 'simple' | 'review' | 'unproven';
  const oracleHead = (record: string | null, ctx: SimpleOverrideContext | undefined): Verdict => {
    if (record === null || ctx === undefined || ctx.overrideReadFailure !== null) return 'unproven';
    const head = ctx.overrides.find((o) => o.sourceRecordId === record); // the chain arrives in server order: the first row IS the head
    if (head === undefined) return 'review';
    // HC1.4 — usable = a finite, non-negative JS number whose exact PostgreSQL text (`final_value::text`, else String()) is a plain decimal of at
    // most 256 characters. Written out HERE from the server's grammar, with no import of the helper under test.
    const v = head.finalValue;
    const text = typeof head.finalValueText === 'string' ? head.finalValueText : String(v);
    const pinnable = typeof v === 'number' && Number.isFinite(v) && v >= 0 && text.length <= 256 && /^(?:0|[1-9][0-9]*)(?:[.][0-9]+)?$/.test(text);
    return pinnable ? 'simple' : 'review';
  };
  const asEscapes = (v: Verdict) => (v === 'simple' ? SIMPLE : v === 'review' ? REVIEW : UNPROVEN);
  const oracle = (reason: string | null, record: string | null, ctx: SimpleOverrideContext | undefined) => {
    switch (reason) {
      case EVIDENCE: return [{ stage: 'readiness', reason: 'source_evidence_invalid' }];
      case VALUE_INVALID: return REVIEW;
      case MISMATCH: return SIMPLE;
      case NUMERIC_REQUIRED:
      case BINDING: return asEscapes(oracleHead(record, ctx));
      default: return [{ stage: 'readiness', reason: 'unknown_lineage_reason' }];
    }
  };

  const REASONS = [...M217_LINEAGE_REASONS, 'a_reason_from_the_future', null] as const;
  const RECORDS = ['rec-5', null] as const;
  const BODIES: ReadonlyArray<readonly [string, FieldOverride[]]> = [
    ['empty', []],
    ['numeric', [override('rec-5', 12)]],
    ['zero', [override('rec-5', 0)]],
    ['text', [override('rec-5', 'x')]],
    ['null', [override('rec-5', null)]],
    ['negative', [override('rec-5', -3)]],
    ['other numeric', [override('rec-9', 12)]],
    ['other numeric then own text', [override('rec-9', 12), override('rec-5', 'x')]],
    ['own text then own numeric', [override('rec-5', 'x'), override('rec-5', 12)]],
    ['own numeric then own text', [override('rec-5', 12), override('rec-5', 'x')]],
    ['own numeric, own numeric', [override('rec-5', 1), override('rec-5', 2)]],
    // HC1.4 — the pinnability boundary and the chronology around it (all shaped as the service returns them)
    ['own 256-char integer', [pgOverride('rec-5', intText(256))]],
    ['own 257-char integer', [pgOverride('rec-5', intText(257))]],
    ['own 256-char fraction', [pgOverride('rec-5', fracText(256))]],
    ['own 257-char fraction', [pgOverride('rec-5', fracText(257))]],
    ['own 309-digit integer (still finite)', [pgOverride('rec-5', intText(309))]],
    ['own 400-digit integer (JSON.parse → Infinity)', [pgOverride('rec-5', intText(400))]],
    ['own long, then older pinnable', [pgOverride('rec-5', intText(257)), pgOverride('rec-5', '12')]],
    ['own pinnable, then older long', [pgOverride('rec-5', '12'), pgOverride('rec-5', intText(257))]],
    ['other 256-char only', [pgOverride('rec-9', intText(256))]],
    ['other pinnable then own long', [pgOverride('rec-9', '12'), pgOverride('rec-5', intText(257))]],
    ['own 22-digit exact text (the JS number prints with an exponent)', [pgOverride('rec-5', intText(22))]],
    ['own tiny decimal (the JS number prints with an exponent)', [pgOverride('rec-5', '0.0000001')]],
    ['own 300-digit integer', [pgOverride('rec-5', intText(300))]],
    ['own tiny fraction of 302 characters (1e-300 written out)', [pgOverride('rec-5', `0.${'0'.repeat(299)}1`)]],
    ['own tiny NEGATIVE that underflows to -0 (numeric to the client, never pinnable)', [pgOverride('rec-5', `-0.${'0'.repeat(400)}1`)]],
  ];
  const VERDICTS: ReadonlyArray<string | null> = [null, 'field_overrides_not_loaded', 'x', '']; // '' is still a failure: only null means "read completely"

  it('agrees on every cell of the grid (the grid is non-trivial: all three verdicts occur for each head-dependent reason)', () => {
    const seen = new Map<string, Set<string>>();
    let cells = 0;
    for (const reason of REASONS) {
      for (const record of RECORDS) {
        for (const [bodyName, body] of BODIES) {
          for (const failure of VERDICTS) {
            const ctx: SimpleOverrideContext = { overrides: body, overrideReadFailure: failure };
            const actual = deriveSimpleExpertEscapes(readiness([rowFor(reason, record)]), ctx);
            expect(actual, `${reason}/${record}/${bodyName}/${failure}`).toEqual(oracle(reason, record, ctx));
            cells += 1;
            if (reason === NUMERIC_REQUIRED || reason === BINDING) {
              const key = String(reason);
              seen.set(key, (seen.get(key) ?? new Set()).add(JSON.stringify(actual)));
            }
          }
        }
        // …and with no context at all.
        expect(deriveSimpleExpertEscapes(readiness([rowFor(reason, record)])), `${reason}/${record}/no-context`).toEqual(oracle(reason, record, undefined));
      }
    }
    expect(cells).toBe(7 * 2 * BODIES.length * VERDICTS.length);
    for (const reason of [NUMERIC_REQUIRED, BINDING]) expect(seen.get(reason)?.size, reason).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------------
// COPY — H1_3_16 / H1_3_17
// ---------------------------------------------------------------------------------------------------
describe('H1_3_16 / H1_3_17 — invalid immutable evidence: every copy surface is truthful, promises no phantom remedy, and says the same thing in EN and AR', () => {
  /** The five surfaces the owner named, plus the refusal message that carried the same promise. */
  const SURFACES = [
    'cn2b_simple_blocker_source_evidence_invalid',
    'cn2b_simple_blocker_lineage_source_cell_value_contract_invalid',
    'cn2b_blocker_source_cell_value_contract_invalid',
    'cn2b_blocker_need_line_quantity_lineage_unsafe__source_cell_value_contract_invalid',
    'cn2b_simple_expert_body_source_evidence_invalid',
    'cn2b_err_source_cell_value_contract_invalid',
  ] as const;
  /** The save-refusal for a need line that holds invalid evidence: it promises nothing, and speaks the same vocabulary as the six above. */
  const LINEAGE_REFUSAL = 'cn2b_err_need_line_quantity_lineage_unsafe__source_cell_value_contract_invalid';

  /**
   * What no surface may claim or imply: re-import, replacement, automatic repair, repair by deleting a need-line source, a guaranteed action,
   * re-sending / re-uploading / starting a new import, or a stage that "resolves" the problem. (The negated "does not itself resolve …" is allowed.)
   */
  const EN_PROMISE = /re-?import|replac|automatic|will be (repaired|fixed|corrected|replaced)|will (replace|repair|fix)|fixed in place|delete (that|the|this) source|remove (that|the|this) (cell|source)|(removing|deleting) (the|that|this) (link|source|cell|line) (repairs|fixes|makes (it|that|the evidence) valid)|(?<!not itself )resolves? (it|this|the (evidence|issue|problem|blocker))|guarantee|re-?send|re-?upload|(import|upload) (it|the file) again|new import|corrected file/i;
  const AR_PROMISE = /إعادة (استيراد|رفع)|إعادة ال(استيراد|رفع)|أعد (رفع|استيراد)|استبدال|تلقائ|سيُصلَح|سيتم (إصلاح|استبدال)|تُصلَح في مكانها|احذف ذلك المصدر|أزل تلك الخلية|(?<!لا )(يحل|تحلّ|يحلّ)( \S+){0,3} (المشكلة|مشكلة)/;

  it('H1_3_16 — NONE of the surfaces promises re-import, available replacement, automatic repair, or deletion-as-repair, in either language', () => {
    for (const key of [...SURFACES, LINEAGE_REFUSAL]) {
      const entry = T[key];
      expect(entry, key).toBeDefined();
      expect(entry.en, `${key}.en`).not.toMatch(EN_PROMISE);
      expect(entry.ar, `${key}.ar`).not.toMatch(AR_PROMISE);
    }
  });

  it('H1_3_16 — the promise regexes really do catch the promises they exist for (they are not vacuous)', () => {
    for (const promise of [
      'The file needs a controlled replacement or re-import.', 'Import the file again.', 'Re-send the corrected file.', 'Start a new import.',
      'The readiness stage resolves the issue.', 'Delete the line and import the file again.', 'It will be repaired automatically.', 'Delete that source to repair it.',
      'Removing the link repairs the evidence.', 'A replacement is available.', 'We guarantee a fix.',
    ]) expect(EN_PROMISE.test(promise), promise).toBe(true);
    for (const promise of [
      'أعد استيراد الملف.', 'أعد رفع الملف بعد تصحيحه.', 'أو إعادة الاستيراد.', 'يحتاج الملف إلى استبدال مضبوط أو إعادة استيراد.', 'سيُصلَح تلقائيًا.',
      'تحلّ مرحلة الجاهزية المشكلة.', 'يحل هذا الإجراء المشكلة.', 'أزل تلك الخلية من سطر احتياجها.',
    ]) expect(AR_PROMISE.test(promise), promise).toBe(true);
    // …and the negated, truthful sentence is not mistaken for one.
    expect(EN_PROMISE.test('opening it does not itself resolve the evidence problem')).toBe(false);
    expect(AR_PROMISE.test('لكن فتحها لا يحل مشكلة الدليل بحد ذاته')).toBe(false);
  });

  it('H1_3_16 — and the rule is a SCAN, not a list: no string whose key names invalid evidence anywhere in the table can carry the promise either', () => {
    const keys = Object.keys(T).filter((k) => /source_cell_value_contract_invalid|source_evidence_invalid/.test(k));
    for (const named of [...SURFACES, LINEAGE_REFUSAL]) expect(keys, named).toContain(named);
    expect(keys.length).toBeGreaterThanOrEqual(SURFACES.length + 1);
    for (const key of keys) {
      expect(T[key].en, `${key}.en`).not.toMatch(EN_PROMISE);
      expect(T[key].ar, `${key}.ar`).not.toMatch(AR_PROMISE);
    }
    // The removed HC1.1 replacement-stage sentence stays removed.
    expect((T as Record<string, unknown>).cn2b_simple_expert_body_source_replacement).toBeUndefined();
  });

  it('H1_3_16 — every one of the six surfaces (and the lineage refusal) is pinned EXACTLY, in both languages: a reworded promise cannot slip through a denylist', () => {
    // The three owner-specified sentences.
    expect(T.cn2b_simple_blocker_source_evidence_invalid.en).toBe('Some imported cells are invalid source evidence under the safety contract. This evidence cannot be repaired in this workflow. Review the readiness details for diagnosis and controlled escalation.');
    expect(T.cn2b_simple_blocker_source_evidence_invalid.ar).toBe('بعض الخلايا المستوردة تمثل دليلاً مصدرياً غير صالح وفق عقد السلامة. لا يمكن إصلاح هذا الدليل داخل دورة العمل الحالية. راجع تفاصيل الجاهزية للتشخيص والتصعيد المضبوط.');
    expect(T.cn2b_simple_blocker_lineage_source_cell_value_contract_invalid.en).toBe('A need-line quantity depends on invalid immutable source evidence. Removing the link does not make that evidence valid. Review the readiness details for diagnosis and controlled escalation.');
    expect(T.cn2b_simple_blocker_lineage_source_cell_value_contract_invalid.ar).toBe('تعتمد كمية في سطر الاحتياج على دليل مصدري غير صالح وغير قابل للتعديل. حذف الربط وحده لا يجعل الدليل صالحاً. راجع تفاصيل الجاهزية للتشخيص والتصعيد المضبوط.');
    expect(T.cn2b_simple_expert_body_source_evidence_invalid.en).toBe('The immutable source evidence is invalid under the safety contract. It cannot be repaired in this workflow. The “__STAGE__” stage provides diagnostic details for controlled escalation; opening it does not itself resolve the evidence problem.');
    expect(T.cn2b_simple_expert_body_source_evidence_invalid.ar).toBe('بيانات المصدر الأصلية غير صالحة وفق عقد السلامة. لا يمكن إصلاح هذا الدليل داخل دورة العمل الحالية. تعرض مرحلة «__STAGE__» تفاصيل تشخيصية للتصعيد المضبوط، لكن فتحها لا يحل مشكلة الدليل بحد ذاته.');
    // The three the Advanced readiness stage and the refusal toast show.
    expect(T.cn2b_blocker_source_cell_value_contract_invalid.en).toBe('An imported source cell is invalid evidence under the safety contract. It cannot be repaired in this workflow — it needs diagnosis and controlled escalation.');
    expect(T.cn2b_blocker_source_cell_value_contract_invalid.ar).toBe('خلية مصدرية مستوردة تمثل دليلاً غير صالح وفق عقد السلامة. لا يمكن إصلاحها داخل دورة العمل الحالية — وتحتاج إلى التشخيص والتصعيد المضبوط.');
    expect(T.cn2b_blocker_need_line_quantity_lineage_unsafe__source_cell_value_contract_invalid.en).toBe('A need-line quantity depends on invalid immutable source evidence. Removing the link does not make that evidence valid — it needs diagnosis and controlled escalation.');
    expect(T.cn2b_blocker_need_line_quantity_lineage_unsafe__source_cell_value_contract_invalid.ar).toBe('تعتمد كمية في سطر الاحتياج على دليل مصدري غير صالح وغير قابل للتعديل. حذف الربط وحده لا يجعل الدليل صالحًا — ويحتاج إلى التشخيص والتصعيد المضبوط.');
    expect(T.cn2b_err_source_cell_value_contract_invalid.en).toBe('This source cell is invalid evidence under the safety contract. It cannot be repaired in this workflow — it needs diagnosis and controlled escalation.');
    expect(T.cn2b_err_source_cell_value_contract_invalid.ar).toBe('هذه الخلية المصدرية دليل غير صالح وفق عقد السلامة. لا يمكن إصلاحها داخل دورة العمل الحالية — وتحتاج إلى التشخيص والتصعيد المضبوط.');
    // The save-refusal for a need line that holds invalid evidence (it says why the line was not saved; no remedy is named).
    expect(T[LINEAGE_REFUSAL].en).toBe('The refused need line was not saved: one of its designated cells is invalid source evidence under the safety contract and cannot feed a need line.');
    expect(T[LINEAGE_REFUSAL].ar).toBe('لم يُحفظ سطر الاحتياج المرفوض: إحدى خلاياه المعيّنة دليل مصدري غير صالح وفق عقد السلامة ولا يمكن أن تغذّي سطر احتياج.');
  });

  it('H1_3_17 — every surface says, in BOTH languages: invalid under the safety contract / not repairable in this workflow / diagnosis and controlled escalation (the lineage ones: removing the link does not make the evidence valid)', () => {
    for (const key of SURFACES) {
      const { en, ar } = T[key];
      const isLineage = /lineage/.test(key);
      // The state of the evidence.
      expect(en, `${key}.en`).toMatch(/invalid/);
      expect(ar, `${key}.ar`).toMatch(/غير صالح/);
      if (isLineage) {
        expect(en, `${key}.en`).toMatch(/Removing the link does not make that evidence valid/);
        expect(ar, `${key}.ar`).toMatch(/حذف الربط وحده لا يجعل الدليل صالح/);
        expect(en, `${key}.en`).toMatch(/immutable/);
        expect(ar, `${key}.ar`).toMatch(/غير قابل للتعديل/);
      } else {
        expect(en, `${key}.en`).toMatch(/cannot be repaired in this workflow/);
        expect(ar, `${key}.ar`).toMatch(/لا يمكن إصلاح/);
      }
      // What to do instead: diagnosis and CONTROLLED ESCALATION, in both languages.
      expect(en, `${key}.en`).toMatch(/escalation/);
      // (the stems, because Arabic contracts the article: «للتشخيص» / «للتصعيد»)
      expect(ar, `${key}.ar`).toMatch(/تصعيد المضبوط/);
      expect(en, `${key}.en`).toMatch(/diagnos/);
      expect(ar, `${key}.ar`).toMatch(/تشخيص/);
    }
  });

  it('H1_3_17 — the lineage refusal speaks the SAME vocabulary ("invalid … under the safety contract"), not the old "structurally invalid", in both languages', () => {
    expect(T[LINEAGE_REFUSAL].en).toMatch(/invalid source evidence under the safety contract/);
    expect(T[LINEAGE_REFUSAL].ar).toMatch(/دليل مصدري غير صالح وفق عقد السلامة/);
    for (const key of [...SURFACES, LINEAGE_REFUSAL]) {
      expect(T[key].en, `${key}.en`).not.toMatch(/structurally invalid/i);
      expect(T[key].ar, `${key}.ar`).not.toMatch(/بنيويًا|بنيوياً/);
    }
  });

  it('the Simple escape title for it is the diagnostic one, and no copy sends the person to the Source stage', () => {
    expect(T.cn2b_simple_expert_title_unknown.en).toBe('Expert diagnostic review');
    for (const key of SURFACES) {
      expect(T[key].en, key).not.toMatch(/Source (and import|stage)/i);
      expect(T[key].ar, key).not.toMatch(/المصدر والاستيراد|مرحلة المصدر/);
    }
  });
});

describe('H1_3_13b — the numeric-required copy names BOTH legitimate next steps and never decides which one applies (the derivation does)', () => {
  const SIMPLE_KEY = 'cn2b_simple_blocker_lineage_source_quantity_requires_explicit_numeric_override';
  const ADVANCED_KEY = 'cn2b_blocker_need_line_quantity_lineage_unsafe__source_quantity_requires_explicit_numeric_override';
  // The write-time REFUSAL is the same reason's third surface. It is what a person sees after re-designating the cell but forgetting to PIN
  // the numeric head they already have (the Simple remedy's own failure mode), so it must not tell them to record a new override unconditionally.
  const REFUSAL_KEY = 'cn2b_err_need_line_quantity_lineage_unsafe__source_quantity_requires_explicit_numeric_override';

  it('the state the sentence DESCRIBES is pinned too (a flipped, false description cannot pass): not a plain number, and the quantity pins no numeric correction', () => {
    expect(T[SIMPLE_KEY].en).toMatch(/^A quantity comes from a cell that is not a plain number, and that quantity is not pinned to a numeric correction\./);
    expect(T[SIMPLE_KEY].ar).toMatch(/^كمية مأخوذة من خلية ليست رقمًا صريحًا، وهذه الكمية غير مثبَّتة على تصحيح رقمي\./);
    expect(T[ADVANCED_KEY].en).toMatch(/^A need line takes its quantity from a cell that is not a plain number, and that quantity is not pinned to a numeric override — /);
    expect(T[ADVANCED_KEY].ar).toMatch(/^سطر احتياج يأخذ كميته من خلية ليست رقمًا صريحًا، وهذه الكمية غير مثبَّتة على تعديل رقمي — /);
    expect(T[REFUSAL_KEY].en).toMatch(/^The refused need line was not saved: one of its designated cells is not a plain number, and its designated quantity is not pinned to a numeric override\./);
    expect(T[REFUSAL_KEY].ar).toMatch(/^لم يُحفظ سطر الاحتياج المرفوض: إحدى خلاياه المعيّنة ليست رقمًا صريحًا، وكميتها المعيّنة غير مثبَّتة على تعديل رقمي\./);
  });

  it('the Simple and Advanced surfaces: record a numeric correction first if there is none; once there is one, delete the need line, designate the cell again and pin the CURRENT one', () => {
    expect(T[SIMPLE_KEY].en).toMatch(/If the cell has no current usable numeric correction yet, record one first; once it has one, delete the need line, designate the cell again and pin the current correction\.$/);
    expect(T[SIMPLE_KEY].ar).toMatch(/إن لم يكن لهذه الخلية تصحيح رقمي حالي صالح للاستخدام بعد، فسجّل واحدًا أولًا؛ وبعد أن يوجد، احذف سطر الاحتياج ثم عيّن الخلية من جديد وثبّت التصحيح الحالي\.$/);
    expect(T[ADVANCED_KEY].en).toMatch(/if the cell has no current usable numeric override yet, record one first; once it has one, delete the need line, designate the cell again and pin the current override$/);
    expect(T[ADVANCED_KEY].ar).toMatch(/وإن لم يكن لها تعديل رقمي حالي صالح للاستخدام بعد فسجّل واحدًا أولًا، وبعد أن يوجد احذف سطر الاحتياج ثم عيّن الخلية من جديد وثبّت التعديل الحالي$/);
  });

  it('the remedy names the whole-LINE delete the panel really offers ("Delete line"), never a per-source delete that does not exist', () => {
    for (const key of [SIMPLE_KEY, ADVANCED_KEY]) {
      expect(T[key].en, key).toMatch(/delete the need line/);
      expect(T[key].en, key).not.toMatch(/delete (and re-designate )?(that|the) source/i);
      expect(T[key].ar, key).toMatch(/احذف سطر الاحتياج/);
      expect(T[key].ar, key).not.toMatch(/احذف (ذلك )?المصدر/);
    }
    // …and that really is what the panel's own control is: a line delete.
    expect(T.cn2b_nl_delete.en).toBe('Delete line');
    expect(T.cn2b_nl_delete.ar).toBe('حذف السطر');
  });

  it('neither surface says unconditionally that no correction exists, or that one does — each next step is conditional on the state the reader can see', () => {
    for (const key of [SIMPLE_KEY, ADVANCED_KEY, REFUSAL_KEY]) {
      expect(T[key].en, key).toMatch(/\b[Ii]f the cell has no current usable numeric (correction|override) yet\b/);
      expect(T[key].en, key).toMatch(/once it has one/);
      expect(T[key].en, key).not.toMatch(/re-?import|replacement/i);
      expect(T[key].ar, key).not.toMatch(/إعادة استيراد|استبدال/);
    }
    for (const key of [SIMPLE_KEY, ADVANCED_KEY]) {
      expect(T[key].en, key).not.toMatch(/or remove the cell|or delete that source$/i);
    }
  });

  it('the write-time refusal names both next steps too: record one first if there is none; once there is one, PIN the current override — or remove the cell', () => {
    expect(T[REFUSAL_KEY].en).toMatch(/If the cell has no current usable numeric override yet, record one first; once it has one, pin the current override to the designated cell, or remove the cell\.$/);
    expect(T[REFUSAL_KEY].ar).toMatch(/إن لم يكن لها تعديل رقمي حالي صالح للاستخدام بعد فسجّل واحدًا أولًا، وبعد أن يوجد ثبّت التعديل الحالي على الخلية المعيّنة، أو أزل الخلية\.$/);
    // It is still a refusal of THIS line, not a claim that anything was saved, and it promises nothing the app cannot do.
    expect(T[REFUSAL_KEY].en).toMatch(/The refused need line was not saved/);
    expect(T[REFUSAL_KEY].en).not.toMatch(/re-?import|replacement|automatic|nothing (was|has been) (saved|changed|written)/i);
    expect(T[REFUSAL_KEY].ar).not.toMatch(/إعادة استيراد|استبدال|تلقائ|لم يُحفظ شيء|لم يتغيّر شيء/);
    // Not the old unconditional wording that sent a person who already HAS a numeric override off to record another one.
    expect(T[REFUSAL_KEY].en).not.toMatch(/Record a numeric override for it and pin that override/);
    expect(T[REFUSAL_KEY].ar).not.toMatch(/سجّل لها تعديلًا رقميًا وثبّته/);
  });
});

describe('H1_3 — the head-unproven diagnostic serves BOTH head-dependent reasons, so it makes no claim a stale pin alone would make, and does not assert a failed read', () => {
  const BODY = 'cn2b_simple_expert_body_override_head_unproven';

  it('it names both states the server may be describing (a stale pin, and no pin) with the quantity as its subject, and says it could not prove which correction is current', () => {
    expect(T[BODY].en).toMatch(/^The server reports that a quantity is pinned to a correction that is not its cell’s current one, or to none, but this view could not prove which correction is current for that cell/);
    expect(T[BODY].ar).toMatch(/^يذكر الخادم أن كمية مثبَّتة على تصحيح ليس التصحيح الحالي لخليتها، أو غير مثبَّتة على أي تصحيح، لكن هذه الواجهة لم تستطع إثبات أي تصحيح هو الحالي لتلك الخلية/);
    // It does not presuppose that a numeric correction exists (that is exactly what it could not prove).
    expect(T[BODY].en).not.toMatch(/needs its current numeric correction/);
  });

  it('while the chain is being re-read the reason is simply "not available" — it never claims a read FAILED (it may merely be loading)', () => {
    expect(T[BODY].en).toMatch(/the server’s detail does not name the cell, or the correction list is not available — so it does not guess/);
    expect(T[BODY].ar).toMatch(/إما لأن تفاصيل الخادم لا تسمّي الخلية أو لأن قائمة التصحيحات غير متاحة — ولذلك لا تخمّن/);
    expect(T[BODY].en).not.toMatch(/could not be read|failed/i);
    expect(T[BODY].ar).not.toMatch(/تعذّرت قراءة|فشل/);
    // It still promises nothing about what the stage can do.
    expect(T[BODY].en).toMatch(/does not guarantee the problem can be resolved there/);
    expect(T[BODY].ar).toMatch(/لا يضمن إمكان حلّ المشكلة هناك/);
  });

  it('the Advanced binding_invalid label keeps parity with the numeric-required one: it, too, says to record a numeric override first when the cell has none', () => {
    const key = 'cn2b_blocker_need_line_quantity_lineage_unsafe__source_quantity_override_binding_invalid';
    expect(T[key].en).toMatch(/re-pin the current numeric override \(if the cell has no current usable numeric override yet, record one first\), or delete and re-designate the source$/);
    expect(T[key].ar).toMatch(/\(وإن لم يكن للخلية تعديل رقمي حالي صالح للاستخدام بعد فسجّل واحدًا أولًا\)، أو احذف المصدر وأعد تعيينه$/);
  });
});

// ===================================================================================================
// CN-UI-S1 HC1.4 — a "numeric" override is not necessarily a PINNABLE one
// ===================================================================================================
// The canonical NeedLine contract accepts a designated quantity only as a plain decimal, untrimmed, of at most 256
// characters. `numericOverrideLexeme` is the one authority for "can this override be pinned as a designated quantity?";
// the derivation consumes its answer and writes none of that grammar itself.
const BOTH = [NUMERIC_REQUIRED, BINDING] as const;
const forReason = (reason: string | null, record: string | null = 'rec-5') => readiness([rowFor(reason, record)]);
const say = (reason: string, what: string) => `${reason.replace('source_quantity_', '')} / ${what}`;

describe('H1_4_01 / H1_4_02 — the 256-character boundary of the canonical quantity lexeme (exact PostgreSQL-style decimal text)', () => {
  it('H1_4_01 — a 256-character plain decimal (integer AND fraction) with a compatible numeric finalValue → numericOverrideLexeme is non-null → SIMPLE', () => {
    for (const text of [intText(256), fracText(256)]) {
      const head = pgOverride('rec-5', text);
      expect(text).toHaveLength(256);
      expect(typeof head.finalValue).toBe('number'); // compatible numeric finalValue …
      expect(Number.isFinite(head.finalValue as number)).toBe(true);
      expect(numericOverrideLexeme(head)).toBe(text); // … and the lexeme is the exact text, byte for byte
      for (const reason of BOTH) expect(deriveSimpleExpertEscapes(forReason(reason), chain(head)), say(reason, text.slice(0, 6))).toEqual(SIMPLE);
    }
  });

  it('H1_4_02 — the SAME shape at 257 characters is still a numeric override, but its lexeme is null → REVIEW, not Simple (the confirmed HC1.3 residual)', () => {
    for (const text of [intText(257), fracText(257)]) {
      const head = pgOverride('rec-5', text);
      expect(text).toHaveLength(257);
      expect(isNumericOverride(head)).toBe(true); // numeric …
      expect(numericOverrideLexeme(head)).toBeNull(); // … yet not pinnable: "numeric" and "pinnable" are not synonyms
      for (const reason of BOTH) {
        expect(deriveSimpleExpertEscapes(forReason(reason), chain(head)), say(reason, text.slice(0, 6))).toEqual(REVIEW);
        expect(deriveSimpleExpertEscape(forReason(reason), chain(head)), say(reason, 'first')).toEqual({ stage: 'review', reason: 'numeric_override' });
      }
    }
  });

  it('every shape the service can return sorts the same way as the canonical helper says — and the table is written out literally, not derived from it', () => {
    type Shape = readonly [label: string, head: FieldOverride, pinnable: boolean];
    const shapes: ReadonlyArray<Shape> = [
      // pinnable (Simple)
      ['zero', pgOverride('rec-5', '0'), true],
      ['integer', pgOverride('rec-5', '12'), true],
      ['trailing-zero fraction (a legal plain decimal)', pgOverride('rec-5', '12.50'), true],
      ['tiny decimal — its JS String() has an exponent, its exact text does not', pgOverride('rec-5', '0.0000001'), true],
      ['22-digit integer — its JS String() has an exponent, its exact text does not', pgOverride('rec-5', intText(22)), true],
      ['long fraction', pgOverride('rec-5', '123456789012345678901234567890.123456789'), true],
      ['256-character integer', pgOverride('rec-5', intText(256)), true],
      ['256-character fraction', pgOverride('rec-5', fracText(256)), true],
      // numeric but NOT pinnable (Review)
      ['257-character integer', pgOverride('rec-5', intText(257)), false],
      ['257-character fraction', pgOverride('rec-5', fracText(257)), false],
      ['309-digit integer (still a finite JS number)', pgOverride('rec-5', intText(309)), false],
      ['400-digit integer (JSON.parse gives Infinity: not even numeric)', pgOverride('rec-5', intText(400)), false],
      ['300-digit integer', pgOverride('rec-5', intText(300)), false],
      ['302-character tiny fraction (1e-300 written out)', pgOverride('rec-5', `0.${'0'.repeat(299)}1`), false],
      ['tiny negative that underflows to -0 — numeric to isNumericOverride, never pinnable (the sign blocks the lexeme)', pgOverride('rec-5', `-0.${'0'.repeat(400)}1`), false],
      // not numeric at all (Review)
      ['text', override('rec-5', 'twelve'), false],
      ['blank', override('rec-5', ''), false],
      ['null', override('rec-5', null), false],
      ['boolean', override('rec-5', true), false],
      ['negative', pgOverride('rec-5', '-5'), false],
    ];
    for (const [label, head, pinnable] of shapes) {
      expect(numericOverrideLexeme(head) !== null, `helper: ${label}`).toBe(pinnable);
      for (const reason of BOTH) {
        expect(deriveSimpleExpertEscapes(forReason(reason), chain(head)), say(reason, label)).toEqual(pinnable ? SIMPLE : REVIEW);
      }
    }
    // The table really exercises the distinction: there are numeric-but-unpinnable rows, and numeric rows whose JS String() would not pin.
    expect(shapes.filter(([, h, p]) => !p && isNumericOverride(h)).length).toBeGreaterThanOrEqual(5);
    expect(shapes.filter(([, h, p]) => p && String(h.finalValue) !== h.finalValueText).length).toBeGreaterThanOrEqual(2);
  });

  it('type-allowed DEGRADED input — `finalValueText` absent, which a healthy listOverrides never returns (it is null only if the ::text alias is not applied): the helper\'s documented fallback, and it fails closed', () => {
    const degraded: ReadonlyArray<readonly [label: string, head: FieldOverride, pinnable: boolean]> = [
      ['short number, finalValueText null → String() is canonical', { ...override('rec-5', 12), finalValueText: null }, true],
      ['short number, finalValueText undefined', { ...override('rec-5', 12), finalValueText: undefined }, true],
      ['large number, finalValueText null → String() prints an exponent', { ...override('rec-5', 1e21), finalValueText: null }, false],
      ['tiny number, finalValueText null → String() prints an exponent', { ...override('rec-5', 1e-7), finalValueText: null }, false],
      ['finalValueText an empty string', { ...override('rec-5', 12), finalValueText: '' }, false],
    ];
    for (const [label, head, pinnable] of degraded) {
      expect(numericOverrideLexeme(head) !== null, `helper: ${label}`).toBe(pinnable);
      for (const reason of BOTH) expect(deriveSimpleExpertEscapes(forReason(reason), chain(head)), say(reason, label)).toEqual(pinnable ? SIMPLE : REVIEW);
    }
  });
});

describe('H1_4_03 / H1_4_04 / H1_4_05 — the CURRENT head is judged for pinnability; no convenient older or foreign value is ever substituted', () => {
  it('H1_4_03 — newest head is an unpinnable 257-character number, an older override is pinnable → REVIEW (the older value is NOT selected)', () => {
    for (const reason of BOTH) {
      expect(deriveSimpleExpertEscapes(forReason(reason), chain(pgOverride('rec-5', intText(257)), pgOverride('rec-5', '12'))), say(reason, 'one older')).toEqual(REVIEW);
      expect(deriveSimpleExpertEscapes(forReason(reason), chain(pgOverride('rec-5', fracText(257)), pgOverride('rec-5', '7'), pgOverride('rec-5', '0'))), say(reason, 'two older')).toEqual(REVIEW);
      // …and the same chain read the other way round (a pinnable newest head) is Simple: only the head decides.
      expect(deriveSimpleExpertEscapes(forReason(reason), chain(pgOverride('rec-5', '12'), pgOverride('rec-5', intText(257)))), say(reason, 'flipped')).toEqual(SIMPLE);
    }
  });

  it('H1_4_04 — newest head is pinnable, an older override is not → SIMPLE', () => {
    for (const reason of BOTH) {
      expect(deriveSimpleExpertEscapes(forReason(reason), chain(pgOverride('rec-5', '12'), pgOverride('rec-5', intText(257)))), say(reason, 'older long')).toEqual(SIMPLE);
      expect(deriveSimpleExpertEscapes(forReason(reason), chain(pgOverride('rec-5', intText(256)), pgOverride('rec-5', '5'), override('rec-5', 'old text'))), say(reason, '256 over older')).toEqual(SIMPLE);
    }
  });

  it('H1_4_05 — a pinnable head of ANOTHER sourceRecordId (256-character or short) does NOT satisfy this record, and a long one of another record changes nothing', () => {
    for (const reason of BOTH) {
      expect(deriveSimpleExpertEscapes(forReason(reason), chain(pgOverride('rec-OTHER', '12'))), say(reason, 'other short')).toEqual(REVIEW);
      expect(deriveSimpleExpertEscapes(forReason(reason), chain(pgOverride('rec-OTHER', intText(256)), pgOverride('rec-6', '7'))), say(reason, 'other 256')).toEqual(REVIEW);
      for (const near of ['rec-50', 'rec-', 'REC-5', ' rec-5']) {
        expect(deriveSimpleExpertEscapes(forReason(reason), chain(pgOverride(near, '12'))), say(reason, `near-miss ${near}`)).toEqual(REVIEW);
      }
      // Noise around the record's own head changes nothing — only the record's OWN head decides.
      expect(deriveSimpleExpertEscapes(forReason(reason), chain(pgOverride('rec-OTHER', intText(257)), pgOverride('rec-5', '12'))), say(reason, 'own short beside other long')).toEqual(SIMPLE);
      expect(deriveSimpleExpertEscapes(forReason(reason), chain(pgOverride('rec-OTHER', '12'), pgOverride('rec-5', intText(257)))), say(reason, 'own long beside other short')).toEqual(REVIEW);
    }
  });
});

describe('H1_4_06 … H1_4_09 — BOTH head-dependent reasons, through the SAME shared decision', () => {
  const pinnableHead = chain(pgOverride('rec-5', intText(256)));
  const unpinnableHead = chain(pgOverride('rec-5', intText(257)));

  it('H1_4_06 — numeric-required + a pinnable current head → Simple', () => {
    expect(deriveSimpleExpertEscapes(forReason(NUMERIC_REQUIRED), pinnableHead)).toEqual(SIMPLE);
    expect(deriveSimpleExpertEscapes(forReason(NUMERIC_REQUIRED), chain(pgOverride('rec-5', '12.5')))).toEqual(SIMPLE);
  });

  it('H1_4_07 — numeric-required + an unpinnable numeric current head → Review', () => {
    expect(deriveSimpleExpertEscapes(forReason(NUMERIC_REQUIRED), unpinnableHead)).toEqual(REVIEW);
    expect(currentNumericHeadRemedyOf(detailFor('rec-5', NUMERIC_REQUIRED), unpinnableHead)).toEqual({ route: 'expert', reason: 'numeric_override' });
  });

  it('H1_4_08 — binding-invalid + a pinnable current head → Simple', () => {
    expect(deriveSimpleExpertEscapes(forReason(BINDING), pinnableHead)).toEqual(SIMPLE);
    expect(bindingInvalidRemedyOf(detailFor('rec-5', BINDING), pinnableHead)).toEqual({ route: 'simple' });
  });

  it('H1_4_09 — binding-invalid + an unpinnable numeric current head → Review', () => {
    expect(deriveSimpleExpertEscapes(forReason(BINDING), unpinnableHead)).toEqual(REVIEW);
    expect(bindingInvalidRemedyOf(detailFor('rec-5', BINDING), unpinnableHead)).toEqual({ route: 'expert', reason: 'numeric_override' });
  });

  it('the two reasons never disagree: for every shape and chain, numeric-required and binding_invalid give identical answers', () => {
    const chains: SimpleOverrideContext[] = [
      pinnableHead, unpinnableHead, chain(), chain(pgOverride('rec-OTHER', '12')),
      chain(pgOverride('rec-5', intText(257)), pgOverride('rec-5', '12')), chain(pgOverride('rec-5', '12'), pgOverride('rec-5', intText(257))),
      { overrides: [pgOverride('rec-5', '12')], overrideReadFailure: 'field_overrides_not_loaded' },
    ];
    for (const ctx of chains) {
      expect(deriveSimpleExpertEscapes(forReason(NUMERIC_REQUIRED), ctx)).toEqual(deriveSimpleExpertEscapes(forReason(BINDING), ctx));
    }
  });
});

describe('HC1.4 regression contract — nothing else moved, whatever a long or pinnable head says', () => {
  const heads: ReadonlyArray<SimpleOverrideContext | undefined> = [
    undefined, chain(), chain(pgOverride('rec-5', intText(256))), chain(pgOverride('rec-5', intText(257))), chain(pgOverride('rec-5', '12')),
  ];

  it('invalid evidence stays a readiness diagnostic; value_invalid stays Review; mismatch stays Simple; an unknown or missing reason stays a diagnostic', () => {
    for (const ctx of heads) {
      expect(deriveSimpleExpertEscapes(forReason(EVIDENCE), ctx)).toEqual([{ stage: 'readiness', reason: 'source_evidence_invalid' }]);
      expect(deriveSimpleExpertEscapes(readiness([{ blocker: 'source_cell_value_contract_invalid', detail: 'session=s1 source_record=rec-5 reason=invalid_evidence' }]), ctx)).toEqual([{ stage: 'readiness', reason: 'source_evidence_invalid' }]);
      expect(deriveSimpleExpertEscapes(forReason(VALUE_INVALID), ctx)).toEqual(REVIEW);
      expect(deriveSimpleExpertEscapes(forReason(MISMATCH), ctx)).toEqual(SIMPLE);
      for (const reason of ['a_reason_from_the_future', null]) {
        expect(deriveSimpleExpertEscapes(forReason(reason), ctx), String(reason)).toEqual([{ stage: 'readiness', reason: 'unknown_lineage_reason' }]);
      }
    }
  });

  it('a missing source_record, or an unavailable chain, stays a readiness diagnostic for BOTH reasons — even with a pinnable head right there', () => {
    const pinnable = [pgOverride('rec-5', '12'), pgOverride('rec-5', intText(256))];
    for (const reason of BOTH) {
      expect(deriveSimpleExpertEscapes(forReason(reason, null), { overrides: pinnable, overrideReadFailure: null }), say(reason, 'no record')).toEqual(UNPROVEN);
      for (const failure of ['field_overrides_not_loaded', 'field_overrides_read_inconsistent', 'x']) {
        expect(deriveSimpleExpertEscapes(forReason(reason), { overrides: pinnable, overrideReadFailure: failure }), say(reason, failure)).toEqual(UNPROVEN);
      }
      expect(deriveSimpleExpertEscapes(forReason(reason)), say(reason, 'no context')).toEqual(UNPROVEN);
    }
  });

  it('the server\'s verdict is still never suppressed: a ready answer, or a closed revision, never escapes, and the input is not mutated', () => {
    const rows = [rowFor(NUMERIC_REQUIRED), rowFor(BINDING)];
    expect(deriveSimpleExpertEscapes(readiness(rows, { ready: true }), chain(pgOverride('rec-5', intText(257))))).toEqual([]);
    for (const status of ['submitted', 'approved', 'rejected', 'superseded'] as const) {
      expect(deriveSimpleExpertEscapes(readiness(rows, { status }), chain(pgOverride('rec-5', intText(257)))), status).toEqual([]);
    }
    const input = readiness(rows);
    const ctx = chain(pgOverride('rec-5', intText(257)), pgOverride('rec-5', '12'));
    const before = JSON.stringify([input, ctx]);
    deriveSimpleExpertEscapes(input, ctx);
    expect(JSON.stringify([input, ctx])).toBe(before);
  });
});

describe('HC1.4 copy — the Review route no longer calls an unusable number "not a number", and the conditional next steps say "usable"', () => {
  const BODY = 'cn2b_simple_expert_body_numeric_override';

  it('the Review-escape body: a usable numeric correction is what is needed; a correction that is missing, out of date or not USABLE is the problem (EN and AR)', () => {
    expect(T[BODY].en).toMatch(/^A quantity needs a current, usable numeric correction recorded as a non-negative number — its source cell is not a plain number, or the correction it is pinned to is missing, out of date or not a usable number\. /);
    expect(T[BODY].ar).toMatch(/^تحتاج الكمية إلى تصحيح رقمي حالي صالح للاستخدام، مسجَّل كرقم غير سالب: إما لأن الخلية المصدرية ليست رقمًا صريحًا، أو لأن التصحيح المثبَّت عليها مفقود أو لم يعد التصحيح الحالي أو ليس رقمًا صالحًا للاستخدام\. /);
    // It says nothing a reviewer cannot act on: no implementation jargon.
    for (const lang of ['en', 'ar'] as const) expect(T[BODY][lang], lang).not.toMatch(/256|lexeme|JSON|exponent|character|حرف|رمز/i);
  });

  it('the six conditional sentences all say "usable" in the same place (EN and AR), so none claims a cell "has" a correction it cannot use — and none carries implementation jargon', () => {
    const EN: Record<string, RegExp> = {
      cn2b_simple_blocker_lineage_source_quantity_requires_explicit_numeric_override: /If the cell has no current usable numeric correction yet, record one first; once it has one,/,
      cn2b_simple_blocker_lineage_source_quantity_override_binding_invalid: /If the cell has no current usable numeric correction yet, record one first\.$/,
      cn2b_blocker_need_line_quantity_lineage_unsafe__source_quantity_requires_explicit_numeric_override: /if the cell has no current usable numeric override yet, record one first; once it has one,/,
      cn2b_blocker_need_line_quantity_lineage_unsafe__source_quantity_override_binding_invalid: /\(if the cell has no current usable numeric override yet, record one first\)/,
      cn2b_err_need_line_quantity_lineage_unsafe__source_quantity_requires_explicit_numeric_override: /If the cell has no current usable numeric override yet, record one first; once it has one,/,
      cn2b_err_need_line_quantity_lineage_unsafe__source_quantity_override_binding_invalid: /pin the current numeric override again once they are loaded\. If the cell has no current usable numeric override yet, record one first\.$/,
    };
    for (const [key, re] of Object.entries(EN)) {
      expect(T[key].en, key).toMatch(re);
      expect(T[key].ar, key).toMatch(/صالح للاستخدام/);
      // No second, un-"usable" version of the condition is left behind.
      expect(T[key].en, key).not.toMatch(/no current numeric (correction|override) yet/);
      expect(T[key].ar, key).not.toMatch(/تصحيح رقمي حالي بعد|تعديل رقمي حالي بعد/);
      for (const lang of ['en', 'ar'] as const) expect(T[key][lang], `${key}.${lang}`).not.toMatch(/256|lexeme|JSON|exponent|character|حرف|رمز/i);
    }
  });
});
