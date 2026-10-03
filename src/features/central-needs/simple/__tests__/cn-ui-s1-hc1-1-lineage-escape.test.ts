/**
 * CN-UI-S1 HC1.1-A (revised by HC1.2) — EVERY reason of M217's quantity-lineage
 * vocabulary is classified, so Simple cannot dead-end on a reason whose remedy
 * exists only in Advanced (H1_1_01 … H1_1_09).
 *
 * HC1.2 changed two of the five classes, HC1.3 a third, and this file now states them:
 *   * `source_cell_value_contract_invalid` — NO in-app remedy exists (no control
 *     replaces the evidence of a completed import), so it is a DIAGNOSTIC escape
 *     to READINESS, not a route to SOURCE;
 *   * `source_quantity_override_binding_invalid` — condition-aware (decided from
 *     the cell's current head; the head conditions are proven in
 *     `cn-ui-s1-hc1-2-lineage-remedy.test.ts`);
 *   * `source_quantity_requires_explicit_numeric_override` (HC1.3) — condition-aware
 *     in exactly the same way, through the SAME function (the head conditions for
 *     both are proven in `cn-ui-s1-hc1-3-lineage-head.test.ts`).
 *
 * The expectations below are written out INDEPENDENTLY of the implementation
 * (one literal row per reason, with the owner's class and route), and the
 * vocabulary itself is read from migration 217's own helper function — so a
 * reason the server gains or loses cannot slip past either side unnoticed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { T } from '@/shared/i18n/strings';
import type { FieldOverride, ReviewReadiness } from '../../central-needs.service';
import {
  M217_LINEAGE_REASONS, deriveSimpleExpertEscape, deriveSimpleExpertEscapes, lineageRemedyOf,
  type SimpleOverrideContext,
} from '../simpleReadiness';

const ROOT = join(__dirname, '../../../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const LINEAGE = 'need_line_quantity_lineage_unsafe';
const row = (reason: string | null) => ({
  blocker: LINEAGE,
  detail: reason === null ? 'session=s1 source_record=r1 need_line=n1' : `session=s1 source_record=r1 need_line=n1 reason=${reason}`,
});
const readiness = (blockers: ReviewReadiness['blockers'], ready = false): ReviewReadiness => ({
  planRevisionId: 'rev-1', status: 'draft', ready, blockers,
});
const override = (sourceRecordId: string, finalValue: unknown, id: string): FieldOverride => ({
  id, sourceRecordId, targetEntity: 'row-5', fieldName: 'qty', previousValue: null, finalValue,
  finalValueText: typeof finalValue === 'number' ? String(finalValue) : JSON.stringify(finalValue),
  overrideReason: 'reviewed', overrideNote: null, createdAt: '2026-09-26T10:00:00+00:00',
});
/** The cell r1 has a CURRENT NUMERIC head, and the chain was read completely. */
const NUMERIC_HEAD: SimpleOverrideContext = { overrides: [override('r1', 12, 'ov-r1')], overrideReadFailure: null };
/** The chain was read completely and the cell r1 has NO current head: a numeric correction is what it still needs. */
const NO_HEAD: SimpleOverrideContext = { overrides: [], overrideReadFailure: null };

/** The owner's frozen classification — one row per reason, nothing implicit. */
const FROZEN = {
  source_cell_value_contract_invalid: { cls: 'DIAGNOSTIC_READINESS', remedy: { route: 'diagnostic', reason: 'source_evidence_invalid' }, escape: { stage: 'readiness', reason: 'source_evidence_invalid' } },
  source_quantity_requires_explicit_numeric_override: { cls: 'CONDITION_AWARE', remedy: { route: 'head_dependent' }, escape: 'depends-on-the-current-head' },
  source_quantity_override_binding_invalid: { cls: 'CONDITION_AWARE', remedy: { route: 'head_dependent' }, escape: 'depends-on-the-current-head' },
  source_quantity_override_value_invalid: { cls: 'EXPERT_REVIEW', remedy: { route: 'expert', reason: 'numeric_override' }, escape: { stage: 'review', reason: 'numeric_override' } },
  source_quantity_override_mismatch: { cls: 'SIMPLE', remedy: { route: 'simple' }, escape: null },
} as const;
type FrozenReason = keyof typeof FROZEN;
const FROZEN_REASONS = Object.keys(FROZEN) as FrozenReason[];

