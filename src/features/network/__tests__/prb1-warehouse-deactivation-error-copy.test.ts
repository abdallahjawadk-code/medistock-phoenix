/**
 * PRB-1 · WAREHOUSE-DEACTIVATION-UX — A SPECIFIC REFUSAL DESERVES A SPECIFIC
 * MESSAGE.
 *
 * Migration 183 refuses to deactivate a warehouse that an ACTIVE crash cabinet
 * or rescue cart still depends on:
 *
 *     RAISE EXCEPTION 'emergency_outlet_warehouse_deactivation_blocked_by_active_outlet'
 *       USING ERRCODE = '23514', DETAIL = '...'
 *
 * The operator saw only "The operation could not be completed", and TWO layers
 * were responsible — fixing either one alone leaves the defect standing:
 *
 *   1. NORMALIZATION. network.service's rpcErrorCode keeps the head of the
 *      message and requires /^[A-Z0-9_]+$/, because the 074/075/076 RPC bodies
 *      raise 'UPPER_SNAKE: human message'. This refusal comes from a schema
 *      TRIGGER, which raises a bare lower_snake token with no colon — so the
 *      token failed the shape test and was discarded as 'unknown_error' before
 *      any mapper ever saw it.
 *
 *   2. MAPPING. networkErrorMessage matches by substring against a ladder of
 *      shapes (CROSS_ORG, EXISTS, CONFLICT, INVALID, …). This token matches
 *      none of them and fell through to the generic tail.
 *
 * The database guard is UNCHANGED. Only the client's reading of its answer is.
 *
 * Live proof that the token, the SQLSTATE and the surrounding lifecycle
 * behaviour are exactly as asserted here — including that standing the cart
 * down lets the deactivation through — is in the PRB-1 deactivation evidence
 * captured against the real database.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkErrorMessage } from '../NetworkManagementScreen';
import { T } from '@/shared/i18n/strings';

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const M183 = read('supabase/migrations/183_phoenix_emergency_outlet_integrity.sql');
const SERVICE_SRC = read('src/features/network/network.service.ts');

/** The token exactly as migration 183 raises it — never retyped by hand. */
const TOKEN = (() => {
  const m = /RAISE EXCEPTION '(emergency_outlet_warehouse_deactivation_blocked_by_active_outlet)'/.exec(M183);
  expect(m, 'migration 183 must still raise this refusal').not.toBeNull();
  return m![1];
})();

// ───────────────────────────────────────────────────────────────────────────
// D1 · The refusal reaches the operator as its own actionable message.
// ───────────────────────────────────────────────────────────────────────────

