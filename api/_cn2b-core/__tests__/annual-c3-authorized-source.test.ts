import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedCaller } from '../../_lib/supabase';
import { createHash } from 'node:crypto';
const annualOriginalSha256 = async (bytes: Uint8Array): Promise<string> =>
  createHash('sha256').update(bytes).digest('hex');
const encodeAnnualOriginalBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
import { readAuthorizedAnnualC3Original } from '../annual-c3-authorized-source';

const scope = { ownerOrgId: '11111111-1111-4111-8111-111111111111', planningYear: 2026 };
const actorId = '22222222-2222-4222-8222-222222222222';
const originalId = '33333333-3333-4333-8333-333333333333';
const contract = {
  version: 1, scope: 'owner_year', maxFileBytes: 3145728, extensions: ['xls','xlsx','csv'],
  attestation: 'server_received_original', atomicReceipt: true, intentBoundReplay: true,
};
async function fixture() {
  const bytes = new TextEncoder().encode('National Code,Name\n001-02,Example\n');
  return {
    scope, original: {
      originalId, sha256: await annualOriginalSha256(bytes), byteSize: bytes.length,
      firstFilename: 'source.csv', createdBy: actorId, createdByName: 'Sample Employee',
      createdByRole: 'employee', createdAt: '2026-10-31T12:00:00Z',
      attestation: 'server_received_original',
    }, base64: encodeAnnualOriginalBytes(bytes),
  };
}
function callerFor(response: unknown, options: { allow?: boolean; noContract?: boolean; denyDownload?: boolean } = {}) {
  const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
    if (name === 'phoenix_central_needs_actor_authorized')
      return { data: options.allow !== false, error: null };
    if (name === 'phoenix_central_needs_annual_originals_contract')
      return options.noContract ? { data: null, error: { message: 'PGRST202' } }
        : { data: contract, error: null };
    if (name === 'phoenix_central_needs_download_annual_original')
      return options.denyDownload
        ? { data: null, error: { message: 'Secret internal detail' } }
        : { data: response, error: null };
    return { data: null, error: { message: 'unexpected RPC' } };
  });
  return { caller: {
    userId: actorId, accessToken: 'unit-test-placeholder',
    client: { rpc },
  } as unknown as AuthenticatedCaller, rpc };
}
describe('C3 server C2-original bridge — private, read-only', () => {
  it('accepts exact original, bound to the actor and owner/year, without service role', async () => {
    const stored = await fixture();
    const { caller, rpc } = callerFor(stored);
    const response = await readAuthorizedAnnualC3Original(caller, scope, originalId);
    expect(response.scope).toEqual(scope);
    expect(response.original.sha256).toBe(stored.original.sha256);
    expect(new TextDecoder().decode(response.bytes)).toBe('National Code,Name\n001-02,Example\n');
    expect(rpc.mock.calls.map(call => call[0])).toEqual([
      'phoenix_central_needs_actor_authorized',
      'phoenix_central_needs_annual_originals_contract',
      'phoenix_central_needs_download_annual_original',
    ]);
    expect(rpc.mock.calls[0][1]).toEqual({
      p_organization_id: scope.ownerOrgId, p_key: 'central_needs.view',
    });
    expect(rpc.mock.calls[2][1]).toEqual({
      p_organization_id: scope.ownerOrgId, p_planning_year: 2026, p_original_id: originalId,
    });
  });
  it('refuses revoked view permission before reading the original', async () => {
    const { caller, rpc } = callerFor(await fixture(), { allow: false });
    await expect(readAuthorizedAnnualC3Original(caller, scope, originalId))
      .rejects.toThrow('annual_c3_forbidden');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('refuses a missing C2 capability without falling back to imports', async () => {
    const { caller, rpc } = callerFor(await fixture(), { noContract: true });
    await expect(readAuthorizedAnnualC3Original(caller, scope, originalId))
      .rejects.toThrow('annual_c3_capability_unavailable');
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('refuses a read denial without exposing the provider error', async () => {
    const { caller, rpc } = callerFor(await fixture(), { denyDownload: true });
    await expect(readAuthorizedAnnualC3Original(caller, scope, originalId))
      .rejects.toThrow('annual_c3_original_unavailable');
    expect(rpc).toHaveBeenCalledTimes(3);
  });
  it('rejects foreign scope and a different original ID returned by the server', async () => {
    const source = await fixture();
    const { caller } = callerFor({ ...source, scope: { ...scope, planningYear: 2027 } });
    await expect(readAuthorizedAnnualC3Original(caller, scope, originalId)).rejects.toThrow('scope.mismatch');
    const { caller: wrong } = callerFor({ ...source, original: {
      ...source.original, originalId: '44444444-4444-4444-8444-444444444444',
    } });
    await expect(readAuthorizedAnnualC3Original(wrong, scope, originalId))
      .rejects.toThrow('annual_c3_original_identity_mismatch');
  });
  it('rejects tampered bytes, wrong size or malformed server responses', async () => {
    const source = await fixture();
    const bad = { ...source,
      base64: encodeAnnualOriginalBytes(new TextEncoder().encode('National Code,Name\n002-02,Example\n')),
    };
    const { caller } = callerFor(bad);
    await expect(readAuthorizedAnnualC3Original(caller, scope, originalId))
      .rejects.toThrow('annual_c3_original_sha256_mismatch');
    const { caller: malformed } = callerFor({ ...source, base64: undefined });
    await expect(readAuthorizedAnnualC3Original(malformed, scope, originalId))
      .rejects.toThrow('annual_c3_base64_invalid');
    const { caller: wrongSize } = callerFor({ ...source, original: { ...source.original, byteSize: 1 } });
    await expect(readAuthorizedAnnualC3Original(wrongSize, scope, originalId))
      .rejects.toThrow('annual_c3_base64_invalid');
  });
  it('rejects invalid actor and request UUIDs before sending RPCs', async () => {
    const { caller, rpc } = callerFor(await fixture());
    await expect(readAuthorizedAnnualC3Original({ ...caller, userId: 'unverified' }, scope, originalId))
      .rejects.toThrow('annual_c3_invalid_uuid');
    await expect(readAuthorizedAnnualC3Original(caller, scope, 'invalid-id'))
      .rejects.toThrow('annual_c3_invalid_uuid');
    expect(rpc).not.toHaveBeenCalled();
  });
});
