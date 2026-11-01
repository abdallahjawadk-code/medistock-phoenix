import { supabase } from '@/shared/supabase/client';
import type { AnnualCatalogScope } from './annual-catalog.contract';
import { AnnualCatalogContractError, catalogScope, catalogUuid } from './annual-catalog-server.contract';
import { decodeSourceCapabilities, decodeSourcePage, decodeVerifiedMembership, decodeVerifiedReceipt, freezeVerifiedIntent,
  validateSourcePageInput, type SourcePageInput, type VerifiedMembershipIntent } from './verified-source.contract';

export class VerifiedSourceError extends Error {
  constructor(readonly code: string, readonly outcomeUnknown = false, readonly requestId: string | null = null) { super(code); this.name = 'VerifiedSourceError'; }
}
export function isVerifiedSourceOutcomeUnknown(error: unknown): boolean {
  if (error instanceof VerifiedSourceError) return error.outcomeUnknown;
  if (error instanceof AnnualCatalogContractError) return error.outcomeUnknown || error.code !== 'annual_catalog_invalid_input';
  return true;
}
async function employeeToken(actorId: string): Promise<string> {
  const actor = catalogUuid(actorId, 'actorId');
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new VerifiedSourceError('not_authenticated');
  if (data.session.user.id !== actor) throw new VerifiedSourceError('source_session_changed');
  return data.session.access_token;
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('missing_body');
  const decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0, text = '';
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > 262144) { await reader.cancel(); throw new Error('response_too_large'); }
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}
const REFUSALS: Readonly<Record<number, readonly string[]>> = {
  400: ['invalid_request'], 401: ['not_authenticated'], 403: ['forbidden'], 404: ['original_unavailable'],
  409: ['c4_review_conflict'], 413: ['invalid_request', 'c4_evidence_too_large'],
  503: ['c4_reviewed_layouts_unavailable', 'c4_unavailable', 'c4_preparation_unavailable'], 504: ['c3_worker_timeout'],
};
async function request(path: string, actorId: string, body?: unknown, requestId: string | null = null): Promise<Record<string, unknown>> {
  const token = await employeeToken(actorId); let response: Response, value: unknown;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', redirect: 'error', credentials: 'omit',
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    value = await boundedJson(response);
  } catch { throw new VerifiedSourceError('source_transport_unavailable', requestId !== null, requestId); }
  const envelope = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!response.ok || envelope?.ok !== true) {
    const code = typeof envelope?.error === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(envelope.error) ? envelope.error : 'source_response_invalid';
    throw new VerifiedSourceError(code, requestId !== null && !(envelope?.ok === false && REFUSALS[response.status]?.includes(code)), requestId);
  }
  return envelope;
}
export async function discoverAnnualSourceProfiles(scope: AnnualCatalogScope, actorId: string) {
  const target = catalogScope(scope);
  const query = new URLSearchParams({ ownerOrgId: target.ownerOrgId, planningYear: String(target.planningYear) });
  return decodeSourceCapabilities(await request(`/api/central-needs/annual-source-capabilities?${query}`, actorId), target);
}
export async function readAnnualSourcePage(input: SourcePageInput, actorId: string) {
  const source = validateSourcePageInput(input);
  const body = { scope: source.scope, originalId: source.original.originalId, templateId: source.profile.id,
    templateVersion: source.profile.version, cursor: source.cursor, pageSize: source.pageSize };
  return decodeSourcePage(await request('/api/central-needs/extract-original', actorId, body), source);
}
/** Caller creates one frozen intent per explicit confirmation. Unknown results
 * require a separate receipt read before offering an explicit same-intent retry. */
export async function commitVerifiedMembership(input: VerifiedMembershipIntent) {
  const intent = freezeVerifiedIntent(input);
  const response = await request('/api/central-needs/commit-verified-membership', intent.actorId, intent.request, intent.request.requestId);
  try {
    if (Object.keys(response).length !== 2) throw new Error('unexpected_acknowledgement');
    return decodeVerifiedMembership(response.result, intent);
  } catch { throw new VerifiedSourceError('c4_commit_outcome_unknown', true, intent.request.requestId); }
}
/** A read only. Neither a prepared nor a missing receipt sends another command. */
export async function getVerifiedMembershipReceipt(input: VerifiedMembershipIntent) {
  const intent = freezeVerifiedIntent(input);
  try {
    await employeeToken(intent.actorId);
    const { data, error } = await supabase.rpc('phoenix_c4_receipt', { p_organization_id: intent.request.scope.ownerOrgId,
      p_planning_year: intent.request.scope.planningYear, p_request_id: intent.request.requestId });
    if (error) throw new Error('receipt_unavailable');
    return decodeVerifiedReceipt(data, intent);
  } catch { throw new VerifiedSourceError('source_receipt_unavailable', true, intent.request.requestId); }
}
