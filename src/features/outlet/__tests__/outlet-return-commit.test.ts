/**
 * OUTLET-RETURN commit — behavioural, driven through an injected fake 071 server.
 *
 * The composer commits header-then-lines via commitDraft and recovers a partial
 * failure via planOutletReturnRetry. The fake server models the part of the 071
 * contract that decides whether a return double-posts: add-line is
 * idempotent-by-conflict on (return_request_id, original_dispatch_line_id), so a
 * replay never creates a second line. Every claim is measured against the count
 * of GENUINE line mutations, not how many times the client called.
 */
import { describe, it, expect } from 'vitest';
import { commitDraft } from '@/features/movement/movement-commit';
import { planOutletReturnRetry, type OutletReturnDraftLine } from '../outlet-return-draft';

const line = (dispatchLineId: string, key = dispatchLineId): OutletReturnDraftLine => ({
  idempotencyKey: key, originalDispatchLineId: dispatchLineId,
  scientificName: 'Amoxicillin', tradeName: null, concentration: null, dosageForm: null,
  unit: 'box', nationalCode: null, batchNumber: 'B-1', internalBatchReference: null,
  expiryDate: '2027-01-01', dispatchNumber: 'D-1', quantity: 5, maxQuantity: 40,
  reasonCode: 'damaged', reasonText: null,
});

/**
 * @param loseLineIndex a global add-line call index whose RESPONSE is lost after
 *        the mutation commits — models the dangerous "did it land?" case.
 */
function fakeServer(opts: { headerOk?: boolean; loseLineIndex?: number } = {}) {
  const { headerOk = true, loseLineIndex = -1 } = opts;
  let headerCount = 0;
  let lineMutations = 0;
  let addIndex = 0;
  // request id -> set of dispatch line ids already committed (the unique index).
  const committed = new Map<string, Set<string>>();

  const createHeader = async () => {
    if (!headerOk) return { ok: false, error: 'NOT_AUTHORIZED_RETURN' };
    headerCount += 1;
    const id = `RR-${headerCount}`;
    committed.set(id, new Set());
    return { ok: true, data: { return_request_id: id } };
  };

  const addLine = async (requestId: string, l: OutletReturnDraftLine) => {
    const i = addIndex++;
    const present = committed.get(requestId) ?? new Set<string>();
    committed.set(requestId, present);
    if (present.has(l.originalDispatchLineId)) {
      // Idempotent-by-conflict: already added, no new mutation.
      return { ok: true, data: { return_request_line_id: `L-${l.originalDispatchLineId}` } };
    }
    present.add(l.originalDispatchLineId);
    lineMutations += 1;
    if (i === loseLineIndex) return { ok: false, error: 'network_timeout' };
    return { ok: true, data: { return_request_line_id: `L-${l.originalDispatchLineId}` } };
  };

  return {
    createHeader, addLine,
    get headerCount() { return headerCount; },
    get lineMutations() { return lineMutations; },
    committedFor: (id: string) => [...(committed.get(id) ?? new Set())],
  };
}

describe('happy path', () => {
  it('creates one header and one line mutation per distinct provenance', async () => {
    const s = fakeServer();
    const result = await commitDraft<OutletReturnDraftLine>([line('DL1'), line('DL2')], s);
    expect(result.complete).toBe(true);
    expect(s.headerCount).toBe(1);
    expect(s.lineMutations).toBe(2);
    expect(s.committedFor(result.requestId!)).toEqual(['DL1', 'DL2']);
  });
});

describe('header failure persists nothing', () => {
  it('returns no request id and adds no lines', async () => {
    const s = fakeServer({ headerOk: false });
    const result = await commitDraft<OutletReturnDraftLine>([line('DL1')], s);
    expect(result.requestId).toBeNull();
    expect(result.headerError).toBe('NOT_AUTHORIZED_RETURN');
    expect(s.lineMutations).toBe(0);
  });
});

describe('partial failure then retry', () => {
  it('surfaces the request id, and retry re-sends ONLY the absent line', async () => {
    const s = fakeServer({ loseLineIndex: 1 }); // second add-line commits but its response is lost
    const draft = [line('DL1'), line('DL2')];
    const first = await commitDraft<OutletReturnDraftLine>(draft, s);

    expect(first.partial).toBe(true);
    expect(first.requestId).not.toBeNull();
    // DL2 actually committed server-side despite the lost response.
    expect(s.committedFor(first.requestId!)).toEqual(['DL1', 'DL2']);

    // Retry reloads canonical lines (both present) and plans to re-send nothing.
    const serverDispatchIds = s.committedFor(first.requestId!);
    const plan = planOutletReturnRetry(draft, serverDispatchIds);
    expect(plan.toSend).toHaveLength(0);
    expect(plan.alreadyPresent).toEqual(['DL1', 'DL2']);

    const before = s.lineMutations;
    const retried = await commitDraft<OutletReturnDraftLine>(plan.toSend, {
      createHeader: () => Promise.resolve({ ok: true, data: { id: first.requestId! } }),
      addLine: s.addLine,
    });
    expect(retried.complete).toBe(true);
    expect(s.lineMutations).toBe(before); // no double-post
  });

  it('retry re-sends a genuinely missing line without duplicating the present one', async () => {
    // Model: DL1 landed, DL2 never reached the server at all.
    const s = fakeServer();
    await s.createHeader();
    await s.addLine('RR-1', line('DL1'));
    const draft = [line('DL1'), line('DL2')];

    const plan = planOutletReturnRetry(draft, s.committedFor('RR-1'));
    expect(plan.toSend.map(l => l.originalDispatchLineId)).toEqual(['DL2']);

    await commitDraft<OutletReturnDraftLine>(plan.toSend, {
      createHeader: () => Promise.resolve({ ok: true, data: { id: 'RR-1' } }),
      addLine: s.addLine,
    });
    expect(s.committedFor('RR-1')).toEqual(['DL1', 'DL2']);
    expect(s.lineMutations).toBe(2);
  });
});

describe('idempotency and concurrency', () => {
  it('a replayed add-line for the same provenance causes no second mutation', async () => {
    const s = fakeServer();
    await s.createHeader();
    await s.addLine('RR-1', line('DL1'));
    await s.addLine('RR-1', line('DL1')); // replay
    expect(s.lineMutations).toBe(1);
    expect(s.committedFor('RR-1')).toEqual(['DL1']);
  });

  it('two concurrent commits of the same provenance yield exactly one line', async () => {
    const s = fakeServer();
    await s.createHeader();
    await Promise.all([
      s.addLine('RR-1', line('DL1', 'a')),
      s.addLine('RR-1', line('DL1', 'b')),
    ]);
    expect(s.lineMutations).toBe(1);
  });
});
