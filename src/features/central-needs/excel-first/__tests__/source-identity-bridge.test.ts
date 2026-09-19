/**
 * E2-A.2 — the Source Identity Bridge, against REAL parser output.
 *
 * Every parse result here comes from the production CN-2A cores (the same
 * `parseWorkbookBytes` / `parseArchiveBytes` finalize-import replays), and the
 * trusted rows are built exactly as finalize-import registers them:
 * ordinal = i + 1, sha = input.sha256, path = input.archiveEntryPath ?? null.
 * The bridge must prove the mapping from ordinal + SHA-256 + archive path, and
 * refuse — never guess — on any disagreement.
 */
import { crc32 } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { ArchiveParseResult, FileParseResult } from '../../import/contract';
import { parseArchiveBytes } from '../../import/archive-core';
import { nodeInflate } from '../../import/node-inflate';
import { parseWorkbookBytes } from '../../import/parser-core';
import { bridgeSourceIdentity, type TrustedBatch, type TrustedBatchEntry } from '../sourceIdentityBridge';

function workbookBytes(label: string): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['الرمز', 'القيمة'], [label, 1]]), 'Sheet1');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

/** A deterministic ZIP with STORED entries (method 0), built from first principles. */
function storedZip(files: Array<{ path: string; bytes: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.path);
    const crc = crc32(file.bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, 0x5021, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, file.bytes.length, true);
    local.setUint32(22, file.bytes.length, true);
    local.setUint16(26, name.length, true);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 20, true);
    head.setUint16(14, 0x5021, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, file.bytes.length, true);
    head.setUint32(24, file.bytes.length, true);
    head.setUint16(28, name.length, true);
    head.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, file.bytes);
    central.push(new Uint8Array(head.buffer), name);
    offset += 30 + name.length + file.bytes.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

/** Exactly what finalize-import registers for a batch (ordinal = i + 1). */
function registeredEntries(batchId: string, files: FileParseResult[]): TrustedBatchEntry[] {
  return files.map((f, i) => ({
    id: `entry-${i + 1}`,
    batchId,
    entryOrdinal: i + 1,
    archiveEntryPath: f.input.archiveEntryPath ?? null,
    entrySha256: f.input.sha256,
    importSessionId: `session-${i + 1}`,
  }));
}

let single: FileParseResult;
let archive: ArchiveParseResult;
let twins: ArchiveParseResult;
let FILE_BATCH: TrustedBatch;
let ZIP_BATCH: TrustedBatch;
let TWIN_BATCH: TrustedBatch;

beforeAll(async () => {
  single = await parseWorkbookBytes(workbookBytes('X-001'), 'احتياج 2027.xlsx', { runtime: 'node' });
  FILE_BATCH = { id: 'batch-file', containerKind: 'file', containerSha256: single.input.sha256 };

  const zip = storedZip([
    { path: 'needs/workbook-1.xlsx', bytes: workbookBytes('A') },
    { path: 'needs/workbook-2.xlsx', bytes: workbookBytes('B') },
    { path: 'needs/sub/workbook-3.xlsx', bytes: workbookBytes('C') },
  ]);
  archive = await parseArchiveBytes(zip, 'احتياج 2027.zip', { runtime: 'node', inflate: nodeInflate });
  ZIP_BATCH = { id: 'batch-zip', containerKind: 'zip', containerSha256: archive.archive.sha256 };

  // The same bytes at two paths — legitimate, and exactly why SHA alone can never be the key.
  const same = workbookBytes('same');
  twins = await parseArchiveBytes(storedZip([
    { path: 'a/twin.xlsx', bytes: same },
    { path: 'b/twin.xlsx', bytes: same },
  ]), 'twins.zip', { runtime: 'node', inflate: nodeInflate });
  TWIN_BATCH = { id: 'batch-twins', containerKind: 'zip', containerSha256: twins.archive.sha256 };
});

describe('E2-A.2 — the fixtures are real parser output', () => {
  it('the ZIP parses into three accepted workbooks with their archive paths, in archive order', () => {
    expect(archive.entries.map((e) => [e.outcome, e.input.archiveEntryPath])).toEqual([
      ['accepted', 'needs/workbook-1.xlsx'],
      ['accepted', 'needs/workbook-2.xlsx'],
      ['accepted', 'needs/sub/workbook-3.xlsx'],
    ]);
    expect(twins.entries[0].input.sha256).toBe(twins.entries[1].input.sha256);
  });
});

