import { describe, expect, it } from 'vitest';
import { GUIDE_REGISTRY, findTour } from '../guide.registry';
import { permittedSteps, permittedTours, type GuideAudience } from '../guide.permissions';

/**
 * INTERACTIVE-GUIDE-IG3 — registry-level eligibility for the eight lifecycle
 * tours (intake, stock, ledger, incoming, dispatch, returns, return
 * exceptions, corrections).
 *
 * Unit-level, against the real registry and the real filtering functions —
 * no rendering. `guide-ig3-panels.runtime.test.tsx` covers the same tours
 * over the REAL InventoryCenterScreen and its child panels; this file is
 * cheaper and proves the surface/presence/permission WIRING in the registry
 * itself is correct, the same division of labour `guide-permissions.test.ts`
 * already uses for the orientation tour.
 */

const INVENTORY_SCREEN = 3;

function audience(over: Partial<GuideAudience> = {}): GuideAudience {
  return {
    role: 'central_warehouse_manager',
    permissions: new Set<string>(),
    surface: { screen: INVENTORY_SCREEN, tab: 'intake' },
    capabilities: {},
    presence: {},
    ...over,
  };
}

/**
 * `guide.tour.return-exceptions` is deliberately absent from this list — see
 * the dedicated "entire return-exceptions tour is held" describe block below
 * for its own regression coverage. It is NOT one of the offered tours.
 */
const TOUR_IDS = [
  'guide.tour.intake', 'guide.tour.stock', 'guide.tour.ledger',
  'guide.tour.incoming', 'guide.tour.dispatch', 'guide.tour.returns',
  'guide.tour.corrections',
] as const;

const TAB_OF: Record<(typeof TOUR_IDS)[number], string> = {
  'guide.tour.intake': 'intake',
  'guide.tour.stock': 'stock',
  'guide.tour.ledger': 'ledger',
  'guide.tour.incoming': 'incoming',
  'guide.tour.dispatch': 'dispatch',
  'guide.tour.returns': 'returns',
  'guide.tour.corrections': 'corrections',
};

/** The two tours gated on a real, global effective permission (see below). */
const REQUIRED_PERMISSION: Partial<Record<(typeof TOUR_IDS)[number], string>> = {
  'guide.tour.incoming': 'warehouse_transfer.receive',
  'guide.tour.dispatch': 'warehouse_dispatch.create',
};

/**
 * Enough presence for every SURVIVING row-level step across all eight tours
 * to render. Deliberately includes no key for a held step's own former
 * anchor (`stock.rowMovementAction`, `returns.rowActions`,
 * `returnExceptions.rowActions`, `corrections.rowActions` no longer exist in
 * `GUIDE_PRESENCE` at all — see guide.registry.ts) — an audience object may
 * still SET such a key (it is a plain string map, not type-checked against
 * `GUIDE_PRESENCE`), which is exactly what the held-step tests below use to
 * prove that resurrecting the old presence key does nothing.
 */
const ALL_PRESENCE: Record<string, boolean> = {
  'inventory.intake.blockedRegion': false, 'inventory.intake.formRegion': true,
  'inventory.stock.region': true, 'inventory.stock.row': true,
  'inventory.ledger.region': true,
  'inventory.incoming.region': true, 'inventory.incoming.rowActions': true,
  'inventory.dispatch.region': true, 'inventory.dispatch.rowActions': true,
  'inventory.returns.region': true,
  'inventory.corrections.region': true,
};

/**
 * The presence keys that USED to gate a held action step, before this
 * correction. Kept here, spelled out by hand (not imported — they are gone
 * from `GUIDE_PRESENCE`), specifically to prove that setting them to `true`
 * — simulating a stale caller who still thinks presence is the gate —
 * resurrects nothing, because the step objects themselves no longer exist.
 */
const FORMER_ACTION_PRESENCE_KEYS: Record<string, boolean> = {
  'inventory.intake.formRegion': true,
  'inventory.stock.rowMovementAction': true,
  'inventory.returns.rowActions': true,
  'inventory.corrections.rowActions': true,
};

