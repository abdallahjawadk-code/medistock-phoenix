/**
 * R1 / ST-15 — API-side hardening of the storage-first import.
 * Dynamic proofs of the two helpers plus static proofs that the handlers use them
 * at the required points. None of this is an atomic-revocation guarantee.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AuthenticatedCaller, ResolvedRevision } from '../supabase.ts';
import { reassertImportAuthority, type AuthorityDeps } from '../import-authority.ts';
import { verifyPermanentObject, type StorageDownloader } from '../object-integrity.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const REV = '22222222-2222-4222-8222-222222222222';
const caller = {} as AuthenticatedCaller;
const rev = (over: Partial<ResolvedRevision> = {}): ResolvedRevision => ({
  id: REV, organizationId: ORG, planId: 'p', status: 'draft', revisionNumber: 1, ...over,
});
const deps = (r: ResolvedRevision | null, authorized: boolean | 'throw'): AuthorityDeps => ({
  resolveRevision: async () => r,
  isAuthorized: async () => { if (authorized === 'throw') throw new Error('rpc'); return authorized; },
});

describe('reassertImportAuthority (fail closed)', () => {
  it('allows only an authorized caller on the same organization and a draft revision', async () => {
    expect(await reassertImportAuthority(caller, REV, ORG, deps(rev(), true))).toEqual({ ok: true });
  });

  it('denies when the revision is no longer visible', async () => {
    const d = await reassertImportAuthority(caller, REV, ORG, deps(null, true));
    expect(d).toMatchObject({ ok: false, status: 404 });
  });

  it('denies when authority was revoked', async () => {
    expect(await reassertImportAuthority(caller, REV, ORG, deps(rev(), false)))
      .toMatchObject({ ok: false, status: 403, code: 'authority_lost_during_import' });
  });

  it('denies when the authorization check itself fails', async () => {
    expect(await reassertImportAuthority(caller, REV, ORG, deps(rev(), 'throw')))
      .toMatchObject({ ok: false, status: 403 });
  });

  it('denies when the revision belongs to a different organization than authorized at the start', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    expect(await reassertImportAuthority(caller, REV, ORG, deps(rev({ organizationId: other }), true)))
      .toMatchObject({ ok: false, status: 409, code: 'import_scope_changed' });
  });

  it.each(['submitted', 'approved', 'rejected', 'superseded', 'withdrawn'])('denies a %s revision', async (status) => {
    expect(await reassertImportAuthority(caller, REV, ORG, deps(rev({ status }), true)))
      .toMatchObject({ ok: false, status: 409, code: 'plan_revision_not_editable' });
  });

  it('denies when the revision lookup throws', async () => {
    const d: AuthorityDeps = { resolveRevision: async () => { throw new Error('x'); }, isAuthorized: async () => true };
    expect(await reassertImportAuthority(caller, REV, ORG, d)).toMatchObject({ ok: false });
  });
});

const sha = async (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = new TextEncoder().encode('workbook-bytes');
const good = createHash('sha256').update(bytes).digest('hex');
const storage = (o: Partial<{ data: Uint8Array | null; error: unknown; throws: boolean; badRead: boolean }>): StorageDownloader => ({
  download: async () => {
    if (o.throws) throw new Error('net');
    return {
      data: o.data === null || o.data === undefined ? null : {
        arrayBuffer: async () => { if (o.badRead) throw new Error('read'); return o.data!.buffer.slice(o.data!.byteOffset, o.data!.byteOffset + o.data!.byteLength) as ArrayBuffer; },
      },
      error: o.error ?? null,
    };
  },
});

describe('verifyPermanentObject (fail closed)', () => {
  it('passes only when the object exists and hashes to the recorded SHA-256', async () => {
    expect(await verifyPermanentObject(storage({ data: bytes }), 'k', good, 1024, sha)).toEqual({ ok: true });
  });

  it('denies a missing object', async () => {
    expect(await verifyPermanentObject(storage({ data: null, error: { m: 'x' } }), 'k', good, 1024, sha))
      .toMatchObject({ ok: false, status: 404, code: 'source_object_missing' });
  });

  it('denies a tampered or mismatching object', async () => {
    expect(await verifyPermanentObject(storage({ data: new TextEncoder().encode('other') }), 'k', good, 1024, sha))
      .toMatchObject({ ok: false, status: 409, code: 'source_object_hash_mismatch' });
  });

  it('denies an oversized object without hashing it', async () => {
    expect(await verifyPermanentObject(storage({ data: bytes }), 'k', good, 3, sha))
      .toMatchObject({ ok: false, status: 413 });
  });

  it('denies when Storage throws or the body cannot be read', async () => {
    expect(await verifyPermanentObject(storage({ throws: true }), 'k', good, 1024, sha)).toMatchObject({ ok: false, status: 502 });
    expect(await verifyPermanentObject(storage({ data: bytes, badRead: true }), 'k', good, 1024, sha)).toMatchObject({ ok: false, status: 502 });
  });

  it('denies a malformed expected hash (no evidence to compare against)', async () => {
    expect(await verifyPermanentObject(storage({ data: bytes }), 'k', 'NOT-A-HASH', 1024, sha))
      .toMatchObject({ ok: false, status: 409 });
  });
});

describe('handler wiring (static)', () => {
  const api = join(__dirname, '..', '..', '_cn2b-core');
  const finalize = readFileSync(join(api, 'finalize-import.ts'), 'utf8');
  const download = readFileSync(join(api, 'source-download.ts'), 'utf8');

  it('finalize re-asserts the caller before the permanent write, each trusted replay and the registration', () => {
    const uses = finalize.match(/reassertImportAuthority\(/g) ?? [];
    expect(uses.length).toBe(3);
    const reassertBeforeUpload = finalize.indexOf('reassertImportAuthority(') < finalize.indexOf('.upload(permanentKey');
    expect(reassertBeforeUpload).toBe(true);
    const replayAt = finalize.indexOf("'phoenix_central_needs_apply_authoritative_replay'");
    const lastReassertBeforeReplay = finalize.lastIndexOf('reassertImportAuthority(', replayAt);
    expect(lastReassertBeforeReplay).toBeGreaterThan(finalize.indexOf('for (let i = 0'));
    const registerAt = finalize.indexOf("'phoenix_central_needs_register_import_batch'");
    expect(finalize.lastIndexOf('reassertImportAuthority(', registerAt)).toBeGreaterThan(finalize.indexOf('manifest.push('));
  });

  it('finalize never deletes or overwrites a permanent object', () => {
    expect(finalize).toMatch(/upsert:\s*false/);
    expect(finalize).not.toMatch(/\.remove\(\[permanent/);
  });

  it('source-download verifies the object before it signs a URL', () => {
    const verifyAt = download.indexOf('verifyPermanentObject(');
    const signAt = download.indexOf('createSignedUrl(');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(signAt);
  });
});
