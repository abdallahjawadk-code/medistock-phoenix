import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, sep, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import * as XLSX from 'xlsx';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { runC3IsolatedWorker, type C3WorkerRequest } from '../../_cn2b-core/annual-c3-worker-boundary.ts';
import type { RegisteredAnnualLayout } from '../computation.ts';

const scope = { ownerOrgId: '11111111-1111-4111-8111-111111111111', planningYear: 2026 };
const originalId = '22222222-2222-4222-8222-222222222222';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const registration: RegisteredAnnualLayout = { workbookSheets: [{ index: 0, name: 'Identity' }], template: {
  id: 'synthetic-native', version: 1, reviewReference: 'synthetic-worker-review', parserContractVersion: '1.2.0',
  classificationCells: [], blocks: [{ blockId: 'items', sheetIndex: 0, headerRow: 0, firstRow: 1, lastRow: 9999,
    classification: null, mappingReference: 'synthetic-only', columns: {
      scientificName: { column: 0, expectedHeaderText: 'Name' }, nationalCode: { column: 1, expectedHeaderText: 'Code' },
      unit: { column: 2, expectedHeaderText: 'Unit' },
    } }],
} };
function request(format: 'xlsx' | 'csv' = 'xlsx', extraSheet = false): C3WorkerRequest {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Name', 'Code', 'Unit', 'Quantity'], ...Array.from({ length: 3 }, (_, i) => [`Synthetic ${i}`, `000${i}`, 'Box', 987654]),
  ]), 'Identity');
  if (extraSheet) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Unreviewed']]), 'Extra');
  const bytes = Uint8Array.from(XLSX.write(book, { type: 'buffer', bookType: format }));
  const manifest = format === 'csv' ? { ...registration, workbookSheets: [{ index: 0, name: 'Sheet1' }] } : registration;
  return { source: { scope, bytes, original: { originalId, sha256: sha(bytes), byteSize: bytes.length,
    firstFilename: `synthetic.${format}`, createdBy: scope.ownerOrgId, createdByName: 'Synthetic employee',
    createdByRole: 'central_needs_editor', createdAt: '2026-11-01T00:00:00Z', attestation: 'server_received_original' } },
  template: { manifest, expectedSha256: sha(JSON.stringify(manifest)) }, pageSize: 2, cursor: null };
}

describe('C3 actual compiled Node worker — synthetic sources, no Auth claim', () => {
  let directory: string; let entry: URL;
  const artifacts = resolve('artifacts');
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true }); directory = mkdtempSync(join(artifacts, 'c3-native-'));
    const output = join(directory, 'worker.mjs');
    await build({ entryPoints: [resolve('api/_c3-core/worker-entry.ts')], outfile: output, bundle: true,
      platform: 'node', target: 'node22', format: 'esm', logLevel: 'silent',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    entry = pathToFileURL(output);
  }, 30000);
  afterAll(() => {
    if (directory && resolve(directory).startsWith(artifacts + sep)) rmSync(directory, { recursive: true, force: true });
  });
  it.each(['xlsx', 'csv'] as const)('parses real %s bytes, pages deterministically and excludes quantity cells', async format => {
    const input = request(format);
    const first = await runC3IsolatedWorker(entry, input);
    expect(first.rows).toHaveLength(2); expect(first.totalRows).toBe(3); expect(first.nextCursor).not.toBeNull();
    expect(JSON.stringify(first)).not.toContain('987654');
    expect(await runC3IsolatedWorker(entry, input)).toEqual(first);
    const last = await runC3IsolatedWorker(entry, { ...input, cursor: first.nextCursor });
    expect(last.rows).toHaveLength(1); expect(last.nextCursor).toBeNull();
    expect(new Set([...first.rows, ...last.rows].map(row => JSON.stringify(row))).size).toBe(3);
  });
  it('binds a continuation to owner/year/source/template/parser identity', async () => {
    const input = request(); const first = await runC3IsolatedWorker(entry, input);
    await expect(runC3IsolatedWorker(entry, { ...input, source: { ...input.source,
      scope: { ...scope, planningYear: 2027 } }, cursor: first.nextCursor })).rejects.toThrow(/^annual_c3_worker_/);
  });
  it('holds an added unreviewed sheet without accepting a partial layout', async () => {
    const page = await runC3IsolatedWorker(entry, request('xlsx', true));
    expect(page.rows).toEqual([]); expect(page.preparationStatus).toBe('held'); expect(page.heldReason).toBe('layout_unavailable');
  });
  it('holds corrupt workbook bytes without echoing parser diagnostics', async () => {
    const input = request(); const bytes = new Uint8Array([1, 2, 3]);
    const page = await runC3IsolatedWorker(entry, { ...input, source: { ...input.source, bytes,
      original: { ...input.source.original, byteSize: bytes.length, sha256: sha(bytes) } } });
    expect(page.rows).toEqual([]); expect(page.preparationStatus).toBe('held'); expect(page.heldReason).toBe('parse_rejected');
  });
  it('refuses CSV bytes renamed to XLSX even when their registered headers match', async () => {
    const input = request('csv');
    const page = await runC3IsolatedWorker(entry, { ...input, source: { ...input.source,
      original: { ...input.source.original, firstFilename: 'renamed.xlsx' } } });
    expect(page.rows).toEqual([]); expect(page.heldReason).toBe('parse_rejected');
  });
  it('actually terminates a synchronous busy worker at its deadline', async () => {
    const busy = join(directory, 'busy.mjs'); writeFileSync(busy, 'while (true) {}');
    let exited!: Promise<number>;
    const started = Date.now();
    await expect(runC3IsolatedWorker(pathToFileURL(busy), request(), (url, options) => {
      const worker = new Worker(url, options); exited = new Promise(resolveExit => worker.once('exit', resolveExit)); return worker;
    })).rejects.toThrow('annual_c3_worker_timeout');
    expect(await Promise.race([exited, new Promise(resolveDelay => setTimeout(() => resolveDelay('still-running'), 2000))])).not.toBe('still-running');
    expect(Date.now() - started).toBeLessThan(15000);
  }, 20000);
});
