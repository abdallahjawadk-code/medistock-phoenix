/**
 * F02 (Director review) — static pin of the historical-Excel read/download surfaces the D27 restriction relies on.
 *
 * D27's enforcement (R1-a candidate 05) is row-level security on the Central Needs relations. That only protects a
 * download path that reads the gateway row AS THE CALLER. If a future change read the batch / file rows with the
 * service role (which bypasses RLS), D27 would silently stop protecting the download. This test pins the facts, so
 * such a change fails here and the D27 owner gate (Q-K / Q-ST / Q-W0, `authorize_excel_download_v1`) is revisited.
 * It does NOT enable any behaviour.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CORE = join(__dirname, '..', '..', '_cn2b-core');
const read = (f: string) => readFileSync(join(CORE, f), 'utf8').replace(/\r\n/g, '\n');

describe('D27 historical-source download surface', () => {
  const download = read('source-download.ts');

  it('the batch row is read through the CALLER client (RLS-bound), before any signed URL is minted', () => {
    const batchRead = download.indexOf(".from('central_needs_import_batches')");
    expect(batchRead).toBeGreaterThan(-1);
    const callerRead = download.lastIndexOf('caller.client', batchRead);
    expect(callerRead).toBeGreaterThan(-1);
    expect(batchRead - callerRead).toBeLessThan(40);
    expect(batchRead).toBeLessThan(download.indexOf('createSignedUrl'));
  });

  it('the service-role client is used for Storage only in this file, never to read a Central Needs relation', () => {
    expect(download).not.toMatch(/service\.from\(/);
    expect(download).not.toMatch(/serviceClient\(\)\.from\(/);
  });

  it('every api/_cn2b-core module reads Central Needs rows only through the caller client', () => {
    for (const f of readdirSync(CORE).filter((n) => n.endsWith('.ts'))) {
      const src = read(f);
      expect(src, f).not.toMatch(/service\.from\(\s*['"]central_needs_/);
      expect(src, f).not.toMatch(/serviceClient\(\)\s*\.from\(\s*['"]central_needs_/);
    }
  });

  it('records the open gate: the download authorizes central_needs.view only; no D27 decision function is called yet', () => {
    expect(download).toContain("'central_needs.view'");
    expect(download).not.toMatch(/authorize_excel_download|excel_history_decision|may_read_excel_history/);
  });

  it('the only Storage object a signed URL is minted for is the verified permanent object', () => {
    expect((download.match(/createSignedUrl/g) ?? []).length).toBe(1);
    expect(download.indexOf('verifyPermanentObject')).toBeLessThan(download.indexOf('createSignedUrl'));
  });
});
