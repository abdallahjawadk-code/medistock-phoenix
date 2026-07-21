/**
 * WAREHOUSE-INTAKE SAFETY GATE — migration-065 accumulating-receipt concurrency.
 *
 * These tests pin the HARD pre-deployment blocker: the manual accumulating
 * receipt / additive movement must fail closed in a production build until the
 * server gains an expected-generation precondition. The most important claim is
 * behavioural — a closed gate calls NO writer — proven by injecting a spy
 * transport, so it cannot be satisfied by a passing manual run.
 *
 * See docs/blocker-migration-065-accumulating-receipt-concurrency.md.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  warehouseIntakeAllowed,
  defaultWarehouseIntakeAllowed,
  MIGRATION_065_CONCURRENCY_RESOLVED,
  MIGRATION_065_CONCURRENCY_BLOCKER,
  WAREHOUSE_INTAKE_BLOCKED_CODE,
} from '../warehouse-intake-safety';
import {
  receiveWarehouseStock,
  applyWarehouseStockMovement,
  classifyIntakeError,
  type ReceiveWarehouseStockInput,
  type ApplyWarehouseStockMovementInput,
} from '../warehouse-intake.service';

const receiveInput: ReceiveWarehouseStockInput = {
  requestId: 'req-1', warehouseId: 'wh-1', scientificName: 'Amoxicillin',
  quantity: 30, hasNoNationalCode: false, hasNoBatchNumber: false,
};
const movementInput: ApplyWarehouseStockMovementInput = {
  requestId: 'req-2', warehouseStockId: 'ws-1', movementType: 'add', amount: 10,
};

describe('the gate is a pure decision over (isProd, blockerResolved)', () => {
  it('is closed only in a production build with the blocker unresolved', () => {
    expect(warehouseIntakeAllowed({ isProd: true, blockerResolved: false })).toBe(false);
    // Every other combination is open: dev/test always, prod once resolved.
    expect(warehouseIntakeAllowed({ isProd: false, blockerResolved: false })).toBe(true);
    expect(warehouseIntakeAllowed({ isProd: true, blockerResolved: true })).toBe(true);
    expect(warehouseIntakeAllowed({ isProd: false, blockerResolved: true })).toBe(true);
  });
});

describe('the blocker is registered and unresolved', () => {
  it('names a stable marker for the pre-deployment safety scan', () => {
    expect(MIGRATION_065_CONCURRENCY_BLOCKER)
      .toBe('PHOENIX_BLOCKER_MIGRATION_065_ACCUMULATING_RECEIPT_CONCURRENCY');
  });

  it('is still unresolved — this pin must be flipped only alongside the migration', () => {
    expect(MIGRATION_065_CONCURRENCY_RESOLVED).toBe(false);
  });

  it('INVARIANT: while unresolved, a production build can never enable the path', () => {
    // The property that actually protects deployment, expressed against the live
    // constant rather than a literal, so it keeps holding if the pin ever moves.
    expect(warehouseIntakeAllowed({ isProd: true, blockerResolved: MIGRATION_065_CONCURRENCY_RESOLVED }))
      .toBe(MIGRATION_065_CONCURRENCY_RESOLVED);
  });

  it('is OPEN in the current build (dev/test), so the feature stays buildable', () => {
    expect(defaultWarehouseIntakeAllowed()).toBe(true);
  });
});

describe('a closed gate fails the write closed and calls no writer', () => {
  const closed = () => false;

  it('receiveWarehouseStock refuses without touching the transport', async () => {
    const transport = vi.fn();
    const result = await receiveWarehouseStock(receiveInput, {
      allowed: closed, callRpc: transport as never,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(WAREHOUSE_INTAKE_BLOCKED_CODE);
    expect(transport).not.toHaveBeenCalled();
  });

  it('applyWarehouseStockMovement refuses without touching the transport', async () => {
    const transport = vi.fn();
    const result = await applyWarehouseStockMovement(movementInput, {
      allowed: closed, callRpc: transport as never,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(WAREHOUSE_INTAKE_BLOCKED_CODE);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('an open gate reaches the writer with the right RPC and request id', () => {
  const open = () => true;
  const okTransport = () =>
    vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ ok: true, data: {} as never }));

  it('receiveWarehouseStock calls the receipt RPC exactly once', async () => {
    const transport = okTransport();
    await receiveWarehouseStock(receiveInput, { allowed: open, callRpc: transport as never });
    expect(transport).toHaveBeenCalledTimes(1);
    const [fn, args] = transport.mock.calls[0];
    // Migration 078: the client now calls the GUARDED entry point, which enforces
    // the expected-generation precondition and delegates to the 065 RPC.
    expect(fn).toBe('phoenix_receive_warehouse_stock_guarded');
    expect((args as { p_request_id: string }).p_request_id).toBe('req-1');
  });

  it('applyWarehouseStockMovement calls the movement RPC exactly once', async () => {
    const transport = okTransport();
    await applyWarehouseStockMovement(movementInput, { allowed: open, callRpc: transport as never });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe('phoenix_apply_warehouse_stock_movement_guarded');
  });
});

describe('the blocked code is a first-class classified error', () => {
  it('maps to the safety i18n key, not the generic fallback', () => {
    expect(classifyIntakeError(WAREHOUSE_INTAKE_BLOCKED_CODE)).toBe('inv_err_blocked_concurrency');
  });
});
