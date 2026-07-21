/**
 * OUTLET-CORRIDOR-070 §2A — contracts for the outlet's incoming supplies surface.
 *
 * Two layers, deliberately:
 *
 *  1. BEHAVIOUR is proven against the shared receive-model, because
 *     OutletIncomingSupplies reuses that model verbatim rather than
 *     re-implementing eligibility. The exclusion matrix itself is already
 *     covered by movement/__tests__/incoming-supplies.test.ts; what is asserted
 *     here is that the OUTLET corridor inherits exactly those guarantees, over
 *     dispatched-line shapes rather than transfer-line shapes.
 *
 *  2. WIRING is asserted against source, the repo convention (this codebase has
 *     no DOM test environment — nothing calls render()). These pin the things
 *     that would silently become false: one writer, one idempotency token per
 *     attempt, no free-text material entry, no catalog picker, no OCR.
 *
 * Source assertions normalise CRLF first — the working tree is CRLF locally and
 * LF on CI, and byte-offset-sensitive matching is a known source of phantom
 * local failures.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  assessReceive, bulkEligibleLines, validateReceive, type ReceivableLine,
} from '@/features/movement/receive-model';

const src = readFileSync(join(__dirname, '..', 'OutletIncomingSupplies.tsx'), 'utf8').replace(/\r\n?/g, '\n');

const TODAY = new Date('2026-07-21T00:00:00Z');

/** A dispatched line as the OUTLET sees it, in receive-model shape. */
function dline(over: Partial<ReceivableLine> = {}): ReceivableLine {
  return {
    id: 'dl1', scientificName: 'Ceftriaxone', batchNumber: 'CTX-2291',
    expiryDate: '2027-03-31', sentQuantity: 60, receivedQuantity: null,
    status: 'in_transit', differenceReason: null,
    ...over,
  };
}

describe('§2A the outlet inherits the conservative bulk-acceptance rules', () => {
  it('bulk-accepts a clean dispatched line at its full sent quantity', () => {
    const e = assessReceive(dline(), TODAY);
    expect(e.bulkEligible).toBe(true);
    expect(e.exclusions).toEqual([]);
  });

  it.each([
    ['expired', dline({ expiryDate: '2020-01-01' })],
    ['already flagged as discrepant', dline({ differenceReason: 'two vials broken' })],
    ['already received', dline({ receivedQuantity: 60, status: 'received' })],
    ['not actually in transit', dline({ status: 'draft' })],
  ])('excludes a %s line from BULK acceptance', (_label, line) => {
    expect(assessReceive(line, TODAY).bulkEligible).toBe(false);
    expect(bulkEligibleLines([line], TODAY)).toEqual([]);
  });

  it('a quantity-adjusted receipt is never bulk-eligible', () => {
    // Bulk always accepts the FULL sent quantity; proposing anything else is a
    // human decision and drops out of the bulk set.
    expect(assessReceive(dline(), TODAY, 59).exclusions).toContain('quantity_adjusted');
  });

  it('keeps a mixed consignment truthful — only the clean lines go in the bulk set', () => {
    const clean = dline({ id: 'ok' });
    const lines = [
      clean,
      dline({ id: 'exp', expiryDate: '2019-01-01' }),
      dline({ id: 'done', receivedQuantity: 60, status: 'received' }),
    ];
    expect(bulkEligibleLines(lines, TODAY).map(l => l.id)).toEqual(['ok']);
  });
});

describe('§2A a received quantity that differs from what was dispatched needs a reason', () => {
  it('demands a reason when the outlet receives fewer than dispatched', () => {
    const issues = validateReceive(dline(), 55, null);
    expect(issues.map(i => i.code)).toContain('difference_reason_required');
  });

  it('accepts the short receipt once a reason is stated', () => {
    expect(validateReceive(dline(), 55, 'two cartons missing on arrival')).toEqual([]);
  });

  it('refuses to receive MORE than was dispatched — that would corrupt the return cap', () => {
    const issues = validateReceive(dline(), 61, 'found extra');
    expect(issues.map(i => i.code)).toContain('quantity_exceeds_sent');
  });

  it('refuses a zero or negative receipt', () => {
    expect(validateReceive(dline(), 0, null).map(i => i.code)).toContain('quantity_not_positive');
    expect(validateReceive(dline(), -5, null).map(i => i.code)).toContain('quantity_not_positive');
  });
});

