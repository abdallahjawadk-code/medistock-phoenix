/** Temporary Preview-only deployment proof. Remove before accepting this batch.
 * No source bytes, credentials, database, caller input or business fixtures. */
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { jsonResponse } from '../_lib/http.ts';
import { C3_WORKER_BOUNDARY } from '../_cn2b-core/annual-c3-worker-boundary.ts';

export async function GET(): Promise<Response> {
  if (process.env.VERCEL_ENV !== 'preview'
    || process.env.VERCEL_GIT_COMMIT_REF !== 'feat/c3-hosted-worker-20261101') {
    return jsonResponse(404, { ok: false, error: 'not_found' });
  }
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const requestId = randomUUID();
    worker = new Worker(pathToFileURL(resolve('.c3-runtime/worker.mjs')), {
      env: {}, workerData: { requestId }, // deliberately invalid, no business data
      resourceLimits: { maxOldGenerationSizeMb: C3_WORKER_BOUNDARY.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: C3_WORKER_BOUNDARY.maxYoungGenerationSizeMb,
        stackSizeMb: C3_WORKER_BOUNDARY.stackSizeMb },
    });
    await new Promise<void>((accept, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), C3_WORKER_BOUNDARY.timeoutMs);
      worker!.once('error', reject);
      worker!.once('exit', () => reject(new Error('exit')));
      worker!.once('message', value => value?.type === 'c3-worker-error'
        && value.requestId === requestId && value.code === 'rejected'
        ? accept() : reject(new Error('protocol')));
    });
    await worker.terminate(); worker = undefined;
    return jsonResponse(200, { ok: true, component: 'private_c3_worker',
      loaded: true, terminated: true, parserEvaluated: false, businessDataRead: false });
  } catch {
    return jsonResponse(503, { ok: false, error: 'c3_runtime_unavailable' });
  } finally {
    clearTimeout(timer);
    if (worker) await worker.terminate();
  }
}
