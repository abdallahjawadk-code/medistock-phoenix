/**
 * CN-2B — POST /api/central-needs/upload-ticket
 *
 * Mints a short-lived, server-created capability to write ONE staging object
 * pair (the source bytes and the provisional browser preview) into the private
 * bucket. The browser uploads straight to Supabase Storage with it, so a
 * workbook never travels through this function's request body.
 *
 * ORDER OF OPERATIONS, deliberately: authenticate → resolve the revision from
 * canonical database state → authorize that revision's real organization →
 * check the revision is still editable → only then mint a capability. The
 * request body contributes no organization identity and no path segment.
 */
import { errorResponse, failureResponse, jsonResponse, readJsonBody, requireMethod } from '../_lib/http.ts';
import { SOURCE_BUCKET, TRANSPORT_LIMITS } from '../_lib/env.ts';
import { authenticate, callerIsAuthorized, resolveRevisionAsCaller, serviceClient } from '../_lib/supabase.ts';
import { stagingPreviewKey, stagingSourceKey } from '../_lib/storage-paths.ts';

interface UploadTicketRequest {
  planRevisionId?: unknown;
  byteSize?: unknown;
}

export default async function handler(req: Request): Promise<Response> {
  const wrongMethod = requireMethod(req, 'POST');
  if (wrongMethod) return wrongMethod;

  try {
    const caller = await authenticate(req);
    if (!caller) return errorResponse(401, 'not_authenticated');

    const body = await readJsonBody<UploadTicketRequest>(req);
    if ('error' in body) return body.error;

    const planRevisionId = body.value.planRevisionId;
    if (typeof planRevisionId !== 'string' || planRevisionId === '') {
      return errorResponse(400, 'plan_revision_id_required');
    }
    if (body.value.byteSize !== undefined) {
      const size = body.value.byteSize;
      if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
        return errorResponse(400, 'byte_size_invalid');
      }
      if (size > TRANSPORT_LIMITS.maxSourceBytes) {
        // CN-2B transport policy, not a CN-2A parser limit.
        return errorResponse(413, 'source_exceeds_transport_limit', String(TRANSPORT_LIMITS.maxSourceBytes));
      }
    }

    const revision = await resolveRevisionAsCaller(caller, planRevisionId);
    if (!revision) return errorResponse(404, 'plan_revision_not_found');

    const authorized = await callerIsAuthorized(caller, revision.organizationId, 'central_needs.import');
    if (!authorized) return errorResponse(403, 'forbidden');

    if (revision.status !== 'draft') {
      return errorResponse(409, 'plan_revision_not_editable', revision.status);
    }

    const uploadId = crypto.randomUUID();
    const identity = {
      organizationId: revision.organizationId,
      planRevisionId: revision.id,
      userId: caller.userId,
      uploadId,
    };

    const service = serviceClient();
    const sourceKey = stagingSourceKey(identity);
    const previewKey = stagingPreviewKey(identity);

    const source = await service.storage.from(SOURCE_BUCKET).createSignedUploadUrl(sourceKey);
    if (source.error || !source.data) return errorResponse(502, 'staging_upload_unavailable');

    const preview = await service.storage.from(SOURCE_BUCKET).createSignedUploadUrl(previewKey);
    if (preview.error || !preview.data) return errorResponse(502, 'staging_upload_unavailable');

    // Only the capability is returned. The bucket is private, the keys are
    // server-generated, and no service-role credential is present anywhere in
    // this response.
    return jsonResponse(200, {
      ok: true,
      uploadId,
      // The PROVIDER's contract, reported verbatim. createSignedUploadUrl
      // takes no expiry argument, so a smaller number here would be a
      // promise Supabase Storage does not keep.
      expiresInSeconds: TRANSPORT_LIMITS.signedUploadTtlSeconds,
      expiresInSource: TRANSPORT_LIMITS.signedUploadTtlSource,
      source: { path: source.data.path, token: source.data.token },
      preview: { path: preview.data.path, token: preview.data.token },
    });
  } catch (err) {
    return failureResponse(err);
  }
}
