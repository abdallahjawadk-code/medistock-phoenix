/**
 * PRB-1 · UAT-DEFECT-006 — THE CORRECTION-APPROVAL UI MUST ASK THE SAME
 * QUESTION THE WRITER ANSWERS.
 *
 * THE ASYMMETRY THAT EXISTED
 *   Server (migrations 098, 101, 133), for every approve and every reject:
 *
 *       IF NOT phoenix_status_center_authorized(org, '<scope>.approve_correction')
 *
 *   Client, for deciding whether to offer the Corrections surface at all:
 *
 *       phoenix_profile_has_scoped_permission(profile, key, org, NULL, NULL)
 *
 *   Those are different functions with different answers. The scoped helper's
 *   "both resource targets NULL" branch ends in
 *   `RETURN v_role = ANY(v_org_wide_roles)` with v_org_wide_roles =
 *   ARRAY['institution_admin'], so it says NO to central_warehouse_manager —
 *   the only role migration 101 grants warehouse_stock.approve_correction to.
 *   Migration 092's own header calls that helper "the WRONG tool here". Net
 *   effect: a correctly provisioned central_warehouse_manager could not reach a
 *   workflow the server would have let them perform, and the only way through
 *   was a second super_admin.
 *
 * WHAT IS PROVEN
 *   1. The client now names the server's own gate, with its committed argument
 *      names — read out of migration 092 rather than hardcoded here.
 *   2. Every correction writer still gates on that same function, so the two
 *      sides cannot silently diverge again.
 *   3. The old, wrong call is gone from this corridor.
 *   4. Fail-closed: no transport or contract failure yields a grant.
 *   5. NO PRIVILEGE EXPANSION: no permission key is added or regranted, no
 *      role gains org-wide rights, and the second-person invariant is
 *      untouched and still enforced where it belongs — server-side.
 *
 * WHAT THIS SUITE DELIBERATELY DOES NOT CLAIM
 *   That the UI is a security boundary. It is not, and the writers re-check
 *   everything. The live negative matrix — wrong role, wrong org, suspended
 *   profile, self-approval, anonymous probe — is proven against the real
 *   database in the PRB-1 authorization-matrix evidence, not here.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const sql = (n: string) => read(`supabase/migrations/${n}`);

const SERVICE = read('src/features/inventory/correction-approval-authorization.service.ts');
const HOOK = read('src/features/inventory/useApproveCorrectionPermission.ts');
const SCREEN = read('src/features/inventory/InventoryCenterScreen.tsx');

const M092 = sql('092_phoenix_monthly_status_redesign.sql');
const M098 = sql('098_phoenix_second_person_correction_approval.sql');
const M101 = sql('101_phoenix_warehouse_second_person_correction_approval.sql');
const M133 = sql('133_phoenix_movement_reason_code_group_h_correction_approval.sql');
const M187 = sql('187_phoenix_delegated_operational_access.sql');

// ───────────────────────────────────────────────────────────────────────────
// 1. THE CLIENT ASKS THE SERVER'S OWN GATE, WITH ITS COMMITTED SIGNATURE.
// ───────────────────────────────────────────────────────────────────────────

describe('UAT-DEFECT-006 · the UI preflight names the canonical server gate', () => {
  it('migration 092 still declares phoenix_status_center_authorized(p_organization_id, p_key)', () => {
    const decl = /CREATE OR REPLACE FUNCTION public\.phoenix_status_center_authorized\(([^)]*)\)/.exec(M092);
    expect(decl, 'the canonical gate must still exist in 092').not.toBeNull();
    const args = decl![1].split(',').map(a => a.trim().split(/\s+/)[0]);
    expect(args).toEqual(['p_organization_id', 'p_key']);
  });

  it('the service calls that function by that name', () => {
    expect(SERVICE).toContain("'phoenix_status_center_authorized'");
  });

  it('the service passes exactly the committed argument names', () => {
    const decl = /CREATE OR REPLACE FUNCTION public\.phoenix_status_center_authorized\(([^)]*)\)/.exec(M092)!;
    for (const arg of decl[1].split(',').map(a => a.trim().split(/\s+/)[0])) {
      expect(SERVICE, `PostgREST resolves by name: ${arg} must be sent`).toContain(`${arg}:`);
    }
  });

  it('the hook delegates to the service and no longer calls the scoped helper', () => {
    expect(HOOK).toContain('isCorrectionApprovalAuthorized');
    expect(HOOK, 'the "both resource targets NULL" call is the defect').not.toContain('hasScopedPermission');
    expect(HOOK).not.toContain('supabaseRbacTransport');
  });

  it('the gate is asked about the CALLER only — it takes no profile-id argument', () => {
    // Strictly narrower than the helper it replaces: phoenix_status_center_
    // authorized reads auth.uid() and cannot be pointed at another profile.
    expect(SERVICE).not.toContain('p_profile_id');
    const body = M092.slice(M092.indexOf('FUNCTION public.phoenix_status_center_authorized'));
    expect(body.slice(0, body.indexOf('$$;'))).toContain('auth.uid()');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. CONVERGENCE: the writers gate on the very same function.
// ───────────────────────────────────────────────────────────────────────────

describe('UAT-DEFECT-006 · every correction writer gates on the same function the UI asks', () => {
  const WRITERS: Array<[string, string, string]> = [
    ['098 approve outlet', M098, 'phoenix_approve_outlet_stock_correction'],
    ['098 reject outlet', M098, 'phoenix_reject_outlet_stock_correction'],
    ['101 approve warehouse', M101, 'phoenix_approve_warehouse_stock_correction'],
    ['101 reject warehouse', M101, 'phoenix_reject_warehouse_stock_correction'],
    ['133 approve outlet (forward)', M133, 'phoenix_approve_outlet_stock_correction'],
    ['133 approve warehouse (forward)', M133, 'phoenix_approve_warehouse_stock_correction'],
  ];

  WRITERS.forEach(([label, source, fn]) => {
    it(`${label} checks phoenix_status_center_authorized`, () => {
      const at = source.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(at, `${fn} must exist in this migration`).toBeGreaterThan(-1);
      const next = source.indexOf('CREATE OR REPLACE FUNCTION', at + 10);
      const body = source.slice(at, next === -1 ? source.length : next);
      expect(body).toContain('phoenix_status_center_authorized');
    });
  });

  it('migration 101 grants warehouse_stock.approve_correction to central_warehouse_manager and to no one else', () => {
    const at = M101.indexOf('INSERT INTO public.role_permission_defaults');
    const block = M101.slice(at, M101.indexOf('ON CONFLICT', at));
    expect(block).toContain("('central_warehouse_manager', 'warehouse_stock.approve_correction', true)");
    for (const other of ['institution_admin', 'warehouse_officer', 'outlet_officer', 'health_center_manager']) {
      expect(block, `${other} must not be granted the approval key`).not.toContain(other);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. WHY THE OLD CALL WAS WRONG — pinned so the reasoning cannot rot.
// ───────────────────────────────────────────────────────────────────────────

describe('UAT-DEFECT-006 · the scoped helper genuinely cannot answer this question', () => {
  it('its "both targets NULL" branch admits only the org-wide roles list', () => {
    const at = M187.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_profile_has_scoped_permission');
    const body = M187.slice(at, M187.indexOf('$scoped_permission$;', at));
    expect(body).toContain("v_org_wide_roles text[] := ARRAY['institution_admin']");
    // The primary-organization path's final line, reached when neither a
    // warehouse nor an outlet is named.
    expect(body).toContain('RETURN v_role = ANY(v_org_wide_roles);');
    expect(body).not.toContain("ARRAY['institution_admin', 'central_warehouse_manager']");
  });

  it('migration 092 says so in its own words', () => {
    // The rationale lives in a wrapped SQL comment block, so compare against
    // the prose with its `--` prefixes and line breaks normalized away.
    const prose = M092
      .split(/\r?\n/)
      .filter(l => l.trimStart().startsWith('--'))
      .map(l => l.trimStart().replace(/^--\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(prose).toContain('is the WRONG tool here');
    expect(prose).toContain('central_warehouse_manager who genuinely holds');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. FAIL-CLOSED TRANSPORT.
// ───────────────────────────────────────────────────────────────────────────

const rpc = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  supabase: { rpc: (...a: unknown[]) => rpc.fn(...a) },
}));

describe('UAT-DEFECT-006 · the preflight fails closed on every non-answer', () => {
  beforeEach(() => { rpc.fn.mockReset(); });

  const load = () => import('../correction-approval-authorization.service');

  it('a true answer is a grant', async () => {
    rpc.fn.mockResolvedValue({ data: true, error: null });
    const { isCorrectionApprovalAuthorized } = await load();
    expect(await isCorrectionApprovalAuthorized('org-1', 'warehouse_stock.approve_correction'))
      .toEqual({ ok: true, allowed: true });
  });

  it('a false answer is a refusal', async () => {
    rpc.fn.mockResolvedValue({ data: false, error: null });
    const { isCorrectionApprovalAuthorized } = await load();
    expect(await isCorrectionApprovalAuthorized('org-1', 'warehouse_stock.approve_correction'))
      .toEqual({ ok: true, allowed: false });
  });

  it('a NON-boolean payload is never read as a grant', async () => {
    const { isCorrectionApprovalAuthorized } = await load();
    for (const data of ['true', 1, {}, [], null, undefined]) {
      rpc.fn.mockResolvedValue({ data, error: null });
      const r = await isCorrectionApprovalAuthorized('org-1', 'warehouse_stock.approve_correction');
      expect(r).toEqual({ ok: true, allowed: false });
    }
  });

  it('an RPC error is an error, and carries no allowed field at all', async () => {
    rpc.fn.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } });
    const { isCorrectionApprovalAuthorized } = await load();
    const r = await isCorrectionApprovalAuthorized('org-1', 'warehouse_stock.approve_correction');
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('allowed');
  });

  it('a missing function is distinguished, and still not a grant', async () => {
    rpc.fn.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    const { isCorrectionApprovalAuthorized } = await load();
    expect(await isCorrectionApprovalAuthorized('org-1', 'warehouse_stock.approve_correction'))
      .toEqual({ ok: false, error: 'MISSING_FUNCTION' });
  });

  it('a thrown transport error is caught and is not a grant', async () => {
    rpc.fn.mockRejectedValue(new TypeError('Failed to fetch'));
    const { isCorrectionApprovalAuthorized } = await load();
    expect(await isCorrectionApprovalAuthorized('org-1', 'warehouse_stock.approve_correction'))
      .toEqual({ ok: false, error: 'NETWORK_ERROR' });
  });

  it('a null organization is refused without a round trip', async () => {
    const { isCorrectionApprovalAuthorized } = await load();
    expect(await isCorrectionApprovalAuthorized(null, 'warehouse_stock.approve_correction'))
      .toEqual({ ok: true, allowed: false });
    expect(rpc.fn).not.toHaveBeenCalled();
  });

  it('no branch of the source can return allowed: true on a failure', () => {
    for (const failure of [...SERVICE.matchAll(/\{\s*ok:\s*false[^}]*\}/g)].map(m => m[0])) {
      expect(failure).not.toContain('allowed');
    }
    expect(SERVICE).toContain('return { ok: true, allowed: data === true };');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. NO PRIVILEGE EXPANSION, AND THE SECOND-PERSON RULE IS UNTOUCHED.
// ───────────────────────────────────────────────────────────────────────────

describe('UAT-DEFECT-006 · the repair grants nothing', () => {
  it('the client creates, grants or widens no permission key', () => {
    for (const src of [SERVICE, HOOK]) {
      expect(src).not.toContain('role_permission_defaults');
      expect(src).not.toContain('permission_keys');
      expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/);
      expect(src).not.toContain('GRANT');
    }
  });

  it('the tab still resolves BOTH approval keys separately — no key is inferred from another', () => {
    expect(SCREEN).toContain("useApproveCorrectionPermission(activeOrgId, 'outlet_stock.approve_correction')");
    expect(SCREEN).toContain("useApproveCorrectionPermission(activeOrgId, 'warehouse_stock.approve_correction')");
  });

  it('mutation authority still flows to the panel separately from view authority', () => {
    const at = SCREEN.indexOf('<PendingCorrectionsPanel');
    expect(at).toBeGreaterThan(-1);
    const el = SCREEN.slice(at, SCREEN.indexOf('/>', at));
    for (const prop of ['canViewOutlet', 'canViewWarehouse', 'canApproveOutlet', 'canApproveWarehouse']) {
      expect(el, `${prop} must still be passed explicitly`).toContain(prop);
    }
  });

  it('the second-person rule stays server-side, by identity, in every writer', () => {
    for (const [label, source] of [['098', M098], ['101', M101], ['133', M133]] as const) {
      expect(source, `${label} must still refuse self-approval`)
        .toContain('proposer_cannot_approve_own_correction');
    }
  });

  it('the client never implements its own self-approval check in place of the server', () => {
    // A client-side identity comparison here would be a second, drift-prone
    // implementation of an invariant the database already owns.
    for (const src of [SERVICE, HOOK]) {
      expect(src).not.toContain('proposed_by');
      expect(src).not.toContain('proposedBy');
    }
  });
});
