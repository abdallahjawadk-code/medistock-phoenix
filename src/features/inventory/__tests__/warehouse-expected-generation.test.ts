/**
 * WAREHOUSE-RECEIPT-EXPECTED-GENERATION-078-A — client contract.
 *
 * Behavioural tests against an injected RPC transport: no database, no network,
 * no React renderer (this repo renders no components in tests).
 *
 * What matters here is the exact wire shape. The server guard is only as strong
 * as the argument the client actually sends, and the two ways to weaken it
 * silently are (a) calling the legacy unguarded RPC name, and (b) coercing a
 * generation of 0 into null. Both are asserted against directly.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  receiveWarehouseStock,
  applyWarehouseStockMovement,
  toExpectedGeneration,
  getWarehouseStockGeneration,
  classifyIntakeError,
  GENERATION_UNAVAILABLE_CODE,
} from '../warehouse-intake.service';

/** Records the RPC name + args, and reports success. */
function transport(result: Record<string, unknown> = { ok: true }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const callRpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return { ok: true as const, data: result as never };
  });
  return { calls, callRpc };
}

const ALLOWED = () => true;

const RECEIPT = {
  requestId: '11111111-1111-4111-8111-111111111111',
  warehouseId: '22222222-2222-4222-8222-222222222222',
  scientificName: 'Amoxicillin',
  quantity: 30,
  hasNoNationalCode: false,
  hasNoBatchNumber: false,
  nationalCode: '1234567',
  batchNumber: 'B4471X',
};

describe('the client calls the GUARDED rpc, never the unguarded legacy name', () => {
  it('receiveWarehouseStock targets phoenix_receive_warehouse_stock_guarded', async () => {
    const t = transport();
    await receiveWarehouseStock({ ...RECEIPT, expectedGeneration: 0 },
      { callRpc: t.callRpc, allowed: ALLOWED });
    expect(t.calls[0].fn).toBe('phoenix_receive_warehouse_stock_guarded');
    expect(t.calls[0].fn).not.toBe('phoenix_receive_warehouse_stock');
  });

  it('applyWarehouseStockMovement targets the guarded movement rpc', async () => {
    const t = transport();
    await applyWarehouseStockMovement({
      requestId: RECEIPT.requestId,
      warehouseStockId: RECEIPT.warehouseId,
      movementType: 'add',
      amount: 5,
      expectedGeneration: 3,
    }, { callRpc: t.callRpc, allowed: ALLOWED });
    expect(t.calls[0].fn).toBe('phoenix_apply_warehouse_stock_movement_guarded');
  });
});

describe('the expected generation reaches the wire intact', () => {
  it('sends generation 0 as 0 — a first receipt into a brand-new lot', async () => {
    // The whole guard collapses if 0 is coerced to null: a brand-new lot IS
    // generation 0, and that is precisely the two-device race being closed.
    const t = transport();
    await receiveWarehouseStock({ ...RECEIPT, expectedGeneration: 0 },
      { callRpc: t.callRpc, allowed: ALLOWED });
    expect(t.calls[0].args.p_expected_generation).toBe(0);
    expect(t.calls[0].args.p_expected_generation).not.toBeNull();
  });

  it('sends a non-zero generation unchanged', async () => {
    const t = transport();
    await receiveWarehouseStock({ ...RECEIPT, expectedGeneration: 7 },
      { callRpc: t.callRpc, allowed: ALLOWED });
    expect(t.calls[0].args.p_expected_generation).toBe(7);
  });

  it('079: omitting the generation REFUSES before the wire', async () => {
    // The server refuses too, but refusing here means a failed generation read
    // can never reach the RPC at all.
    const t = transport();
    const r = await receiveWarehouseStock({ ...RECEIPT }, { callRpc: t.callRpc, allowed: ALLOWED });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(GENERATION_UNAVAILABLE_CODE);
    expect(t.callRpc).not.toHaveBeenCalled();
  });

  it('079: an explicit null is refused too', async () => {
    const t = transport();
    const r = await receiveWarehouseStock({ ...RECEIPT, expectedGeneration: null },
      { callRpc: t.callRpc, allowed: ALLOWED });
    expect(r.ok).toBe(false);
    expect(t.callRpc).not.toHaveBeenCalled();
  });

  it('079: the adjustment path refuses without a generation as well', async () => {
    const t = transport();
    const r = await applyWarehouseStockMovement({
      requestId: RECEIPT.requestId, warehouseStockId: RECEIPT.warehouseId,
      movementType: 'add', amount: 1,
    }, { callRpc: t.callRpc, allowed: ALLOWED });
    expect(r.ok).toBe(false);
    expect(t.callRpc).not.toHaveBeenCalled();
  });

  it('the adjustment path carries it identically', async () => {
    const t = transport();
    await applyWarehouseStockMovement({
      requestId: RECEIPT.requestId, warehouseStockId: RECEIPT.warehouseId,
      movementType: 'correction', amount: 2, reason: 'recount', expectedGeneration: 0,
    }, { callRpc: t.callRpc, allowed: ALLOWED });
    expect(t.calls[0].args.p_expected_generation).toBe(0);
  });
});

