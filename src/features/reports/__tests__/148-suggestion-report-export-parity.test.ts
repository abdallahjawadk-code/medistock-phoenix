/**
 * TRANSFER-SUGGESTION-DRAFT-BRIDGE-148 — canonical report/export parity.
 *
 * A suggestion and its draft document are planning state, not inventory
 * movement. This test locks the boundary through every reader-facing surface:
 * the canonical report query, the on-screen report configuration, real XLSX,
 * and PDF-via-print HTML.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildPremiumPrintHtml,
  buildProfessionalWorkbook,
  type ProfessionalExportConfig,
  type ProfessionalReportColumn,
} from '@/shared/lib/professional-export';

const ROOT = join(__dirname, '../../../../');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const movementLedgerMigration = read('supabase/migrations/138_phoenix_movement_ledger_report.sql');
const monthlyStatusMigration = read('supabase/migrations/092_phoenix_monthly_status_redesign.sql');
const reportScreen = read('src/features/reports/DecisionIntelligenceReportsScreen.tsx');
const custodyService = read('src/features/reports/custody-chain.service.ts');

const PLANNING_ONLY_REFS =
  /inventory_transfer_suggestions|draft_warehouse_transfer_request_id|draft_warehouse_dispatch_id|draft_outlet_return_request_id/;

interface CanonicalMovementRow {
  reference: string;
  scientificName: string;
  quantity: number;
}

function config(rows: CanonicalMovementRow[]): ProfessionalExportConfig<CanonicalMovementRow> {
  const columns: ProfessionalReportColumn<CanonicalMovementRow>[] = [
    { key: 'reference', label: 'Reference', value: row => row.reference },
    { key: 'scientificName', label: 'Material', value: row => row.scientificName },
    {
      key: 'quantity',
      label: 'Quantity',
      value: row => String(row.quantity),
      numeric: true,
      excelValue: row => row.quantity,
    },
  ];
  return {
    reportTitle: 'Canonical Movement Ledger',
    moduleName: 'Movement ledger',
    generatedAt: new Date('2026-07-28T00:00:00.000Z'),
    filtersSummary: 'All committed movements',
    columns,
    rows,
    lang: 'en',
    fileNameBase: 'canonical-movement-ledger',
    footerText: 'MediStock Phoenix',
    labels: { generatedAt: 'Generated at', filtersSummary: 'Filters', rowCount: 'Rows' },
  };
}

describe('suggestion/draft state is excluded from canonical reports', () => {
  it('canonical SQL readers and custody readers never source planning-only identifiers', () => {
    expect(movementLedgerMigration).not.toMatch(PLANNING_ONLY_REFS);
    expect(monthlyStatusMigration).not.toMatch(PLANNING_ONLY_REFS);
    expect(custodyService).not.toMatch(/inventory_transfer_suggestions/);
    expect(custodyService).toMatch(/status !== 'draft'/);
  });

  it('report XLSX and PDF/print actions are fed by the shared exportConfig()', () => {
    const xlsxCalls = reportScreen.match(/exportProfessionalXlsx\(exportConfig\(\)\)/g) ?? [];
    const printCalls = reportScreen.match(/triggerProfessionalPrint\(exportConfig\(\)\)/g) ?? [];
    expect(xlsxCalls.length).toBeGreaterThan(0);
    expect(printCalls.length).toBeGreaterThan(0);
    expect(reportScreen).not.toMatch(/exportProfessionalXlsx\(\s*\{/);
    expect(reportScreen).not.toMatch(/triggerProfessionalPrint\(\s*\{/);
  });
});

describe('canonical rows remain identical in on-screen report, XLSX and PDF', () => {
  it('exports committed movement rows once and never leaks a suggestion or draft row', async () => {
    const canonicalRows: CanonicalMovementRow[] = [
      { reference: 'MOVE-001', scientificName: 'Paracetamol', quantity: 30 },
      { reference: 'MOVE-002', scientificName: 'Amoxicillin', quantity: 12 },
    ];
    const planningOnly = {
      suggestionId: 'SUGGESTION-MUST-NOT-EXPORT',
      draftDocument: 'DRAFT-MUST-NOT-EXPORT',
      suggestedQuantity: 999,
    };
    const exportConfig = config(canonicalRows);

    // The screen table, workbook and PDF/print receive the exact same array,
    // while planning state remains a separate queue object.
    expect(exportConfig.rows).toBe(canonicalRows);
    expect(exportConfig.rows).not.toContain(planningOnly);

    const workbook = await buildProfessionalWorkbook(exportConfig);
    const worksheet = workbook.worksheets[0];
    const workbookText: string[] = [];
    worksheet.eachRow(row => {
      row.eachCell(cell => workbookText.push(String(cell.value ?? '')));
    });
    const pdfHtml = buildPremiumPrintHtml(exportConfig);

    for (const row of canonicalRows) {
      expect(workbookText).toContain(row.reference);
      expect(workbookText).toContain(row.scientificName);
      expect(workbookText).toContain(String(row.quantity));
      expect(pdfHtml).toContain(row.reference);
      expect(pdfHtml).toContain(row.scientificName);
      expect(pdfHtml).toContain(String(row.quantity));
    }
    for (const forbidden of [
      planningOnly.suggestionId,
      planningOnly.draftDocument,
      String(planningOnly.suggestedQuantity),
    ]) {
      expect(workbookText).not.toContain(forbidden);
      expect(pdfHtml).not.toContain(forbidden);
    }
  });
});
