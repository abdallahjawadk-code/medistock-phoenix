/**
 * CN-2B — POST /api/central-needs/finalize-import
 *
 * The authoritative pass. Node 22 re-parses the exact stored bytes with the
 * frozen CN-2A core, proves the browser preview reproduces it field for field,
 * and only then writes any evidence.
 *
 * ORDER, and why each step precedes the next:
 *   1. authenticate                     — no work happens for an unproven caller
 *   2. resolve revision from the DB     — the organization is never a request input
 *   3. authorize central_needs.import   — the canonical Phoenix model, as the caller
 *   4. draft check                      — closed revisions accept nothing
 *   5. download staging bytes           — service_role, private, size-bounded
 *   6. verify the container SHA-256     — what we parse is what we will store
 *   7. Node 22 parse of the WHOLE input — the frozen shared parser core
 *   8. full masked parity vs the preview— any difference at all aborts
 *   9. every entry accepted             — one rejected member aborts the batch
 *  10. persist the container, once      — content-addressed, immutable
 *  11. per entry: digest -> session -> trusted replay
 *  12. register ONE trusted batch       — only after every entry completed
 *  13. drop staging                     — temporary objects only
 *
 * CRASH SAFETY. Steps 11 and 12 are separate on purpose. If this function dies
 * midway through a five-entry archive, some sessions are completed and no batch
 * exists — and M211's submit gate refuses a revision holding a completed
 * session that no batch claims. The import stays fail-closed until it is either
 * retried to completion (every step is idempotent) or abandoned with a reason.
 */
import { errorResponse, failureResponse, jsonResponse, readJsonBody, requireMethod, rpcErrorResponse } from '../_lib/http.ts';
import { SOURCE_BUCKET, TRANSPORT_LIMITS } from '../_lib/env.ts';
import { authenticate, callerIsAuthorized, resolveRevisionAsCaller, serviceClient } from '../_lib/supabase.ts';
import { entryLocator, permanentSourceKey, stagingPreviewKey, stagingSourceKey } from '../_lib/storage-paths.ts';
import { compareParsedResults } from '../_lib/parity.ts';
import { replayArchive, replayWorkbook } from '../../src/features/central-needs/import/node-replay.ts';
import { sha256Hex } from '../../src/features/central-needs/import/parser-core.ts';
import type { ArchiveParseResult, FileParseResult } from '../../src/features/central-needs/import/contract.ts';

interface FinalizeRequest {
  planRevisionId?: unknown;
  uploadId?: unknown;
  containerKind?: unknown;
}

const CONTROL_OR_DEL = new RegExp('[\\u0000-\\u001f\\u007f]');

/**
 * Metadata only — VALIDATED, never transformed. Rewriting the name here would
 * make it differ from the one the browser parsed with, which would break the
 * very parity check this endpoint exists to perform, so a bad name is refused
 * instead. Control characters would corrupt an audit line; a path separator
 * has no business in a basename.
 */
function safeMetadataFilename(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 255) return null;
  if (CONTROL_OR_DEL.test(trimmed)) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

/**
 * The browser's own preview declares which mode it parsed in. Deriving the
 * mode from the document, and then requiring the request to agree, means the
 * two runtimes cannot silently parse the same bytes in different modes — an
 * .xlsx and a ZIP archive share the same magic bytes, so this is not
 * detectable from the container alone.
 */
function detectPreviewKind(preview: unknown): 'file' | 'archive' | null {
  if (typeof preview !== 'object' || preview === null) return null;
  const p = preview as Record<string, unknown>;
  if (Array.isArray(p.entries) && typeof p.archive === 'object' && p.archive !== null) return 'archive';
  if (typeof p.input === 'object' && p.input !== null && 'workbook' in p) return 'file';
  return null;
}

/**
 * The stored size of one private object, read from Storage's own listing, or
 * null when it does not exist. Used to refuse an oversized object BEFORE it is
 * downloaded — a limit checked after `download()` would not be a limit at all.
 */
async function objectSize(
  service: ReturnType<typeof serviceClient>,
  key: string,
): Promise<number | null> {
  const slash = key.lastIndexOf('/');
  const prefix = slash === -1 ? '' : key.slice(0, slash);
  const name = key.slice(slash + 1);
  const listed = await service.storage.from(SOURCE_BUCKET).list(prefix, { search: name, limit: 100 });
  if (listed.error || !listed.data) return null;
  const found = listed.data.find((o) => o.name === name);
  if (!found) return null;
  const size = (found.metadata as { size?: unknown } | null)?.size;
  return typeof size === 'number' ? size : 0;
}