describe('H1_1_08 — the vocabulary is exactly the server\'s, and every reason is classified', () => {
  it('the five reasons are those migration 217\'s lineage helper can return — read from the SQL, not retyped', () => {
    const sql = read('supabase/migrations/217_phoenix_central_needs_c5_safety_convergence.sql');
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public._phoenix_central_needs_quantity_lineage_violation_v1(');
    const end = sql.indexOf('$$;', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const returned = [...sql.slice(start, end).matchAll(/THEN '([a-z_]+)'/g)].map((m) => m[1]).filter((r) => r !== 'NULL');
    expect(returned).toHaveLength(5);
    expect([...M217_LINEAGE_REASONS].sort()).toEqual([...returned].sort());
    expect([...FROZEN_REASONS].sort()).toEqual([...returned].sort());
  });

  it('it is the same vocabulary Simple already has a sentence for — the two tables cannot drift apart', () => {
    const src = read('src/features/central-needs/simple/simpleReadiness.ts');
    const table = src.match(/const LINEAGE_MESSAGE_KEY_BY_REASON[\s\S]*?\n\];/);
    expect(table, 'LINEAGE_MESSAGE_KEY_BY_REASON').not.toBeNull();
    const sentences = [...(table as RegExpMatchArray)[0].matchAll(/\['([a-z_]+)', 'cn2b_simple_blocker_lineage_[a-z_]+'\]/g)].map((m) => m[1]);
    expect([...sentences].sort()).toEqual([...M217_LINEAGE_REASONS].sort());
  });

  it('each of the five reasons is classified by the owner\'s frozen table (DIAGNOSTIC / EXPERT_REVIEW / CONDITION_AWARE / SIMPLE)', () => {
    for (const reason of FROZEN_REASONS) {
      expect(lineageRemedyOf(reason), reason).toEqual(FROZEN[reason].remedy);
    }
  });

  it('the table and the derivation agree: an expert / diagnostic reason in the table IS the reason of the escape the derivation returns (one answer, never two)', () => {
    for (const reason of FROZEN_REASONS) {
      const remedy = lineageRemedyOf(reason);
      const escapes = deriveSimpleExpertEscapes(readiness([row(reason)]), NUMERIC_HEAD);
      if (remedy?.route === 'expert' || remedy?.route === 'diagnostic') {
        expect(escapes.map((e) => e.reason), reason).toEqual([remedy.reason]);
      } else {
        expect(escapes, reason).toEqual([]); // simple, or head-dependent with a proven PINNABLE head (HC1.4)
      }
    }
  });

  it('the table is TYPE-exhaustive: keyed by the vocabulary\'s union, so a sixth reason without a class does not compile', () => {
    const src = read('src/features/central-needs/simple/simpleReadiness.ts');
    expect(src).toMatch(/export const M217_LINEAGE_REASONS = \[[\s\S]*?\] as const;/);
    expect(src).toMatch(/export type M217LineageReason = \(typeof M217_LINEAGE_REASONS\)\[number\];/);
    expect(src).toMatch(/const LINEAGE_REMEDY_BY_REASON: Readonly<Record<M217LineageReason, LineageRemedy>> = \{/);
    // One entry per reason, each an explicit route — no spread, no fallback entry.
    const table = (src.match(/const LINEAGE_REMEDY_BY_REASON[\s\S]*?\n\};/) as RegExpMatchArray)[0];
    expect([...table.matchAll(/^\s{2}([a-z_]+): \{ route:/gm)].map((m) => m[1]).sort()).toEqual([...M217_LINEAGE_REASONS].sort());
    expect(table).not.toMatch(/\.\.\.|default|\[key\]|\[reason\]/);
  });
});

describe('H1_1_01 … H1_1_05 — each reason, through the one derivation (HC1.2 classes)', () => {
  it('H1_1_01 (HC1.2) — source_cell_value_contract_invalid, the lineage reason → a DIAGNOSTIC escape to READINESS, never SOURCE', () => {
    expect(deriveSimpleExpertEscapes(readiness([row('source_cell_value_contract_invalid')])))
      .toEqual([{ stage: 'readiness', reason: 'source_evidence_invalid' }]);
  });

  it('H1_1_01 (HC1.2) — and so is the standalone C5 §7.1 blocker of the same name (ONE meaning), once even beside its lineage row', () => {
    const blocker = { blocker: 'source_cell_value_contract_invalid', detail: 'session=s1 source_record=r1 reason=invalid_evidence' };
    expect(deriveSimpleExpertEscapes(readiness([blocker]))).toEqual([{ stage: 'readiness', reason: 'source_evidence_invalid' }]);
    expect(deriveSimpleExpertEscapes(readiness([blocker, row('source_cell_value_contract_invalid')])))
      .toEqual([{ stage: 'readiness', reason: 'source_evidence_invalid' }]);
  });

  it('H1_1_02 (HC1.3) — source_quantity_requires_explicit_numeric_override is HEAD-DEPENDENT: no current pinnable head → the DATA REVIEW stage; a proven pinnable head → no escape; no proof → READINESS', () => {
    const numericRequired = readiness([row('source_quantity_requires_explicit_numeric_override')]);
    expect(deriveSimpleExpertEscapes(numericRequired, NO_HEAD)).toEqual([{ stage: 'review', reason: 'numeric_override' }]);
    expect(deriveSimpleExpertEscapes(numericRequired, NUMERIC_HEAD)).toEqual([]);
    expect(deriveSimpleExpertEscapes(numericRequired)).toEqual([{ stage: 'readiness', reason: 'override_head_unproven' }]);
  });

  it('H1_1_03 (HC1.2) — source_quantity_override_binding_invalid is Simple-resolvable ONLY with a proven pinnable current head (HC1.4: numeric AND usable as a quantity): then no escape, alone or beside anything Simple resolves', () => {
    expect(deriveSimpleExpertEscapes(readiness([row('source_quantity_override_binding_invalid')]), NUMERIC_HEAD)).toEqual([]);
    expect(deriveSimpleExpertEscape(readiness([
      { blocker: 'mapped_target_entity_without_need_line', detail: 'session=s1 target_entity=row-5' },
      row('source_quantity_override_binding_invalid'),
    ]), NUMERIC_HEAD)).toBeNull();
    // Without that proof it is never assumed resolvable (every branch is proven in the HC1.2 suite).
    expect(deriveSimpleExpertEscapes(readiness([row('source_quantity_override_binding_invalid')])))
      .toEqual([{ stage: 'readiness', reason: 'override_head_unproven' }]);
  });

  it('H1_1_04 — source_quantity_override_value_invalid → the DATA REVIEW stage (Simple never creates a numeric override)', () => {
    expect(deriveSimpleExpertEscapes(readiness([row('source_quantity_override_value_invalid')])))
      .toEqual([{ stage: 'review', reason: 'numeric_override' }]);
  });

  it('H1_1_05 — source_quantity_override_mismatch is SIMPLE-resolvable: no escape, with or without any override context', () => {
    expect(deriveSimpleExpertEscapes(readiness([row('source_quantity_override_mismatch')]))).toEqual([]);
    expect(deriveSimpleExpertEscape(readiness([row('source_quantity_override_mismatch')]), NUMERIC_HEAD)).toBeNull();
  });

  it('the numeric reasons share ONE escape (the same remedy), however many rows and in whatever order', () => {
    expect(deriveSimpleExpertEscapes(readiness([
      row('source_quantity_override_value_invalid'), row('source_quantity_requires_explicit_numeric_override'), row('source_quantity_override_value_invalid'),
    ]), NO_HEAD)).toEqual([{ stage: 'review', reason: 'numeric_override' }]);
  });

  it('every reason, one by one, agrees with the frozen table — and a mixed list escapes exactly for the non-Simple ones', () => {
    for (const reason of FROZEN_REASONS) {
      const expected = FROZEN[reason].escape;
      if (expected === 'depends-on-the-current-head') continue; // proven branch by branch in the HC1.2 suite
      expect(deriveSimpleExpertEscapes(readiness([row(reason)])), reason).toEqual(expected === null ? [] : [expected]);
      // The owner's class name and the route agree: DIAGNOSTIC -> readiness, EXPERT_REVIEW -> review, SIMPLE -> none.
      const stageOfClass: Record<string, string | undefined> = { DIAGNOSTIC_READINESS: 'readiness', EXPERT_REVIEW: 'review', SIMPLE: undefined };
      expect(expected?.stage, reason).toBe(stageOfClass[FROZEN[reason].cls]);
    }
    expect(deriveSimpleExpertEscapes(readiness(FROZEN_REASONS.map((r) => row(r))), NUMERIC_HEAD)).toEqual([
      { stage: 'review', reason: 'numeric_override' },
      { stage: 'readiness', reason: 'source_evidence_invalid' },
    ]);
    // Only the two Simple-resolvable ones (binding_invalid with a proven pinnable head): nothing.
    expect(deriveSimpleExpertEscapes(readiness([
      row('source_quantity_override_binding_invalid'), row('source_quantity_override_mismatch'),
    ]), NUMERIC_HEAD)).toEqual([]);
  });
});

describe('H1_1_06 / H1_1_07 / H1_1_09 — an unknown, missing or future reason fails CLOSED, never to Simple', () => {
  const UNKNOWN_LINEAGE = { stage: 'readiness', reason: 'unknown_lineage_reason' };

  it('H1_1_06 — a reason this build does not know → the READINESS stage, diagnostic only', () => {
    for (const reason of ['a_future_reason_this_build_has_never_seen', 'source_quantity_override_stale', 'SOURCE_QUANTITY_OVERRIDE_MISMATCH']) {
      expect(deriveSimpleExpertEscapes(readiness([row(reason)]), NUMERIC_HEAD), reason).toEqual([UNKNOWN_LINEAGE]);
      expect(lineageRemedyOf(reason), reason).toBeNull();
    }
  });

  it('H1_1_07 — a missing or malformed reason token → the READINESS stage', () => {
    const malformed: ReviewReadiness['blockers'] = [
      { blocker: LINEAGE, detail: null },
      { blocker: LINEAGE, detail: '' },
      { blocker: LINEAGE, detail: 'session=s1 source_record=r1 need_line=n1' },                   // no token
      { blocker: LINEAGE, detail: 'session=s1 source_record=r1 need_line=n1 reason=' },            // empty token
      { blocker: LINEAGE, detail: 'session=s1 source_record=r1 need_line=n1 reason=,' },
      { blocker: LINEAGE, detail: 'source_quantity_override_mismatch' },                           // bare text, not a token
      { blocker: LINEAGE, detail: 'session=s1 note=source_quantity_override_mismatch' },           // another key
      { blocker: LINEAGE, detail: 'session=s1 xreason=source_quantity_override_mismatch' },        // a longer key
      { blocker: LINEAGE, detail: 'session=s1 reason=source_quantity_override_mismatch,' },        // trailing punctuation
      { blocker: LINEAGE, detail: 'session=s1 reason=source_quantity_override_mismatch_v2' },      // a longer token
      { blocker: LINEAGE, detail: 'session=s1 reason=Source_Quantity_Override_Mismatch' },         // case differs
    ];
    for (const blocker of malformed) {
      expect(deriveSimpleExpertEscapes(readiness([blocker]), NUMERIC_HEAD), JSON.stringify(blocker.detail)).toEqual([UNKNOWN_LINEAGE]);
    }
  });

  it('H1_1_09 — a future reason can never fall into Simple-resolvable behaviour: not by name, not by an inherited object property either', () => {
    for (const reason of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'prototype']) {
      expect(lineageRemedyOf(reason), reason).toBeNull();
      expect(deriveSimpleExpertEscapes(readiness([row(reason)]), NUMERIC_HEAD), reason).toEqual([UNKNOWN_LINEAGE]);
    }
    expect(lineageRemedyOf(null)).toBeNull();
    // The lookup is a closed Map over the five reasons: no default branch answers `simple` for anything else.
    const src = read('src/features/central-needs/simple/simpleReadiness.ts');
    expect(src).toMatch(/const LINEAGE_REMEDY_LOOKUP: ReadonlyMap<string, LineageRemedy> = new Map\(Object\.entries\(LINEAGE_REMEDY_BY_REASON\)\);/);
    const lookup = (src.match(/export function lineageRemedyOf[\s\S]*?\n\}/) as RegExpMatchArray)[0];
    expect(lookup).toContain('LINEAGE_REMEDY_LOOKUP.get(reason) ?? null');
    expect(lookup).not.toMatch(/route: 'simple'/);
    const derive = (src.match(/export function deriveSimpleExpertEscapes\([\s\S]*?\n\}/) as RegExpMatchArray)[0];
    // `null` (unknown) is its own branch, ahead of every route; there is no branch that treats it as resolvable.
    expect(derive).toContain("if (remedy === null) found.add('unknown_lineage_reason');");
    // …and a route added to the type later fails to compile in the switch, and at runtime fails closed, never to Simple.
    expect(src).toContain('function failClosed(unhandled: never): SimpleExpertReason {');
    expect(src).toContain('found.add(failClosed(remedy));');
  });

  it('the reason belongs to the lineage blocker only — the same token on any other code is nothing', () => {
    for (const code of ['target_entity_without_disposition', 'need_line_unit_conversion_required', 'import_session_still_open']) {
      const detail = 'session=s1 reason=source_quantity_requires_explicit_numeric_override';
      const expected = code === 'import_session_still_open' ? [{ stage: 'source', reason: 'open_import' }] : [];
      expect(deriveSimpleExpertEscapes(readiness([{ blocker: code, detail }])), code).toEqual(expected);
    }
  });
});

