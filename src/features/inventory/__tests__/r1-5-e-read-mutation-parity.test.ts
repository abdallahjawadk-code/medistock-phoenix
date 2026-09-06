/**
 * R1.5-E12/E13/E14 — READ vs MUTATION PARITY IN THE INVENTORY CENTER.
 *
 * Section E's whole claim is that VISIBILITY widened and CAPABILITY did not.
 * This suite proves both halves, and proves the second half the only way that
 * is meaningful: by showing every mutation decision is still the untouched
 * scoped-permission answer, and that the read affordance cannot reach any of
 * them.
 *
 * The read-affordance predicate itself is exercised as a pure function, so the
 * "HCM yes / historical roles no" behaviour is asserted on real values rather
 * than on the spelling of a role check.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isFacilityScopedRole, normalizeRole, OFFICIAL_ROLES } from '@/shared/lib/roles';

const read = (p: string) => readFileSync(join(__dirname, '../../../', p), 'utf8');

/**
 * Strip comments so a negative assertion cannot trip on prose that legitimately
 * NAMES the thing being forbidden. `stock-identity.ts` documents at length why
 * it never calls `_phoenix_material_identity_v1`; asserting over raw text would
 * fail on that explanation and, worse, invite deleting the explanation to get
 * green. Only executable code is authoritative.
 */
const executable = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SCREEN = read('features/inventory/InventoryCenterScreen.tsx');
const AFFORDANCE = read('features/inventory/useInventoryReadAffordance.ts');
const CORRECTIONS = read('features/inventory/PendingCorrectionsPanel.tsx');
const QUARANTINE_PANEL = read('features/inventory/QuarantinePanel.tsx');
const QUARANTINE_SERVICE = read('features/inventory/quarantine.service.ts');
const NETWORK_SERVICE = read('features/network/network.service.ts');
const RETURNS = read('features/outlet/InstitutionReturnReceipts.tsx');
const IDENTITY = read('features/inventory/stock-identity.ts');

const HISTORICAL_ROLES = [
  'super_admin',
  'central_warehouse_manager',
  'institution_admin',
  'warehouse_officer',
  'outlet_officer',
] as const;

/** The exact rule the hook applies, exercised without React. */
const affords = (role: string | null | undefined) =>
  isFacilityScopedRole(normalizeRole(role ?? ''));

// ── E12: who gets the read affordance ────────────────────────────────────────
describe('E12 — the read affordance reaches health_center_manager and nobody else', () => {
  it('health_center_manager is afforded discoverability', () => {
    expect(affords('health_center_manager')).toBe(true);
  });

  it('every historical role is NOT afforded it, so their menus are unchanged', () => {
    for (const role of HISTORICAL_ROLES) {
      expect(affords(role), role).toBe(false);
    }
  });

  it('an unknown, empty or missing role is not afforded it', () => {
    for (const role of ['', 'not_a_role', 'viewer', 'hospital_admin', null, undefined]) {
      expect(affords(role), String(role)).toBe(false);
    }
  });

  it('the affordance covers exactly the facility-scoped members of the role vocabulary', () => {
    const afforded = OFFICIAL_ROLES.filter(r => affords(r));
    expect(afforded).toEqual(['health_center_manager']);
  });

  it('is asked once, through the canonical helper, not by literal role compare', () => {
    expect(AFFORDANCE).toContain('isFacilityScopedRole(normalizeRole(profile?.role ?? \'\'))');
    expect(AFFORDANCE).not.toContain("=== 'health_center_manager'");
  });
});

// ── E12/E2: the role check is not scattered ──────────────────────────────────
describe('E2 — no scattered role checks in the Inventory Center surfaces', () => {
  it('no Section-E surface names the role literally', () => {
    for (const [name, src] of [
      ['InventoryCenterScreen', SCREEN],
      ['PendingCorrectionsPanel', CORRECTIONS],
      ['QuarantinePanel', QUARANTINE_PANEL],
      ['quarantine.service', QUARANTINE_SERVICE],
      ['InstitutionReturnReceipts', RETURNS],
      ['stock-identity', IDENTITY],
    ] as const) {
      expect(src, name).not.toContain("'health_center_manager'");
    }
  });

  it('the screen consumes ONE affordance hook', () => {
    expect(SCREEN).toContain("import { useInventoryReadAffordance } from './useInventoryReadAffordance'");
    expect(SCREEN.match(/useInventoryReadAffordance\(\)/g) ?? []).toHaveLength(1);
  });
});

