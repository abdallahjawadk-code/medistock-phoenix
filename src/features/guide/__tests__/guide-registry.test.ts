import { describe, expect, it } from 'vitest';
import { GUIDE_ANCHORS } from '../guide.anchors';
import { GUIDE_REGISTRY, findTour } from '../guide.registry';

/**
 * INTERACTIVE-GUIDE-IG1 — registry integrity.
 *
 * These are the invariants a growing registry breaks silently: a duplicated
 * id makes `findTour`/resume pick an arbitrary tour, a translated fragment in
 * an id makes the id move with the copy, and a half-translated step ships an
 * English sentence to an Arabic operator. Each is asserted against the real
 * registry rather than a fixture, so IG-2 and later waves inherit the checks.
 */

const ALL_STEPS = GUIDE_REGISTRY.tours.flatMap(tour =>
  tour.steps.map(step => ({ tourId: tour.id, step })),
);

/** Arabic block, plus the Latin words a stable id must never carry. */
const ARABIC = /[؀-ۿ]/;

describe('guide registry — identity', () => {
  it('is versioned and non-empty', () => {
    expect(GUIDE_REGISTRY.version).toBeGreaterThanOrEqual(1);
    expect(GUIDE_REGISTRY.tours.length).toBeGreaterThan(0);
  });

  it('has unique tour ids', () => {
    const ids = GUIDE_REGISTRY.tours.map(tour => tour.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique step ids within every tour', () => {
    for (const tour of GUIDE_REGISTRY.tours) {
      const ids = tour.steps.map(step => step.id);
      expect(new Set(ids).size, `duplicate step id in ${tour.id}`).toBe(ids.length);
    }
  });

  it('resolves a tour by id and returns null for an unknown one', () => {
    expect(findTour(GUIDE_REGISTRY.tours[0].id)?.id).toBe(GUIDE_REGISTRY.tours[0].id);
    expect(findTour('guide.tour.does-not-exist')).toBeNull();
  });

  it('never puts translated text inside an id', () => {
    for (const tour of GUIDE_REGISTRY.tours) {
      expect(ARABIC.test(tour.id), `${tour.id} carries Arabic`).toBe(false);
      expect(tour.id).toMatch(/^[a-z0-9.-]+$/);
      for (const step of tour.steps) {
        expect(ARABIC.test(step.id), `${step.id} carries Arabic`).toBe(false);
        expect(step.id).toMatch(/^[a-z0-9.-]+$/);
      }
    }
  });
});

describe('guide registry — content', () => {
  it('authors every tour and step in BOTH languages, with no empty side', () => {
    for (const tour of GUIDE_REGISTRY.tours) {
      for (const text of [tour.title, tour.description]) {
        expect(text.ar.trim().length).toBeGreaterThan(0);
        expect(text.en.trim().length).toBeGreaterThan(0);
      }
    }
    for (const { step } of ALL_STEPS) {
      for (const text of [step.title, step.body]) {
        expect(text.ar.trim().length, `${step.id}.ar`).toBeGreaterThan(0);
        expect(text.en.trim().length, `${step.id}.en`).toBeGreaterThan(0);
      }
    }
  });

  it('writes real Arabic in ar and never leaves the English string there', () => {
    for (const { step } of ALL_STEPS) {
      expect(ARABIC.test(step.title.ar), `${step.id} title.ar is not Arabic`).toBe(true);
      expect(ARABIC.test(step.body.ar), `${step.id} body.ar is not Arabic`).toBe(true);
      expect(step.title.ar).not.toBe(step.title.en);
      expect(step.body.ar).not.toBe(step.body.en);
    }
  });

  it('only targets anchors that exist in the declared vocabulary', () => {
    const known = new Set<string>(Object.values(GUIDE_ANCHORS));
    for (const { step } of ALL_STEPS) {
      for (const anchor of step.anchors) {
        expect(known.has(anchor), `${step.id} targets unknown anchor ${anchor}`).toBe(true);
      }
    }
  });

  it('exposes no internal identifier, RPC name or database term to the reader', () => {
    // The guide speaks to operators. An RPC name or a table name reaching a
    // step body would both confuse them and disclose internals.
    const forbidden = [/phoenix_[a-z_]+/i, /\brpc\b/i, /\bselect\b\s+\*/i, /supabase/i, /\buuid\b/i];
    for (const { step } of ALL_STEPS) {
      for (const value of [step.title.ar, step.title.en, step.body.ar, step.body.en]) {
        for (const pattern of forbidden) {
          expect(pattern.test(value), `${step.id} leaks "${pattern}"`).toBe(false);
        }
      }
    }
  });

  it('promises explanation, never a performed action', () => {
    // AD-04/AD-10: the guide must not read as if it did something. Both
    // languages carry the view-only statement at least once per tour.
    for (const tour of GUIDE_REGISTRY.tours) {
      const ar = tour.steps.map(step => step.body.ar).join(' ') + tour.description.ar;
      const en = tour.steps.map(step => step.body.en).join(' ') + tour.description.en;
      expect(ar).toMatch(/لا ينفّذ|ولا ينفّذ|لا يُنفَّذ|شرح/);
      expect(en.toLowerCase()).toMatch(/explanation only|performs no action|does not act|never acts/);
    }
  });
});

describe('guide registry — IG-1 scope boundary', () => {
  /**
   * IG-2 owns Quarantine and Suspended-from-Dispensing, behind pharmaceutical
   * copy approval. Shipping either concept early — in EITHER language, and
   * especially conflating the two — is the failure this guards. Delete this
   * test only together with the approved IG-2 content.
   */
  it('ships no Quarantine or Suspended-from-Dispensing content yet', () => {
    const forbidden = [
      /الحجر الصحي/, /موقوفة الصرف/, /إيقاف الصرف/,
      /quarantine/i, /suspended from dispensing/i, /dispensing suspension/i,
    ];
    for (const { step } of ALL_STEPS) {
      for (const value of [step.title.ar, step.title.en, step.body.ar, step.body.en]) {
        for (const pattern of forbidden) {
          expect(pattern.test(value), `${step.id} contains IG-2 content: ${pattern}`).toBe(false);
        }
      }
    }
  });

  it('stays one short orientation tour', () => {
    expect(GUIDE_REGISTRY.tours).toHaveLength(1);
    expect(GUIDE_REGISTRY.tours[0].id).toBe('guide.tour.orientation');
    expect(GUIDE_REGISTRY.tours[0].steps.length).toBeLessThanOrEqual(12);
  });
});
