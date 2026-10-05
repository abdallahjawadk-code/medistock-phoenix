/**
 * PRE3-A (acceptance 8) — an identity that has no registered central item can
 * never become a `mapped` target.
 *
 * Historical stock identities (`material_identity_key`) are mostly
 * uncatalogued: central intake after M126 forbids a central_item_id, so such a
 * lot carries `central_item_id = NULL`. Even if the shared resolver ever hands
 * one back, `searchCentralItems` — the only candidate source both Annual Needs
 * presentations use for a `mapped` decision — must drop it, together with any
 * catalog row that is not active and selectable.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedMaterial } from '@/shared/materials/material-resolver.service';

const resolveMaterials = vi.fn();
vi.mock('@/shared/materials/material-resolver.service', () => ({
  resolveMaterials: (...a: unknown[]) => resolveMaterials(...a),
}));
vi.mock('@/shared/supabase/client', () => ({
  supabase: { from: () => { throw new Error('searchCentralItems must not read tables directly'); } },
  supabaseConfigured: true,
}));

const { searchCentralItems } = await import('../central-needs.service');

function resolved(over: Partial<ResolvedMaterial> & { active?: boolean; selectable?: boolean }): ResolvedMaterial {
  const { active = true, selectable = true, ...rest } = over;
  const base: ResolvedMaterial = {
    source: 'catalog', centralItemId: 'ci-1', warehouseStockId: null,
    scientificName: 'Amoxicillin', nameAr: null, tradeName: null, concentration: null, dosageForm: null,
    unit: 'capsule', nationalCode: null, barcode: null, batchNumber: null, expiryDate: null,
    onHand: null, reserved: null, available: null, supplyType: null, grade: 'strong', reasonKey: 'mr_reason_name_exact',
    canonical: {
      identity: { centralItemId: 'ci-1', materialIdentityKey: null, warehouseStockId: null, outletStockId: null },
      scope: { kind: 'catalog' },
      display: { scientificName: 'Amoxicillin', tradeName: null, concentration: null, dosageForm: null, unit: 'capsule', nationalCode: null, batchNumber: null, expiryDate: null },
      eligibility: { selectable, active, availableQuantity: null, expired: null, blockedReasonKey: null },
    },
  };
  return { ...base, ...rest };
}

describe('PRE3-A — only a registered, active catalog item is ever a mapping candidate', () => {
  it('8 · drops a historical stock identity without a central item, an inactive row and an unselectable row', async () => {
    resolveMaterials.mockResolvedValue([
      // A historical lot: identity key, no catalog link.
      resolved({
        source: 'stock', centralItemId: null, warehouseStockId: 'ws-1',
        canonical: {
          identity: { centralItemId: null, materialIdentityKey: 'v1|central=N|sci=11:amoxicillin', warehouseStockId: 'ws-1', outletStockId: null },
          scope: { kind: 'catalog' },
          display: { scientificName: 'Amoxicillin', tradeName: null, concentration: null, dosageForm: null, unit: 'capsule', nationalCode: null, batchNumber: 'B1', expiryDate: null },
          eligibility: { selectable: true, active: true, availableQuantity: 10, expired: false, blockedReasonKey: null },
        },
      }),
      // A stock lot that does carry a catalog link is still not a catalog candidate.
      resolved({ source: 'stock', centralItemId: 'ci-lot', warehouseStockId: 'ws-2' }),
      resolved({ centralItemId: 'ci-inactive', active: false, selectable: false }),
      resolved({ centralItemId: 'ci-unselectable', selectable: false }),
      resolved({ centralItemId: '' }),
      resolved({ centralItemId: 'ci-ok' }),
    ]);
    const options = await searchCentralItems('Amoxicillin');
    expect(options.map((o) => o.id)).toEqual(['ci-ok']);
  });

  it('asks the resolver for the internal, catalog-only view: no warehouse scope, so no stock lot is even requested', async () => {
    resolveMaterials.mockResolvedValue([]);
    await searchCentralItems('Amoxicillin', 7);
    expect(resolveMaterials).toHaveBeenLastCalledWith('Amoxicillin', { audience: 'internal', limit: 7 });
  });
});