describe('HC1.1 / HC1.2 — ordering, permissions input, and what is never an escape', () => {
  const OPEN = { blocker: 'import_session_still_open', detail: 'session=s9 status=pending' };
  const UNKNOWN = { blocker: 'brand_new_server_code', detail: null };
  const BINDING_WITHOUT_RECORD = { blocker: LINEAGE, detail: 'session=s1 need_line=n1 reason=source_quantity_override_binding_invalid' };

  it('every kind at once: workflow order — open import (SOURCE), numeric (REVIEW), then the four diagnostics (READINESS)', () => {
    const all = readiness([
      row('a_future_reason'), UNKNOWN, BINDING_WITHOUT_RECORD, row('source_quantity_requires_explicit_numeric_override'),
      row('source_cell_value_contract_invalid'), OPEN,
    ]);
    // (the chain has no head for r1, so the numeric-required row needs a numeric correction → REVIEW)
    expect(deriveSimpleExpertEscapes(all, NO_HEAD)).toEqual([
      { stage: 'source', reason: 'open_import' },
      { stage: 'review', reason: 'numeric_override' },
      { stage: 'readiness', reason: 'source_evidence_invalid' },
      { stage: 'readiness', reason: 'override_head_unproven' },
      { stage: 'readiness', reason: 'unknown_blocker' },
      { stage: 'readiness', reason: 'unknown_lineage_reason' },
    ]);
    expect(deriveSimpleExpertEscape(all, NO_HEAD)).toEqual({ stage: 'source', reason: 'open_import' });
  });

  it('only the readiness the server gave — a ready answer, no answer or a closed revision never escapes', () => {
    expect(deriveSimpleExpertEscapes(null)).toEqual([]);
    expect(deriveSimpleExpertEscapes(readiness([row('source_cell_value_contract_invalid')], true))).toEqual([]);
    for (const status of ['submitted', 'approved', 'rejected', 'superseded'] as const) {
      expect(deriveSimpleExpertEscapes({ ...readiness([row('source_cell_value_contract_invalid'), row(null)]), status }), status).toEqual([]);
    }
  });

  it('it decides from the blockers\' own codes and reason tokens: never from a filename, header, entity label or UI copy', () => {
    const blocked = readiness([{
      blocker: LINEAGE,
      detail: 'session=s1 source_record=source_cell_value_contract_invalid need_line=nl-numeric_override reason=source_quantity_override_mismatch',
    }]);
    // Words that LOOK like other reasons in other fields change nothing: only the `reason=` token decides.
    expect(deriveSimpleExpertEscapes(blocked)).toEqual([]);
  });

  it('is pure: the same readiness and chain give the same answer and are never mutated', () => {
    const input = readiness([row('source_cell_value_contract_invalid'), row('x'), row('source_quantity_override_binding_invalid'), OPEN]);
    const before = JSON.stringify([input, NUMERIC_HEAD]);
    expect(deriveSimpleExpertEscapes(input, NUMERIC_HEAD)).toEqual(deriveSimpleExpertEscapes(input, NUMERIC_HEAD));
    expect(JSON.stringify([input, NUMERIC_HEAD])).toBe(before);
  });

  it('the module adds no read, no write and no second vocabulary: it imports only the shared blocker vocabulary, the canonical lineage helpers and the reason / record parsers', () => {
    const src = read('src/features/central-needs/simple/simpleReadiness.ts');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['../CentralNeedsWorkspaceState', '../central-needs.lineage', '../central-needs.service', '../central-needs.service']);
    expect(src).not.toMatch(/supabase|\.rpc\(|fetch\(|window|document|localStorage/);
  });
});

describe('HC1.1 / HC1.2 — the copy tells the truth', () => {
  it('the numeric sentence covers every reason that shares it (not a plain number / missing / out of date / not a USABLE number — HC1.4); the unknown-lineage sentence promises nothing', () => {
    expect(T.cn2b_simple_expert_body_numeric_override.en).toMatch(/not a plain number/);
    expect(T.cn2b_simple_expert_body_numeric_override.en).toMatch(/missing, out of date or not a usable number/);
    expect(T.cn2b_simple_expert_body_numeric_override.en).toMatch(/non-negative number/);
    expect(T.cn2b_simple_expert_body_numeric_override.ar).toMatch(/ليست رقمًا صريحًا/);
    expect(T.cn2b_simple_expert_body_numeric_override.ar).toMatch(/مفقود أو لم يعد التصحيح الحالي أو ليس رقمًا صالحًا للاستخدام/);
    expect(T.cn2b_simple_expert_body_unknown_lineage.en).toMatch(/does not guarantee/);
    expect(T.cn2b_simple_expert_body_unknown_lineage.ar).toMatch(/لا يضمن/);
    for (const key of ['cn2b_simple_expert_body_source_evidence_invalid', 'cn2b_simple_expert_body_override_head_unproven', 'cn2b_simple_expert_body_unknown_lineage', 'cn2b_simple_expert_body_numeric_override'] as const) {
      expect(T[key].ar, key).toMatch(/[؀-ۿ]/);
      for (const lang of ['en', 'ar'] as const) expect(T[key][lang], `${key}.${lang}`).not.toMatch(/Advanced options|advanced options|خيارات متقدمة|الخيارات المتقدمة/);
    }
  });
});
