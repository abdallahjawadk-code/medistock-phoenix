/**
 * USER-ACCOUNT-EDGE-ERROR-CLASSIFY-A — §4 behavioral (DI) contract tests.
 *
 * These do NOT touch a database or a deployed function. A fake supabase client
 * is injected in place of `@/shared/supabase/client`, and its `functions.invoke`
 * is programmed to return exactly the shapes supabase-js produces:
 *   • FunctionsFetchError  → genuinely unreachable / not deployed;
 *   • FunctionsHttpError   → a DEPLOYED function that answered with a non-2xx
 *                            status and a safe JSON `{ error }` body;
 *   • a normal `{ data }`  → the function ran and returned a business result.
 *
 * The point is to prove the client NO LONGER collapses every failure into
 * EDGE_NOT_DEPLOYED, that a deployed function's real rejection code survives,
 * that an unexpected throw is its own state, and that every attempt carries a
 * correlation id — the exact defect that hid the pharmacy-department
 * (central_warehouse_manager) create/rotate failure behind a false
 * "not deployed".
 *
 * Run: npm test -- --run
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FunctionsHttpError,
  FunctionsFetchError,
  FunctionsRelayError,
} from '@supabase/supabase-js';

// ── Injected fake client (same convention as material-resolver.test.ts) ──────
interface InvokeCall { name: string; body: unknown; headers: Record<string, string> }
const state: {
  next: { data: unknown; error: unknown } | (() => never);
  calls: InvokeCall[];
} = { next: { data: null, error: null }, calls: [] };

vi.mock('@/shared/supabase/client', () => ({
  get supabase() {
    return {
      functions: {
        invoke: async (name: string, opts: { body?: unknown; headers?: Record<string, string> }) => {
          state.calls.push({ name, body: opts?.body, headers: opts?.headers ?? {} });
          if (typeof state.next === 'function') return state.next();
          return state.next;
        },
      },
    };
  },
  supabaseConfigured: true,
}));

import {
  createUserViaEdge,
  rotatePasswordViaEdge,
  classifyEdgeError,
  newCorrelationId,
} from '../services/users.service';

/** Build a real FunctionsHttpError carrying a Response with a JSON body. */
function httpError(status: number, body: unknown): FunctionsHttpError {
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  return new FunctionsHttpError(res);
}

beforeEach(() => {
  state.next = { data: null, error: null };
  state.calls = [];
});

const pharmacyInput = {
  fullName: 'قسم الصيدلة',
  organizationId: 'org-babil',
  role: 'central_warehouse_manager' as const,
  loginMode: 'local' as const,
  username: 'babil.pharmacy',
  temporaryPassword: 'Str0ngPass!',
};

// ── 1. classifyEdgeError — the three real cases, no masking ──────────────────
describe('classifyEdgeError separates unreachable / rejected / unknown', () => {
  it('FunctionsFetchError → unreachable EDGE_NOT_DEPLOYED', async () => {
    const f = await classifyEdgeError(new FunctionsFetchError(new Error('fetch failed')), 'cid-1');
    expect(f.outcome).toBe('unreachable');
    expect(f.code).toBe('EDGE_NOT_DEPLOYED');
    expect(f.correlationId).toBe('cid-1');
  });

  it('FunctionsRelayError → unreachable EDGE_NOT_DEPLOYED', async () => {
    const f = await classifyEdgeError(new FunctionsRelayError(new Error('relay')), 'cid-2');
    expect(f.outcome).toBe('unreachable');
    expect(f.code).toBe('EDGE_NOT_DEPLOYED');
  });

  it('deployed 403 with a JSON error body → rejected, preserving the real code', async () => {
    const f = await classifyEdgeError(httpError(403, { ok: false, error: 'CANNOT_CREATE_CENTRAL_WAREHOUSE_MANAGER' }), 'cid-3');
    expect(f.outcome).toBe('rejected');
    expect(f.code).toBe('CANNOT_CREATE_CENTRAL_WAREHOUSE_MANAGER');
    expect(f.status).toBe(403);
  });

  it('deployed 404 WITH a business error body (TARGET_NOT_FOUND) is a rejection, not "not deployed"', async () => {
    const f = await classifyEdgeError(httpError(404, { ok: false, error: 'TARGET_NOT_FOUND' }), 'cid-4');
    expect(f.outcome).toBe('rejected');
    expect(f.code).toBe('TARGET_NOT_FOUND');
  });

  it('a bare 404 with no JSON contract → unreachable (route/function truly absent)', async () => {
    const res = new Response('Not Found', { status: 404 });
    const f = await classifyEdgeError(new FunctionsHttpError(res), 'cid-5');
    expect(f.outcome).toBe('unreachable');
    expect(f.code).toBe('EDGE_NOT_DEPLOYED');
  });

  it('an unexpected throw shape → unknown UNKNOWN_ERROR', async () => {
    const f = await classifyEdgeError(new Error('boom'), 'cid-6');
    expect(f.outcome).toBe('unknown');
    expect(f.code).toBe('UNKNOWN_ERROR');
  });
});

