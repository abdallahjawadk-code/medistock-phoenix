import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Worker } from 'node:worker_threads';
import type { AuthorizedC3Original } from '../annual-c3-authorized-source';
import { C3_WORKER_BOUNDARY, runC3IsolatedWorker,
  type C3WorkerFactory, type C3WorkerRequest } from '../annual-c3-worker-boundary';

const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const scope = { ownerOrgId: '11111111-1111-4111-8111-111111111111', planningYear: 2026 };
const originalId = '22222222-2222-4222-8222-222222222222';
const entry = new URL('file:///reviewed-c3-worker.mjs');
const manifest = { templateId: 'reviewed-test', version: '1.0.0',
  parserContractVersion: '1.2.0', sheetjsVersion: '0.20.3' };
function fixture(): C3WorkerRequest {
  const bytes = new TextEncoder().encode('id,name\n001,Example\n');
  const source: AuthorizedC3Original = {
    scope, bytes, original: {
      originalId, sha256: sha(bytes), byteSize: bytes.length, firstFilename: 'fixture.csv',
      createdBy: '33333333-3333-4333-8333-333333333333',
      createdByName: 'Test Operator', createdByRole: 'employee',
      createdAt: '2026-10-31T12:00:00Z', attestation: 'server_received_original',
    },
  };
  return { source, pageSize: 25, cursor: null,
    template: { manifest, expectedSha256: sha(JSON.stringify(manifest)) } };
}
function validPage(request: C3WorkerRequest) {
  return {
    scope, original: {
      originalId, sha256: request.source.original.sha256,
      byteSize: request.source.original.byteSize, attestation: 'server_received_original',
    },
    template: { id: 'reviewed-test', version: '1.0.0',
      sha256: request.template.expectedSha256 },
    status: 'source_evidence_only_review_required', totalRows: 1, nextCursor: null,
    rows: [{ scope, source: { sheetIndex: 0, row: 1 } }],
  };
}
class MockWorker extends EventEmitter {
  terminated = 0;
  async terminate(): Promise<number> { this.terminated++; return 0; }
}
function mockFactory(onReady: (worker: MockWorker, options: {
  workerData?: unknown; env?: unknown; resourceLimits?: unknown; transferList?: unknown;
}) => void): { factory: C3WorkerFactory; workers: MockWorker[] } {
  const workers: MockWorker[] = [];
  return {
    workers, factory: (url, options) => {
      expect(url.href).toBe(entry.href);
      const worker = new MockWorker();
      workers.push(worker);
      queueMicrotask(() => onReady(worker, options));
      return worker as unknown as Worker;
    },
  };
}
describe('C3 isolated worker transport — not an HTTP route or parser approval', () => {
  it('transfers bounded original bytes to a reviewed file worker, without JWT or environment', async () => {
    const input = fixture();
    const m = mockFactory((worker, options) => {
      const data = options.workerData as { requestId: string; original: Record<string, unknown>;
        bytes: ArrayBuffer; scope: unknown; reviewedTemplate: unknown };
      expect(options.env).toEqual({});
      expect(options.resourceLimits).toEqual({
        maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4,
      });
      expect(Buffer.from(data.bytes).toString()).toBe('id,name\n001,Example\n');
      expect(JSON.stringify(data)).not.toContain('accessToken');
      expect(data.scope).toEqual(scope);
      worker.emit('message', { type: 'c3-worker-result', requestId: data.requestId,
        page: validPage(input) });
    });
    const result = await runC3IsolatedWorker(entry, input, m.factory);
    expect(result.rows).toHaveLength(1);
    expect(result.status).toBe('source_evidence_only_review_required');
    expect(m.workers[0].terminated).toBe(1);
  });
  it('rejects changed bytes or a different manifest hash before creating a worker', async () => {
    const input = fixture();
    const m = mockFactory(() => {});
    const changed = { ...input, source: { ...input.source,
      bytes: new TextEncoder().encode('id,name\n002,Example\n') } };
    await expect(runC3IsolatedWorker(entry, changed, m.factory))
      .rejects.toThrow('annual_c3_worker_source_invalid');
    await expect(runC3IsolatedWorker(entry, { ...input, template: {
      ...input.template, expectedSha256: 'f'.repeat(64),
    } }, m.factory)).rejects.toThrow('annual_c3_worker_template_invalid');
    expect(m.workers).toHaveLength(0);
  });
  it('refuses a remote worker URL or oversized page without starting a worker', async () => {
    const input = fixture();
    const m = mockFactory(() => {});
    await expect(runC3IsolatedWorker(new URL('https://example.com/worker.mjs'), input, m.factory))
      .rejects.toThrow('annual_c3_worker_entry_invalid');
    await expect(runC3IsolatedWorker(entry, { ...input, pageSize: 51 }, m.factory))
      .rejects.toThrow('annual_c3_worker_page_invalid');
    expect(m.workers).toHaveLength(0);
  });
  it('terminates a timed-out worker instead of leaving it running', async () => {
    vi.useFakeTimers();
    try {
      const m = mockFactory(() => {});
      const pending = runC3IsolatedWorker(entry, fixture(), m.factory);
      // Attach the rejection observer BEFORE advancing fake timers: a valid
      // timeout must not become an unhandled rejection in the full CI run.
      const rejection = expect(pending).rejects.toThrow('annual_c3_worker_timeout');
      await vi.advanceTimersByTimeAsync(C3_WORKER_BOUNDARY.timeoutMs + 1);
      await rejection;
      expect(m.workers[0].terminated).toBe(1);
    } finally { vi.useRealTimers(); }
  });
  it('rejects malformed, stale or foreign-year worker output', async () => {
    const input = fixture();
    const wrong = mockFactory((worker, options) => {
      const data = options.workerData as { requestId: string };
      worker.emit('message', { type: 'c3-worker-result', requestId: data.requestId,
        page: { ...validPage(input), scope: { ...scope, planningYear: 2027 } } });
    });
    await expect(runC3IsolatedWorker(entry, input, wrong.factory))
      .rejects.toThrow('annual_c3_worker_response_invalid');
    const stale = mockFactory((worker) => worker.emit('message', {
      type: 'c3-worker-result', requestId: 'stale', page: validPage(input),
    }));
    await expect(runC3IsolatedWorker(entry, input, stale.factory))
      .rejects.toThrow('annual_c3_worker_protocol_invalid');
  });
  it('rejects over-budget output and terminates the worker', async () => {
    const input = fixture();
    const m = mockFactory((worker, options) => {
      const data = options.workerData as { requestId: string };
      worker.emit('message', { type: 'c3-worker-result', requestId: data.requestId,
        page: { ...validPage(input), rows: [{ scope, padding: 'x'.repeat(300_000) }] } });
    });
    await expect(runC3IsolatedWorker(entry, input, m.factory))
      .rejects.toThrow('annual_c3_worker_response_invalid');
    expect(m.workers[0].terminated).toBe(1);
  });
  it('hides worker exceptions and rejects premature exit', async () => {
    const input = fixture();
    const fault = mockFactory((worker) => worker.emit('error', new Error('secret token')));
    await expect(runC3IsolatedWorker(entry, input, fault.factory))
      .rejects.toThrow('annual_c3_worker_failed');
    const early = mockFactory((worker) => worker.emit('exit', 1));
    await expect(runC3IsolatedWorker(entry, input, early.factory))
      .rejects.toThrow('annual_c3_worker_exited_without_result');
  });
});
