/** Explicit review choices only. Source cells and actor/service authority are
 * reconstructed by the server; request bytes are bounded while streaming. */
export interface C4MembershipInput {
  scope: { ownerOrgId: string; planningYear: number };
  requestId: string; originalId: string; expectedOriginalSha256: string;
  templateId: string; templateVersion: number; expectedTemplateSha256: string;
  cursor: string | null; pageSize: number; occurrenceKeys: string[];
  canonicalItemId: string; expectedCanonicalFingerprint: string; reason: string;
}
export const C4_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const C4_SHA = /^[a-f0-9]{64}$/;
export function c4Record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  const record = c4Record(value);
  return !!record && Object.keys(record).length === fields.length && fields.every(key => Object.hasOwn(record, key));
}
export async function readC4MembershipInput(request: Request): Promise<C4MembershipInput> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('invalid_request');
  const reader = request.body?.getReader(); if (!reader) throw new Error('invalid_request');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new Error('request_too_large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!exact(value, ['scope','requestId','originalId','expectedOriginalSha256','templateId','templateVersion',
    'expectedTemplateSha256','cursor','pageSize','occurrenceKeys','canonicalItemId','expectedCanonicalFingerprint','reason'])
    || !exact(value.scope, ['ownerOrgId','planningYear'])
    || typeof value.scope.ownerOrgId !== 'string' || !C4_UUID.test(value.scope.ownerOrgId)
    || !Number.isSafeInteger(value.scope.planningYear) || Number(value.scope.planningYear) < 2000 || Number(value.scope.planningYear) > 2100
    || ['requestId','originalId','canonicalItemId'].some(key => typeof value[key] !== 'string' || !C4_UUID.test(value[key] as string))
    || ['expectedOriginalSha256','expectedTemplateSha256','expectedCanonicalFingerprint'].some(key => typeof value[key] !== 'string' || !C4_SHA.test(value[key] as string))
    || typeof value.templateId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value.templateId)
    || !Number.isSafeInteger(value.templateVersion) || Number(value.templateVersion) < 1
    || !Number.isInteger(value.pageSize) || Number(value.pageSize) < 1 || Number(value.pageSize) > 50
    || !(value.cursor === null || (typeof value.cursor === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value.cursor)))
    || !Array.isArray(value.occurrenceKeys) || value.occurrenceKeys.length < 1 || value.occurrenceKeys.length > Number(value.pageSize)
    || new Set(value.occurrenceKeys).size !== value.occurrenceKeys.length
    || value.occurrenceKeys.some(key => typeof key !== 'string' || key.length < 1 || key.length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(key))
    || typeof value.reason !== 'string' || value.reason.trim().length < 1 || value.reason.length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(value.reason)) {
    throw new Error('invalid_request');
  }
  const checked = value as unknown as C4MembershipInput;
  return { ...checked, requestId: checked.requestId.toLowerCase(), originalId: checked.originalId.toLowerCase(),
    canonicalItemId: checked.canonicalItemId.toLowerCase(), reason: checked.reason.trim(),
    scope: { ...checked.scope, ownerOrgId: checked.scope.ownerOrgId.toLowerCase() } };
}
