import { describe, expect, it, vi } from 'vitest';
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
import { annualFixture, annualItem, ID, SCOPE } from './annual-ui-fixtures';
import { simpleInput } from './fixture-helpers';
import { extractAnnualIdentityBlock } from '../annual-catalog-source';
import { validateAnnualOccurrences } from '../annual-catalog-server.contract';
import { createVerifiedMembershipIntent, decodeSourceCapabilities, decodeSourcePage, decodeVerifiedMembership, decodeVerifiedReceipt, freezeVerifiedIntent } from '../verified-source.contract';
const profile = { id: 'synthetic-reviewed', version: 1, sha256: 'b'.repeat(64) };
const original = { originalId: 'a0000000-0000-4000-8000-000000000001', sha256: 'a'.repeat(64), byteSize: 100, firstFilename: 'synthetic.xlsx' };
const expected = { scope: SCOPE, original, profile, pageSize: 50, cursor: null };
function page() {
  const input = simpleInput(); input.scope = SCOPE; input.sourceScope = SCOPE; input.sourceId = original.originalId;
  const rows = extractAnnualIdentityBlock(input);
  return { scope: SCOPE, original: { originalId: original.originalId, sha256: original.sha256, byteSize: 100, attestation: 'server_received_original' },
    template: { ...profile, version: '1' }, status: 'source_evidence_only_review_required', preparationStatus: 'prepared', persisted: false,
    coreTemplate: { id: profile.id, version: 1, reviewReference: 'Synthetic review', sha256: 'c'.repeat(64) },
    parser: input.parsed.identity, registrySha256: 'd'.repeat(64), classifications: [], rows, totalRows: rows.length, nextCursor: null as string | null };
}
const intent = { actorId: ID.actor, request: { scope: SCOPE, requestId: ID.request, originalId: original.originalId,
  expectedOriginalSha256: original.sha256, templateId: profile.id, templateVersion: 1, expectedTemplateSha256: profile.sha256,
  cursor: null, pageSize: 50, occurrenceKeys: ['reviewed-choice'], canonicalItemId: ID.canonical, expectedCanonicalFingerprint: 'a'.repeat(64), reason: 'Reviewed exact identity' } };
function result() { const item = annualItem(); return { ...item, membership: { ...item.membership, occurrenceKeys: [ID.event] }, sourceOccurrenceCount: 1, idempotentReplay: false, c4Verification: { attestation: 'server_verified_c2_extraction_v1',
  proofId: ID.change, proofSha256: 'e'.repeat(64), originalId: original.originalId, originalSha256: original.sha256,
  registrationSha256: profile.sha256, workerSha256: 'f'.repeat(64), reviewedById: ID.actor, reviewedByName: 'Synthetic trusted employee', reviewedAt: '2026-11-01T10:00:00Z' } }; }
