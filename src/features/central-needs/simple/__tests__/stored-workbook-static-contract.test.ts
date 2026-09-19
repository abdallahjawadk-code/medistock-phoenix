import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const PANEL = 'src/features/central-needs/simple/StoredWorkbookPanel.tsx';
const WORKSPACE = 'src/features/central-needs/simple/CentralNeedsSimpleWorkspace.tsx';

describe('E1.1 persistent stored workbook contract', () => {
  it('reopens through the existing authorized read endpoint and verifies bytes before parsing', () => {
    const src = code(PANEL);
    expect(src).toMatch(/requestSourceDownload\(selectedBatch\.id\)/);
    expect(src).toMatch(/crypto\.subtle\.digest\('SHA-256', bytes\)/);
    expect(src).toMatch(/actualSha[\s\S]*selectedBatch\.containerSha256/);
    expect(src).toMatch(/await preview\.parse\(file\)/);
    expect(src.indexOf('actualSha')).toBeLessThan(src.indexOf('await preview.parse(file)'));
    // A mismatch returns before any File is built for the parser.
    const mismatch = src.indexOf("setError('integrity_mismatch')");
    expect(mismatch).toBeGreaterThan(0);
    expect(mismatch).toBeLessThan(src.indexOf('new File([bytes]'));
  });

  it('never persists the signed URL, source bytes or parsed workbook in browser storage', () => {
    const src = code(PANEL);
    expect(src).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
    expect(src).not.toMatch(/\bdocument\.cookie\b|\bcaches\s*\.|\bserviceWorker\b|\bcreateObjectURL\b/);
  });

  /*
   * F-3: the guard targets the real DB / Storage / network write surfaces, not
   * arbitrary JavaScript method names — `Array.from(...)` (the hex encoding of
   * the digest) is not a database read or write and must not trip it.
   */
  it('has no DB, RPC, Storage or network write surface — and only the existing read endpoint client', () => {
    const src = code(PANEL);

    // No Supabase client at all, so no table, RPC or Storage bucket is reachable from here.
    expect(src).not.toMatch(/@\/shared\/supabase/);
    expect(src).not.toMatch(/\bsupabase\b/);
    expect(src).not.toMatch(/\.from\s*\(\s*['"`]/);
    expect(src).not.toMatch(/\.storage\b/);
    expect(src).not.toMatch(/\.rpc\s*\(/);

    // No mutation verb — table writes or Storage object mutation.
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
    expect(src).not.toMatch(/\.(upload|uploadToSignedUrl|createSignedUploadUrl|remove|move|copy|updateBucket|emptyBucket|deleteBucket)\s*\(/);

    // From the service layer it imports exactly the source-download read, the ImportBatch type —
    // and, since E2-A, the batch-entry READ that proves which entry a displayed workbook is.
    const serviceImport = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/central-needs\.service'/);
    expect(serviceImport).not.toBeNull();
    const imported = (serviceImport as RegExpMatchArray)[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
    expect(imported).toEqual(['listBatchEntries', 'requestSourceDownload', 'type ImportBatch']);
    expect(src).not.toMatch(/\bauthorizedFetch\b/);
    // E2-A: that added dependency is a pure SELECT of this batch's own entries — no write path.
    const service = code('src/features/central-needs/central-needs.service.ts');
    const listEntries = service.match(/export async function listBatchEntries\([\s\S]*?\n\}/);
    expect(listEntries).not.toBeNull();
    const body = (listEntries as RegExpMatchArray)[0];
    expect(body).toMatch(/\.from\('central_needs_import_batch_entries'\)\s*\.select\(/);
    expect(body).toMatch(/\.eq\('batch_id', batchId\)/);
    expect(body).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(|\.storage\b/);

    // The only other network call is ONE GET of the signed URL the endpoint returned.
    const fetches = [...src.matchAll(/\bfetch\s*\(/g)];
    expect(fetches).toHaveLength(1);
    expect(src).toMatch(/fetch\(descriptor\.url,\s*\{\s*method:\s*'GET'/);
    expect(src).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
    expect(src).not.toMatch(/\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|\bEventSource\b/);
  });

  it('the write guard is precise: Array.from is present and allowed, a real write would be caught', () => {
    const src = code(PANEL);
    expect(src).toMatch(/Array\.from\(new Uint8Array\(digest\)/);
    const tableWrite = /\.(insert|update|upsert|delete)\s*\(/;
    const tableAccess = /\.from\s*\(\s*['"`]/;
    expect("supabase.from('central_needs_import_batches').update({ x: 1 })").toMatch(tableWrite);
    expect("supabase.from('central_needs_import_batches')").toMatch(tableAccess);
    expect('Array.from(new Uint8Array(digest), (b) => b)').not.toMatch(tableAccess);
    expect('Array.from(new Uint8Array(digest), (b) => b)').not.toMatch(tableWrite);
  });

  it('is mounted outside the Simple step branches so upload -> summary/review does not remove it', () => {
    const workspace = code(WORKSPACE);
    const mount = workspace.indexOf('<StoredWorkbookPanel');
    const firstStep = workspace.indexOf("step === 'upload'");
    expect(mount).toBeGreaterThan(0);
    expect(firstStep).toBeGreaterThan(mount);
    expect(workspace).toMatch(/revisionDataReady && revision && batches\.length > 0/);
    expect(workspace).toMatch(/<StoredWorkbookPanel key=\{revision\.id\}/);
  });

  it('F-2: is an auxiliary surface with its own block — never a second Simple task card', () => {
    const panel = code(PANEL);
    expect(panel).toMatch(/<section className="cn2b-stored-workbook"/);
    expect(panel).not.toMatch(/cn2b-simple-card/);
    const css = read('src/shared/lib/central-needs.css');
    expect(css).toMatch(/^\.cn2b-stored-workbook \{/m);
  });

  it('the parent passes the revision-scoped trusted batches and the download descriptor exposes authoritative metadata', () => {
    const screen = code('src/features/central-needs/CentralNeedsScreen.tsx');
    const service = code('src/features/central-needs/central-needs.service.ts');
    expect(screen).toMatch(/<CentralNeedsSimpleWorkspace[\s\S]*batches=\{batches\}/);
    expect(service).toMatch(/requestSourceDownload[\s\S]*authorizedFetch\('\/api\/central-needs\/source-download'/);
    expect(service).toMatch(/requestSourceDownload[\s\S]*containerKind[\s\S]*containerSha256/);
  });

  it('adds bilingual operator-facing copy for the persistent viewer', () => {
    const strings = read('src/shared/i18n/strings.ts');
    for (const key of [
      'cn2b_stored_workbook_persisted', 'cn2b_stored_workbook_title', 'cn2b_stored_workbook_hint',
      'cn2b_stored_workbook_choose', 'cn2b_stored_workbook_open', 'cn2b_stored_workbook_loading',
      'cn2b_stored_workbook_integrity_ok', 'cn2b_stored_workbook_integrity_error',
      'cn2b_stored_workbook_integrity_unavailable', 'cn2b_stored_workbook_metadata_error',
      'cn2b_stored_workbook_load_error',
    ]) {
      const line = strings.match(new RegExp(`^\\s{2}${key}:\\s*\\{[^}]*\\}`, 'm'));
      expect(line, key).not.toBeNull();
      expect((line as RegExpMatchArray)[0]).toMatch(/ar:\s*'[^']+'/);
      expect((line as RegExpMatchArray)[0]).toMatch(/en:\s*'[^']+'/);
    }
  });
});
