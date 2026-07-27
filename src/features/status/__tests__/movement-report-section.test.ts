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
import { expectRetiredSurfaceAbsent } from '../../../../tests/helpers/retired-surfaces';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');
const readSrc     = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

const sectionPath  = join(SRC, 'features/status/MovementReportSection.tsx');
const section      = readFileSync(sectionPath, 'utf8');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const service      = readSrc('features/reports/movement-ledger-report.service.ts');
const strings      = readSrc('shared/i18n/strings.ts');
const labels       = readSrc('shared/lib/movement-labels.ts');
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

  it('the whole section is gated on status_center.view (MOVEMENT-LEDGER-REPORT-138)', () => {
    expect(section).toContain("myPermissions.has('status_center.view')");
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

describe('getMovementLedgerReport: canonical, paginated RPC-backed service query (migration 138)', () => {
  const fnStart = service.indexOf('export async function getMovementLedgerReport');
  const fnBody = service.slice(fnStart);

  it('exists and calls the canonical phoenix_movement_ledger_report RPC', () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnBody).toContain("supabase.rpc('phoenix_movement_ledger_report'");
  });

  it('passes organization_id, date range, ledger source, movement type, location and search filters', () => {
    expect(fnBody).toContain('p_organization_id: filters.organizationId');
    expect(fnBody).toContain('p_from: filters.from');
    expect(fnBody).toContain('p_to: filters.to');
    expect(fnBody).toContain('p_ledger_source: filters.ledgerSource');
    expect(fnBody).toContain('p_movement_type: filters.movementType');
    expect(fnBody).toContain('p_location_id: filters.locationId');
    expect(fnBody).toContain('p_material_search:');
    expect(fnBody).toContain('p_actor_search:');
  });

  it('passes pagination (limit/offset), defaulting limit to 50 — server clamps to 200', () => {
    expect(fnBody).toContain('p_limit: filters.limit ?? 50');
    expect(fnBody).toContain('p_offset: filters.offset ?? 0');
  });

  it('returns typed camelCase rows plus an honest totalCount (not just the page size)', () => {
    expect(service).toContain('export interface MovementLedgerReportRow');
    expect(service).toContain('export interface MovementLedgerReportResult');
    expect(service).toContain('rows: MovementLedgerReportRow[]');
    expect(service).toContain('totalCount: number');
    expect(fnBody).toContain('hasDispenseContext: r.has_dispense_context');
  });

  it('never fetches dispense-beneficiary detail itself — only a hasDispenseContext flag', () => {
    expect(service).not.toMatch(/patient_identifier|patient_name|crash_cart_reference|internal_order_reference/);
    expect(service).not.toContain('phoenix_get_movement_dispense_context');
  });

  it('does not use service_role or auth.admin', () => {
    expect(service).not.toContain('service_role');
    expect(service).not.toMatch(/auth\.admin/);
  });

  it('short-circuits to an empty result when Supabase is not configured', () => {
    const head = service.slice(fnStart, fnStart + 400);
    expect(head).toContain("if (!supabaseConfigured) return { rows: [], totalCount: 0 };");
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

  it('renders date range, ledger source, movement type, location, material and actor filters', () => {
    expect(section).toContain('mr-date-from');
    expect(section).toContain('mr-date-to');
    expect(section).toContain('mr-ledger');
    expect(section).toContain('mr-type');
    expect(section).toContain('mr-location');
    expect(section).toContain('mr-material');
    expect(section).toContain('mr-actor');
  });

  it('ledger source filter offers warehouse/outlet/quarantine plus an "all" option', () => {
    expect(section).toContain("<option value=\"warehouse\">");
    expect(section).toContain("<option value=\"outlet\">");
    expect(section).toContain("<option value=\"quarantine\">");
    expect(section).toContain('mvmt_ledger_all');
  });

  it('movement type filter offers the full union of warehouse/outlet/quarantine types plus an "all" option', () => {
    // MOVEMENT-LABELS: the closed vocabularies live in ONE shared module now
    // (src/shared/lib/movement-labels.ts), reused by both this section and the
    // Custody Chain trace — the section imports the map rather than keeping a
    // second copy of it.
    expect(section).toContain('MOVEMENT_TYPE_LABEL_KEY');
    expect(section).toContain("from '@/shared/lib/movement-labels'");
    ['set_exact', 'add', 'subtract', 'correction', 'dispense', 'quarantine_receive']
      .forEach(v => expect(labels).toContain(`${v}:`));
    expect(section).toContain('mvmt_report_all_types');
  });

  it('the reason-code / movement-type / ledger-source vocabularies are NOT duplicated in the section', () => {
    // A second local copy of any of these maps is exactly the duplication the
    // reporting-closure parity matrix exists to prevent.
    expect(section).not.toMatch(/const\s+REASON_CODE_LABEL_KEY\s*[:=]/);
    expect(section).not.toMatch(/const\s+LEDGER_SOURCE_LABEL_KEY\s*[:=]/);
    expect(section).not.toMatch(/const\s+MOVEMENT_TYPE_LABEL_KEY\s*[:=]/);
  });

  it('the shared label helpers never leak an i18n key for an unknown code', () => {
    // t() returns the KEY for a missing entry, so the helpers must check
    // membership explicitly and fall back to the raw stored code.
    expect(labels).toContain('return key ? t(key, lang) : code;');
    expect(labels).toContain('return key ? t(key, lang) : type;');
    expect(labels).toContain('return key ? t(key, lang) : source;');
  });

  it('renders 5 summary cards: total, additions, subtractions, corrections, net delta', () => {
    expect(section).toContain('mvmt_report_summary_total');
    expect(section).toContain('mvmt_report_summary_add');
    expect(section).toContain('mvmt_report_summary_subtract');
    expect(section).toContain('mvmt_report_summary_correction');
    expect(section).toContain('mvmt_report_summary_net');
  });

  it('summary counts are derived from the loaded rows quantityDelta sign, not recomputed from before/after', () => {
    const summaryBlock = section.slice(section.indexOf('const summary = useMemo'), section.indexOf('const locationLabel'));
    expect(summaryBlock).toContain('m.quantityDelta > 0) totalAdd++');
    expect(summaryBlock).toContain('m.quantityDelta < 0) totalSubtract++');
    expect(summaryBlock).toMatch(/m\.movementType === 'correction'/);
    expect(summaryBlock).toContain('netDelta += m.quantityDelta');
    expect(summaryBlock).not.toMatch(/quantityAfter\s*-\s*quantityBefore/);
  });

  it('table includes all required canonical-contract columns', () => {
    const REQUIRED = ['datetime', 'ledger', 'location', 'sci', 'conc', 'dosage', 'batch', 'type', 'reason', 'before', 'delta', 'after', 'actor', 'doc', 'correlation', 'causation', 'dispense'];
    REQUIRED.forEach(key => expect(section).toContain(`key: '${key}'`));
  });

  it('surfaces correlation_id and causation_id — fetched by the service but previously never rendered', () => {
    expect(section).toContain("r.correlationId || '—'");
    expect(section).toContain("r.causationId || '—'");
  });

  it('delta display uses the stored signed quantityDelta as-is', () => {
    const fnBody = section.slice(section.indexOf('function formatDelta'), section.indexOf('function escHtml'));
    expect(fnBody).toMatch(/delta > 0 \? `\+\$\{delta\}` : String\(delta\)/);
    expect(fnBody).not.toMatch(/quantityAfter\s*-\s*quantityBefore/);
  });

  it('displays actor, reason code, document reference, and dispense-context columns', () => {
    expect(section).toContain('const actorLabel');
    expect(section).toContain('r.actorName');
    expect(section).toContain('r.actorRole');
    expect(section).toContain('const reasonLabel');
    expect(section).toContain('r.sourceDocumentNumber ||');
    expect(section).toContain('r.hasDispenseContext');
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
    // E6: EditorScreen is retired — absence is stronger than 'does not contain'.
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  it('AdjustQuantityModal stays retired (deleted) by this phase', () => {
    expectRetiredSurfaceAbsent('AdjustQuantityModal');
  });

  it('MovementHistoryModal.tsx remains read-only and untouched by this phase', () => {
    expect(historyModal).not.toContain('MovementReportSection');
    expect(historyModal).not.toContain('getAvailabilityMovementsReport');
    expect(historyModal).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(historyModal).not.toContain('.rpc(');
  });

  it('StatusCenterScreen renders the canonical correction launcher and Movement History', () => {
    expect(statusCenter).toContain('AvailabilityStockCorrectionModal');
    expect(statusCenter).not.toContain('<AdjustQuantityModal');
    expect(statusCenter).toContain('MovementHistoryModal');
    expect(statusCenter).toContain('canCorrectStock');
    expect(statusCenter).toContain('canViewMovementHistory');
  });

  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: a later, separately-reviewed phase
  // intentionally wires a real .xlsx export into StatusCenterScreen
  // (exportAvailabilityXlsx) — unrelated to this movement-reports phase,
  // whose own MovementReportSection.tsx (`section`) remains CSV-only, no
  // Excel library, exactly as this phase left it.
  it('does not add Excel import to MovementReportSection.tsx (the file this phase added)', () => {
    expect(section).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });

  it('does not reference service_role or auth.admin anywhere in the new files', () => {
    expect(section).not.toContain('service_role');
    expect(section).not.toMatch(/auth\.admin/);
  });
});