describe('§2A exactly one writer, and it is the 070 receive RPC', () => {
  it('receiveOutletDispatchLine is the only mutation imported', () => {
    expect(src).toContain('receiveOutletDispatchLine');
    for (const forbidden of [
      'createWarehouseDispatch', 'addDispatchLine', 'sendWarehouseDispatch',
      'updateDispatchLineQuantity', 'deleteDispatchLine', 'cancelWarehouseDispatch',
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });

  it('never writes a table directly and never uses a privileged key', () => {
    expect(src).not.toMatch(/\.from\([^)]*\)\.(insert|update|upsert|delete)/);
    expect(src).not.toMatch(/service_role|auth\.admin/);
  });

  it('calls no RPC of its own — the service layer owns every contract', () => {
    expect(src).not.toMatch(/supabase\.rpc\(/);
  });

  it('delegates idempotency to the token store, never minting per attempt', () => {
    // CORRECTED at the reviewer's direction: an earlier version minted a token
    // per ATTEMPT, which makes each retry a NEW operation and double-posts
    // whenever a success response is lost. Behaviour is proven in
    // outlet-receive-idempotency.test.ts; this only pins the wiring.
    expect(src).toContain('new ReceiptTokenStore(newRequestId)');
    expect(src).not.toMatch(/requestId:\s*newRequestId\(\)/);
    // The store must survive re-render, or tokens silently re-mint.
    expect(src).toMatch(/useRef\(new ReceiptTokenStore/);
  });

  it('retires a token only on canonical server proof of receipt', () => {
    expect(src).toMatch(/releaseConfirmed\(serverLineStates\)/);
    // Never on a failure — a rejection is indistinguishable from a committed
    // write whose response was lost.
    expect(src).not.toMatch(/releaseConfirmed[\s\S]{0,80}(failed|error)/);
  });

  it('never re-attempts a line the server already confirmed', () => {
    expect(src).toMatch(/confirmed\.has\(line\.id\)/);
    expect(src).toMatch(/confirmedIds:\s*confirmed/);
  });
});

describe('§2A stock is server-derived only', () => {
  it('reloads canonically after every receive, individual and bulk', () => {
    // Both mutation paths must end at the server reload; the outlet holds stock
    // only once the server says so.
    const individual = src.slice(src.indexOf('const receiveIndividually'), src.indexOf('const acceptAllSafe'));
    const bulk = src.slice(src.indexOf('const acceptAllSafe'));
    expect(individual).toContain('reload()');
    expect(bulk.slice(0, bulk.indexOf('// ── render'))).toContain('reload()');
  });

  it('never edits a balance locally', () => {
    expect(src).not.toMatch(/setStock|stock\s*[-+]=|availableQuantity\s*=/);
  });

  it('reads are keyed to THIS outlet, never a broader scope', () => {
    expect(src).toMatch(/getOutletDispatches\(distributionPointId\)/);
  });

  it('a draft or cancelled dispatch presents nothing to receive', () => {
    expect(src).toMatch(/DISPATCH_NOT_RECEIVABLE[\s\S]{0,120}'draft'[\s\S]{0,40}'cancelled'/);
  });
});

describe('§2A the outlet cannot invent material identity', () => {
  it('has no free-text material entry, no catalog picker and no OCR', () => {
    for (const forbidden of [
      'OcrIntakeFlow', 'ocr', 'CatalogPicker', 'MaterialPicker',
      'central_items', 'scientificNameInput', 'upsertAvailability',
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });

  it('renders the dispatched snapshot rather than any editable identity field', () => {
    // The only two operator inputs are the received quantity and its reason.
    const inputs = [...src.matchAll(/<PhoenixInput/g)];
    expect(inputs.length).toBe(2);
    expect(src).toMatch(/label=\{t\('mv_f_received_quantity', lang\)\}/);
    expect(src).toMatch(/label=\{t\('mv_difference_reason', lang\)\}/);
  });

  it('reuses the SHARED receive-model instead of re-implementing eligibility', () => {
    expect(src).toMatch(/from '@\/features\/movement\/receive-model'/);
    // A local re-implementation would drift from the institution corridor.
    expect(src).not.toMatch(/function\s+(assessReceive|bulkEligibleLines|validateReceive)\b/);
  });
});