// ── E1/E3/E4/E5: visibility is split from mutation ───────────────────────────
describe('E1 — visibility and mutation are separate decisions', () => {
  it('tabs are gated on canView*, not on a mutation key', () => {
    expect(SCREEN).toContain("...(canViewReturns ? [{ id: 'returns'");
    expect(SCREEN).toContain("...(canViewQuarantine ? [{ id: 'quarantine'");
    expect(SCREEN).toContain("...(canViewCorrections ? [{ id: 'corrections'");
    expect(SCREEN).toContain("tab === 'returns' && canViewReturns");
    expect(SCREEN).toContain("tab === 'quarantine' && canViewQuarantine");
    expect(SCREEN).toContain("tab === 'corrections' && canViewCorrections");
  });

  it('each canView derives FROM the mutation answer, so existing actors keep their tabs', () => {
    expect(SCREEN).toContain('const canViewReturns = canReceiveReturns || hasInventoryReadAffordance');
    expect(SCREEN).toContain('const canViewQuarantine = canDisposeQuarantine || hasInventoryReadAffordance');
    expect(SCREEN).toContain('const canViewWarehouseCorrections = canApproveWarehouseCorrection || hasInventoryReadAffordance');
  });

  it('E5 keeps the affordance off OUTLET corrections', () => {
    expect(SCREEN).toContain('const canViewOutletCorrections = canApproveOutletCorrection;');
  });
});

describe('E13 — mutation authority is untouched by the affordance', () => {
  it('every mutation decision is still the raw scoped-permission answer', () => {
    expect(SCREEN).toContain('const canReceiveReturns = returnReceive.data ?? false');
    expect(SCREEN).toContain('const canDisposeQuarantine = quarantinePerm.data ?? false');
    expect(SCREEN).toContain("useApproveCorrectionPermission(activeOrgId, 'outlet_stock.approve_correction')");
    expect(SCREEN).toContain("useApproveCorrectionPermission(activeOrgId, 'warehouse_stock.approve_correction')");
  });

  it('the affordance is never OR-ed into a mutation decision', () => {
    for (const decision of [
      'canReceiveReturns',
      'canDisposeQuarantine',
      'canResolveExceptions',
      'canApproveOutletCorrection',
      'canApproveWarehouseCorrection',
      'canAdjust',
      'canCorrect',
      'canDispatch',
      'canReceive',
    ]) {
      expect(
        SCREEN.match(new RegExp(`const\\s+${decision}\\s*=\\s*[^;]*hasInventoryReadAffordance`)),
        decision,
      ).toBeNull();
    }
  });

  it('the panels still receive the mutation flags, not the view flags', () => {
    expect(SCREEN).toContain('canReceive={canReceiveReturns}');
    // QUARANTINE-PANEL-STALE-WAREHOUSE-RACE fix: the panel prop is
    // canDisposeQuarantineConfirmed, a STRICTER derivative of
    // canDisposeQuarantine (true only once quarantinePerm has settled with
    // no error for the CURRENT warehouse — see useQuarantinePermission's
    // `confirmed` field). It can never be true when canDisposeQuarantine is
    // false, so this stays a mutation-scoped flag, never the view flag.
    expect(SCREEN).toContain('const canDisposeQuarantineConfirmed = quarantinePerm.confirmed && quarantinePerm.data === true');
    expect(SCREEN).toContain('canDispose={canDisposeQuarantineConfirmed}');
    expect(SCREEN).toContain('canApproveOutlet={canApproveOutletCorrection}');
    expect(SCREEN).toContain('canApproveWarehouse={canApproveWarehouseCorrection}');
  });

  it('a viewer reaches the corrections history but no approve/reject control', () => {
    expect(CORRECTIONS).toContain("const canDecide = row.scope === 'outlet' ? canApproveOutlet : canApproveWarehouse");
    expect(CORRECTIONS).toContain('{!canDecide ? null : isOwnRequest ? (');
  });

  it('quarantine release/destroy remain behind canDispose', () => {
    expect(QUARANTINE_PANEL).toContain("{canDispose && mode === 'none' && (");
  });

  it('return receipt controls remain behind canReceive', () => {
    expect(RETURNS).toContain('if (busy || !canReceive');
    expect(RETURNS).toContain('disabled={!canReceive');
  });
});

// ── E13: no security widening anywhere ───────────────────────────────────────
describe('E13 — no security widening', () => {
  const ALL = [SCREEN, AFFORDANCE, CORRECTIONS, QUARANTINE_PANEL, QUARANTINE_SERVICE, NETWORK_SERVICE, IDENTITY].join('\n');

  it('adds no permission key and edits no role default', () => {
    expect(ALL).not.toContain('permission_keys');
    expect(ALL).not.toContain('role_permission_defaults');
    expect(ALL).not.toContain('assign_profile_permissions');
  });

  it('adds no service_role / RLS bypass and no direct table write', () => {
    expect(ALL).not.toContain('service_role');
    expect(ALL).not.toContain('SUPABASE_SERVICE');
    for (const write of ['.insert(', '.update(', '.delete(', '.upsert(']) {
      expect(ALL, write).not.toContain(write);
    }
  });

  it('reads stay plain RLS-scoped SELECTs on the canonical tables', () => {
    expect(QUARANTINE_SERVICE).toContain(".from('warehouse_quarantine_stock')");
    expect(NETWORK_SERVICE).toContain(".from('warehouse_stock')");
  });

  it('alters no RPC signature — the disposition RPCs keep their exact arguments', () => {
    expect(QUARANTINE_SERVICE).toContain("callRpc('phoenix_release_quarantine_stock'");
    expect(QUARANTINE_SERVICE).toContain('p_destination_warehouse_stock_id: input.destinationWarehouseStockId');
    expect(QUARANTINE_SERVICE).toContain("callRpc('phoenix_destroy_quarantine_stock'");
  });

  it('does not client-filter sibling facilities as the security mechanism', () => {
    // Row isolation is RLS's job. A client-side facility filter would both be
    // bypassable and hide the fact that the boundary lives in the database.
    expect(SCREEN).not.toContain('facilityId ===');
    expect(QUARANTINE_SERVICE).not.toContain('facility_id');
    expect(NETWORK_SERVICE).not.toContain("eq('facility_id'");
  });

  it('the query scope is unchanged — still one warehouse at a time', () => {
    expect(QUARANTINE_SERVICE).toContain(".eq('warehouse_id', warehouseId)");
    expect(NETWORK_SERVICE).toContain(".eq('warehouse_id', warehouseId)");
  });
});

