/** Private compiled entrypoint. The server owns the entry URL and registration.
 * No network, database, caller credentials or catalog writer is used here. */
import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createAnnualSourceComputer, type RegisteredAnnualLayout } from './computation.ts';
import { C3_WORKER_BOUNDARY } from '../_cn2b-core/annual-c3-worker-boundary.ts';
import type { AuthorizedC3Original } from '../_cn2b-core/annual-c3-authorized-source.ts';
import type { AnnualSourceOccurrence } from '../../src/features/central-needs/annual-catalog/annual-catalog.contract.ts';
import { CN2A_CONTRACT_VERSION, SHEETJS_VERSION, SHEETJS_TARBALL_SHA256 } from '../../src/features/central-needs/import/contract.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function requireInput(ok: unknown): asserts ok { if (!ok) throw new Error('rejected'); }

async function compute() {
  const request = workerData;
  requireInput(request && request.type === 'c3-worker-request' && typeof request.requestId === 'string'
    && request.bytes instanceof ArrayBuffer && request.bytes.byteLength > 0
    && request.bytes.byteLength <= C3_WORKER_BOUNDARY.maxFileBytes
    && Number.isInteger(request.pageSize) && request.pageSize >= 1 && request.pageSize <= C3_WORKER_BOUNDARY.maxPageRows
    && JSON.stringify(request.scope) === JSON.stringify(request.originalScope));
  const source = { scope: request.scope, original: request.original,
    bytes: new Uint8Array(request.bytes) } as AuthorizedC3Original;
  requireInput(source.original.attestation === 'server_received_original' && source.bytes.length === source.original.byteSize
    && hash(source.bytes) === source.original.sha256);
  const registration = request.reviewedTemplate.manifest as RegisteredAnnualLayout;
  const serialized = JSON.stringify(registration);
  const registrationSha256 = hash(serialized);
  requireInput(Buffer.byteLength(serialized, 'utf8') <= C3_WORKER_BOUNDARY.maxTemplateBytes
    && registrationSha256 === request.reviewedTemplate.expectedSha256);
  const result = await createAnnualSourceComputer([registration]).compute({ origin: 'c2_original',
    scope: { ...source.scope }, originalId: source.original.originalId, filename: source.original.firstFilename,
    sha256: source.original.sha256, byteSize: source.original.byteSize, bytes: source.bytes });
  const identity = hash(JSON.stringify([source.scope, source.original.originalId, source.original.sha256,
    source.original.byteSize, registrationSha256, CN2A_CONTRACT_VERSION, SHEETJS_VERSION, SHEETJS_TARBALL_SHA256, 'node']));
  let offset = 0;
  if (request.cursor !== null) {
    requireInput(typeof request.cursor === 'string' && request.cursor.length > 0
      && request.cursor.length <= C3_WORKER_BOUNDARY.maxCursorCharacters && /^[A-Za-z0-9_-]+$/.test(request.cursor));
    const decoded = Buffer.from(request.cursor, 'base64url');
    requireInput(decoded.toString('base64url') === request.cursor);
    const cursor = JSON.parse(decoded.toString('utf8'));
    requireInput(Array.isArray(cursor) && cursor.length === 3 && cursor[0] === 1 && cursor[1] === identity
      && Number.isSafeInteger(cursor[2]) && cursor[2] >= 0);
    offset = cursor[2];
  }
  const all: AnnualSourceOccurrence[] = result.status === 'prepared' ? result.candidate.occurrences : [];
  requireInput(all.length <= 5000 && offset <= all.length);
  const rows = all.slice(offset, offset + request.pageSize);
  const nextOffset = offset + rows.length;
  const page = {
    scope: { ...source.scope }, original: { originalId: source.original.originalId, sha256: source.original.sha256,
      byteSize: source.original.byteSize, attestation: 'server_received_original' },
    // This digest identifies the reviewed registration, including whole-source
    // sheet coverage. The computation's core-template digest stays distinct.
    template: { id: registration.template.id, version: String(registration.template.version), sha256: registrationSha256 },
    status: 'source_evidence_only_review_required', preparationStatus: result.status,
    ...(result.status === 'held' ? { heldReason: result.reason } : {
      coreTemplate: result.candidate.template, parser: result.candidate.parser,
      registrySha256: result.registrySha256, classifications: result.candidate.classifications,
    }),
    persisted: false, rows, totalRows: all.length,
    nextCursor: nextOffset < all.length ? Buffer.from(JSON.stringify([1, identity, nextOffset])).toString('base64url') : null,
  };
  requireInput(Buffer.byteLength(JSON.stringify(page), 'utf8') <= C3_WORKER_BOUNDARY.maxResponseBytes);
  parentPort?.postMessage({ type: 'c3-worker-result', requestId: request.requestId, page });
}
void compute().catch(() => {
  parentPort?.postMessage({ type: 'c3-worker-error', requestId: workerData?.requestId, code: 'rejected' });
});
