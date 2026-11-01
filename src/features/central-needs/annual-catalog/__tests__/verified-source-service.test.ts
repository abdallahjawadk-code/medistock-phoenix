import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), session: vi.fn(), fetch: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: mocks.rpc, auth: { getSession: mocks.session } } }));
import { discoverAnnualSourceProfiles, readAnnualSourcePage, commitVerifiedMembership, getVerifiedMembershipReceipt, isVerifiedSourceOutcomeUnknown, VerifiedSourceError } from '../verified-source.service';
import type { VerifiedMembershipIntent } from '../verified-source.contract';
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const scope = { ownerOrgId: id(1), planningYear: 2026 }, actor = id(2);
const input = { scope, original: { originalId: id(3), sha256: 'a'.repeat(64), byteSize: 100, firstFilename: 'synthetic.csv' },
  profile: { id: 'synthetic-reviewed', version: 1, sha256: 'b'.repeat(64) }, cursor: null, pageSize: 50 };
const intent: VerifiedMembershipIntent = { actorId: actor, request: { scope, requestId: id(4), originalId: id(3), expectedOriginalSha256: 'a'.repeat(64),
  templateId: 'synthetic-reviewed', templateVersion: 1, expectedTemplateSha256: 'b'.repeat(64), cursor: null, pageSize: 50,
  occurrenceKeys: ['one reviewed occurrence'], canonicalItemId: id(5), expectedCanonicalFingerprint: 'c'.repeat(64), reason: 'Explicit review' } };
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', mocks.fetch);
  mocks.session.mockResolvedValue({ data: { session: { user: { id: actor }, access_token: 'synthetic-local-test-token' } }, error: null }); });
afterEach(() => vi.unstubAllGlobals());
describe('C4 employee transport; no service privilege, fallback or automatic retry', () => {
  it('discovers scoped profiles with the current employee and disables caching and redirects', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ ok: true, capabilities: { version: 1, scope, selectionMode: 'explicit_reviewed_profile',
      readAvailable: false, commitState: 'unavailable_registry', profiles: [], maxPageRows: 50, maxRequestBytes: 16384 } }));
    expect(await discoverAnnualSourceProfiles(scope, actor)).toMatchObject({ readAvailable: false });
    const [url, request] = mocks.fetch.mock.calls[0]; expect(url).toBe(`/api/central-needs/annual-source-capabilities?ownerOrgId=${scope.ownerOrgId}&planningYear=2026`);
    expect(request).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error', credentials: 'omit' });
    expect(request.headers.authorization).toBe('Bearer synthetic-local-test-token');
  });
  it('reads only six authorized source choices, never browser cells, maps or quantities', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ ok: false, error: 'c3_reviewed_layout_unavailable' }, { status: 409 }));
    await expect(readAnnualSourcePage(input, actor)).rejects.toThrow();
    const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(Object.keys(body)).toEqual(['scope', 'originalId', 'templateId', 'templateVersion', 'cursor', 'pageSize']);
    expect(body.templateId).toBe(input.profile.id); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('refuses an old actor before sending any request or receipt RPC', async () => {
    mocks.session.mockResolvedValue({ data: { session: { user: { id: id(9) }, access_token: 'synthetic-other-actor' } }, error: null });
    await expect(commitVerifiedMembership(intent)).rejects.toMatchObject({ outcomeUnknown: false, code: 'source_session_changed' });
    await expect(getVerifiedMembershipReceipt(intent)).rejects.toThrow(); expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    [400, 'invalid_request'], [401, 'not_authenticated'], [403, 'forbidden'], [409, 'c4_review_conflict'], [503, 'c4_unavailable'],
  ])('recognizes only the specific server refusal at %s/%s', async (status, error) => {
    mocks.fetch.mockResolvedValue(Response.json({ ok: false, error }, { status }));
    await expect(commitVerifiedMembership(intent)).rejects.toMatchObject({ code: error, outcomeUnknown: false });
    expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(['transport', 'nonjson', 'malformed200', 'unknown503'])('retains unknown outcome after %s; never retries or calls the old writer', async failure => {
    if (failure === 'transport') mocks.fetch.mockRejectedValue(new Error('network'));
    else if (failure === 'nonjson') mocks.fetch.mockResolvedValue(new Response('<html>upstream</html>', { status: 502 }));
    else mocks.fetch.mockResolvedValue(Response.json(failure === 'malformed200' ? { ok: true, result: {} } : { ok: false, error: 'c4_commit_outcome_unknown', requestId: id(4) }, { status: failure === 'malformed200' ? 200 : 503 }));
    await expect(commitVerifiedMembership(intent)).rejects.toBeInstanceOf(VerifiedSourceError);
    mocks.fetch.mockClear();
    await expect(commitVerifiedMembership(intent)).rejects.toMatchObject({ outcomeUnknown: true, requestId: id(4) });
    expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('receipt reconciliation reads once and does not replay the write for prepared or missing receipts', async () => {
    for (const data of [{ status: 'missing', requestId: id(4) }, { status: 'prepared', requestId: id(4), proofId: id(6), proofSha256: 'e'.repeat(64) }]) {
      mocks.rpc.mockResolvedValue({ data, error: null }); expect(await getVerifiedMembershipReceipt(intent)).toEqual(data);
    }
    expect(mocks.rpc).toHaveBeenLastCalledWith('phoenix_c4_receipt', { p_organization_id: id(1), p_planning_year: 2026, p_request_id: id(4) });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('keeps receipt failure unresolved rather than treating it as missing', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'forbidden_central_needs' } });
    await expect(getVerifiedMembershipReceipt(intent)).rejects.toThrow(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('bounds an oversized acknowledgement and preserves unknown write outcome', async () => {
    mocks.fetch.mockResolvedValue(new Response(' '.repeat(262145)));
    await expect(commitVerifiedMembership(intent)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('separates an invalid unsent intent from an unknown sent command', async () => {
    let refusal: unknown;
    try { await commitVerifiedMembership({ ...intent, request: { ...intent.request, reason: '' } }); } catch (error) { refusal = error; }
    expect(refusal).toBeDefined(); expect(isVerifiedSourceOutcomeUnknown(refusal)).toBe(false);
    expect(isVerifiedSourceOutcomeUnknown(new Error('unexpected after send'))).toBe(true); expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
