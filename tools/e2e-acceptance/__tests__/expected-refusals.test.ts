/**
 * EXPECTED-DOMAIN-REFUSAL WINDOW — harness guard.
 *
 * The acceptance harness may drop the browser's generic
 * "Failed to load resource … status of 400" console line for a refusal a step
 * deliberately provoked. That allowance is the only thing standing between a
 * proved business rule and a silenced regression, so it is proved here rather
 * than trusted: the window must be genuinely temporary, exact, and never able
 * to hide a 5xx.
 *
 * Pure unit test over tools/e2e-acceptance/expected-refusals.mjs — no browser,
 * no database, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  createExpectedRefusalRegistry,
  rpcNameFromUrl,
  isGeneric4xxConsoleLine,
} from '../expected-refusals.mjs';

const RPC = 'phoenix_replenish_emergency_outlet';
const MSG = 'initial_provisioning_required_before_replenishment';
const URL = `http://127.0.0.1:54321/rest/v1/rpc/${RPC}`;
const LINE_400 = 'Failed to load resource: the server responded with a status of 400 (Bad Request)';
const LINE_500 = 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)';
const BODY = `{"code":"23514","details":null,"hint":null,"message":"${MSG}"}`;

describe('url and console-line parsing', () => {
  it('reads the RPC name out of a Supabase REST url, ignoring query and hash', () => {
    expect(rpcNameFromUrl(URL)).toBe(RPC);
    expect(rpcNameFromUrl(`${URL}?select=*`)).toBe(RPC);
    expect(rpcNameFromUrl(`${URL}#frag`)).toBe(RPC);
    expect(rpcNameFromUrl('http://127.0.0.1:54321/rest/v1/outlet_stock?select=*')).toBeNull();
    expect(rpcNameFromUrl(undefined)).toBeNull();
  });

  it('recognises only the generic 4xx resource line', () => {
    expect(isGeneric4xxConsoleLine(LINE_400)).toBe(true);
    expect(isGeneric4xxConsoleLine(LINE_500)).toBe(false);
    expect(isGeneric4xxConsoleLine('TypeError: x is not a function')).toBe(false);
    expect(isGeneric4xxConsoleLine(undefined)).toBe(false);
  });
});

describe('1. an ACTIVE window admits the deliberate refusal', () => {
  it('suppresses the generic 4xx line for that RPC and records the evidence', () => {
    const reg = createExpectedRefusalRegistry();
    const refusal = reg.expectRefusal(RPC, MSG);

    expect(reg.suppressesConsoleError(LINE_400, URL)).toBe(true);

    const recorded = reg.recordResponse({ url: URL, status: 400, body: BODY });
    expect(recorded).toMatchObject({ rpc: RPC, message: MSG, status: 400 });
    expect(refusal.observed()).toHaveLength(1);
    expect(refusal.observed()[0].status).toBe(400);
    expect(refusal.isActive()).toBe(true);
  });

  it('never suppresses a DIFFERENT rpc, even while a window is open', () => {
    const reg = createExpectedRefusalRegistry();
    reg.expectRefusal(RPC, MSG);
    const other = 'http://127.0.0.1:54321/rest/v1/rpc/phoenix_create_warehouse_dispatch';
    expect(reg.suppressesConsoleError(LINE_400, other)).toBe(false);
    expect(reg.recordResponse({ url: other, status: 400, body: BODY })).toBeNull();
  });
});

describe('2. after close() the RPC is policed again', () => {
  it('stops suppressing the generic 4xx line for that same RPC', () => {
    const reg = createExpectedRefusalRegistry();
    const refusal = reg.expectRefusal(RPC, MSG);
    expect(reg.suppressesConsoleError(LINE_400, URL)).toBe(true);

    refusal.close();

    // This is the whole point of the fix: the allowance is a window, not a
    // page-lifetime whitelist.
    expect(refusal.isActive()).toBe(false);
    expect(reg.suppressesConsoleError(LINE_400, URL)).toBe(false);
    expect(reg.activeRegistrations()).toEqual([]);
  });

  it('stops recording — a later identical refusal is no longer counted as proof', () => {
    const reg = createExpectedRefusalRegistry();
    const refusal = reg.expectRefusal(RPC, MSG);
    reg.recordResponse({ url: URL, status: 400, body: BODY });
    refusal.close();

    reg.recordResponse({ url: URL, status: 400, body: BODY });
    expect(refusal.observed()).toHaveLength(1);
  });

  it('closing one window does not open or close another', () => {
    const reg = createExpectedRefusalRegistry();
    const a = reg.expectRefusal(RPC, MSG);
    const b = reg.expectRefusal('phoenix_create_warehouse_dispatch', 'emergency_outlet_requires_initial_provisioning');
    a.close();
    expect(reg.suppressesConsoleError(LINE_400, URL)).toBe(false);
    expect(reg.suppressesConsoleError(LINE_400, 'http://h/rest/v1/rpc/phoenix_create_warehouse_dispatch')).toBe(true);
    expect(b.isActive()).toBe(true);
    expect(reg.activeRegistrations()).toEqual([
      { rpc: 'phoenix_create_warehouse_dispatch', message: 'emergency_outlet_requires_initial_provisioning' },
    ]);
  });
});

describe('3. a different error is never recorded as the expected refusal', () => {
  it('ignores another SQLSTATE / another domain message from the same RPC', () => {
    const reg = createExpectedRefusalRegistry();
    const refusal = reg.expectRefusal(RPC, MSG);

    for (const body of [
      '{"code":"42501","message":"forbidden_outlet_stock_replenish"}',
      '{"code":"23514","message":"route_not_active"}',
      '{"code":"23505","message":"request_id_conflict"}',
      '',
    ]) {
      expect(reg.recordResponse({ url: URL, status: 400, body })).toBeNull();
    }
    expect(refusal.observed()).toEqual([]);
  });

  it('a step asserting observed() therefore fails when the wrong rule fired', () => {
    const reg = createExpectedRefusalRegistry();
    const refusal = reg.expectRefusal(RPC, MSG);
    reg.recordResponse({ url: URL, status: 400, body: '{"message":"route_not_active"}' });
    // The negative step's own assertion is `observed().length > 0`.
    expect(refusal.observed().length > 0).toBe(false);
  });
});

describe('4. a 5xx is NEVER suppressed and NEVER recorded', () => {
  it('holds even while a window for that exact RPC is open', () => {
    const reg = createExpectedRefusalRegistry();
    const refusal = reg.expectRefusal(RPC, MSG);

    expect(reg.suppressesConsoleError(LINE_500, URL)).toBe(false);
    // Even a 5xx whose body happens to carry the expected message.
    expect(reg.recordResponse({ url: URL, status: 500, body: BODY })).toBeNull();
    expect(reg.recordResponse({ url: URL, status: 503, body: BODY })).toBeNull();
    expect(refusal.observed()).toEqual([]);
  });
});

describe('5. registration is fail-closed', () => {
  it('refuses a registration without both an RPC and an exact message', () => {
    const reg = createExpectedRefusalRegistry();
    expect(() => reg.expectRefusal('', MSG)).toThrow(/requires an RPC name/);
    expect(() => reg.expectRefusal(RPC, '')).toThrow(/exact expected error/);
  });

  it('suppresses nothing at all when no window was ever opened', () => {
    const reg = createExpectedRefusalRegistry();
    expect(reg.suppressesConsoleError(LINE_400, URL)).toBe(false);
    expect(reg.recordResponse({ url: URL, status: 400, body: BODY })).toBeNull();
    expect(reg.activeRegistrations()).toEqual([]);
  });
});
