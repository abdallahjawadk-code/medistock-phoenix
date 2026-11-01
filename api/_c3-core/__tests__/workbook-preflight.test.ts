import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { preflightC3Workbook, C3_ZIP_LIMITS } from '../workbook-preflight.ts';
import { readZipSafely } from '../../../src/features/central-needs/import/zip-reader.ts';
import { nodeInflate } from '../../../src/features/central-needs/import/node-inflate.ts';

async function container(streamFiles = false) {
  const zip = new JSZip(); zip.file('part.xml', 'safe bounded source');
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', streamFiles });
}
function central(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i <= bytes.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) return i;
  throw new Error('missing test central directory');
}
describe('C3 internal workbook ZIP preflight before unchanged SheetJS', () => {
  it('accepts actual bounded XLSX and descriptor-based ZIP containers', async () => {
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Name'], ['Synthetic']]), 'Identity');
    expect(await preflightC3Workbook(Uint8Array.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })))).toBe(true);
    expect(await preflightC3Workbook(await container(true))).toBe(true);
  });
  it('does not reinterpret non-ZIP workbook bytes or ordinary PK-prefixed CSV text', async () => {
    expect(await preflightC3Workbook(new TextEncoder().encode('PK,Code\nSynthetic,0007'))).toBe(true);
  });
  it.each(['method', 'flags', 'zip64', 'multidisk', 'count', 'overlap'] as const)(
    'refuses inconsistent or unsupported %s metadata before SheetJS can allocate', async kind => {
      const bytes = await container(); const view = new DataView(bytes.buffer); const c = central(bytes);
      if (kind === 'method') view.setUint16(8, 0, true);
      if (kind === 'flags') view.setUint16(6, 1, true);
      if (kind === 'zip64') view.setUint16(4, 45, true);
      if (kind === 'multidisk') view.setUint16(bytes.length - 18, 1, true);
      if (kind === 'count') view.setUint16(bytes.length - 14, 2, true);
      if (kind === 'overlap') view.setUint32(c + 20, bytes.length, true);
      expect(await preflightC3Workbook(bytes)).toBe(false);
    });
  it('closes the local-allocation bypass which central-only validation accepts (negative control)', async () => {
    const bytes = await container(); new DataView(bytes.buffer).setUint32(22, 0x40000000, true);
    // The existing bounded central reader safely returns the tiny real payload.
    // The unchanged SheetJS parser must NEVER see this huge local size claim.
    expect((await readZipSafely(bytes, C3_ZIP_LIMITS, nodeInflate)).safe).toBe(true);
    expect(await preflightC3Workbook(bytes)).toBe(false);
  });
  it('refuses traversal, corrupt CRC and malformed/truncated ZIP signatures', async () => {
    const bytes = await container(); const c = central(bytes); const view = new DataView(bytes.buffer);
    view.setUint32(c + 16, 0, true); view.setUint32(14, 0, true);
    expect(await preflightC3Workbook(bytes)).toBe(false);
    const path = await container(); const start = central(path);
    path.set(new TextEncoder().encode('../x.xml'), 30); path.set(new TextEncoder().encode('../x.xml'), start + 46);
    expect(await preflightC3Workbook(path)).toBe(false);
    expect(await preflightC3Workbook(new Uint8Array([80, 75, 3, 4]))).toBe(false);
  });
  it('refuses actual inflated output above the bound even when BOTH size claims lie', async () => {
    const zip = new JSZip(); zip.file('part.xml', new Uint8Array(C3_ZIP_LIMITS.maxZipEntryUncompressedBytes + 1).fill(65));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const view = new DataView(bytes.buffer); const c = central(bytes);
    view.setUint32(22, 1, true); view.setUint32(c + 24, 1, true);
    expect(bytes.length).toBeLessThan(3_145_728);
    expect(await preflightC3Workbook(bytes)).toBe(false);
  });
  it('refuses directory payloads instead of letting an ignored entry reach SheetJS', async () => {
    const bytes = await container(); const c = central(bytes);
    bytes[30 + 7] = 47; bytes[c + 46 + 7] = 47;
    expect(await preflightC3Workbook(bytes)).toBe(false);
  });
  it('refuses ZIP64 extra fields rather than relying only on version markers', async () => {
    const zip = new JSZip(); zip.file('شاهد.xml', 'synthetic');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const view = new DataView(bytes.buffer); const offset = 30 + view.getUint16(26, true);
    expect(view.getUint16(28, true)).toBeGreaterThan(4);
    view.setUint16(offset, 1, true);
    expect(await preflightC3Workbook(bytes)).toBe(false);
  });
  it('refuses a misleading EOCD signature in a ZIP comment', async () => {
    const zip = new JSZip(); zip.file('part.xml', 'synthetic');
    const bytes = await zip.generateAsync({ type: 'uint8array', comment: 'PK\u0005\u0006' });
    expect(await preflightC3Workbook(bytes)).toBe(false);
  });
  it('checks data descriptor claims and local allocation sizes independently', async () => {
    const bytes = await container(true); const view = new DataView(bytes.buffer);
    view.setUint32(22, 0x40000000, true);
    expect(await preflightC3Workbook(bytes)).toBe(false);
  });
});
