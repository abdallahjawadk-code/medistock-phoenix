/**
 * PHASE-9-REPORT-PARITY
 *
 * Locks the final reporting boundary:
 *   - the live movement screen and its XLSX/print outputs share one row/column
 *     model;
 *   - only legal document labels are user-facing, while movement/correlation
 *     UUIDs stay internal drill-down keys;
 *   - the latest monthly and movement SQL readers cannot treat suggestion,
 *     Draft, process metadata, or the Phase 8 open-document read as movement.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../../');
const read = (relativePath: string) =>
  readFileSync(join(ROOT, relativePath), 'utf8');

const movementScreen = read('src/features/status/MovementReportSection.tsx');
const reportsCenter = read(
  'src/features/reports/DecisionIntelligenceReportsScreen.tsx',
);
const movementReader = read(
  'supabase/migrations/138_phoenix_movement_ledger_report.sql',
);
const latestMonthlyReader = read(
  'supabase/migrations/112_phoenix_status_classification_boundary_correction.sql',
);
const suggestionReadModel = read(
  'supabase/migrations/152_phoenix_suggestion_action_read_model.sql',
);

const PLANNING_STATE =
  /inventory_transfer_suggestions|draft_warehouse_transfer_request_id|draft_warehouse_dispatch_id|draft_outlet_return_request_id|process_kind|process_version/;

describe('Phase 9 movement screen / XLSX / print parity', () => {
  it('uses one shared columns model for the table, XLSX and print/PDF', () => {
    expect(movementScreen).toContain(
      'ProfessionalReportColumn<MovementLedgerReportRow>[]',
    );
    expect(movementScreen).toContain('exportProfessionalXlsx(exportConfig())');
    expect(movementScreen).toContain('columns.map(c => <th');
    expect(movementScreen).toMatch(
      /columns\.map\(c => `<td[\s\S]*c\.value\(r\)/,
    );
    expect(movementScreen).not.toContain('function exportCsv');
  });

  it('keeps technical movement/correlation UUIDs internal and shows the legal document number', () => {
    expect(movementScreen).toContain(
      "key: 'doc',      label: t('mvmt_col_document_ref', lang)",
    );
    expect(movementScreen).not.toMatch(
      /key:\s*'(?:correlation|causation)'/,
    );
    expect(reportsCenter).not.toMatch(
      /(?:appliedMovementId|correlation_id|causation_id)\.slice\(/,
    );
    expect(reportsCenter).not.toMatch(
      /value:\s*\([^)]*\)\s*=>\s*[^,\n]*(?:appliedMovementId|correlationId|causationId)/,
    );
  });
});

describe('Phase 9 report readers remain movement-only and read-only', () => {
  it('the canonical movement ledger still unions only the three legal ledgers', () => {
    for (const table of [
      'warehouse_stock_movements',
      'outlet_stock_movements',
      'warehouse_quarantine_stock_movements',
    ]) {
      expect(movementReader).toContain(table);
    }
    expect(movementReader).not.toMatch(PLANNING_STATE);
  });

  it('the latest monthly reader ignores suggestion/Draft/process metadata', () => {
    const start = latestMonthlyReader.indexOf(
      'CREATE OR REPLACE FUNCTION public.phoenix_status_prepare_report',
    );
    expect(start).toBeGreaterThan(-1);
    const body = latestMonthlyReader.slice(start);
    expect(body).toContain('warehouse_stock');
    expect(body).toContain('outlet_stock');
    expect(body).not.toMatch(PLANNING_STATE);
  });

  it('opening a Phase 8 document is a read decision and cannot write stock, custody or audit success', () => {
    expect(suggestionReadModel).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?public\.(?:warehouse_stock|outlet_stock|warehouse_quarantine_stock|warehouse_transfers|warehouse_dispatches|outlet_return_shipments|audit_logs)\b/i,
    );
    expect(suggestionReadModel).not.toMatch(
      /warehouse_stock_movements|outlet_stock_movements|warehouse_quarantine_stock_movements/,
    );
  });
});
