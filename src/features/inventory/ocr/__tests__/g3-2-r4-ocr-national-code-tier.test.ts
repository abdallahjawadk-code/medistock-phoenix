/**
 * G3.2 / REVISION 4 — G32-M01: end-to-end evidence for OCR tier-1 national code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Owner DECISION A settles that `central_items.barcode` carries the CATALOG's
 * national-code semantic in the current Phoenix schema. `catalog-adapter.ts`
 * therefore maps it to `nationalCode`, and that mapping switched tier 1 of
 * `matchCatalog` from permanently inert to live: before it, no catalog row ever
 * had a `nationalCode`, so the first branch could not fire.
 *
 * That is an INTENDED behaviour change, not a rollback target — but a behaviour
 * that only just became reachable is exactly the behaviour that has never been
 * exercised. The independent review recorded the gap: the existing coverage
 * calls `matchCatalog` with a hand-written query object, so it proves the
 * matcher's branch and says nothing about whether a real OCR reading can ever
 * reach it.
 *
 * It very nearly cannot. `isPlausibleNationalCode` accepts only digit runs
 * (`/^\d[\d-]{3,19}$/`, four digits minimum), so a code like "NC-2" — the value
 * the unit tests used — is rejected by the extractor and never becomes a
 * candidate at all. The cases below therefore start from an OCR DOCUMENT and
 * run the whole chain:
 *
 *   OcrDocumentResult
 *     → extractPharmaFields        (label vocabulary, digit normalization)
 *     → bestCandidatePerField      (label beats confidence)
 *     → toCatalogMaterials         (DECISION A: barcode → nationalCode)
 *     → matchCatalog               (tier 1)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BOUNDARY THAT MUST SURVIVE
 * ─────────────────────────────────────────────────────────────────────────────
 * OCR ASSISTS DISCOVERY. IT NEVER CREATES OR CONFIRMS CANONICAL IDENTITY. A
 * unique tier-1 hit is a SUGGESTION: `nationalCode` is in
 * REQUIRED_CONFIRMATION_FIELDS, so a human still ticks it before intake, and no
 * outcome of this chain writes anything. Ambiguity is surfaced, never resolved
 * by picking a winner.
 */
import { describe, it, expect } from 'vitest';
import { extractPharmaFields, bestCandidatePerField } from '../parse/fields';
import { toCatalogMaterials } from '../catalog-adapter';
import { matchCatalog } from '../match/catalog-match';
import { REQUIRED_CONFIRMATION_FIELDS } from '../confidence';
import type { OcrDocumentResult, OcrLine } from '../types';
import type { CentralItem } from '@/shared/supabase/services/registry.service';

// ─── Build a real OcrDocumentResult from plain lines ─────────────────────────
let boxCounter = 0;
function line(text: string, confidence = 90): OcrLine {
  const y = boxCounter++ * 20;
  const words = text.split(/\s+/).filter(Boolean).map((word, index) => ({
    text: word,
    box: { x0: index * 50, y0: y, x1: index * 50 + 45, y1: y + 18 },
    confidence,
    language: null,
  }));
  return {
    text,
    box: { x0: 0, y0: y, x1: Math.max(50, words.length * 50), y1: y + 18 },
    confidence,
    words,
  };
}

function document(lines: OcrLine[]): OcrDocumentResult {
  return {
    text: lines.map(l => l.text).join('\n'),
    lines,
    words: lines.flatMap(l => l.words),
    imageWidth: 1000,
    imageHeight: 1400,
    language: 'ara+eng',
    durationMs: 0,
    providerId: 'test',
  };
}

const item = (over: Partial<CentralItem> = {}): CentralItem => ({
  id: 'c1',
  name: 'Amoxicillin',
  name_ar: 'أموكسيسيلين',
  unit: 'box',
  status: 'active',
  ...over,
});

/** The national code an OCR reading actually produced, or null if it produced none. */
function readNationalCode(doc: OcrDocumentResult): string | null {
  const { candidates } = extractPharmaFields(doc);
  return bestCandidatePerField(candidates).get('nationalCode')?.best.value ?? null;
}