describe('guide IG-3 — all seven offered tours exist, once each, correctly scoped', () => {
  it('registers exactly one tour per tab, findable by id', () => {
    for (const id of TOUR_IDS) {
      const tour = findTour(id);
      expect(tour, `${id} missing from the registry`).not.toBeNull();
      expect(tour?.screen).toBe(INVENTORY_SCREEN);
      expect(tour?.tab).toBe(TAB_OF[id]);
    }
  });

  it('is offered only on its OWN tab, never on a sibling tab', () => {
    for (const id of TOUR_IDS) {
      const perm = REQUIRED_PERMISSION[id];
      const onOwnTab = permittedTours(GUIDE_REGISTRY.tours, audience({
        surface: { screen: INVENTORY_SCREEN, tab: TAB_OF[id] },
        permissions: new Set(perm ? [perm] : []),
        presence: ALL_PRESENCE,
      }));
      expect(onOwnTab.some(e => e.tour.id === id), `${id} not offered on ${TAB_OF[id]}`).toBe(true);

      const onOtherTab = permittedTours(GUIDE_REGISTRY.tours, audience({ surface: { screen: INVENTORY_SCREEN, tab: 'stock' === TAB_OF[id] ? 'ledger' : 'stock' } }));
      expect(onOtherTab.some(e => e.tour.id === id), `${id} leaked onto a different tab`).toBe(false);
    }
  });

  it('is offered on no other screen, whatever the tab', () => {
    for (const id of TOUR_IDS) {
      const wrongScreen = permittedTours(GUIDE_REGISTRY.tours, audience({ surface: { screen: 9, tab: TAB_OF[id] } }));
      expect(wrongScreen.some(e => e.tour.id === id)).toBe(false);
    }
  });
});

describe('guide IG-3 — intake: the blocked/form regions are mutually exclusive', () => {
  const tour = findTour('guide.tour.intake')!;
  const surface = { screen: INVENTORY_SCREEN, tab: 'intake' };

  it('shows the blocked step and hides the form step for an institution warehouse', () => {
    const steps = permittedSteps(tour, audience({
      surface, presence: { 'inventory.intake.blockedRegion': true, 'inventory.intake.formRegion': false },
    }));
    const ids = steps.map(s => s.id);
    expect(ids).toContain('intake.blocked');
    expect(ids).not.toContain('intake.form');
    expect(ids).not.toContain('intake.submit');
  });

  it('shows the form step and hides the blocked step for an ordinary warehouse — and never offers a submit step, held or otherwise', () => {
    const steps = permittedSteps(tour, audience({
      surface, presence: { 'inventory.intake.blockedRegion': false, 'inventory.intake.formRegion': true },
    }));
    const ids = steps.map(s => s.id);
    expect(ids).not.toContain('intake.blocked');
    expect(ids).toContain('intake.form');
    expect(ids).not.toContain('intake.submit');
  });

  it('still offers the tab-intro and closing steps in either case — they name no region', () => {
    for (const presence of [
      { 'inventory.intake.blockedRegion': true, 'inventory.intake.formRegion': false },
      { 'inventory.intake.blockedRegion': false, 'inventory.intake.formRegion': true },
    ]) {
      const ids = permittedSteps(tour, audience({ surface, presence })).map(s => s.id);
      expect(ids).toContain('intake.tab');
      expect(ids).toContain('intake.closing');
    }
  });
});

