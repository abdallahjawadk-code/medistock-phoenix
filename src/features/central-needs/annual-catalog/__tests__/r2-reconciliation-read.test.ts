import { describe, expect, it } from 'vitest';
import { reconcileObservedCentralTransfers, type R2ReadInput, type R2TransferLine } from '../r2-reconciliation-read';
const scope = {
  ownerOrgId: '11111111-1111-4111-8111-111111111111',
  beneficiaryOrgId: '22222222-2222-4222-8222-222222222222',
  canonicalItemId: '33333333-3333-4333-8333-333333333333',
  planningYear: 2026, unit: 'tablet',
};
const line = (patch: Partial<R2TransferLine> = {}): R2TransferLine => ({
  id: '44444444-4444-4444-8444-444444444444',
  transferId: '55555555-5555-4555-8555-555555555555',
  sourceOrgId: scope.ownerOrgId, destinationOrgId: scope.beneficiaryOrgId,
  canonicalItemId: scope.canonicalItemId, unit: scope.unit,
  status: 'in_transit', sentQuantity: 10, receivedQuantity: null,
  differenceReason: null, receivedAt: null, ...patch,
});
const input = (transfers: R2TransferLine[]): R2ReadInput => ({ scope, transfers });
describe('R2-1 readonly canonical-transfer observations', () => {
  it('keeps unresolved receipts unknown; never emits quota execution or stock balance', () => {
    expect(reconcileObservedCentralTransfers(input([line()]))).toMatchObject({
      sentObserved: 10, receivedKnownSubtotal: 0, receivedConfirmedTotal: null,
      quotaExecution: null, remainingToExecute: null, stockBalance: null,
      allocationLink: 'UNAVAILABLE_NO_VERIFIED_ATTRIBUTION',
    });
  });
  it('separates full receipts, differences and rejects', () => {
    const rows = [
      line({status:'received', receivedQuantity:10, receivedAt:'2026-10-31T09:00:00Z'}),
      line({id:'66666666-6666-4666-8666-666666666666',status:'received_with_difference',
        receivedQuantity:6,differenceReason:'short shipment',receivedAt:'2026-10-31T09:00:00Z'}),
      line({id:'77777777-7777-4777-8777-777777777777',status:'rejected',
        receivedQuantity:0,differenceReason:'damaged',receivedAt:'2026-10-31T09:00:00Z'}),
    ];
    expect(reconcileObservedCentralTransfers(input(rows))).toMatchObject({
      sentObserved:30,receivedKnownSubtotal:16,receivedConfirmedTotal:16,
      rejectedLineCount:1,differentLineCount:1,unresolvedLineCount:0,
    });
  });
  it('rejects other institution, unknown identity and incompatible unit', () => {
    for (const patch of [{destinationOrgId:scope.ownerOrgId},{canonicalItemId:scope.beneficiaryOrgId},{unit:'vial'}]) {
      expect(() => reconcileObservedCentralTransfers(input([line(patch)]))).toThrow('r2_read_line_scope_mismatch');
    }
  });
  it('rejects duplicate transfer line IDs across central warehouses', () => {
    expect(() => reconcileObservedCentralTransfers(input([line(),line()]))).toThrow('r2_read_line_invalid');
  });
  it('rejects falsely accepted, over-received and unexplained differences', () => {
    for (const patch of [
      {status:'received' as const,receivedQuantity:9,receivedAt:'2026-10-31T09:00:00Z'},
      {status:'received_with_difference' as const,receivedQuantity:9,receivedAt:'2026-10-31T09:00:00Z'},
      {status:'rejected' as const,receivedQuantity:2,receivedAt:'2026-10-31T09:00:00Z',differenceReason:'damaged'},
      {receivedQuantity:11},
    ]) expect(() => reconcileObservedCentralTransfers(input([line(patch)]))).toThrow();
  });
  it('rejects unsafe year, source and empty unit', () => {
    expect(() => reconcileObservedCentralTransfers({...input([]),scope:{...scope,planningYear:1999}})).toThrow();
    expect(() => reconcileObservedCentralTransfers({...input([]),scope:{...scope,unit:''}})).toThrow();
    expect(() => reconcileObservedCentralTransfers({...input([]),scope:{...scope,ownerOrgId:scope.beneficiaryOrgId}})).toThrow();
  });
});