describe('WAREHOUSE-DEACTIVATION-UX · the blocked-by-emergency-outlet refusal', () => {
  it('the migration still raises it as a CHECK violation with an explanatory DETAIL', () => {
    const at = M183.indexOf(`RAISE EXCEPTION '${TOKEN}'`);
    const stanza = M183.slice(at, at + 400);
    expect(stanza).toContain("ERRCODE = '23514'");
    expect(stanza).toContain('DETAIL =');
    expect(stanza).toContain('crash cabinet or rescue cart');
  });

  it('D1 · maps to dedicated copy, not the generic fallback, in English', () => {
    const msg = networkErrorMessage(TOKEN, 'en');
    expect(msg).toBe(T.net_err_wh_deactivate_blocked_emergency_outlet.en);
    expect(msg).not.toBe(T.net_err_generic.en);
  });

  it('D1 · maps to dedicated copy in Arabic', () => {
    const msg = networkErrorMessage(TOKEN, 'ar');
    expect(msg).toBe(T.net_err_wh_deactivate_blocked_emergency_outlet.ar);
    expect(msg).not.toBe(T.net_err_generic.ar);
  });

  it('the copy names the dependency AND the way out, in both languages', () => {
    const en = T.net_err_wh_deactivate_blocked_emergency_outlet.en;
    expect(en).toMatch(/emergency outlet/i);
    expect(en).toMatch(/stand down|reassign/i);
    const ar = T.net_err_wh_deactivate_blocked_emergency_outlet.ar;
    expect(ar).toContain('منفذ طوارئ');
    expect(ar).toContain('إلغاء تفعيل');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D4 · No unrelated refusal may inherit this copy.
// ───────────────────────────────────────────────────────────────────────────

describe('WAREHOUSE-DEACTIVATION-UX · the mapping is exact, never a family match', () => {
  const UNRELATED = [
    // Same RPC, same SQLSTATE class, completely different situation.
    'WAREHOUSE_ARCHIVED',
    'WAREHOUSE_NOT_FOUND',
    'NOT_AUTHORIZED_WAREHOUSE_MANAGE',
    // The health-sector sibling guard (migration 181) — a DIFFERENT refusal
    // with a different remedy, deliberately left on its own path.
    'health_center_depot_deactivation_blocked_by_active_outlet',
    // Adjacent emergency-outlet vocabulary that is not this refusal.
    'emergency_outlet_requires_active_warehouse',
    'emergency_outlet_requires_owning_warehouse',
    'rescue_cart_requires_emergency_context',
    'unknown_error',
    undefined,
  ];

  UNRELATED.forEach(code => {
    it(`${code ?? '(undefined)'} does not receive the emergency-outlet message`, () => {
      for (const lang of ['en', 'ar'] as const) {
        expect(networkErrorMessage(code, lang))
          .not.toBe(T.net_err_wh_deactivate_blocked_emergency_outlet[lang]);
      }
    });
  });

  it('the existing refusal vocabulary still maps exactly as it did', () => {
    expect(networkErrorMessage('NOT_AUTHORIZED_WAREHOUSE_MANAGE', 'en')).toBe(T.net_err_not_authorized.en);
    expect(networkErrorMessage('WAREHOUSE_NOT_FOUND', 'en')).toBe(T.net_err_not_found.en);
    expect(networkErrorMessage('WAREHOUSE_ARCHIVED', 'en')).toBe(T.net_err_invalid.en);
    expect(networkErrorMessage('WAREHOUSE_CODE_EXISTS', 'en')).toBe(T.net_err_conflict.en);
    expect(networkErrorMessage('CROSS_ORG_ASSIGNMENT', 'en')).toBe(T.net_err_cross_org.en);
    expect(networkErrorMessage('SOMETHING_ELSE', 'en')).toBe(T.net_err_generic.en);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The normalization layer: the token must survive the trip at all.
// ───────────────────────────────────────────────────────────────────────────

const rpc = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  supabase: { rpc: (...a: unknown[]) => rpc.fn(...a) },
}));

describe('WAREHOUSE-DEACTIVATION-UX · setWarehouseActive preserves the trigger token', () => {
  beforeEach(() => { rpc.fn.mockReset(); });

  it('the lower_snake trigger token reaches the caller intact', async () => {
    rpc.fn.mockResolvedValue({ data: null, error: { code: '23514', message: TOKEN } });
    const { setWarehouseActive } = await import('../network.service');
    const res = await setWarehouseActive('wh-1', false);
    expect(res.ok).toBe(false);
    expect(res.error, 'the token must not be flattened to unknown_error').toBe(TOKEN);
    expect(networkErrorMessage(res.error, 'en')).toBe(T.net_err_wh_deactivate_blocked_emergency_outlet.en);
  });

  it('the UPPER_SNAKE RPC vocabulary is unaffected', async () => {
    rpc.fn.mockResolvedValue({ data: null, error: { code: '23514', message: 'WAREHOUSE_ARCHIVED: wh-1 is archived' } });
    const { setWarehouseActive } = await import('../network.service');
    expect((await setWarehouseActive('wh-1', false)).error).toBe('WAREHOUSE_ARCHIVED');
  });

  it('arbitrary lowercase database text is STILL discarded — the allowlist is exact', async () => {
    rpc.fn.mockResolvedValue({
      data: null,
      error: { code: 'XX000', message: 'relation "warehouses" does not exist' },
    });
    const { setWarehouseActive } = await import('../network.service');
    expect((await setWarehouseActive('wh-1', false)).error).toBe('unknown_error');
  });

  it('a near-miss token is not accepted by prefix or by shape', async () => {
    rpc.fn.mockResolvedValue({
      data: null,
      error: { code: '23514', message: 'emergency_outlet_warehouse_deactivation_blocked' },
    });
    const { setWarehouseActive } = await import('../network.service');
    expect((await setWarehouseActive('wh-1', false)).error).toBe('unknown_error');
  });

  it('D2 · a successful deactivation is still a success', async () => {
    rpc.fn.mockResolvedValue({ data: { ok: true, status: 'inactive' }, error: null });
    const { setWarehouseActive } = await import('../network.service');
    expect((await setWarehouseActive('wh-1', false)).ok).toBe(true);
  });

  it('D3 · a successful reactivation is still a success', async () => {
    rpc.fn.mockResolvedValue({ data: { ok: true, status: 'active' }, error: null });
    const { setWarehouseActive } = await import('../network.service');
    expect((await setWarehouseActive('wh-1', true)).ok).toBe(true);
  });

  it('the allowlist is a closed, exact-match list — not a pattern', () => {
    const at = SERVICE_SRC.indexOf('const DB_GUARD_ERROR_TOKENS');
    expect(at, 'the allowlist must exist').toBeGreaterThan(-1);
    const decl = SERVICE_SRC.slice(at, SERVICE_SRC.indexOf('];', at));
    expect(decl).toContain(TOKEN);
    // One entry today. A future entry is fine; a regex or a prefix test is not.
    expect(decl).not.toMatch(/RegExp|startsWith|includes|test\(/);
    expect(SERVICE_SRC).toContain('DB_GUARD_ERROR_TOKENS.includes(head)');
  });

  it('the database guard itself is untouched by this repair', () => {
    // The trigger keeps its own vocabulary; the client only learned to read it.
    expect(M183).toContain(`RAISE EXCEPTION '${TOKEN}'`);
    expect(SERVICE_SRC).not.toContain('CREATE ');
    expect(SERVICE_SRC).not.toContain('ALTER ');
  });
});