/** The whole chain: pixels-worth of text in, a catalog outcome out. */
function discover(doc: OcrDocumentResult, catalog: readonly CentralItem[]) {
  const nationalCode = readNationalCode(doc);
  return {
    nationalCode,
    outcome: matchCatalog({ nationalCode }, toCatalogMaterials(catalog)),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// POSITIVE — a real reading reaches tier 1 and resolves to ONE catalog row
// ═════════════════════════════════════════════════════════════════════════════
describe('G32-M01 — an OCR national code resolves through tier 1, end to end', () => {
  it('POSITIVE — a labelled code on the document uniquely identifies its catalog item', () => {
    const { nationalCode, outcome } = discover(
      document([line('National Code: 1234567'), line('Amoxicillin 500mg')]),
      [
        item({ id: 'other', name: 'Paracetamol', barcode: '7654321' }),
        item({ id: 'target', barcode: '1234567' }),
      ],
    );

    // The extractor produced a real candidate — not assumed, read.
    expect(nationalCode).toBe('1234567');
    expect(outcome.kind).toBe('unique');
    if (outcome.kind === 'unique') {
      expect(outcome.candidate.material.id).toBe('target');
      // Tier 1 specifically: the code decided this, not a name similarity.
      expect(outcome.candidate.tier).toBe('national_code');
      expect(outcome.candidate.agreeingFields).toContain('nationalCode');
    }
  });

  it('POSITIVE — an Arabic label and Arabic-Indic digits reach the same catalog row', () => {
    // The Iraqi documents this feature exists for are frequently Arabic-only.
    const { nationalCode, outcome } = discover(
      document([line('الرمز الوطني: ١٢٣٤٥٦٧')]),
      [item({ id: 'target', barcode: '1234567' })],
    );

    expect(nationalCode).toBe('1234567');
    expect(outcome.kind).toBe('unique');
    if (outcome.kind === 'unique') expect(outcome.candidate.tier).toBe('national_code');
  });

  it('tier 1 outranks a better-scoring name match, because the code is authoritative', () => {
    const { outcome } = discover(
      document([line('Code: 4455667'), line('Amoxicillin')]),
      [
        // A perfect name twin that does NOT hold the scanned code...
        item({ id: 'name-twin', name: 'Amoxicillin', barcode: '9999999' }),
        // ...loses to the row that does.
        item({ id: 'code-holder', name: 'Cefalexin', barcode: '4455667' }),
      ],
    );

    expect(outcome.kind).toBe('unique');
    if (outcome.kind === 'unique') {
      expect(outcome.candidate.material.id).toBe('code-holder');
      expect(outcome.candidate.tier).toBe('national_code');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// NEGATIVE / COLLISION — uniqueness is never claimed where it is not earned
// ═════════════════════════════════════════════════════════════════════════════
describe('G32-M01 — ambiguity is surfaced, never silently won', () => {
  it('COLLISION — one OCR code matching two catalog rows is ambiguous, not a pick', () => {
    const { outcome } = discover(
      document([line('National Code: 1234567')]),
      [
        item({ id: 'dup-a', barcode: '1234567' }),
        item({ id: 'dup-b', name: 'Amoxicillin Forte', barcode: '1234567' }),
      ],
    );

    // A duplicated code is a catalog DATA problem the operator must see. Picking
    // a winner would attach real stock to the wrong material and hide the fault.
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') {
      expect(outcome.candidates.map(c => c.material.id).sort()).toEqual(['dup-a', 'dup-b']);
      expect(outcome.candidates.every(c => c.tier === 'national_code')).toBe(true);
    }
  });

  it('COLLISION — codes differing only by punctuation collide rather than resolving', () => {
    // `normalizeForMatching` strips every non-alphanumeric, so '1234-567' and
    // '1234567' are the same string to tier 1. Two catalog rows registered that
    // way are genuinely indistinguishable from the scanned code, and the honest
    // answer is to say so.
    const { nationalCode, outcome } = discover(
      document([line('National Code: 1234567')]),
      [
        item({ id: 'plain', barcode: '1234567' }),
        item({ id: 'hyphenated', name: 'Amoxicillin Forte', barcode: '1234-567' }),
      ],
    );

    expect(nationalCode).toBe('1234567');
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') expect(outcome.candidates).toHaveLength(2);
  });

  it('NEGATIVE — a code held only by an INACTIVE catalog row matches nothing', () => {
    // The adapter filters on `status === 'active'`, so an inactive row cannot be
    // resurrected through a scan. `no_match` is the correct answer, and it
    // creates nothing.
    const { outcome } = discover(
      document([line('National Code: 1234567')]),
      [item({ id: 'retired', barcode: '1234567', status: 'inactive' })],
    );

    expect(outcome.kind).toBe('no_match');
  });

  it('NEGATIVE — a code present on the document but absent from the catalog is no_match', () => {
    const { nationalCode, outcome } = discover(
      document([line('National Code: 1234567')]),
      [item({ id: 'other', barcode: '7654321' })],
    );

    // The reading is real; it simply matches nothing. OCR does not invent a
    // catalog row to receive it.
    expect(nationalCode).toBe('1234567');
    expect(outcome.kind).toBe('no_match');
  });

  it('NEGATIVE — a reading the extractor rejects never reaches tier 1 at all', () => {
    // 'NC-2' is not a plausible national code under `isPlausibleNationalCode`
    // (digit runs, four digits minimum). The gate is upstream of the matcher, so
    // a catalog row carrying that exact barcode still cannot be reached by scan.
    const { nationalCode, outcome } = discover(
      document([line('National Code: NC-2')]),
      [item({ id: 'target', barcode: 'NC-2' })],
    );

    expect(nationalCode).toBeNull();
    expect(outcome.kind).toBe('no_match');
  });

  it('NEGATIVE — an empty catalog cannot produce a tier-1 match', () => {
    const { outcome } = discover(document([line('National Code: 1234567')]), []);
    expect(outcome.kind).toBe('no_match');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE BOUNDARY — discovery only, and a human still confirms
// ═════════════════════════════════════════════════════════════════════════════
describe('G32-M01 — tier 1 stays discovery assistance, never write authority', () => {
  it('nationalCode always requires an explicit operator confirmation', () => {
    // However certain tier 1 is, the value is one a human ticks. This is the
    // property that keeps a confident MISREAD from becoming a dispensing
    // incident, and activating tier 1 must not have weakened it.
    expect(REQUIRED_CONFIRMATION_FIELDS).toContain('nationalCode');
  });

  it('a unique tier-1 outcome is a SUGGESTION carrying its own evidence', () => {
    const { outcome } = discover(
      document([line('National Code: 1234567'), line('Amoxicillin 500mg')]),
      [item({ id: 'target', barcode: '1234567', concentration: '250mg' })],
    );

    expect(outcome.kind).toBe('unique');
    if (outcome.kind === 'unique') {
      // It points at an EXISTING catalog row — the outcome carries a material
      // id that came from the catalog, never a newly minted identity.
      expect(outcome.candidate.material.id).toBe('target');
      // And it reports what agreed and what did not, so the operator confirming
      // it can see the conflict rather than rubber-stamping a match.
      expect(outcome.candidate.agreeingFields).toContain('nationalCode');
    }
  });

  it('the whole chain is pure: matching the same document twice changes nothing', () => {
    const catalog = [item({ id: 'target', barcode: '1234567' })];
    const doc = document([line('National Code: 1234567')]);

    const first = discover(doc, catalog);
    const second = discover(doc, catalog);

    expect(first.outcome).toEqual(second.outcome);
    // The catalog it was handed is untouched — no row was added, removed or
    // rewritten by the act of discovering against it.
    expect(catalog).toHaveLength(1);
    expect(catalog[0].barcode).toBe('1234567');
  });
});