describe('guide IG-3 — presence removes a row step when there is no row to point at, not a fallback card', () => {
  /**
   * Only READ steps remain in this table after the correction:
   * `returns.receive`, `return-exceptions.resolve` and `corrections.decide`
   * used to appear here (presence-gated); they are HELD now (never exist in
   * the registry at all, at any presence value) — see the dedicated
   * "permanently held" describe block below, which is the correct place to
   * assert their absence.
   */
  const cases: Array<{ tourId: (typeof TOUR_IDS)[number]; tab: string; regionKey: string; rowKey: string; rowStepId: string }> = [
    { tourId: 'guide.tour.stock', tab: 'stock', regionKey: 'inventory.stock.region', rowKey: 'inventory.stock.row', rowStepId: 'stock.balances' },
    { tourId: 'guide.tour.incoming', tab: 'incoming', regionKey: 'inventory.incoming.region', rowKey: 'inventory.incoming.rowActions', rowStepId: 'incoming.receive' },
    { tourId: 'guide.tour.dispatch', tab: 'dispatch', regionKey: 'inventory.dispatch.region', rowKey: 'inventory.dispatch.rowActions', rowStepId: 'dispatch.send' },
  ];

  for (const { tourId, tab, regionKey, rowKey, rowStepId } of cases) {
    it(`${tourId}: an empty/no-eligible-row region drops "${rowStepId}" but keeps the tab and region steps`, () => {
      const tour = findTour(tourId)!;
      const surface = { screen: INVENTORY_SCREEN, tab };
      const perm = REQUIRED_PERMISSION[tourId];
      const permissions = new Set(perm ? [perm] : []);
      const emptySteps = permittedSteps(tour, audience({ surface, permissions, presence: { [regionKey]: false, [rowKey]: false } }));
      expect(emptySteps.map(s => s.id)).not.toContain(rowStepId);
      expect(emptySteps.length).toBeGreaterThan(0);

      const populatedSteps = permittedSteps(tour, audience({ surface, permissions, presence: { [regionKey]: true, [rowKey]: true } }));
      expect(populatedSteps.map(s => s.id)).toContain(rowStepId);
    });
  }
});

describe('guide IG-3 — incoming and dispatch require the real, global effective permission', () => {
  it('drops the entire incoming tour without warehouse_transfer.receive', () => {
    const audienceWithout = audience({
      surface: { screen: INVENTORY_SCREEN, tab: 'incoming' },
      permissions: new Set<string>(),
      presence: { 'inventory.incoming.region': true, 'inventory.incoming.rowActions': true },
    });
    expect(permittedTours(GUIDE_REGISTRY.tours, audienceWithout).some(e => e.tour.id === 'guide.tour.incoming')).toBe(false);
  });

  it('offers the incoming tour once warehouse_transfer.receive is held', () => {
    const audienceWith = audience({
      surface: { screen: INVENTORY_SCREEN, tab: 'incoming' },
      permissions: new Set(['warehouse_transfer.receive']),
      presence: { 'inventory.incoming.region': true, 'inventory.incoming.rowActions': true },
    });
    const offered = permittedTours(GUIDE_REGISTRY.tours, audienceWith).find(e => e.tour.id === 'guide.tour.incoming');
    expect(offered).toBeDefined();
    expect(offered?.steps.length).toBeGreaterThan(0);
  });

  it('drops the entire dispatch tour without warehouse_dispatch.create', () => {
    const audienceWithout = audience({
      surface: { screen: INVENTORY_SCREEN, tab: 'dispatch' },
      permissions: new Set<string>(),
    });
    expect(permittedTours(GUIDE_REGISTRY.tours, audienceWithout).some(e => e.tour.id === 'guide.tour.dispatch')).toBe(false);
  });

  it('offers the dispatch tour once warehouse_dispatch.create is held', () => {
    const audienceWith = audience({
      surface: { screen: INVENTORY_SCREEN, tab: 'dispatch' },
      permissions: new Set(['warehouse_dispatch.create']),
    });
    expect(permittedTours(GUIDE_REGISTRY.tours, audienceWith).some(e => e.tour.id === 'guide.tour.dispatch')).toBe(true);
  });
});

