/**
 * CN-2B — trusted-server and UI boundary guards.
 *
 * These are the assertions that do not need a database: the secret boundary,
 * object-key safety, browser/Node parity masking, navigation authorization,
 * and the routing change that lets /api exist at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compareParsedResults, maskArchiveResult } from '../../../../api/_lib/parity';
import {
  entryLocator,
  objectKeyFromLocator,
  permanentSourceKey,
  stagingPreviewKey,
  stagingSourceKey,
  UnsafePathSegmentError,
} from '../../../../api/_lib/storage-paths';
import { SOURCE_BUCKET, TRANSPORT_LIMITS } from '../../../../api/_lib/env';
import { isScreenAuthorized, CENTRAL_NEEDS_SCREEN, CENTRAL_NEEDS_VIEW_PERMISSION } from '@/shared/authz/screen-access';

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// Public Vercel entrypoints are intentionally thin named-POST wrappers. Static
// business/security assertions must inspect the trusted handler modules they
// delegate to, while the separate runtime-contract suite verifies the wrappers.
const CN2B_CORE = {
  uploadTicket: 'api/_cn2b-core/upload-ticket.ts',
  finalizeImport: 'api/_cn2b-core/finalize-import.ts',
  sourceDownload: 'api/_cn2b-core/source-download.ts',
} as const;

/**
 * Source with comments removed. These guards assert about CODE: this
 * feature's own documentation says things like "never trusts formattedText",
 * and prose must never be able to satisfy — or break — a check.
 */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** Only the two fields the masking assertions read back. */
interface MaskedArchive {
  identity: { runtime: string };
  entries: Array<{ identity: { runtime: string } }>;
}

/** The slice of vercel.json these guards actually read. */
interface VercelRewrite { source: string; destination: string }
interface VercelHeader { key: string; value: string }

const ORG = '11111111-1111-4111-8111-111111111111';
const REV = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const UPLOAD = '44444444-4444-4444-8444-444444444444';
const SHA = 'a'.repeat(64);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(rel);
  }
  return out;
}

