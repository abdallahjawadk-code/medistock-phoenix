/**
 * C5 (M217 companion) — the pure client rules.
 *
 *   §7   the two M217 blockers are registered in their frozen stages and are
 *        session-attributable; Simple Mode gives §7.1 and every §7.2 reason
 *        its own sentence, read from `reason=`, and fails closed otherwise;
 *   §14  a head is the FIRST server row of an exact source record;
 *   §15  the two safe prefill shapes, the exact server grammar (untrimmed,
 *        <= 256) and the numeric-override preview;
 *   §17  status routing happens BEFORE blocker projection, for all five
 *        statuses, including a submitted/approved revision WITH blockers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { T } from '@/shared/i18n/strings';
import {
  BLOCKERS_BY_STAGE, KNOWN_BLOCKERS, deriveCentralNeedsStageProgress, recommendedCentralNeedsStage,
  stageProgressLabelKey, summarizeSessionBlockers,
} from '../CentralNeedsWorkspaceState';
import {
  canonicalDecimalText, isCanonicalQuantity, isNumericOverride, numericOverrideLexeme, numericOverridePreview, overrideHeads,
  prefillQuantity,
} from '../central-needs.lineage';
import { freshestRevisionStatus, isStatusAheadOfRegistry } from '../central-needs.revision-context';
import { summarizeSimpleReadiness } from '../simple/simpleReadiness';
import type { FieldOverride, ReviewBlocker, ReviewReadiness, RevisionStatus } from '../central-needs.service';

const REASONS = [
  'source_cell_value_contract_invalid',
  'source_quantity_requires_explicit_numeric_override',
  'source_quantity_override_binding_invalid',
  'source_quantity_override_value_invalid',
  'source_quantity_override_mismatch',
] as const;

const invalidEvidence = (session = 's1'): ReviewBlocker => ({
  blocker: 'source_cell_value_contract_invalid',
  detail: `session=${session} source_record=r1 reason=invalid_evidence`,
});
const unsafeLineage = (reason: string, session = 's1'): ReviewBlocker => ({
  blocker: 'need_line_quantity_lineage_unsafe',
  detail: `session=${session} source_record=r1 need_line=n1 reason=${reason}`,
});
const readiness = (status: RevisionStatus, blockers: ReviewBlocker[], ready = blockers.length === 0): ReviewReadiness => ({
  planRevisionId: 'rev-1', status, ready, blockers,
});
const progressOf = (status: RevisionStatus, blockers: ReviewBlocker[]) => deriveCentralNeedsStageProgress({
  hasRevision: true, revisionStatus: status, revisionDataReady: true, refreshing: false, readiness: readiness(status, blockers),
});

const override = (id: string, sourceRecordId: string, finalValue: unknown, over: Partial<FieldOverride> = {}): FieldOverride => ({
  id, sourceRecordId, targetEntity: 'sheet:0:row:5', fieldName: 'qty', previousValue: null, finalValue,
  overrideReason: 'recount', overrideNote: null, createdAt: '2026-09-26T10:00:00+00:00', ...over,
});

// ============================================================================
// §7 — vocabulary, stage and session attribution.
// ============================================================================
describe('C5 §7 — the two M217 blockers are registered, staged and attributable', () => {
  it('source_cell_value_contract_invalid is a SOURCE blocker; need_line_quantity_lineage_unsafe a NEED-LINES blocker', () => {
    expect(BLOCKERS_BY_STAGE.source.has('source_cell_value_contract_invalid')).toBe(true);
    expect(BLOCKERS_BY_STAGE['need-lines'].has('need_line_quantity_lineage_unsafe')).toBe(true);
    for (const stage of ['review', 'beneficiaries', 'need-lines'] as const) {
      expect(BLOCKERS_BY_STAGE[stage].has('source_cell_value_contract_invalid'), stage).toBe(false);
    }
    expect(KNOWN_BLOCKERS.has('source_cell_value_contract_invalid')).toBe(true);
    expect(KNOWN_BLOCKERS.has('need_line_quantity_lineage_unsafe')).toBe(true);
  });

  it('projects §7.1 onto Source (later stages wait) and §7.2 onto Need lines — never "unknown"', () => {
    const source = progressOf('draft', [invalidEvidence()]);
    expect(source.source).toBe('needs-action');
    expect([source.review, source.beneficiaries, source['need-lines']]).toEqual(['waiting', 'waiting', 'waiting']);
    expect(recommendedCentralNeedsStage(true, source, 'draft')).toBe('source');

    const lines = progressOf('draft', [unsafeLineage('source_quantity_override_mismatch')]);
    expect([lines.source, lines.review, lines.beneficiaries]).toEqual(['complete', 'complete', 'complete']);
    expect(lines['need-lines']).toBe('needs-action');
    expect(recommendedCentralNeedsStage(true, lines, 'draft')).toBe('need-lines');
  });

  it('attributes both to their session — a linked invalid cell counts under both, as §7.2 intends', () => {
    const summary = summarizeSessionBlockers(readiness('draft', [
      invalidEvidence('s1'), unsafeLineage('source_cell_value_contract_invalid', 's1'), unsafeLineage('source_quantity_override_mismatch', 's2'),
    ]));
    expect(summary.bySession.get('s1')).toBe(2);
    expect(summary.bySession.get('s2')).toBe(1);
    expect(summary.unattributed).toBe(0);
  });
});

// ============================================================================
// §17 — status routing before blocker projection.
// ============================================================================
describe('C5 §17 — every non-DRAFT status lands on readiness, whatever the blockers', () => {
  const editBlockers = [
    { blocker: 'target_entity_without_disposition', detail: 'session=s1 target_entity=r1' },
    unsafeLineage('source_quantity_override_binding_invalid'),
  ];

  it.each(['submitted', 'approved', 'rejected', 'superseded'] as const)(
    '%s WITH blockers: readiness landing, stages closed, no edit stage recommended', (status) => {
      const progress = progressOf(status, editBlockers);
      expect(progress.readiness).toBe(status);
      for (const stage of ['source', 'review', 'beneficiaries', 'need-lines'] as const) {
        expect(progress[stage], stage).toBe('closed');
      }
      expect(Object.values(progress)).not.toContain('needs-action');
      expect(recommendedCentralNeedsStage(true, progress, status)).toBe('readiness');
      // The progress alone already routes there, so a caller that omits the status cannot land on an edit stage.
      expect(recommendedCentralNeedsStage(true, progress)).toBe('readiness');
    });

  it.each(['submitted', 'approved', 'rejected', 'superseded'] as const)('%s without blockers also lands on readiness', (status) => {
    const progress = progressOf(status, []);
    expect(progress.readiness).toBe(status);
    expect(recommendedCentralNeedsStage(true, progress, status)).toBe('readiness');
  });

  it('routes by status even before readiness has loaded', () => {
    const progress = deriveCentralNeedsStageProgress({
      hasRevision: true, revisionStatus: 'approved', revisionDataReady: false, refreshing: true, readiness: null,
    });
    expect(progress.readiness).toBe('approved');
    expect(recommendedCentralNeedsStage(true, progress, 'approved')).toBe('readiness');
  });

  it('the status argument wins over a stale draft-shaped projection', () => {
    const draftShaped = progressOf('draft', editBlockers);
    expect(recommendedCentralNeedsStage(true, draftShaped)).toBe('review');
    expect(recommendedCentralNeedsStage(true, draftShaped, 'submitted')).toBe('readiness');
  });

  it('a DRAFT with blockers still goes to its first actionable stage', () => {
    const progress = progressOf('draft', editBlockers);
    expect(progress.review).toBe('needs-action');
    expect(progress.readiness).toBe('not-ready');
    expect(recommendedCentralNeedsStage(true, progress, 'draft')).toBe('review');
  });

  // UI-F3 — the lifecycle only moves forward, so the status further along it
  // is the fresher fact, whichever read returned it.
  it.each([
    ['draft', 'submitted', 'submitted'],
    ['draft', 'approved', 'approved'],
    ['submitted', 'approved', 'approved'],
    ['submitted', 'rejected', 'rejected'],
    ['approved', 'superseded', 'superseded'],
    ['approved', 'submitted', 'approved'], // a readiness read older than the registry
    ['superseded', 'draft', 'superseded'],
    ['draft', 'draft', 'draft'],
    ['draft', null, 'draft'],
    ['draft', 'bogus', 'draft'],
  ] as const)('registry %s + observed %s -> freshest %s', (registry, observed, expected) => {
    expect(freshestRevisionStatus(registry, observed)).toBe(expected);
  });

  it('never yields "draft" from two different statuses, and nothing without a registry row', () => {
    const all: RevisionStatus[] = ['draft', 'submitted', 'approved', 'rejected', 'superseded'];
    for (const a of all) {
      for (const b of all) {
        if (a !== b) expect(freshestRevisionStatus(a, b), `${a}/${b}`).not.toBe('draft');
      }
    }
    expect(freshestRevisionStatus(null, 'submitted')).toBeNull();
    expect(isStatusAheadOfRegistry('draft', 'submitted')).toBe(true);
    expect(isStatusAheadOfRegistry('approved', 'submitted')).toBe(false);
    expect(isStatusAheadOfRegistry('draft', 'draft')).toBe(false);
    expect(isStatusAheadOfRegistry(null, 'submitted')).toBe(false);
  });

  it('routes by the FRESHEST status: a registry "draft" with a readiness "submitted" lands on readiness', () => {
    const status = freshestRevisionStatus('draft', 'submitted');
    const progress = progressOf(status!, editBlockers);
    expect(recommendedCentralNeedsStage(true, progress, status)).toBe('readiness');
    for (const stage of ['source', 'review', 'beneficiaries', 'need-lines'] as const) expect(progress[stage]).toBe('closed');
  });

  it('labels every new progress value in both languages', () => {
    for (const p of ['rejected', 'superseded', 'closed', 'needs-action', 'not-ready'] as const) {
      const key = stageProgressLabelKey(p);
      expect(T[key], key).toBeDefined();
      expect(T[key].ar.trim(), key).not.toBe('');
      expect(T[key].en.trim(), key).not.toBe('');
      expect(T[key].ar, key).not.toBe(T[key].en);
    }
    expect(stageProgressLabelKey('needs-action')).toBe('cn2b_stage_state_needs_action');
  });
});

// ============================================================================
// §7 — Simple Mode copy.
// ============================================================================
describe('C5 §7 — Simple Mode explains §7.1 and every §7.2 reason explicitly', () => {
  it('§7.1 gets its own sentence, not the generic "files not processed" one', () => {
    const s = summarizeSimpleReadiness(readiness('draft', [invalidEvidence()]))!;
    expect(s.messageKeys).toEqual(['cn2b_simple_blocker_source_evidence_invalid']);
    expect(s.countsByCategory.source).toBe(1);
    expect(s.hasUnknownBlocker).toBe(false);
    // With another source blocker present, both sentences are shown.
    const both = summarizeSimpleReadiness(readiness('draft', [
      { blocker: 'import_session_still_open', detail: 'session=s2' }, invalidEvidence(),
    ]))!;
    expect(both.messageKeys).toEqual(['cn2b_simple_blocker_source', 'cn2b_simple_blocker_source_evidence_invalid']);
  });

  it.each(REASONS)('reason %s maps to its own explicit sentence', (reason) => {
    const s = summarizeSimpleReadiness(readiness('draft', [unsafeLineage(reason)]))!;
    expect(s.messageKeys).toEqual([`cn2b_simple_blocker_lineage_${reason}`]);
    expect(s.countsByCategory.need_line).toBe(1);
  });

  it('lists each distinct reason once, in the helper order, after the generic need-line sentence', () => {
    const s = summarizeSimpleReadiness(readiness('draft', [
      unsafeLineage('source_quantity_override_mismatch'),
      { blocker: 'mapped_target_entity_without_need_line', detail: 'session=s1 target_entity=r9' },
      unsafeLineage('source_quantity_requires_explicit_numeric_override'),
      unsafeLineage('source_quantity_override_mismatch', 's2'),
      { blocker: 'beneficiary_column_review_required', detail: 'session=s1 sheet=0 column=5' },
    ]))!;
    expect(s.messageKeys).toEqual([
      'cn2b_simple_blocker_beneficiary',
      'cn2b_simple_blocker_need_line',
      'cn2b_simple_blocker_lineage_source_quantity_requires_explicit_numeric_override',
      'cn2b_simple_blocker_lineage_source_quantity_override_mismatch',
    ]);
    expect(s.countsByCategory.need_line).toBe(4);
  });

  it('fails closed on a missing or unrecognized reason — never a guessed sentence', () => {
    for (const detail of [null, 'session=s1 source_record=r1 need_line=n1', 'session=s1 reason=some_future_reason']) {
      const s = summarizeSimpleReadiness(readiness('draft', [{ blocker: 'need_line_quantity_lineage_unsafe', detail }]))!;
      expect(s.messageKeys, String(detail)).toEqual(['cn2b_simple_blocker_lineage_reason_unrecognized']);
    }
  });

  it('every Simple C5 sentence exists in both languages, distinct and non-empty', () => {
    const keys = [
      'cn2b_simple_blocker_source_evidence_invalid', 'cn2b_simple_blocker_lineage_reason_unrecognized',
      ...REASONS.map((r) => `cn2b_simple_blocker_lineage_${r}`),
      'cn2b_simple_closed_submitted', 'cn2b_simple_closed_rejected', 'cn2b_simple_closed_superseded',
    ];
    for (const key of keys) {
      expect(T[key], key).toBeDefined();
      expect(T[key].ar.trim(), key).not.toBe('');
      expect(T[key].en.trim(), key).not.toBe('');
      expect(T[key].ar, key).not.toBe(T[key].en);
    }
    // §7.1: controlled replacement/re-import, never "repaired in place".
    expect(T.cn2b_simple_blocker_source_evidence_invalid.en).toMatch(/not fixed in place/);
    expect(T.cn2b_simple_blocker_source_evidence_invalid.en).toMatch(/re-import/);
    // §7.2 stale binding: re-pin the current numeric head, or delete and re-designate.
    expect(T.cn2b_simple_blocker_lineage_source_quantity_override_binding_invalid.en).toMatch(/re-pin the current numeric/);
    expect(T.cn2b_simple_blocker_lineage_source_quantity_override_binding_invalid.en).toMatch(/delete and re-designate/);
  });
});

describe('C5 §7/§14/§17 — Advanced labels and refusal copy exist in both languages', () => {
  const ADVANCED_KEYS = [
    'cn2b_blocker_source_cell_value_contract_invalid',
    'cn2b_blocker_need_line_quantity_lineage_unsafe',
    ...REASONS.map((r) => `cn2b_blocker_need_line_quantity_lineage_unsafe__${r}`),
    'cn2b_err_source_cell_value_contract_invalid',
    'cn2b_err_need_line_quantity_lineage_unsafe',
    ...REASONS.map((r) => `cn2b_err_need_line_quantity_lineage_unsafe__${r}`),
    'cn2b_err_designated_quantity_not_canonical',
    'cn2b_err_source_link_requires_designated_quantity',
    'cn2b_err_central_needs_approval_eligibility_changed',
    ...['not_found', 'not_care_institution', 'inactive', 'archived', 'not_owned', 'not_active']
      .map((r) => `cn2b_err_central_needs_approval_eligibility_changed__${r}`),
    'cn2b_err_central_needs_approval_gate_missing',
    'cn2b_err_beneficiary_organization_archived',
    'cn2b_err_plan_revision_not_submitted',
    'cn2b_err_central_needs_request_failed',
    'cn2b_err_central_needs_action_unavailable',
    'cn2b_err_retryable_contention',
    'cn2b_err_field_overrides_read_inconsistent',
    'cn2b_terminal_submitted', 'cn2b_terminal_approved', 'cn2b_terminal_rejected', 'cn2b_terminal_superseded',
    'cn2b_terminal_blockers_informational',
    // UI-F1/F2/F5 — partial saves, unconfirmed outcomes, a confirmed action's failed re-read, the chain reload.
    'cn2b_nl_partial_saved', 'cn2b_bulk_partial_saved', 'cn2b_nl_error_title_unconfirmed',
    'cn2b_err_state_reread_failed', 'cn2b_overrides_reload', 'cn2b_err_field_overrides_read_failed',
  ];

  it('defines every key with distinct, non-empty Arabic and English', () => {
    for (const key of ADVANCED_KEYS) {
      expect(T[key], key).toBeDefined();
      expect(T[key].ar.trim(), key).not.toBe('');
      expect(T[key].en.trim(), key).not.toBe('');
      expect(T[key].ar, key).not.toBe(T[key].en);
    }
    // Reason-specific sentences really are different from each other and from the generic one.
    const lineage = REASONS.map((r) => T[`cn2b_err_need_line_quantity_lineage_unsafe__${r}`].en);
    expect(new Set([...lineage, T.cn2b_err_need_line_quantity_lineage_unsafe.en]).size).toBe(REASONS.length + 1);
  });

  // UI-F2 — each scope of a confirmation is its own transaction, and a
  // transport failure's outcome is unknown: no copy that can follow a
  // part-way refusal or an unknown outcome may claim that NOTHING was saved.
  it('never claims "nothing was saved/changed" where writes may have committed or the outcome is unknown', () => {
    const keys = [
      'cn2b_err_need_line_quantity_lineage_unsafe',
      ...REASONS.map((r) => `cn2b_err_need_line_quantity_lineage_unsafe__${r}`),
      'cn2b_err_central_needs_request_failed',
      'cn2b_err_retryable_contention',
    ];
    for (const key of keys) {
      expect(T[key].en, key).not.toMatch(/nothing (was|has been) (saved|changed|written)/i);
      expect(T[key].ar, key).not.toMatch(/لم يُحفظ شيء|لم تُغيّر هذه الشاشة شيئًا|لم يتغيّر شيء/);
    }
    // An unknown outcome says so, in both languages.
    expect(T.cn2b_err_central_needs_request_failed.en).toMatch(/could not be confirmed/);
    expect(T.cn2b_err_central_needs_request_failed.ar).toMatch(/لم يمكن التأكد/);
    // The partial-save sentences carry both counts.
    for (const key of ['cn2b_nl_partial_saved', 'cn2b_bulk_partial_saved']) {
      for (const lang of ['ar', 'en'] as const) {
        expect(T[key][lang], `${key}.${lang}`).toContain('__K__');
        expect(T[key][lang], `${key}.${lang}`).toContain('__N__');
      }
    }
  });

  it('keeps §7.1 re-import wording out of the key families the C4 static test scans', () => {
    const strings = readFileSync(join(__dirname, '../../../shared/i18n/strings.ts'), 'utf8');
    const c4 = strings.split('\n').filter((l) => /^\s+(cn4_|cn2b_err_beneficiary_region|cn2b_blocker_beneficiary_region)/.test(l));
    for (const line of c4) expect(line).not.toMatch(/re-?import|أعد (رفع|استيراد)/i);
  });
});

// ============================================================================
// §14/§15 — heads, prefill, grammar and the numeric preview.
// ============================================================================
describe('C5 §14 — a head is the FIRST server row of its exact source record', () => {
  it('never re-sorts and never keys by row/header text', () => {
    // Server order (created_at DESC, id DESC). Two records share row + header text.
    const chain = [
      override('ovr-new-a', 'rec-a', 30, { createdAt: '2026-09-26T10:00:02+00:00' }),
      override('ovr-b', 'rec-b', 99, { createdAt: '2026-09-26T10:00:03+00:00' }), // later timestamp, later in list: NOT re-sorted
      override('ovr-old-a', 'rec-a', 20, { createdAt: '2026-09-26T10:00:01+00:00' }),
    ];
    const heads = overrideHeads(chain);
    expect(heads.get('rec-a')?.id).toBe('ovr-new-a');
    expect(heads.get('rec-b')?.id).toBe('ovr-b');
    expect(heads.size).toBe(2);
  });
});

describe('C5 §15 — prefill subset A/B only', () => {
  it.each([
    [{ valueType: 'number', value: 120.5 }, '120.5'],
    [{ valueType: 'number', value: 0 }, '0'],
    [{ valueType: 'string', value: '25' }, '25'],
    [{ valueType: 'string', value: '0' }, '0'],
  ])('suggests %j as %s', (sourceValues, expected) => {
    expect(prefillQuantity(sourceValues)).toBe(expected);
  });

  it.each([
    [{ value: 120.5 }],                                   // no valueType: not the parser envelope
    [{ valueType: 'number', value: -5 }],
    [{ valueType: 'number', value: 1e21 }],               // String() is '1e+21'
    [{ valueType: 'number', value: Number.NaN }],
    [{ valueType: 'number', value: '25' }],               // type and value disagree
    [{ valueType: 'string', value: '25.5' }],             // rule B is whole numbers only
    [{ valueType: 'string', value: '007' }],
    [{ valueType: 'string', value: ' 25' }],
    [{ valueType: 'string', value: '25 ' }],
    [{ valueType: 'string', value: '1'.repeat(257) }],
    [{ valueType: 'string', value: 'NaN' }],
    [{ valueType: 'boolean', value: true }],
    [{ valueType: 'date', value: 45000 }],
    [{ valueType: 'error', value: '#VALUE!' }],
  ])('suggests nothing for %j', (sourceValues) => {
    expect(prefillQuantity(sourceValues)).toBeNull();
  });

  it('allows a whole-number text of exactly 256 characters', () => {
    expect(prefillQuantity({ valueType: 'string', value: `1${'0'.repeat(255)}` })).toBe(`1${'0'.repeat(255)}`);
  });
});

describe('C5 §10/§15 — typed quantities use the exact server grammar, untrimmed', () => {
  it.each(['007', ' 25', '25 ', '1e3', '-5', '+5', '.5', '5.', '1,000', '0x10', '', '١٢', `1${'0'.repeat(256)}`])(
    'refuses %j', (text) => expect(isCanonicalQuantity(text)).toBe(false));

  it.each(['0', '25', '25.50', '0.0001', '12345678901234567.891', `1${'0'.repeat(255)}`])(
    'accepts %j', (text) => expect(isCanonicalQuantity(text)).toBe(true));
});

describe('C5 §15 — only a JSON-number override is a numeric override', () => {
  it('a text override never counts, even when its text looks numeric', () => {
    expect(isNumericOverride(override('o', 'r', '25'))).toBe(false);
    expect(numericOverrideLexeme(override('o', 'r', '25'))).toBeNull();
    expect(isNumericOverride(override('o', 'r', null))).toBe(false);
    expect(isNumericOverride(override('o', 'r', -1))).toBe(false);
    expect(isNumericOverride(override('o', 'r', 25))).toBe(true);
  });

  it('prefers the exact final_value::text to the JSON.parse-rounded number', () => {
    const big = override('o', 'r', 12345678901234567.891, { finalValueText: '12345678901234567.891' });
    expect(String(big.finalValue)).not.toBe('12345678901234567.891');
    expect(numericOverrideLexeme(big)).toBe('12345678901234567.891');
    expect(numericOverrideLexeme(override('o', 'r', 150))).toBe('150');
  });
});

describe('C5 §15 — a numeric override previews the JSON number it will store', () => {
  it('previews JSON.stringify(Number(raw)) and flags a value JavaScript cannot hold', () => {
    expect(numericOverridePreview('12')).toEqual({ ok: true, value: 12, json: '12', exact: true });
    expect(numericOverridePreview('1.50')).toEqual({ ok: true, value: 1.5, json: '1.5', exact: true });
    const big = numericOverridePreview('12345678901234567.891');
    expect(big).toMatchObject({ ok: true, json: '12345678901234568', exact: false });
  });

  // UI-F8 — JSON.stringify prints some EXACT values in exponent form; jsonb
  // stores them as exactly the typed decimal, so they are exact.
  it.each([
    ['0.0000001', '1e-7'],
    ['0.00000012345', '1.2345e-7'],
    ['0.000000100', '1e-7'],
    ['1000000000000000000000', '1e+21'],
    ['1230000000000000000000000.0', '1.23e+24'],
  ])('%j previews as %s and IS exact', (raw, json) => {
    expect(numericOverridePreview(raw)).toEqual({ ok: true, value: Number(raw), json, exact: true });
  });

  it.each([
    ['1234567890123456789012', '1.2345678901234568e+21'],
    ['0.00000012345678901234567', '1.2345678901234566e-7'],
  ])('%j previews as %s and is NOT exact (rounded in exponent form)', (raw, json) => {
    expect(numericOverridePreview(raw)).toMatchObject({ ok: true, json, exact: false });
  });

  it('canonicalDecimalText expands exponents exactly and normalizes scale', () => {
    expect(canonicalDecimalText('1e-7')).toBe('0.0000001');
    expect(canonicalDecimalText('1.2345e-7')).toBe('0.00000012345');
    expect(canonicalDecimalText('1e+21')).toBe('1000000000000000000000');
    expect(canonicalDecimalText('1.5e2')).toBe('150');
    expect(canonicalDecimalText('12.50')).toBe('12.5');
    expect(canonicalDecimalText('0.0')).toBe('0');
    expect(canonicalDecimalText('0')).toBe('0');
    expect(canonicalDecimalText('-0')).toBe('0');
    expect(canonicalDecimalText('-2.50')).toBe('-2.5');
    for (const bad of ['', 'NaN', 'Infinity', '1e', '.5', '1e99999', '0x10']) {
      expect(canonicalDecimalText(bad), bad).toBeNull();
    }
  });

  it.each(['007', ' 25', '1e3', '-5', '.5', '5.', '1'.repeat(257)])('refuses %j before any preview', (raw) => {
    expect(numericOverridePreview(raw)).toEqual({ ok: false, reason: 'override_number_not_canonical' });
  });

  it('an empty entry is "number required"', () => {
    expect(numericOverridePreview('')).toEqual({ ok: false, reason: 'number_required' });
  });
});
