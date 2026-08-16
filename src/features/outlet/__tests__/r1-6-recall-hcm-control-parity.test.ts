import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRecallableOutletInboundMovements } from '../outlet-return.service';

const root = join(__dirname, '../../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const outletService = read('src/features/outlet/outlet-return.service.ts');
const networkService = read('src/features/network/network.service.ts');
const returnComposer = read('src/features/movement/DirectReturnComposer.tsx');
const outletScreen = read('src/features/outlet/OutletOperationsScreen.tsx');
const outletRecallPanel = read('src/features/outlet/OutletRecallPanel.tsx');
const outletRecallPermission = read('src/features/inventory/useOutletRecallPermission.ts');
const emergencyTab = read('src/features/outlet/EmergencyReplenishmentTab.tsx');

describe('R1.6 recall client selector parity', () => {
  it('uses the real outlet dispatch_receive movement selector and no legacy recall mutation', () => {
    expect(outletService).toContain("callRpc('phoenix_recall_outlet_inbound_movement'");
    expect(outletService).toMatch(/p_original_inbound_movement_id:\s*input\.originalInboundMovementId/);
    expect(outletService).toContain('getOutletDispatches');
    expect(outletService).toContain('getDispatchLinesForDispatches');
    expect(outletService).toContain('getMovementTimeline');
    expect(outletService).toContain(".from('phoenix_movement_events')");
    expect(outletService).toContain(".eq('reference_type', 'outlet_stock_movements')");
    expect(outletService).toContain(".eq('status_after', 'dispatch_receive')");
    expect(outletService).not.toContain("callRpc('phoenix_recall_outlet_stock'");
    expect(outletRecallPanel).toContain('getRecallableOutletInboundMovements(distributionPointId)');
    expect(outletRecallPanel).toMatch(/value:\s*movement\.id/);
    expect(outletRecallPanel).toMatch(/originalInboundMovementId:\s*selectedMovementId/);
    expect(outletRecallPanel).toMatch(/movements\.some\(movement => movement\.id === selectedMovementId\)/);
    expect(outletScreen).toMatch(/<OutletRecallPanel\s+key=\{distributionPointId\}/);
    expect(outletRecallPanel).toMatch(/setLoading\(true\);[\s\S]*setMovements\(\[\]\);[\s\S]*setSelectedMovementId\(''\)/);
  });

  it('maps only genuine dispatch_receive timeline events returned for readable dispatch lines', async () => {
    const rows = await getRecallableOutletInboundMovements('point-1', {
      getDispatches: async () => [{
        id: 'dispatch-1', dispatchNumber: 'DSP-1',
      }] as never,
      getLines: async () => [{
        id: 'line-1', dispatchId: 'dispatch-1', receivedQuantity: 5,
        scientificName: 'Amoxicillin', batchNumber: 'B-1',
      }] as never,
      getTimeline: async () => ({
        complete: false,
        completenessNote: null,
        events: [
          { eventId: 'wrong-kind', eventType: 'outlet_stock_movement', statusAfter: 'dispatch_receive', correlationId: 'wrong', occurredAt: '2026-08-15T10:00:00Z' },
          { eventId: 'send-1', eventType: 'warehouse_stock_movement', statusAfter: 'dispatch_send', correlationId: 'correlation-1', occurredAt: '2026-08-15T11:00:00Z' },
        ],
      } as never),
      getReceiptEvents: async correlationIds => {
        expect(correlationIds).toEqual(['correlation-1']);
        return [{ movementId: 'movement-1', correlationId: 'correlation-1', occurredAt: '2026-08-15T12:00:00Z' }];
      },
    });

    expect(rows).toEqual([{
      id: 'movement-1',
      occurredAt: '2026-08-15T12:00:00Z',
      scientificName: 'Amoxicillin',
      batchNumber: 'B-1',
      dispatchNumber: 'DSP-1',
    }]);
  });

  it('uses the real warehouse transfer-line selector and no legacy header recall mutation', () => {
    expect(networkService).toContain("callRpc('phoenix_recall_warehouse_transfer_line'");
    expect(networkService).toMatch(/p_original_transfer_line_id:\s*input\.originalTransferLineId/);
    expect(networkService).not.toContain("callRpc('phoenix_recall_direct_warehouse_transfer'");
    expect(networkService).not.toContain("callRpc('phoenix_recall_warehouse_transfer'");
    expect(returnComposer).toMatch(/originalTransferLineId:\s*line\.originalTransferLineId/);
    expect(returnComposer).not.toMatch(/recallDirectTransfer\(\{[\s\S]{0,300}sourceWarehouseId/);
  });
});

describe('R1.6 HCM view-vs-act control parity', () => {
  it('gates the return composer on exact point-scoped outlet_stock.return_request', () => {
    expect(outletScreen).toContain('useOutletReturnRequestPermission');
    expect(outletScreen).toMatch(/canRequestReturn=\{[^}]*\}/);
    expect(outletScreen).toMatch(/canRequestReturn\s*&&\s*\([\s\S]*<OutletReturnComposer/);
  });

  it('gates outlet recall on exact owning-warehouse scoped outlet_stock.recall', () => {
    expect(outletScreen).toContain('useOutletRecallPermission');
    expect(outletScreen).toMatch(/canRecallOutletStock\s*&&\s*\([\s\S]*<OutletRecallPanel/);
    expect(outletRecallPermission).toContain("permissionKey: 'outlet_stock.recall'");
    expect(outletRecallPermission).toMatch(/warehouseId,/);
    expect(outletRecallPermission).toContain('distributionPointId: null');
  });

  it('gates initial provisioning on exact warehouse-scoped warehouse_dispatch.create', () => {
    expect(emergencyTab).toContain('useWarehouseDispatchCreatePermission');
    expect(emergencyTab).toMatch(/canInitialProvision/);
    expect(emergencyTab).toMatch(/canInitialProvision\s*&&\s*isReplenishmentDestinationPointType/);
  });
});
