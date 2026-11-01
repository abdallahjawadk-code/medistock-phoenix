import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { POST } from '../../central-needs/extract-original.ts';
import { POST as C4_POST } from '../../central-needs/commit-verified-membership.ts';

describe('private worker deployment packaging, no workbook or database', () => {
  beforeAll(() => execFileSync(process.execPath, ['scripts/c3-worker-assets.mjs']), 30000);
  it('the deployed business route refuses anonymous input without configuration or database reads', async () => {
    const response = await POST(new Request('http://localhost/api/central-needs/extract-original', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'not_authenticated' });
    const c4 = await C4_POST(new Request('http://localhost/api/central-needs/commit-verified-membership', { method: 'POST' }));
    expect(c4.status).toBe(401); expect(await c4.json()).toEqual({ ok: false, error: 'not_authenticated' });
  });
  it('loads the generated worker and waits for its actual termination', async () => {
    const worker = new Worker(pathToFileURL(resolve('.c3-runtime/worker.mjs')), {
      env: {}, workerData: { requestId: 'package-check' },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const message = await new Promise((accept, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 10000);
        worker.once('message', accept); worker.once('error', reject);
        worker.once('exit', () => reject(new Error('early_exit')));
      });
      expect(message).toEqual({ type: 'c3-worker-error', requestId: 'package-check', code: 'rejected' });
    } finally { clearTimeout(timer); await worker.terminate(); }
  }, 15000);
});
