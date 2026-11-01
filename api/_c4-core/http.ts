/** One verified NEW catalog membership. No legacy writer, automatic canonical
 * registration, annual quantity or stock operation is exposed here. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthenticatedCaller } from '../_lib/supabase.ts';
import { errorResponse, jsonResponse } from '../_lib/http.ts';
import type { readAuthorizedAnnualC3Original } from '../_cn2b-core/annual-c3-authorized-source.ts';
import type { runC3IsolatedWorker } from '../_cn2b-core/annual-c3-worker-boundary.ts';
import type { RegisteredAnnualLayout } from '../_c3-core/computation.ts';
import { C4_SHA, C4_UUID, c4Record, readC4MembershipInput, type C4MembershipInput } from './input.ts';

interface Dependencies {
  registrations: readonly RegisteredAnnualLayout[]; workerEntry: URL;
  authenticate(request: Request): Promise<AuthenticatedCaller | null>;
  authorized(caller: AuthenticatedCaller, org: string, permission: string): Promise<boolean>;
  read: typeof readAuthorizedAnnualC3Original; run: typeof runC3IsolatedWorker;
  service(): SupabaseClient;
  /** Hash of the immutable deployed server worker artifact, never request data. */
  workerSha256(): Promise<string>;
}
function refusal(message: string | undefined): Response | null {
  if (message === 'forbidden_central_needs' || message === 'c4_proof_unavailable') return errorResponse(403, 'forbidden');
  if (message === 'c4_not_enabled' || message === 'c4_schema_not_ready') return errorResponse(503, 'c4_unavailable');
  if (message && ['c4_idempotency_conflict','c4_source_identity_conflict','c4_source_identity_held','c4_classification_held',
    'c4_canonical_stale_or_incomplete','c4_source_binding_invalid','annual_catalog_membership_exists',
    'annual_catalog_year_archived'].includes(message)) return errorResponse(409, 'c4_review_conflict');
  return null;
}
async function permitted(deps: Dependencies, caller: AuthenticatedCaller, input: C4MembershipInput) {
  return await deps.authorized(caller, input.scope.ownerOrgId, 'central_needs.view')
    && await deps.authorized(caller, input.scope.ownerOrgId, 'central_needs.edit');
}
export function createC4MembershipHandler(deps: Dependencies) {
  if (deps.workerEntry.protocol !== 'file:' || deps.registrations.length > 100) throw new Error('invalid_server_configuration');
  const workerEntry = new URL(deps.workerEntry.href), seen = new Set<string>();
  const registrations = deps.registrations.map(registration => {
    const serialized = JSON.stringify(registration);
    if (Buffer.byteLength(serialized) > 65536) throw new Error('invalid_server_configuration');
    const manifest = JSON.parse(serialized) as RegisteredAnnualLayout;
    const key = JSON.stringify([manifest.template.id, manifest.template.version]);
    if (seen.has(key)) throw new Error('invalid_server_configuration'); seen.add(key);
    return { manifest, expectedSha256: createHash('sha256').update(serialized).digest('hex') };
  });
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return errorResponse(405, 'method_not_allowed');
    let commitStarted = false, input: C4MembershipInput | undefined;
    try {
      const caller = await deps.authenticate(request); if (!caller) return errorResponse(401, 'not_authenticated');
      try { input = await readC4MembershipInput(request); }
      catch (error) { return errorResponse(error instanceof Error && error.message === 'request_too_large' ? 413 : 400, 'invalid_request'); }
      if (!registrations.length) return errorResponse(503, 'c4_reviewed_layouts_unavailable');
      if (!await permitted(deps, caller, input)) return errorResponse(403, 'forbidden');
      const scopeArgs = { p_organization_id: input.scope.ownerOrgId, p_planning_year: input.scope.planningYear };
      const contract = await caller.client.rpc('phoenix_c4_catalog_contract', scopeArgs);
      const capability = c4Record(contract.data);
      if (contract.error || capability?.version !== 1 || capability.enabled !== true || capability.catalogCommitImplemented !== true
        || capability.trustedPreparationRequiresServer !== true || capability.maxPageRows !== 50 || capability.maxEvidenceBytes !== 262144) {
        return errorResponse(503, 'c4_unavailable');
      }
      const template = registrations.find(item => item.manifest.template.id === input!.templateId
        && item.manifest.template.version === input!.templateVersion && item.expectedSha256 === input!.expectedTemplateSha256);
      if (!template) return errorResponse(409, 'c4_review_conflict');
      const source = await deps.read(caller, input.scope, input.originalId);
      if (source.original.sha256 !== input.expectedOriginalSha256) return errorResponse(409, 'c4_review_conflict');
      const page = await deps.run(workerEntry, { source, template, pageSize: input.pageSize, cursor: input.cursor });
      if (!await permitted(deps, caller, input)) return errorResponse(403, 'forbidden');
      if (page.preparationStatus !== 'prepared') return errorResponse(409, 'c4_review_conflict');
      const pageKeys = page.rows.map(row => c4Record(row)?.occurrenceKey);
      if (pageKeys.some(key => typeof key !== 'string') || new Set(pageKeys).size !== pageKeys.length) return errorResponse(503, 'c4_unavailable');
      if (input.occurrenceKeys.some(key => !pageKeys.includes(key))) return errorResponse(409, 'c4_review_conflict');
      const selected = new Set(input.occurrenceKeys);
      const workerSha256 = await deps.workerSha256(); if (!C4_SHA.test(workerSha256)) return errorResponse(503, 'c4_unavailable');
      const evidence = { scope: page.scope, original: { ...page.original, firstFilename: source.original.firstFilename },
        template: page.template, coreTemplate: page.coreTemplate, parser: page.parser, registrySha256: page.registrySha256,
        classifications: page.classifications, rows: page.rows.filter(row => selected.has(c4Record(row)!.occurrenceKey as string)), workerSha256 };
      if (Buffer.byteLength(JSON.stringify(evidence)) > 262144) return errorResponse(413, 'c4_evidence_too_large');
      // This is the ONLY service call. It records prepared evidence, never an
      // employee membership, source download, canonical item or quantity.
      const sealed = await deps.service().rpc('phoenix_c4_seal', { ...scopeArgs, p_actor_id: caller.userId,
        p_request_id: input.requestId, p_canonical_id: input.canonicalItemId, p_expected_canonical_fingerprint: input.expectedCanonicalFingerprint,
        p_evidence: evidence, p_reason: input.reason });
      if (sealed.error) return refusal(sealed.error.message) ?? errorResponse(503, 'c4_preparation_unavailable');
      const proof = c4Record(sealed.data);
      const proofScope = c4Record(proof?.scope);
      if (!proof || proof.requestId !== input.requestId || proof.proofState !== 'sealed'
        || proofScope?.ownerOrgId !== input.scope.ownerOrgId || proofScope.planningYear !== input.scope.planningYear
        || typeof proof.proofId !== 'string' || !C4_UUID.test(proof.proofId)
        || typeof proof.proofSha256 !== 'string' || !C4_SHA.test(proof.proofSha256)) return errorResponse(503, 'c4_preparation_unavailable');
      // The employee's ORIGINAL client/JWT commits; service never impersonates.
      commitStarted = true;
      const committed = await caller.client.rpc('phoenix_c4_commit', { ...scopeArgs, p_request_id: input.requestId,
        p_proof_id: proof.proofId, p_expected_proof_sha256: proof.proofSha256 });
      if (committed.error) return refusal(committed.error.message) ?? jsonResponse(503, { ok: false, error: 'c4_commit_outcome_unknown', requestId: input.requestId });
      const result = c4Record(committed.data), verification = c4Record(result?.c4Verification);
      const membership = c4Record(result?.membership), version = c4Record(result?.fieldVersion);
      const resultScope = c4Record(result?.scope);
      if (!result || typeof result.idempotentReplay !== 'boolean' || result.sourceAttestation !== 'client_attested'
        || resultScope?.ownerOrgId !== input.scope.ownerOrgId || resultScope.planningYear !== input.scope.planningYear
        || verification?.attestation !== 'server_verified_c2_extraction_v1' || verification.reviewedById !== caller.userId
        || verification.proofId !== proof.proofId || verification.proofSha256 !== proof.proofSha256
        || verification.originalId !== input.originalId || verification.originalSha256 !== input.expectedOriginalSha256
        || membership?.canonicalItemId !== input.canonicalItemId
        || typeof membership?.annualItemId !== 'string' || !C4_UUID.test(membership.annualItemId)
        || typeof version?.fieldVersionId !== 'string' || !C4_UUID.test(version.fieldVersionId)
        || Buffer.byteLength(JSON.stringify(result)) > 262000) {
        return jsonResponse(503, { ok: false, error: 'c4_commit_outcome_unknown', requestId: input.requestId });
      }
      return jsonResponse(200, { ok: true, result });
    } catch (error) {
      if (commitStarted && input) return jsonResponse(503, { ok: false, error: 'c4_commit_outcome_unknown', requestId: input.requestId });
      const message = error instanceof Error ? error.message : '';
      if (message === 'annual_c3_forbidden') return errorResponse(403, 'forbidden');
      if (message === 'annual_c3_original_unavailable') return errorResponse(404, 'original_unavailable');
      if (message === 'annual_c3_worker_timeout') return errorResponse(504, 'c3_worker_timeout');
      return errorResponse(503, 'c4_preparation_unavailable');
    }
  };
}
