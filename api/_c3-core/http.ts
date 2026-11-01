/** Read-only HTTP orchestration. CPU parsing runs solely in the bounded worker.
 * Registrations and the worker URL are server dependencies, never request data. */
import { createHash } from 'node:crypto';
import type { AuthenticatedCaller } from '../_lib/supabase.ts';
import { errorResponse, jsonResponse } from '../_lib/http.ts';
import { C3_WORKER_BOUNDARY, type runC3IsolatedWorker } from '../_cn2b-core/annual-c3-worker-boundary.ts';
import type { readAuthorizedAnnualC3Original } from '../_cn2b-core/annual-c3-authorized-source.ts';
import type { RegisteredAnnualLayout } from './computation.ts';

interface Dependencies {
  registrations: readonly RegisteredAnnualLayout[];
  workerEntry: URL;
  authenticate(request: Request): Promise<AuthenticatedCaller | null>;
  read: typeof readAuthorizedAnnualC3Original;
  run: typeof runC3IsolatedWorker;
  authorized(caller: AuthenticatedCaller, org: string, permission: string): Promise<boolean>;
}
interface Input {
  scope: { ownerOrgId: string; planningYear: number };
  originalId: string; templateId: string; templateVersion: number;
  cursor: string | null; pageSize: number;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BODY_BYTES = 16_384;
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)));
}
async function inputFrom(request: Request): Promise<Input> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('invalid_request');
  const reader = request.body?.getReader(); if (!reader) throw new Error('invalid_request');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('request_too_large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!exact(value, ['scope', 'originalId', 'templateId', 'templateVersion', 'cursor', 'pageSize'])
    || !exact(value.scope, ['ownerOrgId', 'planningYear'])
    || typeof value.scope.ownerOrgId !== 'string' || !UUID.test(value.scope.ownerOrgId)
    || !Number.isInteger(value.scope.planningYear) || Number(value.scope.planningYear) < 2000 || Number(value.scope.planningYear) > 2100
    || typeof value.originalId !== 'string' || !UUID.test(value.originalId)
    || typeof value.templateId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value.templateId)
    || !Number.isSafeInteger(value.templateVersion) || Number(value.templateVersion) < 1
    || !Number.isInteger(value.pageSize) || Number(value.pageSize) < 1 || Number(value.pageSize) > C3_WORKER_BOUNDARY.maxPageRows
    || !(value.cursor === null || (typeof value.cursor === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value.cursor)))) {
    throw new Error('invalid_request');
  }
  const input = value as unknown as Input;
  return { ...input, originalId: input.originalId.toLowerCase(),
    scope: { ...input.scope, ownerOrgId: input.scope.ownerOrgId.toLowerCase() } };
}

export function createC3ReadHandler(deps: Dependencies) {
  if (deps.workerEntry.protocol !== 'file:' || deps.registrations.length > 100) throw new Error('invalid_server_configuration');
  const workerEntry = new URL(deps.workerEntry.href);
  const seen = new Set<string>();
  const registrations = deps.registrations.map(registration => {
    const serialized = JSON.stringify(registration);
    if (Buffer.byteLength(serialized) > C3_WORKER_BOUNDARY.maxTemplateBytes) throw new Error('invalid_server_configuration');
    const manifest = JSON.parse(serialized) as RegisteredAnnualLayout;
    const key = JSON.stringify([manifest.template.id, manifest.template.version]);
    if (seen.has(key)) throw new Error('invalid_server_configuration'); seen.add(key);
    return { manifest, expectedSha256: createHash('sha256').update(serialized).digest('hex') };
  });
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return errorResponse(405, 'method_not_allowed');
    try {
      const caller = await deps.authenticate(request);
      if (!caller) return errorResponse(401, 'not_authenticated');
      let input: Input;
      try { input = await inputFrom(request); }
      catch (error) { return errorResponse(error instanceof Error && error.message === 'request_too_large' ? 413 : 400, 'invalid_request'); }
      // No reviewed registry is shipped yet. Do not read original bytes merely
      // to return that fact, and never replace it with a client-provided map.
      if (!registrations.length) return errorResponse(503, 'c3_reviewed_layouts_unavailable');
      if (!await deps.authorized(caller, input.scope.ownerOrgId, 'central_needs.view')) return errorResponse(403, 'forbidden');
      const template = registrations.find(item => item.manifest.template.id === input.templateId
        && item.manifest.template.version === input.templateVersion);
      if (!template) return errorResponse(409, 'c3_reviewed_layout_unavailable');
      const source = await deps.read(caller, input.scope, input.originalId);
      const page = await deps.run(workerEntry, { source, template, pageSize: input.pageSize, cursor: input.cursor });
      // A permission change during CPU work must prevent delivery as well.
      if (!await deps.authorized(caller, input.scope.ownerOrgId, 'central_needs.view')) return errorResponse(403, 'forbidden');
      const body = { ok: true, evidence: page };
      if (Buffer.byteLength(JSON.stringify(body)) > C3_WORKER_BOUNDARY.maxResponseBytes) return errorResponse(413, 'c3_response_too_large');
      return jsonResponse(200, body);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'annual_c3_forbidden') return errorResponse(403, 'forbidden');
      if (code === 'annual_c3_original_unavailable') return errorResponse(404, 'original_unavailable');
      if (code === 'annual_c3_worker_timeout') return errorResponse(504, 'c3_worker_timeout');
      return errorResponse(503, 'c3_extraction_unavailable');
    }
  };
}
