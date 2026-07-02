/**
 * AVAILABILITY-MOVEMENT-REPORTS-PRINT-A
 * Run: npm test -- --run
 *
 * Static source-code tests for the read-only, filterable Quantity Movement
 * Report (Status Center section):
 *  - Permission gating: view (whole section), export (CSV), print.
 *  - getAvailabilityMovementsReport: filters, ordering, limit, no RPC/write.
 *  - Report UI: title, filters, summary cards, table, delta signs, states.
 *  - Print output includes title/filters/rows; CSV escapes values safely.
 *  - Guards: no migrations/RPC/QR touched, no Excel/XLSX, EditorScreen /
 *    AdjustQuantityModal / MovementHistoryModal untouched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');
const readSrc     = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

const sectionPath  = join(SRC, 'features/status/MovementReportSection.tsx');
const section      = readFileSync(sectionPath, 'utf8');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const service      = readSrc('shared/supabase/services/availability.service.ts');
const strings      = readSrc('shared/i18n/strings.ts');
const editorScreen  = readSrc('features/editor/EditorScreen.tsx');
const adjustModal   = readSrc('features/status/AdjustQuantityModal.tsx');
const historyModal  = readSrc('features/status/MovementHistoryModal.tsx');

// ============================================================================
// 1. Permission gating
// ============================================================================

describe('Quantity Movement Report: permission gating', () => {
  it('MovementReportSection.tsx exists and is mounted in StatusCenterScreen', () => {
    expect(existsSync(sectionPath)).toBe(true);
    expect(statusCenter).toContain('MovementReportSection');
    expect(statusCenter).toContain('<MovementReportSection');
  });

  it('the whole section is gated on availability.movements.view', () => {
    expect(section).toContain("myPermissions.has('availability.movements.view')");
    expect(section).toMatch(/if \(!canViewReport\) return null;/);
  });

  it('the CSV export button is gated on availability.movements.export', () => {
    expect(section).toContain("myPermissions.has('availability.movements.export')");
    expect(section).toMatch(/\{canExportCsv && \(/);
  });

  it('the Print button is gated on availability.movements.print', () => {
    expect(section).toContain("myPermissions.has('availability.movements.print')");
    expect(section).toMatch(/\{canPrint && \(/);
  });
});

// ============================================================================
// 2. Service query
// ============================================================================

describe('getAvailabilityMovementsReport: read-only, filterable service query', () => {
  const fnStart = service.indexOf('export async function getAvailabilityMovementsReport');
  const fnBody = service.slice(fnStart, service.indexOf('\nexport async function getLowStockItems'));

  it('exists and queries item_availability_movements via SELECT', () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnBody).toMatch(/\.from\('item_availability_movements'\)/);
  });

  it('scopes by organization_id', () => {
    expect(fnBody).toContain(".eq('organization_id', filters.organizationId)");
  });

  it('filters by date range (gte/lte on created_at)', () => {
    expect(fnBody).toMatch(/\.gte\('created_at',/);
    expect(fnBody).toMatch(/\.lte\('created_at',/);
  });

  it('filters by movement_type', () => {
    expect(fnBody).toMatch(/\.eq\('movement_type', filters\.movementType\)/);
  });

  it('filters by distribution_point_id when provided', () => {
    expect(fnBody).toMatch(/\.eq\('distribution_point_id', filters\.distributionPointId\)/);
  });

  it('supports material search across scientific_name/trade_name/concentration/dosage_form', () => {
    expect(fnBody).toMatch(/scientific_name\.ilike/);
    expect(fnBody).toMatch(/trade_name\.ilike/);
    expect(fnBody).toMatch(/concentration\.ilike/);
    expect(fnBody).toMatch(/dosage_form\.ilike/);
  });

  it('supports actor search across actor_name_snapshot/actor_email_snapshot', () => {
    expect(fnBody).toMatch(/actor_name_snapshot\.ilike/);
    expect(fnBody).toMatch(/actor_email_snapshot\.ilike/);
  });

  it('orders by created_at descending', () => {
    expect(fnBody).toMatch(/\.order\('created_at',\s*\{\s*ascending:\s*false\s*\}\)/);
  });

  it('applies a limit, defaulting to 200', () => {
    expect(fnBody).toMatch(/\.limit\(filters\.limit \?\? 200\)/);
  });

  it('returns typed camelCase records extending AvailabilityMovementRecord', () => {
    expect(service).toContain('export interface AvailabilityMovementReportRecord extends AvailabilityMovementRecord');
    expect(service).toContain('scientificName:');
    expect(service).toContain('tradeName:');
    expect(service).toContain('distributionPointId:');
    expect(service).toContain('distributionPointName:');
  });

  it('is a plain SELECT — no RPC call, no write', () => {
    expect(fnBody).not.toContain('.rpc(');
    expect(fnBody).not.toMatch(/\.insert\(/);
    expect(fnBody).not.toMatch(/\.update\(/);
    expect(fnBody).not.toMatch(/\.delete\(/);
  });

  it('does not use service_role or auth.admin', () => {
    expect(fnBody).not.toContain('service_role');
    expect(fnBody).not.toMatch(/auth\.admin/);
  });

  it('short-circuits to [] when Supabase is not configured', () => {
    const head = service.slice(fnStart, fnStart + 400);
    expect(head).toContain('if (!supabaseConfigured) return [];');
  });
});

// ============================================================================
// 3. Report UI
// ============================================================================

describe('MovementReportSection: title, filters, summary, table, states', () => {
  it('renders the required bilingual title', () => {
    expect(section).toContain("t('mvmt_report_title', lang)");
    const line = strings.split('\n').find(l => l.includes('mvmt_report_title:'));
    expect(line).toContain('Quantity Movement Report');
    expect(line).toContain('تقرير حركات الكمية');
  });

  it('renders date range, movement type, distribution point, material and actor filters', () => {
    expect(section).toContain('mr-date-from');
    expect(section).toContain('mr-date-to');
    expect(section).toContain('mr-type');
    expect(section).toContain('mr-point');
    expect(section).toContain('mr-material');
    expect(section).toContain('mr-actor');
  });

  it('movement type filter offers all 4 types plus an "all" option', () => {
    expect(section).toContain('MOVEMENT_TYPE_OPTIONS');
    ['set_exact', 'add', 'subtract', 'correction'].forEach(v => expect(section).toContain(`value: '${v}'`));
    expect(section).toContain('mvmt_report_all_types');
  });

  it('renders 5 summary cards: total, additions, subtractions, corrections, net delta', () => {
    expect(section).toContain('mvmt_report_summary_total');
    expect(section).toContain('mvmt_report_summary_add');
    expect(section).toContain('mvmt_report_summary_subtract');
    expect(section).toContain('mvmt_report_summary_correction');
    expect(section).toContain('mvmt_report_summary_net');
  });

  it('summary counts are derived from the loaded rows, not recomputed from before/after', () => {
    const summaryBlock = section.slice(section.indexOf('const summary = useMemo'), section.indexOf('const dpLabel'));
    expect(summaryBlock).toContain("m.movementType === 'add'");
    expect(summaryBlock).toContain("m.movementType === 'subtract'");
    expect(summaryBlock).toContain("m.movementType === 'correction'");
    expect(summaryBlock).toContain('netDelta += m.quantityDelta');
    expect(summaryBlock).not.toMatch(/quantityAfter\s*-\s*quantityBefore/);
  });

  it('table includes all required columns', () => {
    const REQUIRED = ['datetime', 'point', 'sci', 'trade', 'conc', 'dosage', 'type', 'before', 'delta', 'after', 'actor', 'reason', 'notes'];
    REQUIRED.forEach(key => expect(section).toContain(`key: '${key}'`));
  });

  it('delta display: add is +N, subtract is -N, others use the stored signed delta', () => {
    const fnBody = section.slice(section.indexOf('function formatDelta'), section.indexOf('function escHtml'));
    expect(fnBody).toMatch(/type === 'add'[\s\S]*?`\+\$\{/);
    expect(fnBody).toMatch(/type === 'subtract'[\s\S]*?`-\$\{/);
    expect(fnBody).not.toMatch(/quantityAfter\s*-\s*quantityBefore/);
  });

  it('displays actor, reason, and notes columns', () => {
    expect(section).toContain('const actorLabel');
    expect(section).toContain('r.actorNameSnapshot');
    expect(section).toContain('r.actorRoleSnapshot');
    expect(section).toContain('r.reason ||');
    expect(section).toContain('r.notes ||');
  });

  it('handles loading state', () => {
    expect(section).toContain('PhoenixLoadingState');
    expect(section).toMatch(/\{report\.loading && <PhoenixLoadingState/);
  });

  it('handles error state with retry, using load_error fallback', () => {
    expect(section).toContain('PhoenixErrorState');
    expect(section).toContain("t('load_error', lang)");
    expect(section).toContain('onRetry={report.reload}');
  });

  it('handles empty state with the required bilingual message', () => {
    expect(section).toContain('mvmt_report_empty');
    const line = strings.split('\n').find(l => l.includes('mvmt_report_empty:'));
    expect(line).toContain('No quantity movements match the selected filters.');
    expect(line).toContain('لا توجد حركات كمية مطابقة لعوامل التصفية المحددة.');
  });

  it('requires org scope before querying (mirrors other Status Center sections)', () => {
    expect(section).toContain('!activeOrgId');
    expect(section).toContain("t('no_org_scope', lang)");
  });
});

// ============================================================================
// 4. Print
// ============================================================================

describe('MovementReportSection: print behavior', () => {
  it('print action only exists gated by canPrint', () => {
    expect(section).toMatch(/\{canPrint && \(\s*<button onClick=\{printReport\}/);
  });

  it('print output includes title, selected filters, generated timestamp, and rows', () => {
    const fnBody = section.slice(section.indexOf('function buildReportHtml'), section.indexOf('function printReport'));
    expect(fnBody).toContain("t('mvmt_report_title', lang)");
    expect(fnBody).toContain("t('sc_selected_filters', lang)");
    expect(fnBody).toContain("t('sc_generated_at', lang)");
    expect(fnBody).toContain('rows.length');
    expect(fnBody).toContain('bodyRows');
  });

  it('print escapes HTML-unsafe characters via escHtml', () => {
    const fnBody = section.slice(section.indexOf('function buildReportHtml'), section.indexOf('function printReport'));
    expect(fnBody).toMatch(/escHtml\(/);
  });

  it('print opens a new window and calls window.print (existing project pattern)', () => {
    const fnBody = section.slice(section.indexOf('function printReport'), section.indexOf('function exportCsv'));
    expect(fnBody).toContain("window.open('', '_blank')");
    expect(fnBody).toContain('win.print()');
  });
});

// ============================================================================
// 5. CSV
// ============================================================================

describe('MovementReportSection: CSV export behavior', () => {
  it('export action only exists gated by canExportCsv', () => {
    expect(section).toMatch(/\{canExportCsv && \(\s*<button onClick=\{exportCsv\}/);
  });

  it('CSV includes the same visible column headers', () => {
    const fnBody = section.slice(section.indexOf('function exportCsv'), section.indexOf('if (!canViewReport)'));
    expect(fnBody).toContain('columns.map(c => cell(c.label))');
  });

  it('CSV escapes quotes safely (doubled quotes, matches existing project convention)', () => {
    const fnBody = section.slice(section.indexOf('function exportCsv'), section.indexOf('if (!canViewReport)'));
    expect(fnBody).toMatch(/replace\(\/"\/g, '""'\)/);
  });

  it('CSV uses a UTF-8 BOM (existing project convention)', () => {
    const fnBody = section.slice(section.indexOf('function exportCsv'), section.indexOf('if (!canViewReport)'));
    expect(fnBody).toMatch(/const bom = /);
  });

  it('CSV escapes cells that could be interpreted as spreadsheet formulas (CSV injection protection)', () => {
    expect(section).toContain('function csvSafeCell');
    const guardFn = section.slice(section.indexOf('function csvSafeCell'), section.indexOf('function csvSafeCell') + 300);
    expect(guardFn).toContain('/^[=+\\-@]/');
    const fnBody = section.slice(section.indexOf('function exportCsv'), section.indexOf('if (!canViewReport)'));
    expect(fnBody).toContain('csvSafeCell');
  });

  it('uses a medistock-movements-prefixed, date-stamped filename', () => {
    const fnBody = section.slice(section.indexOf('function exportCsv'), section.indexOf('if (!canViewReport)'));
    expect(fnBody).toContain('medistock-movements-');
  });

  it('does not add xlsx/exceljs/sheetjs/read-excel-file/papaparse', () => {
    expect(section).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });

  it('CSV export is a client-side Blob download, not a server write', () => {
    const fnBody = section.slice(section.indexOf('function exportCsv'), section.indexOf('if (!canViewReport)'));
    expect(fnBody).toContain("new Blob([csv]");
    expect(fnBody).not.toContain('.rpc(');
    expect(fnBody).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });
});

// ============================================================================
// 6. Guard tests
// ============================================================================

describe('Guards: no unrelated changes, existing features intact', () => {
  it('no migration file (001-035) references this phase / was modified to add it', () => {
    const sql033 = readPhoenix('supabase/migrations/033_phoenix_availability_movements_schema.sql');
    expect(sql033).toContain('avail_mvmt_select_perm');
  });

  it('no new migration file was created for this phase', () => {
    expect(existsSync(join(PHOENIX, 'supabase/migrations/036_phoenix_movement_reports.sql'))).toBe(false);
  });

  it('phoenix_apply_availability_movement / phoenix_upsert_availability are not referenced as write calls in the new section', () => {
    expect(section).not.toContain('applyAvailabilityMovement');
    expect(section).not.toContain('upsertAvailability');
    expect(section).not.toContain('.rpc(');
  });

  it('no QR file is referenced by the new report section', () => {
    expect(section).not.toMatch(/qr[_-]?token|QrToken|public.?qr|get_public_qr_payload/i);
  });

  it('EditorScreen.tsx is untouched by this phase', () => {
    expect(editorScreen).not.toContain('MovementReportSection');
    expect(editorScreen).not.toContain('getAvailabilityMovementsReport');
    expect(editorScreen).not.toContain('AVAILABILITY-MOVEMENT-REPORTS-PRINT-A');
  });

  it('AdjustQuantityModal.tsx is untouched by this phase', () => {
    expect(adjustModal).not.toContain('MovementReportSection');
    expect(adjustModal).not.toContain('getAvailabilityMovementsReport');
  });

  it('MovementHistoryModal.tsx remains read-only and untouched by this phase', () => {
    expect(historyModal).not.toContain('MovementReportSection');
    expect(historyModal).not.toContain('getAvailabilityMovementsReport');
    expect(historyModal).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(historyModal).not.toContain('.rpc(');
  });

  it('StatusCenterScreen still renders Adjust Quantity and Movement History unchanged', () => {
    expect(statusCenter).toContain('AdjustQuantityModal');
    expect(statusCenter).toContain('MovementHistoryModal');
    expect(statusCenter).toContain('canAdjustQuantity');
    expect(statusCenter).toContain('canViewMovementHistory');
  });

  it('does not add Excel import anywhere in the new files', () => {
    expect(section).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
    expect(statusCenter).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });

  it('does not reference service_role or auth.admin anywhere in the new files', () => {
    expect(section).not.toContain('service_role');
    expect(section).not.toMatch(/auth\.admin/);
  });
});
