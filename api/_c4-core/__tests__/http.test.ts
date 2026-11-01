import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedCaller } from '../../_lib/supabase.ts';
import { createC4MembershipHandler } from '../http.ts';

const org = '11111111-1111-4111-8111-111111111111';
const originalId = '22222222-2222-4222-8222-222222222222';
const canonicalItemId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const proofId = '55555555-5555-4555-8555-555555555555';
const scope = { ownerOrgId: org, planningYear: 2026 };
const registration = { workbookSheets: [{ index: 0, name: 'Identity' }], template: { id: 'synthetic-test', version: 1,
  reviewReference: 'synthetic only', parserContractVersion: '1.2.0', classificationCells: [], blocks: [] } };
const templateHash = createHash('sha256').update(JSON.stringify(registration)).digest('hex');
const input = { scope, requestId, originalId, expectedOriginalSha256: 'a'.repeat(64), templateId: 'synthetic-test',
  templateVersion: 1, expectedTemplateSha256: templateHash, cursor: null, pageSize: 2, occurrenceKeys: ['second', 'first'],
  canonicalItemId, expectedCanonicalFingerprint: 'b'.repeat(64), reason: 'Explicit review' };
const request = (value: unknown = input) => new Request('http://localhost/api/central-needs/commit-verified-membership', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
});
function setup(available = true) {
  const result = { scope, membership: { annualItemId: canonicalItemId, canonicalItemId }, fieldVersion: { fieldVersionId: originalId },
    sourceAttestation: 'client_attested', idempotentReplay: false, c4Verification: { attestation: 'server_verified_c2_extraction_v1',
      proofId, proofSha256: 'c'.repeat(64), originalId, originalSha256: input.expectedOriginalSha256, reviewedById: requestId } };
  const userRpc = vi.fn().mockImplementation(async (name: string) => ({ data: name === 'phoenix_c4_catalog_contract'
    ? { version: 1, enabled: true, catalogCommitImplemented: true, trustedPreparationRequiresServer: true, maxPageRows: 50, maxEvidenceBytes: 262144 }
    : result, error: null }));
  const caller = { userId: requestId, client: { rpc: userRpc } } as unknown as AuthenticatedCaller;
  const authenticate = vi.fn().mockResolvedValue(caller), authorized = vi.fn().mockResolvedValue(true);
  const read = vi.fn().mockResolvedValue({ scope, original: { originalId, sha256: input.expectedOriginalSha256,
    byteSize: 10, firstFilename: 'synthetic.xlsx', attestation: 'server_received_original' } });
  const run = vi.fn().mockResolvedValue({ scope, original: { originalId, sha256: input.expectedOriginalSha256,
    byteSize: 10, attestation: 'server_received_original' }, template: { id: input.templateId, version: '1', sha256: templateHash },
    preparationStatus: 'prepared', coreTemplate: {}, parser: {}, registrySha256: 'd'.repeat(64), classifications: [],
    rows: [{ occurrenceKey: 'first', scope }, { occurrenceKey: 'second', scope }] });
  const serviceRpc = vi.fn().mockResolvedValue({ data: { scope, requestId, proofId, proofSha256: 'c'.repeat(64), proofState: 'sealed' }, error: null });
  const service = vi.fn().mockReturnValue({ rpc: serviceRpc });
  const workerSha256 = vi.fn().mockResolvedValue('e'.repeat(64));
  const handler = createC4MembershipHandler({ registrations: available ? [structuredClone(registration)] : [],
    workerEntry: new URL('file:///private/worker.mjs'), authenticate, authorized, read, run, service, workerSha256 });
  return { handler, caller, userRpc, authenticate, authorized, read, run, service, serviceRpc, workerSha256, result };
}
describe('C4 trusted HTTP review choices and two identities', () => {
  it('authenticates before input, original reads or service access', async () => {
    const f = setup(); f.authenticate.mockResolvedValue(null);
    expect((await f.handler(request({ actorId: 'forged' }))).status).toBe(401);
    expect(f.read).not.toHaveBeenCalled(); expect(f.service).not.toHaveBeenCalled();
  });
  it.each([{ ...input, annualQuantity: 4 }, { ...input, evidence: {} }, { ...input, actorId: requestId },
    { ...input, occurrenceKeys: ['first', 'first'] }, { ...input, occurrenceKeys: [] },
    { ...input, pageSize: 51 }, { ...input, reason: '' }, { ...input, expectedOriginalSha256: 'bad' }])('refuses untrusted authority or malformed choices %#', async value => {
    const f = setup(); expect((await f.handler(request(value))).status).toBe(400); expect(f.service).not.toHaveBeenCalled();
  });
  it('bounds actual streamed body bytes', async () => {
    const f = setup(); expect((await f.handler(request('x'.repeat(16385)))).status).toBe(413); expect(f.read).not.toHaveBeenCalled();
  });
  it('keeps an empty registry inactive before any database or source work', async () => {
    const f = setup(false); expect((await f.handler(request())).status).toBe(503);
    expect(f.userRpc).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.service).not.toHaveBeenCalled();
  });
  it('refuses missing edit authority before source access', async () => {
    const f = setup(); f.authorized.mockImplementation(async (_caller, _org, permission) => permission !== 'central_needs.edit');
    expect((await f.handler(request())).status).toBe(403); expect(f.read).not.toHaveBeenCalled(); expect(f.service).not.toHaveBeenCalled();
  });
  it('requires the current database activation contract', async () => {
    const f = setup(); f.userRpc.mockResolvedValueOnce({ error: null, data: { enabled: false } });
    expect((await f.handler(request())).status).toBe(503); expect(f.run).not.toHaveBeenCalled();
  });
  it('holds changed original or reviewed registration hashes before computation', async () => {
    const f = setup(); expect((await f.handler(request({ ...input, expectedTemplateSha256: 'f'.repeat(64) }))).status).toBe(409);
    f.read.mockResolvedValueOnce({ scope, original: { sha256: 'f'.repeat(64) } });
    expect((await f.handler(request())).status).toBe(409); expect(f.run).not.toHaveBeenCalled();
  });
  it('reruns the actual source and seals only chosen rows in deterministic source order', async () => {
    const f = setup(); const response = await f.handler(request()); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(f.read).toHaveBeenCalledWith(f.caller, scope, originalId);
    expect(f.run).toHaveBeenCalledOnce();
    const [name, args] = f.serviceRpc.mock.calls[0]; expect(name).toBe('phoenix_c4_seal');
    expect(args.p_actor_id).toBe(f.caller.userId); expect(args.p_evidence.rows.map((r: { occurrenceKey: string }) => r.occurrenceKey)).toEqual(['first', 'second']);
    expect(args.p_evidence.workerSha256).toBe('e'.repeat(64));
    expect(f.userRpc).toHaveBeenLastCalledWith('phoenix_c4_commit', { p_organization_id: org, p_planning_year: 2026,
      p_request_id: requestId, p_proof_id: proofId, p_expected_proof_sha256: 'c'.repeat(64) });
    expect(f.serviceRpc).toHaveBeenCalledOnce();
  });
  it('does not seal after permission revocation during worker computation', async () => {
    const f = setup(); f.run.mockImplementationOnce(async () => { f.authorized.mockResolvedValue(false); return { rows: [] }; });
    expect((await f.handler(request())).status).toBe(403); expect(f.service).not.toHaveBeenCalled();
  });
  it('holds a missing selected occurrence and a held page without sealing', async () => {
    const f = setup(); expect((await f.handler(request({ ...input, occurrenceKeys: ['absent'] }))).status).toBe(409);
    f.run.mockResolvedValueOnce({ preparationStatus: 'held', rows: [] });
    expect((await f.handler(request())).status).toBe(409); expect(f.service).not.toHaveBeenCalled();
  });
  it('keeps source conflicts and timeouts bounded without raw error leaks', async () => {
    const f = setup(); f.run.mockRejectedValueOnce(new Error('annual_c3_worker_timeout'));
    expect((await f.handler(request())).status).toBe(504); expect(f.service).not.toHaveBeenCalled();
    f.serviceRpc.mockResolvedValueOnce({ data: null, error: { message: 'c4_source_identity_conflict' } });
    expect((await f.handler(request())).status).toBe(409);
    f.serviceRpc.mockRejectedValueOnce(new Error('PRIVATE SECRET'));
    expect(await (await f.handler(request())).text()).not.toContain('PRIVATE');
  });
  it('returns a recoverable request reference for an unknown commit response', async () => {
    const f = setup(); f.userRpc.mockImplementation(async (name: string) => {
      if (name === 'phoenix_c4_commit') throw new Error('PRIVATE network failure');
      return { data: { version: 1, enabled: true, catalogCommitImplemented: true, trustedPreparationRequiresServer: true, maxPageRows: 50, maxEvidenceBytes: 262144 }, error: null };
    });
    const response = await f.handler(request()); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'c4_commit_outcome_unknown', requestId });
    expect(f.serviceRpc).toHaveBeenCalledOnce();
  });
});
