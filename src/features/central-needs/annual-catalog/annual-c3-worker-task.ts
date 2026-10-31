/**
 * C3-1d — private, single-message Node worker task handler.
 *
 * Consumes the structured-cloned request created by the C3 worker boundary,
 * replays the existing pinned CN-2A parser, and emits bounded source EVIDENCE.
 * No database, Storage, network, worker bootstrap or HTTP endpoint is used here.
 * The reviewed deployment still needs a real worker entrypoint/bundle and
 * independent hostile-file / timeout testing before this may serve requests.
 */
import { replayAnnualC3Evidence, C3_REPLAY_LIMITS, type C3ReplayInput,
  type C3ReplayPage } from './annual-c3-replay';

export interface C3WorkerTaskSuccess {
  readonly type: 'c3-worker-result';
  readonly requestId: string;
  readonly page: C3ReplayPage;
}
export interface C3WorkerTaskFailure {
  readonly type: 'c3-worker-error';
  readonly requestId: string;
  /** Never echo a parser exception, cell content, filename or JWT. */
  readonly code: 'rejected';
}
export type C3WorkerTaskResponse = C3WorkerTaskSuccess | C3WorkerTaskFailure;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]+$/;
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/**
 * Only the trusted server-owned worker entrypoint calls this. A caller cannot
 * supply a template, raw file or arbitrary worker path through an HTTP route.
 * All source/template hashes, owner/year and parser versions are revalidated by
 * replayAnnualC3Evidence, even after this transport check.
 */
export async function handleAnnualC3WorkerTask(message: unknown): Promise<C3WorkerTaskResponse | null> {
  const request = object(message);
  if (!request || request.type !== 'c3-worker-request' ||
      typeof request.requestId !== 'string' || !ID.test(request.requestId)) {
    return null;
  }
  const requestId = request.requestId;
  try {
    if (!(request.bytes instanceof ArrayBuffer) ||
        request.bytes.byteLength < 1 ||
        request.bytes.byteLength > C3_REPLAY_LIMITS.maxFileBytes ||
        !object(request.scope) || !object(request.originalScope) ||
        !object(request.original) || !object(request.reviewedTemplate) ||
        !Number.isSafeInteger(request.pageSize) ||
        (request.pageSize as number) < 1 ||
        (request.pageSize as number) > C3_REPLAY_LIMITS.maxPageSize ||
        !(request.cursor === null ||
          (typeof request.cursor === 'string' &&
            request.cursor.length > 0 &&
            request.cursor.length <= C3_REPLAY_LIMITS.maxCursorChars &&
            CURSOR.test(request.cursor)))) {
      return { type: 'c3-worker-error', requestId, code: 'rejected' };
    }
    const input: C3ReplayInput = {
      scope: request.scope as unknown as C3ReplayInput['scope'],
      originalScope: request.originalScope as unknown as C3ReplayInput['originalScope'],
      original: request.original as unknown as C3ReplayInput['original'],
      bytes: new Uint8Array(request.bytes),
      reviewedTemplate: request.reviewedTemplate as unknown as C3ReplayInput['reviewedTemplate'],
      pageSize: request.pageSize as number,
      cursor: request.cursor as string | null,
    };
    const page = await replayAnnualC3Evidence(input);
    return { type: 'c3-worker-result', requestId, page };
  } catch {
    // Deliberately fixed error shape: even corrupt formulas/headers never echo.
    return { type: 'c3-worker-error', requestId, code: 'rejected' };
  }
}
