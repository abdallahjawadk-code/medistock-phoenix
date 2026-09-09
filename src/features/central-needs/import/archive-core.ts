/**
 * CN-2A — archive-level orchestration. Ties the pure ZIP reader together
 * with the shared workbook parser core. Still isomorphic: the only
 * runtime-specific piece is the `Inflate` function each adapter injects.
 */

import type {
  ArchiveParseResult,
  ExcludedEntry,
  FileParseResult,
  InputFingerprint,
  ParserIdentity,
  ParserLimits,
  ParserRuntime,
  ReconciliationSummary,
} from './contract.ts';
import { CN2A_CONTRACT_VERSION, DEFAULT_PARSER_LIMITS, SHEETJS_TARBALL_SHA256, SHEETJS_VERSION, emptyWorkbookTotals, addWorkbookTotals } from './contract.ts';
import { classifyEntry, readZipSafely, type Inflate } from './zip-reader.ts';
import { parseWorkbookBytes, sha256Hex } from './parser-core.ts';

export interface ArchiveParseOptions {
  runtime: ParserRuntime;
  limits?: ParserLimits;
  inflate: Inflate;
  now?: () => string;
}

function makeIdentity(runtime: ParserRuntime): ParserIdentity {
  return { contractVersion: CN2A_CONTRACT_VERSION, sheetjsVersion: SHEETJS_VERSION, sheetjsTarballSha256: SHEETJS_TARBALL_SHA256, runtime };
}

export async function parseArchiveBytes(bytes: Uint8Array, originalFilename: string, options: ArchiveParseOptions): Promise<ArchiveParseResult> {
  const identity = makeIdentity(options.runtime);
  const limits = options.limits ?? DEFAULT_PARSER_LIMITS;
  const archiveSha256 = await sha256Hex(bytes);
  const archive: InputFingerprint = { originalFilename, sha256: archiveSha256, byteSize: bytes.byteLength };

  const zip = await readZipSafely(bytes, limits, options.inflate);
  if (!zip.safe) {
    return {
      identity,
      archive,
      entries: [],
      excludedEntries: [],
      diagnostics: zip.diagnostics,
      reconciliation: { filesTotal: 0, filesAccepted: 0, filesRejected: 0, filesExcluded: 0, aggregateTotals: emptyWorkbookTotals() },
    };
  }

  const entries: FileParseResult[] = [];
  const excludedEntries: ExcludedEntry[] = [];
  let aggregateTotals = emptyWorkbookTotals();
  let filesAccepted = 0;
  let filesRejected = 0;

  for (const entry of zip.entries) {
    const classified = classifyEntry(entry.path);
    if (classified.excluded) {
      if (classified.reason) excludedEntries.push({ path: entry.path, reason: classified.reason });
      continue;
    }
    if (entry.isDirectory || !entry.data) continue;

    const basename = entry.path.split('/').pop() ?? entry.path;
    const result = await parseWorkbookBytes(entry.data, basename, { runtime: options.runtime, limits, now: options.now }, entry.path);
    entries.push(result);
    if (result.outcome === 'accepted') {
      filesAccepted += 1;
      aggregateTotals = addWorkbookTotals(aggregateTotals, result.workbook!.totals);
    } else {
      filesRejected += 1;
    }
  }

  const reconciliation: ReconciliationSummary = {
    filesTotal: entries.length + excludedEntries.length,
    filesAccepted,
    filesRejected,
    filesExcluded: excludedEntries.length,
    aggregateTotals,
  };

  return { identity, archive, entries, excludedEntries, diagnostics: zip.diagnostics, reconciliation };
}
