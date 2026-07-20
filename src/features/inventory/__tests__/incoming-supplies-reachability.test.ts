/**
 * §1 RECEIVER REACHABILITY — the institution incoming-supplies receipt is
 * reachable by a warehouse_transfer.receive holder through the Institution
 * Inventory Center, independent of warehouse_transfer.send, and it is the single
 * authoritative receive-mutation entry.
 *
 * Static source assertions (repo convention — no React test renderer wired up).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const center = read('inventory/InventoryCenterScreen.tsx');
const operations = read('network/DirectSupplyOperations.tsx');

describe('Inventory Center is the authoritative receive entry (receive-gated)', () => {
  it('mounts InstitutionIncomingSupplies behind a warehouse_transfer.receive gate', () => {
    expect(center).toMatch(/import \{ InstitutionIncomingSupplies \}/);
    expect(center).toMatch(/const canReceive = role === 'super_admin' \|\| myPermissions\.has\('warehouse_transfer\.receive'\)/);
    expect(center).toMatch(/<InstitutionIncomingSupplies/);
  });

  it('the incoming tab is offered only to receive holders — not gated on .send', () => {
    expect(center).toMatch(/canReceive \? \[\{ id: 'incoming'/);
    // The gate is the RECEIVE permission, never the send permission.
    expect(center).not.toMatch(/myPermissions\.has\('warehouse_transfer\.send'\)/);
  });

  it('receives into the officer\'s own scoped warehouse (scope isolation)', () => {
    // destinationWarehouseId is the manageable-scope warehouse the officer selected;
    // the RPC + RLS re-check the scope, so another institution is unreachable.
    expect(center).toMatch(/destinationWarehouseId=\{activeWarehouseId\}/);
    expect(center).toMatch(/canReceive=\{canReceive\}/);
  });
});

describe('exactly one authoritative receive-mutation entry', () => {
  it('the Network Supply tab receiver is read-only (send-only actor cannot receive)', () => {
    expect(operations).toMatch(/const canReceive = false/);
  });
});
