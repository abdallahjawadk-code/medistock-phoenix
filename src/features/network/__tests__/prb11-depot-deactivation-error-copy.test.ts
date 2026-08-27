/**
 * PRB-1.1 · PRB1-REVIEW-FINDING-001 — THE HEALTH-CENTER DEPOT REFUSAL GETS ITS
 * OWN MESSAGE, NOT THE EMERGENCY WAREHOUSE ONE.
 *
 * Migration 181's health-sector shape guard refuses to deactivate a depot that
 * ANY active outlet still names:
 *
 *     RAISE EXCEPTION 'health_center_depot_deactivation_blocked_by_active_outlet'
 *       USING ERRCODE = '23514'
 *
 * It travels the identical client path as the emergency-outlet refusal PRB-1
 * repaired — NetworkManagementScreen -> setWarehouseActive -> callRpc ->
 * rpcErrorCode -> networkErrorMessage — and it was lost at the identical two
 * places: it is a bare lower_snake trigger token, so it failed rpcErrorCode's
 * /^[A-Z0-9_]+$/ shape test and collapsed to 'unknown_error'; and
 * 'UNKNOWN_ERROR' matches no branch of networkErrorMessage's ladder, so it fell
 * through to the generic tail.
 *
 * WHY IT IS NOT AN ALIAS OF THE EMERGENCY MESSAGE. The two guards have
 * different triggers and therefore different remedies:
 *
 *   183  blocks a warehouse only when an active crash cabinet or rescue cart
 *        names it            -> stand down THAT emergency outlet.
 *   181  blocks a health-sector depot when ANY active distribution point names
 *        it                  -> stand down or reassign EVERY active outlet.
 *
 * Giving the depot refusal the emergency copy would name the wrong dependency
 * and send the operator after the wrong thing. The PRB-1 suite already pins
 * that it must not inherit that copy; this suite pins what it gets instead.
 *
 * The database guard is UNCHANGED. Only the client's reading of its answer is.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkErrorMessage } from '../NetworkManagementScreen';
import { T } from '@/shared/i18n/strings';

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const M181 = read('supabase/migrations/181_phoenix_health_sector_topology_reconciliation.sql');
const M183 = read('supabase/migrations/183_phoenix_emergency_outlet_integrity.sql');
const SERVICE_SRC = read('src/features/network/network.service.ts');
const SCREEN_SRC = read('src/features/network/NetworkManagementScreen.tsx');

/** The token exactly as migration 181 raises it — never retyped by hand. */
const DEPOT_TOKEN = (() => {
  const m = /RAISE EXCEPTION '(health_center_depot_deactivation_blocked_by_active_outlet)'/.exec(M181);
  expect(m, 'migration 181 must still raise this refusal').not.toBeNull();
  return m![1];
})();

/** The emergency sibling, likewise read from its own migration. */
const EMERGENCY_TOKEN = (() => {
  const m = /RAISE EXCEPTION '(emergency_outlet_warehouse_deactivation_blocked_by_active_outlet)'/.exec(M183);
  expect(m, 'migration 183 must still raise this refusal').not.toBeNull();
  return m![1];
})();

// ───────────────────────────────────────────────────────────────────────────
// The guard is the Product's, and it stays the Product's.
// ───────────────────────────────────────────────────────────────────────────