/**
 * ── Second independent review finding, corrected ────────────────────────
 *
 * `guide.tour.return-exceptions` in its ENTIRETY (not merely its former
 * `.resolve` step) has been removed from the registry: unlike `returns`
 * (tab visibility `canReceiveReturns || hasInventoryReadAffordance` — a
 * genuinely independent, wider read entitlement), this tab's ONLY gate is
 * `canResolveExceptions` — the settled value of
 * `useOutletReturnExceptionResolvePermission`, a plain `useAsync` hook with
 * no freshness-provable scope tag. Tab-surface match alone let
 * `permittedTours` offer the whole tour with no proof that access is
 * CURRENT, and no independent signal exists to gate on instead — gating on
 * `canResolveExceptions` itself would only relocate the same unproven
 * signal one level up. The full per-tour reasoning lives in the module doc
 * comment directly above the tour's former definition in guide.registry.ts
 * (removed along with the tour; preserved in git history).
 *
 * The "both paths need a reason" business fact this tour used to state
 * (merged into its now-removed `.closing` step by the first correction) had
 * no other legitimate home once the entire surface lost its authorization
 * basis, and is not preserved elsewhere — a fact whose only reason to be
 * told is "you are looking at this specific queue" cannot outlive the
 * queue's own removal from the offered catalog.
 */
describe('guide IG-3-CORRECTION — the entire return-exceptions tour is held, not merely its former action step', () => {
  const RETURN_EXCEPTIONS_SURFACE = { screen: INVENTORY_SCREEN, tab: 'return_exceptions' };

  it('is absent from the registry entirely', () => {
    expect(findTour('guide.tour.return-exceptions')).toBeNull();
    expect(GUIDE_REGISTRY.tours.some(t => t.id === 'guide.tour.return-exceptions')).toBe(false);
  });

  it('is never offered by permittedTours — full presence, a granted permission, or a granted (hypothetical) capability change nothing', () => {
    const scenarios: GuideAudience[] = [
      audience({ surface: RETURN_EXCEPTIONS_SURFACE, presence: {} }),
      audience({ surface: RETURN_EXCEPTIONS_SURFACE, presence: ALL_PRESENCE }),
      audience({
        surface: RETURN_EXCEPTIONS_SURFACE, presence: ALL_PRESENCE,
        capabilities: { 'outlet_stock.resolve_return_exception': true },
      }),
      audience({
        surface: RETURN_EXCEPTIONS_SURFACE, presence: ALL_PRESENCE,
        permissions: new Set(['outlet_stock.resolve_return_exception']),
      }),
    ];
    for (const a of scenarios) {
      const offered = permittedTours(GUIDE_REGISTRY.tours, a);
      expect(offered.some(e => e.tour.id === 'guide.tour.return-exceptions')).toBe(false);
    }
  });

  it('stays absent across a simulated warehouse revisit (A → B → A) even with presence RETAINED throughout — a stale tab selection cannot resurrect it', () => {
    // Warehouse A: presence fully set, as if the panel had genuinely rendered
    // rows here once (the strongest possible case for a false positive).
    const atA = permittedTours(GUIDE_REGISTRY.tours, audience({ surface: RETURN_EXCEPTIONS_SURFACE, presence: ALL_PRESENCE }));
    expect(atA.some(e => e.tour.id === 'guide.tour.return-exceptions')).toBe(false);

    // Switch to warehouse B: presence RETAINED rather than collapsing — the
    // exact "stale publisher hasn't cleared its keys yet" shape this
    // correction must be immune to, on top of the tab string itself
    // surviving the switch in local component state.
    const atB = permittedTours(GUIDE_REGISTRY.tours, audience({ surface: RETURN_EXCEPTIONS_SURFACE, presence: ALL_PRESENCE }));
    expect(atB.some(e => e.tour.id === 'guide.tour.return-exceptions')).toBe(false);

    // Revisit warehouse A.
    const backAtA = permittedTours(GUIDE_REGISTRY.tours, audience({ surface: RETURN_EXCEPTIONS_SURFACE, presence: ALL_PRESENCE }));
    expect(backAtA.some(e => e.tour.id === 'guide.tour.return-exceptions')).toBe(false);
  });
});

describe('guide IG-3 — the corrections closing step preserves the proposer-cannot-approve-own-request fact', () => {
  it('the closing step states the identity rule, in both languages, without inviting the reader to act', () => {
    const tour = findTour('guide.tour.corrections')!;
    expect(tour.steps.map(s => s.id)).not.toContain('corrections.decide');
    const closingStep = tour.steps.find(s => s.id === 'corrections.closing')!;
    expect(closingStep.body.en).toMatch(/cannot approve it themselves/i);
    expect(closingStep.body.en).toMatch(/by identity, not by role/i);
    expect(closingStep.body.en).not.toMatch(/close the guide/i);
    expect(closingStep.body.ar).not.toMatch(/أغلق الدليل/);
  });
});