describe('C3/C4 browser evidence boundary, separate from persisted A1', () => {
  it('accepts an empty registry as unavailable without inventing a profile', () => {
    const capabilities = { version: 1, scope: SCOPE, selectionMode: 'explicit_reviewed_profile', readAvailable: false,
      commitState: 'unavailable_registry', profiles: [], maxPageRows: 50, maxRequestBytes: 16384 };
    expect(decodeSourceCapabilities({ ok: true, capabilities }, SCOPE).profiles).toEqual([]);
    expect(() => decodeSourceCapabilities({ ok: true, capabilities: { ...capabilities, commitState: 'ready' } }, SCOPE)).toThrow();
  });
  it('keeps explicit profile choice and independent commit states', () => {
    for (const commitState of ['forbidden', 'missing_candidate', 'inactive', 'ready']) {
      expect(decodeSourceCapabilities({ ok: true, capabilities: { version: 1, scope: SCOPE, selectionMode: 'explicit_reviewed_profile',
        readAvailable: true, commitState, profiles: [profile], maxPageRows: 50, maxRequestBytes: 16384 } }, SCOPE).commitState).toBe(commitState);
    }
  });
  it('refuses a non-string commit-state enum rather than coercing JSON arrays', () => {
    expect(() => decodeSourceCapabilities({ ok: true, capabilities: { version: 1, scope: SCOPE, selectionMode: 'explicit_reviewed_profile',
      readAvailable: true, commitState: ['ready'], profiles: [profile], maxPageRows: 50, maxRequestBytes: 16384 } }, SCOPE)).toThrow();
  });
  it('refuses a non-string held-reason enum rather than coercing JSON arrays', () => {
    const prepared = page(), held = Object.fromEntries(Object.entries(prepared).filter(([key]) => !['coreTemplate','parser','registrySha256','classifications'].includes(key)));
    expect(() => decodeSourcePage({ ok: true, evidence: { ...held, preparationStatus: 'held', heldReason: ['layout_unavailable'], rows: [], totalRows: 0 } }, expected)).toThrow();
  });
  it('accepts server C3 deterministic keys and preserves the stricter persisted UUID contract', () => {
    const evidence = page(); expect(decodeSourcePage({ ok: true, evidence }, expected).rows).toHaveLength(1);
    expect(() => validateAnnualOccurrences(evidence.rows, SCOPE, 'response')).toThrow();
    expect(evidence.rows[0].fields.nationalCode).toMatchObject({ state: 'value', text: '000123-04' });
  });
  it('compares parser identity fields independently of JSON property order', () => {
    const evidence = page(); evidence.parser = Object.fromEntries(Object.entries(evidence.parser).reverse()) as typeof evidence.parser;
    expect(decodeSourcePage({ ok: true, evidence }, expected).preparationStatus).toBe('prepared');
  });
  it('freezes only explicit choices for the current page and opaque canonical preview', async () => {
    const canonical = await annualFixture().api.previewAnnualCanonical(SCOPE, ID.canonical), evidence = page();
    const checked = createVerifiedMembershipIntent({ actorId: ID.actor, requestId: ID.request, source: expected,
      page: decodeSourcePage({ ok: true, evidence }, expected), occurrenceKeys: [evidence.rows[0].occurrenceKey], canonical, reason: 'Explicit source review' });
    expect(Object.keys(checked.request)).toHaveLength(13); expect(Object.isFrozen(checked.request.occurrenceKeys)).toBe(true);
    expect(checked.request.expectedTemplateSha256).toBe(profile.sha256); expect(JSON.stringify(checked)).not.toContain('rawValue');
    expect(() => createVerifiedMembershipIntent({ actorId: ID.actor, requestId: ID.request, source: expected,
      page: decodeSourcePage({ ok: true, evidence }, expected), occurrenceKeys: ['other-page-row'], canonical, reason: 'Explicit review' })).toThrow();
    expect(() => freezeVerifiedIntent({ ...checked, request: { ...checked.request, reason: ' ' } })).toThrow();
    expect(() => freezeVerifiedIntent({ ...checked, request: { ...checked.request, occurrenceKeys: [evidence.rows[0].occurrenceKey, evidence.rows[0].occurrenceKey] } })).toThrow();
  });
  it.each([
    (p: ReturnType<typeof page>) => { p.template.sha256 = p.coreTemplate.sha256; },
    (p: ReturnType<typeof page>) => { p.template.version = '2'; },
    (p: ReturnType<typeof page>) => { p.original.sha256 = 'f'.repeat(64); },
    (p: ReturnType<typeof page>) => { p.rows[0].source.sourceId = ID.request; },
    (p: ReturnType<typeof page>) => { p.rows[0].occurrenceKey = ID.request; },
    (p: ReturnType<typeof page>) => { p.totalRows = 0; },
    (p: ReturnType<typeof page>) => { p.nextCursor = 'not valid cursor'; },
  ])('refuses a substituted or inconsistent evidence page %#', mutate => {
    const evidence = page(); mutate(evidence); expect(() => decodeSourcePage({ ok: true, evidence }, expected)).toThrow();
  });
  it('preserves a held source without allowing rows or a continuation', () => {
    const prepared = page();
    const held = Object.fromEntries(Object.entries(prepared).filter(([key]) => !['coreTemplate','parser','registrySha256','classifications'].includes(key)));
    const evidence = { ...held, preparationStatus: 'held', heldReason: 'layout_unavailable', rows: [], totalRows: 0 };
    expect(decodeSourcePage({ ok: true, evidence }, expected)).toMatchObject({ preparationStatus: 'held', heldReason: 'layout_unavailable', rows: [] });
    expect(() => decodeSourcePage({ ok: true, evidence: { ...evidence, rows: prepared.rows } }, expected)).toThrow();
  });
  it('validates C4 attestation separately while retaining A1 client attestation', () => {
    const checked = decodeVerifiedMembership(result(), intent);
    expect(checked.sourceAttestation).toBe('client_attested'); expect(checked.c4Verification.reviewedById).toBe(ID.actor);
    for (const field of ['originalId', 'reviewedById', 'registrationSha256', 'originalSha256'] as const) {
      const changed = result(); changed.c4Verification[field] = field.endsWith('Id') ? ID.request : '0'.repeat(64);
      expect(() => decodeVerifiedMembership(changed, intent)).toThrow();
    }
  });
  it('checks receipt request identity and requires committed receipt refresh before selection', () => {
    expect(decodeVerifiedReceipt({ status: 'prepared', requestId: ID.request, proofId: ID.change, proofSha256: 'e'.repeat(64) }, intent)).toMatchObject({ status: 'prepared' });
    expect(() => decodeVerifiedReceipt({ status: 'missing', requestId: ID.change }, intent)).toThrow();
    const replay = { ...result(), idempotentReplay: true, selectable: false, selectionBlockers: ['receipt_replay_requires_refresh'] };
    expect(decodeVerifiedReceipt({ status: 'committed', requestId: ID.request, result: replay }, intent)).toMatchObject({ status: 'committed', result: { selectable: false } });
    expect(() => decodeVerifiedReceipt({ status: 'committed', requestId: ID.request, result: result() }, intent)).toThrow();
  });
});
