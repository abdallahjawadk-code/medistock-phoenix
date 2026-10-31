/**
 * C3-1c — a bounded, terminating Node worker *transport*, NOT an endpoint.
 *
 * Worker entry URL must be chosen by reviewed server code, NEVER by a user.
 * No parser is invoked by this module; integration with CN-2A's exact Node
 * parser and a reviewed template remains a separate acceptance gate.
 *
 * Worker creation is per call, with no reuse of actor, year or mutable state.
 * This boundary is not proof of hosted Worker bundling/runtime availability.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import type { AuthorizedC3Original } from './annual-c3-authorized-source.ts';

export const C3_WORKER_BOUNDARY = {
  timeoutMs: 10_000,
  maxFileBytes: 3_145_728,
  maxTemplateBytes: 65_536,
  maxResponseBytes: 262_144,
  maxPageRows: 50,
  maxCursorCharacters: 256,
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
} as const;

export interface ReviewedC3WorkerTemplate {
  /** Pinned by trusted server code; not posted as a customer mapping. */
  readonly manifest: unknown;
  readonly expectedSha256: string;
}
export interface C3WorkerRequest {
  readonly source: AuthorizedC3Original;
  readonly template: ReviewedC3WorkerTemplate;
  readonly pageSize: number;
  readonly cursor: string | null;
}
/** A transport-validated response, not an approved catalog material. */
export interface C3WorkerPage {
  readonly scope: { readonly ownerOrgId: string; readonly planningYear: number };
  readonly original: { readonly originalId: string; readonly sha256: string; readonly byteSize: number;
    readonly attestation: 'server_received_original' };
  readonly template: { readonly sha256: string; readonly id: string; readonly version: string };
  readonly status: 'source_evidence_only_review_required';
  readonly rows: readonly unknown[];
  readonly totalRows: number;
  readonly nextCursor: string | null;
  readonly [key: string]: unknown;
}
export type C3WorkerFactory = (entry: URL, options: WorkerOptions) => Worker;

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const FILENAME = /^[^/\\\u0000-\u001f\u007f-\u009f]{1,255}\.(xls|xlsx|csv)$/i;
const DEFAULT_FACTORY: C3WorkerFactory = (entry, options) => new Worker(entry, options);
function fail(code: string): never { throw new Error('annual_c3_worker_' + code); }
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function sameScope(value: unknown, source: AuthorizedC3Original): boolean {
  const x = record(value);
  return !!x && x.ownerOrgId === source.scope.ownerOrgId && x.planningYear === source.scope.planningYear;
}
function checkPage(value: unknown, source: AuthorizedC3Original,
  sha256: string, pageSize: number): C3WorkerPage {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > C3_WORKER_BOUNDARY.maxResponseBytes) {
    return fail('response_too_large');
  }
  const page = record(value);
  const original = record(page?.original);
  const template = record(page?.template);
  if (!page || !original || !template || !sameScope(page.scope, source) ||
      original.originalId !== source.original.originalId ||
      original.sha256 !== source.original.sha256 ||
      original.byteSize !== source.original.byteSize ||
      original.attestation !== 'server_received_original' ||
      template.sha256 !== sha256 ||
      page.status !== 'source_evidence_only_review_required' ||
      !Array.isArray(page.rows) || page.rows.length > pageSize ||
      !Number.isSafeInteger(page.totalRows) || (page.totalRows as number) < page.rows.length ||
      (page.totalRows as number) > 5_000 ||
      !(page.nextCursor === null || (typeof page.nextCursor === 'string' &&
        page.nextCursor.length > 0 &&
        page.nextCursor.length <= C3_WORKER_BOUNDARY.maxCursorCharacters &&
        /^[A-Za-z0-9_-]+$/.test(page.nextCursor)))) {
    return fail('response_invalid');
  }
  for (const item of page.rows) {
    const row = record(item);
    if (!row || !sameScope(row.scope, source)) return fail('response_scope_mismatch');
  }
  return value as C3WorkerPage;
}