/**
 * ── Reviewer finding #1, corrected ──────────────────────────────────────
 *
 * Five action-describing steps were removed from the registry entirely
 * (`intake.submit`, `stock.movement`, `returns.receive`, `returns.bulk`,
 * `corrections.decide`) because their source hooks
 * (`useWarehouseStockPermissions`, `useReturnReceivePermission`,
 * `useApproveCorrectionPermission`) are plain `useAsync` reads with no
 * freshness-provable scope tag — unlike the fixed `useQuarantinePermission`
 * — so no guide-only wrapper could prove a settled `true` belongs to the
 * CURRENT warehouse/scope rather than a stale one carried over from an
 * A→B→A revisit. See the module doc comments directly above each tour in
 * guide.registry.ts for the full per-tour reasoning.
 *
 * A sixth step, `return-exceptions.resolve`, was held the same way in the
 * first correction — but a second review found the entire
 * `guide.tour.return-exceptions` tour had no independent authorization
 * basis of its own either, so the WHOLE tour was subsequently removed; see
 * the dedicated "entire return-exceptions tour is held" describe block
 * above, which supersedes this one for that tour.
 */
describe('guide IG-3 — five action-describing steps are permanently held, not presence-gated', () => {
  const HELD_STEPS: Array<{ tourId: (typeof TOUR_IDS)[number]; tab: string; stepId: string }> = [
    { tourId: 'guide.tour.intake', tab: 'intake', stepId: 'intake.submit' },
    { tourId: 'guide.tour.stock', tab: 'stock', stepId: 'stock.movement' },
    { tourId: 'guide.tour.returns', tab: 'returns', stepId: 'returns.receive' },
    { tourId: 'guide.tour.returns', tab: 'returns', stepId: 'returns.bulk' },
    { tourId: 'guide.tour.corrections', tab: 'corrections', stepId: 'corrections.decide' },
  ];
  const HELD_TOUR_IDS = [...new Set(HELD_STEPS.map(h => h.tourId))];

  it('is never registered on the tour at all — held, not merely hidden at runtime', () => {
    for (const { tourId, stepId } of HELD_STEPS) {
      const tour = findTour(tourId)!;
      expect(tour.steps.map(s => s.id), `${stepId} must not exist anywhere in ${tourId}`).not.toContain(stepId);
    }
  });

  it('cannot be resurrected by full presence, a granted permission, or a former (now-deleted) presence key set to true', () => {
    for (const { tourId, tab, stepId } of HELD_STEPS) {
      const tour = findTour(tourId)!;
      const perm = REQUIRED_PERMISSION[tourId];
      const permissions = new Set(perm ? [perm] : []);
      const surface = { screen: INVENTORY_SCREEN, tab };

      const withFullPresence = permittedSteps(tour, audience({ surface, permissions, presence: ALL_PRESENCE }));
      expect(withFullPresence.map(s => s.id)).not.toContain(stepId);

      const withFormerPresenceKeys = permittedSteps(tour, audience({
        surface, permissions, presence: { ...ALL_PRESENCE, ...FORMER_ACTION_PRESENCE_KEYS },
      }));
      expect(withFormerPresenceKeys.map(s => s.id)).not.toContain(stepId);
    }
  });

  it('cannot be resurrected across a simulated warehouse revisit (A → B → A), since it never exists to be gated in the first place', () => {
    for (const { tourId, tab, stepId } of HELD_STEPS) {
      const tour = findTour(tourId)!;
      const perm = REQUIRED_PERMISSION[tourId];
      const permissions = new Set(perm ? [perm] : []);
      const surface = { screen: INVENTORY_SCREEN, tab };

      // Warehouse A, fully present.
      const atA = permittedSteps(tour, audience({ surface, permissions, presence: ALL_PRESENCE }));
      expect(atA.map(s => s.id)).not.toContain(stepId);

      // Switch to warehouse B — presence collapses (no rows there yet).
      const atB = permittedSteps(tour, audience({ surface, permissions, presence: {} }));
      expect(atB.map(s => s.id)).not.toContain(stepId);

      // Revisit warehouse A — presence returns, the held step still does not.
      const backAtA = permittedSteps(tour, audience({ surface, permissions, presence: ALL_PRESENCE }));
      expect(backAtA.map(s => s.id)).not.toContain(stepId);
    }
  });

  it('leaves the tab-intro, region/list, and closing steps of each affected tour eligible and unaffected', () => {
    for (const tourId of HELD_TOUR_IDS) {
      const tab = HELD_STEPS.find(h => h.tourId === tourId)!.tab;
      const tour = findTour(tourId)!;
      const perm = REQUIRED_PERMISSION[tourId];
      const permissions = new Set(perm ? [perm] : []);
      const surface = { screen: INVENTORY_SCREEN, tab };
      const steps = permittedSteps(tour, audience({ surface, permissions, presence: ALL_PRESENCE }));
      expect(steps.length).toBeGreaterThanOrEqual(3);
      expect(steps.some(s => s.id.endsWith('.tab'))).toBe(true);
      expect(steps.some(s => s.id.endsWith('.closing'))).toBe(true);
    }
  });
});