describe('E2-A.2 — SOURCE IDENTITY: standalone file', () => {
  it('exactly one entry, matching SHA, null archive path, ordinal 1 → one identity', () => {
    const entries = registeredEntries(FILE_BATCH.id, [single]);
    const result = bridgeSourceIdentity({ batch: FILE_BATCH, kind: 'file', result: single, entries });
    expect(result).toEqual({
      ok: true,
      identities: [{
        batchId: 'batch-file', entryId: 'entry-1', entryOrdinal: 1, entrySha256: single.input.sha256,
        importSessionId: 'session-1', workbookIndex: 0,
      }],
    });
  });

  it.each([
    ['no entry at all', 'entry_count_mismatch', () => []],
    ['two entries', 'entry_count_mismatch', (e: TrustedBatchEntry[]) => [...e, { ...e[0], id: 'entry-x', entryOrdinal: 2, importSessionId: 'session-x' }]],
    ['a non-null archive path', 'path_mismatch', (e: TrustedBatchEntry[]) => [{ ...e[0], archiveEntryPath: 'needs/x.xlsx' }]],
    ['ordinal 2 instead of 1', 'ordinal_mismatch', (e: TrustedBatchEntry[]) => [{ ...e[0], entryOrdinal: 2 }]],
    ['a different SHA-256', 'sha_mismatch', (e: TrustedBatchEntry[]) => [{ ...e[0], entrySha256: 'f'.repeat(64) }]],
    ['another batch\'s entry', 'entry_batch_mismatch', (e: TrustedBatchEntry[]) => [{ ...e[0], batchId: 'batch-other' }]],
    ['a malformed SHA-256', 'invalid_entry', (e: TrustedBatchEntry[]) => [{ ...e[0], entrySha256: 'not-a-digest' }]],
    ['an empty import session', 'invalid_entry', (e: TrustedBatchEntry[]) => [{ ...e[0], importSessionId: '' }]],
  ] as const)('%s → FAIL CLOSED (%s)', (_label, reason, mutate) => {
    const entries = mutate(registeredEntries(FILE_BATCH.id, [single]));
    expect(bridgeSourceIdentity({ batch: FILE_BATCH, kind: 'file', result: single, entries })).toEqual({ ok: false, reason, ...(reason === 'path_mismatch' || reason === 'ordinal_mismatch' || reason === 'sha_mismatch' ? { workbookIndex: 0 } : {}) });
  });

  it('the container must be the verified batch: kind and container SHA-256', () => {
    const entries = registeredEntries(FILE_BATCH.id, [single]);
    expect(bridgeSourceIdentity({ batch: { ...FILE_BATCH, containerKind: 'zip' }, kind: 'file', result: single, entries }))
      .toEqual({ ok: false, reason: 'kind_mismatch' });
    expect(bridgeSourceIdentity({ batch: { ...FILE_BATCH, containerSha256: 'e'.repeat(64) }, kind: 'file', result: single, entries }))
      .toEqual({ ok: false, reason: 'container_sha_mismatch' });
  });
});