describe('PRB-1.1 · the database contract is untouched', () => {
  it('migration 181 still raises the depot refusal as a CHECK violation', () => {
    const at = M181.indexOf(`RAISE EXCEPTION '${DEPOT_TOKEN}'`);
    expect(at).toBeGreaterThan(-1);
    expect(M181.slice(at, at + 200)).toContain("ERRCODE = '23514'");
  });

  it('the LIVE guard is 183\'s forward replacement of 181\'s function', () => {
    // 181 owns the contract and the token; 183 CREATE OR REPLACEs the function
    // behind the same trigger. Assertions about runtime behaviour must therefore
    // read 183, not 181, or they pin a body that no longer executes.
    expect(M183).toContain('CREATE OR REPLACE FUNCTION public._phoenix_health_sector_warehouse_shape_guard_v1()');
    expect(M181).toContain('CREATE FUNCTION public._phoenix_health_sector_warehouse_shape_guard_v1()');
  });

  it('the live guard fires on ANY active dependent outlet, not only emergency ones', () => {
    // The distinguishing fact the copy is built on. If this branch is ever
    // narrowed to emergency point types, the copy must be revisited.
    const at = M183.indexOf(`RAISE EXCEPTION '${DEPOT_TOKEN}'`);
    expect(at).toBeGreaterThan(-1);
    const stanza = M183.slice(Math.max(0, at - 400), at);
    expect(stanza).toContain("v_class = 'health_sector'");
    expect(stanza).toContain('public.distribution_points dp');
    expect(stanza).toContain("dp.status = 'active'");
    expect(stanza, 'the health-sector branch must NOT filter on point_type').not.toContain('point_type');
  });

  it('the emergency branch keeps its own, narrower condition', () => {
    const at = M183.indexOf(`RAISE EXCEPTION '${EMERGENCY_TOKEN}'`);
    const stanza = M183.slice(Math.max(0, at - 400), at);
    expect(stanza).toContain('crash_cabinet');
    expect(stanza).toContain('rescue_cart');
  });

  it('this repair writes no SQL', () => {
    for (const src of [SERVICE_SRC, SCREEN_SRC]) {
      expect(src).not.toContain('CREATE ');
      expect(src).not.toContain('ALTER ');
      expect(src).not.toContain('GRANT ');
      expect(src).not.toContain('DROP ');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DPT-01 / DPT-02 · the dedicated message, both languages.
// ───────────────────────────────────────────────────────────────────────────

describe('PRB-1.1 · DPT-01/02 · the depot refusal maps to its own copy', () => {
  it('DPT-01 · Arabic', () => {
    const msg = networkErrorMessage(DEPOT_TOKEN, 'ar');
    expect(msg).toBe(T.net_err_depot_deactivate_blocked_active_outlet.ar);
    expect(msg).not.toBe(T.net_err_generic.ar);
    expect(msg).not.toBe(T.net_err_invalid.ar);
  });

  it('DPT-02 · English', () => {
    const msg = networkErrorMessage(DEPOT_TOKEN, 'en');
    expect(msg).toBe(T.net_err_depot_deactivate_blocked_active_outlet.en);
    expect(msg).not.toBe(T.net_err_generic.en);
    expect(msg).not.toBe(T.net_err_invalid.en);
  });

  it('the copy names the subject, the dependency AND the way out, in both languages', () => {
    const { ar, en } = T.net_err_depot_deactivate_blocked_active_outlet;
    // Arabic — the Product's canonical depot and outlet vocabulary.
    expect(ar).toContain('مذخر المركز الصحي');
    expect(ar).toContain('منفذ');
    expect(ar).toContain('أعد المحاولة');
    // English — subject, dependency, remedy.
    expect(en).toContain('health-center depot');
    expect(en).toContain('active outlets');
    expect(en).toMatch(/stand down or reassign/i);
    expect(en).toMatch(/try again/i);
  });

  it('the copy is plural-safe — it never implies there can be only one outlet', () => {
    const { ar, en } = T.net_err_depot_deactivate_blocked_active_outlet;
    expect(en).toMatch(/one or more/i);
    expect(ar).toContain('واحد أو أكثر');
  });

  it('the Arabic copy is RTL-safe — no embedded Latin or digits to break bidi', () => {
    expect(T.net_err_depot_deactivate_blocked_active_outlet.ar).not.toMatch(/[A-Za-z0-9]/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DPT-03 · the emergency message is untouched, and the two are NOT aliases.
// ───────────────────────────────────────────────────────────────────────────

describe('PRB-1.1 · DPT-03 · the emergency refusal is unchanged', () => {
  it('the emergency token still maps to the emergency copy, both languages', () => {
    expect(networkErrorMessage(EMERGENCY_TOKEN, 'en'))
      .toBe(T.net_err_wh_deactivate_blocked_emergency_outlet.en);
    expect(networkErrorMessage(EMERGENCY_TOKEN, 'ar'))
      .toBe(T.net_err_wh_deactivate_blocked_emergency_outlet.ar);
  });

  it('the emergency copy still says WAREHOUSE and EMERGENCY outlet, not depot', () => {
    const { ar, en } = T.net_err_wh_deactivate_blocked_emergency_outlet;
    expect(en).toContain('warehouse');
    expect(en).toContain('emergency outlet');
    expect(en).not.toContain('depot');
    expect(ar).toContain('المخزن');
    expect(ar).toContain('منفذ طوارئ');
    expect(ar).not.toContain('مذخر');
  });

  it('the two messages are genuinely distinct strings in both languages', () => {
    const depot = T.net_err_depot_deactivate_blocked_active_outlet;
    const emerg = T.net_err_wh_deactivate_blocked_emergency_outlet;
    expect(depot.ar).not.toBe(emerg.ar);
    expect(depot.en).not.toBe(emerg.en);
  });

  it('neither token can receive the other\'s message', () => {
    expect(networkErrorMessage(DEPOT_TOKEN, 'en'))
      .not.toBe(T.net_err_wh_deactivate_blocked_emergency_outlet.en);
    expect(networkErrorMessage(EMERGENCY_TOKEN, 'en'))
      .not.toBe(T.net_err_depot_deactivate_blocked_active_outlet.en);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DPT-04 / DPT-05 / DPT-06 · nothing else may reach the depot copy.
// ───────────────────────────────────────────────────────────────────────────

const MUST_NOT_GET_DEPOT_COPY: readonly (string | undefined)[] = [
  // DPT-05 · other real 23514 refusals from the same call path.
  'WAREHOUSE_ARCHIVED',
  'WAREHOUSE_NOT_FOUND',
  'health_sector_warehouse_must_be_institution',
  'emergency_outlet_requires_active_warehouse',
  'emergency_outlet_requires_owning_warehouse',
  'rescue_cart_requires_emergency_context',
  EMERGENCY_TOKEN,
  // DPT-04 · arbitrary lowercase database text.
  'relation "warehouses" does not exist',
  'permission denied for table warehouses',
  'unknown_error',
  // DPT-06 · near misses that must not match by prefix, suffix or shape.
  'health_center_depot_deactivation_blocked_by_active_outlet_extra',
  'health_center_depot_deactivation_blocked',
  'health_center_depot',
  'x_health_center_depot_deactivation_blocked_by_active_outlet',
  // Degenerate inputs.
  '',
  undefined,
];

describe('PRB-1.1 · DPT-04/05/06 · the depot mapping is exact, never a family match', () => {
  for (const code of MUST_NOT_GET_DEPOT_COPY) {
    it(`${code === undefined ? '(undefined)' : code === '' ? '(empty)' : code} does not receive the depot message`, () => {
      expect(networkErrorMessage(code, 'en'))
        .not.toBe(T.net_err_depot_deactivate_blocked_active_outlet.en);
      expect(networkErrorMessage(code, 'ar'))
        .not.toBe(T.net_err_depot_deactivate_blocked_active_outlet.ar);
    });
  }

  it('the pre-existing refusal vocabulary still maps exactly as it did', () => {
    expect(networkErrorMessage('NOT_AUTHORIZED_WAREHOUSE_MANAGE', 'en')).toBe(T.net_err_not_authorized.en);
    expect(networkErrorMessage('WAREHOUSE_NOT_FOUND', 'en')).toBe(T.net_err_not_found.en);
    expect(networkErrorMessage('WAREHOUSE_ARCHIVED', 'en')).toBe(T.net_err_invalid.en);
    expect(networkErrorMessage('unknown_error', 'en')).toBe(T.net_err_generic.en);
    expect(networkErrorMessage(undefined, 'en')).toBe(T.net_err_generic.en);
  });

  it('the generic fallback is still the tail of the ladder', () => {
    expect(networkErrorMessage('SOMETHING_NOBODY_HAS_SEEN', 'en')).toBe(T.net_err_generic.en);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The parser stays fail-safe.
// ───────────────────────────────────────────────────────────────────────────

const rpc = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  supabase: { rpc: (...a: unknown[]) => rpc.fn(...a) },
}));

describe('PRB-1.1 · setWarehouseActive preserves the depot token', () => {
  beforeEach(() => { rpc.fn.mockReset(); });

  it('the lower_snake trigger token reaches the caller intact and becomes the depot copy', async () => {
    rpc.fn.mockResolvedValue({ data: null, error: { code: '23514', message: DEPOT_TOKEN } });
    const { setWarehouseActive } = await import('../network.service');
    const res = await setWarehouseActive('depot-1', false);
    expect(res.ok).toBe(false);
    expect(res.error, 'the token must not be flattened to unknown_error').toBe(DEPOT_TOKEN);
    expect(networkErrorMessage(res.error, 'en')).toBe(T.net_err_depot_deactivate_blocked_active_outlet.en);
    expect(networkErrorMessage(res.error, 'ar')).toBe(T.net_err_depot_deactivate_blocked_active_outlet.ar);
  });

  it('the emergency token still reaches the caller intact — PRB-1 behaviour preserved', async () => {
    rpc.fn.mockResolvedValue({ data: null, error: { code: '23514', message: EMERGENCY_TOKEN } });
    const { setWarehouseActive } = await import('../network.service');
    expect((await setWarehouseActive('wh-1', false)).error).toBe(EMERGENCY_TOKEN);
  });

  it('DPT-04 · arbitrary lowercase database text is STILL discarded', async () => {
    const { setWarehouseActive } = await import('../network.service');
    for (const message of [
      'relation "warehouses" does not exist',
      'permission denied for table warehouses',
      'could not serialize access due to concurrent update',
      'null value in column "status" violates not-null constraint',
    ]) {
      rpc.fn.mockResolvedValue({ data: null, error: { code: 'XX000', message } });
      expect((await setWarehouseActive('wh-1', false)).error).toBe('unknown_error');
    }
  });

  it('DPT-06 · a near-miss depot token is not accepted by prefix, suffix or shape', async () => {
    const { setWarehouseActive } = await import('../network.service');
    for (const message of [
      `${DEPOT_TOKEN}_extra`,
      'health_center_depot_deactivation_blocked',
      'health_center_depot',
      `x_${DEPOT_TOKEN}`,
      ` ${DEPOT_TOKEN}x`,
    ]) {
      rpc.fn.mockResolvedValue({ data: null, error: { code: '23514', message } });
      expect((await setWarehouseActive('depot-1', false)).error).toBe('unknown_error');
    }
  });

  it('DPT-05 · an unrelated 23514 keeps its own existing mapping', async () => {
    rpc.fn.mockResolvedValue({
      data: null,
      error: { code: '23514', message: 'WAREHOUSE_ARCHIVED: depot-1 is archived' },
    });
    const { setWarehouseActive } = await import('../network.service');
    const res = await setWarehouseActive('depot-1', false);
    expect(res.error).toBe('WAREHOUSE_ARCHIVED');
    expect(networkErrorMessage(res.error, 'en')).toBe(T.net_err_invalid.en);
  });

  it('DPT-07 · the UPPER_SNAKE form is admitted by the PRE-EXISTING shape rule, not by new normalization', async () => {
    // The real trigger never emits this form — 181 raises bare lower_snake. It
    // is reachable only because rpcErrorCode has ALWAYS passed UPPER_SNAKE
    // tokens through; that rule predates PRB-1 and is untouched here. Asserted
    // so the behaviour is documented rather than accidental, and so it stays
    // symmetric with the emergency token PRB-1 already shipped.
    const { setWarehouseActive } = await import('../network.service');
    for (const token of [DEPOT_TOKEN, EMERGENCY_TOKEN]) {
      rpc.fn.mockResolvedValue({ data: null, error: { code: '23514', message: token.toUpperCase() } });
      const res = await setWarehouseActive('wh-1', false);
      expect(res.error).toBe(token.toUpperCase());
    }
    // No lowercasing was added: the allowlist is consulted case-sensitively.
    expect(SERVICE_SRC).not.toMatch(/toLowerCase\(\)/);
  });

  it('a successful depot deactivation is still a success', async () => {
    rpc.fn.mockResolvedValue({ data: { ok: true, status: 'inactive' }, error: null });
    const { setWarehouseActive } = await import('../network.service');
    expect((await setWarehouseActive('depot-1', false)).ok).toBe(true);
  });

  it('a successful depot reactivation is still a success', async () => {
    rpc.fn.mockResolvedValue({ data: { ok: true, status: 'active' }, error: null });
    const { setWarehouseActive } = await import('../network.service');
    expect((await setWarehouseActive('depot-1', true)).ok).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Shape of the repair itself.
// ───────────────────────────────────────────────────────────────────────────

describe('PRB-1.1 · the allowlist and the mapper stay closed and exact', () => {
  it('the allowlist carries BOTH tokens and is still a literal list', () => {
    const at = SERVICE_SRC.indexOf('const DB_GUARD_ERROR_TOKENS');
    expect(at).toBeGreaterThan(-1);
    const decl = SERVICE_SRC.slice(at, SERVICE_SRC.indexOf('];', at));
    expect(decl).toContain(DEPOT_TOKEN);
    expect(decl).toContain(EMERGENCY_TOKEN);
    // A list of string literals — never a pattern, a prefix test or a regex.
    expect(decl).not.toMatch(/RegExp|startsWith|endsWith|test\(|\.\.\./);
    expect(SERVICE_SRC).toContain('DB_GUARD_ERROR_TOKENS.includes(head)');
  });

  it('the mapper matches the depot token by whole-token equality', () => {
    expect(SCREEN_SRC).toContain("c === 'HEALTH_CENTER_DEPOT_DEACTIVATION_BLOCKED_BY_ACTIVE_OUTLET'");
    expect(SCREEN_SRC).not.toMatch(/startsWith\('HEALTH_CENTER/);
    expect(SCREEN_SRC).not.toMatch(/includes\('HEALTH_CENTER/);
  });

  it('the depot branch sits BEFORE every substring heuristic', () => {
    const depotAt = SCREEN_SRC.indexOf("c === 'HEALTH_CENTER_DEPOT_DEACTIVATION_BLOCKED_BY_ACTIVE_OUTLET'");
    const firstHeuristic = SCREEN_SRC.indexOf("c.startsWith('NOT_AUTHORIZED')");
    expect(depotAt).toBeGreaterThan(-1);
    expect(firstHeuristic).toBeGreaterThan(-1);
    expect(depotAt).toBeLessThan(firstHeuristic);
  });

  it('the two exact branches are separate returns, not a shared one', () => {
    expect(SCREEN_SRC).toContain("return t('net_err_wh_deactivate_blocked_emergency_outlet', lang);");
    expect(SCREEN_SRC).toContain("return t('net_err_depot_deactivate_blocked_active_outlet', lang);");
  });
});
