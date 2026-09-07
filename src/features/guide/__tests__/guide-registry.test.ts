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

describe('guide registry — IG-2 domain separation (AD-10)', () => {
  /**
   * The IG-1 guard that forbade this content outright is replaced, not
   * deleted: its real subject was never "no quarantine copy", it was that the
   * two domains must never be presented as interchangeable. That rule outlives
   * IG-1 and is what these assert now.
   */
  const quarantine = GUIDE_REGISTRY.tours.find(t => t.id === 'guide.tour.quarantine');
  const suspension = GUIDE_REGISTRY.tours.find(t => t.id === 'guide.tour.dispensing-suspension');

  const QUARANTINE_TERMS = [/الحجر الصحي/, /quarantine/i];
  const SUSPENSION_TERMS = [/موقوفة الصرف/, /موقوف الصرف/, /إيقاف الصرف/, /suspended from dispensing/i, /dispensing suspension/i, /suspension/i];

  it('ships both IG-2 tours, each named by its own canonical term', () => {
    expect(quarantine).toBeDefined();
    expect(suspension).toBeDefined();
    expect(quarantine?.title.ar).toBe('الحجر الصحي');
    expect(quarantine?.title.en).toBe('Quarantine');
    expect(suspension?.title.ar).toBe('موقوفة الصرف');
    expect(suspension?.title.en).toBe('Suspended from Dispensing');
  });

  it('mentions the other domain only to DENY that it is affected', () => {
    /**
     * The real rule, stated as a property rather than as a blocklist.
     *
     * A step may name the other domain — both tours close by saying the two
     * are separate, which is the point — but any sentence that names both must
     * be a denial. An affirmative cross-domain sentence ("releasing quarantine
     * lifts the suspension") is the conflation AD-10 forbids, and it is
     * exactly what a naive keyword blocklist would have flagged the correct
     * denial for instead.
     */
    // No `` here: JavaScript word boundaries are ASCII-based, so they do not
    // sit where a reader would expect them around Arabic letters and would
    // make every one of these alternatives silently unmatchable.
    const AR_NEGATION = /لا |ليس|غير |دون |منفصل/;
    const EN_NEGATION = /(^|[^a-z])(not|never|no|nothing|separate|neither)([^a-z]|$)/i;

    for (const { step } of ALL_STEPS) {
      const namesQuarantineAr = /الحجر/.test(step.body.ar);
      const namesSuspensionAr = /(موقوف|إيقاف)/.test(step.body.ar);
      if (namesQuarantineAr && namesSuspensionAr) {
        expect(AR_NEGATION.test(step.body.ar), `${step.id} ar names both domains without denying a link`).toBe(true);
      }

      const namesQuarantineEn = /quarantine/i.test(step.body.en);
      const namesSuspensionEn = /suspension|suspended/i.test(step.body.en);
      if (namesQuarantineEn && namesSuspensionEn) {
        expect(EN_NEGATION.test(step.body.en), `${step.id} en names both domains without denying a link`).toBe(true);
      }
    }
  });

  it('states the separation explicitly in BOTH tours', () => {
    const quarantineCopy = (quarantine?.steps ?? []).map(s => s.body.ar + s.body.en).join(' ');
    const suspensionCopy = (suspension?.steps ?? []).map(s => s.body.ar + s.body.en).join(' ');
    expect(SUSPENSION_TERMS.some(p => p.test(quarantineCopy))).toBe(true);
    expect(QUARANTINE_TERMS.some(p => p.test(suspensionCopy))).toBe(true);
  });

  it('promises no clinical or regulatory rule of its own', () => {
    // The guide explains what the program does. It must not invent an
    // approval, an authority, or a safety determination the program has no
    // concept of.
    const forbidden = [
      /يجب على الطبيب/, /موافقة اللجنة/, /وفق التعليمات الدوائية/, /الجهة الرقابية تلزم/,
      /doctor must/i, /committee approval/i, /regulation requires/i, /per pharmacopoeia/i,
    ];
    for (const { step } of ALL_STEPS) {
      for (const value of [step.title.ar, step.title.en, step.body.ar, step.body.en]) {
        for (const pattern of forbidden) {
          expect(pattern.test(value), `${step.id} asserts an external rule: ${pattern}`).toBe(false);
        }
      }
    }
  });

  it('keeps every tour short and each step to one idea', () => {
    expect(GUIDE_REGISTRY.tours.length).toBeLessThanOrEqual(4);
    for (const tour of GUIDE_REGISTRY.tours) {
      expect(tour.steps.length, `${tour.id} is too long`).toBeLessThanOrEqual(12);
      for (const step of tour.steps) {
        expect(step.body.ar.length, `${step.id} ar is too long`).toBeLessThanOrEqual(340);
        expect(step.body.en.length, `${step.id} en is too long`).toBeLessThanOrEqual(340);
      }
    }
  });

  it('scopes both IG-2 tours to their own screen, tab and capability', () => {
    for (const tour of [quarantine, suspension]) {
      expect(tour?.screen).toBe(3);
      expect(tour?.tab).toBeDefined();
      expect(tour?.requiresCapabilities?.length ?? 0).toBeGreaterThan(0);
      for (const step of tour?.steps ?? []) {
        expect(step.tab, `${step.id} must name its tab`).toBe(tour?.tab);
      }
    }
    expect(quarantine?.tab).not.toBe(suspension?.tab);
  });

  it('gates every action step on a scoped capability, never on a global key', () => {
    const actionSteps = ['quarantine.release', 'quarantine.destroy', 'suspension.create', 'suspension.lift'];
    for (const id of actionSteps) {
      const step = ALL_STEPS.find(entry => entry.step.id === id)?.step;
      expect(step, `${id} is missing`).toBeDefined();
      expect(step?.requiresCapabilities?.length ?? 0, `${id} must require a capability`).toBeGreaterThan(0);
      // requiresPermissions reads the GLOBAL key set and cannot express a
      // per-warehouse or per-outlet decision, so an action step must not lean
      // on it here.
      expect(step?.requiresPermissions, `${id} must not use a global key`).toBeUndefined();
    }
  });

  it('tells the operator to act from the real control, not from the guide', () => {
    for (const id of ['quarantine.release', 'suspension.create']) {
      const step = ALL_STEPS.find(entry => entry.step.id === id)?.step;
      expect(step?.body.ar).toMatch(/أغلق الدليل/);
      expect(step?.body.en.toLowerCase()).toMatch(/close the guide/);
    }
  });
});
