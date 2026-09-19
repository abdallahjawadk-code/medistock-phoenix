/**
 * E2-A — the Source Identity Bridge.
 *
 * Proves, or refuses to prove, WHICH trusted ImportBatchEntry each workbook
 * the E1.1 persistent viewer displays came from. Only a proven identity lets
 * E2-A emit a selection; a refusal never hides the read-only source viewer —
 * it only keeps selection output disabled.
 *
 * AUTHORITATIVE INPUTS ONLY. finalize-import registers, for the i-th parsed
 * workbook of a batch (standalone file: the only one; ZIP:
 * `ArchiveParseResult.entries[i]`, every one accepted):
 *     entryOrdinal     = i + 1
 *     entrySha256      = that workbook's `input.sha256`
 *     archiveEntryPath = its `input.archiveEntryPath`, or null standalone
 * The bridge re-checks exactly those three facts — ordinal, SHA-256, archive
 * path — plus the batch and container identity. It never uses a file name on
 * its own, a sheet name, a title, cell or header content, a workbook family or
 * any inference; there is no fallback and no "closest match".
 *
 * Pure: no React, no service, no network, no storage. The input types are
 * structural, so the viewer layer never imports the service module.
 */
import type { ArchiveParseResult, FileParseResult } from '../import/contract.ts';
import { listViewerWorkbooks } from './excelViewerModel';
import type { WorkbookSourceIdentity } from './workbookSelection';

/** The persisted batch the displayed bytes were verified against (`ImportBatch`). */
export interface TrustedBatch {
  id: string;
  containerKind: 'file' | 'zip';
  containerSha256: string;
}

/** One row of `central_needs_import_batch_entries` (`ImportBatchEntry`), read under RLS. */
export interface TrustedBatchEntry {
  id: string;
  batchId: string;
  entryOrdinal: number;
  archiveEntryPath: string | null;
  entrySha256: string;
  importSessionId: string;
}

export type SourceIdentityFailure =
  | 'kind_mismatch'
  | 'container_sha_mismatch'
  | 'no_parsed_workbooks'
  | 'parsed_entry_rejected'
  | 'invalid_entry'
  | 'entry_batch_mismatch'
  | 'duplicate_entry'
  | 'entry_count_mismatch'
  | 'ordinal_mismatch'
  | 'sha_mismatch'
  | 'path_mismatch';

export type SourceIdentityResult =
  | { ok: true; identities: readonly WorkbookSourceIdentity[] }
  | { ok: false; reason: SourceIdentityFailure; workbookIndex?: number };

export interface SourceIdentityInput {
  batch: TrustedBatch;
  kind: 'file' | 'archive';
  result: FileParseResult | ArchiveParseResult;
  entries: readonly TrustedBatchEntry[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Lowercase hex, or null when it is not a SHA-256 at all. */
function sha(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase();
  return SHA256_HEX.test(hex) ? hex : null;
}

const fail = (reason: SourceIdentityFailure, workbookIndex?: number): SourceIdentityResult =>
  workbookIndex === undefined ? { ok: false, reason } : { ok: false, reason, workbookIndex };

function entryIsWellFormed(entry: TrustedBatchEntry): boolean {
  return typeof entry.id === 'string' && entry.id.trim() !== ''
    && typeof entry.batchId === 'string'
    && typeof entry.entryOrdinal === 'number' && Number.isInteger(entry.entryOrdinal) && entry.entryOrdinal >= 1
    && sha(entry.entrySha256) !== null
    && typeof entry.importSessionId === 'string' && entry.importSessionId.trim() !== ''
    && (entry.archiveEntryPath === null || (typeof entry.archiveEntryPath === 'string' && entry.archiveEntryPath !== ''));
}

function hasDuplicate<T>(values: readonly T[]): boolean {
  return new Set(values).size !== values.length;
}

export function bridgeSourceIdentity({ batch, kind, result, entries }: SourceIdentityInput): SourceIdentityResult {
  // --- the container: the verified batch, its kind and its fingerprint -------
  const isArchive = kind === 'archive';
  if ((batch.containerKind === 'zip') !== isArchive) return fail('kind_mismatch');
  if (isArchive ? !('entries' in result) : !('workbook' in result)) return fail('kind_mismatch');
  const containerSha = isArchive
    ? sha((result as ArchiveParseResult).archive?.sha256)
    : sha((result as FileParseResult).input?.sha256);
  if (containerSha === null || containerSha !== sha(batch.containerSha256)) return fail('container_sha_mismatch');

  // --- the displayed workbooks: every one must be a readable, accepted entry -
  const files = listViewerWorkbooks(kind, result);
  if (files.length === 0) return fail('no_parsed_workbooks');
  for (let i = 0; i < files.length; i += 1) {
    if (files[i].outcome !== 'accepted' || files[i].workbook === null) return fail('parsed_entry_rejected', i);
  }

  // --- the trusted rows: well-formed, this batch's, unambiguous --------------
  for (const entry of entries) {
    if (!entryIsWellFormed(entry)) return fail('invalid_entry');
    if (entry.batchId !== batch.id) return fail('entry_batch_mismatch');
  }
  if (hasDuplicate(entries.map((e) => e.id))
    || hasDuplicate(entries.map((e) => e.entryOrdinal))
    || hasDuplicate(entries.map((e) => e.importSessionId))) {
    return fail('duplicate_entry');
  }
  if (isArchive) {
    // Two rows or two displayed workbooks claiming the same archive path could
    // each match the other's evidence: ambiguous, so refused.
    if (hasDuplicate(entries.map((e) => e.archiveEntryPath))) return fail('duplicate_entry');
    if (hasDuplicate(files.map((f) => f.input.archiveEntryPath ?? null))) return fail('duplicate_entry');
  }
  if (entries.length !== files.length) return fail('entry_count_mismatch');

  // --- one displayed workbook <-> exactly one trusted row --------------------
  const byOrdinal = new Map(entries.map((e) => [e.entryOrdinal, e] as const));
  const identities: WorkbookSourceIdentity[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const entry = byOrdinal.get(i + 1);
    if (!entry) return fail('ordinal_mismatch', i);

    const parsedSha = sha(file.input.sha256);
    const trustedSha = sha(entry.entrySha256);
    if (parsedSha === null || parsedSha !== trustedSha) return fail('sha_mismatch', i);

    const parsedPath = file.input.archiveEntryPath ?? null;
    if (isArchive ? parsedPath === null || entry.archiveEntryPath !== parsedPath : entry.archiveEntryPath !== null || parsedPath !== null) {
      return fail('path_mismatch', i);
    }
    // A standalone file is the batch: its one entry IS the verified container.
    if (!isArchive && parsedSha !== containerSha) return fail('sha_mismatch', i);

    identities.push({
      batchId: batch.id,
      entryId: entry.id,
      entryOrdinal: entry.entryOrdinal,
      entrySha256: parsedSha,
      importSessionId: entry.importSessionId,
      workbookIndex: i,
    });
  }
  return { ok: true, identities };
}