describe('E2-A.2 — SOURCE IDENTITY: ZIP', () => {
  it('N parsed workbooks map to exactly N entries, by ordinal, SHA-256 and path', () => {
    const entries = registeredEntries(ZIP_BATCH.id, archive.entries);
    const result = bridgeSourceIdentity({ batch: ZIP_BATCH, kind: 'archive', result: archive, entries });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identities).toHaveLength(3);
    result.identities.forEach((identity, i) => {
      expect(identity).toEqual({
        batchId: 'batch-zip', entryId: `entry-${i + 1}`, entryOrdinal: i + 1,
        entrySha256: archive.entries[i].input.sha256, importSessionId: `session-${i + 1}`, workbookIndex: i,
      });
    });
  });

  it('the order the rows arrive in does not matter — the ordinal does', () => {
    const entries = registeredEntries(ZIP_BATCH.id, archive.entries).reverse();
    const result = bridgeSourceIdentity({ batch: ZIP_BATCH, kind: 'archive', result: archive, entries });
    expect(result.ok && result.identities.map((i) => i.importSessionId)).toEqual(['session-1', 'session-2', 'session-3']);
  });

  it('identical bytes at two paths are still told apart — by ordinal and path, never by SHA alone', () => {
    const entries = registeredEntries(TWIN_BATCH.id, twins.entries);
    const result = bridgeSourceIdentity({ batch: TWIN_BATCH, kind: 'archive', result: twins, entries });
    expect(result.ok && result.identities.map((i) => [i.workbookIndex, i.importSessionId])).toEqual([[0, 'session-1'], [1, 'session-2']]);
    // Swap the two rows' paths: SHA still matches both, so only the path check can catch it.
    const swapped = entries.map((e, i) => ({ ...e, archiveEntryPath: entries[1 - i].archiveEntryPath }));
    expect(bridgeSourceIdentity({ batch: TWIN_BATCH, kind: 'archive', result: twins, entries: swapped }))
      .toEqual({ ok: false, reason: 'path_mismatch', workbookIndex: 0 });
  });

  it.each([
    ['SHA mismatch (rows 1 and 2 swap digests)', 'sha_mismatch', (e: TrustedBatchEntry[]) => e.map((x, i) => (i < 2 ? { ...x, entrySha256: e[1 - i].entrySha256 } : x))],
    ['PATH mismatch (same file name, other folder)', 'path_mismatch', (e: TrustedBatchEntry[]) => e.map((x, i) => (i === 2 ? { ...x, archiveEntryPath: 'needs/workbook-3.xlsx' } : x))],
    ['PATH missing for an archive entry', 'path_mismatch', (e: TrustedBatchEntry[]) => e.map((x, i) => (i === 1 ? { ...x, archiveEntryPath: null } : x))],
    ['ORDINAL mismatch (gap: 1, 2, 4)', 'ordinal_mismatch', (e: TrustedBatchEntry[]) => e.map((x, i) => (i === 2 ? { ...x, entryOrdinal: 4 } : x))],
    ['ORDINAL mismatch (0-based ordinals)', 'invalid_entry', (e: TrustedBatchEntry[]) => e.map((x) => ({ ...x, entryOrdinal: x.entryOrdinal - 1 }))],
    ['DUPLICATE ordinal', 'duplicate_entry', (e: TrustedBatchEntry[]) => e.map((x, i) => (i === 2 ? { ...x, entryOrdinal: 2 } : x))],
    ['DUPLICATE import session', 'duplicate_entry', (e: TrustedBatchEntry[]) => e.map((x, i) => (i === 2 ? { ...x, importSessionId: 'session-1' } : x))],
    ['DUPLICATE entry id', 'duplicate_entry', (e: TrustedBatchEntry[]) => e.map((x, i) => (i === 2 ? { ...x, id: 'entry-1' } : x))],
    ['DUPLICATE archive path (ambiguous match)', 'duplicate_entry', (e: TrustedBatchEntry[]) => e.map((x, i) => (i === 2 ? { ...x, archiveEntryPath: e[0].archiveEntryPath } : x))],
    ['entry MISSING (N-1 rows)', 'entry_count_mismatch', (e: TrustedBatchEntry[]) => e.slice(0, 2)],
    ['an EXTRA row (N+1)', 'entry_count_mismatch', (e: TrustedBatchEntry[]) => [...e, { ...e[0], id: 'entry-9', entryOrdinal: 9, importSessionId: 'session-9', archiveEntryPath: 'needs/extra.xlsx' }]],
    ['a row of another batch', 'entry_batch_mismatch', (e: TrustedBatchEntry[]) => e.map((x, i) => (i === 1 ? { ...x, batchId: 'batch-file' } : x))],
  ] as const)('%s → FAIL CLOSED (%s)', (_label, reason, mutate) => {
    const entries = mutate(registeredEntries(ZIP_BATCH.id, archive.entries));
    const result = bridgeSourceIdentity({ batch: ZIP_BATCH, kind: 'archive', result: archive, entries });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason });
    expect('identities' in result).toBe(false);
  });

  it('a parsed workbook the batch could never contain (rejected) refuses the whole mapping', () => {
    const rejected: FileParseResult = { ...archive.entries[1], outcome: 'rejected', workbook: null };
    const result: ArchiveParseResult = { ...archive, entries: [archive.entries[0], rejected, archive.entries[2]] };
    const entries = registeredEntries(ZIP_BATCH.id, archive.entries);
    expect(bridgeSourceIdentity({ batch: ZIP_BATCH, kind: 'archive', result, entries }))
      .toEqual({ ok: false, reason: 'parsed_entry_rejected', workbookIndex: 1 });
  });

  it('a ZIP container read as a single file (or the reverse) is refused', () => {
    const entries = registeredEntries(ZIP_BATCH.id, archive.entries);
    expect(bridgeSourceIdentity({ batch: ZIP_BATCH, kind: 'file', result: archive, entries })).toEqual({ ok: false, reason: 'kind_mismatch' });
    expect(bridgeSourceIdentity({ batch: FILE_BATCH, kind: 'archive', result: single, entries: [] })).toEqual({ ok: false, reason: 'kind_mismatch' });
  });

  it('never mutates its inputs', () => {
    const entries = registeredEntries(ZIP_BATCH.id, archive.entries);
    const before = structuredClone({ archive, entries, ZIP_BATCH });
    bridgeSourceIdentity({ batch: ZIP_BATCH, kind: 'archive', result: archive, entries });
    expect({ archive, entries, ZIP_BATCH }).toEqual(before);
  });
});