export default async function handler(req: Request): Promise<Response> {
  const wrongMethod = requireMethod(req, 'POST');
  if (wrongMethod) return wrongMethod;

  try {
    const caller = await authenticate(req);
    if (!caller) return errorResponse(401, 'not_authenticated');

    const body = await readJsonBody<FinalizeRequest>(req);
    if ('error' in body) return body.error;

    const planRevisionId = body.value.planRevisionId;
    const uploadId = body.value.uploadId;
    const declaredKind = body.value.containerKind;
    if (typeof planRevisionId !== 'string' || planRevisionId === '') {
      return errorResponse(400, 'plan_revision_id_required');
    }
    if (typeof uploadId !== 'string' || uploadId === '') {
      return errorResponse(400, 'upload_id_required');
    }
    if (declaredKind !== 'file' && declaredKind !== 'zip') {
      return errorResponse(400, 'container_kind_must_be_file_or_zip');
    }

    const revision = await resolveRevisionAsCaller(caller, planRevisionId);
    if (!revision) return errorResponse(404, 'plan_revision_not_found');

    if (!(await callerIsAuthorized(caller, revision.organizationId, 'central_needs.import'))) {
      return errorResponse(403, 'forbidden');
    }
    if (revision.status !== 'draft') {
      return errorResponse(409, 'plan_revision_not_editable', revision.status);
    }

    const service = serviceClient();
    const identity = {
      organizationId: revision.organizationId,
      planRevisionId: revision.id,
      userId: caller.userId,
      uploadId,
    };

    // --- 5. staging download (private, service_role, bounded) -------------
    const sourceKey = stagingSourceKey(identity);
    const previewKey = stagingPreviewKey(identity);

    // PRE-DOWNLOAD size proof. Checking byteLength after `download()` would
    // mean the object is already fully in memory — the ceiling would document a
    // limit it does not impose. Storage's own listing carries the size, so the
    // refusal happens before a single byte is pulled.
    const sourceSize = await objectSize(service, sourceKey);
    if (sourceSize === null) return errorResponse(404, 'staging_source_not_found');
    if (sourceSize > TRANSPORT_LIMITS.maxSourceBytes) {
      return errorResponse(413, 'source_exceeds_transport_limit', String(TRANSPORT_LIMITS.maxSourceBytes));
    }

    const sourceObject = await service.storage.from(SOURCE_BUCKET).download(sourceKey);
    if (sourceObject.error || !sourceObject.data) return errorResponse(404, 'staging_source_not_found');
    const sourceBuffer = await sourceObject.data.arrayBuffer();
    // Belt and braces: the listing is metadata, the bytes are the truth.
    if (sourceBuffer.byteLength > TRANSPORT_LIMITS.maxSourceBytes) {
      return errorResponse(413, 'source_exceeds_transport_limit', String(TRANSPORT_LIMITS.maxSourceBytes));
    }
    const sourceBytes = new Uint8Array(sourceBuffer);

    const previewSize = await objectSize(service, previewKey);
    if (previewSize === null) return errorResponse(404, 'staging_preview_not_found');
    if (previewSize > TRANSPORT_LIMITS.maxPreviewBytes) {
      return errorResponse(413, 'preview_exceeds_transport_limit', String(TRANSPORT_LIMITS.maxPreviewBytes));
    }

    const previewObject = await service.storage.from(SOURCE_BUCKET).download(previewKey);
    if (previewObject.error || !previewObject.data) return errorResponse(404, 'staging_preview_not_found');
    const previewText = await previewObject.data.text();
    if (new TextEncoder().encode(previewText).byteLength > TRANSPORT_LIMITS.maxPreviewBytes) {
      return errorResponse(413, 'preview_exceeds_transport_limit', String(TRANSPORT_LIMITS.maxPreviewBytes));
    }
    let previewDoc: unknown;
    try {
      previewDoc = JSON.parse(previewText);
    } catch {
      return errorResponse(422, 'staging_preview_not_json');
    }

    const previewKind = detectPreviewKind(previewDoc);
    if (previewKind === null) return errorResponse(422, 'staging_preview_unrecognised');
    const expectedKind = declaredKind === 'zip' ? 'archive' : 'file';
    if (previewKind !== expectedKind) {
      return errorResponse(422, 'container_kind_disagrees_with_preview');
    }

    // --- 6. container fingerprint ----------------------------------------
    const containerSha256 = await sha256Hex(sourceBytes);

    const previewRecord = previewDoc as Record<string, unknown>;
    const fingerprint = (previewKind === 'archive' ? previewRecord.archive : previewRecord.input) as
      | Record<string, unknown>
      | undefined;
    const containerFilename = safeMetadataFilename(fingerprint?.originalFilename);
    if (containerFilename === null) return errorResponse(422, 'original_filename_invalid');
    if (fingerprint?.sha256 !== containerSha256) {
      return errorResponse(422, 'preview_fingerprint_does_not_match_stored_source');
    }

    // --- 7. authoritative Node 22 parse ----------------------------------
    const nodeResult =
      previewKind === 'archive'
        ? await replayArchive(sourceBytes, containerFilename)
        : await replayWorkbook(sourceBytes, containerFilename);

    // --- 8. full masked parity -------------------------------------------
    const parity = compareParsedResults(previewDoc, nodeResult, previewKind);
    if (!parity.equal) {
      return jsonResponse(422, {
        ok: false,
        error: 'browser_node_parity_mismatch',
        difference: parity.difference,
      });
    }

    // --- 9. every accepted entry must really be accepted ------------------
    const entries: FileParseResult[] =
      previewKind === 'archive' ? (nodeResult as ArchiveParseResult).entries : [nodeResult as FileParseResult];
    const browserEntries: unknown[] =
      previewKind === 'archive' ? (previewRecord.entries as unknown[]) : [previewDoc];

    if (entries.length === 0) return errorResponse(422, 'no_accepted_entries');
    const rejected = entries.findIndex((e) => e.outcome !== 'accepted');
    if (rejected >= 0) {
      return jsonResponse(422, {
        ok: false,
        error: 'archive_contains_rejected_entry',
        detail: entries[rejected].input.archiveEntryPath ?? entries[rejected].input.originalFilename,
      });
    }

    // --- 10. persist the container once, content-addressed ----------------
    //
    // PERMANENT EVIDENCE IS CREATE-ONLY. Not upsert.
    //
    // `upsert: true` would be an overwrite path over immutable evidence, and
    // "the key is the content hash so it can only rewrite identical bytes" is
    // an argument, not an enforcement — it rests on this function computing the
    // key correctly forever. So the write is create-only, and a collision is
    // resolved by INDEPENDENTLY re-hashing what is already stored:
    //   * byte-identical  -> reuse, the retry is a true no-op;
    //   * anything else   -> fail closed, touching nothing.
    // Nothing here ever replaces or deletes a permanent object.
    const permanentKey = permanentSourceKey(revision.organizationId, revision.id, containerSha256);
    const stored = await service.storage
      .from(SOURCE_BUCKET)
      .upload(permanentKey, sourceBytes, { contentType: 'application/octet-stream', upsert: false });

    if (stored.error) {
      const existing = await service.storage.from(SOURCE_BUCKET).download(permanentKey);
      if (existing.error || !existing.data) return errorResponse(502, 'permanent_storage_unavailable');
      const existingSha = await sha256Hex(new Uint8Array(await existing.data.arrayBuffer()));
      if (existingSha !== containerSha256) {
        return jsonResponse(409, {
          ok: false,
          error: 'permanent_evidence_conflict',
          detail: 'an object already exists at this content-addressed key whose bytes hash differently',
        });
      }
      // Identical bytes already recorded: this retry adds nothing, as intended.
    }

    // --- 11. per entry: digest, session, trusted replay -------------------
    const manifest: Array<{
      entryOrdinal: number;
      archiveEntryPath: string | null;
      entrySha256: string;
      importSessionId: string;
    }> = [];

    for (let i = 0; i < entries.length; i += 1) {
      const nodeEntry = entries[i];
      const browserEntry = browserEntries[i] as Record<string, unknown>;
      const entrySha256 = nodeEntry.input.sha256;
      const archiveEntryPath = nodeEntry.input.archiveEntryPath ?? null;
      const ordinal = i + 1;

      // The preview digest is the BROWSER's provisional commitment, so it is
      // computed from the browser's own records — canonicalized by PostgreSQL,
      // never by a TypeScript reimplementation of jsonb::text.
      const digestCall = await service.rpc('_phoenix_central_needs_payload_digest_v1', {
        p_records: browserEntry.sourceRecords,
      });
      if (digestCall.error || typeof digestCall.data !== 'string') {
        return errorResponse(502, 'canonical_digest_unavailable');
      }
      const previewDigest = digestCall.data;

      // Started AS THE CALLER: auth.uid() and central_needs.import are the
      // real user's, exactly as if the browser had called it.
      //
      // ENTRY-AWARE. A ZIP may carry the same bytes at two paths, so the
      // session is identified by the entry as well as the file. `p_entry_path`
      // is NULL for a standalone workbook, which is exactly M210's behaviour.
      //
      // `p_original_filename` is the ENTRY'S OWN BASENAME, never its archive
      // path: CN-2A defines InputFingerprint.originalFilename as a basename and
      // keeps archiveEntryPath as a separate field, and the source-file row
      // must not conflate the two. The path is preserved as provenance, on the
      // session and on the batch entry.
      const started = await caller.client.rpc('phoenix_central_needs_start_import_entry_session', {
        p_plan_revision_id: revision.id,
        p_original_filename: nodeEntry.input.originalFilename,
        p_file_hash: entrySha256,
        p_preview_digest: previewDigest,
        p_parser_identity: browserEntry.identity,
        p_byte_size: nodeEntry.input.byteSize,
        p_storage_locator:
          previewKind === 'archive' ? entryLocator(permanentKey, ordinal, entrySha256) : permanentKey,
        p_entry_path: archiveEntryPath,
      });
      const startFailure = rpcErrorResponse(started.error);
      if (startFailure) return startFailure;

      const session = started.data as { import_session_id: string; status: string };

      // ALWAYS replay — including against an already-completed session.
      //
      // Skipping the call for a completed session would bypass the one check
      // that makes a retry safe: M210's completed-session branch re-digests the
      // SUPPLIED payload and refuses it unless it is the exact evidence already
      // finalized. Skipping it would let a retry carrying DIFFERENT evidence be
      // silently accepted as "already done". So the trusted RPC is called every
      // time and M210 — not this function — decides whether it is an exact
      // retry (no-op) or a conflict (refused).
      const replayed = await service.rpc('phoenix_central_needs_apply_authoritative_replay', {
        p_import_session_id: session.import_session_id,
        p_source_file_sha256: entrySha256,
        p_records: nodeEntry.sourceRecords,
        p_parser_identity: nodeEntry.identity,
      });
      const replayFailure = rpcErrorResponse(replayed.error);
      if (replayFailure) return replayFailure;

      manifest.push({
        entryOrdinal: ordinal,
        archiveEntryPath,
        entrySha256,
        importSessionId: session.import_session_id,
      });
    }

    // --- 12. ONE trusted batch, only now ----------------------------------
    const reconciliation =
      previewKind === 'archive' ? (nodeResult as ArchiveParseResult).reconciliation : null;
    const excludedCount =
      previewKind === 'archive' ? (nodeResult as ArchiveParseResult).excludedEntries.length : 0;

    const registered = await service.rpc('phoenix_central_needs_register_import_batch', {
      p_plan_revision_id: revision.id,
      p_container_kind: declaredKind,
      p_container_filename: containerFilename,
      p_container_sha256: containerSha256,
      p_storage_locator: permanentKey,
      p_entries: manifest,
      p_parser_identity: nodeResult.identity,
      p_container_byte_size: sourceBytes.byteLength,
      p_excluded_entry_count: excludedCount,
      p_reconciliation: reconciliation,
    });
    const registerFailure = rpcErrorResponse(registered.error);
    if (registerFailure) return registerFailure;

    // --- 13. temporary staging only ---------------------------------------
    await service.storage.from(SOURCE_BUCKET).remove([sourceKey, previewKey]);

    const result = registered.data as { batch_id: string; idempotent_replay: boolean };
    return jsonResponse(200, {
      ok: true,
      batchId: result.batch_id,
      idempotentReplay: result.idempotent_replay,
      containerKind: declaredKind,
      containerSha256,
      acceptedEntryCount: manifest.length,
      excludedEntryCount: excludedCount,
      importSessionIds: manifest.map((m) => m.importSessionId),
    });
  } catch (err) {
    return failureResponse(err);
  }
}
