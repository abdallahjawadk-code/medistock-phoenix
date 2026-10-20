/**
 * W0 - endpoint wiring of the three Central Needs Excel paths (upload-ticket, finalize-import, source-download).
 * The supabase module is replaced by a controllable fake; the point is the ORDER and the refusals:
 *  - an unauthorized caller (the R1 wrapper answers false: e.g. a super_admin of another organization or without one) gets 403
 *    and NO Storage client is ever created;
 *  - once Excel quantity entry is closed (R1-b) upload-ticket and finalize-import answer 409 and create nothing in Storage;
 *  - an authorized caller on an open organization (the legacy flow) still gets through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    authorized: true, open: true, serviceCalls: 0, asked: [] as Array<[string, string]>, openAsked: 0,
    revision: { id: '22222222-2222-4222-8222-222222222222', organizationId: '11111111-1111-4111-8111-111111111111', planId: 'p', status: 'draft', revisionNumber: 1 },
    batch: { id: 'b', organization_id: '11111111-1111-4111-8111-111111111111', storage_locator: 'nope', container_filename: 'f.xlsx', container_kind: 'file', container_sha256: 'a'.repeat(64) },
  };
  const storage = { from: () => ({ createSignedUploadUrl: async (k: string) => ({ data: { path: k, token: 'tok' }, error: null }), download: async () => ({ data: null, error: { message: 'stub' } }), upload: async () => ({ data: null, error: { message: 'stub' } }), createSignedUrl: async () => ({ data: null, error: { message: 'stub' } }), list: async () => ({ data: [], error: null }) }) };
  const callerClient = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.batch, error: null }) }) }) }) };
  return { state, storage, callerClient };
});

vi.mock('../supabase.ts', () => ({
  authenticate: async () => ({ userId: '44444444-4444-4444-8444-444444444444', accessToken: 't', client: h.callerClient }),
  resolveRevisionAsCaller: async () => h.state.revision,
  callerHasCentralNeedsAuthority: async (_c: unknown, org: string, key: string) => { h.state.asked.push([org, key]); return h.state.authorized; },
  callerExcelImportOpen: async () => { h.state.openAsked += 1; return h.state.open; },
  serviceClient: () => { h.state.serviceCalls += 1; return { storage: h.storage }; },
}));

import upload from '../../_cn2b-core/upload-ticket.ts';
import finalize from '../../_cn2b-core/finalize-import.ts';
import download from '../../_cn2b-core/source-download.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const REV = '22222222-2222-4222-8222-222222222222';
const post = (body: unknown) => new Request('http://localhost/api', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, body: JSON.stringify(body) });
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> });

beforeEach(() => { Object.assign(h.state, { authorized: true, open: true, serviceCalls: 0, asked: [], openAsked: 0 }); h.state.revision.status = 'draft'; });

describe('upload-ticket', () => {
  it('refuses an unauthorized caller (cross-organization / organization-less super_admin) with 403 and touches no Storage', async () => {
    h.state.authorized = false;
    const r = await json(await upload(post({ planRevisionId: REV })));
    expect(r.status).toBe(403);
    expect(h.state.serviceCalls).toBe(0);
    expect(h.state.asked).toEqual([[ORG, 'central_needs.import']]);     // the key and the REVISION's organization, never the request's
    expect(h.state.openAsked).toBe(0);                                  // authority is judged first
  });
  it('after R1-b activation (Excel entry closed) answers 409 excel_import_closed and mints no capability', async () => {
    h.state.open = false;
    const r = await json(await upload(post({ planRevisionId: REV })));
    expect(r.status).toBe(409); expect(JSON.stringify(r.body)).toContain('excel_import_closed');
    expect(h.state.serviceCalls).toBe(0);
  });
  it('an authorized caller on an open organization still gets the legacy capability', async () => {
    const r = await json(await upload(post({ planRevisionId: REV })));
    expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.ok).toBe(true);
    expect(h.state.serviceCalls).toBe(1);
  });
  it('a non-draft revision is still refused (existing contract)', async () => {
    h.state.revision.status = 'approved';
    expect((await json(await upload(post({ planRevisionId: REV })))).status).toBe(409);
    expect(h.state.serviceCalls).toBe(0);
  });
});

describe('finalize-import', () => {
  const body = { planRevisionId: REV, uploadId: '33333333-3333-4333-8333-333333333333', containerKind: 'file' };
  it('refuses an unauthorized caller with 403 before any Storage client exists', async () => {
    h.state.authorized = false;
    expect((await json(await finalize(post(body)))).status).toBe(403);
    expect(h.state.serviceCalls).toBe(0);
  });
  it('refuses with 409 excel_import_closed before any Storage download or permanent write once entry is closed', async () => {
    h.state.open = false;
    const r = await json(await finalize(post(body)));
    expect(r.status).toBe(409); expect(JSON.stringify(r.body)).toContain('excel_import_closed');
    expect(h.state.serviceCalls).toBe(0);
  });
  it('an authorized caller on an open organization proceeds to the Storage steps (legacy flow not broken at the gate)', async () => {
    const r = await finalize(post(body));
    expect([403, 409]).not.toContain(r.status);
    expect(h.state.serviceCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('source-download', () => {
  it('refuses an unauthorized caller with 403 and creates no Storage client / signed URL', async () => {
    h.state.authorized = false;
    expect((await json(await download(post({ batchId: 'b' })))).status).toBe(403);
    expect(h.state.serviceCalls).toBe(0);
    expect(h.state.asked).toEqual([[ORG, 'central_needs.view']]);
  });
  it('an authorized viewer is not blocked by the closed Excel-entry state (history stays readable)', async () => {
    h.state.open = false;
    const r = await download(post({ batchId: 'b' }));
    expect(r.status).not.toBe(403);
    expect(h.state.openAsked).toBe(0);
  });
});