describe('CN-2B — service-role secret boundary', () => {
  const SERVICE_KEY_VAR = 'PHOENIX_SUPABASE_SERVICE_ROLE_KEY';

  it('the service-role variable name does not start with VITE_', () => {
    // Vite inlines every VITE_-prefixed variable into the browser bundle at
    // build time, so the NAME is part of the boundary, not only the usage.
    expect(SERVICE_KEY_VAR.startsWith('VITE_')).toBe(false);
    expect(read('api/_lib/env.ts')).toContain(SERVICE_KEY_VAR);
  });

  it('no production file under src/ mentions the service-role key at all', () => {
    // Scoped to shipped code: unrelated pre-existing SUITES legitimately name
    // service_role while asserting about database grants, and those never
    // reach a browser bundle.
    const offenders = walk('src')
      .filter((f) => !f.includes('__tests__'))
      .filter((f) => read(f).includes('SERVICE_ROLE') || read(f).includes('service_role'));
    expect(offenders).toEqual([]);
  });

  it('no file under src/ imports anything from the api/ tree', () => {
    const offenders = walk('src')
      .filter((f) => !f.includes('__tests__'))
      .filter((f) => /from\s+['"][^'"]*\bapi\/_lib\b/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('the browser service layer never receives a signed-URL secret from the server', () => {
    const service = read('src/features/central-needs/central-needs.service.ts');
    expect(service).not.toContain('serviceClient');
    expect(service).not.toContain('SERVICE_ROLE');
  });

  it('only the trusted server constructs a service-role client', () => {
    const supa = read('api/_lib/supabase.ts');
    expect(supa).toContain('supabaseServiceRoleKey()');
    // The user-scoped path uses the anon key plus the caller's own bearer token.
    expect(supa).toContain('supabaseAnonKey()');
    expect(supa).toContain('Authorization: `Bearer ${accessToken}`');
  });

  it('no endpoint or trusted handler returns the caller a service-role credential', () => {
    for (const f of [
      'api/central-needs/upload-ticket.ts',
      'api/central-needs/finalize-import.ts',
      'api/central-needs/source-download.ts',
      ...Object.values(CN2B_CORE),
    ]) {
      const body = read(f);
      expect(body, f).not.toMatch(/jsonResponse\([^)]*serviceRole/i);
      expect(body, f).not.toContain('supabaseServiceRoleKey');
    }
  });
});

describe('CN-2B — object keys are never user-controlled', () => {
  const identity = { organizationId: ORG, planRevisionId: REV, userId: USER, uploadId: UPLOAD };

  it('builds staging keys from server-generated UUIDs only', () => {
    expect(stagingSourceKey(identity)).toBe(`staging/${ORG}/${REV}/${USER}/${UPLOAD}/source.bin`);
    expect(stagingPreviewKey(identity)).toBe(`staging/${ORG}/${REV}/${USER}/${UPLOAD}/preview.json`);
  });

  it('builds a content-addressed permanent key', () => {
    expect(permanentSourceKey(ORG, REV, SHA)).toBe(`permanent/${ORG}/${REV}/${SHA}`);
  });

  it('refuses every traversal and separator attempt', () => {
    const hostile = [
      '../../etc/passwd', '..', '.', 'a/../../b', 'a\\b', `${ORG}/../..`,
      `${ORG}%2f..`, '', ' ', `${ORG}\u0000`, 'null', `${ORG}/`,
    ];
    for (const bad of hostile) {
      expect(() => permanentSourceKey(bad, REV, SHA), bad).toThrow(UnsafePathSegmentError);
      expect(() => permanentSourceKey(ORG, bad, SHA), bad).toThrow(UnsafePathSegmentError);
      expect(() => permanentSourceKey(ORG, REV, bad), bad).toThrow(UnsafePathSegmentError);
    }
  });

  it('a user-controlled filename can never reach a key', () => {
    // The key builders accept no filename argument at all — the strongest
    // possible form of "the filename is not part of the path".
    expect(permanentSourceKey.length).toBe(3);
    expect(String(permanentSourceKey)).not.toContain('filename');
    expect(String(stagingSourceKey)).not.toContain('filename');
    const paths = read('api/_lib/storage-paths.ts');
    expect(paths).not.toMatch(/originalFilename|containerFilename/);
  });

  it('a ZIP entry path is encoded into the locator, never into the object key', () => {
    const key = permanentSourceKey(ORG, REV, SHA);
    const locator = entryLocator(key, 2, 'b'.repeat(64));
    expect(locator.startsWith(`${key}#`)).toBe(true);
    // The archive itself remains the only stored object.
    expect(objectKeyFromLocator(locator)).toBe(key);
    expect(() => entryLocator(key, 0, SHA)).toThrow(UnsafePathSegmentError);
    expect(() => entryLocator(key, 1, '../etc')).toThrow(UnsafePathSegmentError);
  });

  it('a tampered locator resolves to nothing', () => {
    for (const bad of [
      'permanent/../../secret', 'staging/x/y/z', '', 'permanent/only/two',
      `permanent/${ORG}/${REV}/notahash`, `evil/${ORG}/${REV}/${SHA}`,
    ]) {
      expect(objectKeyFromLocator(bad), bad).toBeNull();
    }
  });

  it('uses one private bucket with two namespaces', () => {
    expect(SOURCE_BUCKET).toBe('central-needs-source-files');
    expect(stagingSourceKey(identity).startsWith('staging/')).toBe(true);
    expect(permanentSourceKey(ORG, REV, SHA).startsWith('permanent/')).toBe(true);
  });

  it('documents transport limits as CN-2B policy, separate from parser limits', () => {
    expect(TRANSPORT_LIMITS.maxSourceBytes).toBeGreaterThan(0);
    expect(TRANSPORT_LIMITS.signedDownloadTtlSeconds).toBeLessThanOrEqual(3600);
    expect(read('api/_lib/env.ts')).toContain('TRANSPORT POLICY');
    // The frozen parser contract is neither imported nor re-declared here:
    // a transport refusal is never dressed up as a parser diagnostic.
    expect(code('api/_lib/env.ts')).not.toContain('DEFAULT_PARSER_LIMITS');
    expect(code('api/_lib/env.ts')).not.toMatch(/import[^;]*contract/);
  });
});

describe('CN-2B — signed-URL TTL truth', () => {
  it('download TTL is ours to set and is actually passed to the provider', () => {
    expect(TRANSPORT_LIMITS.signedDownloadTtlSeconds).toBe(300);
    const dl = read(CN2B_CORE.sourceDownload);
    // The value is an ARGUMENT to createSignedUrl, so it is really enforced.
    expect(dl).toContain('createSignedUrl(objectKey, TRANSPORT_LIMITS.signedDownloadTtlSeconds');
    expect(dl).toContain('expiresInSeconds: TRANSPORT_LIMITS.signedDownloadTtlSeconds');
  });

  it('upload TTL reports the PROVIDER contract and never a shorter local claim', () => {
    // createSignedUploadUrl takes no expiry argument; Supabase Storage fixes the
    // token at two hours. Reporting 300s would be a promise it does not keep.
    expect(TRANSPORT_LIMITS.signedUploadTtlSeconds).toBe(7200);
    expect(TRANSPORT_LIMITS.signedUploadTtlSource).toBe('supabase-storage-provider-default');

    const ticket = read(CN2B_CORE.uploadTicket);
    expect(ticket).toContain('expiresInSeconds: TRANSPORT_LIMITS.signedUploadTtlSeconds');
    // The upload path must not borrow the download TTL…
    expect(code(CN2B_CORE.uploadTicket)).not.toContain('signedDownloadTtlSeconds');
    // …and must not hand createSignedUploadUrl an expiry it cannot honour.
    expect(ticket).toMatch(/createSignedUploadUrl\(\s*\w+\s*\)/);
    expect(code(CN2B_CORE.uploadTicket)).not.toMatch(/createSignedUploadUrl\([^)]*,[^)]*\)/);
  });

  it('the two TTLs are distinct values with distinct names', () => {
    expect(TRANSPORT_LIMITS.signedUploadTtlSeconds)
      .not.toBe(TRANSPORT_LIMITS.signedDownloadTtlSeconds);
    expect(code('api/_lib/env.ts')).not.toContain('signedUrlTtlSeconds');
  });

  it('records the staging lifecycle requirement the bucket owner must apply', () => {
    const env = read('api/_lib/env.ts');
    expect(env).toContain('STAGING_LIFECYCLE_REQUIREMENT');
    expect(env).toContain("prefix: 'staging/'");
    // permanent/ is immutable evidence and must be excluded from any expiry.
    expect(env).toContain("mustNotApplyTo: 'permanent/'");
  });
});