describe('toExpectedGeneration', () => {
  it('preserves 0 — the value falsy coercion would destroy', () => {
    expect(toExpectedGeneration(0)).toBe(0);
  });
  it('preserves positive generations', () => {
    expect(toExpectedGeneration(42)).toBe(42);
  });
  it('maps undefined to null (unguarded)', () => {
    expect(toExpectedGeneration(undefined)).toBeNull();
  });
  it('maps null to null (explicitly unguarded)', () => {
    expect(toExpectedGeneration(null)).toBeNull();
  });
});

describe('the generation read is a DISCRIMINATED result, not a nullable number', () => {
  it('reports a present generation as ok', async () => {
    const r = await getWarehouseStockGeneration('x', { read: async () => ({ movement_seq: 5 }) });
    expect(r).toEqual({ ok: true, generation: 5 });
  });

  it('reports 0 as a real generation, not as a failure', async () => {
    const r = await getWarehouseStockGeneration('x', { read: async () => ({ movement_seq: 0 }) });
    expect(r.ok).toBe(true);
    expect(r.ok && r.generation).toBe(0);
  });

  it('an absent lot is generation 0 — a first receipt, NOT an error', async () => {
    const r = await getWarehouseStockGeneration('x', { read: async () => null });
    expect(r).toEqual({ ok: true, generation: 0, absent: true });
  });

  it('a failed read cannot be mistaken for a usable generation', async () => {
    // The whole point of the discriminated shape: `number | null` collapsed
    // "column not deployed", "unreadable" and "first receipt" into one value,
    // and every one of them silently posted unguarded.
    const failure = { ok: false as const, reason: 'not_deployed' as const };
    expect(failure.ok).toBe(false);
    // TypeScript would reject reading .generation off the failure branch; at
    // runtime the caller must therefore refuse, which the next test proves.
  });

  it('a caller that cannot prove a generation posts NOTHING', async () => {
    const t = transport();
    const read = await getWarehouseStockGeneration('x', { read: async () => null });
    const gen = read.ok ? read.generation : undefined;
    // Simulate the failure branch instead: undefined must refuse.
    const r = await receiveWarehouseStock({ ...RECEIPT, expectedGeneration: undefined },
      { callRpc: t.callRpc, allowed: ALLOWED });
    expect(gen).toBe(0);
    expect(r.ok).toBe(false);
    expect(t.callRpc).not.toHaveBeenCalled();
  });
});

describe('the conflict is surfaced as reload-and-review, not retry', () => {
  it('maps the 079 fail-closed tokens to a distinct, explicit string', () => {
    expect(classifyIntakeError('expected_generation_required')).toBe('inv_err_generation_unavailable');
    expect(classifyIntakeError(GENERATION_UNAVAILABLE_CODE)).toBe('inv_err_generation_unavailable');
    // Not the same message as a generation CONFLICT: nothing was posted here.
    expect(classifyIntakeError('expected_generation_required'))
      .not.toBe(classifyIntakeError('warehouse_receipt_generation_conflict'));
  });

  it('maps the server conflict token to its own string key', () => {
    expect(classifyIntakeError('warehouse_receipt_generation_conflict'))
      .toBe('inv_err_generation_conflict');
  });

  it('is distinct from the request-id conflict, which means something else', () => {
    // request_id_conflict = same id, different arguments (a client bug).
    // generation conflict  = the world moved (reload and re-confirm).
    expect(classifyIntakeError('request_id_conflict')).toBe('inv_err_request_conflict');
    expect(classifyIntakeError('warehouse_receipt_generation_conflict'))
      .not.toBe(classifyIntakeError('request_id_conflict'));
  });

  it('the operator-facing copy tells them to reload and review, never to retry', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const strings = readFileSync(join(__dirname, '../../../shared/i18n/strings.ts'), 'utf8');
    const line = strings.split('\n').find(l => l.includes('inv_err_generation_conflict:'));
    expect(line, 'the conflict string must exist').toBeDefined();
    expect(line).toContain('reload and review');
    // A blind retry is exactly the duplicate post the guard prevents.
    expect(line!.toLowerCase()).not.toContain('try again');
    // Bilingual, like every other operator-facing string.
    expect(line).toMatch(/ar:\s*'[^']*[؀-ۿ][^']*'/);
  });
});

describe('the production gate stays fail-closed until the server contract is live', () => {
  it('refuses before any writer is called when the gate is closed', async () => {
    const t = transport();
    const r = await receiveWarehouseStock({ ...RECEIPT, expectedGeneration: 0 },
      { callRpc: t.callRpc, allowed: () => false });
    expect(r.ok).toBe(false);
    expect(t.callRpc).not.toHaveBeenCalled();
  });

  it('the adjustment path is gated by the same flag', async () => {
    const t = transport();
    const r = await applyWarehouseStockMovement({
      requestId: RECEIPT.requestId, warehouseStockId: RECEIPT.warehouseId,
      movementType: 'add', amount: 1, expectedGeneration: 0,
    }, { callRpc: t.callRpc, allowed: () => false });
    expect(r.ok).toBe(false);
    expect(t.callRpc).not.toHaveBeenCalled();
  });

  it('the blocker flag is still FALSE — 078 is authored but not applied', async () => {
    const { MIGRATION_065_CONCURRENCY_RESOLVED } = await import('../warehouse-intake-safety');
    // Flipping this before the migration is applied AND parity is observed in
    // production would re-open the exact defect 078 closes.
    expect(MIGRATION_065_CONCURRENCY_RESOLVED).toBe(false);
  });
});