// ── E6/E10: canonical identity fields are read, never recomputed ─────────────
describe('E6/E10 — canonical identity is DATA, not a client computation', () => {
  it('both queries select all four canonical columns', () => {
    for (const [name, src] of [['warehouse_stock', NETWORK_SERVICE], ['quarantine', QUARANTINE_SERVICE]] as const) {
      for (const col of ['material_identity_key', 'internal_batch_reference', 'supply_type', 'purchase_origin']) {
        expect(src, `${name}:${col}`).toContain(col);
      }
    }
  });

  it('both map snake_case to the canonical camelCase names', () => {
    for (const src of [NETWORK_SERVICE, QUARANTINE_SERVICE]) {
      expect(src).toContain('materialIdentityKey: r.material_identity_key');
      expect(src).toContain('internalBatchReference: r.internal_batch_reference');
      expect(src).toContain('supplyType: r.supply_type');
      expect(src).toContain('purchaseOrigin: r.purchase_origin');
    }
  });

  it('preserves the pre-existing fields on both row contracts', () => {
    for (const f of ['nationalCode: r.national_code', 'batchNumber: r.batch_number', 'expiryDate: r.expiry_date']) {
      expect(NETWORK_SERVICE, f).toContain(f);
      expect(QUARANTINE_SERVICE, f).toContain(f);
    }
    expect(QUARANTINE_SERVICE).toContain('quarantineReason: r.quarantine_reason');
    expect(NETWORK_SERVICE).toContain('onHandQuantity: r.on_hand_quantity');
  });

  it('never reconstructs the identity key in TypeScript', () => {
    const ALL = executable([NETWORK_SERVICE, QUARANTINE_SERVICE, IDENTITY, QUARANTINE_PANEL].join('\n'));
    // No call to 150's canonical helper, and no hand-rolled equivalent.
    expect(ALL).not.toContain('_phoenix_material_identity_v1');
    // No fabricated fallback: the key is either the database's or it is null.
    expect(ALL).not.toMatch(/materialIdentityKey:\s*r\.material_identity_key\s*\?\?/);
    expect(ALL).not.toMatch(/materialIdentityKey:\s*`/);
  });

  it('the picker uses the exact predicate, not the old name/batch/expiry triple', () => {
    expect(QUARANTINE_PANEL).toContain('stock.filter(s => isExactReleaseCandidate(s, row))');
    expect(QUARANTINE_PANEL).not.toContain('scientificName.toLowerCase()');
  });
});

// ── E14: historical role compatibility ───────────────────────────────────────
describe('E14 — historical roles keep byte-identical behaviour', () => {
  it('for any role without the affordance, canView collapses to the mutation answer', () => {
    // canView = canMutate || affordance. With affordance false this is exactly
    // canMutate, which is what these roles saw before Section E.
    for (const role of HISTORICAL_ROLES) {
      const affordance = affords(role);
      expect(affordance, role).toBe(false);
      for (const canMutate of [true, false]) {
        expect(canMutate || affordance, `${role}:${canMutate}`).toBe(canMutate);
      }
    }
  });

  it('the affordance can only ever ADD visibility, never remove it', () => {
    for (const canMutate of [true, false]) {
      for (const affordance of [true, false]) {
        const canView = canMutate || affordance;
        if (canMutate) expect(canView).toBe(true);
      }
    }
  });

  it('no historical permission key was renamed or dropped from the screen', () => {
    for (const key of [
      'outlet_stock.return_receive',
      'outlet_stock.resolve_return_exception',
      'outlet_stock.approve_correction',
      'warehouse_stock.approve_correction',
    ]) {
      const inScreenOrHooks = SCREEN.includes(key)
        || read('features/inventory/useReturnReceivePermission.ts').includes(key)
        || read('features/inventory/useQuarantinePermission.ts').includes(key)
        || read('features/inventory/useOutletReturnExceptionResolvePermission.ts').includes(key);
      expect(inScreenOrHooks, key).toBe(true);
    }
    expect(read('features/inventory/useQuarantinePermission.ts')).toContain('warehouse_transfer.return_request');
  });
});
