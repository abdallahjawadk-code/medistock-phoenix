import { describe, expect, it, vi } from 'vitest';
import { readC4MembershipInput } from '../input';

const input = {
  scope: { ownerOrgId: '11111111-1111-4111-8111-111111111111', planningYear: 2026 },
  requestId: '22222222-2222-4222-8222-222222222222',
  originalId: '33333333-3333-4333-8333-333333333333',
  expectedOriginalSha256: 'a'.repeat(64), templateId: 'synthetic', templateVersion: 1,
  expectedTemplateSha256: 'b'.repeat(64), cursor: null, pageSize: 1,
  occurrenceKeys: ['synthetic-occurrence'], canonicalItemId: '44444444-4444-4444-8444-444444444444',
  expectedCanonicalFingerprint: 'c'.repeat(64), reason: 'Synthetic explicit review',
};
const request = (body: unknown) => new Request('http://localhost/input', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
describe('Vercel own-field validation compatibility', () => {
  it('validates C4 without requiring Object.hasOwn', async () => {
    const req = request(input);
    const native = vi.spyOn(Object, 'hasOwn').mockImplementation(() => { throw new Error('unsupported_ES2022_API'); });
    let result;
    try { result = await readC4MembershipInput(req); } finally { native.mockRestore(); }
    expect(result).toEqual(input);
  });
  it('still rejects extra fields and prototype-named additions', async () => {
    await expect(readC4MembershipInput(request({ ...input, hasOwnProperty: true }))).rejects.toThrow('invalid_request');
    await expect(readC4MembershipInput(request({ ...input, scope: { ...input.scope, constructor: 'untrusted' } })))
      .rejects.toThrow('invalid_request');
  });
});
