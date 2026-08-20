/**
 * R1.2 / MIGRATION 180 — the ordinary warehouse-dispatch destination picker no
 * longer offers emergency outlets.
 *
 * Warehouse/depot direct supply to a crash cabinet or rescue cart is legal only
 * through the dedicated initial-provisioning corridor, so offering one in the
 * ORDINARY composer offers an action the database now always refuses with
 * `emergency_outlet_requires_initial_provisioning`.
 *
 * THIS FILTER IS UX, NOT THE SECURITY BOUNDARY. The authority boundary is
 * enforced in the database for every caller — including ones that never touch
 * this screen — and is proved dynamically in
 * supabase/migrations/__tests__/180-emergency-initial-provisioning-boundary.dynamic.test.ts.
 * The assertions here only prove the UI does not dangle a dead action, and that
 * the separate initial-provisioning entry point survives intact.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  REPLENISHMENT_DESTINATION_POINT_TYPES,
  isReplenishmentDestinationPointType,
} from '@/shared/lib/emergency-replenishment';

const SRC = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const center = read('features/inventory/InventoryCenterScreen.tsx');
const scopes = read('features/inventory/useInventoryScopes.ts');
const launcher = read('features/outlet/InitialProvisioningLauncher.tsx');
const composer = read('features/outlet/OutletDispatchComposer.tsx');
const dispatchService = read('features/outlet/dispatch.service.ts');
const replenishmentService = read('features/outlet/emergency-replenishment.service.ts');
const replenishmentTab = read('features/outlet/EmergencyReplenishmentTab.tsx');
const outletScreen = read('features/outlet/OutletOperationsScreen.tsx');

describe('the canonical emergency-outlet vocabulary is reused, not re-declared', () => {
  it('classifies exactly the two emergency destination types', () => {
    expect([...REPLENISHMENT_DESTINATION_POINT_TYPES].sort()).toEqual(['crash_cabinet', 'rescue_cart']);
    expect(isReplenishmentDestinationPointType('crash_cabinet')).toBe(true);
    expect(isReplenishmentDestinationPointType('rescue_cart')).toBe(true);
    // A pharmacy stays a legal ordinary destination — including an ER pharmacy,
    // which the database distinguishes by point_type, never by
    // clinical_location_kind.
    expect(isReplenishmentDestinationPointType('pharmacy')).toBe(false);
  });

  it('fails closed on an unknown, null or undefined point type', () => {
    for (const value of [null, undefined, '', 'emergency', 'dispensing', 'storage', 42]) {
      expect(isReplenishmentDestinationPointType(value), String(value)).toBe(false);
    }
  });
});

describe('the scope catalog publishes the outlet point type', () => {
  it('carries pointType on every scope option', () => {
    expect(scopes).toMatch(/pointType: string \| null;/);
    // G4.2: the two named mappers (`toOutletOption` / `toWhOption`) went away when
    // the primary path moved to Migration 191's canonical query — the mapping is
    // now inline over the RPC rows. The CONTRACT is unchanged and still
    // asserted: an outlet option carries the SERVER's point type, and a
    // warehouse option carries an explicit null, so a consumer cannot mistake
    // "warehouse" for "unclassified outlet".
    expect(scopes).toMatch(/kind: 'outlet' as const[\s\S]{0,500}pointType: n\.distributionPointType/);
    expect(scopes).toMatch(/kind: 'warehouse' as const[\s\S]{0,500}pointType: null/);
  });
});

describe('the ORDINARY dispatch destination list excludes emergency outlets', () => {
  it('filters them out with the shared predicate, not a local literal list', () => {
    expect(center).toMatch(
      /import \{ isReplenishmentDestinationPointType \} from '@\/shared\/lib\/emergency-replenishment'/,
    );
    expect(center).toMatch(/outletsForWarehouse[\s\S]{0,600}!isReplenishmentDestinationPointType\(o\.pointType\)/);
    // No parallel hard-coded copy of the vocabulary in this screen.
    expect(center).not.toMatch(/'crash_cabinet'/);
    expect(center).not.toMatch(/'rescue_cart'/);
  });

  it('keeps the pre-existing warehouse-scope filter as well', () => {
    expect(center).toMatch(/o\.warehouseId === activeWarehouseId/);
  });

  it('records that the UI filter is not the authority', () => {
    expect(center).toMatch(/This filter is UX, NOT the security boundary/);
    expect(center).toMatch(/Migration 180/);
  });
});

describe('the initial-provisioning entry point is preserved and still reaches emergency outlets', () => {
  it('InitialProvisioningLauncher supplies the outlet itself and flags the composer', () => {
    // It never reads the ordinary destination list, so excluding emergency
    // outlets there cannot strand it.
    expect(launcher).toMatch(/outlets=\{\[\{ id: distributionPointId, name: outletName \}\]\}/);
    expect(launcher).toMatch(/isInitialProvisioning/);
    expect(launcher).not.toMatch(/manageableOutlets/);
  });

  it('eligibility is read from the 166 lifecycle columns, never from a balance', () => {
    expect(launcher).toMatch(/getInitialProvisioningState\(distributionPointId\)/);
    expect(launcher).toMatch(/state\.data\?\.consumed/);
    expect(launcher).not.toMatch(/onHand|quantity/i);
  });

  it('the composer routes to the DEDICATED RPC when provisioning, and the ordinary one otherwise', () => {
    expect(composer).toMatch(/isInitialProvisioning[\s\S]{0,120}createInitialProvisioningDispatch\(\{/);
    expect(composer).toMatch(/: createWarehouseDispatch\(\{/);
  });
});

describe('the Initial Provisioning launcher is offered for EMERGENCY outlets only', () => {
  it('the tab receives the selected outlet point type through the existing scope catalog', () => {
    // Smallest existing boundary: useInventoryScopes already resolves the
    // active outlet, so no new fetch and no new prop chain is introduced.
    expect(outletScreen).toMatch(/<EmergencyReplenishmentTab[\s\S]{0,700}outletPointType=\{activeOutlet\.pointType\}/);
    expect(replenishmentTab).toMatch(/outletPointType\?: string \| null;/);
  });

  it('gates the launcher on the canonical emergency predicate, not a new literal list', () => {
    expect(replenishmentTab).toMatch(
      /import \{ isReplenishmentDestinationPointType \} from '@\/shared\/lib\/emergency-replenishment'/,
    );
    expect(replenishmentTab).toMatch(
      /\{canInitialProvision && isReplenishmentDestinationPointType\(outletPointType\) && \(\s*<InitialProvisioningLauncher/,
    );
    // The GATE itself must contain no hand-rolled type vocabulary. Scoped to the
    // gate: the route-label rendering further down legitimately names
    // 'rescue_cart' to choose a caption, which decides no authority.
    const gate = replenishmentTab.slice(
      replenishmentTab.indexOf('isReplenishmentDestinationPointType(outletPointType)'),
      replenishmentTab.indexOf('<ReplenishForm'),
    );
    expect(gate).not.toMatch(/'crash_cabinet'/);
    expect(gate).not.toMatch(/'rescue_cart'/);
  });

  it('PHARMACY · the launcher is not rendered — an absent or unknown type fails closed', () => {
    // isReplenishmentDestinationPointType returns false for 'pharmacy', null and
    // undefined, so the guard above renders nothing in all three cases. The
    // behaviour of the predicate itself is asserted at the top of this file.
    for (const value of ['pharmacy', null, undefined]) {
      expect(isReplenishmentDestinationPointType(value), String(value)).toBe(false);
    }
  });

  it('CRASH CABINET / RESCUE CART · the launcher is rendered and still lifecycle-aware', () => {
    for (const value of ['crash_cabinet', 'rescue_cart']) {
      expect(isReplenishmentDestinationPointType(value), value).toBe(true);
    }
    // Rendering it is necessary but not sufficient: the launcher itself still
    // shows a non-actionable status once the lifecycle is open or consumed.
    expect(launcher).toMatch(/state\.data\?\.consumed/);
    expect(launcher).toMatch(/state\.data\?\.openDispatchId/);
  });

  it('a pharmacy keeps its OUTGOING routine-replenishment and reversal forms', () => {
    // Only the launcher is gated. Hiding the whole tab would strand every legal
    // pharmacy source, which is the corridor Migration 168 depends on.
    expect(replenishmentTab).toMatch(/<ReplenishForm/);
    expect(replenishmentTab).toMatch(/<ReverseForm/);
    const gateAt = replenishmentTab.indexOf('isReplenishmentDestinationPointType(outletPointType)');
    const formsAt = replenishmentTab.indexOf('<ReplenishForm');
    expect(gateAt).toBeGreaterThan(-1);
    expect(formsAt).toBeGreaterThan(gateAt);
    // The forms are gated on OUTGOING routes, never on the outlet's own type.
    expect(replenishmentTab).toMatch(/outgoing\.length === 0/);
  });
});

describe('no client can self-declare a dispatch authority', () => {
  it('the ordinary service calls the unchanged six-argument RPC', () => {
    expect(dispatchService).toMatch(/callRpc\('phoenix_create_warehouse_dispatch', \{/);
    for (const param of [
      'p_warehouse_id',
      'p_destination_distribution_point_id',
      'p_dispatch_number',
      'p_document_number',
      'p_default_currency',
      'p_notes',
    ]) {
      expect(dispatchService, param).toContain(param);
    }
  });

  it('no service sends an authority / mode / is-initial argument to any RPC', () => {
    // Authority is determined solely by WHICH RPC is invoked. A client-supplied
    // mode parameter would be the authority-confusion vulnerability Migration
    // 180 exists to prevent.
    for (const [name, source] of [
      ['dispatch.service', dispatchService],
      ['emergency-replenishment.service', replenishmentService],
      ['OutletDispatchComposer', composer],
      ['InitialProvisioningLauncher', launcher],
    ] as const) {
      expect(source, name).not.toMatch(/p_authority/);
      expect(source, name).not.toMatch(/p_is_initial/);
      expect(source, name).not.toMatch(/p_mode\b/);
    }
  });

  it('the initial-provisioning service calls its own dedicated RPC', () => {
    expect(replenishmentService).toMatch(/callRpc<InitialProvisioningResult>\('phoenix_create_initial_provisioning_dispatch'/);
  });
});