describe('guide IG-3 — read-only returns: a viewer with no receive capability still gets viewing guidance, never action guidance', () => {
  /**
   * `canViewReturns` (tab visibility) is deliberately WIDER than
   * `canReceiveReturns` (mutation) in the real screen — a genuinely
   * read-only actor legitimately reaches this tab with every receive
   * control disabled. This tour is offered on tab-surface match alone (it
   * has no `requiresPermissions`/`requiresCapabilities` of its own, matching
   * that real split), so the guarantee that matters is structural: there is
   * no receive/bulk step to leak, for ANY audience.
   */
  it('offers the tab and pending-list steps regardless of any capability, and never offers receive/bulk', () => {
    const tour = findTour('guide.tour.returns')!;
    const surface = { screen: INVENTORY_SCREEN, tab: 'returns' };
    const capabilityCases: Array<Record<string, boolean>> = [{}, { 'returns.receive': false }, { 'returns.receive': true }];
    for (const capabilities of capabilityCases) {
      const steps = permittedSteps(tour, audience({ surface, capabilities, presence: ALL_PRESENCE }));
      const ids = steps.map(s => s.id);
      expect(ids).toContain('returns.tab');
      expect(ids).toContain('returns.list');
      expect(ids).toContain('returns.closing');
      expect(ids).not.toContain('returns.receive');
      expect(ids).not.toContain('returns.bulk');
    }
  });
});

describe('guide IG-3 — regression: IG-2 read/action separation (quarantine, suspension) is untouched by this correction', () => {
  it('quarantine and suspension tours still exist with their own action steps intact', () => {
    const quarantine = findTour('guide.tour.quarantine');
    const suspension = findTour('guide.tour.dispensing-suspension');
    expect(quarantine).not.toBeNull();
    expect(suspension).not.toBeNull();
    expect(quarantine?.steps.some(s => s.id === 'quarantine.release')).toBe(true);
    expect(quarantine?.steps.some(s => s.id === 'quarantine.destroy')).toBe(true);
    expect(suspension?.steps.some(s => s.id === 'suspension.create')).toBe(true);
    expect(suspension?.steps.some(s => s.id === 'suspension.lift')).toBe(true);
  });
});

describe('guide IG-3 — corrections tour never implies the request happens on this panel', () => {
  it('names the actual request locations (stock tab / outlet screen) rather than describing a request control here', () => {
    const tour = findTour('guide.tour.corrections')!;
    const introStep = tour.steps.find(s => s.id === 'corrections.tab')!;
    expect(introStep.body.en).toMatch(/Warehouse Stock tab/);
    expect(introStep.body.en).toMatch(/outlet/i);
  });
});
