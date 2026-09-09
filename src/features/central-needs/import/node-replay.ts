/**
 * CN-2A — Node 22 authoritative replay adapter.
 *
 * This is the trusted-side counterpart to the browser Worker preview: given
 * file bytes already keyed by their SHA-256 fingerprint (as CN-1B's future
 * staging upload would provide), it reproduces the exact same shared-core
 * parse the browser Worker already ran, using the Node-only DEFLATE adapter
 * for the one documented per-runtime exception (ZIP decompression).
 *
 * This module does no filesystem I/O and no database access itself — callers
 * supply bytes. The disk-reading CLI wrapper lives in
 * `scripts/cn2a-node-replay.ts` (development/verification tooling only, not
 * shipped to the browser bundle).
 */
import type { ArchiveParseResult, FileParseResult, ParserLimits } from './contract.ts';
import { parseArchiveBytes } from './archive-core.ts';
import { parseWorkbookBytes } from './parser-core.ts';
import { nodeInflate } from './node-inflate.ts';

export async function replayWorkbook(bytes: Uint8Array, filename: string, limits?: ParserLimits): Promise<FileParseResult> {
  return parseWorkbookBytes(bytes, filename, { runtime: 'node', limits });
}

export async function replayArchive(bytes: Uint8Array, filename: string, limits?: ParserLimits): Promise<ArchiveParseResult> {
  return parseArchiveBytes(bytes, filename, { runtime: 'node', limits, inflate: nodeInflate });
}
