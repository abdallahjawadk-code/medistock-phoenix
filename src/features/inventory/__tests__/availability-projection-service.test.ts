/**
 * INVENTORY-DERIVED-AVAILABILITY-083 — client projection service.
 *
 * The RPC's server behaviour (derives from canonical outlet_stock, excludes
 * expired from usable, forbidden==nonexistent, no double counting) is proven
 * dynamically in supabase/migrations/__tests__/083-availability-projection.dynamic.test.ts.
 * Here we prove the CLIENT wrapper: it maps the payload faithfully, coerces
 * bigint-as-string sums, presents the same empty shape for the empty/forbidden
 * cases, never writes, and propagates a real RPC error.
 *
 * The transport is injected, so this needs no live database.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  getAvailableStock,
  mapAvailableStock,
  type AvailabilityProjectionRpc,
  type RawAvailableStockPayload,
} from '../availability-projection.service';

const fakeRpc = (payload: RawAvailableStockPayload | null, error: { message?: string } | null = null): AvailabilityProjectionRpc =>
  vi.fn(async () => ({ data: payload, error }));

const DP = '00000000-0000-0000-0000-0000000ab301';

describe('mapAvailableStock — faithful, defensive payload mapping', () => {
  it('maps a populated projection to camelCase, coercing bigint-as-string sums', () => {
    const res = mapAvailableStock({
      ok: true,
      distribution_point_id: DP,
      source: 'canonical_projection',
      items: [{
        scientific_name: 'Amoxicillin', trade_name: 'Amoxil', concentration: '500mg',
        dosage_form: 'capsule', national_code: 'NC1', batch_number: 'B1', expiry_date: '2027-05-01',
        on_hand_quantity: '30', available_quantity: '25', usable_quantity: '25',
        condition: 'available', is_usable: true,
      }],
    });
    expect(res.ok).toBe(true);
    expect(res.distributionPointId).toBe(DP);
    expect(res.source).toBe('canonical_projection');
    expect(res.items).toHaveLength(1);
    const it0 = res.items[0];
    expect(it0.onHandQuantity).toBe(30);       // number, not '30'
    expect(it0.availableQuantity).toBe(25);
    expect(it0.usableQuantity).toBe(25);
    expect(it0.scientificName).toBe('Amoxicillin');
    expect(it0.isUsable).toBe(true);
  });

  it('carries an expired lot through with usable 0 and isUsable false', () => {
    const res = mapAvailableStock({
      items: [{
        scientific_name: 'X', trade_name: null, concentration: null, dosage_form: null,
        national_code: null, batch_number: 'BX', expiry_date: '2020-01-01',
        on_hand_quantity: 40, available_quantity: 40, usable_quantity: 0,
        condition: 'expired', is_usable: false,
      }],
    });
    expect(res.items[0].usableQuantity).toBe(0);
    expect(res.items[0].isUsable).toBe(false);
    expect(res.items[0].condition).toBe('expired');
  });

  it('maps a malformed/empty payload to the empty shape instead of throwing', () => {
    expect(mapAvailableStock(null).items).toEqual([]);
    expect(mapAvailableStock(undefined).items).toEqual([]);
    expect(mapAvailableStock({} as RawAvailableStockPayload).items).toEqual([]);
    expect(mapAvailableStock({ items: null }).items).toEqual([]);
  });
});

describe('getAvailableStock — thin, read-only wrapper over the injected RPC', () => {
  it('calls phoenix_available_stock with the point id and returns the mapped result', async () => {
    const rpc = fakeRpc({
      ok: true, distribution_point_id: DP, source: 'canonical_projection',
      items: [{
        scientific_name: 'Ceftriaxone', trade_name: null, concentration: null, dosage_form: null,
        national_code: null, batch_number: 'RB', expiry_date: '2027-09-01',
        on_hand_quantity: 25, available_quantity: 25, usable_quantity: 25,
        condition: 'available', is_usable: true,
      }],
    });
    const res = await getAvailableStock(DP, rpc);
    expect(rpc).toHaveBeenCalledWith('phoenix_available_stock', { p_distribution_point_id: DP });
    expect(res.items[0].scientificName).toBe('Ceftriaxone');
    expect(res.items[0].usableQuantity).toBe(25);
  });

  it('returns the empty shape (no RPC call) when no point id is supplied', async () => {
    const rpc = fakeRpc({ items: [] });
    const res = await getAvailableStock('', rpc);
    expect(res.items).toEqual([]);
    expect(res.distributionPointId).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('presents the forbidden/nonexistent empty projection identically', async () => {
    // The RPC returns the same empty body for a forbidden and a nonexistent point.
    const rpc = fakeRpc({ ok: true, distribution_point_id: null, source: 'canonical_projection', items: [] });
    const res = await getAvailableStock(DP, rpc);
    expect(res.ok).toBe(true);
    expect(res.items).toEqual([]);
    expect(res.distributionPointId).toBeNull();
  });

  it('propagates a genuine RPC error instead of swallowing it', async () => {
    const rpc = fakeRpc(null, { message: 'boom' });
    await expect(getAvailableStock(DP, rpc)).rejects.toEqual({ message: 'boom' });
  });
});

describe('the projection service never writes', () => {
  it('holds no write verb — it is a read projection by construction', () => {
    const src = readFileSync(join(__dirname, '..', 'availability-projection.service.ts'), 'utf8');
    expect(src).not.toContain('upsertAvailability');
    expect(src).not.toContain('applyAvailabilityMovement');
    // the only RPC name this module names is the read projection
    const rpcNames = [...src.matchAll(/'(phoenix_[a-z_]+)'/g)].map(m => m[1]);
    expect([...new Set(rpcNames)]).toEqual(['phoenix_available_stock']);
    // no PostgREST table-write verb anywhere in the module
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
});
