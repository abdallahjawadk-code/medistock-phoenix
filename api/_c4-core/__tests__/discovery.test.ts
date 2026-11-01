import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedCaller } from '../../_lib/supabase.ts';
import { createAnnualSourceDiscoveryHandler } from '../discovery.ts';

const org = '11111111-1111-4111-8111-111111111111';
const request = (query = `ownerOrgId=${org}&planningYear=2026`) => new Request(`http://localhost/api/central-needs/annual-source-capabilities?${query}`);
function setup(available = true) {
  const registration = { workbookSheets: [{ index: 0, name: 'Identity' }], template: { id: 'reviewed-test', version: 1,
    reviewReference: 'PRIVATE REVIEW TEXT', parserContractVersion: '1.2.0', classificationCells: [], blocks: [] } };
  const rpc = vi.fn().mockResolvedValue({ error: null, data: { version: 1, enabled: true, catalogCommitImplemented: true,
    trustedPreparationRequiresServer: true, maxPageRows: 50, maxEvidenceBytes: 262144 } });
  const caller = { userId: org, client: { rpc } } as unknown as AuthenticatedCaller;
  const authenticate = vi.fn().mockResolvedValue(caller), authorized = vi.fn().mockResolvedValue(true);
  const handler = createAnnualSourceDiscoveryHandler({ registrations: available ? [registration] : [], authenticate, authorized });
  return { handler, rpc, authenticate, authorized, registration };
}
describe('scoped source-profile discovery, no automatic recognition or source read', () => {
  it('authenticates before parsing scope', async () => {
    const f = setup(); f.authenticate.mockResolvedValue(null); expect((await f.handler(request('bad'))).status).toBe(401);
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.authorized).not.toHaveBeenCalled();
  });
  it.each(['', `ownerOrgId=${org}&planningYear=1999`, `ownerOrgId=${org}&planningYear=2026&planningYear=2027`,
    `ownerOrgId=${org}&planningYear=2026&actorId=${org}`])('refuses malformed or duplicated scope %#', async query => {
    const f = setup(); expect((await f.handler(request(query))).status).toBe(400); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('refuses a foreign scope before disclosing reviewed registrations', async () => {
    const f = setup(); f.authorized.mockResolvedValue(false); const response = await f.handler(request());
    expect(response.status).toBe(403); expect(await response.text()).not.toContain('reviewed-test');
  });
  it('reports the empty default registry without querying an unavailable SQL candidate', async () => {
    const f = setup(false); const response = await f.handler(request()); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, capabilities: { readAvailable: false, commitState: 'unavailable_registry', profiles: [] } });
    expect(f.rpc).not.toHaveBeenCalled(); expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('advertises only snapshotted profile IDs, versions and hashes', async () => {
    const f = setup(); f.registration.template.id = 'changed-after-creation';
    const response = await f.handler(request()); const body = await response.json();
    expect(body).toMatchObject({ capabilities: { readAvailable: true, commitState: 'ready', selectionMode: 'explicit_reviewed_profile',
      profiles: [{ id: 'reviewed-test', version: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }] } });
    expect(JSON.stringify(body)).not.toContain('PRIVATE REVIEW TEXT'); expect(JSON.stringify(body)).not.toContain('Identity');
  });
  it('separates missing, inactive and forbidden commit capability from read access', async () => {
    const f = setup(); f.rpc.mockResolvedValueOnce({ error: { code: 'PGRST202' }, data: null });
    expect(await (await f.handler(request())).json()).toMatchObject({ capabilities: { commitState: 'missing_candidate' } });
    f.rpc.mockResolvedValueOnce({ error: null, data: { version: 1, enabled: false, catalogCommitImplemented: true,
      trustedPreparationRequiresServer: true, maxPageRows: 50, maxEvidenceBytes: 262144 } });
    expect(await (await f.handler(request())).json()).toMatchObject({ capabilities: { commitState: 'inactive' } });
    f.authorized.mockImplementation(async (_caller, _org, permission) => permission !== 'central_needs.edit');
    expect(await (await f.handler(request())).json()).toMatchObject({ capabilities: { commitState: 'forbidden' } });
  });
  it('does not reinterpret unexpected SQL failures as missing capability', async () => {
    const f = setup(); f.rpc.mockResolvedValueOnce({ error: { code: '55000', message: 'PRIVATE FAILURE' }, data: null });
    const response = await f.handler(request()); expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE');
  });
  it('observes view revocation before delivering the capability', async () => {
    const f = setup(); f.authorized.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await f.handler(request())).status).toBe(403);
  });
});