// ── 2. correlation id ────────────────────────────────────────────────────────
describe('correlation id', () => {
  it('newCorrelationId returns a non-empty, unique-ish token', () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('every create attempt stamps a correlation id and forwards it as a header', async () => {
    state.next = { data: { ok: true, user_id: 'u1', role: 'central_warehouse_manager', login_mode: 'local' }, error: null };
    const res = await createUserViaEdge(pharmacyInput);
    expect(res.correlationId).toBeTruthy();
    expect(state.calls[0].headers['x-correlation-id']).toBe(res.correlationId);
  });
});

// ── 3. Pharmacy-department creation success ──────────────────────────────────
describe('successful Pharmacy Department (central_warehouse_manager) creation', () => {
  it('passes the role through and returns ok with no failure flags', async () => {
    state.next = { data: { ok: true, user_id: 'u-cwm', role: 'central_warehouse_manager', login_mode: 'local' }, error: null };
    const res = await createUserViaEdge(pharmacyInput);
    expect(res.ok).toBe(true);
    expect(res.userId).toBe('u-cwm');
    expect(res.edgeMissing).toBeFalsy();
    expect(res.edgeRejected).toBeFalsy();
    expect(res.unknownError).toBeFalsy();
    // the outgoing body carried the pharmacy-department role + org, unaltered
    expect(state.calls[0].body).toMatchObject({ role: 'central_warehouse_manager', organization_id: 'org-babil' });
  });
});

// ── 4. Deployed rejection is NOT reported as "not deployed" ───────────────────
describe('deployed rejection surfaces the real reason (the masking defect)', () => {
  it('a 403 role-gate rejection sets edgeRejected + the true code, NOT edgeMissing', async () => {
    state.next = { data: null, error: httpError(403, { ok: false, error: 'CANNOT_CREATE_CENTRAL_WAREHOUSE_MANAGER' }) };
    const res = await createUserViaEdge({ ...pharmacyInput });
    expect(res.ok).toBe(false);
    expect(res.edgeRejected).toBe(true);
    expect(res.edgeMissing).toBeFalsy();
    expect(res.error).toBe('CANNOT_CREATE_CENTRAL_WAREHOUSE_MANAGER');
    expect(res.correlationId).toBeTruthy();
  });

  it('a DB-constraint failure (CREATE_PROFILE_FAILED, 400) is rejected, not "not deployed"', async () => {
    state.next = { data: null, error: httpError(400, { ok: false, error: 'CREATE_PROFILE_FAILED' }) };
    const res = await createUserViaEdge(pharmacyInput);
    expect(res.edgeRejected).toBe(true);
    expect(res.edgeMissing).toBeFalsy();
    expect(res.error).toBe('CREATE_PROFILE_FAILED');
  });
});

// ── 5. Genuinely unreachable stays EDGE_NOT_DEPLOYED ─────────────────────────
describe('unreachable function', () => {
  it('a fetch-level failure maps to edgeMissing / EDGE_NOT_DEPLOYED', async () => {
    state.next = { data: null, error: new FunctionsFetchError(new Error('offline')) };
    const res = await createUserViaEdge(pharmacyInput);
    expect(res.edgeMissing).toBe(true);
    expect(res.edgeRejected).toBeFalsy();
    expect(res.error).toBe('EDGE_NOT_DEPLOYED');
  });
});

// ── 6. Unexpected client throw → its own unknown state ───────────────────────
describe('unexpected failure', () => {
  it('a thrown exception inside invoke becomes unknownError, never edgeMissing', async () => {
    state.next = () => { throw new Error('unexpected'); };
    const res = await createUserViaEdge(pharmacyInput);
    expect(res.unknownError).toBe(true);
    expect(res.edgeMissing).toBeFalsy();
    expect(res.error).toBe('UNKNOWN_ERROR');
    expect(res.correlationId).toBeTruthy();
  });
});

// ── 7. Rotation: passthrough of session-revoke + forced password change ──────
describe('rotation (rotate_password) surfaces session revocation + forced change', () => {
  it('forwards sessions_revoked and must_change_password from the function result', async () => {
    state.next = { data: { ok: true, action: 'password_rotated', sessions_revoked: true, must_change_password: true }, error: null };
    const res = await rotatePasswordViaEdge('target-user', 'NewStr0ng!');
    expect(res.ok).toBe(true);
    expect(res.sessions_revoked).toBe(true);
    expect(res.must_change_password).toBe(true);
    expect(res.correlationId).toBeTruthy();
  });

  it('permission denial on rotation (INSUFFICIENT_PERMISSION, 403) is a rejection with the real code', async () => {
    state.next = { data: null, error: httpError(403, { ok: false, error: 'INSUFFICIENT_PERMISSION' }) };
    const res = await rotatePasswordViaEdge('cwm-user', 'NewStr0ng!');
    expect(res.ok).toBe(false);
    expect(res.edgeRejected).toBe(true);
    expect(res.error).toBe('INSUFFICIENT_PERMISSION');
  });
});

// ── 8. Server-side guarantees (source-scan): the edge function actually does
//       the pharmacy-department gate + session revoke + audit + forced change ─
describe('admin-user-lifecycle server contract for rotation & pharmacy-department protection', () => {
  const ROOT = join(__dirname, '../../../../');
  const lifecycle = readFileSync(join(ROOT, 'supabase/functions/admin-user-lifecycle/index.ts'), 'utf8');

  it('only the Platform Manager may run lifecycle actions on central_warehouse_manager', () => {
    expect(lifecycle).toContain('PLATFORM_MANAGED_ROLES');
    expect(lifecycle).toMatch(/PLATFORM_MANAGED_ROLES\s*=\s*\[[^\]]*'central_warehouse_manager'/);
    expect(lifecycle).toContain('PLATFORM_MANAGED_ROLES.includes(targetProfile.role)');
  });

  it('rotate_password revokes prior sessions, forces a password change, and writes an audit event', () => {
    const rotate = lifecycle.slice(lifecycle.indexOf("action === 'rotate_password'"));
    expect(rotate).toMatch(/sessions|signOut|\/sessions/);
    expect(rotate).toContain('must_change_password: true');
    expect(rotate).toContain("action: 'user.password_rotated'");
    expect(rotate).toContain("from('audit_logs')");
  });

  it('the rotation password is never written into audit_logs or profiles', () => {
    const rotate = lifecycle.slice(
      lifecycle.indexOf("action === 'rotate_password'"),
      lifecycle.indexOf("action === 'delete'"),
    );
    // audit payload records only the fact + flags, never the new password value
    expect(rotate).not.toMatch(/payload:[\s\S]*new_?password/i);
  });
});

// ── 9. Frontend never touches privileged material ────────────────────────────
describe('no service_role / auth.admin in the classification layer', () => {
  const SVC = join(__dirname, '../services/users.service.ts');
  const src = readFileSync(SVC, 'utf8');
  it('users.service.ts stays free of service_role and direct auth.admin usage', () => {
    expect(src).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE|auth\.admin/);
  });
});
