/**
 * R1.1-P (P3-A) — INITIAL PROVISIONING USES THE OUTLET'S PAIRED WAREHOUSE.
 *
 * THE DEFECT: `InitialProvisioningLauncher` loaded `getWarehouses(orgId)` and
 * offered EVERY active institution warehouse in the organization as a free
 * choice of source. Inside a health sector that list contains the SECTOR MAIN
 * and every OTHER centre's depot — so commissioning one centre's crash cabinet
 * invited the operator to dispatch from a warehouse that does not own it.
 *
 * THE RULE: an outlet has exactly one owning warehouse
 * (`distribution_points.warehouse_id`). Initial provisioning comes from THAT
 * one. For a health-centre crash cabinet that is the centre's own depot — never
 * the sector main, never a sibling centre.
 *
 * Migrations 180/183 remain the authority. These tests prove the interface no
 * longer offers a source the server would refuse, and that the pairing is
 * carried down from the screen that already resolves it rather than re-derived
 * or guessed from names.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const launcher = read('features/outlet/InitialProvisioningLauncher.tsx');
const tab = read('features/outlet/EmergencyReplenishmentTab.tsx');
const screen = read('features/outlet/OutletOperationsScreen.tsx');

describe('the pairing is carried down the real component chain', () => {
  it('OutletOperationsScreen passes the selected outlet’s own warehouseId', () => {
    // useInventoryScopes already resolved it — no second read, no new boundary.
    expect(screen).toContain('owningWarehouseId={activeOutlet.warehouseId}');
  });

  it('EmergencyReplenishmentTab forwards it to the launcher', () => {
    expect(tab).toContain('owningWarehouseId?: string | null;');
    expect(tab).toContain('owningWarehouseId={owningWarehouseId ?? null}');
  });

  it('the launcher accepts it as its only source of truth for the source', () => {
    expect(launcher).toContain('owningWarehouseId: string | null;');
  });
});

describe('the launcher offers exactly one source — the paired active depot', () => {
  it('resolves the source by warehouse IDENTITY, never by name', () => {
    expect(launcher).toContain('w.id === owningWarehouseId');
    // A name-based match would silently re-point a renamed depot.
    expect(launcher).not.toMatch(/name.*===.*outletName|includes\(outletName\)/);
  });

  it('still requires the paired warehouse to be an ACTIVE institution warehouse', () => {
    expect(launcher).toContain("w.warehouseKind === 'institution'");
    expect(launcher).toContain("w.status === 'active'");
  });

  it('no longer renders an organization-wide warehouse picker', () => {
    // The whole defect was a <PhoenixSelect> over every institution warehouse.
    expect(launcher).not.toContain('PhoenixSelect');
    expect(launcher).not.toContain('institutionWarehouses');
    expect(launcher).not.toContain("t('port_select_wh'");
  });

  it('shows the resolved depot read-only instead of asking the operator to choose', () => {
    expect(launcher).toContain('data-testid="prov-initial-source"');
    expect(launcher).toContain('pairedWarehouseName');
  });

  it('FAILS CLOSED: an unresolvable pairing offers no source and no start button', () => {
    expect(launcher).toContain('pairedWarehouse === null');
    expect(launcher).toContain("t('port_no_wh', lang)");
    // The composer cannot open without a resolved pairing.
    expect(launcher).toContain('if (composerOpen && pairedWarehouse) {');
  });

  it('a null owningWarehouseId never falls back to an org-wide list', () => {
    expect(launcher).toContain('owningWarehouseId\n    ? (warehouses.data ?? []).find');
    expect(launcher).toContain(': null;');
  });

  it('dispatches FROM the paired warehouse id, not an operator selection', () => {
    expect(launcher).toContain('sourceWarehouseId={pairedWarehouse.id}');
    expect(launcher).not.toContain('sourceWarehouseId={warehouseId}');
  });
});

describe('the pre-existing lifecycle behaviour is untouched', () => {
  it('eligibility still comes from Migration 166’s own columns, never from stock', () => {
    expect(launcher).toContain('getInitialProvisioningState(distributionPointId)');
    expect(launcher).toContain('state.data?.consumed');
    expect(launcher).toContain('state.data?.openDispatchId');
    expect(launcher).not.toMatch(/outlet_stock|availableQuantity|onHandQuantity/);
  });

  it('a consumed slot still shows a non-actionable status, not a disabled button', () => {
    expect(launcher).toContain("t('prov_initial_consumed', lang)");
    expect(launcher).toContain("t('prov_initial_open', lang)");
  });

  it('it is still the initial-provisioning composer, not an ordinary dispatch', () => {
    expect(launcher).toContain('isInitialProvisioning');
  });

  it('the launcher is still offered for EMERGENCY outlets only (Migration 180)', () => {
    expect(tab).toContain('isReplenishmentDestinationPointType(outletPointType)');
  });
});
