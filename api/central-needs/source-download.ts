/**
 * CN-2B — POST /api/central-needs/source-download
 *
 * Hands an authorized reviewer a short-lived signed URL for one permanent
 * source container. AUTHORIZE FIRST, then sign: the signed URL is minted only
 * after `central_needs.view` has been proven for the batch's real organization.
 *
 * WHY INSTITUTION AND OUTLET USERS CANNOT REACH A WORKBOOK. Three independent
 * layers, any one of which suffices:
 *   * the bucket is private, so no URL exists without this endpoint;
 *   * the batch row is read on the CALLER's client, so RLS
 *     (`central_needs.view`) decides whether it is even visible — an
 *     unauthorized caller gets 404, learning nothing about its existence;
 *   * the permission is then checked explicitly against the organization read
 *     from that row, never from the request.
 *
 * The locator is not treated as a path. It is parsed back through
 * `objectKeyFromLocator`, which rebuilds the key only if it matches the exact
 * shape this server generates, so a tampered locator addresses nothing.
 */
import { errorResponse, failureResponse, jsonResponse, readJsonBody, requireMethod } from '../_lib/http.ts';
import { SOURCE_BUCKET, TRANSPORT_LIMITS } from '../_lib/env.ts';
import { authenticate, callerIsAuthorized, serviceClient } from '../_lib/supabase.ts';
import { objectKeyFromLocator } from '../_lib/storage-paths.ts';

interface DownloadRequest {
  batchId?: unknown;
}

export default async function handler(req: Request): Promise<Response> {
  const wrongMethod = requireMethod(req, 'POST');
  if (wrongMethod) return wrongMethod;

  try {
    const caller = await authenticate(req);
    if (!caller) return errorResponse(401, 'not_authenticated');

    const body = await readJsonBody<DownloadRequest>(req);
    if ('error' in body) return body.error;

    const batchId = body.value.batchId;
    if (typeof batchId !== 'string' || batchId === '') {
      return errorResponse(400, 'batch_id_required');
    }

    // Read as the caller: RLS is the first authorization gate, and a caller
    // who cannot see the row cannot distinguish "forbidden" from "absent".
    const { data, error } = await caller.client
      .from('central_needs_import_batches')
      .select('id, organization_id, storage_locator, container_filename, container_kind, container_sha256')
      .eq('id', batchId)
      .maybeSingle();

    if (error || !data) return errorResponse(404, 'import_batch_not_found');

    const organizationId = data.organization_id as string;
    if (!(await callerIsAuthorized(caller, organizationId, 'central_needs.view'))) {
      return errorResponse(403, 'forbidden');
    }

    const objectKey = objectKeyFromLocator(data.storage_locator as string);
    if (objectKey === null) return errorResponse(422, 'storage_locator_unrecognised');

    const service = serviceClient();
    const signed = await service.storage
      .from(SOURCE_BUCKET)
      .createSignedUrl(objectKey, TRANSPORT_LIMITS.signedDownloadTtlSeconds, {
        // The human-readable name lives here, in a response header, rather
        // than in the object key it was never allowed to influence.
        download: data.container_filename as string,
      });
    if (signed.error || !signed.data) return errorResponse(502, 'source_download_unavailable');

    return jsonResponse(200, {
      ok: true,
      url: signed.data.signedUrl,
      expiresInSeconds: TRANSPORT_LIMITS.signedDownloadTtlSeconds,
      containerKind: data.container_kind,
      containerSha256: data.container_sha256,
      originalFilename: data.container_filename,
    });
  } catch (err) {
    return failureResponse(err);
  }
}
