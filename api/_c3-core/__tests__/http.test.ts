import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedCaller } from '../../_lib/supabase.ts';
import { createC3ReadHandler } from '../http.ts';

const scope = { ownerOrgId: '11111111-1111-4111-8111-111111111111', planningYear: 2099 };
const originalId = '22222222-2222-4222-8222-222222222222';
const input = { scope, originalId, templateId: 'synthetic-test', templateVersion: 1, cursor: null, pageSize: 2 };
const request = (body: unknown = input) => new Request('http://localhost/api/central-needs/extract-original', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
});
const caller = { userId: originalId } as AuthenticatedCaller;
function setup(available = true) {
  const registration = { workbookSheets: [{ index: 0, name: 'Identity' }], template: {
    id: input.templateId, version: 1, reviewReference: 'synthetic-only', parserContractVersion: '1.2.0',
    classificationCells: [], blocks: [],
  } };
  const authenticate = vi.fn().mockResolvedValue(caller);
  const read = vi.fn().mockResolvedValue({ scope, original: { originalId } });
  const run = vi.fn().mockResolvedValue({ status: 'source_evidence_only_review_required', persisted: false, rows: [], nextCursor: null });
  const authorized = vi.fn().mockResolvedValue(true);
  const handler = createC3ReadHandler({ registrations: available ? [registration] : [],
    workerEntry: new URL('file:///private/worker.mjs'), authenticate, read, run, authorized });
  return { handler, authenticate, read, run, authorized, registration };
}
describe('C3 read-only HTTP boundary, injected transport faults', () => {
  it('authenticates before reading request input or source data', async () => {
    const f = setup(); f.authenticate.mockResolvedValue(null);
    const response = await f.handler(request({ not: 'a request' }));
    expect(response.status).toBe(401); expect(f.read).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, quantity: 4 }, { ...input, template: {} }, { ...input, workerEntry: 'https://invalid/' },
    { ...input, cursor: 'x'.repeat(257) }, { ...input, pageSize: 51 },
    { ...input, scope: { ...scope, planningYear: 1999 } }, { ...input, originalId: '../file' },
  ])('refuses malformed scope, limits and caller-supplied authority %#', async body => {
    const f = setup(); expect((await f.handler(request(body))).status).toBe(400);
    expect(f.read).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
  it('refuses body bytes above the bound, even without Content-Length', async () => {
    const f = setup(); expect((await f.handler(request('x'.repeat(16385)))).status).toBe(413);
    expect(f.read).not.toHaveBeenCalled();
  });
  it('keeps an empty deployed registry unavailable without downloading sources', async () => {
    const f = setup(false); expect((await f.handler(request())).status).toBe(503);
    expect(f.read).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
  it('uses the verified caller and a snapshotted server registration', async () => {
    const f = setup(); f.registration.template.id = 'changed-after-creation';
    const response = await f.handler(request());
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(f.read).toHaveBeenCalledWith(caller, scope, originalId);
    expect(f.run.mock.calls[0][1]).toMatchObject({ template: { manifest: { template: { id: input.templateId } } },
      pageSize: 2, cursor: null });
    expect(f.authorized).toHaveBeenCalledWith(caller, scope.ownerOrgId, 'central_needs.view');
  });
  it('refuses foreign or revoked scope without a worker or raw error leak', async () => {
    const f = setup(); f.read.mockRejectedValue(new Error('annual_c3_forbidden'));
    expect((await f.handler(request())).status).toBe(403); expect(f.run).not.toHaveBeenCalled();
    f.read.mockRejectedValue(new Error('PRIVATE DATABASE SECRET'));
    expect(await (await f.handler(request())).text()).not.toContain('PRIVATE');
  });
  it('refuses revocation during computation before exposing evidence', async () => {
    const f = setup(); f.authorized.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await f.handler(request())).status).toBe(403);
    expect(f.run).toHaveBeenCalledOnce();
  });
  it('refuses a worker timeout and never returns partial evidence', async () => {
    const f = setup(); f.run.mockRejectedValue(new Error('annual_c3_worker_timeout'));
    const response = await f.handler(request()); expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ ok: false, error: 'c3_worker_timeout' });
  });
  it('refuses an oversized final HTTP envelope', async () => {
    const f = setup(); f.run.mockResolvedValue({ rows: ['x'.repeat(262144)] });
    expect((await f.handler(request())).status).toBe(413);
  });
});
