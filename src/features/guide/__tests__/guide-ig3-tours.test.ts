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

const TOUR_IDS = [
  'guide.tour.intake', 'guide.tour.stock', 'guide.tour.ledger',
  'guide.tour.incoming', 'guide.tour.dispatch', 'guide.tour.returns',
  'guide.tour.return-exceptions', 'guide.tour.corrections',
] as const;

const TAB_OF: Record<(typeof TOUR_IDS)[number], string> = {
  'guide.tour.intake': 'intake',
  'guide.tour.stock': 'stock',
  'guide.tour.ledger': 'ledger',
  'guide.tour.incoming': 'incoming',
  'guide.tour.dispatch': 'dispatch',
  'guide.tour.returns': 'returns',
  'guide.tour.return-exceptions': 'return_exceptions',
  'guide.tour.corrections': 'corrections',
};

/** The two tours gated on a real, global effective permission (see below). */
const REQUIRED_PERMISSION: Partial<Record<(typeof TOUR_IDS)[number], string>> = {
  'guide.tour.incoming': 'warehouse_transfer.receive',
  'guide.tour.dispatch': 'warehouse_dispatch.create',
};

/** Enough presence for every row-level step across all eight tours to survive. */
const ALL_PRESENCE: Record<string, boolean> = {
  'inventory.intake.blockedRegion': false, 'inventory.intake.formRegion': true,
  'inventory.stock.region': true, 'inventory.stock.row': true, 'inventory.stock.rowMovementAction': true,
  'inventory.ledger.region': true,
  'inventory.incoming.region': true, 'inventory.incoming.rowActions': true,
  'inventory.dispatch.region': true, 'inventory.dispatch.rowActions': true,
  'inventory.returns.region': true, 'inventory.returns.rowActions': true,
  'inventory.returnExceptions.region': true, 'inventory.returnExceptions.rowActions': true,
  'inventory.corrections.region': true, 'inventory.corrections.rowActions': true,
};

describe('guide IG-3 — all eight tours exist, once each, correctly scoped', () => {
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

  it('shows the form and submit steps and hides the blocked step for an ordinary warehouse', () => {
    const steps = permittedSteps(tour, audience({
      surface, presence: { 'inventory.intake.blockedRegion': false, 'inventory.intake.formRegion': true },
    }));
    const ids = steps.map(s => s.id);
    expect(ids).not.toContain('intake.blocked');
    expect(ids).toContain('intake.form');
    expect(ids).toContain('intake.submit');
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
  const cases: Array<{ tourId: (typeof TOUR_IDS)[number]; tab: string; regionKey: string; rowKey: string; rowStepId: string }> = [
    { tourId: 'guide.tour.stock', tab: 'stock', regionKey: 'inventory.stock.region', rowKey: 'inventory.stock.row', rowStepId: 'stock.balances' },
    { tourId: 'guide.tour.incoming', tab: 'incoming', regionKey: 'inventory.incoming.region', rowKey: 'inventory.incoming.rowActions', rowStepId: 'incoming.receive' },
    { tourId: 'guide.tour.dispatch', tab: 'dispatch', regionKey: 'inventory.dispatch.region', rowKey: 'inventory.dispatch.rowActions', rowStepId: 'dispatch.send' },
    { tourId: 'guide.tour.returns', tab: 'returns', regionKey: 'inventory.returns.region', rowKey: 'inventory.returns.rowActions', rowStepId: 'returns.receive' },
    { tourId: 'guide.tour.return-exceptions', tab: 'return_exceptions', regionKey: 'inventory.returnExceptions.region', rowKey: 'inventory.returnExceptions.rowActions', rowStepId: 'return-exceptions.resolve' },
    { tourId: 'guide.tour.corrections', tab: 'corrections', regionKey: 'inventory.corrections.region', rowKey: 'inventory.corrections.rowActions', rowStepId: 'corrections.decide' },
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

describe('guide IG-3 — the return-exceptions tour states both resolution paths require a reason', () => {
  it('the resolve step body asserts a reason for BOTH paths, in both languages', () => {
    const tour = findTour('guide.tour.return-exceptions')!;
    const resolveStep = tour.steps.find(s => s.id === 'return-exceptions.resolve')!;
    expect(resolveStep).toBeDefined();
    expect(resolveStep.body.ar).toMatch(/كلا المسارين/);
    expect(resolveStep.body.en).toMatch(/BOTH paths/);
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
