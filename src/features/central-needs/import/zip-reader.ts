/**
 * CN-2A — pure, isomorphic ZIP central-directory reader.
 *
 * Adapted from the hand-rolled, independently-proven reader written for the
 * CN-0C gate (`D:\cn0c-work\harness\zip-safe-read.mjs`), which was run
 * against the real 71-entry corpus archive with zero findings. This version:
 *  - operates on `Uint8Array`/`DataView` only (no `Buffer`), so the
 *    central-directory walk, path-safety checks, and CRC-32 verification are
 *    100% isomorphic between Node 22 and the browser Worker;
 *  - takes decompression as an injected async function, so the one
 *    per-runtime difference documented in contract.ts (Node: sync
 *    `zlib.inflateRawSync`; browser: `DecompressionStream`) is the ONLY
 *    thing that differs — every byte of central-directory parsing, path
 *    normalization, traversal/symlink detection, and resource-limit
 *    enforcement is one shared function;
 *  - enforces `ParserLimits` (entry count, per-entry and aggregate
 *    uncompressed-size ceilings, compression-ratio ceiling) as hard
 *    rejections, not just findings, since this is now product code guarding
 *    a real upload path rather than a one-off audit script;
 *  - never decompresses an entry that already fails a pre-decompression
 *    check (traversal, absolute path, symlink, oversized declared size) —
 *    decompression is refused, not merely flagged after the fact.
 */

