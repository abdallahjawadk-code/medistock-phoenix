/** C3-only admission policy, before the unchanged CN2A/SheetJS parser.
 * V8 Worker resourceLimits do not bound external ArrayBuffer allocations. */
import { DEFAULT_PARSER_LIMITS } from '../../src/features/central-needs/import/contract.ts';
import { readZipSafely } from '../../src/features/central-needs/import/zip-reader.ts';
import { nodeInflate } from '../../src/features/central-needs/import/node-inflate.ts';

export const C3_ZIP_LIMITS = Object.freeze({ ...DEFAULT_PARSER_LIMITS,
  maxStandaloneInputBytes: 3_145_728, maxZipEntryCount: 1000,
  maxZipEntryUncompressedBytes: 8 * 1024 * 1024,
  maxZipUncompressedBytes: 32 * 1024 * 1024, maxZipCompressionRatio: 300,
});
const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50, DESCRIPTOR = 0x08074b50;
function requireValue(value: unknown): asserts value { if (!value) throw new Error('invalid_container'); }

/** Reject size/method overrides which SheetJS would use BEFORE reconciling its
 * local header with the central directory. Shared ZIP validation alone checks
 * central bounds and inflation, but deliberately preserves its older contract. */
function consistentStructure(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  let end = -1;
  for (let at = bytes.length - 4; at >= Math.max(0, bytes.length - 65557); at--) {
    if (u32(at) === EOCD) { end = at; break; }
  }
  requireValue(end >= 0 && end + 22 <= bytes.length && end + 22 + u16(end + 20) === bytes.length);
  const count = u16(end + 10), start = u32(end + 16), length = u32(end + 12);
  requireValue(u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 8) === count
    && count > 0 && count <= C3_ZIP_LIMITS.maxZipEntryCount && start + length === end);
  function extra(at: number, length: number) {
    const limit = at + length; requireValue(limit <= bytes.length);
    while (at < limit) {
      requireValue(at + 4 <= limit && u16(at) !== 1); // ZIP64 overrides are not admitted by C3.
      at += 4 + u16(at + 2); requireValue(at <= limit);
    }
  }
  const ranges: [number, number][] = [];
  let at = start;
  for (let index = 0; index < count; index++) {
    requireValue(at + 46 <= end && u32(at) === CENTRAL);
    const flags = u16(at + 8), method = u16(at + 10), crc = u32(at + 16);
    const compressed = u32(at + 20), expanded = u32(at + 24);
    const nameLength = u16(at + 28), extraLength = u16(at + 30), commentLength = u16(at + 32);
    const local = u32(at + 42), nameStart = at + 46;
    requireValue(u16(at + 6) <= 20 && u16(at + 34) === 0 && (flags & ~0x080e) === 0
      && (method === 0 || method === 8) && nameLength > 0
      && nameStart + nameLength + extraLength + commentLength <= end
      && compressed <= bytes.length && expanded <= C3_ZIP_LIMITS.maxZipEntryUncompressedBytes
      && local + 30 <= start && u32(local) === LOCAL && u16(local + 4) <= 20
      && u16(local + 6) === flags && u16(local + 8) === method && u16(local + 26) === nameLength);
    const localName = local + 30, localExtra = u16(local + 28);
    const dataStart = localName + nameLength + localExtra, dataEnd = dataStart + compressed;
    requireValue(dataEnd <= start);
    for (let i = 0; i < nameLength; i++) requireValue(bytes[localName + i] === bytes[nameStart + i]);
    extra(localName + nameLength, localExtra); extra(nameStart + nameLength, extraLength);
    const descriptor = Boolean(flags & 8);
    for (const [offset, expected] of [[14, crc], [18, compressed], [22, expanded]]) {
      const actual = u32(local + offset); requireValue(actual === expected || (descriptor && actual === 0));
    }
    const directory = bytes[nameStart + nameLength - 1] === 47;
    const attributes = u32(at + 38);
    requireValue(!directory || (method === 0 && compressed === 0 && expanded === 0 && !descriptor));
    requireValue(!((attributes & 0x10) || ((attributes >>> 16) & 0xf000) === 0x4000) || directory);
    let rangeEnd = dataEnd;
    if (descriptor) {
      requireValue(dataEnd + 12 <= start);
      const d = u32(dataEnd) === DESCRIPTOR ? dataEnd + 4 : dataEnd;
      requireValue(d + 12 <= start && u32(d) === crc && u32(d + 4) === compressed && u32(d + 8) === expanded);
      rangeEnd = d + 12;
    }
    ranges.push([local, rangeEnd]); at = nameStart + nameLength + extraLength + commentLength;
  }
  requireValue(at === end);
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) requireValue(ranges[i - 1][1] <= ranges[i][0]);
}

export async function preflightC3Workbook(bytes: Uint8Array): Promise<boolean> {
  if (bytes.length < 1 || bytes.length > C3_ZIP_LIMITS.maxStandaloneInputBytes) return false;
  const signature = bytes.length >= 4 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) : 0;
  // SheetJS's ZIP dispatch is broader than CN2A's canonical magic detector:
  // any PK followed by two bytes below 9 can reach its CFB ZIP reader.
  const zipLike = bytes.length >= 4 && bytes[0] === 80 && bytes[1] === 75 && bytes[2] < 9 && bytes[3] < 9;
  if (zipLike && signature !== LOCAL) return false;
  if (signature !== LOCAL) return true;
  try {
    consistentStructure(bytes);
    const checked = await readZipSafely(bytes, C3_ZIP_LIMITS, nodeInflate);
    const safe = checked.safe;
    // Do not retain expanded bytes when the original enters the accepted parser.
    for (const entry of checked.entries) entry.data = null;
    return safe;
  } catch { return false; }
}