/**
 * C3's caller must first call readAuthorizedAnnualC3Original() with its real
 * authenticated employee. This worker cannot download, authenticate or write.
 * The receiving worker must implement the fixed c3-worker-request protocol,
 * run the existing parser and return a c3-worker-result envelope.
 */
export async function runC3IsolatedWorker(
  reviewedWorkerEntry: URL,
  request: C3WorkerRequest,
  factory: C3WorkerFactory = DEFAULT_FACTORY,
): Promise<C3WorkerPage> {
  // A caller-supplied URL is never allowed at an HTTP boundary. The reviewer
  // picks a file: URL in code and proves the built artifact exists separately.
  if (!(reviewedWorkerEntry instanceof URL) || reviewedWorkerEntry.protocol !== 'file:' ||
      !reviewedWorkerEntry.pathname.endsWith('.mjs')) return fail('entry_invalid');
  const source = request.source;
  if (!source || !sameScope(source.scope, source) || !UUID.test(source.scope.ownerOrgId) ||
      !UUID.test(source.original.originalId) || !SHA.test(source.original.sha256) ||
      source.original.attestation !== 'server_received_original' ||
      !FILENAME.test(source.original.firstFilename) ||
      !(source.bytes instanceof Uint8Array) ||
      source.bytes.byteLength === 0 ||
      source.bytes.byteLength !== source.original.byteSize ||
      source.bytes.byteLength > C3_WORKER_BOUNDARY.maxFileBytes ||
      hash(source.bytes) !== source.original.sha256) return fail('source_invalid');
  if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1 ||
      request.pageSize > C3_WORKER_BOUNDARY.maxPageRows ||
      !(request.cursor === null || (typeof request.cursor === 'string' &&
        request.cursor.length <= C3_WORKER_BOUNDARY.maxCursorCharacters &&
        /^[A-Za-z0-9_-]+$/.test(request.cursor)))) return fail('page_invalid');
  const template = request.template;
  if (!template || !SHA.test(template.expectedSha256)) return fail('template_invalid');
  const serialized = JSON.stringify(template.manifest);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > C3_WORKER_BOUNDARY.maxTemplateBytes ||
      hash(Buffer.from(serialized, 'utf8')) !== template.expectedSha256) return fail('template_invalid');

  const requestId = randomUUID();
  const copied = Uint8Array.from(source.bytes);
  const options: WorkerOptions = {
    env: {},
    resourceLimits: {
      maxOldGenerationSizeMb: C3_WORKER_BOUNDARY.maxOldGenerationSizeMb,
      maxYoungGenerationSizeMb: C3_WORKER_BOUNDARY.maxYoungGenerationSizeMb,
      stackSizeMb: C3_WORKER_BOUNDARY.stackSizeMb,
    },
    workerData: {
      type: 'c3-worker-request', requestId,
      scope: { ...source.scope }, originalScope: { ...source.scope },
      original: { ...source.original }, bytes: copied.buffer,
      reviewedTemplate: { manifest: template.manifest, expectedSha256: template.expectedSha256 },
      pageSize: request.pageSize, cursor: request.cursor,
    },
    transferList: [copied.buffer],
  };
  let worker: Worker;
  try { worker = factory(reviewedWorkerEntry, options); }
  catch { return fail('startup_failed'); }

  return new Promise<C3WorkerPage>((resolve, reject) => {
    let settled = false;
    const settle = (errorCode: string | null, result?: C3WorkerPage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Always stop a worker after the single response; ignore late messages.
      void worker.terminate().catch(() => {});
      if (errorCode) reject(new Error('annual_c3_worker_' + errorCode));
      else resolve(result!);
    };
    const timer = setTimeout(() => settle('timeout'), C3_WORKER_BOUNDARY.timeoutMs);
    worker.on('message', (message: unknown) => {
      try {
        const envelope = record(message);
        if (!envelope || envelope.type !== 'c3-worker-result' ||
            envelope.requestId !== requestId) return settle('protocol_invalid');
        settle(null, checkPage(envelope.page, source, template.expectedSha256, request.pageSize));
      } catch { settle('response_invalid'); }
    });
    worker.once('error', () => settle('failed'));
    worker.once('exit', () => settle('exited_without_result'));
  });
}