import type { Diagnostic, ParserLimits } from './contract.ts';
import { LOCK_FILE_PREFIX } from './contract.ts';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function findEOCD(view: DataView, length: number): number {
  const minPos = Math.max(0, length - (22 + 65535));
  for (let i = length - 22; i >= minPos; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new Error('EOCD signature not found — not a valid ZIP or truncated archive.');
}

/** Thrown by an `Inflate` implementation when actual output exceeds `maxOutputBytes`. */
export class InflateOutputLimitExceeded extends Error {
  constructor(limit: number) {
    super(`Inflated output exceeded the ${limit}-byte ceiling.`);
    this.name = 'InflateOutputLimitExceeded';
  }
}

export interface InflateOptions {
  /**
   * Hard ceiling on ACTUAL emitted bytes. Implementations MUST stop and throw
   * `InflateOutputLimitExceeded` as soon as this is exceeded — they must not
   * decompress to completion and check afterwards, and must not treat the
   * ZIP's declared size as authoritative (it is attacker-controlled).
   */
  maxOutputBytes: number;
}

export type Inflate = (compressed: Uint8Array, options: InflateOptions) => Promise<Uint8Array>;

export interface ZipEntryRaw {
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  data: Uint8Array | null;
  crcOk: boolean;
}

export interface ZipReadResult {
  entries: ZipEntryRaw[];
  diagnostics: Diagnostic[];
  safe: boolean;
}

function decodeName(bytes: Uint8Array, isUtf8: boolean): string {
  return new TextDecoder(isUtf8 ? 'utf-8' : 'windows-1252').decode(bytes);
}

export async function readZipSafely(
  bytes: Uint8Array,
  limits: ParserLimits,
  inflate: Inflate,
): Promise<ZipReadResult> {
  const diagnostics: Diagnostic[] = [];
  const entries: ZipEntryRaw[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocdPos: number;
  try {
    eocdPos = findEOCD(view, bytes.length);
  } catch (err) {
    diagnostics.push({
      code: 'TRUNCATED_CONTAINER',
      severity: 'fatal',
      message: err instanceof Error ? err.message : String(err),
    });
    return { entries: [], diagnostics, safe: false };
  }

  const totalEntries = view.getUint16(eocdPos + 10, true);
  const cenSize = view.getUint32(eocdPos + 12, true);
  const cenOffset = view.getUint32(eocdPos + 16, true);

  if (totalEntries > limits.maxZipEntryCount) {
    diagnostics.push({
      code: 'ZIP_ENTRY_COUNT_LIMIT_EXCEEDED',
      severity: 'fatal',
      message: `Archive declares ${totalEntries} entries, exceeding the ${limits.maxZipEntryCount} limit.`,
    });
    return { entries: [], diagnostics, safe: false };
  }

  if (cenOffset + cenSize > bytes.length) {
    diagnostics.push({ code: 'TRUNCATED_CONTAINER', severity: 'fatal', message: 'Central directory extends past end of buffer.' });
    return { entries: [], diagnostics, safe: false };
  }

  const seenNormalized = new Set<string>();
  let totalUncompressed = 0;
  let p = cenOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (view.getUint32(p, true) !== CEN_SIG) {
      diagnostics.push({ code: 'CORRUPT_RECORD_STREAM', severity: 'fatal', message: `Central directory record ${i} has a bad signature.` });
      return { entries: [], diagnostics, safe: false };
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crcExpected = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const uncompSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const externalAttrs = view.getUint32(p + 38, true);
    const localHeaderOffset = view.getUint32(p + 42, true);
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    const isUtf8 = (flags & 0x0800) !== 0;
    const name = decodeName(nameBytes, isUtf8);
    const normalized = name.normalize('NFC');

    let unsafe = false;
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\')) {
      diagnostics.push({ code: 'ZIP_PATH_TRAVERSAL', severity: 'fatal', message: `Entry "${name}" uses an absolute or backslash path.`, path: name });
      unsafe = true;
    }
    if (normalized.split('/').some((seg) => seg === '..')) {
      diagnostics.push({ code: 'ZIP_PATH_TRAVERSAL', severity: 'fatal', message: `Entry "${name}" contains a ".." path-traversal segment.`, path: name });
      unsafe = true;
    }
    const unixMode = externalAttrs >>> 16;
    const isSymlink = (unixMode & 0xf000) === 0xa000;
    if (isSymlink) {
      diagnostics.push({ code: 'ZIP_SYMLINK_ENTRY', severity: 'fatal', message: `Entry "${name}" is a Unix symlink.`, path: name });
      unsafe = true;
    }
    if (seenNormalized.has(normalized)) {
      diagnostics.push({ code: 'ZIP_PATH_TRAVERSAL', severity: 'fatal', message: `Entry "${name}" normalizes to a filename collision with a prior entry.`, path: name });
      unsafe = true;
    }
    seenNormalized.add(normalized);

    if (uncompSize > 0 && compSize > 0 && uncompSize / compSize > limits.maxZipCompressionRatio) {
      diagnostics.push({
        code: 'ZIP_COMPRESSION_RATIO_LIMIT_EXCEEDED',
        severity: 'fatal',
        message: `Entry "${name}" has compression ratio ${(uncompSize / compSize).toFixed(1)}, exceeding ${limits.maxZipCompressionRatio}.`,
        path: name,
      });
      unsafe = true;
    }
    if (uncompSize > limits.maxZipEntryUncompressedBytes) {
      diagnostics.push({
        code: 'ZIP_UNCOMPRESSED_SIZE_LIMIT_EXCEEDED',
        severity: 'fatal',
        message: `Entry "${name}" declares ${uncompSize} uncompressed bytes, exceeding the ${limits.maxZipEntryUncompressedBytes} per-entry limit.`,
        path: name,
      });
      unsafe = true;
    }
    totalUncompressed += uncompSize;
    if (totalUncompressed > limits.maxZipUncompressedBytes) {
      diagnostics.push({
        code: 'ZIP_UNCOMPRESSED_SIZE_LIMIT_EXCEEDED',
        severity: 'fatal',
        message: `Aggregate uncompressed size exceeded the ${limits.maxZipUncompressedBytes}-byte archive limit at entry "${name}".`,
        path: name,
      });
      unsafe = true;
    }

    const isDirectory = name.endsWith('/');
    let data: Uint8Array | null = null;
    let crcOk = true;

    if (!isDirectory && !unsafe) {
      if (localHeaderOffset + 30 > bytes.length || view.getUint32(localHeaderOffset, true) !== LOC_SIG) {
        diagnostics.push({ code: 'CORRUPT_RECORD_STREAM', severity: 'fatal', message: `Local header signature mismatch for entry "${name}".`, path: name });
        unsafe = true;
      } else {
        const locFlags = view.getUint16(localHeaderOffset + 6, true);
        const locNameLen = view.getUint16(localHeaderOffset + 26, true);
        const locExtraLen = view.getUint16(localHeaderOffset + 28, true);
        const locNameBytes = bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + locNameLen);
        const locName = decodeName(locNameBytes, (locFlags & 0x0800) !== 0);
        if (locName !== name) {
          diagnostics.push({ code: 'ZIP_LOCAL_CENTRAL_NAME_MISMATCH', severity: 'fatal', message: `Local header name "${locName}" does not match central directory name "${name}".`, path: name });
          unsafe = true;
        } else {
          const dataStart = localHeaderOffset + 30 + locNameLen + locExtraLen;
          const dataEnd = dataStart + compSize;
          if (dataEnd > bytes.length) {
            diagnostics.push({ code: 'TRUNCATED_CONTAINER', severity: 'fatal', message: `Entry "${name}" data extends past end of buffer.`, path: name });
            unsafe = true;
          } else {
            const raw = bytes.subarray(dataStart, dataEnd);
            // The ceiling handed to the decompressor is the POLICY limit, never
            // the entry's own declared `uncompSize` — a bomb lies about that.
            const maxOutputBytes = limits.maxZipEntryUncompressedBytes;
            if (method === 0) {
              // Stored: "compressed" length IS the output length, and it was
              // already bounded above by dataEnd <= bytes.length, but check the
              // policy ceiling explicitly so both methods fail closed alike.
              if (raw.length > maxOutputBytes) {
                diagnostics.push({
                  code: 'ZIP_INFLATED_OUTPUT_LIMIT_EXCEEDED',
                  severity: 'fatal',
                  message: `Entry "${name}" stored output of ${raw.length} bytes exceeds the ${maxOutputBytes}-byte ceiling.`,
                  path: name,
                });
                unsafe = true;
              } else {
                data = raw.slice();
              }
            } else if (method === 8) {
              try {
                data = await inflate(raw, { maxOutputBytes });
              } catch (err) {
                const limitHit =
                  err instanceof InflateOutputLimitExceeded ||
                  (err instanceof Error &&
                    // Node zlib surfaces its own maxOutputLength breach this way.
                    (/ERR_BUFFER_TOO_LARGE/.test(err.message) ||
                      (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'));
                diagnostics.push({
                  code: limitHit ? 'ZIP_INFLATED_OUTPUT_LIMIT_EXCEEDED' : 'CORRUPT_RECORD_STREAM',
                  severity: 'fatal',
                  message: limitHit
                    ? `Entry "${name}" inflated past the ${maxOutputBytes}-byte actual-output ceiling; decompression was aborted.`
                    : `Entry "${name}" could not be decompressed: ${err instanceof Error ? err.message : String(err)}`,
                  path: name,
                });
                unsafe = true;
              }
            } else {
              diagnostics.push({ code: 'CORRUPT_RECORD_STREAM', severity: 'fatal', message: `Entry "${name}" uses unsupported compression method ${method}.`, path: name });
              unsafe = true;
            }
            if (data) {
              // A truthful entry's actual output must equal what it declared.
              // Disagreement means the central directory lied; fail closed
              // rather than trusting either number.
              if (data.length !== uncompSize) {
                diagnostics.push({
                  code: 'ZIP_INFLATED_SIZE_MISMATCH',
                  severity: 'fatal',
                  message: `Entry "${name}" declared ${uncompSize} uncompressed bytes but actually produced ${data.length}.`,
                  path: name,
                });
                unsafe = true;
                data = null;
              }
            }
            if (data) {
              crcOk = crc32(data) === crcExpected;
              if (!crcOk) {
                diagnostics.push({ code: 'CORRUPT_RECORD_STREAM', severity: 'fatal', message: `Entry "${name}" failed CRC-32 verification.`, path: name });
                unsafe = true;
              }
            }
          }
        }
      }
    }

    if (!unsafe) {
      entries.push({ path: normalized, isDirectory, isSymlink, data, crcOk });
    }

    p += 46 + nameLen + extraLen + commentLen;
  }

  const safe = !diagnostics.some((d) => d.severity === 'fatal');
  return { entries, diagnostics, safe };
}

export interface ClassifiedEntry {
  path: string;
  excluded: boolean;
  reason?: 'lock_file' | 'directory';
}

/** Filenames beginning with "~$" and every directory entry are excluded pre-parse, never opened. */
export function classifyEntry(path: string): ClassifiedEntry {
  const basename = path.split('/').pop() ?? path;
  if (path.endsWith('/')) return { path, excluded: true, reason: 'directory' };
  if (basename.startsWith(LOCK_FILE_PREFIX)) return { path, excluded: true, reason: 'lock_file' };
  return { path, excluded: false };
}
