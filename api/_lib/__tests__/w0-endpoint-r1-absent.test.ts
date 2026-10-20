/**
 * W0 release-order proof (G-REVIEW F1): the three Central Needs Excel endpoints run with the REAL authority helpers against a database
 * that is at M221 (R1 functions absent -> PGRST202) or that answers "not authorized" (a super_admin of another organization / without one).
 * In every such case the endpoint refuses and NO Storage client is created, so no signed URL is minted and no permanent object is written.
 * There is deliberately NO fallback to the legacy phoenix_status_center_authorized predicate.
 *
 * Planned, accepted consequence: while the database is at M221 the legitimate legacy Excel upload-ticket, finalize-import AND source-download
 * (including historical downloads) are refused. That is the cost of fail-closed ordering, not a malfunction (see docs/release/R1-W0-RELEASE-ORDER.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    rpc: (_fn: string, _args: Record<string, unknown>) => ({ data: null as unknown, error: null as unknown }),
    rpcCalls: [] as string[], serviceCalls: 0,
    revision: { id: '22222222-2222-4222-8222-222222222222', organizationId: '11111111-1111-4111-8111-111111111111', planId: 'p', status: 'draft', revisionNumber: 1 },
    batch: { id: 'b', organization_id: '11111111-1111-4111-8111-111111111111', storage_locator: 'permanent/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/' + 'a'.repeat(64), container_filename: 'f.xlsx', container_kind: 'file', container_sha256: 'a'.repeat(64) },
  };
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => { state.rpcCalls.push(fn); return state.rpc(fn, args); },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.batch, error: null }) }) }) }),
  };
  return { state, client };
});

vi.mock('../supabase.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../supabase.ts')>();
  return {
    ...real,                                                          // the REAL callerHasCentralNeedsAuthority / callerExcelImportOpen
    authenticate: async () => ({ userId: '44444444-4444-4444-8444-444444444444', accessToken: 't', client: h.client }),
    resolveRevisionAsCaller: async () => h.state.revision,
    serviceClient: () => { h.state.serviceCalls += 1; throw new Error('Storage must not be reached'); },
  };
});

import upload from '../../_cn2b-core/upload-ticket.ts';
import finalize from '../../_cn2b-core/finalize-import.ts';
import download from '../../_cn2b-core/source-download.ts';

const REV = '22222222-2222-4222-8222-222222222222';
const post = (body: unknown) => new Request('http://localhost/api', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, body: JSON.stringify(body) });
const calls = [
  ['upload-ticket', () => upload(post({ planRevisionId: REV }))],
  ['finalize-import', () => finalize(post({ planRevisionId: REV, uploadId: '33333333-3333-4333-8333-333333333333', containerKind: 'file' }))],
  ['source-download', () => download(post({ batchId: 'b' }))],
] as const;

const PGRST202 = { data: null, error: { code: 'PGRST202', message: 'Could not find the function in the schema cache' } };
beforeEach(() => { h.state.serviceCalls = 0; h.state.rpcCalls = []; });

describe.each(calls)('%s with the R1 functions ABSENT (database at M221)', (_name, call) => {
  it('is refused (403) and never reaches Storage; the legacy helper is never called', async () => {
    h.state.rpc = () => PGRST202;
    const res = await call();
    expect(res.status).toBe(403);
    expect(h.state.serviceCalls).toBe(0);
    expect(h.state.rpcCalls).toEqual(['phoenix_central_needs_actor_authorized']);
    expect(h.state.rpcCalls).not.toContain('phoenix_status_center_authorized');
  });
});

describe.each(calls)('%s for a super_admin of ANOTHER organization or without one (the wrapper answers false)', (_name, call) => {
  it('is refused (403) and never reaches Storage', async () => {
    h.state.rpc = (fn) => (fn === 'phoenix_central_needs_actor_authorized' ? { data: false, error: null } : { data: true, error: null });   // even if every other RPC said yes
    expect((await call()).status).toBe(403);
    expect(h.state.serviceCalls).toBe(0);
    expect(h.state.rpcCalls).toEqual(['phoenix_central_needs_actor_authorized']);
  });
});

describe.each(calls.slice(0, 2))('%s when authority exists but my_capabilities is absent / says closed', (_name, call) => {
  it('is refused (409) before Storage when the capability function is absent (PGRST202)', async () => {
    h.state.rpc = (fn) => (fn === 'phoenix_central_needs_actor_authorized' ? { data: true, error: null } : PGRST202);
    expect((await call()).status).toBe(409);
    expect(h.state.serviceCalls).toBe(0);
  });
  it('is refused (409) before Storage when excel_import_open is false (after R1-b)', async () => {
    h.state.rpc = (fn) => (fn === 'phoenix_central_needs_actor_authorized' ? { data: true, error: null } : { data: [{ excel_import_open: false }], error: null });
    expect((await call()).status).toBe(409);
    expect(h.state.serviceCalls).toBe(0);
  });
});