describe('CN-2B — browser/Node parity', () => {
  const provenance = (extractedAt: string) => ({
    fileFingerprintSha256: SHA, originalFilename: 'n.xls', parserVersion: '1.0.0/0.20.3',
    sheetIndex: 0, sheetName: 'S', sheetHidden: 'visible',
    coordinate: { row: 1, col: 1, a1: 'B2' }, extractedAt,
  });

  const fileResult = (runtime: string, extractedAt: string, value: unknown = 0) => ({
    outcome: 'accepted',
    identity: { contractVersion: '1.0.0', sheetjsVersion: '0.20.3', sheetjsTarballSha256: SHA, runtime },
    input: { originalFilename: 'n.xls', sha256: SHA, byteSize: 10 },
    workbook: { format: 'xls', sheets: [], vbaPresent: false, totals: { sheetCount: 1 } },
    family: { family: 'unknown', confidence: 0, evidence: ['none'] },
    diagnostics: [],
    sourceRecords: [{
      targetEntity: 'sheet:0:row:1', fieldName: 'qty',
      sourceValues: { value, valueType: 'number', isFormula: false, formula: null },
      sourceProvenance: provenance(extractedAt),
    }],
  });

  it('accepts the two documented exemptions and nothing else', () => {
    const browser = fileResult('browser_worker', '2026-01-01T00:00:00.000Z');
    const node = fileResult('node', '2026-09-10T12:00:00.000Z');
    expect(compareParsedResults(browser, node, 'file').equal).toBe(true);
  });

  it('rejects a numeric-zero versus blank disagreement', () => {
    const browser = fileResult('browser_worker', 'x', 0);
    const node = fileResult('node', 'y', null);
    const r = compareParsedResults(browser, node, 'file');
    expect(r.equal).toBe(false);
    expect(r.difference?.path).toContain('sourceValues.value');
  });

  it('rejects a changed provenance coordinate', () => {
    const browser = fileResult('browser_worker', 'x');
    const node = JSON.parse(JSON.stringify(fileResult('node', 'y')));
    node.sourceRecords[0].sourceProvenance.coordinate.a1 = 'C3';
    expect(compareParsedResults(browser, node, 'file').equal).toBe(false);
  });

  it('rejects a differing diagnostic, formula or family', () => {
    const base = fileResult('browser_worker', 'x');
    const withDiag = JSON.parse(JSON.stringify(fileResult('node', 'y')));
    withDiag.diagnostics.push({ code: 'STALE_USED_RANGE', severity: 'warning', message: 'm' });
    expect(compareParsedResults(base, withDiag, 'file').equal).toBe(false);

    const withFormula = JSON.parse(JSON.stringify(fileResult('node', 'y')));
    withFormula.sourceRecords[0].sourceValues.formula = '=SUM(A1:A2)';
    expect(compareParsedResults(base, withFormula, 'file').equal).toBe(false);

    const withFamily = JSON.parse(JSON.stringify(fileResult('node', 'y')));
    withFamily.family.confidence = 0.75;
    expect(compareParsedResults(base, withFamily, 'file').equal).toBe(false);
  });

  it('distinguishes -0 from 0 and an absent key from an undefined one', () => {
    const a = fileResult('browser_worker', 'x', 0);
    const b = fileResult('node', 'y', -0);
    expect(compareParsedResults(a, b, 'file').equal).toBe(false);

    const c = JSON.parse(JSON.stringify(fileResult('node', 'y', 0)));
    delete c.sourceRecords[0].sourceValues.formula;
    expect(compareParsedResults(a, c, 'file').equal).toBe(false);
  });

  it('compares the WHOLE archive result, not only its source records', () => {
    const archive = (runtime: string, filesExcluded: number) => ({
      identity: { contractVersion: '1.0.0', sheetjsVersion: '0.20.3', sheetjsTarballSha256: SHA, runtime },
      archive: { originalFilename: 'a.zip', sha256: SHA, byteSize: 100 },
      entries: [fileResult(runtime, runtime === 'node' ? 'n' : 'b')],
      excludedEntries: [],
      diagnostics: [],
      reconciliation: { filesTotal: 1, filesAccepted: 1, filesRejected: 0, filesExcluded, aggregateTotals: {} },
    });
    expect(compareParsedResults(archive('browser_worker', 0), archive('node', 0), 'archive').equal).toBe(true);
    const drift = compareParsedResults(archive('browser_worker', 0), archive('node', 1), 'archive');
    expect(drift.equal).toBe(false);
    expect(drift.difference?.path).toBe('reconciliation.filesExcluded');
  });

  it('masks the nested per-entry runtime as well as the archive-level one', () => {
    const masked = maskArchiveResult({
      identity: { runtime: 'node' },
      entries: [{ identity: { runtime: 'node' }, sourceRecords: [] }],
    }) as MaskedArchive;
    expect(masked.identity.runtime).toBe('<runtime>');
    expect(masked.entries[0].identity.runtime).toBe('<runtime>');
  });

  it('masking never mutates the input that will be persisted', () => {
    const original = { identity: { runtime: 'node' }, entries: [{ identity: { runtime: 'node' }, sourceRecords: [] }] };
    maskArchiveResult(original);
    expect(original.identity.runtime).toBe('node');
    expect(original.entries[0].identity.runtime).toBe('node');
  });

  it('the finalize endpoint aborts the whole import on any parity difference', () => {
    const body = read(CN2B_CORE.finalizeImport);
    const parityAt = body.indexOf('compareParsedResults');
    const persistAt = body.indexOf('phoenix_central_needs_apply_authoritative_replay');
    const batchAt = body.indexOf('phoenix_central_needs_register_import_batch');
    expect(parityAt).toBeGreaterThan(0);
    expect(persistAt).toBeGreaterThan(parityAt);
    expect(batchAt).toBeGreaterThan(persistAt);
    expect(body).toContain('browser_node_parity_mismatch');
    expect(body).toContain('archive_contains_rejected_entry');
  });

  it('the preview digest is computed by PostgreSQL, never in TypeScript', () => {
    const body = read(CN2B_CORE.finalizeImport);
    expect(body).toContain('_phoenix_central_needs_payload_digest_v1');
    // No hand-rolled canonicalizer anywhere in the API tree.
    for (const f of ['api/_lib/parity.ts', 'api/_lib/storage-paths.ts', CN2B_CORE.finalizeImport]) {
      // No STANDALONE unit/record separator literal — the canonical form joins
      // with U+001F and U+001E, so a lone one of those would be the signature
      // of a hand-rolled digest. (A separator appearing INSIDE a character
      // range, as in the filename control-character filter, is not that.)
      expect(code(f), f).not.toMatch(/\\[ux]0*1[EF]['"`]/i);
      expect(code(f), f).not.toMatch(/string_agg|jsonb::text/i);
    }
    // sha256Hex IS used here — but only to fingerprint the raw container bytes,
    // which is a different thing from the semantic digest and is never applied
    // to records. The digest itself only ever arrives from the RPC.
    expect(body).toContain('const containerSha256 = await sha256Hex(sourceBytes)');
    expect(body).not.toMatch(/sha256Hex\([^)]*[Rr]ecords/);
    expect(body).toContain('const previewDigest = digestCall.data');
  });
});

describe('CN-2B — corrective-pass invariants in the trusted finalizer', () => {
  const finalize = read(CN2B_CORE.finalizeImport);
  const finalizeCode = code(CN2B_CORE.finalizeImport);

  it('A · the authoritative replay is called for EVERY session, completed included', () => {
    // The old shape skipped the RPC when the session came back 'completed',
    // which bypassed M210's completed-session exact-evidence comparison.
    expect(finalizeCode).not.toMatch(/if\s*\(\s*session\.status\s*!==\s*'completed'\s*\)/);
    // Exactly one call site, unconditional within the per-entry loop.
    expect(finalize.split('phoenix_central_needs_apply_authoritative_replay').length - 1).toBe(1);
    const replayAt = finalizeCode.indexOf('phoenix_central_needs_apply_authoritative_replay');
    const manifestAt = finalizeCode.indexOf('manifest.push');
    expect(replayAt).toBeGreaterThan(0);
    expect(manifestAt).toBeGreaterThan(replayAt);
  });

  it('B · each entry starts its own entry-aware session', () => {
    expect(finalize).toContain('phoenix_central_needs_start_import_entry_session');
    expect(finalize).toContain('p_entry_path: archiveEntryPath');
    expect(finalizeCode).not.toMatch(/rpc\('phoenix_central_needs_start_import_session'/);
  });

  it('D · permanent evidence is create-only and a collision is re-hashed', () => {
    expect(finalize).toContain('upsert: false');
    expect(finalizeCode).not.toContain('upsert: true');
    // A collision is resolved by INDEPENDENTLY hashing what is already stored.
    expect(finalize).toContain('permanent_evidence_conflict');
    expect(finalize).toMatch(/existingSha\s*!==\s*containerSha256/);
    // Nothing ever removes or replaces a permanent object.
    const removals = finalizeCode.match(/\.remove\(/g) ?? [];
    expect(removals.length).toBe(1);
    expect(finalize).toContain('.remove([sourceKey, previewKey])');
    expect(finalizeCode).not.toMatch(/remove\(\[[^\]]*permanentKey/);
  });

  it('J · the source file records the entry BASENAME, never its archive path', () => {
    expect(finalize).toContain('p_original_filename: nodeEntry.input.originalFilename');
    expect(finalizeCode).not.toContain('p_original_filename: archiveEntryPath');
    // The path is preserved where it belongs: as provenance, not as a filename.
    expect(finalize).toContain('archiveEntryPath,');
  });

  it('K · size is proven BEFORE the object is downloaded', () => {
    const sizeAt = finalizeCode.indexOf('const sourceSize = await objectSize');
    const downloadAt = finalizeCode.indexOf('.download(sourceKey)');
    expect(sizeAt).toBeGreaterThan(0);
    expect(downloadAt).toBeGreaterThan(sizeAt);
    expect(finalize).toContain('const previewSize = await objectSize');
  });
});

describe('CN-2B — navigation authorization', () => {
  const perms = (...keys: string[]) => new Set(keys);

  it('platform admin needs no grant; central warehouse manager needs central_needs.view', () => {
    expect(CENTRAL_NEEDS_SCREEN).toBe(23);
    expect(CENTRAL_NEEDS_VIEW_PERMISSION).toBe('central_needs.view');
    expect(isScreenAuthorized(23, 'central_warehouse_manager', perms('central_needs.view'))).toBe(true);
    expect(isScreenAuthorized(23, 'central_warehouse_manager', perms())).toBe(false);
    expect(isScreenAuthorized(23, 'super_admin', perms())).toBe(true);
    expect(isScreenAuthorized(23, 'super_admin', perms('central_needs.view'))).toBe(true);
  });

  it('the one facility-scoped role is refused even holding the key', () => {
    // health_center_manager is the ONLY role in FACILITY_SCOPED_ROLES, so it is
    // refused by the allow-list before the capability is ever consulted.
    expect(isScreenAuthorized(23, 'health_center_manager', perms('central_needs.view'))).toBe(false);
    expect(isScreenAuthorized(23, 'health_center_manager', perms())).toBe(false);
  });

  it.each([
    'institution_admin', 'warehouse_officer', 'outlet_officer',
    'health_center_manager', 'hospital_admin', 'viewer', 'unknown', '', null, undefined,
  ])('refuses non-central role %s even with an explicit grant', (role) => {
    expect(isScreenAuthorized(23, role, perms())).toBe(false);
    expect(isScreenAuthorized(23, role, perms('central_needs.view'))).toBe(false);
    expect(isScreenAuthorized(23, role, perms('central_needs.view', 'dashboard.view', 'users.view'))).toBe(false);
  });

  it('the screen is not added to the facility-safe allow-list', () => {
    const src = read('src/shared/authz/screen-access.ts');
    expect(src).toMatch(/FACILITY_SAFE_SCREENS: readonly number\[\] = \[3, 6, 15, 18\]/);
  });

  it('the route and the nav entry both name the constant screen id', () => {
    expect(read('src/app/AuthenticatedApp.tsx')).toContain('case 23: return <CentralNeedsScreen />');
    expect(read('src/shared/ui/PhoenixSidebar.tsx')).toContain("{ screen: 23, icon: 'reports', labelKey: 'cn2b_nav' }");
  });
});

describe('CN-2B — routing and CSP', () => {
  const vercel = JSON.parse(read('vercel.json'));

  it('the SPA catch-all no longer swallows /api', () => {
    const rewrite = vercel.rewrites.find((r: VercelRewrite) => r.destination === '/index.html');
    expect(rewrite.source).toBe('/((?!api/).*)');
    // The pattern still matches every non-API path.
    const re = new RegExp(`^${rewrite.source}$`);
    for (const p of ['/', '/login', '/qr/abc', '/deep/nested/route']) expect(re.test(p), p).toBe(true);
    for (const p of ['/api/central-needs/upload-ticket', '/api/anything']) expect(re.test(p), p).toBe(false);
  });

  it('the existing security headers are untouched', () => {
    const headers = vercel.headers[0].headers.map((h: VercelHeader) => h.key);
    for (const k of [
      'Content-Security-Policy', 'X-Frame-Options', 'X-Content-Type-Options',
      'Referrer-Policy', 'Permissions-Policy', 'Strict-Transport-Security',
    ]) expect(headers, k).toContain(k);
  });

  it('the CSP already permits the same-origin API and the worker', () => {
    const csp = vercel.headers[0].headers
      .find((h: VercelHeader) => h.key === 'Content-Security-Policy')!.value;
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain('https://eyrzxgfkvqybjdgyphap.supabase.co');
  });

  it('Node 22 is pinned for the serverless runtime', () => {
    expect(JSON.parse(read('package.json')).engines.node).toBe('22.x');
  });
});

describe('CN-2B — UI invariants', () => {
  const service = read('src/features/central-needs/central-needs.service.ts');
  const screen = read('src/features/central-needs/CentralNeedsScreen.tsx');
  const table = read('src/features/central-needs/CentralNeedsDispositionTable.tsx');

  it('every workflow mutation goes through a canonical RPC', () => {
    for (const rpc of [
      'phoenix_central_needs_set_record_disposition',
      'phoenix_central_needs_record_field_override',
      'phoenix_central_needs_abandon_import_session',
      'phoenix_central_needs_submit_revision',
      'phoenix_central_needs_approve_revision',
      'phoenix_central_needs_reject_revision',
    ]) expect(service, rpc).toContain(rpc);
  });

  it('the UI never writes to a Central Needs table directly', () => {
    // Matched against a PostgREST builder chain specifically: `Set.delete()` and
    // `Map.delete()` are ordinary JavaScript and must not be mistaken for a
    // database write.
    const writeChain = /\.from\(\s*['"][^'"]+['"]\s*\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/;
    for (const [name, body] of [['service', service], ['screen', screen], ['table', table]] as const) {
      expect(writeChain.test(body), `${name} performs a direct table write`).toBe(false);
    }
    // Reads are the only thing the builder is used for.
    expect(service).toContain(".select('");
  });

  it('completeness is read from the server, never computed in the client', () => {
    expect(service).toContain('phoenix_central_needs_review_readiness');
    // The submit button is disabled by the server's own answer.
    expect(screen).toContain('disabled={busy !== null || !readiness?.ready}');
  });

  it('a bulk action always previews its count before mutating', () => {
    const previewAt = table.indexOf('setBulkPreview(selected.size)');
    const confirmAt = table.indexOf('confirmBulkNotApplicable');
    expect(previewAt).toBeGreaterThan(0);
    expect(confirmAt).toBeGreaterThan(0);
    expect(table).toContain('if (bulkPreview === null || bulkReason.trim() === \'\') return;');
    expect(table).toContain('cn2b_bulk_will_change');
  });

  it('source and effective values are separate columns; source is never replaced', () => {
    expect(table).toContain('cn2b_col_source_value');
    expect(table).toContain('cn2b_col_effective_value');
    expect(table).toContain('cn2b_col_provenance');
    // The override is rendered in its own cell, beside the source cell.
    expect(table).toMatch(/<td><SourceValue values=\{field\.sourceValues\}[\s\S]{0,40}<\/td>/);
  });

  it('never renders cell HTML, never evaluates a formula, never trusts formattedText', () => {
    for (const f of [
      'src/features/central-needs/CentralNeedsScreen.tsx',
      'src/features/central-needs/CentralNeedsDispositionTable.tsx',
    ]) {
      const body = code(f);
      expect(body, f).not.toContain('dangerouslySetInnerHTML');
      expect(body, f).not.toContain('formattedText');
      expect(body, f).not.toMatch(/\beval\(/);
      expect(body, f).not.toContain('innerHTML');
    }
    // The formula is shown as verbatim text and labelled as never evaluated.
    expect(table).toContain('cn2b_formula_not_evaluated');
  });

  it('family detection is advisory and gates nothing', () => {
    expect(screen).toContain('cn2b_family_advisory');
    expect(screen).not.toMatch(/family[\s\S]{0,80}(disabled|canEdit|authoriz|permission)/i);
  });

  it('uses the four exact trust words and no improvised state', () => {
    for (const key of [
      'cn2b_state_provisional', 'cn2b_state_verified', 'cn2b_state_incomplete', 'cn2b_state_ready',
    ]) expect(screen, key).toContain(key);
  });

  it('carries no central_needs.send and no stock/movement/transfer surface', () => {
    for (const body of [service, screen, table]) {
      for (const forbidden of [
        'central_needs.send', 'stock_movements', 'warehouse_transfer',
        'inventory_transfer_suggestions', 'movement_lines',
      ]) expect(body, forbidden).not.toContain(forbidden);
    }
  });
});

describe('CN-2B — bilingual, RTL and responsive', () => {
  const strings = read('src/shared/i18n/strings.ts');
  const css = read('src/shared/lib/central-needs.css');

  it('every cn2b key carries both Arabic and English', () => {
    const keys = strings.match(/^\s{2}(cn2b_[a-z0-9_]+):\s*\{[^}]*\}/gm) ?? [];
    expect(keys.length).toBeGreaterThan(100);
    for (const line of keys) {
      expect(line, line.slice(0, 40)).toMatch(/ar:\s*'[^']+'/);
      expect(line, line.slice(0, 40)).toMatch(/en:\s*'[^']+'/);
    }
  });

  it('every key the components reference exists in the dictionary', () => {
    const used = new Set<string>();
    for (const f of [
      'src/features/central-needs/CentralNeedsScreen.tsx',
      'src/features/central-needs/CentralNeedsDispositionTable.tsx',
      'src/shared/ui/PhoenixSidebar.tsx',
    ]) {
      for (const m of read(f).matchAll(/'(cn2b_[a-z0-9_]+)'/g)) used.add(m[1]);
    }
    const missing = [...used].filter((k) => !new RegExp(`^\\s{2}${k}:`, 'm').test(strings));
    expect(missing).toEqual([]);
  });

  it('the screen honours the app direction rather than hard-coding one', () => {
    const screen = read('src/features/central-needs/CentralNeedsScreen.tsx');
    expect(screen).toContain('dir={dir}');
    expect(screen).not.toMatch(/dir=["']rtl["']|dir=["']ltr["']/);
  });

  it('the stylesheet uses logical properties, not physical left/right', () => {
    expect(css).not.toMatch(/(^|[\s;{])(margin-left|margin-right|padding-left|padding-right|left|right)\s*:/m);
    expect(css).toContain('inline-size');
    expect(css).toContain('padding-inline');
    expect(css).toContain('text-align: start');
  });

  it('wide content scrolls inside its own container, never the document', () => {
    expect(css).toContain('.cn2b-scroll');
    expect(css).toMatch(/\.cn2b-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.cn2b\s*\{[^}]*min-inline-size:\s*0/);
    const screen = read('src/features/central-needs/CentralNeedsScreen.tsx');
    const table = read('src/features/central-needs/CentralNeedsDispositionTable.tsx');
    // Every table is wrapped.
    const tables = (screen + table).match(/<table/g) ?? [];
    const wraps = (screen + table).match(/className="cn2b-scroll"/g) ?? [];
    expect(wraps.length).toBe(tables.length);
  });

  it('has a mobile breakpoint and touch-sized controls', () => {
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toMatch(/min-block-size:\s*3[08]px/);
  });

  it('keyboard focus is always visible and every control is labelled', () => {
    expect(css).toContain(':focus-visible');
    expect(css).toContain('outline: 2px solid var(--cyan)');
    const table = read('src/features/central-needs/CentralNeedsDispositionTable.tsx');
    expect(table).toContain('htmlFor=');
    expect(table).toContain('cn2b-visually-hidden');
    // Buttons are real buttons with an explicit type.
    expect(table).not.toMatch(/<div[^>]*onClick=/);
    expect(read('src/features/central-needs/CentralNeedsScreen.tsx')).not.toMatch(/<div[^>]*onClick=/);
  });

  it('trust state never depends on colour alone', () => {
    // Each badge state carries a border treatment as well as a hue.
    for (const state of ['provisional', 'verified', 'incomplete', 'ready']) {
      const block = css.slice(css.indexOf(`[data-state='${state}']`));
      expect(block.slice(0, 220), state).toMatch(/border-(style|width)/);
    }
  });
});
